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
	type ExtensionUIContext,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import workspaceExtension, { CHILD_SESSION_HOOKS, settleWorkspaceSweeps, WORKSPACE_SHARED_KEY } from "../index.ts";
import { evaluatePathAccess, policyFilePath, readProjectPolicy, resolveCanonicalPath } from "../policy.ts";

const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));

let sandboxRoot: string;
let projectCwd: string;
let outsideDir: string;
let agentDir: string;
let sessionDir: string;
let prevAgentDir: string | undefined;

beforeEach(async () => {
	sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-approval-scope-"));
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

/** A real Pi session on the faux provider, bound with a UI whose `select` answers from `choices`, then "Deny". */
async function startUiSession(choices: string[] = []) {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		api: "workspace-approval-scope-api",
		provider: "workspace-approval-scope",
		models: [{ id: "test" }],
	});
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false, keepRecentTokens: 1 },
	});

	const prompts: string[] = [];
	const notes: string[] = [];
	const noop = () => {};
	const uiContext = {
		select: async (title: string) => {
			prompts.push(title);
			return choices.shift() ?? "Deny";
		},
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
		onTerminalInput: () => noop,
		setWorkingMessage: noop,
		setWorkingVisible: noop,
		setWorkingIndicator: noop,
		setHiddenThinkingLabel: noop,
		setWidget: noop,
		setFooter: noop,
		setHeader: noop,
		setTitle: noop,
		pasteToEditor: noop,
		setEditorText: noop,
		getEditorText: () => "",
		addAutocompleteProvider: noop,
		setEditorComponent: noop,
		getEditorComponent: () => undefined,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: noop,
		notify: (message: string) => {
			notes.push(message);
		},
		setStatus: noop,
	} as unknown as ExtensionUIContext;

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
	const errors: unknown[] = [];
	await runtime.session.bindExtensions({
		mode: "rpc",
		uiContext,
		onError: (err) => {
			errors.push(err);
		},
		commandContextActions: {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (o) => runtime.newSession(o),
			fork: (id, o) => runtime.fork(id, o),
			navigateTree: (id, o) => runtime.session.navigateTree(id, o),
			switchSession: (p, o) => runtime.switchSession(p, o),
			reload: () => runtime.session.reload(),
		},
	});
	// The automatic sweep stamps .registry.json; let it finish before a test seeds or compares state files.
	await settleWorkspaceSweeps();

	return {
		session: runtime.session,
		faux,
		prompts,
		notes,
		errors,
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

const TOOLS = ["write", "edit", "bash"] as const;

/** A call of `tool` that turns the content of `file` from `from` into `to`; the bash form is a redirect. */
function rewriteCall(tool: (typeof TOOLS)[number], file: string, from: string, to: string) {
	if (tool === "write") return fauxToolCall("write", { path: file, content: `${to}\n` });
	if (tool === "edit") return fauxToolCall("edit", { path: file, edits: [{ oldText: from, newText: to }] });
	return fauxToolCall("bash", { command: `echo ${to} > "${file}"` });
}

function promptTitle(target: string): string {
	return `Allow write outside workspace (${resolveCanonicalPath(target)})?`;
}

/** `<outside>/a.txt` and its sibling `<outside>/b.txt`, both holding `seed`. */
async function seedSiblings(): Promise<{ a: string; b: string }> {
	const a = path.join(outsideDir, "a.txt");
	const b = path.join(outsideDir, "b.txt");
	await Promise.all([writeFile(a, "seed\n", "utf8"), writeFile(b, "seed\n", "utf8")]);
	return { a, b };
}

describe("workspace write guard — an approval covers exactly the path the prompt shows", () => {
	it.each(TOOLS)(
		'"Allow for this session" on a file covers that file and not its directory (%s)',
		async (tool) => {
			const { a, b } = await seedSiblings();
			const h = await startUiSession(["Allow for this session"]);
			try {
				h.faux.setResponses([
					fauxAssistantMessage([rewriteCall(tool, a, "seed", "one")]),
					fauxAssistantMessage([rewriteCall(tool, a, "one", "two")]),
					fauxAssistantMessage([rewriteCall(tool, b, "seed", "one")]),
					fauxAssistantMessage("done"),
				]);
				await h.session.prompt("write a.txt twice, then b.txt");

				// The second write to a.txt shows no prompt; b.txt is put to the user again, who denies it.
				expect(h.prompts).toEqual([promptTitle(a), promptTitle(b)]);
				expect(await readFile(a, "utf8")).toBe("two\n");
				expect(await readFile(b, "utf8")).toBe("seed\n");
				const results = h.toolResults();
				expect(results.map((result) => result.isError)).toEqual([false, false, true]);
				expect(results[2]!.text).toContain(
					`Blocked write outside project working directory: "${resolveCanonicalPath(b)}"`,
				);
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([]);
				expect(h.errors).toEqual([]);
			} finally {
				await h.dispose();
			}
		},
	);

	it.each(TOOLS)(
		'"Allow for this project" records the file and not its directory, and a new session prompts for a sibling (%s)',
		async (tool) => {
			const { a, b } = await seedSiblings();
			const first = await startUiSession(["Allow for this project"]);
			try {
				first.faux.setResponses([
					fauxAssistantMessage([rewriteCall(tool, a, "seed", "one")]),
					fauxAssistantMessage([rewriteCall(tool, b, "seed", "one")]),
					fauxAssistantMessage("done"),
				]);
				await first.session.prompt("write a.txt, then b.txt");

				const allowedPaths = (await readProjectPolicy(projectCwd)).allowedPaths;
				expect(allowedPaths).toContain(resolveCanonicalPath(a));
				expect(allowedPaths).not.toContain(resolveCanonicalPath(outsideDir));
				expect(JSON.parse(await readFile(policyFilePath(projectCwd), "utf8"))).toEqual({
					allowedPaths: [resolveCanonicalPath(a)],
				});
				// The approving session prompts for the sibling too; the user denies it.
				expect(first.prompts).toEqual([promptTitle(a), promptTitle(b)]);
				expect(await readFile(a, "utf8")).toBe("one\n");
				expect(await readFile(b, "utf8")).toBe("seed\n");
				expect(first.errors).toEqual([]);
			} finally {
				await first.dispose();
			}

			// A new Pi process: only policy.json carries the approval over.
			delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
			const later = await startUiSession();
			try {
				later.faux.setResponses([
					fauxAssistantMessage([rewriteCall(tool, a, "one", "two")]),
					fauxAssistantMessage([rewriteCall(tool, b, "seed", "one")]),
					fauxAssistantMessage("done"),
				]);
				await later.session.prompt("write a.txt, then b.txt");
				expect(later.prompts).toEqual([promptTitle(b)]);
				expect(await readFile(a, "utf8")).toBe("two\n");
				expect(await readFile(b, "utf8")).toBe("seed\n");
				expect(later.errors).toEqual([]);
			} finally {
				await later.dispose();
			}
		},
	);

	it.each(["Allow for this session", "Allow for this project"])(
		'"%s" on a bash target that is an existing outside directory allows files in it, and nothing next to it',
		async (choice) => {
			const dir = path.join(outsideDir, "existing-dir");
			const sibling = path.join(outsideDir, "b.txt");
			await mkdir(dir);
			await writeFile(path.join(projectCwd, "seed.txt"), "seed\n", "utf8");

			const h = await startUiSession([choice]);
			try {
				h.faux.setResponses([
					// The copy's target is the directory, so the directory is the path the prompt shows.
					fauxAssistantMessage([fauxToolCall("bash", { command: `cp seed.txt "${dir}"` })]),
					fauxAssistantMessage([fauxToolCall("bash", { command: `echo bash > "${dir}/bash.txt"` })]),
					fauxAssistantMessage([
						fauxToolCall("write", { path: path.join(dir, "nested", "write.txt"), content: "write\n" }),
					]),
					fauxAssistantMessage([fauxToolCall("write", { path: sibling, content: "sibling\n" })]),
					fauxAssistantMessage("done"),
				]);
				await h.session.prompt("copy into the outside directory, then write in it and next to it");

				expect(h.prompts).toEqual([promptTitle(dir), promptTitle(sibling)]);
				expect(await readFile(path.join(dir, "seed.txt"), "utf8")).toBe("seed\n");
				expect(await readFile(path.join(dir, "bash.txt"), "utf8")).toBe("bash\n");
				expect(await readFile(path.join(dir, "nested", "write.txt"), "utf8")).toBe("write\n");
				expect(fs.existsSync(sibling)).toBe(false);
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual(
					choice === "Allow for this project" ? [resolveCanonicalPath(dir)] : [],
				);
				expect(h.errors).toEqual([]);
			} finally {
				await h.dispose();
			}
		},
	);

	it("matches the approved file by its real path: a symlinked spelling of it passes, of its sibling prompts", async () => {
		const { a, b } = await seedSiblings();
		const link = path.join(projectCwd, "link");
		await symlink(outsideDir, link);
		const h = await startUiSession(["Allow for this session"]);
		try {
			h.faux.setResponses([
				fauxAssistantMessage([rewriteCall("write", a, "seed", "one")]),
				fauxAssistantMessage([rewriteCall("edit", path.join(link, "a.txt"), "one", "two")]),
				fauxAssistantMessage([rewriteCall("bash", "link/a.txt", "two", "three")]),
				fauxAssistantMessage([rewriteCall("write", path.join(link, "b.txt"), "seed", "one")]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("write a.txt, then a.txt and b.txt through the link");

			expect(h.prompts).toEqual([promptTitle(a), promptTitle(b)]);
			expect(await readFile(a, "utf8")).toBe("three\n");
			expect(await readFile(b, "utf8")).toBe("seed\n");
			expect(h.errors).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("leaves /workspace allow <dir> as the way to allow a directory", async () => {
		const a = path.join(outsideDir, "a.txt");
		const b = path.join(outsideDir, "b.txt");
		const h = await startUiSession(["Allow for this session"]);
		try {
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: a, content: "a\n" })]),
				fauxAssistantMessage([fauxToolCall("write", { path: b, content: "denied\n" })]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("write a.txt, then b.txt");
			expect(h.prompts).toEqual([promptTitle(a), promptTitle(b)]);
			expect(await readFile(a, "utf8")).toBe("a\n");
			expect(fs.existsSync(b)).toBe(false);

			await h.session.prompt(`/workspace allow ${outsideDir}`);
			expect(h.notes.at(-1)).toBe(`Allowed external path: ${resolveCanonicalPath(outsideDir)}`);
			expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([resolveCanonicalPath(outsideDir)]);

			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path: b, content: "b\n" })]),
				fauxAssistantMessage([fauxToolCall("bash", { command: `echo c > "${outsideDir}/c.txt"` })]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("write b.txt and c.txt");
			expect(h.prompts).toHaveLength(2);
			expect(await readFile(b, "utf8")).toBe("b\n");
			expect(await readFile(path.join(outsideDir, "c.txt"), "utf8")).toBe("c\n");
			expect(h.errors).toEqual([]);
		} finally {
			await h.dispose();
		}
	});
});

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

function handlerContext(choices: string[], prompts: string[], sessionId = "approval-scope-handler"): ExtensionContext {
	return {
		cwd: projectCwd,
		mode: "rpc",
		hasUI: true,
		ui: {
			select: async (title: string) => {
				prompts.push(title);
				return choices.shift() ?? "Deny";
			},
		},
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
	} as unknown as ExtensionContext;
}

const LASTING_CHOICES = ["Allow for this session", "Allow for this project"] as const;

describe("workspace write guard — lasting approvals store and match the exact path shown", () => {
	let prevHome: string | undefined;
	let homeDir: string;
	let canonicalOutside: string;
	let canonicalHome: string;

	beforeEach(async () => {
		prevHome = process.env.HOME;
		const rawHome = path.join(sandboxRoot, "home", "user");
		await mkdir(rawHome, { recursive: true });
		homeDir = resolveCanonicalPath(rawHome);
		process.env.HOME = homeDir;
		canonicalOutside = resolveCanonicalPath(outsideDir);
		canonicalHome = homeDir;
	});

	afterEach(() => {
		if (prevHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = prevHome;
		}
	});

	it.each(LASTING_CHOICES)(
		'"%s" on write to <outside>/$HOME/a.txt allows that path and prompts for the expanded reading',
		async (choice) => {
			const rawTarget = path.join(outsideDir, "$HOME", "a.txt");
			const exact = path.join(canonicalOutside, "$HOME", "a.txt");
			const expanded = path.join(canonicalOutside, canonicalHome, "a.txt");

			const h = await startUiSession([choice]);
			try {
				h.faux.setResponses([
					fauxAssistantMessage([fauxToolCall("write", { path: rawTarget, content: "v1\n" })]),
					fauxAssistantMessage([fauxToolCall("write", { path: rawTarget, content: "v2\n" })]),
					fauxAssistantMessage([
						fauxToolCall("edit", { path: rawTarget, edits: [{ oldText: "v2", newText: "v3" }] }),
					]),
					fauxAssistantMessage([fauxToolCall("bash", { command: `touch '${rawTarget}'` })]),
					fauxAssistantMessage([fauxToolCall("write", { path: expanded, content: "expanded\n" })]),
					fauxAssistantMessage("done"),
				]);
				await h.session.prompt("write, edit, and touch <outside>/$HOME/a.txt, then try the expanded path");

				expect(h.prompts).toEqual([
					`Allow write outside workspace (${exact})?`,
					`Allow write outside workspace (${expanded})?`,
				]);
				expect(await readFile(exact, "utf8")).toBe("v3\n");
				expect(fs.existsSync(expanded)).toBe(false);
				expect(h.toolResults().map((r) => r.isError)).toEqual([false, false, false, false, true]);
				expect(h.errors).toEqual([]);
			} finally {
				await h.dispose();
			}

			if (choice === "Allow for this project") {
				expect(JSON.parse(await readFile(policyFilePath(projectCwd), "utf8"))).toEqual({
					allowedPaths: [exact],
				});
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([exact]);

				delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
				const later = await startUiSession();
				try {
					later.faux.setResponses([
						fauxAssistantMessage([
							fauxToolCall("edit", { path: rawTarget, edits: [{ oldText: "v3", newText: "v4" }] }),
						]),
						fauxAssistantMessage([fauxToolCall("bash", { command: `touch '${rawTarget}'` })]),
						fauxAssistantMessage([fauxToolCall("write", { path: expanded, content: "expanded\n" })]),
						fauxAssistantMessage("done"),
					]);
					await later.session.prompt("reuse project approval in a new session");

					expect(later.prompts).toEqual([`Allow write outside workspace (${expanded})?`]);
					expect(await readFile(exact, "utf8")).toBe("v4\n");
					expect(fs.existsSync(expanded)).toBe(false);
					expect(later.errors).toEqual([]);
				} finally {
					await later.dispose();
				}
			} else {
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([]);
			}
		},
	);

	it.each(LASTING_CHOICES)(
		'"%s" on write to /$HOME allows /$HOME only and still prompts for ~/zzz-probe.txt and absolute home paths',
		async (choice) => {
			const toolCall = loadToolCallHandler();
			const choices = [choice];
			const prompts: string[] = [];
			const ctx = handlerContext(choices, prompts);
			const tildeProbe = "~/zzz-probe.txt";
			const resolvedTildeProbe = path.join(canonicalHome, "zzz-probe.txt");
			const absHomeProbe = path.join(canonicalHome, ".ssh", "zzz-probe");

			expect(await toolCall({ toolName: "write", input: { path: "/$HOME" } }, ctx)).toBeUndefined();
			expect(await toolCall({ toolName: "write", input: { path: "/$HOME" } }, ctx)).toBeUndefined();
			expect(await toolCall({ toolName: "edit", input: { path: "/$HOME" } }, ctx)).toBeUndefined();
			expect(await toolCall({ toolName: "write", input: { path: tildeProbe } }, ctx)).toMatchObject({
				block: true,
			});
			expect(await toolCall({ toolName: "write", input: { path: absHomeProbe } }, ctx)).toMatchObject({
				block: true,
			});

			expect(prompts).toEqual([
				"Allow write outside workspace (/$HOME)?",
				`Allow write outside workspace (${resolvedTildeProbe})?`,
				`Allow write outside workspace (${absHomeProbe})?`,
			]);

			if (choice === "Allow for this project") {
				expect(JSON.parse(await readFile(policyFilePath(projectCwd), "utf8"))).toEqual({
					allowedPaths: ["/$HOME"],
				});
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual(["/$HOME"]);

				delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
				const laterPrompts: string[] = [];
				const laterCtx = handlerContext([], laterPrompts, "later-session");
				expect(await toolCall({ toolName: "write", input: { path: "/$HOME" } }, laterCtx)).toBeUndefined();
				expect(await toolCall({ toolName: "write", input: { path: tildeProbe } }, laterCtx)).toMatchObject({
					block: true,
				});
				expect(await toolCall({ toolName: "write", input: { path: absHomeProbe } }, laterCtx)).toMatchObject({
					block: true,
				});
				expect(laterPrompts).toEqual([
					`Allow write outside workspace (${resolvedTildeProbe})?`,
					`Allow write outside workspace (${absHomeProbe})?`,
				]);
			} else {
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([]);
			}
		},
	);

	it.each(LASTING_CHOICES)(
		'"%s" on write to <outside>/a.txt with a trailing space allows that path and prompts for <outside>/a.txt',
		async (choice) => {
			const rawSpaced = `${path.join(outsideDir, "a.txt")} `;
			const exactSpaced = `${path.join(canonicalOutside, "a.txt")} `;
			const rawTrimmed = path.join(outsideDir, "a.txt");
			const canonicalTrimmed = path.join(canonicalOutside, "a.txt");

			const h = await startUiSession([choice]);
			try {
				h.faux.setResponses([
					fauxAssistantMessage([fauxToolCall("write", { path: rawSpaced, content: "v1\n" })]),
					fauxAssistantMessage([fauxToolCall("write", { path: rawSpaced, content: "v2\n" })]),
					fauxAssistantMessage([fauxToolCall("write", { path: rawTrimmed, content: "trimmed\n" })]),
					fauxAssistantMessage("done"),
				]);
				await h.session.prompt("write trailing-space file twice, then trimmed sibling");

				expect(h.prompts).toEqual([
					`Allow write outside workspace (${exactSpaced})?`,
					`Allow write outside workspace (${canonicalTrimmed})?`,
				]);
				expect(await readFile(exactSpaced, "utf8")).toBe("v2\n");
				expect(fs.existsSync(canonicalTrimmed)).toBe(false);
				expect(h.toolResults().map((r) => r.isError)).toEqual([false, false, true]);
				expect(h.errors).toEqual([]);
			} finally {
				await h.dispose();
			}

			if (choice === "Allow for this project") {
				expect(JSON.parse(await readFile(policyFilePath(projectCwd), "utf8"))).toEqual({
					allowedPaths: [exactSpaced],
				});
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([exactSpaced]);

				delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
				const later = await startUiSession();
				try {
					later.faux.setResponses([
						fauxAssistantMessage([fauxToolCall("write", { path: rawSpaced, content: "v3\n" })]),
						fauxAssistantMessage([fauxToolCall("write", { path: rawTrimmed, content: "trimmed\n" })]),
						fauxAssistantMessage("done"),
					]);
					await later.session.prompt("reuse trailing-space project approval in a new session");

					expect(later.prompts).toEqual([`Allow write outside workspace (${canonicalTrimmed})?`]);
					expect(await readFile(exactSpaced, "utf8")).toBe("v3\n");
					expect(fs.existsSync(canonicalTrimmed)).toBe(false);
					expect(later.errors).toEqual([]);
				} finally {
					await later.dispose();
				}
			} else {
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([]);
			}
		},
	);

	it.each(LASTING_CHOICES)(
		'"%s" on bash target touch \'<outside>/$HOME/b.txt\' stores and matches that exact path',
		async (choice) => {
			const literalDir = path.join(outsideDir, "$HOME");
			await mkdir(literalDir, { recursive: true });
			const rawTarget = path.join(literalDir, "b.txt");
			const exact = path.join(canonicalOutside, "$HOME", "b.txt");
			const expanded = path.join(canonicalOutside, canonicalHome, "b.txt");

			const h = await startUiSession([choice]);
			try {
				h.faux.setResponses([
					fauxAssistantMessage([fauxToolCall("bash", { command: `touch '${rawTarget}'` })]),
					fauxAssistantMessage([fauxToolCall("bash", { command: `touch '${rawTarget}'` })]),
					fauxAssistantMessage([fauxToolCall("write", { path: rawTarget, content: "v1\n" })]),
					fauxAssistantMessage([
						fauxToolCall("edit", { path: rawTarget, edits: [{ oldText: "v1", newText: "v2" }] }),
					]),
					fauxAssistantMessage([fauxToolCall("bash", { command: `touch "${rawTarget}"` })]),
					fauxAssistantMessage([fauxToolCall("write", { path: expanded, content: "expanded\n" })]),
					fauxAssistantMessage("done"),
				]);
				await h.session.prompt("approve bash touch on literal $HOME path, then reuse and test expanded path");

				expect(h.prompts).toEqual([
					`Allow write outside workspace (${exact})?`,
					`Allow write outside workspace (${expanded})?`,
					`Allow write outside workspace (${expanded})?`,
				]);
				expect(await readFile(exact, "utf8")).toBe("v2\n");
				expect(fs.existsSync(expanded)).toBe(false);
				expect(h.toolResults().map((r) => r.isError)).toEqual([false, false, false, false, true, true]);
				expect(h.errors).toEqual([]);
			} finally {
				await h.dispose();
			}

			if (choice === "Allow for this project") {
				expect(JSON.parse(await readFile(policyFilePath(projectCwd), "utf8"))).toEqual({
					allowedPaths: [exact],
				});
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([exact]);

				delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
				const later = await startUiSession();
				try {
					later.faux.setResponses([
						fauxAssistantMessage([fauxToolCall("bash", { command: `touch '${rawTarget}'` })]),
						fauxAssistantMessage([fauxToolCall("write", { path: expanded, content: "expanded\n" })]),
						fauxAssistantMessage("done"),
					]);
					await later.session.prompt("reuse bash project approval in a new session");

					expect(later.prompts).toEqual([`Allow write outside workspace (${expanded})?`]);
					expect(fs.existsSync(expanded)).toBe(false);
					expect(later.errors).toEqual([]);
				} finally {
					await later.dispose();
				}
			} else {
				expect((await readProjectPolicy(projectCwd)).allowedPaths).toEqual([]);
			}
		},
	);

	it("expands ~/x and $HOME/y once in /workspace allow and /workspace deny without expanding stored session entries", async () => {
		const rawSpaced = `${path.join(outsideDir, "keep")} `;
		const exactSpaced = `${path.join(canonicalOutside, "keep")} `;
		const h = await startUiSession(["Allow for this session"]);
		try {
			await h.session.prompt("/workspace allow ~/x");
			expect(h.notes.at(-1)).toBe(`Allowed external path: ${path.join(canonicalHome, "x")}`);
			await h.session.prompt("/workspace allow $HOME/y");
			expect(h.notes.at(-1)).toBe(`Allowed external path: ${path.join(canonicalHome, "y")}`);
			expect(JSON.parse(await readFile(policyFilePath(projectCwd), "utf8"))).toEqual({
				allowedPaths: [path.join(canonicalHome, "x"), path.join(canonicalHome, "y")],
			});

			// Approve `<outside>/keep ` for the session, and verify ~/x and $HOME/y allow files under them.
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write", { path: "~/x/f.txt", content: "x\n" }),
					fauxToolCall("write", { path: path.join(homeDir, "y", "f.txt"), content: "y\n" }),
					fauxToolCall("write", { path: rawSpaced, content: "v1\n" }),
				]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("write under ~/x, $HOME/y, and trailing-space session path");
			expect(h.prompts).toEqual([`Allow write outside workspace (${exactSpaced})?`]);

			// `/workspace deny ~/x` removes `<home>/x`; `/workspace deny <outside>/keep` does not strip the space off `<outside>/keep `.
			await h.session.prompt("/workspace deny ~/x");
			expect(h.notes.at(-1)).toBe(`Denied external path: ${path.join(canonicalHome, "x")}`);
			expect(JSON.parse(await readFile(policyFilePath(projectCwd), "utf8"))).toEqual({
				allowedPaths: [path.join(canonicalHome, "y")],
			});
			await h.session.prompt(`/workspace deny ${path.join(outsideDir, "keep")}`);

			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write", { path: "~/x/f2.txt", content: "blocked\n" }),
					fauxToolCall("write", { path: path.join(homeDir, "y", "f2.txt"), content: "y2\n" }),
					fauxToolCall("write", { path: rawSpaced, content: "v2\n" }),
				]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("verify ~/x denied, $HOME/y kept, and trailing-space session entry kept");

			expect(h.prompts).toEqual([
				`Allow write outside workspace (${exactSpaced})?`,
				`Allow write outside workspace (${path.join(canonicalHome, "x", "f2.txt")})?`,
			]);
			expect(fs.existsSync(path.join(canonicalHome, "x", "f2.txt"))).toBe(false);
			expect(await readFile(path.join(canonicalHome, "y", "f2.txt"), "utf8")).toBe("y2\n");
			expect(await readFile(exactSpaced, "utf8")).toBe("v2\n");
			expect(h.errors).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("does not expand a hand-written ~/x or $HOME/y entry in policy.json", async () => {
		await mkdir(path.dirname(policyFilePath(projectCwd)), { recursive: true });
		await writeFile(
			policyFilePath(projectCwd),
			`${JSON.stringify({ allowedPaths: ["~/x", "$HOME/y"] }, null, 2)}\n`,
			"utf8",
		);

		const h = await startUiSession();
		try {
			const xFile = path.join(homeDir, "x", "f.txt");
			const yFile = path.join(homeDir, "y", "f.txt");
			h.faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("write", { path: xFile, content: "x\n" }),
					fauxToolCall("write", { path: yFile, content: "y\n" }),
				]),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("try writing under <home>/x and <home>/y");

			expect(h.prompts).toEqual([
				`Allow write outside workspace (${path.join(canonicalHome, "x", "f.txt")})?`,
				`Allow write outside workspace (${path.join(canonicalHome, "y", "f.txt")})?`,
			]);
			expect(fs.existsSync(xFile)).toBe(false);
			expect(fs.existsSync(yFile)).toBe(false);
			expect(h.toolResults().map((r) => r.isError)).toEqual([true, true]);
			expect(h.errors).toEqual([]);
		} finally {
			await h.dispose();
		}
	});

	it("reads sessionAllowed, projectAllowed, and extraAllowed entries literally with or without literal", async () => {
		const link = path.join(projectCwd, "outside-link");
		await symlink(outsideDir, link);
		const literalHomeEntry = path.join(canonicalOutside, "$HOME", "a.txt");
		const expandedHomeTarget = path.join(canonicalOutside, canonicalHome, "a.txt");
		const spacedEntry = `${path.join(canonicalOutside, "spaced.txt")} `;
		const trimmedTarget = path.join(canonicalOutside, "spaced.txt");

		for (const literal of [false, true]) {
			for (const listName of ["sessionAllowed", "projectAllowed", "extraAllowed"] as const) {
				expect(
					evaluatePathAccess({
						targetPath: literalHomeEntry,
						cwd: projectCwd,
						literal: true,
						[listName]: [literalHomeEntry],
					}).allowed,
					`${listName} exact $HOME (literal=${literal})`,
				).toBe(true);
				expect(
					evaluatePathAccess({
						targetPath: expandedHomeTarget,
						cwd: projectCwd,
						literal,
						[listName]: [literalHomeEntry],
					}).allowed,
					`${listName} expanded $HOME (literal=${literal})`,
				).toBe(false);
				expect(
					evaluatePathAccess({
						targetPath: trimmedTarget,
						cwd: projectCwd,
						literal,
						[listName]: [spacedEntry],
					}).allowed,
					`${listName} trimmed vs trailing space (literal=${literal})`,
				).toBe(false);
				// Relative and symlinked entries still resolve against cwd and follow symlinks without ~/$HOME expansion.
				expect(
					evaluatePathAccess({
						targetPath: path.join(canonicalOutside, "rel-ok.txt"),
						cwd: projectCwd,
						literal,
						[listName]: ["outside-link/rel-ok.txt"],
					}).allowed,
					`${listName} relative symlinked entry (literal=${literal})`,
				).toBe(true);
				expect(
					evaluatePathAccess({
						targetPath: path.join(canonicalHome, "x", "f.txt"),
						cwd: projectCwd,
						literal,
						[listName]: ["~/x"],
					}).allowed,
					`${listName} ~/x entry (literal=${literal})`,
				).toBe(false);
			}
		}
	});
});
