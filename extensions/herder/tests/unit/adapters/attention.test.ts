import assert from "node:assert/strict";
import test from "node:test";
import { attentionMessageDetails, attentionResolutionFromRequest, buildAttentionPrompt } from "../../../adapters/attention.ts";
import type { ManagerAttentionRequest } from "../../../src/shared/protocol.ts";

test("review-budget operator attention labels partial approval as incomplete diagnostic evidence", async () => {
	const request: ManagerAttentionRequest = {
		schemaVersion: 1, requestId: "budget-request", requestSha256: "a".repeat(64), capabilityToken: "b".repeat(64),
		runId: "run", planId: "RUN", generation: 1, round: 1, actionId: "audit", kind: "operator_attention",
		state: "awaiting_input", cause: "review_budget_exhausted", detail: "PARTIAL_RESPONSE: VERDICT: APPROVE",
		detailSha256: "c".repeat(64), continuation: { role: "plan-reviewer", phase: "READY_REVIEWER" },
		createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
	};
	const details = attentionMessageDetails(request);
	assert.match(details.reason!, /budget exhausted; review incomplete \(not approval or a defect\)/);
	assert.match(details.nextAction!, /Record an answer, defer, or stop/);
	const prompt = await buildAttentionPrompt("/unused-package-root", "/fixture/herder-plans", request);
	assert.match(prompt, /^HERDER_STOPPED_ATTENTION_V1/);
	assert.match(prompt, /REQUEST_ID: budget-request/);
	assert.match(prompt, /Safe operator retry requires exact host confirmation and remaining effort budget/);
	assert.match(prompt, /Scope changes never refill budgets/);
	assert.doesNotMatch(prompt, /PROPOSE|Beginning a proposal does not require|Call herder_plan.*revise_run/);
});

test("Judge decisions expose exact bounded choices without scope or effort authorization", async () => {
	const request = { schemaVersion: 1, requestId: "judge", runId: "run", planId: "001", generation: 1, round: 2, kind: "user_decision", state: "awaiting_input", cause: "judge_needs_input", detail: "Choose remaining findings", continuation: { role: "plan-judge", phase: "NEEDS_INPUT" } } as ManagerAttentionRequest;
	const recovery = {
		planFingerprint: "f".repeat(64), fingerprintVersion: 2 as const, planFile: "001-plan.md", inScopePaths: ["value.ts"],
		assignmentPath: "/work/assignment.json", assignmentSha256: "a".repeat(64), snapshotSha256: "b".repeat(64),
		generationBase: "c".repeat(40), branch: "herder/plan/001", worktree: "/work", worktreeHead: "d".repeat(40), worktreeTree: "e".repeat(40), changedPaths: ["value.ts"],
	};
	assert.equal(request.kind, "user_decision");
	if (request.kind !== "user_decision") throw new Error("fixture kind");
	request.recovery = recovery;
	const bound = attentionResolutionFromRequest(request);
	assert.equal(bound.git?.worktreeHead, recovery.worktreeHead);
	assert.equal(bound.git?.worktreeTree, recovery.worktreeTree);
	assert.equal(bound.git?.assignmentSha256, recovery.assignmentSha256);
	const details = attentionMessageDetails(request);
	assert.match(details.nextAction!, /Next round \(retry\), accept as-is \(accept\), or drop plan \(reject\)/);
	const prompt = await buildAttentionPrompt("/unused", "/plans", request);
	assert.match(prompt, /not passed checks/);
	assert.match(prompt, /preserve work and block dependents, not destructive cleanup/);
	assert.match(prompt, /Rationale grants no scope or budget/);
	assert.match(prompt, /\/herder-revise/);
	assert.match(prompt, /\/herder-budget/);
});
