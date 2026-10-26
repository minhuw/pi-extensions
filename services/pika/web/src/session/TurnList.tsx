import { useInfiniteQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../components/icons";
import { useScrollRoot } from "../components/Layout";
import { Markdown } from "../components/Markdown";
import { cx, EmptyState, ErrorState, Pill, Skeleton, SkeletonLines } from "../components/ui";
import { useApi } from "../lib/api";
import { formatCost, formatDateTime, formatDuration, plural } from "../lib/format";
import { useShortcuts } from "../lib/keyboard";
import type { Entry, Turn } from "../lib/types";
import { useViewState } from "../lib/viewState";
import { useScrollMargin } from "../lib/virtual";
import { buildTimeline, type TimelineItem } from "./timeline";
import { TimelineItemView } from "./TimelineItemView";

export const TURN_PAGE_SIZE = 100;
export const ENTRY_PAGE_SIZE = 200;

type Row =
	| { type: "head"; key: string; turn: Turn; position: number; expanded: boolean }
	| { type: "item"; key: string; turn: Turn; item: TimelineItem }
	| { type: "status"; key: string; turn: Turn; status: "loading" | "error" | "more" | "empty"; error?: unknown }
	| { type: "foot"; key: string; turn: Turn }
	| { type: "turns-loader"; key: string };

interface TurnEntries {
	entries: Entry[];
	pages: Entry[][];
	loading: boolean;
	error: unknown;
	hasMore: boolean;
}

export function entriesKey(sessionId: string, turn: Pick<Turn, "endSeq">, from: number) {
	return ["entries", sessionId, from, turn.endSeq] as const;
}

const HIGHLIGHT_MS = 2500;

function estimateRow(row: Row | undefined): number {
	if (!row) return 80;
	switch (row.type) {
		case "head":
			return 150;
		case "item":
			return row.item.kind === "tool" ? 160 : row.item.kind === "model-call" ? 28 : 60;
		case "foot":
			return 120;
		default:
			return 48;
	}
}

function WorkStrip({ turn, expanded, onToggle }: { turn: Turn; expanded: boolean; onToggle: () => void }) {
	const parts = [
		plural(turn.modelCalls, "model call"),
		plural(turn.toolCalls, "tool"),
		formatDuration(turn.durationMs),
		formatCost(turn.cost),
	];
	return (
		<button
			type="button"
			aria-expanded={expanded}
			onClick={onToggle}
			className="-mx-2 mt-3 flex w-[calc(100%+1rem)] items-center gap-2 rounded-sm px-2 py-1 text-left text-[14px] text-muted hover:bg-hover"
			data-work-strip={turn.index}
		>
			<span aria-hidden="true" className="w-3 text-[11px]">
				{expanded ? "▾" : "▸"}
			</span>
			<span className="truncate">{parts.join(" · ")}</span>
			{turn.toolErrors > 0 && <Pill tone="red">{plural(turn.toolErrors, "error")}</Pill>}
		</button>
	);
}

function TurnHead({
	row,
	active,
	highlighted,
	onToggle,
}: {
	row: Extract<Row, { type: "head" }>;
	active: boolean;
	highlighted: boolean;
	onToggle: () => void;
}) {
	const { turn } = row;
	return (
		<div
			className={cx(
				"rounded-t-md border-x border-t px-6 pt-5 pb-2 transition-colors duration-700",
				active ? "border-accent/40" : "border-line",
				highlighted && "bg-accent-soft",
			)}
			data-turn={turn.index}
			data-active={active || undefined}
			data-highlighted={highlighted || undefined}
		>
			<div className="mb-2 flex items-center gap-2 text-[13px] text-muted">
				<Icon name="user" size={14} />
				<span>Prompt {turn.index + 1}</span>
				<span className="ml-auto">{formatDateTime(turn.at)}</span>
			</div>
			{turn.userText ? <Markdown text={turn.userText} /> : <div className="text-muted italic">(empty prompt)</div>}
			<WorkStrip turn={turn} expanded={row.expanded} onToggle={onToggle} />
		</div>
	);
}

function TurnFoot({ turn, active }: { turn: Turn; active: boolean }) {
	return (
		<div className="pb-6">
			<div className={cx("rounded-b-md border-x border-b px-6 pb-5", active ? "border-accent/40" : "border-line", turn.finalText ? "pt-3" : "pt-1")}>
				{turn.finalText && (
					<div className="border-t border-line pt-4" data-final-answer={turn.index}>
						<div className="mb-1.5 flex items-center gap-2 text-[13px] text-muted">
							<Icon name="sparkle" size={14} />
							Answer
						</div>
						<Markdown text={turn.finalText} className="text-[16px]" />
					</div>
				)}
			</div>
		</div>
	);
}

function ItemShell({
	active,
	children,
	seq,
	highlighted = false,
}: {
	active: boolean;
	children: ReactNode;
	seq?: number;
	highlighted?: boolean;
}) {
	return (
		<div
			className={cx("border-x px-6 transition-colors duration-700", active ? "border-accent/40" : "border-line", highlighted && "bg-accent-soft")}
			data-entry-seq={seq}
			data-highlighted={highlighted || undefined}
		>
			<div className="ml-1.5 border-l border-line py-1.5 pl-5">{children}</div>
		</div>
	);
}

function itemHasSeq(item: TimelineItem, seq: number): boolean {
	return item.seq === seq || (item.kind === "tool" && item.resultEntry?.seq === seq);
}

export function TurnList({
	sessionId,
	showHidden,
	nested = false,
	focusSeq,
	onFocusHandled,
}: {
	sessionId: string;
	showHidden: boolean;
	/** Inline inside another session's timeline: no j/k shortcuts. */
	nested?: boolean;
	/** An entry to scroll to: its turn is expanded and the entry briefly highlighted. */
	focusSeq?: number;
	onFocusHandled?: () => void;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const turns = useInfiniteQuery({
		queryKey: ["turns", sessionId],
		queryFn: ({ pageParam }) => api.turns(sessionId, pageParam, TURN_PAGE_SIZE),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
	});
	const turnItems = useMemo(() => turns.data?.pages.flatMap((page) => page.items) ?? [], [turns.data]);

	// Expanded turns and how many entry pages each has requested.
	const [expanded, setExpanded] = useViewState<Map<number, number>>(`turns-expanded:${sessionId}`, () => new Map());
	const [active, setActive] = useState(-1);

	const turnsByIndex = useMemo(() => new Map(turnItems.map((turn) => [turn.index, turn])), [turnItems]);

	// Entry pages chain: each page starts after the previous page's last seq. Recomputed every
	// render; `useQueries` re-renders when a page settles, which extends the chain.
	const entryQueries: { turn: Turn; from: number }[] = [];
	for (const [index, pages] of expanded) {
		const turn = turnsByIndex.get(index);
		if (!turn) continue;
		let from = turn.startSeq;
		for (let page = 0; page < pages; page++) {
			entryQueries.push({ turn, from });
			const data = queryClient.getQueryData<{ items: Entry[] }>(entriesKey(sessionId, turn, from));
			if (!data) break;
			const last = data.items[data.items.length - 1];
			if (!last || data.items.length < ENTRY_PAGE_SIZE || last.seq >= turn.endSeq) break;
			from = last.seq + 1;
		}
	}

	const entryResults = useQueries({
		queries: entryQueries.map(({ turn, from }) => ({
			queryKey: entriesKey(sessionId, turn, from),
			queryFn: () => api.entries(sessionId, { from, to: turn.endSeq, limit: ENTRY_PAGE_SIZE }),
			staleTime: Infinity,
		})),
	});
	const entrySignature = entryQueries
		.map(({ turn, from }, i) => `${turn.index}:${from}:${entryResults[i]?.status}:${entryResults[i]?.dataUpdatedAt}`)
		.join(",");

	const timelineCache = useRef(new Map<number, { pages: Entry[][]; showHidden: boolean; items: TimelineItem[] }>());

	const { rows, byTurn } = useMemo(() => {
		const byTurn = new Map<number, TurnEntries>();
		entryQueries.forEach(({ turn }, i) => {
			const result = entryResults[i];
			const state = byTurn.get(turn.index) ?? { entries: [], pages: [], loading: false, error: null, hasMore: false };
			if (result?.data) state.pages.push(result.data.items);
			if (result?.isPending) state.loading = true;
			if (result?.isError) state.error = result.error;
			byTurn.set(turn.index, state);
		});
		for (const [index, state] of byTurn) {
			const turn = turnsByIndex.get(index)!;
			state.entries = state.pages.flat();
			const lastPage = state.pages[state.pages.length - 1];
			const lastSeq = state.entries[state.entries.length - 1]?.seq ?? -1;
			const complete = !lastPage || lastPage.length < ENTRY_PAGE_SIZE || lastSeq >= turn.endSeq;
			const requested = expanded.get(index) ?? 0;
			if (!state.loading && !state.error && !complete) {
				if (state.pages.length < requested) state.loading = true;
				else state.hasMore = true;
			}
		}

		const out: Row[] = [];
		turnItems.forEach((turn, position) => {
			const isExpanded = expanded.has(turn.index);
			out.push({ type: "head", key: `h${turn.index}`, turn, position, expanded: isExpanded });
			if (isExpanded) {
				const state = byTurn.get(turn.index);
				if (state) {
					const cached = timelineCache.current.get(turn.index);
					let items: TimelineItem[];
					if (
						cached &&
						cached.showHidden === showHidden &&
						cached.pages.length === state.pages.length &&
						cached.pages.every((page, i) => page === state.pages[i])
					) {
						items = cached.items;
					} else {
						items = buildTimeline(state.entries, turn.startSeq).filter((item) => showHidden || !item.hidden);
						timelineCache.current.set(turn.index, { pages: state.pages, showHidden, items });
					}
					for (const item of items) out.push({ type: "item", key: `i${turn.index}:${item.key}`, turn, item });
					if (state.error) out.push({ type: "status", key: `s${turn.index}`, turn, status: "error", error: state.error });
					else if (state.loading) out.push({ type: "status", key: `s${turn.index}`, turn, status: "loading" });
					else if (state.hasMore) out.push({ type: "status", key: `s${turn.index}`, turn, status: "more" });
					else if (items.length === 0) out.push({ type: "status", key: `s${turn.index}`, turn, status: "empty" });
				} else {
					out.push({ type: "status", key: `s${turn.index}`, turn, status: "loading" });
				}
			}
			out.push({ type: "foot", key: `f${turn.index}`, turn });
		});
		if (turns.hasNextPage) out.push({ type: "turns-loader", key: "turns-loader" });
		return { rows: out, byTurn };
		// `entrySignature` stands in for `entryQueries` and `entryResults`, which are new arrays every render.
	}, [turnItems, turnsByIndex, expanded, entrySignature, showHidden, turns.hasNextPage]);

	const scrollRoot = useScrollRoot();
	const listRef = useRef<HTMLDivElement>(null);
	const scrollMargin = useScrollMargin(listRef, scrollRoot);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRoot,
		estimateSize: (index) => estimateRow(rows[index]),
		overscan: 6,
		scrollMargin,
		getItemKey: (index) => rows[index]?.key ?? index,
	});
	const virtualItems = virtualizer.getVirtualItems();

	const toggle = useCallback((turn: Turn) => {
		setExpanded((current) => {
			const next = new Map(current);
			if (next.has(turn.index)) next.delete(turn.index);
			else next.set(turn.index, 1);
			return next;
		});
	}, [setExpanded]);

	// Load more turns or entry pages when their placeholder rows come into view.
	const visibleKeys = virtualItems.map((item) => item.key).join(",");
	const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = turns;
	useEffect(() => {
		const wanted: number[] = [];
		for (const virtual of virtualizer.getVirtualItems()) {
			const row = rows[virtual.index];
			if (!row) continue;
			if (row.type === "turns-loader" && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
			if (row.type === "status" && row.status === "more") wanted.push(row.turn.index);
		}
		if (wanted.length) {
			setExpanded((current) => {
				const next = new Map(current);
				for (const index of wanted) if (next.has(index)) next.set(index, (next.get(index) ?? 1) + 1);
				return next;
			});
		}
	}, [visibleKeys, rows, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

	// Deep link: load turns until one holds `focusSeq`, expand it, page its entries, then scroll.
	const [focus, setFocus] = useState(focusSeq);
	const [highlight, setHighlight] = useState<number | undefined>();
	useEffect(() => setFocus(focusSeq), [focusSeq]);
	useEffect(() => {
		if (highlight === undefined) return;
		const timer = setTimeout(() => setHighlight(undefined), HIGHLIGHT_MS);
		return () => clearTimeout(timer);
	}, [highlight]);
	useEffect(() => {
		if (focus === undefined || turns.isPending) return;
		const finish = (rowIndex: number | undefined, seq?: number) => {
			if (rowIndex !== undefined) {
				virtualizer.scrollToIndex(rowIndex, { align: "center" });
				setHighlight(seq);
			}
			setFocus(undefined);
			onFocusHandled?.();
		};
		const target = turnItems.find((turn) => turn.startSeq <= focus && focus <= turn.endSeq);
		if (!target) {
			const last = turnItems[turnItems.length - 1];
			if (hasNextPage && (!last || last.endSeq < focus)) {
				if (!isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
				if (!isFetchNextPageError) return;
			}
			finish(undefined);
			return;
		}
		const headIndex = rows.findIndex((row) => row.type === "head" && row.turn.index === target.index);
		if (focus === target.startSeq) {
			finish(headIndex, target.startSeq);
			return;
		}
		if (!expanded.has(target.index)) {
			setExpanded((current) => new Map(current).set(target.index, 1));
			return;
		}
		const itemIndex = rows.findIndex((row) => row.type === "item" && row.turn.index === target.index && itemHasSeq(row.item, focus));
		if (itemIndex >= 0) {
			finish(itemIndex, focus);
			return;
		}
		const state = byTurn.get(target.index);
		if (!state || state.loading) return;
		if (state.hasMore) {
			setExpanded((current) => new Map(current).set(target.index, (current.get(target.index) ?? 1) + 1));
			return;
		}
		finish(headIndex, target.startSeq);
	});

	const headRows = useMemo(() => rows.flatMap((row, index) => (row.type === "head" ? [index] : [])), [rows]);
	const activeTurnIndex = rows[headRows[active] ?? -1]?.type === "head" ? (rows[headRows[active]] as Extract<Row, { type: "head" }>).turn.index : -1;
	const move = (delta: number) => {
		if (headRows.length === 0) return;
		const next = Math.max(0, Math.min(headRows.length - 1, active + delta));
		setActive(next);
		virtualizer.scrollToIndex(headRows[next], { align: "start" });
		if (next === headRows.length - 1 && hasNextPage && !isFetchingNextPage) void fetchNextPage();
	};
	useShortcuts(nested ? {} : { j: () => move(1), k: () => move(-1) });

	if (turns.isPending) {
		return (
			<div className="space-y-6" aria-busy="true" aria-label="Loading prompts">
				{[0, 1].map((i) => (
					<div key={i} className="rounded-md border border-line px-6 py-5">
						<Skeleton className="mb-3 h-3 w-24" />
						<SkeletonLines lines={3} />
					</div>
				))}
			</div>
		);
	}
	if (turns.isError && turnItems.length === 0) return <ErrorState error={turns.error} onRetry={() => void turns.refetch()} />;
	if (turnItems.length === 0) return <EmptyState title="No prompts in this session" />;

	return (
		<div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }} data-turn-list="">
			{virtualItems.map((virtual) => {
				const row = rows[virtual.index];
				if (!row) return null;
				const isActive = row.type !== "turns-loader" && row.turn.index === activeTurnIndex;
				return (
					<div
						key={virtual.key}
						ref={virtualizer.measureElement}
						data-index={virtual.index}
						className="absolute top-0 left-0 w-full"
						style={{ transform: `translateY(${virtual.start - scrollMargin}px)` }}
					>
						{row.type === "head" ? (
							<TurnHead
								row={row}
								active={isActive}
								highlighted={highlight !== undefined && highlight === row.turn.startSeq}
								onToggle={() => toggle(row.turn)}
							/>
						) : row.type === "item" ? (
							<ItemShell
								active={isActive}
								seq={row.item.seq}
								highlighted={highlight !== undefined && highlight !== row.turn.startSeq && itemHasSeq(row.item, highlight)}
							>
								<TimelineItemView item={row.item} />
							</ItemShell>
						) : row.type === "status" ? (
							<ItemShell active={isActive}>
								{row.status === "error" ? (
									<ErrorState
										error={row.error}
										onRetry={() => void queryClient.refetchQueries({ queryKey: ["entries", sessionId], type: "all" })}
									/>
								) : row.status === "empty" ? (
									<div className="text-[14px] text-muted italic">No entries in this turn</div>
								) : (
									<div className="py-1" aria-busy="true" aria-label="Loading entries">
										<SkeletonLines lines={2} />
									</div>
								)}
							</ItemShell>
						) : row.type === "foot" ? (
							<TurnFoot turn={row.turn} active={isActive} />
						) : (
							<div className="py-2" aria-busy="true" aria-label="Loading more prompts">
								<SkeletonLines lines={2} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
