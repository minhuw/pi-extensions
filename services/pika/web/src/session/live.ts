import { useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ApiError, useApi } from "../lib/api";
import type { Entry, Page, SessionDetail, SessionUpdates, Turn } from "../lib/types";
import { entriesKey } from "./TurnList";

export const LIVE_WINDOW_MS = 120_000;
export const LIVE_POLL_MS = 3_000;

export function isLive(lastAt: string | undefined, now: number = Date.now()): boolean {
	const time = lastAt ? Date.parse(lastAt) : Number.NaN;
	return Number.isFinite(time) && now - time < LIVE_WINDOW_MS;
}

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

/** Applies an updates response: replaces the turns that changed, appends new ones, and refreshes the summary. */
export function applySessionUpdates(queryClient: QueryClient, sessionId: string, update: SessionUpdates) {
	const detail = queryClient.getQueryData<SessionDetail>(["session", sessionId]);
	if (detail) {
		queryClient.setQueryData<SessionDetail>(["session", sessionId], { ...detail, ...update.session, children: detail.children });
		if (update.session.childCount !== detail.childCount) void queryClient.invalidateQueries({ queryKey: ["session", sessionId], exact: true });
	}
	if (update.turns.length === 0) return;
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
 * minutes. Servers without that route fall back to polling the summary and refreshing the turns.
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
		let fallback = false;
		let lastAt = initial.lastAt;

		const tick = async () => {
			try {
				if (!fallback) {
					const update = await api.updates(sessionId, since);
					if (cancelled) return;
					since = Math.max(since, update.lastSeq);
					lastAt = update.session.lastAt;
					applySessionUpdates(queryClient, sessionId, update);
				} else {
					const detail = await api.session(sessionId);
					if (cancelled) return;
					const previous = sessionRef.current;
					lastAt = detail.lastAt;
					queryClient.setQueryData(["session", sessionId], detail);
					if (!previous || detail.entryCount !== previous.entryCount) {
						await queryClient.invalidateQueries({ queryKey: ["turns", sessionId], exact: true });
					}
				}
			} catch (error) {
				if (error instanceof ApiError && (error.status === 404 || error.status === 405)) fallback = true;
			}
			if (!cancelled && isLive(lastAt)) timer = setTimeout(() => void tick(), LIVE_POLL_MS);
		};
		timer = setTimeout(() => void tick(), LIVE_POLL_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [api, queryClient, sessionId, live]);
}
