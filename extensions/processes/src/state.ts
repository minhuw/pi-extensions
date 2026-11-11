// Process-wide state shared by every extension instance of this Node process: Pi recreates extensions per session
// (reload, /new, /resume, fork) and binds them again in child sessions, while processes outlive all of those.
import type { ProcessManager } from "./types.ts";

export const MANAGER_KEY = Symbol.for("pi-extensions.processes.manager");

export interface RequestedStop {
	by: "agent" | "user";
	/** The session whose agent or user asked. */
	session: string;
}

export interface SharedState {
	manager: ProcessManager | undefined;
	/**
	 * The extension instance allowed to shut the manager down on quit: the one that created it, then whichever replaces
	 * it on reload, /new, /resume, or fork. Child sessions (subagents, dreams) also end with "quit" but start with
	 * reason "startup", so they never take this over.
	 */
	root: symbol | undefined;
	/** The root's session was replaced; the next non-startup session start becomes the root. */
	handoff: boolean;
	exitHookInstalled: boolean;
	/** Stops and restarts in flight, by process id, so the exit they cause is reported as requested by whom. */
	requested: Map<string, RequestedStop>;
	/** Pending process_wait ids and the session that registered each. */
	waits: Map<string, string>;
	/** "id:readyAt" of ready states a start or restart result already reported, so no notification repeats them. */
	reportedReady: Set<string>;
}

export function sharedState(): SharedState {
	const shared = globalThis as Record<symbol, unknown>;
	return (shared[MANAGER_KEY] ??= {
		manager: undefined,
		root: undefined,
		handoff: false,
		exitHookInstalled: false,
		requested: new Map(),
		waits: new Map(),
		reportedReady: new Set(),
	} satisfies SharedState) as SharedState;
}

/** The manager, or a loud error when no session of this process has started one. */
export function requireManager(): ProcessManager {
	const manager = sharedState().manager;
	if (!manager) throw new Error("The process manager is not running: no session has started in this Pi process.");
	return manager;
}

/** Runs a stop or restart, marking the exit it causes as requested by `who` until it settles. */
export async function withRequestedStop<T>(processId: string, who: RequestedStop, run: () => Promise<T>): Promise<T> {
	const { requested } = sharedState();
	requested.set(processId, who);
	try {
		return await run();
	} finally {
		if (requested.get(processId) === who) requested.delete(processId);
	}
}
