import { attentionCapabilityToken, type ManagerAttentionRequest } from "../src/shared/protocol.ts";
import { buildPlanningSkillPrompt } from "./planning-workflows.ts";

export const HERDER_ATTENTION_MESSAGE = "herder-attention-v1";

export interface HerderAttentionMessageDetails {
	requestId: string;
	kind: ManagerAttentionRequest["kind"];
	planId: string;
	generation: number;
	round: number;
}

function list(values: readonly string[] | undefined): string {
	return values && values.length > 0 ? values.join("\n") : "none";
}

function requestBinding(request: ManagerAttentionRequest, planDirectory?: string): string[] {
	return [
		...(planDirectory ? [`PLAN_DIRECTORY: ${planDirectory}`] : []),
		"SCHEMA_VERSION: 1",
		`REQUEST_ID: ${request.requestId}`,
		`REQUEST_SHA256: ${request.requestSha256}`,
		`CAPABILITY_TOKEN: ${request.capabilityToken || attentionCapabilityToken(request.requestId)}`,
		`RUN_ID: ${request.runId}`,
		`PLAN_ID: ${request.planId}`,
		`GENERATION: ${request.generation}`,
		`ROUND: ${request.round}`,
		`ACTION_ID: ${request.actionId ?? "null"}`,
		`STATE: ${request.state}`,
		`DETAIL_SHA256: ${request.detailSha256}`,
		`CONTINUATION_ROLE: ${request.continuation.role}`,
		`CONTINUATION_PHASE: ${request.continuation.phase}`,
		`CAUSE: ${request.cause}`,
	];
}

function recoveryIdentity(request: Extract<ManagerAttentionRequest, { kind: "plan_recovery" }>): string[] {
	const recovery = request.recovery;
	const identity = {
		assignmentPath: recovery.assignmentPath,
		assignmentSha256: recovery.assignmentSha256,
		snapshotSha256: recovery.snapshotSha256,
		generationBase: recovery.generationBase,
		branch: recovery.branch,
		worktree: recovery.worktree,
		worktreeHead: recovery.worktreeHead,
		worktreeTree: recovery.worktreeTree,
	};
	return ["RECOVERY_GIT_IDENTITY:", JSON.stringify(identity)];
}

export function attentionMessageDetails(request: ManagerAttentionRequest): HerderAttentionMessageDetails {
	return {
		requestId: request.requestId,
		kind: request.kind,
		planId: request.planId,
		generation: request.generation,
		round: request.round,
	};
}

export async function buildAttentionPrompt(
	packageRoot: string,
	planDirectory: string,
	request: ManagerAttentionRequest,
): Promise<string> {
	if (request.kind === "plan_recovery") {
		const recovery = request.recovery;
		const runtimeContext = [
			"HERDER_ACTIVE_PLAN_RECOVERY_V1",
			"The deterministic Run Manager has delegated exactly one blocked-plan recovery request to this main Pi session.",
			"Inspect evidence and the target plan in the user checkout. The main session may edit only the confirmed target plan Markdown; it never edits source code, README status, dependencies, sibling plans, Git refs, worktrees, SQLite, leases, or run-control state.",
			"Ask one decision at a time and require final confirmation before any plan edit. A graph-affecting discovery must stop and direct the operator to the existing graph-wide revise workflow.",
			`PLAN_FILE: ${recovery.planFile}`,
			`PLAN_FINGERPRINT: ${recovery.planFingerprint}`,
			`FINGERPRINT_VERSION: ${recovery.fingerprintVersion}`,
			...requestBinding(request, planDirectory),
			"RECOVERY_DOSSIER:",
			`DETAIL: ${request.detail}`,
			`RECOMMENDED_ACTION: ${request.recommendedAction ?? "none"}`,
			`IN_SCOPE_PATH_COUNT: ${recovery.inScopePathCount ?? recovery.inScopePaths.length}`,
			`IN_SCOPE_PATHS_SHA256: ${recovery.inScopePathsSha256 ?? "none"}`,
			"IN_SCOPE_PATHS:",
			list(recovery.inScopePaths),
			`CHANGED_PATH_COUNT: ${recovery.changedPathCount ?? recovery.changedPaths.length}`,
			`CHANGED_PATHS_SHA256: ${recovery.changedPathsSha256 ?? "none"}`,
			"CHANGED_PATHS:",
			list(recovery.changedPaths),
			...recoveryIdentity(request),
			"ALLOWED_OPERATIONS: defer, unchanged_retry, revise, reject",
			"For defer, submit the request unchanged with action \"defer\" and do not edit files.",
			"For unchanged retry, preserve the target plan content, record a non-empty rationale, and submit action \"unchanged_retry\".",
			"For a replacement, edit only the confirmed target plan content, run shape and validate, then submit action \"revise\" with a non-empty rationale.",
			"For a rejected recovery, submit action \"reject\" with a non-empty rationale.",
			"Every resolution payload must include the fixed field schemaVersion: 1.",
			"Submit every recovery decision with herder_plan operation \"attention\", the exact request binding above, and the exact RECOVERY_GIT_IDENTITY object. Never invent a new capability token.",
		].join("\n");
		const grill = await buildPlanningSkillPrompt(packageRoot, "grill", "", runtimeContext);
		return [
			"HERDER_MAIN_SESSION_ATTENTION_V1",
			"Herder has presented one durable plan-recovery request. Follow the exact packaged Grill skill below; it is a recovery extension of the normal Grill interview, not a new graph-wide planning workflow.",
			grill,
		].join("\n\n");
	}

	const question = request.question ?? request.detail;
	const binding = requestBinding(request, planDirectory).join("\n");
	if (request.kind === "user_decision") {
		return [
			"HERDER_MAIN_SESSION_USER_DECISION_V1",
			"Ask the user exactly the following one-line question without paraphrasing or supplying an answer:",
			`QUESTION: ${question}`,
			`RECOMMENDED_ACTION: ${request.recommendedAction ?? "none"}`,
			binding,
			"After the user answers, call herder_plan exactly once with operation \"attention\", schemaVersion: 1, action \"answer\", the exact answer text, and every request binding field above. Do not use an unbound user_input event. Do not edit source, plans, Git state, SQLite, or run-control state.",
		].join("\n");
	}

	return [
		"HERDER_MAIN_SESSION_OPERATOR_ATTENTION_V1",
		"Present this bounded operator choice without rewriting the plan: retry the recorded role, or stop/cancel it. Do not reinterpret transport/provider evidence as a plan failure and do not edit any file.",
		`DETAIL: ${question}`,
		`RECOMMENDED_ACTION: ${request.recommendedAction ?? "none"}`,
		binding,
		"The user may defer. After a choice, call herder_plan exactly once with operation \"attention\", schemaVersion: 1, action \"retry\" for the recorded role or \"cancel\" to stop, with the exact request binding fields above. Use action \"defer\" only when no decision is made.",
	].join("\n");
}
