import assert from "node:assert/strict";
import test from "node:test";
import {
	ATTENTION_PATH_LIMIT,
	ATTENTION_RESOLUTION_ACTIONS,
	MANAGER_PROTOCOL_VERSION,
	MAX_PLAN_ROUNDS,
	attentionCapabilityToken,
	validateAttentionResolution,
	attentionRequestSha256,
	canonicalEventPayload,
	integrationRepairRefSnapshotSha256,
	normalizeIntegrationRepairRefSnapshotEvidence,
	normalizeUsage,
	parseWorkerResult,
	sha256,
	stableJson,
	validateAttentionRequest,
	normalizeIntegrationRepairInput,
	validateIntegrationRepairInput,
	integrationRepairCapabilityToken,
	isTerminalRunStatus,
	RUN_STATUSES,
	TERMINAL_RUN_STATUSES,
	type IntegrationRepairRef,
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

	const judge = parseWorkerResult("plan-judge", "DECISION: REPAIR\nPASS_DOCUMENT: Fix F001 and rerun the failing check.\nFINDINGS: [F001][BLOCKING_IN_SCOPE][PLAN_REQUIREMENT] retain; evidence=test\nAUTHORIZED_BLOCKERS: F001\nREPAIR_CONTRACTS: [F001] observed=x; expected=y; reproduction=z; constraints=q\nDISCOVERED_PATHS: none\nLEAKS: none\nQUESTION: none\nCHECKS: test reproduced\nRATIONALE: bounded repair remains\nUSAGE: input_tokens=1; cached_input_tokens=0; output_tokens=2; reasoning_tokens=0; source=host");
	assert.equal(judge.kind, "judge");
	assert.deepEqual(judge.authorizedBlockers, ["F001"]);
	assert.equal(judge.passDocument, "Fix F001 and rerun the failing check.");
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
	const finalRound = { ...requestBody, round: MAX_PLAN_ROUNDS };
	assert.doesNotThrow(() => validateAttentionRequest({ ...finalRound, requestSha256: attentionRequestSha256(finalRound) }));
	assert.throws(() => validateAttentionRequest({ ...request, round: 4 }), /round must be between 1 and 3/);
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
test("integration repair inputs narrow by operation without changing the wire admission", () => {
	const requestId = "request-1";
	const wireBase = {
		schemaVersion: 1 as const,
		requestId,
		requestSha256: "a".repeat(64),
		capabilityToken: integrationRepairCapabilityToken(requestId),
	};
	for (const operation of ["begin", "finish", "cancel"] as const) {
		const ownerless = { ...wireBase, operation };
		assert.doesNotThrow(() => validateIntegrationRepairInput(ownerless));
		assert.throws(
			() => normalizeIntegrationRepairInput(ownerless),
			operation === "begin" ? /owning main session ID/ : /owner session does not match/,
		);
	}

	const unclassified = { ...wireBase, operation: "begin" as const, ownerSessionId: "session-1" };
	assert.doesNotThrow(() => validateIntegrationRepairInput(unclassified));
	assert.throws(() => normalizeIntegrationRepairInput(unclassified), /classification is invalid/);

	const common = {
		...wireBase,
		operationId: "operation-1",
		repairId: "repair-1",
		runId: "run-1",
		generation: 1,
		ownerSessionId: "session-1",
		rationale: "repair rationale",
		detail: "repair detail",
		gates: [],
		gateAdditions: [],
		allowedPaths: ["src/value.mjs"],
	};
	const begin = { ...common, operation: "begin" as const, classification: "code_defect", observedCommit: "b".repeat(40) };
	const finish = { ...common, operation: "finish" as const };
	const cancel = { ...common, operation: "cancel" as const };
	assert.deepEqual(normalizeIntegrationRepairInput(begin), begin);
	assert.deepEqual(normalizeIntegrationRepairInput(finish), finish);
	assert.deepEqual(normalizeIntegrationRepairInput(cancel), cancel);
	assert.equal("observedCommit" in normalizeIntegrationRepairInput(finish), false);
});

test("integration repair ref snapshots normalize strings and arrays with one evidence rule", () => {
	const refs: IntegrationRepairRef[] = [
		{ ref: "refs/heads/herder/demo/main", target: "a".repeat(40) },
		{ ref: "refs/plan-herder/demo/work", target: "b".repeat(64) },
	];
	const json = stableJson(refs);
	const hash = integrationRepairRefSnapshotSha256(refs);
	const fromString = normalizeIntegrationRepairRefSnapshotEvidence(json, hash.toUpperCase());
	assert.deepEqual(fromString.refs, refs);
	assert.equal(fromString.json, json);
	assert.equal(fromString.sha256, hash);
	const fromArray = normalizeIntegrationRepairRefSnapshotEvidence(
		refs.map(({ ref, target }) => ({ target, ref })),
		hash,
	);
	assert.deepEqual(fromArray.refs, refs);
	assert.equal(fromArray.json, json);
	assert.equal(fromArray.sha256, hash);

	assert.throws(() => normalizeIntegrationRepairRefSnapshotEvidence("{", hash), /not valid JSON/);
	assert.throws(() => normalizeIntegrationRepairRefSnapshotEvidence("{}", hash), /must be an array/);
	assert.throws(() => normalizeIntegrationRepairRefSnapshotEvidence(JSON.stringify(refs, null, 2), hash), /not canonical/);
	assert.throws(() => normalizeIntegrationRepairRefSnapshotEvidence(refs, undefined), /hash is invalid/);
	assert.throws(() => normalizeIntegrationRepairRefSnapshotEvidence(refs, "not-a-hash"), /hash is invalid/);
	assert.throws(() => normalizeIntegrationRepairRefSnapshotEvidence(refs, "0".repeat(64)), /hash changed/);
	assert.throws(() => normalizeIntegrationRepairRefSnapshotEvidence([{ ref: "refs/demo", target: "invalid" }], hash), /target is invalid/);
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


test("Judge repair requires a bounded pass document while other decisions may omit it", () => {
	const repair = "DECISION: REPAIR\nAUTHORIZED_BLOCKERS: F001\nREPAIR_CONTRACTS: Fix F001";
	for (const document of [undefined, "", "   ", "none", "NoNe"]) {
		assert.throws(() => parseWorkerResult("plan-judge", repair + (document === undefined ? "" : `\nPASS_DOCUMENT: ${document}`)), /requires a nonempty PASS_DOCUMENT/);
	}
	const document = "Fix the failing assertion.\nPreserve the public API.";
	const result = parseWorkerResult("plan-judge", `${repair}\nPASS_DOCUMENT: ${document}`);
	assert.equal(result.kind, "judge");
	assert.equal(result.passDocument, document);
	assert.doesNotThrow(() => parseWorkerResult("plan-judge", `${repair}\nPASS_DOCUMENT: ${"x".repeat(16_384)}`));
	for (const invalid of ["x".repeat(16_385), "bad\0document"]) {
		for (const decision of [repair, "DECISION: DONE"]) {
			assert.throws(() => parseWorkerResult("plan-judge", `${decision}\nPASS_DOCUMENT: ${invalid}`), /PASS_DOCUMENT must be/);
		}
	}
	for (const decision of ["DONE", "BLOCKED", "NEEDS_INPUT\nQUESTION: Which API?"]) {
		const result = parseWorkerResult("plan-judge", `DECISION: ${decision}`);
		assert.equal(Object.hasOwn(result, "passDocument"), false);
	}
});

test("attention acceptance requires adapter confirmation and explicit waivers through round three", () => {
	assert.equal(MANAGER_PROTOCOL_VERSION, 11);
	assert.equal(MAX_PLAN_ROUNDS, 3);
	assert.ok(ATTENTION_RESOLUTION_ACTIONS.includes("accept"));
	assert.ok(ATTENTION_RESOLUTION_ACTIONS.includes("stop"));
	const acceptance = {
		schemaVersion: 1,
		requestId: "attention-accept",
		requestSha256: "a".repeat(64),
		capabilityToken: attentionCapabilityToken("attention-accept"),
		runId: "run-1", planId: "001", generation: 1, round: 3,
		action: " AcCePt ", confirmed: true,
		answer: "Accept the missing optional regression check as a waived gap.",
		rationale: "The reviewed tree is sufficient for this release.",
	};
	assert.doesNotThrow(() => validateAttentionResolution(acceptance));
	for (const patch of [{ confirmed: false }, { confirmed: undefined }, { answer: undefined }, { answer: "   " }, { rationale: undefined }, { rationale: "   " }]) {
		assert.throws(() => validateAttentionResolution({ ...acceptance, ...patch }), /requires human confirmation/);
	}
	for (const confirmed of ["true", 1, null]) {
		assert.throws(() => validateAttentionResolution({ ...acceptance, action: "stop", confirmed }), /confirmed must be a boolean/);
	}
	assert.doesNotThrow(() => validateAttentionResolution({ ...acceptance, action: "stop", confirmed: false, answer: undefined, rationale: undefined }));
	assert.throws(() => validateAttentionResolution({ ...acceptance, round: 4 }), /round must be between 1 and 3/);
	for (const answer of ["x".repeat(16_385), "bad\0waiver"]) {
		assert.throws(() => validateAttentionResolution({ ...acceptance, answer }), /answer is invalid/);
	}
});


const blockerEnvelopes = [
	["plan-implementer", "STATUS: STOPPED\nSTOPPED BECAUSE: npm project dependencies are missing; operator must prepare the locked environment"],
	["plan-reviewer", "VERDICT: BLOCK\nSCOPE: PASS\nFINDINGS: none\nRATIONALE: npm project dependencies are missing; operator must prepare the locked environment"],
	["plan-judge", "DECISION: BLOCKED\nAUTHORIZED_BLOCKERS: none\nREPAIR_CONTRACTS: none\nRATIONALE: npm project dependencies are missing; operator must prepare the locked environment"],
] as const;
const blockerChecks = "CHECKS: manager=npm project scripts; command=npm test; cwd=/repo; error=missing locked dependency; prerequisite=npm ci by operator";

test("optional worker blockers require blocked outcomes and concrete detail/check evidence", () => {
	for (const [role, envelope] of blockerEnvelopes) {
		for (const kind of ["ENVIRONMENT", "INVOCATION", "REQUIREMENT"]) {
			assert.equal(parseWorkerResult(role, `${envelope}\nBLOCKER_KIND: ${kind}\n${blockerChecks}`).blockerKind, kind);
			assert.throws(() => parseWorkerResult(role, `${envelope}\nBLOCKER_KIND: ${kind}\nCHECKS: none`), /concrete detail and CHECKS/);
			assert.throws(() => parseWorkerResult(role, `${envelope.replace(/(?:STOPPED BECAUSE|RATIONALE): .*/, "RATIONALE: none")}\nBLOCKER_KIND: ${kind}\n${blockerChecks}`), /concrete detail and CHECKS/);
		}
		assert.equal(parseWorkerResult(role, `${envelope}\n${blockerChecks}`).blockerKind, undefined);
		assert.throws(() => parseWorkerResult(role, `${envelope}\nBLOCKER_KIND: CODE\n${blockerChecks}`), /Invalid BLOCKER_KIND/);
	}
});

test("worker blocker classification rejects success, repair authority, scope failure, and hidden contradictions", () => {
	for (const [role, envelope] of [
		["plan-implementer", "STATUS: COMPLETE"],
		["plan-reviewer", "VERDICT: APPROVE\nSCOPE: PASS"],
		["plan-reviewer", "VERDICT: REVISE\nSCOPE: PASS"],
		["plan-judge", "DECISION: DONE"],
		["plan-judge", "DECISION: REPAIR"],
	] as const) assert.throws(() => parseWorkerResult(role, `${envelope}\nBLOCKER_KIND: ENVIRONMENT\n${blockerChecks}`), /requires a blocked worker outcome/);
	for (const kind of ["ENVIRONMENT", "INVOCATION"]) {
		for (const extra of ["FINDINGS: [P1][BLOCKING] source bug", "FIX_GUIDANCE: edit code", "AUTHORIZED_BLOCKERS: F001", "REPAIR_CONTRACTS: fix F001", "PASS_DOCUMENT: fix F001", "SCOPE: FAIL"]) {
			assert.throws(() => parseWorkerResult("plan-implementer", `${blockerEnvelopes[0][1]}\nBLOCKER_KIND: ${kind}\n${blockerChecks}\n${extra}`), /cannot report defect findings/);
		}
	}
	assert.throws(() => parseWorkerResult("plan-reviewer", `${blockerEnvelopes[1][1]}\nFINDINGS: source bug\nBLOCKER_KIND: ENVIRONMENT\n${blockerChecks}`), /repeats FINDINGS/);
	assert.throws(() => parseWorkerResult("plan-implementer", `STATUS: COMPLETE\n${blockerEnvelopes[0][1]}\nBLOCKER_KIND: ENVIRONMENT\n${blockerChecks}`), /repeats STATUS/);
});
