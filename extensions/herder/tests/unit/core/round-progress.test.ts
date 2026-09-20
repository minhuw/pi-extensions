import assert from "node:assert/strict";
import test from "node:test";
import type { StoredAction } from "../../../src/daemon/run-store.ts";
import { buildRoundProgress, excludedFindings } from "../../../src/core/round-progress.ts";
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
