import { createHash } from "node:crypto";

export const MANAGER_PROTOCOL_VERSION = 4;
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
	orchestrator: { model: string; effort: string };
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

export interface UsageEvidence {
	inputTokens: number | null;
	cachedInputTokens: number | null;
	outputTokens: number | null;
	reasoningTokens: number | null;
	source: string;
	startedAt?: string;
	finishedAt?: string;
	durationMs?: number;
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

export const MANAGER_OPERATION_KINDS = ["start", "event", "edit", "stop", "verification"] as const;
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
}

export interface VerificationGate {
	gateId: string;
	label: string;
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
	selector?: {
		model?: string;
		thinkingLevel?: string;
		sessionId?: string;
	};
}

export interface ManagerReply {
	protocolVersion: number;
	runId: string;
	status: RunStatus | "idle";
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
	planEdit?: ManagerPlanEdit;
	verificationRequest?: VerificationRequest;
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

export function normalizeUsage(result: WorkerResult | null, terminal: TerminalEvent): UsageEvidence {
	const supplied = terminal.usage ?? {};
	const fallback = result?.usage ?? {
		inputTokens: null,
		cachedInputTokens: null,
		outputTokens: null,
		reasoningTokens: null,
		source: "unknown",
	};
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
	};
}
