// When a session counts as live. Kept apart from `session/live`, so the session list can tell without loading the transcript.

export const LIVE_WINDOW_MS = 120_000;
/** A live session's trace refetches at most this often; an unchanged one revalidates cheaply with its ETag. */
export const TRACE_REFRESH_MS = 10_000;

export function isLive(lastAt: string | undefined, now: number = Date.now()): boolean {
	const time = lastAt ? Date.parse(lastAt) : Number.NaN;
	return Number.isFinite(time) && now - time < LIVE_WINDOW_MS;
}
