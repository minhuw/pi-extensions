import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { git } from "../../../src/daemon/git-driver.ts";
import { buildCompletionProofPayload, inspectCompletionProof } from "../../../src/daemon/git/completion-proof.ts";
import { EXECUTION_SCHEMA_VERSION } from "../../../src/daemon/execution-store.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { sha256, stableJson, type ManagerAction, type ManagerReply } from "../../../src/shared/protocol.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";

function fixture(writePaths = ["src/value.mjs"]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-yolo-"));
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

for (const yolo of [false, true]) test(`${yolo ? "YOLO" : "normal"} implementation and final verification keep their distinct review flows`, async () => {
	const f = fixture();
	let manager = new HerderRunManager(f.directory);
	try {
		let reply = await manager.start({ ...f.input, ...(yolo ? { yolo } : {}) });
		assert.equal(reply.yolo, yolo);
		const implementer = reply.actions[0];
		commit(implementer);
		reply = await terminal(manager, implementer);
		if (!yolo) {
			assert.equal(reply.actions[0].role, "plan-reviewer");
			reply = await terminal(manager, reply.actions[0], approve);
		}
		assert.equal(reply.status, "paused");
		assert.equal(reply.actions.length, 0);
		const proof = manager.store.getApproval(reply.runId, "001", 1)!;
		assert.equal(proof.decisionRole, yolo ? "plan-implementer" : "plan-reviewer");
		assert.equal(manager.store.getPlan(reply.runId, "001")!.phase, "DONE");
		if (yolo) {
			assert.equal(proof.decisionActionId, implementer.actionId);
			const action = manager.store.getAction(implementer.actionId)!;
			const result = (action.result as { workerResult: unknown }).workerResult;
			assert.equal(proof.decisionResultSha256, sha256(stableJson(result)));
			manager.validateSelectiveApprovals(manager.store.getRun()!);
			// A completion tag explicitly names the Implementer, never a fabricated review.
			const refs = git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/plan-herder/"]).stdout.trim().split("\n");
			assert.ok(refs.some(ref => { const inspected = inspectCompletionProof(f.repo, ref); return inspected.ok && inspected.payload.decisionRole === "plan-implementer"; }));
		}
		const submitted = manifest(reply);
		manager.close();
		manager = new HerderRunManager(f.directory);
		assert.equal(manager.store.getRun()!.yolo, yolo);
		await assert.rejects(manager.start({ ...f.input, mode: "resume", yolo: !yolo }), /preserve YOLO/);
		reply = await manager.start({ ...f.input, mode: "resume" });
		assert.equal(reply.yolo, yolo);
		reply = await manager.verification(submitted);
		if (!yolo) {
			assert.equal(reply.actions[0].planId, "RUN");
			assert.equal(reply.actions[0].role, "plan-reviewer");
			reply = await terminal(manager, reply.actions[0], approve);
		}
		assert.equal(reply.status, "complete");
		assert.equal(manager.store.getPlan(reply.runId, "RUN")!.phase, "FINAL_APPROVED");
		assert.equal(manager.store.getVerification(reply.runId, 1)!.state, "passed");
		assert.equal(manager.store.getActions(reply.runId).filter(a => a.role !== "plan-implementer").length, yolo ? 0 : 2);
		assert.equal(reply.reigniteRequest, undefined);
		if (yolo) assert.match(reply.message, /YOLO accepted.*no independent review/);
		assert.equal(git(f.repo, ["rev-parse", "HEAD"]).stdout.trim(), f.originalHead);
	} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const scenario of ["failed", "unknown", "interrupted", "error", "scope-add", "scope-delete", "scope-rename", "scope-file-subtree"] as const) {
	test(`YOLO does not approve ${scenario}`, async () => {
		const f = fixture();
		const manager = new HerderRunManager(f.directory);
		try {
			const started = await manager.start({ ...f.input, yolo: true });
			const action = started.actions[0];
			commit(action, () => {
				fs.writeFileSync(path.join(action.worktree, "src/value.mjs"), "export const value = 2;\n");
				if (scenario === "scope-add") fs.writeFileSync(path.join(action.worktree, "src/outside.mjs"), "outside\n");
				if (scenario === "scope-delete") fs.rmSync(path.join(action.worktree, "src/other.mjs"));
				if (scenario === "scope-rename") { fs.rmSync(path.join(action.worktree, "src/value.mjs")); fs.renameSync(path.join(action.worktree, "src/other.mjs"), path.join(action.worktree, "src/value.mjs")); }
				if (scenario === "scope-file-subtree") { fs.rmSync(path.join(action.worktree, "src/value.mjs")); fs.mkdirSync(path.join(action.worktree, "src/value.mjs")); fs.writeFileSync(path.join(action.worktree, "src/value.mjs", "child"), "not a subtree grant\n"); }
			});
			const reply = await terminal(manager, action, scenario === "failed" ? complete.replace("STATUS: COMPLETE", "STATUS: FAILED") : scenario === "unknown" ? "STATUS: SOMETHING_NEW" : complete,
				scenario === "interrupted" ? { interrupted: true } : scenario === "error" ? { error: "transport failed" } : {});
			assert.notEqual(reply.status, "complete");
			assert.equal(manager.store.getApproval(reply.runId, "001", 1), null);
			assert.equal(manager.store.getActions(reply.runId).every(a => a.role === "plan-implementer"), true);
			if (scenario.startsWith("scope-")) assert.match(manager.store.getPlan(reply.runId, "001")!.repair.join(" "), /YOLO scope violation/);
		} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
	});
}

for (const scenario of ["failed-gate", "changed-head", "dirty-tree"] as const) test(`YOLO final completion rejects ${scenario}`, async () => {
	const f = fixture();
	const manager = new HerderRunManager(f.directory);
	try {
		const started = await manager.start({ ...f.input, yolo: true });
		commit(started.actions[0]);
		let reply = await terminal(manager, started.actions[0]);
		const submitted = manifest(reply, [process.execPath, "-e", scenario === "failed-gate" ? "process.exit(1)" : "process.exit(0)"]);
		if (scenario !== "failed-gate") {
			const worktree = manager.store.getRun()!.integrationWorktree;
			fs.writeFileSync(path.join(worktree, "src/value.mjs"), "changed after request\n");
			if (scenario === "changed-head") { git(worktree, ["add", "-A"]); git(worktree, ["commit", "-qm", "change frozen tree"]); }
			await assert.rejects(manager.verification(submitted), /changed|match|dirty/i);
			reply = manager.reply();
		} else reply = await manager.verification(submitted);
		assert.notEqual(reply.status, "complete");
		assert.equal(manager.store.getPlan(reply.runId, "RUN"), null);
		assert.equal(manager.store.getActions(reply.runId).every(a => a.role === "plan-implementer"), true);
	} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("YOLO proof validation requires persisted mode and unchanged successful Implementer terminal evidence", async () => {
	const f = fixture();
	const manager = new HerderRunManager(f.directory);
	try {
		const started = await manager.start({ ...f.input, yolo: true });
		commit(started.actions[0]);
		const reply = await terminal(manager, started.actions[0]);
		const run = manager.store.getRun()!;
		const action = manager.store.getAction(started.actions[0].actionId)!;
		const original = action.result as { workerResult: { status: string }; terminal: { interrupted: boolean }; outcome: string };
		for (const altered of [{ ...original, workerResult: { ...original.workerResult, status: "FAILED" } }, { ...original, terminal: { ...original.terminal, interrupted: true } }]) {
			manager.store.database.prepare("UPDATE manager_actions SET result_json = ? WHERE action_id = ?").run(JSON.stringify(altered), action.actionId);
			assert.throws(() => manager.validateSelectiveApprovals(run), /YOLO approval/);
		}
		manager.store.database.prepare("UPDATE manager_actions SET result_json = ? WHERE action_id = ?").run(JSON.stringify(original), action.actionId);
		manager.store.database.prepare("UPDATE manager_runs SET yolo = 0").run();
		assert.throws(() => manager.validateSelectiveApprovals(run), /YOLO approval/);
		const proof = manager.store.getApproval(reply.runId, "001", 1)!;
		assert.throws(() => buildCompletionProofPayload({ ...proof, decisionActionId: "another", integratedHead: proof.approvedHead }), /one exact Implementer/);
	} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("YOLO rejects invalid input before creating a run and fails closed on stale review phases", async () => {
	const f = fixture();
	const manager = new HerderRunManager(f.directory);
	try {
		for (const yolo of ["true", 1, null]) await assert.rejects(manager.start({ ...f.input, yolo: yolo as unknown as boolean }), /boolean/);
		assert.equal(manager.store.getRun(), null);
		const reply = await manager.start({ ...f.input, yolo: true });
		const action = reply.actions[0];
		manager.store.markCancelled(action.actionId, { error: "synthetic stale state" });
		const plan = manager.store.getPlan(reply.runId, "001")!;
		for (const phase of ["READY_REVIEWER", "READY_JUDGE"] as const) {
			manager.store.putPlan({ ...plan, phase });
			const resumed = await manager.resume({ ...f.input, mode: "resume" });
			assert.equal(resumed.status, "paused");
			assert.equal(resumed.actions.length, 0);
		}
		assert.equal(manager.store.getActions(reply.runId).every(a => a.role === "plan-implementer"), true);
	} finally { manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("schema20 to schema21 defaults to normal without pausing and preserves approval rows, hashes, budgets and index", async () => {
	const f = fixture();
	const manager = new HerderRunManager(f.directory);
	let closed = false;
	try {
		const started = await manager.start(f.input);
		commit(started.actions[0]);
		let reply = await terminal(manager, started.actions[0]);
		reply = await terminal(manager, reply.actions[0], approve);
		manager.store.updateRun({ status: "running", terminalDetail: "preserve me" });
		const before = manager.store.getRun()!;
		const approval = manager.store.getApproval(reply.runId, "001", 1)!;
		const budget = manager.store.getBudget(reply.runId)!;
		// Materialize a schema20 fixture, including its original restrictive role CHECK.
		const db = manager.store.database;
		const schema = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'manager_approvals'").get() as { sql: string }).sql;
		db.exec(`${schema.replace("CREATE TABLE manager_approvals", "CREATE TABLE old_approvals").replace(", 'plan-implementer'", "")};
			INSERT INTO old_approvals SELECT * FROM manager_approvals; DROP TABLE manager_approvals;
			ALTER TABLE old_approvals RENAME TO manager_approvals; CREATE UNIQUE INDEX manager_approvals_proof ON manager_approvals(proof_sha256);
			ALTER TABLE manager_runs DROP COLUMN yolo; PRAGMA user_version = 20;`);
		manager.close();
		closed = true;
		const migrated = new RunStore(f.directory);
		try {
			assert.equal(EXECUTION_SCHEMA_VERSION, 21);
			assert.equal(migrated.database.prepare("PRAGMA user_version").get()!.user_version, 21);
			assert.deepEqual(migrated.getRun(), { ...before, yolo: false });
			assert.deepEqual(migrated.getApproval(reply.runId, "001", 1), approval);
			assert.deepEqual(migrated.getBudget(reply.runId), budget);
			assert.ok(migrated.database.prepare("SELECT name FROM sqlite_master WHERE name = 'manager_approvals_proof'").get());
			assert.deepEqual(migrated.database.prepare("PRAGMA foreign_key_check").all(), []);
		} finally { migrated.close(); }
	} finally { if (!closed) manager.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
