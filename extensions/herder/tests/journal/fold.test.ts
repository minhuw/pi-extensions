import { describe, expect, it } from "vitest";
import { isKnownEvent } from "../../src/journal/events.ts";
import { findCompletion, findIntegration, fold } from "../../src/journal/fold.ts";
import { renderProgress } from "../../src/journal/render.ts";
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
		const started = fold(journalOf([run, { t: "delivery.started", mode: "branch", target: "herder/r", tip: "x", onto: "y", commits: ["x"] }]));
		expect(started.deliveryStarted).toMatchObject({ mode: "branch", tip: "x", onto: "y" });
		expect(started.delivery).toBeUndefined();
		expect(fold(journalOf([run, { t: "run.finished", status: "abandoned", reason: "user" }]))).toMatchObject({ status: "abandoned", finished: { reason: "user" } });
		expect(fold([]).status).toBe("drafting");
	});

	it("records the orchestrating session and each step's latest session", () => {
		const state = fold(journalOf([
			{ t: "run.started", runId: "r", title: "t", base: "b0", runtime: "0.1.0", repo: "/r", sessionId: "main" },
			started("s-0", "f1", 1),
			{ t: "step.failed", key: "s-0", fingerprint: "f1", attempt: 1, errorClass: "transient", message: "net", final: false, sessionId: "a1", sessionFile: "/s/a1.jsonl" },
			started("s-0", "f1", 2),
			{ t: "step.completed", key: "s-0", fingerprint: "f1", status: "ok", sessionId: "a2", sessionFile: "/s/a2.jsonl" },
			{ ...started("r-0", "f2", 1), sessionId: "b1", sessionFile: "/s/b1.jsonl" } as JournalInput,
			{ t: "step.completed", key: "r-0", fingerprint: "f2", status: "ok" },
		]));
		expect(state.sessionId).toBe("main");
		expect(state.steps.get("s-0")).toMatchObject({ status: "ok", sessionId: "a2", sessionFile: "/s/a2.jsonl" });
		expect(state.steps.get("r-0")).toMatchObject({ status: "ok", sessionId: "b1", sessionFile: "/s/b1.jsonl" });
	});

	it("folds a journal written before session fields existed", () => {
		const lines = [
			'{"v":1,"t":"run.started","at":"2026-01-01T00:00:00.000Z","runId":"20260101-000000-abcd","title":"old","base":"b0","runtime":"0.1.0","repo":"/repo"}',
			'{"v":1,"t":"step.started","at":"2026-01-01T00:00:01.000Z","key":"impl-0","id":"impl","occurrence":0,"fingerprint":"f1","attempt":1,"role":"worker","write":true,"base":"b0","task":"T1","launch":1}',
			'{"v":1,"t":"step.failed","at":"2026-01-01T00:00:02.000Z","key":"impl-0","fingerprint":"f1","attempt":1,"errorClass":"transient","message":"net","final":false}',
			'{"v":1,"t":"step.started","at":"2026-01-01T00:00:03.000Z","key":"impl-0","id":"impl","occurrence":0,"fingerprint":"f1","attempt":2,"role":"worker","write":true,"base":"b0","task":"T1","launch":1}',
			'{"v":1,"t":"step.completed","at":"2026-01-01T00:00:04.000Z","key":"impl-0","fingerprint":"f1","status":"ok","text":"done","commit":"c1"}',
		];
		const events = lines.map((line) => JSON.parse(line) as JournalEvent);
		expect(events.every(isKnownEvent)).toBe(true);
		const state = fold(events);
		expect(state).toMatchObject({ runId: "20260101-000000-abcd", title: "old", liveAgentStarts: 1 });
		expect(state.sessionId).toBeUndefined();
		const step = state.steps.get("impl-0")!;
		expect(step).toMatchObject({ status: "ok", started: { attempt: 2 }, completed: { commit: "c1" } });
		expect(step).not.toHaveProperty("sessionId");
		expect(step).not.toHaveProperty("sessionFile");
		const text = renderProgress(state);
		expect(text).toContain("1. 2026-01-01T00:00:02.000Z step `impl-0` attempt 1 failed (will retry): transient: net\n");
		expect(text).toContain("2. 2026-01-01T00:00:04.000Z step `impl-0` ok at c1\n");
		expect(text).not.toContain("session");
	});

	it("ignores unknown event types and fields and is deterministic", () => {
		const events = [...sampleJournal(), { v: 1, t: "future.thing", at: "x", key: "impl1-0" } as unknown as JournalEvent];
		(events[5] as unknown as Record<string, unknown>).futureField = 42;
		expect(fold(events).steps.get("impl1-0")?.status).toBe("ok");
		expect(fold(events)).toEqual(fold(events));
		expect(fold(events).history).toHaveLength(fold(sampleJournal()).history.length);
	});
});
