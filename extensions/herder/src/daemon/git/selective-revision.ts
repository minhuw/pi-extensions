import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RunStore, type StoredPlan, type StoredPlanSpec, type StoredRun } from "../run-store.ts";
import { GitDriver, patchEquivalentBothWays, commitPatchIdentity } from "../git-driver.ts";
import { inspectCompletionProof, buildCompletionProofPayload } from "./completion-proof.ts";
import { listCoordinationRefs } from "./coordination-ref.ts";
import { listWorktreeInventory } from "./namespace-inventory.ts";
import { runGit, isAncestor } from "./primitives.ts";
import { sha256, stableJson } from "../../shared/protocol.ts";
import type { ResetPlanCleanupIdentity } from "./reset-plan.ts";

export interface SelectiveRevision {
	version: 1;
	resumed?: boolean;
	published?: boolean;
	sourceGeneration: number;
	nextGeneration: number;
	retainedPlanIds: string[];
	rerunPlanIds: string[];
	removedPlanIds: string[];
	integrationHead: string;
	integrationTree: string;
	previewSha256: string;
	specs: StoredPlanSpec[];
	/** Attribution survives subsequent revisions even after affected completion refs are deleted. */
	knownCommits: string[];
	reverseCommits: string[];
	namespace: Array<{ ref: string; target: string }>;
	worktrees: ReturnType<typeof listWorktreeInventory>;
	artifacts: Array<{ plan: StoredPlan; head: string; tree: string; identity: string; attachment: string; refs: Array<{ ref: string; target: string }> }>;
	retainedWorktrees: Array<{ worktree: string; identity: string; attachment: string; assignmentPath: string; assignmentSha256: string }>;
	integrationIdentity: string;
	integrationAttachment: string;
	publication?: { head: string; tree: string };
}

const git = (repo: string, args: string[]) => runGit(repo, args).stdout.trim();

/** Changes propagate through both dependency graphs, including removed edges. */
export function selectivePlanSets(previous: StoredPlanSpec[], next: StoredPlanSpec[], done: Set<string>) {
	const before = new Map(previous.map(spec => [spec.planId, spec]));
	const after = new Map(next.map(spec => [spec.planId, spec]));
	const invalid = new Set([...before.keys(), ...after.keys()].filter(id => before.get(id)?.planFingerprint !== after.get(id)?.planFingerprint));
	if (!invalid.size) throw new Error("Propose a concrete semantic graph revision; unchanged retry is not allowed");
	for (const id of before.keys()) if (!done.has(id)) invalid.add(id);
	let changed = true;
	while (changed) {
		changed = false;
		for (const spec of [...previous, ...next]) if (!invalid.has(spec.planId) && spec.dependencies.some(id => invalid.has(id))) {
			invalid.add(spec.planId); changed = true;
		}
	}
	return {
		retainedPlanIds: next.filter(spec => !invalid.has(spec.planId) && done.has(spec.planId)).map(spec => spec.planId).sort(),
		rerunPlanIds: next.filter(spec => invalid.has(spec.planId) || !done.has(spec.planId)).map(spec => spec.planId).sort(),
		removedPlanIds: previous.filter(spec => !after.has(spec.planId)).map(spec => spec.planId).sort(),
	};
}

function safePath(candidate: string): void {
	for (let file = path.resolve(candidate); ; file = path.dirname(file)) {
		try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Selective revision refuses symlink artifact: ${file}`); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (path.dirname(file) === file) break;
	}
}
function identity(file: string): string {
	safePath(file);
	const stat = fs.lstatSync(file, { bigint: true });
	if (!stat.isDirectory()) throw new Error(`Selective revision requires a directory: ${file}`);
	return `${stat.dev}:${stat.ino}`;
}
function attachment(file: string): string {
	const candidate = path.join(file, ".git");
	safePath(candidate);
	const stat = fs.lstatSync(candidate, { bigint: true });
	if (!stat.isFile() || stat.nlink !== 1n) throw new Error(`Selective revision refuses replaced attachment: ${candidate}`);
	return `${stat.dev}:${stat.ino}:${sha256(fs.readFileSync(candidate))}`;
}
function linear(repo: string, base: string, head: string): string[] {
	if (!isAncestor(repo, base, head)) throw new Error("Selective revision range is not ancestral");
	const rows = git(repo, ["rev-list", "--reverse", "--parents", `${base}..${head}`]).split("\n").filter(Boolean);
	let parent = base;
	return rows.map(row => {
		const parts = row.split(" ");
		if (parts.length !== 2 || parts[1] !== parent) throw new Error("Selective revision refuses merges or nonlinear integration ranges");
		parent = parts[0]!; return parent;
	});
}

function validateUnfinishedWork(plan: StoredPlan, driver: GitDriver): void {
	if (plan.phase !== "DONE" && (driver.worktreeStatus(plan.worktree)
		|| driver.branchHead(plan.branch) !== plan.generationBase || driver.worktreeHead(plan.worktree) !== plan.generationBase)) {
		throw new Error(`Selective revision refuses cleanup of non-DONE plan ${plan.planId}: dirty or unreviewed committed work exists. Preserve/reconcile this work before amendment; files and refs have not been cleaned up.`);
	}
}

export function prepareSelectiveRevision(run: StoredRun, specs: StoredPlanSpec[], driver: GitDriver, priorKnown: string[] = []): SelectiveRevision {
	const store = new RunStore(run.planDirectory, { readOnly: true });
	try {
		const plans = store.getPlans(run.runId).filter(plan => plan.planId !== "RUN");
		const previous = store.getPlanSpecs(run.runId, run.currentGeneration);
		if (plans.some(plan => !previous.some(spec => spec.planId === plan.planId))) throw new Error("Selective revision refuses runtime without compiled plan ownership");
		const sets = selectivePlanSets(previous, specs, new Set(plans.filter(plan => plan.phase === "DONE").map(plan => plan.planId)));
		const namespace = driver.readIntegrationRepairNamespace().refs;
		const integrationHead = driver.branchHead(run.integrationBranch);
		if (driver.worktreeHead(run.integrationWorktree) !== integrationHead || driver.worktreeStatus(run.integrationWorktree)) throw new Error("Selective revision requires clean, attached integration HEAD");
		const inventory = listWorktreeInventory(run.repositoryRoot);
		const integration = inventory.filter(item => item.branch === run.integrationBranch);
		if (integration.length !== 1 || integration[0]!.path !== run.integrationWorktree || integration[0]!.locked) throw new Error("Selective revision refuses moved or leased integration worktree");
		const refs = listCoordinationRefs(run.repositoryRoot, run.planName);
		if (refs.some(ref => !ref.identity)) throw new Error("Selective revision refuses unknown coordination refs");
		const known = new Set(priorKnown);
		const ranges = new Set<string>();
		const reverse = new Set<string>();
		const retainedApprovedCommits = new Map<string, string[]>();
		for (const plan of plans) {
			const owned = inventory.filter(item => item.branch === plan.branch);
			if (plan.branch !== `herder/${run.planName}/${plan.planId}` || plan.worktree !== path.join(path.dirname(run.integrationWorktree), plan.planId)
				|| owned.length !== 1 || owned[0]!.path !== plan.worktree || owned[0]!.locked) throw new Error(`Selective revision refuses moved/leased plan ${plan.planId}`);
			const ref = `refs/plan-herder/${run.planName}/completed/${plan.planId}`;
			if (plan.phase !== "DONE") {
				validateUnfinishedWork(plan, driver);
				if (namespace.some(item => item.ref === ref)) throw new Error(`Non-DONE plan ${plan.planId} has integrated completion evidence`);
				continue;
			}
			const executionSpec = store.getPlanSpecs(run.runId, plan.generation).find(spec => spec.planId === plan.planId);
			if (!executionSpec || executionSpec.planFingerprint !== previous.find(spec => spec.planId === plan.planId)!.planFingerprint) throw new Error(`Completed plan ${plan.planId} no longer matches its execution assignment`);
			const proof = inspectCompletionProof(run.repositoryRoot, ref);
			const approval = store.getApproval(run.runId, plan.planId, plan.generation);
			if (!proof.ok || !approval || stableJson(proof.payload) !== stableJson(buildCompletionProofPayload({ ...approval, approvalProofSha256: approval.proofSha256, integratedHead: proof.object }))) throw new Error(`Plan ${plan.planId} lacks its valid original completion/approval proof`);
			if (plan.approvedHead !== proof.object || driver.branchHead(plan.branch) !== proof.object || driver.worktreeHead(plan.worktree) !== proof.object || driver.worktreeStatus(plan.worktree) || !isAncestor(run.repositoryRoot, proof.object, integrationHead)) throw new Error(`Completed plan ${plan.planId} Git evidence changed`);
			let base = approval.approvedBase;
			const approvedCommits = linear(run.repositoryRoot, base, approval.approvedHead);
			if (sets.retainedPlanIds.includes(plan.planId)) retainedApprovedCommits.set(plan.planId, approvedCommits);
			if (proof.object !== approval.approvedHead) {
				const candidates = refs.filter(ref => {
					const target = ref.identity;
					return target?.kind === "restack-target" && target.plan === plan.planId && target.generation === `generation-${plan.generation}`
						&& refs.some(checkpoint => checkpoint.identity?.kind === "checkpoint" && checkpoint.identity.plan === plan.planId && checkpoint.identity.generation === target.generation && checkpoint.identity.ordinal === target.ordinal && checkpoint.target === approval.approvedHead);
				});
				if (candidates.length !== 1) throw new Error(`Plan ${plan.planId} has no unambiguous approved restack range`);
				base = candidates[0]!.target;
			}
			const commits = linear(run.repositoryRoot, base, proof.object);
			if (proof.object !== approval.approvedHead && !patchEquivalentBothWays(run.repositoryRoot, base, proof.object, approval.approvedBase, approval.approvedHead)) throw new Error(`Plan ${plan.planId} integrated range is not its approved patch`);
			for (const commit of commits) {
				if (ranges.has(commit)) throw new Error("Selective revision refuses overlapping completion ranges");
				ranges.add(commit); known.add(commit);
				if (!sets.retainedPlanIds.includes(plan.planId)) reverse.add(commit);
			}
		}
		// Restacking may drop approved duplicates already supplied by another plan.
		// Retention must protect the original approval, not just surviving commits.
		const patchIdentity = (commit: string) => {
			const result = commitPatchIdentity(run.repositoryRoot, commit);
			if (!result) throw new Error(`Selective revision cannot identify approved patch ${commit}`);
			return result;
		};
		const reversedPatches = new Set([...reverse].map(patchIdentity).filter(id => id !== "empty"));
		for (const [planId, commits] of retainedApprovedCommits) {
			if (commits.some(commit => reversedPatches.has(patchIdentity(commit)))) throw new Error(`Selective revision refuses reversal of an approved patch required by retained plan ${planId}`);
		}
		const history = linear(run.repositoryRoot, run.baseCommit, integrationHead);
		if (history.some(commit => !known.has(commit)) || [...known].some(commit => !history.includes(commit))) throw new Error("Selective revision refuses unknown integration contributions");
		const artifacts = plans.filter(plan => !sets.retainedPlanIds.includes(plan.planId)).map(plan => {
			const head = driver.branchHead(plan.branch);
			if (driver.worktreeHead(plan.worktree) !== head) throw new Error(`Selective revision plan ${plan.planId} worktree moved`);
			return { plan, head, tree: driver.worktreeTree(plan.worktree), identity: identity(plan.worktree), attachment: attachment(plan.worktree), refs: refs.filter(ref => ref.identity && "plan" in ref.identity && ref.identity.plan === plan.planId).map(({ ref, target }) => ({ ref, target })) };
		});
		const knownPlans = new Set(plans.map(plan => plan.planId));
		if (refs.find(ref => ref.identity?.kind === "base")?.target !== run.baseCommit) throw new Error("Selective revision base coordination identity changed");
		if (refs.some(ref => ref.identity && "plan" in ref.identity && ref.identity.plan !== null && !knownPlans.has(ref.identity.plan))) throw new Error("Selective revision refuses coordination refs without runtime ownership");
		for (const entry of namespace) {
			const branchPrefix = `refs/heads/herder/${run.planName}/`;
			if (entry.ref.startsWith(branchPrefix) && entry.ref !== `refs/heads/${run.integrationBranch}` && !knownPlans.has(entry.ref.slice(branchPrefix.length))) throw new Error("Selective revision refuses unowned plan branches");
		}
		const result: SelectiveRevision = { version: 1, sourceGeneration: run.currentGeneration, nextGeneration: run.currentGeneration + 1, ...sets,
			integrationHead, integrationTree: driver.worktreeTree(run.integrationWorktree), previewSha256: "", specs: specs.map(spec => ({ ...spec, initialStatus: sets.retainedPlanIds.includes(spec.planId) ? "DONE" : "TODO", initialStatusDetail: "" })), knownCommits: history, reverseCommits: history.filter(commit => reverse.has(commit)).reverse(), namespace, worktrees: inventory, artifacts,
			retainedWorktrees: plans.filter(plan => sets.retainedPlanIds.includes(plan.planId)).map(plan => ({ worktree: plan.worktree, identity: identity(plan.worktree), attachment: attachment(plan.worktree), assignmentPath: plan.assignmentPath, assignmentSha256: plan.assignmentSha256 })),
			integrationIdentity: identity(run.integrationWorktree), integrationAttachment: attachment(run.integrationWorktree) };
		result.previewSha256 = selectivePreviewSha256(result);
		return result;
	} finally { store.close(); }
}

export function selectivePreviewSha256(revision: SelectiveRevision): string {
	const { previewSha256: _, publication: __, resumed: ___, published: ____, ...preview } = revision;
	return sha256(stableJson(preview));
}

/** Validate every owned artifact before publication or any deletion, including inode/attachment identity. */
export function validateSelectiveArtifacts(run: StoredRun, revision: SelectiveRevision, driver: GitDriver, store?: RunStore, request?: { requestId: string; requestSha256: string }): void {
	if (selectivePreviewSha256(revision) !== revision.previewSha256) throw new Error("Selective revision preview changed");
	if (identity(run.integrationWorktree) !== revision.integrationIdentity || attachment(run.integrationWorktree) !== revision.integrationAttachment || driver.worktreeStatus(run.integrationWorktree)) throw new Error("Selective revision integration worktree changed");
	const head = driver.branchHead(run.integrationBranch);
	if (!(revision.published ? head === revision.publication?.head : [revision.integrationHead, revision.publication?.head].includes(head)) || driver.worktreeHead(run.integrationWorktree) !== head) throw new Error("Selective revision integration HEAD changed");
	for (const kept of revision.retainedWorktrees) {
		driver.verifyAssignment(kept.worktree, kept.assignmentPath, kept.assignmentSha256);
		if (identity(kept.worktree) !== kept.identity || attachment(kept.worktree) !== kept.attachment || driver.worktreeStatus(kept.worktree)) throw new Error(`Selective revision retained worktree changed: ${kept.worktree}`);
	}
	const expectedWorktrees = [...revision.worktrees];
	const expected = new Map(revision.namespace.map(item => [item.ref, item.target]));
	expected.set(`refs/heads/${run.integrationBranch}`, head);
	for (const artifact of revision.artifacts) {
		const cleanup = store && request ? store.getAttentionCleanupEvidence(cleanupIdentity(run, artifact, request)) : null;
		let exists = false;
		try { fs.lstatSync(artifact.plan.worktree); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (exists) {
			if (cleanup?.step === "branch_deleted" || cleanup?.state === "completed" || identity(artifact.plan.worktree) !== artifact.identity || attachment(artifact.plan.worktree) !== artifact.attachment) throw new Error(`Selective revision found replaced worktree ${artifact.plan.worktree}`);
			validateUnfinishedWork(artifact.plan, driver);
		} else if (!cleanup) throw new Error(`Selective revision worktree disappeared: ${artifact.plan.worktree}`);
		if (!exists) {
			const index = expectedWorktrees.findIndex(item => item.path === artifact.plan.worktree);
			if (index >= 0) expectedWorktrees.splice(index, 1);
		}
		if (cleanup?.step === "branch_deleted") {
			const branch = `refs/heads/${artifact.plan.branch}`;
			const current = driver.readIntegrationRepairNamespace().refs;
			const deleted = [branch, ...artifact.refs.map(ref => ref.ref)];
			const missing = deleted.filter(ref => !current.some(item => item.ref === ref));
			if (missing.length && missing.length !== deleted.length) throw new Error("Selective revision cleanup transaction partially missing");
			if (cleanup.state === "completed" && !missing.length) throw new Error("Selective revision refs reappeared after cleanup");
			if (missing.length) for (const ref of deleted) expected.delete(ref);
		}
	}
	const actualWorktrees = listWorktreeInventory(run.repositoryRoot);
	// HEAD is the only permitted integration inventory change.
	const normalize = (items: typeof actualWorktrees) => items.map(item => item.path === run.integrationWorktree ? { ...item, head } : item);
	if (stableJson(normalize(actualWorktrees)) !== stableJson(normalize(expectedWorktrees))) throw new Error("Selective revision worktree inventory changed");
	const actual = driver.readIntegrationRepairNamespace().refs;
	if (stableJson(actual) !== stableJson([...expected].map(([ref, target]) => ({ ref, target })).sort((a, b) => a.ref.localeCompare(b.ref)))) throw new Error("Selective revision found moved or foreign refs");
	const common = git(run.repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	// for-each-ref omits malformed/dangling loose artifacts; never silently adopt them.
	function validateLooseRefs(relative: string): void {
		const file = path.join(common, relative);
		safePath(file);
		let stat: fs.Stats;
		try { stat = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (stat.isDirectory()) for (const entry of fs.readdirSync(file)) validateLooseRefs(`${relative}/${entry}`);
		else if (!stat.isFile() || !expected.has(relative)) throw new Error(`Selective revision found unknown loose ref artifact: ${relative}`);
	}
	validateLooseRefs(`refs/heads/herder/${run.planName}`);
	validateLooseRefs(`refs/plan-herder/${run.planName}`);
	for (const { ref } of actual) {
		safePath(path.join(common, ref));
		if (runGit(run.repositoryRoot, ["symbolic-ref", "-q", ref], { allowFailure: true }).status === 0) throw new Error(`Selective revision refuses symbolic ref ${ref}`);
	}
}

export function cleanupIdentity(run: StoredRun, artifact: SelectiveRevision["artifacts"][number], request: { requestId: string; requestSha256: string }): ResetPlanCleanupIdentity {
	const plan = artifact.plan;
	return { runId: run.runId, requestId: request.requestId, requestSha256: request.requestSha256, planId: plan.planId, generation: plan.generation, round: plan.round, assignmentPath: plan.assignmentPath, assignmentSha256: plan.assignmentSha256, snapshotSha256: plan.snapshotSha256, generationBase: plan.generationBase, branch: plan.branch, worktree: plan.worktree, expectedHead: artifact.head, expectedTree: artifact.tree };
}

export class SelectiveReversalConflict extends Error {}

/** A private temporary index cannot disturb any checkout; conflicts leave every execution surface intact. */
export function stageSelectiveReversal(run: StoredRun, revision: SelectiveRevision): { head: string; tree: string } {
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "herder-selective-"));
	try {
		const invoke = (args: string[], input?: string): string => {
			const result = spawnSync("git", ["-C", run.repositoryRoot, ...args], { encoding: "utf8", input, env: { ...process.env, GIT_INDEX_FILE: path.join(temporary, "index") }, maxBuffer: 16 * 1024 * 1024 });
			if (result.error || result.status !== 0) {
				const message = `Selective reversal refused (no execution artifacts changed): ${result.error?.message || result.stderr}`;
				// Only an apply failure with actual unmerged index entries grants refinement.
				if (!result.error && result.status === 1 && args[0] === "apply" && invoke(["ls-files", "--unmerged"])) throw new SelectiveReversalConflict(message);
				throw new Error(message);
			}
			return result.stdout.trim();
		};
		invoke(["read-tree", revision.integrationHead]);
		for (const commit of revision.reverseCommits) {
			const patch = runGit(run.repositoryRoot, ["diff", "--binary", `${commit}^`, commit]).stdout;
			if (patch) invoke(["apply", "--cached", "--3way", "--reverse", "--whitespace=nowarn", "-"], patch);
		}
		const tree = invoke(["write-tree"]);
		const head = revision.reverseCommits.length ? invoke(["-c", "user.name=Herder Run Manager", "-c", "user.email=herder@localhost", "commit-tree", tree, "-p", revision.integrationHead], `Herder selective revision generation ${revision.nextGeneration}\nPreview: ${revision.previewSha256}\n`) : revision.integrationHead;
		return { head, tree };
	} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
