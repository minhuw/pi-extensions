import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { getCurrentSystemPrompt, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionContext, type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { isExcluded } from "../../config.ts";
import { type CredentialsRegistry, credentialsRegistry } from "../../credentials.ts";
import { TOKEN as INGEST_TOKEN } from "./ingest-server.ts";
import { TOKEN as PIKA_TOKEN } from "./pika-server.ts";

// Real pi sessions load slowly on a cold, busy worker; every suite runtime imports this module.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

export const OPENAI_PROVIDER = "pika-mock-openai";

export function openAiModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "mock-model", name: "Mock model", api: "openai-completions", provider: OPENAI_PROVIDER, baseUrl,
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096,
	} as Model<"openai-completions">;
}

export interface WorkspaceOptions {
	prefix?: string;
	project?: string;
	clearEnv?: readonly string[];
	onCleanup?: () => void;
}

/** A temp directory holding the agent dir, session dir, and project cwd of one test. */
export class Workspace {
	readonly project: string;
	private readonly onCleanup?: () => void;
	protected constructor(readonly root: string, project: string, onCleanup?: () => void) {
		this.project = project;
		this.onCleanup = onCleanup;
	}
	static async create(options: WorkspaceOptions = {}): Promise<Workspace> {
		const workspace = new Workspace(await mkdtemp(join(tmpdir(), options.prefix ?? "pi-pika-")), options.project ?? "project", options.onCleanup);
		for (const dir of [workspace.agentDir, workspace.sessionDir, workspace.cwd]) await mkdir(dir, { recursive: true });
		for (const name of ["PIKA_URL", "PIKA_TOKEN", "PIKA_DISABLED", ...(options.clearEnv ?? [])]) delete process.env[name];
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		return workspace;
	}
	get agentDir() { return join(this.root, "agent"); }
	get sessionDir() { return join(this.root, "sessions"); }
	get cwd() { return join(this.root, this.project); }
	get pikaDir() { return join(this.agentDir, "pika"); }
	async configure(config: Record<string, unknown> | undefined): Promise<void> {
		if (config === undefined) await rm(join(this.agentDir, "pika.json"), { force: true });
		else await writeFile(join(this.agentDir, "pika.json"), JSON.stringify(config));
	}
	async enable(url: string, extra: Record<string, unknown> = {}): Promise<void> {
		await this.configure({ url, token: INGEST_TOKEN, ...extra });
	}
	async cleanup(): Promise<void> {
		this.onCleanup?.();
		await rm(this.root, { recursive: true, force: true });
	}
}

export interface CredentialsOptions {
	token?: string;
	excluded?: boolean | ((cwd: string) => boolean);
	exclude?: readonly string[];
	repository?: CredentialsRegistry["repository"];
}

/** Publishes credentials as pika would, notifying every listener. */
export function setCredentials(url: string | undefined, options: CredentialsOptions = {}): void {
	const registry = credentialsRegistry();
	const excluded = options.excluded;
	const checkExcluded: (cwd: string) => boolean = typeof excluded === "function"
		? excluded
		: options.exclude
			? (cwd) => isExcluded(cwd, options.exclude!)
			: () => excluded ?? false;
	registry.current = url === undefined ? undefined : { url, token: options.token ?? PIKA_TOKEN, isExcluded: checkExcluded };
	if (options.repository !== undefined) registry.repository = options.repository;
	for (const listener of [...registry.listeners]) listener();
}

export interface SessionOptions {
	workspace: Workspace;
	/** Extension factories in load order. */
	extensions?: ExtensionFactory[];
	/** Extensions loaded by path before the factories, as Pi loads packages. */
	extensionPaths?: string[];
	sessionManager?: SessionManager;
	cwd?: string;
	/** Serve the model through a real OpenAI-compatible API implementation at this base URL. */
	openAiBaseUrl?: string;
	faux?: FauxProviderHandle;
	/** Provider name for the default faux provider; default `"pika-test"`. */
	provider?: string;
	/** API id for the default faux provider; default `${provider}-api`. */
	api?: string;
	/** Model ids for the default faux provider; default `["test"]`. */
	models?: string[];
	tools?: string[];
	/** How many recent tokens `session.compact()` keeps; 1 compacts away everything before the last turn. */
	keepRecentTokens?: number;
	/** Bind this UI, so `ctx.hasUI` is true; without it the session has no UI. */
	ui?: ExtensionUIContext;
	mode?: ExtensionContext["mode"];
	/** Bind with empty options, as a child session does. */
	bindAsChild?: boolean;
}

export interface Harness {
	runtime: AgentSessionRuntime;
	readonly session: AgentSession;
	faux: FauxProviderHandle;
	errors: unknown[];
	shutdown(): Promise<void>;
}

/** A real pi session runtime with the faux provider (or mock OpenAI endpoint) and session replacement wired as in pi. */
export async function startSession(options: SessionOptions): Promise<Harness> {
	const cwd = options.cwd ?? options.workspace.cwd;
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const provider = options.provider ?? "pika-test";
	const models = (options.models ?? ["test"]).map((id) => ({ id })) as [{ id: string }, ...{ id: string }[]];
	const faux = options.faux ?? fauxProvider({ api: options.api ?? `${provider}-api`, provider, models });
	const baseUrl = options.openAiBaseUrl;
	const settingsManager = SettingsManager.inMemory({
		defaultTools: options.tools ?? [],
		retry: { enabled: false },
		compaction: { enabled: false, ...(options.keepRecentTokens !== undefined ? { keepRecentTokens: options.keepRecentTokens } : {}) },
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: options.extensionPaths,
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.provider);
						if (baseUrl) pi.registerProvider(OPENAI_PROVIDER, { baseUrl, apiKey: "test-key", api: "openai-completions", models: [{ ...openAiModel(baseUrl) }] });
					},
					...(options.extensions ?? []),
				],
			},
		});
		expect(services.resourceLoader.getExtensions().errors).toEqual([]);
		const created = await createAgentSessionFromServices({
			services, sessionManager, sessionStartEvent,
			model: baseUrl ? openAiModel(baseUrl) : (faux.getModel(models[0].id) ?? faux.getModel()),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd, agentDir: options.workspace.agentDir, sessionManager: options.sessionManager ?? SessionManager.create(cwd, options.workspace.sessionDir),
	});
	const errors: unknown[] = [];
	const bind = () => runtime.session.bindExtensions(options.bindAsChild ? {} : {
		mode: options.mode ?? "rpc",
		...(options.ui ? { uiContext: options.ui } : {}),
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
		runtime, faux, errors,
		get session() { return runtime.session; },
		async shutdown() {
			if (closed) return;
			closed = true;
			await runtime.dispose();
		},
	};
}

export { RecordingUI } from "./ui.ts";

export interface ToolCallHarness {
	readonly session: AgentSession;
	faux: FauxProviderHandle;
	systems?: string[];
}

export interface ToolResult { text: string; isError: boolean; details: unknown }

/** Wraps a faux assistant reply so each provider request records its current system prompt. */
export function recordSystem(systems: string[], answer: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory {
	return ({ messages }) => {
		systems.push(getCurrentSystemPrompt(messages));
		return answer();
	};
}

/** Queues one tool call followed by `after` on the faux provider, recording system prompts when `h.systems` is present. */
export function queueToolCall(h: Pick<ToolCallHarness, "faux" | "systems">, name: string, args: Parameters<typeof fauxToolCall>[1], after = "done"): void {
	const first = () => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
	const second = () => fauxAssistantMessage(after);
	h.faux.appendResponses(h.systems ? [recordSystem(h.systems, first), recordSystem(h.systems, second)] : [first(), second()]);
}

/** Makes the model call one tool in its next turn, then answer `after`, and runs that turn. */
export async function callTool(h: ToolCallHarness, name: string, args: Parameters<typeof fauxToolCall>[1], after = "done"): Promise<ToolResult> {
	queueToolCall(h, name, args, after);
	await h.session.prompt(`call ${name}`);
	const result = h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1) as
		{ content: { type: string; text?: string }[]; isError: boolean; details: unknown } | undefined;
	if (!result) throw new Error(`${name} was not called`);
	return { text: result.content.map((part) => part.text ?? "").join(""), isError: result.isError, details: result.details };
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000, label = "condition", intervalMs = 10): Promise<number> {
	const started = Date.now();
	for (;;) {
		if (await check()) return Date.now() - started;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/** The pid of a process that has already exited. */
export function exitedPid(): number {
	return spawnSync(process.execPath, ["-e", ""]).pid!;
}

export async function readText(path: string): Promise<string> {
	return readFile(path, "utf8");
}
