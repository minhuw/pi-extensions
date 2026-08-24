import assert from "node:assert/strict";
import test from "node:test";
import {
	ATTENTION_PATH_LIMIT,
	attentionRequestSha256,
	canonicalEventPayload,
	normalizeUsage,
	parseWorkerResult,
	sha256,
	stableJson,
	validateAttentionRequest,
	validateIntegrationRepairInput,
	integrationRepairCapabilityToken,
	isTerminalRunStatus,
	RUN_STATUSES,
	TERMINAL_RUN_STATUSES,
} from "../../../src/shared/protocol.ts";

test("terminal run status policy is shared and fail-closed", () => {
	assert.deepEqual(RUN_STATUSES, ["initializing", "running", "paused", "needs_input", "complete", "failed", "stopped"]);
	assert.deepEqual(TERMINAL_RUN_STATUSES, ["complete", "failed", "stopped"]);
	for (const status of RUN_STATUSES) assert.equal(isTerminalRunStatus(status), ["complete", "failed", "stopped"].includes(status));
	for (const status of ["unknown", undefined, "active", "missing"]) assert.equal(isTerminalRunStatus(status), false);
});

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

test("normalizeUsage preserves nested model slices from the terminal event", () => {
	const usage = normalizeUsage(null, {
		actionId: "action-1",
		usage: {
			inputTokens: 10,
			cachedInputTokens: 1,
			outputTokens: 2,
			reasoningTokens: 3,
			source: "herder pi worker session",
			nested: [{
				type: "recon",
				model: "gpt-5.6-luna",
				effort: "max",
				serviceTier: "fast",
				count: 1,
				inputTokens: 4,
				cachedInputTokens: 0,
				outputTokens: 1,
				reasoningTokens: 1,
			}],
		},
	});
	assert.equal(usage.inputTokens, 10);
	assert.equal(usage.nested?.[0]?.model, "gpt-5.6-luna");
	assert.equal(usage.nested?.[0]?.count, 1);
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
	const legacyRequestBody = {
		...requestBody,
		recovery: { ...requestBody.recovery, fingerprintVersion: 1 },
	};
	const legacyRequest = {
		...legacyRequestBody,
		requestSha256: attentionRequestSha256(legacyRequestBody as unknown as Parameters<typeof attentionRequestSha256>[0]),
	};
	assert.throws(() => validateAttentionRequest(legacyRequest), /fingerprint version/);
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

test("typed attention requests accept every manager-owned state and reject delegated", () => {
	const detail = "Attention state coverage";
	const base = {
		schemaVersion: 1 as const,
		requestId: "attention-state",
		runId: "run-1",
		planId: "001",
		generation: 1,
		round: 2,
		actionId: "run-1:state",
		kind: "operator_attention" as const,
		cause: "reviewer_blocked" as const,
		detail,
		detailSha256: sha256(detail),
		continuation: { role: "plan-reviewer" as const, phase: "READY_REVIEWER" as const },
		createdAt: "2026-08-11T00:00:00.000Z",
		updatedAt: "2026-08-11T00:00:00.000Z",
	};
	for (const state of ["pending", "awaiting_input", "editing"] as const) {
		const request = { ...base, state, requestSha256: attentionRequestSha256({ ...base, state } as typeof base) };
		assert.doesNotThrow(() => validateAttentionRequest(request));
	}
	const resolved = { ...base, state: "resolved" as const, resolvedAt: base.updatedAt };
	assert.doesNotThrow(() => validateAttentionRequest({ ...resolved, requestSha256: attentionRequestSha256(resolved) }));
	const delegatedBody = { ...base, state: "delegated" as const };
	const delegated = { ...delegatedBody, requestSha256: attentionRequestSha256(delegatedBody as typeof base) };
	assert.throws(() => validateAttentionRequest(delegated), /Unsupported attention state/);
});
test("integration repair input validation owns context-free admission rules", () => {
	const requestId = "request-1";
	const valid = {
		operation: "begin" as const,
		requestId,
		requestSha256: "a".repeat(64),
		capabilityToken: integrationRepairCapabilityToken(requestId),
		ownerSessionId: "session-1",
		repairId: "repair-1",
		gates: [],
		gateAdditions: [],
		allowedPaths: ["src/value.mjs"],
		observedCommit: "b".repeat(40),
	};
	assert.doesNotThrow(() => validateIntegrationRepairInput(valid));
	assert.throws(() => validateIntegrationRepairInput({ ...valid, capabilityToken: "c".repeat(64) }), /request-bound/);
	assert.throws(() => validateIntegrationRepairInput({ ...valid, ownerSessionId: "" }), /ownerSessionId is invalid/);
	assert.throws(() => validateIntegrationRepairInput({ ...valid, repairId: "x".repeat(201) }), /repairId is invalid/);
	assert.throws(() => validateIntegrationRepairInput({ ...valid, commitMessage: "legacy" }), /commitMessage is not accepted/);
	assert.throws(() => validateIntegrationRepairInput({ ...valid, gates: Array.from({ length: 33 }, () => ({})) }), /gates are invalid/);
	assert.throws(() => validateIntegrationRepairInput({ ...valid, observedCommit: "not-a-commit" }), /observed commit is invalid/);
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
