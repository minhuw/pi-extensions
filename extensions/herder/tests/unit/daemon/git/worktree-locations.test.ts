import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitDriver, git, runCommand } from "../../../../src/daemon/git-driver.ts";
import {
	allowedWorktreePaths,
	canonicalWorktreeRoot,
	isAllowedWorktreeRoot,
	legacyWorktreeContainer,
	legacyWorktreeRoot,
	worktreeRelativeName,
} from "../../../../src/daemon/git/worktree-locations.ts";

function writeRepo(): { root: string; repo: string; planDirectory: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-worktree-locations-"));
	const repo = path.join(root, "repo");
	const planDirectory = path.join(repo, "herder-plans");
	fs.mkdirSync(planDirectory, { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", "Herder Worktree Test"]);
	git(repo, ["config", "user.email", "herder-worktree@example.invalid"]);
	fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "test: initialize worktree location fixture"]);
	return { root, repo: fs.realpathSync(repo), planDirectory: fs.realpathSync(planDirectory) };
}

test("canonical worktrees live under the plan directory runtime tree", () => {
	const { root, repo, planDirectory } = writeRepo();
	try {
		assert.equal(canonicalWorktreeRoot(planDirectory), path.join(planDirectory, ".herder", "worktrees"));
		assert.equal(legacyWorktreeRoot(repo, "herder-plans"), path.join(`${repo}-herder-worktrees`, "herder-plans"));
		assert.equal(legacyWorktreeContainer(repo), `${repo}-herder-worktrees`);
		assert.equal(
			isAllowedWorktreeRoot(canonicalWorktreeRoot(planDirectory), repo, planDirectory, "herder-plans"),
			true,
		);
		assert.equal(
			isAllowedWorktreeRoot(legacyWorktreeRoot(repo, "herder-plans"), repo, planDirectory, "herder-plans"),
			true,
		);
		assert.equal(isAllowedWorktreeRoot(repo, repo, planDirectory, "herder-plans"), false);
		assert.deepEqual(
			allowedWorktreePaths(repo, planDirectory, "herder-plans", "001"),
			[
				path.join(planDirectory, ".herder", "worktrees", "001"),
				path.join(`${repo}-herder-worktrees`, "herder-plans", "001"),
			],
		);
		assert.equal(worktreeRelativeName("herder/herder-plans/integration", "herder-plans", "herder/herder-plans/integration"), "integration");
		assert.equal(worktreeRelativeName("herder/herder-plans/001", "herder-plans", "herder/herder-plans/integration"), "001");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("GitDriver defaults to the plan-directory worktree root and still accepts the leftover sibling", () => {
	const { root, repo, planDirectory } = writeRepo();
	try {
		const created = new GitDriver({
			repoRoot: repo,
			planDirectory,
			planName: "herder-plans",
			helperRoot: root,
		});
		assert.equal(created.worktreeRoot, path.join(planDirectory, ".herder", "worktrees"));
		assert.equal(created.integrationWorktree, path.join(planDirectory, ".herder", "worktrees", "integration"));

		const leftover = legacyWorktreeRoot(repo, "herder-plans");
		const resumed = new GitDriver({
			repoRoot: repo,
			planDirectory,
			planName: "herder-plans",
			helperRoot: root,
			worktreeRoot: leftover,
		});
		assert.equal(resumed.worktreeRoot, leftover);
		assert.equal(resumed.integrationWorktree, path.join(leftover, "integration"));

		assert.throws(() => new GitDriver({
			repoRoot: repo,
			planDirectory,
			planName: "herder-plans",
			helperRoot: root,
			worktreeRoot: repo,
		}), /outside Herder's allowed locations/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
