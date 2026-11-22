// Shared Pi AgentSessionRuntime test harness for the Language extension suites.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
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
} from "@earendil-works/pi-coding-agent";

// Load by path, as Pi does.
export const LANGUAGE_EXTENSION_PATH = fileURLToPath(new URL("../../index.ts", import.meta.url));

export type Message = { role: string; content: unknown };
export interface Captured {
	system: string;
	systems: number;
	conversation: Message[];
}

export const capture = (messages: Parameters<typeof getCurrentSystemPrompt>[0]): Captured => {
	const copy = JSON.parse(JSON.stringify(messages)) as Message[];
	return {
		system: getCurrentSystemPrompt(messages),
		systems: copy.filter((message) => message.role === "system").length,
		conversation: copy.filter((message) => message.role !== "system"),
	};
};

export const textOf = ({ content }: Message): string =>
	typeof content === "string"
		? content
		: (content as { text?: string }[]).map((part) => part.text ?? "").join("");

/** What followed the run's starting message in a request: the language message of that run, if any. */
export const afterPrompt = (request: Captured, prompt: string): string[] => {
	const texts = request.conversation.map(textOf);
	const start = texts.lastIndexOf(prompt);
	expect(start).toBeGreaterThanOrEqual(0);
	return texts.slice(start + 1);
};

/** The system prompt is unchanged, and `later` starts with every conversation message of `earlier`, byte for byte. */
export const expectSamePrefix = (later: Captured, earlier: Captured): void => {
	expect(later.system).toBe(earlier.system);
	expect(later.systems).toBeLessThanOrEqual(earlier.systems);
	expect(JSON.stringify(later.conversation.slice(0, earlier.conversation.length))).toBe(JSON.stringify(earlier.conversation));
};

export interface LanguageTestEnv {
	readonly root: string;
	agentDir(): string;
	sessionDir(): string;
	cwd(): string;
	configPath(): string;
	writeConfig(value: unknown): Promise<void>;
	newManager(options?: { parentSession?: string }): SessionManager;
	track(disposable: { dispose(): Promise<void> }): void;
	untrack(disposable: { dispose(): Promise<void> }): void;
	setup(): Promise<void>;
	teardown(): Promise<void>;
}

/** Owns the temp-dir layout (`agent/`, `sessions/`, `work/`), `PI_CODING_AGENT_DIR`, and runtime disposal. */
export function createLanguageTestEnv(prefix = "pi-language-"): LanguageTestEnv {
	let root = "";
	let previousAgentDir: string | undefined;
	const started: { dispose(): Promise<void> }[] = [];

	const agentDir = () => join(root, "agent");
	const sessionDir = () => join(root, "sessions");
	const cwd = () => join(root, "work");
	const configPath = () => join(agentDir(), "language.json");

	return {
		get root() {
			return root;
		},
		agentDir,
		sessionDir,
		cwd,
		configPath,
		writeConfig: (value: unknown) => writeFile(configPath(), typeof value === "string" ? value : JSON.stringify(value)),
		newManager: (options?: { parentSession?: string }) => SessionManager.create(cwd(), sessionDir(), options),
		track(disposable: { dispose(): Promise<void> }) {
			started.push(disposable);
		},
		untrack(disposable: { dispose(): Promise<void> }) {
			const index = started.indexOf(disposable);
			if (index >= 0) started.splice(index, 1);
		},
		async setup() {
			root = await mkdtemp(join(tmpdir(), prefix));
			await Promise.all([agentDir(), sessionDir(), cwd()].map((path) => mkdir(path)));
			previousAgentDir = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agentDir();
		},
		async teardown() {
			try {
				for (const harness of started.splice(0)) await harness.dispose();
			} finally {
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				if (root) {
					await rm(root, { recursive: true, force: true });
					root = "";
				}
			}
		},
	};
}

/** A UI context that records notifications and footer statuses. A plain object: Pi spreads it. */
export function recordingUi() {
	const notes: { message: string; type?: string }[] = [];
	const statuses = new Map<string, string | undefined>();
	const control = { failStatus: false };
	const noop = () => {};
	const context = {
		select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
		onTerminalInput: () => noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop,
		setFooter: noop, setHeader: noop, setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => "",
		addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined, getAllThemes: () => [], getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }), getToolsExpanded: () => false, setToolsExpanded: noop,
		notify: (message: string, type?: string) => { notes.push({ message, type }); },
		setStatus: (key: string, text: string | undefined) => {
			if (control.failStatus) throw new Error("stale context");
			statuses.set(key, text);
		},
	} as unknown as ExtensionUIContext;
	return { notes, statuses, control, context };
}

export interface LanguageSessionRuntimeOptions {
	api?: string;
	provider?: string;
	sessionManager?: SessionManager;
	mode?: ExtensionContext["mode"];
	extension?: boolean;
	register?: (pi: ExtensionAPI) => void;
	bindAsChild?: boolean;
	configureFaux?: (faux: FauxProviderHandle) => void;
}

/** Bootstraps a real Pi AgentSessionRuntime with the language extension and faux provider. */
export async function createLanguageSessionRuntime(env: LanguageTestEnv, options: LanguageSessionRuntimeOptions = {}) {
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({
		api: options.api ?? "language-test-api",
		provider: options.provider ?? "language-test",
		models: [{ id: "test" }],
	});
	options.configureFaux?.(faux);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } });
	const ui = recordingUi();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: options.extension === false ? [] : [LANGUAGE_EXTENSION_PATH],
				extensionFactories: [(pi) => { pi.registerProvider(faux.provider); options.register?.(pi); }],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel("test") });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: env.cwd(),
		agentDir: env.agentDir(),
		sessionManager: options.sessionManager ?? env.newManager(),
	});
	const errors: unknown[] = [];
	const bind = () => runtime.session.bindExtensions(options.bindAsChild ? {} : {
		mode: options.mode ?? "rpc",
		uiContext: ui.context,
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

	let disposed = false;
	const disposable = {
		async dispose() {
			if (disposed) return;
			disposed = true;
			env.untrack(disposable);
			await runtime.dispose();
		},
	};
	env.track(disposable);

	return { runtime, faux, ui, errors, dispose: disposable.dispose };
}
