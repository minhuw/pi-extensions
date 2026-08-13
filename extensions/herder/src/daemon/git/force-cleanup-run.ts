import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { parseCoordinationRefRelative, type CoordinationRef } from "./coordination-ref.ts";
import { parseWorktreeRecords } from "./cleanup-run.ts";
import type { CleanupInput, CleanupResult } from "./cleanup-run.ts";

export interface ForceCleanupInput {
	repo: string;
	planDir: string;
	planName?: string | null;
	dryRun: boolean;
}

interface WorktreeRecord { path: string; branch: string; locked: boolean }
interface BranchRecord { branch: string; head: string; relative: string }
interface CoordinationRefRecord {
	ref: string;
	target: string;
	relative: string;
	kind: CoordinationRef["kind"] | "unknown";
	plan: string | null;
}

function fail(message: string): never {
	throw new Error(message);
}

function runGit(repoRoot: string, args: string[], { allowFailure = false }: { allowFailure?: boolean } = {}): SpawnSyncReturns<string> {
	const result = spawnSync("git", ["-C", repoRoot, ...args], {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) fail(`Cannot run git: ${result.error.message}`);
	if (result.status !== 0 && !allowFailure) {
		fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result;
}

function realpathIfPresent(candidate: string): string {
	try { return fs.realpathSync(candidate); }
	catch { return path.resolve(candidate); }
}

function isInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolvePlanName(planDir: string, inputName: unknown): string {
	const name = String(inputName ?? path.basename(planDir));
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)
		|| name.includes("..")
		|| name.endsWith(".")
		|| name.endsWith(".lock")) {
		fail(`Plan-set name must be a lowercase Git-safe basename: ${JSON.stringify(name)}`);
	}
	return name;
}

function parseWorktrees(repoRoot: string): WorktreeRecord[] {
	const nulResult = runGit(repoRoot, ["worktree", "list", "--porcelain", "-z"], { allowFailure: true });
	if (nulResult.status === 0) return parseWorktreeRecords(nulResult.stdout, true);
	return parseWorktreeRecords(runGit(repoRoot, ["worktree", "list", "--porcelain"]).stdout, false);
}

function listPlanBranches(repoRoot: string, planName: string): BranchRecord[] {
	const prefix = `herder/${planName}/`;
	const output = runGit(repoRoot, [
		"for-each-ref",
		"--format=%(refname:lstrip=2)%09%(objectname)",
		`refs/heads/${prefix}`,
	]).stdout;
	return output.split(/\r?\n/).filter(Boolean).map((line) => {
		const separator = line.indexOf("\t");
		if (separator === -1) fail(`Cannot parse Git branch record: ${JSON.stringify(line)}`);
		const branch = line.slice(0, separator);
		return { branch, head: line.slice(separator + 1), relative: branch.slice(prefix.length) };
	});
}

function listCoordinationRefs(repoRoot: string, planName: string): CoordinationRefRecord[] {
	const prefix = `refs/plan-herder/${planName}/`;
	const output = runGit(repoRoot, [
		"for-each-ref",
		"--format=%(refname)%09%(objectname)",
		prefix,
	]).stdout;
	return output.split(/\r?\n/).filter(Boolean).map((line) => {
		const separator = line.indexOf("\t");
		if (separator === -1) fail(`Cannot parse coordination ref record: ${JSON.stringify(line)}`);
		const ref = line.slice(0, separator);
		const target = line.slice(separator + 1);
		const relative = ref.slice(prefix.length);
		const identity = parseCoordinationRefRelative(relative);
		return { ref, target, relative, kind: identity?.kind ?? "unknown", plan: identity?.plan ?? null };
	});
}

function currentCheckout(repoRoot: string): { branch: string | null; head: string | null } {
	const branch = runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
	const head = runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
	return {
		branch: branch.status === 0 ? branch.stdout.trim() : null,
		head: head.status === 0 ? head.stdout.trim() : null,
	};
}

function conventionalWorktreeRoot(repoRoot: string, planName: string): string {
	return `${repoRoot}-herder-worktrees${path.sep}${planName}`;
}

function ownedWorktrees(repoRoot: string, planName: string, records: WorktreeRecord[]): WorktreeRecord[] {
	const namespace = `herder/${planName}/`;
	const conventionalRoot = conventionalWorktreeRoot(repoRoot, planName);
	return records.filter((item) => {
		if (item.branch.startsWith(namespace)) return true;
		return isInside(conventionalRoot, realpathIfPresent(item.path));
	});
}

function forceRemoveWorktree(repoRoot: string, worktreePath: string): void {
	const resolved = realpathIfPresent(worktreePath);
	if (resolved === repoRoot) fail(`Refusing to remove the user checkout: ${repoRoot}`);
	runGit(repoRoot, ["worktree", "unlock", "--", worktreePath], { allowFailure: true });
	const removed = runGit(repoRoot, ["worktree", "remove", "--force", "--force", "--", worktreePath], { allowFailure: true });
	if (removed.status !== 0) {
		runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
		if (fs.existsSync(worktreePath)) {
			fs.rmSync(worktreePath, { recursive: true, force: true });
			runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
		}
		const stillListed = parseWorktrees(repoRoot).some((item) => realpathIfPresent(item.path) === resolved);
		if (stillListed) {
			fail(`Cannot force-remove worktree ${worktreePath}: ${(removed.stderr || removed.stdout).trim()}`);
		}
	}
}

function deleteRef(repoRoot: string, ref: string): void {
	runGit(repoRoot, ["update-ref", "-d", ref], { allowFailure: true });
}

function emptyCleanupResult(input: {
	repoRoot: string;
	planDir: string;
	planName: string;
	dryRun: boolean;
	integrationBranch: string;
	integrationHead: string;
	integrationWorktree: string | null;
}): CleanupResult {
	return {
		repoRoot: input.repoRoot,
		planDir: input.planDir,
		planName: input.planName,
		integrationBranch: input.integrationBranch,
		integrationHead: input.integrationHead,
		plan: null,
		dryRun: input.dryRun,
		includeFailed: false,
		deep: false,
		force: true,
		actions: [],
		removed: [],
		skipped: [],
		destruction: {
			requested: true,
			eligible: false,
			blockers: [],
			refsPlanned: [],
			refsRemoved: [],
			integrationWorktree: input.integrationWorktree,
			integrationRemoved: false,
			planDirectoryRemoved: false,
		},
		preserved: {
			integrationBranch: input.integrationBranch,
			integrationWorktree: input.integrationWorktree,
			coordinationRefs: `refs/plan-herder/${input.planName}/`,
			planDirectory: true,
		},
	};
}

/**
 * Unconditionally destroy one Herder plan-set namespace. This ignores run
 * status, completion proofs, dirty/locked worktrees, and merge ancestry.
 * The only hard refusals are "this would delete the current checkout".
 */
export function forceCleanupRun(input: ForceCleanupInput | CleanupInput): CleanupResult {
	if ("force" in input && input.force && (input.deep || input.includeFailed || input.plan)) {
		fail("--force cannot be combined with --deep, --plan, or --include-failed");
	}
	const repoCandidate = path.resolve(input.repo);
	if (!fs.existsSync(repoCandidate) || !fs.statSync(repoCandidate).isDirectory()) fail(`Repository does not exist: ${repoCandidate}`);
	const repoRoot = fs.realpathSync(repoCandidate);
	const actualRoot = fs.realpathSync(runGit(repoRoot, ["rev-parse", "--show-toplevel"]).stdout.trim());
	if (actualRoot !== repoRoot) fail(`--repo must be the Git repository root: ${actualRoot}`);

	const planCandidate = path.resolve(repoRoot, input.planDir);
	const planName = resolvePlanName(planCandidate, input.planName);
	const integrationBranch = `herder/${planName}/integration`;
	const integrationRef = `refs/heads/${integrationBranch}`;
	const integrationHeadResult = runGit(repoRoot, ["rev-parse", "--verify", integrationRef], { allowFailure: true });
	const integrationHead = integrationHeadResult.status === 0 ? integrationHeadResult.stdout.trim() : "";

	let planDir = planCandidate;
	let planDirectoryPresent = false;
	if (fs.existsSync(planCandidate)) {
		if (fs.lstatSync(planCandidate).isSymbolicLink()) fail(`Plan directory must not be a symlink: ${planCandidate}`);
		planDir = fs.realpathSync(planCandidate);
		if (!fs.statSync(planDir).isDirectory()) fail(`Plan directory is not a directory: ${planDir}`);
		if (planDir === repoRoot) fail(`Refusing to remove the repository root: ${repoRoot}`);
		if (!isInside(repoRoot, planDir)) fail(`Plan directory must be inside the repository: ${planDir}`);
		planDirectoryPresent = true;
	}

	const worktrees = parseWorktrees(repoRoot);
	const owned = ownedWorktrees(repoRoot, planName, worktrees);
	const branches = listPlanBranches(repoRoot, planName);
	const refs = listCoordinationRefs(repoRoot, planName);
	const integrationWorktree = owned.find((item) => item.branch === integrationBranch)?.path ?? null;
	const checkout = currentCheckout(repoRoot);
	const currentWorktree = realpathIfPresent(repoRoot);
	const blockers: Array<Record<string, unknown>> = [];

	for (const item of owned) {
		if (realpathIfPresent(item.path) === currentWorktree) {
			blockers.push({ reason: "current-checkout-is-owned-worktree", worktree: item.path, branch: item.branch });
		}
	}
	if (checkout.branch?.startsWith(`herder/${planName}/`)) {
		blockers.push({ reason: "current-branch-is-owned", branch: checkout.branch });
	}

	const result = emptyCleanupResult({
		repoRoot,
		planDir,
		planName,
		dryRun: Boolean(input.dryRun),
		integrationBranch,
		integrationHead,
		integrationWorktree,
	});
	result.destruction.blockers = blockers;
	result.destruction.eligible = blockers.length === 0;
	result.destruction.refsPlanned = refs.map((item) => ({
		ref: item.ref,
		target: item.target,
		kind: item.kind === "unknown" ? "base" : item.kind,
		...(item.plan ? { plan: item.plan } : {}),
	}));
	result.actions = [
		...owned.map((item) => ({
			branch: item.branch || null,
			worktree: item.path,
			locked: item.locked,
			mode: "force-remove-worktree",
			operations: ["force-remove-worktree"],
		})),
		...branches.map((item) => ({
			branch: item.branch,
			head: item.head,
			plan: /^\d{3,}$/.test(item.relative) ? item.relative : null,
			mode: "force-delete-branch",
			operations: ["force-delete-branch"],
		})),
	];

	if (input.dryRun) return result;
	if (blockers.length > 0) {
		fail(`Force cleanup refused: ${blockers.map((item) => String(item.reason ?? "blocked")).join(", ")}`);
	}

	for (const item of owned) forceRemoveWorktree(repoRoot, item.path);
	for (const item of branches) deleteRef(repoRoot, `refs/heads/${item.branch}`);
	for (const item of refs) {
		deleteRef(repoRoot, item.ref);
		result.destruction.refsRemoved.push({
			ref: item.ref,
			target: item.target,
			kind: item.kind === "unknown" ? "base" : item.kind,
			...(item.plan ? { plan: item.plan } : {}),
		});
	}

	const remainingBranches = listPlanBranches(repoRoot, planName);
	const remainingRefs = listCoordinationRefs(repoRoot, planName);
	const remainingWorktrees = ownedWorktrees(repoRoot, planName, parseWorktrees(repoRoot));
	if (remainingBranches.length > 0 || remainingRefs.length > 0 || remainingWorktrees.length > 0) {
		fail(`Force cleanup left Herder artifacts: ${[
			...remainingBranches.map((item) => item.branch),
			...remainingRefs.map((item) => item.ref),
			...remainingWorktrees.map((item) => item.path),
		].join(", ")}`);
	}

	const conventionalRoot = conventionalWorktreeRoot(repoRoot, planName);
	if (fs.existsSync(conventionalRoot) && isInside(path.dirname(conventionalRoot), conventionalRoot)) {
		fs.rmSync(conventionalRoot, { recursive: true, force: true });
	}

	if (planDirectoryPresent) {
		const deletionTarget = realpathIfPresent(planDir);
		if (deletionTarget !== planDir || deletionTarget === repoRoot || !isInside(repoRoot, deletionTarget)) {
			fail(`Refusing to remove changed or unsafe plan directory: ${planDir}`);
		}
		fs.rmSync(planDir, { recursive: true, force: true });
		result.destruction.planDirectoryRemoved = true;
	}

	result.destruction.integrationRemoved = Boolean(integrationHead || integrationWorktree);
	result.removed = result.actions;
	result.preserved = {
		integrationBranch: null,
		integrationWorktree: null,
		coordinationRefs: null,
		planDirectory: !result.destruction.planDirectoryRemoved,
	};
	return result;
}
