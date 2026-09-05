import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotCheckout } from "./git/checkout-state.ts";
import {
	inspectActiveRebase,
	materializeAssignment,
	verifyActiveRebase,
	verifyAssignment,
} from "./git/assignment-bundle.ts";
import { inspectNamespace } from "./git/namespace-run.ts";
import { listWorktreeInventory } from "./git/namespace-inventory.ts";
import {
	buildCompletionProofPayload,
	inspectCompletionProof,
	writeCompletionProof,
	type ApprovalCore,
} from "./git/completion-proof.ts";
import { isAncestor as isAncestorProbe, isInside, runGit } from "./git/primitives.ts";
import { formatCheckpointRef, listCoordinationRefs } from "./git/coordination-ref.ts";
import { resetPlanExecution, type ResetPlanCleanupEvidence, type ResetPlanCleanupIdentity, type ResetPlanCleanupStep, type ResetPlanExecutionResult } from "./git/reset-plan.ts";
import { canonicalWorktreeRoot, isAllowedWorktreeRoot } from "./git/worktree-locations.ts";
import type { StoredPlanSpec } from "./run-store.ts";
import { resolveNodeExecutable } from "../shared/node-executable.ts";
import { GATE_OUTCOMES, type GateOutcome } from "../shared/gate-outcome.ts";
import {
	integrationRepairRefSnapshotSha256,
	normalizeIntegrationRepairRefSnapshotEvidence,
	stableJson,
	validateIntegrationRepairRefSnapshot,
	type IntegrationRepairRef,
	type VerificationGate,
} from "../shared/protocol.ts";

const ZERO_OID = "0000000000000000000000000000000000000000";

export interface AssignmentEvidence {
	bundlePath: string;
	bundleSha256: string;
	snapshotSha256: string;
	generationBase: string;
}

export interface GateResult {
	gateId: string;
	label: string;
	cwd: string;
	argv: string[];
	timeoutMs: number;
	rationale: string;
	command: string;
	ok: boolean;
	/** Process outcome only: a launched command failure is not necessarily a code defect. */
	outcome?: GateOutcome;
	error?: string;
	timedOut?: boolean;
	signal?: string | null;
	exitCode: number | null;
	durationMs: number;
	logPath: string;
	logBytes: number;
	logSha256: string;
	logTruncated: boolean;
}

export interface IntegrationResult {
	status: "integrated" | "conflict";
	head?: string;
	checkpointRef?: string;
	checkpoint?: string;
	onto?: string;
	detachedHead?: string;
}

export interface IntegrationRepairCommitResult {
	head: string;
	tree: string;
	parent: string;
	changedPaths: string[];
	supersededHead: string | null;
	committed: boolean;
}

export interface IntegrationRepairNamespaceEvidence {
	refs: IntegrationRepairRef[];
	snapshot: string;
	sha256: string;
}

export interface ActiveRebaseEvidence {
	checkpointRef: string;
	checkpoint: string;
	onto: string;
	detachedHead: string;
	rebaseStateSha256?: string;
}

export interface PlanTransientRef {
	ref: string;
	target: string;
}

export interface CompletionApprovalProof extends ApprovalCore {
	approvalProofSha256: string;
}

interface CompletionTagPayload extends CompletionApprovalProof {
	schemaVersion: 1;
	integratedHead: string;
}

function compact(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function runCommand(command: string, args: string[], options: {
	cwd?: string;
	allowFailure?: boolean;
	input?: string;
	maxBuffer?: number;
} = {}): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		input: options.input ?? "",
		maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
	});
	if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
	const status = result.status ?? 1;
	if (status !== 0 && !options.allowFailure) {
		throw new Error(`${command} ${args.join(" ")} failed (${status}): ${compact(result.stderr || result.stdout || "no output")}`);
	}
	return { status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

export function git(repo: string, args: string[], allowFailure = false): { status: number; stdout: string; stderr: string } {
	const result = runGit(repo, args, {
		allowFailure,
		maxBuffer: 64 * 1024 * 1024,
		failureFormatter: (commandArgs, stderr, stdout) => `git ${commandArgs.join(" ")} failed: ${compact(stderr || stdout || "no output")}`,
		spawnErrorFormatter: (error) => `git failed to start: ${error.message}`,
	});
	return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

export function gitValue(repo: string, ...args: string[]): string {
	return git(repo, args).stdout.trim();
}

function runJson(script: string, args: string[], options: { allowFailure?: boolean; allowNotOk?: boolean } = {}): Record<string, unknown> {
	const normalized = [...args];
	const delimiter = normalized.indexOf("--");
	if (delimiter === -1) normalized.push("--pretty");
	else normalized.splice(delimiter, 0, "--pretty");
	const result = runCommand(resolveNodeExecutable(), [script, ...normalized], { allowFailure: options.allowFailure });
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(result.stdout) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`${path.basename(script)} returned invalid JSON: ${(error as Error).message}`);
	}
	if (parsed.ok === false && !options.allowNotOk) throw new Error(String(parsed.error || `${path.basename(script)} failed`));
	return parsed;
}

function ensureParent(candidate: string): void {
	fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
}

function realRepositoryRoot(repoRoot: string): string {
	return fs.realpathSync(gitValue(repoRoot, "rev-parse", "--show-toplevel"));
}

function completionPayload(approval: CompletionApprovalProof, integratedHead: string): CompletionTagPayload {
	return buildCompletionProofPayload({ ...approval, integratedHead }) as CompletionTagPayload;
}

function parseCompletionTag(repoRoot: string, ref: string): { object: string; payload: CompletionTagPayload } {
	const proof = inspectCompletionProof(repoRoot, ref);
	if (!proof.ok) throw new Error(`Completion evidence ${ref} is invalid: ${proof.error}`);
	const object = String(proof.object || "");
	if (!object) throw new Error(`Completion evidence ${ref} has no commit object`);
	return { object, payload: proof.payload as CompletionTagPayload };
}

function createCompletionTag(repoRoot: string, ref: string, tagName: string, payload: CompletionTagPayload): void {
	writeCompletionProof(repoRoot, ref, payload, tagName);
}

function cherryHasOnlyEquivalent(repoRoot: string, upstream: string, head: string, limit: string): boolean {
	const result = git(repoRoot, ["cherry", upstream, head, limit], true);
	return result.status === 0 && result.stdout.split(/\r?\n/).filter(Boolean).every((line) => line.startsWith("-"));
}

function linearCommits(repoRoot: string, range: string): string[] | null {
	const merges = git(repoRoot, ["rev-list", "--min-parents=2", range], true);
	if (merges.status !== 0 || merges.stdout.trim()) return null;
	const commits = git(repoRoot, ["rev-list", "--reverse", range], true);
	return commits.status === 0 ? commits.stdout.split(/\r?\n/).filter(Boolean) : null;
}

function commitPatchIdentity(repoRoot: string, commit: string): string | null {
	const empty = git(repoRoot, ["diff", "--quiet", `${commit}^`, commit], true);
	if (empty.status === 0) return "empty";
	if (empty.status !== 1) return null;
	const patch = git(repoRoot, ["show", "--pretty=format:", "--patch", "--binary", commit], true);
	if (patch.status !== 0) return null;
	const result = runGit(repoRoot, ["patch-id", "--stable"], {
		input: patch.stdout,
		allowFailure: true,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) return null;
	const lines = result.stdout.split(/\r?\n/).filter(Boolean);
	const match = lines.length === 1 ? lines[0]!.match(/^([0-9a-f]+)\s/i) : null;
	return match?.[1]?.toLowerCase() ?? null;
}

function patchEquivalentBothWays(repoRoot: string, integrationHead: string, restackedHead: string, approvedBase: string, checkpoint: string): boolean {
	// `git cherry` is a useful patch-membership check, but it omits merges and
	// collapses repeated patch IDs. Replay the exact reviewed linear sequence so
	// recovery is also bound to patch order, multiplicity, and the resulting tree.
	const approvedCommits = linearCommits(repoRoot, `${approvedBase}..${checkpoint}`);
	const restackedCommits = linearCommits(repoRoot, `${integrationHead}..${restackedHead}`);
	if (!approvedCommits || !restackedCommits) return false;
	if (!cherryHasOnlyEquivalent(repoRoot, restackedHead, checkpoint, approvedBase)
		|| !cherryHasOnlyEquivalent(repoRoot, checkpoint, restackedHead, integrationHead)) return false;

	const container = fs.mkdtempSync(path.join(os.tmpdir(), "herder-restack-validation-"));
	const validationRepo = path.join(container, "repo");
	const expectedPatchIds: string[] = [];
	try {
		const cloned = git(repoRoot, ["clone", "--quiet", "--shared", "--no-checkout", repoRoot, validationRepo], true);
		if (cloned.status !== 0) return false;
		if (git(validationRepo, ["checkout", "--detach", "--quiet", integrationHead], true).status !== 0) return false;
		for (const commit of approvedCommits) {
			const approvedIdentity = commitPatchIdentity(repoRoot, commit);
			if (!approvedIdentity) return false;
			const replayed = git(validationRepo, ["-c", "rerere.enabled=false", "cherry-pick", "--no-commit", commit], true);
			if (replayed.status !== 0) return false;
			const changed = git(validationRepo, ["diff", "--cached", "--quiet", "HEAD", "--"], true).status !== 0;
			if (!changed && approvedIdentity !== "empty") {
				// The approved patch is already in the advanced integration base.
				git(validationRepo, ["reset", "--hard", "--quiet", "HEAD"]);
				continue;
			}
			const tree = gitValue(validationRepo, "write-tree");
			const parent = gitValue(validationRepo, "rev-parse", "HEAD");
			const committed = runGit(validationRepo, [
				"-c", "user.name=Herder Restack Validation",
				"-c", "user.email=herder-restack-validation@invalid",
				"commit-tree", tree, "-p", parent,
			], {
				input: `Herder restack validation for ${commit}\n`,
				allowFailure: true,
				maxBuffer: 64 * 1024 * 1024,
			});
			if (committed.status !== 0 || !committed.stdout.trim()) return false;
			const expectedCommit = committed.stdout.trim();
			git(validationRepo, ["reset", "--hard", "--quiet", expectedCommit]);
			const patchIdentity = commitPatchIdentity(validationRepo, expectedCommit);
			if (!patchIdentity) return false;
			expectedPatchIds.push(patchIdentity);
		}
		if (gitValue(validationRepo, "rev-parse", "HEAD^{tree}") !== gitValue(repoRoot, "rev-parse", `${restackedHead}^{tree}`)) return false;
		const restackedPatchIds = restackedCommits.map((commit) => commitPatchIdentity(repoRoot, commit));
		return restackedPatchIds.every(Boolean)
			&& stableJson(expectedPatchIds) === stableJson(restackedPatchIds);
	} finally {
		fs.rmSync(container, { recursive: true, force: true });
	}
}

export class GitDriver {
	readonly repoRoot: string;
	readonly planDirectory: string;
	readonly planName: string;
	readonly helperRoot: string;
	readonly worktreeRoot: string;
	readonly integrationBranch: string;
	readonly integrationWorktree: string;

	constructor(input: {
		repoRoot: string;
		planDirectory: string;
		planName: string;
		helperRoot: string;
		worktreeRoot?: string;
	}) {
		this.repoRoot = fs.realpathSync(input.repoRoot);
		if (realRepositoryRoot(this.repoRoot) !== this.repoRoot) throw new Error(`Repository root mismatch: ${this.repoRoot}`);
		this.planDirectory = fs.realpathSync(input.planDirectory);
		if (!isInside(this.repoRoot, this.planDirectory, { allowEqual: false })) throw new Error(`Plan directory must be inside the repository: ${this.planDirectory}`);
		this.planName = input.planName;
		this.helperRoot = input.helperRoot;
		const canonicalRoot = canonicalWorktreeRoot(this.planDirectory);
		this.worktreeRoot = path.resolve(input.worktreeRoot ?? canonicalRoot);
		if (!isAllowedWorktreeRoot(this.worktreeRoot, this.repoRoot, this.planDirectory, this.planName)) {
			throw new Error(`Worktree root is outside Herder's allowed locations: ${this.worktreeRoot}`);
		}
		this.integrationBranch = `herder/${this.planName}/integration`;
		this.integrationWorktree = path.join(this.worktreeRoot, "integration");
	}

	async captureCheckout(): Promise<string> {
		const result = await snapshotCheckout({ repo: this.repoRoot, excludes: [this.planDirectory] });
		return result.stateToken;
	}

	async verifyCheckout(expected: string): Promise<void> {
		const result = await snapshotCheckout({ repo: this.repoRoot, excludes: [this.planDirectory], expect: expected });
		if (!result.ok) throw new Error(`Checkout changed since the run checkpoint: ${result.changedComponents?.join(", ") ?? "unknown"}`);
	}

	inspectNamespace(mode: "fire" | "resume") {
		return inspectNamespace({
			repo: this.repoRoot,
			planDir: this.planDirectory,
			planName: this.planName,
			mode,
		});
	}

	initializeFreshNamespace(baseCommit: string, assignments: StoredPlanSpec["assignment"][], graphGeneration = 1): AssignmentEvidence {
		const branchRef = `refs/heads/${this.integrationBranch}`;
		const baseRef = `refs/plan-herder/${this.planName}/base`;
		const allowedRefs = new Set([branchRef, baseRef]);
		for (const prefix of [`refs/heads/herder/${this.planName}/`, `refs/plan-herder/${this.planName}/`]) {
			for (const line of git(this.repoRoot, ["for-each-ref", "--format=%(refname)%09%(objectname)", prefix]).stdout.split(/\r?\n/).filter(Boolean)) {
				const [ref, target] = line.split("\t");
				if (!ref || !target || !allowedRefs.has(ref)) throw new Error(`Unexpected ref during namespace initialization: ${line}`);
				if (target !== baseCommit) throw new Error(`Initialization ref ${ref} moved from ${baseCommit} to ${target}`);
			}
		}
		const branchExists = git(this.repoRoot, ["show-ref", "--verify", "--quiet", branchRef], true).status === 0;
		const worktreeRecord = listWorktreeInventory(this.repoRoot).find((item) => item.path === this.integrationWorktree);
		if (!branchExists) {
			if (worktreeRecord || fs.existsSync(this.integrationWorktree)) throw new Error(`Integration path exists without its expected branch: ${this.integrationWorktree}`);
			ensureParent(this.integrationWorktree);
			git(this.repoRoot, ["worktree", "add", "-b", this.integrationBranch, this.integrationWorktree, baseCommit]);
		} else if (!worktreeRecord) {
			if (fs.existsSync(this.integrationWorktree)) throw new Error(`Unregistered integration path exists: ${this.integrationWorktree}`);
			ensureParent(this.integrationWorktree);
			git(this.repoRoot, ["worktree", "add", this.integrationWorktree, this.integrationBranch]);
		} else if (worktreeRecord.branch !== this.integrationBranch) {
			throw new Error(`Integration worktree is not attached to ${this.integrationBranch}`);
		}
		if (git(this.repoRoot, ["show-ref", "--verify", "--quiet", baseRef], true).status !== 0) {
			git(this.repoRoot, ["update-ref", baseRef, baseCommit, ZERO_OID]);
		}
		return this.materializeRunAssignment(baseCommit, assignments, graphGeneration);
	}

	materializeRunAssignment(expectedHead: string, assignments: StoredPlanSpec["assignment"][], graphGeneration: number): AssignmentEvidence {
		const result = materializeAssignment({
			planDir: this.planDirectory,
			worktree: this.integrationWorktree,
			expectedBranch: this.integrationBranch,
			expectedHead,
		}, { run: true, entries: assignments, runGeneration: graphGeneration });
		return {
			bundlePath: String(result.bundlePath),
			bundleSha256: String(result.bundleSha256),
			snapshotSha256: String(result.snapshotSha256),
			generationBase: String(result.generationBase),
		};
	}

	ensurePlanWorktree(planId: string, compiled: StoredPlanSpec["assignment"], expectedHead?: string): { branch: string; worktree: string; assignment: AssignmentEvidence } {
		const branch = `herder/${this.planName}/${planId}`;
		const worktree = path.join(this.worktreeRoot, planId);
		const integrationHead = expectedHead ?? gitValue(this.repoRoot, "rev-parse", `refs/heads/${this.integrationBranch}`);
		const branchExists = git(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true).status === 0;
		const worktreeRecord = listWorktreeInventory(this.repoRoot).find((item) => item.path === worktree);
		if (!branchExists) {
			if (worktreeRecord || fs.existsSync(worktree)) throw new Error(`Plan worktree path exists without its expected branch: ${worktree}`);
			ensureParent(worktree);
			git(this.repoRoot, ["worktree", "add", "-b", branch, worktree, integrationHead]);
		} else if (!worktreeRecord) {
			if (fs.existsSync(worktree)) throw new Error(`Unregistered plan worktree path exists: ${worktree}`);
			ensureParent(worktree);
			git(this.repoRoot, ["worktree", "add", worktree, branch]);
		} else if (worktreeRecord.branch !== branch) {
			throw new Error(`Plan worktree is not attached to ${branch}`);
		}
		const result = materializeAssignment({
			plan: planId,
			planDir: this.planDirectory,
			worktree,
			expectedBranch: branch,
			expectedHead: integrationHead,
			expectedSnapshotSha256: compiled.snapshotSha256,
		}, { entries: [compiled] });
		return {
			branch,
			worktree,
			assignment: {
				bundlePath: String(result.bundlePath),
				bundleSha256: String(result.bundleSha256),
				snapshotSha256: String(result.snapshotSha256),
				generationBase: String(result.generationBase),
			},
		};
	}

	verifyAssignment(worktree: string, bundlePath: string, bundleSha256: string): void {
		verifyAssignment({ worktree, bundle: bundlePath, expectedBundleSha256: bundleSha256 });
	}

	verifyActiveRebase(input: {
		worktree: string;
		branch: string;
		bundlePath: string;
		bundleSha256: string;
		leaseReason: string;
		rebase: ActiveRebaseEvidence;
	}): ActiveRebaseEvidence {
		const options = {
			worktree: input.worktree,
			bundle: input.bundlePath,
			expectedBundleSha256: input.bundleSha256,
			expectedWorktree: fs.realpathSync(input.worktree),
			expectedBranch: input.branch,
			expectedWorkerMode: "GUIDED_REPAIR",
			expectedDetachedHead: input.rebase.detachedHead,
			expectedRebaseOnto: input.rebase.onto,
			expectedRebaseOrigHead: input.rebase.checkpoint,
			expectedPlanHead: input.rebase.checkpoint,
			expectedCheckpointRef: input.rebase.checkpointRef,
			expectedCheckpoint: input.rebase.checkpoint,
			expectedLeaseReason: input.leaseReason,
		};
		const inspected = inspectActiveRebase(options);
		const inspectedSha256 = String(inspected.rebaseStateSha256);
		if (input.rebase.rebaseStateSha256 && input.rebase.rebaseStateSha256 !== inspectedSha256) {
			throw new Error(`Active rebase state changed: expected ${input.rebase.rebaseStateSha256}, found ${inspectedSha256}`);
		}
		const rebaseStateSha256 = input.rebase.rebaseStateSha256 || inspectedSha256;
		verifyActiveRebase({ ...options, verificationMode: "active-rebase", expectedRebaseStateSha256: rebaseStateSha256 });
		return { ...input.rebase, rebaseStateSha256 };
	}

	lease(worktree: string, reason: string): void {
		const current = this.leaseReason(worktree);
		if (current === reason) return;
		if (current) throw new Error(`Worktree is already leased: ${worktree} (${current})`);
		git(this.repoRoot, ["worktree", "lock", "--reason", reason, worktree]);
	}

	release(worktree: string, expectedReason: string): void {
		const current = this.leaseReason(worktree);
		if (!current) return;
		if (current !== expectedReason) throw new Error(`Worktree lease changed: expected ${expectedReason}, found ${current}`);
		git(this.repoRoot, ["worktree", "unlock", worktree]);
	}

	leaseReason(worktree: string): string | null {
		const record = listWorktreeInventory(this.repoRoot).find((item) => item.path === worktree);
		if (!record) throw new Error(`Worktree is not registered: ${worktree}`);
		return record.locked ? record.lockReason : null;
	}

	branchHead(branch: string): string {
		return gitValue(this.repoRoot, "rev-parse", `refs/heads/${branch}`);
	}

	worktreeHead(worktree: string): string {
		return gitValue(worktree, "rev-parse", "HEAD");
	}

	worktreeTree(worktree: string): string {
		return gitValue(worktree, "rev-parse", "HEAD^{tree}");
	}

	worktreeStatus(worktree: string): string {
		return gitValue(worktree, "status", "--porcelain=v1", "--untracked-files=all");
	}

	changedPaths(worktree: string, base: string): string[] {
		return git(worktree, ["diff", "--name-only", "-z", `${base}..HEAD`, "--"]).stdout.split("\0").filter(Boolean).sort();
	}

	private integrationRepairRefPrefixes(): string[] {
		return [
			`refs/heads/herder/${this.planName}/`,
			`refs/plan-herder/${this.planName}/`,
		];
	}

	/** Read every ref owned by this plan set in a canonical order for repair binding. */
	readIntegrationRepairNamespace(): IntegrationRepairNamespaceEvidence {
		const refs: IntegrationRepairRef[] = [];
		const seen = new Set<string>();
		for (const prefix of this.integrationRepairRefPrefixes()) {
			const output = git(this.repoRoot, ["for-each-ref", "--format=%(refname)%09%(objectname)", prefix]).stdout;
			for (const line of output.split(/\r?\n/).filter(Boolean)) {
				const separator = line.indexOf("\t");
				if (separator <= 0 || line.indexOf("\t", separator + 1) !== -1) throw new Error(`Cannot parse integration repair ref record: ${JSON.stringify(line)}`);
				const ref = line.slice(0, separator);
				const target = line.slice(separator + 1);
				if (!ref.startsWith(prefix) || !/^refs\/(?:heads\/herder|plan-herder)\/[^\0\r\n]+$/.test(ref)) {
					throw new Error(`Integration repair ref is outside the owned namespace: ${JSON.stringify(ref)}`);
				}
				if (!/^[0-9a-f]{40,64}$/i.test(target)) throw new Error(`Integration repair ref has an invalid object identity: ${JSON.stringify(line)}`);
				if (seen.has(ref)) throw new Error(`Integration repair namespace contains duplicate ref ${ref}`);
				seen.add(ref);
				refs.push({ ref, target: target.toLowerCase() });
			}
		}
		refs.sort((left, right) => left.ref.localeCompare(right.ref));
		validateIntegrationRepairRefSnapshot(refs);
		const snapshot = stableJson(refs);
		const snapshotSha256 = integrationRepairRefSnapshotSha256(refs);
		return { refs, snapshot, sha256: snapshotSha256 };
	}

	private normalizedIntegrationRepairNamespaceSnapshot(input: string | IntegrationRepairRef[] | IntegrationRepairNamespaceEvidence, expectedSha256: string): IntegrationRepairRef[] {
		const value = typeof input === "string" || Array.isArray(input) ? input : input.refs;
		return normalizeIntegrationRepairRefSnapshotEvidence(value, expectedSha256).refs;
	}

	private assertIntegrationRepairNamespaceContinuity(baseline: IntegrationRepairRef[], current: IntegrationRepairRef[]): void {
		const integrationRef = `refs/heads/${this.integrationBranch}`;
		const baselineIntegration = baseline.find((entry) => entry.ref === integrationRef);
		const currentIntegration = current.find((entry) => entry.ref === integrationRef);
		if (!baselineIntegration || !currentIntegration) throw new Error("Integration repair integration branch ref is missing from the bound namespace");
		const nonIntegration = (entries: IntegrationRepairRef[]) => entries.filter((entry) => entry.ref !== integrationRef);
		if (stableJson(nonIntegration(baseline)) !== stableJson(nonIntegration(current))) {
			throw new Error("Integration repair changed a manager-owned Herder ref since begin");
		}
	}

	validateIntegrationRepairNamespace(input: {
		beginRefSnapshot: string | IntegrationRepairRef[] | IntegrationRepairNamespaceEvidence;
		beginRefSnapshotSha256: string;
		expectedIntegrationHead?: string;
		expectedWorktreeHead?: string;
	}): IntegrationRepairNamespaceEvidence {
		const baseline = this.normalizedIntegrationRepairNamespaceSnapshot(input.beginRefSnapshot, input.beginRefSnapshotSha256);
		const current = this.readIntegrationRepairNamespace();
		this.assertIntegrationRepairNamespaceContinuity(baseline, current.refs);
		if (input.expectedIntegrationHead !== undefined) {
			const integrationRef = `refs/heads/${this.integrationBranch}`;
			const currentIntegration = current.refs.find((entry) => entry.ref === integrationRef);
			if (!currentIntegration || currentIntegration.target !== input.expectedIntegrationHead) {
				throw new Error(`Integration repair integration branch moved: expected ${input.expectedIntegrationHead}`);
			}
		}
		if (input.expectedWorktreeHead !== undefined && this.worktreeHead(this.integrationWorktree) !== input.expectedWorktreeHead) {
			throw new Error(`Integration repair integration worktree moved: expected ${input.expectedWorktreeHead}`);
		}
		return current;
	}

	resetPlanExecution(input: {
		branch: string;
		worktree: string;
		expectedHead: string | null;
		expectedTree: string | null;
		additionalRefs?: PlanTransientRef[];
		cleanupIdentity?: ResetPlanCleanupIdentity;
		recordedCleanup?: ResetPlanCleanupEvidence;
		onPrepare?: (step: ResetPlanCleanupStep) => void;
		onProgress?: (step: ResetPlanCleanupStep) => void;
		onComplete?: (step: ResetPlanCleanupStep) => void;
	}): ResetPlanExecutionResult {
		return resetPlanExecution({
			repoRoot: this.repoRoot,
			worktreeRoot: this.worktreeRoot,
			integrationWorktree: this.integrationWorktree,
			...input,
		});
	}

	hasPlanCompletionProof(planId: string): boolean {
		return git(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/plan-herder/${this.planName}/completed/${planId}`], true).status === 0;
	}

	isAncestor(ancestor: string, descendant: string): boolean {
		return isAncestorProbe(this.repoRoot, ancestor, descendant);
	}

	planTransientRefs(planId: string): PlanTransientRef[] {
		const targetPrefix = new RegExp(`^(?:checkpoints|restacks|completed)/${planId}(?:/|$)`);
		const refs: PlanTransientRef[] = [];
		for (const record of listCoordinationRefs(this.repoRoot, this.planName)) {
			const identity = record.identity;
			if (!identity) {
				if (targetPrefix.test(record.relative)) throw new Error(`Plan ${planId} has an unrecognized manager ref: ${record.ref}`);
				continue;
			}
			if (!("plan" in identity) || identity.plan !== planId) continue;
			if (identity.kind === "completed") throw new Error(`Plan ${planId} still has completion evidence; create a corrective plan instead of reworking it.`);
			if (identity.kind === "checkpoint" || identity.kind === "restack-target") refs.push({ ref: record.ref, target: record.target });
		}
		return refs.sort((left, right) => left.ref.localeCompare(right.ref));
	}

	assertPlanTransientRefs(planId: string, expected: PlanTransientRef[]): void {
		if (stableJson(this.planTransientRefs(planId)) !== stableJson(expected)) {
			throw new Error(`Plan ${planId} transient refs changed after rework began`);
		}
	}

	runVerificationGates(requestId: string, worktree: string, gates: VerificationGate[]): GateResult[] {
		const logDir = path.join(this.planDirectory, ".herder", "logs", "RUN", requestId);
		const gateRunner = path.join(this.helperRoot, "run-gate.ts");
		return gates.map((gate, index) => {
			if (!gate.cwd || path.isAbsolute(gate.cwd)) {
				throw new Error(`Verification gate ${gate.gateId} cwd must be relative to the integration worktree`);
			}
			const canonicalWorktree = fs.realpathSync(worktree);
			const requestedCwd = path.resolve(worktree, gate.cwd);
			if (requestedCwd !== canonicalWorktree && !isInside(canonicalWorktree, requestedCwd, { allowEqual: false })) {
				throw new Error(`Verification gate ${gate.gateId} cwd escapes the integration worktree`);
			}
			const cwd = fs.realpathSync(requestedCwd);
			if (cwd !== canonicalWorktree && !isInside(canonicalWorktree, cwd, { allowEqual: false })) {
				throw new Error(`Verification gate ${gate.gateId} cwd resolves outside the integration worktree`);
			}
			const command = path.basename(gate.argv[0] || "").toLowerCase();
			const needsNpmDependencies = command === "npm" || command === "npm.cmd" || command === "npx" || command === "npx.cmd";
			let preparedModules: string | null = null;
			if (needsNpmDependencies) {
				const manifestPath = path.join(cwd, "package.json");
				if (fs.existsSync(manifestPath)) {
					let manifest: Record<string, unknown>;
					try {
						manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
					} catch (error) {
						throw new Error(`Cannot prepare final verification dependencies from invalid package.json in ${gate.cwd}: ${(error as Error).message}`);
					}
					const declaresDependencies = ["dependencies", "devDependencies", "optionalDependencies"].some((field) => {
						const value = manifest[field];
						return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0);
					});
					const modules = path.join(cwd, "node_modules");
					if (declaresDependencies && !fs.existsSync(modules)) {
						const lockfile = ["npm-shrinkwrap.json", "package-lock.json"].find((candidate) => fs.existsSync(path.join(cwd, candidate)));
						if (!lockfile) throw new Error(`Final verification gate ${gate.gateId} requires npm dependencies, but ${gate.cwd} has no npm lockfile`);
						preparedModules = modules;
						try {
							const installed = runCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
								cwd,
								allowFailure: true,
								maxBuffer: 64 * 1024 * 1024,
							});
							if (installed.status !== 0) {
								throw new Error(`Failed to prepare final verification dependencies for gate ${gate.gateId}: ${compact(installed.stderr || installed.stdout || "npm ci failed")}`);
							}
							if (!fs.existsSync(modules)) throw new Error(`Final verification dependency preparation for gate ${gate.gateId} completed without creating node_modules`);
						} catch (error) {
							fs.rmSync(modules, { recursive: true, force: true });
							throw error;
						}
					}
				}
			}
			try {
				const result = runJson(gateRunner, [
					"--cwd", cwd,
					"--root", worktree,
					"--label", `${String(index + 1).padStart(2, "0")}-${gate.gateId}`,
					"--log-dir", logDir,
					"--timeout-ms", String(gate.timeoutMs ?? 30 * 60 * 1_000),
					"--", ...gate.argv,
				], { allowFailure: true, allowNotOk: true });
				// A runner/setup failure may precede log creation. Never manufacture
				// "undefined" paths or NaN timing as if a check had actually run.
				if (typeof result.logPath !== "string" || !result.logPath
					|| typeof result.logSha256 !== "string" || !/^[0-9a-f]{64}$/.test(result.logSha256)
					|| !Number.isFinite(result.durationMs) || !Number.isSafeInteger(result.logBytes)
					|| Number(result.logBytes) < 0 || !GATE_OUTCOMES.includes(result.outcome as GateOutcome)) {
					throw new Error(`Verification gate ${gate.gateId} runner failed before evidence was finalized: ${String(result.error || result.phase || "invalid gate evidence")}`);
				}
				return {
					gateId: gate.gateId,
					label: gate.label,
					cwd: gate.cwd,
					argv: gate.argv,
					timeoutMs: gate.timeoutMs ?? 30 * 60 * 1_000,
					rationale: gate.rationale,
					command: gate.argv.join(" "),
					ok: Boolean(result.ok),
					outcome: result.outcome as GateOutcome,
					...(typeof result.error === "string" ? { error: result.error } : {}),
					timedOut: Boolean(result.timedOut),
					signal: typeof result.signal === "string" ? result.signal : null,
					exitCode: result.exitCode === null ? null : Number(result.exitCode),
					durationMs: Number(result.durationMs),
					logPath: String(result.logPath),
					logBytes: Number(result.logBytes),
					logSha256: String(result.logSha256),
					logTruncated: Boolean(result.logTruncated),
				};
			} finally {
				if (preparedModules) fs.rmSync(preparedModules, { recursive: true, force: true });
			}
		});
	}

	/**
	 * Validate one session-authored integration repair commit without mutating
	 * the assigned worktree, index, branch, or commit history. Round one must be
	 * a non-empty child of `parent`; later rounds replace the durable current
	 * commit with another non-empty single-parent commit sharing that parent.
	 */
	validateIntegrationRepairCommit(input: {
		worktree?: string;
		branch?: string;
		parent: string;
		round: number;
		currentHead?: string | null;
		replayHead?: string | null;
		/** Previously accepted repair heads that may not be submitted again as replacements. */
		supersededCommits?: string[];
		observedCommit: string;
		allowedPaths?: string[];
		/** Immutable namespace evidence captured by the successful repair begin. */
		beginRefSnapshot?: string | IntegrationRepairRef[] | IntegrationRepairNamespaceEvidence;
		beginRefSnapshotSha256?: string;
	}): IntegrationRepairCommitResult {
		if (Object.prototype.hasOwnProperty.call(input, "commitMessage")) throw new Error("Integration repair commitMessage is not accepted; the owning session must author the commit");
		const worktree = input.worktree ?? this.integrationWorktree;
		const branch = input.branch ?? this.integrationBranch;
		if (branch !== this.integrationBranch) throw new Error(`Integration repair branch must remain ${this.integrationBranch}`);
		if (!fs.existsSync(worktree)) throw new Error(`Integration repair worktree does not exist: ${worktree}`);
		const expectedWorktree = fs.realpathSync(this.integrationWorktree);
		if (fs.realpathSync(worktree) !== expectedWorktree) throw new Error("Integration repair must use the assigned integration worktree");
		const symbolicBranch = gitValue(worktree, "symbolic-ref", "--short", "HEAD");
		if (symbolicBranch !== branch) throw new Error(`Integration repair worktree is not on ${branch}`);
		if (input.round < 1 || input.round > 3 || !Number.isSafeInteger(input.round)) throw new Error("Integration repair round must be between 1 and 3");
		if (input.round > 1 && !input.currentHead) throw new Error("Later integration repair rounds require the durable current commit");
		if (input.round > 2 && (!Array.isArray(input.supersededCommits) || input.supersededCommits.length === 0)) {
			throw new Error("Integration repair superseded commit lineage is required for round three");
		}
		const parent = input.parent.trim().toLowerCase();
		if (!/^[0-9a-f]{40,64}$/.test(parent)) throw new Error("Integration repair parent must be a Git object identity");
		const currentHead = input.currentHead?.trim().toLowerCase() || null;
		const observedCommit = input.observedCommit.trim().toLowerCase();
		let replayHead = input.replayHead?.trim().toLowerCase() || null;
		const supersededCommits = (input.supersededCommits ?? []).map((candidate) => {
			const normalized = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
			if (!/^[0-9a-f]{40,64}$/.test(normalized)) throw new Error("Integration repair superseded commit must be a Git object identity");
			return normalized;
		});
		if (!/^[0-9a-f]{40,64}$/.test(observedCommit)) throw new Error("Integration repair observed commit must be a Git object identity");
		if (currentHead && !/^[0-9a-f]{40,64}$/.test(currentHead)) throw new Error("Integration repair current commit must be a Git object identity");
		if (replayHead && !/^[0-9a-f]{40,64}$/.test(replayHead)) throw new Error("Integration repair replay commit must be a Git object identity");
		if (replayHead && replayHead !== observedCommit) throw new Error("Integration repair replay commit must equal the observed commit");
		if (replayHead && supersededCommits.includes(replayHead)) throw new Error("Integration repair replay commit was previously superseded");
		if (!replayHead && supersededCommits.includes(observedCommit)) throw new Error("Integration repair observed commit was previously superseded");
		const beginRefSnapshot = input.beginRefSnapshot;
		const beginRefSnapshotSha256 = input.beginRefSnapshotSha256;
		if (beginRefSnapshot === undefined || beginRefSnapshotSha256 === undefined) {
			throw new Error("Integration repair begin-ref namespace evidence is required");
		}
		const baselineRefs = this.normalizedIntegrationRepairNamespaceSnapshot(beginRefSnapshot, beginRefSnapshotSha256);
		const currentNamespace = this.readIntegrationRepairNamespace();
		this.assertIntegrationRepairNamespaceContinuity(baselineRefs, currentNamespace.refs);
		const branchBefore = this.branchHead(branch).toLowerCase();
		const worktreeBefore = this.worktreeHead(worktree).toLowerCase();
		const statusBefore = this.worktreeStatus(worktree);
		if (statusBefore) throw new Error("Integration repair worktree must be clean before finish");
		if (branchBefore !== observedCommit || worktreeBefore !== observedCommit) {
			throw new Error(`Integration repair observed commit does not match the clean assigned HEAD: expected ${observedCommit}, found branch ${branchBefore}, worktree ${worktreeBefore}`);
		}
		if (input.round === 1 && currentHead && currentHead !== parent) {
			throw new Error(`Round 1 integration repair must start at parent ${parent}, found durable current ${currentHead}`);
		}
		const expectedCurrent = input.round === 1 ? parent : currentHead!;
		if (!replayHead && observedCommit === expectedCurrent) {
			throw new Error("Integration repair commit must replace the durable current commit");
		}

		const normalizePath = (candidate: string): string => {
			const normalized = candidate.replaceAll("\\\\", "/").replace(/^\.\//, "");
			if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`Integration repair path is not repository-relative: ${candidate}`);
			return normalized;
		};
		const allowedPaths = input.allowedPaths?.map(normalizePath);
		const protectedRoot = normalizePath(path.relative(this.repoRoot, this.planDirectory));
		const validateChangedPaths = (paths: string[]): void => {
			for (const candidate of paths.map(normalizePath)) {
				if (candidate === protectedRoot || candidate.startsWith(`${protectedRoot}/`)) {
					throw new Error(`Integration repair cannot modify protected plan path ${candidate}`);
				}
				if (!allowedPaths || allowedPaths.length === 0) throw new Error("Integration repair requires recorded failure-related paths before accepting a commit");
				if (!allowedPaths.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`))) {
					throw new Error(`Integration repair path ${candidate} is not recorded as failure-related`);
				}
			}
		};
		if (!allowedPaths || allowedPaths.length === 0) throw new Error("Integration repair requires recorded failure-related paths before accepting a commit");
		const parents = gitValue(worktree, "rev-list", "--parents", "-n", "1", observedCommit).split(/\s+/).filter(Boolean).slice(1);
		if (parents.length !== 1) throw new Error("Integration repair commit must be a non-merge commit");
		if (parents[0] !== parent) throw new Error(`Integration repair commit parent changed: expected ${parent}, found ${parents[0]}`);
		if (git(this.repoRoot, ["diff", "--quiet", parent, observedCommit], true).status === 0) throw new Error("Integration repair commit must contain a non-empty diff");
		const changedPaths = this.changedPaths(worktree, parent).filter((candidate) => candidate);
		if (changedPaths.length === 0) throw new Error("Integration repair commit has no changed paths");
		validateChangedPaths(changedPaths);
		const afterNamespace = this.readIntegrationRepairNamespace();
		this.assertIntegrationRepairNamespaceContinuity(baselineRefs, afterNamespace.refs);
		const integrationRef = `refs/heads/${this.integrationBranch}`;
		const afterIntegration = afterNamespace.refs.find((entry) => entry.ref === integrationRef);
		if (!afterIntegration || afterIntegration.target !== observedCommit) throw new Error("Integration repair integration branch is not at the observed repair head");
		return {
			head: observedCommit,
			tree: this.worktreeTree(worktree),
			parent,
			changedPaths,
			supersededHead: input.round > 1 && expectedCurrent !== observedCommit ? expectedCurrent : null,
			committed: false,
		};
	}

	integrate(input: {
		planId: string;
		branch: string;
		worktree: string;
		approvedBase: string;
		approvedHead: string;
		approvedTree: string;
		generation: number;
		checkpointOrdinal: number;
		approval: CompletionApprovalProof;
	}): IntegrationResult {
		let integrationHead = this.branchHead(this.integrationBranch);
		const approvedHead = input.approvedHead;
		const completionRef = `refs/plan-herder/${this.planName}/completed/${input.planId}`;
		const completion = git(this.repoRoot, ["rev-parse", "--verify", "--quiet", completionRef], true).stdout.trim();
		if (completion) {
			const evidence = parseCompletionTag(this.repoRoot, completionRef);
			const expected = completionPayload(input.approval, evidence.object);
			if (stableJson(evidence.payload) !== stableJson(expected)) throw new Error(`Completion approval proof changed for plan ${input.planId}`);
			if (evidence.object !== integrationHead || this.branchHead(input.branch) !== evidence.object
				|| this.worktreeHead(input.worktree) !== evidence.object || this.worktreeStatus(input.worktree)) {
				throw new Error(`Completion evidence for plan ${input.planId} is inconsistent with integration`);
			}
			return { status: "integrated", head: evidence.object };
		}
		if (input.approval.planId !== input.planId || input.approval.generation !== input.generation) {
			throw new Error(`Approval identity does not match plan ${input.planId} generation ${input.generation}`);
		}

		const initialBranchHead = this.branchHead(input.branch);
		const initialWorktreeHead = this.worktreeHead(input.worktree);
		const untouched = initialBranchHead === approvedHead && initialWorktreeHead === approvedHead
			&& this.worktreeTree(input.worktree) === input.approvedTree && !this.worktreeStatus(input.worktree);
		const checkpoint = formatCheckpointRef({
			planName: this.planName,
			plan: input.planId,
			generation: `generation-${input.generation}`,
			ordinal: input.checkpointOrdinal,
		}).ref;
		const restackTargetRef = `refs/plan-herder/${this.planName}/restacks/${input.planId}/generation-${input.generation}-${String(input.checkpointOrdinal).padStart(3, "0")}-onto`;
		let checkpointTarget = git(this.repoRoot, ["rev-parse", "--verify", "--quiet", checkpoint], true).stdout.trim();
		let restackTarget = git(this.repoRoot, ["rev-parse", "--verify", "--quiet", restackTargetRef], true).stdout.trim();

		if (integrationHead === approvedHead && untouched) {
			const payload = completionPayload(input.approval, integrationHead);
			createCompletionTag(this.repoRoot, completionRef, `herder-${this.planName}-${input.planId}-generation-${input.generation}`, payload);
			return { status: "integrated", head: integrationHead };
		}

		if (input.approvedBase === integrationHead && !restackTarget) {
			if (!untouched) throw new Error(`Approved patch changed before integration for ${input.planId}`);
		} else {
			const metadataCandidates = ["rebase-merge", "rebase-apply"]
				.map((name) => gitValue(input.worktree, "rev-parse", "--git-path", name))
				.map((candidate) => path.resolve(input.worktree, candidate));
			const metadataDir = metadataCandidates.find((candidate) => fs.existsSync(candidate));
			if (metadataDir) {
				if (checkpointTarget !== approvedHead) throw new Error(`Active rebase for plan ${input.planId} has no exact reviewed checkpoint`);
				const headName = fs.readFileSync(path.join(metadataDir, "head-name"), "utf8").trim();
				const onto = fs.readFileSync(path.join(metadataDir, "onto"), "utf8").trim();
				const origHead = fs.readFileSync(path.join(metadataDir, "orig-head"), "utf8").trim();
				if (headName !== `refs/heads/${input.branch}` || onto !== integrationHead || origHead !== approvedHead
					|| (restackTarget && restackTarget !== onto)) {
					throw new Error(`Active rebase metadata for plan ${input.planId} does not match its reviewed checkpoint`);
				}
				if (!restackTarget) {
					git(this.repoRoot, ["update-ref", restackTargetRef, onto, ZERO_OID]);
					restackTarget = onto;
				}
				return {
					status: "conflict",
					checkpointRef: checkpoint,
					checkpoint: approvedHead,
					onto,
					detachedHead: this.worktreeHead(input.worktree),
				};
			}

			if (untouched) {
				if (checkpointTarget && checkpointTarget !== approvedHead) throw new Error(`Checkpoint ${checkpoint} moved from ${approvedHead} to ${checkpointTarget}`);
				if (restackTarget && restackTarget !== integrationHead) throw new Error(`Restack target ${restackTargetRef} moved from ${integrationHead} to ${restackTarget}`);
				// Seal both the reviewed state and exact onto target before Herder mutates Git.
				if (!checkpointTarget) {
					git(this.repoRoot, ["update-ref", checkpoint, approvedHead, ZERO_OID]);
					checkpointTarget = approvedHead;
				}
				if (!restackTarget) {
					git(this.repoRoot, ["update-ref", restackTargetRef, integrationHead, ZERO_OID]);
					restackTarget = integrationHead;
				}
				const rebase = git(input.worktree, ["rebase", "--onto", restackTarget, input.approvedBase], true);
				if (rebase.status !== 0) {
					return {
						status: "conflict",
						checkpointRef: checkpoint,
						checkpoint: approvedHead,
						onto: restackTarget,
						detachedHead: this.worktreeHead(input.worktree),
					};
				}
			} else if (checkpointTarget !== approvedHead) {
				// Never create recovery evidence retroactively around an unknown mutation.
				throw new Error(`Approved patch changed before integration for ${input.planId}`);
			}

			const restackedHead = this.worktreeHead(input.worktree);
			const onto = restackTarget || integrationHead;
			if (this.worktreeStatus(input.worktree) || this.branchHead(input.branch) !== restackedHead
				|| git(this.repoRoot, ["merge-base", "--is-ancestor", onto, restackedHead], true).status !== 0
				|| (integrationHead !== onto && integrationHead !== restackedHead)) {
				throw new Error(`Approved patch changed before integration for ${input.planId}`);
			}
			if (!patchEquivalentBothWays(this.repoRoot, onto, restackedHead, input.approvedBase, checkpoint)) {
				throw new Error(`Restacked plan ${input.planId} is not patch-equivalent to its reviewed checkpoint`);
			}
			if (!restackTarget) {
				// A legacy completed restack can prove its current onto before merge; seal
				// it now so a crash after the fast-forward remains unambiguous.
				git(this.repoRoot, ["update-ref", restackTargetRef, onto, ZERO_OID]);
				restackTarget = onto;
			}
		}

		const acceptedHead = this.worktreeHead(input.worktree);
		git(this.integrationWorktree, ["merge", "--ff-only", input.branch]);
		integrationHead = this.branchHead(this.integrationBranch);
		if (integrationHead !== acceptedHead) throw new Error(`Integration head mismatch for plan ${input.planId}`);
		const existingCompletion = git(this.repoRoot, ["rev-parse", "--verify", "--quiet", completionRef], true).stdout.trim();
		if (existingCompletion) {
			const evidence = parseCompletionTag(this.repoRoot, completionRef);
			if (evidence.object !== integrationHead || stableJson(evidence.payload) !== stableJson(completionPayload(input.approval, integrationHead))) {
				throw new Error(`Completion ref for plan ${input.planId} moved`);
			}
		} else {
			const payload = completionPayload(input.approval, integrationHead);
			createCompletionTag(this.repoRoot, completionRef, `herder-${this.planName}-${input.planId}-generation-${input.generation}`, payload);
		}
		return { status: "integrated", head: integrationHead };
	}

}
