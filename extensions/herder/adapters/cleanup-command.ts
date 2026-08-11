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

function removedIds(result: CleanupPreview | CleanupApplyResult): string[] {
	return result.outcomes.flatMap((outcome) => outcome.result.removed
		.map((item) => itemPlanId(item, outcome.planId))
		.filter((value): value is string => Boolean(value)));
}

function skippedIds(result: CleanupPreview | CleanupApplyResult): string[] {
	return [
		...result.skippedPlanIds,
		...result.outcomes.flatMap((outcome) => outcome.result.skipped.flatMap((item) => {
			const plan = itemPlanId(item, outcome.planId);
			const reason = itemReason(item);
			return plan ? [reason ? `${plan}:${reason}` : plan] : [];
		})),
	];
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
	const entry = createCleanupTranscriptEntry({
		mode: modeFor(request),
		preview: transcriptPreview(preview, input.cancelled === true),
		executed: Boolean(input.applied?.executed),
		removed: removedIds(result),
		skipped: skippedIds(result),
		blockers: [...preview.blockers, ...(input.blockers ?? [])],
	});
	try { dependencies.appendEntry(entry); } catch { /* Transcript evidence is best effort. */ }
}

function statusCounts(preview: CleanupPreview): { eligible: number; skipped: number; blockers: number } {
	return {
		eligible: preview.outcomes.reduce((total, outcome) => total + outcome.result.actions.length, 0),
		skipped: preview.skippedPlanIds.length + preview.outcomes.reduce((total, outcome) => total + outcome.result.skipped.length, 0),
		blockers: preview.blockers.length,
	};
}

export function formatCleanupPreview(preview: CleanupPreview): string {
	const counts = statusCounts(preview);
	const selected = preview.selectedPlanIds.length ? preview.selectedPlanIds.join(", ") : "none";
	const failed = preview.failedPlanIds.length ? ` · failed evidence: ${preview.failedPlanIds.join(", ")}` : "";
	const skipped = skippedIds(preview);
	const skippedText = skipped.length ? skipped.join(", ") : "none";
	const blockers = preview.blockers.length ? preview.blockers.join(", ") : "none";
	const state = preview.terminal ? "terminal" : `preview-only (${preview.durableStatus})`;
	return `Cleanup preview · ${state} · selected: ${selected}${failed} · eligible actions: ${counts.eligible} · skipped: ${skippedText} · blockers: ${blockers}.`;
}

export function formatCleanupApplied(preview: CleanupPreview, applied: CleanupApplyResult): string {
	const removed = removedIds(applied);
	const skipped = skippedIds(applied);
	return `Cleanup executed · removed: ${removed.length ? removed.join(", ") : "none"} · skipped: ${skipped.length ? skipped.join(", ") : "none"} · blockers: ${applied.blockers.length ? applied.blockers.join(", ") : "none"}.`;
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
	};
	const orchestrator = createCleanupOrchestrator(context);
	const preview = await orchestrator.preview(request);
	if (!preview.canApply) {
		appendTranscript(request, preview, context);
		return { message: formatCleanupPreview(preview), preview, cancelled: false };
	}

	const confirm = context.confirm ?? (async () => false);
	if (!(await confirm("Clean up completed Herder plans?", formatCleanupPreview(preview)))) {
		appendTranscript(request, preview, context, { cancelled: true });
		return { message: "Cleanup cancelled; no Git mutation was applied.", preview, cancelled: true };
	}
	if (preview.failedPlanIds.length > 0
		&& !(await confirm("Remove failed Herder evidence?", `This second confirmation removes only BLOCKED/REJECTED evidence: ${preview.failedPlanIds.join(", ")}.`))) {
		appendTranscript(request, preview, context, { cancelled: true });
		return { message: "Cleanup cancelled; failed evidence was preserved.", preview, cancelled: true };
	}

	try {
		const applied = await orchestrator.apply(request, preview);
		appendTranscript(request, preview, context, { applied });
		return { message: formatCleanupApplied(preview, applied), preview, applied, cancelled: false };
	} catch (error) {
		appendTranscript(request, preview, context, { blockers: ["apply-failed"] });
		throw error;
	}
}

export const executeCleanupCommand = runCleanupCommand;
export const orchestrateCleanupCommand = runCleanupCommand;
