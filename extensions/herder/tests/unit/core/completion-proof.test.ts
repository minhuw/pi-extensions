import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	buildCompletionProofPayload,
	inspectCompletionProof,
	writeCompletionProof,
	type ApprovalCore,
} from "../../../src/daemon/git/completion-proof.ts";
import { attentionCapabilityToken, sha256, stableJson, type AttentionResolutionInput } from "../../../src/shared/protocol.ts";

const core: ApprovalCore = {
	runId: "run-1", planId: "001", generation: 1, round: 3,
	reviewerActionId: "reviewer-3", decisionActionId: "reviewer-3", decisionRole: "plan-reviewer",
	assignmentSha256: "a".repeat(64), approvedBase: "b".repeat(40), approvedHead: "c".repeat(40), approvedTree: "d".repeat(40),
	reviewResultSha256: "e".repeat(64), decisionResultSha256: "e".repeat(64),
};

function userCore(approval = core): ApprovalCore & { userAcceptance: AttentionResolutionInput } {
	const userAcceptance: AttentionResolutionInput = {
		schemaVersion: 1, requestId: "attention-3", requestSha256: "f".repeat(64), capabilityToken: attentionCapabilityToken("attention-3"),
		runId: approval.runId, planId: approval.planId, generation: approval.generation, round: approval.round,
		action: "accept", confirmed: true, answer: "Waive the missing optional regression check.", rationale: "The reviewed implementation is sufficient.",
		git: {
			assignmentPath: "/tmp/assignment.json", assignmentSha256: approval.assignmentSha256, snapshotSha256: "1".repeat(64),
			generationBase: approval.approvedBase, branch: "herder/plan/001", worktree: "/tmp/worktree",
			worktreeHead: approval.approvedHead, worktreeTree: approval.approvedTree,
		},
	};
	return { ...approval, decisionRole: "user", userAcceptance, decisionResultSha256: sha256(stableJson(userAcceptance)) };
}

test("round-three worker proofs retain their exact optional-free hash shape and reject round four", () => {
	for (const decisionRole of ["plan-reviewer", "plan-judge"] as const) {
		const approval = { ...core, decisionRole };
		const proof = buildCompletionProofPayload({ ...approval, integratedHead: core.approvedHead });
		assert.deepEqual(proof, { schemaVersion: 1, ...approval, approvalProofSha256: sha256(stableJson(approval)), integratedHead: core.approvedHead });
		assert.equal(Object.hasOwn(proof, "userAcceptance"), false);
		assert.throws(() => buildCompletionProofPayload({ ...approval, round: 4, integratedHead: core.approvedHead }), /invalid approval identity/);
		assert.throws(() => buildCompletionProofPayload({ ...proof, approvalProofSha256: "0".repeat(64) }), /approval proof hash changed/);
		assert.throws(() => buildCompletionProofPayload({ ...proof, userAcceptance: userCore().userAcceptance }), /only user completion decisions/);
	}
});

test("user proofs bind explicit confirmed waivers and every frozen approval identity", () => {
	const approval = userCore();
	const proof = buildCompletionProofPayload({ ...approval, integratedHead: core.approvedHead });
	assert.deepEqual(proof.userAcceptance, approval.userAcceptance);
	assert.equal(proof.approvalProofSha256, sha256(stableJson(approval)));
	assert.throws(() => buildCompletionProofPayload({ ...proof, userAcceptance: undefined }), /Attention resolution must be an object/);
	assert.throws(() => buildCompletionProofPayload({ ...proof, round: 4 }), /invalid approval identity/);
	assert.throws(() => buildCompletionProofPayload({ ...approval, decisionActionId: "fabricated-user", integratedHead: core.approvedHead }), /acceptance does not match/);
	for (const patch of [
		{ action: "stop" }, { runId: "other-run" }, { planId: "002" }, { generation: 2 }, { round: 2 },
		{ git: undefined },
		...["assignmentSha256", "generationBase", "worktreeHead", "worktreeTree"].map((field) => ({
			git: { ...approval.userAcceptance.git!, [field]: "0".repeat(field === "assignmentSha256" ? 64 : 40) },
		})),
	]) {
		const acceptance = { ...approval.userAcceptance, ...patch };
		assert.throws(() => buildCompletionProofPayload({
			...approval, userAcceptance: acceptance, decisionResultSha256: sha256(stableJson(acceptance)), integratedHead: core.approvedHead,
		}), /acceptance does not match/);
	}
	for (const patch of [{ confirmed: false }, { answer: " " }, { rationale: " " }]) {
		assert.throws(() => buildCompletionProofPayload({ ...proof, userAcceptance: { ...approval.userAcceptance, ...patch } }), /requires human confirmation/);
	}
	const changed = { ...approval.userAcceptance, answer: "Waive all remaining gaps." };
	assert.throws(() => buildCompletionProofPayload({ ...proof, userAcceptance: changed }), /acceptance does not match/);
	assert.throws(() => buildCompletionProofPayload({ ...proof, userAcceptance: changed, decisionResultSha256: sha256(stableJson(changed)) }), /approval proof hash changed/);
	assert.throws(() => buildCompletionProofPayload({ ...proof, reviewResultSha256: "0".repeat(64) }), /approval proof hash changed/);
	assert.throws(() => buildCompletionProofPayload({ ...proof, decisionResultSha256: "bad" }), /invalid decisionResultSha256/);
});

test("user completion tags round-trip and inspection rejects tampered acceptance", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "herder-user-completion-"));
	const git = (args: string[], input?: string) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", input }).trim();
	try {
		git(["init", "-q"]);
		git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"]);
		const head = git(["rev-parse", "HEAD"]);
		const tree = git(["rev-parse", "HEAD^{tree}"]);
		const approval = userCore({ ...core, approvedBase: head, approvedHead: head, approvedTree: tree });
		const proof = buildCompletionProofPayload({ ...approval, integratedHead: head });
		const ref = "refs/plan-herder/test/completed/001";
		writeCompletionProof(repo, ref, proof);
		const inspected = inspectCompletionProof(repo, ref);
		assert.equal(inspected.ok, true);
		if (inspected.ok) assert.deepEqual(inspected.payload, proof);

		const tag = git(["cat-file", "-p", ref]);
		const tampered = { ...proof, userAcceptance: { ...approval.userAcceptance, answer: "Waive everything." } };
		const object = git(["hash-object", "-t", "tag", "-w", "--stdin"], tag.replace(stableJson(proof), stableJson(tampered)) + "\n");
		git(["update-ref", ref, object]);
		const invalid = inspectCompletionProof(repo, ref);
		assert.equal(invalid.ok, false);
		if (!invalid.ok) assert.match(invalid.error, /acceptance does not match/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
