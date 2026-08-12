import {
	applyHerderCleanup,
	previewHerderCleanup,
	type CleanupApplicationRequest,
	type CleanupApplyResult,
	type CleanupPreview,
} from "../src/application/tools.ts";
import {
	parseCleanupArguments,
	type CleanupCommandOptions,
} from "./arguments.ts";
import {
	createCleanupTranscriptEntry,
	type CleanupTranscriptEntry,
	type CleanupTranscriptIntegration,
	type CleanupTranscriptMode,
	type CleanupTranscriptPreview,
} from "./cleanup-transcript.ts";

export interface CleanupCommandRequest extends CleanupApplicationRequest {
	includeFailed: boolean;
}

export interface CleanupCommandOrchestrator {
	preview: (request: CleanupCommandRequest) => Promise<CleanupPreview>;
	apply: (request: CleanupCommandRequest, preview: CleanupPreview) => Promise<CleanupApplyResult>;
}

export interface CleanupCommandDependencies {
	preview?: CleanupCommandOrchestrator["preview"];
	apply?: CleanupCommandOrchestrator["apply"];
	confirm?: (title: string, message: string) => Promise<boolean>;
	appendEntry?: (entry: CleanupTranscriptEntry) => void;
}

export interface CleanupCommandResult {
	message: string;
	preview: CleanupPreview;
	applied?: CleanupApplyResult;
	cancelled: boolean;
}

function modeFor(request: CleanupCommandRequest): CleanupTranscriptMode {
	return request.includeFailed ? "include-failed" : "standard";
}

function itemPlanId(item: Record<string, unknown>, fallback?: string): string | null {
	const value = typeof item.plan === "string" ? item.plan : fallback;
	return value && /^\d{1,9}$/.test(value) ? value.padStart(3, "0") : null;
}

function itemReason(item: Record<string, unknown>): string | null {
	const value = typeof item.reason === "string" ? item.reason.toLowerCase() : null;
	return value && /^[a-z0-9][a-z0-9-]{0,48}$/.test(value) ? value : null;
}

function resultItems(result: CleanupPreview | CleanupApplyResult): CleanupPreview["outcomes"][number]["result"][] {
	return result.outcomes.map((outcome) => outcome.result);
}

function removedIds(result: CleanupPreview | CleanupApplyResult): string[] {
	return [...new Set(result.outcomes.flatMap((outcome) => outcome.result.removed
		.map((item) => itemPlanId(item, outcome.planId))
		.filter((value): value is string => Boolean(value))))];
}

function skippedIds(result: CleanupPreview | CleanupApplyResult): string[] {
	return [...new Set([
		...result.skippedPlanIds,
		...result.outcomes.flatMap((outcome) => outcome.result.skipped.flatMap((item) => {
			const plan = itemPlanId(item, outcome.planId);
			const reason = itemReason(item);
			return plan ? [reason ? `${plan}:${reason}` : plan] : [];
		})),
	])];
}

function safeRefLabel(item: Record<string, unknown>): string | null {
	const kind = typeof item.kind === "string" && /^[a-z][a-z-]{0,24}$/.test(item.kind) ? item.kind : null;
	if (!kind) return null;
	const plan = typeof item.plan === "string" && /^\d{3,9}$/.test(item.plan) ? item.plan : null;
	return plan ? `${kind}:${plan}` : kind;
}

function refLabels(result: CleanupPreview | CleanupApplyResult, field: "refsPlanned" | "refsRemoved"): string[] {
	const values = resultItems(result).flatMap((item) => {
		const refs = item.finalization[field];
		return refs.map((ref) => safeRefLabel(ref as unknown as Record<string, unknown>)).filter((value): value is string => Boolean(value));
	});
	return [...new Set(values)];
}

function handoffDetails(result: CleanupPreview | CleanupApplyResult): {
	target: string | null;
	requested: boolean;
	eligible: boolean;
	removed: boolean;
	blocked: boolean;
} {
	const handoffs = resultItems(result).map((item) => item.handoff);
	const requested = handoffs.some((handoff) => handoff.requested);
	const target = handoffs.find((handoff) => typeof handoff.targetBranch === "string")?.targetBranch ?? null;
	return {
		target,
		requested,
		eligible: requested && handoffs.every((handoff) => !handoff.requested || handoff.eligible),
		removed: handoffs.some((handoff) => handoff.removed),
		blocked: handoffs.some((handoff) => handoff.requested && handoff.blockers.length > 0),
	};
}

function integrationState(result: CleanupPreview | CleanupApplyResult): CleanupTranscriptIntegration {
	const handoff = handoffDetails(result);
	if (handoff.removed) return "removed";
	if (handoff.blocked) return "blocked";
	if (resultItems(result).some((item) => Boolean(item.preserved.integrationBranch || item.preserved.integrationWorktree))) return "preserved";
	return "unknown";
}

function modeLabel(preview: CleanupPreview): string {
	const finalize = resultItems(preview).some((item) => item.finalization.requested);
	return finalize ? "finalize" : "cleanup";
}

function transcriptPreview(result: CleanupPreview, cancelled = false): CleanupTranscriptPreview {
	if (cancelled) return "cancelled";
	if (!result.terminal) return "preview-only";
	if (!result.canApply || result.blockers.length > 0) return "blocked";
	return "eligible";
}

function appendTranscript(
	request: CleanupCommandRequest,
	preview: CleanupPreview,
	dependencies: CleanupCommandDependencies,
	input: { applied?: CleanupApplyResult; cancelled?: boolean; blockers?: string[] } = {},
): void {
	if (!dependencies.appendEntry) return;
	const result = input.applied ?? preview;
	const handoff = handoffDetails(result);
	const entry = createCleanupTranscriptEntry({
		mode: modeFor(request),
		finalize: Boolean(request.finalize),
		handoffTarget: handoff.target,
		preview: transcriptPreview(preview, input.cancelled === true),
		executed: Boolean(input.applied?.executed),
		plannedRefs: refLabels(result, "refsPlanned"),
		removedRefs: refLabels(result, "refsRemoved"),
		integration: integrationState(result),
		removed: removedIds(result),
		skipped: skippedIds(result),
		blockers: [...preview.blockers, ...(input.blockers ?? [])],
	});
	dependencies.appendEntry(entry);
}

function statusCounts(preview: CleanupPreview): { eligible: number; skipped: number; blockers: number } {
	return {
		eligible: preview.outcomes.reduce((total, outcome) => total + outcome.result.actions.length, 0),
		skipped: preview.skippedPlanIds.length + preview.outcomes.reduce((total, outcome) => total + outcome.result.skipped.length, 0),
		blockers: preview.blockers.length,
	};
}

function branchLabels(preview: CleanupPreview): string[] {
	return [...new Set(preview.outcomes.flatMap((outcome) => outcome.result.actions
		.map((item) => typeof item.branch === "string" ? item.branch : itemPlanId(item, outcome.planId))
		.filter((value): value is string => Boolean(value))))];
}

function finalizationSummary(preview: CleanupPreview): string {
	const results = resultItems(preview);
	if (!results.some((item) => item.finalization.requested)) return "not requested";
	return results.every((item) => !item.finalization.requested || item.finalization.eligible) ? "eligible" : "blocked";
}

function handoffSummary(preview: CleanupPreview): string {
	const handoff = handoffDetails(preview);
	if (!handoff.requested) return "not requested";
	if (handoff.eligible) return `${handoff.target ?? "configured"} contains integration; removal requires confirmation`;
	return `${handoff.target ?? "configured"} blocked`;
}

export function formatCleanupPreview(preview: CleanupPreview): string {
	const counts = statusCounts(preview);
	const selected = preview.selectedPlanIds.length ? preview.selectedPlanIds.join(", ") : "none";
	const failed = preview.failedPlanIds.length ? ` · failed evidence: ${preview.failedPlanIds.join(", ")}` : "";
	const skipped = skippedIds(preview);
	const skippedText = skipped.length ? skipped.join(", ") : "none";
	const blockers = preview.blockers.length ? preview.blockers.join(", ") : "none";
	const state = preview.terminal ? "terminal" : `preview-only (${preview.durableStatus})`;
	if (modeLabel(preview) !== "finalize") {
		return `Cleanup preview · ${state} · selected: ${selected}${failed} · eligible actions: ${counts.eligible} · skipped: ${skippedText} · blockers: ${blockers}.`;
	}
	const branches = branchLabels(preview);
	const refs = refLabels(preview, "refsPlanned");
	return `Cleanup preview · ${state} · mode: finalize · selected: ${selected}${failed} · branches: ${branches.length ? branches.join(", ") : "none"} · eligible actions: ${counts.eligible} · finalization: ${finalizationSummary(preview)} · refs planned: ${refs.length ? refs.join(", ") : "none"} · integration: preserved until handoff · handoff: ${handoffSummary(preview)} · skipped: ${skippedText} · blockers: ${blockers}.`;
}

export function formatCleanupApplied(preview: CleanupPreview, applied: CleanupApplyResult): string {
	const removed = removedIds(applied);
	const skipped = skippedIds(applied);
	if (modeLabel(preview) !== "finalize") {
		return `Cleanup executed · removed: ${removed.length ? removed.join(", ") : "none"} · skipped: ${skipped.length ? skipped.join(", ") : "none"} · blockers: ${applied.blockers.length ? applied.blockers.join(", ") : "none"}.`;
	}
	const refs = refLabels(applied, "refsRemoved");
	const handoff = handoffDetails(applied);
	const integration = integrationState(applied);
	return `Cleanup finalized · removed: ${removed.length ? removed.join(", ") : "none"} · refs removed: ${refs.length ? refs.join(", ") : "none"} · integration: ${integration} · handoff: ${handoff.removed ? "removed" : handoff.requested ? "preserved" : "not requested"} · skipped: ${skipped.length ? skipped.join(", ") : "none"} · blockers: ${applied.blockers.length ? applied.blockers.join(", ") : "none"}.`;
}

export function createCleanupOrchestrator(dependencies: CleanupCommandDependencies = {}): CleanupCommandOrchestrator {
	return {
		preview: dependencies.preview ?? ((request) => previewHerderCleanup(request)),
		apply: dependencies.apply ?? ((request, preview) => applyHerderCleanup(request, preview)),
	};
}

export async function runCleanupCommand(
	input: string | CleanupCommandOptions,
	context: { repositoryRoot: string; planDirectory: string } & CleanupCommandDependencies,
): Promise<CleanupCommandResult> {
	const parsed = typeof input === "string" ? parseCleanupArguments(input) : input;
	const request: CleanupCommandRequest = {
		repositoryRoot: context.repositoryRoot,
		planDirectory: context.planDirectory,
		...(parsed.planId === undefined ? {} : { planId: parsed.planId }),
		includeFailed: parsed.includeFailed,
		finalize: Boolean(parsed.finalize),
		...(parsed.handoffTarget === undefined ? {} : { handoffTarget: parsed.handoffTarget }),
	};
	const orchestrator = createCleanupOrchestrator(context);
	const preview = await orchestrator.preview(request);
	if (!preview.canApply) {
		appendTranscript(request, preview, context);
		return { message: formatCleanupPreview(preview), preview, cancelled: false };
	}

	const confirm = context.confirm ?? (async () => false);
	const confirmationTitle = request.finalize ? "Finalize Herder cleanup?" : "Clean up completed Herder plans?";
	if (!(await confirm(confirmationTitle, formatCleanupPreview(preview)))) {
		appendTranscript(request, preview, context, { cancelled: true });
		return { message: "Cleanup cancelled; no Git mutation was applied.", preview, cancelled: true };
	}
	if (preview.failedPlanIds.length > 0
		&& !(await confirm("Remove failed Herder evidence?", `This second confirmation removes only BLOCKED/REJECTED evidence: ${preview.failedPlanIds.join(", ")}.`))) {
		appendTranscript(request, preview, context, { cancelled: true });
		return { message: "Cleanup cancelled; failed evidence was preserved.", preview, cancelled: true };
	}

	let applied: CleanupApplyResult;
	try {
		applied = await orchestrator.apply(request, preview);
	} catch (error) {
		try {
			appendTranscript(request, preview, context, { blockers: ["apply-failed"] });
		} catch (transcriptError) {
			throw new AggregateError([error, transcriptError], "Cleanup apply and transcript publication both failed.");
		}
		throw error;
	}
	appendTranscript(request, preview, context, { applied });
	return { message: formatCleanupApplied(preview, applied), preview, applied, cancelled: false };
}
