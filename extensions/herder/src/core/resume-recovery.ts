import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RunStore, type StoredAction, type StoredRun } from "../daemon/run-store.ts";
import { git, gitValue } from "../daemon/git-driver.ts";
import { listWorktreeInventory } from "../daemon/git/namespace-inventory.ts";
import { allowedWorktreePaths } from "../daemon/git/worktree-locations.ts";
import { sha256, stableJson } from "../shared/protocol.ts";
import { readRunRevision, revisionPending } from "./run-revision.ts";

export interface ResumeRecovery {
	requestId: string;
	runId: string;
	generation: number;
	graphSha256: string;
	amount: number;
	targets: Array<{ actionId: string; planId: string; role: string; worktree: string; head: string; dirtySha256: string; infrastructureRecoveries: number }>;
}

/** Read-only preview. Runtime actions, never authored DONE labels, select the targets. */
export function previewResumeRecovery(store: RunStore): ResumeRecovery | undefined {
	const run = store.getRun();
	if (!run || run.status === "complete" || store.getPlanEdit(run.runId) || revisionPending(readRunRevision(run.planDirectory))) return;
	const attention = store.getAttentionRequests(run.runId, { unresolvedOnly: true });
	const targets: ResumeRecovery["targets"] = [];
	for (const plan of store.getPlans(run.runId)) {
		const actions = store.getActions(run.runId).filter(a => a.planId === plan.planId && a.generation === plan.generation && a.round === plan.round);
		const action = actions.at(-1);
		if (!action || !["IMPLEMENTING", "REVIEWING", "JUDGING", "NEEDS_INPUT", "READY_IMPLEMENTER", "READY_REVIEWER", "READY_JUDGE"].includes(plan.phase)) continue;
		const requests = attention.filter(a => a.planId === plan.planId);
		if (requests.some(a => a.kind !== "operator_attention" || a.cause !== "transport_exhausted" || a.actionId !== action.actionId)) continue;
		const record = action.result as { terminal?: { interrupted?: boolean; error?: string; failureKind?: string } } | null;
		if (action.state !== "dispatched" && !(action.state === "terminal" && !record?.terminal?.failureKind && (record?.terminal?.interrupted || record?.terminal?.error))) continue;
		if (actions.some(a => a.actionId !== action.actionId && ["proposed", "dispatched"].includes(a.state))) throw new Error(`Resume target ${plan.planId} still has another active action`);
		const identity = resumeWorktreeIdentity(run, plan, action);
		targets.push({ actionId: action.actionId, planId: plan.planId, role: action.role, worktree: plan.worktree, ...identity,
			infrastructureRecoveries: action.role === "plan-implementer" ? store.transportRecoveryIncrement(run.runId, plan.planId, action.actionId) : 0 });
	}
	if (!targets.length) return;
	const budget = store.getBudget(run.runId);
	if (!budget) throw new Error("Resume recovery requires recorded effort accounting");
	if (budget.stopReason && budget.stopReason !== "Run execution budget exhausted" && !targets.some(t => t.role === "plan-implementer" && budget.stopReason === `Task ${t.planId} implementation budget exhausted`)) throw new Error(`Resume cannot clear this budget decision: ${budget.stopReason}`);
	return { requestId: "", runId: run.runId, generation: run.currentGeneration, graphSha256: run.graphSha256,
		amount: Math.max(0, targets.length - (budget.limit - budget.used)), targets };
}

export function resumeWorktreeIdentity(run: StoredRun, plan: ReturnType<RunStore["getPlans"]>[number], action: StoredAction) {
	const expectedBranch = plan.planId === "RUN" ? run.integrationBranch : `herder/${run.planName}/${plan.planId}`;
	const relative = plan.planId === "RUN" ? "integration" : plan.planId;
	if (plan.branch !== expectedBranch || !allowedWorktreePaths(run.repositoryRoot, run.planDirectory, run.planName, relative).includes(plan.worktree)
		|| fs.realpathSync(plan.worktree) !== plan.worktree || plan.worktree === run.repositoryRoot) throw new Error(`Resume refuses foreign worktree ${plan.worktree}`);
	const inventory = listWorktreeInventory(run.repositoryRoot);
	const owned = inventory.filter(w => w.path === plan.worktree || w.branch === plan.branch);
	if (owned.length !== 1 || owned[0].path !== plan.worktree || owned[0].branch !== plan.branch || owned[0].detached
		|| (owned[0].locked && (action.state !== "dispatched" || owned[0].lockReason !== action.leaseReason))) throw new Error(`Resume worktree ownership changed: ${plan.planId}`);
	const head = gitValue(plan.worktree, "rev-parse", "HEAD");
	if (gitValue(plan.worktree, "symbolic-ref", "--short", "HEAD") !== plan.branch || gitValue(run.repositoryRoot, "rev-parse", plan.branch) !== head) throw new Error("Resume branch changed");
	if (action.role !== "plan-implementer" && (head !== plan.approvedHead || gitValue(plan.worktree, "rev-parse", "HEAD^{tree}") !== plan.approvedTree)) throw new Error("Resume refuses a mutated frozen Reviewer/Judge commit");
	git(plan.worktree, ["merge-base", "--is-ancestor", plan.generationBase, head]);
	if (gitValue(plan.worktree, "ls-files", "--", ".herder")) throw new Error("Resume refuses tracked manager assignment files");
	// Ignored dependency/setup directories and manager-owned assignments are deliberately retained.
	const untracked = git(plan.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(p => p && !p.startsWith(".herder/"));
	const files = untracked.map(name => {
		const file = path.join(plan.worktree, name), stat = fs.lstatSync(file);
		if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Resume cannot safely clean ${file}`);
		return [name, stat.mode, sha256(stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file))];
	});
	return { head, dirtySha256: sha256(stableJson([gitValue(plan.worktree, "diff", "--binary", "HEAD", "--"), gitValue(plan.worktree, "diff", "--binary", "--cached", "--"), files])) };
}

function grantPath(run: StoredRun, request: ResumeRecovery): string {
	if (!/^[\da-f-]{36}$/.test(request.requestId)) throw new Error("Invalid resume recovery request ID");
	return path.join(run.planDirectory, ".herder", `resume-host-grant-${request.requestId}.json`);
}

/** Called only after command-owned confirmation and worker settlement, never by a model tool. */
export function grantResumeRecovery(run: StoredRun, request: ResumeRecovery): void {
	fs.writeFileSync(grantPath(run, request), stableJson(request), { flag: "wx", mode: 0o600 });
}

export function assertResumeRecoveryGrant(run: StoredRun, request: ResumeRecovery): void {
	if (request.runId !== run.runId || request.generation !== run.currentGeneration || request.graphSha256 !== run.graphSha256) throw new Error("Resume recovery run/generation changed");
	const fd = fs.openSync(grantPath(run, request), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || fs.readFileSync(fd, "utf8") !== stableJson(request)) throw new Error("Resume requires its exact private host confirmation");
	} finally { fs.closeSync(fd); }
}

export function newResumeRecovery(preview: ResumeRecovery): ResumeRecovery { return { ...preview, requestId: randomUUID() }; }
