import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ResetPlanCleanupEvidence } from "./git/reset-plan.ts";
import {
	executionDatabasePath,
	insertUsageRecordInDatabase,
	openExecutionDatabase,
	recordUsageRecordInDatabase,
	withExecutionTransaction,
	type UsageRecordInput,
} from "./execution-store.ts";
import {
	MANAGER_PROTOCOL_VERSION,
	attentionCapabilityToken,
	canonicalEventPayload,
	integrationRepairCapabilityDigest,
	integrationRepairCapabilityToken,
	integrationRepairEpisodeId,
	normalizeIntegrationRepairRefSnapshotEvidence,
	sha256,
	stableJson,
	validateAttentionRequest,
	type AttentionRequest,
	type AttentionRequestInput,
	type AttentionResolutionInput,
	type AttentionState,
	type ManagerAction,
	type ManagerAttentionRequest,
	type ManagerOperationKind,
	type ManagerOperationReceipt,
	type StoredManagerOperationKind,
	type ManagerOperationState,
	type ManagerReply,
	type PlanPhase,
	type RunStatus,
	type ReigniteRequest,
	type VerificationManifest,
	type VerificationRequest,
	type IntegrationRepairClassification,
	type IntegrationRepairEpisode,
	type IntegrationRepairRequest,
	type IntegrationRepairState,
} from "../shared/protocol.ts";

type Database = DatabaseSync;
type SqlRow = Record<string, any>;

export interface StoredRun {
	runId: string;
	repositoryRoot: string;
	planDirectory: string;
	planName: string;
	host: "pi";
	profileName: string;
	profileSha256: string;
	maxParallel: number;
	currentGeneration: number;
	graphSha256: string;
	status: RunStatus;
	checkoutStateToken: string;
	baseCommit: string;
	integrationBranch: string;
	integrationWorktree: string;
	dashboardUrl: string | null;
	terminalDetail: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface StoredPlan {
	runId: string;
	planId: string;
	generation: number;
	round: number;
	phase: PlanPhase;
	branch: string;
	worktree: string;
	assignmentPath: string;
	assignmentSha256: string;
	snapshotSha256: string;
	generationBase: string;
	reviewPass: number;
	findings: string[];
	repair: string[];
	gates: unknown[];
	approvedBase: string | null;
	approvedHead: string | null;
	approvedTree: string | null;
	rebase: {
		checkpointRef: string;
		checkpoint: string;
		onto: string;
		detachedHead: string;
		rebaseStateSha256?: string;
	} | null;
	updatedAt: string;
}

export interface StoredPlanSpec {
	runId: string;
	graphGeneration: number;
	planId: string;
	planFingerprint: string;
	fingerprintVersion: 2;
	ordinal: number;
	title: string;
	priority: string;
	effort: string;
	kind: string | null;
	dependencies: string[];
	initialStatus: "TODO" | "DONE" | "BLOCKED" | "REJECTED";
	initialStatusDetail: string;
	planFile: string;
	assignment: {
		snapshotSha256: string;
		snapshotInputs: Array<{ kind: string; name: string; sha256: string }>;
		plan: {
			id: string;
			title: string;
			kind: string | null;
			parentObjective: string | null;
			dependencies: string[];
			inScopePaths: string[];
		};
		planText: string;
	};
}

export interface StoredGeneration {
	runId: string;
	generation: number;
	graphSha256: string;
	parentGeneration: number | null;
	runAssignmentPath: string;
	runAssignmentSha256: string;
	runSnapshotSha256: string;
	createdAt: string;
}

export interface StoredPlanEdit {
	runId: string;
	planId: string;
	editToken: string;
	state: "reserved" | "barrier";
	baseGraphSha256: string;
	basePlanFingerprint: string;
	proposedGraphSha256: string | null;
	proposedPlanFingerprint: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface StoredApproval {
	runId: string;
	planId: string;
	generation: number;
	round: number;
	reviewerActionId: string;
	decisionActionId: string;
	decisionRole: "plan-reviewer" | "plan-judge" | "user";
	userAcceptance?: AttentionResolutionInput;
	assignmentSha256: string;
	approvedBase: string;
	approvedHead: string;
	approvedTree: string;
	reviewResultSha256: string;
	decisionResultSha256: string;
	proofSha256: string;
	createdAt: string;
}

export interface StoredAction {
	actionId: string;
	runId: string;
	planId: string;
	generation: number;
	round: number;
	role: string;
	attemptId: string;
	state: "proposed" | "dispatched" | "terminal" | "cancelled";
	agentType: string;
	model: string;
	effort: string;
	serviceTier: string | null;
	workerMode: string;
	taskName: string;
	leaseReason: string;
	hostHandle: string | null;
	result: unknown;
	createdAt: string;
	updatedAt: string;
}

export interface StoredService {
	instanceId: string;
	pid: number;
	port: number;
	authToken: string;
	dashboardUrl: string;
	startedAt: string;
}

export interface StoredProfileBinding {
	profile: string;
	profileSha256: string;
	host: StoredRun["host"];
	roles: Record<string, { agent_type: string; model: string; effort: string; service_tier?: string }>;
}

export interface StoredManagerOperation {
	sequence: number;
	operationId: string;
	kind: StoredManagerOperationKind;
	payload: unknown;
	payloadSha256: string;
	state: ManagerOperationState;
	attemptCount: number;
	result: unknown;
	error: string | null;
	acceptedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	updatedAt: string;
}

export interface StoredVerification {
	request: VerificationRequest;
	state: "awaiting_manifest" | "running" | "passed" | "failed";
	manifest: VerificationManifest | null;
	manifestSha256: string | null;
	result: unknown;
	terminalDetail: string | null;
	updatedAt: string;
}

export interface StoredIntegrationRepairEpisode extends IntegrationRepairEpisode {}

export interface StoredIntegrationRepair {
	repairId: string;
	runId: string;
	generation: number;
	requestId: string;
	requestSha256: string;
	/** Null until the owning session claims an automatically recorded failure. */
	ownerSessionId: string | null;
	/** Null until begin binds the request-bound capability to an owner. */
	capabilityDigest: string | null;
	classification: IntegrationRepairClassification | null;
	state: IntegrationRepairState;
	/** Current classification episode; lineage identity remains the repair ID. */
	episodeId: string | null;
	episodeRequestId: string | null;
	episodeRequestSha256: string | null;
	episodeIntegrationHead: string | null;
	episodeIntegrationTree: string | null;
	episodeCanonicalGates: VerificationManifest["gates"];
	episodeCanonicalGatesSha256: string | null;
	episodeState: IntegrationRepairState | null;
	episodeClassification: IntegrationRepairClassification | null;
	episodeOperationId: string | null;
	episodeOperationPayloadSha256: string | null;
	episodeTransientUsed: boolean;
	episodeTransientUseEvidenceSha256: string | null;
	transientRetryUsed: boolean;
	acceptedCodeRounds: number;
	round: number;
	maxRounds: 3;
	parentCommit: string;
	currentCommit: string | null;
	currentTree: string | null;
	beginRefSnapshot: string | null;
	beginRefSnapshotSha256: string | null;
	supersededCommits: string[];
	canonicalGates: VerificationManifest["gates"];
	canonicalGatesSha256: string;
	effectiveGates: VerificationManifest["gates"];
	successorRequestId: string | null;
	successorRequestSha256: string | null;
	successorManifest: VerificationManifest | null;
	successorManifestSha256: string | null;
	operationId: string | null;
	operationPayloadSha256: string | null;
	detail: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface StoredIntegrationRepairAudit {
	auditId: number;
	repairId: string;
	episodeId: string | null;
	operationId: string;
	action: string;
	payloadSha256: string;
	evidence: unknown;
	createdAt: string;
}

export type StoredAttentionRequest = AttentionRequest & { sequence: number };
export type AttentionCleanupStep = ResetPlanCleanupEvidence["step"];
export type AttentionCleanupIdentity = Omit<ResetPlanCleanupEvidence, "evidenceId" | "step" | "state">;
export type PlanEditOutcomeOperation = "finish" | "cancel";

const ATTENTION_CLEANUP_INTENT_KIND = "manager_attention_cleanup_intent";
const ATTENTION_CLEANUP_COMPLETE_KIND = "manager_attention_cleanup_complete";
const ATTENTION_CLEANUP_EVENT_PREFIX = "manager-attention-cleanup:";
const PLAN_EDIT_SNAPSHOT_KIND = "manager_plan_edit_snapshot";
const PLAN_EDIT_CONFIRM_KIND = "manager_plan_edit_confirmation";
const PLAN_EDIT_OUTCOME_KIND = "manager_plan_edit_outcome";
export const PLAN_EDIT_EVENT_PREFIX = "manager-plan-edit:";

function planEditEvidencePayload(runId: string, editToken: string, planId: string, operation: "confirm" | PlanEditOutcomeOperation, edit?: StoredPlanEdit): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: operation === "confirm" ? PLAN_EDIT_CONFIRM_KIND : PLAN_EDIT_OUTCOME_KIND,
		runId,
		editToken,
		planId,
		operation,
		...(operation === "confirm" ? {
			proposedGraphSha256: edit?.proposedGraphSha256,
			proposedPlanFingerprint: edit?.proposedPlanFingerprint,
		} : {}),
	};
}

function planEditEventId(editToken: string, operation: "confirm" | PlanEditOutcomeOperation, planId: string): string {
	return `${PLAN_EDIT_EVENT_PREFIX}${editToken}:${operation}:${planId}`;
}

function attentionCleanupPayload(identity: AttentionCleanupIdentity, step: AttentionCleanupStep, state: "prepared" | "completed"): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: state === "prepared" ? ATTENTION_CLEANUP_INTENT_KIND : ATTENTION_CLEANUP_COMPLETE_KIND,
		...identity,
		step,
		state,
	};
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	return JSON.parse(value) as T;
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(String(value)) as T } catch { return fallback }
}

export function readManagerState(planDir: string) {
  const database = openExecutionDatabase(planDir, { readOnly: true })
  if (!database) return { run: null, specs: [], plans: [], actions: [], generations: [], approvals: [], edit: null, verification: null, integrationRepair: null, attention: null, service: null }
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_runs'").get()
    if (!table) return { run: null, specs: [], plans: [], actions: [], generations: [], approvals: [], edit: null, verification: null, integrationRepair: null, attention: null, service: null }
    const run = (database.prepare(`
      SELECT run_id, plan_name, host, profile_name, profile_sha256, max_parallel,
        current_generation, graph_sha256, status, integration_branch,
        integration_worktree, dashboard_url, terminal_detail, created_at, updated_at
      FROM manager_runs ORDER BY created_at DESC LIMIT 1
    `).get() as SqlRow | undefined) ?? null
    const plans = run ? database.prepare(`
      SELECT plan_id, generation, round_number, phase, branch, worktree,
        review_pass, findings_json, repair_json, gate_json, rebase_json, updated_at
      FROM manager_plans WHERE run_id = ? ORDER BY plan_id
    `).all(run.run_id) as SqlRow[] : []
    const specs = run ? database.prepare(`
      SELECT graph_generation, plan_id, plan_fingerprint, fingerprint_version, ordinal, title, priority,
        effort, kind, dependencies_json, initial_status, initial_status_detail,
        plan_file
      FROM manager_plan_specs
      WHERE run_id = ? AND graph_generation = ?
      ORDER BY ordinal, plan_id
    `).all(run.run_id, run.current_generation) as SqlRow[] : []
    for (const spec of specs) {
      if (spec.fingerprint_version !== 2) throw new Error("Stored plan specification fingerprint version is invalid")
    }
    const actions = run ? database.prepare(`
      SELECT action_id, plan_id, generation, round_number, role, attempt_id,
        state, agent_type, model, effort, service_tier, worker_mode, task_name,
        host_handle, created_at, updated_at
      FROM manager_actions WHERE run_id = ? ORDER BY created_at, action_id
    `).all(run.run_id) as SqlRow[] : []
    const generations = run ? database.prepare("SELECT * FROM manager_generations WHERE run_id = ? ORDER BY generation").all(run.run_id) as SqlRow[] : []
    const approvals = run ? database.prepare("SELECT * FROM manager_approvals WHERE run_id = ? ORDER BY plan_id, generation").all(run.run_id) as SqlRow[] : []
    const edit = run ? database.prepare("SELECT * FROM manager_plan_edits WHERE run_id = ?").get(run.run_id) as SqlRow | undefined : undefined
    const verificationTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_verifications'").get()
    const verification = run && verificationTable ? database.prepare(`
      SELECT request_id, generation, state, terminal_detail, updated_at
      FROM manager_verifications
      WHERE run_id = ? AND generation = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(run.run_id, run.current_generation) as SqlRow | undefined : undefined
    const repairTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_integration_repairs'").get()
    const repairColumns = repairTable
      ? new Set((database.prepare("PRAGMA table_info(manager_integration_repairs)").all() as Array<{ name: string }>).map((column) => column.name))
      : new Set<string>()
    const beginRefSnapshotColumn = repairColumns.has("begin_ref_snapshot_json") ? "begin_ref_snapshot_json" : "NULL AS begin_ref_snapshot_json"
    const beginRefSnapshotSha256Column = repairColumns.has("begin_ref_snapshot_sha256") ? "begin_ref_snapshot_sha256" : "NULL AS begin_ref_snapshot_sha256"
    const acceptedCodeRoundsColumn = repairColumns.has("accepted_code_rounds") ? "accepted_code_rounds" : "0 AS accepted_code_rounds"
    const currentEpisodeIdColumn = repairColumns.has("current_episode_id") ? "current_episode_id" : "NULL AS current_episode_id"
    const episodeTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_integration_repair_episodes'").get()
    const integrationRepair = run && repairTable ? database.prepare(`
      SELECT repair_id, generation, request_id, request_sha256, owner_session_id, classification, state,
        round_number, parent_commit, current_commit, current_tree, superseded_commits_json,
        ${acceptedCodeRoundsColumn}, ${currentEpisodeIdColumn},
        ${beginRefSnapshotColumn}, ${beginRefSnapshotSha256Column},
        canonical_gates_json, canonical_gates_sha256, effective_gates_json, successor_request_id,
        successor_request_sha256, successor_manifest_json, successor_manifest_sha256, detail, created_at, updated_at
      FROM manager_integration_repairs
      WHERE run_id = ? AND generation = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(run.run_id, run.current_generation) as SqlRow | undefined : undefined
    const currentEpisode = integrationRepair && episodeTable && integrationRepair.current_episode_id
      ? database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?").get(integrationRepair.current_episode_id) as SqlRow | undefined
      : undefined
    const currentEpisodeForRequest = integrationRepair && currentEpisode && currentEpisode.request_id === integrationRepair.request_id ? currentEpisode : undefined
    const transientRetryUsed = integrationRepair && currentEpisodeForRequest && episodeTable
      ? Boolean(database.prepare(`
          SELECT 1 FROM manager_integration_repair_episodes
          WHERE repair_id = ? AND transient_used = 1 AND integration_head = ? AND integration_tree = ? AND canonical_gates_sha256 = ?
          LIMIT 1
        `).get(integrationRepair.repair_id, currentEpisodeForRequest.integration_head, currentEpisodeForRequest.integration_tree, currentEpisodeForRequest.canonical_gates_sha256))
      : false
    const attentionTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_attention_requests'").get()
    const attention = run && attentionTable ? database.prepare(`
      SELECT sequence, request_id, plan_id, generation, round_number, action_id, request_sha256,
        kind, state, cause, detail, detail_sha256, continuation_role,
        continuation_phase, question, recommended_action, recovery_json,
        created_at, updated_at, resolved_at
      FROM manager_attention_requests
      WHERE run_id = ? AND state <> 'resolved'
      ORDER BY plan_id COLLATE BINARY, sequence
      LIMIT 1
    `).get(run.run_id) as SqlRow | undefined : undefined
    let projectedAttention: Record<string, unknown> | null = null
    if (attention) {
      projectedAttention = {
        schemaVersion: 1,
        requestId: attention.request_id,
        runId: run!.run_id,
        planId: attention.plan_id,
        generation: attention.generation,
        round: attention.round_number,
        actionId: attention.action_id,
        requestSha256: attention.request_sha256,
        kind: attention.kind,
        state: attention.state,
        cause: attention.cause,
        detail: attention.detail,
        detailSha256: attention.detail_sha256,
        continuation: { role: attention.continuation_role, phase: attention.continuation_phase },
        ...(attention.question === null ? {} : { question: attention.question }),
        ...(attention.recommended_action === null ? {} : { recommendedAction: attention.recommended_action }),
        ...(attention.recovery_json === null ? {} : { recovery: parseJsonColumn<unknown>(attention.recovery_json, null) }),
        createdAt: attention.created_at,
        updatedAt: attention.updated_at,
        ...(attention.resolved_at === null ? {} : { resolvedAt: attention.resolved_at }),
      }
      validateAttentionRequest(projectedAttention)
    }
    const service = database.prepare(`
      SELECT instance_id, pid, port, dashboard_url, started_at
      FROM manager_service WHERE singleton = 1
    `).get() as SqlRow | undefined ?? null
    return {
      run: run ? {
        runId: run.run_id,
        planName: run.plan_name,
        host: run.host,
        profile: run.profile_name,
        profileSha256: run.profile_sha256,
        maxParallel: run.max_parallel,
        currentGeneration: run.current_generation,
        graphSha256: run.graph_sha256,
        status: run.status,
        integrationBranch: run.integration_branch,
        integrationWorktree: run.integration_worktree,
        dashboardUrl: run.dashboard_url,
        terminalDetail: run.terminal_detail,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      } : null,
      specs: specs.map((spec) => ({
        graphGeneration: spec.graph_generation,
        planId: spec.plan_id,
        planFingerprint: spec.plan_fingerprint,
        ordinal: spec.ordinal,
        title: spec.title,
        priority: spec.priority,
        effort: spec.effort,
        kind: spec.kind,
        dependencies: parseJsonColumn(spec.dependencies_json, []),
        initialStatus: spec.initial_status,
        initialStatusDetail: spec.initial_status_detail,
        planFile: spec.plan_file,
      })),
      plans: plans.map((plan) => ({
        planId: plan.plan_id,
        generation: plan.generation,
        round: plan.round_number,
        phase: plan.phase,
        branch: plan.branch,
        worktree: plan.worktree,
        reviewPass: plan.review_pass,
        findings: parseJsonColumn(plan.findings_json, []),
        repair: parseJsonColumn(plan.repair_json, []),
        gates: parseJsonColumn(plan.gate_json, []),
        rebase: parseJsonColumn(plan.rebase_json, null),
        updatedAt: plan.updated_at,
      })),
      actions: actions.map((action) => ({
        actionId: action.action_id,
        planId: action.plan_id,
        generation: action.generation,
        round: action.round_number,
        role: action.role,
        attemptId: action.attempt_id,
        state: action.state,
        agentType: action.agent_type,
        model: action.model,
        effort: action.effort,
        serviceTier: action.service_tier,
        workerMode: action.worker_mode,
        taskName: action.task_name,
        hostHandle: action.host_handle,
        createdAt: action.created_at,
        updatedAt: action.updated_at,
      })),
      generations: generations.map((generation) => ({
        generation: generation.generation,
        graphSha256: generation.graph_sha256,
        parentGeneration: generation.parent_generation,
        runAssignmentPath: generation.run_assignment_path,
        runAssignmentSha256: generation.run_assignment_sha256,
        runSnapshotSha256: generation.run_snapshot_sha256,
        createdAt: generation.created_at,
      })),
      approvals: approvals.map((approval) => ({
        planId: approval.plan_id,
        generation: approval.generation,
        round: approval.round_number,
        reviewerActionId: approval.reviewer_action_id,
        decisionActionId: approval.decision_action_id,
        decisionRole: approval.decision_role,
        ...(approval.user_acceptance_json == null ? {} : { userAcceptance: JSON.parse(approval.user_acceptance_json) as AttentionResolutionInput }),
        assignmentSha256: approval.assignment_sha256,
        approvedBase: approval.approved_base,
        approvedHead: approval.approved_head,
        approvedTree: approval.approved_tree,
        reviewResultSha256: approval.review_result_sha256,
        decisionResultSha256: approval.decision_result_sha256,
        proofSha256: approval.proof_sha256,
        createdAt: approval.created_at,
      })),
      edit: edit ? {
        planId: edit.plan_id,
        state: edit.state,
        baseGraphSha256: edit.base_graph_sha256,
        createdAt: edit.created_at,
        updatedAt: edit.updated_at,
      } : null,
      verification: verification ? {
        requestId: verification.request_id,
        generation: verification.generation,
        state: verification.state,
        terminalDetail: verification.terminal_detail,
        updatedAt: verification.updated_at,
      } : null,
      integrationRepair: integrationRepair ? {
        repairId: integrationRepair.repair_id,
        generation: integrationRepair.generation,
        requestId: integrationRepair.request_id,
        requestSha256: integrationRepair.request_sha256,
        ownerSessionId: integrationRepair.owner_session_id || undefined,
        classification: integrationRepair.classification,
        episodeId: currentEpisodeForRequest?.episode_id ?? undefined,
        episodeState: currentEpisodeForRequest ? (currentEpisodeForRequest.classification ? currentEpisodeForRequest.state : "unclassified") : undefined,
        episodeRequestSha256: currentEpisodeForRequest?.request_sha256,
        episodeIntegrationHead: currentEpisodeForRequest?.integration_head,
        episodeIntegrationTree: currentEpisodeForRequest?.integration_tree,
        episodeCanonicalGatesSha256: currentEpisodeForRequest?.canonical_gates_sha256,
        acceptedCodeRounds: Number(integrationRepair.accepted_code_rounds ?? 0),
        transientRetryUsed,
        state: integrationRepair.state,
        round: integrationRepair.round_number,
        parentCommit: integrationRepair.parent_commit,
        currentCommit: integrationRepair.current_commit,
        currentTree: integrationRepair.current_tree,
        supersededCommits: parseJsonColumn(integrationRepair.superseded_commits_json, []),
        beginRefSnapshot: parseJsonColumn(integrationRepair.begin_ref_snapshot_json, null),
        beginRefSnapshotSha256: integrationRepair.begin_ref_snapshot_sha256,
        canonicalGates: parseJsonColumn(integrationRepair.canonical_gates_json, []),
        canonicalGatesSha256: integrationRepair.canonical_gates_sha256,
        effectiveGates: parseJsonColumn(integrationRepair.effective_gates_json, []),
        successorRequestId: integrationRepair.successor_request_id,
        successorRequestSha256: integrationRepair.successor_request_sha256,
        successorManifest: parseJsonColumn(integrationRepair.successor_manifest_json, null),
        successorManifestSha256: integrationRepair.successor_manifest_sha256,
        detail: integrationRepair.detail,
        createdAt: integrationRepair.created_at,
        updatedAt: integrationRepair.updated_at,
      } : null,
      attention: projectedAttention,
      service: service ? {
        instanceId: service.instance_id,
        pid: service.pid,
        port: service.port,
        dashboardUrl: service.dashboard_url,
        startedAt: service.started_at,
      } : null,
    }
  } finally {
    database.close()
  }
}

function normalizeBeginRefSnapshot(snapshot: string | null | undefined, snapshotSha256: string | null | undefined): { json: string | null; sha256: string | null } {
	if (snapshot === null || snapshot === undefined || snapshot === "") {
		if (snapshotSha256 !== null && snapshotSha256 !== undefined && snapshotSha256 !== "") throw new Error("Integration repair begin-ref snapshot hash is missing its snapshot");
		return { json: null, sha256: null };
	}
	const evidence = normalizeIntegrationRepairRefSnapshotEvidence(snapshot, snapshotSha256);
	return { json: evidence.json, sha256: evidence.sha256 };
}

function durableOperationPayload(kind: StoredManagerOperationKind, payload: unknown): unknown {
	if (kind !== "integration_repair" && kind !== "repair") return payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const record = payload as Record<string, unknown>;
	const token = typeof record.capabilityToken === "string" ? record.capabilityToken : "";
	const { capabilityToken: _capabilityToken, ...rest } = record;
	return {
		...rest,
		...(token ? { capabilityTokenSha256: integrationRepairCapabilityDigest(token) } : {}),
	};
}

function mapIntegrationRepairReply(value: unknown, restore: boolean): unknown {
	if (Array.isArray(value)) return value.map((entry) => mapIntegrationRepairReply(entry, restore));
	if (!value || typeof value !== "object") return value;
	const mapped: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		mapped[key] = mapIntegrationRepairReply(entry, restore);
	}
	const repair = mapped.integrationRepair;
	if (!repair || typeof repair !== "object" || Array.isArray(repair)) return mapped;
	const request = repair as Record<string, unknown>;
	const token = typeof request.capabilityToken === "string" ? request.capabilityToken : "";
	if (restore) {
		if (!token && typeof request.requestId === "string") {
			const expected = integrationRepairCapabilityToken(request.requestId);
			if (request.capabilityTokenSha256 === integrationRepairCapabilityDigest(expected)) {
				request.capabilityToken = expected;
			}
		}
	} else {
		delete request.capabilityToken;
		if (token) request.capabilityTokenSha256 = integrationRepairCapabilityDigest(token);
	}
	mapped.integrationRepair = request;
	return mapped;
}

function durableManagerReply(value: unknown): unknown {
	return mapIntegrationRepairReply(value, false);
}

function exposedManagerReply(value: unknown): unknown {
	return mapIntegrationRepairReply(value, true);
}

function rowToRun(row: Record<string, unknown> | undefined): StoredRun | null {
	if (!row) return null;
	return {
		runId: String(row.run_id),
		repositoryRoot: String(row.repository_root),
		planDirectory: String(row.plan_directory),
		planName: String(row.plan_name),
		host: row.host as StoredRun["host"],
		profileName: String(row.profile_name),
		profileSha256: String(row.profile_sha256),
		maxParallel: Number(row.max_parallel),
		currentGeneration: Number(row.current_generation),
		graphSha256: String(row.graph_sha256),
		status: row.status as RunStatus,
		checkoutStateToken: String(row.checkout_state_token),
		baseCommit: String(row.base_commit),
		integrationBranch: String(row.integration_branch),
		integrationWorktree: String(row.integration_worktree),
		dashboardUrl: row.dashboard_url === null ? null : String(row.dashboard_url),
		terminalDetail: row.terminal_detail === null ? null : String(row.terminal_detail),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToPlan(row: Record<string, unknown>): StoredPlan {
	return {
		runId: String(row.run_id),
		planId: String(row.plan_id),
		generation: Number(row.generation),
		round: Number(row.round_number),
		phase: String(row.phase) as PlanPhase,
		branch: String(row.branch),
		worktree: String(row.worktree),
		assignmentPath: String(row.assignment_path),
		assignmentSha256: String(row.assignment_sha256),
		snapshotSha256: String(row.snapshot_sha256),
		generationBase: String(row.generation_base),
		reviewPass: Number(row.review_pass),
		findings: parseJson<string[]>(String(row.findings_json), []),
		repair: parseJson<string[]>(String(row.repair_json), []),
		gates: parseJson<unknown[]>(String(row.gate_json), []),
		approvedBase: row.approved_base === null ? null : String(row.approved_base),
		approvedHead: row.approved_head === null ? null : String(row.approved_head),
		approvedTree: row.approved_tree === null ? null : String(row.approved_tree),
		rebase: parseJson<StoredPlan["rebase"]>(row.rebase_json === null ? null : String(row.rebase_json), null),
		updatedAt: String(row.updated_at),
	};
}

function rowToPlanSpec(row: Record<string, unknown>): StoredPlanSpec {
	if (row.fingerprint_version !== 2) throw new Error("Stored plan specification fingerprint version is invalid");
	return {
		runId: String(row.run_id),
		graphGeneration: Number(row.graph_generation),
		planId: String(row.plan_id),
		planFingerprint: String(row.plan_fingerprint),
		fingerprintVersion: 2,
		ordinal: Number(row.ordinal),
		title: String(row.title),
		priority: String(row.priority),
		effort: String(row.effort),
		kind: String(row.kind),
		dependencies: parseJson(String(row.dependencies_json), []),
		initialStatus: String(row.initial_status) as StoredPlanSpec["initialStatus"],
		initialStatusDetail: String(row.initial_status_detail),
		planFile: String(row.plan_file),
		assignment: JSON.parse(String(row.assignment_json)) as StoredPlanSpec["assignment"],
	};
}

function rowToGeneration(row: Record<string, unknown>): StoredGeneration {
	return {
		runId: String(row.run_id),
		generation: Number(row.generation),
		graphSha256: String(row.graph_sha256),
		parentGeneration: row.parent_generation === null ? null : Number(row.parent_generation),
		runAssignmentPath: String(row.run_assignment_path),
		runAssignmentSha256: String(row.run_assignment_sha256),
		runSnapshotSha256: String(row.run_snapshot_sha256),
		createdAt: String(row.created_at),
	};
}

function rowToPlanEdit(row: Record<string, unknown> | undefined): StoredPlanEdit | null {
	if (!row) return null;
	return {
		runId: String(row.run_id),
		planId: String(row.plan_id),
		editToken: String(row.edit_token),
		state: row.state as StoredPlanEdit["state"],
		baseGraphSha256: String(row.base_graph_sha256),
		basePlanFingerprint: String(row.base_plan_fingerprint),
		proposedGraphSha256: row.proposed_graph_sha256 === null ? null : String(row.proposed_graph_sha256),
		proposedPlanFingerprint: row.proposed_plan_fingerprint === null ? null : String(row.proposed_plan_fingerprint),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToApproval(row: Record<string, unknown>): StoredApproval {
	return {
		runId: String(row.run_id),
		planId: String(row.plan_id),
		generation: Number(row.generation),
		round: Number(row.round_number),
		reviewerActionId: String(row.reviewer_action_id),
		decisionActionId: String(row.decision_action_id),
		decisionRole: row.decision_role as StoredApproval["decisionRole"],
		...(row.user_acceptance_json == null ? {} : { userAcceptance: JSON.parse(String(row.user_acceptance_json)) as AttentionResolutionInput }),
		assignmentSha256: String(row.assignment_sha256),
		approvedBase: String(row.approved_base),
		approvedHead: String(row.approved_head),
		approvedTree: String(row.approved_tree),
		reviewResultSha256: String(row.review_result_sha256),
		decisionResultSha256: String(row.decision_result_sha256),
		proofSha256: String(row.proof_sha256),
		createdAt: String(row.created_at),
	};
}

function rowToAction(row: Record<string, unknown>): StoredAction {
	return {
		actionId: String(row.action_id),
		runId: String(row.run_id),
		planId: String(row.plan_id),
		generation: Number(row.generation),
		round: Number(row.round_number),
		role: String(row.role),
		attemptId: String(row.attempt_id),
		state: row.state as StoredAction["state"],
		agentType: String(row.agent_type),
		model: String(row.model),
		effort: String(row.effort),
		serviceTier: row.service_tier === null ? null : String(row.service_tier),
		workerMode: String(row.worker_mode),
		taskName: String(row.task_name),
		leaseReason: String(row.lease_reason),
		hostHandle: row.host_handle === null ? null : String(row.host_handle),
		result: parseJson<unknown>(row.result_json === null ? null : String(row.result_json), null),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToOperation(row: Record<string, unknown>): StoredManagerOperation {
	return {
		sequence: Number(row.sequence),
		operationId: String(row.operation_id),
		kind: row.kind as StoredManagerOperationKind,
		payload: JSON.parse(String(row.payload_json)),
		payloadSha256: String(row.payload_sha256),
		state: row.state as ManagerOperationState,
		attemptCount: Number(row.attempt_count),
		result: exposedManagerReply(parseJson<unknown>(row.result_json === null ? null : String(row.result_json), null)),
		error: row.error === null ? null : String(row.error),
		acceptedAt: String(row.accepted_at),
		startedAt: row.started_at === null ? null : String(row.started_at),
		finishedAt: row.finished_at === null ? null : String(row.finished_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToVerification(row: Record<string, unknown>): StoredVerification {
	const request: VerificationRequest = {
		schemaVersion: 1,
		requestId: String(row.request_id),
		requestSha256: String(row.request_sha256),
		runId: String(row.run_id),
		generation: Number(row.generation),
		graphSha256: String(row.graph_sha256),
		runAssignmentPath: String(row.run_assignment_path),
		runAssignmentSha256: String(row.run_assignment_sha256),
		integrationBranch: String(row.integration_branch),
		integrationWorktree: String(row.integration_worktree),
		integrationHead: String(row.integration_head),
		integrationTree: String(row.integration_tree),
		requestedAt: String(row.created_at),
		...(row.predecessor_request_id === null || row.predecessor_request_id === undefined ? {} : { predecessorRequestId: String(row.predecessor_request_id) }),
		...(row.repair_id === null || row.repair_id === undefined ? {} : { repairId: String(row.repair_id) }),
		...(row.repair_round === null || row.repair_round === undefined ? {} : { repairRound: Number(row.repair_round) }),
	};
	return {
		request,
		state: row.state as StoredVerification["state"],
		manifest: parseJson<VerificationManifest | null>(row.manifest_json === null ? null : String(row.manifest_json), null),
		manifestSha256: row.manifest_sha256 === null ? null : String(row.manifest_sha256),
		result: parseJson<unknown>(row.result_json === null ? null : String(row.result_json), null),
		terminalDetail: row.terminal_detail === null ? null : String(row.terminal_detail),
		updatedAt: String(row.updated_at),
	};
}

function rowToIntegrationRepairEpisode(row: Record<string, unknown>): StoredIntegrationRepairEpisode {
	const classification = row.episode_classification ?? row.classification;
	return {
		episodeId: String(row.episode_id),
		repairId: String(row.episode_repair_id ?? row.repair_id),
		requestId: String(row.episode_request_id ?? row.request_id),
		requestSha256: String(row.episode_request_sha256 ?? row.request_sha256),
		integrationHead: String(row.episode_integration_head ?? row.integration_head),
		integrationTree: String(row.episode_integration_tree ?? row.integration_tree),
		canonicalGates: parseJson<VerificationManifest["gates"]>(String(row.episode_canonical_gates_json ?? row.canonical_gates_json), []),
		canonicalGatesSha256: String(row.episode_canonical_gates_sha256 ?? row.canonical_gates_sha256),
		classification: classification === null || classification === undefined ? null : String(classification) as IntegrationRepairClassification,
		state: String(row.episode_state ?? row.state) as IntegrationRepairState,
		operationId: (row.episode_operation_id ?? row.operation_id) === null || (row.episode_operation_id ?? row.operation_id) === undefined ? null : String(row.episode_operation_id ?? row.operation_id),
		operationPayloadSha256: (row.episode_operation_payload_sha256 ?? row.operation_payload_sha256) === null || (row.episode_operation_payload_sha256 ?? row.operation_payload_sha256) === undefined ? null : String(row.episode_operation_payload_sha256 ?? row.operation_payload_sha256),
		transientUsed: Number(row.episode_transient_used ?? row.transient_used ?? 0) === 1,
		transientUseEvidenceSha256: row.episode_transient_use_evidence_sha256 === null || row.episode_transient_use_evidence_sha256 === undefined ? null : String(row.episode_transient_use_evidence_sha256),
		createdAt: String(row.episode_created_at ?? row.created_at),
		updatedAt: String(row.episode_updated_at ?? row.updated_at),
		closedAt: (row.episode_closed_at ?? row.closed_at) === null || (row.episode_closed_at ?? row.closed_at) === undefined ? null : String(row.episode_closed_at ?? row.closed_at),
	};
}

function rowToIntegrationRepair(row: Record<string, unknown>): StoredIntegrationRepair {
	const episodeId = row.episode_current_id === null || row.episode_current_id === undefined
		? (row.current_episode_id === null || row.current_episode_id === undefined ? null : String(row.current_episode_id))
		: String(row.episode_current_id);
	return {
		repairId: String(row.repair_id),
		runId: String(row.run_id),
		generation: Number(row.generation),
		requestId: String(row.request_id),
		requestSha256: String(row.request_sha256),
		ownerSessionId: row.owner_session_id === null || row.owner_session_id === undefined || String(row.owner_session_id) === "" ? null : String(row.owner_session_id),
		capabilityDigest: row.capability_digest === null || row.capability_digest === undefined || String(row.capability_digest) === "" ? null : String(row.capability_digest),
		classification: row.classification === null ? null : String(row.classification) as IntegrationRepairClassification,
		state: String(row.state) as IntegrationRepairState,
		episodeId,
		episodeRequestId: row.episode_request_id === null || row.episode_request_id === undefined ? null : String(row.episode_request_id),
		episodeRequestSha256: row.episode_request_sha256 === null || row.episode_request_sha256 === undefined ? null : String(row.episode_request_sha256),
		episodeIntegrationHead: row.episode_integration_head === null || row.episode_integration_head === undefined ? null : String(row.episode_integration_head),
		episodeIntegrationTree: row.episode_integration_tree === null || row.episode_integration_tree === undefined ? null : String(row.episode_integration_tree),
		episodeCanonicalGates: row.episode_canonical_gates_json === null || row.episode_canonical_gates_json === undefined ? [] : parseJson<VerificationManifest["gates"]>(String(row.episode_canonical_gates_json), []),
		episodeCanonicalGatesSha256: row.episode_canonical_gates_sha256 === null || row.episode_canonical_gates_sha256 === undefined ? null : String(row.episode_canonical_gates_sha256),
		episodeState: row.episode_state === null || row.episode_state === undefined ? null : String(row.episode_state) as IntegrationRepairState,
		episodeClassification: row.episode_classification === null || row.episode_classification === undefined ? null : String(row.episode_classification) as IntegrationRepairClassification,
		episodeOperationId: row.episode_operation_id === null || row.episode_operation_id === undefined ? null : String(row.episode_operation_id),
		episodeOperationPayloadSha256: row.episode_operation_payload_sha256 === null || row.episode_operation_payload_sha256 === undefined ? null : String(row.episode_operation_payload_sha256),
		episodeTransientUsed: Number(row.episode_transient_used ?? 0) === 1,
		episodeTransientUseEvidenceSha256: row.episode_transient_use_evidence_sha256 === null || row.episode_transient_use_evidence_sha256 === undefined ? null : String(row.episode_transient_use_evidence_sha256),
		transientRetryUsed: Number(row.transient_retry_used ?? 0) === 1,
		acceptedCodeRounds: Number(row.accepted_code_rounds ?? 0),
		round: Number(row.round_number),
		maxRounds: 3,
		parentCommit: String(row.parent_commit),
		currentCommit: row.current_commit === null ? null : String(row.current_commit),
		currentTree: row.current_tree === null ? null : String(row.current_tree),
		beginRefSnapshot: row.begin_ref_snapshot_json === null || row.begin_ref_snapshot_json === undefined ? null : String(row.begin_ref_snapshot_json),
		beginRefSnapshotSha256: row.begin_ref_snapshot_sha256 === null || row.begin_ref_snapshot_sha256 === undefined ? null : String(row.begin_ref_snapshot_sha256),
		supersededCommits: parseJson<string[]>(row.superseded_commits_json === null ? null : String(row.superseded_commits_json), []),
		canonicalGates: parseJson<VerificationManifest["gates"]>(String(row.canonical_gates_json), []),
		canonicalGatesSha256: String(row.canonical_gates_sha256),
		effectiveGates: parseJson<VerificationManifest["gates"]>(String(row.effective_gates_json), []),
		successorRequestId: row.successor_request_id === null ? null : String(row.successor_request_id),
		successorRequestSha256: row.successor_request_sha256 === null ? null : String(row.successor_request_sha256),
		successorManifest: parseJson<VerificationManifest | null>(row.successor_manifest_json === null ? null : String(row.successor_manifest_json), null),
		successorManifestSha256: row.successor_manifest_sha256 === null ? null : String(row.successor_manifest_sha256),
		operationId: row.operation_id === null ? null : String(row.operation_id),
		operationPayloadSha256: row.operation_payload_sha256 === null ? null : String(row.operation_payload_sha256),
		detail: row.detail === null ? null : String(row.detail),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function rowToIntegrationRepairAudit(row: Record<string, unknown>): StoredIntegrationRepairAudit {
	return {
		auditId: Number(row.audit_id),
		repairId: String(row.repair_id),
		episodeId: row.episode_id === null || row.episode_id === undefined ? null : String(row.episode_id),
		operationId: String(row.operation_id),
		action: String(row.action),
		payloadSha256: String(row.payload_sha256),
		evidence: parseJson<unknown>(String(row.evidence_json), null),
		createdAt: String(row.created_at),
	};
}

function rowToReignite(row: Record<string, unknown>): ReigniteRequest {
	const allocatedPlanDirectory = row.allocated_plan_directory == null || row.allocated_plan_directory === ""
		? undefined
		: String(row.allocated_plan_directory);
	const detail = row.detail == null || row.detail === "" ? undefined : String(row.detail);
	return {
		schemaVersion: 1,
		requestId: String(row.request_id),
		requestSha256: String(row.request_sha256),
		runId: String(row.run_id),
		generation: Number(row.generation),
		sourcePlanDirectory: String(row.source_plan_directory),
		graphSha256: String(row.graph_sha256),
		integrationHead: String(row.integration_head),
		integrationTree: String(row.integration_tree),
		integrationBranch: String(row.integration_branch),
		verdict: String(row.verdict) as ReigniteRequest["verdict"],
		scope: String(row.scope) as ReigniteRequest["scope"],
		findings: parseJson<string[]>(String(row.findings_json), []),
		fixGuidance: parseJson<string[]>(String(row.fix_guidance_json), []),
		rationale: String(row.rationale),
		createdAt: String(row.created_at),
		state: String(row.state) as ReigniteRequest["state"],
		...(allocatedPlanDirectory ? { allocatedPlanDirectory } : {}),
		...(detail ? { detail } : {}),
	};
}

function rowToAttention(row: Record<string, unknown>): StoredAttentionRequest {
	const request = {
		schemaVersion: 1,
		requestId: String(row.request_id),
		capabilityToken: attentionCapabilityToken(String(row.request_id)),
		runId: String(row.run_id),
		planId: String(row.plan_id),
		generation: Number(row.generation),
		round: Number(row.round_number),
		actionId: row.action_id === null ? null : String(row.action_id),
		requestSha256: String(row.request_sha256),
		kind: String(row.kind) as AttentionRequest["kind"],
		state: String(row.state) as AttentionState,
		cause: String(row.cause) as AttentionRequest["cause"],
		detail: String(row.detail),
		detailSha256: String(row.detail_sha256),
		continuation: {
			role: String(row.continuation_role) as AttentionRequest["continuation"]["role"],
			phase: String(row.continuation_phase) as AttentionRequest["continuation"]["phase"],
		},
		...(row.question === null ? {} : { question: String(row.question) }),
		...(row.recommended_action === null ? {} : { recommendedAction: String(row.recommended_action) }),
		...(row.recovery_json === null ? {} : { recovery: JSON.parse(String(row.recovery_json)) }),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		...(row.resolved_at === null ? {} : { resolvedAt: String(row.resolved_at) }),
	} as unknown as ManagerAttentionRequest;
	validateAttentionRequest(request);
	return { ...request, sequence: Number(row.sequence) };
}

function attentionIdentity(request: AttentionRequest): string {
	return stableJson({
		runId: request.runId,
		planId: request.planId,
		generation: request.generation,
		round: request.round,
		actionId: request.actionId,
		kind: request.kind,
		cause: request.cause,
		detail: request.detail,
		detailSha256: request.detailSha256,
		requestSha256: request.requestSha256,
		continuation: request.continuation,
		question: request.question ?? null,
		recommendedAction: request.recommendedAction ?? null,
		recovery: request.kind === "plan_recovery" ? request.recovery : null,
	});
}

function operationReceipt(operation: StoredManagerOperation): ManagerOperationReceipt {
	return {
		protocolVersion: MANAGER_PROTOCOL_VERSION,
		operationId: operation.operationId,
		kind: operation.kind,
		payloadSha256: operation.payloadSha256,
		state: operation.state,
		acceptedAt: operation.acceptedAt,
		updatedAt: operation.updatedAt,
		pollPath: `/v1/operation?id=${encodeURIComponent(operation.operationId)}`,
		...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
		...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
		...(operation.state === "succeeded" ? { result: operation.result } : {}),
		...(operation.error ? { error: operation.error } : {}),
	};
}

export class RunStore {
	readonly databasePath: string;
	readonly database: Database;

	constructor(planDirectory: string, options: { readOnly?: boolean } = {}) {
		this.databasePath = executionDatabasePath(planDirectory);
		const database = options.readOnly
			? openExecutionDatabase(planDirectory, { create: false, readOnly: true })
			: openExecutionDatabase(planDirectory, { create: true, readOnly: false });
		if (!database) throw new Error(`Herder execution database is not initialized: ${this.databasePath}`);
		this.database = database;
		if (!options.readOnly) {
			try {
				this.scrubPersistedIntegrationRepairReplies();
			} catch (error) {
				try { database.close(); } catch {}
				throw error;
			}
		}
	}

	private scrubPersistedIntegrationRepairReplies(): void {
		this.transaction(() => {
			const operations = this.database.prepare("SELECT operation_id, result_json FROM manager_operations WHERE result_json IS NOT NULL").all() as Array<{ operation_id: string; result_json: string | null }>;
			for (const row of operations) {
				if (!row.result_json) continue;
				let parsed: unknown;
				try { parsed = JSON.parse(row.result_json); } catch { continue; }
				const durable = durableManagerReply(parsed);
				if (stableJson(parsed) !== stableJson(durable)) this.database.prepare("UPDATE manager_operations SET result_json = ? WHERE operation_id = ?").run(JSON.stringify(durable), row.operation_id);
			}
			const snapshot = this.database.prepare("SELECT reply_json FROM manager_snapshots WHERE singleton = 1").get() as { reply_json?: string } | undefined;
			if (snapshot?.reply_json) {
				try {
					const parsed = JSON.parse(snapshot.reply_json);
					const durable = durableManagerReply(parsed);
					if (stableJson(parsed) !== stableJson(durable)) this.database.prepare("UPDATE manager_snapshots SET reply_json = ? WHERE singleton = 1").run(JSON.stringify(durable));
				} catch {
					// Leave malformed historical evidence for the normal integrity path.
				}
			}
		});
	}

	close(): void {
		this.database.close();
	}

	transaction<T>(operation: () => T): T {
		return withExecutionTransaction(this.database, operation);
	}

	/** Insert usage into an open caller-owned transaction. */
	insertUsageInTransaction(input: UsageRecordInput): void {
		insertUsageRecordInDatabase(this.database, input);
	}

	/** Record usage in a transaction owned by this store. */
	recordUsage(input: UsageRecordInput): void {
		recordUsageRecordInDatabase(this.database, input);
	}

	getRun(): StoredRun | null {
		return rowToRun(this.database.prepare("SELECT * FROM manager_runs ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined);
	}

	getProfileBinding(): StoredProfileBinding | null {
		const row = this.database.prepare("SELECT profile_name, profile_sha256, host, roles_json FROM run_configuration WHERE singleton = 1").get() as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			profile: String(row.profile_name),
			profileSha256: String(row.profile_sha256),
			host: row.host as StoredRun["host"],
			roles: JSON.parse(String(row.roles_json)) as StoredProfileBinding["roles"],
		};
	}

	getOperation(operationId: string): StoredManagerOperation | null {
		const row = this.database.prepare("SELECT * FROM manager_operations WHERE operation_id = ?").get(operationId) as Record<string, unknown> | undefined;
		return row ? rowToOperation(row) : null;
	}

	submitOperation(operationId: string, kind: ManagerOperationKind, payload: unknown): ManagerOperationReceipt {
		return this.submitOperationInternal(operationId, kind, payload, true);
	}

	replayOperation(operationId: string, kind: StoredManagerOperationKind, payload: unknown): ManagerOperationReceipt {
		return this.submitOperationInternal(operationId, kind, payload, false);
	}

	private submitOperationInternal(operationId: string, kind: StoredManagerOperationKind, payload: unknown, allowInsertion: boolean): ManagerOperationReceipt {
		if (!operationId || operationId.length > 206 || /[\0\r\n]/.test(operationId)) throw new Error("Manager operation ID must be one line of at most 206 characters");
		const durablePayload = durableOperationPayload(kind, payload);
		const canonicalPayload = canonicalEventPayload(durablePayload);
		const identity = canonicalEventPayload({ kind, payload: durablePayload });
		const existing = this.getOperation(operationId);
		if (existing) {
			if (existing.kind !== kind || existing.payloadSha256 !== identity.sha256) throw new Error(`Operation ${operationId} was replayed with different payload`);
			return operationReceipt(existing);
		}
		if (!allowInsertion) throw new Error(`Operation ${operationId} was not found for replay`);
		if (kind === "repair") throw new Error("Unknown manager operation kind: repair");
		const now = new Date().toISOString();
		this.database.prepare(`
			INSERT INTO manager_operations (
				operation_id, kind, payload_json, payload_sha256, state, attempt_count,
				result_json, error, accepted_at, started_at, finished_at, updated_at
			) VALUES (?, ?, ?, ?, 'accepted', 0, NULL, NULL, ?, NULL, NULL, ?)
		`).run(operationId, kind, canonicalPayload.json, identity.sha256, now, now);
		return operationReceipt(this.getOperation(operationId)!);
	}

	countPendingOperations(): number {
		const row = this.database.prepare("SELECT COUNT(*) AS count FROM manager_operations WHERE state IN ('accepted', 'running')").get() as { count: number };
		return Number(row.count);
	}

	recoverRunningOperations(): void {
		const running = (this.database.prepare("SELECT * FROM manager_operations WHERE state = 'running' ORDER BY sequence").all() as Record<string, unknown>[]).map(rowToOperation);
		for (const operation of running) {
			const payload = operation.payload && typeof operation.payload === "object" && !Array.isArray(operation.payload)
				? operation.payload as Record<string, unknown> : {};
			const mode = operation.kind === "start" ? String(payload.mode || "") : "";
			if (operation.kind === "verification") {
				const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
				const stored = requestId ? this.getVerificationByRequestId(requestId) : null;
				if (stored?.state === "passed" || (stored?.manifest && stored.request.repairId && stored.state === "running")) {
					this.database.prepare("UPDATE manager_operations SET state = 'accepted', updated_at = ? WHERE operation_id = ?")
						.run(new Date().toISOString(), operation.operationId);
					continue;
				}
			}
			if (operation.kind === "integration_repair" || operation.kind === "repair") {
				const repairId = typeof payload.repairId === "string" ? payload.repairId : "";
				const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
				const repairOperation = typeof payload.operation === "string" ? payload.operation : "";
				const repairForRequest = requestId ? this.getIntegrationRepairForRequest(requestId) : null;
				const repair = repairId ? this.getIntegrationRepair(repairId) : repairForRequest;
				// A begin with no repair row proves that the row transaction never
				// committed. Requeue the exact receipt instead of terminalizing it;
				// finish and cancel still fail closed when their evidence is absent.
				if (repairOperation === "begin" && !repair && !repairForRequest) {
					this.database.prepare("UPDATE manager_operations SET state = 'accepted', updated_at = ? WHERE operation_id = ?")
						.run(new Date().toISOString(), operation.operationId);
					continue;
				}
				if (repair && repair.state !== "interrupted") {
					this.database.prepare("UPDATE manager_operations SET state = 'accepted', updated_at = ? WHERE operation_id = ?")
						.run(new Date().toISOString(), operation.operationId);
					continue;
				}
			}
			const replaySafe = operation.kind === "event" || operation.kind === "edit" || operation.kind === "stop" || operation.kind === "reignite" || (operation.kind === "start" && ["fire", "resume"].includes(mode));
			if (replaySafe) {
				this.database.prepare("UPDATE manager_operations SET state = 'accepted', updated_at = ? WHERE operation_id = ?")
					.run(new Date().toISOString(), operation.operationId);
				continue;
			}
			const detail = `Operation ${operation.operationId} was interrupted while ${operation.kind} was running; its durable evidence was incomplete and was not replayed.`;
			const now = new Date().toISOString();
			this.transaction(() => {
				this.database.prepare("UPDATE manager_operations SET state = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE operation_id = ?")
					.run(detail, now, now, operation.operationId);
				if (operation.kind === "integration_repair" || operation.kind === "repair") {
					const repairId = typeof payload.repairId === "string" ? payload.repairId : "";
					if (repairId && this.getIntegrationRepair(repairId)) this.updateIntegrationRepair(repairId, { state: "interrupted", detail });
				} else if (operation.kind === "verification") {
					const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
					if (requestId) {
						const verification = this.getVerificationByRequestId(requestId);
						this.database.prepare("UPDATE manager_verifications SET state = 'failed', terminal_detail = ?, updated_at = ? WHERE request_id = ? AND state = 'running'").run(detail, now, requestId);
						if (verification && !verification.request.repairId) this.recordInitialIntegrationRepairFailure(verification, detail);
					}
					this.database.prepare("UPDATE manager_runs SET status = 'failed', terminal_detail = ?, updated_at = ? WHERE status IN ('running', 'paused')").run(detail, now);
				}
			});
		}
	}

	claimNextOperation(): StoredManagerOperation | null {
		return this.transaction(() => {
			const row = this.database.prepare("SELECT * FROM manager_operations WHERE state = 'accepted' ORDER BY sequence LIMIT 1").get() as Record<string, unknown> | undefined;
			if (!row) return null;
			const now = new Date().toISOString();
			this.database.prepare("UPDATE manager_operations SET state = 'running', attempt_count = attempt_count + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE operation_id = ? AND state = 'accepted'")
				.run(now, now, String(row.operation_id));
			return this.getOperation(String(row.operation_id));
		});
	}

	completeOperation(operationId: string, result: unknown): ManagerOperationReceipt {
		const current = this.getOperation(operationId);
		const durableResult = durableManagerReply(result);
		if (current?.state === "succeeded") {
			if (stableJson(durableManagerReply(current.result)) !== stableJson(durableResult)) throw new Error(`Operation ${operationId} was completed with different evidence`);
			return operationReceipt(current);
		}
		if (current?.state === "failed") throw new Error(`Operation ${operationId} is already failed`);
		const now = new Date().toISOString();
		this.database.prepare("UPDATE manager_operations SET state = 'succeeded', result_json = ?, error = NULL, finished_at = ?, updated_at = ? WHERE operation_id = ? AND state = 'running'")
			.run(JSON.stringify(durableResult), now, now, operationId);
		const operation = this.getOperation(operationId);
		if (!operation || operation.state !== "succeeded") throw new Error(`Operation ${operationId} is not running`);
		return operationReceipt(operation);
	}

	failOperation(operationId: string, error: string): ManagerOperationReceipt {
		const current = this.getOperation(operationId);
		const bounded = error.slice(0, 16_384);
		if (current?.state === "failed") {
			if (current.error !== bounded) throw new Error(`Operation ${operationId} was failed with different evidence`);
			return operationReceipt(current);
		}
		if (current?.state === "succeeded") throw new Error(`Operation ${operationId} is already succeeded`);
		const now = new Date().toISOString();
		this.database.prepare("UPDATE manager_operations SET state = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE operation_id = ? AND state = 'running'")
			.run(bounded, now, now, operationId);
		const operation = this.getOperation(operationId);
		if (!operation || operation.state !== "failed") throw new Error(`Operation ${operationId} is not running`);
		return operationReceipt(operation);
	}

	operationReceipt(operationId: string): ManagerOperationReceipt | null {
		const operation = this.getOperation(operationId);
		return operation ? operationReceipt(operation) : null;
	}

	pendingOperationReceipts(): ManagerOperationReceipt[] {
		return (this.database.prepare("SELECT * FROM manager_operations WHERE state IN ('accepted', 'running') ORDER BY sequence LIMIT 32").all() as Record<string, unknown>[])
			.map((row) => operationReceipt(rowToOperation(row)));
	}

	putSnapshot(reply: ManagerReply): void {
		const current = this.database.prepare("SELECT revision FROM manager_snapshots WHERE singleton = 1").get() as { revision?: number } | undefined;
		const revision = Number(current?.revision ?? 0) + 1;
		this.database.prepare(`
			INSERT INTO manager_snapshots (singleton, revision, reply_json, updated_at)
			VALUES (1, ?, ?, ?)
			ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision, reply_json = excluded.reply_json, updated_at = excluded.updated_at
		`).run(revision, JSON.stringify(durableManagerReply(reply)), new Date().toISOString());
	}

	getSnapshotEnvelope(): { revision: number; updatedAt: string; reply: ManagerReply } | null {
		const row = this.database.prepare("SELECT revision, reply_json, updated_at FROM manager_snapshots WHERE singleton = 1").get() as { revision?: number; reply_json?: string; updated_at?: string } | undefined;
		return row?.reply_json ? { revision: Number(row.revision), updatedAt: String(row.updated_at), reply: exposedManagerReply(JSON.parse(row.reply_json)) as ManagerReply } : null;
	}

	getAttention(requestId: string): StoredAttentionRequest | null {
		const row = this.database.prepare("SELECT * FROM manager_attention_requests WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
		return row ? rowToAttention(row) : null;
	}

	/** Return the immutable payload hash for the first resolution that actually committed. */
	getAttentionResolutionHash(requestId: string): string | null {
		const rows = this.database.prepare("SELECT payload_json, state FROM manager_operations WHERE kind = 'event' AND state IN ('running', 'succeeded') ORDER BY sequence").all() as Array<{ payload_json: string; state: string }>;
		for (const row of rows) {
			try {
				const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
				if (payload.kind !== "attention") continue;
				const resolution = payload.attention;
				if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) continue;
				if (String((resolution as { requestId?: unknown }).requestId || "") !== requestId) continue;
				const action = String((resolution as { action?: unknown }).action || "").trim().toLowerCase().replace(/[- ]+/g, "_");
				// Defer is durable input, but it does not commit a resolution. A later
				// answer/retry/recovery action is the payload bound to the resolved row.
				if (action === "defer") continue;
				return sha256(stableJson(resolution));
			} catch {
				// A malformed historical operation remains evidence, but cannot bind a new replay.
			}
		}
		return null;
	}

	getAttentionCleanupEvidence(identity: AttentionCleanupIdentity): ResetPlanCleanupEvidence | null {
		const worktreeIntent = this.findAttentionCleanupEvidence(identity, "worktree_removed", "prepared");
		const worktreeComplete = this.findAttentionCleanupEvidence(identity, "worktree_removed", "completed");
		const branchIntent = this.findAttentionCleanupEvidence(identity, "branch_deleted", "prepared");
		const branchComplete = this.findAttentionCleanupEvidence(identity, "branch_deleted", "completed");
		// Branch deletion is a successor transition. It is never sufficient on its
		// own: the manager must have durably completed worktree removal first.
		if (worktreeComplete && branchIntent) return branchComplete ?? branchIntent;
		return worktreeComplete ?? worktreeIntent;
	}

	/** Persist a manager-owned cleanup intent before the corresponding Git mutation. */
	recordAttentionCleanupStep(identity: AttentionCleanupIdentity, step: AttentionCleanupStep): ResetPlanCleanupEvidence {
		if (step === "branch_deleted" && !this.findAttentionCleanupEvidence(identity, "worktree_removed", "completed")) {
			throw new Error("Branch cleanup requires completed manager-owned worktree cleanup evidence");
		}
		return this.recordAttentionCleanupEvidence(identity, step, "prepared");
	}

	/** Persist successful completion without making replay depend on a post-mutation callback. */
	recordAttentionCleanupCompletion(identity: AttentionCleanupIdentity, step: AttentionCleanupStep): ResetPlanCleanupEvidence {
		if (!this.findAttentionCleanupEvidence(identity, step, "prepared")) {
			throw new Error(`Cleanup step ${step} has no manager-owned preparation evidence`);
		}
		if (step === "branch_deleted" && !this.findAttentionCleanupEvidence(identity, "worktree_removed", "completed")) {
			throw new Error("Branch cleanup requires completed manager-owned worktree cleanup evidence");
		}
		return this.recordAttentionCleanupEvidence(identity, step, "completed");
	}

	private findAttentionCleanupEvidence(identity: AttentionCleanupIdentity, step: AttentionCleanupStep, state: "prepared" | "completed"): ResetPlanCleanupEvidence | null {
		const kind = state === "prepared" ? ATTENTION_CLEANUP_INTENT_KIND : ATTENTION_CLEANUP_COMPLETE_KIND;
		const canonical = canonicalEventPayload(attentionCleanupPayload(identity, step, state));
		const row = this.database.prepare(`
			SELECT event_id
			FROM manager_events
			WHERE run_id = ? AND kind = ? AND payload_sha256 = ? AND event_id LIKE ?
			LIMIT 1
		`).get(identity.runId, kind, canonical.sha256, `${ATTENTION_CLEANUP_EVENT_PREFIX}%`) as Record<string, unknown> | undefined;
		return row ? { ...identity, evidenceId: String(row.event_id), step, state } : null;
	}

	private recordAttentionCleanupEvidence(identity: AttentionCleanupIdentity, step: AttentionCleanupStep, state: "prepared" | "completed"): ResetPlanCleanupEvidence {
		const existing = this.findAttentionCleanupEvidence(identity, step, state);
		if (existing) return existing;
		const canonical = canonicalEventPayload(attentionCleanupPayload(identity, step, state));
		const eventId = `${ATTENTION_CLEANUP_EVENT_PREFIX}${randomUUID()}`;
		const colliding = this.database.prepare("SELECT run_id, kind, payload_sha256 FROM manager_events WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
		if (colliding) throw new Error(`Cleanup evidence token ${eventId} is already in use`);
		this.database.prepare(`
			INSERT INTO manager_events (event_id, run_id, kind, payload_sha256, created_at)
			VALUES (?, ?, ?, ?, ?)
		`).run(eventId, identity.runId, state === "prepared" ? ATTENTION_CLEANUP_INTENT_KIND : ATTENTION_CLEANUP_COMPLETE_KIND, canonical.sha256, new Date().toISOString());
		return { ...identity, evidenceId: eventId, step, state };
	}

	getAttentionRequests(runId: string, options: { unresolvedOnly?: boolean } = {}): StoredAttentionRequest[] {
		const rows = this.database.prepare(`
			SELECT * FROM manager_attention_requests
			WHERE run_id = ? ${options.unresolvedOnly ? "AND state <> 'resolved'" : ""}
			ORDER BY plan_id COLLATE BINARY, sequence
		`).all(runId) as Record<string, unknown>[];
		return rows.map(rowToAttention);
	}

	getNextAttention(runId: string): StoredAttentionRequest | null {
		const row = this.database.prepare(`
			SELECT * FROM manager_attention_requests
			WHERE run_id = ? AND state <> 'resolved'
			ORDER BY plan_id COLLATE BINARY, sequence
			LIMIT 1
		`).get(runId) as Record<string, unknown> | undefined;
		return row ? rowToAttention(row) : null;
	}

	getNextInputAttention(runId: string): StoredAttentionRequest | null {
		const row = this.database.prepare(`
			SELECT * FROM manager_attention_requests
			WHERE run_id = ? AND state <> 'resolved'
				AND kind IN ('user_decision', 'operator_attention')
			ORDER BY plan_id COLLATE BINARY, sequence
			LIMIT 1
		`).get(runId) as Record<string, unknown> | undefined;
		return row ? rowToAttention(row) : null;
	}

	putAttention(input: AttentionRequestInput): StoredAttentionRequest {
		validateAttentionRequest(input);
		const existingById = this.getAttention(input.requestId);
		if (existingById) {
			if (attentionIdentity(existingById) !== attentionIdentity(input)) throw new Error(`Attention request ${input.requestId} was replayed with different evidence`);
			return existingById;
		}
		const existingUnresolved = this.database.prepare(`
			SELECT * FROM manager_attention_requests
			WHERE run_id = ? AND plan_id = ? AND cause = ? AND state <> 'resolved'
			ORDER BY sequence LIMIT 1
		`).get(input.runId, input.planId, input.cause) as Record<string, unknown> | undefined;
		if (existingUnresolved) return rowToAttention(existingUnresolved);
		this.database.prepare(`
			INSERT INTO manager_attention_requests (
			request_id, run_id, plan_id, generation, round_number, action_id, request_sha256,
			kind, state, cause, detail, detail_sha256, continuation_role,
			continuation_phase, question, recommended_action, recovery_json,
			created_at, updated_at, resolved_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.requestId, input.runId, input.planId, input.generation, input.round, input.actionId, input.requestSha256,
			input.kind, input.state, input.cause, input.detail, input.detailSha256,
			input.continuation.role, input.continuation.phase, input.question ?? null,
			input.recommendedAction ?? null, input.kind === "plan_recovery" ? JSON.stringify(input.recovery) : null,
			input.createdAt, input.updatedAt, input.resolvedAt ?? null,
		);
		return this.getAttention(input.requestId)!;
	}

	beginRecoveryEdit(requestId: string): StoredAttentionRequest {
		const existing = this.getAttention(requestId);
		if (!existing) throw new Error(`Unknown attention request ${requestId}`);
		if (existing.kind !== "plan_recovery") throw new Error(`Attention request ${requestId} is not a plan-recovery request`);
		if (existing.state === "editing") return existing;
		if (existing.state === "resolved") throw new Error(`Attention request ${requestId} is already resolved`);
		if (existing.state !== "pending" && existing.state !== "awaiting_input") {
			throw new Error(`Attention request ${requestId} cannot enter editing from ${existing.state}`);
		}
		const now = new Date().toISOString();
		this.database.prepare("UPDATE manager_attention_requests SET state = ?, updated_at = ? WHERE request_id = ?")
			.run("editing", now, requestId);
		return this.getAttention(requestId)!;
	}

	resolveAttention(requestId: string): StoredAttentionRequest {
		const existing = this.getAttention(requestId);
		if (!existing) throw new Error(`Unknown attention request ${requestId}`);
		if (existing.state === "resolved") return existing;
		const now = new Date().toISOString();
		this.database.prepare("UPDATE manager_attention_requests SET state = ?, updated_at = ?, resolved_at = ? WHERE request_id = ?")
			.run("resolved", now, now, requestId);
		return this.getAttention(requestId)!;
	}

	getVerification(runId: string, generation?: number): StoredVerification | null {
		const row = generation === undefined
			? this.database.prepare("SELECT * FROM manager_verifications WHERE run_id = ? ORDER BY generation DESC, created_at DESC LIMIT 1").get(runId)
			: this.database.prepare("SELECT * FROM manager_verifications WHERE run_id = ? AND generation = ? ORDER BY created_at DESC LIMIT 1").get(runId, generation);
		return row ? rowToVerification(row as Record<string, unknown>) : null;
	}

	getVerificationByRequestId(requestId: string): StoredVerification | null {
		const row = this.database.prepare("SELECT * FROM manager_verifications WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
		return row ? rowToVerification(row) : null;
	}

	recordInitialIntegrationRepairFailure(verification: StoredVerification, detail: string | null): StoredIntegrationRepair {
		const existing = this.getIntegrationRepairForRequest(verification.request.requestId);
		if (existing) return existing;
		const canonicalGates = verification.manifest?.gates ?? [];
		const canonicalGatesSha256 = sha256(stableJson(canonicalGates));
		return this.putIntegrationRepair({
			repairId: randomUUID(),
			runId: verification.request.runId,
			generation: verification.request.generation,
			requestId: verification.request.requestId,
			requestSha256: verification.request.requestSha256,
			ownerSessionId: null,
			capabilityDigest: null,
			classification: null,
			state: "failed",
			round: 1,
			parentCommit: verification.request.integrationHead,
			currentTree: verification.request.integrationTree,
			canonicalGates,
			canonicalGatesSha256,
			effectiveGates: canonicalGates,
			detail,
			episode: {
				integrationHead: verification.request.integrationHead,
				integrationTree: verification.request.integrationTree,
				canonicalGates,
				canonicalGatesSha256,
			},
		});
	}

	private integrationRepairSelect(): string {
		return `
			SELECT r.*, (SELECT EXISTS (
				SELECT 1 FROM manager_integration_repair_episodes h
				WHERE h.repair_id = r.repair_id AND h.transient_used = 1
				  AND h.integration_head = e.integration_head AND h.integration_tree = e.integration_tree
				  AND h.canonical_gates_sha256 = e.canonical_gates_sha256
			)) AS transient_retry_used,
			e.episode_id AS episode_current_id,
				e.repair_id AS episode_repair_id, e.request_id AS episode_request_id, e.request_sha256 AS episode_request_sha256,
				e.integration_head AS episode_integration_head, e.integration_tree AS episode_integration_tree,
				e.canonical_gates_json AS episode_canonical_gates_json, e.canonical_gates_sha256 AS episode_canonical_gates_sha256,
				e.classification AS episode_classification, e.state AS episode_state,
				e.operation_id AS episode_operation_id, e.operation_payload_sha256 AS episode_operation_payload_sha256,
				e.transient_used AS episode_transient_used, e.transient_use_evidence_sha256 AS episode_transient_use_evidence_sha256,
				e.created_at AS episode_created_at, e.updated_at AS episode_updated_at, e.closed_at AS episode_closed_at
			FROM manager_integration_repairs r
			LEFT JOIN manager_integration_repair_episodes e ON e.episode_id = r.current_episode_id
		`;
	}

	getIntegrationRepair(repairId: string): StoredIntegrationRepair | null {
		const row = this.database.prepare(`${this.integrationRepairSelect()} WHERE r.repair_id = ?`).get(repairId) as Record<string, unknown> | undefined;
		return row ? rowToIntegrationRepair(row) : null;
	}

	getIntegrationRepairForRequest(requestId: string): StoredIntegrationRepair | null {
		const row = this.database.prepare(`${this.integrationRepairSelect()}
			WHERE r.request_id = ? OR r.successor_request_id = ?
			   OR EXISTS (SELECT 1 FROM manager_integration_repair_episodes h WHERE h.repair_id = r.repair_id AND h.request_id = ?)
			ORDER BY r.updated_at DESC LIMIT 1
		`).get(requestId, requestId, requestId) as Record<string, unknown> | undefined;
		return row ? rowToIntegrationRepair(row) : null;
	}

	getIntegrationRepairForRun(runId: string, generation?: number): StoredIntegrationRepair | null {
		const row = generation === undefined
			? this.database.prepare(`${this.integrationRepairSelect()} WHERE r.run_id = ? ORDER BY r.generation DESC, r.updated_at DESC LIMIT 1`).get(runId)
			: this.database.prepare(`${this.integrationRepairSelect()} WHERE r.run_id = ? AND r.generation = ? ORDER BY r.updated_at DESC LIMIT 1`).get(runId, generation);
		return row ? rowToIntegrationRepair(row as Record<string, unknown>) : null;
	}

	hasOtherIntegrationRepairForGeneration(runId: string, generation: number, repairId: string): boolean {
		const row = this.database.prepare(`
			SELECT 1
			FROM manager_integration_repairs
			WHERE run_id = ? AND generation = ? AND repair_id <> ?
			LIMIT 1
		`).get(runId, generation, repairId);
		return Boolean(row);
	}

	getIntegrationRepairEpisode(episodeId: string): StoredIntegrationRepairEpisode | null {
		const row = this.database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?").get(episodeId) as Record<string, unknown> | undefined;
		return row ? rowToIntegrationRepairEpisode(row) : null;
	}

	getIntegrationRepairEpisodes(repairId: string): StoredIntegrationRepairEpisode[] {
		return (this.database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE repair_id = ? ORDER BY created_at, episode_id").all(repairId) as Record<string, unknown>[]).map(rowToIntegrationRepairEpisode);
	}

	getIntegrationRepairAudits(repairId: string): StoredIntegrationRepairAudit[] {
		return (this.database.prepare("SELECT * FROM manager_integration_repair_audits WHERE repair_id = ? ORDER BY audit_id").all(repairId) as Record<string, unknown>[]).map(rowToIntegrationRepairAudit);
	}

	putIntegrationRepair(input: {
		repairId: string;
		runId: string;
		generation: number;
		requestId: string;
		requestSha256: string;
		ownerSessionId: string | null;
		capabilityDigest: string | null;
		classification?: IntegrationRepairClassification | null;
		state?: IntegrationRepairState;
		round?: number;
		parentCommit: string;
		currentTree?: string | null;
		beginRefSnapshot?: string | null;
		beginRefSnapshotSha256?: string | null;
		canonicalGates: VerificationManifest["gates"];
		canonicalGatesSha256: string;
		effectiveGates?: VerificationManifest["gates"];
		operationId?: string | null;
		operationPayloadSha256?: string | null;
		acceptedCodeRounds?: number;
		episode?: {
			episodeId?: string;
			integrationHead?: string;
			integrationTree?: string;
			canonicalGates?: VerificationManifest["gates"];
			canonicalGatesSha256?: string;
		};
		detail?: string | null;
	}): StoredIntegrationRepair {
		const providedBeginEvidence = input.beginRefSnapshot !== undefined || input.beginRefSnapshotSha256 !== undefined;
		const beginEvidence = normalizeBeginRefSnapshot(input.beginRefSnapshot, input.beginRefSnapshotSha256);
		const episodeGates = input.episode?.canonicalGates ?? input.canonicalGates;
		const episodeHead = input.episode?.integrationHead ?? input.parentCommit;
		const episodeTree = input.episode?.integrationTree ?? input.currentTree ?? input.parentCommit;
		const calculatedEpisodeId = integrationRepairEpisodeId({
			requestId: input.requestId,
			requestSha256: input.requestSha256,
			integrationHead: episodeHead,
			integrationTree: episodeTree,
			canonicalGates: episodeGates,
		});
		const episodeId = input.episode?.episodeId ?? calculatedEpisodeId;
		if (episodeId !== calculatedEpisodeId || (input.episode?.canonicalGatesSha256 ?? input.canonicalGatesSha256) !== sha256(stableJson(episodeGates))) {
			throw new Error(`Integration repair episode ${episodeId} was supplied with different evidence`);
		}
		const existing = this.getIntegrationRepair(input.repairId);
		if (existing) {
			if (existing.runId !== input.runId || existing.generation !== input.generation
				|| existing.requestId !== input.requestId || existing.requestSha256 !== input.requestSha256
				|| existing.ownerSessionId !== input.ownerSessionId || existing.capabilityDigest !== input.capabilityDigest
				|| existing.parentCommit !== input.parentCommit || existing.canonicalGatesSha256 !== input.canonicalGatesSha256
				|| (providedBeginEvidence && (existing.beginRefSnapshot !== beginEvidence.json || existing.beginRefSnapshotSha256 !== beginEvidence.sha256))) {
				throw new Error(`Integration repair ${input.repairId} was replayed with different evidence`);
			}
			return existing;
		}
		const codeRounds = input.acceptedCodeRounds ?? 0;
		if (!Number.isSafeInteger(codeRounds) || codeRounds < 0 || codeRounds > 3) throw new Error("Integration repair accepted code rounds are out of bounds");
		const now = new Date().toISOString();
		this.database.prepare(`
			INSERT INTO manager_integration_repairs (
				repair_id, run_id, generation, request_id, request_sha256, owner_session_id, capability_digest,
				classification, state, round_number, max_rounds, parent_commit, current_commit, current_tree,
				begin_ref_snapshot_json, begin_ref_snapshot_sha256, superseded_commits_json,
				canonical_gates_json, canonical_gates_sha256, effective_gates_json,
				successor_request_id, successor_request_sha256, successor_manifest_json, successor_manifest_sha256,
				operation_id, operation_payload_sha256, detail, accepted_code_rounds, current_episode_id, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, NULL, NULL, ?, ?, '[]', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.repairId, input.runId, input.generation, input.requestId, input.requestSha256,
			input.ownerSessionId ?? "", input.capabilityDigest ?? "", input.classification ?? null, input.state ?? "active",
			input.round ?? 1, input.parentCommit, beginEvidence.json, beginEvidence.sha256,
			JSON.stringify(input.canonicalGates), input.canonicalGatesSha256,
			JSON.stringify(input.effectiveGates ?? input.canonicalGates), input.operationId ?? null,
			input.operationPayloadSha256 ?? null, input.detail ?? null, codeRounds, episodeId, now, now,
		);
		this.database.prepare(`
			INSERT INTO manager_integration_repair_episodes (
				episode_id, repair_id, request_id, request_sha256, integration_head, integration_tree,
				canonical_gates_json, canonical_gates_sha256, classification, state,
				operation_id, operation_payload_sha256, transient_used, transient_use_evidence_sha256,
				created_at, updated_at, closed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL)
		`).run(
			episodeId, input.repairId, input.requestId, input.requestSha256, episodeHead, episodeTree,
			JSON.stringify(episodeGates), input.episode?.canonicalGatesSha256 ?? input.canonicalGatesSha256,
			input.classification ?? null, input.state ?? "active", input.operationId ?? null,
			input.operationPayloadSha256 ?? null, now, now,
		);
		return this.getIntegrationRepair(input.repairId)!;
	}

	updateIntegrationRepair(repairId: string, patch: {
		requestId?: string;
		requestSha256?: string;
		ownerSessionId?: string | null;
		capabilityDigest?: string | null;
		classification?: IntegrationRepairClassification | null;
		state?: IntegrationRepairState;
		round?: number;
		currentCommit?: string | null;
		currentTree?: string | null;
		beginRefSnapshot?: string | null;
		beginRefSnapshotSha256?: string | null;
		supersededCommits?: string[];
		effectiveGates?: VerificationManifest["gates"];
		successorRequestId?: string | null;
		successorRequestSha256?: string | null;
		successorManifest?: VerificationManifest | null;
		successorManifestSha256?: string | null;
		operationId?: string | null;
		operationPayloadSha256?: string | null;
		acceptedCodeRounds?: number;
		detail?: string | null;
	}): StoredIntegrationRepair {
		const existing = this.getIntegrationRepair(repairId);
		if (!existing) throw new Error(`Unknown integration repair ${repairId}`);
		const providedBeginEvidence = patch.beginRefSnapshot !== undefined || patch.beginRefSnapshotSha256 !== undefined;
		const beginEvidence = providedBeginEvidence
			? normalizeBeginRefSnapshot(patch.beginRefSnapshot, patch.beginRefSnapshotSha256)
			: { json: existing.beginRefSnapshot, sha256: existing.beginRefSnapshotSha256 };
		if (existing.beginRefSnapshot !== null && (beginEvidence.json !== existing.beginRefSnapshot || beginEvidence.sha256 !== existing.beginRefSnapshotSha256)) {
			throw new Error(`Integration repair ${repairId} begin-ref evidence is immutable`);
		}
		const next = {
			requestId: patch.requestId ?? existing.requestId,
			requestSha256: patch.requestSha256 ?? existing.requestSha256,
			ownerSessionId: patch.ownerSessionId === undefined ? existing.ownerSessionId : patch.ownerSessionId,
			capabilityDigest: patch.capabilityDigest === undefined ? existing.capabilityDigest : patch.capabilityDigest,
			classification: patch.classification === undefined ? existing.classification : patch.classification,
			state: patch.state ?? existing.state,
			round: patch.round ?? existing.round,
			currentCommit: patch.currentCommit === undefined ? existing.currentCommit : patch.currentCommit,
			currentTree: patch.currentTree === undefined ? existing.currentTree : patch.currentTree,
			beginRefSnapshot: beginEvidence.json,
			beginRefSnapshotSha256: beginEvidence.sha256,
			supersededCommits: patch.supersededCommits ?? existing.supersededCommits,
			effectiveGates: patch.effectiveGates ?? existing.effectiveGates,
			successorRequestId: patch.successorRequestId === undefined ? existing.successorRequestId : patch.successorRequestId,
			successorRequestSha256: patch.successorRequestSha256 === undefined ? existing.successorRequestSha256 : patch.successorRequestSha256,
			successorManifest: patch.successorManifest === undefined ? existing.successorManifest : patch.successorManifest,
			successorManifestSha256: patch.successorManifestSha256 === undefined ? existing.successorManifestSha256 : patch.successorManifestSha256,
			operationId: patch.operationId === undefined ? existing.operationId : patch.operationId,
			operationPayloadSha256: patch.operationPayloadSha256 === undefined ? existing.operationPayloadSha256 : patch.operationPayloadSha256,
			acceptedCodeRounds: patch.acceptedCodeRounds ?? existing.acceptedCodeRounds,
			detail: patch.detail === undefined ? existing.detail : patch.detail,
		};
		if (!Number.isSafeInteger(next.acceptedCodeRounds) || next.acceptedCodeRounds < 0 || next.acceptedCodeRounds > 3) throw new Error("Integration repair accepted code rounds are out of bounds");
		if (existing.episodeClassification !== null && patch.classification !== undefined && patch.classification !== existing.episodeClassification) {
			throw new Error(`Integration repair episode ${existing.episodeId} classification is immutable`);
		}
		this.database.prepare(`
			UPDATE manager_integration_repairs SET request_id = ?, request_sha256 = ?, owner_session_id = ?, capability_digest = ?, classification = ?,
			state = ?, round_number = ?, current_commit = ?, current_tree = ?, begin_ref_snapshot_json = ?, begin_ref_snapshot_sha256 = ?,
			superseded_commits_json = ?, effective_gates_json = ?, accepted_code_rounds = ?,
			successor_request_id = ?, successor_request_sha256 = ?, successor_manifest_json = ?, successor_manifest_sha256 = ?,
			operation_id = ?, operation_payload_sha256 = ?, detail = ?, updated_at = ? WHERE repair_id = ?
		`).run(
			next.requestId, next.requestSha256, next.ownerSessionId ?? "", next.capabilityDigest ?? "", next.classification, next.state, next.round,
			next.currentCommit, next.currentTree, next.beginRefSnapshot, next.beginRefSnapshotSha256,
			JSON.stringify(next.supersededCommits), JSON.stringify(next.effectiveGates), next.acceptedCodeRounds,
			next.successorRequestId, next.successorRequestSha256, next.successorManifest ? JSON.stringify(next.successorManifest) : null,
			next.successorManifestSha256, next.operationId, next.operationPayloadSha256, next.detail, new Date().toISOString(), repairId,
		);
		if (existing.episodeId) {
			this.database.prepare("UPDATE manager_integration_repair_episodes SET classification = ?, state = ?, updated_at = ? WHERE episode_id = ? AND closed_at IS NULL")
				.run(next.classification, next.state, new Date().toISOString(), existing.episodeId);
		}
		return this.getIntegrationRepair(repairId)!;
	}

	closeIntegrationRepairEpisode(repairId: string, episodeId: string, state: IntegrationRepairState): StoredIntegrationRepairEpisode {
		const episode = this.getIntegrationRepairEpisode(episodeId);
		if (!episode || episode.repairId !== repairId) throw new Error(`Unknown integration repair episode ${episodeId}`);
		if (episode.closedAt !== null) {
			if (episode.state !== state) throw new Error(`Integration repair episode ${episodeId} was closed with different state`);
			return episode;
		}
		const now = new Date().toISOString();
		this.database.prepare("UPDATE manager_integration_repair_episodes SET state = ?, updated_at = ?, closed_at = ? WHERE episode_id = ? AND closed_at IS NULL")
			.run(state, now, now, episodeId);
		return this.getIntegrationRepairEpisode(episodeId)!;
	}

	openIntegrationRepairEpisode(input: {
		repairId: string;
		requestId: string;
		requestSha256: string;
		integrationHead: string;
		integrationTree: string;
		canonicalGates: VerificationManifest["gates"];
		canonicalGatesSha256: string;
		state: IntegrationRepairState;
		round?: number;
		detail?: string | null;
	}): StoredIntegrationRepair {
		const repair = this.getIntegrationRepair(input.repairId);
		if (!repair) throw new Error(`Unknown integration repair ${input.repairId}`);
		if (input.canonicalGatesSha256 !== sha256(stableJson(input.canonicalGates))) throw new Error(`Integration repair episode evidence hash changed`);
		const episodeId = integrationRepairEpisodeId(input);
		const existing = this.getIntegrationRepairEpisode(episodeId);
		if (existing) {
			if (existing.repairId !== input.repairId || existing.requestId !== input.requestId || existing.requestSha256 !== input.requestSha256
				|| existing.integrationHead !== input.integrationHead || existing.integrationTree !== input.integrationTree
				|| existing.canonicalGatesSha256 !== input.canonicalGatesSha256
				|| stableJson(existing.canonicalGates) !== stableJson(input.canonicalGates)) {
				throw new Error(`Integration repair episode ${episodeId} was replayed with different evidence`);
			}
			if (repair.episodeId !== episodeId) {
				const now = new Date().toISOString();
				this.database.prepare("UPDATE manager_integration_repairs SET current_episode_id = ?, request_id = ?, request_sha256 = ?, classification = NULL, state = ?, round_number = ?, operation_id = NULL, operation_payload_sha256 = NULL, detail = ?, updated_at = ? WHERE repair_id = ?")
					.run(episodeId, input.requestId, input.requestSha256, input.state, input.round ?? repair.round, input.detail ?? null, now, input.repairId);
			}
			return this.getIntegrationRepair(input.repairId)!;
		}
		if (repair.episodeId && repair.episodeId !== episodeId) {
			this.closeIntegrationRepairEpisode(input.repairId, repair.episodeId, repair.episodeState ?? repair.state);
		}
		const now = new Date().toISOString();
		this.database.prepare(`
			INSERT INTO manager_integration_repair_episodes (
				episode_id, repair_id, request_id, request_sha256, integration_head, integration_tree,
				canonical_gates_json, canonical_gates_sha256, classification, state,
				operation_id, operation_payload_sha256, transient_used, transient_use_evidence_sha256,
				created_at, updated_at, closed_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, 0, NULL, ?, ?, NULL)
		`).run(
			episodeId, input.repairId, input.requestId, input.requestSha256, input.integrationHead, input.integrationTree,
			JSON.stringify(input.canonicalGates), input.canonicalGatesSha256, input.state, now, now,
		);
		this.database.prepare("UPDATE manager_integration_repairs SET current_episode_id = ?, request_id = ?, request_sha256 = ?, classification = NULL, state = ?, round_number = ?, operation_id = NULL, operation_payload_sha256 = NULL, detail = ?, updated_at = ? WHERE repair_id = ?")
			.run(episodeId, input.requestId, input.requestSha256, input.state, input.round ?? repair.round, input.detail ?? null, now, input.repairId);
		return this.getIntegrationRepair(input.repairId)!;
	}

	selectIntegrationRepairEpisode(repairId: string, input: { classification: IntegrationRepairClassification; operationId: string; operationPayloadSha256: string; state: IntegrationRepairState }): StoredIntegrationRepair {
		const repair = this.getIntegrationRepair(repairId);
		if (!repair || !repair.episodeId) throw new Error(`Integration repair ${repairId} has no current classification episode`);
		if (repair.episodeClassification !== null && repair.episodeClassification !== input.classification) {
			throw new Error(`Integration repair episode ${repair.episodeId} classification cannot change within an episode`);
		}
		if (repair.episodeOperationId !== null && (repair.episodeOperationId !== input.operationId || repair.episodeOperationPayloadSha256 !== input.operationPayloadSha256)) {
			throw new Error(`Integration repair episode ${repair.episodeId} operation was replayed with different evidence`);
		}
		const now = new Date().toISOString();
		this.database.prepare("UPDATE manager_integration_repair_episodes SET classification = ?, state = ?, operation_id = COALESCE(operation_id, ?), operation_payload_sha256 = COALESCE(operation_payload_sha256, ?), updated_at = ? WHERE episode_id = ? AND closed_at IS NULL")
			.run(input.classification, input.state, input.operationId, input.operationPayloadSha256, now, repair.episodeId);
		this.database.prepare("UPDATE manager_integration_repairs SET classification = ?, state = ?, operation_id = ?, operation_payload_sha256 = ?, updated_at = ? WHERE repair_id = ?")
			.run(input.classification, input.state, input.operationId, input.operationPayloadSha256, now, repairId);
		return this.getIntegrationRepair(repairId)!;
	}

	markIntegrationRepairEpisodeTransientUsed(repairId: string, episodeId: string, evidenceSha256: string): StoredIntegrationRepairEpisode {
		const episode = this.getIntegrationRepairEpisode(episodeId);
		if (!episode || episode.repairId !== repairId) throw new Error(`Unknown integration repair episode ${episodeId}`);
		if (episode.transientUsed) {
			if (episode.transientUseEvidenceSha256 !== evidenceSha256) throw new Error(`Integration repair episode ${episodeId} transient evidence changed`);
			return episode;
		}
		this.database.prepare("UPDATE manager_integration_repair_episodes SET transient_used = 1, transient_use_evidence_sha256 = ?, updated_at = ? WHERE episode_id = ? AND closed_at IS NULL")
			.run(evidenceSha256, new Date().toISOString(), episodeId);
		return this.getIntegrationRepairEpisode(episodeId)!;
	}

	hasIntegrationRepairTransientUse(repairId: string, evidence: { integrationHead: string; integrationTree: string; canonicalGatesSha256: string }): boolean {
		return Boolean(this.database.prepare(`
			SELECT 1 FROM manager_integration_repair_episodes
			WHERE repair_id = ? AND transient_used = 1 AND integration_head = ? AND integration_tree = ? AND canonical_gates_sha256 = ?
			LIMIT 1
		`).get(repairId, evidence.integrationHead, evidence.integrationTree, evidence.canonicalGatesSha256));
	}

	recordIntegrationRepairAudit(repairId: string, operationId: string, action: string, payloadSha256: string, evidence: unknown, episodeId?: string | null): StoredIntegrationRepairAudit {
		const canonicalEvidence = canonicalEventPayload(evidence).json;
		const repair = this.getIntegrationRepair(repairId);
		if (!repair) throw new Error(`Unknown integration repair ${repairId}`);
		const expectedEpisodeId = episodeId ?? repair.episodeId;
		const existing = this.database.prepare("SELECT * FROM manager_integration_repair_audits WHERE repair_id = ? AND operation_id = ? AND action = ?").get(repairId, operationId, action) as Record<string, unknown> | undefined;
		if (existing) {
			if (String(existing.payload_sha256) !== payloadSha256 || String(existing.evidence_json) !== canonicalEvidence
				|| (expectedEpisodeId && existing.episode_id && String(existing.episode_id) !== expectedEpisodeId)) {
				throw new Error(`Integration repair audit ${action} was replayed with different evidence`);
			}
			return rowToIntegrationRepairAudit(existing);
		}
		this.database.prepare(`INSERT INTO manager_integration_repair_audits (repair_id, episode_id, operation_id, action, payload_sha256, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(repairId, expectedEpisodeId, operationId, action, payloadSha256, canonicalEvidence, new Date().toISOString());
		return rowToIntegrationRepairAudit(this.database.prepare("SELECT * FROM manager_integration_repair_audits WHERE repair_id = ? AND operation_id = ? AND action = ?").get(repairId, operationId, action) as Record<string, unknown>);
	}

	putVerificationRequest(request: VerificationRequest): StoredVerification {
		const existingById = this.getVerificationByRequestId(request.requestId);
		if (existingById) {
			if (existingById.request.requestSha256 !== request.requestSha256) throw new Error(`Verification request ${request.requestId} was replayed with different evidence`);
			return existingById;
		}
		const existing = this.getVerification(request.runId, request.generation);
		if (existing && existing.state !== "failed") {
			if (existing.request.requestSha256 !== request.requestSha256) throw new Error(`Verification request changed for generation ${request.generation}`);
			return existing;
		}
		this.database.prepare(`
			INSERT INTO manager_verifications (
				request_id, run_id, generation, graph_sha256, run_assignment_path, run_assignment_sha256,
				integration_branch, integration_worktree, integration_head, integration_tree, request_sha256,
				state, manifest_json, manifest_sha256, result_json, terminal_detail, predecessor_request_id, repair_id, repair_round, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_manifest', NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)
		`).run(
			request.requestId, request.runId, request.generation, request.graphSha256,
			request.runAssignmentPath, request.runAssignmentSha256, request.integrationBranch,
			request.integrationWorktree, request.integrationHead, request.integrationTree,
			request.requestSha256, request.predecessorRequestId ?? null, request.repairId ?? null,
			request.repairRound ?? null, request.requestedAt, request.requestedAt,
		);
		return this.getVerification(request.runId, request.generation)!;
	}

	startVerification(requestId: string, manifest: VerificationManifest, manifestSha256: string): StoredVerification {
		const row = this.database.prepare("SELECT * FROM manager_verifications WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
		if (!row) throw new Error(`Unknown verification request ${requestId}`);
		const existing = rowToVerification(row);
		if (existing.manifestSha256 && existing.manifestSha256 !== manifestSha256) throw new Error(`Verification request ${requestId} was submitted with a different manifest`);
		if (existing.state === "passed" || existing.state === "failed" || existing.state === "running") return existing;
		this.database.prepare("UPDATE manager_verifications SET state = 'running', manifest_json = ?, manifest_sha256 = ?, terminal_detail = NULL, updated_at = ? WHERE request_id = ? AND state = 'awaiting_manifest'")
			.run(JSON.stringify(manifest), manifestSha256, new Date().toISOString(), requestId);
		return rowToVerification(this.database.prepare("SELECT * FROM manager_verifications WHERE request_id = ?").get(requestId) as Record<string, unknown>);
	}

	finishVerification(requestId: string, state: "passed" | "failed", result: unknown, terminalDetail: string | null): StoredVerification {
		const row = this.database.prepare("SELECT * FROM manager_verifications WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
		if (!row) throw new Error(`Unknown verification request ${requestId}`);
		const existing = rowToVerification(row);
		if (existing.state === "passed" || existing.state === "failed") {
			if (existing.state !== state || stableJson(existing.result) !== stableJson(result) || existing.terminalDetail !== terminalDetail) {
				throw new Error(`Verification request ${requestId} was finalized with different evidence`);
			}
			return existing;
		}
		if (existing.state !== "running") throw new Error(`Verification request ${requestId} is not running`);
		this.database.prepare("UPDATE manager_verifications SET state = ?, result_json = ?, terminal_detail = ?, updated_at = ? WHERE request_id = ? AND state = 'running'")
			.run(state, JSON.stringify(result), terminalDetail, new Date().toISOString(), requestId);
		const updated = this.database.prepare("SELECT * FROM manager_verifications WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
		if (!updated) throw new Error(`Unknown verification request ${requestId}`);
		return rowToVerification(updated);
	}

	getReigniteRequest(runId: string, generation?: number): ReigniteRequest | null {
		const row = generation === undefined
			? this.database.prepare("SELECT * FROM manager_reignite_requests WHERE run_id = ? ORDER BY generation DESC, created_at DESC LIMIT 1").get(runId)
			: this.database.prepare("SELECT * FROM manager_reignite_requests WHERE run_id = ? AND generation = ?").get(runId, generation);
		return row ? rowToReignite(row as Record<string, unknown>) : null;
	}

	putReigniteRequest(request: ReigniteRequest): ReigniteRequest {
		const existing = this.getReigniteRequest(request.runId, request.generation);
		if (existing) {
			if (existing.requestSha256 !== request.requestSha256) {
				throw new Error(`Reignite request changed for generation ${request.generation}`);
			}
			return existing;
		}
		this.database.prepare(`
			INSERT INTO manager_reignite_requests (
				request_id, run_id, generation, request_sha256, source_plan_directory, graph_sha256,
				integration_head, integration_tree, integration_branch, verdict, scope,
				findings_json, fix_guidance_json, rationale, state, allocated_plan_directory, detail, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			request.requestId, request.runId, request.generation, request.requestSha256,
			request.sourcePlanDirectory, request.graphSha256, request.integrationHead,
			request.integrationTree, request.integrationBranch, request.verdict, request.scope,
			JSON.stringify(request.findings), JSON.stringify(request.fixGuidance), request.rationale,
			request.state, request.allocatedPlanDirectory ?? null, request.detail ?? null, request.createdAt,
		);
		return this.getReigniteRequest(request.runId, request.generation)!;
	}

	updateReigniteRequest(requestId: string, patch: {
		allocatedPlanDirectory?: string | null;
		state?: ReigniteRequest["state"];
		detail?: string | null;
	}): ReigniteRequest {
		const row = this.database.prepare("SELECT * FROM manager_reignite_requests WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
		if (!row) throw new Error(`Unknown reignite request ${requestId}`);
		const current = rowToReignite(row);
		const allocatedPlanDirectory = patch.allocatedPlanDirectory === undefined
			? current.allocatedPlanDirectory ?? null
			: patch.allocatedPlanDirectory;
		const state = patch.state ?? current.state;
		const detail = patch.detail === undefined ? current.detail ?? null : patch.detail;
		this.database.prepare("UPDATE manager_reignite_requests SET allocated_plan_directory = ?, state = ?, detail = ? WHERE request_id = ?")
			.run(allocatedPlanDirectory, state, detail, requestId);
		const updated = this.database.prepare("SELECT * FROM manager_reignite_requests WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
		if (!updated) throw new Error(`Unknown reignite request ${requestId}`);
		return rowToReignite(updated);
	}

	getPlanSpecs(runId: string, graphGeneration?: number): StoredPlanSpec[] {
		const generation = graphGeneration ?? this.getRun()?.currentGeneration;
		if (!generation) return [];
		return (this.database.prepare("SELECT * FROM manager_plan_specs WHERE run_id = ? AND graph_generation = ? ORDER BY ordinal, plan_id").all(runId, generation) as Record<string, unknown>[]).map(rowToPlanSpec);
	}

	putPlanSpecs(specs: StoredPlanSpec[]): void {
		const statement = this.database.prepare(`
			INSERT INTO manager_plan_specs (
				run_id, graph_generation, plan_id, plan_fingerprint, fingerprint_version, ordinal, title, priority, effort, kind, dependencies_json,
				initial_status, initial_status_detail, gate_commands_json, plan_file, assignment_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id, graph_generation, plan_id) DO UPDATE SET
				plan_fingerprint = excluded.plan_fingerprint,
				fingerprint_version = excluded.fingerprint_version,
				ordinal = excluded.ordinal,
				title = excluded.title,
				priority = excluded.priority,
				effort = excluded.effort,
				kind = excluded.kind,
				dependencies_json = excluded.dependencies_json,
				initial_status = excluded.initial_status,
				initial_status_detail = excluded.initial_status_detail,
				gate_commands_json = excluded.gate_commands_json,
				plan_file = excluded.plan_file,
				assignment_json = excluded.assignment_json
		`);
		for (const input of specs) {
			statement.run(
				input.runId, input.graphGeneration, input.planId, input.planFingerprint, input.fingerprintVersion,
				input.ordinal, input.title, input.priority, input.effort,
				input.kind, JSON.stringify(input.dependencies), input.initialStatus, input.initialStatusDetail,
				"[]", input.planFile, JSON.stringify(input.assignment),
			);
		}
	}

	getGeneration(runId: string, generation: number): StoredGeneration | null {
		const row = this.database.prepare("SELECT * FROM manager_generations WHERE run_id = ? AND generation = ?").get(runId, generation) as Record<string, unknown> | undefined;
		return row ? rowToGeneration(row) : null;
	}

	getGenerations(runId: string): StoredGeneration[] {
		return (this.database.prepare("SELECT * FROM manager_generations WHERE run_id = ? ORDER BY generation").all(runId) as Record<string, unknown>[]).map(rowToGeneration);
	}

	putGeneration(input: Omit<StoredGeneration, "createdAt">): StoredGeneration {
		const existing = this.getGeneration(input.runId, input.generation);
		if (existing) {
			const expected = { ...input, createdAt: existing.createdAt };
			if (JSON.stringify(existing) !== JSON.stringify(expected)) throw new Error(`Generation ${input.generation} evidence changed`);
			return existing;
		}
		this.database.prepare(`
			INSERT INTO manager_generations (
				run_id, generation, graph_sha256, parent_generation,
				run_assignment_path, run_assignment_sha256, run_snapshot_sha256, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.runId, input.generation, input.graphSha256, input.parentGeneration,
			input.runAssignmentPath, input.runAssignmentSha256, input.runSnapshotSha256,
			new Date().toISOString(),
		);
		return this.getGeneration(input.runId, input.generation)!;
	}

	getPlanEdit(runId: string): StoredPlanEdit | null {
		return rowToPlanEdit(this.database.prepare("SELECT * FROM manager_plan_edits WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined);
	}

	putPlanEdit(input: Omit<StoredPlanEdit, "createdAt" | "updatedAt" | "proposedGraphSha256" | "proposedPlanFingerprint">): StoredPlanEdit {
		const existing = this.getPlanEdit(input.runId);
		if (existing) {
			if (existing.planId !== input.planId) throw new Error(`Plan ${existing.planId} already has the active Herder edit reservation`);
			return existing;
		}
		const now = new Date().toISOString();
		this.database.prepare(`
			INSERT INTO manager_plan_edits (
				run_id, plan_id, edit_token, state, base_graph_sha256,
				base_plan_fingerprint, proposed_graph_sha256, proposed_plan_fingerprint,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
		`).run(
			input.runId, input.planId, input.editToken, input.state,
			input.baseGraphSha256, input.basePlanFingerprint, now, now,
		);
		return this.getPlanEdit(input.runId)!;
	}

	putPlanEditBarrier(runId: string, editToken: string, proposedGraphSha256: string, proposedPlanFingerprint: string): StoredPlanEdit {
		const edit = this.getPlanEdit(runId);
		if (!edit || edit.editToken !== editToken) throw new Error("Plan edit token does not match the active reservation");
		if (edit.state === "barrier") {
			if (edit.proposedGraphSha256 !== proposedGraphSha256 || edit.proposedPlanFingerprint !== proposedPlanFingerprint) {
				throw new Error(`Prepared plan ${edit.planId} changed after its revision barrier was requested`);
			}
			return edit;
		}
		this.database.prepare(`
			UPDATE manager_plan_edits
			SET state = 'barrier', proposed_graph_sha256 = ?, proposed_plan_fingerprint = ?, updated_at = ?
			WHERE run_id = ? AND edit_token = ? AND state = 'reserved'
		`).run(proposedGraphSha256, proposedPlanFingerprint, new Date().toISOString(), runId, editToken);
		return this.getPlanEdit(runId)!;
	}

	deletePlanEdit(runId: string): void {
		this.database.prepare("DELETE FROM manager_plan_edits WHERE run_id = ?").run(runId);
	}

	createRun(input: Omit<StoredRun, "createdAt" | "updatedAt" | "dashboardUrl" | "terminalDetail"> & { dashboardUrl?: string | null }): StoredRun {
		const existing = this.getRun();
		if (existing) throw new Error(`Herder run ${existing.runId} already exists for ${existing.planDirectory}; use resume`);
		const now = new Date().toISOString();
		this.database.prepare(`
				INSERT INTO manager_runs (
					run_id, repository_root, plan_directory, plan_name, host,
					profile_name, profile_sha256, max_parallel, current_generation, graph_sha256,
					status, checkout_state_token,
					base_commit, integration_branch, integration_worktree, dashboard_url,
					terminal_detail, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
			`).run(
				input.runId, input.repositoryRoot, input.planDirectory, input.planName, input.host,
			input.profileName, input.profileSha256, input.maxParallel, input.currentGeneration, input.graphSha256,
			input.status, input.checkoutStateToken,
			input.baseCommit, input.integrationBranch, input.integrationWorktree, input.dashboardUrl ?? null,
			now, now,
		);
		return this.getRun()!;
	}

	updateRun(input: {
		status?: RunStatus;
		dashboardUrl?: string | null;
		terminalDetail?: string | null;
		currentGeneration?: number;
		graphSha256?: string;
	}): StoredRun {
		const run = this.getRun();
		if (!run) throw new Error("No Herder manager run exists");
		const status = input.status ?? run.status;
		const dashboardUrl = input.dashboardUrl === undefined ? run.dashboardUrl : input.dashboardUrl;
		const terminalDetail = input.terminalDetail === undefined ? run.terminalDetail : input.terminalDetail;
		const currentGeneration = input.currentGeneration ?? run.currentGeneration;
		const graphSha256 = input.graphSha256 ?? run.graphSha256;
		this.database.prepare("UPDATE manager_runs SET status = ?, dashboard_url = ?, terminal_detail = ?, current_generation = ?, graph_sha256 = ?, updated_at = ? WHERE run_id = ?")
			.run(status, dashboardUrl, terminalDetail, currentGeneration, graphSha256, new Date().toISOString(), run.runId);
		return this.getRun()!;
	}

	resetExecutionState(): void {
		this.transaction(() => {
			// Keep the schema/database and runtime directory intact, but remove all
			// durable execution evidence so the next Fire is a fresh initialization.
			for (const table of [
				// Delete children before their manager_runs parent. Foreign-key enforcement
				// is enabled for every execution connection, so relying on cascade order
				// here would make reset fail part-way through its transaction.
				"manager_approvals", "manager_plan_edits", "manager_verifications", "manager_reignite_requests", "manager_attention_requests",
				"manager_events", "manager_actions", "manager_plans", "manager_plan_specs", "manager_generations",
				"manager_operations", "manager_snapshots", "manager_service", "manager_runs", "run_configuration", "attempts",
			]) this.database.prepare(`DELETE FROM ${table}`).run();
		});
	}

	getPlans(runId: string): StoredPlan[] {
		return (this.database.prepare("SELECT * FROM manager_plans WHERE run_id = ? ORDER BY plan_id").all(runId) as Record<string, unknown>[]).map(rowToPlan);
	}

	getPlan(runId: string, planId: string): StoredPlan | null {
		const row = this.database.prepare("SELECT * FROM manager_plans WHERE run_id = ? AND plan_id = ?").get(runId, planId) as Record<string, unknown> | undefined;
		return row ? rowToPlan(row) : null;
	}

	deletePlan(runId: string, planId: string): void {
		this.database.prepare("DELETE FROM manager_plans WHERE run_id = ? AND plan_id = ?").run(runId, planId);
	}

	putPlan(input: Omit<StoredPlan, "updatedAt"> | StoredPlan): StoredPlan {
		const now = new Date().toISOString();
		this.database.prepare(`
			INSERT INTO manager_plans (
				run_id, plan_id, generation, round_number, phase, branch, worktree,
				assignment_path, assignment_sha256, snapshot_sha256, generation_base,
				review_pass, findings_json, repair_json, gate_json,
				approved_base, approved_head, approved_tree, rebase_json, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(run_id, plan_id) DO UPDATE SET
				generation = excluded.generation,
				round_number = excluded.round_number,
				phase = excluded.phase,
				branch = excluded.branch,
				worktree = excluded.worktree,
				assignment_path = excluded.assignment_path,
				assignment_sha256 = excluded.assignment_sha256,
				snapshot_sha256 = excluded.snapshot_sha256,
				generation_base = excluded.generation_base,
				review_pass = excluded.review_pass,
				findings_json = excluded.findings_json,
				repair_json = excluded.repair_json,
				gate_json = excluded.gate_json,
				approved_base = excluded.approved_base,
				approved_head = excluded.approved_head,
				approved_tree = excluded.approved_tree,
				rebase_json = excluded.rebase_json,
				updated_at = excluded.updated_at
		`).run(
			input.runId, input.planId, input.generation, input.round, input.phase, input.branch, input.worktree,
			input.assignmentPath, input.assignmentSha256, input.snapshotSha256, input.generationBase,
			input.reviewPass, JSON.stringify(input.findings), JSON.stringify(input.repair), JSON.stringify(input.gates),
			input.approvedBase, input.approvedHead, input.approvedTree, JSON.stringify(input.rebase), now,
		);
		return this.getPlan(input.runId, input.planId)!;
	}

	getActions(runId: string, states?: StoredAction["state"][]): StoredAction[] {
		const rows = states?.length
			? this.database.prepare(`SELECT * FROM manager_actions WHERE run_id = ? AND state IN (${states.map(() => "?").join(",")}) ORDER BY created_at, action_id`).all(runId, ...states)
			: this.database.prepare("SELECT * FROM manager_actions WHERE run_id = ? ORDER BY created_at, action_id").all(runId);
		return (rows as Record<string, unknown>[]).map(rowToAction);
	}

	countActions(runId: string, filters: {
		states?: StoredAction["state"][];
		planId?: string;
		generation?: number;
		round?: number;
		role?: string;
	} = {}): number {
		const clauses = ["run_id = ?"];
		const values: Array<string | number> = [runId];
		if (filters.states?.length) {
			clauses.push(`state IN (${filters.states.map(() => "?").join(",")})`);
			values.push(...filters.states);
		}
		if (filters.planId !== undefined) { clauses.push("plan_id = ?"); values.push(filters.planId); }
		if (filters.generation !== undefined) { clauses.push("generation = ?"); values.push(filters.generation); }
		if (filters.round !== undefined) { clauses.push("round_number = ?"); values.push(filters.round); }
		if (filters.role !== undefined) { clauses.push("role = ?"); values.push(filters.role); }
		const row = this.database.prepare(`SELECT COUNT(*) AS count FROM manager_actions WHERE ${clauses.join(" AND ")}`).get(...values) as Record<string, unknown>;
		return Number(row.count);
	}

	getTerminalActionsMissingUsage(runId: string): StoredAction[] {
		const rows = this.database.prepare(`
			SELECT action.*
			FROM manager_actions AS action
			LEFT JOIN attempts AS usage ON usage.attempt_id = action.attempt_id
			WHERE action.run_id = ? AND action.state = 'terminal' AND usage.attempt_id IS NULL
			ORDER BY action.created_at, action.action_id
		`).all(runId) as Record<string, unknown>[];
		return rows.map(rowToAction);
	}

	getTerminalLeaseReasons(runId: string): Set<string> {
		const rows = this.database.prepare(`
			SELECT lease_reason FROM manager_actions
			WHERE run_id = ? AND state IN ('terminal', 'cancelled')
		`).all(runId) as Array<{ lease_reason: string }>;
		return new Set(rows.map((row) => String(row.lease_reason)));
	}

	getLatestAction(runId: string, filters: {
		planId: string;
		generation: number;
		round: number;
		role: string;
		state?: StoredAction["state"];
	}): StoredAction | null {
		const row = this.database.prepare(`
			SELECT * FROM manager_actions
			WHERE run_id = ? AND plan_id = ? AND generation = ? AND round_number = ? AND role = ?
				${filters.state ? "AND state = ?" : ""}
			ORDER BY created_at DESC, action_id DESC LIMIT 1
		`).get(
			runId, filters.planId, filters.generation, filters.round, filters.role,
			...(filters.state ? [filters.state] : []),
		) as Record<string, unknown> | undefined;
		return row ? rowToAction(row) : null;
	}

	getAction(actionId: string): StoredAction | null {
		const row = this.database.prepare("SELECT * FROM manager_actions WHERE action_id = ?").get(actionId) as Record<string, unknown> | undefined;
		return row ? rowToAction(row) : null;
	}

	putAction(action: ManagerAction): StoredAction {
		const existing = this.getAction(action.actionId);
		if (existing) return existing;
		const now = new Date().toISOString();
		this.database.prepare(`
			INSERT INTO manager_actions (
				action_id, run_id, plan_id, generation, round_number, role, attempt_id,
				state, agent_type, model, effort, service_tier, worker_mode, task_name,
				lease_reason, host_handle, result_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
		`).run(
			action.actionId, action.runId, action.planId, action.generation, action.round, action.role, action.attemptId,
			action.agentType, action.model, action.effort, action.serviceTier ?? null, action.workerMode,
			action.taskName, action.leaseReason, now, now,
		);
		return this.getAction(action.actionId)!;
	}

	markDispatched(actionId: string, hostHandle: string): StoredAction {
		const action = this.getAction(actionId);
		if (!action) throw new Error(`Unknown Herder action ${actionId}`);
		if (action.state === "dispatched" && action.hostHandle === hostHandle) return action;
		if (action.state !== "proposed") throw new Error(`Action ${actionId} cannot dispatch from ${action.state}`);
		this.database.prepare("UPDATE manager_actions SET state = 'dispatched', host_handle = ?, updated_at = ? WHERE action_id = ?")
			.run(hostHandle, new Date().toISOString(), actionId);
		return this.getAction(actionId)!;
	}

	markCancelled(actionId: string, result: unknown): StoredAction {
		const action = this.getAction(actionId);
		if (!action) throw new Error(`Unknown Herder action ${actionId}`);
		if (action.state === "cancelled") return action;
		if (action.state !== "proposed") throw new Error(`Action ${actionId} cannot cancel from ${action.state}`);
		this.database.prepare("UPDATE manager_actions SET state = 'cancelled', result_json = ?, updated_at = ? WHERE action_id = ?")
			.run(JSON.stringify(result), new Date().toISOString(), actionId);
		return this.getAction(actionId)!;
	}

	markTerminal(actionId: string, result: unknown): StoredAction {
		const action = this.getAction(actionId);
		if (!action) throw new Error(`Unknown Herder action ${actionId}`);
		if (action.state === "terminal") return action;
		if (action.state !== "dispatched") throw new Error(`Action ${actionId} cannot finish from ${action.state}`);
		this.database.prepare("UPDATE manager_actions SET state = 'terminal', result_json = ?, updated_at = ? WHERE action_id = ?")
			.run(JSON.stringify(result), new Date().toISOString(), actionId);
		return this.getAction(actionId)!;
	}

	getApproval(runId: string, planId: string, generation: number): StoredApproval | null {
		const row = this.database.prepare("SELECT * FROM manager_approvals WHERE run_id = ? AND plan_id = ? AND generation = ?")
			.get(runId, planId, generation) as Record<string, unknown> | undefined;
		return row ? rowToApproval(row) : null;
	}

	deleteApproval(runId: string, planId: string, generation: number): void {
		this.database.prepare("DELETE FROM manager_approvals WHERE run_id = ? AND plan_id = ? AND generation = ?")
			.run(runId, planId, generation);
	}

	putApproval(input: Omit<StoredApproval, "createdAt">): StoredApproval {
		const existing = this.getApproval(input.runId, input.planId, input.generation);
		if (existing) {
			const expected = { ...input, createdAt: existing.createdAt };
			if (expected.userAcceptance === undefined) delete expected.userAcceptance;
			if (stableJson(existing) !== stableJson(expected)) throw new Error(`Approval proof changed for ${input.planId} generation ${input.generation}`);
			return existing;
		}
		this.database.prepare(`
			INSERT INTO manager_approvals (
				run_id, plan_id, generation, round_number, reviewer_action_id,
				decision_action_id, decision_role, assignment_sha256, approved_base,
				approved_head, approved_tree, review_result_sha256,
				decision_result_sha256, proof_sha256, user_acceptance_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			input.runId, input.planId, input.generation, input.round, input.reviewerActionId,
			input.decisionActionId, input.decisionRole, input.assignmentSha256, input.approvedBase,
			input.approvedHead, input.approvedTree, input.reviewResultSha256,
			input.decisionResultSha256, input.proofSha256, input.userAcceptance === undefined ? null : JSON.stringify(input.userAcceptance), new Date().toISOString(),
		);
		return this.getApproval(input.runId, input.planId, input.generation)!;
	}

	recordPlanEditSnapshot(runId: string, editToken: string, planId: string, snapshotSha256: string): void {
		if (!/^[0-9a-f-]{36}$/i.test(editToken) || !/^\d{3,}$/.test(planId) || !/^[0-9a-f]{64}$/i.test(snapshotSha256)) throw new Error("Plan edit snapshot evidence is invalid");
		const eventId = `${PLAN_EDIT_EVENT_PREFIX}${editToken}:snapshot:${planId}`;
		const canonical = canonicalEventPayload({ schemaVersion: 1, kind: PLAN_EDIT_SNAPSHOT_KIND, runId, editToken, planId, snapshotSha256: snapshotSha256.toLowerCase() });
		const row = this.database.prepare("SELECT run_id, kind, payload_sha256 FROM manager_events WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
		if (row) {
			if (String(row.run_id) !== runId || String(row.kind) !== PLAN_EDIT_SNAPSHOT_KIND || String(row.payload_sha256) !== canonical.sha256) throw new Error(`Plan edit snapshot evidence ${eventId} changed`);
			return;
		}
		this.database.prepare("INSERT INTO manager_events (event_id, run_id, kind, payload_sha256, created_at) VALUES (?, ?, ?, ?, ?)")
			.run(eventId, runId, PLAN_EDIT_SNAPSHOT_KIND, canonical.sha256, new Date().toISOString());
	}

	hasPlanEditSnapshot(runId: string, editToken: string, planId: string): boolean {
		const row = this.database.prepare("SELECT run_id, kind FROM manager_events WHERE event_id = ?").get(`${PLAN_EDIT_EVENT_PREFIX}${editToken}:snapshot:${planId}`) as Record<string, unknown> | undefined;
		return Boolean(row && String(row.run_id) === runId && String(row.kind) === PLAN_EDIT_SNAPSHOT_KIND);
	}

	validatePlanEditSnapshot(runId: string, editToken: string, planId: string, snapshotSha256: string): void {
		const eventId = `${PLAN_EDIT_EVENT_PREFIX}${editToken}:snapshot:${planId}`;
		const row = this.database.prepare("SELECT run_id, kind, payload_sha256 FROM manager_events WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
		const canonical = canonicalEventPayload({ schemaVersion: 1, kind: PLAN_EDIT_SNAPSHOT_KIND, runId, editToken, planId, snapshotSha256: snapshotSha256.toLowerCase() });
		if (!row || String(row.run_id) !== runId || String(row.kind) !== PLAN_EDIT_SNAPSHOT_KIND || String(row.payload_sha256) !== canonical.sha256) {
			throw new Error(`Plan edit snapshot evidence ${eventId} is missing or changed`);
		}
	}

	private recordPlanEditEvidence(edit: StoredPlanEdit, operation: "confirm" | PlanEditOutcomeOperation): void {
		if (!/^[0-9a-f-]{36}$/i.test(edit.editToken) || !/^\d{3,}$/.test(edit.planId)) throw new Error("Plan edit evidence identity is invalid");
		if (operation === "confirm" && (edit.state !== "barrier" || !edit.proposedGraphSha256 || !edit.proposedPlanFingerprint)) {
			throw new Error("Only a prepared plan edit can be confirmed");
		}
		const eventId = planEditEventId(edit.editToken, operation, edit.planId);
		const kind = operation === "confirm" ? PLAN_EDIT_CONFIRM_KIND : PLAN_EDIT_OUTCOME_KIND;
		const canonical = canonicalEventPayload(planEditEvidencePayload(edit.runId, edit.editToken, edit.planId, operation, edit));
		const row = this.database.prepare("SELECT run_id, kind, payload_sha256 FROM manager_events WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
		if (row) {
			if (String(row.run_id) !== edit.runId || String(row.kind) !== kind || String(row.payload_sha256) !== canonical.sha256) {
				throw new Error(`Plan edit evidence ${eventId} changed`);
			}
			return;
		}
		this.database.prepare(`
			INSERT INTO manager_events (event_id, run_id, kind, payload_sha256, created_at)
			VALUES (?, ?, ?, ?, ?)
		`).run(eventId, edit.runId, kind, canonical.sha256, new Date().toISOString());
	}

	recordPlanEditConfirmation(edit: StoredPlanEdit): void {
		this.recordPlanEditEvidence(edit, "confirm");
	}

	hasPlanEditConfirmation(edit: StoredPlanEdit): boolean {
		if (edit.state !== "barrier" || !edit.proposedGraphSha256 || !edit.proposedPlanFingerprint) return false;
		const eventId = planEditEventId(edit.editToken, "confirm", edit.planId);
		const row = this.database.prepare("SELECT run_id, kind, payload_sha256 FROM manager_events WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
		if (!row) return false;
		const canonical = canonicalEventPayload(planEditEvidencePayload(edit.runId, edit.editToken, edit.planId, "confirm", edit));
		if (String(row.run_id) !== edit.runId || String(row.kind) !== PLAN_EDIT_CONFIRM_KIND || String(row.payload_sha256) !== canonical.sha256) {
			throw new Error(`Plan edit confirmation ${eventId} changed`);
		}
		return true;
	}

	recordPlanEditOutcome(edit: StoredPlanEdit, operation: PlanEditOutcomeOperation): void {
		this.recordPlanEditEvidence(edit, operation);
	}

	getPlanEditOutcome(runId: string, editToken: string, operation: PlanEditOutcomeOperation): { planId: string; operation: PlanEditOutcomeOperation; rework: boolean } | null {
		if (!/^[0-9a-f-]{36}$/i.test(editToken)) throw new Error("Plan edit token is invalid");
		const prefix = `${PLAN_EDIT_EVENT_PREFIX}${editToken}:${operation}:`;
		const rows = this.database.prepare("SELECT event_id, kind, payload_sha256 FROM manager_events WHERE run_id = ? AND event_id LIKE ? ORDER BY event_id").all(runId, `${prefix}%`) as Record<string, unknown>[];
		if (rows.length === 0) return null;
		if (rows.length !== 1) throw new Error(`Plan edit ${editToken} has ambiguous ${operation} evidence`);
		const eventId = String(rows[0]!.event_id);
		const planId = eventId.slice(prefix.length);
		if (!/^\d{3,}$/.test(planId) || eventId !== planEditEventId(editToken, operation, planId)) throw new Error(`Plan edit ${editToken} has invalid ${operation} evidence`);
		const canonical = canonicalEventPayload(planEditEvidencePayload(runId, editToken, planId, operation));
		if (String(rows[0]!.kind) !== PLAN_EDIT_OUTCOME_KIND || String(rows[0]!.payload_sha256) !== canonical.sha256) {
			throw new Error(`Plan edit ${editToken} ${operation} evidence changed`);
		}
		return { planId, operation, rework: this.hasPlanEditSnapshot(runId, editToken, planId) };
	}

	readEvent(eventId: string): { payloadSha256: string } | null {
		const row = this.database.prepare("SELECT payload_sha256 FROM manager_events WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
		return row ? { payloadSha256: String(row.payload_sha256) } : null;
	}

	recordEvent(runId: string, eventId: string, kind: string, payload: unknown): void {
		if (eventId.startsWith(ATTENTION_CLEANUP_EVENT_PREFIX) || eventId.startsWith("attention-cleanup:") || eventId.startsWith(PLAN_EDIT_EVENT_PREFIX)
			|| kind === ATTENTION_CLEANUP_INTENT_KIND || kind === ATTENTION_CLEANUP_COMPLETE_KIND || kind === PLAN_EDIT_SNAPSHOT_KIND || kind === PLAN_EDIT_CONFIRM_KIND || kind === PLAN_EDIT_OUTCOME_KIND) {
			throw new Error("Manager private evidence cannot be submitted as a public event");
		}
		const canonical = canonicalEventPayload(payload);
		const existing = this.readEvent(eventId);
		if (existing) {
			if (existing.payloadSha256 !== canonical.sha256) throw new Error(`Event ${eventId} was replayed with different payload`);
			return;
		}
		this.database.prepare(`
				INSERT INTO manager_events (event_id, run_id, kind, payload_sha256, created_at)
				VALUES (?, ?, ?, ?, ?)
			`).run(eventId, runId, kind, canonical.sha256, new Date().toISOString());
	}

	getService(): StoredService | null {
		const row = this.database.prepare("SELECT instance_id, pid, port, auth_token, dashboard_url, started_at FROM manager_service WHERE singleton = 1").get() as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			instanceId: String(row.instance_id),
			pid: Number(row.pid),
			port: Number(row.port),
			authToken: String(row.auth_token),
			dashboardUrl: String(row.dashboard_url),
			startedAt: String(row.started_at),
		};
	}

	putService(service: StoredService): void {
		this.database.prepare(`
				INSERT INTO manager_service (
					singleton, instance_id, pid, port, auth_token, dashboard_url,
					forwarded_url, started_at
				) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(singleton) DO UPDATE SET
				instance_id = excluded.instance_id,
				pid = excluded.pid,
				port = excluded.port,
				auth_token = excluded.auth_token,
				dashboard_url = excluded.dashboard_url,
					forwarded_url = excluded.forwarded_url,
					started_at = excluded.started_at
			`).run(
				service.instanceId, service.pid, service.port, service.authToken, service.dashboardUrl,
				null, service.startedAt,
			);
	}
}
