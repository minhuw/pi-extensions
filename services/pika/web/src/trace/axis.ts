// The overview's time axis: idle gaps folded into fixed-width breaks, a pixel scale over the
// remaining active time, ticks, and the layout and hit-testing of the drawn records.
import type { SessionTrace, TraceRecord } from "../lib/types";
import { childSpan, contextTokens, recordFamily, recordIsError, recordKey, recordSpan, type Family } from "./kinds";

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

const TICK_STEPS = [
	1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000,
	10_800_000, 21_600_000, 43_200_000, 86_400_000,
];

export interface Tick {
	x: number;
	/** Wall-clock time since the session started, gaps included. */
	elapsed: number;
}

/** Ticks at a round elapsed-time step at least `minSpacing` pixels apart; each segment starts with a tick. */
export function axisTicks(scale: Scale, minSpacing = 72): Tick[] {
	const { axis } = scale;
	const step = TICK_STEPS.find((candidate) => candidate * scale.pxPerMs >= minSpacing) ?? TICK_STEPS[TICK_STEPS.length - 1];
	const ticks: Tick[] = [];
	let lastX = Number.NEGATIVE_INFINITY;
	for (const segment of axis.segments) {
		const first = segment.start - axis.origin;
		const candidates = [first];
		for (let e = Math.ceil(first / step) * step; e <= segment.end - axis.origin; e += step) if (e !== first) candidates.push(e);
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

export type OverviewLane = "turns" | "llm" | "tools" | "agents";

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
	turnIndex?: number;
	childId?: string;
}

export interface LaneBox {
	lane: OverviewLane;
	label: string;
	y0: number;
	y1: number;
}

/** Vertical layout of the overview's lanes, in CSS pixels from the canvas top. */
export function overviewLanes(compact: boolean): LaneBox[] {
	if (compact) {
		return [
			{ lane: "turns", label: "Turns", y0: 2, y1: 14 },
			{ lane: "llm", label: "LLM", y0: 18, y1: 32 },
			{ lane: "tools", label: "Tools", y0: 36, y1: 50 },
			{ lane: "agents", label: "Agents", y0: 54, y1: 62 },
		];
	}
	return [
		{ lane: "turns", label: "Turns", y0: 4, y1: 22 },
		{ lane: "llm", label: "LLM", y0: 28, y1: 50 },
		{ lane: "tools", label: "Tools", y0: 56, y1: 80 },
		{ lane: "agents", label: "Agents", y0: 86, y1: 98 },
	];
}

export const TOOL_ROWS = 3;

/** Places every record, turn, and child session on the overview. Pure; the canvas only paints it. */
export function layoutOverview(trace: SessionTrace, scale: Scale, lanes: LaneBox[], sessionId = trace.sessionId): OverviewItem[] {
	const box = Object.fromEntries(lanes.map((lane) => [lane.lane, lane])) as Record<OverviewLane, LaneBox>;
	const items: OverviewItem[] = [];
	// Turns without a start are not drawn; each drawn turn ends at the next drawn one at the latest.
	const timed = trace.turns.filter((turn): turn is typeof turn & { at: number } => turn.at !== undefined && Number.isFinite(turn.at));
	timed.forEach((turn, i) => {
		const next = timed[i + 1];
		const end = turn.at + Math.max(0, turn.durationMs || 0);
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
		if (start === undefined) continue;
		const family = recordFamily(record);
		const error = recordIsError(record);
		const x0 = scale.x(start);
		const x1 = Math.max(x0 + 1.5, scale.x(end ?? start));
		const key = recordKey(sessionId, record);
		if (record.kind === "llm") {
			items.push({ key, lane: "llm", family, error, x0, x1, y0: box.llm.y0 + 4, y1: box.llm.y1 - 4, start, end, record });
		} else if (record.kind === "tool") {
			// Overlapping calls stack in up to three sub-rows.
			let row = rowEnds.findIndex((rowEnd) => rowEnd <= x0);
			if (row < 0) row = rowEnds.indexOf(Math.min(...rowEnds));
			rowEnds[row] = x1 + 0.5;
			const y0 = box.tools.y0 + row * (toolRowHeight + 1);
			items.push({ key, lane: "tools", family, error, x0, x1, y0, y1: y0 + toolRowHeight, start, end, record });
		} else {
			items.push({ key, lane: "llm", family, error: false, x0: x0 - 1, x1: x0 + 2, y0: box.turns.y0, y1: box.agents.y1, start, end, record });
		}
	}
	for (const child of trace.children) {
		const span = childSpan(trace, child);
		if (span.start === undefined) continue;
		const { start } = span;
		const end = span.end ?? start;
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
