import fs from "node:fs";
import path from "node:path";
import { listCoordinationRefs, validatePlanName } from "./coordination-ref.ts";
import type { CleanupInput, CleanupResult } from "./cleanup-run.ts";
import { listHerderBranches, listWorktreeInventory, type BranchRecord, type WorktreeRecord } from "./namespace-inventory.ts";
import { allowedWorktreeRoots, canonicalWorktreeRoot, legacyWorktreeContainer, legacyWorktreeRoot } from "./worktree-locations.ts";
import { currentCheckout, fail, isInside, realpathIfPresent, runGit } from "./primitives.ts";

export interface ForceCleanupInput {
	repo: string;
	planDir: string;
	planName?: string | null;
	dryRun: boolean;
	/** Internal synchronous authority check; omitted by raw Git callers. */
	validateBeforeMutation?: (phase: string, target: string) => void;
	/** Synchronous coordinated remover; validates each mutation and retains exclusion on failure.
	 * Must remove the directory before returning. Omitted by raw Git callers.
	 * Exclusion must survive failures in the final directory-removal tail too.
	 */
	removePlanDirectory?: (planDirectory: string, validate: (phase: string, target: string) => void) => void;
}

function ownedWorktrees(repoRoot: string, planDir: string, planName: string, records: WorktreeRecord[]): WorktreeRecord[] {
	const namespace = `herder/${planName}/`;
	const canonicalRoot = canonicalWorktreeRoot(planDir);
	const leftoverRoot = legacyWorktreeRoot(repoRoot, planName);
	return records.filter((item) => {
		if (item.branch.startsWith(namespace)) return true;
		const resolved = realpathIfPresent(item.path);
		return isInside(canonicalRoot, resolved) || isInside(leftoverRoot, resolved);
	});
}

function removeLegacyWorktreeContainer(repoRoot: string, planName: string, validate: (phase: string, target: string) => void): void {
	const leftoverRoot = legacyWorktreeRoot(repoRoot, planName);
	if (fs.existsSync(leftoverRoot) && isInside(path.dirname(leftoverRoot), leftoverRoot)) {
		validate("legacy-root", leftoverRoot);
		fs.rmSync(leftoverRoot, { recursive: true, force: true });
	}
	const parent = legacyWorktreeContainer(repoRoot);
	if (path.dirname(leftoverRoot) === parent && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
		validate("legacy-container", parent);
		fs.rmSync(parent, { recursive: true, force: true });
	}
}

function forceRemoveWorktree(repoRoot: string, worktreePath: string, allowedRoots: string[], validate: (phase: string, target: string) => void): void {
	const resolved = realpathIfPresent(worktreePath);
	if (resolved === repoRoot) fail(`Refusing to remove the user checkout: ${repoRoot}`);
	validate("unlock", worktreePath);
	runGit(repoRoot, ["worktree", "unlock", "--", worktreePath], { allowFailure: true });
	validate("remove", worktreePath);
	const removed = runGit(repoRoot, ["worktree", "remove", "--force", "--force", "--", worktreePath], { allowFailure: true });
	if (removed.status !== 0) {
		validate("prune", worktreePath);
		runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
		const fallbackPath = realpathIfPresent(worktreePath);
		if (fallbackPath === repoRoot || !allowedRoots.some((root) => isInside(root, fallbackPath))) {
			fail(`Refusing raw removal of worktree ${worktreePath}: resolved path ${fallbackPath} is outside allowed roots ${allowedRoots.join(", ")}`);
		}
		if (fs.existsSync(fallbackPath)) {
			validate("fallback-rm", fallbackPath);
			fs.rmSync(fallbackPath, { recursive: true, force: true });
			validate("prune", worktreePath);
			runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
		}
		const stillListed = listWorktreeInventory(repoRoot).some((item) => item.path && realpathIfPresent(item.path) === resolved);
		if (stillListed) {
			fail(`Cannot force-remove worktree ${worktreePath}: ${(removed.stderr || removed.stdout).trim()}`);
		}
	}
}

function deleteRef(repoRoot: string, ref: string, validate: (phase: string, target: string) => void): void {
	validate("ref", ref);
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
	const planName = validatePlanName(input.planName ?? path.basename(planCandidate));
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

	const allowedRoots = allowedWorktreeRoots(repoRoot, planDir, planName);
	const worktrees = listWorktreeInventory(repoRoot);
	const owned = ownedWorktrees(repoRoot, planDir, planName, worktrees.filter((item) => item.path));
	const branches = listHerderBranches(repoRoot, planName);
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
		kind: item.identity?.kind ?? "base",
		...(item.identity?.plan ? { plan: item.identity.plan } : {}),
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

	const validate = "validateBeforeMutation" in input ? input.validateBeforeMutation ?? (() => {}) : () => {};
	for (const item of owned) forceRemoveWorktree(repoRoot, item.path, allowedRoots, validate);
	for (const item of branches) deleteRef(repoRoot, `refs/heads/${item.branch}`, validate);
	for (const item of refs) {
		deleteRef(repoRoot, item.ref, validate);
		result.destruction.refsRemoved.push({
			ref: item.ref,
			target: item.target,
			kind: item.identity?.kind ?? "base",
			...(item.identity?.plan ? { plan: item.identity.plan } : {}),
		});
	}

	const remainingBranches = listHerderBranches(repoRoot, planName);
	const remainingRefs = listCoordinationRefs(repoRoot, planName);
	const remainingWorktrees = ownedWorktrees(repoRoot, planDir, planName, listWorktreeInventory(repoRoot).filter((item) => item.path));
	if (remainingBranches.length > 0 || remainingRefs.length > 0 || remainingWorktrees.length > 0) {
		fail(`Force cleanup left Herder artifacts: ${[
			...remainingBranches.map((item) => item.branch),
			...remainingRefs.map((item) => item.ref),
			...remainingWorktrees.map((item) => item.path),
		].join(", ")}`);
	}

	removeLegacyWorktreeContainer(repoRoot, planName, validate);

	if (planDirectoryPresent) {
		const deletionTarget = realpathIfPresent(planDir);
		if (deletionTarget !== planDir || deletionTarget === repoRoot || !isInside(repoRoot, deletionTarget)) {
			fail(`Refusing to remove changed or unsafe plan directory: ${planDir}`);
		}
		validate("plan-directory", planDir);
		if ("removePlanDirectory" in input && input.removePlanDirectory) {
			input.removePlanDirectory(planDir, validate);
		} else {
			fs.rmSync(planDir, { recursive: true, force: true });
		}
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
