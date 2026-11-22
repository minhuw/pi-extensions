// Shared in-process Pi AgentSession test harness for selfdrive test suites.
import { expect } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
	type FauxResponseFactory,
	type FauxResponseStep,
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
	type Extension,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type ExtensionUIContext,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { grants, type StandingApproval } from "../../grants.ts";
import { CHILD_SESSION_HOOKS, runtime as selfdriveRuntime, type ChildSessionHook } from "../../index.ts";

export interface RecordedMessage {
	role: string;
	content: unknown;
}

export interface RecordedRequest {
	texts: string[];
}

export interface RecordedToolResult {
	role: "toolResult";
	toolName: string;
	isError: boolean;
	content: { type: string; text?: string }[];
	details?: Record<string, unknown>;
}

export interface SimpleToolResult {
	isError: boolean;
	text: string;
}

export interface RecordedNote {
	message: string;
	type?: string;
}

export interface RecordedConfirm {
	title: string;
	body: string;
}

export interface RecordingUi {
	notes: RecordedNote[];
	statuses: Map<string, string | undefined>;
	confirms: RecordedConfirm[];
	control: { confirm: (title: string) => Promise<boolean> };
	context: ExtensionUIContext;
}

export interface KeepAwakeCounter {
	started: number;
	killed: number;
}

export interface KeepAwakeStub {
	awake: KeepAwakeCounter;
	restore: () => void;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await sleep(5);
	}
}

/** Wait until the provider saw `count` requests and the session settled. */
export async function settle(
	session: AgentSession,
	requests: readonly unknown[],
	count: number,
	timeoutMs = 4_000,
): Promise<void> {
	await until(() => requests.length >= count, timeoutMs);
	await session.waitForIdle();
	await sleep(10);
	expect(requests.length).toBe(count);
}

export function textOf({ content }: { content: unknown }): string {
	return typeof content === "string"
		? content
		: (content as { text?: string }[]).map((part) => part.text ?? "").join("");
}

/** Scopes `PI_CODING_AGENT_DIR` to `agentDir` and returns an idempotent restore callback. */
export function scopeAgentDir(agentDir: string): () => void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	};
}

/** Replaces `selfdriveRuntime.keepAwake` with a counting stub and returns an idempotent restore callback. */
export function stubKeepAwake(): KeepAwakeStub {
	const saved = selfdriveRuntime.keepAwake;
	const awake: KeepAwakeCounter = { started: 0, killed: 0 };
	selfdriveRuntime.keepAwake = () => {
		awake.started++;
		return { kill: () => { awake.killed++; } };
	};
	let restored = false;
	return {
		awake,
		restore: () => {
			if (restored) return;
			restored = true;
			selfdriveRuntime.keepAwake = saved;
		},
	};
}

/** A UI context that records notifications, statuses, and confirms, whose answers the test chooses. A plain object: Pi spreads it. */
export function createRecordingUi(): RecordingUi {
	const notes: RecordedNote[] = [];
	const statuses = new Map<string, string | undefined>();
	const confirms: RecordedConfirm[] = [];
	const control = { confirm: (_title: string): Promise<boolean> => Promise.resolve(true) };
	const noop = () => {};
	const context = {
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined,
		confirm: (title: string, body: string) => {
			confirms.push({ title, body });
			return control.confirm(title);
		},
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
		notify: (message: string, type?: string) => { notes.push({ message, type }); },
		setStatus: (key: string, text: string | undefined) => { statuses.set(key, text); },
	} as unknown as ExtensionUIContext;
	return { notes, statuses, confirms, control, context };
}

/** Reads registered child-session hooks from `Symbol.for("pi-extensions.child-session-hooks")`. */
export function childHookFactories(): InlineExtension[] {
	const hooks = (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
	if (!(hooks instanceof Set)) return [];
	return [...(hooks as Set<ChildSessionHook>)]
		.filter((hook) => typeof hook?.name === "string" && typeof hook.extensionFactory === "function")
		.map((hook) => ({ name: hook.name, factory: hook.extensionFactory }));
}

function createCommandContextActions(runtime: AgentSessionRuntime) {
	return {
		waitForIdle: () => runtime.session.waitForIdle(),
		newSession: (newOptions?: Parameters<AgentSessionRuntime["newSession"]>[0]) => runtime.newSession(newOptions),
		fork: (entryId: string, forkOptions?: Parameters<AgentSessionRuntime["fork"]>[1]) => runtime.fork(entryId, forkOptions),
		navigateTree: (targetId: string, treeOptions?: Parameters<AgentSession["navigateTree"]>[1]) => runtime.session.navigateTree(targetId, treeOptions),
		switchSession: (sessionPath: string, switchOptions?: Parameters<AgentSessionRuntime["switchSession"]>[1]) => runtime.switchSession(sessionPath, switchOptions),
		reload: () => runtime.session.reload(),
	};
}

function extractSimpleToolResults(session: AgentSession): SimpleToolResult[] {
	return session.sessionManager.getBranch().flatMap((entry) =>
		entry.type === "message" && entry.message.role === "toolResult"
			? [{
				isError: Boolean(entry.message.isError),
				text: entry.message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
			}]
			: [],
	);
}

export interface StartSelfdriveSessionOptions {
	cwd: string;
	agentDir: string;
	/** Directory for persisted session files; omit to use `SessionManager.inMemory(cwd)`. */
	sessionDir?: string;
	/** Explicit session manager (overrides `sessionDir`). */
	sessionManager?: SessionManager;
	api?: string;
	provider?: string;
	keepRecentTokens?: number;
	noExtensions?: boolean;
	additionalExtensionPaths?: string[];
	extensionFactories?: (ExtensionFactory | InlineExtension)[];
	register?: (pi: ExtensionAPI) => void;
	script?: FauxResponseStep[];
	settleTimeoutMs?: number;
	mode?: ExtensionContext["mode"];
	/** Bind with `{}` instead of UI and commandContextActions (matches child sessions). */
	bindAsChild?: boolean;
}

export interface SelfdriveSessionHarness extends RecordingUi {
	runtime: AgentSessionRuntime;
	faux: FauxProviderHandle;
	requests: RecordedRequest[];
	script: FauxResponseStep[];
	readonly session: AgentSession;
	readonly id: string;
	readonly status: string | undefined;
	readonly lastNote: RecordedNote | undefined;
	readonly grant: StandingApproval | undefined;
	activeTools: () => string[];
	command: (text: string) => Promise<void>;
	settle: (count: number, timeoutMs?: number) => Promise<void>;
	entries: () => Record<string, unknown>[];
	tasks: () => Record<string, unknown>[];
	toolResults: () => RecordedToolResult[];
	messages: () => { content: string; details: Record<string, unknown> }[];
	dispose: () => Promise<void>;
}

/** Boots a full in-process Pi AgentSessionRuntime on the faux provider with recording UI and rebind support. */
export async function startSelfdriveSession(options: StartSelfdriveSessionOptions): Promise<SelfdriveSessionHarness> {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		api: options.api ?? "selfdrive-test-api",
		provider: options.provider ?? "selfdrive-test",
		models: [{ id: "test" }],
	});
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: {
			enabled: false,
			...(options.keepRecentTokens !== undefined ? { keepRecentTokens: options.keepRecentTokens } : {}),
		},
	});
	const ui = createRecordingUi();
	const requests: RecordedRequest[] = [];
	let api: ExtensionAPI | undefined;
	const script = [...(options.script ?? [])];
	const respond: FauxResponseFactory = (context, streamOptions, state, model) => {
		const messages = context.messages as unknown as RecordedMessage[];
		requests.push({ texts: messages.filter((message) => message.role !== "system").map(textOf) });
		const step = script.shift();
		return typeof step === "function" ? step(context, streamOptions, state, model) : step ?? fauxAssistantMessage("ok");
	};
	faux.setResponses(Array.from({ length: 200 }, () => respond));

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				...(options.noExtensions !== undefined ? { noExtensions: options.noExtensions } : {}),
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				...(options.additionalExtensionPaths ? { additionalExtensionPaths: options.additionalExtensionPaths } : {}),
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
						api = pi;
						options.register?.(pi);
					},
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

	const sessionManager = options.sessionManager
		?? (options.sessionDir ? SessionManager.create(options.cwd, options.sessionDir) : SessionManager.inMemory(options.cwd));
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: options.cwd,
		agentDir: options.agentDir,
		sessionManager,
	});
	const bind = () => runtime.session.bindExtensions(options.bindAsChild ? {} : {
		mode: options.mode ?? "rpc",
		uiContext: ui.context,
		commandContextActions: createCommandContextActions(runtime),
	});
	runtime.setRebindSession(bind);
	await bind();

	let disposed = false;
	const defaultSettleTimeoutMs = options.settleTimeoutMs ?? 4_000;
	const branch = () => runtime.session.sessionManager.getBranch();
	return {
		runtime,
		faux,
		requests,
		script,
		...ui,
		get session() { return runtime.session; },
		get id() { return runtime.session.sessionManager.getSessionId(); },
		get status() { return ui.statuses.get("selfdrive"); },
		get lastNote() { return ui.notes.at(-1); },
		get grant() { return grants().find((grant) => grant.id === runtime.session.sessionManager.getSessionId()); },
		activeTools: () => api!.getActiveTools(),
		command: (text: string) => runtime.session.prompt(text),
		settle: (count: number, timeoutMs = defaultSettleTimeoutMs) => settle(runtime.session, requests, count, timeoutMs),
		entries: () => branch().flatMap((entry) => entry.type === "custom" && entry.customType === "selfdrive" ? [entry.data as Record<string, unknown>] : []),
		tasks: () => branch().flatMap((entry) => entry.type === "custom" && entry.customType === "selfdrive-task" ? [entry.data as Record<string, unknown>] : []),
		toolResults: () => branch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message as unknown as RecordedToolResult] : []),
		messages: () => branch().flatMap((entry) => entry.type === "custom_message" && entry.customType === "selfdrive" ? [{ content: entry.content as string, details: entry.details as Record<string, unknown> }] : []),
		dispose: async () => {
			if (!disposed) {
				disposed = true;
				await runtime.dispose();
			}
		},
	};
}

export interface StartGuardSessionOptions {
	cwd: string;
	agentDir: string;
	api?: string;
	provider?: string;
	noExtensions?: boolean;
	extensionFactories?: (ExtensionFactory | InlineExtension)[];
	linkParentId?: string;
}

export interface GuardSessionHarness {
	faux: FauxProviderHandle;
	session: AgentSession;
	extensions: Extension[];
	toolResults: () => SimpleToolResult[];
	dispose: () => Promise<void>;
}

/** Boots a lightweight in-process Pi AgentSession bound with `{}` (no runtime or UI). */
export async function startGuardSession(options: StartGuardSessionOptions): Promise<GuardSessionHarness> {
	const faux = fauxProvider({
		api: options.api ?? `selfdrive-guard-${Math.random()}`,
		provider: options.provider ?? "selfdrive-guard",
		models: [{ id: "test" }],
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false },
	});
	const sessionManager = SessionManager.inMemory(options.cwd);
	if (options.linkParentId) {
		sessionManager.appendCustomEntry("pi-extensions.session-link", {
			kind: "subagent",
			parentSessionId: options.linkParentId,
			agentType: "worker",
		});
	}
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		modelRuntime,
		resourceLoaderOptions: {
			...(options.noExtensions !== undefined ? { noExtensions: options.noExtensions } : {}),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				(pi) => pi.registerProvider(faux.provider),
				...(options.extensionFactories ?? []),
			],
		},
	});
	const loaded = services.resourceLoader.getExtensions();
	expect(loaded.errors).toEqual([]);
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model: faux.getModel("test"),
	});
	await session.bindExtensions({});
	let disposed = false;
	return {
		faux,
		session,
		extensions: loaded.extensions,
		toolResults: () => extractSimpleToolResults(session),
		dispose: async () => {
			if (!disposed) {
				disposed = true;
				const runner = session.extensionRunner;
				if (runner.hasHandlers("session_shutdown")) {
					await runner.emit({ type: "session_shutdown", reason: "quit" });
				}
				session.dispose();
			}
		},
	};
}

export interface StartChildSessionOptions {
	cwd: string;
	agentDir: string;
	extraFactories?: (ExtensionFactory | InlineExtension)[];
	linkParentId?: string;
}

/** Boots a `noExtensions: true` child session that loads `CHILD_SESSION_HOOKS` and binds with `{}`. */
export function startChildSession(options: StartChildSessionOptions): Promise<GuardSessionHarness> {
	return startGuardSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		api: `selfdrive-child-${Math.random()}`,
		provider: "selfdrive-child",
		noExtensions: true,
		extensionFactories: [...(options.extraFactories ?? []), ...childHookFactories()],
		linkParentId: options.linkParentId,
	});
}
