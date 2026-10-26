import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");
export const PIKA_CREDENTIALS = Symbol.for("pi-extensions.pika.credentials");

export interface ChildSessionHook {
	name: string;
	extensionFactory: (pi: ExtensionAPI) => void;
}

/** pika's credentials registry; relay only reads it and listens. */
export interface PikaCredentials { url: string; token: string; isExcluded(cwd: string): boolean }
export interface CredentialsRegistry { current: PikaCredentials | undefined; listeners: Set<() => void> }

/** What a relay instance lets the child hook do to it. */
export interface Member {
	/** The hook saw this session start as a child: it must stay offline. */
	markChild(): void;
	/** "online", or why the session is offline; for diagnostics. */
	status(): string;
	/**
	 * Whether the session could connect as far as the process knows: started, a top-level session in
	 * the TUI or RPC mode, not `/relay off`, and pika has credentials that do not exclude its cwd.
	 */
	canConnect(): boolean;
}

// Module copies loaded for other cwds, and the child hook, share this state, so it lives on globalThis.
const SHARED = Symbol.for("pi-extensions.relay");
interface Shared {
	/** Session ids the child hook saw start; their relay instances stay offline. */
	children: Set<string>;
	/** Relay instances whose session started and has not shut down, by session id. */
	members: Map<object, { sessionId: string; member: Member }>;
	hook?: ChildSessionHook;
	/** An unsupported server was reported to the user; once per process. */
	unsupportedNotified: boolean;
}

const global = globalThis as { [SHARED]?: Shared; [CHILD_SESSION_HOOKS]?: Set<ChildSessionHook>; [PIKA_CREDENTIALS]?: CredentialsRegistry };
export const shared = (): Shared => global[SHARED] ??= { children: new Set(), members: new Map(), unsupportedNotified: false };
const hooks = (): Set<ChildSessionHook> => global[CHILD_SESSION_HOOKS] ??= new Set();
export const credentials = (): CredentialsRegistry => global[PIKA_CREDENTIALS] ??= { current: undefined, listeners: new Set() };

/**
 * The factory Subagents and Herder append last to every child session. It only records the
 * child's id at its `session_start`, and tells a relay instance of that session that already
 * joined to stay offline.
 */
function childHookFactory(pi: ExtensionAPI): void {
	let id: string | undefined;
	pi.on("session_start", (_event, ctx) => {
		try {
			id = ctx.sessionManager.getSessionId();
			const state = shared();
			state.children.add(id);
			for (const entry of state.members.values()) if (entry.sessionId === id) entry.member.markChild();
		} catch { /* never into pi */ }
	});
	pi.on("session_shutdown", () => {
		if (id !== undefined) shared().children.delete(id);
		id = undefined;
	});
}

/**
 * Registers the child hook while at least one relay instance could connect, and takes it out
 * otherwise. A registered hook makes Subagents keep every child session on disk, so it must not
 * stay registered in an excluded cwd, after `/relay off`, in print or JSON mode, or without pika.
 */
export function syncHook(): void {
	const state = shared();
	state.hook ??= { name: "relay", extensionFactory: childHookFactory };
	const wanted = [...state.members.values()].some((entry) => { try { return entry.member.canConnect(); } catch { return false; } });
	if (wanted) hooks().add(state.hook);
	else hooks().delete(state.hook);
}

/** Adds a started relay instance. */
export function join(self: object, sessionId: string, member: Member): void {
	shared().members.set(self, { sessionId, member });
	syncHook();
}

/** Removes a relay instance. */
export function leave(self: object): void {
	shared().members.delete(self);
	syncHook();
}
