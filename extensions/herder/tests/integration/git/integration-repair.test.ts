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

function authorRepairCommit(driver: GitDriver, content: string, message: string, amend = false): string {
	fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), content);
	git(driver.integrationWorktree, ["add", "--", "value.txt"]);
	git(driver.integrationWorktree, amend ? ["commit", "-q", "--amend", "--no-edit"] : ["commit", "-q", "-m", message]);
	return driver.worktreeHead(driver.integrationWorktree);
}

function validate(driver: GitDriver, input: Parameters<GitDriver["validateIntegrationRepairCommit"]>[0]) {
	return driver.validateIntegrationRepairCommit(input);
}

test("repair accepts clean session-authored descendants and fixed-parent replacements", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		const firstHead = authorRepairCommit(driver, "repaired\n", "fix: repair integrated verification");
		const first = validate(driver, { parent, round: 1, observedCommit: firstHead, ...evidence, allowedPaths: ["value.txt"] });
		assert.equal(first.parent, parent);
		assert.equal(first.head, firstHead);
		assert.deepEqual(first.changedPaths, ["value.txt"]);
		assert.equal(first.committed, false);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), "");

		const secondHead = authorRepairCommit(driver, "repaired again\n", "fix: amend integrated verification", true);
		const second = validate(driver, { parent, round: 2, currentHead: first.head, observedCommit: secondHead, ...evidence, allowedPaths: ["value.txt"] });
		assert.equal(second.parent, parent);
		assert.equal(second.supersededHead, first.head);
		assert.notEqual(second.head, first.head);
		const parents = git(driver.integrationWorktree, ["rev-list", "--parents", "-n", "1", second.head]).stdout.trim().split(/\s+/).slice(1);
		assert.deepEqual(parents, [parent]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("repair rejects a no-op and a detached worktree without mutation", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		assert.throws(() => validate(driver, { parent, round: 1, observedCommit: parent, ...evidence, allowedPaths: ["value.txt"] }), /non-empty diff|replace/);
		assert.equal(driver.branchHead(driver.integrationBranch), parent);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), parent);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), "");
		git(driver.integrationWorktree, ["checkout", "--detach", "HEAD"]);
		assert.throws(() => validate(driver, { parent, round: 1, observedCommit: parent, ...evidence, allowedPaths: ["value.txt"] }), /symbolic|not on/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("later-round acceptance requires a clean authored replacement", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		const firstHead = authorRepairCommit(driver, "round one\n", "fix: first repair");
		const first = validate(driver, { parent, round: 1, observedCommit: firstHead, ...evidence, allowedPaths: ["value.txt"] });
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "dirty round two\n");
		const beforeStatus = driver.worktreeStatus(driver.integrationWorktree);
		assert.throws(() => validate(driver, { parent, round: 2, currentHead: first.head, observedCommit: first.head, ...evidence, allowedPaths: ["value.txt"] }), /clean/);
		assert.equal(driver.branchHead(driver.integrationBranch), first.head);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), first.head);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), beforeStatus);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("later-round replacements retain the superseded head while sharing the fixed parent", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		const firstHead = authorRepairCommit(driver, "accepted\n", "fix: accepted repair");
		const first = validate(driver, { parent, round: 1, observedCommit: firstHead, ...evidence, allowedPaths: ["value.txt"] });
		git(driver.integrationWorktree, ["reset", "--hard", parent]);
		const replacementHead = authorRepairCommit(driver, "replacement\n", "fix: replacement repair");
		const replacement = validate(driver, { parent, round: 2, currentHead: first.head, observedCommit: replacementHead, ...evidence, allowedPaths: ["value.txt"] });
		assert.equal(replacement.supersededHead, first.head);
		assert.notEqual(replacement.head, first.head);
		assert.equal(driver.branchHead(driver.integrationBranch), replacementHead);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("later rounds reject previously superseded heads without mutation", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		const firstHead = authorRepairCommit(driver, "round one\n", "fix: first repair");
		const first = validate(driver, { parent, round: 1, observedCommit: firstHead, ...evidence, allowedPaths: ["value.txt"] });
		git(driver.integrationWorktree, ["reset", "--hard", parent]);
		const secondHead = authorRepairCommit(driver, "round two\n", "fix: second repair");
		const second = validate(driver, {
			parent,
			round: 2,
			currentHead: first.head,
			supersededCommits: [],
			observedCommit: secondHead,
			...evidence,
			allowedPaths: ["value.txt"],
		});
		assert.equal(second.supersededHead, first.head);

		git(driver.integrationWorktree, ["reset", "--hard", first.head]);
		assert.throws(() => validate(driver, {
			parent,
			round: 3,
			currentHead: second.head,
			supersededCommits: [first.head],
			observedCommit: first.head,
			...evidence,
			allowedPaths: ["value.txt"],
		}), /previously superseded/);
		assert.equal(driver.branchHead(driver.integrationBranch), first.head);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), first.head);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), "");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a rejected round-one retry preserves the clean commit and dirty evidence", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		const firstHead = authorRepairCommit(driver, "first\n", "fix: first repair");
		validate(driver, { parent, round: 1, observedCommit: firstHead, ...evidence, allowedPaths: ["value.txt"] });
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "invalid retry\n");
		const beforeStatus = driver.worktreeStatus(driver.integrationWorktree);
		assert.throws(() => validate(driver, { parent, round: 1, currentHead: firstHead, observedCommit: firstHead, ...evidence, allowedPaths: ["value.txt"] }), /clean/);
		assert.equal(driver.branchHead(driver.integrationBranch), firstHead);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), firstHead);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), beforeStatus);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("failure-related paths are required before accepting a session commit", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		const observedCommit = authorRepairCommit(driver, "related\n", "fix: reject missing paths");
		const beforeHead = driver.branchHead(driver.integrationBranch);
		assert.equal(beforeHead, observedCommit);
		assert.throws(() => validate(driver, { parent, round: 1, observedCommit, ...evidence }), /failure-related paths/);
		assert.equal(driver.branchHead(driver.integrationBranch), beforeHead);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), observedCommit);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), "");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("clean commit identity replays without a marker or another commit", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		const firstHead = authorRepairCommit(driver, "replayed\n", "fix: replayable repair");
		const first = validate(driver, { parent, round: 1, observedCommit: firstHead, ...evidence, allowedPaths: ["value.txt"] });
		const replay = validate(driver, { parent, round: 1, replayHead: first.head, observedCommit: first.head, ...evidence, allowedPaths: ["value.txt"] });
		assert.equal(replay.head, first.head);
		assert.equal(replay.committed, false);

		const secondHead = authorRepairCommit(driver, "round two\n", "fix: amended repair", true);
		const amended = validate(driver, { parent, round: 2, currentHead: first.head, observedCommit: secondHead, ...evidence, allowedPaths: ["value.txt"] });
		const amendedReplay = validate(driver, { parent, round: 2, currentHead: first.head, replayHead: amended.head, observedCommit: amended.head, ...evidence, allowedPaths: ["value.txt"] });
		assert.equal(amendedReplay.head, amended.head);
		assert.equal(amendedReplay.supersededHead, first.head);
		assert.equal(amendedReplay.committed, false);

		git(driver.integrationWorktree, ["reset", "--hard", parent]);
		const siblingHead = authorRepairCommit(driver, "sibling\n", "test: unrelated sibling");
		assert.throws(() => validate(driver, { parent, round: 1, replayHead: first.head, observedCommit: siblingHead, ...evidence, allowedPaths: ["value.txt"] }), /replay commit must equal/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("protected plan paths are rejected without changing the authored commit", () => {
	const { root, driver } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		fs.mkdirSync(path.join(driver.integrationWorktree, "herder-plans"), { recursive: true });
		fs.writeFileSync(path.join(driver.integrationWorktree, "herder-plans", "README.md"), "foreign\n");
		fs.writeFileSync(path.join(driver.integrationWorktree, "source.txt"), "failure-related\n");
		git(driver.integrationWorktree, ["add", "--", "herder-plans/README.md", "source.txt"]);
		git(driver.integrationWorktree, ["commit", "-q", "-m", "fix: protected path"]);
		const observedCommit = driver.worktreeHead(driver.integrationWorktree);
		assert.throws(() => validate(driver, { parent, round: 1, observedCommit, ...evidence, allowedPaths: ["source.txt"] }), /protected plan path/);
		assert.equal(driver.branchHead(driver.integrationBranch), observedCommit);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), "");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("namespace creation after begin is rejected without Git mutation", () => {
	const { root, driver, repo } = fixture();
	try {
		const parent = driver.branchHead(driver.integrationBranch);
		const evidence = namespaceEvidence(driver);
		const observedCommit = authorRepairCommit(driver, "drifted\n", "fix: reject namespace drift");
		git(repo, ["update-ref", "refs/plan-herder/repair-test/checkpoints/RUN/001", parent]);
		assert.throws(() => validate(driver, { parent, round: 1, observedCommit, ...evidence, allowedPaths: ["value.txt"] }), /manager-owned Herder ref/);
		assert.equal(driver.branchHead(driver.integrationBranch), observedCommit);
		assert.equal(driver.worktreeHead(driver.integrationWorktree), observedCommit);
		assert.equal(driver.worktreeStatus(driver.integrationWorktree), "");
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
		const observedCommit = authorRepairCommit(driver, "drifted branch\n", "fix: reject moved branch");
		assert.throws(() => validate(driver, { parent, round: 1, observedCommit, ...evidence, allowedPaths: ["value.txt"] }), /manager-owned Herder ref/);
		assert.equal(driver.branchHead(driver.integrationBranch), observedCommit);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
