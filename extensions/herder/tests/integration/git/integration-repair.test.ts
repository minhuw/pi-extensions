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

function namespaceEvidence(driver: GitDriver): { beginRefSnapshot: string; beginRefSnapshotSha256: string } {
	const evidence = driver.readIntegrationRepairNamespace();
	return { beginRefSnapshot: evidence.snapshot, beginRefSnapshotSha256: evidence.sha256 };
}

test("repair commits are direct descendants and later rounds preserve the fixed parent", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "repaired\n");
		const first = driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, allowedPaths: ["value.txt"], commitMessage: "fix: repair integrated verification" });
		assert.equal(first.parent, parent);
		assert.notEqual(first.head, parent);
		assert.deepEqual(first.changedPaths, ["value.txt"]);

		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "repaired again\n");
		const second = driver.acceptIntegrationRepairCommit({ parent, round: 2, currentHead: first.head, ...evidence, allowedPaths: ["value.txt"], commitMessage: "fix: amend integrated verification" });
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
		const evidence = namespaceEvidence(driver);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, allowedPaths: ["value.txt"] }), /non-merge|non-empty diff/);
		git(driver.integrationWorktree, ["checkout", "--detach", "HEAD"]);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, allowedPaths: ["value.txt"] }), /symbolic|not on/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("later-round acceptance requires a dirty amendment or explicit replay evidence", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "round one\n");
		const first = driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, allowedPaths: ["value.txt"], commitMessage: "fix: first repair" });
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 2, currentHead: first.head, ...evidence, allowedPaths: ["value.txt"] }), /dirty amendment|replay evidence/);
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
		const evidence = namespaceEvidence(driver);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "accepted\n");
		const first = driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, allowedPaths: ["value.txt"], commitMessage: "fix: accepted repair" });
		git(driver.integrationWorktree, ["reset", "--hard", parent]);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "sibling\n");
		git(driver.integrationWorktree, ["add", "value.txt"]);
		git(driver.integrationWorktree, ["commit", "-q", "-m", "test: unrelated sibling"]);
		const sibling = driver.branchHead(driver.integrationBranch);
		assert.notEqual(sibling, first.head);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 2, currentHead: first.head, ...evidence, allowedPaths: ["value.txt"] }), /branch or worktree moved/);
		assert.equal(driver.branchHead(driver.integrationBranch), sibling);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a rejected round-one retry does not commit from a moved durable head", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "first\n");
		const first = driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, allowedPaths: ["value.txt"], commitMessage: "fix: first repair" });
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "invalid retry\n");
		const beforeStatus = driver.worktreeStatus(driver.integrationWorktree);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, currentHead: first.head, ...evidence, allowedPaths: ["value.txt"], commitMessage: "fix: invalid retry" }), /Round 1|durable current/);
		assert.equal(driver.branchHead(driver.integrationBranch), first.head);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), first.head);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), beforeStatus);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("failure-related paths are required before staging", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "related\n");
		fs.writeFileSync(path.join(driver.integrationWorktree, "unrelated.txt"), "unrelated\n");
		const beforeStatus = driver.worktreeStatus(driver.integrationWorktree);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, commitMessage: "fix: reject unrelated path" }), /failure-related paths/);
		assert.equal(driver.branchHead(driver.integrationBranch), parent);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), parent);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), beforeStatus);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a marked repair commit replays after a crash but an unmarked sibling does not", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		const repairMarker = "a".repeat(64);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "replayed\n");
		const first = driver.acceptIntegrationRepairCommit({
			parent,
			round: 1,
			...evidence,
			repairMarker,
			allowedPaths: ["value.txt"],
			commitMessage: "fix: replayable repair",
		});
		const replay = driver.acceptIntegrationRepairCommit({
			parent,
			round: 1,
			...evidence,
			repairMarker,
			allowedPaths: ["value.txt"],
			commitMessage: "fix: replayable repair",
		});
		assert.equal(replay.head, first.head);
		assert.equal(replay.committed, false);

		const roundTwoMarker = "b".repeat(64);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "round two\n");
		const amended = driver.acceptIntegrationRepairCommit({
			parent,
			round: 2,
			currentHead: first.head,
			...evidence,
			repairMarker: roundTwoMarker,
			allowedPaths: ["value.txt"],
		});
		const amendedReplay = driver.acceptIntegrationRepairCommit({
			parent,
			round: 2,
			currentHead: first.head,
			...evidence,
			repairMarker: roundTwoMarker,
			allowedPaths: ["value.txt"],
		});
		assert.equal(amendedReplay.head, amended.head);
		assert.equal(amendedReplay.supersededHead, first.head);
		assert.equal(amendedReplay.committed, false);

		git(driver.integrationWorktree, ["reset", "--hard", parent]);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "sibling\n");
		git(driver.integrationWorktree, ["add", "value.txt"]);
		git(driver.integrationWorktree, ["commit", "-q", "-m", "test: unrelated sibling"]);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, repairMarker, allowedPaths: ["value.txt"] }), /branch or worktree moved/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("protected plan paths are rejected before staging", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		fs.mkdirSync(path.join(driver.integrationWorktree, "herder-plans"), { recursive: true });
		fs.writeFileSync(path.join(driver.integrationWorktree, "herder-plans", "README.md"), "foreign\n");
		fs.writeFileSync(path.join(driver.integrationWorktree, "source.txt"), "failure-related\n");
		const beforeStatus = driver.worktreeStatus(driver.integrationWorktree);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, allowedPaths: ["source.txt"], commitMessage: "fix: protected path" }), /protected plan path/);
		assert.equal(driver.branchHead(driver.integrationBranch), parent);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), parent);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), beforeStatus);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("namespace creation after begin is rejected before staging", () => {
	const { root, driver, repo } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		git(repo, ["update-ref", "refs/plan-herder/repair-test/checkpoints/RUN/001", parent]);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "drifted\n");
		const beforeStatus = driver.worktreeStatus(driver.integrationWorktree);
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, allowedPaths: ["value.txt"], commitMessage: "fix: reject namespace drift" }), /manager-owned Herder ref/);
		assert.equal(driver.branchHead(driver.integrationBranch), parent);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), parent);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), beforeStatus);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("indexed branch movement after begin is rejected", () => {
	const { root, driver, repo } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		git(repo, ["branch", "herder/repair-test/001", parent]);
		git(repo, ["update-ref", "refs/plan-herder/repair-test/base", parent]);
		const evidence = namespaceEvidence(driver);
		const drift = git(repo, ["commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "namespace drift"]).stdout.trim();
		git(repo, ["update-ref", "refs/heads/herder/repair-test/001", drift, parent]);
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "drifted branch\n");
		assert.throws(() => driver.acceptIntegrationRepairCommit({ parent, round: 1, ...evidence, allowedPaths: ["value.txt"], commitMessage: "fix: reject moved branch" }), /manager-owned Herder ref/);
		assert.equal(driver.branchHead(driver.integrationBranch), parent);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
