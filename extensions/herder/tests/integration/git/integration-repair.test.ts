import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitDriver, git, runCommand } from "../../../src/daemon/git-driver.ts";

function fixture(): { root: string; driver: GitDriver; repo: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-integration-repair-git-"));
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo, { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", "Integration Repair Test"]);
	git(repo, ["config", "user.email", "integration-repair@example.invalid"]);
	fs.writeFileSync(path.join(repo, "value.txt"), "before\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "test: seed integration repair"]);
	const planDirectory = path.join(repo, "herder-plans");
	fs.mkdirSync(path.join(planDirectory, ".herder"), { recursive: true });
	const driver = new GitDriver({
		repoRoot: repo,
		planDirectory,
		planName: "repair-test",
		helperRoot: path.resolve("extensions/herder/src/daemon/git"),
	});
	fs.mkdirSync(driver.worktreeRoot, { recursive: true });
	git(repo, ["worktree", "add", "-q", "-b", driver.integrationBranch, driver.integrationWorktree, "HEAD"]);
	return { root, driver, repo };
}

test("repair commits are direct descendants and later rounds preserve the fixed parent", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "repaired\n");
		const first = driver.acceptIntegrationRepairCommit({ parent, round: 1, commitMessage: "fix: repair integrated verification" });
		assert.equal(first.parent, parent);
		assert.notEqual(first.head, parent);
		assert.deepEqual(first.changedPaths, ["value.txt"]);

		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "repaired again\n");
		const second = driver.acceptIntegrationRepairCommit({ parent, round: 2, currentHead: first.head, commitMessage: "fix: amend integrated verification" });
		assert.equal(second.parent, parent);
		assert.equal(second.supersededHead, first.head);
		assert.notEqual(second.head, first.head);
		const parents = git(driver.integrationWorktree, ["rev-list", "--parents", "-n", "1", second.head]).stdout.trim().split(/\s+/).slice(1);
		assert.deepEqual(parents, [parent]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("repair rejects a no-op and a moved worktree before accepting a commit", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1 }), /non-merge|non-empty diff/);
		git(driver.integrationWorktree, ["checkout", "--detach", "HEAD"]);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1 }), /symbolic|not on/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("later-round acceptance requires a dirty amendment or explicit replay evidence", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "round one\n");
		const first = driver.acceptIntegrationRepairCommit({ parent, round: 1, commitMessage: "fix: first repair" });
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 2, currentHead: first.head }), /dirty amendment|replay evidence/);
		assert.equal(driver.branchHead(driver.integrationBranch), first.head);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), first.head);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("an unrelated clean sibling is not accepted as a later-round replay", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "accepted\n");
		const first = driver.acceptIntegrationRepairCommit({ parent, round: 1, commitMessage: "fix: accepted repair" });
		git(driver.integrationWorktree, ["reset", "--hard", parent]);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "sibling\n");
		git(driver.integrationWorktree, ["add", "value.txt"]);
		git(driver.integrationWorktree, ["commit", "-q", "-m", "test: unrelated sibling"]);
		const sibling = driver.branchHead(driver.integrationBranch);
		assert.notEqual(sibling, first.head);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 2, currentHead: first.head }), /branch or worktree moved/);
		assert.equal(driver.branchHead(driver.integrationBranch), sibling);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a rejected round-one retry does not commit from a moved durable head", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "first\n");
		const first = driver.acceptIntegrationRepairCommit({ parent, round: 1, commitMessage: "fix: first repair" });
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "invalid retry\n");
		const beforeStatus = driver.worktreeStatus(driver.integrationWorktree);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, currentHead: first.head, commitMessage: "fix: invalid retry" }), /Round 1|durable current/);
		assert.equal(driver.branchHead(driver.integrationBranch), first.head);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), first.head);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), beforeStatus);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("protected plan paths are rejected before staging", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		fs.mkdirSync(path.join(driver.integrationWorktree, "herder-plans"), { recursive: true });
		fs.writeFileSync(path.join(driver.integrationWorktree, "herder-plans", "README.md"), "foreign\n");
		fs.writeFileSync(path.join(driver.integrationWorktree, "source.txt"), "failure-related\n");
		const beforeStatus = driver.worktreeStatus(driver.integrationWorktree);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, commitMessage: "fix: protected path" }), /protected plan path/);
		assert.equal(driver.branchHead(driver.integrationBranch), parent);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), parent);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), beforeStatus);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
