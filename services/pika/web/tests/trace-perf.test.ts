import { describe, expect, it } from "vitest";
import type { SessionTrace, TraceChild, TraceRecord, TraceToolRecord, TraceTurn } from "../src/lib/types";
import {
	foldGaps,
	GAP_MS,
	layoutOverview,
	makeScale,
	MAX_AGENT_ROWS,
	overviewLanes,
	packChildren,
	traceIntervals,
	windowAxis,
	zoomWindow,
	type Axis,
	type AxisSegment,
	type Interval,
} from "../src/trace/axis";
import { childSpan, indexSpawningCalls, recordKey, recordSpan, spawningCall } from "../src/trace/kinds";
import { buildLedger, childrenOf, rowForSeq, turnForSeq, type LedgerRow } from "../src/trace/rows";

const BASE_TIME = 1_800_000_000_000;
const EMPTY_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function makeTurn(index: number, startSeq: number, endSeq: number, at?: number, durationMs = 1_000): TraceTurn {
	return {
		index,
		startSeq,
		endSeq,
		...(at !== undefined ? { at } : {}),
		durationMs,
		userText: `Turn ${index + 1}`,
		modelCalls: 1,
		toolCalls: 1,
		toolErrors: 0,
		cost: 0.01,
		tokens: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0 },
	};
}

function makeTool(
	seq: number,
	callId: string,
	name: string,
	extra: Partial<TraceToolRecord> = {},
): TraceToolRecord {
	return {
		kind: "tool",
		seq,
		callId,
		name,
		isError: false,
		...extra,
	};
}

function makeLlm(seq: number, start: number, end: number, extra: Partial<Extract<TraceRecord, { kind: "llm" }>> = {}): TraceRecord {
	return {
		kind: "llm",
		seq,
		start,
		end,
		input: 100,
		output: 20,
		cacheRead: 300,
		cacheWrite: 0,
		cost: 0.01,
		...extra,
	};
}

function makeChild(sessionId: string, extra: Partial<TraceChild> = {}): TraceChild {
	return {
		sessionId,
		kind: "subagent",
		entryCount: 1,
		tokens: EMPTY_TOKENS,
		cost: 0,
		title: `Child ${sessionId}`,
		...extra,
	};
}

/** Reference O(R) `spawningCall` matching the original linear `records.find(...)` semantics. */
function referenceSpawningCall(records: readonly TraceRecord[], child: TraceChild): TraceToolRecord | undefined {
	return records.find(
		(record): record is TraceToolRecord =>
			record.kind === "tool" && (record.callId === child.parentToolCallId || record.childSessionId === child.sessionId),
	);
}

/** Reference O(R) `childSpan` matching the original implementation. */
function referenceChildSpan(records: readonly TraceRecord[], child: TraceChild): { start: number | undefined; end: number | undefined } {
	let start = child.startedAt;
	let end = child.lastAt;
	if (start === undefined || end === undefined) {
		const call = referenceSpawningCall(records, child);
		const span = call ? recordSpan(call) : undefined;
		start ??= span?.start;
		end ??= span?.end;
	}
	return { start, end: end ?? start };
}

/** Reference O(C) `childrenOf` matching the original implementation. */
function referenceChildrenOf(childrenList: readonly TraceChild[], record: TraceToolRecord): TraceChild[] {
	const children = childrenList.filter((child) => child.parentToolCallId === record.callId);
	if (record.childSessionId && !children.some((child) => child.sessionId === record.childSessionId)) {
		children.unshift({
			sessionId: record.childSessionId,
			parentToolCallId: record.callId,
			kind: "subagent",
			entryCount: 0,
			tokens: EMPTY_TOKENS,
			cost: 0,
			title: "",
		});
	}
	return children.sort((a, b) => (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY));
}

/** Reference O(T) `turnForSeq` matching `turns.find(...)`. */
function referenceTurnForSeq(turns: readonly TraceTurn[], seq: number): TraceTurn | undefined {
	return turns.find((turn) => turn.startSeq <= seq && seq <= turn.endSeq);
}

/** Reference linear `scale.time` and `scale.timeAt` matching the original implementation. */
function referenceScaleLookups(axis: Axis, breakPx: number, pxPerMs: number) {
	const startX = (i: number) => axis.segments[i].offset * pxPerMs + i * breakPx;
	const endX = (i: number) => startX(i) + (axis.segments[i].end - axis.segments[i].start) * pxPerMs;
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
	const timeAt = (p: number): number => {
		const { segments } = axis;
		const clamped = Number.isFinite(p) ? Math.max(0, Math.min(axis.activeMs, p)) : 0;
		for (const segment of segments) {
			const length = segment.end - segment.start;
			if (clamped <= segment.offset + length) return segment.start + (clamped - segment.offset);
		}
		return segments[segments.length - 1].end;
	};
	return { time, timeAt };
}

/** Reference linear `windowAxis`. */
function referenceWindowAxis(axis: Axis, window: Interval): Axis {
	const segments: AxisSegment[] = [];
	const gaps: Interval[] = [];
	axis.segments.forEach((segment, i) => {
		const a = Math.max(window.start, segment.offset);
		const b = Math.min(window.end, segment.offset + (segment.end - segment.start));
		if (b <= a) return;
		if (segments.length) gaps.push(axis.gaps[i - 1]);
		segments.push({ start: segment.start + (a - segment.offset), end: segment.start + (b - segment.offset), offset: a - window.start });
	});
	if (segments.length === 0) return axis;
	return { origin: axis.origin, segments, gaps, activeMs: segments.reduce((total, segment) => total + segment.end - segment.start, 0) };
}

describe("trace indexing equivalence on edge cases", () => {
	it("matches linear spawningCall and childSpan across conflicting, duplicate, partial, and orphan IDs", () => {
		const records: TraceRecord[] = [
			makeLlm(1, BASE_TIME, BASE_TIME + 500),
			// Matches by childSessionId before the later record matching by parentToolCallId.
			makeTool(2, "call-other", "Agent", { start: BASE_TIME + 1_000, end: BASE_TIME + 2_000, childSessionId: "child-session-first" }),
			makeTool(3, "call-conflict-a", "Agent", { start: BASE_TIME + 3_000, end: BASE_TIME + 4_000 }),
			// Matches by callId before the later record matching by childSessionId.
			makeTool(4, "call-conflict-b", "Agent", { start: BASE_TIME + 5_000, end: BASE_TIME + 6_000 }),
			makeTool(5, "call-other-2", "Agent", { start: BASE_TIME + 7_000, end: BASE_TIME + 8_000, childSessionId: "child-call-first" }),
			// Duplicate callIds: first record must win.
			makeTool(6, "dup-call", "Agent", { start: BASE_TIME + 9_000, end: BASE_TIME + 9_500 }),
			makeTool(7, "dup-call", "Agent", { start: BASE_TIME + 10_000, end: BASE_TIME + 11_000 }),
			// Tool with durationMs only (no explicit end).
			makeTool(8, "call-dur", "Agent", { start: BASE_TIME + 12_000, durationMs: 750 }),
			// Untimed tool.
			makeTool(9, "call-untimed", "Agent", {}),
			{ kind: "compaction", seq: 10, at: BASE_TIME + 13_000 },
		];
		const children: TraceChild[] = [
			makeChild("child-session-first", { parentToolCallId: "call-conflict-a" }),
			makeChild("child-call-first", { parentToolCallId: "call-conflict-b" }),
			makeChild("child-dup", { parentToolCallId: "dup-call" }),
			makeChild("child-start-only", { parentToolCallId: "call-dur", startedAt: BASE_TIME + 12_100 }),
			makeChild("child-end-only", { parentToolCallId: "call-dur", lastAt: BASE_TIME + 12_900 }),
			makeChild("child-own-times", { parentToolCallId: "call-conflict-a", startedAt: BASE_TIME + 50, lastAt: BASE_TIME + 90 }),
			makeChild("child-untimed-call", { parentToolCallId: "call-untimed" }),
			makeChild("child-orphan-no-parent"),
			makeChild("child-orphan-missing", { parentToolCallId: "does-not-exist" }),
		];
		const trace: SessionTrace = { sessionId: "edge", startedAt: BASE_TIME, lastAt: BASE_TIME + 20_000, turns: [], records, children };
		const explicit = indexSpawningCalls(records);

		for (const child of children) {
			const expectedCall = referenceSpawningCall(records, child);
			const expectedSpan = referenceChildSpan(records, child);
			expect(spawningCall(trace, child)).toBe(expectedCall);
			expect(spawningCall(trace, child, explicit)).toBe(expectedCall);
			expect(childSpan(trace, child)).toEqual(expectedSpan);
			expect(childSpan(trace, child, explicit)).toEqual(expectedSpan);
		}
		// Conflicting match order: earlier record in trace.records wins regardless of which field matched.
		expect(spawningCall(trace, children[0])?.seq).toBe(2);
		expect(spawningCall(trace, children[1])?.seq).toBe(4);
		expect(spawningCall(trace, children[2])?.seq).toBe(6);
	});

	it("matches linear turnForSeq and recordsByTurn on overlapping, touching, unsorted, duplicate, and degenerate turns", () => {
		const turns: TraceTurn[] = [
			makeTurn(10, 20, 10, BASE_TIME, 100), // degenerate (startSeq > endSeq): never matches
			makeTurn(0, 5, 10, BASE_TIME + 1_000, 1_000), // touching next at 10, nested inside turn 1
			makeTurn(1, 1, 15, BASE_TIME + 2_000, 1_000), // surrounds turn 0, overlaps turn 2
			makeTurn(2, 10, 20, BASE_TIME + 3_000, 1_000), // touches turn 0 at 10, overlaps turn 1
			makeTurn(3, 10, 20, BASE_TIME + 4_000, 1_000), // duplicate of turn 2 (turn 2 must win)
			makeTurn(4, 25, 25, BASE_TIME + 5_000, 0), // single-point turn
			makeTurn(5, 30, 35, BASE_TIME + 6_000, 1_000), // later disjoint turn
			makeTurn(6, -5, -2, BASE_TIME + 7_000, 1_000), // unsorted negative turn
		];
		const testSeqs = [-10, -5, -4, -2, -1, 0, 1, 4, 4.5, 5, 7, 10, 12, 15, 15.5, 16, 20, 21, 25, 26, 30, 33, 35, 36, Number.NaN];
		// Out-of-order records without explicit `turn`, plus explicit and orphaned `turn` references.
		const records: TraceRecord[] = [
			makeLlm(33, BASE_TIME + 6_100, BASE_TIME + 6_200),
			makeLlm(10, BASE_TIME + 1_100, BASE_TIME + 1_200),
			makeLlm(3, BASE_TIME + 2_100, BASE_TIME + 2_200),
			makeLlm(18, BASE_TIME + 3_100, BASE_TIME + 3_200),
			makeLlm(25, BASE_TIME + 5_100, BASE_TIME + 5_200),
			makeLlm(22, BASE_TIME + 5_500, BASE_TIME + 5_600), // loose (in gap)
			makeLlm(-3, BASE_TIME + 7_100, BASE_TIME + 7_200),
			makeLlm(12, BASE_TIME + 2_500, BASE_TIME + 2_600, { turn: 999 }), // orphaned turn index -> loose
			makeLlm(14, BASE_TIME + 3_500, BASE_TIME + 3_600, { turn: 5 }), // explicit turn override
		];
		const trace: SessionTrace = { sessionId: "overlap", startedAt: BASE_TIME, lastAt: BASE_TIME + 10_000, turns, records, children: [] };

		for (const seq of testSeqs) {
			expect(turnForSeq(trace, seq)).toBe(referenceTurnForSeq(turns, seq));
		}

		// Verify buildLedger assigns every record to the exact same turn (or loose) as linear lookup.
		const rows = buildLedger({ trace, turnOverrides: new Map(), expanded: new Set(), childTrace: () => undefined });
		const actualTurnBySeq = new Map<number, number | undefined>();
		for (const row of rows) {
			if (row.type === "record") actualTurnBySeq.set(row.record.seq, row.turnIndex);
		}
		const validTurnIndexes = new Set(turns.map((t) => t.index));
		for (const record of records) {
			const expectedRaw = record.turn ?? referenceTurnForSeq(turns, record.seq)?.index;
			const expected = expectedRaw !== undefined && validTurnIndexes.has(expectedRaw) ? expectedRaw : undefined;
			expect(actualTurnBySeq.get(record.seq)).toBe(expected);
		}
	});

	it("handles disjoint turns with out-of-order record seqs and empty turn lists identically to linear find", () => {
		const turns = [
			makeTurn(0, 1, 5, BASE_TIME, 500),
			makeTurn(1, 10, 15, BASE_TIME + 1_000, 500),
			makeTurn(2, 20, 25, BASE_TIME + 2_000, 500),
		];
		// Deliberately jumps high (22) -> low (2) -> middle (12) -> high (24) to stress two-pointer + fallback invariant.
		const records: TraceRecord[] = [
			makeLlm(22, BASE_TIME + 2_100, BASE_TIME + 2_200),
			makeLlm(2, BASE_TIME + 100, BASE_TIME + 200),
			makeLlm(12, BASE_TIME + 1_100, BASE_TIME + 1_200),
			makeLlm(7, BASE_TIME + 700, BASE_TIME + 800), // loose
			makeLlm(24, BASE_TIME + 2_300, BASE_TIME + 2_400),
		];
		const trace: SessionTrace = { sessionId: "disjoint-ooo", startedAt: BASE_TIME, lastAt: BASE_TIME + 3_000, turns, records, children: [] };

		for (const seq of [-1, 0, 1, 2, 5, 6, 9, 10, 12, 15, 16, 20, 22, 25, 26, Number.NaN]) {
			expect(turnForSeq(trace, seq)).toBe(referenceTurnForSeq(turns, seq));
		}

		const rows = buildLedger({ trace, turnOverrides: new Map(), expanded: new Set(), childTrace: () => undefined });
		const bySeq = new Map<number, number | undefined>();
		for (const row of rows) if (row.type === "record") bySeq.set(row.record.seq, row.turnIndex);
		expect(bySeq.get(22)).toBe(2);
		expect(bySeq.get(2)).toBe(0);
		expect(bySeq.get(12)).toBe(1);
		expect(bySeq.get(7)).toBeUndefined();
		expect(bySeq.get(24)).toBe(2);

		// Empty turns and all-degenerate turns return undefined cleanly.
		const emptyTrace: SessionTrace = { sessionId: "empty", turns: [], records: [], children: [] };
		expect(turnForSeq(emptyTrace, 1)).toBeUndefined();
		expect(buildLedger({ trace: emptyTrace, turnOverrides: new Map(), expanded: new Set(), childTrace: () => undefined })).toEqual([]);
		const degenTrace: SessionTrace = { sessionId: "degen", turns: [makeTurn(0, 10, 5)], records: [makeLlm(7, BASE_TIME, BASE_TIME + 10)], children: [] };
		expect(turnForSeq(degenTrace, 7)).toBeUndefined();
	});

	it("matches linear childrenOf ordering, synthetic children, orphan children, and immutability", () => {
		const children: TraceChild[] = [
			makeChild("c-untimed-1", { parentToolCallId: "call-wf" }),
			makeChild("c-late", { parentToolCallId: "call-wf", startedAt: BASE_TIME + 5_000, lastAt: BASE_TIME + 6_000 }),
			makeChild("c-tie-1", { parentToolCallId: "call-wf", startedAt: BASE_TIME + 2_000, lastAt: BASE_TIME + 3_000 }),
			makeChild("c-tie-2", { parentToolCallId: "call-wf", startedAt: BASE_TIME + 2_000, lastAt: BASE_TIME + 4_000 }),
			makeChild("c-untimed-2", { parentToolCallId: "call-wf" }),
			makeChild("c-orphan"),
			makeChild("c-other", { parentToolCallId: "call-single", startedAt: BASE_TIME + 1_000, lastAt: BASE_TIME + 1_500 }),
		];
		const tools: TraceToolRecord[] = [
			makeTool(2, "call-wf", "SubagentWorkflow", { childSessionId: "c-synth" }),
			makeTool(3, "call-wf", "SubagentWorkflow", { childSessionId: "c-late" }), // already present
			makeTool(4, "call-single", "Agent", { childSessionId: "c-other" }),
			makeTool(5, "call-none", "Agent", {}),
			makeTool(6, "call-synth-only", "Agent", { childSessionId: "c-only" }),
		];
		const trace: SessionTrace = { sessionId: "kids", turns: [], records: tools, children };

		for (const tool of tools) {
			const actual = childrenOf(trace, tool);
			const expected = referenceChildrenOf(children, tool);
			expect(actual).toEqual(expected);
		}
		// Synthetic untimed child precedes existing untimed children while staying after timed ones.
		expect(childrenOf(trace, tools[0]).map((c) => c.sessionId)).toEqual(["c-tie-1", "c-tie-2", "c-late", "c-synth", "c-untimed-1", "c-untimed-2"]);
		// Mutating the returned array must not corrupt the cached bucket.
		const copy = childrenOf(trace, tools[0]);
		copy.reverse();
		expect(childrenOf(trace, tools[0]).map((c) => c.sessionId)).toEqual(["c-tie-1", "c-tie-2", "c-late", "c-synth", "c-untimed-1", "c-untimed-2"]);
	});

	it("matches linear scale time/timeAt and windowAxis across gaps, boundaries, and out-of-range inputs", () => {
		const intervals: Interval[] = [];
		for (let i = 0; i < 12; i++) {
			const start = BASE_TIME + i * (GAP_MS + 30_000);
			intervals.push({ start, end: start + 10_000 + (i % 3) * 5_000 });
		}
		const axis = foldGaps(intervals);
		expect(axis.segments.length).toBe(12);
		const scale = makeScale(axis, 1_000, { breakPx: 20 });
		const ref = referenceScaleLookups(axis, scale.breakPx, scale.pxPerMs);

		// Exact match against linear scans across every segment boundary, midpoint, gap, and out-of-range value.
		const samplePx: number[] = [-50, 0, scale.width, 10_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
		const samplePos: number[] = [-100, 0, axis.activeMs, axis.activeMs + 100, Number.NaN, Number.POSITIVE_INFINITY];
		for (const seg of axis.segments) {
			for (const t of [seg.start, seg.start + 1, (seg.start + seg.end) / 2, seg.end - 1, seg.end]) {
				const px = scale.x(t);
				samplePx.push(px);
				samplePos.push(scale.position(t));
				expect(scale.time(px)).toBeCloseTo(t, 4);
			}
		}
		for (const b of scale.breaks()) {
			samplePx.push(b.x0, b.x0 + 0.001, (b.x0 + b.x1) / 2, b.x1 - 0.001, b.x1);
		}
		for (const px of samplePx) expect(scale.time(px)).toBe(ref.time(px));
		for (const pos of samplePos) expect(scale.timeAt(pos)).toBe(ref.timeAt(pos));

		// windowAxis matches reference linear scan across arbitrary windows.
		const windows: Interval[] = [
			{ start: 0, end: axis.activeMs },
			{ start: 0, end: 5_000 },
			{ start: 12_345, end: 87_654 },
			{ start: axis.activeMs - 15_000, end: axis.activeMs },
			{ start: 50_000, end: 50_000 },
			{ start: 60_000, end: 40_000 },
			{ start: axis.activeMs + 10, end: axis.activeMs + 100 },
		];
		for (const win of windows) {
			expect(windowAxis(axis, win)).toEqual(referenceWindowAxis(axis, win));
		}
	});

	it("preserves rowForSeq precedence (exact > resultSeq > turn startSeq > nearest) while ignoring nested rows", () => {
		const turns = [makeTurn(0, 1, 5, BASE_TIME, 1_000), makeTurn(1, 10, 15, BASE_TIME + 2_000, 1_000)];
		const records: TraceRecord[] = [
			makeLlm(2, BASE_TIME + 100, BASE_TIME + 200, { turn: 0 }),
			makeTool(2, "c-agent", "Agent", { turn: 0, resultSeq: 4, start: BASE_TIME + 200, end: BASE_TIME + 800, childSessionId: "kid" }),
			makeLlm(11, BASE_TIME + 2_100, BASE_TIME + 2_500, { turn: 1 }),
		];
		const childTrace: SessionTrace = {
			sessionId: "kid",
			startedAt: BASE_TIME + 250,
			lastAt: BASE_TIME + 750,
			turns: [],
			// Child record shares seq 10 with parent turn 1's startSeq; depth > 0 must not shadow parent rows.
			records: [makeLlm(10, BASE_TIME + 300, BASE_TIME + 400)],
			children: [],
		};
		const trace: SessionTrace = {
			sessionId: "parent",
			startedAt: BASE_TIME,
			lastAt: BASE_TIME + 3_000,
			turns,
			records,
			children: [makeChild("kid", { parentToolCallId: "c-agent", startedAt: BASE_TIME + 250, lastAt: BASE_TIME + 750 })],
		};
		const agentKey = recordKey("parent", records[1]);
		const rows = buildLedger({
			trace,
			turnOverrides: new Map(),
			expanded: new Set([agentKey]),
			childTrace: (id) => (id === "kid" ? { status: "success", data: childTrace } : undefined),
		});

		expect(rows[rowForSeq(rows, 2)]).toMatchObject({ type: "record", record: { seq: 2, kind: "llm" } });
		expect(rows[rowForSeq(rows, 4)]).toMatchObject({ type: "record", record: { callId: "c-agent" } });
		expect(rows[rowForSeq(rows, 10)]).toMatchObject({ type: "turn", turn: { index: 1 } });
		expect(rows[rowForSeq(rows, 14)]).toMatchObject({ type: "record", record: { seq: 11 } });
		expect(rowForSeq(rows, 0)).toBe(-1);
	});
});

describe("large trace performance without quadratic blowup", () => {
	function buildLargeTrace(turnCount: number): SessionTrace {
		const turns: TraceTurn[] = [];
		const records: TraceRecord[] = [];
		const children: TraceChild[] = [];
		let seq = 1;
		let time = BASE_TIME;

		for (let t = 0; t < turnCount; t++) {
			// Insert an idle gap every 40 turns so the axis has many folded segments.
			if (t > 0 && t % 40 === 0) time += GAP_MS + 60_000;
			const startSeq = seq;
			const turnStart = time;
			seq++; // user prompt seq

			// Deliberately omit `record.turn` so `recordsByTurn` resolves every record against `turns`.
			const llmSeq = seq++;
			records.push(
				makeLlm(llmSeq, time, time + 300, {
					sentAt: time + 20,
					firstTokenAt: time + 120,
				}),
			);
			time += 300;

			for (let j = 0; j < 3; j++) {
				const callId = `t${t}_tool_${j}`;
				const resultSeq = seq++;
				records.push(
					makeTool(llmSeq, callId, j === 0 ? "read" : j === 1 ? "bash" : "edit", {
						resultSeq,
						start: time,
						end: time + 150,
						durationMs: 150,
						isError: j === 1 && t % 50 === 0,
						summary: j === 0 ? `src/file_${t}.ts` : j === 1 ? `npm test ${t}` : `src/out_${t}.ts`,
					}),
				);
				time += 150;
			}

			const agentCallId = `t${t}_agent`;
			const agentResultSeq = seq++;
			const childId = `child_${t}`;
			records.push(
				makeTool(llmSeq, agentCallId, "Agent", {
					resultSeq: agentResultSeq,
					start: time,
					end: time + 800,
					durationMs: 800,
					summary: `worker ${t}`,
					childSessionId: childId,
				}),
			);
			// Leave half the children without own timestamps so `childSpan` must resolve their spawning tool call.
			const hasTimes = t % 2 === 0;
			children.push(
				makeChild(childId, {
					parentToolCallId: agentCallId,
					agentType: "worker",
					...(hasTimes ? { startedAt: time + 10, lastAt: time + 790 } : {}),
				}),
			);
			time += 800;

			const endSeq = seq - 1;
			turns.push(makeTurn(t, startSeq, endSeq, turnStart, time - turnStart));
			time += 200;
		}

		return {
			sessionId: "large-session",
			startedAt: BASE_TIME,
			lastAt: time,
			turns,
			records,
			children,
		};
	}

	it("processes 1,200 turns, 6,000 records, and 1,200 subagent children across axis, kinds, and rows quickly and accurately", () => {
		const TURN_COUNT = 1_200;
		const trace = buildLargeTrace(TURN_COUNT);
		expect(trace.turns).toHaveLength(TURN_COUNT);
		expect(trace.records).toHaveLength(TURN_COUNT * 5);
		expect(trace.children).toHaveLength(TURN_COUNT);

		const allExpanded = new Map<number, boolean>(trace.turns.map((turn) => [turn.index, true]));

		const t0 = performance.now();

		// axis.ts: traceIntervals -> foldGaps -> makeScale -> packChildren -> layoutOverview -> windowAxis/zoomWindow
		const intervals = traceIntervals(trace);
		const axis = foldGaps(intervals);
		const scale = makeScale(axis, 1_200);
		const packing = packChildren(trace);
		const lanes = overviewLanes(false, true, packing.rows);
		const overview = layoutOverview(trace, scale, lanes);
		const zoomed = zoomWindow(axis, { start: 0, end: axis.activeMs }, 4, axis.activeMs * 0.5, 1_200, 600);
		const subAxis = windowAxis(axis, zoomed);
		for (let i = 0; i < 500; i++) {
			const px = (i / 499) * scale.width;
			scale.time(px);
			scale.timeAt((i / 499) * axis.activeMs);
		}

		// kinds.ts: spawningCall + childSpan for every child
		let resolvedCalls = 0;
		let resolvedSpans = 0;
		for (const child of trace.children) {
			const call = spawningCall(trace, child);
			if (call && call.callId === child.parentToolCallId) resolvedCalls++;
			const span = childSpan(trace, child);
			if (span.start !== undefined && span.end !== undefined && span.end >= span.start) resolvedSpans++;
		}

		// rows.ts: full expanded ledger + filtered ledger + childrenOf + turnForSeq + rowForSeq
		const ledger = buildLedger({
			trace,
			turnOverrides: allExpanded,
			expanded: new Set(),
			childTrace: () => undefined,
		});
		const filtered = buildLedger({
			trace,
			turnOverrides: new Map(),
			expanded: new Set(),
			childTrace: () => undefined,
			filter: { text: "npm test", families: ["shell"], errorsOnly: true },
		});
		let matchedChildren = 0;
		for (const record of trace.records) {
			if (record.kind === "tool" && record.name === "Agent") {
				const kids = childrenOf(trace, record);
				if (kids.length === 1 && kids[0].sessionId === record.childSessionId) matchedChildren++;
			}
		}
		let matchedTurns = 0;
		for (const record of trace.records) {
			const found = turnForSeq(trace, record.seq);
			if (found && found.startSeq <= record.seq && record.seq <= found.endSeq) matchedTurns++;
		}
		const targetTurn = trace.turns[TURN_COUNT - 1];
		const targetRowIdx = rowForSeq(ledger, targetTurn.startSeq);

		const elapsedMs = performance.now() - t0;

		// Accuracy assertions
		expect(axis.segments.length).toBeGreaterThan(20);
		expect(subAxis.activeMs).toBeGreaterThan(0);
		expect(packing.rowOf.size).toBe(TURN_COUNT);
		expect(packing.rows).toBeLessThanOrEqual(MAX_AGENT_ROWS);
		expect(overview.filter((item) => item.lane === "turns")).toHaveLength(TURN_COUNT);
		expect(overview.filter((item) => item.lane === "agents")).toHaveLength(TURN_COUNT);
		expect(overview.filter((item) => item.lane === "llm")).toHaveLength(TURN_COUNT);
		expect(overview.filter((item) => item.lane === "provider")).toHaveLength(TURN_COUNT);
		expect(overview.filter((item) => item.lane === "tools")).toHaveLength(TURN_COUNT * 4);
		expect(resolvedCalls).toBe(TURN_COUNT);
		expect(resolvedSpans).toBe(TURN_COUNT);
		// 1,200 turn headers + 6,000 records = 7,200 rows; zero loose records.
		expect(ledger).toHaveLength(TURN_COUNT * 6);
		expect(ledger.filter((row): row is Extract<LedgerRow, { type: "record" }> => row.type === "record" && row.turnIndex === undefined)).toHaveLength(0);
		// Every 50th turn had an error bash call -> 24 turns * (1 header + 1 record) = 48 rows.
		expect(filtered).toHaveLength((TURN_COUNT / 50) * 2);
		expect(matchedChildren).toBe(TURN_COUNT);
		expect(matchedTurns).toBe(trace.records.length);
		expect(ledger[targetRowIdx]).toMatchObject({ type: "turn", turn: { index: TURN_COUNT - 1 } });

		// Non-quadratic bound: indexed/two-pointer implementation completes in tens of ms.
		expect(elapsedMs).toBeLessThan(2_000);
	});

	it("handles 1,000 overlapping turns and 5,000 unturned records without quadratic blowup", () => {
		const TURN_COUNT = 1_000;
		const RECORD_COUNT = 5_000;
		const turns: TraceTurn[] = [];
		for (let i = 0; i < TURN_COUNT; i++) {
			// Overlapping windows: each turn spans 12 seqs, advancing by 5.
			turns.push(makeTurn(i, i * 5 + 1, i * 5 + 12, BASE_TIME + i * 100, 100));
		}
		const records: TraceRecord[] = [];
		for (let r = 0; r < RECORD_COUNT; r++) {
			records.push(makeLlm(r + 1, BASE_TIME + r * 20, BASE_TIME + r * 20 + 10));
		}
		const trace: SessionTrace = { sessionId: "overlap-large", startedAt: BASE_TIME, lastAt: BASE_TIME + RECORD_COUNT * 20, turns, records, children: [] };

		const t0 = performance.now();
		const rows = buildLedger({
			trace,
			turnOverrides: new Map(turns.map((t) => [t.index, true])),
			expanded: new Set(),
			childTrace: () => undefined,
		});
		let directMatches = 0;
		for (let r = 0; r < RECORD_COUNT; r++) {
			const seq = r + 1;
			// First turn i with i*5 + 1 <= seq <= i*5 + 12 is max(0, ceil((seq - 12) / 5)) when <= TURN_COUNT - 1.
			const expectedIndex = Math.max(0, Math.ceil((seq - 12) / 5));
			const found = turnForSeq(trace, seq);
			if (found?.index === expectedIndex) directMatches++;
		}
		const elapsedMs = performance.now() - t0;

		expect(rows).toHaveLength(TURN_COUNT + RECORD_COUNT);
		expect(directMatches).toBe(RECORD_COUNT);
		expect(elapsedMs).toBeLessThan(2_000);
	});
});
