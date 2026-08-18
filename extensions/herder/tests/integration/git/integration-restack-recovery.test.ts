import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitDriver, git, gitValue, runCommand } from "../../../src/daemon/git-driver.ts";
import { sha256, stableJson } from "../../../src/shared/protocol.ts";

function approval(planId: string, generation: number) {
	const hash = "a".repeat(64);
	const core = {
		runId: "run-restack",
		planId,
		generation,
		round: 1,
		reviewerActionId: "reviewer-restack",
		decisionActionId: "decision-restack",
		decisionRole: "plan-reviewer" as const,
		assignmentSha256: hash,
		approvedBase: "0".repeat(40),
		approvedHead: "0".repeat(40),
		approvedTree: "0".repeat(40),
		reviewResultSha256: hash,
		decisionResultSha256: hash,
	};
	return { ...core, approvalProofSha256: sha256(stableJson(core)) };
}

test("integration recovers a manager-owned restack when the approved patch is already in integration", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-restack-recovery-"));
	const repo = path.join(root, "repo");
	const planDirectory = path.join(repo, "herder-plans");
	fs.mkdirSync(planDirectory, { recursive: true });
	try {
		runCommand("git", ["init", "-q", repo]);
		git(repo, ["config", "user.name", "Herder Restack Test"]);
		git(repo, ["config", "user.email", "herder@example.test"]);
		fs.writeFileSync(path.join(repo, "value.txt"), "base\n");
		git(repo, ["add", "value.txt"]);
		git(repo, ["commit", "-q", "-m", "base"]);
		const base = gitValue(repo, "rev-parse", "HEAD");
		const driver = new GitDriver({ repoRoot: repo, planDirectory, planName: "restack-test", helperRoot: path.resolve("extensions/herder/src/daemon/git") });
		fs.mkdirSync(driver.worktreeRoot, { recursive: true });
		git(repo, ["worktree", "add", "-q", "-b", driver.integrationBranch, driver.integrationWorktree, base]);
		const branch = "herder/restack-test/001";
		const worktree = path.join(driver.worktreeRoot, "001");
		git(repo, ["worktree", "add", "-q", "-b", branch, worktree, base]);

		fs.writeFileSync(path.join(worktree, "value.txt"), "approved\n");
		git(worktree, ["add", "value.txt"]);
		git(worktree, ["commit", "-q", "-m", "approved change"]);
		const approvedHead = gitValue(worktree, "rev-parse", "HEAD");
		const approvedTree = gitValue(worktree, "rev-parse", "HEAD^{tree}");

		// An independently-created integration commit contains the same patch.
		fs.writeFileSync(path.join(driver.integrationWorktree, "value.txt"), "approved\n");
		git(driver.integrationWorktree, ["add", "value.txt"]);
		git(driver.integrationWorktree, ["commit", "-q", "-m", "already integrated change"]);
		const integrationHead = gitValue(driver.integrationWorktree, "rev-parse", "HEAD");
		const result = driver.integrate({
			planId: "001", branch, worktree, approvedBase: base, approvedHead, approvedTree,
			generation: 1, checkpointOrdinal: 1, approval: approval("001", 1),
		});
		assert.equal(result.status, "integrated");
		assert.equal(result.head, integrationHead);
		assert.equal(gitValue(repo, "rev-parse", `refs/plan-herder/restack-test/checkpoints/001/generation-1-001`), approvedHead);
		assert.equal(gitValue(repo, "rev-parse", `refs/heads/${branch}`), integrationHead);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
