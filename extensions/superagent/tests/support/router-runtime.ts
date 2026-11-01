// Real Pi sessions on the faux provider with the superagent extension loaded from index.ts, in a temporary git repository.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionContext, type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
/** The modules index.ts needs; the router tests run once they exist. */
export const modulesExist = ["store", "git", "merge", "git-read", "subagents-host", "hook", "worker-prompt"].every((name) => existsSync(join(SRC, `${name}.ts`)));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

/** A temp directory with an agent dir, a session dir, a git repository with one commit, and a plain directory. */
export class Workspace {
	private constructor(readonly root: string) {}
	static async create(): Promise<Workspace> {
		const workspace = new Workspace(await realpath(await mkdtemp(join(tmpdir(), "pi-superagent-"))));
		for (const dir of [workspace.agentDir, workspace.sessionDir, workspace.repo, workspace.plain]) await mkdir(dir, { recursive: true });
		delete process.env.PI_SUPERAGENT_DISABLED;
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		git(workspace.repo, "init", "-q", "-b", "main");
		git(workspace.repo, "config", "user.email", "test@example.com");
		git(workspace.repo, "config", "user.name", "Test");
		git(workspace.repo, "config", "commit.gpgsign", "false");
		await writeFile(join(workspace.repo, "README.md"), "# demo\n");
		git(workspace.repo, "add", ".");
		git(workspace.repo, "commit", "-q", "-m", "initial commit");
		return workspace;
	}
	get agentDir() { return join(this.root, "agent"); }
	get sessionDir() { return join(this.root, "sessions"); }
	get repo() { return join(this.root, "repo"); }
	get plain() { return join(this.root, "plain"); }
	get commonDir() { return join(this.repo, ".git"); }
	git(...args: string[]) { return git(this.repo, ...args); }
	async settings(value: unknown) { await writeFile(join(this.agentDir, "superagent.json"), JSON.stringify(value)); }
	async cleanup(): Promise<void> {
		try { for (const line of git(this.repo, "worktree", "list", "--porcelain").split("\n")) if (line.startsWith("worktree ") && line.slice(9) !== this.repo) git(this.repo, "worktree", "remove", "--force", line.slice(9)); } catch {}
		await rm(this.root, { recursive: true, force: true });
	}
}

/** A UI context that records notifications, footer statuses, and widgets; every other method is a no-op. */
export class Notes {
	readonly notes: { message: string; type?: string }[] = [];
	readonly statuses = new Map<string, string | undefined>();
	readonly widgets = new Map<string, string[] | undefined>();
	get messages() { return this.notes.map((note) => note.message); }
	get last() { return this.notes.at(-1); }
	context(): ExtensionUIContext {
		// A plain object: Pi spreads the UI context, so every method must be an own property.
		const noop = () => {};
		const methods: Record<string, unknown> = {
			select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
			onTerminalInput: () => noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop,
			setFooter: noop, setHeader: noop, setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => "",
			addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "UI not available" }), getToolsExpanded: () => false, setToolsExpanded: noop,
			notify: (message: string, type?: string) => { this.notes.push({ message, type }); },
			setStatus: (key: string, text: string | undefined) => { this.statuses.set(key, text); },
			setWidget: (key: string, content: unknown) => { this.widgets.set(key, Array.isArray(content) ? [...content as string[]] : undefined); },
		};
		return methods as unknown as ExtensionUIContext;
	}
}

export interface SessionOptions {
	workspace: Workspace;
	cwd?: string;
	mode?: ExtensionContext["mode"];
	sessionManager?: SessionManager;
	faux?: FauxProviderHandle;
	notes?: Notes;
	/** Loaded before superagent (Subagents, as in `pi.extensions`). */
	before?: ExtensionFactory[];
	extensions?: ExtensionFactory[];
}

export interface Harness {
	runtime: AgentSessionRuntime;
	readonly session: AgentSession;
	faux: FauxProviderHandle;
	notes: Notes;
	errors: unknown[];
	shutdown(): Promise<void>;
}

export async function startSession(options: SessionOptions): Promise<Harness> {
	const { default: superagentExtension } = await import("../../index.ts");
	const cwd = options.cwd ?? options.workspace.repo;
	const agentDir = options.workspace.agentDir;
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = options.faux ?? fauxProvider({ api: "superagent-test-api", provider: "superagent-test", models: [{ id: "test" }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const notes = options.notes ?? new Notes();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); }, ...(options.before ?? []), superagentExtension, ...(options.extensions ?? [])],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd, agentDir, sessionManager: options.sessionManager ?? SessionManager.create(cwd, options.workspace.sessionDir),
	});
	const errors: unknown[] = [];
	const bind = () => runtime.session.bindExtensions({
		mode: options.mode ?? "rpc",
		uiContext: notes.context(),
		onError: (error) => { errors.push(error); },
		commandContextActions: {
			waitForIdle: () => runtime.session.waitForIdle(),
			newSession: (newOptions) => runtime.newSession(newOptions),
			fork: (entryId, forkOptions) => runtime.fork(entryId, forkOptions),
			navigateTree: (targetId, treeOptions) => runtime.session.navigateTree(targetId, treeOptions),
			switchSession: (sessionPath, switchOptions) => runtime.switchSession(sessionPath, switchOptions),
			reload: () => runtime.session.reload(),
		},
	});
	runtime.setRebindSession(bind);
	await bind();
	let closed = false;
	return {
		runtime, faux, notes, errors,
		get session() { return runtime.session; },
		async shutdown() { if (closed) return; closed = true; await runtime.dispose(); },
	};
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = "condition"): Promise<void> {
	const started = Date.now();
	for (;;) {
		if (await check()) return;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** The custom-message entries of one type on the session's branch. */
export function customMessages(session: AgentSession, customType: string): { content: unknown; details?: unknown; display: boolean }[] {
	return session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom_message" && entry.customType === customType ? [entry] : []);
}

/** The text of every tool result in the session. */
export function toolResults(session: AgentSession): { name: string; text: string; isError: boolean }[] {
	return session.messages.flatMap((message) => {
		if (message.role !== "toolResult") return [];
		const result = message as { toolName: string; content: { type: string; text?: string }[]; isError: boolean };
		return [{ name: result.toolName, text: result.content.map((part) => part.text ?? "").join(""), isError: result.isError }];
	});
}
