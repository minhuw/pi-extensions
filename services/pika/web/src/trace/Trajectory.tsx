import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { cx } from "../components/ui";
import { useApi } from "../lib/api";
import { isTypingTarget } from "../lib/keyboard";
import type { SessionTrace, TraceRecord, TraceTurn } from "../lib/types";
import { useViewState } from "../lib/viewState";
import { foldGaps, makeScale, traceIntervals, type Interval, type OverviewItem } from "./axis";
import { fetchTrace, traceKey } from "./data";
import { formatClock } from "./format";
import { Inspector, type InspectorTab, type InspectorTarget } from "./Inspector";
import { COST_DIAMETERS, COST_STEPS, formatCost, formatCount, plural } from "../lib/format";
import { FAMILIES, FAMILY_LABELS, hasProviderTiming, isSubagentTool, recordFamily, recordIsError, recordKey, recordSpan, type Family } from "./kinds";
import { Ledger, type LedgerHandle } from "./Ledger";
import { Overview } from "./Overview";
import { KindBullet, PhaseSwatch } from "./parts";
import { currentStop, initialReplay, REPLAY_SPEEDS, replayReducer, type ReplayState } from "./replay";
import {
	buildLedger,
	childrenOf,
	filterActive,
	isSelectable,
	NO_FILTER,
	rowForSeq,
	turnExpanded,
	turnForSeq,
	type ChildTraceState,
	type LedgerFilter,
	type LedgerRow,
} from "./rows";

const HIGHLIGHT_MS = 2500;
const TAB_KEY = "pika-inspector-tab";
const REDUCED_STEP_MS = 650;

function storedTab(): InspectorTab {
	try {
		const value = localStorage.getItem(TAB_KEY);
		return value === "input" || value === "output" || value === "context" || value === "raw" ? value : "rendered";
	} catch {
		return "rendered";
	}
}

/** Below this viewport width the inspector is a slide-over. */
const WIDE_QUERY = "(min-width: 1200px)";

function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const media = window.matchMedia(query);
		const update = () => setMatches(media.matches);
		update();
		media.addEventListener?.("change", update);
		return () => media.removeEventListener?.("change", update);
	}, [query]);
	return matches;
}

/**
 * Whether the ledger's navigation keys apply to a key press: on the page itself or in the ledger, but never on a
 * control that handles keys itself (buttons, links, tabs, the view switch, form fields) or inside the inspector.
 */
function navigationTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return true;
	if (target === document.body || target === document.documentElement) return true;
	if (target.closest("button, a, [role=tab], [role=radio], [role=checkbox], [role=switch], [role=menuitem], [contenteditable=''], [contenteditable=true], [data-inspector], [role=dialog]")) return false;
	return target.closest("[data-ledger]") !== null || target.matches("[data-scroll-root], main");
}

function turnKey(sessionId: string, index: number): string {
	return `turn:${sessionId}:${index}`;
}

function prefersReducedMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function ReplayControls({ state, dispatch, origin }: { state: ReplayState; dispatch: (action: Parameters<typeof replayReducer>[1]) => void; origin: string }) {
	const playing = state.status === "playing";
	return (
		<div className="flex items-center gap-1.5" data-replay="" data-status={state.status}>
			<button
				type="button"
				onClick={() => dispatch({ type: "toggle" })}
				className={cx(
					"inline-flex h-7 items-center gap-1.5 rounded-sm border border-ink px-2.5 text-[13px] font-medium transition-colors duration-150",
					playing ? "bg-ink text-page hover:bg-ink/82" : "bg-page text-ink hover:bg-hover",
				)}
				aria-label={playing ? "Pause replay" : "Replay the session"}
				data-replay-toggle=""
			>
				{playing ? (
					<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
						<rect x="1.5" y="1" width="2.5" height="8" rx="0.6" fill="currentColor" />
						<rect x="6" y="1" width="2.5" height="8" rx="0.6" fill="currentColor" />
					</svg>
				) : (
					<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
						<path d="M2 1.2v7.6a.5.5 0 0 0 .76.43l6.2-3.8a.5.5 0 0 0 0-.86L2.76.77A.5.5 0 0 0 2 1.2Z" fill="currentColor" />
					</svg>
				)}
				{playing ? "Pause" : state.status === "paused" && state.position < state.duration ? "Resume" : "Replay"}
			</button>
			<div className="flex h-7 items-center gap-px rounded-sm border border-line p-0.5" role="group" aria-label="Replay speed">
				{REPLAY_SPEEDS.map((speed) => (
					<button
						key={speed}
						type="button"
						onClick={() => dispatch({ type: "speed", speed })}
						aria-pressed={state.speed === speed}
						className={cx(
							"tnum h-full rounded-sm px-1.5 text-[12px] font-medium transition-colors duration-150",
							state.speed === speed ? "bg-ink text-page" : "text-muted hover:bg-hover hover:text-ink",
						)}
						data-speed={speed}
					>
						{speed}×
					</button>
				))}
			</div>
			{state.status !== "stopped" && (
				<>
					<span className="tnum px-1 text-[12px] text-ink" data-replay-clock="">
						{formatClock(state.position)} <span className="text-muted">/ {formatClock(state.duration)}</span>
					</span>
					<button
						type="button"
						onClick={() => dispatch({ type: "stop" })}
						className="inline-flex h-7 items-center rounded-sm px-1.5 text-[12px] text-muted hover:bg-hover hover:text-ink"
						aria-label="Stop replay"
						title="Stop (Esc)"
					>
						<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
							<rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="currentColor" />
						</svg>
					</button>
				</>
			)}
			<span className="sr-only" aria-live="polite">
				{state.status === "playing" ? `Replaying from ${origin}` : ""}
			</span>
		</div>
	);
}

export interface TrajectoryProps {
	sessionId: string;
	trace: SessionTrace;
	live: boolean;
	focusSeq?: number;
	onFocusHandled?: () => void;
}

const NO_KEYS: ReadonlySet<string> = new Set();
/** How long rows of arriving records keep their fade-in class. */
const FRESH_MS = 1500;

export function Trajectory({ sessionId, trace, live, focusSeq, onFocusHandled }: TrajectoryProps) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [turnOverrides, setTurnOverrides] = useViewState<Map<number, boolean>>(`ledger-turns:${sessionId}`, () => new Map());
	const [expanded, setExpanded] = useViewState<Set<string>>(`ledger-expanded:${sessionId}`, () => new Set());
	const [filter, setFilter] = useViewState<LedgerFilter>(`ledger-filter:${sessionId}`, NO_FILTER);
	const [range, setRange] = useState<Interval | undefined>();
	// Only the key: the record it names is read from the current trace, so a running tool shows its result once it has one.
	const [selectedKey, setSelectedKey] = useState<string | undefined>();
	const [hoveredKey, setHoveredKey] = useState<string | undefined>();
	const [highlightKey, setHighlightKey] = useState<string | undefined>();
	const [viewport, setViewport] = useState<Interval | undefined>();
	const [tab, setTabState] = useState<InspectorTab>(storedTab);
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const [childIds, setChildIds] = useState<string[]>([]);
	// Turns the replay opened to show its record; closed again when it stops.
	const [replayTurns, setReplayTurns] = useState<ReadonlySet<number>>(() => new Set());
	const [startAtTail] = useState(() => live && focusSeq === undefined);
	const wide = useMediaQuery(WIDE_QUERY);
	const ledger = useRef<LedgerHandle>(null);
	const inspector = useRef<HTMLDivElement>(null);
	const aside = useRef<HTMLElement>(null);
	const filterInput = useRef<HTMLInputElement>(null);

	const setTab = useCallback((next: InspectorTab) => {
		setTabState(next);
		try {
			localStorage.setItem(TAB_KEY, next);
		} catch {
			// Not remembered without storage.
		}
	}, []);

	// Records that arrived with this trace, for the ledger's fade-in; expanding or filtering reveals no new records.
	const [arrivals, setArrivals] = useState<{ trace: SessionTrace; keys: ReadonlySet<string> }>(() => ({ trace, keys: NO_KEYS }));
	if (arrivals.trace !== trace) {
		const before = new Set(arrivals.trace.records.map((record) => recordKey(sessionId, record)));
		const keys = new Set<string>();
		if (live) for (const record of trace.records) if (!before.has(recordKey(sessionId, record))) keys.add(recordKey(sessionId, record));
		setArrivals({ trace, keys: keys.size ? keys : NO_KEYS });
	}
	useEffect(() => {
		if (arrivals.keys.size === 0) return;
		const timer = setTimeout(() => setArrivals((current) => ({ ...current, keys: NO_KEYS })), FRESH_MS);
		return () => clearTimeout(timer);
	}, [arrivals.keys]);

	// Child traces load only when their subagent row is expanded.
	const childQueries = useQueries({
		// Live children refetch when their parent's trace shows them changed, not on every poll.
		queries: childIds.map((id) => ({ queryKey: traceKey(id), queryFn: () => fetchTrace(api, id, queryClient), staleTime: 60_000 })),
	});
	const childSignature = childQueries.map((query) => `${query.status}:${query.dataUpdatedAt}`).join(",");
	const childStates = useMemo(() => {
		const map = new Map<string, ChildTraceState>();
		childIds.forEach((id, i) => {
			const query = childQueries[i];
			if (query) map.set(id, { data: query.data, status: query.status, error: query.error });
		});
		return map;
		// `childSignature` stands in for `childQueries`, a new array every render.
	}, [childIds, childSignature]);

	const effectiveOverrides = useMemo(() => {
		if (replayTurns.size === 0) return turnOverrides;
		const merged = new Map(turnOverrides);
		for (const index of replayTurns) merged.set(index, true);
		return merged;
	}, [turnOverrides, replayTurns]);

	const rows = useMemo(
		() =>
			buildLedger({
				trace,
				turnOverrides: effectiveOverrides,
				expanded,
				childTrace: (id) => childStates.get(id),
				filter,
				range,
				ancestors: [sessionId],
			}),
		[trace, effectiveOverrides, expanded, childStates, filter, range, sessionId],
	);
	const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);

	useEffect(() => {
		const wanted = rows.flatMap((row) => (row.type === "status" && row.status === "loading" ? [row.sessionId] : []));
		const missing = wanted.filter((id) => !childIds.includes(id));
		if (missing.length) setChildIds((current) => [...current, ...missing.filter((id) => !current.includes(id))]);
	}, [rows, childIds]);

	const turnRecords = useMemo(() => {
		const map = new Map<number, TraceRecord[]>();
		for (const record of trace.records) {
			if (record.turn === undefined) continue;
			const list = map.get(record.turn);
			if (list) list.push(record);
			else map.set(record.turn, [record]);
		}
		return map;
	}, [trace]);

	const turnsByIndex = useMemo(() => new Map(trace.turns.map((turn) => [turn.index, turn])), [trace]);
	const recordsByKey = useMemo(() => new Map(trace.records.map((record) => [recordKey(sessionId, record), record])), [trace, sessionId]);

	const targetFor = useCallback(
		(row: LedgerRow): InspectorTarget | undefined => {
			if (row.type === "record") {
				const turn = row.depth === 0 && row.turnIndex !== undefined ? turnsByIndex.get(row.turnIndex) : undefined;
				return { kind: "record", record: row.record, sessionId: row.sessionId, children: row.children, turn };
			}
			if (row.type === "child") return { kind: "child", child: row.child };
			if (row.type === "turn") return { kind: "turn", turn: row.turn, records: turnRecords.get(row.turn.index) ?? [] };
			return undefined;
		},
		[turnsByIndex, turnRecords],
	);

	/** The target a key names in the current trace, also when its row is folded or filtered away. */
	const targetForKey = useCallback(
		(key: string | undefined): InspectorTarget | undefined => {
			if (!key) return undefined;
			const index = rowIndex.get(key);
			if (index !== undefined) return targetFor(rows[index]);
			const record = recordsByKey.get(key);
			if (record) {
				const turnIndex = record.turn ?? turnForSeq(trace, record.seq)?.index;
				const children = isSubagentTool(record) ? childrenOf(trace, record) : [];
				return { kind: "record", record, sessionId, children, turn: turnIndex !== undefined ? turnsByIndex.get(turnIndex) : undefined };
			}
			const turn = key.startsWith(`turn:${sessionId}:`) ? turnsByIndex.get(Number(key.slice(`turn:${sessionId}:`.length))) : undefined;
			return turn ? { kind: "turn", turn, records: turnRecords.get(turn.index) ?? [] } : undefined;
		},
		[rowIndex, rows, targetFor, recordsByKey, trace, sessionId, turnsByIndex, turnRecords],
	);

	// A nested record whose subagent row was folded is no longer in the rows; it keeps its last known target.
	const lastTarget = useRef<{ key: string; target: InspectorTarget } | undefined>(undefined);
	const selectedTarget = useMemo(() => {
		const target = targetForKey(selectedKey);
		if (target || !selectedKey) return target;
		return lastTarget.current?.key === selectedKey ? lastTarget.current.target : undefined;
	}, [selectedKey, targetForKey]);
	useEffect(() => {
		if (selectedKey && selectedTarget) lastTarget.current = { key: selectedKey, target: selectedTarget };
	}, [selectedKey, selectedTarget]);

	const select = useCallback(
		(key: string | undefined, options: { scroll?: boolean; open?: boolean } = {}) => {
			if (!key) {
				setSelectedKey(undefined);
				return;
			}
			if (!rowIndex.has(key)) return;
			setSelectedKey(key);
			if (options.open !== false) setInspectorOpen(true);
			if (options.scroll !== false) ledger.current?.scrollToKey(key);
		},
		[rowIndex],
	);

	// A record chosen outside the ledger (timeline, deep link) may sit in a collapsed turn: `reveal` expands it, then this
	// selects it once its row exists. A row that does not exist then (a filter hides it) is dropped, not revealed later.
	const [pending, setPending] = useState<{ key: string; highlight?: boolean; align?: "auto" | "center" } | undefined>();
	useEffect(() => {
		if (!pending) return;
		setPending(undefined);
		if (!rowIndex.has(pending.key)) return;
		setSelectedKey(pending.key);
		setInspectorOpen(true);
		ledger.current?.scrollToKey(pending.key, pending.align ?? "center");
		if (pending.highlight) setHighlightKey(pending.key);
	}, [pending, rowIndex]);

	useEffect(() => {
		if (!highlightKey) return;
		const timer = setTimeout(() => setHighlightKey(undefined), HIGHLIGHT_MS);
		return () => clearTimeout(timer);
	}, [highlightKey]);

	const reveal = useCallback(
		(record: TraceRecord, options: { highlight?: boolean; align?: "auto" | "center" } = {}) => {
			const turn = record.turn ?? turnForSeq(trace, record.seq)?.index;
			if (turn !== undefined && !filterActive(filter) && !range && !turnExpanded(trace, turnOverrides, turn)) {
				setTurnOverrides((current) => new Map(current).set(turn, true));
			}
			setPending({ key: recordKey(sessionId, record), ...options });
		},
		[trace, turnOverrides, setTurnOverrides, filter, range, sessionId],
	);

	// On a wide screen the inspector is part of the first view, so the session opens with a record in it: the latest one
	// while it runs, else its first failure, else its last record. A deep link, or a choice already made, wins.
	const opened = useRef(false);
	useEffect(() => {
		if (opened.current || !wide || focusSeq !== undefined) return;
		opened.current = true;
		if (selectedKey !== undefined) return;
		const records = trace.records.filter((record) => record.kind === "llm" || record.kind === "tool");
		const target = (live ? undefined : records.find(recordIsError)) ?? records.at(-1);
		if (target) reveal(target, { align: "center" });
	}, [wide, focusSeq, selectedKey, trace, live, reveal]);

	// `?seq=`: select and scroll to the record, once.
	const handledSeq = useRef<number | undefined>(undefined);
	const [pendingSeq, setPendingSeq] = useState<number | undefined>();
	useEffect(() => {
		if (focusSeq === undefined || handledSeq.current === focusSeq) return;
		handledSeq.current = focusSeq;
		const turn = turnForSeq(trace, focusSeq);
		if (turn && !turnExpanded(trace, turnOverrides, turn.index)) setTurnOverrides((current) => new Map(current).set(turn.index, true));
		// Filters would hide the target.
		setFilter(NO_FILTER);
		setRange(undefined);
		setPendingSeq(focusSeq);
		onFocusHandled?.();
	}, [focusSeq, trace, turnOverrides, setTurnOverrides, setFilter, onFocusHandled]);
	useEffect(() => {
		if (pendingSeq === undefined) return;
		const index = rowForSeq(rows, pendingSeq);
		const turn = turnForSeq(trace, pendingSeq);
		if (turn && !turnExpanded(trace, turnOverrides, turn.index) && rows[index]?.type !== "turn") return;
		setPendingSeq(undefined);
		const row = rows[index];
		if (row) setPending({ key: row.key, highlight: true, align: "center" });
	}, [pendingSeq, rows, trace, turnOverrides]);

	const toggleTurn = useCallback(
		(turn: TraceTurn) => {
			setTurnOverrides((current) => new Map(current).set(turn.index, !turnExpanded(trace, current, turn.index)));
		},
		[trace, setTurnOverrides],
	);

	const toggleExpand = useCallback(
		(key: string) => {
			setExpanded((current) => {
				const next = new Set(current);
				if (next.has(key)) next.delete(key);
				else next.add(key);
				return next;
			});
		},
		[setExpanded],
	);

	const collapseAll = useCallback(
		(collapse: boolean) => setTurnOverrides(new Map(trace.turns.map((turn) => [turn.index, !collapse]))),
		[trace, setTurnOverrides],
	);

	const onOverviewSelect = useCallback(
		(item: OverviewItem) => {
			if (item.record) reveal(item.record, { align: "center" });
			else if (item.turnIndex !== undefined) {
				const turn = turnsByIndex.get(item.turnIndex);
				if (turn) {
					if (!turnExpanded(trace, turnOverrides, turn.index)) setTurnOverrides((current) => new Map(current).set(turn.index, true));
					setPending({ key: turnKey(sessionId, turn.index), align: "center" });
				}
			} else if (item.childId) {
				const parent = trace.records.find((record) => record.kind === "tool" && trace.children.some((c) => c.sessionId === item.childId && c.parentToolCallId === record.callId));
				if (parent) reveal(parent, { align: "center" });
			}
		},
		[reveal, turnsByIndex, trace, turnOverrides, setTurnOverrides, sessionId],
	);

	// Replay over the gap-folded axis; positions do not depend on the canvas width.
	const axis = useMemo(() => foldGaps(traceIntervals(trace)), [trace]);
	const scale = useMemo(() => makeScale(axis, 1000), [axis]);
	const stops = useMemo(() => {
		const list: { position: number; record: TraceRecord }[] = [];
		for (const record of trace.records) {
			const { start } = recordSpan(record);
			if (start !== undefined) list.push({ position: scale.position(start), record });
		}
		return list.sort((a, b) => a.position - b.position);
	}, [trace, scale]);
	const stopPositions = useMemo(() => stops.map((stop) => stop.position), [stops]);
	const [replay, dispatch] = useReducer(replayReducer, axis.activeMs, initialReplay);
	useEffect(() => dispatch({ type: "duration", duration: axis.activeMs }), [axis.activeMs]);

	useEffect(() => {
		if (replay.status !== "playing") return;
		if (prefersReducedMotion()) {
			const timer = setInterval(() => dispatch({ type: "step", stops: stopPositions }), REDUCED_STEP_MS);
			return () => clearInterval(timer);
		}
		let frame = 0;
		let last = performance.now();
		// About 30 frames a second is smooth enough; rows re-render only when the current record changes.
		const loop = (now: number) => {
			if (now - last >= 32) {
				dispatch({ type: "tick", dt: Math.min(100, now - last) });
				last = now;
			}
			frame = requestAnimationFrame(loop);
		};
		frame = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(frame);
	}, [replay.status, stopPositions]);

	const replayIndex = replay.status === "stopped" ? -1 : currentStop(stopPositions, replay.position);
	const replayRecord = replayIndex >= 0 ? stops[replayIndex]?.record : undefined;
	const replayKey = replayRecord ? recordKey(sessionId, replayRecord) : undefined;

	// The ledger follows the playhead: it highlights and scrolls to the current record, opening a collapsed turn only
	// for the replay. Replay never selects, opens the slide-over, or changes the turns the reader folded.
	const scrolledTo = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!replayRecord || !replayKey) return;
		if (rowIndex.has(replayKey)) {
			if (scrolledTo.current !== replayKey) {
				scrolledTo.current = replayKey;
				ledger.current?.scrollToKey(replayKey, "auto");
			}
			return;
		}
		const turn = replayRecord.turn ?? turnForSeq(trace, replayRecord.seq)?.index;
		if (turn !== undefined && !filterActive(filter) && !range && !turnExpanded(trace, effectiveOverrides, turn)) {
			setReplayTurns((current) => new Set(current).add(turn));
		}
	}, [replayKey, replayRecord, rowIndex, trace, filter, range, effectiveOverrides]);
	useEffect(() => {
		if (replay.status !== "stopped") return;
		scrolledTo.current = undefined;
		setReplayTurns((current) => (current.size ? new Set() : current));
	}, [replay.status]);
	// Pausing selects the record the playhead stopped on, so the inspector shows it in full.
	const previousStatus = useRef(replay.status);
	useEffect(() => {
		if (previousStatus.current === "playing" && replay.status === "paused" && replayKey) setSelectedKey(replayKey);
		previousStatus.current = replay.status;
	}, [replay.status, replayKey]);

	// Focus moves to the inspector after the render that opens it; a closed slide-over is inert and takes no focus.
	const [focusInspector, setFocusInspector] = useState(0);
	useEffect(() => {
		if (focusInspector) inspector.current?.focus();
	}, [focusInspector]);

	const overlay = !wide;
	const overlayOpen = overlay && inspectorOpen && selectedTarget !== undefined;
	const closeInspector = useCallback(() => {
		setInspectorOpen(false);
		// Focus must not stay in a slide-over that is gone.
		if (aside.current?.contains(document.activeElement)) ledger.current?.focus();
	}, []);

	// Keyboard: in the capture phase, so `/` beats the app-wide search shortcut. The ledger's navigation keys apply only
	// on the page or in the ledger; `/` and Esc apply anywhere but in form fields and dialogs.
	const keyState = useRef({ rows, selectedKey, range, replay, filter, overlayOpen });
	keyState.current = { rows, selectedKey, range, replay, filter, overlayOpen };
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			if (isTypingTarget(event.target)) return;
			if (document.querySelector("[aria-modal='true'], [data-context-drawer]")) return;
			if (event.target instanceof Element && event.target.closest("[role=dialog]")) return;
			const { rows, selectedKey, range, replay, filter, overlayOpen } = keyState.current;
			const handle = (fn: () => void) => {
				event.preventDefault();
				fn();
			};
			if (event.key === "/") return handle(() => filterInput.current?.focus());
			if (event.key === "?") return handle(() => document.querySelector<HTMLElement>("[data-ledger-help] button")?.focus());
			if (event.key === "Escape") {
				// Esc in an open filter menu only closes the menu, which handles it itself.
				if (event.target instanceof Element && event.target.closest("[data-filter-menu]")) return;
				// Esc in the help closes it and keeps everything else.
				if (event.target instanceof HTMLElement && event.target.closest("[data-ledger-help]")) {
					const help = event.target;
					return handle(() => help.blur());
				}
				if (replay.status !== "stopped") return handle(() => dispatch({ type: "stop" }));
				if (overlayOpen) return handle(closeInspector);
				if (range) return handle(() => setRange(undefined));
				if (filterActive(filter)) return handle(() => setFilter(NO_FILTER));
				if (selectedKey) return handle(() => setSelectedKey(undefined));
				return;
			}
			if (!navigationTarget(event.target)) return;
			const index = selectedKey ? rows.findIndex((row) => row.key === selectedKey) : -1;
			const moveBy = (delta: number) => {
				let next = index;
				do next += delta;
				while (next >= 0 && next < rows.length && !isSelectable(rows[next]) && rows[next]?.type !== "turn");
				if (index < 0) next = delta > 0 ? rows.findIndex((row) => isSelectable(row)) : rows.length - 1;
				const row = rows[next];
				if (row) select(row.key);
			};
			const row = rows[index];
			switch (event.key) {
				case "ArrowDown":
				case "j":
					return handle(() => moveBy(1));
				case "ArrowUp":
				case "k":
					return handle(() => moveBy(-1));
				case "ArrowLeft":
					return handle(() => {
						if (!row) return;
						if ((row.type === "record" || row.type === "child") && row.expanded) toggleExpand(row.key);
						else if (row.type === "turn") {
							if (row.expanded) toggleTurn(row.turn);
						} else if (row.type === "record" && row.depth === 0 && row.turnIndex !== undefined) {
							const turn = turnsByIndex.get(row.turnIndex);
							if (turn) {
								toggleTurn(turn);
								setPending({ key: turnKey(sessionId, turn.index) });
							}
						}
					});
				case "ArrowRight":
					return handle(() => {
						if (!row) return;
						if (row.type === "turn" && !row.expanded) toggleTurn(row.turn);
						else if (row.type === "record" && row.children.length && !row.expanded) toggleExpand(row.key);
						else if (row.type === "child" && !row.expanded) toggleExpand(row.key);
					});
				case "[":
				case "]":
					return handle(() => {
						const heads = rows.flatMap((candidate, i) => (candidate.type === "turn" ? [i] : []));
						const target = event.key === "]" ? heads.find((i) => i > index) : [...heads].reverse().find((i) => i < index);
						if (target !== undefined) select(rows[target].key, { scroll: true });
					});
				case "Enter":
					if (!selectedKey) return;
					return handle(() => {
						if (row?.type === "turn") toggleTurn(row.turn);
						else {
							setInspectorOpen(true);
							setFocusInspector((n) => n + 1);
						}
					});
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [select, toggleExpand, toggleTurn, turnsByIndex, sessionId, setFilter, closeInspector]);

	const timed = useMemo(() => hasProviderTiming(trace), [trace]);

	const primaryModel = useMemo(() => {
		const tally = new Map<string, number>();
		for (const record of trace.records) if (record.kind === "llm" && record.model) tally.set(record.model, (tally.get(record.model) ?? 0) + 1);
		return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];
	}, [trace]);

	const counts = useMemo(
		() => ({ shown: rows.filter((row) => row.type === "record" && row.depth === 0).length, total: trace.records.length }),
		[rows, trace.records.length],
	);
	// Records of each kind and failed records, for the ledger's kind menu and errors toggle.
	const { familyCounts, errorCount } = useMemo(() => {
		const byFamily = new Map<Family, number>();
		let failed = 0;
		for (const record of trace.records) {
			byFamily.set(recordFamily(record), (byFamily.get(recordFamily(record)) ?? 0) + 1);
			if (recordIsError(record)) failed++;
		}
		return { familyCounts: byFamily, errorCount: failed };
	}, [trace.records]);
	const rangeLabel = range ? `${formatClock(range.start - axis.origin)}–${formatClock(range.end - axis.origin)}` : undefined;
	const selectedTopKey = selectedKey && recordsByKey.has(selectedKey) ? selectedKey : undefined;
	const onSelectCall = useCallback(
		(callId: string) => {
			const record = trace.records.find((candidate) => candidate.kind === "tool" && candidate.callId === callId);
			if (record) reveal(record, { align: "center" });
		},
		[trace, reveal],
	);
	const onLedgerSelect = useCallback((key: string) => select(key, { scroll: false }), [select]);
	const onToggleTurn = useCallback(
		(turn: TraceTurn) => {
			toggleTurn(turn);
			setSelectedKey(turnKey(sessionId, turn.index));
		},
		[toggleTurn, sessionId],
	);
	const clearRange = useCallback(() => setRange(undefined), []);
	const onScrub = useCallback((position: number) => dispatch({ type: "seek", position }), []);

	// While playing, the inspector previews the playhead's record; otherwise it shows the selection.
	const replayTarget = replay.status === "playing" ? targetForKey(replayKey) : undefined;
	const inspected = replayTarget ?? selectedTarget;

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-trajectory="">
			<section className="shrink-0 border-y border-line px-6 pt-2 pb-3" aria-label="Timeline">
				<div className="mb-1.5 flex h-8 min-w-0 items-center gap-3 whitespace-nowrap">
					<h2 className="text-[13px] font-semibold">Trajectory</h2>
					<span className="tnum text-[12px] text-muted" data-trajectory-counts="">
						{plural(trace.turns.length, "turn")} · {formatCount(trace.records.length)} {trace.records.length === 1 ? "record" : "records"}
					</span>
					<ul
						className={cx("ml-auto flex min-w-0 items-center gap-3 overflow-hidden text-[12px] max-lg:hidden", timed && "max-[1439px]:gap-2.5")}
						aria-label="Record kinds"
						data-kind-legend=""
					>
						{FAMILIES.map((family) => (
							<li key={family} className="flex shrink-0 items-center gap-1.5">
								<KindBullet family={family} size={14} />
								{FAMILY_LABELS[family]}
							</li>
						))}
						<li
							className="flex shrink-0 items-center gap-1.5 border-l border-line pl-3"
							title={`A model call's bar is as thick as it cost: up to ${COST_STEPS.record.map(formatCost).join(", ")}, and more`}
							data-cost-key=""
						>
							Cost
							<span className="flex items-center gap-1" aria-hidden="true">
								{COST_DIAMETERS.map((thickness) => (
									<span key={thickness} className="w-[10px] bg-k-llm" style={{ height: thickness }} />
								))}
							</span>
						</li>
						{timed && (
							<li
								className="flex shrink-0 items-center gap-1.5 border-l border-line pl-3"
								title="On the provider row, a timed model call is hatched while it waits for its first token and solid while it streams"
								data-phase-key=""
							>
								{/* Below 1440 px there is room only for the swatches; the words stay for screen readers. */}
								<PhaseSwatch phase="waiting" />
								<span className="max-[1439px]:sr-only">Waiting</span>
								<PhaseSwatch phase="streaming" className="min-[1440px]:ml-1.5" />
								<span className="max-[1439px]:sr-only">Streaming</span>
							</li>
						)}
					</ul>
					<div className="ml-auto shrink-0 border-l border-line pl-3 lg:ml-0">
						<ReplayControls state={replay} dispatch={dispatch} origin={formatClock(replay.position)} />
					</div>
				</div>
				<ErrorBoundary label="the timeline" resetKey={trace} fallback={() => <OverviewError />}>
					<Overview
						trace={trace}
						selectedKey={replay.status !== "stopped" && replayKey ? replayKey : selectedTopKey}
						hoveredKey={hoveredKey}
						onHover={setHoveredKey}
						onSelect={onOverviewSelect}
						range={range}
						onRange={setRange}
						viewport={viewport}
						playhead={replay.status === "stopped" ? undefined : replay.position}
						onScrub={onScrub}
					/>
				</ErrorBoundary>
			</section>
			<div className="relative flex min-h-0 flex-1">
				<div className="min-w-0 flex-1">
					<Ledger
						ref={ledger}
						rows={rows}
						live={live}
						recordCount={trace.records.length}
						freshKeys={arrivals.keys}
						startAtTail={startAtTail}
						selectedKey={selectedKey}
						hoveredKey={hoveredKey}
						highlightKey={highlightKey}
						replayKey={replayKey}
						onSelect={onLedgerSelect}
						onHover={setHoveredKey}
						onToggleTurn={onToggleTurn}
						onToggleExpand={toggleExpand}
						onViewport={setViewport}
						counts={counts}
						filter={filter}
						onFilter={setFilter}
						range={range}
						rangeLabel={rangeLabel}
						onClearRange={clearRange}
						onCollapseAll={collapseAll}
						filterRef={filterInput}
						familyCounts={familyCounts}
						errorCount={errorCount}
						primaryModel={primaryModel}
					/>
				</div>
				<aside
					ref={aside}
					className={cx(
						"flex flex-col border-l border-ink bg-page min-[1200px]:border-line",
						"fixed inset-y-0 right-0 z-30 w-[min(560px,100vw)] transition-transform duration-150",
						// The shadow only while open: off screen it would still darken the page's right edge.
						overlayOpen ? "translate-x-0 shadow-[0_8px_24px_rgba(0,0,0,0.14)]" : "pointer-events-none translate-x-full",
						"min-[1200px]:pointer-events-auto min-[1200px]:static min-[1200px]:z-auto min-[1200px]:w-[40%] min-[1200px]:max-w-[680px] min-[1200px]:min-w-[420px] min-[1200px]:translate-x-0 min-[1200px]:shadow-none",
						// With nothing to inspect, the ledger takes the whole width.
						!inspected && "min-[1200px]:hidden",
					)}
					aria-label="Inspector"
					// Off screen as a closed slide-over: out of the tab order and the accessibility tree.
					inert={overlay && !overlayOpen}
					aria-hidden={overlay && !overlayOpen ? true : undefined}
					data-slide-over={overlay ? (overlayOpen ? "open" : "closed") : undefined}
					data-inspector-pane={inspected ? "shown" : "hidden"}
				>
					<Inspector
						ref={inspector}
						target={inspected}
						trace={trace}
						tab={tab}
						onTab={setTab}
						preview={replayTarget !== undefined}
						live={live}
						onClose={closeInspector}
						onSelectCall={onSelectCall}
					/>
				</aside>
			</div>
		</div>
	);
}

function OverviewError() {
	return (
		<div className="flex h-[96px] items-center justify-center border-y border-line text-[13px] text-muted" data-overview-error="">
			The timeline could not be drawn. The ledger below lists every record.
		</div>
	);
}
