// Process-wide state shared by every extension instance of this Node process: Pi recreates extensions per session
// (reload, /new, /resume, fork) and binds them again in child sessions, while processes outlive all of those.
import type { ProcessManager } from "./types.ts";

export const MANAGER_KEY = Symbol.for("pi-extensions.processes.manager");

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
	/** In-flight `/ps` stops and restarts, counted per process id so overlapping calls decrement safely. */
	userStops: Map<string, number>;
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
		userStops: new Map(),
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

/** Runs a `/ps` stop or restart, marking requested exits it causes as user-initiated until it settles. */
export async function withUserStop<T>(processId: string, run: () => Promise<T>): Promise<T> {
	const { userStops } = sharedState();
	userStops.set(processId, (userStops.get(processId) ?? 0) + 1);
	try {
		return await run();
	} finally {
		const remaining = (userStops.get(processId) ?? 0) - 1;
		if (remaining > 0) userStops.set(processId, remaining);
		else userStops.delete(processId);
	}
}
