export interface LockInfo { pid: number; host: string; startedAt: string; heartbeatAt: string; sessionId: string }
export interface RunLock { readonly info: LockInfo; heartbeat(): void; release(): void }

/** Takes the lock, refreshes our own, or takes over a stale one; throws when another live holder owns it. */
export function acquireLock(path: string, sessionId: string, options?: { now?: () => Date; staleMs?: number }): RunLock { throw new Error("not implemented"); }
export function readLock(path: string): LockInfo | null { throw new Error("not implemented"); }
export function isStale(info: LockInfo, now: Date, staleMs?: number): boolean { throw new Error("not implemented"); }
