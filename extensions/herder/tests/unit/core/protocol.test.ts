import assert from "node:assert/strict";
import test from "node:test";
import { canonicalEventPayload, parseWorkerResult } from "../../../src/shared/protocol.ts";

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
