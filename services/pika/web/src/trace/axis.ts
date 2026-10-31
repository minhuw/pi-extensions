// The overview's time axis: idle gaps folded into fixed-width breaks, a pixel scale over the
// remaining active time, ticks, and the layout and hit-testing of the drawn records.
import type { SessionTrace, TraceRecord } from "../lib/types";
import { childSpan, contextTokens, llmPhases, recordFamily, recordIsError, recordKey, recordSpan, type Family, type LlmPhases } from "./kinds";

/** Idle stretches longer than this fold into a break marker. */
export const GAP_MS = 120_000;
/** A cluster of activity shorter than this still gets this much axis, so instants stay visible. */
const MIN_SEGMENT_MS = 1_000;

export interface Interval {
	start: number;
	end: number;
}

/** A stretch of activity; `offset` is the active time before it, gaps excluded. */
export interface AxisSegment extends Interval {
	offset: number;
}

export interface Axis {
	origin: number;
	segments: AxisSegment[];
	/** `gaps[i]` lies between `segments[i]` and `segments[i + 1]`. */
	gaps: Interval[];
	/** Active time: the segments' total length. */
	activeMs: number;
}

/** Merges intervals into active segments, folding gaps longer than `gapMs`. */
export function foldGaps(intervals: Interval[], gapMs = GAP_MS): Axis {
	const sorted = intervals
		.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end))
		.map((item) => ({ start: Math.min(item.start, item.end), end: Math.max(item.start, item.end) }))
		.sort((a, b) => a.start - b.start);
	if (sorted.length === 0) return { origin: 0, segments: [{ start: 0, end: MIN_SEGMENT_MS, offset: 0 }], gaps: [], activeMs: MIN_SEGMENT_MS };
	const clusters: Interval[] = [];
	let current = { ...sorted[0] };
	for (const item of sorted.slice(1)) {
		if (item.start - current.end > gapMs) {
			clusters.push(current);
			current = { ...item };
		} else if (item.end > current.end) current.end = item.end;
	}
	clusters.push(current);
	const segments: AxisSegment[] = [];
	const gaps: Interval[] = [];
	let offset = 0;
	clusters.forEach((cluster, index) => {
		const end = Math.max(cluster.end, cluster.start + MIN_SEGMENT_MS);
		// A padded instant must not overlap the next cluster.
		const next = clusters[index + 1];
		const clipped = next ? Math.min(end, next.start) : end;
		segments.push({ start: cluster.start, end: clipped, offset });
		offset += clipped - cluster.start;
		if (next) gaps.push({ start: clipped, end: next.start });
	});
	return { origin: segments[0].start, segments, gaps, activeMs: offset };
}

/** The intervals a trace occupies: records, turns, and child sessions; anything without a known time is left out. */
export function traceIntervals(trace: SessionTrace): Interval[] {
	const out: Interval[] = [];
	for (const record of trace.records) {
		const { start, end } = recordSpan(record);
		if (start !== undefined) out.push({ start, end: end ?? start });
	}
	for (const turn of trace.turns) if (turn.at !== undefined) out.push({ start: turn.at, end: turn.at + Math.max(0, turn.durationMs || 0) });
	for (const child of trace.children) {
		const { start, end } = childSpan(trace, child);
		if (start !== undefined) out.push({ start, end: end ?? start });
	}
	return out;
}

export interface Scale {
	axis: Axis;
	width: number;
	breakPx: number;
	pxPerMs: number;
	/** x of an instant; instants inside a gap fall inside its break marker. */
	x(t: number): number;
	/** The instant at `x`. */
	time(x: number): number;
	/** Start and end x of each gap's break marker. */
	breaks(): { x0: number; x1: number; gap: Interval }[];
	/** Active time before `t`, the replay's position. */
	position(t: number): number;
	/** The instant at an active-time position. */
	timeAt(position: number): number;
}

function segmentIndex(axis: Axis, t: number): number {
	// The first segment ending at or after `t`.
	let lo = 0;
	let hi = axis.segments.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (axis.segments[mid].end < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export function makeScale(axis: Axis, width: number, options: { breakPx?: number } = {}): Scale {
	const gaps = axis.gaps.length;
	const usable = Math.max(1, width);
	// Breaks may take at most a third of the width.
	const breakPx = gaps ? Math.min(options.breakPx ?? 28, (usable * 0.33) / gaps) : 0;
	const pxPerMs = Math.max(1e-12, (usable - gaps * breakPx) / Math.max(1, axis.activeMs));
	const startX = (i: number) => axis.segments[i].offset * pxPerMs + i * breakPx;
	const endX = (i: number) => startX(i) + (axis.segments[i].end - axis.segments[i].start) * pxPerMs;

	const x = (t: number): number => {
		const { segments } = axis;
		// An unknown time has no place on the axis; callers skip it, and a slip lands at the start, not in a throw.
		if (!Number.isFinite(t) || t <= segments[0].start) return 0;
		const last = segments.length - 1;
		if (t >= segments[last].end) return Math.min(usable, endX(last));
		const i = segmentIndex(axis, t);
		const segment = segments[i];
		if (t >= segment.start) return startX(i) + (t - segment.start) * pxPerMs;
		const gap = axis.gaps[i - 1];
		const fraction = gap.end > gap.start ? (t - gap.start) / (gap.end - gap.start) : 0;
		return endX(i - 1) + fraction * breakPx;
	};

	const time = (px: number): number => {
		const { segments } = axis;
		if (!Number.isFinite(px)) return segments[0].start;
		for (let i = 0; i < segments.length; i++) {
			const x0 = startX(i);
			if (px < x0 && i > 0) {
				const gap = axis.gaps[i - 1];
				const fraction = Math.max(0, Math.min(1, (px - endX(i - 1)) / Math.max(1, breakPx)));
				return gap.start + fraction * (gap.end - gap.start);
			}
			if (px <= endX(i) || i === segments.length - 1) {
				const t = segments[i].start + Math.max(0, px - x0) / pxPerMs;
				return Math.min(segments[i].end, t);
			}
		}
		return segments[segments.length - 1].end;
	};

	const position = (t: number): number => {
		const { segments } = axis;
		if (!Number.isFinite(t) || t <= segments[0].start) return 0;
		const i = segmentIndex(axis, t);
		const segment = segments[Math.min(i, segments.length - 1)];
		if (t >= segment.end) return segment.offset + (segment.end - segment.start);
		return segment.offset + Math.max(0, t - segment.start);
	};

	const timeAt = (p: number): number => {
		const { segments } = axis;
		const clamped = Number.isFinite(p) ? Math.max(0, Math.min(axis.activeMs, p)) : 0;
		for (const segment of segments) {
			const length = segment.end - segment.start;
			if (clamped <= segment.offset + length) return segment.start + (clamped - segment.offset);
		}
		return segments[segments.length - 1].end;
	};

	const breaks = () => axis.gaps.map((gap, i) => ({ x0: endX(i), x1: endX(i) + breakPx, gap }));

	return { axis, width: usable, breakPx, pxPerMs, x, time, breaks, position, timeAt };
}

/** The narrowest zoom window, in active time. */
export const MIN_WINDOW_MS = 1_000;

/** A window's length kept between the narrowest window and the whole session. */
function windowLength(axis: Axis, length: number): number {
	const min = Math.min(MIN_WINDOW_MS, axis.activeMs);
	return Math.max(min, Math.min(axis.activeMs, Number.isFinite(length) ? length : axis.activeMs));
}

/** A zoom window, in active time, kept inside the session and at least `MIN_WINDOW_MS` long. */
export function clampWindow(axis: Axis, window: Interval): Interval {
	const length = windowLength(axis, window.end - window.start);
	const start = Math.max(0, Math.min(axis.activeMs - length, Number.isFinite(window.start) ? window.start : 0));
	return { start, end: start + length };
}

/** Whether a window shows the whole session. */
export function isFullWindow(axis: Axis, window: Interval | undefined): boolean {
	return !window || (window.start <= 0.5 && window.end >= axis.activeMs - 0.5);
}

/**
 * The axis clipped to a window in active time: segments cut at its edges, the gaps inside it kept, and the origin
 * unchanged, so clock labels still count from the session's start.
 */
export function windowAxis(axis: Axis, window: Interval): Axis {
	const segments: AxisSegment[] = [];
	const gaps: Interval[] = [];
	axis.segments.forEach((segment, i) => {
		const a = Math.max(window.start, segment.offset);
		const b = Math.min(window.end, segment.offset + (segment.end - segment.start));
		if (b <= a) return;
		// The window is one stretch of active time, so kept segments are neighbours and the gap between them is theirs.
		if (segments.length) gaps.push(axis.gaps[i - 1]);
		segments.push({ start: segment.start + (a - segment.offset), end: segment.start + (b - segment.offset), offset: a - window.start });
	});
	if (segments.length === 0) return axis;
	return { origin: axis.origin, segments, gaps, activeMs: segments.reduce((total, segment) => total + segment.end - segment.start, 0) };
}

/** The scale of a window: the whole axis when there is none. */
export function windowScale(axis: Axis, window: Interval | undefined, width: number): Scale {
	return makeScale(window && !isFullWindow(axis, window) ? windowAxis(axis, window) : axis, width);
}

/**
 * The window zoomed by `factor` (above 1 zooms in) around `anchor`, an active-time position. With a `width` and the
 * anchor's pixel `x`, the anchor stays at that pixel; breaks keep their fixed width, so this is solved, not scaled.
 */
export function zoomWindow(axis: Axis, window: Interval, factor: number, anchor: number, width?: number, x?: number): Interval {
	const current = clampWindow(axis, window);
	const length = windowLength(axis, (current.end - current.start) / (factor > 0 && Number.isFinite(factor) ? factor : 1));
	const fraction = Math.max(0, Math.min(1, (anchor - current.start) / Math.max(1e-9, current.end - current.start)));
	let start = anchor - fraction * length;
	if (width !== undefined && x !== undefined && length < axis.activeMs) {
		const t = makeScale(axis, 1).timeAt(anchor);
		// The anchor's x falls as the window's start moves right.
		let lo = Math.max(0, anchor - length);
		let hi = Math.min(anchor, axis.activeMs - length);
		for (let i = 0; i < 48 && hi - lo > 0.01; i++) {
			const mid = (lo + hi) / 2;
			if (makeScale(windowAxis(axis, { start: mid, end: mid + length }), width).x(t) > x) lo = mid;
			else hi = mid;
		}
		start = (lo + hi) / 2;
	}
	return clampWindow(axis, { start, end: start + length });
}

/** The window moved by `delta` active milliseconds, stopping at the session's ends. */
export function panWindow(axis: Axis, window: Interval, delta: number): Interval {
	const current = clampWindow(axis, window);
	return clampWindow(axis, { start: current.start + delta, end: current.end + delta });
}

/** The window moved, at the same zoom, so `position` is at its centre. */
export function centreWindow(axis: Axis, window: Interval, position: number): Interval {
	const current = clampWindow(axis, window);
	const half = (current.end - current.start) / 2;
	return clampWindow(axis, { start: position - half, end: position + half });
}

const TICK_STEPS = [
	100, 200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
	10_800_000, 21_600_000, 43_200_000, 86_400_000,
];

export interface Tick {
	x: number;
	/** Wall-clock time since the session started, gaps included. */
	elapsed: number;
}

/** The round elapsed-time step ticks are at, at least `minSpacing` pixels apart and no finer than `minStep`. */
export function tickStep(scale: Scale, minSpacing = 72, minStep = 1_000): number {
	return TICK_STEPS.find((candidate) => candidate >= minStep && candidate * scale.pxPerMs >= minSpacing) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * Ticks at a round elapsed-time step at least `minSpacing` pixels apart; each segment that begins at a break or at the
 * session's start starts with a tick. Steps below a second are only used with a smaller `minStep`, when zoomed.
 */
export function axisTicks(scale: Scale, minSpacing = 72, minStep = 1_000): Tick[] {
	const { axis } = scale;
	const step = tickStep(scale, minSpacing, minStep);
	const ticks: Tick[] = [];
	let lastX = Number.NEGATIVE_INFINITY;
	for (const [index, segment] of axis.segments.entries()) {
		const first = segment.start - axis.origin;
		// A window's first segment that starts mid-stretch gets only round ticks.
		const cut = index === 0 && segment.start !== axis.origin;
		const candidates = cut ? [] : [first];
		// Integer steps, so a tenth of a second does not drift.
		for (let n = Math.ceil(first / step); n * step <= segment.end - axis.origin; n++) if (n * step !== first || cut) candidates.push(n * step);
		candidates.forEach((elapsed, i) => {
			const x = scale.x(axis.origin + elapsed);
			if (x - lastX < minSpacing * 0.7) {
				// A segment's start, right after a break, says more than the tick before it.
				if (i !== 0 || ticks.length === 0) return;
				ticks.pop();
			}
			ticks.push({ x, elapsed });
			lastX = x;
		});
	}
	return ticks;
}

export type OverviewLane = "turns" | "provider" | "llm" | "tools" | "agents";

export interface OverviewItem {
	key: string;
	lane: OverviewLane;
	family: Family | "turn";
	error: boolean;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	/** Record start, for ordering and the tooltip. */
	start: number;
	end?: number;
	record?: TraceRecord;
	/** A timed model call's phases, on its model-call bar and its provider bar. */
	phases?: LlmPhases;
	turnIndex?: number;
	childId?: string;
}

export interface LaneBox {
	lane: OverviewLane;
	label: string;
	y0: number;
	y1: number;
}

/**
 * The strip map's rows, each labelled in the gutter: turns as stations with a bar for each turn's extent, model calls
 * as bars along the trunk, tool calls as bars on up to three rows below it, and subagents as branch lines underneath.
 * The bands do not overlap, so a pointer always means one row. With `provider`, a row above the model calls holds the
 * provider's side of each timed call, as the far lifeline of a sequence diagram, and the rows below move down.
 */
export function overviewLanes(compact: boolean, provider = false): LaneBox[] {
	if (compact && provider) {
		return [
			{ lane: "turns", label: "Turns", y0: 1, y1: 10 },
			{ lane: "provider", label: "Provider", y0: 12, y1: 20 },
			{ lane: "llm", label: "Model calls", y0: 22, y1: 33 },
			{ lane: "tools", label: "Tools", y0: 35, y1: 47 },
			{ lane: "agents", label: "Subagents", y0: 49, y1: 58 },
		];
	}
	if (provider) {
		return [
			{ lane: "turns", label: "Turns", y0: 2, y1: 20 },
			{ lane: "provider", label: "Provider", y0: 22, y1: 34 },
			{ lane: "llm", label: "Model calls", y0: 40, y1: 58 },
			{ lane: "tools", label: "Tools", y0: 62, y1: 82 },
			{ lane: "agents", label: "Subagents", y0: 86, y1: 102 },
		];
	}
	if (compact) {
		return [
			{ lane: "turns", label: "Turns", y0: 1, y1: 10 },
			{ lane: "llm", label: "Model calls", y0: 11, y1: 22 },
			{ lane: "tools", label: "Tools", y0: 24, y1: 36 },
			{ lane: "agents", label: "Subagents", y0: 38, y1: 47 },
		];
	}
	return [
		{ lane: "turns", label: "Turns", y0: 2, y1: 20 },
		{ lane: "llm", label: "Model calls", y0: 22, y1: 40 },
		{ lane: "tools", label: "Tools", y0: 44, y1: 64 },
		{ lane: "agents", label: "Subagents", y0: 68, y1: 84 },
	];
}

/** The trunk's centre line on the strip map, through the model-call row. */
export function trunkY(lanes: LaneBox[]): number {
	const llm = lanes.find((lane) => lane.lane === "llm")!;
	return (llm.y0 + llm.y1) / 2;
}

/** The provider row's centre line, when the overview has one. */
export function providerY(lanes: LaneBox[]): number | undefined {
	const row = lanes.find((lane) => lane.lane === "provider");
	return row ? (row.y0 + row.y1) / 2 : undefined;
}

export const TOOL_ROWS = 3;

/**
 * Places every record, turn, and child session on the overview. Pure; the canvas only paints it. On a zoomed scale,
 * whatever lies outside its window is left out and whatever crosses an edge is cut there by the scale.
 */
export function layoutOverview(trace: SessionTrace, scale: Scale, lanes: LaneBox[], sessionId = trace.sessionId): OverviewItem[] {
	const box = Object.fromEntries(lanes.map((lane) => [lane.lane, lane])) as Record<OverviewLane, LaneBox>;
	const items: OverviewItem[] = [];
	const first = scale.axis.segments[0].start;
	const last = scale.axis.segments[scale.axis.segments.length - 1].end;
	const outside = (start: number, end: number) => end < first || start > last;
	// Turns without a start are not drawn; each drawn turn ends at the next drawn one at the latest.
	const timed = trace.turns.filter((turn): turn is typeof turn & { at: number } => turn.at !== undefined && Number.isFinite(turn.at));
	timed.forEach((turn, i) => {
		const next = timed[i + 1];
		const end = turn.at + Math.max(0, turn.durationMs || 0);
		if (outside(turn.at, next ? Math.min(end, next.at) : end)) return;
		const x0 = scale.x(turn.at);
		const x1 = Math.max(x0 + 1, Math.min(scale.x(end), next ? scale.x(next.at) : scale.width));
		items.push({
			key: `turn:${turn.index}`,
			lane: "turns",
			family: "turn",
			error: turn.toolErrors > 0,
			x0,
			x1,
			y0: box.turns.y0,
			y1: box.turns.y1,
			start: turn.at,
			end,
			turnIndex: turn.index,
		});
	});
	const rowEnds = new Array<number>(TOOL_ROWS).fill(Number.NEGATIVE_INFINITY);
	const toolRowHeight = (box.tools.y1 - box.tools.y0 - (TOOL_ROWS - 1)) / TOOL_ROWS;
	for (const record of trace.records) {
		const { start, end } = recordSpan(record);
		if (start === undefined || outside(start, end ?? start)) continue;
		const family = recordFamily(record);
		const error = recordIsError(record);
		const x0 = scale.x(start);
		// Every call is a bar as long as it ran, and at least 2 px so the shortest still shows.
		const x1 = Math.max(x0 + 2, scale.x(end ?? start));
		const key = recordKey(sessionId, record);
		if (record.kind === "llm") {
			const phases = box.provider ? llmPhases(record) : undefined;
			items.push({ key, lane: "llm", family, error, x0, x1, y0: box.llm.y0, y1: box.llm.y1, start, end, record, phases });
			// The provider's side of a timed call, from the request going out to the last token; same key, same record.
			if (phases && !outside(phases.request, phases.end)) {
				const px0 = scale.x(phases.request);
				const px1 = Math.max(px0 + 2, scale.x(phases.end));
				items.push({ key, lane: "provider", family, error, x0: px0, x1: px1, y0: box.provider.y0, y1: box.provider.y1, start, end, record, phases });
			}
		} else if (record.kind === "tool") {
			// Overlapping calls stack in up to three sub-rows.
			let row = rowEnds.findIndex((rowEnd) => rowEnd <= x0);
			if (row < 0) row = rowEnds.indexOf(Math.min(...rowEnds));
			rowEnds[row] = x1 + 0.5;
			const y0 = box.tools.y0 + row * (toolRowHeight + 1);
			items.push({ key, lane: "tools", family, error, x0, x1, y0, y1: y0 + toolRowHeight, start, end, record });
		} else {
			// Compactions and branch summaries are marks on the trunk, in the model-call row.
			items.push({ key, lane: "llm", family, error: false, x0: x0 - 1, x1: x0 + 2, y0: box.llm.y0, y1: box.llm.y1, start, end, record });
		}
	}
	for (const child of trace.children) {
		const span = childSpan(trace, child);
		if (span.start === undefined) continue;
		const { start } = span;
		const end = span.end ?? start;
		if (outside(start, end)) continue;
		const x0 = scale.x(start);
		const x1 = Math.max(x0 + 2, scale.x(end));
		items.push({
			key: `child:${child.sessionId}`,
			lane: "agents",
			family: "agent",
			error: false,
			x0,
			x1,
			y0: box.agents.y0,
			y1: box.agents.y1,
			start,
			end,
			childId: child.sessionId,
		});
	}
	return items;
}

/** Context size per model call, as points for the sparkline behind the LLM lane. */
export function contextSeries(trace: SessionTrace, scale: Scale): { x: number; value: number }[] {
	const points: { x: number; value: number }[] = [];
	for (const record of trace.records) {
		if (record.kind === "compaction") {
			const { start } = recordSpan(record);
			if (start !== undefined) points.push({ x: scale.x(start), value: 0 });
			continue;
		}
		if (record.kind !== "llm") continue;
		const { start, end } = recordSpan(record);
		const at = end ?? start;
		if (at === undefined) continue;
		points.push({ x: scale.x(at), value: contextTokens(record) });
	}
	return points;
}

/**
 * The item under a point: records over turn segments, the narrowest when several overlap, and
 * thin bars widened to `slop` pixels so they are easy to hover.
 */
export function hitTest(items: OverviewItem[], x: number, y: number, slop = 3): OverviewItem | undefined {
	let best: OverviewItem | undefined;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const item of items) {
		if (y < item.y0 - 1 || y > item.y1 + 1) continue;
		const pad = Math.max(0, slop - (item.x1 - item.x0) / 2);
		if (x < item.x0 - pad || x > item.x1 + pad) continue;
		// Prefer records to turns, then the closest center, then the narrowest.
		const center = (item.x0 + item.x1) / 2;
		const score = (item.lane === "turns" ? 1e6 : 0) + Math.abs(x - center) + (item.x1 - item.x0) * 0.01;
		if (score < bestScore) {
			best = item;
			bestScore = score;
		}
	}
	return best;
}
