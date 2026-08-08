import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideJudge, decideReview } from "../daemon/git/round-policy.ts";
import { compiledAssignmentEntry } from "../daemon/git/assignment-bundle.ts";
import {
	buildGraph,
	projectStatuses,
	snapshotPlanFromGraph,
} from "./plans.ts";
import {
	recordRunConfiguration,
	recordUsageRecord,
} from "../daemon/execution-store.ts";
import {
	GitDriver,
	gitValue,
	runCommand,
	type CompletionApprovalProof,
	type GateResult,
} from "../daemon/git-driver.ts";
import {
	MANAGER_PROTOCOL_VERSION,
	canonicalEventPayload,
	normalizeUsage,
	parseWorkerResult,
	sha256,
	stableJson,
	type DispatchResult,
	type ManagerAction,
	type ManagerReply,
	type ResolvedProfile,
	type TerminalEvent,
	type WorkerResult,
	type WorkerRole,
} from "../shared/protocol.ts";
import {
	RunStore,
	type StoredAction,
	type StoredApproval,
	type StoredPlan,
	type StoredPlanSpec,
	type StoredRun,
} from "../daemon/run-store.ts";
import { resolvePiProfile } from "./profile-registry.ts";
import { lifecycleStatus, phaseForRole, readyPhaseForRole, roleForPhase, summarizeRun } from "./workflow.ts";

const CORE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(CORE_ROOT, "../..");
const HELPER_ROOT = path.join(PLUGIN_ROOT, "src/daemon/git");

interface StartInput {
	mode: "fire" | "resume" | "revise";
	repositoryRoot: string;
	planDirectory: string;
	planName?: string;
	profile?: string;
	maxParallel?: number;
	dashboardUrl?: string;
}

interface EventInput {
	eventId: string;
	kind: "dispatch_results" | "terminals" | "user_input";
	dispatchResults?: DispatchResult[];
	terminals?: TerminalEvent[];
	userInput?: string;
}

function validateStartInput(input: StartInput): void {
	if (!input || !["fire", "resume", "revise"].includes(input.mode)) throw new Error("Start mode must be fire, resume, or revise");
	if (!input.repositoryRoot || !input.planDirectory) throw new Error("Start requires repositoryRoot and planDirectory");
	if (input.maxParallel !== undefined && (!Number.isSafeInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > 32)) {
		throw new Error("maxParallel must be 1 through 32");
	}
}

function validateEventInput(input: EventInput): void {
	if (!input || typeof input.eventId !== "string" || input.eventId.length === 0 || input.eventId.length > 200 || /[\r\n\0]/.test(input.eventId)) {
		throw new Error("Manager eventId must be a non-empty single-line identifier of at most 200 characters");
	}
	if (!["dispatch_results", "terminals", "user_input"].includes(input.kind)) throw new Error(`Unknown manager event kind: ${String(input.kind)}`);
	if (input.kind === "dispatch_results") {
		if (!Array.isArray(input.dispatchResults)) throw new Error("dispatch_results requires an array");
		const seen = new Set<string>();
		for (const result of input.dispatchResults) {
			if (!result || typeof result.actionId !== "string" || typeof result.accepted !== "boolean") throw new Error("Invalid dispatch result");
			if (seen.has(result.actionId)) throw new Error(`Duplicate dispatch result for ${result.actionId}`);
			seen.add(result.actionId);
			if (result.accepted && (typeof result.hostHandle !== "string" || result.hostHandle.length === 0)) throw new Error(`Accepted action ${result.actionId} has no host handle`);
		}
	}
	if (input.kind === "terminals") {
		if (!Array.isArray(input.terminals)) throw new Error("terminals requires an array");
		const seen = new Set<string>();
		for (const terminal of input.terminals) {
			if (!terminal || typeof terminal.actionId !== "string" || terminal.actionId.length === 0) throw new Error("Invalid terminal event");
			if (seen.has(terminal.actionId)) throw new Error(`Duplicate terminal event for ${terminal.actionId}`);
			seen.add(terminal.actionId);
		}
	}
	if (input.kind === "user_input" && (typeof input.userInput !== "string" || input.userInput.trim().length === 0)) {
		throw new Error("user_input requires non-empty text");
	}
}

function resolveProfile(requested?: string): ResolvedProfile {
	return resolvePiProfile(requested);
}

function boundProfile(run: StoredRun, store: RunStore): ResolvedProfile {
	const binding = store.getProfileBinding();
	if (!binding || binding.profile !== run.profileName || binding.profileSha256 !== run.profileSha256 || binding.host !== run.host) {
		throw new Error("SQLite profile binding does not match the manager run");
	}
	return {
		schema_version: 1,
		profile: binding.profile,
		profile_sha256: binding.profileSha256,
		host: binding.host,
		orchestrator: { model: "bound-by-host", effort: "bound-by-host" },
		roles: binding.roles,
	};
}

function safeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function activeActions(store: RunStore, runId: string): StoredAction[] {
	return store.getActions(runId, ["proposed", "dispatched"]);
}

function assignedPlanIds(store: RunStore, runId: string): Set<string> {
	return new Set(activeActions(store, runId).map((action) => action.planId));
}

function workerMode(plan: StoredPlan, role: WorkerRole): ManagerAction["workerMode"] {
	if (plan.planId === "RUN") return "FINAL_AUDIT";
	if (role === "plan-implementer") return plan.round === 1 && plan.repair.length === 0 ? "INITIAL" : "GUIDED_REPAIR";
	if (role === "plan-reviewer") return plan.reviewPass === 0 ? "DISCOVERY" : "VERIFICATION";
	return "ADJUDICATE";
}

function attemptOrdinal(store: RunStore, runId: string, planId: string, role: string): number {
	return store.getActions(runId).filter((action) => action.planId === planId && action.role === role).length + 1;
}

function requiredRole(profile: ResolvedProfile, role: WorkerRole) {
	const mapping = profile.roles[role];
	if (!mapping) throw new Error(`Profile ${profile.profile} has no ${role} mapping`);
	return mapping;
}

function assignmentPrompt(input: {
	run: StoredRun;
	plan: StoredPlan;
	action: StoredAction;
	changedPaths: string[];
}): string {
	const { run, plan, action } = input;
	const repair = plan.repair.length ? plan.repair.join("\n") : "none";
	const findings = plan.findings.length ? plan.findings.join("\n") : "none";
	const gates = plan.gates.length ? JSON.stringify(plan.gates) : "none";
	return [
		"HERDER_MANAGER_WORKER_V1",
		`RUN_ID: ${run.runId}`,
		`ACTION_ID: ${action.actionId}`,
		`ATTEMPT_ID: ${action.attemptId}`,
		`ROLE: ${action.role}`,
		`ROLE_CONTRACT_PATH: ${path.join(PLUGIN_ROOT, "assets", "roles", "contracts", `${action.role}.md`)}`,
		`PLAN: ${plan.planId}`,
		`GENERATION: generation-${plan.generation}`,
		`ROUND: ${plan.round}`,
		`MODE: ${action.workerMode}`,
		`REPOSITORY_WORKTREE: ${plan.worktree}`,
		`EXPECTED_BRANCH: ${plan.branch}`,
		`ASSIGNMENT_BUNDLE: ${plan.assignmentPath}`,
		`ASSIGNMENT_SHA256: ${plan.assignmentSha256}`,
		`GENERATION_BASE: ${plan.generationBase}`,
		`FROZEN_HEAD: ${plan.approvedHead ?? "none"}`,
		`FROZEN_TREE: ${plan.approvedTree ?? "none"}`,
		`CHANGED_PATHS: ${input.changedPaths.length ? input.changedPaths.join(", ") : "none"}`,
		`GATES: ${gates}`,
		"FINDING_LEDGER:",
		findings,
		"REPAIR_CONTRACT:",
		repair,
		"WORKTREE_MODE: The child may inherit the coordinator checkout as its process cwd. Before reading repository files or running Git, change to the exact absolute REPOSITORY_WORKTREE, verify pwd and EXPECTED_BRANCH, and keep every command and edit rooted there. Never inspect or modify the inherited coordinator checkout.",
		...(plan.rebase ? [
			"ACTIVE_REBASE: exact preserved conflicted rebase verified by the Run Manager",
			`REBASE_ONTO: ${plan.rebase.onto}`,
			`CHECKPOINT_REF: ${plan.rebase.checkpointRef}`,
			"Resolve only the existing conflicts, stage the resolution, and complete it with git rebase --continue. Do not attach HEAD, move refs, abort, reset, clean, recreate the worktree, or rematerialize the assignment.",
		] : []),
		"",
		"Act only in the supplied worktree and return the exact envelope required by your installed role contract. Do not update plan lifecycle, integration, SQLite, refs, leases, or another worktree; the deterministic Herder Run Manager owns those operations.",
	].join("\n");
}

function resultOutcome(result: WorkerResult | null, terminal: TerminalEvent): string {
	if (terminal.interrupted) return "INTERRUPTED";
	if (!result) return "FAILED";
	if (result.kind === "implementer") return result.status;
	if (result.kind === "reviewer") return result.verdict;
	return result.decision;
}

function countBlocking(findings: string[]): number {
	return findings.filter((finding) => /\[BLOCKING\]/.test(finding) && /\[(?:P0|P1)\]/.test(finding)).length;
}

function compilePlanSpecs(input: {
	runId: string;
	graphGeneration: number;
	graph: ReturnType<typeof buildGraph>;
	driver: GitDriver;
	previous?: StoredPlanSpec[];
}): { specs: StoredPlanSpec[]; graphSha256: string } {
	const previous = new Map((input.previous ?? []).map((spec) => [spec.planId, spec]));
	const specs = input.graph.plans.map((plan, ordinal) => {
		const snapshot = snapshotPlanFromGraph(input.graph, plan.id);
		const assignment = compiledAssignmentEntry(snapshot);
		const prior = previous.get(plan.id);
		const semantic = {
			planId: plan.id,
			title: plan.title,
			priority: plan.priority,
			effort: plan.effort,
			kind: plan.kind,
			dependencies: plan.dependencies,
			gateCommands: input.driver.extractGateCommands(snapshot.planText),
			planFile: path.basename(plan.file),
			assignment,
		};
		return {
			runId: input.runId,
			graphGeneration: input.graphGeneration,
			planId: plan.id,
			planFingerprint: sha256(stableJson(semantic)),
			ordinal,
			title: plan.title,
			priority: plan.priority,
			effort: plan.effort,
			kind: plan.kind,
			dependencies: plan.dependencies,
			initialStatus: prior?.initialStatus ?? plan.status as StoredPlanSpec["initialStatus"],
			initialStatusDetail: prior?.initialStatusDetail ?? plan.statusDetail,
			gateCommands: semantic.gateCommands,
			planFile: semantic.planFile,
			assignment,
		} satisfies StoredPlanSpec;
	});
	const graphSha256 = sha256(stableJson(specs.map((spec) => ({ planId: spec.planId, fingerprint: spec.planFingerprint }))));
	return { specs, graphSha256 };
}

interface StoredTerminalRecord {
	workerResult: WorkerResult | null;
	usage: ReturnType<typeof normalizeUsage>;
	outcome: string;
	terminal: { interrupted: boolean; error: string | null; hostHandle: string | null };
}

interface TerminalTransition {
	plan: StoredPlan;
	runUpdate?: { status: "needs_input"; terminalDetail: string };
	approval?: Omit<StoredApproval, "createdAt">;
}

function terminalRecord(result: WorkerResult | null, terminal: TerminalEvent, usage: ReturnType<typeof normalizeUsage>): StoredTerminalRecord {
	return {
		workerResult: result,
		usage,
		outcome: resultOutcome(result, terminal),
		terminal: {
			interrupted: Boolean(terminal.interrupted),
			error: terminal.error ?? null,
			hostHandle: terminal.hostHandle ?? null,
		},
	};
}

function storedWorkerResult(action: StoredAction): WorkerResult | null {
	const record = action.result && typeof action.result === "object" && !Array.isArray(action.result)
		? action.result as Record<string, unknown>
		: null;
	const result = record?.workerResult;
	return result && typeof result === "object" && !Array.isArray(result) ? result as WorkerResult : null;
}

function storedTerminalRecord(action: StoredAction): StoredTerminalRecord | null {
	if (!action.result || typeof action.result !== "object" || Array.isArray(action.result)) return null;
	const record = action.result as Partial<StoredTerminalRecord>;
	if (!record.usage || typeof record.outcome !== "string" || !record.terminal) return null;
	return record as StoredTerminalRecord;
}

function approvalCore(input: Omit<StoredApproval, "proofSha256" | "createdAt">) {
	return {
		runId: input.runId,
		planId: input.planId,
		generation: input.generation,
		round: input.round,
		reviewerActionId: input.reviewerActionId,
		decisionActionId: input.decisionActionId,
		decisionRole: input.decisionRole,
		assignmentSha256: input.assignmentSha256,
		approvedBase: input.approvedBase,
		approvedHead: input.approvedHead,
		approvedTree: input.approvedTree,
		reviewResultSha256: input.reviewResultSha256,
		decisionResultSha256: input.decisionResultSha256,
	};
}

function createApproval(input: Omit<StoredApproval, "proofSha256" | "createdAt">): Omit<StoredApproval, "createdAt"> {
	return { ...input, proofSha256: sha256(stableJson(approvalCore(input))) };
}

function completionApproval(approval: StoredApproval): CompletionApprovalProof {
	return {
		...approvalCore(approval),
		approvalProofSha256: approval.proofSha256,
	};
}

function persistLeaks(planDirectory: string, planId: string, leaks: string[]): void {
	if (leaks.length === 0) return;
	const leakDirectory = path.join(planDirectory, "leak");
	fs.mkdirSync(leakDirectory, { recursive: true, mode: 0o700 });
	if (fs.lstatSync(leakDirectory).isSymbolicLink()) throw new Error("Herder leak directory must not be a symlink");
	for (const [index, leak] of leaks.entries()) {
		const findingId = leak.match(/^\[([^\]]+)\]/)?.[1] || `leak-${index + 1}`;
		const title = leak.match(/(?:^|;)\s*title=([^;]+)/i)?.[1] || "deferred-finding";
		const slug = safeName(`${planId}-${findingId}-${title}`).toLowerCase() || `${planId}-leak-${index + 1}`;
		const destination = path.join(leakDirectory, `${slug}.md`);
		const body = `# Deferred finding ${findingId}\n\nSource plan: ${planId}\n\n${leak.trim()}\n`;
		if (fs.existsSync(destination)) {
			if (fs.readFileSync(destination, "utf8") !== body) throw new Error(`Leak record changed for ${destination}`);
			continue;
		}
		fs.writeFileSync(destination, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
	}
}

export class HerderRunManager {
	readonly planDirectory: string;
	readonly store: RunStore;

	constructor(planDirectory: string) {
		this.planDirectory = fs.realpathSync(planDirectory);
		this.store = new RunStore(this.planDirectory);
	}

	close(): void {
		this.store.close();
	}

	private driver(run: StoredRun): GitDriver {
		return new GitDriver({
			repoRoot: run.repositoryRoot,
			planDirectory: run.planDirectory,
			planName: run.planName,
			helperRoot: HELPER_ROOT,
			worktreeRoot: path.dirname(run.integrationWorktree),
		});
	}

	private updatePlan(plan: StoredPlan, changes: Partial<Omit<StoredPlan, "runId" | "planId" | "updatedAt">>): StoredPlan {
		return this.store.putPlan({ ...plan, ...changes });
	}

	private specs(run: StoredRun): StoredPlanSpec[] {
		const specs = this.store.getPlanSpecs(run.runId);
		if (specs.length === 0) throw new Error("Run has no compiled plan specification; start a fresh run with the current Herder version");
		return specs;
	}

	private spec(run: StoredRun, planId: string): StoredPlanSpec {
		const spec = this.specs(run).find((candidate) => candidate.planId === planId);
		if (!spec) throw new Error(`Run specification has no plan ${planId}`);
		return spec;
	}

	private compileCurrentGraph(run: StoredRun, graphGeneration = run.currentGeneration) {
		const graph = buildGraph(this.planDirectory);
		if (!graph.shapeReady) throw new Error("Herder plan graph is not shape-ready");
		if (graph.plans.length === 0) throw new Error("Herder plan graph is empty");
		return { graph, ...compilePlanSpecs({
			runId: run.runId,
			graphGeneration,
			graph,
			driver: this.driver(run),
			previous: this.specs(run),
		}) };
	}

	private graphDrift(run: StoredRun): { changed: boolean; detail: string | null } {
		try {
			const compiled = this.compileCurrentGraph(run);
			return {
				changed: compiled.graphSha256 !== run.graphSha256,
				detail: compiled.graphSha256 === run.graphSha256
					? null
					: `Plan graph changed after generation ${run.currentGeneration}; run Herder revise after active workers finish.`,
			};
		} catch (error) {
			return { changed: true, detail: `Plan graph is currently invalid: ${(error as Error).message}` };
		}
	}

	private projectLifecycle(run: StoredRun): void {
		const plans = this.store.getPlans(run.runId);
		const runtime = new Map(plans.map((plan) => [plan.planId, plan]));
		projectStatuses(this.planDirectory, this.specs(run).map((spec) => {
			const plan = runtime.get(spec.planId) ?? null;
			const status = lifecycleStatus(spec, plan);
			const detail = plan?.phase === "BLOCKED" || plan?.phase === "NEEDS_INPUT"
				? plan.repair[0] || spec.initialStatusDetail
				: status === spec.initialStatus ? spec.initialStatusDetail : "";
			return { id: spec.planId, status, detail };
		}));
	}

	async start(input: StartInput): Promise<ManagerReply> {
		validateStartInput(input);
		const existing = this.store.getRun();
		if (existing) {
			if (input.mode === "fire") throw new Error(`Run ${existing.runId} already exists; use resume`);
			return input.mode === "revise" ? this.revise(input) : this.resume(input);
		}
		if (input.mode !== "fire") throw new Error("No deterministic Herder run is recorded; start a fresh run");
		const profile = resolveProfile(input.profile);
		const planName = input.planName || path.basename(this.planDirectory);
		const driver = new GitDriver({
			repoRoot: input.repositoryRoot,
			planDirectory: this.planDirectory,
			planName,
			helperRoot: HELPER_ROOT,
		});
		const graph = buildGraph(this.planDirectory);
		if (!graph.shapeReady) throw new Error("Herder plan graph is not shape-ready");
		if (graph.plans.length === 0) throw new Error("Herder plan graph is empty");
		const adopted = graph.plans.filter((plan: { status: string }) => ["IN PROGRESS", "DONE"].includes(plan.status));
		if (adopted.length > 0) {
			throw new Error(`Fresh deterministic runs cannot adopt prior execution state: ${adopted.map((plan: { id: string; status: string }) => `${plan.id}=${plan.status}`).join(", ")}`);
		}
		const unsupported = graph.plans.filter((plan: { status: string }) => !["TODO", "BLOCKED", "REJECTED"].includes(plan.status));
		if (unsupported.length > 0) throw new Error(`Unsupported initial lifecycle state: ${unsupported.map((plan: { id: string; status: string }) => `${plan.id}=${plan.status}`).join(", ")}`);
		const checkoutStateToken = await driver.captureCheckout();
		const baseCommit = gitValue(driver.repoRoot, "rev-parse", "HEAD");
		const namespace = driver.inspectNamespace("fire");
		if (!namespace.ok) throw new Error(`Herder namespace is unavailable: ${namespace.reason}`);
		recordRunConfiguration(this.planDirectory, {
			profile: profile.profile,
			profileSha256: profile.profile_sha256,
			host: profile.host,
			roles: profile.roles,
		});
		const runId = randomUUID();
		const graphGeneration = 1;
		const compiled = compilePlanSpecs({ runId, graphGeneration, graph, driver });
		const specs = compiled.specs;
		this.store.transaction(() => {
			this.store.createRun({
				runId,
				repositoryRoot: driver.repoRoot,
				planDirectory: this.planDirectory,
				planName,
				host: "pi",
				profileName: profile.profile,
				profileSha256: profile.profile_sha256,
				maxParallel: input.maxParallel ?? 5,
				currentGeneration: graphGeneration,
				graphSha256: compiled.graphSha256,
				status: "initializing",
				checkoutStateToken,
				baseCommit,
				integrationBranch: driver.integrationBranch,
				integrationWorktree: driver.integrationWorktree,
				dashboardUrl: input.dashboardUrl ?? null,
			});
			this.store.putPlanSpecs(specs);
		});
		try {
			const assignment = driver.initializeFreshNamespace(baseCommit, specs.map((spec) => spec.assignment), graphGeneration);
			this.store.transaction(() => {
				this.store.putGeneration({
					runId,
					generation: graphGeneration,
					graphSha256: compiled.graphSha256,
					parentGeneration: null,
					runAssignmentPath: assignment.bundlePath,
					runAssignmentSha256: assignment.bundleSha256,
					runSnapshotSha256: assignment.snapshotSha256,
				});
				this.store.updateRun({ status: "running", terminalDetail: null });
			});
		} catch (error) {
			this.store.updateRun({ terminalDetail: `Initialization incomplete: ${(error as Error).message}` });
			throw error;
		}
		return this.reconcile(profile);
	}

	async resume(input: StartInput): Promise<ManagerReply> {
		let run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		if (fs.realpathSync(input.repositoryRoot) !== run.repositoryRoot) throw new Error("Resume repository does not match the recorded run");
		if (input.planName && input.planName !== run.planName) throw new Error(`Resume plan name must remain ${run.planName}`);
		this.specs(run);
		const profile = resolveProfile(input.profile || run.profileName);
		if (profile.profile_sha256 !== run.profileSha256 || profile.profile !== run.profileName) {
			throw new Error(`Recorded profile ${run.profileName} no longer matches its immutable binding`);
		}
		if (input.maxParallel !== undefined && input.maxParallel !== run.maxParallel) {
			throw new Error(`Resume must preserve max parallel ${run.maxParallel}; received ${input.maxParallel}`);
		}
		const driver = this.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		const drift = this.graphDrift(run);
		if (drift.changed) throw new Error(`${drift.detail} Use revise instead of resume.`);
		if (run.status === "initializing") {
			const assignment = driver.initializeFreshNamespace(run.baseCommit, this.specs(run).map((spec) => spec.assignment), run.currentGeneration);
			this.store.transaction(() => {
				this.store.putGeneration({
					runId: run!.runId,
					generation: run!.currentGeneration,
					graphSha256: run!.graphSha256,
					parentGeneration: null,
					runAssignmentPath: assignment.bundlePath,
					runAssignmentSha256: assignment.bundleSha256,
					runSnapshotSha256: assignment.snapshotSha256,
				});
				this.store.updateRun({ status: "running", terminalDetail: null });
			});
		} else {
			const namespace = driver.inspectNamespace("resume");
			if (!namespace.ok) throw new Error(`Cannot resume ambiguous Herder namespace: ${namespace.reason}`);
		}
		if (["failed", "stopped", "paused"].includes(run.status)) this.store.updateRun({ status: "running", terminalDetail: null });
		run = this.store.getRun()!;
		return this.reconcile(profile);
	}

	async revise(input: StartInput): Promise<ManagerReply> {
		const run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		if (fs.realpathSync(input.repositoryRoot) !== run.repositoryRoot) throw new Error("Revision repository does not match the recorded run");
		if (input.planName && input.planName !== run.planName) throw new Error(`Revision plan name must remain ${run.planName}`);
		if (input.maxParallel !== undefined && input.maxParallel !== run.maxParallel) {
			throw new Error(`Revision must preserve max parallel ${run.maxParallel}; received ${input.maxParallel}`);
		}
		if (activeActions(this.store, run.runId).length > 0) {
			throw new Error("Plan graph revision requires zero proposed or dispatched workers; wait for terminal events or stop them first");
		}
		const profile = resolveProfile(input.profile || run.profileName);
		if (profile.profile_sha256 !== run.profileSha256 || profile.profile !== run.profileName) {
			throw new Error(`Recorded profile ${run.profileName} no longer matches its immutable binding`);
		}
		const driver = this.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		const nextGeneration = run.currentGeneration + 1;
		const compiled = this.compileCurrentGraph(run, nextGeneration);
		if (compiled.graphSha256 === run.graphSha256) throw new Error(`Plan graph still matches generation ${run.currentGeneration}; use resume`);
		const previous = new Map(this.specs(run).map((spec) => [spec.planId, spec]));
		const next = new Map(compiled.specs.map((spec) => [spec.planId, spec]));
		const removed = [...previous.keys()].filter((planId) => !next.has(planId));
		if (removed.length > 0) throw new Error(`Graph revision cannot remove plans from an existing namespace: ${removed.join(", ")}`);
		for (const spec of compiled.specs) {
			const prior = previous.get(spec.planId);
			if (!prior) {
				const graphPlan = compiled.graph.plans.find((plan) => plan.id === spec.planId)!;
				if (["DONE", "IN PROGRESS"].includes(graphPlan.status)) throw new Error(`New plan ${spec.planId} cannot adopt lifecycle state ${graphPlan.status}`);
				continue;
			}
			if (prior.planFingerprint === spec.planFingerprint) continue;
			const runtime = this.store.getPlan(run.runId, spec.planId);
			if (runtime) {
				throw new Error(`Graph revision changed ${spec.planId} after execution started; create a trusted-base recovery namespace instead`);
			}
		}
		const namespace = driver.inspectNamespace("resume");
		if (!namespace.ok) throw new Error(`Cannot revise ambiguous Herder namespace: ${namespace.reason}`);
		const integrationHead = driver.branchHead(run.integrationBranch);
		const assignment = driver.materializeRunAssignment(integrationHead, compiled.specs.map((spec) => spec.assignment), nextGeneration);
		this.store.transaction(() => {
			this.store.putPlanSpecs(compiled.specs);
			this.store.putGeneration({
				runId: run.runId,
				generation: nextGeneration,
				graphSha256: compiled.graphSha256,
				parentGeneration: run.currentGeneration,
				runAssignmentPath: assignment.bundlePath,
				runAssignmentSha256: assignment.bundleSha256,
				runSnapshotSha256: assignment.snapshotSha256,
			});
			this.store.deletePlan(run.runId, "RUN");
			this.store.updateRun({
				status: "running",
				terminalDetail: `Adopted plan graph generation ${nextGeneration} from generation ${run.currentGeneration}.`,
				currentGeneration: nextGeneration,
				graphSha256: compiled.graphSha256,
			});
		});
		return this.reconcile(profile);
	}

	async event(input: EventInput): Promise<ManagerReply> {
		validateEventInput(input);
		const run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		const canonical = canonicalEventPayload(input);
		const previous = this.store.readEvent(input.eventId);
		if (previous) {
			if (previous.payloadSha256 !== canonical.sha256) throw new Error(`Event ${input.eventId} was replayed with different payload`);
			return this.reply();
		}
		const profile = boundProfile(run, this.store);
		let schedule = true;
		if (input.kind === "dispatch_results") schedule = !(await this.applyDispatchResults(input.dispatchResults ?? []));
		else if (input.kind === "terminals") await this.applyTerminals(input.terminals ?? []);
		else this.applyUserInput(input.userInput!, input.eventId);
		const current = this.store.getRun()!;
		const drift = this.graphDrift(current);
		if (drift.changed) {
			this.store.updateRun({ status: "paused", terminalDetail: drift.detail });
			this.store.recordEvent(run.runId, input.eventId, input.kind, input);
			return this.reply();
		}
		const reply = await this.reconcile(profile, { schedule });
		this.store.recordEvent(run.runId, input.eventId, input.kind, input);
		return reply;
	}

	private async applyDispatchResults(results: DispatchResult[]): Promise<boolean> {
		const run = this.store.getRun()!;
		let capacityRejected = false;
		for (const result of results) {
			const action = this.store.getAction(result.actionId);
			if (!action || action.runId !== run.runId) throw new Error(`Unknown dispatch action ${result.actionId}`);
			if (result.accepted) {
				if (!result.hostHandle) throw new Error(`Accepted action ${result.actionId} has no host handle`);
				this.store.markDispatched(result.actionId, result.hostHandle);
				continue;
			}
			this.store.markCancelled(result.actionId, { error: result.error || "dispatch rejected" });
			const plan = this.store.getPlan(run.runId, action.planId);
			if (plan) this.driver(run).release(plan.worktree, action.leaseReason);
			if (!/capacity|limit|slot|concurr/i.test(result.error || "")) {
				this.store.updateRun({ status: "paused", terminalDetail: `Dispatch rejected for ${action.agentType}: ${result.error || "unknown host error"}` });
			} else if (plan) {
				capacityRejected = true;
				this.updatePlan(plan, { phase: readyPhaseForRole(action.role) });
			}
		}
		if (capacityRejected && this.store.getActions(run.runId, ["dispatched"]).length === 0) {
			this.store.updateRun({ status: "paused", terminalDetail: "Host worker capacity is unavailable; resume when a child slot is free." });
		}
		return capacityRejected;
	}

	private async applyTerminals(terminals: TerminalEvent[]): Promise<void> {
		const run = this.store.getRun()!;
		const driver = this.driver(run);
		for (const terminal of [...terminals].sort((left, right) => left.actionId.localeCompare(right.actionId))) {
			let action = this.store.getAction(terminal.actionId);
			if (!action || action.runId !== run.runId) throw new Error(`Unknown terminal action ${terminal.actionId}`);
			if (action.state === "terminal") {
				const record = storedTerminalRecord(action);
				if (record) this.recordTerminalUsage(run, action, record);
				const completedPlan = this.store.getPlan(run.runId, action.planId);
				if (completedPlan && driver.leaseReason(completedPlan.worktree) === action.leaseReason) driver.release(completedPlan.worktree, action.leaseReason);
				continue;
			}
			if (action.state !== "dispatched") throw new Error(`Action ${terminal.actionId} is not dispatched`);
			if (terminal.hostHandle && action.hostHandle && terminal.hostHandle !== action.hostHandle) {
				throw new Error(`Terminal handle mismatch for ${terminal.actionId}`);
			}
			const plan = this.store.getPlan(run.runId, action.planId);
			if (!plan) throw new Error(`Action ${action.actionId} has no plan runtime record`);
			await driver.verifyCheckout(run.checkoutStateToken);
			if (plan.phase !== phaseForRole(action.role as WorkerRole)) throw new Error(`Action ${action.actionId} does not own plan phase ${plan.phase}`);
			if (plan.generation !== action.generation || plan.round !== action.round) {
				throw new Error(`Action ${action.actionId} does not match plan generation/round`);
			}
			const lease = driver.leaseReason(plan.worktree);
			if (lease !== action.leaseReason) throw new Error(`Lease mismatch for ${action.actionId}`);
			let parsed: WorkerResult | null = null;
			let parseError: string | null = null;
			if (!terminal.interrupted && terminal.response) {
				try { parsed = parseWorkerResult(action.role as WorkerRole, terminal.response); }
				catch (error) { parseError = (error as Error).message; }
			}
			const usage = normalizeUsage(parsed, terminal);
			let transition: TerminalTransition;
			if (terminal.interrupted) {
				const detail = terminal.error || "Worker transport was interrupted";
				transition = action.role === "plan-implementer"
					? this.retryImplementerTransport(run, plan, action, detail)
					: this.retryTransportOrPause(run, plan, action, detail);
			} else if (!parsed) {
				const detail = `Worker result was malformed: ${parseError || terminal.error || "missing response"}`;
				transition = action.role === "plan-implementer"
					? this.retryImplementerTransport(run, plan, action, detail)
					: this.retryTransportOrPause(run, plan, action, detail);
			} else if (parsed.kind === "implementer") transition = this.finishImplementer(run, plan, parsed);
			else if (parsed.kind === "reviewer") transition = this.finishReviewer(run, plan, action, parsed);
			else transition = this.finishJudge(run, plan, action, parsed);
			const record = terminalRecord(parsed, terminal, usage);
			const actionId = action.actionId;
			this.store.transaction(() => {
				action = this.store.markTerminal(actionId, record);
				if (transition.approval) this.store.putApproval(transition.approval);
				this.store.putPlan(transition.plan);
				if (transition.runUpdate) this.store.updateRun(transition.runUpdate);
			});
			this.recordTerminalUsage(run, action, record);
			driver.release(plan.worktree, action.leaseReason);
			await driver.verifyCheckout(run.checkoutStateToken);
		}
	}

	private recordTerminalUsage(run: StoredRun, action: StoredAction, record: StoredTerminalRecord): void {
		const usage = record.usage;
		recordUsageRecord(this.planDirectory, {
			plan: action.planId,
			role: action.role,
			attempt: action.attemptId,
			model: action.model,
			effort: action.effort,
			outcome: record.outcome,
			inputTokens: usage.inputTokens ?? "unknown",
			cachedInputTokens: usage.cachedInputTokens ?? "unknown",
			outputTokens: usage.outputTokens ?? "unknown",
			reasoningTokens: usage.reasoningTokens ?? "unknown",
			source: usage.source,
			round: action.round,
			generation: `generation-${action.generation}`,
			harness: run.host,
			serviceTier: action.serviceTier || undefined,
			startedAt: usage.startedAt,
			finishedAt: usage.finishedAt,
			durationMs: usage.durationMs,
		});
	}

	private retryImplementerTransport(run: StoredRun, plan: StoredPlan, action: StoredAction, detail: string): TerminalTransition {
		const driver = this.driver(run);
		const mutationMayHaveOccurred = driver.worktreeHead(plan.worktree) !== plan.generationBase || Boolean(driver.worktreeStatus(plan.worktree));
		if (!mutationMayHaveOccurred) return this.retryTransportOrPause(run, plan, action, detail);
		if (plan.round >= 6) {
			return { plan: { ...plan, phase: "BLOCKED", repair: [detail] } };
		}
		return { plan: { ...plan, phase: "READY_IMPLEMENTER", round: plan.round + 1, repair: [detail] } };
	}

	private retryTransportOrPause(run: StoredRun, plan: StoredPlan, action: StoredAction, detail: string): TerminalTransition {
		const equivalentAttempts = this.store.getActions(run.runId).filter((candidate) =>
			candidate.planId === action.planId
			&& candidate.generation === action.generation
			&& candidate.round === action.round
			&& candidate.role === action.role
		).length;
		if (equivalentAttempts < 3) {
			return { plan: { ...plan, phase: readyPhaseForRole(action.role), repair: [detail] } };
		}
		const terminalDetail = `${action.role} transport failed ${equivalentAttempts} times for ${action.planId} generation ${action.generation} round ${action.round}: ${detail}`;
		return {
			plan: { ...plan, phase: "NEEDS_INPUT", repair: [terminalDetail] },
			runUpdate: { status: "needs_input", terminalDetail },
		};
	}

	private finishImplementer(run: StoredRun, plan: StoredPlan, result: Extract<WorkerResult, { kind: "implementer" }>): TerminalTransition {
		const driver = this.driver(run);
		let failure: string | null = null;
		if (result.status !== "COMPLETE") failure = result.stoppedBecause || result.notes || `Implementer returned ${result.status}`;
		if (!failure) {
			try { driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256); }
			catch (error) { failure = `Assignment or branch verification failed: ${(error as Error).message}`; }
		}
		if (!failure) {
			const status = driver.worktreeStatus(plan.worktree);
			if (status) failure = `Implementer left a dirty worktree: ${status.split(/\r?\n/).slice(0, 5).join("; ")}`;
		}
		const head = driver.worktreeHead(plan.worktree);
		const reviewBase = plan.rebase?.onto ?? plan.generationBase;
		if (!failure && head === reviewBase) failure = "Implementer produced no commit";
		const changedPaths = failure ? [] : driver.changedPaths(plan.worktree, reviewBase);
		if (!failure && changedPaths.length === 0) failure = "Implementer produced no changed paths";
		let gates: GateResult[] = [];
		if (!failure) {
			gates = driver.runGates(plan.planId, plan.worktree, this.spec(run, plan.planId).gateCommands);
			const failed = gates.find((gate) => !gate.ok);
			if (failed) failure = `Required gate failed: ${failed.command} (log ${failed.logPath})`;
		}
		if (failure) {
			if (plan.round >= 6) {
				return { plan: { ...plan, phase: "BLOCKED", repair: [failure], gates } };
			}
			return { plan: { ...plan, phase: "READY_IMPLEMENTER", round: plan.round + 1, repair: [failure], gates } };
		}
		return { plan: {
			...plan, phase: "READY_REVIEWER", gates, generationBase: reviewBase,
			approvedBase: reviewBase, approvedHead: head, approvedTree: driver.worktreeTree(plan.worktree),
			repair: result.discoveredPaths, rebase: null,
		} };
	}

	private finishReviewer(run: StoredRun, plan: StoredPlan, action: StoredAction, result: Extract<WorkerResult, { kind: "reviewer" }>): TerminalTransition {
		const driver = this.driver(run);
		driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256);
		if (driver.worktreeHead(plan.worktree) !== plan.approvedHead || driver.worktreeTree(plan.worktree) !== plan.approvedTree || driver.worktreeStatus(plan.worktree)) {
			throw new Error(`Reviewer mutated frozen plan ${plan.planId}`);
		}
		const blockers = countBlocking(result.findings);
		const verdict = result.verdict === "REVISE" && blockers === 0 && result.scope === "PASS" ? "APPROVE" : result.verdict;
		if (plan.planId === "RUN") {
			if (verdict === "APPROVE" && result.scope === "PASS" && blockers === 0) {
				return { plan: { ...plan, phase: "FINAL_APPROVED", reviewPass: plan.reviewPass + 1, findings: result.findings } };
			}
			const detail = result.rationale || result.findings[0] || "Final cross-plan audit did not approve";
			return {
				plan: { ...plan, phase: "NEEDS_INPUT", reviewPass: plan.reviewPass + 1, findings: result.findings, repair: [detail] },
				runUpdate: { status: "needs_input", terminalDetail: detail },
			};
		}
		const decision = decideReview({ round: plan.round, verdict, scope: result.scope, openBlockers: blockers });
		const reviewed = { ...plan, reviewPass: plan.reviewPass + 1, findings: result.findings };
		if (decision.action === "READY_TO_INTEGRATE") {
			if (!plan.approvedBase || !plan.approvedHead || !plan.approvedTree) throw new Error(`Reviewer approval has no frozen patch for ${plan.planId}`);
			const resultSha256 = sha256(stableJson(result));
			const approval = createApproval({
				runId: run.runId, planId: plan.planId, generation: plan.generation, round: plan.round,
				reviewerActionId: action.actionId, decisionActionId: action.actionId, decisionRole: "plan-reviewer",
				assignmentSha256: plan.assignmentSha256, approvedBase: plan.approvedBase,
				approvedHead: plan.approvedHead, approvedTree: plan.approvedTree,
				reviewResultSha256: resultSha256, decisionResultSha256: resultSha256,
			});
			return { plan: { ...reviewed, phase: "READY_TO_INTEGRATE", repair: [] }, approval };
		} else if (decision.action === "REPAIR_DIRECT") {
			return { plan: { ...reviewed, phase: "READY_IMPLEMENTER", round: decision.nextRound!, repair: result.fixGuidance } };
		} else if (decision.action === "JUDGE") {
			return { plan: { ...reviewed, phase: "READY_JUDGE", repair: result.fixGuidance } };
		}
		return { plan: { ...reviewed, phase: "BLOCKED" } };
	}

	private finishJudge(run: StoredRun, plan: StoredPlan, action: StoredAction, result: Extract<WorkerResult, { kind: "judge" }>): TerminalTransition {
		const driver = this.driver(run);
		driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256);
		if (driver.worktreeHead(plan.worktree) !== plan.approvedHead || driver.worktreeTree(plan.worktree) !== plan.approvedTree || driver.worktreeStatus(plan.worktree)) {
			throw new Error(`Judge mutated frozen plan ${plan.planId}`);
		}
		persistLeaks(this.planDirectory, plan.planId, result.leaks);
		const decision = decideJudge({ round: plan.round, decision: result.decision });
		if (decision.action === "READY_TO_INTEGRATE") {
			if (!plan.approvedBase || !plan.approvedHead || !plan.approvedTree) throw new Error(`Judge approval has no frozen patch for ${plan.planId}`);
			const reviewer = this.store.getActions(run.runId).filter((candidate) =>
				candidate.planId === plan.planId && candidate.generation === plan.generation
				&& candidate.round === plan.round && candidate.role === "plan-reviewer" && candidate.state === "terminal"
			).at(-1);
			const reviewResult = reviewer ? storedWorkerResult(reviewer) : null;
			if (!reviewer || !reviewResult || reviewResult.kind !== "reviewer") throw new Error(`Judge cannot approve ${plan.planId} without a terminal Reviewer result`);
			const approval = createApproval({
				runId: run.runId, planId: plan.planId, generation: plan.generation, round: plan.round,
				reviewerActionId: reviewer.actionId, decisionActionId: action.actionId, decisionRole: "plan-judge",
				assignmentSha256: plan.assignmentSha256, approvedBase: plan.approvedBase,
				approvedHead: plan.approvedHead, approvedTree: plan.approvedTree,
				reviewResultSha256: sha256(stableJson(reviewResult)), decisionResultSha256: sha256(stableJson(result)),
			});
			return { plan: { ...plan, phase: "READY_TO_INTEGRATE", findings: result.findings, repair: [] }, approval };
		} else if (decision.action === "REPAIR_GUIDED") {
			return { plan: { ...plan, phase: "READY_IMPLEMENTER", round: decision.nextRound!, findings: result.findings, repair: result.repairContracts } };
		} else if (decision.action === "NEEDS_INPUT") {
			const terminalDetail = result.question || result.rationale;
			return {
				plan: { ...plan, phase: "NEEDS_INPUT", findings: result.findings, repair: result.question ? [result.question] : [] },
				runUpdate: { status: "needs_input", terminalDetail },
			};
		}
		return { plan: { ...plan, phase: "BLOCKED", findings: result.findings } };
	}

	private applyUserInput(value: string, eventId: string): void {
		const run = this.store.getRun()!;
		const marker = `USER_INPUT [${eventId}]: ${value}`;
		if (run.status !== "needs_input") {
			if (this.store.getPlans(run.runId).some((plan) => plan.repair.includes(marker))) return;
			throw new Error("Run is not waiting for user input");
		}
		const plan = this.store.getPlans(run.runId).find((candidate) => candidate.phase === "NEEDS_INPUT");
		if (!plan) throw new Error("No plan is waiting for user input");
		this.updatePlan(plan, {
			phase: plan.planId === "RUN" ? "READY_REVIEWER" : "READY_JUDGE",
			repair: [...plan.repair, marker],
		});
		this.store.updateRun({ status: "running", terminalDetail: null });
	}

	private validateApproval(run: StoredRun, plan: StoredPlan, approval: StoredApproval): CompletionApprovalProof {
		if (approval.runId !== run.runId || approval.planId !== plan.planId || approval.generation !== plan.generation || approval.round !== plan.round) {
			throw new Error(`Approval identity does not match ${plan.planId} generation ${plan.generation} round ${plan.round}`);
		}
		if (approval.assignmentSha256 !== plan.assignmentSha256
			|| approval.approvedBase !== plan.approvedBase
			|| approval.approvedHead !== plan.approvedHead
			|| approval.approvedTree !== plan.approvedTree) {
			throw new Error(`Approval patch binding does not match plan ${plan.planId}`);
		}
		if (sha256(stableJson(approvalCore(approval))) !== approval.proofSha256) throw new Error(`Approval proof hash changed for ${plan.planId}`);
		const reviewer = this.store.getAction(approval.reviewerActionId);
		const decision = this.store.getAction(approval.decisionActionId);
		if (!reviewer || reviewer.runId !== run.runId || reviewer.planId !== plan.planId
			|| reviewer.generation !== plan.generation || reviewer.round !== plan.round
			|| reviewer.role !== "plan-reviewer" || reviewer.state !== "terminal") {
			throw new Error(`Approval for ${plan.planId} lacks its exact terminal Reviewer action`);
		}
		if (!decision || decision.runId !== run.runId || decision.planId !== plan.planId
			|| decision.generation !== plan.generation || decision.round !== plan.round
			|| decision.role !== approval.decisionRole || decision.state !== "terminal") {
			throw new Error(`Approval for ${plan.planId} lacks its exact terminal decision action`);
		}
		const reviewerResult = storedWorkerResult(reviewer);
		const decisionResult = storedWorkerResult(decision);
		if (!reviewerResult || reviewerResult.kind !== "reviewer"
			|| sha256(stableJson(reviewerResult)) !== approval.reviewResultSha256) {
			throw new Error(`Reviewer result proof changed for ${plan.planId}`);
		}
		if (!decisionResult || sha256(stableJson(decisionResult)) !== approval.decisionResultSha256) {
			throw new Error(`Decision result proof changed for ${plan.planId}`);
		}
		if (approval.decisionRole === "plan-reviewer" && (decision.actionId !== reviewer.actionId || decisionResult.kind !== "reviewer")) {
			throw new Error(`Direct Reviewer approval is inconsistent for ${plan.planId}`);
		}
		if (approval.decisionRole === "plan-judge" && decisionResult.kind !== "judge") {
			throw new Error(`Judge approval is inconsistent for ${plan.planId}`);
		}
		return completionApproval(approval);
	}

	private recoverTerminalSideEffects(run: StoredRun, driver: GitDriver): void {
		for (const action of this.store.getActions(run.runId, ["terminal"])) {
			const record = storedTerminalRecord(action);
			if (!record) throw new Error(`Terminal action ${action.actionId} has no durable result envelope`);
			this.recordTerminalUsage(run, action, record);
			const plan = this.store.getPlan(run.runId, action.planId);
			if (!plan) continue;
			const lease = driver.leaseReason(plan.worktree);
			if (lease === action.leaseReason) driver.release(plan.worktree, action.leaseReason);
		}
	}

	private async reconcile(profile: ResolvedProfile, options: { schedule?: boolean } = {}): Promise<ManagerReply> {
		let run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		if (run.status !== "running") return this.reply();
		const driver = this.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		this.recoverTerminalSideEffects(run, driver);

		for (const plan of this.store.getPlans(run.runId).filter((candidate) => candidate.phase === "READY_TO_INTEGRATE").sort((a, b) => a.planId.localeCompare(b.planId))) {
			if (!plan.approvedBase || !plan.approvedHead || !plan.approvedTree) throw new Error(`Plan ${plan.planId} has no approved integration surface`);
			const approval = this.store.getApproval(run.runId, plan.planId, plan.generation);
			if (!approval) throw new Error(`Plan ${plan.planId} has no durable approval proof`);
			const completionProof = this.validateApproval(run, plan, approval);
			driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256);
			if (driver.worktreeHead(plan.worktree) !== plan.approvedHead
				|| driver.worktreeTree(plan.worktree) !== plan.approvedTree
				|| driver.worktreeStatus(plan.worktree)) {
				throw new Error(`Approved patch changed before integration for ${plan.planId}`);
			}
			if (driver.leaseReason(plan.worktree)) throw new Error(`Approved plan ${plan.planId} is still leased`);
			const integration = driver.integrate({
				planId: plan.planId,
				branch: plan.branch,
				worktree: plan.worktree,
				approvedBase: plan.approvedBase,
				approvedHead: plan.approvedHead,
				generation: plan.generation,
				checkpointOrdinal: plan.reviewPass || 1,
				gateCommands: this.spec(run, plan.planId).gateCommands,
				approval: completionProof,
			});
			if (integration.status === "conflict") {
				if (plan.round >= 6) {
					this.updatePlan(plan, { phase: "BLOCKED" });
				} else {
					if (!integration.checkpointRef || !integration.checkpoint || !integration.onto || !integration.detachedHead) {
						throw new Error(`Restack conflict for ${plan.planId} lacks sealed recovery evidence`);
					}
					this.updatePlan(plan, {
						phase: "READY_IMPLEMENTER",
						round: plan.round + 1,
						repair: [`Preserved conflicted rebase: checkpoint=${integration.checkpointRef}; onto=${integration.onto}; detached=${integration.detachedHead}`],
						rebase: {
							checkpointRef: integration.checkpointRef,
							checkpoint: integration.checkpoint,
							onto: integration.onto,
							detachedHead: integration.detachedHead,
						},
					});
				}
				break;
			}
			this.updatePlan(plan, { phase: "DONE", approvedHead: integration.head!, approvedTree: gitValue(plan.worktree, "rev-parse", "HEAD^{tree}"), rebase: null });
		}

		run = this.store.getRun()!;
		if (run.status !== "running") return this.reply();
		const current = this.store.getPlans(run.runId);
		const overview = summarizeRun(this.specs(run), current);
		if (overview.complete && activeActions(this.store, run.runId).length === 0) {
			const finalPlan = current.find((plan) => plan.planId === "RUN");
			if (finalPlan?.phase === "FINAL_APPROVED") {
				this.store.updateRun({ status: "complete", terminalDetail: "All plans integrated and final audit approved." });
				return this.reply();
			}
			if (!finalPlan) {
				const finalGates = this.specs(run).flatMap((spec) => driver.runGates(spec.planId, run.integrationWorktree, spec.gateCommands));
				const failedGate = finalGates.find((gate) => !gate.ok);
				if (failedGate) {
					this.store.updateRun({ status: "failed", terminalDetail: `Final integration gate failed: ${failedGate.command} (log ${failedGate.logPath})` });
					return this.reply();
				}
				const generation = this.store.getGeneration(run.runId, run.currentGeneration);
				if (!generation) throw new Error(`Run generation ${run.currentGeneration} has no assignment evidence`);
				const assignmentPath = generation.runAssignmentPath;
				const bytes = fs.readFileSync(assignmentPath);
				if (sha256(bytes) !== generation.runAssignmentSha256) throw new Error(`Run assignment changed for generation ${run.currentGeneration}`);
				const assignment = JSON.parse(bytes.toString("utf8")) as { snapshotSha256: string; assignment: { generationBase: string } };
				this.store.putPlan({
					runId: run.runId,
					planId: "RUN",
					generation: run.currentGeneration,
					round: 1,
					phase: "READY_REVIEWER",
					branch: run.integrationBranch,
					worktree: run.integrationWorktree,
					assignmentPath,
					assignmentSha256: sha256(bytes),
					snapshotSha256: assignment.snapshotSha256,
					generationBase: assignment.assignment.generationBase,
					reviewPass: 0,
					findings: [],
					repair: [],
					gates: finalGates,
					approvedBase: run.baseCommit,
					approvedHead: driver.branchHead(run.integrationBranch),
					approvedTree: gitValue(run.integrationWorktree, "rev-parse", "HEAD^{tree}"),
					rebase: null,
				});
			}
		}

		if (options.schedule !== false) {
			await this.schedule(profile);
			const scheduler = this.schedulerState(this.store.getRun()!);
			if (!scheduler.workConserving) {
				this.store.updateRun({ status: "paused", terminalDetail: `Scheduler stall: ${scheduler.freeSlots} free slot(s) and runnable plans ${scheduler.runnablePlanIds.join(", ")} produced no action.` });
			}
		}
		const settled = summarizeRun(this.specs(run), this.store.getPlans(run.runId));
		if (activeActions(this.store, run.runId).length === 0 && settled.blocked.length > 0 && settled.ready.length === 0) {
			this.store.updateRun({ status: "failed", terminalDetail: `Blocked plans require recovery: ${settled.blocked.join(", ")}` });
		}
		await driver.verifyCheckout(run.checkoutStateToken);
		this.projectLifecycle(run);
		return this.reply(options.schedule === false ? "host-backpressure" : undefined);
	}

	async auditScheduler(): Promise<ManagerReply> {
		const run = this.store.getRun();
		if (!run || run.status !== "running") return this.reply();
		return this.reconcile(boundProfile(run, this.store));
	}

	private async schedule(profile: ResolvedProfile): Promise<void> {
		const run = this.store.getRun()!;
		const driver = this.driver(run);
		let occupied = activeActions(this.store, run.runId).length;
		const owned = assignedPlanIds(this.store, run.runId);
		const plans = this.store.getPlans(run.runId);
		for (const plan of plans.sort((a, b) => a.planId.localeCompare(b.planId))) {
			if (occupied >= run.maxParallel) break;
			if (owned.has(plan.planId)) continue;
			const role = roleForPhase(plan.phase);
			if (!role) continue;
			this.createAction(run, plan, role, profile, driver);
			occupied += 1;
			owned.add(plan.planId);
		}

		if (occupied >= run.maxParallel) return;
		const overview = summarizeRun(this.specs(run), this.store.getPlans(run.runId));
		for (const spec of overview.ready) {
			if (occupied >= run.maxParallel) break;
			const planId = spec.planId;
			if (this.store.getPlan(run.runId, planId)) continue;
			const execution = driver.ensurePlanWorktree(planId, spec.assignment);
			const plan = this.store.putPlan({
				runId: run.runId,
				planId,
				generation: spec.graphGeneration,
				round: 1,
				phase: "READY_IMPLEMENTER",
				branch: execution.branch,
				worktree: execution.worktree,
				assignmentPath: execution.assignment.bundlePath,
				assignmentSha256: execution.assignment.bundleSha256,
				snapshotSha256: execution.assignment.snapshotSha256,
				generationBase: execution.assignment.generationBase,
				reviewPass: 0,
				findings: [],
				repair: [],
				gates: [],
				approvedBase: null,
				approvedHead: null,
				approvedTree: null,
				rebase: null,
			});
			this.createAction(run, plan, "plan-implementer", profile, driver);
			occupied += 1;
		}
	}

	private createAction(run: StoredRun, plan: StoredPlan, role: WorkerRole, profile: ResolvedProfile, driver: GitDriver): StoredAction {
		const mapping = requiredRole(profile, role);
		const ordinal = attemptOrdinal(this.store, run.runId, plan.planId, role);
		const attemptId = `${plan.planId}-g${plan.generation}-r${plan.round}-${role.replace("plan-", "")}-${ordinal}`;
		const actionId = `${run.runId}:${attemptId}`;
		const taskName = safeName(`herder-${plan.planId}-${role.replace("plan-", "")}-r${plan.round}-${ordinal}`);
		const leaseReason = `plan-herder:${run.planName}:${plan.planId}:${role}:${attemptId}:${taskName}`;
		if (plan.rebase && role !== "plan-implementer") throw new Error(`Only an Implementer may own active rebase recovery for ${plan.planId}`);
		if (!plan.rebase) driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256);
		driver.lease(plan.worktree, leaseReason);
		if (plan.rebase) {
			try {
				const rebase = driver.verifyActiveRebase({
					worktree: plan.worktree,
					branch: plan.branch,
					bundlePath: plan.assignmentPath,
					bundleSha256: plan.assignmentSha256,
					leaseReason,
					rebase: plan.rebase,
				});
				plan = this.updatePlan(plan, { rebase });
			} catch (error) {
				driver.release(plan.worktree, leaseReason);
				throw error;
			}
		}
		const mode = workerMode(plan, role);
		const action: ManagerAction = {
			actionId,
			attemptId,
			runId: run.runId,
			planId: plan.planId,
			generation: plan.generation,
			round: plan.round,
			role,
			agentType: mapping.agent_type,
			model: mapping.model,
			effort: mapping.effort,
			...(mapping.service_tier ? { serviceTier: mapping.service_tier } : {}),
			workerMode: mode,
			taskName,
			worktree: plan.worktree,
			branch: plan.branch,
			assignmentPath: plan.assignmentPath,
			assignmentSha256: plan.assignmentSha256,
			leaseReason,
			prompt: "",
		};
		let stored!: StoredAction;
		this.store.transaction(() => {
			stored = this.store.putAction(action);
			this.updatePlan(plan, { phase: phaseForRole(role) });
		});
		return stored;
	}

	private managerAction(run: StoredRun, stored: StoredAction): ManagerAction {
		const plan = this.store.getPlan(run.runId, stored.planId);
		if (!plan) throw new Error(`Action ${stored.actionId} has no plan runtime`);
		const changedPaths = plan.planId === "RUN" || plan.rebase ? [] : this.driver(run).changedPaths(plan.worktree, plan.generationBase);
		const action: ManagerAction = {
			actionId: stored.actionId,
			attemptId: stored.attemptId,
			runId: stored.runId,
			planId: stored.planId,
			generation: stored.generation,
			round: stored.round,
			role: stored.role as WorkerRole,
			agentType: stored.agentType,
			model: stored.model,
			effort: stored.effort,
			...(stored.serviceTier ? { serviceTier: stored.serviceTier } : {}),
			workerMode: stored.workerMode as ManagerAction["workerMode"],
			taskName: stored.taskName,
			worktree: plan.worktree,
			branch: plan.branch,
			assignmentPath: plan.assignmentPath,
			assignmentSha256: plan.assignmentSha256,
			leaseReason: stored.leaseReason,
			prompt: "",
		};
		action.prompt = assignmentPrompt({ run, plan, action: stored, changedPaths });
		return action;
	}

	private schedulerState(run: StoredRun, suppression?: "host-backpressure"): ManagerReply["scheduler"] {
		const active = activeActions(this.store, run.runId);
		const owned = new Set(active.map((action) => action.planId));
		const plans = this.store.getPlans(run.runId);
		const runtimeIds = new Set(plans.map((plan) => plan.planId));
		const runnablePlanIds = [
			...plans.filter((plan) => !owned.has(plan.planId) && roleForPhase(plan.phase)).map((plan) => plan.planId),
			...summarizeRun(this.specs(run), plans).ready.filter((spec) => !runtimeIds.has(spec.planId)).map((spec) => spec.planId),
		].sort();
		const freeSlots = Math.max(0, run.maxParallel - active.length);
		const expectedNewActions = Math.min(freeSlots, runnablePlanIds.length);
		const inactive = run.status !== "running";
		const workConserving = inactive || suppression === "host-backpressure" || expectedNewActions === 0;
		const reason = inactive ? "inactive"
			: suppression === "host-backpressure" ? "host-backpressure"
				: freeSlots === 0 ? "saturated"
					: runnablePlanIds.length === 0 ? "no-runnable-work"
						: "scheduler-stall";
		return { active: active.length, freeSlots, runnable: runnablePlanIds.length, runnablePlanIds, expectedNewActions, workConserving, reason, checkedAt: new Date().toISOString() };
	}

	reply(suppression?: "host-backpressure"): ManagerReply {
		let run = this.store.getRun();
		if (!run) return {
			protocolVersion: MANAGER_PROTOCOL_VERSION,
			runId: "",
			status: "idle",
			maxParallel: 0,
			planDirectory: this.planDirectory,
			actions: [],
			active: [],
			summary: { total: 0, done: 0, rejected: 0, inProgress: 0, available: 0 },
			scheduler: { active: 0, freeSlots: 0, runnable: 0, runnablePlanIds: [], expectedNewActions: 0, workConserving: true, reason: "inactive", checkedAt: new Date().toISOString() },
			message: "No Herder run has started.",
		};
		if (run.status === "running") {
			const drift = this.graphDrift(run);
			if (drift.changed) run = this.store.updateRun({ status: "paused", terminalDetail: drift.detail });
		}
		const overview = summarizeRun(this.specs(run), this.store.getPlans(run.runId));
		const proposed = this.store.getActions(run.runId, ["proposed"]);
		const active = this.store.getActions(run.runId, ["proposed", "dispatched"]);
		const questionPlan = this.store.getPlans(run.runId).find((plan) => plan.phase === "NEEDS_INPUT");
		const scheduler = this.schedulerState(run, suppression);
		return {
			protocolVersion: MANAGER_PROTOCOL_VERSION,
			runId: run.runId,
			status: run.status,
			maxParallel: run.maxParallel,
			planDirectory: run.planDirectory,
			...(run.dashboardUrl ? { dashboardUrl: run.dashboardUrl } : {}),
			actions: proposed.map((action) => this.managerAction(run, action)),
			active: active.map((action) => ({
				actionId: action.actionId,
				planId: action.planId,
				role: action.role,
				...(action.hostHandle ? { hostHandle: action.hostHandle } : {}),
			})),
			summary: {
				total: overview.total,
				done: overview.done,
				rejected: overview.rejected,
				inProgress: overview.inProgress,
				available: Math.max(0, run.maxParallel - active.length),
			},
			scheduler,
			message: run.terminalDetail || `${overview.done}/${overview.total} plans done; ${active.length} worker actions active.`,
			...(questionPlan?.repair[0] ? { question: questionPlan.repair[0] } : {}),
		};
	}

	stop(): ManagerReply {
		const run = this.store.getRun();
		if (!run) return this.reply();
		this.store.updateRun({ status: "stopped", terminalDetail: "Stop requested; repository and worker evidence preserved." });
		return this.reply();
	}
}

export type { EventInput, StartInput };
