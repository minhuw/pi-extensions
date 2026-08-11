import assert from "node:assert/strict";
import test from "node:test";
import {
	ATTENTION_PATH_LIMIT,
	attentionRequestSha256,
	canonicalEventPayload,
	parseWorkerResult,
	sha256,
	stableJson,
	validateAttentionRequest,
} from "../../../src/shared/protocol.ts";

test("worker envelopes become typed deterministic results", () => {
	const implementer = parseWorkerResult("plan-implementer", "STATUS: COMPLETE\nCOMMITS: abcdef1\nADDRESSED: none\nCHECKS: npm test — passed\nFILES CHANGED: src/a.ts, test/a.test.ts\nDISCOVERED_PATHS: none\nNOTES: done\nUSAGE: input_tokens=10; cached_input_tokens=2; output_tokens=3; reasoning_tokens=1; source=host");
	assert.equal(implementer.kind, "implementer");
	assert.deepEqual(implementer.filesChanged, ["src/a.ts", "test/a.test.ts"]);
	assert.equal(implementer.usage.inputTokens, 10);

	const reviewer = parseWorkerResult("plan-reviewer", "VERDICT: REVISE\nFINDINGS: [NEW][P1][BLOCKING][PLAN_REQUIREMENT] src/a.ts:1 — wrong value; scenario=x; evidence=y; introduced_by=z\nFIX_GUIDANCE: [F001] observed=x; expected=y; reproduction=z; constraints=q\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: npm test failed\nRATIONALE: one blocker\nUSAGE: input_tokens=unknown; cached_input_tokens=unknown; output_tokens=unknown; reasoning_tokens=unknown; source=unknown");
	assert.equal(reviewer.kind, "reviewer");
	assert.equal(reviewer.findings.length, 1);

	const judge = parseWorkerResult("plan-judge", "DECISION: REPAIR\nFINDINGS: [F001][BLOCKING_IN_SCOPE][PLAN_REQUIREMENT] retain; evidence=test\nAUTHORIZED_BLOCKERS: F001\nREPAIR_CONTRACTS: [F001] observed=x; expected=y; reproduction=z; constraints=q\nDISCOVERED_PATHS: none\nLEAKS: none\nQUESTION: none\nCHECKS: test reproduced\nRATIONALE: bounded repair remains\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=2; reasoning_tokens=0; source=host");
	assert.equal(judge.kind, "judge");
	assert.deepEqual(judge.authorizedBlockers, ["F001"]);
});

test("typed attention requests require bounded evidence, continuation, and recovery bindings", () => {
	const detail = "Reviewer evidence is blocked";
	const requestBody = {
		schemaVersion: 1 as const,
		requestId: "attention-1",
		runId: "run-1",
		planId: "001",
		generation: 1,
		round: 2,
		actionId: "run-1:action-1",
		kind: "plan_recovery" as const,
		state: "pending" as const,
		cause: "reviewer_blocked" as const,
		detail,
		detailSha256: sha256(detail),
		continuation: { role: "plan-reviewer" as const, phase: "READY_REVIEWER" as const },
		recommendedAction: "Review the target plan",
		recovery: {
			planFingerprint: "f".repeat(64),
			fingerprintVersion: 2 as const,
			planFile: "001-plan.md",
			inScopePaths: ["src/value.mjs"],
			assignmentPath: "/tmp/assignment.json",
			assignmentSha256: "a".repeat(64),
			snapshotSha256: "b".repeat(64),
			generationBase: "c".repeat(40),
			branch: "herder/plans/001",
			worktree: "/tmp/worktree",
			worktreeHead: "d".repeat(40),
			worktreeTree: "e".repeat(40),
			changedPaths: ["src/value.mjs"],
		},
		createdAt: "2026-08-11T00:00:00.000Z",
		updatedAt: "2026-08-11T00:00:00.000Z",
	};
	const request = { ...requestBody, requestSha256: attentionRequestSha256(requestBody) };
	assert.doesNotThrow(() => validateAttentionRequest(request));
	const completeInScopePaths = Array.from({ length: ATTENTION_PATH_LIMIT + 1 }, (_, index) => `src/path-${index}.mjs`);
	const boundedRecovery = {
		...requestBody.recovery,
		inScopePaths: completeInScopePaths.slice(0, ATTENTION_PATH_LIMIT),
		inScopePathCount: completeInScopePaths.length,
		inScopePathsSha256: sha256(stableJson(completeInScopePaths)),
	};
	const boundedBody = { ...requestBody, recovery: boundedRecovery };
	const boundedRequest = { ...boundedBody, requestSha256: attentionRequestSha256(boundedBody) };
	assert.doesNotThrow(() => validateAttentionRequest(boundedRequest), "omitted paths remain cryptographically bound by count and hash");
	const mismatchedBoundedRecovery = {
		...boundedRecovery,
		inScopePathCount: ATTENTION_PATH_LIMIT,
		inScopePathsSha256: "0".repeat(64),
	};
	const mismatchedBoundedBody = { ...requestBody, recovery: mismatchedBoundedRecovery };
	assert.throws(() => validateAttentionRequest({
		...mismatchedBoundedBody,
		requestSha256: attentionRequestSha256(mismatchedBoundedBody),
	}), /evidence hash/);
	assert.throws(() => validateAttentionRequest({
		...requestBody,
		recovery: { ...requestBody.recovery, inScopePaths: completeInScopePaths },
		requestSha256: attentionRequestSha256({ ...requestBody, recovery: { ...requestBody.recovery, inScopePaths: completeInScopePaths } }),
	}), /paths are invalid/);
	assert.throws(() => validateAttentionRequest({ ...request, detailSha256: "0".repeat(64) }), /detail hash/);
	assert.throws(() => validateAttentionRequest({ ...request, recovery: undefined }), /request hash|recovery evidence/);
	assert.throws(() => validateAttentionRequest({ ...request, continuation: { role: "plan-judge", phase: "UNKNOWN" } }), /request hash|continuation/);
});

test("malformed envelopes and payload-changing replay identities fail closed", () => {
	assert.throws(() => parseWorkerResult("plan-reviewer", "VERDICT: MAYBE"), /missing SCOPE|Invalid Reviewer/);
	assert.throws(() => parseWorkerResult("plan-judge", "DECISION: DONE\nAUTHORIZED_BLOCKERS: F001\nREPAIR_CONTRACTS: none\nQUESTION: none"), /cannot retain authorized blockers/);
	assert.throws(() => parseWorkerResult("plan-judge", "DECISION: REPAIR\nAUTHORIZED_BLOCKERS: none\nREPAIR_CONTRACTS: none\nQUESTION: none"), /requires authorized blockers/);
	assert.throws(() => parseWorkerResult("plan-judge", "DECISION: NEEDS_INPUT\nAUTHORIZED_BLOCKERS: none\nREPAIR_CONTRACTS: none\nQUESTION: none"), /requires one question/);
	const first = canonicalEventPayload({ b: 2, a: 1 });
	const reordered = canonicalEventPayload({ a: 1, b: 2 });
	const changed = canonicalEventPayload({ a: 1, b: 3 });
	assert.equal(first.sha256, reordered.sha256);
	assert.notEqual(first.sha256, changed.sha256);
});
