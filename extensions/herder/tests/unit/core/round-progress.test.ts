import assert from "node:assert/strict";
import test from "node:test";
import type { StoredAction } from "../../../src/daemon/run-store.ts";
import { buildRoundProgress, excludedFindings } from "../../../src/core/round-progress.ts";
import { renderRoundProgress, recommendedNextOperation } from "../../../adapters/round-progress.ts";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { parseWorkerResult } from "../../../src/shared/protocol.ts";

function action(id: string, role: "implementer" | "reviewer" | "judge", overrides: Partial<StoredAction> = {}): StoredAction {
	const envelopes = {
		implementer: "STATUS: COMPLETE\nCOMMITS: none\nFILES CHANGED: src/a.ts\nNOTES: Fixed A1.\nSETUP: npm ci — restored\nCHECKS: npm test — passed",
		reviewer: "VERDICT: APPROVE\nFINDINGS: none\nSCOPE: PASS\nRATIONALE: A1 verified; final gate unrun.\nCHECKS: npm test — passed",
		judge: "DECISION: DONE\nFINDINGS: none\nRATIONALE: Original task closed.\nCHECKS: final gate — not run",
	};
	return {
		actionId: id, runId: "run", planId: "001", generation: 1, round: 1,
		role: `plan-${role}`, attemptId: id, state: "terminal", agentType: role,
		model: "test", effort: "test", serviceTier: null, workerMode: "INITIAL", taskName: "test",
		leaseReason: "test", hostHandle: null,
		result: { workerResult: parseWorkerResult(`plan-${role}`, envelopes[role]), terminal: { interrupted: false } },
		createdAt: "2026-01-01", updatedAt: "2026-01-01", ...overrides,
	};
}

function judge(id: string, findings: string[], overrides: Partial<StoredAction> = {}): StoredAction {
	const value = action(id, "judge", overrides);
	const record = value.result as { workerResult: { findings: string[] } };
	record.workerResult.findings = findings;
	return value;
}

const deferred = "[F001][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] old bug; evidence=baseline";

test("round progress retains chronological grouping, terminal identity and actual self-reports", () => {
	const history = [action("z", "implementer"), action("a", "reviewer"), judge("j", [deferred]), action("next", "implementer", { round: 2 }), action("active", "reviewer", { round: 2, state: "dispatched" })];
	const progress = buildRoundProgress(history);
	assert.equal(progress.length, 2);
	assert.equal(progress[0]?.reportId, "j");
	assert.equal(progress[0]?.implementer?.summary, "Fixed A1.");
	assert.deepEqual(progress[0]?.implementer?.setup, ["npm ci — restored"]);
	assert.deepEqual(progress[0]?.judge?.checks, ["final gate — not run"]);
	assert.equal(progress[0]?.outcome, "DONE");
	assert.deepEqual(progress[1]?.notIntendedToFix, [deferred]);
	assert.equal(progress[1]?.reviewer, undefined);
	assert.equal(progress[1]?.reportId, "next");
	assert.deepEqual(buildRoundProgress(history), progress);
});

test("interrupted or failed transport never turns a retained success envelope into completion", () => {
	for (const terminal of [{ interrupted: true }, { error: "lost transport" }, { failureKind: "timeout" }]) {
		const interrupted = action("lost", "judge");
		(interrupted.result as { terminal: unknown }).terminal = terminal;
		const round = buildRoundProgress([action("impl", "implementer"), interrupted])[0]!;
		assert.equal(round.outcome, "UNKNOWN");
		assert.equal(round.judge?.outcome, "UNKNOWN");
		assert.deepEqual(round.judge?.checks, []);
		assert.deepEqual(round.fixNext, []);
	}
	assert.equal(buildRoundProgress([action("bad", "reviewer", { result: null })])[0]?.outcome, "UNKNOWN");
	assert.deepEqual(buildRoundProgress([action("cancelled", "implementer", { state: "cancelled" })]), []);
});

test("only persisted Judge-authorized stable-ID repair contracts appear in fixNext", () => {
	const repair = judge("repair", []);
	Object.assign((repair.result as { workerResult: object }).workerResult, {
		decision: "REPAIR", authorizedBlockers: ["F002", "NEW"],
		repairContracts: ["[F002] fix the approved failure", "[F003] unauthorized", "[NEW] unbound"],
	});
	assert.deepEqual(buildRoundProgress([repair])[0]?.fixNext, ["[F002] fix the approved failure"]);
	const interrupted = structuredClone(repair);
	(interrupted.result as { terminal: unknown }).terminal = { interrupted: true };
	assert.deepEqual(buildRoundProgress([repair, interrupted])[0]?.fixNext, []);
});

test("exclusions deduplicate stable IDs across rounds and stay generation/plan scoped", () => {
	const rejected = "[F002][REJECTED][INVALID] contradicted by test";
	const history = [judge("j1", [deferred, rejected, "[NEW][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] unbound"]), judge("j2", [deferred], { round: 2 }), judge("j3", ["[F003][NONBLOCKING_IN_SCOPE][FOLLOWUP] notify only"]), judge("other", ["[F999][REJECTED][INVALID] other"], { planId: "002" }), judge("newgen", [], { generation: 2 })];
	assert.deepEqual(excludedFindings(history, "001", 1), [deferred, rejected, "[F003][NONBLOCKING_IN_SCOPE][FOLLOWUP] notify only"]);
	assert.deepEqual(excludedFindings(history, "001", 2), []);
	const interrupted = judge("interrupted", [deferred]);
	(interrupted.result as { terminal: unknown }).terminal = { interrupted: true };
	assert.deepEqual(excludedFindings([interrupted], "001", 1), []);
	assert.deepEqual(buildRoundProgress(history).find((r) => r.generation === 2)?.notIntendedToFix, []);
});

test("run identity separates groups/exclusions; YOLO has implementer evidence only", () => {
	const progress = buildRoundProgress([judge("j", [deferred]), action("yolo", "implementer", { runId: "other" })]);
	assert.equal(progress.length, 2);
	assert.deepEqual(progress[1]?.notIntendedToFix, []);
	assert.equal(progress[1]?.implementer?.outcome, "COMPLETE");
	assert.equal(progress[1]?.reviewer, undefined);
	assert.equal(progress[1]?.judge, undefined);
	assert.deepEqual(buildRoundProgress([]), []);
});

test("validated Judge reopening removes only its authorized ID from current exclusions", () => {
	const retained = "[F002][REJECTED][INVALID] unsupported";
	const excluded = judge("excluded", [deferred, retained]);
	const reopened = judge("reopened", ["[F001][BLOCKING_IN_SCOPE][PATCH_REGRESSION] new failure; evidence=repair delta; regression_rationale=repair worsened baseline"], { round: 2 });
	Object.assign((reopened.result as { workerResult: object }).workerResult, {
		decision: "REPAIR", authorizedBlockers: ["F001"], repairContracts: ["[F001] fix only the new regression"],
	});
	assert.deepEqual(excludedFindings([excluded, reopened], "001", 1), [retained]);
	const round = buildRoundProgress([excluded, reopened])[1]!;
	assert.deepEqual(round.fixNext, ["[F001] fix only the new regression"]);
	assert.deepEqual(round.notIntendedToFix, [retained]);
	for (const change of [{ decision: "BLOCKED" }, { authorizedBlockers: [] }, { findings: ["[F001][BLOCKING_IN_SCOPE][PLAN_REQUIREMENT] not a newly introduced regression"] }]) {
		const unauthorized = structuredClone(reopened);
		Object.assign((unauthorized.result as { workerResult: object }).workerResult, change);
		assert.deepEqual(excludedFindings([excluded, unauthorized], "001", 1), [deferred, retained]);
	}
});

function stoppedAttempt(planId: string, status: "FAILED" | "STOPPED", commits: string, reason: string): StoredAction {
	return action(planId, "implementer", { planId, result: {
		workerResult: parseWorkerResult("plan-implementer", `STATUS: ${status}\nCOMMITS: ${commits}\nNOTES: Updated code.\nSTOPPED BECAUSE: ${reason}\nCHECKS: npm test — passed\ntypecheck — passed`),
		terminal: { interrupted: false },
	} });
}

test("003 FAILED retains committed work but prioritizes the full V3 reason over passing checks", () => {
	const reason = `V3 not verified: ${"supporting evidence; ".repeat(40)}critical trailing prerequisite`;
	const progress = buildRoundProgress([stoppedAttempt("003", "FAILED", "abcdef1", reason)])[0]!;
	assert.equal(progress.implementer?.stoppedBecause, reason);
	assert.deepEqual(progress.implementer?.commits, ["abcdef1"]);
	const text = renderRoundProgress(progress);
	assert.match(text, /Outcome: FAILED/);
	assert.ok(text.includes(`Reason: ${reason}`));
	assert.ok(text.indexOf(reason) < text.indexOf("npm test"));
	assert.match(text, /Recorded work: Updated code/);
	assert.match(text, /Retained commits \(worker-reported\): abcdef1/);
	assert.match(text, /self-reported, not passed manager gates/);
	assert.match(text, /Inspect the stopped reason and current manager status\/attention before any retry/);
	assert.doesNotMatch(text, /done:|fixNext:|notIntendedToFix:|Authorized repair:|Excluded finding:/);
	assert.equal(text.match(/Recommended next operation:/g)?.length, 1);
	assert.ok(new Text(text, 0, 0).render(42).every(line => visibleWidth(line) <= 42));
});

test("004 STOPPED has no invented commits; legacy progress omits unknown commit evidence", () => {
	const progress = buildRoundProgress([stoppedAttempt("004", "STOPPED", "none", "Required environment unavailable")])[0]!;
	assert.deepEqual(progress.implementer?.commits, []);
	assert.match(renderRoundProgress(progress), /Retained commits \(worker-reported\): none recorded/);
	delete progress.implementer!.commits;
	delete progress.implementer!.stoppedBecause;
	const text = renderRoundProgress(progress);
	assert.match(text, /Outcome: STOPPED/);
	assert.doesNotMatch(text, /Retained commits|undefined|fixNext: none/);
});

test("stage advice preserves role boundaries and interrupted outcomes remain unknown", () => {
	assert.match(renderRoundProgress(buildRoundProgress([action("i", "implementer")])[0]!), /Use \/herder-status.*does not establish plan completion or a next dispatch/);
	assert.match(renderRoundProgress(buildRoundProgress([action("r", "reviewer")])[0]!), /Judge adjudication.*not plan approval/);
	assert.match(renderRoundProgress(buildRoundProgress([action("j", "judge")])[0]!), /Use \/herder-status.*integration\/final verification/);
	assert.match(recommendedNextOperation("judge", "REPAIR"), /manager-owned authorized repair/);
	const interrupted = action("i", "implementer");
	(interrupted.result as { terminal: unknown }).terminal = { interrupted: true };
	const progress = buildRoundProgress([interrupted])[0]!;
	assert.equal(progress.implementer?.commits, undefined);
	const text = renderRoundProgress(progress);
	assert.match(text, /Outcome: UNKNOWN/);
	assert.match(text, /Inspect preserved evidence/);
	assert.doesNotMatch(text, /Outcome: COMPLETE|Await manager review dispatch|Run at report/);
});

test("only same-run historical manager snapshots override stage advice for pause or attention", () => {
	const progress = buildRoundProgress([action("i", "implementer")])[0]!;
	const snapshot = {
		runId: "run", status: "paused", message: "Host review required", active: [], actions: [],
		scheduler: { active: 0, freeSlots: 1, runnable: 0, runnablePlanIds: [], expectedNewActions: 0, workConserving: true, reason: "inactive", checkedAt: "now" },
	} satisfies NonNullable<Parameters<typeof renderRoundProgress>[1]>;
	const text = renderRoundProgress(progress, snapshot);
	assert.match(text, /Run at report \(historical manager snapshot\): paused — Host review required/);
	assert.match(text, /Inspect current manager status\/attention and its request before any retry/);
	assert.doesNotMatch(text, /next dispatch/);
	const otherRun = renderRoundProgress(progress, { ...snapshot, runId: "other" });
	assert.doesNotMatch(otherRun, /Run at report|Host review required/);
	assert.match(otherRun, /Use \/herder-status.*does not establish plan completion or a next dispatch/);
});


test("round check previews stay bounded without hiding the stop reason or counting pass/fail", () => {
	const progress = buildRoundProgress([stoppedAttempt("003", "FAILED", "abcdef1", "V3 not verified")])[0]!;
	progress.implementer!.setup = ["install", "configure", "third setup item"];
	progress.implementer!.checks = ["check one: " + "x".repeat(600), "second check", "third check", "fourth check"];
	const text = renderRoundProgress(progress);
	assert.match(text, /Reason: V3 not verified/);
	assert.match(text, /1 additional items omitted; expand worker transcript/);
	assert.match(text, /preview truncated; 2 additional items omitted; expand worker transcript/);
	assert.doesNotMatch(text, /third setup item|third check|fourth check|\d+ passed|\d+ failed/);
	assert.ok(text.split("\n").find(line => line.includes("Recorded checks ("))!.length < 700);
});


test("manager completion and stopped states outrank historical stage advice", () => {
	const progress = buildRoundProgress([action("j", "judge")])[0]!;
	const snapshot = { runId: "run", status: "complete", message: "Final verification passed", active: [], actions: [] } as unknown as NonNullable<Parameters<typeof renderRoundProgress>[1]>;
	const complete = renderRoundProgress(progress, snapshot);
	assert.match(complete, /Recommended next operation: Use \/herder-status to review the completed run status/);
	assert.doesNotMatch(complete, /Await|before any retry/);
	for (const status of ["stopped", "failed", "needs_input", "paused"] as const) {
		assert.match(renderRoundProgress(progress, { ...snapshot, status }), /Inspect current manager status\/attention and its request before any retry or continuation/);
	}
});

test("no-context COMPLETE is mode-neutral, including YOLO; Reviewer BLOCK asks for adjudication", () => {
	const text = renderRoundProgress(buildRoundProgress([action("yolo", "implementer")])[0]!);
	assert.match(text, /Recommended next operation: Use \/herder-status/);
	assert.doesNotMatch(text, /Await|wait.*review|review dispatch/);
	assert.match(recommendedNextOperation("reviewer", "BLOCK"), /Judge adjudication/);
	assert.doesNotMatch(recommendedNextOperation("reviewer", "BLOCK"), /retry|stopped reason|repair/);
});
