import { describe, expect, it } from "vitest";
import type { SessionTrace, TraceChild, TraceRecord } from "../src/lib/types";
import { betweenCalls, buildBreakdown, type Breakdown } from "../src/trace/breakdown";

const T = 1_000_000;

function llm(seq: number, start: number, end: number, model = "claude-opus-5-5"): TraceRecord {
	return { kind: "llm", seq, turn: 0, start: T + start, end: T + end, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function tool(seq: number, name: string, start: number, end: number | undefined, extra: Partial<Extract<TraceRecord, { kind: "tool" }>> = {}): TraceRecord {
	return { kind: "tool", seq, turn: 0, callId: `c${seq}`, name, start: T + start, ...(end === undefined ? {} : { end: T + end }), isError: false, ...extra };
}

function child(sessionId: string, parentToolCallId: string | undefined, extra: Partial<TraceChild> = {}): TraceChild {
	return {
		sessionId,
		...(parentToolCallId ? { parentToolCallId } : {}),
		kind: "subagent",
		entryCount: 4,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		cost: 0,
		title: sessionId,
		...extra,
	};
}

/** A one-turn session from `at` for `duration` ms. */
function session(sessionId: string, records: TraceRecord[], at: number, duration: number, children: TraceChild[] = []): SessionTrace {
	const turn = { index: 0, startSeq: 1, endSeq: 99, at: T + at, durationMs: duration, userText: "", modelCalls: 0, toolCalls: 0, toolErrors: 0, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	return { sessionId, startedAt: T + at, lastAt: T + at + duration, turns: [turn], records, children };
}

/** Each kind's time, and each kind's lines as `name:count:ms`. */
function shape(breakdown: Breakdown) {
	return Object.fromEntries(breakdown.families.map((family) => [family.family, [family.ms, ...family.items.map((item) => `${item.name}:${item.count}:${item.ms}`)]]));
}

// A model call, a shell call, a worker subagent, and a model call on another model, in a 17 s turn: 1 s between calls.
const worker = child("c1", "c3", { agentType: "worker", startedAt: T + 5000, lastAt: T + 15_000 });
const root = session("root", [llm(1, 0, 2000), tool(2, "bash", 2000, 5000), tool(3, "Agent", 5000, 15_000), llm(4, 15_000, 16_000, "gpt-6-astra")], 0, 17_000, [worker]);
// The worker: a DeepSeek call and a read in its 10 s run, so 6.1 s between them.
const workerTrace = session("c1", [llm(1, 5100, 8000, "deepseek-flash"), tool(2, "read", 8000, 9000)], 5000, 10_000);

describe("time breakdown", () => {
	it("counts a subagent as one Subagent stop by its type, for as long as its call ran", () => {
		const breakdown = buildBreakdown({ trace: root, mode: "one", traces: new Map([["c1", workerTrace]]) });
		expect(shape(breakdown)).toEqual({
			llm: [3000, "claude-opus-5-5:1:2000", "gpt-6-astra:1:1000"],
			shell: [3000, "bash:1:3000"],
			agent: [10_000, "worker:1:10000"],
		});
		expect(breakdown.between).toBe(1000);
		// The kinds and the time between calls add up to the turn.
		expect(breakdown.ms).toBe(17_000);
		expect(breakdown.count).toBe(4);
		expect(breakdown.sessions).toBe(1);
	});

	it("splits a subagent into its own calls' kinds, with the time between them", () => {
		const breakdown = buildBreakdown({ trace: root, mode: "split", traces: new Map([["c1", workerTrace]]) });
		expect(shape(breakdown)).toEqual({
			llm: [5900, "deepseek-flash:1:2900", "claude-opus-5-5:1:2000", "gpt-6-astra:1:1000"],
			shell: [3000, "bash:1:3000"],
			read: [1000, "read:1:1000"],
		});
		expect(breakdown.between).toBe(1000 + 6100);
		expect(breakdown.ms).toBe(17_000);
		expect(breakdown.sessions).toBe(2);
	});

	it("keeps a subagent whose trace has not loaded as one Subagent stop", () => {
		const breakdown = buildBreakdown({ trace: root, mode: "split", traces: new Map() });
		expect(shape(breakdown).agent).toEqual([10_000, "worker:1:10000"]);
		expect(breakdown.sessions).toBe(1);
	});

	it("splits a workflow only once every agent it ran has loaded, and names it by its tool until then", () => {
		const a = child("w1", "c1", { agentType: "reviewer" });
		const b = child("w2", "c1", { agentType: "reviewer" });
		const parent = session("p", [tool(1, "SubagentWorkflow", 0, 4000)], 0, 4000, [a, b]);
		const w1 = session("w1", [llm(1, 100, 1100)], 100, 1000);
		const w2 = session("w2", [llm(1, 200, 3200)], 200, 3000);
		expect(shape(buildBreakdown({ trace: parent, mode: "split", traces: new Map([["w1", w1]]) }))).toEqual({ agent: [4000, "SubagentWorkflow:1:4000"] });
		// Parallel agents each count in full.
		const both = buildBreakdown({ trace: parent, mode: "split", traces: new Map([["w1", w1], ["w2", w2]]) });
		expect(shape(both)).toEqual({ llm: [4000, "claude-opus-5-5:2:4000"] });
		expect(both.sessions).toBe(3);
	});

	it("goes all the way down, and counts each session once", () => {
		const nested = child("n1", "c2", { agentType: "recon" });
		const middle = session("c1", [llm(1, 5100, 6000), tool(2, "Agent", 6000, 9000)], 5000, 10_000, [nested]);
		const leaf = session("n1", [tool(1, "grep", 6100, 8100)], 6000, 3000);
		const breakdown = buildBreakdown({ trace: root, mode: "split", traces: new Map([["c1", middle], ["n1", leaf]]) });
		expect(shape(breakdown).read).toEqual([2000, "grep:1:2000"]);
		expect(shape(breakdown).agent).toBeUndefined();
		expect(breakdown.sessions).toBe(3);
		// A cycle back to the root does not count it again.
		const cyclic = session("n1", [tool(1, "Agent", 6100, 8100)], 6000, 3000, [child("root", "c1")]);
		expect(buildBreakdown({ trace: root, mode: "split", traces: new Map([["c1", middle], ["n1", cyclic], ["root", root]]) }).sessions).toBe(3);
	});

	it("counts subagents no call ran, such as Herder steps, for as long as they ran", () => {
		const step = child("s1", undefined, { kind: "herder-step", agentType: "implementer", startedAt: T + 1000, lastAt: T + 6000 });
		const orchestrator = session("o", [llm(1, 0, 500)], 0, 8000, [step]);
		expect(shape(buildBreakdown({ trace: orchestrator, mode: "one" })).agent).toEqual([5000, "Herder step:1:5000"]);
		const stepTrace = session("s1", [tool(1, "edit", 1000, 3000)], 1000, 5000);
		const split = buildBreakdown({ trace: orchestrator, mode: "split", traces: new Map([["s1", stepTrace]]) });
		expect(shape(split)).toEqual({ llm: [500, "claude-opus-5-5:1:500"], write: [2000, "edit:1:2000"] });
	});

	it("names MCP tools by server, and counts running tools up to now and untimed model calls as time between calls", () => {
		const live = session(
			"l",
			[tool(1, "mcp__github__create_issue", 0, 1000), llm(2, 1000, 1000), tool(3, "bash", 2000, undefined)],
			0,
			3000,
		);
		const breakdown = buildBreakdown({ trace: live, mode: "one", now: T + 5000 });
		expect(breakdown.families.find((family) => family.family === "other")?.items[0].label).toBe("github · create_issue");
		expect(shape(breakdown).shell).toEqual([3000, "bash:1:3000"]);
		expect(shape(breakdown).llm).toEqual([0, "claude-opus-5-5:1:0"]);
		expect(breakdown.untimed).toBe(1);
		// Without `now`, a running tool counts up to the session's last entry.
		expect(shape(buildBreakdown({ trace: live, mode: "one" })).shell).toEqual([1000, "bash:1:1000"]);
	});

	it("counts only what ran in a selected range, and the part of a call that crosses its edge", () => {
		const window = { start: T + 4000, end: T + 10_000 };
		const traces = new Map([["c1", workerTrace]]);
		const grouped = buildBreakdown({ trace: root, mode: "one", traces, window });
		// The first model call ended before the range and the last one started after it.
		expect(shape(grouped)).toEqual({ shell: [1000, "bash:1:1000"], agent: [5000, "worker:1:5000"] });
		expect(grouped.between).toBe(0);
		expect(grouped.count).toBe(2);
		expect(grouped.ms).toBe(6000);

		// Split, the worker's calls and the time between them are clipped to the range too: still the range's 6 s.
		const split = buildBreakdown({ trace: root, mode: "split", traces, window });
		expect(shape(split)).toEqual({ llm: [2900, "deepseek-flash:1:2900"], shell: [1000, "bash:1:1000"], read: [1000, "read:1:1000"] });
		expect(split.between).toBe(1100);
		expect(split.ms).toBe(6000);
		expect(split.sessions).toBe(2);
	});

	it("opens no subagent that ran outside the range, and counts nothing in a range without calls", () => {
		const early = buildBreakdown({ trace: root, mode: "split", traces: new Map([["c1", workerTrace]]), window: { start: T, end: T + 1000 } });
		expect(shape(early)).toEqual({ llm: [1000, "claude-opus-5-5:1:1000"] });
		expect(early.sessions).toBe(1);

		const after = buildBreakdown({ trace: root, mode: "one", window: { start: T + 20_000, end: T + 30_000 } });
		expect(after.families).toEqual([]);
		expect([after.count, after.between, after.ms]).toEqual([0, 0, 0]);

		// A background subagent counts the part of its run inside the range.
		const step = child("s1", undefined, { kind: "herder-step", startedAt: T + 1000, lastAt: T + 6000 });
		const orchestrator = session("o", [], 0, 8000, [step]);
		expect(shape(buildBreakdown({ trace: orchestrator, mode: "one", window: { start: T + 5000, end: T + 8000 } })).agent).toEqual([1000, "Herder step:1:1000"]);
	});

	it("counts time between calls once when calls overlap, and only inside turns", () => {
		const parallel = session("p", [tool(1, "read", 0, 1000), tool(2, "read", 500, 1500)], 0, 2000);
		expect(betweenCalls(parallel)).toBe(500);
		const breakdown = buildBreakdown({ trace: parallel, mode: "one" });
		expect(shape(breakdown).read).toEqual([2000, "read:2:2000"]);
		expect(breakdown.ms).toBe(2500);
		// Time after the turn, such as the owner reading the answer, is not the session's work.
		expect(betweenCalls({ ...parallel, lastAt: T + 60_000 })).toBe(500);
	});
});
