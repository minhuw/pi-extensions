import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import workspaceExtension, { CHILD_SESSION_HOOKS, WORKSPACE_SHARED_KEY } from "../index.ts";
import {
	extractBashExternalWriteTargets,
	extractBashWriteTargets,
	normalizeFileToolPath,
	resolveCanonicalPath,
} from "../policy.ts";
import { readRegistry } from "../registry.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

let sandboxRoot: string;
let projectCwd: string;
let outsideDir: string;
let agentDir: string;
let sessionDir: string;
let prevAgentDir: string | undefined;

beforeEach(async () => {
	sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-at-prefix-"));
	projectCwd = path.join(sandboxRoot, "project");
	outsideDir = path.join(sandboxRoot, "outside");
	agentDir = path.join(sandboxRoot, "agent");
	sessionDir = path.join(sandboxRoot, "sessions");
	await Promise.all([
		mkdir(projectCwd, { recursive: true }),
		mkdir(outsideDir, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);
	prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
});

afterEach(async () => {
	delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
	if (prevAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = prevAgentDir;
	}
	await rm(sandboxRoot, { recursive: true, force: true });
});

/** Spellings Pi's write and edit tools resolve to a file in `outsideDir`, each with the file it names. */
function outsideSpellings(): { spelling: string; target: string }[] {
	const target = (name: string) => path.join(outsideDir, name);
	return [
		{ spelling: `@${target("at-absolute.txt")}`, target: target("at-absolute.txt") },
		{ spelling: "@../outside/at-parent.txt", target: target("at-parent.txt") },
		{ spelling: `file://${target("file-url.txt")}`, target: target("file-url.txt") },
		{ spelling: `@file://${target("at-file-url.txt")}`, target: target("at-file-url.txt") },
	];
}

/** A real Pi session on the faux provider, bound without UI, so unapproved external writes are blocked. */
async function startHeadlessSession() {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		api: "workspace-at-prefix-api",
		provider: "workspace-at-prefix",
		models: [{ id: "test" }],
	});
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false, keepRecentTokens: 1 },
	});

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				additionalExtensionPaths: [extensionPath],
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
					},
				],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: faux.getModel("test"),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: projectCwd,
		agentDir,
		sessionManager: SessionManager.create(projectCwd, sessionDir),
	});
	await runtime.session.bindExtensions({ mode: "print" });

	return {
		session: runtime.session,
		faux,
		toolResults: () =>
			runtime.session.sessionManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult"
						? [
								{
									isError: Boolean((entry.message as { isError?: boolean }).isError),
									text: ((entry.message as { content?: { text?: string }[] }).content ?? [])
										.map((part) => part.text ?? "")
										.join(""),
								},
							]
						: [],
				),
		dispose: () => runtime.dispose(),
	};
}

type ToolCallHandler = (
	event: { toolName: string; input: unknown },
	ctx: ExtensionContext,
) => Promise<ToolCallEventResult | undefined>;

/** The extension's `tool_call` handler, for judging a call without running its tool. */
function loadToolCallHandler(): ToolCallHandler {
	let toolCall: ToolCallHandler | undefined;
	workspaceExtension({
		on: (event: string, handler: ToolCallHandler) => {
			if (event === "tool_call") toolCall = handler;
		},
		registerTool: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI);
	return toolCall!;
}

function handlerContext(select?: (title: string) => Promise<string>): ExtensionContext {
	return {
		cwd: projectCwd,
		mode: select ? "rpc" : "print",
		hasUI: select !== undefined,
		ui: { select },
		sessionManager: { getSessionId: () => "at-prefix-session", getEntries: () => [] },
	} as unknown as ExtensionContext;
}

describe("workspace write guard — paths Pi's write and edit tools resolve differently from a plain path", () => {
	it.each(["write", "edit"] as const)(
		"blocks %s calls whose @ or file:// path leaves the project, naming the real target",
		async (toolName) => {
			const cases = outsideSpellings();
			for (const { target } of cases) {
				await writeFile(target, "original\n", "utf8");
			}
			const h = await startHeadlessSession();
			try {
				h.faux.setResponses([
					fauxAssistantMessage(
						cases.map(({ spelling }) =>
							toolName === "write"
								? fauxToolCall("write", { path: spelling, content: "escaped\n" })
								: fauxToolCall("edit", {
										path: spelling,
										edits: [{ oldText: "original", newText: "escaped" }],
									}),
						),
					),
					fauxAssistantMessage("done"),
				]);
				await h.session.prompt(`${toolName} outside the project`);

				const results = h.toolResults();
				expect(results).toHaveLength(cases.length);
				for (const [index, { spelling, target }] of cases.entries()) {
					expect(results[index]!.text, spelling).toContain(
						`Blocked write outside project working directory: "${resolveCanonicalPath(target)}"`,
					);
					expect(results[index]!.isError, spelling).toBe(true);
					expect(await readFile(target, "utf8"), spelling).toBe("original\n");
				}
				expect(fs.readdirSync(outsideDir).sort()).toEqual(cases.map(({ target }) => path.basename(target)).sort());
			} finally {
				await h.dispose();
			}
		},
	);

	it("blocks @~ write and edit calls exactly like their plain home paths", async () => {
		const toolCall = loadToolCallHandler();
		const home = resolveCanonicalPath(os.homedir());
		for (const toolName of ["write", "edit"]) {
			for (const [spelling, target] of [
				["@~/pi-workspace-at-prefix/f.txt", path.join(home, "pi-workspace-at-prefix", "f.txt")],
				["@~", home],
			] as const) {
				const result = await toolCall({ toolName, input: { path: spelling } }, handlerContext());
				expect(result, `${toolName} ${spelling}`).toMatchObject({ block: true });
				expect(result?.reason).toContain(`Blocked write outside project working directory: "${target}"`);
				expect(result).toEqual(await toolCall({ toolName, input: { path: spelling.slice(1) } }, handlerContext()));
			}
		}
	});

	it("prompts with the real target and records it as the allowed path", async () => {
		const toolCall = loadToolCallHandler();
		const titles: string[] = [];
		const ctx = handlerContext(async (title) => {
			titles.push(title);
			return "Allow for this session";
		});
		const canonicalOutside = resolveCanonicalPath(outsideDir);

		expect(await toolCall({ toolName: "write", input: { path: `@${outsideDir}/allowed.txt` } }, ctx)).toBeUndefined();
		expect(titles).toEqual([`Allow write outside workspace (${path.join(canonicalOutside, "allowed.txt")})?`]);

		// The session allowlist holds the real file, so other spellings of it pass unprompted.
		for (const spelling of [path.join(outsideDir, "allowed.txt"), `file://${outsideDir}/allowed.txt`]) {
			expect(await toolCall({ toolName: "edit", input: { path: spelling } }, ctx), spelling).toBeUndefined();
		}
		expect(titles).toHaveLength(1);
	});

	it("blocks a file:// URL that cannot name a local file", async () => {
		const toolCall = loadToolCallHandler();
		for (const toolName of ["write", "edit"]) {
			const result = await toolCall(
				{ toolName, input: { path: `file://remote-host${outsideDir}/f.txt` } },
				handlerContext(),
			);
			expect(result, toolName).toMatchObject({ block: true });
			expect(result?.reason).toContain(`file://remote-host${outsideDir}/f.txt`);
		}
	});

	it("normalizes a write or edit path the way Pi's file tools do", () => {
		const home = os.homedir();
		for (const [raw, normalized] of [
			["src/plain.txt", "src/plain.txt"],
			["@src/plain.txt", "src/plain.txt"],
			["@/abs/f.txt", "/abs/f.txt"],
			["@../f.txt", "../f.txt"],
			["@~", home],
			["@~/f.txt", path.join(home, "f.txt")],
			["file:///abs/with%20space.txt", "/abs/with space.txt"],
			["@file:///abs/f.txt", "/abs/f.txt"],
			// Only one leading `@` is dropped, and only when it is the very first character.
			["@@/abs/f.txt", "@/abs/f.txt"],
			[" @/abs/f.txt", " @/abs/f.txt"],
			// Unicode spaces become plain spaces before the `@` check.
			["\u00A0@/abs/f.txt", " @/abs/f.txt"],
			["@src/screen\u202Fshot.txt", "src/screen shot.txt"],
			["FILE:///abs/f.txt", "FILE:///abs/f.txt"],
		]) {
			expect(normalizeFileToolPath(raw), JSON.stringify(raw)).toBe(normalized);
		}
	});

	it("keeps in-project @ spellings allowed and bash words literal", async () => {
		const canonicalCwd = resolveCanonicalPath(projectCwd);
		// In a shell, `@name` and `file://...` are ordinary relative names.
		expect(extractBashWriteTargets("echo shell > @at-name.txt", projectCwd)).toEqual([
			path.join(canonicalCwd, "@at-name.txt"),
		]);
		expect(
			extractBashExternalWriteTargets(
				`echo shell > @${outsideDir}/f.txt; touch @~/f.txt @../f.txt; mkdir -p file://${outsideDir}/d`,
				projectCwd,
			),
		).toEqual([]);

		const h = await startHeadlessSession();
		try {
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write", { path: "@src/at-relative.txt", content: "v1\n" }),
					fauxToolCall("write", { path: "@.pi/workspaces/at-ws/notes.txt", content: "notes\n" }),
					fauxToolCall("write", { path: `@@${outsideDir}/double-at.txt`, content: "double\n" }),
					fauxToolCall("write", { path: ` @${outsideDir}/spaced.txt`, content: "spaced\n" }),
				]),
				fauxAssistantMessage([
					fauxToolCall("edit", { path: "@src/at-relative.txt", edits: [{ oldText: "v1", newText: "v2" }] }),
					fauxToolCall("bash", { command: "echo shell > @at-name.txt" }),
				]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("write, edit, and bash inside the project");

			expect(h.toolResults().filter((result) => result.isError)).toEqual([]);
			expect(await readFile(path.join(projectCwd, "src", "at-relative.txt"), "utf8")).toBe("v2\n");
			// The workspace Pi wrote into is the one registered.
			expect(await readFile(path.join(projectCwd, ".pi", "workspaces", "at-ws", "notes.txt"), "utf8")).toBe("notes\n");
			expect((await readRegistry(projectCwd)).map((entry) => entry.name)).toEqual(["at-ws"]);
			// `@@/abs/...` and a leading space keep the path relative: Pi writes these inside the project.
			expect(await readFile(path.join(projectCwd, `@${outsideDir}`, "double-at.txt"), "utf8")).toBe("double\n");
			expect(await readFile(path.join(projectCwd, ` @${outsideDir}`, "spaced.txt"), "utf8")).toBe("spaced\n");
			expect(await readFile(path.join(projectCwd, "@at-name.txt"), "utf8")).toBe("shell\n");
			expect(fs.readdirSync(outsideDir)).toEqual([]);
		} finally {
			await h.dispose();
		}
	});
});
