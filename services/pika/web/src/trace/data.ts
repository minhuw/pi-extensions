import { skipToken, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
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

/** The most descendants `useDescendantTraces` loads; a larger family leaves the rest out. */
export const MAX_DESCENDANTS = 400;

export interface DescendantTraces {
	/** The descendants' traces loaded so far, by session id. */
	traces: ReadonlyMap<string, SessionTrace>;
	/** Descendants known so far: a loaded trace names its own children, which load next. */
	wanted: number;
	failed: number;
	/** Set when the family has more than `MAX_DESCENDANTS` descendants. */
	capped: boolean;
}

const NO_TRACES: ReadonlyMap<string, SessionTrace> = new Map();

/**
 * Every descendant's trace, loaded level by level while `enabled`: the root's children, then theirs. The traces share
 * the ledger's cache, so subagents already expanded there do not load again.
 */
export function useDescendantTraces(root: SessionTrace, enabled: boolean): DescendantTraces {
	const api = useApi();
	const queryClient = useQueryClient();
	const [ids, setIds] = useState<string[]>([]);
	const queries = useQueries({
		queries: (enabled ? ids : []).map((id) => ({ queryKey: traceKey(id), queryFn: () => fetchTrace(api, id, queryClient), staleTime: 60_000 })),
	});
	const signature = queries.map((query) => `${query.status}:${query.dataUpdatedAt}`).join(",");
	const loaded = useMemo(() => {
		const traces = new Map<string, SessionTrace>();
		let failed = 0;
		queries.forEach((query, i) => {
			if (query.data) traces.set(ids[i], query.data);
			else if (query.status === "error") failed++;
		});
		return { traces: traces.size ? traces : NO_TRACES, failed };
		// `signature` stands in for `queries`, a new array every render.
	}, [ids, signature]);

	const wanted = useMemo(() => {
		const out: string[] = [];
		const seen = new Set([root.sessionId]);
		const queue = [root];
		let capped = false;
		for (let trace = queue.shift(); trace; trace = queue.shift()) {
			const children = [
				...trace.children.map((child) => child.sessionId),
				...trace.records.flatMap((record) => (record.kind === "tool" && record.childSessionId ? [record.childSessionId] : [])),
			];
			for (const id of children) {
				if (seen.has(id)) continue;
				seen.add(id);
				if (out.length >= MAX_DESCENDANTS) {
					capped = true;
					continue;
				}
				out.push(id);
				const child = loaded.traces.get(id);
				if (child) queue.push(child);
			}
		}
		return { ids: out, capped };
	}, [root, loaded.traces]);

	useEffect(() => {
		if (!enabled) return;
		const known = new Set(ids);
		const missing = wanted.ids.filter((id) => !known.has(id));
		if (missing.length) setIds((current) => [...current, ...missing.filter((id) => !current.includes(id))]);
	}, [enabled, wanted, ids]);

	if (!enabled) return { traces: NO_TRACES, wanted: 0, failed: 0, capped: false };
	return { traces: loaded.traces, wanted: wanted.ids.length, failed: loaded.failed, capped: wanted.capped };
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
