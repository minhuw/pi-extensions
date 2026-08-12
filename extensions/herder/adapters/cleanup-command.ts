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
	if (request.deep) return "deep";
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
		const refs = item.destruction[field];
		return refs.map((ref) => safeRefLabel(ref as unknown as Record<string, unknown>)).filter((value): value is string => Boolean(value));
	});
	return [...new Set(values)];
}

function destructionDetails(result: CleanupPreview | CleanupApplyResult) {
	const items = resultItems(result).map((item) => item.destruction);
	return {
		requested: items.some((item) => item.requested),
		eligible: items.every((item) => !item.requested || item.eligible),
		removed: items.some((item) => item.integrationRemoved),
	};
}

function integrationState(result: CleanupPreview | CleanupApplyResult): CleanupTranscriptIntegration {
	const destruction = destructionDetails(result);
	if (destruction.removed) return "removed";
	if (destruction.requested && !destruction.eligible) return "blocked";
	if (resultItems(result).some((item) => Boolean(item.preserved.integrationBranch || item.preserved.integrationWorktree))) return "preserved";
	return "unknown";
}

function modeLabel(preview: CleanupPreview): string {
	return destructionDetails(preview).requested ? "deep" : "cleanup";
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
	const handoff = destructionDetails(result);
	const entry = createCleanupTranscriptEntry({
		mode: modeFor(request),
		deep: Boolean(request.deep),
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

function deepSummary(preview: CleanupPreview): string {
		const details = destructionDetails(preview);
		return details.eligible ? "eligible" : "blocked";
}

export function formatCleanupPreview(preview: CleanupPreview): string {
	const counts = statusCounts(preview);
	const selected = preview.selectedPlanIds.length ? preview.selectedPlanIds.join(", ") : "none";
	const failed = preview.failedPlanIds.length ? ` · failed evidence: ${preview.failedPlanIds.join(", ")}` : "";
	const skipped = skippedIds(preview);
	const skippedText = skipped.length ? skipped.join(", ") : "none";
	const blockers = preview.blockers.length ? preview.blockers.join(", ") : "none";
	const state = preview.terminal ? "terminal" : `preview-only (${preview.durableStatus})`;
	if (modeLabel(preview) !== "deep") {
		return `Cleanup preview · ${state} · selected: ${selected}${failed} · eligible actions: ${counts.eligible} · skipped: ${skippedText} · blockers: ${blockers}.`;
	}
	const branches = branchLabels(preview);
	const refs = refLabels(preview, "refsPlanned");
	return `Cleanup preview · ${state} · mode: deep · selected: ${selected}${failed} · branches: ${branches.length ? branches.join(", ") : "none"} · eligible actions: ${counts.eligible} · deep cleanup: ${deepSummary(preview)} · refs planned: ${refs.length ? refs.join(", ") : "none"} · integration: removed only by deep cleanup · skipped: ${skippedText} · blockers: ${blockers}.`;
}

export function formatCleanupApplied(preview: CleanupPreview, applied: CleanupApplyResult): string {
	const removed = removedIds(applied);
	const skipped = skippedIds(applied);
	if (modeLabel(preview) !== "deep") {
		return `Cleanup executed · removed: ${removed.length ? removed.join(", ") : "none"} · skipped: ${skipped.length ? skipped.join(", ") : "none"} · blockers: ${applied.blockers.length ? applied.blockers.join(", ") : "none"}.`;
	}
	const refs = refLabels(applied, "refsRemoved");
	const handoff = destructionDetails(applied);
	const integration = integrationState(applied);
	return `Deep cleanup executed · removed: ${removed.length ? removed.join(", ") : "none"} · refs removed: ${refs.length ? refs.join(", ") : "none"} · integration: ${integration} · plan directory: ${handoff.removed ? "removed" : "preserved"} · skipped: ${skipped.length ? skipped.join(", ") : "none"} · blockers: ${applied.blockers.length ? applied.blockers.join(", ") : "none"}.`;
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
		deep: Boolean(parsed.deep),
	};
	const orchestrator = createCleanupOrchestrator(context);
	const preview = await orchestrator.preview(request);
	if (!preview.canApply) {
		appendTranscript(request, preview, context);
		return { message: formatCleanupPreview(preview), preview, cancelled: false };
	}

	const confirm = context.confirm ?? (async () => false);
	const confirmationTitle = request.deep ? "Deep-clean Herder plan set?" : "Clean up completed Herder plans?";
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
