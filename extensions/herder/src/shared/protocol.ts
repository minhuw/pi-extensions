import { createHash } from "node:crypto";

export const MANAGER_PROTOCOL_VERSION = 7;
export const MAIN_SESSION_VERIFICATION_PAUSE_DETAIL = "Waiting for the main Pi session to submit an exact-tree verification manifest.";
export const RUN_STATUSES = ["initializing", "running", "paused", "needs_input", "complete", "failed", "stopped"] as const;
export const WORKER_ROLES = ["plan-implementer", "plan-reviewer", "plan-judge"] as const;
export const PLAN_PHASES = [
	"READY_IMPLEMENTER",
	"IMPLEMENTING",
	"READY_REVIEWER",
	"REVIEWING",
	"READY_JUDGE",
	"JUDGING",
	"READY_TO_INTEGRATE",
	"DONE",
	"BLOCKED",
	"NEEDS_INPUT",
	"FINAL_APPROVED",
] as const;

export type RunStatus = typeof RUN_STATUSES[number];
export type WorkerRole = typeof WORKER_ROLES[number];
export type PlanPhase = typeof PLAN_PHASES[number];
export type HostName = "pi";

export interface RoleProfile {
	agent_type: string;
	model: string;
	effort: string;
	service_tier?: string;
}

export interface ResolvedProfile {
	schema_version: number;
	profile: string;
	profile_sha256: string;
	host: HostName;
	orchestrator: { model: string; effort: string; service_tier?: string };
	roles: Record<string, RoleProfile>;
}

export interface ManagerAction {
	actionId: string;
	attemptId: string;
	runId: string;
	planId: string;
	generation: number;
	round: number;
	role: WorkerRole;
	agentType: string;
	model: string;
	effort: string;
	serviceTier?: string;
	workerMode: "INITIAL" | "GUIDED_REPAIR" | "DISCOVERY" | "VERIFICATION" | "ADJUDICATE" | "FINAL_AUDIT";
	taskName: string;
	worktree: string;
	branch: string;
	assignmentPath: string;
	assignmentSha256: string;
	leaseReason: string;
	prompt: string;
}

export interface DispatchResult {
	actionId: string;
	accepted: boolean;
	hostHandle?: string;
	error?: string;
}

export interface NestedUsageSlice {
	type: string;
	model: string;
	effort: string;
	serviceTier?: string;
	count: number;
	inputTokens: number | null;
	cachedInputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	durationMs?: number;
}

export interface UsageEvidence {
	inputTokens: number | null;
	cachedInputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	source: string;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
	nested?: NestedUsageSlice[];
}

export interface TerminalEvent {
	actionId: string;
	hostHandle?: string;
	response?: string;
	interrupted?: boolean;
	error?: string;
	usage?: Partial<UsageEvidence>;
}

export interface ManagerPlanEdit {
	planId: string;
	state: "reserved" | "barrier";
}

export const ATTENTION_KINDS = ["plan_recovery", "user_decision", "operator_attention"] as const;
export const ATTENTION_STATES = ["pending", "delegated", "awaiting_input", "editing", "resolved"] as const;
export const ATTENTION_PATH_LIMIT = 128;
export const ATTENTION_CAUSES = [
	"initial_decision_blocked",
	"implementer_exhausted",
	"reviewer_blocked",
	"judge_blocked",
	"round_limit",
	"integration_conflict_exhausted",
	"judge_needs_input",
	"final_reviewer_needs_input",
	"transport_exhausted",
] as const;

export type AttentionKind = typeof ATTENTION_KINDS[number];
export type AttentionState = typeof ATTENTION_STATES[number];
export type AttentionCause = typeof ATTENTION_CAUSES[number];

export interface AttentionContinuation {
	role: WorkerRole;
	phase: PlanPhase;
}

/** Actions accepted by the manager-owned attention resolution operation. */
export const ATTENTION_RESOLUTION_ACTIONS = [
	"answer",
	"defer",
	"retry",
	"cancel",
	"unchanged_retry",
	"revise",
	"reject",
] as const;
export type AttentionResolutionAction = typeof ATTENTION_RESOLUTION_ACTIONS[number];

/** Git identity supplied with a recovery decision. It is compared before any destructive operation. */
export interface AttentionGitIdentity {
	assignmentPath: string;
	assignmentSha256: string;
	snapshotSha256: string;
	generationBase: string;
	branch: string;
	worktree: string;
	worktreeHead: string | null;
	worktreeTree: string | null;
}

export interface AttentionResolutionInput {
	schemaVersion: 1;
	requestId: string;
	requestSha256: string;
	/** The request-bound capability derived from its immutable ID. */
	capabilityToken: string;
	runId: string;
	planId: string;
	generation: number;
	round: number;
	action: AttentionResolutionAction | string;
	answer?: string;
	rationale?: string;
	continuation?: AttentionContinuation;
	git?: AttentionGitIdentity;
	/** Aliases accepted for callers that name the binding explicitly. */
	gitIdentity?: AttentionGitIdentity;
	recovery?: AttentionGitIdentity;
}

/** A deterministic, request-bound capability used by attention submissions. */
export function attentionCapabilityToken(requestId: string): string {
	return sha256(`herder-attention-capability:${requestId}`);
}

export function validateAttentionResolution(value: unknown): asserts value is AttentionResolutionInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Attention resolution must be an object");
	const resolution = value as Partial<AttentionResolutionInput>;
	if (resolution.schemaVersion !== 1) throw new Error("Attention resolution schemaVersion must be 1");
	for (const [name, candidate, limit] of [
		["requestId", resolution.requestId, 200],
		["runId", resolution.runId, 200],
		["planId", resolution.planId, 200],
	] as const) {
		if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > limit || /[\0\r\n]/.test(candidate)) {
			throw new Error(`Attention resolution ${name} must be a bounded single-line string`);
		}
	}
	if (typeof resolution.requestSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(resolution.requestSha256)) {
		throw new Error("Attention resolution requestSha256 must be a SHA-256");
	}
	if (typeof resolution.capabilityToken !== "string" || !/^[0-9a-f]{64}$/i.test(resolution.capabilityToken)) {
		throw new Error("Attention resolution capabilityToken must be a SHA-256");
	}
	if (!Number.isSafeInteger(resolution.generation) || Number(resolution.generation) < 1) throw new Error("Attention resolution generation must be positive");
	if (!Number.isSafeInteger(resolution.round) || Number(resolution.round) < 1 || Number(resolution.round) > 6) throw new Error("Attention resolution round must be between 1 and 6");
	if (typeof resolution.action !== "string" || resolution.action.length === 0 || resolution.action.length > 64 || /[\0\r\n]/.test(resolution.action)) {
		throw new Error("Attention resolution action is invalid");
	}
	for (const [name, candidate, limit] of [["answer", resolution.answer, 16_384], ["rationale", resolution.rationale, 16_384]] as const) {
		if (candidate !== undefined && (typeof candidate !== "string" || candidate.length === 0 || candidate.length > limit || /\0/.test(candidate))) {
			throw new Error(`Attention resolution ${name} is invalid`);
		}
	}
	if (resolution.continuation !== undefined && (!resolution.continuation || typeof resolution.continuation !== "object" || Array.isArray(resolution.continuation)
		|| !WORKER_ROLES.includes(resolution.continuation.role as WorkerRole)
		|| !PLAN_PHASES.includes(resolution.continuation.phase as PlanPhase))) {
		throw new Error("Attention resolution continuation is invalid");
	}
	const identity = resolution.git ?? resolution.gitIdentity ?? resolution.recovery;
	if (identity !== undefined) {
		if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("Attention resolution Git identity is invalid");
		for (const [name, candidate, limit] of [
			["assignmentPath", identity.assignmentPath, 2_048],
			["assignmentSha256", identity.assignmentSha256, 128],
			["snapshotSha256", identity.snapshotSha256, 128],
			["generationBase", identity.generationBase, 128],
			["branch", identity.branch, 512],
			["worktree", identity.worktree, 2_048],
		] as const) {
			if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > limit || /[\0\r\n]/.test(candidate)) {
				throw new Error(`Attention resolution Git ${name} is invalid`);
			}
		}
		if (!["worktreeHead", "worktreeTree"].every((name) => {
			const candidate = identity[name as "worktreeHead" | "worktreeTree"];
			return candidate === null || (typeof candidate === "string" && /^[0-9a-f]{40,64}$/i.test(candidate));
		})) throw new Error("Attention resolution Git object identity is invalid");
	}
}

export interface AttentionRecoveryEvidence {
	planFingerprint: string;
	fingerprintVersion: 1 | 2;
	planFile: string;
	inScopePaths: string[];
	/** Full path evidence is bounded to ATTENTION_PATH_LIMIT; these bind omitted paths. */
	inScopePathCount?: number;
	inScopePathsSha256?: string;
	assignmentPath: string;
	assignmentSha256: string;
	snapshotSha256: string;
	generationBase: string;
	branch: string;
	worktree: string;
	worktreeHead: string | null;
	worktreeTree: string | null;
	changedPaths: string[];
	changedPathCount?: number;
	changedPathsSha256?: string;
}

interface AttentionRequestCore {
	schemaVersion: 1;
	requestId: string;
	runId: string;
	planId: string;
	generation: number;
	round: number;
	actionId: string | null;
	requestSha256: string;
	state: AttentionState;
	cause: AttentionCause;
	/** The exact bounded transition evidence; complete prompts, responses, and logs are not retained here. */
	detail: string;
	detailSha256: string;
	continuation: AttentionContinuation;
	createdAt: string;
	updatedAt: string;
	/** Request-bound capability; older persisted requests may omit it. */
	capabilityToken?: string;
	resolvedAt?: string;
}

export interface PlanRecoveryAttentionRequest extends AttentionRequestCore {
	kind: "plan_recovery";
	question?: string;
	recommendedAction?: string;
	recovery: AttentionRecoveryEvidence;
}

export interface UserDecisionAttentionRequest extends AttentionRequestCore {
	kind: "user_decision";
	question: string;
	recommendedAction?: string;
}

export interface OperatorAttentionRequest extends AttentionRequestCore {
	kind: "operator_attention";
	question?: string;
	recommendedAction?: string;
}

export type ManagerAttentionRequest = PlanRecoveryAttentionRequest | UserDecisionAttentionRequest | OperatorAttentionRequest;
export type AttentionRequest = ManagerAttentionRequest;
export type AttentionRequestInput =
	| Omit<PlanRecoveryAttentionRequest, "resolvedAt">
	| Omit<UserDecisionAttentionRequest, "resolvedAt">
	| Omit<OperatorAttentionRequest, "resolvedAt">;

type AttentionHashInput = {
	runId: string;
	planId: string;
	generation: number;
	round: number;
	actionId: string | null;
	kind: AttentionKind;
	cause: AttentionCause;
	detail: string;
	detailSha256: string;
	continuation: AttentionContinuation;
	question?: string;
	recommendedAction?: string;
	recovery?: AttentionRecoveryEvidence;
};

export function attentionRequestSha256(value: AttentionHashInput): string {
	return sha256(stableJson({
		runId: value.runId,
		planId: value.planId,
		generation: value.generation,
		round: value.round,
		actionId: value.actionId,
		kind: value.kind,
		cause: value.cause,
		detail: value.detail,
		detailSha256: value.detailSha256,
		continuation: value.continuation,
		question: value.question ?? null,
		recommendedAction: value.recommendedAction ?? null,
		recovery: value.recovery ?? null,
	}));
}

export function validateAttentionRequest(value: unknown): asserts value is ManagerAttentionRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Attention request must be an object");
	const request = value as Partial<AttentionRequestCore> & {
		kind?: AttentionKind;
		question?: unknown;
		recommendedAction?: unknown;
		recovery?: unknown;
	};
	if (request.schemaVersion !== 1) throw new Error("Attention request schemaVersion must be 1");
	for (const [name, candidate, limit] of [
		["requestId", request.requestId, 200],
		["runId", request.runId, 200],
		["planId", request.planId, 200],
		["createdAt", request.createdAt, 100],
		["updatedAt", request.updatedAt, 100],
	] as const) {
		if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > limit || /[\0\r\n]/.test(candidate)) {
			throw new Error(`Attention request ${name} must be a bounded single-line string`);
		}
	}
	if (typeof request.detail !== "string" || request.detail.length === 0 || request.detail.length > 16_384 || /\0/.test(request.detail)) {
		throw new Error("Attention request detail must be bounded evidence without NUL bytes");
	}
	if (!ATTENTION_KINDS.includes(request.kind as AttentionKind)) throw new Error(`Unsupported attention kind: ${String(request.kind)}`);
	if (!ATTENTION_STATES.includes(request.state as AttentionState)) throw new Error(`Unsupported attention state: ${String(request.state)}`);
	if (!ATTENTION_CAUSES.includes(request.cause as AttentionCause)) throw new Error(`Unsupported attention cause: ${String(request.cause)}`);
	if (!Number.isSafeInteger(request.generation) || Number(request.generation) < 1) throw new Error("Attention generation must be positive");
	if (!Number.isSafeInteger(request.round) || Number(request.round) < 1 || Number(request.round) > 6) throw new Error("Attention round must be between 1 and 6");
	if (request.actionId !== null
		&& (typeof request.actionId !== "string" || request.actionId.length === 0 || request.actionId.length > 300 || /[\0\r\n]/.test(request.actionId))) {
		throw new Error("Attention actionId must be null or a bounded single-line string");
	}
	if (!request.continuation || typeof request.continuation !== "object" || Array.isArray(request.continuation)
		|| !WORKER_ROLES.includes(request.continuation.role as WorkerRole)
		|| !PLAN_PHASES.includes(request.continuation.phase as PlanPhase)) {
		throw new Error("Attention continuation must name a supported worker role and plan phase");
	}
	if (!/^[0-9a-f]{64}$/i.test(String(request.detailSha256)) || sha256(request.detail!) !== request.detailSha256) {
		throw new Error("Attention detail hash does not match its evidence");
	}
	if (!/^[0-9a-f]{64}$/i.test(String(request.requestSha256))
		|| attentionRequestSha256(request as AttentionHashInput) !== request.requestSha256) {
		throw new Error("Attention request hash does not match its immutable evidence");
	}
	for (const [name, candidate, limit] of [
		["question", request.question, 4_096],
		["recommendedAction", request.recommendedAction, 4_096],
	] as const) {
		if (candidate !== undefined && (typeof candidate !== "string" || candidate.length === 0 || candidate.length > limit || /\0/.test(candidate))) {
			throw new Error(`Attention ${name} must be bounded evidence without NUL bytes`);
		}
	}
	if (request.capabilityToken !== undefined
		&& (typeof request.capabilityToken !== "string" || !/^[0-9a-f]{64}$/i.test(request.capabilityToken))) {
		throw new Error("Attention capability token is invalid");
	}
	if (request.kind === "user_decision" && !request.question) throw new Error("User-decision attention requires a question");
	if (request.kind === "plan_recovery") {
		const recovery = request.recovery as AttentionRecoveryEvidence | undefined;
		if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) throw new Error("Plan-recovery attention requires recovery evidence");
		for (const [name, candidate, limit] of [
			["planFingerprint", recovery.planFingerprint, 128],
			["planFile", recovery.planFile, 512],
			["assignmentPath", recovery.assignmentPath, 2_048],
			["assignmentSha256", recovery.assignmentSha256, 128],
			["snapshotSha256", recovery.snapshotSha256, 128],
			["generationBase", recovery.generationBase, 128],
			["branch", recovery.branch, 512],
			["worktree", recovery.worktree, 2_048],
		] as const) {
			if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > limit || /[\0\r\n]/.test(candidate)) {
				throw new Error(`Attention recovery ${name} is invalid`);
			}
		}
		if (![1, 2].includes(recovery.fingerprintVersion)
			|| !/^[0-9a-f]{40,64}$/i.test(recovery.planFingerprint)
			|| !/^[0-9a-f]{40,64}$/i.test(recovery.assignmentSha256)
			|| !/^[0-9a-f]{40,64}$/i.test(recovery.snapshotSha256)
			|| !/^[0-9a-f]{40,64}$/i.test(recovery.generationBase)) {
			throw new Error("Attention recovery fingerprint version is invalid");
		}
		const validatePathEvidence = (
			name: string,
			paths: unknown,
			count: unknown,
			pathsSha256: unknown,
		): void => {
			if (!Array.isArray(paths) || paths.length > ATTENTION_PATH_LIMIT) throw new Error("Attention recovery paths are invalid");
			for (const candidate of paths) {
				if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 2_048 || /[\0\r\n]/.test(candidate)) {
					throw new Error("Attention recovery path is invalid");
				}
			}
			const hasCount = count !== undefined;
			const hasHash = pathsSha256 !== undefined;
			if (hasCount !== hasHash) throw new Error(`Attention recovery ${name} evidence is incomplete`);
			if (!hasCount) return;
			if (!Number.isSafeInteger(count) || Number(count) < paths.length
				|| typeof pathsSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(pathsSha256)) {
				throw new Error(`Attention recovery ${name} evidence is invalid`);
			}
			if (Number(count) <= ATTENTION_PATH_LIMIT
				&& (Number(count) !== paths.length || sha256(stableJson(paths)) !== pathsSha256)) {
				throw new Error(`Attention recovery ${name} evidence hash does not match its paths`);
			}
		};
		validatePathEvidence("in-scope", recovery.inScopePaths, recovery.inScopePathCount, recovery.inScopePathsSha256);
		validatePathEvidence("changed", recovery.changedPaths, recovery.changedPathCount, recovery.changedPathsSha256);
		for (const [name, candidate] of [["worktreeHead", recovery.worktreeHead], ["worktreeTree", recovery.worktreeTree]] as const) {
			if (candidate !== null && (typeof candidate !== "string" || !/^[0-9a-f]{40,64}$/i.test(candidate))) {
				throw new Error(`Attention recovery ${name} is invalid`);
			}
		}
	} else if (request.recovery !== undefined) {
		throw new Error("Only plan-recovery attention may contain recovery evidence");
	}
	if (request.state === "resolved" && request.resolvedAt === undefined) throw new Error("Resolved attention requires a resolution timestamp");
	if (request.state !== "resolved" && request.resolvedAt !== undefined) throw new Error("Unresolved attention cannot have a resolution timestamp");
	if (request.resolvedAt !== undefined
		&& (typeof request.resolvedAt !== "string" || request.resolvedAt.length === 0 || /[\0\r\n]/.test(request.resolvedAt))) {
		throw new Error("Resolved attention timestamp is invalid");
	}
}

export const MANAGER_OPERATION_KINDS = ["start", "event", "edit", "stop", "verification", "reignite", "integration_repair", "repair"] as const;
export const MANAGER_OPERATION_STATES = ["accepted", "running", "succeeded", "failed"] as const;
export type ManagerOperationKind = typeof MANAGER_OPERATION_KINDS[number];
export type ManagerOperationState = typeof MANAGER_OPERATION_STATES[number];

export interface ManagerOperationReceipt {
	protocolVersion: number;
	operationId: string;
	kind: ManagerOperationKind;
	payloadSha256: string;
	state: ManagerOperationState;
	acceptedAt: string;
	updatedAt: string;
	pollPath: string;
	startedAt?: string;
	finishedAt?: string;
	result?: unknown;
	error?: string;
}

export interface VerificationRequest {
	schemaVersion: 1;
	requestId: string;
	requestSha256: string;
	runId: string;
	generation: number;
	graphSha256: string;
	runAssignmentPath: string;
	runAssignmentSha256: string;
	integrationBranch: string;
	integrationWorktree: string;
	integrationHead: string;
	integrationTree: string;
	requestedAt: string;
	/** The failed verification request from which this successor was created. */
	predecessorRequestId?: string;
	/** The bounded integration repair transaction that owns this request. */
	repairId?: string;
	repairRound?: number;
}

export const REIGNITE_STATES = ["pending", "skipped", "written", "failed"] as const;
export type ReigniteState = typeof REIGNITE_STATES[number];

export interface ReigniteRequest {
	schemaVersion: 1;
	requestId: string;
	requestSha256: string;
	runId: string;
	generation: number;
	sourcePlanDirectory: string;
	graphSha256: string;
	integrationHead: string;
	integrationTree: string;
	integrationBranch: string;
	verdict: "APPROVE" | "REVISE" | "BLOCK";
	scope: "PASS" | "FAIL";
	findings: string[];
	fixGuidance: string[];
	rationale: string;
	createdAt: string;
	state: ReigniteState;
	allocatedPlanDirectory?: string;
	detail?: string;
}

export interface VerificationGate {
	gateId: string;
	label: string;
	/** TreeRelative path inside the integration worktree. Use "." for the worktree root; absolute paths are invalid. */
	cwd: string;
	argv: string[];
	timeoutMs?: number;
	rationale: string;
}

export interface VerificationManifest {
	schemaVersion: 1;
	requestId: string;
	requestSha256: string;
	runId: string;
	generation: number;
	graphSha256: string;
	runAssignmentSha256: string;
	integrationHead: string;
	integrationTree: string;
	rationale: string;
	gates: VerificationGate[];
	predecessorRequestId?: string;
	repairId?: string;
	repairRound?: number;
	selector?: {
		model?: string;
		thinkingLevel?: string;
		sessionId?: string;
	};
}

export const INTEGRATION_REPAIR_CLASSIFICATIONS = [
	"code_defect",
	"transient",
	"manifest_error",
	"design_ambiguity",
	"scope_ambiguity",
	"credential",
	"product_ambiguity",
] as const;
export type IntegrationRepairClassification = typeof INTEGRATION_REPAIR_CLASSIFICATIONS[number];

export const INTEGRATION_REPAIR_STATES = [
	"available",
	"active",
	"committing",
	"committed",
	"verifying",
	"passed",
	"failed",
	"cancelled",
	"paused",
	"interrupted",
] as const;
export type IntegrationRepairState = typeof INTEGRATION_REPAIR_STATES[number];
export const INTEGRATION_REPAIR_OPERATIONS = ["begin", "finish", "cancel"] as const;
export type IntegrationRepairOperation = typeof INTEGRATION_REPAIR_OPERATIONS[number];

export interface IntegrationRepairEpisode {
	episodeId: string;
	repairId: string;
	requestId: string;
	requestSha256: string;
	integrationHead: string;
	integrationTree: string;
	canonicalGates: VerificationGate[];
	canonicalGatesSha256: string;
	classification: IntegrationRepairClassification | null;
	state: IntegrationRepairState;
	operationId: string | null;
	operationPayloadSha256: string | null;
	transientUsed: boolean;
	transientUseEvidenceSha256: string | null;
	createdAt: string;
	updatedAt: string;
	closedAt: string | null;
}

/** Bind one classification episode to the exact failed verification evidence. */
export function integrationRepairEpisodeId(input: {
	requestId: string;
	requestSha256: string;
	integrationHead: string;
	integrationTree: string;
	canonicalGates: VerificationGate[];
}): string {
	return sha256(stableJson({
		requestId: input.requestId,
		requestSha256: input.requestSha256,
		integrationHead: input.integrationHead,
		integrationTree: input.integrationTree,
		canonicalGates: input.canonicalGates,
	}));
}

/** One immutable object identity in the Herder-owned repair namespace. */
export interface IntegrationRepairRef {
	ref: string;
	target: string;
}

export function integrationRepairRefSnapshotSha256(snapshot: IntegrationRepairRef[]): string {
	return sha256(stableJson(snapshot));
}

export function validateIntegrationRepairRefSnapshot(value: unknown): asserts value is IntegrationRepairRef[] {
	if (!Array.isArray(value)) throw new Error("Integration repair begin-ref snapshot must be an array");
	const seen = new Set<string>();
	let previous = "";
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Integration repair begin-ref snapshot entry is invalid");
		const candidate = entry as Partial<IntegrationRepairRef>;
		if (typeof candidate.ref !== "string" || !candidate.ref || /[\0\r\n]/.test(candidate.ref)) {
			throw new Error("Integration repair begin-ref snapshot ref is invalid");
		}
		if (!/^refs\//.test(candidate.ref)) throw new Error("Integration repair begin-ref snapshot ref is not a Git ref");
		if (typeof candidate.target !== "string" || !/^[0-9a-f]{40,64}$/i.test(candidate.target)) {
			throw new Error("Integration repair begin-ref snapshot target is invalid");
		}
		if (seen.has(candidate.ref)) throw new Error(`Integration repair begin-ref snapshot contains duplicate ref ${candidate.ref}`);
		if (previous && candidate.ref <= previous) throw new Error("Integration repair begin-ref snapshot is not sorted");
		seen.add(candidate.ref);
		previous = candidate.ref;
	}
}

/** A deterministic capability bound to exactly one failed verification request. */
export function integrationRepairCapabilityToken(requestId: string): string {
	return sha256(`herder-integration-repair-capability:${requestId}`);
}

export function integrationRepairCapabilityDigest(capabilityToken: string): string {
	return sha256(capabilityToken);
}

export interface IntegrationRepairRequest {
	schemaVersion: 1;
	repairId?: string;
	episodeId?: string;
	requestId: string;
	requestSha256: string;
	runId: string;
	generation: number;
	state: IntegrationRepairState;
	classification?: IntegrationRepairClassification;
	episodeState?: "unclassified" | IntegrationRepairState;
	episodeRequestSha256?: string;
	episodeIntegrationHead?: string;
	episodeIntegrationTree?: string;
	episodeCanonicalGatesSha256?: string;
	round: number;
	maxRounds: 3;
	/** Number of accepted code-defect commits across the repair lineage. */
	acceptedCodeRounds?: number;
	/** Whether an unchanged transient retry has been consumed for this evidence chain. */
	transientRetryUsed?: boolean;
	ownerSessionId?: string;
	/** Never persist or expose this value in SQLite; it is request-bound evidence. */
	capabilityToken: string;
	capabilityTokenSha256: string;
	/** Durable checkout identity copied from the failed verification request. */
	integrationBranch: string;
	integrationWorktree: string;
	parentCommit: string;
	currentCommit?: string;
	currentTree?: string;
	failedGates: VerificationGate[];
	canonicalGates: VerificationGate[];
	/** Canonical Herder-owned refs captured when the repair began. */
	beginRefSnapshot?: IntegrationRepairRef[];
	beginRefSnapshotSha256?: string;
	successorRequestId?: string;
	successorRequestSha256?: string;
	supersededCommits: string[];
	detail?: string;
}

export interface IntegrationRepairInput {
	schemaVersion?: 1;
	operation: IntegrationRepairOperation;
	operationId?: string;
	repairId?: string;
	requestId: string;
	requestSha256: string;
	capabilityToken: string;
	runId?: string;
	generation?: number;
	ownerSessionId?: string;
	classification?: IntegrationRepairClassification | string;
	rationale?: string;
	detail?: string;
	/** A complete successor gate array. For code/transient recovery it must retain the exact prefix. */
	gates?: VerificationGate[];
	/** Explicitly recorded append-only additions for code repair. */
	gateAdditions?: VerificationGate[];
	/** Failure-related repository paths allowed in the accepted code-defect commit. Required when finishing code repair. */
	allowedPaths?: string[];
	/** The clean integration-worktree HEAD observed by the owning adapter before finish. */
	observedCommit?: string;
}

export function validateIntegrationRepairInput(value: unknown): asserts value is IntegrationRepairInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration repair input must be an object");
	if (Object.prototype.hasOwnProperty.call(value, "commitMessage")) throw new Error("Integration repair commitMessage is not accepted; the owning session must author the commit");
	const input = value as Partial<IntegrationRepairInput>;
	if (!INTEGRATION_REPAIR_OPERATIONS.includes(input.operation as IntegrationRepairOperation)) throw new Error("Integration repair operation is invalid");
	for (const [name, candidate, limit] of [["requestId", input.requestId, 200], ["requestSha256", input.requestSha256, 64], ["capabilityToken", input.capabilityToken, 64]] as const) {
		if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > limit || /[\0\r\n]/.test(candidate)) throw new Error(`Integration repair ${name} is invalid`);
	}
	if (!/^[0-9a-f]{64}$/i.test(input.requestSha256!) || !/^[0-9a-f]{64}$/i.test(input.capabilityToken!)) throw new Error("Integration repair identities must be SHA-256 values");
	if (input.capabilityToken !== integrationRepairCapabilityToken(input.requestId!)) throw new Error("Integration repair capability token is not request-bound");
	if (input.ownerSessionId !== undefined && (typeof input.ownerSessionId !== "string" || input.ownerSessionId.length === 0 || input.ownerSessionId.length > 256 || /[\0\r\n]/.test(input.ownerSessionId))) throw new Error("Integration repair ownerSessionId is invalid");
	if (input.repairId !== undefined && (typeof input.repairId !== "string" || input.repairId.length === 0 || input.repairId.length > 200 || /[\0\r\n]/.test(input.repairId))) throw new Error("Integration repair repairId is invalid");
	if (input.gates !== undefined && (!Array.isArray(input.gates) || input.gates.length > 32)) throw new Error("Integration repair gates are invalid");
	if (input.gateAdditions !== undefined && (!Array.isArray(input.gateAdditions) || input.gateAdditions.length > 32)) throw new Error("Integration repair gate additions are invalid");
	if (input.allowedPaths !== undefined && (!Array.isArray(input.allowedPaths) || input.allowedPaths.length > 256 || input.allowedPaths.some((path) => typeof path !== "string" || !path || path.length > 2_048 || /[\0\r\n]/.test(path)))) throw new Error("Integration repair allowed paths are invalid");
	if (input.observedCommit !== undefined && (typeof input.observedCommit !== "string" || !/^[0-9a-f]{40,64}$/i.test(input.observedCommit))) throw new Error("Integration repair observed commit is invalid");
}

export function validateIntegrationRepairRequest(value: unknown): asserts value is IntegrationRepairRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration repair request must be an object");
	const request = value as Partial<IntegrationRepairRequest>;
	if (request.schemaVersion !== 1 || typeof request.requestId !== "string" || typeof request.requestSha256 !== "string" || typeof request.runId !== "string") throw new Error("Integration repair request identity is invalid");
	if (!INTEGRATION_REPAIR_STATES.includes(request.state as IntegrationRepairState)) throw new Error("Integration repair request state is invalid");
	if (!Number.isSafeInteger(request.round) || Number(request.round) < 1 || Number(request.round) > 3) throw new Error("Integration repair request round is invalid");
	if (request.maxRounds !== 3 || typeof request.capabilityToken !== "string" || request.capabilityToken !== integrationRepairCapabilityToken(request.requestId)) throw new Error("Integration repair request capability is invalid");
	if (request.capabilityTokenSha256 !== integrationRepairCapabilityDigest(request.capabilityToken)) throw new Error("Integration repair request capability digest is invalid");
	for (const [name, candidate, limit] of [["integrationBranch", request.integrationBranch, 512], ["integrationWorktree", request.integrationWorktree, 2_048]] as const) {
		if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > limit || /[\0\r\n]/.test(candidate)) throw new Error(`Integration repair request ${name} is invalid`);
	}
	if (!Array.isArray(request.failedGates) || !Array.isArray(request.canonicalGates) || !Array.isArray(request.supersededCommits)) throw new Error("Integration repair request evidence is invalid");
	if (request.episodeId !== undefined && (typeof request.episodeId !== "string" || !/^[0-9a-f]{64}$/i.test(request.episodeId))) throw new Error("Integration repair episode identity is invalid");
	if (request.episodeState !== undefined && request.episodeState !== "unclassified" && !INTEGRATION_REPAIR_STATES.includes(request.episodeState as IntegrationRepairState)) throw new Error("Integration repair episode state is invalid");
	for (const [name, candidate] of [["episodeRequestSha256", request.episodeRequestSha256], ["episodeCanonicalGatesSha256", request.episodeCanonicalGatesSha256]] as const) {
		if (candidate !== undefined && (typeof candidate !== "string" || !/^[0-9a-f]{64}$/i.test(candidate))) throw new Error(`Integration repair ${name} is invalid`);
	}
	for (const [name, candidate] of [["episodeIntegrationHead", request.episodeIntegrationHead], ["episodeIntegrationTree", request.episodeIntegrationTree]] as const) {
		if (candidate !== undefined && (typeof candidate !== "string" || !/^[0-9a-f]{40,64}$/i.test(candidate))) throw new Error(`Integration repair ${name} is invalid`);
	}
	if (request.acceptedCodeRounds !== undefined && (!Number.isSafeInteger(request.acceptedCodeRounds) || request.acceptedCodeRounds < 0 || request.acceptedCodeRounds > 3)) throw new Error("Integration repair accepted code rounds are invalid");
	if (request.transientRetryUsed !== undefined && typeof request.transientRetryUsed !== "boolean") throw new Error("Integration repair transient retry evidence is invalid");
	const episodeEvidencePresent = request.episodeId !== undefined || request.episodeRequestSha256 !== undefined || request.episodeIntegrationHead !== undefined || request.episodeIntegrationTree !== undefined || request.episodeCanonicalGatesSha256 !== undefined;
	if (episodeEvidencePresent && (request.episodeId === undefined || request.episodeRequestSha256 === undefined || request.episodeIntegrationHead === undefined || request.episodeIntegrationTree === undefined || request.episodeCanonicalGatesSha256 === undefined)) {
		throw new Error("Integration repair episode evidence is incomplete");
	}
	if (request.episodeId !== undefined && request.episodeRequestSha256 !== undefined && request.episodeIntegrationHead !== undefined && request.episodeIntegrationTree !== undefined) {
		if (sha256(stableJson(request.canonicalGates)) !== request.episodeCanonicalGatesSha256
			|| integrationRepairEpisodeId({
				requestId: request.requestId,
				requestSha256: request.episodeRequestSha256,
				integrationHead: request.episodeIntegrationHead,
				integrationTree: request.episodeIntegrationTree,
				canonicalGates: request.canonicalGates,
			}) !== request.episodeId) throw new Error("Integration repair episode identity does not match its evidence");
	}
	if (request.beginRefSnapshot !== undefined || request.beginRefSnapshotSha256 !== undefined) {
		if (request.beginRefSnapshot === undefined || typeof request.beginRefSnapshotSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(request.beginRefSnapshotSha256)) {
			throw new Error("Integration repair begin-ref snapshot evidence is incomplete");
		}
		validateIntegrationRepairRefSnapshot(request.beginRefSnapshot);
		if (integrationRepairRefSnapshotSha256(request.beginRefSnapshot) !== request.beginRefSnapshotSha256) {
			throw new Error("Integration repair begin-ref snapshot hash changed");
		}
	}
}

export interface ManagerReply {
	protocolVersion: number;
	runId: string;
	status: RunStatus | "idle";
	profileName: string;
	maxParallel: number;
	planDirectory: string;
	dashboardUrl?: string;
	actions: ManagerAction[];
	active: Array<{ actionId: string; planId: string; role: string; hostHandle?: string }>;
	summary: {
		total: number;
		done: number;
		rejected: number;
		inProgress: number;
		available: number;
	};
	scheduler: {
		active: number;
		freeSlots: number;
		runnable: number;
		runnablePlanIds: string[];
		expectedNewActions: number;
		workConserving: boolean;
		reason: "saturated" | "no-runnable-work" | "scheduled" | "host-backpressure" | "revision-barrier" | "scheduler-stall" | "inactive";
		checkedAt: string;
	};
	message: string;
	question?: string;
	attention?: ManagerAttentionRequest;
	planEdit?: ManagerPlanEdit;
	verificationRequest?: VerificationRequest;
	integrationRepair?: IntegrationRepairRequest;
	reigniteRequest?: ReigniteRequest;
	operations?: ManagerOperationReceipt[];
}

export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function canonicalEventPayload(value: unknown): { json: string; sha256: string } {
	const json = stableJson(value);
	return { json, sha256: sha256(json) };
}

function optionalCount(value: unknown): number | null {
	if (value === null || value === undefined || value === "" || String(value).toLowerCase() === "unknown") return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseUsageLine(value: string | undefined): UsageEvidence {
	const fields = new Map<string, string>();
	for (const part of String(value ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
	}
	return {
		inputTokens: optionalCount(fields.get("input_tokens")),
		cachedInputTokens: optionalCount(fields.get("cached_input_tokens")),
		outputTokens: optionalCount(fields.get("output_tokens")),
		reasoningTokens: optionalCount(fields.get("reasoning_tokens")),
		source: fields.get("source") || "unknown",
	};
}

function parseFields(text: string): Map<string, string> {
	const fields = new Map<string, string>();
	let current: string | null = null;
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		const match = line.match(/^([A-Z][A-Z _-]*):\s*(.*)$/);
		if (match) {
			current = match[1]!.trim();
			fields.set(current, match[2]!.trim());
		} else if (current && line.trim()) {
			fields.set(current, `${fields.get(current)}\n${line.trim()}`);
		}
	}
	return fields;
}

function requiredField(fields: Map<string, string>, name: string): string {
	const value = fields.get(name)?.trim();
	if (!value) throw new Error(`Worker result is missing ${name}`);
	return value;
}

function lines(value: string | undefined): string[] {
	if (!value || value.trim().toLowerCase() === "none") return [];
	return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

export interface ImplementerResult {
	kind: "implementer";
	status: "COMPLETE" | "STOPPED" | "FAILED";
	commits: string[];
	checks: string[];
	filesChanged: string[];
	discoveredPaths: string[];
	stoppedBecause?: string;
	notes: string;
	usage: UsageEvidence;
}

export interface ReviewerResult {
	kind: "reviewer";
	verdict: "APPROVE" | "REVISE" | "BLOCK";
	findings: string[];
	fixGuidance: string[];
	discoveredPaths: string[];
	scope: "PASS" | "FAIL";
	checks: string[];
	rationale: string;
	usage: UsageEvidence;
}

export interface JudgeResult {
	kind: "judge";
	decision: "DONE" | "REPAIR" | "NEEDS_INPUT" | "BLOCKED";
	findings: string[];
	authorizedBlockers: string[];
	repairContracts: string[];
	discoveredPaths: string[];
	leaks: string[];
	question?: string;
	checks: string[];
	rationale: string;
	usage: UsageEvidence;
}

export type WorkerResult = ImplementerResult | ReviewerResult | JudgeResult;

export function parseWorkerResult(role: WorkerRole, text: string): WorkerResult {
	const fields = parseFields(text);
	if (role === "plan-implementer") {
		const status = requiredField(fields, "STATUS");
		if (!["COMPLETE", "STOPPED", "FAILED"].includes(status)) throw new Error(`Invalid Implementer STATUS: ${status}`);
		return {
			kind: "implementer",
			status: status as ImplementerResult["status"],
			commits: lines(fields.get("COMMITS")).flatMap((line) => line.split(/[\s,]+/)).filter((item) => /^[0-9a-f]{7,64}$/i.test(item)),
			checks: lines(fields.get("CHECKS")),
			filesChanged: lines(fields.get("FILES CHANGED")).flatMap((line) => line.split(/\s*,\s*/)).filter((item) => item && item.toLowerCase() !== "none"),
			discoveredPaths: lines(fields.get("DISCOVERED_PATHS")),
			...(fields.get("STOPPED BECAUSE") ? { stoppedBecause: fields.get("STOPPED BECAUSE") } : {}),
			notes: fields.get("NOTES") || "",
			usage: parseUsageLine(fields.get("USAGE")),
		};
	}
	if (role === "plan-reviewer") {
		const verdict = requiredField(fields, "VERDICT");
		const scope = requiredField(fields, "SCOPE");
		if (!["APPROVE", "REVISE", "BLOCK"].includes(verdict)) throw new Error(`Invalid Reviewer VERDICT: ${verdict}`);
		if (!["PASS", "FAIL"].includes(scope)) throw new Error(`Invalid Reviewer SCOPE: ${scope}`);
		return {
			kind: "reviewer",
			verdict: verdict as ReviewerResult["verdict"],
			findings: lines(fields.get("FINDINGS")),
			fixGuidance: lines(fields.get("FIX_GUIDANCE")),
			discoveredPaths: lines(fields.get("DISCOVERED_PATHS")),
			scope: scope as ReviewerResult["scope"],
			checks: lines(fields.get("CHECKS")),
			rationale: fields.get("RATIONALE") || "",
			usage: parseUsageLine(fields.get("USAGE")),
		};
	}
	const decision = requiredField(fields, "DECISION");
	if (!["DONE", "REPAIR", "NEEDS_INPUT", "BLOCKED"].includes(decision)) throw new Error(`Invalid Judge DECISION: ${decision}`);
	const question = fields.get("QUESTION")?.trim();
	const result: JudgeResult = {
		kind: "judge",
		decision: decision as JudgeResult["decision"],
		findings: lines(fields.get("FINDINGS")),
		authorizedBlockers: lines(fields.get("AUTHORIZED_BLOCKERS")).flatMap((line) => line.split(/[\s,]+/)).filter(Boolean),
		repairContracts: lines(fields.get("REPAIR_CONTRACTS")),
		discoveredPaths: lines(fields.get("DISCOVERED_PATHS")),
		leaks: lines(fields.get("LEAKS")),
		...(question && question.toLowerCase() !== "none" ? { question } : {}),
		checks: lines(fields.get("CHECKS")),
		rationale: fields.get("RATIONALE") || "",
		usage: parseUsageLine(fields.get("USAGE")),
	};
	if (result.decision === "DONE" && result.authorizedBlockers.length > 0) {
		throw new Error("Judge DONE cannot retain authorized blockers");
	}
	if (result.decision === "REPAIR" && (result.authorizedBlockers.length === 0 || result.repairContracts.length === 0)) {
		throw new Error("Judge REPAIR requires authorized blockers and repair contracts");
	}
	if (result.decision === "NEEDS_INPUT" && !result.question) {
		throw new Error("Judge NEEDS_INPUT requires one question");
	}
	return result;
}

function normalizeNestedUsage(value: unknown): NestedUsageSlice[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new Error("Usage nested breakdown must be an array");
	const slices = value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Usage nested slice ${index} must be an object`);
		const record = item as Record<string, unknown>;
		const type = String(record.type ?? "").trim();
		const model = String(record.model ?? "").trim();
		const effort = String(record.effort ?? "").trim();
		const count = optionalCount(record.count);
		if (!type || !model || !effort) throw new Error(`Usage nested slice ${index} is missing type, model, or effort`);
		if (count === null || count < 1) throw new Error(`Usage nested slice ${index} has an invalid count`);
		const serviceTier = typeof record.serviceTier === "string" && record.serviceTier.trim() ? record.serviceTier.trim() : undefined;
		const durationMs = optionalCount(record.durationMs);
		return {
			type,
			model,
			effort,
			...(serviceTier ? { serviceTier } : {}),
			count,
			inputTokens: optionalCount(record.inputTokens),
			cachedInputTokens: optionalCount(record.cachedInputTokens),
			outputTokens: optionalCount(record.outputTokens),
			reasoningTokens: optionalCount(record.reasoningTokens),
			...(durationMs !== null ? { durationMs } : {}),
		} satisfies NestedUsageSlice;
	});
	return slices.length > 0 ? slices : undefined;
}

export function normalizeUsage(result: WorkerResult | null, terminal: TerminalEvent): UsageEvidence {
	const supplied = terminal.usage ?? {};
	const fallback = result?.usage ?? {
		inputTokens: null,
		cachedInputTokens: null,
		outputTokens: null,
		reasoningTokens: null,
		source: "unknown",
	};
	const nested = normalizeNestedUsage(supplied.nested ?? fallback.nested);
	return {
		inputTokens: optionalCount(supplied.inputTokens ?? fallback.inputTokens),
		cachedInputTokens: optionalCount(supplied.cachedInputTokens ?? fallback.cachedInputTokens),
		outputTokens: optionalCount(supplied.outputTokens ?? fallback.outputTokens),
		reasoningTokens: optionalCount(supplied.reasoningTokens ?? fallback.reasoningTokens),
		source: String(supplied.source ?? fallback.source ?? "unknown"),
		...(supplied.startedAt ? { startedAt: String(supplied.startedAt) } : {}),
		...(supplied.finishedAt ? { finishedAt: String(supplied.finishedAt) } : {}),
		...(supplied.durationMs !== undefined && optionalCount(supplied.durationMs) !== null
			? { durationMs: optionalCount(supplied.durationMs)! }
			: {}),
		...(nested ? { nested } : {}),
	};
}
