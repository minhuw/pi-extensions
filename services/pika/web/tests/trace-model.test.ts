import { describe, expect, it } from "vitest";
import type { SessionTrace, TraceChild, TraceRecord, TraceToolRecord, TraceTurn } from "../src/lib/types";
import { normalizeTrace } from "../src/trace/data";
import { axisTicks, foldGaps, GAP_MS, hitTest, layoutOverview, makeScale, overviewLanes, traceIntervals } from "../src/trace/axis";
import { formatClock, formatElapsed, formatFineCost, formatGap, formatSpan, middleTruncate } from "../src/trace/format";
import { cacheHit, childSpan, recordBadge, recordFamily, recordIcon, recordKey, recordName, recordSummary, showsToolName, toolFamily, toolName } from "../src/trace/kinds";
import { currentStop, initialReplay, replayReducer, type ReplayState } from "../src/trace/replay";
import { buildLedger, defaultTurnExpanded, matchesFilter, NO_FILTER, rowForSeq, type LedgerInput } from "../src/trace/rows";
import { assistantMessage, entry, header, summary, toolCall, toolResultMessage, turn, userMessage } from "./support/fixtures";
import { traceOf } from "./support/server";

const T = 1_800_000_000_000;

function tool(seq: number, name: string, start: number, end: number, extra: Partial<TraceToolRecord> = {}): TraceToolRecord {
	return { kind: "tool", seq, turn: 0, callId: `c${seq}-${name}`, name, start, end, durationMs: end - start, isError: false, ...extra };
}

function llm(seq: number, start: number, end: number, extra: Partial<Extract<TraceRecord, { kind: "llm" }>> = {}): TraceRecord {
	return { kind: "llm", seq, turn: 0, start, end, input: 100, output: 20, cacheRead: 300, cacheWrite: 0, cost: 0.01, ...extra };
}

function traceTurn(index: number, startSeq: number, endSeq: number, at: number, durationMs: number): TraceTurn {
	return {
		index,
		startSeq,
		endSeq,
		at,
		durationMs,
		userText: `Prompt ${index + 1}`,
		modelCalls: 1,
		toolCalls: 1,
		toolErrors: 0,
		cost: 0.01,
		tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
	};
}

function trace(records: TraceRecord[], turns: TraceTurn[], extra: Partial<SessionTrace> = {}): SessionTrace {
	return { sessionId: "s", startedAt: turns[0]?.at ?? T, lastAt: T + 1e7, turns, records, children: [], ...extra };
}

describe("gap folding", () => {
	it("merges activity and folds idle gaps longer than two minutes", () => {
		const axis = foldGaps([
			{ start: T, end: T + 10_000 },
			{ start: T + 5_000, end: T + 30_000 },
			{ start: T + 30_000 + GAP_MS - 1, end: T + 30_000 + GAP_MS + 9_999 },
			{ start: T + 3_600_000, end: T + 3_620_000 },
		]);
		// The 119.999 s pause is not a gap; the hour-long one is.
		expect(axis.segments).toEqual([
			{ start: T, end: T + 30_000 + GAP_MS + 9_999, offset: 0 },
			{ start: T + 3_600_000, end: T + 3_620_000, offset: 30_000 + GAP_MS + 9_999 },
		]);
		expect(axis.gaps).toEqual([{ start: T + 30_000 + GAP_MS + 9_999, end: T + 3_600_000 }]);
		expect(axis.activeMs).toBe(30_000 + GAP_MS + 9_999 + 20_000);
		expect(axis.origin).toBe(T);
	});

	it("gives instants a minimum length without overlapping the next segment", () => {
		const axis = foldGaps([
			{ start: T, end: T },
			{ start: T + 500_000, end: T + 500_000 },
		]);
		expect(axis.segments.map((s) => s.end - s.start)).toEqual([1000, 1000]);
		expect(axis.gaps).toHaveLength(1);
		expect(foldGaps([]).activeMs).toBe(1000);
	});

	it("maps time to x with fixed-width breaks, and back", () => {
		const axis = foldGaps([
			{ start: T, end: T + 60_000 },
			{ start: T + 3_600_000, end: T + 3_660_000 },
		]);
		const scale = makeScale(axis, 1000, { breakPx: 40 });
		expect(scale.breakPx).toBe(40);
		// 960 px for 120 s of activity.
		expect(scale.pxPerMs).toBeCloseTo(960 / 120_000);
		expect(scale.x(T)).toBe(0);
		expect(scale.x(T + 60_000)).toBeCloseTo(480);
		expect(scale.x(T + 3_600_000)).toBeCloseTo(520);
		expect(scale.x(T + 3_660_000)).toBeCloseTo(1000);
		// Inside the gap: inside the break marker.
		const mid = scale.x((T + 60_000 + T + 3_600_000) / 2);
		expect(mid).toBeGreaterThan(480);
		expect(mid).toBeLessThan(520);
		expect(scale.breaks()).toEqual([{ x0: 480, x1: 520, gap: { start: T + 60_000, end: T + 3_600_000 } }]);
		for (const t of [T, T + 30_000, T + 3_630_000, T + 3_660_000]) expect(scale.time(scale.x(t))).toBeCloseTo(t, -1);
		// Positions skip the gap: the replay never waits through idle time.
		expect(scale.position(T + 3_630_000)).toBe(90_000);
		expect(scale.position(T + 1_000_000)).toBe(60_000);
		expect(scale.timeAt(90_000)).toBe(T + 3_630_000);
	});

	it("keeps breaks to a third of the width when there are many gaps", () => {
		const intervals = Array.from({ length: 20 }, (_, i) => ({ start: T + i * 1_000_000, end: T + i * 1_000_000 + 10_000 }));
		const scale = makeScale(foldGaps(intervals), 600);
		expect(scale.breaks()).toHaveLength(19);
		expect(scale.breakPx * 19).toBeLessThanOrEqual(600 * 0.33 + 1e-6);
		expect(scale.x(T + 19_000_000 + 10_000)).toBeCloseTo(600);
	});

	it("labels ticks with elapsed wall-clock time, gaps included", () => {
		const axis = foldGaps([
			{ start: T, end: T + 60_000 },
			{ start: T + 3_600_000, end: T + 3_660_000 },
		]);
		const ticks = axisTicks(makeScale(axis, 1000, { breakPx: 40 }), 72);
		expect(ticks[0]).toEqual({ x: 0, elapsed: 0 });
		// The second segment starts with a tick an hour in.
		expect(ticks.some((tick) => tick.elapsed === 3_600_000)).toBe(true);
		for (let i = 1; i < ticks.length; i++) expect(ticks[i].x - ticks[i - 1].x).toBeGreaterThanOrEqual(72 * 0.7);
	});
});

describe("overview layout and hit-testing", () => {
	const records: TraceRecord[] = [
		llm(2, T + 1000, T + 4000, { thinking: true }),
		tool(2, "bash", T + 4000, T + 9000, { isError: true }),
		tool(2, "read", T + 4000, T + 4100),
		{ kind: "compaction", seq: 5, turn: 0, at: T + 9500, tokensBefore: 1000 },
	];
	const t = trace(records, [traceTurn(0, 1, 6, T, 10_000)], {
		children: [
			{
				sessionId: "child",
				kind: "subagent",
				startedAt: T + 5000,
				lastAt: T + 8000,
				entryCount: 3,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
				title: "c",
			},
		],
	});
	const scale = makeScale(foldGaps(traceIntervals(t)), 1000);
	const lanes = overviewLanes(false);
	const items = layoutOverview(t, scale, lanes);

	it("puts each record in its lane and stacks overlapping tools", () => {
		const byKey = new Map(items.map((item) => [item.key, item]));
		expect(byKey.get("turn:0")?.lane).toBe("turns");
		expect(byKey.get("l:s:2")?.lane).toBe("llm");
		const bash = byKey.get("t:s:c2-bash")!;
		const read = byKey.get("t:s:c2-read")!;
		expect(bash.lane).toBe("tools");
		expect(bash.error).toBe(true);
		expect(bash.family).toBe("shell");
		// Both start together, so they sit on different sub-rows.
		expect(read.y0).not.toBe(bash.y0);
		expect(byKey.get("child:child")?.lane).toBe("agents");
		// Even a 100 ms call is at least 1.5 px wide.
		expect(read.x1 - read.x0).toBeGreaterThanOrEqual(1.5);
	});

	it("hits records before turns, and widens thin bars", () => {
		const read = items.find((item) => item.key === "t:s:c2-read")!;
		expect(hitTest(items, read.x0 + 1, (read.y0 + read.y1) / 2)?.key).toBe(read.key);
		// A one-pixel bar answers within three pixels of its center.
		const thin = { ...read, key: "thin", x0: 600, x1: 601 };
		expect(hitTest([thin], 598, (read.y0 + read.y1) / 2)?.key).toBe("thin");
		expect(hitTest([thin], 596, (read.y0 + read.y1) / 2)).toBeUndefined();
		const llmItem = items.find((item) => item.key === "l:s:2")!;
		expect(hitTest(items, (llmItem.x0 + llmItem.x1) / 2, (llmItem.y0 + llmItem.y1) / 2)?.key).toBe("l:s:2");
		const turnItem = items.find((item) => item.key === "turn:0")!;
		expect(hitTest(items, 900, (turnItem.y0 + turnItem.y1) / 2)?.key).toBe("turn:0");
		expect(hitTest(items, 500, 500)).toBeUndefined();
	});
});

describe("replay", () => {
	const play = (state: ReplayState) => replayReducer(state, { type: "play" });

	it("sweeps at the chosen speed and pauses at the end", () => {
		let state = initialReplay(60_000);
		expect(state).toEqual({ status: "stopped", speed: 10, position: 0, duration: 60_000 });
		state = replayReducer(state, { type: "tick", dt: 1000 });
		expect(state.position).toBe(0);
		state = play(state);
		state = replayReducer(state, { type: "tick", dt: 1000 });
		expect(state.position).toBe(10_000);
		state = replayReducer(state, { type: "speed", speed: 60 });
		state = replayReducer(state, { type: "tick", dt: 1000 });
		expect(state.position).toBe(60_000);
		expect(state.status).toBe("paused");
		// Playing at the end starts over.
		expect(play(state).position).toBe(0);
	});

	it("pauses, toggles, scrubs, and stops", () => {
		let state = play(initialReplay(10_000));
		state = replayReducer(state, { type: "toggle" });
		expect(state.status).toBe("paused");
		expect(replayReducer(state, { type: "tick", dt: 500 }).position).toBe(0);
		state = replayReducer(state, { type: "seek", position: 99_999 });
		expect(state.position).toBe(10_000);
		state = replayReducer(state, { type: "seek", position: -5 });
		expect(state.position).toBe(0);
		state = replayReducer(state, { type: "toggle" });
		expect(state.status).toBe("playing");
		state = replayReducer(state, { type: "stop" });
		expect(state).toMatchObject({ status: "stopped", position: 0 });
		// Scrubbing a stopped replay shows the playhead, paused.
		expect(replayReducer(state, { type: "seek", position: 400 })).toMatchObject({ status: "paused", position: 400 });
	});

	it("steps from stop to stop with reduced motion", () => {
		let state = play(initialReplay(1000));
		const stops = [0, 100, 450, 900];
		state = replayReducer(state, { type: "step", stops });
		expect(state.position).toBe(100);
		state = replayReducer(state, { type: "step", stops });
		expect(state.position).toBe(450);
		state = replayReducer(replayReducer(state, { type: "step", stops }), { type: "step", stops });
		expect(state).toMatchObject({ position: 1000, status: "paused" });
		expect(currentStop(stops, 449)).toBe(1);
		expect(currentStop(stops, 450)).toBe(2);
		expect(currentStop(stops, -1)).toBe(-1);
		expect(replayReducer(state, { type: "duration", duration: 500 }).position).toBe(500);
	});
});

describe("record kinds", () => {
	it("sorts tools into the palette's families with short badges", () => {
		const cases: [string, string, string][] = [
			["bash", "shell", "BASH"],
			["powershell", "shell", "PWSH"],
			["read", "read", "READ"],
			["grep", "read", "GREP"],
			["find", "read", "FIND"],
			["ls", "read", "LS"],
			["glob", "read", "GLOB"],
			["web_fetch", "read", "WEB"],
			["web_search", "read", "WEB"],
			["edit", "write", "EDIT"],
			["write", "write", "WRITE"],
			["apply_patch", "write", "PATCH"],
			["codemode", "write", "CODE"],
			["Agent", "agent", "AGENT"],
			["SubagentWorkflow", "agent", "FLOW"],
			["mcp__github__create_issue", "other", "MCP"],
			["mcp__exa__web_search_exa", "read", "WEB"],
			["todo_write", "other", "TOOL"],
		];
		for (const [name, family, badge] of cases) {
			const record = tool(1, name, T, T + 1);
			expect([name, recordFamily(record), recordBadge(record)]).toEqual([name, family, badge]);
		}
		expect(toolFamily("Bash")).toBe("shell");
		expect(recordBadge(llm(1, T, T + 1))).toBe("LLM");
		expect(recordIcon(tool(1, "grep", T, T))).toBe("search");
		expect(showsToolName(tool(1, "read", T, T))).toBe(false);
		expect(showsToolName(tool(1, "mcp__github__create_issue", T, T))).toBe(true);
		expect(cacheHit(llm(1, T, T))).toBeCloseTo(0.75);
		expect(recordKey("s", tool(4, "bash", T, T))).toBe("t:s:c4-bash");
		expect(recordSummary(llm(1, T, T, { error: "overloaded" }))).toBe("overloaded");
		expect(recordSummary(llm(1, T, T, { toolCalls: 2 }))).toBe("2 tool calls");
	});

	it("formats elapsed times, spans, gaps, and costs densely", () => {
		expect(formatElapsed(62_345)).toBe("+1:02.3");
		expect(formatElapsed(3_723_000)).toBe("+1:02:03");
		expect(formatElapsed(400)).toBe("+0:00.4");
		expect(formatClock(3_720_000)).toBe("1:02:00");
		expect(formatSpan(840)).toBe("840ms");
		expect(formatSpan(3_420)).toBe("3.4s");
		expect(formatSpan(65_000)).toBe("1m 05s");
		expect(formatSpan(undefined)).toBe("—");
		expect(formatGap(47 * 60_000)).toBe("47 min");
		expect(formatGap(150 * 60_000)).toBe("2.5 h");
		expect(formatFineCost(0.0123)).toBe("$0.012");
		expect(formatFineCost(0)).toBe("");
		expect(middleTruncate("/home/me/code/pi-extensions/services/pika/web", 20)).toBe("/home/me…es/pika/web");
		expect(middleTruncate("/short", 20)).toBe("/short");
	});
});

describe("ledger rows", () => {
	const turns = [traceTurn(0, 1, 5, T, 20_000), traceTurn(1, 6, 9, T + 60_000, 20_000)];
	const records: TraceRecord[] = [
		llm(2, T + 1000, T + 2000, { toolCalls: 2 }),
		tool(2, "bash", T + 2000, T + 5000, { isError: true, summary: "npm test" }),
		tool(2, "read", T + 2000, T + 2100, { summary: "src/api.ts" }),
		llm(4, T + 6000, T + 7000, { text: "Done." }),
		{ ...llm(7, T + 61_000, T + 62_000), turn: 1 },
		{ ...tool(7, "Agent", T + 62_000, T + 70_000, { summary: "worker: Fix tests", childSessionId: "child" }), turn: 1 },
	];
	const base: LedgerInput = { trace: trace(records, turns), turnOverrides: new Map(), expanded: new Set(), childTrace: () => undefined };

	it("groups records under turn headers and names the tools each model call made", () => {
		const rows = buildLedger(base);
		expect(rows.map((row) => (row.type === "turn" ? `#${row.turn.index}` : row.type === "record" ? row.key : row.type))).toEqual([
			"#0",
			"l:s:2",
			"t:s:c2-bash",
			"t:s:c2-read",
			"l:s:4",
			"#1",
			"l:s:7",
			"t:s:c7-Agent",
		]);
		const first = rows[1];
		expect(first.type === "record" && first.calls).toEqual(["bash", "read"]);
		const head = rows[0];
		expect(head.type === "turn" && head.window).toEqual({ start: T, end: T + 20_000 });
		const agent = rows[7];
		expect(agent.type === "record" && agent.children.map((child) => child.sessionId)).toEqual(["child"]);
	});

	it("collapses turns, and expands all of 40 or fewer but only the last three of more", () => {
		const rows = buildLedger({ ...base, turnOverrides: new Map([[0, false]]) });
		expect(rows.map((row) => row.key)).toEqual(["turn:s:0", "turn:s:1", "l:s:7", "t:s:c7-Agent"]);
		expect(defaultTurnExpanded(0, 40)).toBe(true);
		expect(defaultTurnExpanded(0, 41)).toBe(false);
		expect(defaultTurnExpanded(37, 41)).toBe(false);
		expect(defaultTurnExpanded(38, 41)).toBe(true);
		expect(defaultTurnExpanded(40, 41)).toBe(true);
	});

	it("filters by text, family, errors, and time range, showing matches even in collapsed turns", () => {
		const keys = (input: Partial<LedgerInput>) =>
			buildLedger({ ...base, turnOverrides: new Map([[0, false]]), ...input }).flatMap((row) => (row.type === "record" ? [row.key] : []));
		expect(keys({ filter: { ...NO_FILTER, text: "npm" } })).toEqual(["t:s:c2-bash"]);
		expect(keys({ filter: { ...NO_FILTER, text: "READ api" } })).toEqual(["t:s:c2-read"]);
		expect(keys({ filter: { ...NO_FILTER, families: ["llm"] } })).toEqual(["l:s:2", "l:s:4", "l:s:7"]);
		expect(keys({ filter: { ...NO_FILTER, errorsOnly: true } })).toEqual(["t:s:c2-bash"]);
		expect(keys({ range: { start: T + 60_000, end: T + 61_500 } })).toEqual(["l:s:7"]);
		// Turns without a match disappear.
		const rows = buildLedger({ ...base, filter: { ...NO_FILTER, text: "worker" } });
		expect(rows.map((row) => row.key)).toEqual(["turn:s:1", "t:s:c7-Agent"]);
		expect(matchesFilter(records[0], { ...NO_FILTER, families: ["shell"] })).toBe(false);
	});

	it("expands a subagent into its child's records, lazily, with a depth limit", () => {
		const key = "t:s:c7-Agent";
		const loading = buildLedger({ ...base, expanded: new Set([key]) });
		expect(loading.at(-1)).toMatchObject({ type: "status", status: "loading", sessionId: "child", depth: 1 });
		const child = trace([llm(1, T + 63_000, T + 64_000), tool(1, "read", T + 64_000, T + 64_100)], [], { sessionId: "child", startedAt: T + 62_000 });
		const loaded = buildLedger({ ...base, expanded: new Set([key]), childTrace: () => ({ status: "success", data: child }) });
		const nested = loaded.filter((row) => row.type === "record" && row.depth === 1);
		expect(nested.map((row) => row.key)).toEqual([`${key}>l:child:1`, `${key}>t:child:c1-read`]);
		expect(nested.every((row) => row.type === "record" && row.sessionId === "child")).toBe(true);
		// A cycle back to an ancestor stops.
		const cyclic = buildLedger({ ...base, expanded: new Set([key]), ancestors: ["s", "child"] });
		expect(cyclic.at(-1)).toMatchObject({ type: "status", status: "deep" });
		const failed = buildLedger({ ...base, expanded: new Set([key]), childTrace: () => ({ status: "error", error: new Error("x") }) });
		expect(failed.at(-1)).toMatchObject({ type: "status", status: "error" });
	});

	it("lists a workflow's children as their own expandable rows", () => {
		const children = ["w1", "w2"].map((id, i) => ({
			sessionId: id,
			parentToolCallId: "wf",
			agentType: "reviewer",
			description: `Review ${i}`,
			kind: "subagent" as const,
			startedAt: T + i,
			lastAt: T + 10 + i,
			entryCount: 4,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			cost: 0,
			title: "",
		}));
		const workflow = { ...tool(2, "SubagentWorkflow", T + 2000, T + 9000), callId: "wf" };
		const t = trace([llm(2, T + 1000, T + 2000), workflow], [turns[0]], { children });
		const rows = buildLedger({ ...base, trace: t, expanded: new Set(["t:s:wf", "t:s:wf>w2"]) });
		expect(rows.slice(3).map((row) => `${row.type}:${row.key}`)).toEqual(["child:t:s:wf>w1", "child:t:s:wf>w2", "status:t:s:wf>w2>status"]);
	});

	it("finds the row for a deep-linked seq", () => {
		const rows = buildLedger(base);
		expect(rows[rowForSeq(rows, 2)]?.key).toBe("l:s:2");
		// A tool result's seq selects its call.
		const withResult = buildLedger({ ...base, trace: trace([records[0], { ...(records[1] as TraceToolRecord), resultSeq: 3 }], [turns[0]]) });
		expect(withResult[rowForSeq(withResult, 3)]?.key).toBe("t:s:c2-bash");
		// A prompt selects its turn; anything else the nearest record before it.
		expect(rows[rowForSeq(rows, 6)]?.key).toBe("turn:s:1");
		expect(rows[rowForSeq(rows, 5)]?.key).toBe("l:s:4");
	});
});

describe("trace normalization", () => {
	it("fills what the server omits: tool names, turn starts, and session bounds", () => {
		const raw = {
			sessionId: "s",
			turns: [
				{ ...traceTurn(0, 1, 3, T, 5000), at: undefined },
				{ ...traceTurn(1, 4, 6, T, 1000), at: undefined },
			],
			records: [llm(2, T + 1000, T + 2000), { ...tool(2, "bash", T + 2000, T + 4000), name: undefined }],
		} as unknown as SessionTrace;
		const trace = normalizeTrace(raw);
		expect(trace.turns.map((t) => t.at)).toEqual([T + 1000, T + 6000]);
		// A tool without a name keeps none; the view calls it "tool".
		expect((trace.records[1] as TraceToolRecord).name).toBeUndefined();
		expect(toolName(trace.records[1] as TraceToolRecord)).toBe("tool");
		expect(recordName(trace.records[1])).toBe("tool");
		expect(recordBadge(trace.records[1])).toBe("TOOL");
		expect(trace.startedAt).toBe(T + 1000);
		expect(trace.lastAt).toBe(T + 7000);
		expect(trace.children).toEqual([]);
		// Known values are kept.
		const known = trace;
		expect(normalizeTrace(known)).toEqual(known);
	});
});

describe("missing times", () => {
	const child = (sessionId: string, extra: Partial<TraceChild> = {}): TraceChild => ({
		sessionId,
		kind: "subagent",
		entryCount: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		cost: 0,
		title: "",
		...extra,
	});

	it("places a just-spawned child, which has no times yet, on its Agent call, and skips one without a call", () => {
		const agent = tool(2, "Agent", T + 2000, T + 9000, { callId: "call_agent" });
		const running = { ...tool(4, "Agent", T + 9500, T + 9500, { callId: "call_running" }), end: undefined, durationMs: undefined };
		const value = trace([llm(2, T, T + 2000), agent, running], [traceTurn(0, 1, 5, T, 9000)], {
			children: [child("done", { parentToolCallId: "call_agent", startedAt: T + 2500, lastAt: T + 8000, entryCount: 4 }), child("new", { parentToolCallId: "call_running" }), child("orphan")],
		});
		expect(childSpan(value, value.children[0])).toEqual({ start: T + 2500, end: T + 8000 });
		expect(childSpan(value, value.children[1])).toEqual({ start: T + 9500, end: T + 9500 });
		expect(childSpan(value, value.children[2])).toEqual({ start: undefined, end: undefined });
		const scale = makeScale(foldGaps(traceIntervals(value)), 1000);
		const items = layoutOverview(value, scale, overviewLanes(false));
		const agents = items.filter((item) => item.lane === "agents");
		expect(agents.map((item) => item.childId)).toEqual(["done", "new"]);
		for (const item of items) for (const n of [item.x0, item.x1, item.y0, item.y1]) expect(Number.isFinite(n)).toBe(true);
	});

	it("draws no turn without a start and keeps a session without any time drawable", () => {
		const value: SessionTrace = { sessionId: "s", turns: [{ ...traceTurn(0, 1, 2, T, 0), at: undefined }], records: [{ ...tool(1, "bash", T, T), start: undefined, end: undefined, durationMs: undefined }], children: [child("c")] };
		const normalized = normalizeTrace(value);
		expect(normalized.startedAt).toBeUndefined();
		expect(normalized.lastAt).toBeUndefined();
		expect(normalized.turns[0].at).toBeUndefined();
		const scale = makeScale(foldGaps(traceIntervals(normalized)), 800);
		expect(layoutOverview(normalized, scale, overviewLanes(true))).toEqual([]);
		// The ledger still lists the record, without a waterfall window.
		const rows = buildLedger({ trace: normalized, turnOverrides: new Map(), expanded: new Set(), childTrace: () => undefined });
		expect(rows.map((row) => row.type)).toEqual(["turn", "record"]);
		expect(rows[0].type === "turn" && rows[0].window).toBeUndefined();
	});

	it("maps an unknown time to the axis start instead of throwing", () => {
		const scale = makeScale(foldGaps([{ start: T, end: T + 1000 }, { start: T + 10 * GAP_MS, end: T + 10 * GAP_MS + 1000 }]), 600);
		for (const bad of [Number.NaN, undefined as unknown as number, Number.POSITIVE_INFINITY]) {
			expect(scale.x(bad)).toBe(0);
			expect(scale.position(bad)).toBe(0);
			expect(scale.timeAt(bad)).toBe(T);
		}
	});

	it("sorts children without a start last, and gives a call's unlisted child no invented times", () => {
		const agent = tool(2, "Agent", T, T + 100, { callId: "call", childSessionId: "unlisted" });
		const value = trace([agent], [traceTurn(0, 1, 3, T, 100)], {
			children: [child("late", { parentToolCallId: "call" }), child("early", { parentToolCallId: "call", startedAt: T + 10, lastAt: T + 50, entryCount: 2 })],
		});
		const rows = buildLedger({ trace: value, turnOverrides: new Map(), expanded: new Set(["t:s:call"]), childTrace: () => undefined });
		expect(rows.flatMap((row) => (row.type === "child" ? [[row.child.sessionId, row.child.startedAt]] : []))).toEqual([
			["early", T + 10],
			["unlisted", undefined],
			["late", undefined],
		]);
	});

	it("normalizes and lays out 200,000 records without spreading them into arguments", () => {
		const records: TraceRecord[] = [];
		for (let i = 0; i < 200_000; i++) records.push(llm(i, T + i * 10, T + i * 10 + 5));
		const normalized = normalizeTrace({ sessionId: "big", turns: [], records, children: [] });
		expect(normalized.startedAt).toBe(T);
		expect(normalized.lastAt).toBe(T + 199_999 * 10 + 5);
		expect(() => layoutOverview(normalized, makeScale(foldGaps(traceIntervals(normalized)), 1200), overviewLanes(false))).not.toThrow();
	});
});

describe("the fake server's trace", () => {
	it("derives records, summaries, timings, and children from entries", () => {
		const entries = [
			entry(0, header("s1")),
			entry(1, userMessage("Go")),
			entry(
				2,
				assistantMessage(
					[
						{ type: "thinking", thinking: "hm" },
						toolCall("a", "bash", { command: "npm test\nnpm run build" }),
						toolCall("b", "read", { path: "src/a.ts", offset: 10, limit: 5 }),
						toolCall("c", "grep", { pattern: "foo", path: "src" }),
						toolCall("d", "Agent", { subagent_type: "worker", description: "Fix", prompt: "…" }),
						toolCall("e", "mcp__gh__issue", { title: "Bug\u0007 here", n: 1 }),
					],
					2000,
					{ durationMs: 1500 },
				),
			),
			entry(3, toolResultMessage("a", "bash", "boom", { isError: true, at: 5000 })),
			entry(4, toolResultMessage("b", "read", "x", { at: 2100 })),
		];
		const detail = summary("s1", { children: [{ ...summary("kid", { parentSessionId: "s1", link: { kind: "subagent", agentType: "worker" } }), parentToolCallId: "d" }] });
		const t = traceOf({ detail, entries, turns: [turn(0, 1, 4)] });
		const [model, ...tools] = t.records;
		expect(model).toMatchObject({ kind: "llm", seq: 2, turn: 0, thinking: true, toolCalls: 5, input: 1200, cacheRead: 8000 });
		expect(model.kind === "llm" && model.end! - model.start!).toBe(1500);
		expect(tools.map((record) => record.kind === "tool" && record.summary)).toEqual(["npm test", "src/a.ts:10-14", "foo in src", "worker: Fix", "Bug  here"]);
		expect(tools[0]).toMatchObject({ resultSeq: 3, isError: true, outputSize: 4 });
		expect(tools[2]).not.toHaveProperty("end");
		expect(tools[3]).toMatchObject({ childSessionId: "kid" });
		expect(t.children).toMatchObject([{ sessionId: "kid", parentToolCallId: "d", agentType: "worker", kind: "subagent" }]);
	});
});
