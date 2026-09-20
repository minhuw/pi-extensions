import assert from "node:assert/strict";
import test from "node:test";
import { normalizeReviewerFindings, reviewFindingContractsFromSpecs, validateReviewFindings, validateReviewerResult, validateJudgeFindings, type ReviewFindingContract } from "../../../src/core/review-findings.ts";
import { parseWorkerResult, ATTENTION_CAUSES } from "../../../src/shared/protocol.ts";
import { fixturePlan } from "../../support/plan-v2.ts";

const contracts: readonly ReviewFindingContract[] = Object.freeze([
	Object.freeze({ planId: "001", acceptanceIds: Object.freeze(["A1"]), verificationIds: Object.freeze(["V1"]), boundaryText: "**Out of scope**\nDo not change the public API." }),
]);
const fields = "obligation=A1; evidence=src/value.ts:3 returns null for input 0; violation=null violates the required integer result";
const finding = `[F001][P1][BLOCKING][PLAN_REQUIREMENT] incorrect result; ${fields}`;
const judge = () => ({ decision: "REPAIR" as const, findings: [`[F001][BLOCKING_IN_SCOPE][PLAN_REQUIREMENT] retain; ${fields}`], authorizedBlockers: ["F001"], repairContracts: ["[F001] restore the integer result"] });

test("validated failure binds approved acceptance/verification IDs, including aggregate qualified IDs", () => {
	assert.equal(validateReviewFindings([finding], contracts)[0]?.id, "F001");
	for (const id of ["V1", "001:A1", "001:V1"]) assert.equal(validateReviewFindings([finding.replace("obligation=A1", `obligation=${id}`)], contracts).length, 1);
	const aggregate = [...contracts, { ...contracts[0]!, planId: "002" }];
	assert.throws(() => validateReviewFindings([finding], aggregate), /aggregate obligations/);
	assert.equal(validateReviewFindings([finding.replace("obligation=A1", "obligation=002:A1")], aggregate).length, 1);
});

test("unknown/missing obligations, evidence and causal fields fail closed", () => {
	for (const id of ["A2", "V2", "999:A1", "T1", "public API"]) assert.throws(() => validateReviewFindings([finding.replace("obligation=A1", `obligation=${id}`)], contracts), /Review finding protocol/);
	for (const name of ["obligation", "evidence", "violation"]) {
		assert.throws(() => validateReviewFindings([finding.replace(new RegExp(`; ${name}=[^;]+`), "")], contracts), new RegExp(`missing ${name}`));
		assert.throws(() => validateReviewFindings([finding.replace(new RegExp(`${name}=[^;]+`), `${name}=unknown`)], contracts), /missing concrete/);
	}
	assert.throws(() => validateReviewFindings([`${finding}; obligation=A1`], contracts), /duplicate obligation/);
});

test("constraints quote exact frozen boundary lines, not synthetic labels or substrings", () => {
	assert.equal(validateReviewFindings([finding.replace("obligation=A1", "obligation=constraint:Do not change the public API.")], contracts).length, 1);
	for (const quote of ["API stability", "public API", "Keep API unchanged"]) assert.throws(() => validateReviewFindings([finding.replace("obligation=A1", `obligation=constraint:${quote}`)], contracts), /exact frozen Boundaries/);
});

test("incidental followups remain compatible and never become repair authority", () => {
	for (const advisory of ["legacy advisory prose", "[NEW][P2][ADVISORY][FOLLOWUP] incidental formatting"]) assert.deepEqual(validateReviewFindings([advisory], contracts), []);
	for (const changed of [finding.replace("PLAN_REQUIREMENT", "FOLLOWUP"), finding.replace("P1", "P2"), "[BLOCKING][P1] old ambiguous blocker"]) assert.throws(() => validateReviewFindings([changed], contracts), /blocker requires/);
	assert.throws(() => validateJudgeFindings(judge(), [finding.replace("[BLOCKING]", "[ADVISORY]")], contracts), /validated reviewer evidence/);
});

test("judge authorization binds validated evidence and cannot invent obligations or repair IDs", () => {
	validateJudgeFindings(judge(), [finding], contracts);
	for (const field of ["obligation=A1", "evidence=src/value.ts:3 returns null for input 0", "violation=null violates the required integer result"]) {
		const changed = judge(); changed.findings[0] = changed.findings[0]!.replace(field, `${field} invented`);
		assert.throws(() => validateJudgeFindings(changed, [finding], contracts), /must retain validated/);
	}
	assert.throws(() => validateJudgeFindings({ ...judge(), authorizedBlockers: ["F999"] }, [finding], contracts), /unbound/);
	assert.throws(() => validateJudgeFindings({ ...judge(), findings: [] }, [finding], contracts), /lacks a bound disposition/);
	assert.throws(() => validateJudgeFindings({ ...judge(), repairContracts: ["[F999] invented repair"] }, [finding], contracts), /requires one repair contract/);
	assert.throws(() => validateJudgeFindings({ ...judge(), decision: "DONE" }, [finding], contracts), /only REPAIR/);
});

test("contract extraction reads compiled Markdown with optional frozen shared context", () => {
	const local = fixturePlan({ head: "abcdef12" });
	const assignment = { snapshotSha256: "a".repeat(64), snapshotInputs: [], plan: { id: "001", title: "fixture", kind: null, parentObjective: null, dependencies: [], inScopePaths: [] }, planText: local };
	const plain = reviewFindingContractsFromSpecs([{ planId: "001", assignment }]);
	assert.deepEqual(plain[0]?.acceptanceIds, ["A1"]);
	assert.ok(!plain[0]?.boundaryText.includes("**Out of scope**"));
	const compiled = `<!-- herder-snapshot:shared-context -->\n# Shared context\nFrozen facts.\n<!-- herder-snapshot:local-plan -->\n${local}`;
	assert.deepEqual(reviewFindingContractsFromSpecs([{ planId: "001", assignment: { ...assignment, planText: compiled } }]), plain);
	const tableStart = local.indexOf("| ID | Owner |");
	const tableEnd = local.indexOf("\n\n", tableStart);
	const toolchainTable = local.slice(tableStart, tableEnd);
	const shared = `<!-- herder-snapshot:shared-context -->\n${toolchainTable}\n<!-- herder-snapshot:local-plan -->\n${local.replace(toolchainTable, "")}`;
	assert.deepEqual(reviewFindingContractsFromSpecs([{ planId: "001", assignment: { ...assignment, planText: shared } }]), plain);
});


test("commented and fenced boundary examples cannot authorize blocking findings", () => {
	const planText = fixturePlan({ head: "abcdef12" }).replace("**Out of scope**:", [
		"**Out of scope**:", "Do not change the public API.",
		"<!--", "Require a new dashboard.", "-->",
		"```text", "Require browser hardening.", "```", "### Examples",
	].join("\n"));
	const frozen = reviewFindingContractsFromSpecs([{ planId: "001", assignment: {
		snapshotSha256: "a".repeat(64), snapshotInputs: [],
		plan: { id: "001", title: "fixture", kind: null, parentObjective: null, dependencies: [], inScopePaths: [] }, planText,
	} }]);
	for (const quote of ["Require a new dashboard.", "Require browser hardening.", "### Examples", "**Out of scope**:"]) {
		assert.throws(() => validateReviewFindings([finding.replace("obligation=A1", `obligation=constraint:${quote}`)], frozen), /exact frozen Boundaries/);
	}
	assert.equal(validateReviewFindings([finding.replace("obligation=A1", "obligation=constraint:Do not change the public API.")], frozen).length, 1);
});

test("verdicts cannot turn followups or scope failure into repair or approval", () => {
	const incidental = "[NEW][P2][ADVISORY][FOLLOWUP] incidental formatting";
	for (const findings of [[], [incidental]]) {
		assert.deepEqual(validateReviewerResult({ verdict: "REVISE", scope: "PASS", findings }, contracts), [], "Reviewer observations do not authorize repair");
		assert.deepEqual(validateReviewerResult({ verdict: "APPROVE", scope: "PASS", findings }, contracts), []);
	}
	assert.throws(() => validateReviewerResult({ verdict: "APPROVE", scope: "FAIL", findings: [] }, contracts), /APPROVE requires/);
	assert.throws(() => validateReviewerResult({ verdict: "APPROVE", scope: "PASS", findings: [finding] }, contracts), /APPROVE requires/);
	assert.deepEqual(validateReviewerResult({ verdict: "BLOCK", scope: "PASS", findings: [] }, contracts), []);
	assert.equal(validateReviewerResult({ verdict: "REVISE", scope: "PASS", findings: [finding] }, contracts, true).length, 1);
	assert.throws(() => validateJudgeFindings(judge(), [finding], contracts, [], true), /aggregate obligations/);
});

test("safety uses blocked envelopes with concrete evidence, and protocol attention is distinct", () => {
	const response = "VERDICT: BLOCK\nBLOCKER_KIND: SAFETY\nSCOPE: PASS\nCHECKS: destructive probe refused in frozen worktree\nRATIONALE: probe would delete customer data";
	assert.equal(parseWorkerResult("plan-reviewer", response).blockerKind, "SAFETY");
	assert.throws(() => parseWorkerResult("plan-reviewer", response.replace("VERDICT: BLOCK", "VERDICT: APPROVE")), /blocked worker outcome/);
	assert.throws(() => parseWorkerResult("plan-reviewer", response.replace("CHECKS: destructive probe refused in frozen worktree", "CHECKS: none")), /concrete detail/);
	assert.ok(ATTENTION_CAUSES.includes("worker_protocol_error"));
});


test("legacy NEW can bind only when unique; contradictory judge dispositions fail", () => {
	const result = judge();
	result.findings = result.findings.map((entry) => entry.replace("F001", "NEW"));
	result.authorizedBlockers = ["NEW"];
	result.repairContracts = ["[NEW] fix integer result"];
	const fresh = finding.replace("F001", "NEW");
	validateJudgeFindings(result, [fresh], contracts);
	assert.throws(() => validateJudgeFindings(result, [fresh, fresh], contracts), /unambiguous validated/);
	assert.throws(() => validateJudgeFindings({ ...judge(), findings: [...judge().findings, "[F001][REJECTED][INVALID] no defect"] }, [finding], contracts), /exactly one disposition/);
});


test("blocked judges may retain validated blockers without granting repair authority", () => {
	const stopped = { ...judge(), decision: "BLOCKED" as const, authorizedBlockers: [], repairContracts: [] };
	validateJudgeFindings(stopped, [finding], contracts);
	assert.throws(() => validateJudgeFindings(stopped, [], contracts), /validated reviewer evidence/);
	assert.throws(() => validateJudgeFindings({ ...stopped, decision: "DONE" }, [finding], contracts), /unbound/);
});


test("Judge must dispose all concrete findings and cannot revive unchanged exclusions", () => {
	const unknown = finding.replace("obligation=A1", "obligation=unknown");
	validateReviewerResult({ verdict: "REVISE", scope: "PASS", findings: [unknown] }, contracts);
	const done = { decision: "DONE" as const, authorizedBlockers: [], repairContracts: [], findings: ["[F001][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] unrelated preexisting behavior"] };
	validateJudgeFindings(done, [unknown], contracts);
	assert.throws(() => validateJudgeFindings({ ...done, findings: [] }, [unknown], contracts), /exactly one disposition/);
	assert.throws(() => validateJudgeFindings(judge(), [unknown], contracts), /invalid obligation/);
	assert.throws(() => validateJudgeFindings(judge(), [finding], contracts, [finding]), /excluded finding/);
	const changed = finding.replace("src/value.ts:3", "src/value.ts:9").replace("PLAN_REQUIREMENT", "PATCH_REGRESSION");
	const revived = { ...judge(), findings: [judge().findings[0]!.replace("src/value.ts:3", "src/value.ts:9").replace("PLAN_REQUIREMENT", "PATCH_REGRESSION")] };
	assert.throws(() => validateJudgeFindings(revived, [changed], contracts, [finding]), /regression_rationale/);
	revived.findings[0] += "; regression_rationale=new patch introduced this separate regression";
	validateJudgeFindings(revived, [changed], contracts, [finding]);
});


test("NEW IDs persist deterministically, retain observations and map only unambiguous guidance", () => {
	const parsed = parseWorkerResult("plan-reviewer", `VERDICT: REVISE\nFINDINGS: ${finding.replace("F001", "NEW")}\nFIX_GUIDANCE: [NEW] fix integer result\nSCOPE: PASS\nCHECKS: fixture passed\nRATIONALE: verified`);
	assert.equal(parsed.kind, "reviewer");
	if (parsed.kind !== "reviewer") throw new Error("not reviewer");
	const normalized = normalizeReviewerFindings(parsed, "action-1");
	const id = normalized.findings[0]!.match(/^\[([^\]]+)\]/)![1]!;
	assert.match(id, /^F-[a-f0-9]{64}-1$/);
	assert.deepEqual(normalizeReviewerFindings(parsed, "action-1"), normalized);
	assert.deepEqual(normalizeReviewerFindings(normalized, "action-1"), normalized);
	assert.deepEqual(normalizeReviewerFindings(parsed, "action-2", normalized.findings), normalized);
	assert.deepEqual(normalized.fixGuidance, [`[${id}] fix integer result`]);
	assert.equal(parsed.findings[0], finding.replace("F001", "NEW"), "raw parser output remains unchanged");
	const multiple = normalizeReviewerFindings({ ...parsed, findings: [parsed.findings[0]!, "[NEW][P2][ADVISORY][FOLLOWUP] formatting", finding] }, "action-1");
	assert.equal(multiple.findings[2], finding);
	assert.notEqual(multiple.findings[0], multiple.findings[1]);
	assert.deepEqual(multiple.fixGuidance, parsed.fixGuidance, "ambiguous guidance stays unbound");
});

test("historical ADVISORY evidence can reopen only as a changed introduced PATCH_REGRESSION", () => {
	const prior = finding.replace("[BLOCKING][PLAN_REQUIREMENT]", "[ADVISORY][FOLLOWUP]");
	const current = finding.replace("PLAN_REQUIREMENT", "PATCH_REGRESSION");
	const disposition = judge().findings[0]!.replace("PLAN_REQUIREMENT", "PATCH_REGRESSION");
	const rationale = "; regression_rationale=repair introduced a new null path";
	assert.throws(() => validateJudgeFindings({ ...judge(), findings: [disposition + rationale] }, [current], contracts, [prior]), /excluded finding/);
	const changed = current.replace("input 0", "input 1");
	const reopened = { ...judge(), findings: [disposition.replace("input 0", "input 1") + rationale] };
	validateJudgeFindings(reopened, [changed], contracts, [prior]);
	for (const text of ["none", "unknown", "please fix this", ""]) {
		assert.throws(() => validateJudgeFindings({ ...reopened, findings: [reopened.findings[0]!.replace("repair introduced a new null path", text)] }, [changed], contracts, [prior]), /excluded finding/);
	}
	assert.throws(() => validateJudgeFindings({ ...reopened, findings: reopened.findings.map(f => f.replace("PATCH_REGRESSION", "PLAN_REQUIREMENT")) }, [changed.replace("PATCH_REGRESSION", "PLAN_REQUIREMENT")], contracts, [prior]), /excluded finding/);
	assert.throws(() => validateJudgeFindings({ ...judge(), findings: [disposition.replace("F001", "NEW") + rationale], authorizedBlockers: ["NEW"], repairContracts: ["[NEW] fix"] }, [current.replace("F001", "NEW")], contracts, [prior]), /excluded finding/);
});
