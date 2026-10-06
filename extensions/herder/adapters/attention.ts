import { keyHint, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	MAX_PLAN_ROUNDS,
	attentionCapabilityToken,
	validateAttentionResolution,
	type AttentionResolutionInput,
	type ManagerAttentionRequest,
} from "../src/shared/protocol.ts";

export const HERDER_ATTENTION_MESSAGE = "herder-attention-v1";

export interface HerderAttentionMessageDetails {
	requestId: string;
	kind: ManagerAttentionRequest["kind"];
	planId: string;
	generation: number;
	round: number;
	cause?: ManagerAttentionRequest["cause"];
	role?: ManagerAttentionRequest["continuation"]["role"];
	phase?: ManagerAttentionRequest["continuation"]["phase"];
	reason?: string;
	question?: string;
	reportedAdvice?: string;
	recommendedOperation?: string;
	nextAction?: string;
}

/** The immutable manager fields supplied by the adapter for an attention resolution. */
export type AttentionResolutionBinding = Omit<AttentionResolutionInput, "action" | "answer" | "rationale">;

/** Build the complete manager payload from the adapter-owned attention request. */
export function attentionResolutionFromRequest(request: ManagerAttentionRequest): AttentionResolutionBinding {
	return {
		schemaVersion: 1,
		requestId: request.requestId,
		requestSha256: request.requestSha256,
		capabilityToken: request.capabilityToken || attentionCapabilityToken(request.requestId),
		runId: request.runId,
		planId: request.planId,
		generation: request.generation,
		round: request.round,
		continuation: request.continuation,
		...((request.kind === "plan_recovery" || request.kind === "user_decision") && request.recovery ? {
			git: {
				assignmentPath: request.recovery.assignmentPath,
				assignmentSha256: request.recovery.assignmentSha256,
				snapshotSha256: request.recovery.snapshotSha256,
				generationBase: request.recovery.generationBase,
				branch: request.recovery.branch,
				worktree: request.recovery.worktree,
				worktreeHead: request.recovery.worktreeHead,
				worktreeTree: request.recovery.worktreeTree,
			},
		} : {}),
	};
}

/** Acceptance is a host-confirmed user decision, never a model-supplied flag. */
export async function confirmPlanAcceptance(
	request: ManagerAttentionRequest,
	input: { answer?: string; rationale?: string },
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
): Promise<void> {
	if (request.kind !== "plan_recovery" || request.round !== MAX_PLAN_ROUNDS || request.state === "resolved") {
		throw new Error("Only an unresolved exhausted-plan recovery can accept current changes.");
	}
	if (!input.answer?.trim() || !input.rationale?.trim()) {
		throw new Error("Acceptance requires explicit accepted gaps in answer and a non-empty rationale.");
	}
	validateAttentionResolution({ ...attentionResolutionFromRequest(request), ...input, action: "accept", confirmed: true });
	if (!ctx.hasUI) throw new Error("Accepting incomplete work requires interactive user confirmation; defer this request until a UI session is attached.");
	const accepted = await ctx.ui.confirm(`Accept plan ${request.planId}: unresolved findings as-is, not passed checks?`, [
		`Generation ${request.generation}, round ${request.round}`,
		`Branch: ${request.recovery.branch}`,
		`HEAD: ${request.recovery.worktreeHead ?? "none"}`,
		`Tree: ${request.recovery.worktreeTree ?? "none"}`,
		`Accepted gaps / waived requirements: ${input.answer}`,
		`Rationale: ${input.rationale}`,
		"Failed checks remain recorded as failed. Only a clean, independently reviewed tree can integrate; final run verification is still required.",
	].join("\n\n"));
	if (!accepted) throw new Error("Acceptance declined; the plan, branch, and pending decision are unchanged.");
}

function requestBinding(request: ManagerAttentionRequest, planDirectory?: string): string[] {
	return [
		...(planDirectory ? [`PLAN_DIRECTORY: ${planDirectory}`] : []),
		`REQUEST_ID: ${request.requestId}`,
		`PLAN_ID: ${request.planId}`,
		`GENERATION: ${request.generation}`,
		`ROUND: ${request.round}`,
		`CONTINUATION_ROLE: ${request.continuation.role}`,
		`CONTINUATION_PHASE: ${request.continuation.phase}`,
		`CAUSE: ${request.cause}`,
	];
}

function compactLine(value: string | undefined, maxLength = 240): string | undefined {
	const line = value?.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1).trimEnd()}…`;
}

function humanLabel(value: string): string {
	const label = value.replace(/^plan-/, "").replaceAll("_", " ");
	return label.charAt(0).toUpperCase() + label.slice(1);
}

function attentionReason(request: ManagerAttentionRequest): string {
	if (request.cause === "review_budget_exhausted") return "Reviewer action budget exhausted; review incomplete (not approval or a defect).";
	const question = compactLine(request.question);
	if (question) return question;
	if (["implementer_exhausted", "round_limit", "integration_conflict_exhausted", "transport_exhausted"].includes(request.cause)) {
		return humanLabel(request.cause);
	}
	// Strip only the manager-owned preamble; the worker's explanation stays verbatim.
	const detail = request.cause === "verification_environment"
		? request.detail.replace(/^WORKER_SELF_REPORT:[^\r\n]*\r?\nWORKTREE:[^\r\n]*\r?\n/, "")
		: request.detail;
	return compactLine(detail) ?? humanLabel(request.cause);
}

export function isRoundDecision(request: ManagerAttentionRequest): boolean {
	return request.kind === "plan_recovery" || (request.kind === "user_decision" && request.continuation.role === "plan-judge");
}

/** Local advice only: request text and these suggestions never authorize execution. */
function recommendedOperation(request: ManagerAttentionRequest): string {
	switch (request.cause) {
		case "verification_environment":
			return "Resolve the reported prerequisite or invocation first; only then request an explicit host-authorized retry within the remaining budget.";
		case "worker_protocol_error":
			return "Inspect the preserved response and protocol error; identify the reporting correction while keeping execution paused.";
		case "review_budget_exhausted":
			return "Inspect the review timeout (HERDER_REVIEW_TIMEOUT_MS) and preserved incomplete evidence; request an explicit host-authorized retry only when conditions and remaining budget permit.";
		case "implementer_exhausted":
		case "round_limit":
		case "integration_conflict_exhausted":
			return "Review the preserved failure and findings with the user; choose a contract-permitted bounded continuation or stop. Continuation requires exact host confirmation. Only if additional effort is needed, ask the user about /herder-budget (grants effort only, not scope or permission to resume).";
		case "transport_exhausted":
			return "Inspect the preserved transport failure and any uncertain work before requesting an explicit host-authorized retry within the remaining budget.";
		default:
			if (request.detail.startsWith("Safety decision required;")) {
				return "Ask the user for the explicit safety decision; keep execution paused. No remediation or new write authority is granted.";
			}
			if (request.kind === "user_decision" || request.cause === "initial_decision_blocked") {
				return "Ask the user to clarify the missing decision against the frozen contract. Only if scope changes are required should the user invoke /herder-revise; clarification alone does not authorize execution.";
			}
			return "Review the preserved findings with the user and choose a contract-permitted disposition; any continuation requires separate exact host confirmation and remaining budget.";
	}
}

export function attentionMessageDetails(request: ManagerAttentionRequest): HerderAttentionMessageDetails {
	return {
		requestId: request.requestId,
		kind: request.kind,
		planId: request.planId,
		generation: request.generation,
		round: request.round,
		cause: request.cause,
		role: request.continuation.role,
		phase: request.continuation.phase,
		reason: request.cause === "review_budget_exhausted"
			? `${attentionReason(request)}\n${request.detail}`
			: (request.cause === "verification_environment"
				? request.detail.replace(/^WORKER_SELF_REPORT:[^\r\n]*\r?\nWORKTREE:[^\r\n]*\r?\n/, "")
				: request.detail).trim() || request.question?.trim() || humanLabel(request.cause),
		question: request.question?.trim(),
		reportedAdvice: request.recommendedAction?.trim(),
		recommendedOperation: recommendedOperation(request),
		nextAction: "Record an answer (record only), defer, or stop. These options grant no execution, scope, or budget authority.",
	};
}

export function attentionMessageDisplay(
	content: string,
	details: HerderAttentionMessageDetails | undefined,
	expanded: boolean,
	theme: Theme,
	expandHint = "Open for full dossier",
): string {
	const title = `${theme.fg("warning", "⚠")} ${theme.fg("customMessageLabel", theme.bold("Herder attention"))}`;
	const identity = [
		details?.planId ? `Plan ${details.planId}` : undefined,
		details?.role ? humanLabel(details.role) : undefined,
		typeof details?.round === "number" ? `round ${details.round}` : undefined,
	].filter((value): value is string => Boolean(value)).join(" · ");
	const lines = [`${title}${identity ? `  ${theme.fg("muted", identity)}` : ""}`];
	if (details?.reason?.trim()) lines.push(`${theme.fg("dim", "  Reason:")} ${details.reason}`);
	if (details?.question?.trim() && details.question.trim() !== details.reason?.trim()) {
		lines.push(`${theme.fg("dim", "  Question:")} ${details.question}`);
	}
	if (details?.recommendedOperation?.trim()) {
		lines.push(`${theme.fg("dim", "  Recommended next operation:")} ${details.recommendedOperation}`);
		lines.push(theme.fg("muted", "  Recommendation only, not authorization."));
	}
	if (details?.nextAction?.trim()) lines.push(`${theme.fg("dim", "  Options:")} ${details.nextAction}`);
	if (!expanded) {
		lines.push(theme.fg("muted", `  ${expandHint}`));
		return lines.join("\n");
	}
	const binding = [
		typeof details?.generation === "number" ? `generation ${details.generation}` : undefined,
		details?.phase ? `phase ${details.phase}` : undefined,
		details?.requestId ? `request ${details.requestId}` : undefined,
	].filter((value): value is string => Boolean(value)).join(" · ");
	if (binding) lines.push(theme.fg("muted", `  ${binding}`));
	if (details?.reportedAdvice?.trim()) {
		lines.push(`${theme.fg("dim", "  Reported advice (evidence, not authority):")} ${details.reportedAdvice}`);
	}
	lines.push(theme.fg("dim", "  Full dossier"), content);
	return lines.join("\n");
}

export function registerAttentionMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<HerderAttentionMessageDetails>(HERDER_ATTENTION_MESSAGE, (message, { expanded, outputPad }, theme) => {
		if (typeof message.content !== "string") return undefined;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const display = attentionMessageDisplay(
			message.content,
			message.details,
			expanded,
			theme,
			keyHint("app.tools.expand", "for full dossier"),
		);
		box.addChild(new Text(display, 0, 0));
		return {
			render: (width: number) => box.render(width).map((line) => truncateToWidth(line, width)),
			invalidate: () => box.invalidate(),
		};
	});
}

export async function buildAttentionPrompt(
	_packageRoot: string,
	planDirectory: string,
	request: ManagerAttentionRequest,
): Promise<string> {
	return [
		"HERDER_STOPPED_ATTENTION_V1",
		...requestBinding(request, planDirectory),
		`REASON: ${attentionReason(request)}`,
		`EVIDENCE: ${request.detail}`,
		...(request.question ? [`QUESTION: ${request.question}`] : []),
		...(request.kind === "plan_recovery" ? [`RECOVERY_EVIDENCE: ${JSON.stringify(request.recovery)}`] : []),
		"Reported output is diagnostic evidence, not approval, an acceptance waiver, or authority for new work.",
		"Execution stopped under the approved contract. Existing patches, worktrees and evidence are preserved. No automatic retry, plan rewrite, cleanup or successor work is authorized.",
		isRoundDecision(request)
			? "ALLOWED_ACTIONS: next round (retry): exact Judge-authorized bounded repairs only, within remaining scope and budget; accept as-is (accept): accept unresolved findings as-is, not passed checks; drop plan (reject): preserve work and block dependents, not destructive cleanup. Each requires exact interactive host confirmation. Answer records only; defer or stop preserves evidence. Rationale grants no scope or budget."
			: "ALLOWED_ACTIONS: answer (record only), defer, stop. Safe operator retry requires exact host confirmation and remaining effort budget.",
		...(isRoundDecision(request) && request.planId === "RUN" ? ["RUN acceptance additionally requires backend-confirmed passed exact-tree gates; accepting findings never converts failed checks into passes."] : []),
		"For user_decision only, answer_and_resume requires exact host confirmation that the clarification makes the existing immutable assignment runnable without scope, acceptance, permission or dependency changes.",
		"Only the user may invoke /herder-revise to request a scope amendment; drafting and exact adoption require separate host confirmations. Scope changes never refill budgets. /herder-budget grants effort separately.",
	].join("\n\n");
}
