import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";
import { initPlanDir, buildGraph } from "../../../src/core/plans.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { RunStore, type StoredPlanSpec } from "../../../src/daemon/run-store.ts";
import { git, GitDriver } from "../../../src/daemon/git-driver.ts";
import { attentionResolutionFromRequest } from "../../../adapters/attention.ts";
import { assertApprovedRevisionGraph, confirmRunRevision, prepareRunRevision, readRunRevision, revisionDriver, writeRunRevision } from "../../../src/core/run-revision.ts";
import { finishRunRevision } from "../../../src/application/run-revision.ts";
import { graphInputSha256 } from "../../../src/core/plan-edit.ts";
import { selectivePlanSets, stageSelectiveReversal, SelectiveReversalConflict } from "../../../src/daemon/git/selective-revision.ts";
import { compileGraphIdentity } from "../../../src/core/plan-identity.ts";
import { finishWholeRunEdit, cancelWholeRunEdit, wholeRunToolPolicy, type RunRevisionHost } from "../../../adapters/run-revision.ts";
import { resetHerderPlanSet } from "../../../src/daemon/git/reset-plan-set.ts";
import { buildCompletionProofPayload } from "../../../src/daemon/git/completion-proof.ts";
import { parseWorkerResult, normalizeUsage, sha256, stableJson, attentionRequestSha256, attentionCapabilityToken } from "../../../src/shared/protocol.ts";
import type { ManagerAttentionRequest } from "../../../src/shared/protocol.ts";

function fixture(upstreamStatus = "DONE") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-run-revision-"));
	const { repo, originalHead } = initFixtureRepo(root, { name: "Revision", email: "revision@example.invalid", files: { "src/value.mjs": "export const value = 1;\n", "src/other.mjs": "export const other = 1;\n" } });
	const directory = path.join(repo, "herder-plans");
	initPlanDir(directory);
	fs.writeFileSync(path.join(directory, "README.md"), `# Revision\n\n## Execution order & status\n\n| Plan | Title | Priority | Effort | Depends on | Status |\n|---|---|---|---|---|---|\n| [001](001-upstream.md) | Upstream | P1 | S | — | ${upstreamStatus} |\n| [002](002-downstream.md) | Downstream | P1 | S | 001 | BLOCKED — revise the upstream contract |\n\n## Dependency notes\n\n002 consumes 001.\n\n## Considered and rejected\n\nNone.\n`);
	fs.writeFileSync(path.join(directory, "001-upstream.md"), fixturePlan({ id: "001", title: "Upstream" }));
	fs.writeFileSync(path.join(directory, "002-downstream.md"), fixturePlan({ id: "002", title: "Downstream", dependencies: "001", writePaths: ["src/other.mjs"] }));
	return { root, repo, directory, originalHead, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function completeFixturePlan(value: ReturnType<typeof fixture>, store: RunStore, id: string, file: string, content: string, reviewBase?: string, companion?: { file: string; content: string }) {
	const run = store.getRun()!;
	const driver = revisionDriver(run);
	const spec = store.getPlanSpecs(run.runId).find(spec => spec.planId === id)!;
	const base = reviewBase ?? driver.branchHead(run.integrationBranch);
	const execution = driver.ensurePlanWorktree(id, spec.assignment, base);
	const worktree = execution.worktree;
	fs.writeFileSync(path.join(worktree, file), content);
	git(worktree, ["add", file]);
	git(worktree, ["commit", "-qm", "upstream implementation"]);
	if (companion) {
		fs.mkdirSync(path.dirname(path.join(worktree, companion.file)), { recursive: true });
		fs.writeFileSync(path.join(worktree, companion.file), companion.content);
		git(worktree, ["add", companion.file]);
		git(worktree, ["commit", "-qm", "approved companion test"]);
	}
	const head = driver.worktreeHead(worktree);
	store.putPlan({ runId: run.runId, planId: id, generation: run.currentGeneration, round: 1, phase: "DONE", branch: execution.branch, worktree,
		assignmentPath: execution.assignment.bundlePath, assignmentSha256: execution.assignment.bundleSha256, snapshotSha256: execution.assignment.snapshotSha256, generationBase: base,
		reviewPass: 1, findings: [], repair: [], gates: [], approvedBase: base, approvedHead: head, approvedTree: driver.worktreeTree(worktree), rebase: null });
	const actionId = randomUUID();
	const review = parseWorkerResult("plan-reviewer", "VERDICT: APPROVE\nSCOPE: PASS\nFINDINGS: none");
	store.putAction({ actionId, attemptId: randomUUID(), runId: run.runId, planId: id, generation: run.currentGeneration, round: 1,
		role: "plan-reviewer", agentType: "reviewer", model: "fixture", effort: "high", workerMode: "VERIFICATION", taskName: "Review", worktree, branch: execution.branch,
		assignmentPath: execution.assignment.bundlePath, assignmentSha256: execution.assignment.bundleSha256, leaseReason: "fixture", prompt: "Review" });
	store.markDispatched(actionId, "fixture");
	store.markTerminal(actionId, { workerResult: review, usage: normalizeUsage(review, { actionId, response: "" }), outcome: "approved", terminal: { interrupted: false, error: null, hostHandle: "fixture" } });
	const proof = buildCompletionProofPayload({ runId: run.runId, planId: id, generation: run.currentGeneration, round: 1, reviewerActionId: actionId, decisionActionId: actionId, decisionRole: "plan-reviewer",
		assignmentSha256: execution.assignment.bundleSha256, approvedBase: base, approvedHead: head, approvedTree: driver.worktreeTree(worktree), reviewResultSha256: sha256(stableJson(review)), decisionResultSha256: sha256(stableJson(review)), integratedHead: head });
	store.putApproval({ ...proof, proofSha256: proof.approvalProofSha256 });
	const integration = driver.integrate({ planId: id, branch: execution.branch, worktree, approvedBase: base, approvedHead: head, approvedTree: driver.worktreeTree(worktree), generation: run.currentGeneration, checkpointOrdinal: 1, approval: proof });
	assert.equal(integration.status, "integrated");
	store.putPlan({ ...store.getPlan(run.runId, id)!, approvedHead: integration.head!, approvedTree: driver.worktreeTree(worktree) });

	return worktree;
}

async function begin(value: ReturnType<typeof fixture>, conflict = false, restack = false, completeDownstream = false, duplicate = false) {
	const manager = new HerderRunManager(value.directory);
	try {
		const reply = await manager.start({ mode: "fire", repositoryRoot: value.repo, planDirectory: value.directory, profile: "eclipse", maxParallel: 2 });
		const store = new RunStore(value.directory);
		let worktree: string;
		try {
			if (store.getPlanSpecs(store.getRun()!.runId).some(spec => spec.planId === "003")) completeFixturePlan(value, store, "003", "src/before.mjs", "export const before = 3;\n");
			const companion = duplicate ? { file: "tests/shared.test.mjs", content: "export const sharedTest = true;\n" } : undefined;
			worktree = completeFixturePlan(value, store, "001", "src/value.mjs", "export const value = 2;\n", restack ? value.originalHead : undefined, companion);
			if (completeDownstream) completeFixturePlan(value, store, "002", "src/other.mjs", "export const other = 2;\n");
			if (store.getPlanSpecs(store.getRun()!.runId).some(spec => spec.planId === "004")) completeFixturePlan(value, store, "004", conflict ? "src/value.mjs" : "src/after.mjs", conflict ? "export const value = 4;\n" : "export const after = 4;\n", duplicate ? value.originalHead : undefined, companion);
		} finally { store.close(); }
		const request = reply.attention!;
		assert.equal(request.planId, "002");
		const opened = await manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "revise_run" } });
		assert.deepEqual(opened.actions, []);
		assert.equal(opened.scheduler.reason, "revision-barrier");
		return { request, record: readRunRevision(value.directory)!, worktree };
	} finally { manager.close(); }
}

function revise(value: ReturnType<typeof fixture>) {
	const index = path.join(value.directory, "README.md");
	fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("| DONE |", "| TODO |").replace("| 001 | BLOCKED — revise the upstream contract |", "| — | TODO |"));
	fs.writeFileSync(path.join(value.directory, "001-upstream.md"), fixturePlan({ id: "001", title: "Upstream", acceptance: "The upstream publishes the revised numeric API." }));
	fs.writeFileSync(path.join(value.directory, "002-downstream.md"), fixturePlan({ id: "002", title: "Downstream", writePaths: ["src/other.mjs"], acceptance: "The revised consumer no longer depends on upstream execution." }));
}

const host: RunRevisionHost = { assert: () => {}, settle: async () => {}, observe: () => {}, finished: async () => {} };

// Real local Git only: no LLM workers and no live project runtime mutations.
test("whole-run revision replaces integrated upstream and blocked downstream on original base", { timeout: 60_000 }, async () => {
	const value = fixture();
	try {
		const { record, worktree, request } = await begin(value);
		revise(value);
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		assert.ok(fs.existsSync(worktree));
		await confirmRunRevision(prepared);
		const result = await finishRunRevision(value.directory, record.editToken);
		assert.equal(result.reply?.runId, record.run.runId);
		assert.equal(result.reply?.actions.length, 2);
		assert.ok(result.reply?.actions.some(action => fs.readFileSync(action.assignmentPath, "utf8").includes("revised numeric API")));
		const store = new RunStore(value.directory, { readOnly: true });
		try {
			assert.equal(store.getRun()?.baseCommit, value.originalHead);
			assert.equal(store.getRun()?.profileName, "eclipse");
			assert.equal(store.getRun()?.maxParallel, 2);
			assert.deepEqual(store.getPlanSpecs(record.run.runId).map(spec => [spec.planId, spec.initialStatus, spec.dependencies]), [["001", "TODO", []], ["002", "TODO", []]]);
			assert.equal(store.getAttention(request.requestId)?.state, "resolved");
			assert.ok(store.getApproval(record.run.runId, "001", 1), "original affected proof remains historical evidence");
			assert.equal(store.getApproval(record.run.runId, "001", 2), null, "old affected approval never authorizes rerun");
			assert.ok(store.getPlans(record.run.runId).every(plan => plan.generationBase !== value.originalHead && plan.round === 1 && !plan.approvedHead));
		} finally { store.close(); }
		assert.equal(git(value.repo, ["rev-parse", "HEAD"]).stdout.trim(), value.originalHead);
		assert.equal(fs.readFileSync(path.join(value.repo, "src/value.mjs"), "utf8"), "export const value = 1;\n");
		assert.equal(fs.readFileSync(path.join(worktree, "src/value.mjs"), "utf8"), "export const value = 1;\n");
		const replay = await finishRunRevision(value.directory, record.editToken);
		assert.equal(replay.reply?.runId, result.reply?.runId);
		const manager = new HerderRunManager(value.directory);
		try { await assert.rejects(manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "abandon_run" } }), /already resolved|not recorded/); }
		finally { manager.close(); }
	} finally { value.dispose(); }
});

test("dismissed confirmation preserves graph conversation and old execution without retry", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record, worktree } = await begin(value);
		revise(value);
		let settled = false;
		await assert.rejects(finishWholeRunEdit(value.directory, record.editToken, { hasUI: true, ui: { confirm: async () => false } as never }, { ...host, settle: async () => { settled = true; } }), /dismissed/);
		assert.equal(settled, false);
		assert.equal(readRunRevision(value.directory)?.state, "prepared");
		assert.ok(fs.existsSync(worktree));
		const manager = new HerderRunManager(value.directory);
		try {
			assert.deepEqual(manager.reply().actions, []);
			await assert.rejects(manager.start({ mode: "resume", repositoryRoot: value.repo, planDirectory: value.directory }), /unchanged resume/);
		} finally { manager.close(); }
		await cancelWholeRunEdit(value.directory, record.editToken, host);
		assert.equal(buildGraph(value.directory).plans[0]?.status, "DONE");
		assert.equal(readRunRevision(value.directory)?.state, "draft");
	} finally { value.dispose(); }
});

test("invalid, inherited, unchanged, and changed-after-confirmation graphs cannot delete execution", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record, worktree } = await begin(value);
		await assert.rejects(prepareRunRevision(value.directory, record.editToken), /unchanged retry is not allowed/);
		const readme = path.join(value.directory, "README.md");
		const originalIndex = fs.readFileSync(readme, "utf8");
		fs.writeFileSync(readme, originalIndex.replace("| DONE |", "| TODO |").replace("BLOCKED — revise the upstream contract", "TODO"));
		await assert.rejects(prepareRunRevision(value.directory, record.editToken), /unchanged retry is not allowed/);
		fs.writeFileSync(readme, originalIndex);
		revise(value);
		const plan = path.join(value.directory, "001-upstream.md");
		const valid = fs.readFileSync(plan, "utf8");
		fs.writeFileSync(plan, "invalid graph");
		await assert.rejects(prepareRunRevision(value.directory, record.editToken));
		assert.ok(fs.existsSync(worktree));
		fs.writeFileSync(plan, valid);
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		fs.appendFileSync(plan, "\nChanged after preview.\n");
		await assert.rejects(confirmRunRevision(prepared), /changed after confirmation/);
		assert.ok(fs.existsSync(worktree));
		await assert.rejects(finishRunRevision(value.directory, record.editToken), /requires host confirmation/);
	} finally { value.dispose(); }
});

test("explicit abandonment deletes entire unmerged execution and preserves exact Markdown", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record, worktree } = await begin(value);
		const index = fs.readFileSync(path.join(value.directory, "README.md"));
		await finishWholeRunEdit(value.directory, record.editToken, { hasUI: true, ui: { confirm: async () => true } as never }, host, "abandon_run");
		assert.equal(readRunRevision(value.directory)?.state, "abandoned");
		assert.deepEqual(fs.readFileSync(path.join(value.directory, "README.md")), index);
		assert.equal(fs.existsSync(worktree), false);
		assert.equal(git(value.repo, ["for-each-ref", "--format=%(refname)", "refs/heads/herder/"]).stdout.trim(), "");
		assert.equal(git(value.repo, ["rev-parse", "HEAD"]).stdout.trim(), value.originalHead);
		assert.equal((await finishRunRevision(value.directory, record.editToken)).abandoned, true);
	} finally { value.dispose(); }
});

test("plan attention rejects every retired action at the manager boundary", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { request } = await begin(value);
		const manager = new HerderRunManager(value.directory);
		try {
			for (const action of ["defer", "answer", "answer_and_resume", "retry", "unchanged_retry", "revise", "reject", "accept", "stop", "cancel"]) {
				await assert.rejects(manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(request), action, answer: "do it", rationale: "do it", confirmed: true } }), /requires revise_run or explicit abandon_run/);
			}
		} finally { manager.close(); }
	} finally { value.dispose(); }
});

test("revision tool authority permits only Markdown graph edits, including literal rename/remove", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record } = await begin(value);
		assert.equal(wholeRunToolPolicy(record, "write", { path: "herder-plans/003-new.md" }, value.repo), undefined);
		assert.equal(wholeRunToolPolicy(record, "bash", { command: "rm -- herder-plans/001-upstream.md" }, value.repo), undefined);
		assert.equal(wholeRunToolPolicy(record, "bash", { command: "mv -- herder-plans/001-upstream.md herder-plans/004-renamed.md" }, value.repo), undefined);
		for (const command of ["git reset --hard", "rm -- src/value.mjs", "rm -- herder-plans/001-upstream.md; echo bad", "rm -- herder-plans/.herder/001-state.md"]) assert.equal(wholeRunToolPolicy(record, "bash", { command }, value.repo)?.block, true);
		assert.equal(wholeRunToolPolicy(record, "edit", { path: "src/value.mjs" }, value.repo)?.block, true);
	} finally { value.dispose(); }
});

for (const point of ["before_publication", "after_publication", "before_cleanup_worktree_removed", "after_cleanup_worktree_removed", "before_cleanup_branch_deleted", "after_cleanup_branch_deleted", "after_reset", "after_restarting", "after_restart", "after_complete", "after_schedule"]) {
	test(`whole-run finish safely replays after process interruption ${point}`, { timeout: 45_000 }, async () => {
		const value = fixture();
		try {
			const { record } = await begin(value);
			revise(value);
			await confirmRunRevision(await prepareRunRevision(value.directory, record.editToken));
			const module = new URL("../../../src/application/run-revision.ts", import.meta.url).href;
			const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { finishRunRevision } from ${JSON.stringify(module)}; await finishRunRevision(${JSON.stringify(value.directory)}, ${JSON.stringify(record.editToken)});`], { env: { ...process.env, HERDER_TEST_RUN_REVISION_CRASH_AT: point }, encoding: "utf8", timeout: 25_000 });
			assert.equal(child.signal, "SIGKILL", child.stderr);
			const reply = (await finishRunRevision(value.directory, record.editToken)).reply!;
			assert.equal(reply.runId, record.run.runId);
			assert.equal(reply.actions.length, 2);
			assert.equal(git(value.repo, ["rev-parse", "HEAD"]).stdout.trim(), value.originalHead);
			assert.equal(readRunRevision(value.directory)?.state, "complete");
		} finally { value.dispose(); }
	});
}

test("checkout changes after preparation reject confirmation without deleting execution", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record, worktree } = await begin(value);
		revise(value);
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		fs.appendFileSync(path.join(value.repo, "src/value.mjs"), "// user edit\n");
		await assert.rejects(confirmRunRevision(prepared), /Checkout changed/);
		assert.ok(fs.existsSync(worktree));
		assert.equal(readRunRevision(value.directory)?.state, "prepared");
	} finally { value.dispose(); }
});


test("whole-run revision can replace the entire ID set and dependency graph", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record, worktree } = await begin(value);
		const index = path.join(value.directory, "README.md");
		fs.writeFileSync(index, fs.readFileSync(index, "utf8")
			.replace("| [001](001-upstream.md) | Upstream | P1 | S | — | DONE |", "| [003](003-replacement.md) | Replacement | P1 | S | — | TODO |")
			.replace("| [002](002-downstream.md) | Downstream | P1 | S | 001 | BLOCKED — revise the upstream contract |\n", "")
			.replace("002 consumes 001.", "The replacement has no dependencies."));
		fs.unlinkSync(path.join(value.directory, "001-upstream.md"));
		fs.unlinkSync(path.join(value.directory, "002-downstream.md"));
		fs.writeFileSync(path.join(value.directory, "003-replacement.md"), fixturePlan({ id: "003", title: "Replacement", acceptance: "The replacement subsumes both former plans." }));
		await confirmRunRevision(await prepareRunRevision(value.directory, record.editToken));
		const reply = (await finishRunRevision(value.directory, record.editToken)).reply!;
		assert.deepEqual(reply.actions.map(action => action.planId), ["003"]);
		assert.equal(fs.existsSync(worktree), false);
		assert.equal(git(value.repo, ["show-ref", "--verify", "--quiet", "refs/heads/herder/herder-plans/001"], true).status, 1);
		assert.equal(fs.readFileSync(path.join(value.repo, "src/value.mjs"), "utf8"), "export const value = 1;\n");
	} finally { value.dispose(); }
});

for (const point of ["after_restarting", "after_restart"]) {
	test(`restart replay rejects changed TODO status after interruption ${point}`, { timeout: 45_000 }, async () => {
		const value = fixture();
		try {
			const { record } = await begin(value);
			revise(value);
			await confirmRunRevision(await prepareRunRevision(value.directory, record.editToken));
			const module = new URL("../../../src/application/run-revision.ts", import.meta.url).href;
			const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { finishRunRevision } from ${JSON.stringify(module)}; await finishRunRevision(${JSON.stringify(value.directory)}, ${JSON.stringify(record.editToken)});`], { env: { ...process.env, HERDER_TEST_RUN_REVISION_CRASH_AT: point }, encoding: "utf8", timeout: 25_000 });
			assert.equal(child.signal, "SIGKILL", child.stderr);
			const restarting = readRunRevision(value.directory)!;
			assert.equal(restarting.state, "restarting");
			const index = path.join(value.directory, "README.md");
			const approved = fs.readFileSync(index, "utf8");
			fs.writeFileSync(index, approved.replace("| TODO |", "| DONE |"));
			assert.equal(compileGraphIdentity(buildGraph(value.directory)), restarting.graphSha256, "graph identity alone cannot detect skipped execution");
			assert.throws(() => assertApprovedRevisionGraph({ ...restarting, inputSha256: graphInputSha256(value.directory) }), /every plan TODO/);
			await assert.rejects(finishRunRevision(value.directory, record.editToken), /Markdown changed after host confirmation/);
			const manager = new HerderRunManager(value.directory);
			try {
				await assert.rejects(manager.start({ mode: point === "after_restart" ? "resume" : "fire", repositoryRoot: record.run.repositoryRoot, planDirectory: value.directory, profile: "eclipse", maxParallel: 2 }), /Markdown changed after host confirmation|Finish the whole-run revision/);
				const run = manager.store.getRun();
				if (point === "after_restarting") assert.equal(run?.currentGeneration, 1, "original generation remains until adoption");
				if (run) assert.equal(manager.store.countActions(run.runId, { generation: 2 }), 0, "no skipped or partial execution may start");
			} finally { manager.close(); }
			assert.equal(readRunRevision(value.directory)?.state, "restarting");
			fs.writeFileSync(index, approved);
			const reply = (await finishRunRevision(value.directory, record.editToken)).reply!;
			assert.equal(reply.runId, record.run.runId);
			assert.deepEqual(reply.actions.map(action => action.planId), ["001", "002"]);
		} finally { value.dispose(); }
	});
}

function independentFixture() {
	const value = fixture();
	const index = path.join(value.directory, "README.md");
	fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("\n\n## Dependency notes", "\n| [003](003-before.md) | Before | P1 | S | — | DONE |\n| [004](004-after.md) | After | P1 | S | — | DONE |\n\n## Dependency notes"));
	fs.writeFileSync(path.join(value.directory, "003-before.md"), fixturePlan({ id: "003", title: "Before", writePaths: ["src/before.mjs"] }));
	fs.writeFileSync(path.join(value.directory, "004-after.md"), fixturePlan({ id: "004", title: "After", writePaths: ["src/after.mjs"] }));
	return value;
}

for (const restack of [false, true]) test(`selective revision retains independent DONE work before and after reversed commits (restack=${restack}), including proofs and branches`, { timeout: 60_000 }, async () => {
	const value = independentFixture();
	try {
		const { record } = await begin(value, false, restack, true);
		const store = new RunStore(value.directory);
		const retained = ["003", "004"].map(id => ({ plan: store.getPlan(record.run.runId, id)!, approval: store.getApproval(record.run.runId, id, 1), ref: git(value.repo, ["rev-parse", `refs/plan-herder/herder-plans/completed/${id}`]).stdout.trim() }));
		store.putPlan({ ...retained[0]!.plan, planId: "RUN", phase: "BLOCKED", branch: record.run.integrationBranch, worktree: record.run.integrationWorktree });
		store.close();
		fs.appendFileSync(path.join(value.directory, "001-upstream.md"), "\nThe revised upstream publishes a new numeric API.\n");
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		assert.deepEqual(prepared.selective?.retainedPlanIds, ["003", "004"]);
		assert.deepEqual(prepared.selective?.rerunPlanIds, ["001", "002"]);
		await confirmRunRevision(prepared);
		const reply = (await finishRunRevision(value.directory, record.editToken)).reply!;
		assert.deepEqual(reply.actions.map(action => action.planId), ["001"]);
		const current = new RunStore(value.directory);
		try {
			assert.equal(current.getPlan(record.run.runId, "RUN"), null, "prior final audit runtime never survives adoption");
			assert.equal(current.getVerification(record.run.runId, 2), null, "new generation requires fresh exact-tree verification");
			for (const saved of retained) {
				assert.deepEqual(current.getPlan(record.run.runId, saved.plan.planId), saved.plan);
				assert.deepEqual(current.getApproval(record.run.runId, saved.plan.planId, 1), saved.approval);
				assert.equal(git(value.repo, ["rev-parse", `refs/plan-herder/herder-plans/completed/${saved.plan.planId}`]).stdout.trim(), saved.ref);
				assert.equal(git(value.repo, ["rev-parse", saved.plan.branch]).stdout.trim(), saved.plan.approvedHead);
			}
			assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "src/value.mjs"), "utf8"), "export const value = 1;\n");
			assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "src/other.mjs"), "utf8"), "export const other = 1;\n");
			assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "src/before.mjs"), "utf8"), "export const before = 3;\n");
			assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "src/after.mjs"), "utf8"), "export const after = 4;\n");
		} finally { current.close(); }
	} finally { value.dispose(); }
});

test("ordinary reset requeues TODO-origin completion retained from an earlier selective generation", { timeout: 60_000 }, async () => {
	const value = fixture("TODO");
	try {
		const manager = new HerderRunManager(value.directory);
		let record;
		let retained;
		let approval;
		let ref;
		try {
			const reply = await manager.start({ mode: "fire", repositoryRoot: value.repo, planDirectory: value.directory, profile: "eclipse", maxParallel: 2 });
			assert.deepEqual(reply.actions.map(action => [action.planId, action.role]), [["001", "plan-implementer"]]);
			const store = new RunStore(value.directory);
			try {
				assert.equal(store.getPlanSpecs(reply.runId!).find(spec => spec.planId === "001")!.initialStatus, "TODO");
				// Settle the local fixture's proposed worker before opening revision authority.
				for (const action of reply.actions) {
					store.markDispatched(action.actionId, "fixture");
					const workerResult = parseWorkerResult("plan-implementer", "STATUS: COMPLETE\nCOMMITS: none\nADDRESSED: none\nSETUP: none\nCHECKS: none\nFILES CHANGED: src/value.mjs\nDISCOVERED_PATHS: none\nNOTES: fixture");
					store.markTerminal(action.actionId, { workerResult, usage: normalizeUsage(workerResult, { actionId: action.actionId, response: "" }), outcome: "complete", terminal: { interrupted: false, error: null, hostHandle: "fixture" } });
					revisionDriver(store.getRun()!).release(action.worktree, action.leaseReason);
				}
				completeFixturePlan(value, store, "001", "src/value.mjs", "export const value = 2;\n");
				retained = store.getPlan(reply.runId!, "001")!;
				approval = store.getApproval(reply.runId!, "001", 1);
				ref = git(value.repo, ["rev-parse", "refs/plan-herder/herder-plans/completed/001"]).stdout.trim();
			} finally { store.close(); }
			const request = reply.attention!;
			assert.equal(request.planId, "002");
			await manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "revise_run" } });
			record = readRunRevision(value.directory)!;
		} finally { manager.close(); }
		fs.appendFileSync(path.join(value.directory, "002-downstream.md"), "\nRevise the downstream implementation only.\n");
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		assert.deepEqual(prepared.selective!.retainedPlanIds, ["001"]);
		await confirmRunRevision(prepared);
		const revised = (await finishRunRevision(value.directory, record.editToken)).reply!;
		assert.deepEqual(revised.actions.map(action => action.planId), ["002"], "selective revision alone keeps the prerequisite complete");
		const store = new RunStore(value.directory);
		try {
			assert.equal(store.getRun()!.currentGeneration, 2);
			assert.equal(retained.generation, 1);
			assert.deepEqual(store.getPlan(record.run.runId, "001"), retained);
			assert.deepEqual(store.getApproval(record.run.runId, "001", 1), approval);
			assert.equal(store.getPlanSpecs(record.run.runId).find(spec => spec.planId === "001")!.initialStatus, "DONE");
			assert.equal(git(value.repo, ["rev-parse", "refs/plan-herder/herder-plans/completed/001"]).stdout.trim(), ref);
		} finally { store.close(); }
		assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "src/value.mjs"), "utf8"), "export const value = 2;\n");
		resetHerderPlanSet({ repoRoot: value.repo, planDirectory: value.directory });
		assert.deepEqual(buildGraph(value.directory).plans.map(plan => [plan.id, plan.status, plan.statusDetail]), [["001", "TODO", ""], ["002", "TODO", ""]]);
		const fresh = new HerderRunManager(value.directory);
		try {
			const reply = await fresh.start({ mode: "fire", repositoryRoot: value.repo, planDirectory: value.directory, profile: "eclipse", maxParallel: 2 });
			assert.notEqual(reply.runId, record.run.runId);
			assert.deepEqual(reply.actions.map(action => [action.planId, action.role]), [["001", "plan-implementer"]], "discarded prerequisite must run before its dependent");
			assert.equal(fs.readFileSync(path.join(reply.actions[0]!.worktree, "src/value.mjs"), "utf8"), "export const value = 1;\n");
		} finally { fresh.close(); }
	} finally { value.dispose(); }
});

test("selective revision refuses removing a retained approval's duplicate patch dropped during restack", { timeout: 60_000 }, async () => {
	const value = independentFixture();
	try {
		const { record } = await begin(value, false, false, false, true);
		const manager = new HerderRunManager(value.directory);
		try { manager.validateSelectiveApprovals(record.run); } finally { manager.close(); }
		const store = new RunStore(value.directory);
		try {
			const plans = store.getPlans(record.run.runId);
			const retained = store.getPlan(record.run.runId, "004")!;
			const approval = store.getApproval(record.run.runId, "004", 1)!;
			assert.equal(git(value.repo, ["rev-list", "--count", `${approval.approvedBase}..${approval.approvedHead}`]).stdout.trim(), "2");
			const onto = git(value.repo, ["rev-parse", "refs/plan-herder/herder-plans/restacks/004/generation-1-001-onto"]).stdout.trim();
			assert.equal(git(value.repo, ["rev-list", "--count", `${onto}..${retained.approvedHead}`]).stdout.trim(), "1", "restack dropped the approved shared test");
			assert.equal(git(value.repo, ["merge-base", "--is-ancestor", approval.approvedHead, retained.approvedHead!], true).status, 1);
			const namespace = revisionDriver(record.run).readIntegrationRepairNamespace();
			const inventory = git(value.repo, ["worktree", "list", "--porcelain"]).stdout;
			const assignments = plans.map(plan => fs.readFileSync(plan.assignmentPath));
			fs.appendFileSync(path.join(value.directory, "001-upstream.md"), "\nRevise the numeric API.\n");
			await assert.rejects(prepareRunRevision(value.directory, record.editToken), /approved patch required by retained plan 004/);
			assert.deepEqual(revisionDriver(record.run).readIntegrationRepairNamespace(), namespace);
			assert.equal(git(value.repo, ["worktree", "list", "--porcelain"]).stdout, inventory);
			assert.deepEqual(store.getPlans(record.run.runId), plans);
			assert.deepEqual(store.getApproval(record.run.runId, "004", 1), approval);
			assert.equal(store.countActions(record.run.runId, { generation: 2 }), 0);
			for (const [index, plan] of plans.entries()) assert.deepEqual(fs.readFileSync(plan.assignmentPath), assignments[index]);
			assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "tests/shared.test.mjs"), "utf8"), "export const sharedTest = true;\n");
		} finally { store.close(); }
	} finally { value.dispose(); }
});

for (const stage of ["confirmation", "finish"] as const) for (const mutation of ["delete", "modify"] as const) {
	test(`selective revision ${stage} refuses ${mutation} of an ignored retained assignment`, { timeout: 60_000 }, async () => {
		const value = independentFixture();
		try {
			const { record } = await begin(value);
			fs.appendFileSync(path.join(value.directory, "001-upstream.md"), "\nRevise the numeric API.\n");
			const prepared = await prepareRunRevision(value.directory, record.editToken);
			const kept = prepared.selective!.retainedWorktrees[0]!;
			assert.equal(sha256(fs.readFileSync(kept.assignmentPath)), kept.assignmentSha256);
			assert.equal(git(kept.worktree, ["check-ignore", kept.assignmentPath], true).status, 0);
			if (stage === "finish") await confirmRunRevision(prepared);
			const store = new RunStore(value.directory);
			try {
				const plans = store.getPlans(record.run.runId);
				const namespace = revisionDriver(record.run).readIntegrationRepairNamespace();
				const inventory = git(value.repo, ["worktree", "list", "--porcelain"]).stdout;
				const revision = readRunRevision(value.directory);
				if (mutation === "delete") fs.unlinkSync(kept.assignmentPath);
				else {
					const mode = fs.statSync(kept.assignmentPath).mode;
					fs.chmodSync(kept.assignmentPath, 0o600);
					fs.appendFileSync(kept.assignmentPath, "\n");
					fs.chmodSync(kept.assignmentPath, mode);
				}
				assert.equal(revisionDriver(record.run).worktreeStatus(kept.worktree), "", "Git status ignores assignment mutation");
				await assert.rejects(stage === "confirmation" ? confirmRunRevision(prepared) : finishRunRevision(value.directory, record.editToken), /assignment bundle is missing|assignment bundle hash mismatch/);
				assert.deepEqual(revisionDriver(record.run).readIntegrationRepairNamespace(), namespace);
				assert.equal(git(value.repo, ["worktree", "list", "--porcelain"]).stdout, inventory);
				assert.deepEqual(store.getPlans(record.run.runId), plans);
				assert.equal(store.getRun()!.currentGeneration, 1);
				assert.equal(store.countActions(record.run.runId, { generation: 2 }), 0);
				assert.deepEqual(readRunRevision(value.directory), revision);
				for (const plan of plans) assert.ok(fs.existsSync(plan.worktree));
			} finally { store.close(); }
		} finally { value.dispose(); }
	});
}

for (const mutation of ["moved ref", "replaced worktree", "symlink worktree", "dangling ref", "conflict"] as const) {
	test(`selective revision fails closed on ${mutation} without deleting any execution artifact`, { timeout: 30_000 }, async () => {
		const value = independentFixture();
		try {
			const { record, worktree } = await begin(value, mutation === "conflict");
			fs.appendFileSync(path.join(value.directory, "001-upstream.md"), "\nRevise the numeric API.\n");
			const prepared = await prepareRunRevision(value.directory, record.editToken);
			if (mutation === "moved ref") git(value.repo, ["update-ref", "refs/heads/herder/herder-plans/001", value.originalHead]);
			if (mutation === "replaced worktree") { fs.renameSync(worktree, `${worktree}-original`); fs.cpSync(`${worktree}-original`, worktree, { recursive: true }); }
			if (mutation === "symlink worktree") { fs.renameSync(worktree, `${worktree}-original`); fs.symlinkSync(`${worktree}-original`, worktree); }
			if (mutation === "dangling ref") fs.symlinkSync("missing", path.join(value.repo, ".git", "refs", "plan-herder", "herder-plans", "unexpected"));
			if (mutation === "conflict") {
				await confirmRunRevision(prepared);
				await assert.rejects(finishRunRevision(value.directory, record.editToken), /Selective reversal refused/);
			} else await assert.rejects(confirmRunRevision(prepared), /moved|replaced|changed|symlink/);
			assert.equal(git(value.repo, ["rev-parse", record.run.integrationBranch]).stdout.trim(), prepared.selective!.integrationHead);
			for (const id of ["001", "003", "004"]) assert.equal(git(value.repo, ["show-ref", "--verify", "--quiet", `refs/heads/herder/herder-plans/${id}`], true).status, 0);
			assert.ok(fs.existsSync(worktree));
		} finally { value.dispose(); }
	});
}

test("two selective revisions preserve attribution and restart non-DONE surfaces without stale attention or action leakage", { timeout: 60_000 }, async () => {
	const value = independentFixture();
	try {
		const { record, request } = await begin(value);
		fs.appendFileSync(path.join(value.directory, "001-upstream.md"), "\nFirst API revision.\n");
		await confirmRunRevision(await prepareRunRevision(value.directory, record.editToken));
		await finishRunRevision(value.directory, record.editToken);
		const manager = new HerderRunManager(value.directory);
		let second;
		try {
			// Simulate host settlement without accepting unfinished work.
			for (const action of manager.store.getActions(record.run.runId, ["proposed"])) revisionDriver(manager.store.getRun()!).release(manager.store.getPlan(record.run.runId, action.planId)!.worktree, action.leaseReason);
			manager.store.database.prepare("UPDATE manager_actions SET state = 'cancelled' WHERE state = 'proposed'").run();
			const requestId = randomUUID();
			const next = { ...request, requestId, capabilityToken: attentionCapabilityToken(requestId), generation: 2, state: "pending" as const };
			next.requestSha256 = attentionRequestSha256(next);
			manager.store.putAttention(next);
			await manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(next), action: "revise_run" } });
			second = readRunRevision(value.directory)!;
		} finally { manager.close(); }
		fs.appendFileSync(path.join(value.directory, "004-after.md"), "\nSecond independent API revision.\n");
		const prepared = await prepareRunRevision(value.directory, second.editToken);
		assert.deepEqual(prepared.selective?.retainedPlanIds, ["003"]);
		assert.deepEqual(prepared.selective?.rerunPlanIds, ["001", "002", "004"]);
		await confirmRunRevision(prepared);
		const reply = (await finishRunRevision(value.directory, second.editToken)).reply!;
		assert.deepEqual(reply.actions.map(action => action.planId), ["001", "004"]);
		assert.ok(reply.actions.every(action => action.generation === 3));
		const store = new RunStore(value.directory);
		try { assert.equal(store.getAttentionRequests(record.run.runId, { unresolvedOnly: true }).length, 0); assert.equal(store.getRun()?.currentGeneration, 3); }
		finally { store.close(); }
		assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "src/value.mjs"), "utf8"), "export const value = 1;\n");
		assert.equal(fs.existsSync(path.join(record.run.integrationWorktree, "src/after.mjs")), false);
		assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "src/before.mjs"), "utf8"), "export const before = 3;\n");
	} finally { value.dispose(); }
});

test("confirmed legacy records without selective evidence still use their original all-reset successor scope", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record } = await begin(value);
		revise(value);
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		const { selective: _, ...legacy } = prepared;
		writeRunRevision(value.directory, legacy, prepared);
		await confirmRunRevision(legacy);
		const reply = (await finishRunRevision(value.directory, record.editToken)).reply!;
		assert.equal(reply.runId, record.successorRunId);
		const store = new RunStore(value.directory);
		try { assert.equal(store.getRun()?.currentGeneration, 1); assert.equal(store.getAttention(record.request.requestId), null); }
		finally { store.close(); }
	} finally { value.dispose(); }
});


test("selective closure includes removed plans and old/new rewiring, but not independent DONE plans", () => {
	const spec = (planId: string, dependencies: string[] = [], planFingerprint = planId) => ({ planId, dependencies, planFingerprint }) as StoredPlanSpec;
	const previous = [spec("001"), spec("002", ["001"]), spec("003", ["002"]), spec("004")];
	const next = [spec("002", [], "rewired"), spec("003", ["002"]), spec("004"), spec("005", ["003"])];
	assert.deepEqual(selectivePlanSets(previous, next, new Set(["001", "002", "003", "004"])), { retainedPlanIds: ["004"], rerunPlanIds: ["002", "003", "005"], removedPlanIds: ["001"] });
	assert.throws(() => selectivePlanSets(previous, previous, new Set()), /unchanged retry/);
});

test("shared context changes invalidate every semantic fingerprint and authored DONE cannot skip execution", { timeout: 30_000 }, async () => {
	const value = independentFixture();
	try {
		const { record } = await begin(value);
		fs.writeFileSync(path.join(value.directory, "CONTEXT.md"), "# Shared context\n\nAll plans must use the revised public contract.\n");
		const index = path.join(value.directory, "README.md");
		fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("BLOCKED — revise the upstream contract", "DONE"));
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		assert.deepEqual(prepared.selective?.retainedPlanIds, []);
		assert.deepEqual(prepared.selective?.rerunPlanIds, ["001", "002", "003", "004"]);
		assert.ok(buildGraph(value.directory).plans.every(plan => plan.status === "TODO"));
	} finally { value.dispose(); }
});


test("unattributed integration commits reject selective preparation without deletion", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record, worktree } = await begin(value);
		fs.appendFileSync(path.join(record.run.integrationWorktree, "src/value.mjs"), "// unknown integration contribution\n");
		git(record.run.integrationWorktree, ["add", "src/value.mjs"]);
		git(record.run.integrationWorktree, ["commit", "-qm", "unattributed change"]);
		revise(value);
		await assert.rejects(prepareRunRevision(value.directory, record.editToken), /unknown integration contributions/);
		assert.ok(fs.existsSync(worktree));
		assert.equal(readRunRevision(value.directory)?.state, "draft");
	} finally { value.dispose(); }
});


for (const continuation of ["refine", "abandon"] as const) {
	test(`isolated reversal conflict restores prepared authority for ${continuation} only after unchanged-artifact validation`, { timeout: 45_000 }, async () => {
		const value = independentFixture();
		try {
			const { record, worktree } = await begin(value, true);
			fs.appendFileSync(path.join(value.directory, "001-upstream.md"), "\nRevise the numeric API.\n");
			const prepared = await prepareRunRevision(value.directory, record.editToken);
			await confirmRunRevision(prepared);
			const driver = revisionDriver(record.run);
			const beforeRefs = driver.readIntegrationRepairNamespace();
			const beforeWorktree = fs.statSync(worktree);
			const beforeStore = new RunStore(value.directory);
			const beforeRun = beforeStore.getRun();
			const beforePlans = beforeStore.getPlans(record.run.runId);
			beforeStore.close();
			// A non-apply staging failure must not be misclassified as refinement authority.
			assert.throws(() => stageSelectiveReversal(record.run, { ...prepared.selective!, integrationHead: "0".repeat(40) }), error => error instanceof Error && !(error instanceof SelectiveReversalConflict));
			assert.equal(readRunRevision(value.directory)?.state, "confirmed");
			await assert.rejects(finishRunRevision(value.directory, record.editToken), SelectiveReversalConflict);
			const reopened = readRunRevision(value.directory)!;
			assert.equal(reopened.state, "prepared");
			assert.equal(reopened.selective?.publication, undefined);
			assert.equal(reopened.selective?.published, undefined);
			assert.equal(reopened.selective?.resumed, undefined);
			assert.deepEqual(driver.readIntegrationRepairNamespace(), beforeRefs);
			assert.equal(fs.statSync(worktree).ino, beforeWorktree.ino);
			const store = new RunStore(value.directory);
			try { assert.deepEqual(store.getRun(), beforeRun); assert.deepEqual(store.getPlans(record.run.runId), beforePlans); }
			finally { store.close(); }
			await assert.rejects(finishRunRevision(value.directory, record.editToken), /requires host confirmation/);
			if (continuation === "refine") {
				fs.appendFileSync(path.join(value.directory, "004-after.md"), "\nRevise this conflicting contribution explicitly.\n");
				await assert.rejects(confirmRunRevision(reopened), /changed after confirmation/);
				const refined = await prepareRunRevision(value.directory, record.editToken);
				assert.deepEqual(refined.selective?.retainedPlanIds, ["003"]);
				await assert.rejects(finishRunRevision(value.directory, record.editToken), /requires host confirmation/);
				await confirmRunRevision(refined);
				const result = await finishRunRevision(value.directory, record.editToken);
				assert.equal(result.reply?.runId, record.run.runId);
				assert.equal(readRunRevision(value.directory)?.state, "complete");
			} else {
				const abandoned = await prepareRunRevision(value.directory, record.editToken, "abandon_run");
				assert.equal(abandoned.selective, undefined);
				await confirmRunRevision(abandoned);
				assert.equal((await finishRunRevision(value.directory, record.editToken)).abandoned, true);
			}
		} finally { value.dispose(); }
	});
}


test("a staging conflict does not reopen authority when the approved graph changed concurrently", { timeout: 30_000 }, async () => {
	const value = independentFixture();
	const originalStatus = GitDriver.prototype.worktreeStatus;
	try {
		const { record } = await begin(value, true);
		const planFile = path.join(value.directory, "001-upstream.md");
		fs.appendFileSync(planFile, "\nRevise the numeric API.\n");
		await confirmRunRevision(await prepareRunRevision(value.directory, record.editToken));
		let changed = false;
		GitDriver.prototype.worktreeStatus = function (worktree: string) {
			// Concurrent edit after finish's initial graph check, before its conflict recovery check.
			if (!changed && worktree === record.run.integrationWorktree) {
				changed = true;
				fs.appendFileSync(planFile, "\nUnconfirmed concurrent change.\n");
			}
			return originalStatus.call(this, worktree);
		};
		await assert.rejects(finishRunRevision(value.directory, record.editToken), /Markdown changed after host confirmation/);
		assert.equal(changed, true);
		assert.equal(readRunRevision(value.directory)?.state, "confirmed");
	} finally { GitDriver.prototype.worktreeStatus = originalStatus; value.dispose(); }
});
