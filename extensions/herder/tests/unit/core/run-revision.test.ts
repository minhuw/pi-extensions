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
import { grantHostAttention, assertApprovedRevisionGraph, confirmRunRevision, prepareRunRevision, readRunRevision, revisionDriver, writeRunRevision } from "../../../src/core/run-revision.ts";
import { finishRunRevision } from "../../../src/application/run-revision.ts";
import { graphInputSha256 } from "../../../src/core/plan-edit.ts";
import { destructiveSnapshot } from "../../../src/daemon/git/destructive-snapshot.ts";
import { selectivePreviewSha256, selectivePlanSets, stageSelectiveReversal, SelectiveReversalConflict } from "../../../src/daemon/git/selective-revision.ts";
import { compileGraphIdentity } from "../../../src/core/plan-identity.ts";
import { beginUserScopeAmendment, scopeChangePreview, finishWholeRunEdit, cancelWholeRunEdit, wholeRunToolPolicy, type RunRevisionHost } from "../../../adapters/run-revision.ts";
import { applyHerderReset } from "../../../src/application/tools.ts";
import { runResetCommand } from "../../../adapters/reset-command.ts";
import { resetHerderPlanSet } from "../../../src/daemon/git/reset-plan-set.ts";
import { buildCompletionProofPayload } from "../../../src/daemon/git/completion-proof.ts";
import { parseWorkerResult, normalizeUsage, sha256, stableJson, attentionRequestSha256, attentionCapabilityToken } from "../../../src/shared/protocol.ts";
import type { ManagerAttentionRequest, ManagerReply } from "../../../src/shared/protocol.ts";

function fixture(upstreamStatus = "DONE") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-run-revision-"));
	const { repo, originalHead } = initFixtureRepo(root, { name: "Revision", email: "revision@example.invalid", files: { ".gitignore": ".herder/ignored.txt\n", "src/value.mjs": "export const value = 1;\n", "src/other.mjs": "export const other = 1;\n" } });
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
		grantHostAttention(manager.store.getRun()!, { ...attentionResolutionFromRequest(request), action: "revise_run" });
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

function installLegacyHistory(directory: string, state: "complete" | "abandoned") {
	const current = readRunRevision(directory)!;
	assert.ok(current.selective?.version === 2);
	const { preservedPlanIds: _, artifacts, retainedWorktrees, ...preview } = current.selective;
	const selective = { ...preview, version: 1 as const,
		artifacts: artifacts.map(({ snapshot: _, unreviewedCommits: __, ...artifact }) => artifact),
		retainedWorktrees: retainedWorktrees.map(({ completed: _, ...worktree }) => worktree) };
	selective.previewSha256 = selectivePreviewSha256(selective);
	const legacy = { ...current, state, selective };
	const file = path.join(directory, ".herder/run-revision.json");
	const bytes = stableJson({ record: legacy, sha256: sha256(stableJson(legacy)) });
	fs.writeFileSync(file, bytes, { mode: 0o600 });
	return { legacy, file, bytes };
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
		assert.deepEqual(result.reply?.actions, []);
		assert.equal(result.reply?.status, "paused");
		const resumedManager = new HerderRunManager(value.directory);
		let resumed;
		try { resumed = await resumedManager.start({ mode: "resume", repositoryRoot: value.repo, planDirectory: value.directory }); } finally { resumedManager.close(); }
		assert.equal(resumed.actions.length, 2);
		assert.ok(resumed.actions.some(action => fs.readFileSync(action.assignmentPath, "utf8").includes("revised numeric API")));
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

test("legacy abandonment replay is refused without deleting execution or Markdown", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record, worktree } = await begin(value);
		const index = fs.readFileSync(path.join(value.directory, "README.md"));
		await assert.rejects(finishWholeRunEdit(value.directory, record.editToken, { hasUI: true, ui: { confirm: async () => true } as never }, host, "abandon_run"), /Legacy destructive/);
		assert.equal(readRunRevision(value.directory)?.state, "confirmed");
		assert.deepEqual(fs.readFileSync(path.join(value.directory, "README.md")), index);
		assert.equal(fs.existsSync(worktree), true);
		assert.notEqual(git(value.repo, ["for-each-ref", "--format=%(refname)", "refs/heads/herder/"]).stdout.trim(), "");
		assert.equal(git(value.repo, ["rev-parse", "HEAD"]).stdout.trim(), value.originalHead);
		await assert.rejects(finishRunRevision(value.directory, record.editToken), /Legacy destructive/);
	} finally { value.dispose(); }
});

test("plan attention rejects retired actions and cannot reuse a revision grant for other decisions", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { request } = await begin(value);
		const manager = new HerderRunManager(value.directory);
		try {
			for (const action of ["answer_and_resume", "retry", "unchanged_retry", "revise", "reject", "accept"]) {
				await assert.rejects(manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(request), action, answer: "do it", rationale: "do it", confirmed: true } }), ["retry", "accept", "reject"].includes(action) ? /Host attention grant is stale or does not match this exact decision/ : /Stopped attention permits/);
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

for (const point of ["before_publication", "after_publication", "before_cleanup_worktree_removed", "after_cleanup_worktree_removed", "before_cleanup_branch_deleted", "after_cleanup_branch_deleted", "after_reset", "after_restarting", "after_restart", "after_complete"]) {
	test(`whole-run finish safely replays after process interruption ${point}`, { timeout: 45_000 }, async () => {
		const value = fixture();
		try {
			const { record } = await begin(value);
			const unfinished = unfinishedPlan(value, record.run);
			fs.writeFileSync(path.join(unfinished.worktree, "src/other.mjs"), "// committed unfinished work\n");
			git(unfinished.worktree, ["add", "src/other.mjs"]); git(unfinished.worktree, ["commit", "-qm", "unreviewed before crash"]);
			fs.mkdirSync(path.join(unfinished.worktree, ".herder"), { recursive: true });
			fs.writeFileSync(path.join(unfinished.worktree, ".herder/ignored.txt"), "approved ignored discard");
			fs.writeFileSync(path.join(unfinished.worktree, "untracked.txt"), "approved untracked discard");
			revise(value);
			await confirmRunRevision(await prepareRunRevision(value.directory, record.editToken));
			const module = new URL("../../../src/application/run-revision.ts", import.meta.url).href;
			const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { finishRunRevision } from ${JSON.stringify(module)}; await finishRunRevision(${JSON.stringify(value.directory)}, ${JSON.stringify(record.editToken)});`], { env: { ...process.env, HERDER_TEST_RUN_REVISION_CRASH_AT: point }, encoding: "utf8", timeout: 25_000 });
			assert.equal(child.signal, "SIGKILL", child.stderr);
			const reply = (await finishRunRevision(value.directory, record.editToken)).reply!;
			assert.equal(reply.runId, record.run.runId);
			assert.deepEqual(reply.actions, []);
			assert.equal(reply.status, "paused");
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
		assert.deepEqual(reply.actions, [], "new task requires a separate explicit effort grant");
		assert.equal(reply.status, "paused");
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
			assert.throws(() => assertApprovedRevisionGraph({ ...restarting, inputSha256: graphInputSha256(value.directory) }), /approved lifecycle statuses/);
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
			assert.deepEqual(reply.actions, []);
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
		assert.deepEqual(reply.actions, []);
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
			grantHostAttention(manager.store.getRun()!, { ...attentionResolutionFromRequest(request), action: "revise_run" });
			await manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "revise_run" } });
			record = readRunRevision(value.directory)!;
		} finally { manager.close(); }
		fs.appendFileSync(path.join(value.directory, "002-downstream.md"), "\nRevise the downstream implementation only.\n");
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		assert.deepEqual(prepared.selective!.retainedPlanIds, ["001"]);
		await confirmRunRevision(prepared);
		const revised = (await finishRunRevision(value.directory, record.editToken)).reply!;
		assert.deepEqual(revised.actions, [], "selective adoption does not resume execution");
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

for (const legacyHistory of [false, true]) test(`two selective revisions preserve attribution and unaffected unfinished plans and attention (legacy history: ${legacyHistory})`, { timeout: 60_000 }, async () => {
	const value = independentFixture();
	try {
		const { record, request } = await begin(value);
		fs.appendFileSync(path.join(value.directory, "001-upstream.md"), "\nFirst API revision.\n");
		// The historical v1 flow reset all unfinished plans, unlike v2 preservation.
		if (legacyHistory) fs.appendFileSync(path.join(value.directory, "002-downstream.md"), "\nHistorical consumer revision.\n");
		await confirmRunRevision(await prepareRunRevision(value.directory, record.editToken));
		await finishRunRevision(value.directory, record.editToken);
		const history = legacyHistory ? installLegacyHistory(value.directory, "complete").legacy : readRunRevision(value.directory)!;
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
			grantHostAttention(manager.store.getRun()!, { ...attentionResolutionFromRequest(next), action: "revise_run" });
			await manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(next), action: "revise_run" } });
			second = readRunRevision(value.directory)!;
			assert.deepEqual(second.priorSelectiveCommits, [...history.selective!.knownCommits, history.selective!.publication!.head]);
			assert.equal(second.state, "draft");
		} finally { manager.close(); }
		fs.appendFileSync(path.join(value.directory, "004-after.md"), "\nSecond independent API revision.\n");
		const prepared = await prepareRunRevision(value.directory, second.editToken);
		assert.equal(prepared.selective?.version, 2);
		assert.deepEqual(prepared.selective?.retainedPlanIds, ["003"]);
		assert.deepEqual(prepared.selective?.rerunPlanIds, ["004"]);
		assert.deepEqual(prepared.selective?.preservedPlanIds, ["001", "002"]);
		await confirmRunRevision(prepared);
		const reply = (await finishRunRevision(value.directory, second.editToken)).reply!;
		assert.deepEqual(reply.actions, []);
		const store = new RunStore(value.directory);
		try { assert.equal(store.getAttentionRequests(record.run.runId, { unresolvedOnly: true }).length, 1); assert.equal(store.getRun()?.currentGeneration, 3); }
		finally { store.close(); }
		assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "src/value.mjs"), "utf8"), "export const value = 1;\n");
		assert.equal(fs.existsSync(path.join(record.run.integrationWorktree, "src/after.mjs")), false);
		assert.equal(fs.readFileSync(path.join(record.run.integrationWorktree, "src/before.mjs"), "utf8"), "export const before = 3;\n");
	} finally { value.dispose(); }
});

test("confirmed legacy records without selective evidence cannot reset budgets or create a successor", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record } = await begin(value);
		revise(value);
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		const { selective: _, ...legacy } = prepared;
		writeRunRevision(value.directory, legacy, prepared);
		await confirmRunRevision(legacy);
		await assert.rejects(finishRunRevision(value.directory, record.editToken), /Legacy destructive/);
		const store = new RunStore(value.directory);
		try { assert.equal(store.getRun()?.currentGeneration, 1); assert.equal(store.getRun()?.runId, record.run.runId); assert.ok(store.getAttention(record.request.requestId)); }
		finally { store.close(); }
	} finally { value.dispose(); }
});


test("selective closure includes removed plans and old/new rewiring, but not independent DONE plans", () => {
	const spec = (planId: string, dependencies: string[] = [], planFingerprint = planId) => ({ planId, dependencies, planFingerprint }) as unknown as StoredPlanSpec;
	const previous = [spec("001"), spec("002", ["001"]), spec("003", ["002"]), spec("004")];
	const next = [spec("002", [], "rewired"), spec("003", ["002"]), spec("004"), spec("005", ["003"])];
	assert.deepEqual(selectivePlanSets(previous, next, new Set(["001", "002", "003", "004"])), { retainedPlanIds: ["004"], preservedPlanIds: [], rerunPlanIds: ["002", "003", "005"], removedPlanIds: ["001"] });
	assert.deepEqual(selectivePlanSets(previous, next, new Set(["001", "002", "003"])), { retainedPlanIds: [], preservedPlanIds: ["004"], rerunPlanIds: ["002", "003", "005"], removedPlanIds: ["001"] });
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
				await assert.rejects(finishRunRevision(value.directory, record.editToken), /Legacy destructive/);
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


test("user scope command can open a draft after a run-level stop without worker attention", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const manager = new HerderRunManager(value.directory);
		try {
			await manager.start({ mode: "fire", repositoryRoot: value.repo, planDirectory: value.directory, profile: "eclipse", maxParallel: 2 });
			for (const request of manager.store.getAttentionRequests(manager.store.getRun()!.runId)) manager.store.resolveAttention(request.requestId);
			manager.store.updateRun({ status: "paused", terminalDetail: "Final audit stopped" });
		} finally { manager.close(); }
		await assert.rejects(beginUserScopeAmendment(value.directory, { hasUI: false, ui: {} as never }, host), /interactive/);
		assert.equal(readRunRevision(value.directory), null);
		await assert.rejects(beginUserScopeAmendment(value.directory, { hasUI: true, ui: { confirm: async () => false } as never }, host), /dismissed/);
		assert.equal(readRunRevision(value.directory), null);
		await beginUserScopeAmendment(value.directory, { hasUI: true, ui: { confirm: async (_title: string, body: string) => { assert.match(body, /Generation: 1/); assert.match(body, /budgets are unchanged/); return true; } } as never }, host);
		assert.equal(readRunRevision(value.directory)?.state, "draft");
		assert.equal(readRunRevision(value.directory)?.request.planId, "RUN");
	} finally { value.dispose(); }
});

test("scope preview displays exact acceptance and permission changes, additions and removals", () => {
	const spec = (id: string, text: string, paths: string[]): StoredPlanSpec => ({ planId: id, planFingerprint: sha256(text), dependencies: [], assignment: { planText: text, plan: { inScopePaths: paths } } }) as unknown as StoredPlanSpec;
	const preview = scopeChangePreview([spec("001", "Acceptance: old\nPermission: src/old", ["src/old"]), spec("002", "Removed acceptance", [])], [spec("001", "Acceptance: new\nPermission: src/new", ["src/new"]), spec("003", "Added acceptance", [])]);
	assert.match(preview, /CHANGED plan 001/); assert.match(preview, /- Acceptance: old/); assert.match(preview, /\+ Acceptance: new/);
	assert.match(preview, /Permissions before: \["src\/old"\]/); assert.match(preview, /Permissions after: \["src\/new"\]/);
	assert.match(preview, /REMOVED plan 002/); assert.match(preview, /ADDED plan 003/);
});

for (const stage of ["prepare", "confirm", "cleanup"] as const) {
	for (const mutation of ["unstaged", "staged", "untracked", "ignored", "committed"] as const) {
		test(`selective revision ${stage} ${stage === "prepare" ? "authorizes affected discard of" : "refuses newly changed"} non-DONE ${mutation} work`, { timeout: 30_000 }, async () => {
			const value = fixture();
			try {
				const { record } = await begin(value);
				const driver = revisionDriver(record.run);
				const store = new RunStore(value.directory);
				let worktree: string;
				try {
					const spec = store.getPlanSpecs(record.run.runId).find(spec => spec.planId === "002")!;
					const base = driver.branchHead(record.run.integrationBranch);
					const execution = driver.ensurePlanWorktree("002", spec.assignment, base);
					worktree = execution.worktree;
					store.putPlan({ runId: record.run.runId, planId: "002", generation: 1, round: 1, phase: "IMPLEMENTING",
						branch: execution.branch, worktree, generationBase: base,
						assignmentPath: execution.assignment.bundlePath, assignmentSha256: execution.assignment.bundleSha256,
						snapshotSha256: execution.assignment.snapshotSha256, reviewPass: 0, findings: [], repair: [], gates: [],
						approvedBase: null, approvedHead: null, approvedTree: null, rebase: null });
				} finally { store.close(); }
				revise(value);
				const prepared = stage === "prepare" ? null : await prepareRunRevision(value.directory, record.editToken);
				if (stage === "cleanup") await confirmRunRevision(prepared!);
				const file = mutation === "untracked" ? "unfinished.txt" : mutation === "ignored" ? ".herder/ignored.txt" : "src/other.mjs";
				fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
				const contents = "// unfinished work must survive amendment\n";
				fs.writeFileSync(path.join(worktree, file), contents);
				if (mutation === "staged" || mutation === "committed") git(worktree, ["add", file]);
				if (mutation === "committed") git(worktree, ["commit", "-qm", "unreviewed work"]);
				const refs = driver.readIntegrationRepairNamespace().refs;
				const status = driver.worktreeStatus(worktree);
				const revision = readRunRevision(value.directory);
				const operation = stage === "prepare" ? () => prepareRunRevision(value.directory, record.editToken)
					: stage === "confirm" ? () => confirmRunRevision(prepared!) : () => finishRunRevision(value.directory, record.editToken);
				if (stage === "prepare") {
					const preview = await prepareRunRevision(value.directory, record.editToken);
					const artifact = preview.selective!.artifacts.find(item => item.plan.planId === "002")!;
					assert.ok(artifact.snapshot.sha256);
					assert.equal(artifact.unreviewedCommits.length, mutation === "committed" ? 1 : 0);
					if (mutation !== "committed") assert.ok(artifact.snapshot[mutation === "unstaged" ? "tracked" : mutation] > 0);
					await confirmRunRevision(preview);
					assert.deepEqual((await finishRunRevision(value.directory, record.editToken)).reply!.actions, []);
					assert.equal(fs.existsSync(worktree), false);
					return;
				}
				await assert.rejects(operation, /snapshot changed|inventory changed|moved|foreign refs/);
				assert.equal(fs.readFileSync(path.join(worktree, file), "utf8"), contents);
				assert.equal(driver.worktreeStatus(worktree), status);
				assert.deepEqual(driver.readIntegrationRepairNamespace().refs, refs);
				assert.deepEqual(readRunRevision(value.directory), revision);
			} finally { value.dispose(); }
		});
	}
}

function unfinishedPlan(value: ReturnType<typeof fixture>, run: NonNullable<ReturnType<RunStore["getRun"]>>, id = "002") {
	const store = new RunStore(value.directory);
	try {
		const driver = revisionDriver(run), spec = store.getPlanSpecs(run.runId).find(spec => spec.planId === id)!;
		const base = driver.branchHead(run.integrationBranch), execution = driver.ensurePlanWorktree(id, spec.assignment, base);
		store.putPlan({ runId: run.runId, planId: id, generation: run.currentGeneration, round: 1, phase: "BLOCKED", branch: execution.branch, worktree: execution.worktree,
			generationBase: base, assignmentPath: execution.assignment.bundlePath, assignmentSha256: execution.assignment.bundleSha256, snapshotSha256: execution.assignment.snapshotSha256,
			reviewPass: 0, findings: [], repair: ["Preserve stopped work"], gates: [], approvedBase: null, approvedHead: null, approvedTree: null, rebase: null });
		return store.getPlan(run.runId, id)!;
	} finally { store.close(); }
}

for (const stage of ["confirmation", "publication", "deletion"] as const) for (const kind of ["tracked", "staged", "untracked", "ignored"] as const) {
	test(`same-path same-status ${kind} byte edit before ${stage} refuses approved discard`, { timeout: 30_000 }, async () => {
		const value = fixture(), originalReset = GitDriver.prototype.resetPlanExecution;
		try {
			const { record } = await begin(value), plan = unfinishedPlan(value, record.run);
			const file = path.join(plan.worktree, kind === "ignored" ? ".herder/ignored.txt" : kind === "untracked" ? "untracked.txt" : "src/other.mjs");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, "first dirty bytes\n");
			if (kind === "staged") git(plan.worktree, ["add", file]);
			revise(value);
			const prepared = await prepareRunRevision(value.directory, record.editToken);
			const status = revisionDriver(record.run).worktreeStatus(plan.worktree);
			if (kind === "ignored") assert.equal(git(plan.worktree, ["check-ignore", file]).status, 0);
			const change = () => { fs.writeFileSync(file, "other dirty bytes\n"); if (kind === "staged") git(plan.worktree, ["add", file]); };
			if (stage !== "confirmation") await confirmRunRevision(prepared);
			if (stage === "deletion") GitDriver.prototype.resetPlanExecution = function(input) {
				return originalReset.call(this, { ...input, onPrepare: step => { input.onPrepare?.(step); if (input.worktree === plan.worktree && step === "worktree_removed") change(); } });
			};
			else change();
			await assert.rejects(stage === "confirmation" ? confirmRunRevision(prepared) : finishRunRevision(value.directory, record.editToken), /destructive snapshot changed/);
			assert.equal(revisionDriver(record.run).worktreeStatus(plan.worktree), status);
			assert.equal(fs.readFileSync(file, "utf8"), "other dirty bytes\n");
			assert.equal(git(value.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${plan.branch}`]).status, 0);
		} finally { GitDriver.prototype.resetPlanExecution = originalReset; value.dispose(); }
	});
}

for (const state of ["complete", "abandoned"] as const) test(`terminal selective v1 ${state} remains immutable history for status and resume`, { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record } = await begin(value);
		revise(value);
		await confirmRunRevision(await prepareRunRevision(value.directory, record.editToken));
		await finishRunRevision(value.directory, record.editToken);
		const { legacy, file, bytes } = installLegacyHistory(value.directory, state);
		assert.deepEqual(readRunRevision(value.directory), legacy);
		await assert.rejects(confirmRunRevision(legacy), /history only/);
		await assert.rejects(finishRunRevision(value.directory, record.editToken), /history only/);
		await assert.rejects(finishWholeRunEdit(value.directory, record.editToken, { hasUI: true, ui: { confirm: async () => assert.fail("legacy history cannot request confirmation") } as never }, host), /history only/);
		const manager = new HerderRunManager(value.directory);
		try {
			assert.equal(manager.reply().status, "paused");
			const reply = await manager.start({ mode: "resume", repositoryRoot: value.repo, planDirectory: value.directory });
			assert.equal(reply.runId, record.run.runId);
			assert.equal(manager.store.getRun()!.currentGeneration, 2);
			assert.equal(reply.actions.length, 2);
		} finally { manager.close(); }
		assert.equal(fs.readFileSync(file, "utf8"), bytes, "reads/resume never normalize legacy evidence");
		for (const mutation of ["preview", "generation", "envelope"] as const) {
			const changed = structuredClone(legacy);
			if (mutation === "preview") changed.selective.previewSha256 = "0".repeat(64);
			if (mutation === "generation") {
				changed.selective.nextGeneration++;
				changed.selective.previewSha256 = selectivePreviewSha256(changed.selective);
			}
			fs.writeFileSync(file, stableJson({ record: changed, sha256: mutation === "envelope" ? "0".repeat(64) : sha256(stableJson(changed)) }));
			assert.throws(() => readRunRevision(value.directory), /Invalid .*revision/);
		}
	} finally { value.dispose(); }
});

for (const state of ["prepared", "confirmed", "resetting"] as const) test(`legacy selective v1 ${state} never receives destructive authority`, { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record, worktree } = await begin(value);
		revise(value);
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		const legacy = JSON.parse(JSON.stringify({ ...prepared, state }));
		legacy.selective.version = 1;
		delete legacy.selective.preservedPlanIds;
		for (const artifact of legacy.selective.artifacts) { delete artifact.snapshot; delete artifact.unreviewedCommits; }
		legacy.selective.previewSha256 = selectivePreviewSha256(legacy.selective);
		fs.writeFileSync(path.join(value.directory, ".herder/run-revision.json"), stableJson({ record: legacy, sha256: sha256(stableJson(legacy)) }), { mode: 0o600 });
		assert.throws(() => readRunRevision(value.directory), /Legacy selective revision is paused/);
		await assert.rejects(finishRunRevision(value.directory, record.editToken), /explicit operator recovery/);
		assert.ok(fs.existsSync(worktree));
	} finally { value.dispose(); }
});

test("independent amendment preserves blocked runtime, dirty/unreviewed work, opening attention and old-generation retry", { timeout: 60_000 }, async () => {
	const value = fixture();
	try {
		const index = path.join(value.directory, "README.md");
		fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("| 001 | BLOCKED", "| — | BLOCKED").replace("\n\n## Dependency notes", "\n| [003](003-rejected.md) | Rejected | P1 | S | — | REJECTED — preserve rejection |\n\n## Dependency notes"));
		fs.writeFileSync(path.join(value.directory, "002-downstream.md"), fixturePlan({ id: "002", title: "Downstream", writePaths: ["src/other.mjs"] }));
		fs.writeFileSync(path.join(value.directory, "003-rejected.md"), fixturePlan({ id: "003", title: "Rejected", writePaths: ["src/rejected.mjs"] }));
		const manager = new HerderRunManager(value.directory);
		let record, savedPlan, request: ManagerAttentionRequest, budget: ReturnType<RunStore["getBudget"]>, ledger: unknown;
		try {
			await manager.start({ mode: "fire", repositoryRoot: value.repo, planDirectory: value.directory, profile: "eclipse", maxParallel: 2 });
			const run = manager.store.getRun()!;
			completeFixturePlan(value, manager.store, "001", "src/value.mjs", "export const value = 2;\n");
			savedPlan = unfinishedPlan(value, run);
			fs.writeFileSync(path.join(savedPlan.worktree, "src/other.mjs"), "// unreviewed committed work\n");
			git(savedPlan.worktree, ["add", "src/other.mjs"]); git(savedPlan.worktree, ["commit", "-qm", "unreviewed"]);
			fs.writeFileSync(path.join(savedPlan.worktree, "unfinished.txt"), "untracked survives");
			fs.mkdirSync(path.join(savedPlan.worktree, ".herder"), { recursive: true });
			fs.writeFileSync(path.join(savedPlan.worktree, ".herder/ignored.txt"), "ignored survives");
			fs.appendFileSync(path.join(savedPlan.worktree, "src/other.mjs"), "// dirty survives\n");
			for (const pending of manager.store.getAttentionRequests(run.runId)) manager.store.resolveAttention(pending.requestId);
			const requestId = randomUUID(), detail = "Stopped transport for preserved plan";
			request = { schemaVersion: 1, requestId, runId: run.runId, planId: "002", generation: 1, round: 1, actionId: null,
				kind: "operator_attention", state: "awaiting_input", cause: "transport_exhausted", detail, detailSha256: sha256(detail),
				continuation: { role: "plan-implementer", phase: "READY_IMPLEMENTER" }, requestSha256: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
			request.requestSha256 = attentionRequestSha256(request);
			manager.store.putAttention(request);
			request = manager.store.getAttention(requestId)!;
			const resolution = { ...attentionResolutionFromRequest(request), action: "revise_run" };
			grantHostAttention(run, resolution);
			await manager.event({ eventId: randomUUID(), kind: "attention", attention: resolution });
			record = readRunRevision(value.directory)!;
			budget = manager.store.getBudget(run.runId);
			ledger = manager.store.database.prepare("SELECT * FROM manager_budget_ledger").all();
		} finally { manager.close(); }
		const before = destructiveSnapshot(savedPlan.worktree), inode = fs.statSync(savedPlan.worktree).ino;
		fs.appendFileSync(path.join(value.directory, "001-upstream.md"), "\nIndependent upstream amendment.\n");
		const prepared = await prepareRunRevision(value.directory, record.editToken);
		assert.deepEqual(prepared.selective!.preservedPlanIds, ["002", "003"]);
		assert.deepEqual(prepared.selective!.artifacts.map(item => item.plan.planId), ["001"]);
		await confirmRunRevision(prepared);
		const reply = (await finishRunRevision(value.directory, record.editToken)).reply!;
		assert.equal(reply.status, "paused"); assert.deepEqual(reply.actions, []);
		assert.equal(reply.attention?.requestId, request.requestId);
		assert.deepEqual(destructiveSnapshot(savedPlan.worktree), before); assert.equal(fs.statSync(savedPlan.worktree).ino, inode);
		assert.deepEqual(buildGraph(value.directory).plans.map(plan => plan.status), ["TODO", "BLOCKED", "REJECTED"]);
		for (let reopen = 0; reopen < 2; reopen++) {
			const replay: ManagerReply = (await finishRunRevision(value.directory, record.editToken)).reply!;
			assert.equal(replay.status, "paused");
			assert.equal(replay.attention?.requestId, request.requestId);
			const audit = new HerderRunManager(value.directory);
			try {
				const plans = audit.store.getPlans(record.run.runId), actions = audit.store.getActions(record.run.runId);
				for (let tick = 0; tick < 3; tick++) {
					const reply = await audit.auditScheduler();
					assert.equal(reply.status, "paused"); assert.deepEqual(reply.actions, []);
					assert.equal(reply.attention?.requestId, request.requestId);
					assert.deepEqual(audit.store.getPlans(record.run.runId), plans);
					assert.deepEqual(audit.store.getActions(record.run.runId), actions);
					assert.equal(audit.store.getPlan(record.run.runId, "001"), null);
					assert.deepEqual(audit.store.getBudget(record.run.runId), { ...budget, generation: 2, graphSha256: prepared.graphSha256 });
					assert.deepEqual(audit.store.database.prepare("SELECT * FROM manager_budget_ledger").all(), ledger);
				}
			} finally { audit.close(); }
		}
		const recovered = new HerderRunManager(value.directory);
		try {
			assert.deepEqual(recovered.store.getPlan(record.run.runId, "002"), savedPlan);
			assert.deepEqual(recovered.store.getAttention(request.requestId), request);
			assert.deepEqual(recovered.store.getBudget(record.run.runId), { ...budget, generation: 2, graphSha256: prepared.graphSha256 });
			assert.deepEqual(recovered.store.database.prepare("SELECT * FROM manager_budget_ledger").all(), ledger);
			const stale = { runId: record.run.runId, generation: 1, reservationId: "invalid-old-generation", kind: "verification", planId: "002", round: 1, payloadSha256: "invalid" };
			assert.throws(() => recovered.store.reserveBudget(stale), /generation is stale/);
			assert.throws(() => recovered.store.reserveBudget({ ...stale, kind: "action:plan-implementer", round: 2 }), /generation is stale/);
			assert.throws(() => recovered.store.reserveBudget({ ...stale, kind: "action:plan-implementer", planId: "001" }), /generation is stale/);
			const resolution = { ...attentionResolutionFromRequest(request), action: "retry", rationale: "Retry exact stopped transport" };
			grantHostAttention(recovered.store.getRun()!, resolution);
			const retry = await recovered.event({ eventId: randomUUID(), kind: "attention", attention: resolution });
			assert.equal(recovered.store.getAttention(request.requestId)!.state, "resolved");
			assert.ok(retry.actions.some(action => action.planId === "002" && action.generation === 1 && action.round === 1 && action.assignmentSha256 === savedPlan.assignmentSha256));
		} finally { recovered.close(); }
	} finally { value.dispose(); }
});

test("destructive snapshot hashes symlink targets without following and refuses nested Git or special files", () => {
	const value = fixture();
	try {
		const external = path.join(value.root, "external"); fs.writeFileSync(external, "outside");
		fs.symlinkSync(external, path.join(value.repo, "link"));
		const first = destructiveSnapshot(value.repo);
		fs.writeFileSync(external, "outside changed");
		assert.deepEqual(destructiveSnapshot(value.repo), first);
		fs.unlinkSync(path.join(value.repo, "link")); fs.symlinkSync("different target", path.join(value.repo, "link"));
		assert.notEqual(destructiveSnapshot(value.repo).sha256, first.sha256);
		fs.mkdirSync(path.join(value.repo, "nested/.git"), { recursive: true });
		assert.throws(() => destructiveSnapshot(value.repo), /nested Git/);
		fs.rmSync(path.join(value.repo, "nested"), { recursive: true });
		assert.equal(spawnSync("mkfifo", [path.join(value.repo, "pipe")]).status, 0);
		assert.throws(() => destructiveSnapshot(value.repo), /unsafe special file/);
	} finally { value.dispose(); }
});

test("exact host preview lists affected dirty/committed artifacts; no UI and dismissal cannot discard", { timeout: 30_000 }, async () => {
	const value = fixture();
	try {
		const { record } = await begin(value), plan = unfinishedPlan(value, record.run);
		fs.writeFileSync(path.join(plan.worktree, "src/other.mjs"), "// secret committed bytes\n");
		git(plan.worktree, ["add", "src/other.mjs"]); git(plan.worktree, ["commit", "-qm", "unreviewed"]);
		const unreviewed = revisionDriver(record.run).branchHead(plan.branch);
		fs.writeFileSync(path.join(plan.worktree, "src/other.mjs"), "// secret staged bytes\n"); git(plan.worktree, ["add", "src/other.mjs"]);
		fs.appendFileSync(path.join(plan.worktree, "src/other.mjs"), "// secret unstaged bytes\n");
		fs.writeFileSync(path.join(plan.worktree, "untracked.txt"), "secret untracked bytes");
		fs.mkdirSync(path.join(plan.worktree, ".herder"), { recursive: true });
		fs.writeFileSync(path.join(plan.worktree, ".herder/ignored.txt"), "secret ignored bytes");
		revise(value);
		const before = destructiveSnapshot(plan.worktree);
		await assert.rejects(finishWholeRunEdit(value.directory, record.editToken, { hasUI: false, ui: {} as never }, host), /interactive host confirmation/);
		await assert.rejects(finishWholeRunEdit(value.directory, record.editToken, { hasUI: true, ui: { confirm: async (_title: string, body: string) => {
			assert.match(body, /Preserve unfinished plans: none/); assert.match(body, /Rerun plans: 001, 002/);
			assert.ok(body.includes(plan.branch) && body.includes(plan.worktree) && body.includes(unreviewed));
			assert.match(body, /Dirty tracked \(unstaged\): 1; staged: 1; untracked: 1; ignored: [1-9]/);
			assert.match(body, /BOTH old and new dependency graphs/); assert.match(body, /source checkout and branch will not be reset/);
			assert.match(body, /no additional effort and does not resume execution/); assert.doesNotMatch(body, /secret (?:committed|staged|unstaged|untracked|ignored) bytes/);
			return false;
		} } as never }, host), /Confirmation dismissed/);
		assert.deepEqual(destructiveSnapshot(plan.worktree), before);
		assert.equal(revisionDriver(record.run).branchHead(plan.branch), unreviewed);
	} finally { value.dispose(); }
});

for (const stage of ["draft", "prepared", "confirmed", "legacy", "after_publication", "after_cleanup_worktree_removed", "after_cleanup_branch_deleted", "after_restarting", "after_restart", "after_complete"]) {
	test(`explicit host reset supersedes revision ${stage} without completion proofs or adoption`, { timeout: 45_000 }, async () => {
		const value = fixture();
		try {
			const { record } = await begin(value);
			const unfinished = unfinishedPlan(value, record.run);
			fs.writeFileSync(path.join(unfinished.worktree, "src/other.mjs"), "unreviewed commit\n");
			git(unfinished.worktree, ["commit", "-qam", "unreviewed"]);
			fs.writeFileSync(path.join(unfinished.worktree, "src/other.mjs"), "dirty\n");
			fs.writeFileSync(path.join(unfinished.worktree, "untracked.txt"), "untracked\n");
			fs.mkdirSync(path.join(unfinished.worktree, ".herder"), { recursive: true });
			fs.writeFileSync(path.join(unfinished.worktree, ".herder/ignored.txt"), "ignored\n");
			revise(value);
			if (stage !== "draft") {
				const prepared = await prepareRunRevision(value.directory, record.editToken);
				if (stage === "legacy") {
					const { legacy, file } = installLegacyHistory(value.directory, "complete");
					const pending = { ...legacy, state: "prepared" };
					fs.writeFileSync(file, stableJson({ record: pending, sha256: sha256(stableJson(pending)) }));
					assert.throws(() => readRunRevision(value.directory), /Legacy selective revision is paused/);
				} else if (stage !== "prepared") await confirmRunRevision(prepared);
			}
			if (stage.startsWith("after_")) {
				const module = new URL("../../../src/application/run-revision.ts", import.meta.url).href;
				const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { finishRunRevision } from ${JSON.stringify(module)}; await finishRunRevision(${JSON.stringify(value.directory)}, ${JSON.stringify(record.editToken)});`], { env: { ...process.env, HERDER_TEST_RUN_REVISION_CRASH_AT: stage }, encoding: "utf8", timeout: 25_000 });
				assert.equal(child.signal, "SIGKILL", child.stderr);
			}
			const draft = fs.readFileSync(path.join(value.directory, "001-upstream.md"), "utf8");
			const context = { repositoryRoot: value.repo, planDirectory: value.directory };
			const recordBytes = fs.readFileSync(path.join(value.directory, ".herder/run-revision.json"), "utf8");
			assert.match(await runResetCommand({ ...context, confirm: async () => false }), /cancelled/);
			assert.equal(fs.readFileSync(path.join(value.directory, ".herder/run-revision.json"), "utf8"), recordBytes);
			assert.match(await runResetCommand({ ...context, confirm: async () => true }), /reset executed/);
			assert.equal(readRunRevision(value.directory), null);
			assert.equal(fs.existsSync(path.join(value.directory, ".herder/attention-host-grant.json")), false);
			assert.equal(fs.readFileSync(path.join(value.directory, "001-upstream.md"), "utf8"), draft);
			assert.equal(git(value.repo, ["rev-parse", "HEAD"]).stdout.trim(), value.originalHead);
			await applyHerderReset({ repoRoot: value.repo, planDirectory: value.directory });
			const manager = new HerderRunManager(value.directory);
			try {
				assert.equal(manager.store.getRun(), null);
				const reply = await manager.start({ mode: "fire", repositoryRoot: value.repo, planDirectory: value.directory, profile: "eclipse", maxParallel: 2 });
				assert.notEqual(reply.runId, record.run.runId);
				assert.ok(reply.actions.length > 0);
			} finally { manager.close(); }
		} finally { value.dispose(); }
	});
}
