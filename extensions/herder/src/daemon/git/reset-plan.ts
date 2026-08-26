import fs from "node:fs";
import path from "node:path";
import { listWorktrees, type WorktreeRecord } from "./namespace-inventory.ts";
import { fail, isInside, realpathIfPresent, runGit } from "./primitives.ts";

export type ResetPlanCleanupStep = "worktree_removed" | "branch_deleted";

/** Opaque, request-bound evidence returned by the manager store before replaying a cleanup step. */
export interface ResetPlanCleanupEvidence {
	evidenceId: string;
	runId: string;
	requestId: string;
	requestSha256: string;
	planId: string;
	generation: number;
	round: number;
	assignmentPath: string;
	assignmentSha256: string;
	snapshotSha256: string;
	generationBase: string;
	branch: string;
	worktree: string;
	expectedHead: string | null;
	expectedTree: string | null;
	step: ResetPlanCleanupStep;
	state: "prepared" | "completed";
}

export type ResetPlanCleanupIdentity = Omit<ResetPlanCleanupEvidence, "evidenceId" | "step" | "state">;

export interface ResetPlanExecutionInput {
	repoRoot: string;
	worktreeRoot: string;
	integrationWorktree: string;
	branch: string;
	worktree: string;
	expectedHead: string | null;
	expectedTree: string | null;
	additionalRefs?: Array<{ ref: string; target: string }>;
	/** Exact request/run identity expected for any replay evidence. */
	cleanupIdentity?: ResetPlanCleanupIdentity;
	/** Typed manager-owned progress from an earlier interrupted apply. */
	recordedCleanup?: ResetPlanCleanupEvidence;
	/** Persist manager-owned step intent before the next Git mutation. */
	onPrepare?: (step: ResetPlanCleanupStep) => void;
	/** Observe a successful Git mutation; replay never depends on this callback. */
	onProgress?: (step: ResetPlanCleanupStep) => void;
	/** Persist successful completion after a Git mutation when supplied by the manager. */
	onComplete?: (step: ResetPlanCleanupStep) => void;
}

export interface ResetPlanExecutionResult {
	branch: string;
	worktree: string;
	removedWorktree: boolean;
	deletedBranch: boolean;
	alreadyMissing: boolean;
}


function branchHead(repoRoot: string, branch: string): string | null {
	const result = runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`], { allowFailure: true });
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
	if (!isInside(worktreeRoot, worktree, { allowEqual: false })) fail(`Recovery worktree escaped the manager worktree root: ${worktree}`);
	if (!isInside(canonicalRoot, canonicalWorktree, { allowEqual: false })) fail(`Recovery worktree escaped the manager worktree root: ${worktree}`);
	if (path.resolve(worktree) === path.resolve(input.integrationWorktree) || canonicalWorktree === realpathIfPresent(input.integrationWorktree)) fail("Recovery cleanup cannot remove the integration worktree");
	if (fs.existsSync(worktree) && fs.lstatSync(worktree).isSymbolicLink()) {
		fail(`Recovery worktree path is moved or symlinked: ${worktree}`);
	}
}

function validateRecordedCleanup(input: ResetPlanExecutionInput, evidence: ResetPlanCleanupEvidence | undefined): void {
	if (!evidence) return;
	if (!input.cleanupIdentity) fail("Recovery cleanup evidence has no expected manager identity");
	for (const key of ["runId", "requestId", "requestSha256", "planId", "generation", "round", "assignmentPath", "assignmentSha256", "snapshotSha256", "generationBase", "branch", "worktree", "expectedHead", "expectedTree"] as const) {
		if (evidence[key] !== input.cleanupIdentity[key]) fail(`Recovery cleanup evidence does not match ${key}`);
	}
	if (!/^manager-attention-cleanup:[0-9a-f-]{36}$/i.test(evidence.evidenceId)) {
		fail("Recovery cleanup evidence is not a manager-owned token");
	}
	if (evidence.state !== "prepared" && evidence.state !== "completed") {
		fail("Recovery cleanup evidence has an invalid transition state");
	}
	if (evidence.step !== "worktree_removed" && evidence.step !== "branch_deleted") {
		fail("Recovery cleanup evidence has an invalid step");
	}
	if (evidence.branch !== input.branch || evidence.worktree !== input.worktree
		|| evidence.expectedHead !== input.expectedHead || evidence.expectedTree !== input.expectedTree) {
		fail("Recovery cleanup evidence does not match the recorded Git identity");
	}
	if (!evidence.runId || !evidence.requestId || !evidence.requestSha256 || !evidence.planId
		|| !evidence.assignmentPath || !evidence.assignmentSha256 || !evidence.snapshotSha256 || !evidence.generationBase
		|| !Number.isSafeInteger(evidence.generation) || evidence.generation < 1
		|| !Number.isSafeInteger(evidence.round) || evidence.round < 1) {
		fail("Recovery cleanup evidence is incomplete");
	}
}

function removeWorktree(repoRoot: string, worktree: string): void {
	const result = runGit(repoRoot, ["worktree", "remove", "--force", "--", worktree], { allowFailure: true });
	if (result.status !== 0) fail(`Cannot force-remove the recorded recovery worktree: ${(result.stderr || result.stdout).trim()}`);
}

function deleteBranch(repoRoot: string, branch: string, expectedHead: string, additionalRefs: Array<{ ref: string; target: string }> = []): void {
	const commands = [
		"start",
		`delete refs/heads/${branch} ${expectedHead}`,
		...additionalRefs.map((record) => `delete ${record.ref} ${record.target}`),
		"prepare",
		"commit",
		"",
	].join("\n");
	const result = runGit(repoRoot, ["update-ref", "--stdin"], { input: commands, allowFailure: true });
	if (result.status !== 0) fail(`Cannot delete moved recovery branch or transient refs for ${branch}: ${(result.stderr || result.stdout).trim()}`);
}

function additionalRefsMissing(repoRoot: string, refs: Array<{ ref: string; target: string }> = []): boolean {
	return refs.every((record) => runGit(repoRoot, ["show-ref", "--verify", "--quiet", record.ref], { allowFailure: true }).status === 1);
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
	validateRecordedCleanup(input, input.recordedCleanup);
	if (realpathIfPresent(repoRoot) !== repoRoot) fail(`Recovery repository root is not canonical: ${repoRoot}`);
	verifyExpectedNamespace({ ...input, worktree, integrationWorktree }, repoRoot, worktreeRoot, worktree);
	const branchIdentity = input.branch.match(/^herder\/([^/]+)\/(\d{3,})$/)!;
	const refPrefix = `refs/plan-herder/${branchIdentity[1]}/`;
	const seenRefs = new Set<string>();
	for (const record of input.additionalRefs ?? []) {
		if (!record.ref.startsWith(refPrefix) || !/^[0-9a-f]{40,64}$/i.test(record.target) || seenRefs.has(record.ref)) {
			fail(`Recovery transient ref identity is invalid: ${record.ref}`);
		}
		seenRefs.add(record.ref);
	}

	const records = listWorktrees(repoRoot);
	const canonicalWorktree = realpathIfPresent(worktree);
	const record = records.find((candidate) => candidate.path && realpathIfPresent(candidate.path) === canonicalWorktree);
	const branchRecord = records.find((candidate) => candidate.branch === input.branch);
	if (branchRecord && !branchRecord.path) {
		fail(`Recovery branch ${input.branch} has a pathless worktree record`);
	}
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
		const actualHeadResult = runGit(worktree, ["rev-parse", "HEAD"], { allowFailure: true });
		if (actualHeadResult.status !== 0) fail(`Recovery worktree is not a readable Git checkout: ${worktree}`);
		if (actualHeadResult.stdout.trim() !== expectedHead) {
			fail(`Recovery worktree moved: expected ${expectedHead}, found ${actualHeadResult.stdout.trim()}`);
		}
		if (input.expectedTree !== null) {
			const actualTree = runGit(worktree, ["rev-parse", "HEAD^{tree}"], { allowFailure: true });
			if (actualTree.status !== 0 || actualTree.stdout.trim() !== input.expectedTree) {
				fail(`Recovery worktree tree moved: expected ${input.expectedTree}, found ${actualTree.stdout.trim()}`);
			}
		}
	}

	const recordedStep = input.recordedCleanup?.step;
	const fullyMissing = currentHead === null && !record && !fs.existsSync(worktree);
	if (fullyMissing) {
		if (!additionalRefsMissing(repoRoot, input.additionalRefs)) fail(`Recovery transient refs remain after branch cleanup: ${input.branch}`);
		if (input.expectedHead === null) {
			return { branch: input.branch, worktree, removedWorktree: false, deletedBranch: false, alreadyMissing: true };
		}
		if (recordedStep !== "branch_deleted") {
			fail(`Recorded recovery Git state is missing before its destructive apply: ${input.branch}`);
		}
		if (input.recordedCleanup?.state === "prepared") input.onComplete?.("branch_deleted");
		return { branch: input.branch, worktree, removedWorktree: false, deletedBranch: false, alreadyMissing: true };
	}
	if (recordedStep === "branch_deleted" && input.recordedCleanup?.state === "completed" && currentHead !== null) {
		fail(`Recovery branch ${input.branch} reappeared after manager cleanup`);
	}
	if (currentHead === null && (record || fs.existsSync(worktree))) {
		fail(`Recovery branch ${input.branch} is missing while its worktree still exists`);
	}
	if (!record && !fs.existsSync(worktree) && recordedStep === undefined) {
		fail(`Recovery worktree is missing before its manager cleanup was recorded: ${worktree}`);
	}
	if (record) {
		if (recordedStep === "branch_deleted") {
			fail(`Recovery worktree reappeared before branch cleanup: ${worktree}`);
		}
		if (recordedStep === "worktree_removed" && input.recordedCleanup?.state === "completed") {
			fail(`Recovery worktree reappeared after manager cleanup: ${worktree}`);
		}
		if (recordedStep !== "worktree_removed" && recordedStep !== "branch_deleted") input.onPrepare?.("worktree_removed");
		removeWorktree(repoRoot, worktree);
		const afterRemoval = listWorktrees(repoRoot).find((candidate) => candidate.path && realpathIfPresent(candidate.path) === canonicalWorktree);
		if (afterRemoval || fs.existsSync(worktree)) fail(`Recovery worktree was not removed: ${worktree}`);
		input.onProgress?.("worktree_removed");
		input.onComplete?.("worktree_removed");
	} else if (recordedStep !== "worktree_removed" && recordedStep !== "branch_deleted") {
		fail(`Recovery worktree is not a manager-recorded cleanup continuation: ${worktree}`);
	} else if (recordedStep === "worktree_removed" && input.recordedCleanup?.state === "prepared") {
		input.onComplete?.("worktree_removed");
	}
	if (recordedStep !== "branch_deleted") input.onPrepare?.("branch_deleted");
	deleteBranch(repoRoot, input.branch, expectedHead, input.additionalRefs);
	if (branchHead(repoRoot, input.branch) !== null || !additionalRefsMissing(repoRoot, input.additionalRefs)) fail(`Recovery branch or transient refs remain after CAS deletion: ${input.branch}`);
	input.onProgress?.("branch_deleted");
	input.onComplete?.("branch_deleted");
	return { branch: input.branch, worktree, removedWorktree: Boolean(record), deletedBranch: true, alreadyMissing: false };
}
