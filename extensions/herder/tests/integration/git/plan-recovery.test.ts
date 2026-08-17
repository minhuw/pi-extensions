import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { git, runCommand } from "../../../src/daemon/git-driver.ts";
import { resetPlanExecution, type ResetPlanCleanupStep } from "../../../src/daemon/git/reset-plan.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { canonicalEventPayload } from "../../../src/shared/protocol.ts";

function fixture(prefix: string): { root: string; repo: string; worktreeRoot: string; branch: string; worktree: string; head: string; tree: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const repo = path.join(root, "repo");
	const worktreeRoot = path.join(root, "worktrees");
	fs.mkdirSync(repo, { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", "Git reset test"]);
	git(repo, ["config", "user.email", "git-reset@example.invalid"]);
	fs.writeFileSync(path.join(repo, "value.txt"), "one\n");
	git(repo, ["add", "value.txt"]);
	git(repo, ["commit", "-q", "-m", "test: create reset fixture"]);
	const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
	const tree = git(repo, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
	const branch = "herder/plans/001";
	const worktree = path.join(worktreeRoot, "001");
	fs.mkdirSync(worktreeRoot, { recursive: true });
	git(repo, ["worktree", "add", "-q", "-b", branch, worktree, head]);
	return { root, repo, worktreeRoot, branch, worktree, head, tree };
}

function withWorktreeShim<T>(branch: string, mode: "replace" | "append", callback: () => T): T {
	const originalPath = process.env.PATH ?? "";
	const realPath = originalPath.replaceAll("'", "'\\\"'\\\"'");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-recovery-shim-"));
	const shim = path.join(directory, "git");
	const record = `branch refs/heads/${branch}`;
	fs.writeFileSync(shim, `#!/bin/sh
real_git() { PATH='${realPath}'; export PATH; command git "$@"; }
case "$*" in
	*"worktree list --porcelain -z"*)
		${mode === "replace" ? `printf '${record}\\0\\0'` : `real_git "$@"; printf '${record}\\0\\0'`}
		exit ;;
esac
real_git "$@"
`);
	fs.chmodSync(shim, 0o755);
	process.env.PATH = `${directory}:${originalPath}`;
	try { return callback(); } finally {
		process.env.PATH = originalPath;
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

function cleanup(value: { root: string }): void {
	fs.rmSync(value.root, { recursive: true, force: true });
}

function resetInput(value: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) {
	return {
		repoRoot: value.repo,
		worktreeRoot: value.worktreeRoot,
		integrationWorktree: path.join(value.worktreeRoot, "integration"),
		branch: value.branch,
		worktree: value.worktree,
		expectedHead: value.head,
		expectedTree: value.tree,
		...extra,
	} as Parameters<typeof resetPlanExecution>[0];
}

test("recovery rejects a pathless exact target before mutation", () => {
	const value = fixture("herder-plan-reset-pathless-target-");
	try {
		assert.throws(() => withWorktreeShim(value.branch, "replace", () => resetPlanExecution(resetInput(value))), /pathless worktree record/);
		assert.equal(fs.existsSync(value.worktree), true);
		assert.equal(git(value.repo, ["rev-parse", `refs/heads/${value.branch}`]).stdout.trim(), value.head);
	} finally { cleanup(value); }
});

test("recovery ignores an unrelated pathless record", () => {
	const value = fixture("herder-plan-reset-pathless-unrelated-");
	try {
		const result = withWorktreeShim("herder/plans/999", "append", () => resetPlanExecution(resetInput(value)));
		assert.equal(result.deletedBranch, true);
		assert.equal(fs.existsSync(value.worktree), false);
		assert.notEqual(git(value.repo, ["show-ref", "--verify", `refs/heads/${value.branch}`], true).status, 0);
	} finally { cleanup(value); }
});
test("manager reset force-removes dirty and untracked failed plan worktrees with CAS branch deletion", () => {
	const value = fixture("herder-plan-reset-dirty-");
	try {
		fs.writeFileSync(path.join(value.worktree, "value.txt"), "dirty\n");
		fs.writeFileSync(path.join(value.worktree, "untracked.txt"), "discard me\n");
		const result = resetPlanExecution(resetInput(value));
		assert.equal(result.removedWorktree, true);
		assert.equal(result.deletedBranch, true);
		assert.equal(fs.existsSync(value.worktree), false);
		assert.notEqual(git(value.repo, ["show-ref", "--verify", `refs/heads/${value.branch}`], true).status, 0);
	} finally {
		cleanup(value);
	}
});

test("manager reset fails closed for locked and moved Git state", () => {
	const locked = fixture("herder-plan-reset-locked-");
	try {
		git(locked.repo, ["worktree", "lock", "--reason", "operator-lock", locked.worktree]);
		assert.throws(() => resetPlanExecution(resetInput(locked)), /locked/);
		assert.equal(fs.existsSync(locked.worktree), true);
		assert.equal(git(locked.repo, ["rev-parse", `refs/heads/${locked.branch}`]).stdout.trim(), locked.head);
	} finally {
		git(locked.repo, ["worktree", "unlock", locked.worktree], true);
		cleanup(locked);
	}

	const moved = fixture("herder-plan-reset-moved-");
	try {
		fs.writeFileSync(path.join(moved.worktree, "value.txt"), "moved\n");
		git(moved.worktree, ["add", "value.txt"]);
		git(moved.worktree, ["commit", "-q", "-m", "test: move failed branch"]);
		assert.throws(() => resetPlanExecution(resetInput(moved)), /branch moved|worktree moved/);
		assert.equal(fs.existsSync(moved.worktree), true);
	} finally {
		cleanup(moved);
	}
});

test("manager reset refuses the user checkout and caller-collidable cleanup evidence", () => {
	const value = fixture("herder-plan-reset-safety-");
	const planDirectory = path.join(value.root, "plan-store");
	fs.mkdirSync(planDirectory, { recursive: true });
	const store = new RunStore(planDirectory);
	try {
		store.createRun({
			runId: "reset-run",
			repositoryRoot: value.repo,
			planDirectory,
			planName: "plan-store",
			host: "pi",
			profileName: "eclipse",
			profileSha256: "a".repeat(64),
			maxParallel: 1,
			currentGeneration: 1,
			graphSha256: "b".repeat(64),
			status: "running",
			checkoutStateToken: "checkout-token",
			baseCommit: value.head,
			integrationBranch: "herder/plan-store/integration",
			integrationWorktree: path.join(value.worktreeRoot, "integration"),
		});
		assert.throws(() => resetPlanExecution({ ...resetInput(value), worktree: value.repo }), /user checkout|worktree root/);
		assert.throws(() => store.recordEvent("reset-run", "manager-attention-cleanup:request-1:branch_deleted", "attention", { requestId: "request-1", action: "defer" }), /private/);
		const forgedPayload = { requestId: "request-1", action: "defer" };
		const forgedCanonical = canonicalEventPayload(forgedPayload);
		store.database.prepare(`
			INSERT INTO manager_events (event_id, run_id, kind, payload_sha256, created_at)
			VALUES (?, ?, ?, ?, ?)
		`).run("attention-cleanup:request-1:branch_deleted", "reset-run", "attention", forgedCanonical.sha256, new Date().toISOString());
		git(value.repo, ["worktree", "remove", "--force", value.worktree]);
		git(value.repo, ["update-ref", "-d", `refs/heads/${value.branch}`, value.head]);
		assert.equal(store.getAttentionCleanupEvidence({
			runId: "reset-run",
			requestId: "request-1",
			requestSha256: "c".repeat(64),
			planId: "001",
			generation: 1,
			round: 1,
			assignmentPath: "assignment.json",
			assignmentSha256: "d".repeat(64),
			snapshotSha256: "e".repeat(64),
			generationBase: value.head,
			branch: value.branch,
			worktree: value.worktree,
			expectedHead: value.head,
			expectedTree: value.tree,
		}), null);
		assert.throws(() => resetPlanExecution(resetInput(value)), /missing before its destructive apply/);
	} finally {
		store.close();
		cleanup(value);
	}
});

test("manager cleanup replays a partial apply from typed pre-mutation evidence", () => {
	const value = fixture("herder-plan-reset-replay-");
	const planDirectory = path.join(value.root, "plan-store");
	fs.mkdirSync(planDirectory, { recursive: true });
	const store = new RunStore(planDirectory);
	const identity = {
		runId: "reset-replay-run",
		requestId: "request-replay",
		requestSha256: "a".repeat(64),
		planId: "001",
		generation: 1,
		round: 1,
		assignmentPath: "assignment.json",
		assignmentSha256: "b".repeat(64),
		snapshotSha256: "c".repeat(64),
		generationBase: value.head,
		branch: value.branch,
		worktree: value.worktree,
		expectedHead: value.head,
		expectedTree: value.tree,
	};
	try {
		store.createRun({
			runId: identity.runId,
			repositoryRoot: value.repo,
			planDirectory,
			planName: "plan-store",
			host: "pi",
			profileName: "eclipse",
			profileSha256: "d".repeat(64),
			maxParallel: 1,
			currentGeneration: 1,
			graphSha256: "e".repeat(64),
			status: "running",
			checkoutStateToken: "checkout-token",
			baseCommit: value.head,
			integrationBranch: "herder/plan-store/integration",
			integrationWorktree: path.join(value.worktreeRoot, "integration"),
		});
		let crash = true;
		assert.throws(() => resetPlanExecution(resetInput(value, {
			onPrepare: (step: ResetPlanCleanupStep) => store.recordAttentionCleanupStep(identity, step),
			onProgress: (step: ResetPlanCleanupStep) => {
				if (step === "branch_deleted" && crash) throw new Error("simulated callback stop");
				store.recordAttentionCleanupCompletion(identity, step);
			},
			onComplete: (step: ResetPlanCleanupStep) => store.recordAttentionCleanupCompletion(identity, step),
		})), /simulated callback stop/);
		assert.equal(fs.existsSync(value.worktree), false);
		assert.notEqual(git(value.repo, ["rev-parse", `refs/heads/${value.branch}`], true).status, 0);
		const evidence = store.getAttentionCleanupEvidence(identity);
		assert.equal(evidence?.step, "branch_deleted");
		assert.equal(evidence?.state, "prepared");
		crash = false;
		const replay = resetPlanExecution(resetInput(value, {
			cleanupIdentity: identity,
			recordedCleanup: evidence ?? undefined,
			onPrepare: (step: ResetPlanCleanupStep) => store.recordAttentionCleanupStep(identity, step),
			onProgress: (step: ResetPlanCleanupStep) => store.recordAttentionCleanupCompletion(identity, step),
			onComplete: (step: ResetPlanCleanupStep) => store.recordAttentionCleanupCompletion(identity, step),
		}));
		assert.equal(replay.alreadyMissing, true);
		assert.equal(replay.deletedBranch, false);
		assert.equal(store.getAttentionCleanupEvidence(identity)?.state, "completed");
	} finally {
		store.close();
		cleanup(value);
	}
});
