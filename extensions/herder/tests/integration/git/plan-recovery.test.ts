import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git, runCommand } from "../../../src/daemon/git-driver.ts";
import { resetPlanExecution } from "../../../src/daemon/git/reset-plan.ts";

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

test("manager reset refuses the user checkout and distinguishes recorded partial absence", () => {
	const value = fixture("herder-plan-reset-safety-");
	try {
		assert.throws(() => resetPlanExecution({ ...resetInput(value), worktree: value.repo }), /user checkout|worktree root/);
		git(value.repo, ["worktree", "remove", "--force", value.worktree]);
		git(value.repo, ["update-ref", "-d", `refs/heads/${value.branch}`, value.head]);
		assert.throws(() => resetPlanExecution(resetInput(value)), /missing before its destructive apply/);
		const replay = resetPlanExecution(resetInput(value, { allowRecordedMissing: true }));
		assert.equal(replay.alreadyMissing, true);
	} finally {
		cleanup(value);
	}
});
