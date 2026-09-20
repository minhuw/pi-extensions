import type { RoundProgress } from "../src/shared/protocol.ts";

export const HERDER_ROUND_PROGRESS_MESSAGE = "herder-round-progress-v1";

export function roundProgressKey(progress: RoundProgress): string {
	return JSON.stringify([progress.runId, progress.planId, progress.generation, progress.round, progress.reportId]);
}

export function renderRoundProgress(progress: RoundProgress): string {
	const compact = (text: string) => text.replace(/\s+/g, " ").trim();
	const roles = (["implementer", "reviewer", "judge"] as const).flatMap(role => {
		const evidence = progress[role];
		return evidence ? [`${role}: ${compact(evidence.summary)} (${evidence.outcome}${evidence.interrupted ? ", interrupted" : ""})`] : [];
	});
	const concise = (items: string[]) => {
		const line = items.map(compact).join("; ");
		return line.length > 480 ? `${line.slice(0, 479)}…` : line;
	};
	const checks = [progress.implementer, progress.reviewer, progress.judge].flatMap(role => role?.checks ?? []);
	return [
		`Herder · ${progress.planId} · generation ${progress.generation} · round ${progress.round}`,
		`done: ${concise(roles) || "none recorded"}`,
		`checks: ${concise(checks) || "none recorded"}`,
		`fixNext: ${concise(progress.fixNext) || "none"}`,
		`notIntendedToFix: ${concise(progress.notIntendedToFix) || "none"}`,
		`outcome: ${concise([progress.outcome])}`,
	].join("\n");
}
