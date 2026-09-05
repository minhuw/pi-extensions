import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideJudge, decideReview } from "../daemon/git/round-policy.ts";
import { buildGraph, projectStatuses } from "./plans.ts";
import { compileGraphIdentity, compilePlanSpecs } from "./plan-identity.ts";
import {
	captureReworkSnapshot,
	crashReworkForTest,
	deleteReworkSnapshotBestEffort,
	graphInputSha256,
	pruneReworkSnapshots,
	readReworkSnapshot,
	readReworkSnapshotFile,
	restoreReworkSnapshot,
	reworkSnapshotPath,
	validateReworkGraphFiles,
	type ReworkGraphSnapshot,
} from "./plan-edit.ts";
import { recordRunConfiguration } from "../daemon/execution-store.ts";
import {
	GitDriver,
	gitValue,
	runCommand,
	type CompletionApprovalProof,
	type GateResult,
} from "../daemon/git-driver.ts";
import {
	ATTENTION_PATH_LIMIT,
	MAIN_SESSION_VERIFICATION_PAUSE_DETAIL,
	MANAGER_PROTOCOL_VERSION,
	MAX_PLAN_ROUNDS,
	attentionCapabilityToken,
	attentionRequestSha256,
	canonicalEventPayload,
	isTerminalRunStatus,
	normalizeUsage,
	parseWorkerResult,
	sha256,
	stableJson,
	validateAttentionResolution,
	type AttentionCause,
	type AttentionGitIdentity,
	type AttentionRecoveryEvidence,
	type AttentionRequestInput,
	type AttentionResolutionAction,
	type AttentionResolutionInput,
	type ManagerAttentionRequest,
	type IntegrationRepairInput,
	type DispatchResult,
	type ManagerAction,
	type ManagerReply,
	type ResolvedProfile,
	type TerminalEvent,
	type ReigniteRequest,
	type VerificationManifest,
	type WorkerResult,
	type WorkerRole,
} from "../shared/protocol.ts";
import {
	PLAN_EDIT_EVENT_PREFIX,
	RunStore,
	type StoredAction,
	type StoredApproval,
	type StoredPlan,
	type StoredPlanEdit,
	type StoredPlanSpec,
	type StoredRun,
	type StoredVerification,
} from "../daemon/run-store.ts";
import { resolvePiProfile } from "./profile-registry.ts";
import {
	integrationRepairForVerification,
	integrationRepairRequest,
	isProvableInitialRepair,
	recordIntegrationRepairVerificationOutcome,
	repairBeginRefSnapshot,
	runIntegrationRepair,
	validateDurableRepairSuccessor,
	validateRepairSuccessorManifest,
} from "./integration-repair.ts";
import { lifecycleStatus, phaseForRole, readyPhaseForRole, readPlanLifecycle, roleForPhase, summarizeRun } from "./workflow.ts";
import {
	createReigniteRequest,
	createVerificationRequest,
	normalizeVerificationManifest,
} from "./verification.ts";

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

interface ReigniteInput {
	requestId: string;
	requestSha256: string;
	state: "written" | "failed";
	graphSha256?: string;
	detail?: string;
}

type EventInput =
	| {
		eventId: string;
		kind: "dispatch_results";
		dispatchResults: DispatchResult[];
		terminals?: never;
		userInput?: never;
		attentionRequestId?: never;
		attention?: never;
	}
	| {
		eventId: string;
		kind: "terminals";
		terminals: TerminalEvent[];
		dispatchResults?: never;
		userInput?: never;
		attentionRequestId?: never;
		attention?: never;
	}
	| {
		eventId: string;
		kind: "user_input";
		userInput: string;
		attentionRequestId: string;
		dispatchResults?: never;
		terminals?: never;
		attention?: never;
	}
	| {
		eventId: string;
		kind: "attention";
		attention: AttentionResolutionInput;
		dispatchResults?: never;
		terminals?: never;
		userInput?: never;
		attentionRequestId?: never;
	};

interface PlanEditInput {
	operation: "begin" | "prepare" | "confirm" | "finish" | "cancel";
	planId?: string;
	editToken?: string;
	intent?: "rework";
}

interface PlanEditReply {
	edit: {
		planId: string;
		state: StoredPlanEdit["state"];
		editToken?: string;
	};
	reply: ManagerReply;
}

function validateStartInput(input: StartInput): void {
	if (!input || !["fire", "resume", "revise"].includes(input.mode)) throw new Error("Start mode must be fire, resume, or revise");
	if (!input.repositoryRoot || !input.planDirectory) throw new Error("Start requires repositoryRoot and planDirectory");
	if (input.maxParallel !== undefined && (!Number.isSafeInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > 32)) {
		throw new Error("maxParallel must be 1 through 32");
	}
}

type EventPayloadKey = "dispatchResults" | "terminals" | "userInput" | "attentionRequestId" | "attention";

function rejectEventInputKeys(input: EventInput, keys: readonly EventPayloadKey[]): void {
	for (const key of keys) {
		if (Object.hasOwn(input, key)) throw new Error(`Manager event ${key} is not valid for ${input.kind} events`);
	}
}

function validateEventInput(input: EventInput): void {
	if (!input || typeof input.eventId !== "string" || input.eventId.length === 0 || input.eventId.length > 200 || /[\r\n\0]/.test(input.eventId)) {
		throw new Error("Manager eventId must be a non-empty single-line identifier of at most 200 characters");
	}
	if (input.eventId.startsWith("manager-attention-resolution:") || input.eventId.startsWith("manager-attention-cleanup:") || input.eventId.startsWith("attention-cleanup:") || input.eventId.startsWith(PLAN_EDIT_EVENT_PREFIX)) {
		throw new Error("Manager private evidence event IDs are private");
	}
	switch (input.kind) {
		case "dispatch_results": {
			rejectEventInputKeys(input, ["terminals", "userInput", "attentionRequestId", "attention"]);
			if (!Array.isArray(input.dispatchResults)) throw new Error("dispatch_results requires an array");
			const seen = new Set<string>();
			for (const result of input.dispatchResults) {
				if (!result || typeof result.actionId !== "string" || typeof result.accepted !== "boolean") throw new Error("Invalid dispatch result");
				if (seen.has(result.actionId)) throw new Error(`Duplicate dispatch result for ${result.actionId}`);
				seen.add(result.actionId);
				if (result.accepted && (typeof result.hostHandle !== "string" || result.hostHandle.length === 0)) throw new Error(`Accepted action ${result.actionId} has no host handle`);
			}
			return;
		}
		case "terminals": {
			rejectEventInputKeys(input, ["dispatchResults", "userInput", "attentionRequestId", "attention"]);
			if (!Array.isArray(input.terminals)) throw new Error("terminals requires an array");
			const seen = new Set<string>();
			for (const terminal of input.terminals) {
				if (!terminal || typeof terminal.actionId !== "string" || terminal.actionId.length === 0) throw new Error("Invalid terminal event");
				if (seen.has(terminal.actionId)) throw new Error(`Duplicate terminal event for ${terminal.actionId}`);
				seen.add(terminal.actionId);
			}
			return;
		}
		case "user_input": {
			rejectEventInputKeys(input, ["dispatchResults", "terminals", "attention"]);
			if (typeof input.userInput !== "string" || input.userInput.trim().length === 0) {
				throw new Error("user_input requires non-empty text");
			}
			if (!input.attentionRequestId) throw new Error("user_input requires attentionRequestId");
			if (typeof input.attentionRequestId !== "string" || input.attentionRequestId.length === 0 || input.attentionRequestId.length > 200 || /[\0\r\n]/.test(input.attentionRequestId)) {
				throw new Error("attentionRequestId must be a bounded single-line identifier");
			}
			return;
		}
		case "attention":
			rejectEventInputKeys(input, ["dispatchResults", "terminals", "userInput", "attentionRequestId"]);
			if (!input.attention) throw new Error("attention requires a resolution payload");
			validateAttentionResolution(input.attention);
			return;
		default:
			throw new Error(`Unknown manager event kind: ${String((input as { kind?: unknown }).kind)}`);
	}
}

function normalizePlanId(value: string | undefined): string {
	const normalized = String(value ?? "").trim();
	const match = path.basename(normalized).match(/^(\d+)(?:-|\.|$)/);
	if (!match) throw new Error("Plan edit requires a numeric plan ID or NNN-*.md plan path");
	return match[1]!.padStart(3, "0");
}

function validatePlanEditInput(input: PlanEditInput): void {
	if (!input || !["begin", "prepare", "confirm", "finish", "cancel"].includes(input.operation)) throw new Error("Plan edit operation must be begin, prepare, confirm, finish, or cancel");
	if (input.intent !== undefined && input.intent !== "rework") throw new Error("Plan edit intent must be rework when provided");
	if (input.intent === "rework" && input.operation !== "begin") throw new Error("Plan rework intent is only valid when beginning a reservation");
	if (input.operation === "begin") {
		normalizePlanId(input.planId);
		if (input.intent === "rework" && (typeof input.editToken !== "string" || !/^[0-9a-f-]{36}$/i.test(input.editToken))) throw new Error("Plan rework begin requires an edit token");
		if (input.editToken !== undefined && (typeof input.editToken !== "string" || !/^[0-9a-f-]{36}$/i.test(input.editToken))) throw new Error("Plan edit token is invalid");
	} else if (typeof input.editToken !== "string" || !/^[0-9a-f-]{36}$/i.test(input.editToken)) throw new Error("Plan edit token is required");
}

function normalizeAttentionAction(value: string): AttentionResolutionAction {
	const normalized = value.trim().toLowerCase().replace(/[- ]+/g, "_");
	const aliases: Record<string, AttentionResolutionAction> = {
		answer: "answer",
		defer: "defer",
		retry: "retry",
		cancel: "cancel",
		unchanged: "unchanged_retry",
		unchanged_retry: "unchanged_retry",
		retry_unchanged: "unchanged_retry",
		revise: "revise",
		replace: "revise",
		accept: "accept",
		stop: "stop",
		reject: "reject",
		reject_revision: "reject",
	};
	const action = aliases[normalized];
	if (!action) throw new Error(`Unsupported attention resolution action: ${value}`);
	return action;
}

function sameStringArray(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRecoveryGraphIdentity(left: StoredPlanSpec, right: StoredPlanSpec): boolean {
	return left.planId === right.planId
		&& left.ordinal === right.ordinal
		&& left.planFile === right.planFile
		&& sameStringArray(left.dependencies, right.dependencies)
		&& left.assignment.plan.id === right.assignment.plan.id
		&& sameStringArray(left.assignment.plan.dependencies, right.assignment.plan.dependencies);
}

function sameRecoverySpecIdentity(left: StoredPlanSpec, right: StoredPlanSpec): boolean {
	return sameRecoveryGraphIdentity(left, right)
		&& left.planFingerprint === right.planFingerprint
		&& left.fingerprintVersion === right.fingerprintVersion
		&& stableJson(left.assignment) === stableJson(right.assignment);
}

function validateTargetOnlyGraph(
	priorSpecs: StoredPlanSpec[],
	nextSpecs: StoredPlanSpec[],
	targetPlanId: string,
	graphLabel: string,
	targetLabel: string,
): { prior: StoredPlanSpec; target: StoredPlanSpec } {
	const prior = priorSpecs.find((spec) => spec.planId === targetPlanId);
	if (!prior) throw new Error(`${targetLabel} ${targetPlanId} has no recorded specification`);
	const current = new Map(priorSpecs.map((spec) => [spec.planId, spec]));
	const next = new Map(nextSpecs.map((spec) => [spec.planId, spec]));
	if (current.size !== next.size || [...current.keys()].some((planId) => !next.has(planId))) {
		throw new Error(`${graphLabel} cannot change the plan graph topology`);
	}
	const target = next.get(targetPlanId);
	if (!target) throw new Error(`${targetLabel} ${targetPlanId} is missing from the revised graph`);
	for (const oldSpec of priorSpecs) {
		const newSpec = next.get(oldSpec.planId)!;
		if (oldSpec.planId === targetPlanId) {
			if (!sameRecoveryGraphIdentity(oldSpec, newSpec)) {
				throw new Error(`${targetLabel} ${targetPlanId} cannot change its identity, filename, or dependencies`);
			}
			continue;
		}
		if (!sameRecoveryGraphIdentity(oldSpec, newSpec) || oldSpec.planFingerprint !== newSpec.planFingerprint) {
			throw new Error(`${graphLabel} changed sibling plan ${oldSpec.planId}`);
		}
	}
	return { prior, target };
}

function recoveryIdentityFromRequest(request: ManagerAttentionRequest): AttentionGitIdentity | null {
	if (request.kind !== "plan_recovery") return null;
	return {
		assignmentPath: request.recovery.assignmentPath,
		assignmentSha256: request.recovery.assignmentSha256,
		snapshotSha256: request.recovery.snapshotSha256,
		generationBase: request.recovery.generationBase,
		branch: request.recovery.branch,
		worktree: request.recovery.worktree,
		worktreeHead: request.recovery.worktreeHead,
		worktreeTree: request.recovery.worktreeTree,
	};
}

function sameRecoveryIdentity(left: AttentionGitIdentity, right: AttentionGitIdentity): boolean {
	return left.assignmentPath === right.assignmentPath
		&& left.assignmentSha256 === right.assignmentSha256
		&& left.snapshotSha256 === right.snapshotSha256
		&& left.generationBase === right.generationBase
		&& left.branch === right.branch
		&& left.worktree === right.worktree
		&& left.worktreeHead === right.worktreeHead
		&& left.worktreeTree === right.worktreeTree;
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
		orchestrator: { model: "bound-by-host", effort: "bound-by-host" as ResolvedProfile["orchestrator"]["effort"] },
		roles: binding.roles as ResolvedProfile["roles"],
	};
}

function safeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function activeActions(store: RunStore, runId: string): StoredAction[] {
	return store.getActions(runId, ["proposed", "dispatched"]);
}

function activeActionCount(store: RunStore, runId: string): number {
	return store.countActions(runId, { states: ["proposed", "dispatched"] });
}

function workerMode(plan: StoredPlan, role: WorkerRole): ManagerAction["workerMode"] {
	if (plan.planId === "RUN") return "FINAL_AUDIT";
	if (role === "plan-implementer" && plan.round === MAX_PLAN_ROUNDS) return "RESCUE";
	if (role === "plan-implementer") return plan.round === 1 && plan.repair.length === 0 ? "INITIAL" : "GUIDED_REPAIR";
	if (role === "plan-reviewer") return plan.reviewPass === 0 ? "DISCOVERY" : "VERIFICATION";
	return "ADJUDICATE";
}

function attemptOrdinal(store: RunStore, runId: string, planId: string, generation: number, role: string): number {
	return store.countActions(runId, { planId, generation, role }) + 1;
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
	evidence: string;
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
		...(action.role === "plan-reviewer" ? [
			`REVIEW_PROTOCOL_PATH: ${path.join(PLUGIN_ROOT, "assets", "review", "code-review-protocol.md")}`,
		] : []),
		`PLAN: ${plan.planId}`,
		`GENERATION: generation-${plan.generation}`,
		`ROUND: ${plan.round}`,
		`MAX_ROUNDS: ${MAX_PLAN_ROUNDS}`,
		`REMAINING_IMPLEMENTATION_ROUNDS: ${Math.max(0, MAX_PLAN_ROUNDS - plan.round)}`,
		`REVIEW_PASS: ${plan.reviewPass + (action.role === "plan-reviewer" ? 1 : 0)}`,
		`MODE: ${action.workerMode}`,
		`REPOSITORY_WORKTREE: ${plan.worktree}`,
		`EXPECTED_BRANCH: ${plan.branch}`,
		`ASSIGNMENT_BUNDLE: ${plan.assignmentPath}`,
		`ASSIGNMENT_SHA256: ${plan.assignmentSha256}`,
		`GENERATION_BASE: ${plan.generationBase}`,
		`FROZEN_HEAD: ${plan.approvedHead ?? "none"}`,
		`FROZEN_TREE: ${plan.approvedTree ?? "none"}`,
		`CHANGED_PATHS: ${input.changedPaths.length ? input.changedPaths.join(", ") : "none"}`,
		`VERIFICATION_EVIDENCE: ${gates}`,
		"FINDING_LEDGER:",
		findings,
		"REPAIR_CONTRACT:",
		repair,
		"SCOPE_AUTHORITY: The immutable original assignment for this generation is the sole scope authority. History, repair guidance, and PASS_DOCUMENT are evidence and acceptance guidance, never a waiver or a replacement assignment.",
		input.evidence,
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

function isActionableReigniteFinding(finding: string): boolean {
	return /\[PLAN_REQUIREMENT\]/.test(finding) || /\[PATCH_REGRESSION\]/.test(finding);
}

const REIGNITE_DIRECTORY_PATTERN = /^(?:herder-reignite|herder-reignite-[2-9]|herder-reignite-[1-9]\d+)$/;
const REIGNITE_RESERVATION_FILE = path.join(".herder", "reignite.reservation");

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

function lstatIfPresent(target: string): fs.Stats | null {
	try {
		return fs.lstatSync(target);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}

function isRealDirectory(stats: fs.Stats | null): stats is fs.Stats {
	return Boolean(stats && stats.isDirectory() && !stats.isSymbolicLink());
}

function repoRootReignitePath(repositoryRoot: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(repositoryRoot), path.resolve(candidate));
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && REIGNITE_DIRECTORY_PATTERN.test(relative);
}

function reigniteDirectoryHasLiveRun(directory: string): boolean {
	const executionDb = path.join(directory, ".herder", "execution.sqlite3");
	if (!fs.existsSync(executionDb)) return false;
	try {
		const store = new RunStore(directory, { readOnly: true });
		try {
			const run = store.getRun();
			return Boolean(run && !isTerminalRunStatus(run.status));
		} finally {
			store.close();
		}
	} catch {
		return true;
	}
}

function reigniteReservationPath(directory: string): string {
	return path.join(directory, REIGNITE_RESERVATION_FILE);
}

function readReigniteReservation(directory: string): string | null {
	const reservation = lstatIfPresent(reigniteReservationPath(directory));
	if (!reservation || reservation.isSymbolicLink() || !reservation.isFile()) return null;
	try {
		return fs.readFileSync(reigniteReservationPath(directory), "utf8").trim();
	} catch {
		return null;
	}
}

function writeReigniteReservation(directory: string, token: string): boolean {
	const existing = readReigniteReservation(directory);
	if (existing === token) return true;
	if (existing) return false;
	const runtimeDirectory = path.join(directory, ".herder");
	if (!lstatIfPresent(runtimeDirectory)) {
		try {
			fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
	}
	if (!isRealDirectory(lstatIfPresent(runtimeDirectory))) return false;
	try {
		fs.writeFileSync(reigniteReservationPath(directory), `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return readReigniteReservation(directory) === token;
		throw error;
	}
}

function tryReserveReigniteDirectory(directory: string, token: string): boolean {
	let stats = lstatIfPresent(directory);
	if (!stats) {
		try {
			fs.mkdirSync(directory);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		stats = lstatIfPresent(directory);
	}
	if (!isRealDirectory(stats)) return false;
	if (lstatIfPresent(path.join(directory, "README.md"))) return false;
	if (reigniteDirectoryHasLiveRun(directory)) return false;
	return writeReigniteReservation(directory, token);
}

export function allocateUnusedReigniteDirectory(repositoryRoot: string, sourcePlanDirectory: string, reservationToken: string): string {
	const root = path.resolve(repositoryRoot);
	const source = path.resolve(sourcePlanDirectory);
	const token = String(reservationToken || "").trim();
	if (!token || token.length > 400 || /[\0\r\n]/.test(token)) {
		throw new Error("Reignite allocation requires a bounded reservation token");
	}
	for (let index = 1; index <= 10_000; index += 1) {
		const candidate = path.join(root, index === 1 ? "herder-reignite" : `herder-reignite-${index}`);
		if (path.resolve(candidate) === source) continue;
		if (tryReserveReigniteDirectory(candidate, token)) return candidate;
	}
	throw new Error("Could not allocate an unused herder-reignite directory");
}

interface StoredTerminalRecord {
	workerResult: WorkerResult | null;
	usage: ReturnType<typeof normalizeUsage>;
	outcome: string;
	terminal: { interrupted: boolean; error: string | null; hostHandle: string | null };
}

interface TerminalTransition {
	plan: StoredPlan;
	runUpdate?: { status: "needs_input" | "paused"; terminalDetail: string };
	approval?: Omit<StoredApproval, "createdAt">;
	attention?: AttentionRequestInput;
	reigniteRequest?: ReigniteRequest;
	leaks?: string[];
}

interface PreparedDispatch {
	result: DispatchResult;
	action: StoredAction;
	plan: StoredPlan | null;
	capacity: boolean;
	apply: "accepted" | "rejected" | "noop";
}

interface PreparedTerminal {
	terminal: TerminalEvent;
	action: StoredAction;
	plan: StoredPlan | null;
	record: StoredTerminalRecord | null;
	transition: TerminalTransition | null;
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

function boundedEvidence(value: string, limit: number): string {
	const note = "\n[TRUNCATED: full evidence remains in the immutable terminal result or recovery request]";
	return value.length <= limit ? value : value.slice(0, Math.max(0, limit - note.length)) + note;
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
		...(input.userAcceptance ? { userAcceptance: input.userAcceptance } : {}),
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
	private specsCache: { runId: string; generation: number; specs: StoredPlanSpec[]; byId: Map<string, StoredPlanSpec> } | null = null;
	private graphDriftCache: {
		inputSha256: string;
		generation: number;
		expectedGraphSha256: string;
		editState: string;
		result: { changed: boolean; detail: string | null };
	} | null = null;
	private terminalSideEffectsDirty = true;

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

	private recoveryEvidence(run: StoredRun, plan: StoredPlan | null, spec: StoredPlanSpec): AttentionRecoveryEvidence {
		const generation = this.store.getGeneration(run.runId, spec.graphGeneration);
		if (!generation) throw new Error(`Run generation ${spec.graphGeneration} has no assignment evidence`);
		const assignmentPath = plan?.assignmentPath ?? generation.runAssignmentPath;
		const assignmentSha256 = plan?.assignmentSha256 ?? generation.runAssignmentSha256;
		const branch = plan?.branch ?? `herder/${run.planName}/${spec.planId}`;
		const worktree = plan?.worktree ?? path.join(path.dirname(run.integrationWorktree), spec.planId);
		let worktreeHead: string | null = null;
		let worktreeTree: string | null = null;
		let changedPaths: string[] = [];
		if (plan) {
			const driver = this.driver(run);
			try { worktreeHead = driver.worktreeHead(plan.worktree); } catch { worktreeHead = null; }
			try { worktreeTree = driver.worktreeTree(plan.worktree); } catch { worktreeTree = null; }
			try { changedPaths = driver.changedPaths(plan.worktree, plan.generationBase).sort(); } catch { changedPaths = []; }
		}
		const inScopePaths = [...spec.assignment.plan.inScopePaths].sort();
		const changedPathCount = changedPaths.length;
		const changedPathsSha256 = sha256(stableJson(changedPaths));
		let generationBase = plan?.generationBase ?? run.baseCommit;
		if (!plan) {
			try { generationBase = this.driver(run).branchHead(run.integrationBranch); } catch { /* preserve the recorded base commit */ }
		}
		return {
			planFingerprint: spec.planFingerprint,
			fingerprintVersion: spec.fingerprintVersion,
			planFile: spec.planFile,
			inScopePaths: inScopePaths.slice(0, ATTENTION_PATH_LIMIT),
			inScopePathCount: inScopePaths.length,
			inScopePathsSha256: sha256(stableJson(inScopePaths)),
			assignmentPath,
			assignmentSha256,
			snapshotSha256: plan?.snapshotSha256 ?? spec.assignment.snapshotSha256,
			generationBase,
			branch,
			worktree,
			worktreeHead,
			worktreeTree,
			changedPaths: changedPaths.slice(0, ATTENTION_PATH_LIMIT),
			changedPathCount,
			changedPathsSha256,
		};
	}

	private terminalEvidence(run: StoredRun, plan: StoredPlan, finishing?: { actionId: string; result?: WorkerResult; detail: string }): string {
		const actions = this.store.getActions(run.runId).filter((action) => action.planId === plan.planId
			&& action.generation === plan.generation && action.state === "terminal");
		if (finishing && !actions.some((action) => action.actionId === finishing.actionId)) {
			const action = this.store.getAction(finishing.actionId);
			if (action) actions.push({ ...action, result: { workerResult: finishing.result ?? null, outcome: finishing.detail } });
		}
		const recent = actions.slice(-24).reverse();
		return boundedEvidence([
			`CURRENT_GENERATION_TERMINAL_HISTORY: plan=${plan.planId}; generation=${plan.generation}; attempts=${actions.length}`,
			...(recent.length < actions.length ? ["[TRUNCATED: showing the latest 24 attempts]"] : []),
			...recent.map((action) => {
				const result = storedWorkerResult(action);
				const record = action.result as Record<string, unknown> | null;
				const fields = result as unknown as Record<string, unknown> | null;
				return [
					`ACTION_ID: ${action.actionId}; ROLE: ${action.role}; ROUND: ${action.round}; MODE: ${action.workerMode}`,
					`WORKER_RESULT_SHA256: ${result ? sha256(stableJson(result)) : "none"}`,
					`OUTCOME: ${boundedEvidence(String(fields?.status ?? fields?.verdict ?? fields?.decision ?? record?.outcome ?? "unknown"), 400)}`,
					`TRANSPORT: ${boundedEvidence(stableJson(record?.terminal ?? "none"), 400)}`,
					...(["checks", "commits", "filesChanged", "findings", "fixGuidance", "repairContracts", "authorizedBlockers", "notes", "stoppedBecause", "rationale"] as const)
						.filter((field) => fields?.[field] !== undefined)
						.map((field) => `${field}: ${boundedEvidence(stableJson(fields![field]), 650)}`),
				].join("\n");
			}),
		].join("\n"), 10_000);
	}

	private passDocumentEvidence(run: StoredRun, plan: StoredPlan): string {
		const judge = this.store.getActions(run.runId).filter((action) => action.planId === plan.planId
			&& action.generation === plan.generation && action.round === 2 && action.role === "plan-judge"
			&& action.state === "terminal" && storedWorkerResult(action)?.kind === "judge")
			.reverse().find((action) => (storedWorkerResult(action) as Extract<WorkerResult, { kind: "judge" }>).decision === "REPAIR");
		const result = judge ? storedWorkerResult(judge) : null;
		if (!judge || result?.kind !== "judge" || !result.passDocument) {
			return "PASS_DOCUMENT: none — no recorded round-2 Judge REPAIR document. Rescue may follow a proven operational failure; use the original assignment and recorded failure evidence, never invent a waiver.";
		}
		return `PASS_DOCUMENT_ACTION_ID: ${judge.actionId}\nPASS_DOCUMENT_SHA256: ${sha256(result.passDocument)}\nPASS_DOCUMENT_RESULT_SHA256: ${sha256(stableJson(result))}\nPASS_DOCUMENT:\n${result.passDocument}`;
	}

	private promptEvidence(run: StoredRun, plan: StoredPlan): string {
		const prior = this.store.getAttentionRequests(run.runId).filter((request) => request.kind === "plan_recovery"
			&& request.planId === plan.planId && request.generation < plan.generation && request.state === "resolved").at(-1);
		return [
			this.terminalEvidence(run, plan),
			this.acceptedDependencyEvidence(run, plan),
			...(plan.round === MAX_PLAN_ROUNDS ? [this.passDocumentEvidence(run, plan),
				"FINAL_ROUND: Rescue uses the existing Implementer role, model and tools in a fresh session. Reviewer nonapproval ends autonomous work; no Judge and no round 4."] : []),
			...(prior ? [`PREVIOUS_GENERATION_RECOVERY_EVIDENCE_ONLY: request=${prior.requestId}; sha256=${prior.detailSha256}. This is historical evidence, NOT a contract; the current revised assignment supersedes all old requirements.\n${boundedEvidence(prior.detail, 6_000)}`] : []),
		].join("\n");
	}

	private acceptedDependencyEvidence(run: StoredRun, plan: StoredPlan): string {
		const specs = this.specs(run);
		const dependencies = new Set(plan.planId === "RUN" ? specs.map((spec) => spec.planId) : this.spec(run, plan.planId).dependencies);
		for (const id of dependencies) for (const dependency of specs.find((spec) => spec.planId === id)?.dependencies ?? []) dependencies.add(dependency);
		const accepted = this.store.getPlans(run.runId).filter((candidate) => candidate.phase === "DONE" && dependencies.has(candidate.planId))
			.map((candidate) => ({ plan: candidate, approval: this.store.getApproval(run.runId, candidate.planId, candidate.generation) }))
			.filter(({ approval }) => approval?.decisionRole === "user" && approval.userAcceptance);
		if (!accepted.length) return "RECORDED_HUMAN_EXCEPTIONS: none";
		return boundedEvidence([
			"RECORDED_HUMAN_EXCEPTIONS: Explicit scoped user acceptance for DONE dependencies only. These are not PASS evidence: failed checks and findings remain failed/open. Do not silently reopen acknowledged gaps as unacknowledged criteria, or extend exceptions to this assignment, other trees, or new regressions. Final verification gates and REIGNITE behavior are unchanged.",
			...accepted.map(({ plan: dependency, approval }) => [
				`PLAN: ${dependency.planId}; GENERATION: ${dependency.generation}; ROUND: ${approval!.round}; ASSIGNMENT_SHA256: ${approval!.assignmentSha256}`,
				`APPROVED_BASE: ${approval!.approvedBase}; APPROVED_HEAD: ${approval!.approvedHead}; APPROVED_TREE: ${approval!.approvedTree}; INTEGRATED_HEAD: ${dependency.approvedHead}; INTEGRATED_TREE: ${dependency.approvedTree}`,
				`REVIEWER_ACTION_ID: ${approval!.reviewerActionId}; REVIEW_RESULT_SHA256: ${approval!.reviewResultSha256}; APPROVAL_PROOF_SHA256: ${approval!.proofSha256}`,
				`USER_ACCEPTANCE_SHA256: ${approval!.decisionResultSha256}; REQUEST_ID: ${approval!.userAcceptance!.requestId}; REQUEST_SHA256: ${approval!.userAcceptance!.requestSha256}`,
				`ACCEPTED_GAPS: ${boundedEvidence(approval!.userAcceptance!.answer!, 1_200)}`,
				`RATIONALE: ${boundedEvidence(approval!.userAcceptance!.rationale!, 600)}`,
			].join("\n")),
		].join("\n"), 8_000);
	}

	private exhaustionDossier(run: StoredRun, plan: StoredPlan, detail: string, finishing?: { actionId: string; result?: WorkerResult }): string {
		const evidence = this.recoveryEvidence(run, plan, this.spec(run, plan.planId));
		return boundedEvidence([
			"EXHAUSTION_DECISION_DOSSIER — evidence, not an approval or waiver",
			`REASON: ${boundedEvidence(detail, 800)}`,
			`EXACT_IDENTITY: ${stableJson({
				branch: evidence.branch, generationBase: evidence.generationBase, HEAD: evidence.worktreeHead, tree: evidence.worktreeTree,
				assignmentSha256: evidence.assignmentSha256, snapshotSha256: evidence.snapshotSha256,
				assignmentPath: boundedEvidence(evidence.assignmentPath, 700), worktree: boundedEvidence(evidence.worktree, 700),
				changedPathCount: evidence.changedPathCount, changedPathsSha256: evidence.changedPathsSha256,
				inScopePathCount: evidence.inScopePathCount, inScopePathsSha256: evidence.inScopePathsSha256,
			})}`,
			"Full exact paths remain in runtime evidence and, for plan recovery, request.recovery; dossier path display may be truncated.",
			`FROZEN_REVIEW: base=${plan.approvedBase}; HEAD=${plan.approvedHead}; tree=${plan.approvedTree}`,
			`IMPLEMENTED_STATUS: inspect recorded COMPLETE/FAILED outcomes and checks below; failed checks remain failed. Worktree status: ${boundedEvidence(this.driver(run).worktreeStatus(plan.worktree) || "clean", 500)}`,
			`REMAINING_FINDINGS_AND_IMPACT: ${boundedEvidence(stableJson(finishing?.result && "findings" in finishing.result ? finishing.result.findings : plan.findings), 1_000)}`,
			`RECORDED_GATES: ${boundedEvidence(stableJson(plan.gates), 600)}`,
			"RECOMMENDATION: Stop unless the exact clean reviewed patch is acceptable with explicitly acknowledged gaps. OPTIONS: accept (confirmed, accepted gaps and rationale; only a clean terminal round-3 reviewed tree), stop (preserve artifacts), or explicitly revise the target in a new generation. Pure transport exhaustion remains operator attention, not authorization to rewrite or waive requirements.",
			boundedEvidence(this.passDocumentEvidence(run, plan), 3_000),
			this.terminalEvidence(run, plan, finishing ? { ...finishing, detail } : undefined),
		].join("\n"), 16_384);
	}

	private attention(input: {
		run: StoredRun;
		plan: StoredPlan | null;
		spec?: StoredPlanSpec;
		planId?: string;
		kind: ManagerAttentionRequest["kind"];
		cause: AttentionCause;
		actionId: string | null;
		continuation: ManagerAttentionRequest["continuation"];
		state: ManagerAttentionRequest["state"];
		detail: string;
		question?: string;
		recommendedAction?: string;
		result?: WorkerResult;
	}): AttentionRequestInput {
		const detail = input.plan && input.plan.planId !== "RUN" && ["round_limit", "implementer_exhausted", "transport_exhausted", "integration_conflict_exhausted"].includes(input.cause)
			? this.exhaustionDossier(input.run, input.plan, input.detail, input.actionId ? { actionId: input.actionId, result: input.result } : undefined)
			: boundedEvidence(input.detail, 16_384);
		const now = new Date().toISOString();
		const requestId = randomUUID();
		const request = {
			schemaVersion: 1,
			requestId,
			capabilityToken: attentionCapabilityToken(requestId),
			runId: input.run.runId,
			planId: input.plan?.planId ?? input.spec?.planId ?? input.planId ?? "",
			generation: input.plan?.generation ?? input.spec?.graphGeneration ?? input.run.currentGeneration,
			round: input.plan?.round ?? 1,
			actionId: input.actionId,
			kind: input.kind,
			state: input.state,
			cause: input.cause,
			detail,
			detailSha256: sha256(detail),
			continuation: input.continuation,
			...(input.question ? { question: input.question.slice(0, 4_096) } : {}),
			...(input.recommendedAction ? { recommendedAction: input.recommendedAction.slice(0, 4_096) } : {}),
			...(input.kind === "plan_recovery"
				? input.spec
					? { recovery: this.recoveryEvidence(input.run, input.plan, input.spec) }
					: (() => { throw new Error("Plan-recovery attention requires a compiled plan specification"); })()
				: {}),
			createdAt: now,
			updatedAt: now,
		} as AttentionRequestInput;
		return { ...request, requestSha256: attentionRequestSha256(request) } as AttentionRequestInput;
	}

	private cacheSpecs(specs: StoredPlanSpec[]): void {
		const first = specs[0];
		if (!first) { this.specsCache = null; return; }
		this.specsCache = {
			runId: first.runId,
			generation: first.graphGeneration,
			specs,
			byId: new Map(specs.map((spec) => [spec.planId, spec])),
		};
	}

	private specs(run: StoredRun): StoredPlanSpec[] {
		if (this.specsCache?.runId === run.runId && this.specsCache.generation === run.currentGeneration) {
			return this.specsCache.specs;
		}
		const specs = this.store.getPlanSpecs(run.runId);
		if (specs.length === 0) throw new Error("Run has no compiled plan specification; start a fresh run with the current Herder version");
		this.cacheSpecs(specs);
		return specs;
	}

	private spec(run: StoredRun, planId: string): StoredPlanSpec {
		this.specs(run);
		const spec = this.specsCache!.byId.get(planId);
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
			previous: this.specs(run),
		}) };
	}

	private graphDrift(run: StoredRun): { changed: boolean; detail: string | null } {
		const edit = this.store.getPlanEdit(run.runId);
		if (edit?.state === "reserved") return { changed: false, detail: null };
		try {
			const inputSha256 = graphInputSha256(this.planDirectory);
			const expectedGraphSha256 = edit?.state === "barrier" ? edit.proposedGraphSha256! : run.graphSha256;
			const editState = edit?.state === "barrier" ? `barrier:${edit.planId}` : "none";
			const cached = this.graphDriftCache;
			if (cached
				&& cached.inputSha256 === inputSha256
				&& cached.generation === run.currentGeneration
				&& cached.expectedGraphSha256 === expectedGraphSha256
				&& cached.editState === editState) return cached.result;
			const compiled = this.compileCurrentGraph(run);
			const result = edit?.state === "barrier"
				? {
					changed: compiled.graphSha256 !== edit.proposedGraphSha256,
					detail: compiled.graphSha256 === edit.proposedGraphSha256
						? null
						: `Reserved plan ${edit.planId} changed after its revision barrier was requested. Finish the edit again after repairing the graph.`,
				}
				: {
					changed: compiled.graphSha256 !== run.graphSha256,
					detail: compiled.graphSha256 === run.graphSha256
						? null
						: `Plan graph changed after generation ${run.currentGeneration}; run Herder revise after active workers finish.`,
				};
			this.graphDriftCache = { inputSha256, generation: run.currentGeneration, expectedGraphSha256, editState, result };
			return result;
		} catch (error) {
			return { changed: true, detail: `Plan graph is currently invalid: ${(error as Error).message}` };
		}
	}

	private ensureInitialAttention(run: StoredRun): void {
		for (const spec of this.specs(run).filter((candidate) => candidate.initialStatus === "BLOCKED")) {
			if (this.store.getPlan(run.runId, spec.planId)) continue;
			this.store.putAttention(this.attention({
				run,
				plan: null,
				spec,
				kind: "plan_recovery",
				cause: "initial_decision_blocked",
				actionId: null,
				state: "pending",
				continuation: { role: "plan-implementer", phase: "READY_IMPLEMENTER" },
				detail: spec.initialStatusDetail,
				recommendedAction: "Review the target plan's decision blockage before resuming its recorded Implementer continuation.",
			}));
		}
	}

	private projectLifecycle(run: StoredRun, changedAfter?: string): void {
		const plans = this.store.getPlans(run.runId);
		const runtime = new Map(plans.map((plan) => [plan.planId, plan]));
		const attentionDetails = new Map(this.store.getAttentionRequests(run.runId, { unresolvedOnly: true })
			.map((request) => [request.planId, request.detail]));
		const reservedPlanId = this.store.getPlanEdit(run.runId)?.planId;
		projectStatuses(this.planDirectory, this.specs(run).filter((spec) => {
			if (spec.planId === reservedPlanId) return false;
			if (!changedAfter) return true;
			return Boolean(runtime.get(spec.planId)?.updatedAt && runtime.get(spec.planId)!.updatedAt > changedAfter);
		}).map((spec) => {
			const plan = runtime.get(spec.planId) ?? null;
			const status = lifecycleStatus(spec, plan);
			const rawDetail = plan?.phase === "BLOCKED" || plan?.phase === "NEEDS_INPUT"
				? plan.repair[0] || attentionDetails.get(spec.planId) || spec.initialStatusDetail
				: status === spec.initialStatus ? spec.initialStatusDetail : "";
			const detail = rawDetail.replace(/[\r\n]+/g, " ").replaceAll("|", ";").replace(/\s+/g, " ").trim();
			return { id: spec.planId, status, detail: status === "BLOCKED" || status === "REJECTED" ? detail : "" };
		}));
	}

	private projectLifecycleBestEffort(): void {
		try {
			const run = this.store.getRun();
			if (run) this.projectLifecycle(run);
		} catch {
			// Terminal snapshots are best-effort and must not revert a persisted run.
		}
	}

	async start(input: StartInput): Promise<ManagerReply> {
		validateStartInput(input);
		const existing = this.store.getRun();
		if (existing) {
			if (input.mode === "fire") throw new Error(`Run ${existing.runId} already exists; use resume`);
			return input.mode === "revise" ? this.revise(input) : this.resume(input);
		}
		if (input.mode !== "fire") throw new Error("No deterministic Herder run is recorded; start a fresh run");
		const profile = resolvePiProfile(input.profile);
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
		const lifecycle = readPlanLifecycle(this.planDirectory, graph);
		const adopted = graph.plans.filter((plan: { id: string }) => lifecycle.get(plan.id) === "IN PROGRESS");
		if (adopted.length > 0) {
			throw new Error(`Fresh deterministic runs cannot adopt prior execution state: ${adopted.map((plan: { id: string }) => `${plan.id}=${lifecycle.get(plan.id)}`).join(", ")}`);
		}
		const allowedInitial = new Set(["TODO", "DONE", "BLOCKED", "REJECTED"]);
		const unsupported = graph.plans.filter((plan: { id: string }) => !allowedInitial.has(lifecycle.get(plan.id) ?? ""));
		if (unsupported.length > 0) {
			throw new Error(`Unsupported initial lifecycle state: ${unsupported.map((plan: { id: string }) => `${plan.id}=${lifecycle.get(plan.id) ?? "missing"}`).join(", ")}`);
		}
		const checkoutStateToken = await driver.captureCheckout();
		const baseCommit = driver.worktreeHead(driver.repoRoot);
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
		const compiled = compilePlanSpecs({ runId, graphGeneration, graph });
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
		this.cacheSpecs(specs);
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
		const profile = resolvePiProfile(input.profile || run.profileName);
		if (profile.profile_sha256 !== run.profileSha256 || profile.profile !== run.profileName) {
			throw new Error(`Recorded profile ${run.profileName} no longer matches its immutable binding`);
		}
		if (input.maxParallel !== undefined && input.maxParallel !== run.maxParallel) {
			throw new Error(`Resume must preserve max parallel ${run.maxParallel}; received ${input.maxParallel}`);
		}
		if (run.status === "complete" && this.store.getReigniteRequest(run.runId, run.currentGeneration)?.state === "pending") {
			return this.refreshReply();
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
		const failedVerification = this.store.getVerification(run.runId, run.currentGeneration);
		const integrationRepair = failedVerification ? integrationRepairForVerification(this.store, failedVerification) : null;
		if (integrationRepair && (integrationRepair.state === "verifying" || integrationRepair.state === "committed")) {
			const successor = validateDurableRepairSuccessor(this.store, integrationRepair);
			const beginRefSnapshot = repairBeginRefSnapshot(integrationRepair);
			driver.validateIntegrationRepairNamespace({
				beginRefSnapshot,
				beginRefSnapshotSha256: integrationRepair.beginRefSnapshotSha256!,
				expectedIntegrationHead: integrationRepair.currentCommit ?? integrationRepair.parentCommit,
				expectedWorktreeHead: integrationRepair.currentCommit ?? integrationRepair.parentCommit,
			});
			if (integrationRepair.state === "committed") this.store.updateIntegrationRepair(integrationRepair.repairId, { state: "verifying" });
			return this.verification(successor.manifest);
		}
		const unclaimedInitialFailure = Boolean(integrationRepair
			&& failedVerification
			&& isProvableInitialRepair(this.store, failedVerification, integrationRepair));
		if (integrationRepair && ["active", "committing", "committed", "failed", "paused", "interrupted"].includes(integrationRepair.state) && !unclaimedInitialFailure) {
			return this.reply();
		}
		if (run.status === "failed" && failedVerification?.state === "failed" && !this.store.getPlan(run.runId, "RUN")) {
			if (driver.branchHead(run.integrationBranch) !== failedVerification.request.integrationHead
				|| driver.worktreeTree(run.integrationWorktree) !== failedVerification.request.integrationTree
				|| driver.worktreeStatus(run.integrationWorktree)) {
				throw new Error("Cannot retry verification because the frozen integration tree changed");
			}
			const request = createVerificationRequest({
				...failedVerification.request,
				requestId: randomUUID(),
				requestedAt: new Date().toISOString(),
			});
			this.store.transaction(() => {
				this.store.putVerificationRequest(request);
				this.store.updateRun({ status: "paused", terminalDetail: "Waiting for the main Pi session to submit a replacement verification manifest." });
			});
			return this.reply();
		}
		if (run.status === "complete") return this.reply();
		if (["failed", "stopped", "paused"].includes(run.status)) this.store.updateRun({ status: "running", terminalDetail: null });
		run = this.store.getRun()!;
		return this.reconcile(profile);
	}

	private validateRevisionChanges(
		run: StoredRun,
		compiled: { graph: ReturnType<typeof buildGraph>; specs: StoredPlanSpec[]; graphSha256: string },
		reservedPlanId?: string,
	): void {
		const previous = new Map(this.specs(run).map((spec) => [spec.planId, spec]));
		const next = new Map(compiled.specs.map((spec) => [spec.planId, spec]));
		const removed = [...previous.keys()].filter((planId) => !next.has(planId));
		if (removed.length > 0) throw new Error(`Graph revision cannot remove plans from an existing namespace: ${removed.join(", ")}`);
		for (const spec of compiled.specs) {
			const prior = previous.get(spec.planId);
			if (!prior) {
				if (reservedPlanId) throw new Error(`Active Grill may refine only reserved plan ${reservedPlanId}; it cannot add plan ${spec.planId}`);
				const graphPlan = compiled.graph.plans.find((plan) => plan.id === spec.planId)!;
				if (["DONE", "IN PROGRESS"].includes(graphPlan.status)) throw new Error(`New plan ${spec.planId} cannot adopt lifecycle state ${graphPlan.status}`);
				continue;
			}
			if (prior.planFingerprint === spec.planFingerprint) continue;
			if (reservedPlanId && spec.planId !== reservedPlanId) {
				throw new Error(`Active Grill reserved ${reservedPlanId} but also changed ${spec.planId}`);
			}
			const runtime = this.store.getPlan(run.runId, spec.planId);
			if (runtime) throw new Error(`Graph revision changed ${spec.planId} after execution started; create a trusted-base recovery namespace instead`);
		}
	}

	private adoptCompiledRevision(
		run: StoredRun,
		compiled: { specs: StoredPlanSpec[]; graphSha256: string },
		detail: string,
		completedEdit?: StoredPlanEdit,
	): void {
		const driver = this.driver(run);
		const namespace = driver.inspectNamespace("resume");
		if (!namespace.ok) throw new Error(`Cannot revise ambiguous Herder namespace: ${namespace.reason}`);
		const nextGeneration = run.currentGeneration + 1;
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
			if (completedEdit) {
				this.store.recordPlanEditOutcome(completedEdit, "finish");
				this.store.deletePlanEdit(run.runId);
			}
			this.store.updateRun({
				status: "running",
				terminalDetail: detail,
				currentGeneration: nextGeneration,
				graphSha256: compiled.graphSha256,
			});
		});
		this.cacheSpecs(compiled.specs);
	}

	async revise(input: StartInput): Promise<ManagerReply> {
		const run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		if (fs.realpathSync(input.repositoryRoot) !== run.repositoryRoot) throw new Error("Revision repository does not match the recorded run");
		if (input.planName && input.planName !== run.planName) throw new Error(`Revision plan name must remain ${run.planName}`);
		if (input.maxParallel !== undefined && input.maxParallel !== run.maxParallel) {
			throw new Error(`Revision must preserve max parallel ${run.maxParallel}; received ${input.maxParallel}`);
		}
		if (activeActionCount(this.store, run.runId) > 0) {
			throw new Error("Plan graph revision requires zero proposed or dispatched workers; wait for terminal events or stop them first");
		}
		if (this.store.getPlanEdit(run.runId)) throw new Error("Finish or cancel the active Grill plan edit before running Herder revise");
		const profile = resolvePiProfile(input.profile || run.profileName);
		if (profile.profile_sha256 !== run.profileSha256 || profile.profile !== run.profileName) {
			throw new Error(`Recorded profile ${run.profileName} no longer matches its immutable binding`);
		}
		const driver = this.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		const nextGeneration = run.currentGeneration + 1;
		const compiled = this.compileCurrentGraph(run, nextGeneration);
		if (compiled.graphSha256 === run.graphSha256) throw new Error(`Plan graph still matches generation ${run.currentGeneration}; use resume`);
		this.validateRevisionChanges(run, compiled);
		this.adoptCompiledRevision(run, compiled, `Adopted plan graph generation ${nextGeneration} from generation ${run.currentGeneration}.`);
		return this.reconcile(profile);
	}

	private compiledReservedEdit(run: StoredRun, edit: StoredPlanEdit) {
		const compiled = this.compileCurrentGraph(run, run.currentGeneration + 1);
		this.validateRevisionChanges(run, compiled, edit.planId);
		const target = compiled.specs.find((spec) => spec.planId === edit.planId);
		if (!target) throw new Error(`Reserved plan ${edit.planId} is missing from the revised graph`);
		if (target.planFingerprint === edit.basePlanFingerprint || compiled.graphSha256 === edit.baseGraphSha256) {
			throw new Error(`Reserved plan ${edit.planId} has not changed; cancel the edit instead`);
		}
		return { compiled, target };
	}

	private adoptReservedEdit(run: StoredRun, edit: StoredPlanEdit): void {
		if (activeActionCount(this.store, run.runId) > 0) throw new Error("Reserved plan revision is still waiting for active workers to settle");
		const { compiled, target } = this.compiledReservedEdit(run, edit);
		if (edit.proposedGraphSha256 !== compiled.graphSha256 || edit.proposedPlanFingerprint !== target.planFingerprint) {
			throw new Error(`Reserved plan ${edit.planId} changed after its revision barrier was requested`);
		}
		const nextGeneration = run.currentGeneration + 1;
		this.adoptCompiledRevision(
			run,
			compiled,
			`Adopted Grill revision for plan ${edit.planId} as graph generation ${nextGeneration}.`,
			edit,
		);
	}

	private reservedEditIsRework(run: StoredRun, planId: string): boolean {
		return Boolean(this.store.getPlan(run.runId, planId) || this.store.countActions(run.runId, { planId }) > 0);
	}

	private reworkGitHeads(driver: GitDriver, plan: StoredPlan): { expectedHead: string; expectedTree: string } {
		return { expectedHead: driver.worktreeHead(plan.worktree), expectedTree: driver.worktreeTree(plan.worktree) };
	}

	private planCommitIsIntegrated(run: StoredRun, driver: GitDriver, plan: StoredPlan): boolean {
		const integrationHead = driver.branchHead(run.integrationBranch);
		let branchHead: string | null = null;
		try { branchHead = driver.branchHead(plan.branch); } catch { /* A missing branch is handled by exact cleanup validation. */ }
		return [plan.approvedHead, branchHead]
			.some((candidate) => Boolean(candidate && candidate !== plan.generationBase && driver.isAncestor(candidate, integrationHead)));
	}

	private assertNoNewActivePathOverlap(run: StoredRun, priorSpecs: StoredPlanSpec[], prior: StoredPlanSpec, target: StoredPlanSpec, label: string): void {
		const activePaths = this.store.getActions(run.runId, ["proposed", "dispatched"])
			.filter((candidate) => candidate.planId !== prior.planId)
			.flatMap((candidate) => priorSpecs.find((spec) => spec.planId === candidate.planId)?.assignment.plan.inScopePaths ?? []);
		if (activePaths.length === 0) return;
		const activePathSet = new Set(activePaths);
		const oldTargetPaths = new Set(prior.assignment.plan.inScopePaths);
		const newOverlap = target.assignment.plan.inScopePaths.filter((candidate) => activePathSet.has(candidate));
		const priorOverlap = [...oldTargetPaths].filter((candidate) => activePathSet.has(candidate));
		if (newOverlap.some((candidate) => !oldTargetPaths.has(candidate)) || (prior.planFingerprint !== target.planFingerprint && priorOverlap.length === 0 && newOverlap.length > 0)) {
			throw new Error(`${label} target ${prior.planId} introduces an unordered overlap with active work: ${newOverlap.join(", ")}`);
		}
	}

	private assertReworkEligible(run: StoredRun, planId: string): StoredPlan {
		if (planId === "RUN") throw new Error("The final RUN audit cannot be reworked");
		if (!["running", "failed", "needs_input"].includes(run.status)) {
			throw new Error(`Cannot rework a plan while Herder is ${run.status}`);
		}
		this.spec(run, planId);
		const plan = this.store.getPlan(run.runId, planId);
		if (!plan && this.store.countActions(run.runId, { planId }) === 0) {
			throw new Error(`Plan ${planId} has not started; use /herder-grill --plan`);
		}
		if (!plan) throw new Error(`Plan ${planId} has no runtime record to rework`);
		const driver = this.driver(run);
		if (plan.phase === "DONE" || plan.phase === "FINAL_APPROVED" || driver.hasPlanCompletionProof(planId) || this.planCommitIsIntegrated(run, driver, plan)) {
			throw new Error(`Plan ${planId} is already integrated; create a corrective plan instead of reworking it.`);
		}
		if (!["BLOCKED", "NEEDS_INPUT"].includes(plan.phase)) {
			throw new Error(`Plan ${planId} is ${plan.phase}, not a blocked or exhausted plan`);
		}
		const specs = this.specs(run);
		const downstream = new Set([planId]);
		for (let changed = true; changed;) {
			changed = false;
			for (const candidate of specs) {
				if (downstream.has(candidate.planId)) continue;
				if (candidate.dependencies.some((dependency) => downstream.has(dependency))
					|| candidate.assignment.plan.dependencies.some((dependency) => downstream.has(dependency))) {
					downstream.add(candidate.planId);
					changed = true;
				}
			}
		}
		for (const other of specs) {
			if (other.planId === planId || !downstream.has(other.planId)) continue;
			const runtime = this.store.getPlan(run.runId, other.planId);
			const lifecycle = lifecycleStatus(other, runtime);
			if (lifecycle === "DONE" || driver.hasPlanCompletionProof(other.planId) || (runtime && this.planCommitIsIntegrated(run, driver, runtime))) {
				throw new Error(`Plan ${planId} cannot be reworked because integrated downstream plan ${other.planId} depends on it. Create a corrective plan instead.`);
			}
			if (this.store.countActions(run.runId, { planId: other.planId, states: ["proposed", "dispatched"] }) > 0
				|| (runtime && runtime.phase !== "BLOCKED" && runtime.phase !== "NEEDS_INPUT")) {
				throw new Error(`Plan ${planId} cannot be reworked because active downstream plan ${other.planId} depends on it. Create a corrective plan instead.`);
			}
		}
		return plan;
	}

	private validateReworkGraph(
		run: StoredRun,
		planId: string,
		compiled: { specs: StoredPlanSpec[]; graphSha256: string },
	): { compiled: { specs: StoredPlanSpec[]; graphSha256: string }; nextSpecs: StoredPlanSpec[] } {
		const priorSpecs = this.specs(run);
		const { prior, target } = validateTargetOnlyGraph(priorSpecs, compiled.specs, planId, "Rework", "Rework target");
		if (target.planFingerprint === prior.planFingerprint) throw new Error(`Reserved plan ${planId} has not changed; cancel the edit instead`);
		this.assertNoNewActivePathOverlap(run, priorSpecs, prior, target, "Rework");
		return {
			compiled,
			nextSpecs: compiled.specs.map((spec) => spec.planId === planId
				? { ...spec, initialStatus: "TODO" as StoredPlanSpec["initialStatus"], initialStatusDetail: "" }
				: spec),
		};
	}

	private reworkCleanupIdentity(run: StoredRun, plan: StoredPlan, edit: StoredPlanEdit, snapshot: ReworkGraphSnapshot) {
		const expectedHead = snapshot.expectedHead;
		const expectedTree = snapshot.expectedTree;
		return {
			runId: run.runId,
			requestId: edit.editToken,
			requestSha256: sha256(stableJson({
				kind: "plan_rework",
				editToken: edit.editToken,
				planId: edit.planId,
				generation: plan.generation,
				round: plan.round,
				assignmentPath: plan.assignmentPath,
				assignmentSha256: plan.assignmentSha256,
				snapshotSha256: plan.snapshotSha256,
				generationBase: plan.generationBase,
				branch: plan.branch,
				worktree: plan.worktree,
				expectedHead,
				expectedTree,
				transientRefs: snapshot.transientRefs,
			})),
			planId: edit.planId,
			generation: plan.generation,
			round: plan.round,
			assignmentPath: plan.assignmentPath,
			assignmentSha256: plan.assignmentSha256,
			snapshotSha256: plan.snapshotSha256,
			generationBase: plan.generationBase,
			branch: plan.branch,
			worktree: plan.worktree,
			expectedHead,
			expectedTree,
		};
	}

	private async validatePreparedRework(run: StoredRun, edit: StoredPlanEdit): Promise<{
		plan: StoredPlan;
		driver: GitDriver;
		snapshot: ReworkGraphSnapshot;
		validation: ReturnType<HerderRunManager["validateReworkGraph"]>;
		cleanupIdentity: ReturnType<HerderRunManager["reworkCleanupIdentity"]>;
	}> {
		if (this.store.countActions(run.runId, { planId: edit.planId, states: ["proposed", "dispatched"] }) > 0) {
			throw new Error(`Plan ${edit.planId} still owns active worker actions; settle them before preparing rework`);
		}
		const plan = this.assertReworkEligible(run, edit.planId);
		const driver = this.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		const snapshot = readReworkSnapshot(run, edit, this.store);
		validateReworkGraphFiles(run, snapshot, snapshot.targetPlanFile);
		const compiled = this.compileCurrentGraph(run, run.currentGeneration + 1);
		const currentTarget = compiled.graph.plans.find((candidate) => candidate.id === edit.planId);
		if (!currentTarget || path.relative(run.planDirectory, currentTarget.file) !== snapshot.targetPlanFile) {
			throw new Error(`Rework target ${edit.planId} cannot change its linked plan file`);
		}
		const validation = this.validateReworkGraph(run, edit.planId, compiled);
		if (edit.state === "barrier" && (edit.proposedGraphSha256 !== validation.compiled.graphSha256
			|| edit.proposedPlanFingerprint !== validation.nextSpecs.find((spec) => spec.planId === edit.planId)?.planFingerprint)) {
			throw new Error(`Prepared plan ${edit.planId} changed after its revision barrier was requested`);
		}
		const cleanupIdentity = this.reworkCleanupIdentity(run, plan, edit, snapshot);
		const cleanupEvidence = this.store.getAttentionCleanupEvidence(cleanupIdentity);
		if (!cleanupEvidence) {
			driver.assertPlanTransientRefs(edit.planId, snapshot.transientRefs);
			const current = this.reworkGitHeads(driver, plan);
			if (current.expectedHead !== snapshot.expectedHead || current.expectedTree !== snapshot.expectedTree) {
				throw new Error(`Plan ${edit.planId} Git identity changed after rework began`);
			}
		} else {
			const currentRefs = driver.planTransientRefs(edit.planId);
			if (stableJson(currentRefs) !== stableJson(snapshot.transientRefs) && currentRefs.length !== 0) {
				throw new Error(`Plan ${edit.planId} transient refs changed during rework replay`);
			}
		}
		return { plan, driver, snapshot, validation, cleanupIdentity };
	}

	private async prepareRework(run: StoredRun, edit: StoredPlanEdit): Promise<StoredPlanEdit> {
		const { validation } = await this.validatePreparedRework(run, edit);
		const target = validation.nextSpecs.find((spec) => spec.planId === edit.planId)!;
		return this.store.putPlanEditBarrier(run.runId, edit.editToken, validation.compiled.graphSha256, target.planFingerprint);
	}

	private generationBase(run: StoredRun): string {
		const generation = this.store.getGeneration(run.runId, run.currentGeneration);
		if (!generation) throw new Error(`Run generation ${run.currentGeneration} has no assignment evidence`);
		const bytes = fs.readFileSync(generation.runAssignmentPath);
		if (sha256(bytes) !== generation.runAssignmentSha256) throw new Error(`Run assignment changed for generation ${run.currentGeneration}`);
		const parsed = JSON.parse(bytes.toString("utf8")) as { assignment?: { generationBase?: unknown } };
		const base = typeof parsed.assignment?.generationBase === "string" ? parsed.assignment.generationBase : "";
		if (!/^[0-9a-f]{40,64}$/i.test(base)) throw new Error(`Run generation ${run.currentGeneration} assignment has no valid base`);
		return base;
	}

	private ensureFreshPlanRuntime(run: StoredRun, spec: StoredPlanSpec, expectedHead?: string): StoredPlan {
		const execution = this.driver(run).ensurePlanWorktree(spec.planId, spec.assignment, expectedHead);
		return this.store.putPlan({
			runId: run.runId,
			planId: spec.planId,
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
	}

	private ensureReworkedPlanRuntime(run: StoredRun, planId: string, expectedHead = this.generationBase(run)): StoredPlan {
		const existing = this.store.getPlan(run.runId, planId);
		if (existing) {
			if (existing.generation !== run.currentGeneration || existing.round !== 1) throw new Error(`Reworked plan ${planId} runtime identity changed`);
			return existing;
		}
		return this.ensureFreshPlanRuntime(run, this.spec(run, planId), expectedHead);
	}

	private async applyRework(run: StoredRun, edit: StoredPlanEdit): Promise<ManagerReply> {
		if (edit.state !== "barrier" || !edit.proposedGraphSha256 || !edit.proposedPlanFingerprint) throw new Error(`Plan ${edit.planId} rework must be prepared before finish`);
		if (!this.store.hasPlanEditConfirmation(edit)) throw new Error(`Plan ${edit.planId} rework must be confirmed before finish`);
		const { plan, driver, snapshot, validation, cleanupIdentity } = await this.validatePreparedRework(run, edit);
		try {
			const lease = driver.leaseReason(plan.worktree);
			if (lease) throw new Error(`Plan ${plan.planId} worktree is still leased after worker settlement: ${lease}`);
		} catch (error) {
			if (!/not registered/i.test(error instanceof Error ? error.message : String(error))) throw error;
		}
		const nextGeneration = run.currentGeneration + 1;
		const integrationHead = driver.branchHead(run.integrationBranch);
		const assignment = driver.materializeRunAssignment(integrationHead, validation.nextSpecs.map((spec) => spec.assignment), nextGeneration);
		const recordedCleanup = this.store.getAttentionCleanupEvidence(cleanupIdentity);
		driver.resetPlanExecution({
			branch: plan.branch,
			worktree: plan.worktree,
			expectedHead: snapshot.expectedHead,
			expectedTree: snapshot.expectedTree,
			additionalRefs: snapshot.transientRefs,
			cleanupIdentity,
			recordedCleanup: recordedCleanup ?? undefined,
			onPrepare: (step) => this.store.recordAttentionCleanupStep(cleanupIdentity, step),
			onProgress: (step) => this.store.recordAttentionCleanupCompletion(cleanupIdentity, step),
			onComplete: (step) => this.store.recordAttentionCleanupCompletion(cleanupIdentity, step),
		});
		if (driver.planTransientRefs(edit.planId).length > 0) throw new Error(`Plan ${edit.planId} transient refs remain after rework cleanup`);
		crashReworkForTest("after_git_cleanup");
		this.store.transaction(() => {
			this.store.putPlanSpecs(validation.nextSpecs);
			this.store.putGeneration({
				runId: run.runId,
				generation: nextGeneration,
				graphSha256: validation.compiled.graphSha256,
				parentGeneration: run.currentGeneration,
				runAssignmentPath: assignment.bundlePath,
				runAssignmentSha256: assignment.bundleSha256,
				runSnapshotSha256: assignment.snapshotSha256,
			});
			this.store.deletePlan(run.runId, edit.planId);
			for (const request of this.store.getAttentionRequests(run.runId, { unresolvedOnly: true })) {
				if (request.planId === edit.planId) this.store.resolveAttention(request.requestId);
			}
			this.store.recordPlanEditOutcome(edit, "finish");
			this.store.deletePlanEdit(run.runId);
			this.store.updateRun({
				currentGeneration: nextGeneration,
				graphSha256: validation.compiled.graphSha256,
				status: this.store.getNextInputAttention(run.runId) ? "needs_input" : "running",
				terminalDetail: `Reworked plan ${edit.planId} as graph generation ${nextGeneration}.`,
			});
		});
		this.cacheSpecs(validation.nextSpecs);
		crashReworkForTest("after_adoption");
		const adoptedRun = this.store.getRun()!;
		this.ensureReworkedPlanRuntime(adoptedRun, edit.planId, integrationHead);
		deleteReworkSnapshotBestEffort(run.planDirectory, edit.editToken);
		const reply = await this.reconcile(boundProfile(adoptedRun, this.store));
		this.projectLifecycle(this.store.getRun()!);
		return reply;
	}

	async edit(input: PlanEditInput): Promise<PlanEditReply> {
		validatePlanEditInput(input);
		let run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		if (input.operation !== "begin") {
			const editToken = input.editToken!;
			if (input.operation === "finish" || input.operation === "cancel") {
				const outcome = this.store.getPlanEditOutcome(run.runId, editToken, input.operation);
				if (outcome) {
					if (input.operation === "finish" && outcome.rework && !this.store.getPlan(run.runId, outcome.planId) && !this.store.getPlanEdit(run.runId)) {
						this.cacheSpecs(this.store.getPlanSpecs(run.runId));
						this.ensureReworkedPlanRuntime(run, outcome.planId);
					}
					deleteReworkSnapshotBestEffort(run.planDirectory, editToken);
					const reply = input.operation === "finish" && (run.status === "running" || run.status === "needs_input")
						? await this.reconcile(boundProfile(run, this.store))
						: this.reply();
					if (input.operation === "finish" && outcome.rework) this.projectLifecycle(this.store.getRun()!);
					return { edit: { planId: outcome.planId, state: input.operation === "finish" ? "barrier" : "reserved" }, reply };
				}
				const opposite = this.store.getPlanEditOutcome(run.runId, editToken, input.operation === "finish" ? "cancel" : "finish");
				if (opposite) throw new Error(`Plan edit ${editToken} was already ${opposite.operation === "finish" ? "finished" : "cancelled"}`);
			}
		}
		if (input.operation === "begin") {
			const planId = normalizePlanId(input.planId);
			const rework = input.intent === "rework";
			if (!rework && run.status !== "running") throw new Error(`Active Grill requires a running Herder Fire run; current status is ${run.status}`);
			const existing = this.store.getPlanEdit(run.runId);
			if (existing) {
				if (existing.planId !== planId) throw new Error(`Plan ${existing.planId} already has the active Grill reservation`);
				const hadExecution = this.reservedEditIsRework(run, planId);
				if (rework && !hadExecution) throw new Error(`Plan ${planId} is reserved for Grill; cancel that edit before reworking`);
				if (!rework && hadExecution) throw new Error(`Plan ${planId} is reserved for rework; continue with /herder-rework or cancel the reservation`);
				if (rework) readReworkSnapshot(run, existing, this.store);
				return { edit: { planId, state: existing.state, editToken: existing.editToken }, reply: this.reply() };
			}
			const drift = this.graphDrift(run);
			if (drift.changed) throw new Error(`${drift.detail} Resolve graph drift before starting Grill.`);
			const spec = this.spec(run, planId);
			if (rework) {
				const plan = this.assertReworkEligible(run, planId);
				const driver = this.driver(run);
				await driver.verifyCheckout(run.checkoutStateToken);
				const editToken = input.editToken ?? randomUUID();
				pruneReworkSnapshots(run.planDirectory, editToken);
				const pendingEdit: StoredPlanEdit = {
					runId: run.runId,
					planId,
					editToken,
					state: "reserved",
					baseGraphSha256: run.graphSha256,
					basePlanFingerprint: spec.planFingerprint,
					proposedGraphSha256: null,
					proposedPlanFingerprint: null,
					createdAt: "",
					updatedAt: "",
				};
				let snapshotSha256: string;
				try {
					const snapshotPath = reworkSnapshotPath(run.planDirectory, editToken);
					if (fs.existsSync(snapshotPath)) snapshotSha256 = readReworkSnapshotFile(run, pendingEdit).sha256;
					else {
						const heads = this.reworkGitHeads(driver, plan);
						const graphPlan = buildGraph(run.planDirectory).plans.find((candidate) => candidate.id === planId);
						if (!graphPlan) throw new Error(`Rework target ${planId} is missing from the current graph`);
						const targetPlanFile = path.relative(run.planDirectory, graphPlan.file);
						snapshotSha256 = captureReworkSnapshot(run, planId, editToken, heads.expectedHead, heads.expectedTree, targetPlanFile, driver.planTransientRefs(planId)).sha256;
					}
				} catch (error) {
					deleteReworkSnapshotBestEffort(run.planDirectory, editToken);
					throw error;
				}
				crashReworkForTest("after_snapshot");
				let edit: StoredPlanEdit;
				try {
					edit = this.store.transaction(() => {
						const reserved = this.store.putPlanEdit(pendingEdit);
						this.store.recordPlanEditSnapshot(run!.runId, editToken, planId, snapshotSha256);
						return reserved;
					});
				} catch (error) {
					deleteReworkSnapshotBestEffort(run.planDirectory, editToken);
					throw error;
				}
				return { edit: { planId, state: edit.state, editToken: edit.editToken }, reply: this.reply() };
			}
			if (!["TODO", "BLOCKED"].includes(spec.initialStatus)) throw new Error(`Plan ${planId} is ${spec.initialStatus}, not an unstarted editable plan`);
			if (this.store.getPlan(run.runId, planId) || this.store.countActions(run.runId, { planId }) > 0) {
				throw new Error(`Plan ${planId} cannot be grilled because execution already started`);
			}
			const edit = this.store.putPlanEdit({
				runId: run.runId,
				planId,
				editToken: randomUUID(),
				state: "reserved",
				baseGraphSha256: run.graphSha256,
				basePlanFingerprint: spec.planFingerprint,
			});
			return { edit: { planId, state: edit.state, editToken: edit.editToken }, reply: this.reply() };
		}

		const edit = this.store.getPlanEdit(run.runId);
		if (!edit || edit.editToken !== input.editToken) throw new Error("Plan edit token does not match the active Grill reservation");
		const rework = this.reservedEditIsRework(run, edit.planId);
		if (input.operation === "prepare") {
			if (!rework) throw new Error("Explicit prepare is only valid for plan rework");
			const barrier = await this.prepareRework(run, edit);
			return { edit: { planId: edit.planId, state: barrier.state }, reply: this.reply("revision-barrier") };
		}
		if (input.operation === "confirm") {
			if (!rework || edit.state !== "barrier") throw new Error("Only a prepared plan rework can be confirmed");
			await this.validatePreparedRework(run, edit);
			this.store.recordPlanEditConfirmation(edit);
			return { edit: { planId: edit.planId, state: edit.state }, reply: this.reply("revision-barrier") };
		}
		if (input.operation === "cancel") {
			if (rework) {
				if (this.store.hasPlanEditConfirmation(edit)) throw new Error(`Confirmed plan ${edit.planId} rework must finish or replay; it can no longer be cancelled`);
				restoreReworkSnapshot(run, edit, this.store);
				this.projectLifecycle(run, edit.createdAt);
			} else {
				const compiled = this.compileCurrentGraph(run);
				if (compiled.graphSha256 !== edit.baseGraphSha256) throw new Error(`Plan ${edit.planId} changed; restore the reserved graph or finish the edit before cancelling`);
			}
			this.store.transaction(() => {
				this.store.recordPlanEditOutcome(edit, "cancel");
				this.store.deletePlanEdit(run!.runId);
			});
			if (rework) deleteReworkSnapshotBestEffort(run.planDirectory, edit.editToken);
			return { edit: { planId: edit.planId, state: edit.state }, reply: this.reply() };
		}
		if (rework) {
			const reply = await this.applyRework(run, edit);
			return { edit: { planId: edit.planId, state: "barrier" }, reply };
		}
		if (run.status !== "running") throw new Error(`Cannot finish a Grill revision while Herder is ${run.status}`);

		const { compiled, target } = this.compiledReservedEdit(run, edit);
		const barrier = this.store.putPlanEditBarrier(run.runId, edit.editToken, compiled.graphSha256, target.planFingerprint);
		if (activeActionCount(this.store, run.runId) === 0) {
			await this.driver(run).verifyCheckout(run.checkoutStateToken);
			this.adoptReservedEdit(run, barrier);
			run = this.store.getRun()!;
			return { edit: { planId: edit.planId, state: "barrier" }, reply: await this.reconcile(boundProfile(run, this.store)) };
		}
		return { edit: { planId: edit.planId, state: barrier.state }, reply: this.reply("revision-barrier") };
	}

	async integrationRepair(input: IntegrationRepairInput): Promise<ManagerReply> {
		return runIntegrationRepair({
			store: this.store,
			driver: (run) => this.driver(run),
			reply: () => this.reply(),
			verification: (manifest) => this.verification(manifest),
			updateRun: (changes) => this.store.updateRun(changes),
		}, input);
	}

	private finalizeVerificationFailure(
		stored: StoredVerification,
		detail: string,
		evidence: { schemaVersion: 1; request: StoredVerification["request"]; manifestSha256: string; manifest: VerificationManifest; gates: GateResult[]; passed: boolean; finishedAt: string; error?: string },
	): void {
		const repair = this.store.getIntegrationRepairForRequest(stored.request.requestId);
		this.store.transaction(() => {
			this.store.finishVerification(stored.request.requestId, "failed", evidence, detail);
			recordIntegrationRepairVerificationOutcome(this.store, stored.request.requestId, "failed", detail);
			const paused = Boolean(repair && repair.classification === "code_defect" && repair.acceptedCodeRounds >= 3);
			this.store.updateRun({ status: paused ? "paused" : "failed", terminalDetail: paused ? "Three accepted code-repair commits exhausted the bounded code-repair budget; awaiting explicit user choice." : detail });
		});
		this.projectLifecycleBestEffort();
	}

	async verification(input: VerificationManifest): Promise<ManagerReply> {
		let run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		const stored = this.store.getVerification(run.runId, run.currentGeneration);
		if (!stored) throw new Error("Herder is not waiting for a verification manifest");
		const { manifest, manifestSha256 } = normalizeVerificationManifest(stored.request, input);
		const successorRepair = stored.request.repairId ? this.store.getIntegrationRepair(stored.request.repairId) : null;
		validateRepairSuccessorManifest(this.store, stored.request, manifestSha256, successorRepair);
		const driver = this.driver(run);
		const validateSuccessorNamespace = (requireEvidence: boolean): string | null => {
			if (!successorRepair) return null;
			if (!successorRepair.beginRefSnapshot || !successorRepair.beginRefSnapshotSha256) {
				return requireEvidence ? "Integration repair begin namespace evidence is unavailable; cancel and restart the repair" : null;
			}
			try {
				const beginRefSnapshot = repairBeginRefSnapshot(successorRepair);
				driver.validateIntegrationRepairNamespace({
					beginRefSnapshot,
					beginRefSnapshotSha256: successorRepair.beginRefSnapshotSha256,
					expectedIntegrationHead: stored.request.integrationHead,
					expectedWorktreeHead: stored.request.integrationHead,
				});
			} catch (error) {
				return `Verification gate changed the bound integration repair namespace: ${error instanceof Error ? error.message : String(error)}`;
			}
			return null;
		};
		if (stored.state === "passed" || stored.state === "failed") {
			if (stored.manifestSha256 !== manifestSha256) throw new Error(`Verification request ${stored.request.requestId} was replayed with a different manifest`);
			if (successorRepair?.beginRefSnapshot && successorRepair.beginRefSnapshotSha256) {
				await driver.verifyCheckout(run.checkoutStateToken);
				const namespaceError = validateSuccessorNamespace(false);
				if (namespaceError) throw new Error(namespaceError);
			}
			if (stored.state === "passed") {
				if (run.status === "complete") return this.reply();
				if (run.status !== "running") this.store.updateRun({ status: "running", terminalDetail: "Recovering passed verification." });
				run = this.store.getRun()!;
				const refreshed = this.refreshReply();
				if (refreshed.status !== "running") return refreshed;
				return this.reconcile(boundProfile(run, this.store));
			}
			return this.reply();
		}
		await driver.verifyCheckout(run.checkoutStateToken);
		if (driver.branchHead(run.integrationBranch) !== stored.request.integrationHead
			|| driver.worktreeTree(run.integrationWorktree) !== stored.request.integrationTree
			|| driver.worktreeStatus(run.integrationWorktree)) {
			throw new Error("Integration worktree changed after the verification request was created");
		}
		const assignment = fs.readFileSync(stored.request.runAssignmentPath);
		if (sha256(assignment) !== stored.request.runAssignmentSha256) throw new Error("Verification run assignment changed after the request was created");
		this.store.transaction(() => {
			this.store.startVerification(stored.request.requestId, manifest, manifestSha256);
			this.store.updateRun({ status: "running", terminalDetail: "Executing the main-session verification manifest." });
		});
		const gates: GateResult[] = [];
		try {
			const frozenStateError = async (): Promise<string | null> => {
				await driver.verifyCheckout(run!.checkoutStateToken);
				const repairNamespaceError = validateSuccessorNamespace(true);
				if (repairNamespaceError) return repairNamespaceError;
				if (!successorRepair) {
					const namespace = driver.inspectNamespace("resume");
					if (!namespace.ok) return `Verification gate changed the Herder namespace: ${namespace.reason}`;
				}
				if (driver.branchHead(run!.integrationBranch) !== stored.request.integrationHead
					|| driver.worktreeTree(run!.integrationWorktree) !== stored.request.integrationTree
					|| driver.worktreeStatus(run!.integrationWorktree)) return "Verification gate changed the frozen integration worktree.";
				const live = this.store.getVerification(run!.runId, run!.currentGeneration);
				if (!live || live.state !== "running" || live.manifestSha256 !== manifestSha256) return "Verification gate changed manager-owned verification state.";
				return null;
			};
			let detail: string | null = await frozenStateError();
			for (const gate of manifest.gates) {
				if (detail) break;
				const [result] = driver.runVerificationGates(stored.request.requestId, run.integrationWorktree, [gate]);
				gates.push(result!);
				detail = await frozenStateError();
				if (detail) break;
				if (!result!.ok) {
					detail = `Verification gate ${result!.gateId} failed (log ${result!.logPath}).`;
					break;
				}
			}
			const evidence = {
				schemaVersion: 1 as const,
				request: stored.request,
				manifestSha256,
				manifest,
				gates,
				passed: !detail,
				finishedAt: new Date().toISOString(),
			};

			if (detail) {
				this.finalizeVerificationFailure(stored, detail, evidence);
				return this.reply();
			}
			this.store.transaction(() => {
				this.store.finishVerification(stored.request.requestId, "passed", evidence, null);
				recordIntegrationRepairVerificationOutcome(this.store, stored.request.requestId, "passed", null);
				this.store.updateRun({ status: "running", terminalDetail: "Final verification passed; preparing the aggregate audit." });
			});
			run = this.store.getRun()!;
			const refreshed = this.refreshReply();
			if (refreshed.status !== "running") return refreshed;
			return this.reconcile(boundProfile(run, this.store));
		} catch (error) {
			const detail = `Verification execution failed: ${error instanceof Error ? error.message : String(error)}`;
			const evidence = {
				schemaVersion: 1 as const,
				request: stored.request,
				manifestSha256,
				manifest,
				gates,
				passed: false,
				finishedAt: new Date().toISOString(),
				error: detail,
			};
			const live = this.store.getVerificationByRequestId(stored.request.requestId);
			if (live?.state === "running") {
				this.finalizeVerificationFailure(stored, detail, evidence);
			}
			return this.reply();
		}
	}

	reignite(input: ReigniteInput): ManagerReply {
		const requestId = String(input?.requestId ?? "").trim();
		const requestSha256 = String(input?.requestSha256 ?? "").trim().toLowerCase();
		const state = input?.state;
		if (!requestId || requestId.length > 200 || /[\0\r\n]/.test(requestId)) throw new Error("Reignite requestId must be a bounded single-line string");
		if (!/^[0-9a-f]{64}$/.test(requestSha256)) throw new Error("Reignite requestSha256 must be a SHA-256");
		if (state !== "written" && state !== "failed") throw new Error("Reignite state must be written or failed");
		const graphSha256 = input.graphSha256 === undefined ? undefined : String(input.graphSha256).trim().toLowerCase();
		if (graphSha256 !== undefined && !/^[0-9a-f]{40,64}$/.test(graphSha256)) throw new Error("Reignite graphSha256 must be a hexadecimal Git or SHA-256 identity");
		const detail = input.detail === undefined ? undefined : String(input.detail);
		if (detail !== undefined && (detail.length === 0 || detail.length > 16_384 || /\0/.test(detail))) {
			throw new Error("Reignite detail must be bounded evidence without NUL bytes");
		}
		const run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		const existing = this.store.getReigniteRequest(run.runId, run.currentGeneration);
		if (!existing || existing.requestId !== requestId || existing.requestSha256 !== requestSha256) {
			throw new Error(`Reignite request ${requestId} is not bound to this complete run`);
		}
		if (existing.state === "skipped") throw new Error("Reignite request was skipped and cannot be acknowledged");
		if (existing.state === "written") {
			if (state !== "written") throw new Error("Reignite request was already written");
			return this.reply();
		}
		if (existing.state !== "pending") throw new Error(`Reignite request ${requestId} is ${existing.state}`);
		if (run.status !== "complete") throw new Error("Reignite acknowledgement requires a complete source run");
		const request = this.ensureReigniteAllocation(run, existing);
		if (state === "failed") {
			this.store.updateReigniteRequest(request.requestId, { detail: detail ?? "Reignite write failed." });
			return this.reply();
		}
		if (!graphSha256) throw new Error("Reignite written acknowledgement requires graphSha256");
		this.assertWrittenReigniteGraph(run, request, graphSha256);
		this.store.updateReigniteRequest(request.requestId, {
			state: "written",
			detail: detail ?? null,
		});
		return this.reply();
	}

	async event(input: EventInput): Promise<ManagerReply> {
		validateEventInput(input);
		const run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		const canonical = canonicalEventPayload(input);
		const capacitySuppressed = input.kind === "dispatch_results"
			&& input.dispatchResults.some((result) => !result.accepted && /capacity|limit|slot|concurr/i.test(result.error || ""));
		const previous = this.store.readEvent(input.eventId);
		if (previous) {
			if (previous.payloadSha256 !== canonical.sha256) throw new Error(`Event ${input.eventId} was replayed with different payload`);
			const current = this.store.getRun()!;
			const replaySuppression = capacitySuppressed ? "host-backpressure" as const : undefined;
			const drift = this.graphDrift(current);
			if (drift.changed && (current.status === "running" || current.status === "needs_input")) {
				this.store.updateRun({ status: "paused", terminalDetail: drift.detail });
			}
			if (drift.changed) return this.refreshReply(replaySuppression);
			if (current.status === "running" || current.status === "needs_input") {
				return this.reconcile(boundProfile(current, this.store), {
					schedule: input.kind === "dispatch_results" ? !capacitySuppressed : true,
				});
			}
			return this.refreshReply(replaySuppression);
		}
		const profile = boundProfile(run, this.store);
		let schedule = true;
		let batchDrift: { changed: boolean; detail: string | null } | null = null;
		if (input.kind === "dispatch_results") {
			const applied = await this.applyDispatchResults(input.dispatchResults, input.eventId, input);
			batchDrift = applied.drift;
			schedule = !applied.capacityRejected;
		} else if (input.kind === "terminals") {
			batchDrift = await this.applyTerminals(input.terminals, input.eventId, input);
		} else if (input.kind === "user_input") this.applyUserInput(input.userInput, input.eventId, input.attentionRequestId);
		else await this.applyAttentionResolution(input.attention);
		const current = this.store.getRun()!;
		const drift = batchDrift ?? this.graphDrift(current);
		if (drift.changed) {
			if (input.kind !== "dispatch_results" && input.kind !== "terminals") {
				this.store.updateRun({ status: "paused", terminalDetail: drift.detail });
				this.store.recordEvent(run.runId, input.eventId, input.kind, input);
			}
			return this.reply(input.kind === "dispatch_results" && capacitySuppressed ? "host-backpressure" : undefined);
		}
		const reply = await this.reconcile(profile, { schedule });
		if (input.kind !== "dispatch_results" && input.kind !== "terminals") this.store.recordEvent(run.runId, input.eventId, input.kind, input);
		return reply;
	}

	private async applyDispatchResults(
		results: DispatchResult[],
		eventId: string,
		payload: EventInput,
	): Promise<{ capacityRejected: boolean; drift: { changed: boolean; detail: string | null } }> {
		const run = this.store.getRun()!;
		const driver = this.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		const prepared: PreparedDispatch[] = [];
		for (const result of results) {
			const action = this.store.getAction(result.actionId);
			if (!action || action.runId !== run.runId) throw new Error(`Unknown dispatch action ${result.actionId}`);
			// Multiple durable callers can observe the same proposed action before
			// either dispatch result is applied. Once one host wins, a stale rejection
			// must not cancel that dispatched worker; an exact accepted replay is also
			// idempotent, while a conflicting second handle still fails closed.
			if (action.state === "dispatched" || action.state === "terminal") {
				if (!result.accepted) {
					prepared.push({ result, action, plan: null, capacity: false, apply: "noop" });
					continue;
				}
				if (!result.hostHandle) throw new Error(`Accepted action ${result.actionId} has no host handle`);
				if (action.hostHandle !== result.hostHandle) {
					throw new Error(`Action ${result.actionId} was already dispatched to a different host handle`);
				}
				prepared.push({ result, action, plan: null, capacity: false, apply: "noop" });
				continue;
			}
			if (action.state === "cancelled") {
				if (result.accepted) throw new Error(`Action ${result.actionId} cannot dispatch from cancelled`);
				prepared.push({ result, action, plan: null, capacity: false, apply: "noop" });
				continue;
			}
			if (action.state !== "proposed") throw new Error(`Action ${result.actionId} cannot dispatch from ${action.state}`);
			if (!result.accepted && result.hostHandle) throw new Error(`Rejected action ${result.actionId} cannot have a host handle`);
			if (result.accepted && !result.hostHandle) throw new Error(`Accepted action ${result.actionId} has no host handle`);
			const plan = this.store.getPlan(run.runId, action.planId);
			if (!plan) throw new Error(`Action ${action.actionId} has no plan runtime record`);
			if (plan.generation !== action.generation || plan.round !== action.round) {
				throw new Error(`Action ${action.actionId} does not match plan generation/round`);
			}
			if (plan.phase !== phaseForRole(action.role as WorkerRole)) throw new Error(`Action ${action.actionId} does not own plan phase ${plan.phase}`);
			if (driver.leaseReason(plan.worktree) !== action.leaseReason) throw new Error(`Lease mismatch for ${action.actionId}`);
			prepared.push({
				result,
				action,
				plan,
				capacity: !result.accepted && /capacity|limit|slot|concurr/i.test(result.error || ""),
				apply: result.accepted ? "accepted" : "rejected",
			});
		}

		const capacityRejected = prepared.some((entry) => entry.apply === "rejected" && entry.capacity);
		const drift = this.graphDrift(this.store.getRun()!);
		this.store.transaction(() => {
			for (const entry of prepared) {
				if (entry.apply === "noop") continue;
				if (entry.apply === "accepted") {
					this.store.markDispatched(entry.action.actionId, entry.result.hostHandle!);
					continue;
				}
				this.store.markCancelled(entry.action.actionId, { error: entry.result.error || "dispatch rejected" });
				this.updatePlan(entry.plan!, { phase: readyPhaseForRole(entry.action.role) });
				if (!entry.capacity) {
					this.store.updateRun({ status: "paused", terminalDetail: `Dispatch rejected for ${entry.action.agentType}: ${entry.result.error || "unknown host error"}` });
				}
			}
			if (capacityRejected && this.store.countActions(run.runId, { states: ["dispatched"] }) === 0) {
				this.store.updateRun({ status: "paused", terminalDetail: "Host worker capacity is unavailable; resume when a child slot is free." });
			}
			if (drift.changed) this.store.updateRun({ status: "paused", terminalDetail: drift.detail });
			this.store.recordEvent(run.runId, eventId, payload.kind, payload);
		});

		for (const entry of prepared) {
			if (entry.apply !== "rejected" || !entry.plan) continue;
			try {
				driver.release(entry.plan.worktree, entry.action.leaseReason);
			} catch (error) {
				this.terminalSideEffectsDirty = true;
				process.stderr.write(`herder-run-manager: failed to release ${entry.action.leaseReason}: ${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
		return { capacityRejected, drift };
	}

	private async applyTerminals(
		terminals: TerminalEvent[],
		eventId: string,
		payload: EventInput,
	): Promise<{ changed: boolean; detail: string | null }> {
		const run = this.store.getRun()!;
		const driver = this.driver(run);
		const recoveryWasDirty = this.terminalSideEffectsDirty;
		if (terminals.length === 0) {
			const drift = this.graphDrift(this.store.getRun()!);
			this.store.transaction(() => {
				if (drift.changed) this.store.updateRun({ status: "paused", terminalDetail: drift.detail });
				this.store.recordEvent(run.runId, eventId, payload.kind, payload);
			});
			return drift;
		}
		await driver.verifyCheckout(run.checkoutStateToken);
		const prepared: PreparedTerminal[] = [];
		for (const terminal of [...terminals].sort((left, right) => left.actionId.localeCompare(right.actionId))) {
			const action = this.store.getAction(terminal.actionId);
			if (!action || action.runId !== run.runId) throw new Error(`Unknown terminal action ${terminal.actionId}`);
			if (terminal.hostHandle && action.hostHandle && terminal.hostHandle !== action.hostHandle) {
				throw new Error(`Terminal handle mismatch for ${terminal.actionId}`);
			}
			if (action.state === "terminal") {
				prepared.push({ action, terminal, plan: this.store.getPlan(run.runId, action.planId), record: storedTerminalRecord(action), transition: null });
				continue;
			}
			if (action.state !== "dispatched") throw new Error(`Action ${terminal.actionId} is not dispatched`);
			const plan = this.store.getPlan(run.runId, action.planId);
			if (!plan) throw new Error(`Action ${action.actionId} has no plan runtime record`);
			if (plan.phase !== phaseForRole(action.role as WorkerRole)) throw new Error(`Action ${action.actionId} does not own plan phase ${plan.phase}`);
			if (plan.generation !== action.generation || plan.round !== action.round) {
				throw new Error(`Action ${action.actionId} does not match plan generation/round`);
			}
			if (driver.leaseReason(plan.worktree) !== action.leaseReason) throw new Error(`Lease mismatch for ${action.actionId}`);
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
			} else if (parsed.kind === "implementer") transition = this.finishImplementer(run, plan, action, parsed);
			else if (parsed.kind === "reviewer") transition = this.finishReviewer(run, plan, action, parsed);
			else transition = this.finishJudge(run, plan, action, parsed);
			if (parsed?.kind === "judge") transition = { ...transition, leaks: parsed.leaks };
			prepared.push({ action, terminal, plan, record: terminalRecord(parsed, terminal, usage), transition });
		}

		this.terminalSideEffectsDirty = true;
		const drift = this.graphDrift(this.store.getRun()!);
		this.store.transaction(() => {
			for (const entry of prepared) {
				if (!entry.transition || !entry.record) {
					if (entry.record) this.store.insertUsageInTransaction(this.terminalUsageInput(run, entry.action, entry.record));
					continue;
				}
				const action = this.store.markTerminal(entry.action.actionId, entry.record);
				if (entry.transition.approval) this.store.putApproval(entry.transition.approval);
				if (entry.transition.attention) this.store.putAttention(entry.transition.attention);
				this.store.putPlan(entry.transition.plan);
				if (entry.transition.runUpdate) this.store.updateRun(entry.transition.runUpdate);
				if (entry.transition.reigniteRequest) {
					try {
						if (process.env.HERDER_TEST_REIGNITE_PERSIST_FAILURE === eventId) throw new Error("injected dossier failure");
						this.store.putReigniteRequest(entry.transition.reigniteRequest);
					} catch { /* A dossier failure must not roll back the terminal result. */ }
				}
				this.store.insertUsageInTransaction(this.terminalUsageInput(run, action, entry.record));
			}
			if (drift.changed) this.store.updateRun({ status: "paused", terminalDetail: drift.detail });
			this.store.recordEvent(run.runId, eventId, payload.kind, payload);
		});

		for (const entry of prepared) {
			const leaks = entry.transition?.leaks
				?? (() => {
					const result = storedWorkerResult(entry.action);
					return result?.kind === "judge" ? result.leaks : undefined;
				})();
			if (leaks) persistLeaks(this.planDirectory, entry.action.planId, leaks);
		}
		let releaseError: unknown;
		for (const entry of prepared) {
			if (!entry.plan) continue;
			if (!entry.transition && driver.leaseReason(entry.plan.worktree) !== entry.action.leaseReason) continue;
			try { driver.release(entry.plan.worktree, entry.action.leaseReason); }
			catch (error) { releaseError ??= error; }
		}
		if (releaseError) throw releaseError;
		await driver.verifyCheckout(run.checkoutStateToken);
		if (!recoveryWasDirty) this.terminalSideEffectsDirty = false;
		return drift;
	}

	private terminalUsageInput(run: StoredRun, action: StoredAction, record: StoredTerminalRecord) {
		const usage = record.usage;
		return {
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
			nestedUsage: usage.nested,
		};
	}

	private retryImplementerTransport(run: StoredRun, plan: StoredPlan, action: StoredAction, detail: string): TerminalTransition {
		const driver = this.driver(run);
		const mutationMayHaveOccurred = driver.worktreeHead(plan.worktree) !== plan.generationBase || Boolean(driver.worktreeStatus(plan.worktree));
		if (!mutationMayHaveOccurred) return this.retryTransportOrPause(run, plan, action, detail);
		if (plan.round >= MAX_PLAN_ROUNDS) {
			const terminalDetail = `${action.role} transport failed after a mutated worktree at ${action.planId} generation ${action.generation} round ${action.round}: ${detail}`;
			return {
				plan: { ...plan, phase: "NEEDS_INPUT", repair: [terminalDetail] },
				runUpdate: { status: "needs_input", terminalDetail },
				attention: this.attention({
					run,
					plan,
					spec: this.spec(run, plan.planId),
					kind: "operator_attention",
					cause: "transport_exhausted",
					actionId: action.actionId,
					state: "awaiting_input",
					continuation: { role: "plan-implementer", phase: "READY_IMPLEMENTER" },
					detail: terminalDetail,
					recommendedAction: "Choose whether to retry the recorded Implementer role; transport exhaustion never authorizes plan rewriting.",
				}),
			};
		}
		return { plan: { ...plan, phase: "READY_IMPLEMENTER", round: plan.round + 1, repair: [detail] } };
	}

	private retryTransportOrPause(run: StoredRun, plan: StoredPlan, action: StoredAction, detail: string): TerminalTransition {
		const equivalentAttempts = this.store.countActions(run.runId, {
			planId: action.planId,
			generation: action.generation,
			round: action.round,
			role: action.role,
		});
		if (equivalentAttempts < 3) {
			return { plan: { ...plan, phase: readyPhaseForRole(action.role), repair: [detail] } };
		}
		const terminalDetail = `${action.role} transport failed ${equivalentAttempts} times for ${action.planId} generation ${action.generation} round ${action.round}: ${detail}`;
		return {
			plan: { ...plan, phase: "NEEDS_INPUT", repair: [terminalDetail] },
			runUpdate: { status: "needs_input", terminalDetail },
			attention: this.attention({
				run,
				plan,
				spec: this.spec(run, plan.planId),
				kind: "operator_attention",
				cause: "transport_exhausted",
				actionId: action.actionId,
				state: "awaiting_input",
				continuation: { role: action.role as WorkerRole, phase: readyPhaseForRole(action.role) },
				detail: terminalDetail,
				recommendedAction: `Choose whether to retry the recorded ${action.role} role; transport exhaustion never authorizes plan rewriting.`,
			}),
		};
	}

	private finishImplementer(run: StoredRun, plan: StoredPlan, action: StoredAction, result: Extract<WorkerResult, { kind: "implementer" }>): TerminalTransition {
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
		const gates: GateResult[] = [];
		if (failure) {
			if (plan.round >= MAX_PLAN_ROUNDS) {
				return {
					plan: { ...plan, phase: "BLOCKED", repair: [failure], gates },
					attention: this.attention({
						run,
						plan,
						spec: this.spec(run, plan.planId),
						kind: "plan_recovery",
						cause: "implementer_exhausted",
						result,
						actionId: action.actionId,
						state: "pending",
						continuation: { role: "plan-implementer", phase: "READY_IMPLEMENTER" },
						detail: failure,
						recommendedAction: "Repair or explicitly revise only the target plan, then resume the recorded Implementer continuation.",
					}),
				};
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
		const verdict = result.verdict;
		if (plan.planId === "RUN") {
			const verification = this.store.getVerification(run.runId, plan.generation);
			if (!verification) {
				const detail = "Legacy final Reviewer evidence was discarded; exact-tree verification is required.";
				return {
					plan: { ...plan, phase: "BLOCKED", reviewPass: plan.reviewPass + 1, repair: [detail] },
					runUpdate: { status: "paused", terminalDetail: detail },
				};
			}
			if (verification.state !== "passed"
				|| verification.request.integrationHead !== plan.approvedHead
				|| verification.request.integrationTree !== plan.approvedTree) {
				throw new Error("Final Reviewer is not bound to passed verification evidence for its frozen tree");
			}
			return {
				plan: { ...plan, phase: "FINAL_APPROVED", reviewPass: plan.reviewPass + 1, findings: result.findings },
				reigniteRequest: this.buildReigniteDossier(run, plan, result, verification),
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
		const detail = result.rationale || result.findings[0] || "Reviewer blocked the plan";
		return {
			plan: { ...reviewed, phase: "BLOCKED", repair: [detail] },
			attention: this.attention({
				run,
				plan,
				spec: this.spec(run, plan.planId),
				kind: "plan_recovery",
				cause: decision.action === "BLOCKED_ROUND_LIMIT" ? "round_limit" : "reviewer_blocked",
				result,
				actionId: action.actionId,
				state: "pending",
				continuation: { role: "plan-reviewer", phase: "READY_REVIEWER" },
				detail,
				recommendedAction: "Repair or explicitly revise only the target plan, then resume the recorded Reviewer continuation.",
			}),
		};
	}

	private buildReigniteDossier(
		run: StoredRun,
		plan: StoredPlan,
		result: Extract<WorkerResult, { kind: "reviewer" }>,
		verification: StoredVerification,
	): ReigniteRequest {
		const existing = this.store.getReigniteRequest(run.runId, plan.generation);
		const state = result.findings.some(isActionableReigniteFinding) ? "pending" : "skipped";
		return createReigniteRequest({
			requestId: existing?.requestId ?? randomUUID(),
			runId: run.runId,
			generation: plan.generation,
			sourcePlanDirectory: run.planDirectory,
			graphSha256: run.graphSha256,
			integrationHead: verification.request.integrationHead,
			integrationTree: verification.request.integrationTree,
			integrationBranch: verification.request.integrationBranch,
			verdict: result.verdict,
			scope: result.scope,
			findings: result.findings,
			fixGuidance: result.fixGuidance,
			rationale: result.rationale,
			createdAt: existing?.createdAt ?? new Date().toISOString(),
			state,
		});
	}

	private finishJudge(run: StoredRun, plan: StoredPlan, action: StoredAction, result: Extract<WorkerResult, { kind: "judge" }>): TerminalTransition {
		const driver = this.driver(run);
		driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256);
		if (driver.worktreeHead(plan.worktree) !== plan.approvedHead || driver.worktreeTree(plan.worktree) !== plan.approvedTree || driver.worktreeStatus(plan.worktree)) {
			throw new Error(`Judge mutated frozen plan ${plan.planId}`);
		}
		const decision = decideJudge({ round: plan.round, decision: result.decision });
		if (decision.action === "READY_TO_INTEGRATE") {
			if (!plan.approvedBase || !plan.approvedHead || !plan.approvedTree) throw new Error(`Judge approval has no frozen patch for ${plan.planId}`);
			const reviewer = this.store.getLatestAction(run.runId, {
				planId: plan.planId,
				generation: plan.generation,
				round: plan.round,
				role: "plan-reviewer",
				state: "terminal",
			});
			const reviewResult = reviewer ? storedWorkerResult(reviewer) : null;
			if (!reviewer || !reviewResult || reviewResult.kind !== "reviewer") throw new Error(`Judge cannot approve ${plan.planId} without a terminal Reviewer result`);
			const approval = createApproval({
				runId: run.runId, planId: plan.planId, generation: plan.generation, round: plan.round,
				reviewerActionId: reviewer.actionId, decisionActionId: action.actionId, decisionRole: "plan-judge",
				assignmentSha256: plan.assignmentSha256, approvedBase: plan.approvedBase,
				approvedHead: plan.approvedHead, approvedTree: plan.approvedTree,
				reviewResultSha256: sha256(stableJson(reviewResult)), decisionResultSha256: sha256(stableJson(result)),
			});
			return { plan: { ...plan, phase: "READY_TO_INTEGRATE", findings: result.findings, repair: [] }, approval, leaks: result.leaks };
		} else if (decision.action === "REPAIR_GUIDED") {
			return { plan: { ...plan, phase: "READY_IMPLEMENTER", round: decision.nextRound!, findings: result.findings, repair: result.repairContracts } };
		} else if (decision.action === "NEEDS_INPUT") {
			const terminalDetail = result.question || result.rationale;
			return {
				plan: { ...plan, phase: "NEEDS_INPUT", findings: result.findings, repair: [terminalDetail] },
				runUpdate: { status: "needs_input", terminalDetail },
				attention: this.attention({
					run,
					plan,
					spec: this.spec(run, plan.planId),
					kind: "user_decision",
					cause: "judge_needs_input",
					actionId: action.actionId,
					state: "awaiting_input",
					continuation: { role: "plan-judge", phase: "READY_JUDGE" },
					detail: terminalDetail,
					question: result.question || terminalDetail,
					recommendedAction: "Answer the Judge question while preserving the recorded plan and review evidence.",
				}),
			};
		}
		const terminalDetail = result.rationale || result.findings[0] || (decision.action === "BLOCKED_ROUND_LIMIT" ? "Judge round limit exhausted" : "Judge blocked the plan");
		const cause: AttentionCause = decision.action === "BLOCKED_ROUND_LIMIT" ? "round_limit" : "judge_blocked";
		return {
			plan: { ...plan, phase: "BLOCKED", findings: result.findings, repair: [terminalDetail] },
			attention: this.attention({
				run,
				plan,
				spec: this.spec(run, plan.planId),
				kind: "plan_recovery",
				cause,
				actionId: action.actionId,
				state: "pending",
				continuation: { role: "plan-judge", phase: "READY_JUDGE" },
				detail: terminalDetail,
				recommendedAction: "Repair or explicitly revise only the target plan, then resume the recorded Judge continuation.",
			}),
		};
	}

	private applyUserInput(value: string, eventId: string, attentionRequestId?: string): void {
		if (!attentionRequestId) throw new Error("User input requires an attention request ID");
		const run = this.store.getRun()!;
		const marker = `USER_INPUT [${eventId}]: ${value}`;
		const plans = this.store.getPlans(run.runId);
		const suppliedAttention = this.store.getAttention(attentionRequestId);
		// The event may have committed its plan/attention transaction before the
		// process was replaced and before the event journal write. Recognize that
		// durable marker only on the explicitly bound request's plan.
		if (suppliedAttention?.runId === run.runId && plans.some((plan) => plan.planId === suppliedAttention.planId && plan.repair.includes(marker))) return;
		if (run.status !== "needs_input") throw new Error("Run is not waiting for user input");

		// Recovery dossiers are record-only in this phase. They retain the
		// deterministic global attention order, but must not mask an input-bearing
		// dossier when selecting a user answer.
		const nextInputAttention = this.store.getNextInputAttention(run.runId);
		if (!nextInputAttention) throw new Error("No durable attention request is waiting for user input");
		const attention = suppliedAttention;
		if (!attention || attention.runId !== run.runId || attention.state === "resolved") {
			throw new Error(`Attention request ${attentionRequestId} is not an unresolved request for this run`);
		}
		if (!["user_decision", "operator_attention"].includes(attention.kind)) {
			throw new Error(`Attention request ${attention.requestId} does not accept user input`);
		}
		if (attention.requestId !== nextInputAttention.requestId) {
			throw new Error(`Attention request ${attention.requestId} is not the next eligible input request`);
		}
		const plan = this.store.getPlan(run.runId, attention.planId);
		if (!plan || plan.phase !== "NEEDS_INPUT") throw new Error(`Attention request ${attention.requestId} has no matching input-waiting plan`);
		if (plan.generation !== attention.generation || plan.round !== attention.round) {
			throw new Error(`Attention request ${attention.requestId} does not match the input-waiting generation and round`);
		}
		if (readyPhaseForRole(attention.continuation.role) !== attention.continuation.phase) {
			throw new Error(`Attention request ${attention.requestId} has an invalid continuation phase`);
		}
		this.store.transaction(() => {
			this.updatePlan(plan, {
				phase: attention.continuation.phase,
				repair: [...plan.repair, marker],
			});
			this.store.resolveAttention(attention.requestId);
			const remainingInput = this.store.getNextInputAttention(run.runId);
			const remaining = this.store.getNextAttention(run.runId);
			this.store.updateRun({
				status: remainingInput ? "needs_input" : "running",
				terminalDetail: remainingInput?.detail ?? remaining?.detail ?? null,
			});
		});
	}

	private attentionResolutionRequest(run: StoredRun, resolution: AttentionResolutionInput) {
		validateAttentionResolution(resolution);
		const attention = this.store.getAttention(resolution.requestId);
		if (!attention || attention.runId !== run.runId) throw new Error(`Attention request ${resolution.requestId} is not recorded for this run`);
		if (resolution.requestSha256 !== attention.requestSha256) {
			throw new Error(`Attention request ${resolution.requestId} hash does not match its immutable evidence`);
		}
		const expectedCapability = attention.capabilityToken || attentionCapabilityToken(attention.requestId);
		if (resolution.capabilityToken !== expectedCapability) {
			throw new Error(`Attention request ${resolution.requestId} capability token does not match`);
		}
		if (resolution.runId !== attention.runId || resolution.planId !== attention.planId
			|| resolution.generation !== attention.generation || resolution.round !== attention.round) {
			throw new Error(`Attention resolution identity does not match request ${attention.requestId}`);
		}
		if (resolution.continuation && stableJson(resolution.continuation) !== stableJson(attention.continuation)) {
			throw new Error(`Attention resolution continuation does not match request ${attention.requestId}`);
		}
		const next = this.store.getNextAttention(run.runId);
		if (attention.state === "resolved") {
			const priorResolution = this.store.readEvent(`manager-attention-resolution:${attention.requestId}`)?.payloadSha256
				?? this.store.getAttentionResolutionHash(attention.requestId);
			if (priorResolution && priorResolution !== sha256(stableJson(resolution))) {
				throw new Error(`Attention request ${attention.requestId} was replayed with a different resolution`);
			}
			return attention;
		}
		if (next && next.requestId !== attention.requestId) {
			throw new Error(`Attention request ${attention.requestId} is not the next eligible request`);
		}
		return attention;
	}

	private attentionStatusAfterResolution(runId: string): void {
		const nextInput = this.store.getNextInputAttention(runId);
		const next = this.store.getNextAttention(runId);
		this.store.updateRun({
			status: nextInput ? "needs_input" : "running",
			terminalDetail: nextInput?.detail ?? next?.detail ?? null,
		});
	}

	private validateRecoveryTarget(
		run: StoredRun,
		attention: Extract<ManagerAttentionRequest, { kind: "plan_recovery" }>,
		action: AttentionResolutionAction,
		resolution: AttentionResolutionInput,
	): {
		plan: StoredPlan | null;
		prior: StoredPlanSpec;
		compiled: { specs: StoredPlanSpec[]; graphSha256: string };
		nextSpecs: StoredPlanSpec[];
		targetChanged: boolean;
	} {
		const recordedSpecs = this.store.getPlanSpecs(run.runId, attention.generation);
		const recorded = recordedSpecs.find((spec) => spec.planId === attention.planId);
		if (!recorded) throw new Error(`Recovery request ${attention.requestId} has no recorded target specification`);
		if (attention.recovery.planFingerprint !== recorded.planFingerprint
			|| attention.recovery.fingerprintVersion !== recorded.fingerprintVersion
			|| attention.recovery.planFile !== recorded.planFile) {
			throw new Error(`Recovery request ${attention.requestId} does not match its recorded target evidence`);
		}
		const currentSpecs = this.store.getPlanSpecs(run.runId, run.currentGeneration);
		if (recordedSpecs.length !== currentSpecs.length) {
			throw new Error(`Recovery request ${attention.requestId} no longer matches the recorded plan graph`);
		}
		for (const recordedSpec of recordedSpecs) {
			const currentSpec = currentSpecs.find((spec) => spec.planId === recordedSpec.planId);
			if (!currentSpec || !sameRecoveryGraphIdentity(recordedSpec, currentSpec)) {
				throw new Error(`Recovery request ${attention.requestId} no longer matches the recorded plan graph`);
			}
		}
		const currentTarget = currentSpecs.find((spec) => spec.planId === attention.planId);
		if (!currentTarget) throw new Error(`Recovery request ${attention.requestId} has no current target specification`);
		if (!sameRecoverySpecIdentity(recorded, currentTarget)) {
			throw new Error(`Recovery request ${attention.requestId} no longer matches its immutable target specification`);
		}
		const priorSpecs = run.currentGeneration === attention.generation ? recordedSpecs : currentSpecs;
		const plan = this.store.getPlan(run.runId, attention.planId);
		if (plan && (plan.generation !== attention.generation || plan.round !== attention.round)) {
			throw new Error(`Recovery request ${attention.requestId} does not match the target runtime generation and round`);
		}
		if (plan && plan.phase !== "BLOCKED" && plan.phase !== "NEEDS_INPUT") {
			throw new Error(`Recovery target ${attention.planId} is no longer blocked`);
		}
		if (!plan && attention.cause !== "initial_decision_blocked") {
			throw new Error(`Recovery target ${attention.planId} has no blocked runtime record`);
		}
		const expected = recoveryIdentityFromRequest(attention);
		const supplied = resolution.git;
		if (!expected || !supplied || !sameRecoveryIdentity(expected, supplied)) {
			throw new Error(`Recovery request ${attention.requestId} is not bound to its recorded Git identity`);
		}
		if (plan) {
			if (plan.branch !== expected.branch || plan.worktree !== expected.worktree
				|| plan.assignmentPath !== expected.assignmentPath || plan.assignmentSha256 !== expected.assignmentSha256
				|| plan.snapshotSha256 !== expected.snapshotSha256 || plan.generationBase !== expected.generationBase) {
				throw new Error(`Recovery target ${attention.planId} runtime evidence changed`);
			}
			const driver = this.driver(run);
			try {
				driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256);
			} catch (error) {
				if (attention.state !== "editing" || !/not a regular file|missing|cannot change (?:directory|to)|no such file/i.test(error instanceof Error ? error.message : String(error))) throw error;
			}
			if (expected.worktreeHead !== null) {
				try {
					if (driver.worktreeHead(plan.worktree) !== expected.worktreeHead) throw new Error(`Recovery target ${attention.planId} worktree HEAD changed`);
					if (expected.worktreeTree !== null && driver.worktreeTree(plan.worktree) !== expected.worktreeTree) {
						throw new Error(`Recovery target ${attention.planId} worktree tree changed`);
					}
				} catch (error) {
					if (attention.state !== "editing" || !/not a git repository|no such file|does not exist|cannot change (?:directory|to)/i.test(error instanceof Error ? error.message : String(error))) throw error;
				}
			}
			try {
				const lease = driver.leaseReason(plan.worktree);
				if (lease) throw new Error(`Recovery target ${attention.planId} is still leased`);
			} catch (error) {
				if (!/not registered/i.test(error instanceof Error ? error.message : String(error)) || attention.state !== "editing") throw error;
			}
		} else {
			this.driver(run).verifyAssignment(run.integrationWorktree, expected.assignmentPath, expected.assignmentSha256);
		}
		const activeTargetActions = this.store.getActions(run.runId, ["proposed", "dispatched"])
			.filter((candidate) => candidate.planId === attention.planId);
		if (activeTargetActions.length > 0) throw new Error(`Recovery target ${attention.planId} still owns active worker actions`);

		const compiled = this.compileCurrentGraph(run, run.currentGeneration + 1);
		const { prior, target } = validateTargetOnlyGraph(priorSpecs, compiled.specs, attention.planId, "Recovery revision", "Recovery target");
		const targetChanged = target.planFingerprint !== prior.planFingerprint;
		if (["unchanged_retry", "accept", "stop"].includes(action) && targetChanged) throw new Error("Unchanged recovery requires graph-equivalent target content");
		if (action === "revise" && !targetChanged) throw new Error("Target revision did not change the compiled target content");
		if (["unchanged_retry", "reject", "accept", "stop"].includes(action) && !(resolution.rationale || "").trim()) {
			throw new Error(`${action === "reject" ? "Recovery rejection" : "Unchanged recovery"} requires a non-empty rationale`);
		}
		this.assertNoNewActivePathOverlap(run, priorSpecs, prior, target, "Recovery");
		const rejected = action === "reject" || action === "cancel";
		const nextSpecs: StoredPlanSpec[] = compiled.specs.map((spec) => spec.planId === attention.planId
			? {
				...spec,
				initialStatus: (rejected ? "REJECTED" : "TODO") as StoredPlanSpec["initialStatus"],
				initialStatusDetail: rejected
					? (resolution.rationale?.trim() || "Recovery was rejected by the main session.")
					: "",
			}
			: spec);
		return { plan, prior, compiled, nextSpecs, targetChanged };
	}

	private async applyAttentionResolution(resolution: AttentionResolutionInput): Promise<void> {
		const run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		const attention = this.attentionResolutionRequest(run, resolution);
		if (attention.state === "resolved") return;
		const action = normalizeAttentionAction(String(resolution.action));
		if (action === "defer") return;
		if (attention.kind === "plan_recovery") {
			if (action === "accept" || action === "stop") {
				const driver = this.driver(run);
				await driver.verifyCheckout(run.checkoutStateToken);
				const { plan } = this.validateRecoveryTarget(run, attention, action, resolution);
				let approval: Omit<StoredApproval, "createdAt"> | undefined;
				if (action === "accept") {
					if (resolution.confirmed !== true || !resolution.answer?.trim() || !resolution.rationale?.trim()) {
						throw new Error("Acceptance requires explicit confirmation, accepted gaps and rationale");
					}
					if (!plan || plan.round !== MAX_PLAN_ROUNDS) throw new Error("Acceptance requires a terminal round-3 reviewed tree");
					if (plan.rebase || ["rebase-merge", "rebase-apply"].some((name) => fs.existsSync(gitValue(plan.worktree, "rev-parse", "--path-format=absolute", "--git-path", name)))
						|| driver.worktreeStatus(plan.worktree)) throw new Error("Acceptance requires a clean worktree without an active rebase");
					if (!plan.approvedBase || !plan.approvedHead || !plan.approvedTree
						|| plan.approvedBase !== attention.recovery.generationBase
						|| plan.approvedHead !== attention.recovery.worktreeHead || plan.approvedTree !== attention.recovery.worktreeTree
						|| driver.changedPaths(plan.worktree, plan.approvedBase).length === 0) {
						throw new Error("Acceptance requires the exact nonempty frozen reviewed patch");
					}
					const reviewer = this.store.getLatestAction(run.runId, { planId: plan.planId, generation: plan.generation,
						round: plan.round, role: "plan-reviewer", state: "terminal" });
					const result = reviewer ? storedWorkerResult(reviewer) : null;
					if (!reviewer || reviewer.actionId !== attention.actionId || result?.kind !== "reviewer") {
						throw new Error("Acceptance requires the recovery request's terminal round-3 Reviewer evidence");
					}
					approval = createApproval({
						runId: run.runId, planId: plan.planId, generation: plan.generation, round: plan.round,
						reviewerActionId: reviewer.actionId, decisionActionId: reviewer.actionId, decisionRole: "user",
						assignmentSha256: plan.assignmentSha256, approvedBase: plan.approvedBase,
						approvedHead: plan.approvedHead, approvedTree: plan.approvedTree,
						reviewResultSha256: sha256(stableJson(result)), decisionResultSha256: sha256(stableJson(resolution)),
						userAcceptance: resolution,
					});
				}
				this.store.transaction(() => {
					if (approval) this.store.putApproval(approval);
					if (plan) this.updatePlan(plan, { phase: action === "accept" ? "READY_TO_INTEGRATE" : "BLOCKED" });
					this.store.recordEvent(run.runId, `manager-attention-resolution:${attention.requestId}`, "attention_resolution", resolution);
					this.store.resolveAttention(attention.requestId);
					this.attentionStatusAfterResolution(run.runId);
				});
				return;
			}
			if (!["unchanged_retry", "revise", "reject", "retry", "cancel"].includes(action)) {
				throw new Error(`Action ${action} cannot resolve plan-recovery attention`);
			}
			const recoveryAction = action === "retry" ? "unchanged_retry" : action === "cancel" ? "reject" : action;
			if (recoveryAction === "unchanged_retry" && attention.round >= MAX_PLAN_ROUNDS) {
				throw new Error("Exhausted round-3 recovery requires accept, stop, or an explicit target revision");
			}
			if (recoveryAction === "revise" && !(resolution.rationale || "").trim()) {
				throw new Error("Target revision requires a non-empty rationale");
			}
			const driver = this.driver(run);
			await driver.verifyCheckout(run.checkoutStateToken);
			const validation = this.validateRecoveryTarget(run, attention, recoveryAction, resolution);
			const cleanupIdentity = {
				runId: run.runId,
				requestId: attention.requestId,
				requestSha256: attention.requestSha256,
				planId: attention.planId,
				generation: attention.generation,
				round: attention.round,
				assignmentPath: attention.recovery.assignmentPath,
				assignmentSha256: attention.recovery.assignmentSha256,
				snapshotSha256: attention.recovery.snapshotSha256,
				generationBase: attention.recovery.generationBase,
				branch: attention.recovery.branch,
				worktree: attention.recovery.worktree,
				expectedHead: attention.recovery.worktreeHead,
				expectedTree: attention.recovery.worktreeTree,
			};
			const recordedCleanup = this.store.getAttentionCleanupEvidence(cleanupIdentity);
			this.store.beginRecoveryEdit(attention.requestId);
			driver.resetPlanExecution({
				branch: attention.recovery.branch,
				worktree: attention.recovery.worktree,
				expectedHead: attention.recovery.worktreeHead,
				expectedTree: attention.recovery.worktreeTree,
				cleanupIdentity,
				recordedCleanup: recordedCleanup ?? undefined,
				onPrepare: (step) => this.store.recordAttentionCleanupStep(cleanupIdentity, step),
				onProgress: (step) => this.store.recordAttentionCleanupCompletion(cleanupIdentity, step),
				onComplete: (step) => this.store.recordAttentionCleanupCompletion(cleanupIdentity, step),
			});
			const nextGeneration = run.currentGeneration + 1;
			const integrationHead = driver.branchHead(run.integrationBranch);
			const assignment = driver.materializeRunAssignment(integrationHead, validation.nextSpecs.map((spec) => spec.assignment), nextGeneration);
			this.store.transaction(() => {
				this.store.putPlanSpecs(validation.nextSpecs);
				this.store.putGeneration({
					runId: run.runId,
					generation: nextGeneration,
					graphSha256: validation.compiled.graphSha256,
					parentGeneration: run.currentGeneration,
					runAssignmentPath: assignment.bundlePath,
					runAssignmentSha256: assignment.bundleSha256,
					runSnapshotSha256: assignment.snapshotSha256,
				});
				this.store.deletePlan(run.runId, attention.planId);
				this.store.resolveAttention(attention.requestId);
				this.store.updateRun({
					currentGeneration: nextGeneration,
					graphSha256: validation.compiled.graphSha256,
					status: this.store.getNextInputAttention(run.runId) ? "needs_input" : "running",
					terminalDetail: resolution.rationale?.trim() || `Recovery applied for plan ${attention.planId}.`,
				});
			});
			this.cacheSpecs(validation.nextSpecs);
			return;
		}
		if (!["answer", "retry", "cancel"].includes(action)) throw new Error(`Action ${action} cannot resolve ${attention.kind} attention`);
		if (attention.kind === "user_decision" && action === "answer" && !(resolution.answer || "").trim()) {
			throw new Error(`Attention request ${attention.requestId} requires an answer`);
		}
		const plan = this.store.getPlan(run.runId, attention.planId);
		if (!plan || plan.generation !== attention.generation || plan.round !== attention.round || plan.phase !== "NEEDS_INPUT") {
			throw new Error(`Attention request ${attention.requestId} has no matching input-waiting continuation`);
		}
		const continuationPhase = attention.continuation.phase;
		const marker = action === "cancel"
			? `ATTENTION_CANCEL [${attention.requestId}]: ${(resolution.rationale || resolution.answer || "operator cancelled").trim()}`
			: `ATTENTION_ANSWER [${attention.requestId}]: ${(resolution.answer || resolution.rationale || "retry").trim()}`;
		this.store.transaction(() => {
			this.updatePlan(plan, {
				phase: action === "cancel" ? "BLOCKED" : continuationPhase,
				repair: [...plan.repair, marker],
			});
			this.store.resolveAttention(attention.requestId);
			this.attentionStatusAfterResolution(run.runId);
		});
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
		const reviewerResult = storedWorkerResult(reviewer);
		const decisionResult = decision ? storedWorkerResult(decision) : null;
		if (!reviewerResult || reviewerResult.kind !== "reviewer"
			|| sha256(stableJson(reviewerResult)) !== approval.reviewResultSha256) {
			throw new Error(`Reviewer result proof changed for ${plan.planId}`);
		}
		if (approval.decisionRole === "user") {
			const resolution = approval.userAcceptance;
			if (!resolution) throw new Error(`Human approval lacks its acceptance evidence for ${plan.planId}`);
			validateAttentionResolution(resolution);
			const request = this.store.getAttention(resolution.requestId);
			const latest = this.store.getLatestAction(run.runId, { planId: plan.planId, generation: plan.generation,
				round: plan.round, role: "plan-reviewer", state: "terminal" });
			if (!request || request.kind !== "plan_recovery" || request.state !== "resolved"
				|| request.requestSha256 !== attentionRequestSha256(request) || resolution.requestSha256 !== request.requestSha256
				|| resolution.capabilityToken !== (request.capabilityToken || attentionCapabilityToken(request.requestId))
				|| normalizeAttentionAction(resolution.action) !== "accept" || resolution.confirmed !== true || !resolution.answer?.trim() || !resolution.rationale?.trim()
				|| request.runId !== run.runId || request.planId !== plan.planId || request.generation !== plan.generation || request.round !== MAX_PLAN_ROUNDS
				|| resolution.runId !== request.runId || resolution.planId !== request.planId || resolution.generation !== request.generation || resolution.round !== request.round
				|| plan.round !== MAX_PLAN_ROUNDS || approval.decisionActionId !== reviewer.actionId || request.actionId !== reviewer.actionId || latest?.actionId !== reviewer.actionId
				|| !resolution.git || !sameRecoveryIdentity(resolution.git, recoveryIdentityFromRequest(request)!)
				|| request.recovery.assignmentPath !== plan.assignmentPath || request.recovery.assignmentSha256 !== plan.assignmentSha256
				|| request.recovery.snapshotSha256 !== plan.snapshotSha256 || request.recovery.branch !== plan.branch || request.recovery.worktree !== plan.worktree
				|| request.recovery.generationBase !== approval.approvedBase || request.recovery.worktreeHead !== approval.approvedHead || request.recovery.worktreeTree !== approval.approvedTree
				|| sha256(stableJson(resolution)) !== approval.decisionResultSha256) {
				throw new Error(`Human acceptance proof changed for ${plan.planId}`);
			}
			const recordedHash = this.store.readEvent(`manager-attention-resolution:${request.requestId}`)?.payloadSha256
				?? this.store.getAttentionResolutionHash(request.requestId);
			if (recordedHash && recordedHash !== approval.decisionResultSha256) throw new Error(`Human resolution proof changed for ${plan.planId}`);
			return completionApproval(approval);
		}
		if (!decision || decision.runId !== run.runId || decision.planId !== plan.planId
			|| decision.generation !== plan.generation || decision.round !== plan.round
			|| decision.role !== approval.decisionRole || decision.state !== "terminal") {
			throw new Error(`Approval for ${plan.planId} lacks its exact terminal decision action`);
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

	private async recoverTerminalSideEffects(run: StoredRun, driver: GitDriver): Promise<void> {
		if (!this.terminalSideEffectsDirty) return;
		for (const action of this.store.getActions(run.runId).filter((candidate) => candidate.state === "terminal")) {
			const result = storedWorkerResult(action);
			if (result?.kind === "judge") persistLeaks(this.planDirectory, action.planId, result.leaks);
		}
		this.store.transaction(() => {
			for (const action of this.store.getTerminalActionsMissingUsage(run.runId)) {
				const record = storedTerminalRecord(action);
				if (!record) throw new Error(`Terminal action ${action.actionId} has no durable result envelope`);
				this.store.insertUsageInTransaction(this.terminalUsageInput(run, action, record));
			}
		});
		const terminalLeases = this.store.getTerminalLeaseReasons(run.runId);
		for (const plan of this.store.getPlans(run.runId)) {
			const lease = driver.leaseReason(plan.worktree);
			if (lease && terminalLeases.has(lease)) driver.release(plan.worktree, lease);
		}
		await driver.verifyCheckout(run.checkoutStateToken);
		this.terminalSideEffectsDirty = false;
	}

	private async reconcile(profile: ResolvedProfile, options: { schedule?: boolean } = {}): Promise<ManagerReply> {
		let run = this.store.getRun();
		if (!run) throw new Error("No deterministic Herder run exists");
		if (run.status !== "running" && run.status !== "needs_input") return this.reply();
		const driver = this.driver(run);
		await driver.verifyCheckout(run.checkoutStateToken);
		await this.recoverTerminalSideEffects(run, driver);
		this.ensureInitialAttention(run);

		await this.integrateReadyPlans(run, driver);
		const edit = await this.adoptPendingEditBarrier(run, driver);
		if (edit.reply) return edit.reply;
		run = edit.run;
		const audit = await this.prepareFinalAuditHandoff(run, driver);
		if (audit.reply) return audit.reply;
		run = audit.run;
		return this.scheduleAndSettle(run, driver, profile, options);
	}

	private async integrateReadyPlans(run: StoredRun, driver: GitDriver): Promise<void> {
		for (const plan of this.store.getPlans(run.runId).filter((candidate) => candidate.phase === "READY_TO_INTEGRATE").sort((a, b) => a.planId.localeCompare(b.planId))) {
			if (!plan.approvedBase || !plan.approvedHead || !plan.approvedTree) throw new Error(`Plan ${plan.planId} has no approved integration surface`);
			const approval = this.store.getApproval(run.runId, plan.planId, plan.generation);
			if (!approval) throw new Error(`Plan ${plan.planId} has no durable approval proof`);
			const completionProof = this.validateApproval(run, plan, approval);
			driver.verifyAssignment(plan.worktree, plan.assignmentPath, plan.assignmentSha256);
			if (driver.leaseReason(plan.worktree)) throw new Error(`Approved plan ${plan.planId} is still leased`);
			const integration = driver.integrate({
				planId: plan.planId,
				branch: plan.branch,
				worktree: plan.worktree,
				approvedBase: plan.approvedBase,
				approvedHead: plan.approvedHead,
				approvedTree: plan.approvedTree,
				generation: plan.generation,
				checkpointOrdinal: plan.reviewPass || 1,
				approval: completionProof,
			});
			if (integration.status === "conflict") {
				if (plan.round >= MAX_PLAN_ROUNDS) {
					const latestAction = this.store.getActions(run.runId)
						.filter((candidate) => candidate.planId === plan.planId && candidate.generation === plan.generation && candidate.round === plan.round && candidate.state === "terminal")
						.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.actionId.localeCompare(left.actionId))[0];
					const detail = `Integration conflict recovery exhausted for ${plan.planId} at generation ${plan.generation} round ${plan.round}.`;
					this.store.transaction(() => {
						this.updatePlan(plan, { phase: "BLOCKED", repair: [detail] });
						this.store.putAttention(this.attention({
							run: run!,
							plan,
							spec: this.spec(run!, plan.planId),
							kind: "plan_recovery",
							cause: "integration_conflict_exhausted",
							actionId: latestAction?.actionId ?? null,
							state: "pending",
							continuation: { role: "plan-implementer", phase: "READY_IMPLEMENTER" },
							detail,
							recommendedAction: "Repair or explicitly revise only the target plan, then resume its recorded Implementer continuation.",
						}));
					});
				} else {
					if (!integration.checkpointRef || !integration.checkpoint || !integration.onto || !integration.detachedHead) {
						throw new Error(`Restack conflict for ${plan.planId} lacks sealed recovery evidence`);
					}
					const conflictRunId = run.runId;
					const rebase = {
						checkpointRef: integration.checkpointRef,
						checkpoint: integration.checkpoint,
						onto: integration.onto,
						detachedHead: integration.detachedHead,
					};
					this.store.transaction(() => {
						this.store.deleteApproval(conflictRunId, plan.planId, plan.generation);
						this.updatePlan(plan, {
							phase: "READY_IMPLEMENTER",
							round: plan.round + 1,
							repair: [`Preserved conflicted rebase: checkpoint=${rebase.checkpointRef}; onto=${rebase.onto}; detached=${rebase.detachedHead}`],
							rebase,
						});
					});
				}
				break;
			}
			this.updatePlan(plan, { phase: "DONE", approvedHead: integration.head!, approvedTree: driver.worktreeTree(plan.worktree), rebase: null });
		}
	}

	private async adoptPendingEditBarrier(
		run: StoredRun,
		driver: GitDriver,
	): Promise<{ run: StoredRun; reply?: ManagerReply }> {
		run = this.store.getRun()!;
		if (run.status !== "running" && run.status !== "needs_input") return { run, reply: this.reply() };
		const pendingEdit = this.store.getPlanEdit(run.runId);
		if (pendingEdit?.state === "barrier") {
			if (this.reservedEditIsRework(run, pendingEdit.planId) || activeActionCount(this.store, run.runId) > 0) {
				await driver.verifyCheckout(run.checkoutStateToken);
				return { run, reply: this.reply("revision-barrier") };
			}
			this.adoptReservedEdit(run, pendingEdit);
			run = this.store.getRun()!;
		}
		return { run };
	}

	private async prepareFinalAuditHandoff(
		run: StoredRun,
		driver: GitDriver,
	): Promise<{ run: StoredRun; reply?: ManagerReply }> {
		const current = this.store.getPlans(run.runId);
		const overview = summarizeRun(this.specs(run), current);
		if (overview.complete && activeActionCount(this.store, run.runId) === 0) {
			const finalPlan = current.find((plan) => plan.planId === "RUN");
			if (finalPlan?.phase === "FINAL_APPROVED") {
				const verification = this.store.getVerification(run.runId, finalPlan.generation);
				if (verification?.state !== "passed"
					|| verification.request.integrationHead !== finalPlan.approvedHead
					|| verification.request.integrationTree !== finalPlan.approvedTree) {
					const detail = "Final completion is blocked; exact-tree verification is required.";
					this.store.transaction(() => {
						this.updatePlan(finalPlan, { phase: "BLOCKED", repair: [detail] });
						this.store.updateRun({ status: "paused", terminalDetail: detail });
					});
					this.projectLifecycleBestEffort();
					return { run, reply: this.reply() };
				}
				this.store.updateRun({ status: "complete", terminalDetail: "All plans integrated and final audit approved." });
				this.projectLifecycleBestEffort();
				return { run, reply: this.refreshReply() };
			}
			if (!finalPlan) {
				const generation = this.store.getGeneration(run.runId, run.currentGeneration);
				if (!generation) throw new Error(`Run generation ${run.currentGeneration} has no assignment evidence`);
				const assignmentPath = generation.runAssignmentPath;
				const bytes = fs.readFileSync(assignmentPath);
				if (sha256(bytes) !== generation.runAssignmentSha256) throw new Error(`Run assignment changed for generation ${run.currentGeneration}`);
				const assignment = JSON.parse(bytes.toString("utf8")) as { snapshotSha256: string; assignment: { generationBase: string } };
				const integrationHead = driver.branchHead(run.integrationBranch);
				const integrationTree = driver.worktreeTree(run.integrationWorktree);
				const verification = this.store.getVerification(run.runId, run.currentGeneration);
				if (!verification) {
					const request = createVerificationRequest({
						requestId: randomUUID(),
						runId: run.runId,
						generation: run.currentGeneration,
						graphSha256: run.graphSha256,
						runAssignmentPath: assignmentPath,
						runAssignmentSha256: generation.runAssignmentSha256,
						integrationBranch: run.integrationBranch,
						integrationWorktree: run.integrationWorktree,
						integrationHead,
						integrationTree,
						requestedAt: new Date().toISOString(),
					});
					this.store.transaction(() => {
						this.store.putVerificationRequest(request);
						this.store.updateRun({ status: "paused", terminalDetail: MAIN_SESSION_VERIFICATION_PAUSE_DETAIL });
					});
					return { run, reply: this.reply() };
				}
				if (verification.state !== "passed") {
					if (run.status !== "paused") this.store.updateRun({ status: "paused", terminalDetail: verification.terminalDetail || "Waiting for final verification." });
					return { run, reply: this.reply() };
				}
				if (verification.request.integrationHead !== integrationHead || verification.request.integrationTree !== integrationTree) {
					throw new Error("Passed verification no longer matches the integration branch");
				}
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
					gates: [verification.result],
					approvedBase: run.baseCommit,
					approvedHead: integrationHead,
					approvedTree: integrationTree,
					rebase: null,
				});
			}
		}
		return { run };
	}

	private async scheduleAndSettle(
		run: StoredRun,
		driver: GitDriver,
		profile: ResolvedProfile,
		options: { schedule?: boolean },
	): Promise<ManagerReply> {
		if (options.schedule !== false) {
			await this.schedule(profile);
			const scheduler = this.schedulerState(this.store.getRun()!);
			if (!scheduler.workConserving) {
				this.store.updateRun({ status: "paused", terminalDetail: `Scheduler stall: ${scheduler.freeSlots} free slot(s) and runnable plans ${scheduler.runnablePlanIds.join(", ")} produced no action.` });
			}
		}
		const settled = summarizeRun(this.specs(run), this.store.getPlans(run.runId));
		if (run.status === "running" && activeActionCount(this.store, run.runId) === 0 && settled.blocked.length > 0 && settled.ready.length === 0) {
			this.store.updateRun({ status: "failed", terminalDetail: `Blocked plans require recovery: ${settled.blocked.join(", ")}` });
			this.projectLifecycleBestEffort();
		}
		await driver.verifyCheckout(run.checkoutStateToken);
		return this.refreshReply(options.schedule === false ? "host-backpressure" : undefined);
	}

	async auditScheduler(): Promise<ManagerReply>;
	async auditScheduler(options: { includeReply: false }): Promise<ManagerReply | null>;
	async auditScheduler(options: { includeReply?: boolean } = {}): Promise<ManagerReply | null> {
		const run = this.store.getRun();
		if (!run || (run.status !== "running" && run.status !== "needs_input")) return options.includeReply === false ? null : this.reply();
		const drift = this.graphDrift(run);
		if (drift.changed) {
			this.store.updateRun({ status: "paused", terminalDetail: drift.detail });
			return this.reply();
		}
		const plans = this.store.getPlans(run.runId);
		const activeActionsForRun = activeActions(this.store, run.runId);
		const overview = summarizeRun(this.specs(run), plans);
		const scheduler = this.schedulerState(run, undefined, { active: activeActionsForRun, plans });
		const needsReconcile = this.terminalSideEffectsDirty
			|| this.store.getPlanEdit(run.runId)?.state === "barrier"
			|| plans.some((plan) => plan.phase === "READY_TO_INTEGRATE")
			|| (overview.complete && activeActionsForRun.length === 0)
			|| !scheduler.workConserving;
		return needsReconcile
			? this.reconcile(boundProfile(run, this.store))
			: options.includeReply === false ? null : this.reply();
	}

	private async schedule(profile: ResolvedProfile): Promise<void> {
		const run = this.store.getRun()!;
		const driver = this.driver(run);
		const reservedPlanId = this.store.getPlanEdit(run.runId)?.planId;
		const active = activeActions(this.store, run.runId);
		let occupied = active.length;
		const owned = new Set(active.map((action) => action.planId));
		const plans = this.store.getPlans(run.runId);
		for (const plan of plans.sort((a, b) => a.planId.localeCompare(b.planId))) {
			if (occupied >= run.maxParallel) break;
			if (plan.planId === reservedPlanId) continue;
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
			if (planId === reservedPlanId) continue;
			if (this.store.getPlan(run.runId, planId)) continue;
			const plan = this.ensureFreshPlanRuntime(run, spec);
			this.createAction(run, plan, "plan-implementer", profile, driver);
			occupied += 1;
		}
	}

	private createAction(run: StoredRun, plan: StoredPlan, role: WorkerRole, profile: ResolvedProfile, driver: GitDriver): StoredAction {
		const mapping = requiredRole(profile, role);
		const ordinal = attemptOrdinal(this.store, run.runId, plan.planId, plan.generation, role);
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
				this.store.updateRun({
					status: "paused",
					terminalDetail: `Active rebase verification failed for ${plan.planId}: ${error instanceof Error ? error.message : String(error)}`,
				});
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
		action.prompt = assignmentPrompt({ run, plan, action: stored, changedPaths, evidence: this.promptEvidence(run, plan) });
		return action;
	}

	private schedulerState(
		run: StoredRun,
		suppression?: "host-backpressure" | "revision-barrier",
		state?: { active: StoredAction[]; plans: StoredPlan[] },
	): ManagerReply["scheduler"] {
		const active = state?.active ?? activeActions(this.store, run.runId);
		const edit = this.store.getPlanEdit(run.runId);
		if (edit?.state === "barrier") suppression = "revision-barrier";
		const reservedPlanId = edit?.planId;
		const owned = new Set(active.map((action) => action.planId));
		const plans = state?.plans ?? this.store.getPlans(run.runId);
		const runtimeIds = new Set(plans.map((plan) => plan.planId));
		const runnablePlanIds = [
			...plans.filter((plan) => !owned.has(plan.planId) && roleForPhase(plan.phase)).map((plan) => plan.planId),
			...summarizeRun(this.specs(run), plans).ready.filter((spec) => !runtimeIds.has(spec.planId) && spec.planId !== reservedPlanId).map((spec) => spec.planId),
		].sort();
		const freeSlots = Math.max(0, run.maxParallel - active.length);
		const expectedNewActions = suppression === "revision-barrier" ? 0 : Math.min(freeSlots, runnablePlanIds.length);
		const inactive = run.status !== "running" && run.status !== "needs_input";
		const workConserving = inactive || suppression === "host-backpressure" || suppression === "revision-barrier" || expectedNewActions === 0;
		const reason = inactive ? "inactive"
			: suppression === "host-backpressure" ? "host-backpressure"
				: suppression === "revision-barrier" ? "revision-barrier"
				: freeSlots === 0 ? "saturated"
					: runnablePlanIds.length === 0 ? "no-runnable-work"
						: "scheduler-stall";
		return { active: active.length, freeSlots, runnable: runnablePlanIds.length, runnablePlanIds, expectedNewActions, workConserving, reason, checkedAt: new Date().toISOString() };
	}

	private ensureReigniteAllocation(run: StoredRun, request: ReigniteRequest): ReigniteRequest {
		if (request.state !== "pending") return request;
		if (run.status !== "complete") return request;
		if (request.allocatedPlanDirectory) return request;
		try {
			const allocatedPlanDirectory = allocateUnusedReigniteDirectory(
				run.repositoryRoot,
				run.planDirectory,
				`${run.runId}:${request.requestId}`,
			);
			return this.store.updateReigniteRequest(request.requestId, { allocatedPlanDirectory });
		} catch {
			return request;
		}
	}

	private assertWrittenReigniteGraph(run: StoredRun, request: ReigniteRequest, graphSha256: string): string {
		const allocated = request.allocatedPlanDirectory;
		if (!allocated) throw new Error("Reignite dossier has no allocated plan directory");
		const resolvedAllocated = fs.existsSync(allocated) ? fs.realpathSync(allocated) : path.resolve(allocated);
		const sourcePlanDirectory = fs.existsSync(request.sourcePlanDirectory)
			? fs.realpathSync(request.sourcePlanDirectory)
			: path.resolve(request.sourcePlanDirectory);
		const runPlanDirectory = fs.existsSync(run.planDirectory) ? fs.realpathSync(run.planDirectory) : path.resolve(run.planDirectory);
		if (resolvedAllocated === sourcePlanDirectory || resolvedAllocated === runPlanDirectory) {
			throw new Error("Reignite write cannot target the source plan directory");
		}
		if (!repoRootReignitePath(run.repositoryRoot, resolvedAllocated)) {
			throw new Error("Reignite write must target a repo-root herder-reignite[-N] directory");
		}
		if (!fs.existsSync(path.join(resolvedAllocated, "README.md"))) {
			throw new Error("Reignite write requires a validated plan graph at the allocated directory");
		}
		if (reigniteDirectoryHasLiveRun(resolvedAllocated)) {
			throw new Error("Reignite write cannot overwrite a live Herder run");
		}
		let graph: ReturnType<typeof buildGraph>;
		try {
			graph = buildGraph(resolvedAllocated);
		} catch (error) {
			throw new Error(`Reignite write path has a foreign or invalid README: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (graph.complete) throw new Error("Reignite write must not be a complete plan graph");
		if (!graph.plans.some((plan) => plan.status === "TODO" || plan.status === "BLOCKED")) {
			throw new Error("Reignite write must contain at least one TODO or BLOCKED plan");
		}
		if (!graph.shapeReady) throw new Error("Reignite write must be shape-ready");
		if (graph.inProgress.length > 0) {
			throw new Error(`Reignite write cannot adopt in-progress plans: ${graph.inProgress.join(", ")}`);
		}
		const compiled = compileGraphIdentity(graph);
		if (graphSha256 !== compiled) throw new Error("Reignite write graph hash does not match the allocated directory");
		return compiled;
	}

	refreshReply(suppression?: "host-backpressure" | "revision-barrier"): ManagerReply {
		let run = this.store.getRun();
		if (!run) return this.reply(suppression);
		if (run.status === "running") {
			const drift = this.graphDrift(run);
			if (drift.changed) run = this.store.updateRun({ status: "paused", terminalDetail: drift.detail });
		}
		if (run.status === "complete") {
			const reignite = this.store.getReigniteRequest(run.runId, run.currentGeneration);
			if (reignite?.state === "pending") this.ensureReigniteAllocation(run, reignite);
		}
		return this.reply(suppression);
	}

	reply(suppression?: "host-backpressure" | "revision-barrier"): ManagerReply {
		const run = this.store.getRun();
		if (!run) return {
			protocolVersion: MANAGER_PROTOCOL_VERSION,
			runId: "",
			status: "idle",
			profileName: "",
			maxParallel: 0,
			planDirectory: this.planDirectory,
			actions: [],
			active: [],
			summary: { total: 0, done: 0, rejected: 0, inProgress: 0, available: 0 },
			scheduler: { active: 0, freeSlots: 0, runnable: 0, runnablePlanIds: [], expectedNewActions: 0, workConserving: true, reason: "inactive", checkedAt: new Date().toISOString() },
			message: "No Herder run has started.",
		};
		const plans = this.store.getPlans(run.runId);
		const overview = summarizeRun(this.specs(run), plans);
		const active = this.store.getActions(run.runId, ["proposed", "dispatched"]);
		const proposed = active.filter((action) => action.state === "proposed");
		const planEdit = this.store.getPlanEdit(run.runId);
		const nextAttention = planEdit ? null : this.store.getNextAttention(run.runId);
		const exposedAttention = nextAttention ? (({ sequence: _sequence, ...request }) => request)(nextAttention) : undefined;
		const verification = this.store.getVerification(run.runId, run.currentGeneration);
		const integrationRepair = verification ? integrationRepairForVerification(this.store, verification) : null;
		const exposedIntegrationRepair = verification && (verification.state === "failed" || Boolean(integrationRepair))
			? integrationRepairRequest(verification, integrationRepair)
			: undefined;
		const reignite = this.store.getReigniteRequest(run.runId, run.currentGeneration);
		const scheduler = this.schedulerState(run, suppression, { active, plans });
		return {
			protocolVersion: MANAGER_PROTOCOL_VERSION,
			runId: run.runId,
			status: run.status,
			profileName: run.profileName,
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
			message: planEdit
				? `Plan ${planEdit.planId} is ${planEdit.state === "reserved" ? "reserved for Grill" : "waiting at the revision barrier"}; ${active.length} worker actions active.`
				: nextAttention?.detail || run.terminalDetail || `${overview.done}/${overview.total} plans done; ${active.length} worker actions active.`,
			...(exposedAttention ? { attention: exposedAttention } : {}),
			...(planEdit ? { planEdit: { planId: planEdit.planId, state: planEdit.state } } : {}),
			...(verification?.state === "awaiting_manifest" ? { verificationRequest: verification.request } : {}),
			...(exposedIntegrationRepair ? { integrationRepair: exposedIntegrationRepair } : {}),
			...(run.status === "complete" && reignite?.state === "pending" ? { reigniteRequest: reignite } : {}),
		};
	}

	stop(): ManagerReply {
		const run = this.store.getRun();
		if (!run) return this.reply();
		this.store.updateRun({ status: "stopped", terminalDetail: "Stop requested; repository and worker evidence preserved." });
		this.projectLifecycleBestEffort();
		return this.reply();
	}
}

export type { EventInput, IntegrationRepairInput, PlanEditInput, ReigniteInput, StartInput };
