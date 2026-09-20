import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { git } from "../../../src/daemon/git-driver.ts";
import { grantHostAttention } from "../../../src/core/run-revision.ts";
import { attentionCapabilityToken, type ManagerAttentionRequest, type ManagerAction, type ManagerReply } from "../../../src/shared/protocol.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";

function attentionResolutionFromRequest(request: ManagerAttentionRequest) {
	const recovery = "recovery" in request ? request.recovery : undefined;
	return { schemaVersion: 1 as const, requestId: request.requestId, requestSha256: request.requestSha256,
		capabilityToken: request.capabilityToken ?? attentionCapabilityToken(request.requestId), runId: request.runId,
		planId: request.planId, generation: request.generation, round: request.round, continuation: request.continuation,
		...(recovery ? { git: { assignmentPath: recovery.assignmentPath, assignmentSha256: recovery.assignmentSha256,
			snapshotSha256: recovery.snapshotSha256, generationBase: recovery.generationBase, branch: recovery.branch,
			worktree: recovery.worktree, worktreeHead: recovery.worktreeHead, worktreeTree: recovery.worktreeTree } } : {}) };
}

function fixture(writePaths = ["src/value.mjs"]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-agreed-loop-"));
	const { repo, originalHead } = initFixtureRepo(root, { name: "YOLO fixture", email: "test@example.invalid",
		files: { "src/value.mjs": "export const value = 1;\n", "src/other.mjs": "export const other = 1;\n" } });
	const directory = path.join(repo, "herder-plans");
	initPlanDir(directory);
	fs.writeFileSync(path.join(directory, "README.md"), "# Plans\n\n## Execution order & status\n\n| Plan | Title | Priority | Effort | Depends on | Status |\n|---|---|---|---|---|---|\n| [001](001-value.md) | Value | P1 | S | — | TODO |\n\n## Dependency notes\n\nNone.\n\n## Considered and rejected\n\nNone.\n");
	fs.writeFileSync(path.join(directory, "001-value.md"), fixturePlan({ head: originalHead, writePaths }));
	return { root, repo, directory, originalHead, input: { mode: "fire" as const, repositoryRoot: repo, planDirectory: directory, profile: "eclipse", maxParallel: 1 } };
}
const complete = "STATUS: COMPLETE\nCOMMITS: fixture commit\nCHECKS: passed\nFILES CHANGED: src/value.mjs\nDISCOVERED_PATHS: none\nNOTES: implemented";
const approve = "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: passed\nRATIONALE: focused outcome passes";
async function terminal(manager: HerderRunManager, action: ManagerAction, response = complete, extra = {}) {
	await manager.event({ eventId: `dispatch:${action.actionId}`, kind: "dispatch_results", dispatchResults: [{ actionId: action.actionId, accepted: true, hostHandle: action.actionId }] });
	return manager.event({ eventId: `terminal:${action.actionId}`, kind: "terminals", terminals: [{ actionId: action.actionId, hostHandle: action.actionId, response, ...extra }] });
}
function commit(action: ManagerAction, edit = () => fs.writeFileSync(path.join(action.worktree, "src/value.mjs"), "export const value = 2;\n")) {
	edit();
	git(action.worktree, ["add", "-A"]);
	git(action.worktree, ["commit", "-qm", "fixture implementation"]);
}
function manifest(reply: ManagerReply, argv = [process.execPath, "-e", "process.exit(0)"]) {
	const request = reply.verificationRequest!;
	assert.ok(request);
	return { schemaVersion: 1 as const, requestId: request.requestId, requestSha256: request.requestSha256, runId: request.runId,
		generation: request.generation, graphSha256: request.graphSha256, runAssignmentSha256: request.runAssignmentSha256,
		integrationHead: request.integrationHead, integrationTree: request.integrationTree, rationale: "Verify the exact synthetic integration tree.",
		gates: [{ gateId: "fixture", label: "fixture gate", cwd: ".", argv, rationale: "Bounded fixture check." }] };
}

const done = "DECISION: DONE\nFINDINGS: none\nAUTHORIZED_BLOCKERS: none\nREPAIR_CONTRACTS: none\nLEAKS: none\nCHECKS: passed\nRATIONALE: original contract satisfied";
const input = done.replace("DECISION: DONE", "DECISION: NEEDS_INPUT") + "\nQUESTION: Accept the preserved outcome?";
const fields = "obligation=A1; evidence=src/value.mjs:1 unexpected value; violation=approved fixture result not met";
const revise = approve.replace("VERDICT: APPROVE", "VERDICT: REVISE").replace("FINDINGS: none", `FINDINGS: [F001][P1][BLOCKING][PLAN_REQUIREMENT] defect; ${fields}`);
const repair = done.replace("DECISION: DONE", "DECISION: REPAIR").replace("FINDINGS: none", `FINDINGS: [F001][BLOCKING_IN_SCOPE][PLAN_REQUIREMENT] repair; ${fields}`).replace("AUTHORIZED_BLOCKERS: none", "AUTHORIZED_BLOCKERS: F001").replace("REPAIR_CONTRACTS: none", "REPAIR_CONTRACTS: [F001] Fix only the bound result") + "\nPASS_DOCUMENT: Fix the result under the unchanged assignment and rerun its check.";

async function review(manager: HerderRunManager, action: ManagerAction, response = approve) {
	commit(action, () => fs.writeFileSync(path.join(action.worktree, "src/value.mjs"), `export const value = ${action.round + 1};\n`));
	let reply = await terminal(manager, action);
	return terminal(manager, reply.actions[0], response);
}

for (const decision of ["DONE", "NEEDS_INPUT", "REPAIR"] as const) test(`final RUN requires Judge; ${decision} never bypasses passed verification`, async () => {
	const f = fixture(); const manager = new HerderRunManager(f.directory);
	try {
		let reply = await manager.start(f.input);
		reply = await review(manager, reply.actions[0]);
		assert.equal(reply.actions[0].role, "plan-judge");
		reply = await terminal(manager, reply.actions[0], done);
		reply = await manager.verification(manifest(reply));
		reply = await terminal(manager, reply.actions[0], decision === "REPAIR" ? revise.replace("obligation=A1", "obligation=001:A1") : approve);
		assert.equal(reply.actions[0].role, "plan-judge");
		assert.equal(reply.actions[0].planId, "RUN");
		assert.notEqual(reply.status, "complete");
		reply = await terminal(manager, reply.actions[0], decision === "DONE" ? done : decision === "REPAIR" ? repair.replace("obligation=A1", "obligation=001:A1") : input);
		assert.deepEqual(reply.actions, []);
		if (decision === "DONE") assert.equal(reply.status, "complete");
		else {
			assert.equal(reply.status, "needs_input");
			const resolution = { ...attentionResolutionFromRequest(reply.attention!), action: "accept", confirmed: true, answer: "Accept the preserved unresolved audit finding.", rationale: "Explicit host choice for this verified tree." };
			grantHostAttention(manager.store.getRun()!, resolution);
			reply = await manager.event({ eventId: "accept-final", kind: "attention", attention: resolution });
			assert.equal(reply.status, "complete");
			assert.match(reply.message, /accepted as-is/);
			assert.equal(manager.store.getApproval(reply.runId, "RUN", 1)?.decisionRole, "user");
		}
	} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const recovery of [false, true]) for (const choice of ["accept", "reject"] as const) test(`host ${choice} for ${recovery ? "plan recovery" : "user decision"} binds request/tree, rejects stale/replay and never invents a verdict`, async () => {
	const f = fixture(); const manager = new HerderRunManager(f.directory);
	try {
		let reply = await manager.start(f.input);
		reply = await review(manager, reply.actions[0]);
		reply = await terminal(manager, reply.actions[0], recovery ? done.replace("DECISION: DONE", "DECISION: BLOCKED") : input);
		const before = manager.store.getPlan(reply.runId, "001")!;
		const count = manager.store.getActions(reply.runId).length;
		const resolution = { ...attentionResolutionFromRequest(reply.attention!), action: choice, confirmed: true, answer: "Preserve the unresolved findings and unknown checks.", rationale: "Exact private host decision." };
		await assert.rejects(manager.event({ eventId: "stale-request", kind: "attention", attention: { ...resolution, requestSha256: "f".repeat(64) } }), /hash does not match/);
		await assert.rejects(manager.event({ eventId: "no-grant", kind: "attention", attention: resolution }), /host grant/);
		grantHostAttention(manager.store.getRun()!, resolution);
		fs.writeFileSync(path.join(before.worktree, "src/value.mjs"), "dirty\n");
		if (choice === "accept") {
			await assert.rejects(manager.event({ eventId: "dirty", kind: "attention", attention: resolution }), /clean frozen/);
			git(before.worktree, ["restore", "src/value.mjs"]);
		}
		reply = await manager.event({ eventId: "decide", kind: "attention", attention: resolution });
		await manager.event({ eventId: "same-resolution", kind: "attention", attention: resolution });
		await assert.rejects(manager.event({ eventId: "changed-resolution", kind: "attention", attention: { ...resolution, rationale: "different" } }), /replayed with a different resolution/);
		const after = manager.store.getPlan(reply.runId, "001")!;
		assert.equal(manager.store.getActions(reply.runId).length, count);
		assert.equal(after.branch, before.branch);
		assert.equal(after.worktree, before.worktree);
		if (choice === "accept") {
			assert.equal(after.phase, "DONE");
			assert.equal(manager.store.getApproval(reply.runId, "001", 1)?.decisionRole, "user");
			assert.ok(reply.verificationRequest);
		} else {
			assert.equal(after.phase, "BLOCKED");
			assert.equal(fs.readFileSync(path.join(after.worktree, "src/value.mjs"), "utf8"), "dirty\n");
			assert.match(after.repair.join(" "), /DROPPED_BY_USER/);
			reply = await manager.resume({ ...f.input, mode: "resume" });
			assert.equal(reply.status, "paused");
			assert.deepEqual(reply.actions, []);
			assert.equal(reply.attention, undefined);
		}
	} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("host retry requires Judge repair and a separate exhausted-allocation grant", async () => {
	const f = fixture(); const manager = new HerderRunManager(f.directory);
	try {
		let reply = await manager.start(f.input);
		for (let round = 1; round <= 3; round++) {
			reply = await review(manager, reply.actions[0], revise);
			reply = await terminal(manager, reply.actions[0], repair);
		}
		assert.equal(reply.status, "paused");
		const request = reply.attention!;
		const resolution = { ...attentionResolutionFromRequest(request), action: "retry", rationale: "One bounded attempt, unchanged contract." };
		grantHostAttention(manager.store.getRun()!, resolution);
		reply = await manager.event({ eventId: "exhausted-retry", kind: "attention", attention: resolution });
		assert.deepEqual(reply.actions, []);
		assert.match(reply.executionBudget!.stopReason!, /implementation budget exhausted/);
		const run = manager.store.getRun()!;
		manager.store.grantBudget({ requestId: "separate-grant", runId: run.runId, generation: run.currentGeneration, graphSha256: run.graphSha256, amount: 3, planId: "001", implementationRounds: 1 });
		reply = await manager.resume({ ...f.input, mode: "resume" });
		assert.equal(reply.actions[0].role, "plan-implementer");
		assert.equal(reply.actions[0].round, 3);
		assert.deepEqual(manager.store.getPlan(run.runId, "001")!.repair, ["[F001] Fix only the bound result"]);
	} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("accept-as-is preserves exhausted dispatch allocation and does not bypass final verification", async () => {
	const f = fixture(); const manager = new HerderRunManager(f.directory);
	try {
		let reply = await manager.start(f.input);
		reply = await review(manager, reply.actions[0]);
		reply = await terminal(manager, reply.actions[0], input);
		const run = manager.store.getRun()!;
		const initial = manager.store.getBudget(run.runId)!;
		for (let index = initial.used; index < initial.limit; index++) manager.store.reserveBudget({ runId: run.runId, generation: run.currentGeneration, reservationId: `test-unit:${index}`, kind: "verification", payloadSha256: "a".repeat(64) });
		assert.throws(() => manager.store.reserveBudget({ runId: run.runId, generation: run.currentGeneration, reservationId: "test-exhausted", kind: "verification", payloadSha256: "a".repeat(64) }), /budget exhausted/);
		const before = manager.store.getBudget(run.runId)!;
		const resolution = { ...attentionResolutionFromRequest(reply.attention!), action: "accept", confirmed: true, answer: "Accept this exact reviewed patch only.", rationale: "Final verification remains mandatory." };
		grantHostAttention(run, resolution);
		reply = await manager.event({ eventId: "budget-accept", kind: "attention", attention: resolution });
		assert.equal(reply.status, "paused");
		assert.deepEqual(reply.actions, []);
		assert.deepEqual(manager.store.getBudget(run.runId), before);
		assert.equal(manager.store.getPlan(run.runId, "001")!.phase, "READY_TO_INTEGRATE");
		assert.equal(manager.store.getApproval(run.runId, "001", 1)?.decisionRole, "user");
		assert.equal(manager.store.getVerification(run.runId, 1), null);
	} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("excluded findings survive restart and unchanged evidence cannot authorize a later repair", async () => {
	const f = fixture(); let manager = new HerderRunManager(f.directory);
	try {
		let reply = await manager.start(f.input);
		reply = await review(manager, reply.actions[0], revise.replace("FIX_GUIDANCE:", `[F900][P1][BLOCKING][PLAN_REQUIREMENT] unrelated; ${fields}\nFIX_GUIDANCE:`));
		reply = await terminal(manager, reply.actions[0], repair.replace("AUTHORIZED_BLOCKERS:", "[F900][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] preexisting and unrelated\nAUTHORIZED_BLOCKERS:"));
		manager.close(); manager = new HerderRunManager(f.directory);
		reply = manager.reply();
		assert.match(reply.actions[0].prompt, /CUMULATIVE_EXCLUDED_FINDINGS:.*F900/);
		reply = await review(manager, reply.actions[0], revise.replaceAll("F001", "F900"));
		reply = await terminal(manager, reply.actions[0], repair.replaceAll("F001", "F900"));
		assert.equal(reply.attention?.cause, "worker_protocol_error");
		assert.match(reply.attention!.detail, /excluded finding F900/);
		assert.deepEqual(reply.actions, []);
		assert.equal(manager.store.getPlan(reply.runId, "001")!.round, 2);
	} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
