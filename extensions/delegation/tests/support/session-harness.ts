import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
	type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { registerCoach, type CoachOptions } from "../../coach.ts";
import { registerSwarm } from "../../swarm.ts";

export const DELEGATION_EXTENSION_PATH = fileURLToPath(new URL("../../index.ts", import.meta.url));
export const SESSION_MODES = Symbol.for("pi-extensions.session-modes");
export const SWARM_BOARDS = Symbol.for("pi-extensions.swarm-boards");
export const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");

export type { SessionModesRegistry } from "../../board.ts";

/** Clears process-global delegation registries and removes the swarm-board child-session hook. */
export function clearDelegationGlobals(): void {
	const shared = globalThis as Record<symbol, unknown>;
	delete shared[SESSION_MODES];
	delete shared[SWARM_BOARDS];
	const hooks = shared[CHILD_SESSION_HOOKS] as Set<{ name: string; extensionFactory: ExtensionFactory }> | undefined;
	if (hooks) {
		for (const hook of hooks) {
			if (hook.name === "swarm-board") hooks.delete(hook);
		}
	}
}

export interface DelegationSandbox {
	root: string;
	agentDir: string;
	sessionDir: string;
	cwd: string;
	/** Track a disposable session so cleanup() disposes it in reverse order. */
	track: (disposable: { dispose(): Promise<void> }) => void;
	/** Untrack a session that has already been disposed. */
	untrack: (disposable: { dispose(): Promise<void> }) => void;
	/** Dispose tracked sessions in reverse order, restore PI_CODING_AGENT_DIR, clear delegation globals, and delete root. */
	cleanup: () => Promise<void>;
}

/** Creates an isolated temp workspace, sets PI_CODING_AGENT_DIR, and resets delegation globals. */
export async function createDelegationSandbox(prefix = "pi-delegation-"): Promise<DelegationSandbox> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "work");
	await Promise.all([agentDir, sessionDir, cwd].map((dir) => mkdir(dir)));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	clearDelegationGlobals();

	const tracked: { dispose(): Promise<void> }[] = [];
	return {
		root,
		agentDir,
		sessionDir,
		cwd,
		track(disposable) {
			tracked.push(disposable);
		},
		untrack(disposable) {
			const idx = tracked.indexOf(disposable);
			if (idx >= 0) tracked.splice(idx, 1);
		},
		async cleanup() {
			try {
				for (const session of tracked.splice(0).reverse()) await session.dispose();
			} finally {
				if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
				clearDelegationGlobals();
				await rm(root, { recursive: true, force: true });
			}
		},
	};
}

export interface RecordedNote {
	message: string;
	type?: string;
}

export interface RecordingUi {
	notes: RecordedNote[];
	statuses: Map<string, string | undefined>;
	control: { failStatus: boolean };
	context: ExtensionUIContext;
}

function baseUi(overrides: Partial<Pick<ExtensionUIContext, "notify" | "setStatus">> = {}): ExtensionUIContext {
	const noop = () => {};
	return {
		select: async () => undefined,
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
		notify: noop,
		setStatus: noop,
		...overrides,
	} as unknown as ExtensionUIContext;
}

/** A UI context that records notifications and footer statuses. A plain object: Pi spreads it. */
export function createRecordingUi(): RecordingUi {
	const notes: RecordedNote[] = [];
	const statuses = new Map<string, string | undefined>();
	const control = { failStatus: false };
	const context = baseUi({
		notify: (message: string, type?: string) => {
			notes.push({ message, type });
		},
		setStatus: (key: string, text: string | undefined) => {
			if (control.failStatus) throw new Error("stale context");
			statuses.set(key, text);
		},
	});
	return { notes, statuses, control, context };
}

/** A UI context with no effects. A plain object: Pi spreads it. */
export function createQuietUi(): ExtensionUIContext {
	return baseUi();
}

export type CapturedMessage = {
	role: string;
	content: unknown;
	sections?: unknown;
	toolsAdded?: { name: string }[];
	toolsRemoved?: unknown;
};

export interface CapturedRequest {
	system: string;
	systems: CapturedMessage[];
	conversation: CapturedMessage[];
}

export function captureRequest(messages: Parameters<typeof getCurrentSystemPrompt>[0]): CapturedRequest {
	const copy = JSON.parse(JSON.stringify(messages)) as CapturedMessage[];
	return {
		system: getCurrentSystemPrompt(messages),
		systems: copy.filter((message) => message.role === "system"),
		conversation: copy.filter((message) => message.role !== "system"),
	};
}

export function textOf(message: CapturedMessage): string {
	return typeof message.content === "string"
		? message.content
		: (message.content as { text?: string }[]).map((part) => part.text ?? "").join("");
}

/** What followed the run's starting message in a request. */
export function afterPrompt(request: CapturedRequest, prompt: string): string[] {
	const texts = request.conversation.map(textOf);
	const start = texts.lastIndexOf(prompt);
	expect(start).toBeGreaterThanOrEqual(0);
	return texts.slice(start + 1);
}

export interface CreateDelegationSessionOptions {
	/** Sandbox supplying cwd, agentDir, sessionDir, and automatic lifecycle tracking. */
	sandbox: DelegationSandbox;
	sessionManager?: SessionManager;
	/** Faux provider API identifier (default: "delegation-test-api"). */
	api?: string;
	/** Faux provider name (default: "delegation-test"). */
	provider?: string;
	/** Optional model contextWindow override. */
	contextWindow?: number;
	/** Override in-memory SettingsManager options. */
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	/** Load extensions/delegation/index.ts by path (default: true unless coachOptions is provided). */
	loadExtension?: boolean;
	/** Register swarm + coach directly with custom CoachOptions (clock / thresholds / interval) instead of loading index.ts. */
	coachOptions?: CoachOptions;
	/** Additional ExtensionFactory callbacks registered after the faux provider (and coachOptions, if any). */
	extensionFactories?: ExtensionFactory[];
	/** Session binding mode (default: "rpc"). Ignored when bindAsChild is true. */
	mode?: ExtensionContext["mode"];
	/** UI context style: "recording" (default), "quiet", or "none" (omit uiContext). Ignored when bindAsChild is true. */
	ui?: "recording" | "quiet" | "none";
	/** Bind with bindExtensions({}) as Subagents and Herder bind child sessions. */
	bindAsChild?: boolean;
	/** Whether to wire commandContextActions into bindExtensions (default: true unless bindAsChild is true). */
	commandContextActions?: boolean;
	/** Pre-populate this many capturing "ok" responses on the faux provider. */
	defaultResponses?: number;
}

export interface DelegationSessionHarness {
	runtime: AgentSessionRuntime;
	readonly session: AgentSession;
	readonly sessionId: string;
	readonly events: ExtensionAPI["events"];
	faux: FauxProviderHandle;
	requests: CapturedRequest[];
	errors: unknown[];
	/** Recording UI handle (bound to the session when ui is "recording", the default). */
	ui: RecordingUi;
	dispose: () => Promise<void>;
}

/** Boots a real in-process Pi AgentSession on a per-session faux provider for delegation tests. */
export async function createDelegationSession(
	options: CreateDelegationSessionOptions,
): Promise<DelegationSessionHarness> {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const model = options.contextWindow === undefined ? { id: "test" } : { id: "test", contextWindow: options.contextWindow };
	const faux = fauxProvider({
		api: options.api ?? "delegation-test-api",
		provider: options.provider ?? "delegation-test",
		models: [model],
	});
	const settingsManager = SettingsManager.inMemory(
		options.settings ?? { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } },
	);
	const recordingUi = createRecordingUi();
	const uiMode = options.ui ?? "recording";
	const uiContext = uiMode === "recording" ? recordingUi.context : uiMode === "quiet" ? createQuietUi() : undefined;
	const includeCommandActions = options.commandContextActions ?? true;
	const requests: CapturedRequest[] = [];

	if (options.defaultResponses && options.defaultResponses > 0) {
		const respond: FauxResponseFactory = ({ messages }) => {
			requests.push(captureRequest(messages));
			return fauxAssistantMessage("ok");
		};
		faux.setResponses(Array.from({ length: options.defaultResponses }, () => respond));
	}

	const loadExtension = options.loadExtension ?? !options.coachOptions;
	const additionalExtensionPaths = loadExtension ? [DELEGATION_EXTENSION_PATH] : [];
	let api: ExtensionAPI | undefined;
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
				additionalExtensionPaths,
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
						api = pi;
					},
					...(options.coachOptions
						? [(pi: ExtensionAPI) => { registerCoach(pi, registerSwarm(pi), options.coachOptions); }]
						: []),
					...(options.extensionFactories ?? []),
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

	let runtime: AgentSessionRuntime | undefined;
	let disposed = false;
	const unregisterFaux = () => {
		modelRuntime.unregisterProvider(faux.provider.id);
	};
	const errors: unknown[] = [];

	try {
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: options.sandbox.cwd,
			agentDir: options.sandbox.agentDir,
			sessionManager: options.sessionManager ?? SessionManager.create(options.sandbox.cwd, options.sandbox.sessionDir),
		});
		const activeRuntime = runtime;
		const bind = () => {
			if (options.bindAsChild) {
				return activeRuntime.session.bindExtensions({});
			}
			return activeRuntime.session.bindExtensions({
				mode: options.mode ?? "rpc",
				...(uiContext ? { uiContext } : {}),
				onError: (error) => {
					errors.push(error);
				},
				...(includeCommandActions
					? {
							commandContextActions: {
								waitForIdle: () => activeRuntime.session.waitForIdle(),
								newSession: (newOptions) => activeRuntime.newSession(newOptions),
								fork: (entryId, forkOptions) => activeRuntime.fork(entryId, forkOptions),
								navigateTree: (targetId, treeOptions) => activeRuntime.session.navigateTree(targetId, treeOptions),
								switchSession: (sessionPath, switchOptions) => activeRuntime.switchSession(sessionPath, switchOptions),
								reload: () => activeRuntime.session.reload(),
							},
						}
					: {}),
			});
		};
		activeRuntime.setRebindSession(bind);
		await bind();
	} catch (error) {
		try {
			await runtime?.dispose();
		} finally {
			disposed = true;
			unregisterFaux();
		}
		throw error;
	}

	const activeRuntime = runtime;
	const harness: DelegationSessionHarness = {
		runtime: activeRuntime,
		get session() {
			return activeRuntime.session;
		},
		get sessionId() {
			return activeRuntime.session.sessionManager.getSessionId();
		},
		get events() {
			return api!.events;
		},
		faux,
		requests,
		errors,
		ui: recordingUi,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			options.sandbox.untrack(harness);
			try {
				await activeRuntime.dispose();
			} finally {
				unregisterFaux();
			}
		},
	};
	options.sandbox.track(harness);
	return harness;
}
