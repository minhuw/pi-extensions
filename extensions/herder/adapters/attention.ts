import { readRunRevision } from "../src/core/run-revision.ts";
import { keyHint, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	MAX_PLAN_ROUNDS,
	attentionCapabilityToken,
	validateAttentionResolution,
	type AttentionResolutionInput,
	type ManagerAttentionRequest,
} from "../src/shared/protocol.ts";
import { buildPlanningSkillPrompt } from "./planning-workflows.ts";

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
		...(request.kind === "plan_recovery" ? {
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
	const accepted = await ctx.ui.confirm(`Accept plan ${request.planId} as DONE?`, [
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

function list(values: readonly string[] | undefined): string {
	return values && values.length > 0 ? values.join("\n") : "none";
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

function nextAction(request: ManagerAttentionRequest): string {
	if (request.planId !== "RUN") return "Propose/review a whole-run revision; abandon is available.";
	if (request.kind === "user_decision") return "Answer the question, or defer.";
	if (request.kind === "operator_attention") return "Retry the recorded role, cancel it, or defer.";
	return request.round === MAX_PLAN_ROUNDS
		? "Review the dossier, then accept, revise, stop, or defer."
		: "Review the dossier, then retry unchanged, revise, reject, or defer.";
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
		reason: attentionReason(request),
		nextAction: nextAction(request),
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
	if (details?.reason) lines.push(`${theme.fg("dim", "  Reason:")} ${details.reason}`);
	if (details?.nextAction) lines.push(`${theme.fg("dim", "  Next:")} ${details.nextAction}`);
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
		box.addChild(expanded
			? new Text(display, 0, 0)
			: {
				render: (width: number) => display.split("\n").map((line) => truncateToWidth(line, width)),
				invalidate: () => {},
			});
		return {
			render: (width: number) => box.render(width).map((line) => truncateToWidth(line, width)),
			invalidate: () => box.invalidate(),
		};
	});
}

export async function buildAttentionPrompt(
	packageRoot: string,
	planDirectory: string,
	request: ManagerAttentionRequest,
): Promise<string> {
	if (request.planId !== "RUN") {
		const revision = readRunRevision(planDirectory);
		return [
			"HERDER_MAIN_SESSION_ATTENTION_V1", "HERDER_WHOLE_RUN_REVISION_V1",
			...requestBinding(request, planDirectory),
			`FAILURE_EVIDENCE: ${request.detail}`, ...(request.question ? [`QUESTION: ${request.question}`] : []),
			...(request.kind === "plan_recovery" ? [`RECOVERY_DOSSIER: ${JSON.stringify(request.recovery)}`] : []),
			"Inspect the failure and the entire graph, including upstream DONE/integrated plans. PROPOSE a concrete whole-run graph revision directly: explain what changes and why, then let the user refine/approve it. Do not first ask permission to think, inspect, or propose a revision.",
			"ALLOWED_ACTIONS: revise_run, abandon_run. No defer menu, unchanged retry, answer-only resolution, target-only rewrite, or acceptance of incomplete work.",
			"Call herder_plan operation attention with action revise_run, this planDirectory and requestId to open the run-wide edit barrier. This stops all run workers before granting graph editing, but preserves their branches, worktrees, and proofs until final approval. Beginning a proposal does not require prior user permission.",
			`Before drafting, read ${packageRoot}/skills/plans/references/plan-format.md and ${packageRoot}/skills/plans/references/plan-template.md completely; follow canonical Plan V2 for every replacement plan.`,
			"Preserve confirmed product intent and the product/execution boundary: Herder delivers repository implementation, not release operations. Cloud provisioning, deployment/publishing, live migrations, and live database restore/undo are outside execution, even for disposable targets. Do not make them executable acceptance, verification, toolchain/setup, or dependency requirements; record operator workflows and outstanding live evidence in Escalation and handoff. Clarify and confirm any change to an existing live criterion instead of silently dropping it or treating local simulation as live proof. Propose substantive changes in conversation for user refinement. After begin, draft Markdown writes are allowed without execution approval; the host's later exact-graph confirmation authorizes destruction/restart, not merely drafting. Never treat a draft as user-approved product intent.",
			"After begin returns an editToken, edit ONLY plan-graph Markdown: README index, CONTEXT, and numbered plan files. All IDs, dependencies, shared context, additions/removals, and previously integrated plans may change. Revise only the Markdown that needs to change; do not rewrite unrelated completed plans merely to restart them. Herder computes retained completed plans and the changed-plan/downstream invalidation closure; authored status alone never proves completion. Use read/grep/find for inspection and write/edit for Markdown. For graph file removal/rename only, literal rm -- <path> or mv -- <old-path> <new-path> is allowed; no other shell commands. Never edit source code, Git refs, runtime files, SQLite, or worker worktrees. Do not run source setup, dependency installation, tests, builds, or other execution commands during graph planning; record verification commands in Markdown for future workers.",
			"Before shape/validate, cold-read the complete affected plan snapshots via herder_plan snapshot (collect every page), plus the README and shared context, as a fresh worker would. Check source facts by read-only inspection, standalone clarity, cross-plan dependencies, A/V/T sufficiency, acceptance evidence, and product/execution boundaries; record not-run evidence honestly and repair omissions in Markdown only. Run herder_plan shape and validate on the entire graph, then call finish_edit with that editToken. The host binds final approval to the exact request, run, graph, original checkout and base. Confirmation shows retained completed plans, plans to rerun, and removed plans. Whole-graph editing does not mean whole-graph recomputation: unchanged completed work outside the affected dependency closure is retained with its existing evidence. Changed plans and their downstream dependents rerun; unfinished execution surfaces restart rather than inheriting unreviewed work. Shared-context changes may affect every plan. Herder removes invalidated contributions through checked reversal on integration, preserving retained history, and requires fresh final verification. Conflicts or changed ownership keep the run blocked; never silently expand invalidation. No source checkout reset.",
			"A dismissed confirmation leaves the proposal recoverable with workers stopped; it is neither abandonment nor permission for an unchanged retry. Continue refining the proposal. Only an explicit user choice of abandon_run may stop/discard the entire unmerged execution without restart, preserving plan Markdown and the user's checkout; the host separately confirms abandonment.",
			"Final RUN attention and exact-tree final integration repair/verification remain separate existing mechanisms; this flow does not waive their trust gates or budgets.",
			...(revision?.request.requestId === request.requestId ? [`EXISTING_EDIT_TOKEN: ${revision.editToken}`, `REVISION_STATE: ${revision.state}`, "Continue this durable revision; do not open a new request or reset manually."] : []),
		].join("\n\n");
	}
	if (request.kind === "plan_recovery") {
		const recovery = request.recovery;
		const exhausted = request.round === MAX_PLAN_ROUNDS;
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
			`BRANCH: ${recovery.branch}`,
			`FROZEN_HEAD: ${recovery.worktreeHead ?? "none"}`,
			`FROZEN_TREE: ${recovery.worktreeTree ?? "none"}`,
			"CHANGED_PATHS:",
			list(recovery.changedPaths),
			...(exhausted ? [
				"EXHAUSTED_PLAN_DECISION: Present a concise summary of implemented work, unmet requirements and impact, passed/failed checks, prior attempts, and a recommendation. Keep evidence links and the exact frozen target visible; do not dump worker transcripts or silently restart the loop.",
				"ALLOWED_OPERATIONS: defer, accept, revise, stop",
				"For acceptance, first obtain the user's explicit choice of accepted gaps or waived requirements. Submit action \"accept\", answer containing those exact gaps, and a non-empty rationale; the host separately asks for user confirmation. Never submit a confirmed flag yourself. Only the exact clean, independently reviewed frozen tree can be accepted; dirty, unreviewed, or active-rebase work cannot. Failed checks remain failed, and final run verification is not waived.",
				"For stop, submit action \"stop\" with a non-empty rationale; the branch, worktree, and artifacts are preserved without integration or another worker attempt.",
				"A revision starts a new three-round generation; prior evidence is carried forward as history, not as authority over revised requirements. A revision may discard the current execution, so explain that consequence and confirm the plan change before submitting it.",
			] : ["ALLOWED_OPERATIONS: defer, unchanged_retry, revise, reject"]),
			"For defer, submit the request unchanged with action \"defer\" and do not edit files.",
			...(!exhausted ? ["For unchanged retry, preserve the target plan content, record a non-empty rationale, and submit action \"unchanged_retry\"."] : []),
			"For a replacement, edit only the confirmed target plan content, run shape and validate, then submit action \"revise\" with a non-empty rationale.",
			...(!exhausted ? ["For a rejected recovery, submit action \"reject\" with a non-empty rationale."] : []),
			"Submit every recovery decision with herder_plan operation \"attention\", planDirectory and requestId from the evidence above, and one allowed action. The adapter supplies immutable request and recovery Git evidence.",
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
			'After the user answers, call herder_plan exactly once with operation "attention", planDirectory and requestId from the evidence above, and the exact nonempty answer text. Default to action "answer": it durably records the answer and resolves this request, but leaves the plan BLOCKED (final RUN paused), never scheduling its worker. Manual intervention is still needed; /herder-resume does not unblock a recorded-only answer.',
			'Use action "answer_and_resume" only for an explicit user clarification within existing scope that makes the current immutable assignment runnable; it resumes the recorded role/phase at the same round. Upstream, scope, acceptance, or dependency revisions are not clarifications. If unresolved or a revision is needed, use record-only "answer"; never use "retry" for user_decision or infer permission from prose.',
			'Manual recovery must be explicitly user-invoked: /herder-rework can rewrite a blocked non-integrated target, not final RUN or a target with active/integrated downstream consumers. /herder-revise adopts validated graph changes after workers settle but cannot change already-started plans. Neither permits editing integrated upstream plans. When those guards cannot express the change, ask the user to stop, replan standalone, and start a fresh run from a trusted base. Do not invoke recovery automatically.',
			'The adapter supplies immutable request evidence. Do not use an unbound user_input event. Do not edit source, plans, Git state, SQLite, or run-control state.',
		].join("\n");
	}

	return [
		"HERDER_MAIN_SESSION_OPERATOR_ATTENTION_V1",
		"Present this bounded operator choice without rewriting the plan: retry the recorded role, or stop/cancel it. Do not reinterpret transport/provider/environment/invocation evidence as a code or plan failure and do not edit any file.",
		...(request.cause === "verification_environment" ? ["ENVIRONMENT_BOUNDARY: This worker self-report is not an evidence-complete review, approval, waiver, or permission to install dependencies or edit source/plans. Present the exact manager/command/cwd/error and required prerequisite. Only an explicit user retry resumes the recorded role/mode at the same round; no automatic retry or round charge."] : []),
		...(request.cause === "review_budget_exhausted" ? ["REVIEW_BUDGET_BOUNDARY: The host ended an incomplete review at its action budget. Partial output, even APPROVE, is non-authoritative diagnostic evidence: not a completed review, code defect, environment failure, approval, waiver, or Reignite authority. Preserve prior findings and repair guidance. Only an explicit user retry starts a fresh action budget for the same Reviewer mode/round/review pass; otherwise cancel or defer. Never automatically retry, repair code, revise plans, or accept incomplete work."] : []),
		`DETAIL: ${question}`,
		`RECOMMENDED_ACTION: ${request.recommendedAction ?? "none"}`,
		binding,
		"The user may defer. After a choice, call herder_plan exactly once with operation \"attention\", planDirectory and requestId from the evidence above, action \"retry\" for the recorded role or \"cancel\" to stop. Use action \"defer\" only when no decision is made; the adapter supplies immutable request evidence.",
	].join("\n");
}
