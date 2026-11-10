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
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { CHILD_SESSION_HOOKS, WORKSPACE_SHARED_KEY } from "../index.ts";
import { policyFilePath, readProjectPolicy, resolveCanonicalPath } from "../policy.ts";

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
