import { afterEach, beforeEach } from "vitest";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import type { AgentSession, ExtensionAPI, ExtensionContext, ExtensionFactory, ExtensionUIContext, SessionManager } from "@earendil-works/pi-coding-agent";
import relayExtension from "../../../relay/index.ts";
import { timing } from "../../../relay/protocol.ts";
import { credentialsRegistry } from "../../../credentials.ts";
import { sessionModes } from "../../../relay/modes.ts";
import { shared } from "../../../relay/shared.ts";
import {
	queueToolCall, RecordingUI, setCredentials as setBaseCredentials, startSession as startBaseSession, waitFor, Workspace as BaseWorkspace,
	type CredentialsOptions, type Harness as BaseHarness,
} from "../../support/runtime.ts";
import { FakeRelay, TOKEN } from "./relay-server.ts";

export { queueToolCall, RecordingUI as Notes, waitFor };

const DEFAULT_TIMING = { ...timing };

/** A temp directory holding the agent dir, session dir, and project cwd of one test. */
export class Workspace extends BaseWorkspace {
	static override async create(): Promise<Workspace> {
		const workspace = await BaseWorkspace.create({
			prefix: "pi-relay-", project: "project", clearEnv: ["PI_RELAY_DISABLED"],
			onCleanup: () => {
				setCredentials(undefined);
				credentialsRegistry().listeners.clear();
				sessionModes().modes.clear();
				sessionModes().listeners.clear();
			},
		});
		Object.assign(timing, DEFAULT_TIMING);
		return workspace;
	}
}

/** Publishes credentials as pika would, telling every listener. */
export const setCredentials = (url: string | undefined, options: CredentialsOptions = {}): void =>
	setBaseCredentials(url, { token: TOKEN, ...options });

/** Publishes a session's modes as swarm mode would, telling every listener. */
export function setModes(sessionId: string, ...modes: string[]): void {
	const registry = sessionModes();
	if (modes.length) registry.modes.set(sessionId, new Set(modes));
	else registry.modes.delete(sessionId);
	for (const listener of [...registry.listeners]) listener(sessionId);
}

export interface Sent { message: { customType: string; content: unknown; display?: boolean; details?: unknown }; options: unknown }

export interface SessionOptions {
	workspace: Workspace;
	/** Extension factories loaded after relay. */
	extensions?: ExtensionFactory[];
	/** Extension factories loaded before relay, as swarm mode is. */
	extensionsBefore?: ExtensionFactory[];
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
	/** How many recent tokens `session.compact()` keeps; 1 compacts away everything before the last turn. */
	keepRecentTokens?: number;
}

export interface Harness extends BaseHarness {
	/** Every `pi.sendMessage` relay made, with its options. */
	sent: Sent[];
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
	const sent: Sent[] = [];
	const base = await startBaseSession({
		...options,
		provider: "relay-test",
		models: ["test", "other"],
		extensions: [
			...(options.extensionsBefore ?? []),
			...(options.noRelay ? [] : [(pi: ExtensionAPI) => relayExtension(spying(pi, sent, options.failSend))]),
			...(options.extensions ?? []),
		],
	});
	return {
		runtime: base.runtime, faux: base.faux, errors: base.errors, sent,
		get session() { return base.runtime.session; },
		shutdown: () => base.shutdown(),
	};
}

/** What a session's relay instance says of itself: "online", or why it is offline. */
export const relayStatus = (sessionId: string): string | undefined =>
	[...shared().members.values()].find((member) => member.sessionId === sessionId)?.member.status();

/** Waits until the server welcomed the session and the session processed the welcome. */
export async function waitOnline(server: { online(id: string): unknown }, sessionId: string): Promise<void> {
	await waitFor(() => server.online(sessionId) !== undefined && relayStatus(sessionId) === "online", 5_000, `${sessionId} online`);
}

export type OpenOptions = Partial<Omit<SessionOptions, "workspace">> & { workspace?: Workspace };

export interface RelaySuiteOptions {
	/** Base path passed to `relay.start(base)`; default `""`. */
	base?: string;
	/** Publish `setCredentials(relay.url)` in `beforeEach`; default `true`. */
	credentials?: boolean;
	/** Runs at the end of `beforeEach`, after `workspace`, `relay`, and optional credentials are ready. */
	beforeEach?: (env: { workspace: Workspace; relay: FakeRelay }) => void | Promise<void>;
	/** Runs at the start of `afterEach`, before harnesses shut down and `relay`/`workspace` stop. */
	beforeCleanup?: () => void | Promise<void>;
	/** Runs at the end of `afterEach`, after harnesses shut down and `relay`/`workspace` stop. */
	afterCleanup?: () => void | Promise<void>;
}

export interface RelaySuite {
	readonly workspace: Workspace;
	readonly relay: FakeRelay;
	/** Starts a tracked session in the current test's workspace. */
	open(options?: OpenOptions | RecordingUI): Promise<Harness>;
	/** Starts a tracked session and waits until the fake relay welcomes it. */
	online(options?: OpenOptions | RecordingUI): Promise<Harness>;
	/** Registers a harness created outside `open()`/`online()` so `afterEach` shuts it down. */
	track<T extends Harness>(harness: T): T;
}

/** Registers `beforeEach`/`afterEach` for a workspace, fake relay, and tracked session harnesses. */
export function relaySuite(options: RelaySuiteOptions = {}): RelaySuite {
	let workspace: Workspace | undefined;
	let relay: FakeRelay | undefined;
	const tracked = new Set<Harness>();

	const currentWorkspace = () => {
		if (!workspace) throw new Error("relaySuite used outside a test");
		return workspace;
	};
	const currentRelay = () => {
		if (!relay) throw new Error("relaySuite used outside a test");
		return relay;
	};

	const track = <T extends Harness>(harness: T): T => {
		tracked.add(harness);
		return harness;
	};
	const toSessionOptions = (sessionOptions?: OpenOptions | RecordingUI): OpenOptions =>
		sessionOptions instanceof RecordingUI ? { ui: sessionOptions.context() } : (sessionOptions ?? {});
	const open = async (sessionOptions?: OpenOptions | RecordingUI): Promise<Harness> =>
		track(await startSession({ workspace: currentWorkspace(), ...toSessionOptions(sessionOptions) }));
	const online = async (sessionOptions?: OpenOptions | RecordingUI): Promise<Harness> => {
		const h = await open(sessionOptions);
		await waitOnline(currentRelay(), h.session.sessionId);
		return h;
	};

	beforeEach(async () => {
		workspace = await Workspace.create();
		relay = await new FakeRelay().start(options.base);
		if (options.credentials !== false) setCredentials(relay.url);
		await options.beforeEach?.({ workspace, relay });
	});

	afterEach(async () => {
		try {
			await options.beforeCleanup?.();
			const toClose = [...tracked];
			tracked.clear();
			for (const h of toClose) await h.shutdown();
		} finally {
			const current = relay;
			const dir = workspace;
			relay = undefined;
			workspace = undefined;
			try {
				await current?.stop();
			} finally {
				try {
					await dir?.cleanup();
				} finally {
					await options.afterCleanup?.();
				}
			}
		}
	});

	return {
		get workspace() { return currentWorkspace(); },
		get relay() { return currentRelay(); },
		open,
		online,
		track,
	};
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
