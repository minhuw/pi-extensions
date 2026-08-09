/** Minimal abort-aware session surface used by subagent runners. */
export interface AbortableSession {
  abort(): void | Promise<void>;
}

/**
 * Forward parent cancellation to a child session, including an abort that
 * happened before the listener was installed (AbortSignal events do not replay).
 */
export function forwardAbortSignal(session: AbortableSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => { void session.abort(); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => signal.removeEventListener("abort", onAbort);
}
