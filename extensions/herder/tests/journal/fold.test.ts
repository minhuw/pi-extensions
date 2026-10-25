import { describe, expect, it } from "vitest";
import { findCompletion, findIntegration, fold } from "../../src/journal/fold.ts";
import type { JournalEvent, JournalInput } from "../../src/types.ts";
import { journalOf, sampleJournal, started } from "./sample.ts";

describe("fold", () => {
	it("derives run, goal, launches, steps, integrations, and tasks", () => {
		const state = fold(sampleJournal());
		expect(state).toMatchObject({ runId: "20260101-000000-abcd", title: "Add | feature", base: "b0", repo: "/repo", runtime: "0.1.0", status: "approved", planSha256: "p1", integrationHead: "h1", liveAgentStarts: 3 });
		expect(state.goal).toMatchObject({ sha256: "g1", checks: [{ id: "unit" }] });
		expect(state.launches.get(1)).toMatchObject({ launched: { head: "b0" }, settled: { status: "completed", new: 3 } });
		expect(state.steps.get("impl1-0")).toMatchObject({ status: "ok", started: { attempt: 1 }, completed: { commit: "c1" }, task: "T1" });
		expect(state.steps.get("impl2-0")).toMatchObject({ status: "gate_failed", started: { attempt: 2 }, completed: { commit: "c2" } });
		expect(state.steps.get("impl2-0")?.failed).toBeUndefined();
		expect(state.steps.get("rev-0")?.status).toBe("running");
		expect(findCompletion(state, "impl1-0", "f1")?.commit).toBe("c1");
		expect(findCompletion(state, "impl1-0", "other")).toBeUndefined();
		expect(findIntegration(state, "i1")?.head).toBe("h1");
		expect(state.integrations.map((event) => event.key)).toEqual(["i1"]);
		expect(state.integrationFailures.map((event) => event.reason)).toEqual(["conflict"]);
		expect(state.checks).toHaveLength(1);
		expect(state.verification?.verdict).toBe("not_met");
		expect(state.decisions.map((event) => event.answer)).toEqual(["yes"]);
		expect([...state.tasks.values()].map(({ id, status, lastStep, integratedCommit }) => ({ id, status, lastStep, integratedCommit }))).toEqual([
			{ id: "T1", status: "integrated", lastStep: "impl1-0", integratedCommit: "h1" },
			{ id: "T2", status: "failed", lastStep: "impl2-0", integratedCommit: undefined },
			{ id: "T3", status: "failed", lastStep: undefined, integratedCommit: undefined },
			{ id: "T4", status: "running", lastStep: "rev-0", integratedCommit: undefined },
		]);
		expect(state.history.map((event) => event.t)).toEqual([
			"step.completed", "step.failed", "step.completed", "check.completed", "integrate.completed", "integrate.failed", "script.settled", "decision.recorded", "verify.completed",
		]);
	});

	it("keeps every completion per fingerprint and tracks the latest attempt", () => {
		const state = fold(journalOf([
			started("s-0", "f1", 1),
			{ t: "step.completed", key: "s-0", fingerprint: "f1", status: "ok", text: "one" },
			started("s-0", "f2", 1),
			{ t: "step.failed", key: "s-0", fingerprint: "f2", attempt: 1, errorClass: "stopped", message: "stop", final: true },
			{ t: "step.completed", key: "adopted-0", fingerprint: "f9", status: "ok", commit: "c9" },
		]));
		expect(findCompletion(state, "s-0", "f1")?.text).toBe("one");
		expect(state.steps.get("s-0")).toMatchObject({ status: "stopped", started: { fingerprint: "f2" }, failed: { errorClass: "stopped" } });
		expect(state.steps.get("s-0")?.completed).toBeUndefined();
		expect(state.steps.get("adopted-0")).toMatchObject({ status: "ok", completed: { commit: "c9" } });
		expect(state.steps.get("adopted-0")?.started).toBeUndefined();
		expect(state.liveAgentStarts).toBe(2);
	});

	it("computes the overall status and defaults the head to the base", () => {
		const run: JournalInput = { t: "run.started", runId: "r", title: "t", base: "b0", runtime: "0.1.0", repo: "/r" };
		expect(fold(journalOf([run]))).toMatchObject({ status: "drafting", integrationHead: "b0" });
		expect(fold(journalOf([run, { t: "delivery.completed", mode: "series", target: "main", tip: "x", commits: ["x"] }])).status).toBe("delivered");
		expect(fold(journalOf([run, { t: "run.finished", status: "abandoned", reason: "user" }]))).toMatchObject({ status: "abandoned", finished: { reason: "user" } });
		expect(fold([]).status).toBe("drafting");
	});

	it("ignores unknown event types and fields and is deterministic", () => {
		const events = [...sampleJournal(), { v: 1, t: "future.thing", at: "x", key: "impl1-0" } as unknown as JournalEvent];
		(events[5] as unknown as Record<string, unknown>).futureField = 42;
		expect(fold(events).steps.get("impl1-0")?.status).toBe("ok");
		expect(fold(events)).toEqual(fold(events));
		expect(fold(events).history).toHaveLength(fold(sampleJournal()).history.length);
	});
});
