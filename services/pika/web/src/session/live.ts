import { useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ApiError, useApi } from "../lib/api";
import { isLive, TRACE_REFRESH_MS } from "../lib/liveness";
import type { Entry, Page, SessionDetail, SessionUpdates, Turn } from "../lib/types";
import { traceKey } from "../trace/data";
import { entriesKey } from "./TurnList";

export { isLive, LIVE_WINDOW_MS, TRACE_REFRESH_MS } from "../lib/liveness";
export const LIVE_POLL_MS = 3_000;

function knownLastSeq(queryClient: QueryClient, session: SessionDetail): number {
	const turns = queryClient.getQueryData<InfiniteData<Page<Turn>>>(["turns", session.id]);
	const lastTurn = turns?.pages.flatMap((page) => page.items).reduce((max, turn) => Math.max(max, turn.endSeq), -1) ?? -1;
	return Math.max(session.entryCount - 1, lastTurn);
}

/** Moves an expanded turn's cached entry pages to its new `endSeq` and marks them for refetch. */
function carryEntries(queryClient: QueryClient, sessionId: string, before: Turn, after: Turn) {
	for (const [key, data] of queryClient.getQueriesData<{ items: Entry[] }>({ queryKey: ["entries", sessionId] })) {
		const from = key[2];
		if (typeof from !== "number" || key[3] !== before.endSeq || from < before.startSeq || from > before.endSeq || !data) continue;
		const next = entriesKey(sessionId, after, from);
		queryClient.setQueryData(next, data);
		void queryClient.invalidateQueries({ queryKey: next, exact: true });
	}
}

/**
 * Applies an updates response: refreshes the summary, replaces the turns that changed, and appends
 * new ones. A truncated response refetches the turns list instead. The session's own trace refetches
 * through `refreshTrace`, which may throttle it; its subagents' traces refetch when it shows them
 * changed (see `fetchTrace`).
 */
export function applySessionUpdates(
	queryClient: QueryClient,
	sessionId: string,
	update: SessionUpdates,
	refreshTrace: () => void = () => void queryClient.invalidateQueries({ queryKey: traceKey(sessionId), exact: true }),
) {
	refreshTrace();
	const detail = queryClient.getQueryData<SessionDetail>(["session", sessionId]);
	if (detail && update.session) {
		queryClient.setQueryData<SessionDetail>(["session", sessionId], { ...detail, ...update.session, children: detail.children });
		if (update.session.childCount !== detail.childCount) void queryClient.invalidateQueries({ queryKey: ["session", sessionId], exact: true });
	}
	if (update.truncated) {
		void queryClient.invalidateQueries({ queryKey: ["turns", sessionId], exact: true });
		return;
	}
	if (!update.turns?.length) return;
	const changed = new Map(update.turns.map((turn) => [turn.index, turn]));
	queryClient.setQueryData<InfiniteData<Page<Turn>>>(["turns", sessionId], (data) => {
		if (!data) return data;
		const pages = data.pages.map((page) => {
			if (!page.items.some((turn) => changed.has(turn.index))) return page;
			return {
				...page,
				items: page.items.map((turn) => {
					const next = changed.get(turn.index);
					if (!next) return turn;
					changed.delete(turn.index);
					if (next.endSeq !== turn.endSeq) carryEntries(queryClient, sessionId, turn, next);
					return next;
				}),
			};
		});
		const last = pages[pages.length - 1];
		// New turns are appended only when every page is loaded; otherwise paging reaches them.
		if (last && !last.nextCursor && changed.size > 0) {
			pages[pages.length - 1] = { ...last, items: [...last.items, ...[...changed.values()].sort((a, b) => a.index - b.index)] };
		}
		return { ...data, pages };
	});
}

/**
 * Polls `sessions/:id/updates` every few seconds while the session saw activity in the last two
 * minutes. Polling stops when the route answers 404, as older servers do.
 */
export function useLiveUpdates(sessionId: string, session: SessionDetail | undefined) {
	const api = useApi();
	const queryClient = useQueryClient();
	const live = session ? isLive(session.lastAt) : false;
	const sessionRef = useRef(session);
	sessionRef.current = session;

	useEffect(() => {
		const initial = sessionRef.current;
		if (!live || !initial) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let since = knownLastSeq(queryClient, initial);
		let lastAt = initial.lastAt;
		// At most one trace refetch per `TRACE_REFRESH_MS`, counted from when the trace last arrived.
		let traceTimer: ReturnType<typeof setTimeout> | undefined;
		const invalidateTrace = () => void queryClient.invalidateQueries({ queryKey: traceKey(sessionId), exact: true });
		const refreshTrace = () => {
			if (traceTimer !== undefined) return;
			const updatedAt = queryClient.getQueryState(traceKey(sessionId))?.dataUpdatedAt ?? 0;
			const wait = updatedAt ? Math.max(0, updatedAt + TRACE_REFRESH_MS - Date.now()) : 0;
			traceTimer = setTimeout(() => {
				traceTimer = undefined;
				invalidateTrace();
			}, wait);
		};

		const tick = async () => {
			try {
				const update = await api.updates(sessionId, since);
				if (cancelled) return;
				lastAt = update.lastAt ?? update.session?.lastAt ?? lastAt;
				if (update.lastSeq > since) {
					applySessionUpdates(queryClient, sessionId, update, refreshTrace);
					since = update.lastSeq;
				}
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) return;
			}
			if (!cancelled && isLive(lastAt)) timer = setTimeout(() => void tick(), LIVE_POLL_MS);
		};
		timer = setTimeout(() => void tick(), LIVE_POLL_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			// A refresh still waiting is not dropped: the trace is marked stale for whoever shows it next.
			if (traceTimer !== undefined) {
				clearTimeout(traceTimer);
				invalidateTrace();
			}
		};
	}, [api, queryClient, sessionId, live]);
}
