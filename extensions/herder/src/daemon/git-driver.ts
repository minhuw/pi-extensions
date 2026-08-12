import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { snapshotCheckout } from "./git/checkout-state.ts";
import {
	inspectActiveRebase,
	materializeAssignment,
	verifyActiveRebase,
	verifyAssignment,
} from "./git/assignment-bundle.ts";
import { inspectNamespace } from "./git/namespace-run.ts";
import {
	buildCompletionProofPayload,
	inspectCompletionProof,
	writeCompletionProof,
} from "./git/completion-proof.ts";
import { resetPlanExecution, type ResetPlanCleanupEvidence, type ResetPlanCleanupIdentity, type ResetPlanCleanupStep, type ResetPlanExecutionResult } from "./git/reset-plan.ts";
import type { StoredPlanSpec } from "./run-store.ts";
import { resolveNodeExecutable } from "../shared/node-executable.ts";
import { stableJson, type VerificationGate } from "../shared/protocol.ts";

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
	exitCode: number | null;
	durationMs: number;
	logPath: string;
	logBytes: number;
	logSha256: string;
}

export interface IntegrationResult {
	status: "integrated" | "conflict";
	head?: string;
	checkpointRef?: string;
	checkpoint?: string;
	onto?: string;
	detachedHead?: string;
}

export interface ActiveRebaseEvidence {
	checkpointRef: string;
	checkpoint: string;
	onto: string;
	detachedHead: string;
	rebaseStateSha256?: string;
}

export interface CompletionApprovalProof {
	runId: string;
	planId: string;
	generation: number;
	round: number;
	reviewerActionId: string;
	decisionActionId: string;
	decisionRole: "plan-reviewer" | "plan-judge";
	assignmentSha256: string;
	approvedBase: string;
	approvedHead: string;
	approvedTree: string;
	reviewResultSha256: string;
	decisionResultSha256: string;
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
	return runCommand("git", ["-C", repo, ...args], { allowFailure });
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

function isInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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
		if (!isInside(this.repoRoot, this.planDirectory)) throw new Error(`Plan directory must be inside the repository: ${this.planDirectory}`);
		this.planName = input.planName;
		this.helperRoot = input.helperRoot;
		const externalRoot = path.resolve(`${this.repoRoot}-herder-worktrees`, this.planName);
		this.worktreeRoot = path.resolve(input.worktreeRoot ?? externalRoot);
		if (this.worktreeRoot !== externalRoot) {
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
		await snapshotCheckout({ repo: this.repoRoot, excludes: [this.planDirectory], expect: expected });
	}

	inspectNamespace(mode: "fire" | "resume" | "status") {
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
		const worktreeRecord = git(this.repoRoot, ["worktree", "list", "--porcelain"]).stdout
			.split(/(?:\r?\n){2,}/)
			.find((block) => block.split(/\r?\n/)[0] === `worktree ${this.integrationWorktree}`);
		if (!branchExists) {
			if (worktreeRecord || fs.existsSync(this.integrationWorktree)) throw new Error(`Integration path exists without its expected branch: ${this.integrationWorktree}`);
			ensureParent(this.integrationWorktree);
			git(this.repoRoot, ["worktree", "add", "-b", this.integrationBranch, this.integrationWorktree, baseCommit]);
		} else if (!worktreeRecord) {
			if (fs.existsSync(this.integrationWorktree)) throw new Error(`Unregistered integration path exists: ${this.integrationWorktree}`);
			ensureParent(this.integrationWorktree);
			git(this.repoRoot, ["worktree", "add", this.integrationWorktree, this.integrationBranch]);
		} else if (!worktreeRecord.split(/\r?\n/).includes(`branch ${branchRef}`)) {
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

	ensurePlanWorktree(planId: string, compiled: StoredPlanSpec["assignment"]): { branch: string; worktree: string; assignment: AssignmentEvidence } {
		const branch = `herder/${this.planName}/${planId}`;
		const worktree = path.join(this.worktreeRoot, planId);
		const integrationHead = gitValue(this.repoRoot, "rev-parse", `refs/heads/${this.integrationBranch}`);
		const branchExists = git(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true).status === 0;
		const worktreeRecord = git(this.repoRoot, ["worktree", "list", "--porcelain"]).stdout
			.split(/(?:\r?\n){2,}/)
			.find((block) => block.split(/\r?\n/)[0] === `worktree ${worktree}`);
		if (!branchExists) {
			if (worktreeRecord || fs.existsSync(worktree)) throw new Error(`Plan worktree path exists without its expected branch: ${worktree}`);
			ensureParent(worktree);
			git(this.repoRoot, ["worktree", "add", "-b", branch, worktree, integrationHead]);
		} else if (!worktreeRecord) {
			if (fs.existsSync(worktree)) throw new Error(`Unregistered plan worktree path exists: ${worktree}`);
			ensureParent(worktree);
			git(this.repoRoot, ["worktree", "add", worktree, branch]);
		} else if (!worktreeRecord.split(/\r?\n/).includes(`branch refs/heads/${branch}`)) {
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
		const output = git(this.repoRoot, ["worktree", "list", "--porcelain"]).stdout;
		for (const block of output.split(/(?:\r?\n){2,}/)) {
			const lines = block.split(/\r?\n/);
			if (lines[0] !== `worktree ${worktree}`) continue;
			const lock = lines.find((line) => line === "locked" || line.startsWith("locked "));
			return lock ? lock.slice("locked".length).trim() : null;
		}
		throw new Error(`Worktree is not registered: ${worktree}`);
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

	resetPlanExecution(input: {
		branch: string;
		worktree: string;
		expectedHead: string | null;
		expectedTree: string | null;
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

	runVerificationGates(requestId: string, worktree: string, gates: VerificationGate[]): GateResult[] {
		const logDir = path.join(this.planDirectory, ".herder", "logs", "RUN", requestId);
		const gateRunner = path.join(this.helperRoot, "run-gate.ts");
		return gates.map((gate, index) => {
			if (!gate.cwd || path.isAbsolute(gate.cwd)) {
				throw new Error(`Verification gate ${gate.gateId} cwd must be relative to the integration worktree`);
			}
			const canonicalWorktree = fs.realpathSync(worktree);
			const requestedCwd = path.resolve(worktree, gate.cwd);
			if (requestedCwd !== canonicalWorktree && !isInside(canonicalWorktree, requestedCwd)) {
				throw new Error(`Verification gate ${gate.gateId} cwd escapes the integration worktree`);
			}
			const cwd = fs.realpathSync(requestedCwd);
			if (cwd !== canonicalWorktree && !isInside(canonicalWorktree, cwd)) {
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
				return {
					gateId: gate.gateId,
					label: gate.label,
					cwd: gate.cwd,
					argv: gate.argv,
					timeoutMs: gate.timeoutMs ?? 30 * 60 * 1_000,
					rationale: gate.rationale,
					command: gate.argv.join(" "),
					ok: Boolean(result.ok),
					exitCode: result.exitCode === null ? null : Number(result.exitCode),
					durationMs: Number(result.durationMs),
					logPath: String(result.logPath),
					logBytes: Number(result.logBytes),
					logSha256: String(result.logSha256),
				};
			} finally {
				if (preparedModules) fs.rmSync(preparedModules, { recursive: true, force: true });
			}
		});
	}

	integrate(input: {
		planId: string;
		branch: string;
		worktree: string;
		approvedBase: string;
		approvedHead: string;
		generation: number;
		checkpointOrdinal: number;
		approval: CompletionApprovalProof;
	}): IntegrationResult {
		let integrationHead = this.branchHead(this.integrationBranch);
		let approvedHead = input.approvedHead;
		const completionRef = `refs/plan-herder/${this.planName}/completed/${input.planId}`;
		const completion = git(this.repoRoot, ["rev-parse", "--verify", "--quiet", completionRef], true).stdout.trim();
		if (completion) {
			const evidence = parseCompletionTag(this.repoRoot, completionRef);
			const expected = completionPayload(input.approval, evidence.object);
			if (stableJson(evidence.payload) !== stableJson(expected)) throw new Error(`Completion approval proof changed for plan ${input.planId}`);
			if (evidence.object !== integrationHead || this.branchHead(input.branch) !== evidence.object) {
				throw new Error(`Completion evidence for plan ${input.planId} is inconsistent with integration`);
			}
			return { status: "integrated", head: evidence.object };
		}
		if (input.approval.planId !== input.planId || input.approval.generation !== input.generation) {
			throw new Error(`Approval identity does not match plan ${input.planId} generation ${input.generation}`);
		}
		if (integrationHead === input.approvedHead && this.branchHead(input.branch) === input.approvedHead) {
			const payload = completionPayload(input.approval, integrationHead);
			createCompletionTag(this.repoRoot, completionRef, `herder-${this.planName}-${input.planId}-generation-${input.generation}`, payload);
			return { status: "integrated", head: integrationHead };
		}
		if (input.approvedBase !== integrationHead) {
			const checkpoint = `refs/plan-herder/${this.planName}/checkpoints/${input.planId}/generation-${input.generation}-${String(input.checkpointOrdinal).padStart(3, "0")}`;
			const checkpointTarget = git(this.repoRoot, ["rev-parse", "--verify", "--quiet", checkpoint], true).stdout.trim();
			if (checkpointTarget && checkpointTarget !== approvedHead) throw new Error(`Checkpoint ${checkpoint} moved from ${approvedHead} to ${checkpointTarget}`);
			if (!checkpointTarget) git(this.repoRoot, ["update-ref", checkpoint, approvedHead, ZERO_OID]);
			const metadataCandidates = ["rebase-merge", "rebase-apply"]
				.map((name) => gitValue(input.worktree, "rev-parse", "--git-path", name))
				.map((candidate) => path.resolve(input.worktree, candidate));
			const metadataDir = metadataCandidates.find((candidate) => fs.existsSync(candidate));
			if (metadataDir) {
				const headName = fs.readFileSync(path.join(metadataDir, "head-name"), "utf8").trim();
				const onto = fs.readFileSync(path.join(metadataDir, "onto"), "utf8").trim();
				const origHead = fs.readFileSync(path.join(metadataDir, "orig-head"), "utf8").trim();
				if (headName !== `refs/heads/${input.branch}` || onto !== integrationHead || origHead !== approvedHead) {
					throw new Error(`Active rebase metadata for plan ${input.planId} does not match its reviewed checkpoint`);
				}
				return {
					status: "conflict",
					checkpointRef: checkpoint,
					checkpoint: approvedHead,
					onto: integrationHead,
					detachedHead: this.worktreeHead(input.worktree),
				};
			}
			const branchHead = this.branchHead(input.branch);
			if (branchHead === approvedHead) {
				const rebase = git(input.worktree, ["rebase", "--onto", integrationHead, input.approvedBase], true);
				if (rebase.status !== 0) {
					return {
						status: "conflict",
						checkpointRef: checkpoint,
						checkpoint: approvedHead,
						onto: integrationHead,
						detachedHead: this.worktreeHead(input.worktree),
					};
				}
			} else if (git(this.repoRoot, ["merge-base", "--is-ancestor", integrationHead, branchHead], true).status !== 0) {
				throw new Error(`Plan ${input.planId} branch moved without a valid restack`);
			}
			approvedHead = this.worktreeHead(input.worktree);
			const equivalent = git(this.repoRoot, ["cherry", approvedHead, checkpoint], true);
			if (equivalent.status !== 0 || equivalent.stdout.split(/\r?\n/).filter(Boolean).some((line) => !line.startsWith("-"))) {
				throw new Error(`Restacked plan ${input.planId} is not patch-equivalent to its reviewed checkpoint`);
			}
		}
		git(this.integrationWorktree, ["merge", "--ff-only", input.branch]);
		integrationHead = this.branchHead(this.integrationBranch);
		const head = integrationHead;
		if (head !== approvedHead) throw new Error(`Integration head mismatch for plan ${input.planId}`);
		const existingCompletion = git(this.repoRoot, ["rev-parse", "--verify", "--quiet", completionRef], true).stdout.trim();
		if (existingCompletion) {
			const evidence = parseCompletionTag(this.repoRoot, completionRef);
			if (evidence.object !== head || stableJson(evidence.payload) !== stableJson(completionPayload(input.approval, head))) {
				throw new Error(`Completion ref for plan ${input.planId} moved`);
			}
		} else {
			const payload = completionPayload(input.approval, head);
			createCompletionTag(this.repoRoot, completionRef, `herder-${this.planName}-${input.planId}-generation-${input.generation}`, payload);
		}
		return { status: "integrated", head };
	}
}
