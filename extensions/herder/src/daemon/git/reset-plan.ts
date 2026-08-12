import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ResetPlanExecutionInput {
	repoRoot: string;
	worktreeRoot: string;
	integrationWorktree: string;
	branch: string;
	worktree: string;
	expectedHead: string | null;
	expectedTree: string | null;
	/** A retry after the manager recorded the editing state may observe both entries gone. */
	allowRecordedMissing?: boolean;
}

export interface ResetPlanExecutionResult {
	branch: string;
	worktree: string;
	removedWorktree: boolean;
	deletedBranch: boolean;
	alreadyMissing: boolean;
}

type WorktreeRecord = { path: string; branch: string; locked: boolean };

function fail(message: string): never {
	throw new Error(message);
}

function git(repoRoot: string, args: string[], allowFailure = false): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	if (result.error) fail(`Cannot run git: ${result.error.message}`);
	const status = result.status ?? 1;
	if (status !== 0 && !allowFailure) fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
	return { status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function realpathIfPresent(candidate: string): string {
	try { return fs.realpathSync(candidate); }
	catch { return path.resolve(candidate); }
}

function isInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseWorktrees(repoRoot: string): WorktreeRecord[] {
	const output = git(repoRoot, ["worktree", "list", "--porcelain"]).stdout;
	return output.split(/(?:\r?\n){2,}/).filter((block) => block.trim()).map((block) => {
		const record: WorktreeRecord = { path: "", branch: "", locked: false };
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith("worktree ")) record.path = line.slice("worktree ".length);
			else if (line.startsWith("branch refs/heads/")) record.branch = line.slice("branch refs/heads/".length);
			else if (line === "locked" || line.startsWith("locked ")) record.locked = true;
		}
		return record;
	});
}

function branchHead(repoRoot: string, branch: string): string | null {
	const result = git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`], true);
	return result.status === 0 ? result.stdout.trim() : null;
}

function verifyExpectedNamespace(input: ResetPlanExecutionInput, repoRoot: string, worktreeRoot: string, worktree: string): void {
	if (!/^herder\/[^/]+\/\d{3,}$/.test(input.branch)) fail(`Recovery branch is not a plan branch: ${input.branch}`);
	const canonicalRoot = realpathIfPresent(worktreeRoot);
	const canonicalWorktree = fs.existsSync(worktree)
		? realpathIfPresent(worktree)
		: path.resolve(canonicalRoot, path.relative(worktreeRoot, worktree));
	if (realpathIfPresent(input.integrationWorktree) === repoRoot || canonicalWorktree === repoRoot) {
		fail("Recovery cleanup cannot remove the user checkout or integration worktree");
	}
	if (!isInside(worktreeRoot, worktree)) fail(`Recovery worktree escaped the manager worktree root: ${worktree}`);
	if (!isInside(canonicalRoot, canonicalWorktree)) fail(`Recovery worktree escaped the manager worktree root: ${worktree}`);
	if (path.resolve(worktree) === path.resolve(input.integrationWorktree) || canonicalWorktree === realpathIfPresent(input.integrationWorktree)) fail("Recovery cleanup cannot remove the integration worktree");
	if (fs.existsSync(worktree) && fs.lstatSync(worktree).isSymbolicLink()) {
		fail(`Recovery worktree path is moved or symlinked: ${worktree}`);
	}
}

function removeWorktree(repoRoot: string, worktree: string): void {
	const result = git(repoRoot, ["worktree", "remove", "--force", "--", worktree], true);
	if (result.status !== 0) fail(`Cannot force-remove the recorded recovery worktree: ${(result.stderr || result.stdout).trim()}`);
}

function deleteBranch(repoRoot: string, branch: string, expectedHead: string): void {
	const result = git(repoRoot, ["update-ref", "-d", `refs/heads/${branch}`, expectedHead], true);
	if (result.status !== 0) fail(`Cannot delete moved recovery branch ${branch}: ${(result.stderr || result.stdout).trim()}`);
}

/**
 * Remove only the manager-owned failed execution surface. The operation is
 * deliberately narrower than ordinary cleanup: it requires the exact plan
 * namespace, worktree identity, and branch head, but permits dirty contents.
 */
export function resetPlanExecution(input: ResetPlanExecutionInput): ResetPlanExecutionResult {
	const repoRoot = fs.realpathSync(input.repoRoot);
	const worktreeRoot = path.resolve(input.worktreeRoot);
	const worktree = path.resolve(input.worktree);
	const integrationWorktree = path.resolve(input.integrationWorktree);
	if (realpathIfPresent(repoRoot) !== repoRoot) fail(`Recovery repository root is not canonical: ${repoRoot}`);
	verifyExpectedNamespace({ ...input, worktree, integrationWorktree }, repoRoot, worktreeRoot, worktree);

	const records = parseWorktrees(repoRoot);
	const canonicalWorktree = realpathIfPresent(worktree);
	const record = records.find((candidate) => realpathIfPresent(candidate.path) === canonicalWorktree);
	const branchRecord = records.find((candidate) => candidate.branch === input.branch);
	if (branchRecord && realpathIfPresent(branchRecord.path) !== canonicalWorktree) {
		fail(`Recovery branch ${input.branch} is attached to a foreign worktree: ${branchRecord.path}`);
	}
	if (record?.branch && record.branch !== input.branch) fail(`Recovery worktree is attached to a foreign branch: ${record.branch}`);
	if (record?.locked) fail(`Recovery worktree is locked: ${worktree}`);
	if (record && !fs.existsSync(worktree)) fail(`Recovery worktree moved or disappeared while still registered: ${worktree}`);
	if (!record && fs.existsSync(worktree)) fail(`Recovery path exists without its recorded Git worktree: ${worktree}`);

	const currentHead = branchHead(repoRoot, input.branch);
	const expectedHead = input.expectedHead;
	if (expectedHead === null) {
		if (currentHead !== null || record || fs.existsSync(worktree)) {
			fail(`Unexpected Git state exists for a recovery target with no recorded worktree head: ${input.branch}`);
		}
		return { branch: input.branch, worktree, removedWorktree: false, deletedBranch: false, alreadyMissing: true };
	}
	if (!/^[0-9a-f]{40,64}$/i.test(expectedHead)) fail("Recovery expected head is not a Git object ID");

	if (currentHead !== null && currentHead !== expectedHead) {
		fail(`Recovery branch moved: expected ${expectedHead}, found ${currentHead}`);
	}
	if (record) {
		const actualHeadResult = git(worktree, ["rev-parse", "HEAD"], true);
		if (actualHeadResult.status !== 0) fail(`Recovery worktree is not a readable Git checkout: ${worktree}`);
		if (actualHeadResult.stdout.trim() !== expectedHead) {
			fail(`Recovery worktree moved: expected ${expectedHead}, found ${actualHeadResult.stdout.trim()}`);
		}
		if (input.expectedTree !== null) {
			const actualTree = git(worktree, ["rev-parse", "HEAD^{tree}"], true);
			if (actualTree.status !== 0 || actualTree.stdout.trim() !== input.expectedTree) {
				fail(`Recovery worktree tree moved: expected ${input.expectedTree}, found ${actualTree.stdout.trim()}`);
			}
		}
	}

	const fullyMissing = currentHead === null && !record && !fs.existsSync(worktree);
	if (fullyMissing) {
		if (!input.allowRecordedMissing) fail(`Recorded recovery Git state is missing before its destructive apply: ${input.branch}`);
		return { branch: input.branch, worktree, removedWorktree: false, deletedBranch: false, alreadyMissing: true };
	}
	if (currentHead === null && (record || fs.existsSync(worktree))) {
		fail(`Recovery branch ${input.branch} is missing while its worktree still exists`);
	}
	if (record) removeWorktree(repoRoot, worktree);
	const afterRemoval = parseWorktrees(repoRoot).find((candidate) => realpathIfPresent(candidate.path) === canonicalWorktree);
	if (afterRemoval || fs.existsSync(worktree)) fail(`Recovery worktree was not removed: ${worktree}`);
	deleteBranch(repoRoot, input.branch, expectedHead);
	if (branchHead(repoRoot, input.branch) !== null) fail(`Recovery branch remains after CAS deletion: ${input.branch}`);
	return { branch: input.branch, worktree, removedWorktree: Boolean(record), deletedBranch: true, alreadyMissing: false };
}
