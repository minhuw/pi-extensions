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
import { RunStore } from "../../../src/daemon/run-store.ts";
import { git } from "../../../src/daemon/git-driver.ts";
import { attentionResolutionFromRequest } from "../../../adapters/attention.ts";
import { assertApprovedRevisionGraph, confirmRunRevision, prepareRunRevision, readRunRevision, revisionDriver, writeRunRevision } from "../../../src/core/run-revision.ts";
import { finishRunRevision } from "../../../src/application/run-revision.ts";
import { graphInputSha256 } from "../../../src/core/plan-edit.ts";
import { compileGraphIdentity } from "../../../src/core/plan-identity.ts";
import { finishWholeRunEdit, cancelWholeRunEdit, wholeRunToolPolicy, type RunRevisionHost } from "../../../adapters/run-revision.ts";
import type { ManagerAttentionRequest } from "../../../src/shared/protocol.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-run-revision-"));
	const { repo, originalHead } = initFixtureRepo(root, { name: "Revision", email: "revision@example.invalid", files: { "src/value.mjs": "export const value = 1;\n", "src/other.mjs": "export const other = 1;\n" } });
	const directory = path.join(repo, "herder-plans");
	initPlanDir(directory);
	fs.writeFileSync(path.join(directory, "README.md"), `# Revision\n\n## Execution order & status\n\n| Plan | Title | Priority | Effort | Depends on | Status |\n|---|---|---|---|---|---|\n| [001](001-upstream.md) | Upstream | P1 | S | — | DONE |\n| [002](002-downstream.md) | Downstream | P1 | S | 001 | BLOCKED — revise the upstream contract |\n\n## Dependency notes\n\n002 consumes 001.\n\n## Considered and rejected\n\nNone.\n`);
	fs.writeFileSync(path.join(directory, "001-upstream.md"), fixturePlan({ id: "001", title: "Upstream" }));
	fs.writeFileSync(path.join(directory, "002-downstream.md"), fixturePlan({ id: "002", title: "Downstream", dependencies: "001", writePaths: ["src/other.mjs"] }));
	return { root, repo, directory, originalHead, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function begin(value: ReturnType<typeof fixture>) {
	const manager = new HerderRunManager(value.directory);
	try {
		const reply = await manager.start({ mode: "fire", repositoryRoot: value.repo, planDirectory: value.directory, profile: "eclipse", maxParallel: 2 });
		const store = new RunStore(value.directory);
		let worktree: string;
		try {
			const run = store.getRun()!;
			const driver = revisionDriver(run);
			const spec = store.getPlanSpecs(run.runId).find(spec => spec.planId === "001")!;
			const execution = driver.ensurePlanWorktree("001", spec.assignment);
			worktree = execution.worktree;
			fs.writeFileSync(path.join(worktree, "src/value.mjs"), "export const value = 2;\n");
			git(worktree, ["add", "src/value.mjs"]);
			git(worktree, ["commit", "-qm", "upstream implementation"]);
			const head = driver.worktreeHead(worktree);
			git(run.integrationWorktree, ["merge", "--ff-only", head]);
			store.putPlan({ runId: run.runId, planId: "001", generation: 1, round: 1, phase: "DONE", branch: execution.branch, worktree,
				assignmentPath: execution.assignment.bundlePath, assignmentSha256: execution.assignment.bundleSha256, snapshotSha256: execution.assignment.snapshotSha256, generationBase: value.originalHead,
				reviewPass: 1, findings: [], repair: [], gates: [], approvedBase: value.originalHead, approvedHead: head, approvedTree: driver.worktreeTree(worktree), rebase: null });
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
		assert.equal(result.reply?.runId, record.successorRunId);
		assert.equal(result.reply?.actions.length, 2);
		assert.ok(result.reply?.actions.some(action => fs.readFileSync(action.assignmentPath, "utf8").includes("revised numeric API")));
		const store = new RunStore(value.directory, { readOnly: true });
		try {
			assert.equal(store.getRun()?.baseCommit, value.originalHead);
			assert.equal(store.getRun()?.profileName, "eclipse");
			assert.equal(store.getRun()?.maxParallel, 2);
			assert.deepEqual(store.getPlanSpecs(record.successorRunId).map(spec => [spec.planId, spec.initialStatus, spec.dependencies]), [["001", "TODO", []], ["002", "TODO", []]]);
			assert.equal(store.getAttention(request.requestId), null);
			assert.ok(store.getPlans(record.successorRunId).every(plan => plan.generationBase === value.originalHead && plan.round === 1 && !plan.approvedHead));
		} finally { store.close(); }
		assert.equal(git(value.repo, ["rev-parse", "HEAD"]).stdout.trim(), value.originalHead);
		assert.equal(fs.readFileSync(path.join(value.repo, "src/value.mjs"), "utf8"), "export const value = 1;\n");
		assert.equal(fs.readFileSync(path.join(worktree, "src/value.mjs"), "utf8"), "export const value = 1;\n");
		const replay = await finishRunRevision(value.directory, record.editToken);
		assert.equal(replay.reply?.runId, result.reply?.runId);
		const manager = new HerderRunManager(value.directory);
		try { await assert.rejects(manager.event({ eventId: randomUUID(), kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "abandon_run" } }), /not recorded/); }
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
		await assert.rejects(prepareRunRevision(value.directory, record.editToken), /every plan TODO/);
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

for (const point of ["after_reset", "after_restarting", "after_restart", "after_complete"]) {
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
			assert.equal(reply.runId, record.successorRunId);
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
				await assert.rejects(manager.start({ mode: point === "after_restart" ? "resume" : "fire", repositoryRoot: record.run.repositoryRoot, planDirectory: value.directory, profile: "eclipse", maxParallel: 2 }), /Markdown changed after host confirmation/);
				const run = manager.store.getRun();
				if (point === "after_restarting") assert.equal(run, null, "unapproved successor must never be created");
				if (run) assert.equal(manager.store.countActions(run.runId), 0, "no skipped or partial execution may start");
			} finally { manager.close(); }
			assert.equal(readRunRevision(value.directory)?.state, "restarting");
			fs.writeFileSync(index, approved);
			const reply = (await finishRunRevision(value.directory, record.editToken)).reply!;
			assert.equal(reply.runId, record.successorRunId);
			assert.deepEqual(reply.actions.map(action => action.planId), ["001", "002"]);
		} finally { value.dispose(); }
	});
}
