import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
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
	type ExtensionFactory,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { CHILD_SESSION_HOOKS, settleWorkspaceSweeps, WORKSPACE_SHARED_KEY } from "../../index.ts";

export const WORKSPACE_EXTENSION_PATH = fileURLToPath(new URL("../../index.ts", import.meta.url));

export interface WorkspaceSandbox {
	sandboxRoot: string;
	projectCwd: string;
	outsideDir: string;
	agentDir: string;
	sessionDir: string;
	cleanup: () => Promise<void>;
}

/** Clears process-global workspace state and child-session hook registrations between tests. */
export function clearWorkspaceGlobals(): void {
	delete (globalThis as Record<symbol, unknown>)[WORKSPACE_SHARED_KEY];
	delete (globalThis as Record<symbol, unknown>)[CHILD_SESSION_HOOKS];
}

export interface WorkspaceSandboxOptions {
	prefix?: string;
	createOutsideDir?: boolean;
}

/** Creates an isolated sandbox directory, points `PI_CODING_AGENT_DIR` at it, and resets workspace globals. */
export async function createWorkspaceSandbox(
	prefixOrOptions: string | WorkspaceSandboxOptions = "pi-workspace-test-",
): Promise<WorkspaceSandbox> {
	const { prefix = "pi-workspace-test-", createOutsideDir = true } =
		typeof prefixOrOptions === "string" ? { prefix: prefixOrOptions } : prefixOrOptions;
	const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
	const projectCwd = path.join(sandboxRoot, "project");
	const outsideDir = path.join(sandboxRoot, "outside");
	const agentDir = path.join(sandboxRoot, "agent");
	const sessionDir = path.join(sandboxRoot, "sessions");
	await Promise.all([
		mkdir(projectCwd, { recursive: true }),
		...(createOutsideDir ? [mkdir(outsideDir, { recursive: true })] : []),
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	clearWorkspaceGlobals();

	return {
		sandboxRoot,
		projectCwd,
		outsideDir,
		agentDir,
		sessionDir,
		cleanup: async () => {
			await settleWorkspaceSweeps();
			clearWorkspaceGlobals();
			if (prevAgentDir === undefined) {
				delete process.env.PI_CODING_AGENT_DIR;
			} else {
				process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			}
			await rm(sandboxRoot, { recursive: true, force: true });
		},
	};
}

export interface RecordedNote {
	message: string;
	type?: string;
}

export interface RecordedPrompt {
	title: string;
	options: string[];
}

export interface RecordingUi {
	notes: RecordedNote[];
	prompts: RecordedPrompt[];
	promptTitles: string[];
	noteMessages: string[];
	context: ExtensionUIContext;
}

export function createRecordingUi(
	selectHandler?: (title: string, options: string[]) => Promise<string | undefined>,
): RecordingUi {
	const notes: RecordedNote[] = [];
	const prompts: RecordedPrompt[] = [];
	const promptTitles: string[] = [];
	const noteMessages: string[] = [];
	const noop = () => {};
	const context = {
		select: async (title: string, options: string[]) => {
			prompts.push({ title, options });
			promptTitles.push(title);
			return selectHandler ? selectHandler(title, options) : undefined;
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
		notify: (message: string, type?: string) => {
			notes.push({ message, type });
			noteMessages.push(message);
		},
		setStatus: noop,
	} as unknown as ExtensionUIContext;
	return { notes, prompts, promptTitles, noteMessages, context };
}

export interface ToolResultEntry {
	isError: boolean;
	text: string;
}

export interface StartWorkspaceSessionOptions {
	cwd: string;
	agentDir: string;
	sessionDir: string;
	/**
	 * How to bind extensions on the session:
	 * - `"ui"` (default): binds with `mode` (default `"rpc"`), recording UI, error collector, and command actions
	 * - `"headless"`: binds with `{ mode: mode ?? "print" }` and no UI context
	 * - `"child"`: binds with `{}` (no mode, no UI), matching how Subagents binds live child sessions
	 */
	binding?: "ui" | "headless" | "child";
	/** Mode passed to `bindExtensions` (defaults to `"rpc"` for `"ui"` and `"print"` for `"headless"`). */
	mode?: "tui" | "rpc" | "print" | "json";
	/** Shorthand for `binding: "child"`. */
	bindAsChild?: boolean;
	sessionManager?: SessionManager;
	/** Custom `ui.select` handler when `binding` is `"ui"`. */
	selectHandler?: (title: string, options: string[]) => Promise<string | undefined>;
	/** Queue of `ui.select` answers (falls back to `"Deny"` when exhausted). Ignored if `selectHandler` is provided. */
	choices?: string[];
	/** Extra extension factories registered alongside the faux provider. */
	extraFactories?: ExtensionFactory[];
	/** Faux provider identifiers (defaults to `"workspace-test-api"` / `"workspace-test"`). */
	api?: string;
	provider?: string;
	/** Wait for startup automatic sweeps to settle before returning (default `true`). */
	settleSweeps?: boolean;
}

export interface WorkspaceSessionHarness {
	runtime: AgentSessionRuntime;
	session: AgentSession;
	faux: FauxProviderHandle;
	ui: RecordingUi;
	/** Prompt titles recorded by `ui.select`, in order. */
	prompts: string[];
	/** Notification messages recorded by `ui.notify`, in order. */
	notes: string[];
	errors: unknown[];
	capturedSystems: string[];
	toolResults: () => ToolResultEntry[];
	dispose: () => Promise<void>;
}

/** Starts a real Pi session backed by a per-session faux provider with the workspace extension loaded. */
export async function startWorkspaceSession(
	options: StartWorkspaceSessionOptions,
): Promise<WorkspaceSessionHarness> {
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	const faux = fauxProvider({
		api: options.api ?? "workspace-test-api",
		provider: options.provider ?? "workspace-test",
		models: [{ id: "test" }],
	});
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: false, keepRecentTokens: 1 },
	});

	const choiceQueue = options.choices ? [...options.choices] : undefined;
	const selectHandler =
		options.selectHandler ?? (choiceQueue ? async () => choiceQueue.shift() ?? "Deny" : undefined);
	const ui = createRecordingUi(selectHandler);
	const capturedSystems: string[] = [];

	faux.setResponses([
		({ messages }) => {
			capturedSystems.push(getCurrentSystemPrompt(messages));
			return fauxAssistantMessage("ok");
		},
	]);

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
				additionalExtensionPaths: [WORKSPACE_EXTENSION_PATH],
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
					},
					...(options.extraFactories ?? []),
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
	const binding = options.bindAsChild ? "child" : (options.binding ?? "ui");

	try {
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: options.cwd,
			agentDir: options.agentDir,
			sessionManager: options.sessionManager ?? SessionManager.create(options.cwd, options.sessionDir),
		});

		const activeRuntime = runtime;
		const bind = () => {
			if (binding === "child") {
				return activeRuntime.session.bindExtensions({});
			}
			if (binding === "headless") {
				return activeRuntime.session.bindExtensions({
					mode: options.mode ?? "print",
					onError: (err) => {
						errors.push(err);
					},
				});
			}
			return activeRuntime.session.bindExtensions({
				mode: options.mode ?? "rpc",
				uiContext: ui.context,
				onError: (err) => {
					errors.push(err);
				},
				commandContextActions: {
					waitForIdle: () => activeRuntime.session.waitForIdle(),
					newSession: (o) => activeRuntime.newSession(o),
					fork: (id, o) => activeRuntime.fork(id, o),
					navigateTree: (id, o) => activeRuntime.session.navigateTree(id, o),
					switchSession: (p, o) => activeRuntime.switchSession(p, o),
					reload: () => activeRuntime.session.reload(),
				},
			});
		};
		activeRuntime.setRebindSession(bind);
		await bind();
		if (options.settleSweeps !== false) {
			await settleWorkspaceSweeps();
		}
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
	return {
		runtime: activeRuntime,
		session: activeRuntime.session,
		faux,
		ui,
		prompts: ui.promptTitles,
		notes: ui.noteMessages,
		errors,
		capturedSystems,
		toolResults: () =>
			activeRuntime.session.sessionManager
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
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			try {
				await activeRuntime.dispose();
			} finally {
				unregisterFaux();
			}
		},
	};
}
