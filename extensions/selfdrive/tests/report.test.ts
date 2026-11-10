// The self-driving report and ledger helpers, as pure functions.
import { describe, expect, it } from "vitest";
import { buildReport, costOf, countByStatus, elapsed, foldLedger, nextTaskId, type CostEntry, type Task } from "../report.ts";

const since = "2026-11-10T22:00:00.000Z";
const ended = "2026-11-11T05:42:00.000Z";

describe("buildReport", () => {
	it("sorts the ledger into sections and omits empty ones", () => {
		const tasks: Task[] = [
			{ id: "T1", title: "Fix stale hop limit in RELAY.md", status: "proposed", result: "verified Herder run 20261111-0102", herderRun: "20261111-0102" },
			{ id: "T2", title: "Repeat the flaky relay test 200 times", status: "done", result: "0 failures" },
			{ id: "T3", title: "Pick the side-answer threshold", status: "planned", needs: "choose 30 s or 60 s" },
			{ id: "T4", title: "Profile the footer", status: "failed", why: "slow redraws", result: "the profiler crashed" },
			{ id: "T5", title: "Rewrite the parser", status: "dropped", result: "a broad rewrite" },
			{ id: "T6", title: "Bump deps", status: "dropped", why: "needs network" },
			{ id: "T7", title: "Audit relay", status: "running" },
		];
		expect(buildReport({ tasks, since, ended, runs: 23, cost: 4.12, subagentCost: 2.8 })).toEqual([
			"🚗 Self-driving report · 7h42m · 7 tasks · 1 proposal · $4.12 (subagents $2.80)",
			"Needs you:",
			"  T1 Fix stale hop limit in RELAY.md · verified Herder run 20261111-0102 · /herder deliver 20261111-0102",
			"  T3 Pick the side-answer threshold · needs: choose 30 s or 60 s",
			"Done:",
			"  T2 Repeat the flaky relay test 200 times · 0 failures",
			"Failed:",
			"  T4 Profile the footer · the profiler crashed",
			"Not done: T5 Rewrite the parser (a broad rewrite), T6 Bump deps (needs network)",
			"Still open: T7 Audit relay (running)",
		]);
	});

	it("counts multiple proposals once each and keeps their delivery commands", () => {
		const tasks: Task[] = [
			{ id: "T1", title: "Fix relay retries", status: "proposed", result: "Bound retries after disconnect", herderRun: "20261111-010203-abcd" },
			{ id: "T2", title: "Clarify setup", status: "proposed", herderRun: "20261111-020304-abcd" },
			{ id: "T3", title: "Choose retry delay", status: "planned", needs: "pick a delay" },
		];
		const report = buildReport({ tasks, since, ended, runs: 1, cost: 2, subagentCost: 0.5 });
		expect(report).toEqual([
			"🚗 Self-driving report · 7h42m · 3 tasks · 2 proposals · $2.00 (subagents $0.50)",
			"Needs you:",
			"  T1 Fix relay retries · Bound retries after disconnect · /herder deliver 20261111-010203-abcd",
			"  T2 Clarify setup · /herder deliver 20261111-020304-abcd",
			"  T3 Choose retry delay · needs: pick a delay",
		]);
		expect(report.join("\n")).not.toContain("verified");
	});

	it.each([
		["done", "1 task"],
		["proposed", "1 task · 1 proposal"],
	] as const)("uses singular counts for one %s task and omits empty sections", (status, counts) => {
		const tasks: Task[] = [{ id: "T1", title: "Check relay", status }];
		const input = { tasks, since, ended, runs: 1, cost: 0, subagentCost: 0, doneReason: "no further candidates supported by the findings" };
		expect(buildReport(input)).toEqual([
			`🚗 Self-driving report · 7h42m · ${counts} · $0.00`,
			"Stopped: no further candidates supported by the findings",
			status === "proposed" ? "Needs you:" : "Done:",
			"  T1 Check relay",
		]);
		expect(buildReport({ ...input, runs: 200 })).toEqual(buildReport(input));
	});

	it("shows an empty ledger and its stop reason without filler rows", () => {
		expect(buildReport({ tasks: [], since, ended: "2026-11-10T22:05:00.000Z", runs: 1, cost: 0.014, subagentCost: 0, doneReason: "no open questions" }))
			.toEqual(["🚗 Self-driving report · 5m · 0 tasks · $0.01", "Stopped: no open questions"]);
		expect(buildReport({ tasks: [], since, now: Date.parse(since) + 60_000, runs: 0, cost: 0, subagentCost: 0 }))
			.toEqual(["🚗 Self-driving report · 1m · 0 tasks · $0.00"]);
	});

	it.each([
		"three continuations in a row did nothing",
		"three runs in a row failed",
		"three continuations in a row did not start",
	])("shows the recorded stop reason with a nonempty ledger: %s", (doneReason) => {
		const tasks: Task[] = [
			{ id: "T1", title: "Check relay", status: "done", result: "0 failures" },
			{ id: "T2", title: "Inspect retries", status: "running" },
		];
		expect(buildReport({ tasks, since, ended, runs: 3, cost: 1, subagentCost: 0, doneReason })).toEqual([
			"🚗 Self-driving report · 7h42m · 2 tasks · $1.00",
			`Stopped: ${doneReason}`,
			"Done:",
			"  T1 Check relay · 0 failures",
			"Still open: T2 Inspect retries (running)",
		]);
	});
});

describe("ledger", () => {
	it("folds updates per id in first-seen order and numbers new tasks", () => {
		const tasks = foldLedger([
			{ id: "T1", title: "a", status: "planned" },
			{ id: "T2", title: "b", status: "planned" },
			{ id: "T1", title: "a", status: "done", result: "ok" },
		]);
		expect(tasks).toEqual([{ id: "T1", title: "a", status: "done", result: "ok" }, { id: "T2", title: "b", status: "planned" }]);
		expect(nextTaskId(tasks)).toBe("T3");
		expect(nextTaskId([])).toBe("T1");
		expect(countByStatus(tasks)).toBe("1 planned, 1 done");
		expect(countByStatus([])).toBe("none");
	});

	it("formats durations", () => {
		expect(elapsed(13 * 60_000 + 59_000)).toBe("13m");
		expect(elapsed((2 * 60 + 13) * 60_000)).toBe("2h13m");
		expect(elapsed((7 * 60 + 2) * 60_000)).toBe("7h02m");
		expect(elapsed(-5)).toBe("0m");
	});

	it("sums assistant costs and subagent notifications", () => {
		const entries: CostEntry[] = [
			{ type: "message", message: { role: "assistant", usage: { cost: { total: 1.25 } } } },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "custom_message", customType: "subagent-notification", details: { totalCost: 0.5 } },
			{ type: "custom_message", customType: "subagent-notification", details: {} },
			{ type: "custom_message", customType: "other", details: { totalCost: 9 } },
		];
		expect(costOf(entries)).toEqual({ cost: 1.75, subagentCost: 0.5 });
	});
});
