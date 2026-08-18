import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	GitDriver,
	git,
	gitValue,
	runCommand,
	type CompletionApprovalProof,
	type IntegrationResult,
} from "../../../src/daemon/git-driver.ts";
import { sha256, stableJson } from "../../../src/shared/protocol.ts";

const PLAN_NAME = "restack-test";
const PLAN_ID = "001";
const GENERATION = 1;
const CHECKPOINT_ORDINAL = 1;

interface Fixture {
	root: string;
	repo: string;
	driver: GitDriver;
	base: string;
	branch: string;
	worktree: string;
	checkpointRef: string;
	completionRef: string;
}

interface ApprovedState {
	base: string;
	head: string;
	tree: string;
	approval: CompletionApprovalProof;
}

function createFixture(): Fixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-restack-recovery-"));
	const repo = path.join(root, "repo");
	const planDirectory = path.join(repo, "herder-plans");
	fs.mkdirSync(planDirectory, { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", "Herder Restack Test"]);
	git(repo, ["config", "user.email", "herder@example.test"]);
	fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
	git(repo, ["add", "base.txt"]);
	git(repo, ["commit", "-q", "-m", "base"]);
	const base = gitValue(repo, "rev-parse", "HEAD");
	const driver = new GitDriver({
		repoRoot: repo,
		planDirectory,
		planName: PLAN_NAME,
		helperRoot: path.resolve("extensions/herder/src/daemon/git"),
	});
	fs.mkdirSync(driver.worktreeRoot, { recursive: true });
	git(repo, ["worktree", "add", "-q", "-b", driver.integrationBranch, driver.integrationWorktree, base]);
	const branch = `herder/${PLAN_NAME}/${PLAN_ID}`;
	const worktree = path.join(driver.worktreeRoot, PLAN_ID);
	git(repo, ["worktree", "add", "-q", "-b", branch, worktree, base]);
	return {
		root,
		repo,
		driver,
		base,
		branch,
		worktree,
		checkpointRef: `refs/plan-herder/${PLAN_NAME}/checkpoints/${PLAN_ID}/generation-${GENERATION}-001`,
		completionRef: `refs/plan-herder/${PLAN_NAME}/completed/${PLAN_ID}`,
	};
}

function cleanupFixture(fixture: Fixture): void {
	// In particular, do not leave the active-conflict fixture registered or with
	// rebase metadata if an assertion fails before the driver gets another turn.
	if (fs.existsSync(fixture.worktree)) git(fixture.worktree, ["rebase", "--abort"], true);
	git(fixture.repo, ["worktree", "remove", "--force", fixture.worktree], true);
	git(fixture.repo, ["worktree", "remove", "--force", fixture.driver.integrationWorktree], true);
	git(fixture.repo, ["worktree", "prune"], true);
	fs.rmSync(fixture.root, { recursive: true, force: true });
}

function commitFile(worktree: string, relativePath: string, content: string, message: string): string {
	const target = path.join(worktree, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	git(worktree, ["add", "--", relativePath]);
	git(worktree, ["commit", "-q", "-m", message]);
	return gitValue(worktree, "rev-parse", "HEAD");
}

function approvalFor(approvedBase: string, approvedHead: string, approvedTree: string): CompletionApprovalProof {
	const hash = "a".repeat(64);
	const core = {
		runId: "run-restack",
		planId: PLAN_ID,
		generation: GENERATION,
		round: 1,
		reviewerActionId: "reviewer-restack",
		decisionActionId: "decision-restack",
		decisionRole: "plan-reviewer" as const,
		assignmentSha256: hash,
		approvedBase,
		approvedHead,
		approvedTree,
		reviewResultSha256: hash,
		decisionResultSha256: hash,
	};
	return { ...core, approvalProofSha256: sha256(stableJson(core)) };
}

function approvedState(fixture: Fixture): ApprovedState {
	const head = gitValue(fixture.worktree, "rev-parse", "HEAD");
	const tree = gitValue(fixture.worktree, "rev-parse", "HEAD^{tree}");
	return {
		base: fixture.base,
		head,
		tree,
		approval: approvalFor(fixture.base, head, tree),
	};
}

function integrationInput(fixture: Fixture, approved: ApprovedState) {
	return {
		planId: PLAN_ID,
		branch: fixture.branch,
		worktree: fixture.worktree,
		approvedBase: approved.base,
		approvedHead: approved.head,
		approvedTree: approved.tree,
		generation: GENERATION,
		checkpointOrdinal: CHECKPOINT_ORDINAL,
		approval: approved.approval,
	};
}

function createCheckpoint(fixture: Fixture, target: string): void {
	git(fixture.repo, ["update-ref", fixture.checkpointRef, target]);
}

function advanceIntegration(fixture: Fixture, relativePath = "independent.txt", content = "independent\n"): string {
	return commitFile(fixture.driver.integrationWorktree, relativePath, content, "advance integration");
}

function manuallyRestack(fixture: Fixture, approved: ApprovedState, integrationHead: string): string {
	const rebase = git(fixture.worktree, ["rebase", "--onto", integrationHead, approved.base], true);
	assert.equal(rebase.status, 0, rebase.stderr || rebase.stdout);
	return gitValue(fixture.worktree, "rev-parse", "HEAD");
}

function assertMissingRef(repo: string, ref: string): void {
	assert.notEqual(git(repo, ["show-ref", "--verify", "--quiet", ref], true).status, 0);
}

function assertIntegrated(result: IntegrationResult, expectedHead: string): void {
	assert.deepEqual(result, { status: "integrated", head: expectedHead });
}

test("integrate recovers a completed manager restack crash window and completion is idempotent", (t) => {
	const fixture = createFixture();
	t.after(() => cleanupFixture(fixture));
	commitFile(fixture.worktree, "settings.json", "{\"enabled\":true}\n", "add approved settings");
	const approved = approvedState(fixture);
	const integrationHead = advanceIntegration(fixture);
	createCheckpoint(fixture, approved.head);

	const restackedHead = manuallyRestack(fixture, approved, integrationHead);
	assert.notEqual(restackedHead, approved.head);
	assert.equal(gitValue(fixture.repo, "rev-parse", fixture.checkpointRef), approved.head);
	assert.equal(gitValue(fixture.repo, "merge-base", "--is-ancestor", integrationHead, restackedHead), "");

	const input = integrationInput(fixture, approved);
	assertIntegrated(fixture.driver.integrate(input), restackedHead);
	assert.equal(fixture.driver.branchHead(fixture.driver.integrationBranch), restackedHead);
	assert.equal(gitValue(fixture.repo, "rev-parse", `${fixture.completionRef}^{commit}`), restackedHead);

	// A restart can redispatch the same integration after completion was sealed.
	assertIntegrated(fixture.driver.integrate(input), restackedHead);
	assert.equal(gitValue(fixture.repo, "rev-parse", `${fixture.completionRef}^{commit}`), restackedHead);
});

test("integrate accepts a completed restack that drops a duplicate patch already in integration", (t) => {
	const fixture = createFixture();
	t.after(() => cleanupFixture(fixture));
	const uniqueCommit = commitFile(
		fixture.worktree,
		"config/settings.json",
		"{\"storage\":\"durable\"}\n",
		"add unique settings storage",
	);
	const duplicateCommit = commitFile(
		fixture.worktree,
		"tests/machine-upgrade.test.ts",
		"export const machineUpgradeCovered = true;\n",
		"add machine upgrade contract test",
	);
	const approved = approvedState(fixture);

	const integrationHead = advanceIntegration(
		fixture,
		"tests/machine-upgrade.test.ts",
		"export const machineUpgradeCovered = true;\n",
	);
	createCheckpoint(fixture, approved.head);
	const restackedHead = manuallyRestack(fixture, approved, integrationHead);

	assert.notEqual(restackedHead, approved.head);
	assert.equal(gitValue(fixture.repo, "rev-list", "--count", `${integrationHead}..${restackedHead}`), "1");
	assert.equal(gitValue(fixture.repo, "log", "-1", "--format=%s", restackedHead), "add unique settings storage");
	assert.equal(git(fixture.repo, ["merge-base", "--is-ancestor", duplicateCommit, restackedHead], true).status, 1);
	assert.match(gitValue(fixture.repo, "cherry", integrationHead, duplicateCommit, `${duplicateCommit}^`), /^- /);
	assert.match(gitValue(fixture.repo, "cherry", integrationHead, uniqueCommit, `${uniqueCommit}^`), /^\+ /);
	assert.equal(fs.readFileSync(path.join(fixture.worktree, "config/settings.json"), "utf8"), "{\"storage\":\"durable\"}\n");
	assert.equal(fs.readFileSync(path.join(fixture.worktree, "tests/machine-upgrade.test.ts"), "utf8"), "export const machineUpgradeCovered = true;\n");

	assertIntegrated(fixture.driver.integrate(integrationInput(fixture, approved)), restackedHead);
	assert.equal(fixture.driver.branchHead(fixture.driver.integrationBranch), restackedHead);
	assert.equal(gitValue(fixture.repo, "rev-parse", `${fixture.completionRef}^{commit}`), restackedHead);
});

test("integrate recognizes an active manager-owned rebase with exact metadata", (t) => {
	const fixture = createFixture();
	t.after(() => cleanupFixture(fixture));
	commitFile(fixture.worktree, "conflict.txt", "approved\n", "approved conflicting change");
	const approved = approvedState(fixture);
	const integrationHead = advanceIntegration(fixture, "conflict.txt", "integration\n");
	createCheckpoint(fixture, approved.head);

	const rebase = git(fixture.worktree, ["rebase", "--onto", integrationHead, approved.base], true);
	assert.notEqual(rebase.status, 0);
	const detachedHead = gitValue(fixture.worktree, "rev-parse", "HEAD");
	assert.notEqual(git(fixture.worktree, ["symbolic-ref", "--quiet", "HEAD"], true).status, 0);

	assert.deepEqual(fixture.driver.integrate(integrationInput(fixture, approved)), {
		status: "conflict",
		checkpointRef: fixture.checkpointRef,
		checkpoint: approved.head,
		onto: integrationHead,
		detachedHead,
	});
	assert.equal(fixture.driver.branchHead(fixture.branch), approved.head);
	assert.equal(fixture.driver.branchHead(fixture.driver.integrationBranch), integrationHead);
});

test("integrate rejects an externally changed plan without creating a retroactive checkpoint", (t) => {
	const fixture = createFixture();
	t.after(() => cleanupFixture(fixture));
	commitFile(fixture.worktree, "settings.json", "approved\n", "approved settings");
	const approved = approvedState(fixture);
	const integrationHead = advanceIntegration(fixture);
	const externalHead = commitFile(fixture.worktree, "external.txt", "external\n", "external mutation");

	assert.throws(
		() => fixture.driver.integrate(integrationInput(fixture, approved)),
		new RegExp(`Approved patch changed before integration for ${PLAN_ID}`),
	);
	assert.equal(fixture.driver.branchHead(fixture.branch), externalHead);
	assert.equal(fixture.driver.branchHead(fixture.driver.integrationBranch), integrationHead);
	assertMissingRef(fixture.repo, fixture.checkpointRef);
	assertMissingRef(fixture.repo, fixture.completionRef);
});

test("integrate rejects an extra external commit after an otherwise valid completed restack", (t) => {
	const fixture = createFixture();
	t.after(() => cleanupFixture(fixture));
	commitFile(fixture.worktree, "settings.json", "approved\n", "approved settings");
	const approved = approvedState(fixture);
	const integrationHead = advanceIntegration(fixture);
	createCheckpoint(fixture, approved.head);
	manuallyRestack(fixture, approved, integrationHead);
	const externalHead = commitFile(fixture.worktree, "external.txt", "external\n", "external mutation after restack");

	assert.throws(
		() => fixture.driver.integrate(integrationInput(fixture, approved)),
		new RegExp(`Restacked plan ${PLAN_ID} is not patch-equivalent to its reviewed checkpoint`),
	);
	assert.equal(fixture.driver.branchHead(fixture.branch), externalHead);
	assert.equal(fixture.driver.branchHead(fixture.driver.integrationBranch), integrationHead);
	assert.equal(gitValue(fixture.repo, "rev-parse", fixture.checkpointRef), approved.head);
	assertMissingRef(fixture.repo, fixture.completionRef);
});

test("integrate rejects a merge commit that hides an unauthorized tree change", (t) => {
	const fixture = createFixture();
	t.after(() => cleanupFixture(fixture));
	commitFile(fixture.worktree, "settings.json", "approved\n", "approved settings");
	const approved = approvedState(fixture);
	const integrationHead = advanceIntegration(fixture);
	createCheckpoint(fixture, approved.head);
	const restackedHead = manuallyRestack(fixture, approved, integrationHead);

	// `git cherry` omits merge commits. Build a merge whose tree contains an
	// unauthorized file but whose only visible linear plan patch is approved.
	const externalCommit = commitFile(fixture.worktree, "external.txt", "external\n", "prepare unauthorized tree");
	const externalTree = gitValue(fixture.repo, "rev-parse", `${externalCommit}^{tree}`);
	const mergeHead = gitValue(
		fixture.repo,
		"commit-tree", externalTree,
		"-p", restackedHead,
		"-p", integrationHead,
		"-m", "hide unauthorized tree in merge",
	);
	git(fixture.worktree, ["reset", "--hard", mergeHead]);
	assert.equal(fixture.driver.worktreeStatus(fixture.worktree), "");
	assert.equal(gitValue(fixture.repo, "rev-list", "--count", "--min-parents=2", `${integrationHead}..${mergeHead}`), "1");

	assert.throws(
		() => fixture.driver.integrate(integrationInput(fixture, approved)),
		new RegExp(`Restacked plan ${PLAN_ID} is not patch-equivalent to its reviewed checkpoint`),
	);
	assert.equal(fixture.driver.branchHead(fixture.branch), mergeHead);
	assert.equal(fixture.driver.branchHead(fixture.driver.integrationBranch), integrationHead);
	assertMissingRef(fixture.repo, fixture.completionRef);
});

test("integrate fails closed when completed-restack recovery finds a checkpoint at the wrong object", (t) => {
	const fixture = createFixture();
	t.after(() => cleanupFixture(fixture));
	commitFile(fixture.worktree, "settings.json", "approved\n", "approved settings");
	const approved = approvedState(fixture);
	const integrationHead = advanceIntegration(fixture);
	createCheckpoint(fixture, approved.base);
	const restackedHead = manuallyRestack(fixture, approved, integrationHead);

	assert.throws(
		() => fixture.driver.integrate(integrationInput(fixture, approved)),
		new RegExp(`Approved patch changed before integration for ${PLAN_ID}`),
	);
	assert.equal(fixture.driver.branchHead(fixture.branch), restackedHead);
	assert.equal(fixture.driver.branchHead(fixture.driver.integrationBranch), integrationHead);
	assert.equal(gitValue(fixture.repo, "rev-parse", fixture.checkpointRef), approved.base);
	assertMissingRef(fixture.repo, fixture.completionRef);
});
