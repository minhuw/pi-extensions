import { skipToken, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useApi, type PikaApi } from "../lib/api";
import type { Entry, SessionTrace, TraceRecord, TraceTurn } from "../lib/types";
import { recordSpan } from "./kinds";

export function traceKey(sessionId: string) {
	return ["trace", sessionId] as const;
}

export function entryKey(sessionId: string, seq: number) {
	return ["entry", sessionId, seq] as const;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The server omits values it does not know rather than inventing them, and so does this: a turn
 * without a start begins at its first timed record (else where the previous timed turn ended), and
 * the session's bounds come from its timed records; a trace without any time keeps none. Loops, not
 * `Math.min(...)`, since spreading a long session's times overflows the stack.
 */
export function normalizeTrace(raw: SessionTrace): SessionTrace {
	const records: TraceRecord[] = raw.records ?? [];
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	const firstByTurn = new Map<number, number>();
	for (const record of records) {
		const span = recordSpan(record);
		const start = finite(span.start);
		const end = finite(span.end);
		if (start !== undefined) {
			first = Math.min(first, start);
			last = Math.max(last, start);
			if (record.turn !== undefined) firstByTurn.set(record.turn, Math.min(firstByTurn.get(record.turn) ?? start, start));
		}
		if (end !== undefined) {
			first = Math.min(first, end);
			last = Math.max(last, end);
		}
	}
	const startedAt = finite(raw.startedAt) ?? (Number.isFinite(first) ? first : undefined);
	let previousEnd = startedAt;
	const turns: TraceTurn[] = (raw.turns ?? []).map((turn) => {
		const durationMs = finite(turn.durationMs) ?? 0;
		const at = finite(turn.at) ?? firstByTurn.get(turn.index) ?? previousEnd;
		if (at !== undefined) {
			previousEnd = at + durationMs;
			last = Math.max(last, previousEnd);
		}
		return at === undefined ? { ...turn, durationMs } : { ...turn, at, durationMs };
	});
	const lastAt = finite(raw.lastAt) ?? (Number.isFinite(last) ? Math.max(last, startedAt ?? last) : startedAt);
	const out: SessionTrace = { ...raw, turns, records, children: raw.children ?? [] };
	if (startedAt !== undefined) out.startedAt = startedAt;
	else delete out.startedAt;
	if (lastAt !== undefined) out.lastAt = lastAt;
	else delete out.lastAt;
	return out;
}

/**
 * Fetches and normalizes a trace. With `queryClient`, a child session the trace shows changed since
 * the cached one (more entries, a later last entry) has its own cached trace invalidated, so an
 * expanded subagent refetches only when it changed, and no more often than its parent's trace.
 */
export async function fetchTrace(api: PikaApi, sessionId: string, queryClient?: QueryClient): Promise<SessionTrace> {
	const trace = normalizeTrace(await api.trace(sessionId));
	const before = queryClient?.getQueryData<SessionTrace>(traceKey(sessionId));
	if (queryClient && before) {
		const known = new Map(before.children.map((child) => [child.sessionId, child]));
		for (const child of trace.children) {
			const previous = known.get(child.sessionId);
			if (previous && (previous.entryCount !== child.entryCount || previous.lastAt !== child.lastAt)) {
				void queryClient.invalidateQueries({ queryKey: traceKey(child.sessionId), exact: true });
			}
		}
	}
	return trace;
}

export function useTrace(sessionId: string, enabled = true) {
	const api = useApi();
	const queryClient = useQueryClient();
	return useQuery<SessionTrace>({ queryKey: traceKey(sessionId), queryFn: () => fetchTrace(api, sessionId, queryClient), enabled });
}

/** An entry already loaded by the transcript's turn pages, if any. */
function cachedEntry(queryClient: QueryClient, sessionId: string, seq: number): Entry | undefined {
	for (const [, data] of queryClient.getQueriesData<{ items: Entry[] }>({ queryKey: ["entries", sessionId] })) {
		const found = data?.items.find((item) => item.seq === seq);
		if (found) return found;
	}
	return undefined;
}

/** The entry at `seq`, loaded alone and cached for good; never the whole session. */
export function useEntry(sessionId: string, seq: number | undefined, enabled = true) {
	const api = useApi();
	const queryClient = useQueryClient();
	return useQuery<Entry | null>({
		queryKey: entryKey(sessionId, seq ?? -1),
		queryFn: async () => {
			const cached = cachedEntry(queryClient, sessionId, seq!);
			if (cached) return cached;
			const page = await api.entries(sessionId, { from: seq, to: seq, limit: 1 });
			return page.items.find((item) => item.seq === seq) ?? null;
		},
		enabled: enabled && seq !== undefined,
		staleTime: Infinity,
	});
}

/**
 * A loaded entry from the cache, without fetching, for row decorations like diffstats; it re-renders
 * its (memoized) row when the inspector loads the entry. `seq` undefined watches nothing.
 */
export function useLoadedEntry(sessionId: string, seq: number | undefined): Entry | null | undefined {
	return useQuery<Entry | null>({ queryKey: entryKey(sessionId, seq ?? -1), queryFn: skipToken, staleTime: Infinity }).data;
}
