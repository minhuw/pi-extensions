import assert from "node:assert/strict";
import test from "node:test";
import type { IntegrationRepairRequest } from "../../../src/shared/protocol.ts";
import { classifyVerificationRecovery, FINAL_VERIFICATION_SELECTION_GUIDANCE } from "../../../adapters/verification-recovery.ts";

const currentSessionId = "main-session";

function repair(overrides: Partial<IntegrationRepairRequest> = {}): IntegrationRepairRequest {
	return {
		schemaVersion: 1,
		requestId: "request-1",
		requestSha256: "request-sha",
		runId: "run-1",
		generation: 1,
		state: "available",
		round: 1,
		maxRounds: 3,
		capabilityToken: "capability",
		capabilityTokenSha256: "capability-sha",
		integrationBranch: "herder/test",
		integrationWorktree: "/tmp/integration-worktree",
		parentCommit: "parent-commit",
		failedGates: [],
		canonicalGates: [],
		supersededCommits: [],
		...overrides,
	};
}

const actionableStates = ["available", "failed", "paused"] as const;
const strandedStates = ["active", "committing", "committed", "interrupted"] as const;
const inactiveStates = ["verifying", "passed", "cancelled"] as const;

function expected(overrides: Partial<ReturnType<typeof classifyVerificationRecovery>> = {}) {
	return {
		actionable: false,
		stranded: false,
		ownerMismatch: false,
		ambiguity: false,
		atLimit: false,
		kind: "none" as const,
		...overrides,
	};
}

test("classification matrix preserves recovery boundaries and precedence", () => {
	assert.deepEqual(classifyVerificationRecovery(undefined, currentSessionId), expected());

	for (const state of actionableStates) {
		assert.deepEqual(
			classifyVerificationRecovery(repair({ state }), currentSessionId),
			expected({ actionable: true, kind: "recoverable" }),
			`ownerless actionable ${state}`,
		);
		assert.deepEqual(
			classifyVerificationRecovery(repair({ state, ownerSessionId: currentSessionId }), currentSessionId),
			expected({ actionable: true, kind: "recoverable" }),
			`current-owner actionable ${state}`,
		);
		assert.deepEqual(
			classifyVerificationRecovery(repair({ state, ownerSessionId: "foreign-session" }), currentSessionId),
			expected({ actionable: true, ownerMismatch: true, kind: "owner_mismatch" }),
			`foreign-owner actionable ${state}`,
		);
	}

	for (const state of strandedStates) {
		assert.deepEqual(
			classifyVerificationRecovery(repair({ state }), currentSessionId),
			expected({ stranded: true, ownerMismatch: true, kind: "owner_mismatch" }),
			`ownerless stranded ${state}`,
		);
		assert.deepEqual(
			classifyVerificationRecovery(repair({ state, ownerSessionId: currentSessionId }), currentSessionId),
			expected({ stranded: true, kind: "recoverable" }),
			`current-owner stranded ${state}`,
		);
		assert.deepEqual(
			classifyVerificationRecovery(repair({ state, ownerSessionId: "foreign-session" }), currentSessionId),
			expected({ stranded: true, ownerMismatch: true, kind: "owner_mismatch" }),
			`foreign-owner stranded ${state}`,
		);
	}

	for (const state of inactiveStates) {
		assert.deepEqual(
			classifyVerificationRecovery(repair({ state }), currentSessionId),
			expected({ kind: "recoverable" }),
			`ownerless inactive ${state}`,
		);
		assert.deepEqual(
			classifyVerificationRecovery(repair({ state, ownerSessionId: currentSessionId }), currentSessionId),
			expected({ kind: "recoverable" }),
			`current-owner inactive ${state}`,
		);
	}

	for (const classification of ["design_ambiguity", "scope_ambiguity", "credential", "product_ambiguity"] as const) {
		assert.deepEqual(
			classifyVerificationRecovery(repair({ classification }), currentSessionId),
			expected({ actionable: true, ambiguity: true, kind: "decision_required" }),
			classification,
		);
	}

	assert.deepEqual(
		classifyVerificationRecovery(repair({ classification: "code_defect", acceptedCodeRounds: 3, round: 1 }), currentSessionId),
		expected({ actionable: true, atLimit: true, kind: "decision_required" }),
		"code-defect accepted round limit",
	);
	assert.deepEqual(
		classifyVerificationRecovery(repair({ classification: "code_defect", round: 3 }), currentSessionId),
		expected({ actionable: true, atLimit: true, kind: "decision_required" }),
		"code-defect round fallback limit",
	);
	assert.deepEqual(
		classifyVerificationRecovery(repair({ classification: "code_defect", acceptedCodeRounds: 2, round: 2 }), currentSessionId),
		expected({ actionable: true, kind: "recoverable" }),
		"code-defect below limit",
	);

	for (const state of ["available", "failed"] as const) {
		assert.deepEqual(
			classifyVerificationRecovery(repair({ state, classification: "transient", transientRetryUsed: true }), currentSessionId),
			expected({ actionable: true, atLimit: true, kind: "decision_required" }),
			`transient retry used in ${state}`,
		);
	}

	assert.deepEqual(
		classifyVerificationRecovery(repair({ classification: "transient", transientRetryUsed: false }), currentSessionId),
		expected({ actionable: true, kind: "recoverable" }),
		"transient retry still available",
	);
	assert.deepEqual(
		classifyVerificationRecovery(repair({ state: "paused", classification: "transient", transientRetryUsed: true }), currentSessionId),
		expected({ actionable: true, kind: "recoverable" }),
		"paused transient repair is not an exhausted available/failed retry",
	);
	assert.deepEqual(
		classifyVerificationRecovery(repair({ classification: "manifest_error" }), currentSessionId),
		expected({ actionable: true, kind: "recoverable" }),
		"manifest error remains recoverable",
	);

	assert.deepEqual(
		classifyVerificationRecovery(repair({ ownerSessionId: "foreign-session", classification: "design_ambiguity", state: "active" }), currentSessionId),
		expected({ stranded: true, ownerMismatch: true, ambiguity: true, kind: "owner_mismatch" }),
		"owner mismatch takes precedence",
	);
	assert.deepEqual(
		classifyVerificationRecovery(repair({ classification: "design_ambiguity", round: 3 }), currentSessionId),
		expected({ actionable: true, ambiguity: true, kind: "decision_required" }),
		"ambiguity and exhausted repairs are never recoverable",
	);
});


test("initial selection guidance binds V phases and T evidence without turning probes/setup into gates", () => {
	const prompt = FINAL_VERIFICATION_SELECTION_GUIDANCE.join("\n");
	for (const term of ["compiled assignment", "Phase/Criteria/Toolchain/Command/Expected", "Owner/Cwd/Prerequisites/Probe/Evidence", "final-phase coverage", "integration-risk", "development diagnostics", "uv run --no-sync", "nix develop --command", "canonical package script", "minimal environment", "interactive HOME", "npm-only locked auto-preparation"]) assert.ok(prompt.includes(term), term);
	assert.match(prompt, /probes.*only as selection diagnostics/);
	assert.match(prompt, /Only the manager executes.*authoritative verification gates/);
	assert.match(prompt, /do not fabricate passed checks or submit a known-invalid tool choice/);
});
