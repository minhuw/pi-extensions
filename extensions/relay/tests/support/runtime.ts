import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionAPI, type ExtensionContext,
	type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import relayExtension from "../../index.ts";
import { timing } from "../../protocol.ts";
import { credentials, type CredentialsRegistry, shared } from "../../shared.ts";
import { TOKEN } from "./relay-server.ts";

const DEFAULT_TIMING = { ...timing };

// Real pi sessions load slowly on a cold, busy worker; every relay test file imports this module.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

/** A temp directory holding the agent dir, session dir, and project cwd of one test. */
export class Workspace {
	private constructor(readonly root: string) {}
	static async create(): Promise<Workspace> {
		const workspace = new Workspace(await mkdtemp(join(tmpdir(), "pi-relay-")));
		for (const dir of [workspace.agentDir, workspace.sessionDir, workspace.cwd]) await mkdir(dir, { recursive: true });
		for (const name of ["PIKA_URL", "PIKA_TOKEN", "PIKA_DISABLED", "PI_RELAY_DISABLED"]) delete process.env[name];
		process.env.PI_CODING_AGENT_DIR = workspace.agentDir;
		Object.assign(timing, DEFAULT_TIMING);
		return workspace;
	}
	get agentDir() { return join(this.root, "agent"); }
	get sessionDir() { return join(this.root, "sessions"); }
	get cwd() { return join(this.root, "project"); }
	async cleanup(): Promise<void> {
		setCredentials(undefined);
		credentials().listeners.clear();
		await rm(this.root, { recursive: true, force: true });
	}
}

/** Publishes credentials as pika would, telling every listener. */
export function setCredentials(url: string | undefined, options: { token?: string; excluded?: (cwd: string) => boolean } = {}): void {
	const registry: CredentialsRegistry = credentials();
	registry.current = url === undefined ? undefined : { url, token: options.token ?? TOKEN, isExcluded: options.excluded ?? (() => false) };
	for (const listener of [...registry.listeners]) listener();
}

export interface Sent { message: { customType: string; content: unknown; display?: boolean; details?: unknown }; options: unknown }

export interface SessionOptions {
	workspace: Workspace;
	/** Extension factories loaded after relay. */
	extensions?: ExtensionFactory[];
	/** Leave relay out, for example when it loads by path instead. */
	noRelay?: boolean;
	extensionPaths?: string[];
	sessionManager?: SessionManager;
	cwd?: string;
	faux?: FauxProviderHandle;
	mode?: ExtensionContext["mode"];
	ui?: ExtensionUIContext;
	/** Makes relay's `pi.sendMessage` throw while it returns true, as a stale runtime would. */
	failSend?: () => boolean;
}

export interface Harness {
	runtime: AgentSessionRuntime;
	readonly session: AgentSession;
	faux: FauxProviderHandle;
	errors: unknown[];
	/** Every `pi.sendMessage` relay made, with its options. */
	sent: Sent[];
	shutdown(): Promise<void>;
}

/** Wraps `pi` so the test sees every `sendMessage` relay makes, and can make it fail. */
function spying(pi: ExtensionAPI, sent: Sent[], fail?: () => boolean): ExtensionAPI {
	return new Proxy(pi, {
		get(target, name, receiver) {
			if (name === "sendMessage") {
				return (message: Sent["message"], options?: unknown) => {
					if (fail?.()) throw new Error("sendMessage failed");
					sent.push({ message, options });
					return target.sendMessage(message as never, options as never);
				};
			}
			const value = Reflect.get(target, name, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** A real pi session runtime with relay, the faux provider, and session replacement wired as in pi. */
export async function startSession(options: SessionOptions): Promise<Harness> {
	const cwd = options.cwd ?? options.workspace.cwd;
	const agentDir = options.workspace.agentDir;
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = options.faux ?? fauxProvider({ api: "relay-test-api", provider: "relay-test", models: [{ id: "test" }, { id: "other" }] });
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const sent: Sent[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd, agentDir: runtimeAgentDir, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				additionalExtensionPaths: options.extensionPaths,
				extensionFactories: [
					(pi) => { pi.registerProvider(faux.provider); },
					...(options.noRelay ? [] : [(pi: ExtensionAPI) => relayExtension(spying(pi, sent, options.failSend))]),
					...(options.extensions ?? []),
				],
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
		runtime, faux, errors, sent,
		get session() { return runtime.session; },
		async shutdown() {
			if (closed) return;
			closed = true;
			await runtime.dispose();
		},
	};
}

/** A UI context that records notifications; every other method is a no-op. */
export class Notes {
	readonly notes: { message: string; type?: string }[] = [];
	get last() { return this.notes.at(-1); }
	get messages() { return this.notes.map((note) => note.message); }
	context(): ExtensionUIContext {
		const methods: Partial<ExtensionUIContext> = { notify: (message, type) => { this.notes.push({ message, type }); } };
		return new Proxy(methods, {
			get: (target, name) => name in target ? target[name as keyof ExtensionUIContext] : name === "then" ? undefined : () => undefined,
		}) as ExtensionUIContext;
	}
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000, label = "condition"): Promise<number> {
	const started = Date.now();
	for (;;) {
		if (await check()) return Date.now() - started;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** What a session's relay instance says of itself: "online", or why it is offline. */
export const relayStatus = (sessionId: string): string | undefined =>
	[...shared().members.values()].find((member) => member.sessionId === sessionId)?.member.status();

/** Waits until the server welcomed the session and the session processed the welcome. */
export async function waitOnline(server: { online(id: string): unknown }, sessionId: string): Promise<void> {
	await waitFor(() => server.online(sessionId) !== undefined && relayStatus(sessionId) === "online", 5_000, `${sessionId} online`);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The text of every message of a role in the session, in order. */
export function texts(session: AgentSession, role: string): string[] {
	return session.messages.filter((message) => message.role === role).map((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		return Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => part.type === "text" ? part.text ?? "" : "").join("") : "";
	});
}
