/**
 * The session modes registry: the modes ("alwayson") each top-level session's current branch has on, by session id.
 * Always-on mode publishes it and relay reads it; whoever reads it first creates it.
 */
export const SESSION_MODES = Symbol.for("pi-extensions.session-modes");

export interface SessionModesRegistry {
	/** Mode names active on each top-level session's current branch, by session id. */
	modes: Map<string, Set<string>>;
	/** Called with a session id whenever its set changes. */
	listeners: Set<(sessionId: string) => void>;
}

const global = globalThis as { [SESSION_MODES]?: SessionModesRegistry };

export const sessionModes = (): SessionModesRegistry => global[SESSION_MODES] ??= { modes: new Map(), listeners: new Set() };

/** Whether the registry shows `mode` on for the session. */
export const hasMode = (sessionId: string | undefined, mode: string): boolean =>
	sessionId !== undefined && sessionModes().modes.get(sessionId)?.has(mode) === true;
