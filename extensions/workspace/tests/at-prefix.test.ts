import * as fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

describe("workspace write guard — a write or edit path is taken literally once Pi has normalized it", () => {
	let prevHome: string | undefined;
	let canonicalRoot: string;

	// `$HOME` is one path segment for Pi and several once expanded, so every test here pins the home directory.
	beforeEach(async () => {
		prevHome = process.env.HOME;
		process.env.HOME = path.join(sandboxRoot, "home", "user");
		await mkdir(process.env.HOME, { recursive: true });
		canonicalRoot = resolveCanonicalPath(sandboxRoot);
	});

	afterEach(() => {
		if (prevHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = prevHome;
		}
	});

	/** Spellings Pi resolves to `<sandbox>/outside/<name>`: `$HOME` is one directory name, and `..` climbs back out of it. */
	function homeTokenSpellings(name: string): string[] {
		return [
			`a/$HOME/../../../outside/${name}`,
			`a/\${HOME}/../../../outside/${name}`,
			`@a/$HOME/../../../outside/${name}`,
		];
	}

	it("blocks $HOME spellings of an outside file in a real session, creating and changing nothing", async () => {
		const existing = path.join(outsideDir, "existing.txt");
		await writeFile(existing, "original\n", "utf8");
		const h = await startHeadlessSession();
		try {
			h.faux.setResponses([
				fauxAssistantMessage([
					...homeTokenSpellings("created.txt").map((spelling) =>
						fauxToolCall("write", { path: spelling, content: "escaped\n" }),
					),
					...homeTokenSpellings("existing.txt").map((spelling) =>
						fauxToolCall("edit", { path: spelling, edits: [{ oldText: "original", newText: "escaped" }] }),
					),
				]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("write and edit outside the project");

			const results = h.toolResults();
			expect(results).toHaveLength(6);
			for (const [index, result] of results.entries()) {
				const target = path.join(canonicalRoot, "outside", index < 3 ? "created.txt" : "existing.txt");
				expect(result.text, `call ${index}`).toContain(
					`Blocked write outside project working directory: "${target}"`,
				);
				expect(result.isError, `call ${index}`).toBe(true);
			}
			expect(await readFile(existing, "utf8")).toBe("original\n");
			expect(fs.readdirSync(outsideDir)).toEqual(["existing.txt"]);
		} finally {
			await h.dispose();
		}
	});

	it.each(["write", "edit"] as const)(
		"blocks %s calls with $HOME spellings of an outside file, or prompts with the real target",
		async (toolName) => {
			const toolCall = loadToolCallHandler();
			const target = path.join(canonicalRoot, "outside", "f.txt");
			for (const spelling of homeTokenSpellings("f.txt")) {
				const blocked = await toolCall({ toolName, input: { path: spelling } }, handlerContext());
				expect(blocked, spelling).toMatchObject({ block: true });
				expect(blocked?.reason, spelling).toContain(
					`Blocked write outside project working directory: "${target}"`,
				);

				const titles: string[] = [];
				const denied = await toolCall(
					{ toolName, input: { path: spelling } },
					handlerContext(async (title) => {
						titles.push(title);
						return "Deny";
					}),
				);
				expect(denied, spelling).toMatchObject({ block: true });
				expect(titles, spelling).toEqual([`Allow write outside workspace (${target})?`]);
			}
		},
	);

	it("judges a leading space or wrapping quotes as part of the path, not as a /tmp path", async () => {
		const toolCall = loadToolCallHandler();
		// The first segment is a directory named " ", "'", or '"' inside the project, and `..` climbs out of it.
		for (const [spelling, target] of [
			[" /../../tmp/probe/f.txt", path.join(canonicalRoot, "tmp", "probe", "f.txt")],
			["'/../../tmp/probe/q.txt'", path.join(canonicalRoot, "tmp", "probe", "q.txt'")],
			['"/../../tmp/probe/d.txt"', path.join(canonicalRoot, "tmp", "probe", 'd.txt"')],
		] as const) {
			for (const toolName of ["write", "edit"]) {
				const result = await toolCall({ toolName, input: { path: spelling } }, handlerContext());
				expect(result, `${toolName} ${spelling}`).toMatchObject({ block: true });
				expect(result?.reason, `${toolName} ${spelling}`).toContain(
					`Blocked write outside project working directory: "${target}"`,
				);
			}
		}
	});

	it("judges a path that is only a space, or ends in one, as the file of that name", async () => {
		// Links named " ": Pi opens the name as written, so a write lands on the link's target.
		await mkdir(path.join(projectCwd, "dir"), { recursive: true });
		await symlink(path.join(outsideDir, "via-blank.txt"), path.join(projectCwd, " "));
		await symlink(path.join(outsideDir, "via-trailing.txt"), path.join(projectCwd, "dir", " "));
		const cases: [spelling: string, target: string][] = [
			[" ", path.join(canonicalRoot, "outside", "via-blank.txt")],
			// Pi turns a Unicode space into a plain one.
			["\u00A0", path.join(canonicalRoot, "outside", "via-blank.txt")],
			["dir/ ", path.join(canonicalRoot, "outside", "via-trailing.txt")],
		];
		const h = await startHeadlessSession();
		try {
			h.faux.setResponses([
				fauxAssistantMessage(cases.map(([spelling]) => fauxToolCall("write", { path: spelling, content: "escaped\n" }))),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("write through the links");

			const results = h.toolResults();
			expect(results).toHaveLength(cases.length);
			for (const [index, [spelling, target]] of cases.entries()) {
				expect(results[index]!.text, JSON.stringify(spelling)).toContain(
					`Blocked write outside project working directory: "${target}"`,
				);
				expect(results[index]!.isError, JSON.stringify(spelling)).toBe(true);
			}
			expect(fs.readdirSync(outsideDir)).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("allows paths Pi keeps inside the project, without a prompt", async () => {
		const toolCall = loadToolCallHandler();
		const inProject: [spelling: string, file: string][] = [
			[" notes.txt", path.join(projectCwd, " notes.txt")],
			["$HOME/notes.txt", path.join(projectCwd, "$HOME", "notes.txt")],
			["${HOME}/notes.txt", path.join(projectCwd, "${HOME}", "notes.txt")],
			// ` ..` is a directory name, not the parent directory.
			[" ../notes.txt", path.join(projectCwd, " ..", "notes.txt")],
			["'quoted.txt'", path.join(projectCwd, "'quoted.txt'")],
		];
		const titles: string[] = [];
		const ctx = handlerContext(async (title) => {
			titles.push(title);
			return "Deny";
		});
		for (const [spelling] of inProject) {
			for (const toolName of ["write", "edit"]) {
				expect(await toolCall({ toolName, input: { path: spelling } }, ctx), `${toolName} ${spelling}`).toBeUndefined();
			}
		}
		expect(titles).toEqual([]);

		const h = await startHeadlessSession();
		try {
			h.faux.setResponses([
				fauxAssistantMessage(inProject.map(([spelling]) => fauxToolCall("write", { path: spelling, content: "v1\n" }))),
				fauxAssistantMessage(
					inProject.map(([spelling]) =>
						fauxToolCall("edit", { path: spelling, edits: [{ oldText: "v1", newText: "v2" }] }),
					),
				),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("write and edit inside the project");

			expect(h.toolResults().filter((result) => result.isError)).toEqual([]);
			for (const [spelling, file] of inProject) {
				expect(await readFile(file, "utf8"), spelling).toBe("v2\n");
			}
			expect(fs.readdirSync(outsideDir)).toEqual([]);
			expect(fs.readdirSync(os.homedir())).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("keeps the ../ rule for the path as Pi reads it", async () => {
		const toolCall = loadToolCallHandler();
		const sibling = `${path.basename(sandboxRoot)}-sibling`;
		const target = path.join(resolveCanonicalPath(os.tmpdir()), sibling, "f.txt");

		// A temp path outside this sandbox is allowed by its absolute spelling, but not by climbing out with `../`.
		expect(await toolCall({ toolName: "write", input: { path: target } }, handlerContext())).toBeUndefined();
		for (const spelling of [`../../${sibling}/f.txt`, `@../../${sibling}/f.txt`]) {
			for (const toolName of ["write", "edit"]) {
				const result = await toolCall({ toolName, input: { path: spelling } }, handlerContext());
				expect(result, `${toolName} ${spelling}`).toMatchObject({ block: true });
				expect(result?.reason, `${toolName} ${spelling}`).toContain(
					`Blocked write outside project working directory: "${target}"`,
				);
			}
		}
		// With a leading space the first segment is a directory named ` ..`, so Pi stays inside the project.
		expect(
			await toolCall({ toolName: "write", input: { path: ` ../../${sibling}/f.txt` } }, handlerContext()),
		).toBeUndefined();
	});

	it("follows a dangling symlink's target text the way the OS does", async () => {
		const toolCall = loadToolCallHandler();
		// The OS reads link text literally: `$HOME` and " " are directory names to climb out of.
		await mkdir(path.join(projectCwd, "a", "$HOME"), { recursive: true });
		await mkdir(path.join(projectCwd, " "), { recursive: true });
		await mkdir(path.join(sandboxRoot, "tmp", "probe"), { recursive: true });
		await symlink("$HOME/../../../outside/via-home.txt", path.join(projectCwd, "a", "home-link"));
		await symlink(" /../../tmp/probe/via-space.txt", path.join(projectCwd, "space-link"));
		const links: [spelling: string, target: string][] = [
			["a/home-link", path.join(canonicalRoot, "outside", "via-home.txt")],
			["space-link", path.join(canonicalRoot, "tmp", "probe", "via-space.txt")],
		];

		for (const [spelling, target] of links) {
			for (const toolName of ["write", "edit"]) {
				const result = await toolCall({ toolName, input: { path: spelling } }, handlerContext());
				expect(result, `${toolName} ${spelling}`).toMatchObject({ block: true });
				expect(result?.reason, `${toolName} ${spelling}`).toContain(
					`Blocked write outside project working directory: "${target}"`,
				);
			}
		}
		// A shell follows the same links.
		expect(extractBashExternalWriteTargets("touch a/home-link space-link", projectCwd)).toEqual(
			links.map(([, target]) => target),
		);

		// Writing through each link creates exactly the file the guard named.
		for (const [spelling, target] of links) {
			await writeFile(path.join(projectCwd, spelling), "followed\n", "utf8");
			expect(await readFile(target, "utf8"), spelling).toBe("followed\n");
		}
	});

	it("still expands ~ and $HOME in bash words", async () => {
		const toolCall = loadToolCallHandler();
		const home = path.join(canonicalRoot, "home", "user");
		expect(extractBashWriteTargets('touch $HOME/a.txt ~/b.txt "${HOME}/c.txt"; mkdir -p ~', projectCwd)).toEqual([
			path.join(home, "a.txt"),
			path.join(home, "b.txt"),
			path.join(home, "c.txt"),
			home,
		]);
		// The spelling `write` and `edit` are blocked for stays inside the project once a shell expands `$HOME`.
		expect(extractBashExternalWriteTargets("echo shell > a/$HOME/../../../outside/f.txt", projectCwd)).toEqual([]);

		const result = await toolCall(
			{ toolName: "bash", input: { command: 'mkdir -p "$HOME/d" && touch ~/e.txt' } },
			handlerContext(),
		);
		expect(result).toMatchObject({ block: true });
		expect(result?.reason).toContain(`Blocked write outside project working directory: "${path.join(home, "d")}"`);
	});

	it("judges a quoted or escaped $HOME in a bash word as the directory name bash keeps", async () => {
		const toolCall = loadToolCallHandler();
		// For bash `a/$HOME` is two directories deep, so `../../..` leaves the project for the sibling directory.
		const target = path.join(canonicalRoot, "outside", "f.txt");
		for (const command of [
			"touch 'a/$HOME/../../../outside/f.txt'",
			"touch a/\\$HOME/../../../outside/f.txt",
			// The directory `cd` entered keeps its name for the words that follow.
			"cd 'a/$HOME' && touch ../../../outside/f.txt",
		]) {
			expect(extractBashWriteTargets(command, projectCwd), command).toEqual([target]);
			const blocked = await toolCall({ toolName: "bash", input: { command } }, handlerContext());
			expect(blocked, command).toMatchObject({ block: true });
			expect(blocked?.reason, command).toContain(`Blocked write outside project working directory: "${target}"`);

			const titles: string[] = [];
			const denied = await toolCall(
				{ toolName: "bash", input: { command } },
				handlerContext(async (title) => {
					titles.push(title);
					return "Deny";
				}),
			);
			expect(denied, command).toMatchObject({ block: true });
			expect(titles, command).toEqual([`Allow write outside workspace (${target})?`]);
		}
	});

	it("allows bash words that a quoted or escaped ~, $HOME, or space keeps inside the project, without a prompt", async () => {
		const toolCall = loadToolCallHandler();
		const canonicalCwd = resolveCanonicalPath(projectCwd);
		// Quoted or escaped, `~` and `$HOME` are directory names, and a leading space is part of the file name.
		const inProject: [command: string, file: string][] = [
			["touch '~/f.txt'", path.join(canonicalCwd, "~", "f.txt")],
			['touch "~/f.txt"', path.join(canonicalCwd, "~", "f.txt")],
			["touch \\~/f.txt", path.join(canonicalCwd, "~", "f.txt")],
			["touch '$HOME/f'", path.join(canonicalCwd, "$HOME", "f")],
			["echo x > ' notes.txt'", path.join(canonicalCwd, " notes.txt")],
			["cd '$HOME' && touch f", path.join(canonicalCwd, "$HOME", "f")],
		];
		const titles: string[] = [];
		const ui = handlerContext(async (title) => {
			titles.push(title);
			return "Deny";
		});
		for (const [command, file] of inProject) {
			expect(extractBashWriteTargets(command, projectCwd), command).toEqual([file]);
			expect(await toolCall({ toolName: "bash", input: { command } }, ui), command).toBeUndefined();
			expect(await toolCall({ toolName: "bash", input: { command } }, handlerContext()), command).toBeUndefined();
		}
		expect(titles).toEqual([]);

		const h = await startHeadlessSession();
		try {
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "mkdir -p '~' '$HOME'" })]),
				...inProject.map(([command]) => fauxAssistantMessage([fauxToolCall("bash", { command })])),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("create files inside the project");

			expect(h.toolResults().filter((result) => result.isError)).toEqual([]);
			// bash created exactly the files the guard named.
			expect(fs.readdirSync(projectCwd).sort()).toEqual([" notes.txt", "$HOME", ".pi", "~"]);
			expect(fs.readdirSync(path.join(projectCwd, "~"))).toEqual(["f.txt"]);
			expect(fs.readdirSync(path.join(projectCwd, "$HOME"))).toEqual(["f"]);
			expect(await readFile(path.join(projectCwd, " notes.txt"), "utf8")).toBe("x\n");
			expect(fs.readdirSync(outsideDir)).toEqual([]);
			expect(fs.readdirSync(os.homedir())).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("judges bash words whose ~, $HOME, or ${HOME} bash expands in the home directory", async () => {
		const toolCall = loadToolCallHandler();
		const home = path.join(canonicalRoot, "home", "user");
		for (const [command, target] of [
			["touch ~/e.txt", path.join(home, "e.txt")],
			['mkdir -p "$HOME/d"', path.join(home, "d")],
			["touch ${HOME}/e.txt", path.join(home, "e.txt")],
			// A leading `~` also expands right after `of=`, and `cd` alone goes home.
			["dd if=/dev/zero of=~/x", path.join(home, "x")],
			["cd && touch f", path.join(home, "f")],
			// A backslash-newline is gone before bash reads the word.
			["touch ~\\\n/e.txt", path.join(home, "e.txt")],
			["touch $HO\\\nME/e.txt", path.join(home, "e.txt")],
		] as const) {
			expect(extractBashWriteTargets(command, projectCwd), command).toEqual([target]);
			const result = await toolCall({ toolName: "bash", input: { command } }, handlerContext());
			expect(result, command).toMatchObject({ block: true });
			expect(result?.reason, command).toContain(`Blocked write outside project working directory: "${target}"`);
		}
	});
});
