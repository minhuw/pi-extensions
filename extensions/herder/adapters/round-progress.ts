import { compactLine } from "./attention.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ManagerReply, RoundProgress } from "../src/shared/protocol.ts";

export const HERDER_ROUND_PROGRESS_MESSAGE = "herder-round-progress-v1";

export function roundProgressKey(progress: RoundProgress): string {
	return JSON.stringify([progress.runId, progress.planId, progress.generation, progress.round, progress.reportId]);
}

/** Stage advice only: historical worker evidence cannot establish current scheduling. */
export function recommendedNextOperation(role: string, outcome: string): string {
	if (role === "reviewer" && ["APPROVE", "REVISE", "BLOCK"].includes(outcome)) return "Use /herder-status to check manager-owned Judge adjudication; Reviewer verdict is not plan approval.";
	if (["FAILED", "STOPPED", "BLOCKED", "NEEDS_INPUT"].includes(outcome)) return "Use /herder-status. Inspect the stopped reason and current manager status/attention before any retry.";
	if (role === "implementer" && outcome === "COMPLETE") return "Use /herder-status to inspect current manager progress; Implementer COMPLETE does not establish plan completion or a next dispatch.";
	if (role === "judge" && outcome === "REPAIR") return "Use /herder-status to inspect manager-owned authorized repair and current scheduling.";
	if (role === "judge" && outcome === "DONE") return "Use /herder-status to inspect integration/final verification evidence; Judge DONE is not run completion.";
	return "Use /herder-status. Inspect preserved evidence and current manager status/attention; no completed role outcome is established.";
}

export function renderRoundProgress(
	progress: RoundProgress,
	reply?: Pick<ManagerReply, "runId" | "status" | "message" | "active" | "actions" | "attention" | "scheduler">,
	expanded = false,
): string {
	if (!expanded) {
		const role = (["implementer", "reviewer", "judge"] as const).find(role => progress[role]?.actionId === progress.reportId);
		const evidence = role ? progress[role] : undefined;
		const reason = compactLine(evidence?.stoppedBecause || evidence?.summary);
		return `Herder · ${progress.planId} · round ${progress.round} · ${role ?? "worker"} reported ${evidence?.outcome ?? progress.outcome}${reason ? ` — ${reason}` : ""}`;
	}
	const compact = (text: string) => text.replace(/\s+/g, " ").trim();
	const lines = [
		`Herder · ${progress.planId} · generation ${progress.generation} · round ${progress.round} · Attempt result (not plan completion)`,
		`Outcome: ${progress.outcome} · Scheduling is manager-owned`,
	];
	const snapshot = reply?.runId === progress.runId ? reply : undefined;
	if (snapshot) lines.push(`Run at report (historical manager snapshot): ${snapshot.status} — ${snapshot.message}`);
	let latestRole = "";
	for (const role of ["implementer", "reviewer", "judge"] as const) {
		const evidence = progress[role];
		if (!evidence) continue;
		if (evidence.actionId === progress.reportId) latestRole = role;
		lines.push(`${role} · Outcome: ${evidence.outcome}${evidence.interrupted ? " (interrupted)" : ""}`);
		if (evidence.stoppedBecause) lines.push(`  Reason: ${compact(evidence.stoppedBecause)}`);
		const summaryLabel = role === "implementer" && (evidence.stoppedBecause || !["FAILED", "STOPPED"].includes(evidence.outcome)) ? "Recorded work" : "Reason";
		lines.push(`  ${summaryLabel}: ${compact(evidence.summary)}`);
		if (evidence.commits !== undefined) lines.push(`  Retained commits (worker-reported): ${evidence.commits.join(", ") || "none recorded"}`);
	}
	// Keep all role reasons ahead of potentially long check lists.
	for (const role of ["implementer", "reviewer", "judge"] as const) {
		const evidence = progress[role];
		if (!evidence) continue;
		for (const [label, items] of [["setup", evidence.setup], ["checks", evidence.checks]] as const) {
			if (!items.length) {
				if (label === "checks") lines.push(`${role} · Recorded checks: none recorded`);
				continue;
			}
			lines.push(`${role} · Recorded ${label} (self-reported):\n${items.join("\n")}`);
		}
	}
	for (const contract of progress.fixNext) lines.push(`Authorized repair: ${compact(contract)}`);
	for (const exclusion of progress.notIntendedToFix) lines.push(`Excluded finding: ${compact(exclusion)}`);
	const next = snapshot?.status === "complete"
		? "Use /herder-status to review the completed run status and final evidence recorded by the manager."
		: snapshot?.attention || (snapshot && ["paused", "stopped", "failed", "needs_input"].includes(snapshot.status))
			? "Use /herder-status. Inspect current manager status/attention and its request before any retry or continuation; the snapshot may be historical."
			: recommendedNextOperation(latestRole, progress.outcome);
	lines.push(`Recommended next operation: ${next}`);
	return lines.join("\n");
}

export function registerRoundProgressRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<{ collapsed?: string }>(HERDER_ROUND_PROGRESS_MESSAGE, (message, { expanded, outputPad }, theme) => {
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const content = typeof message.content === "string" ? message.content : "Herder attempt evidence unavailable";
		// Legacy cards retain their original content on expansion; show only the latest role otherwise.
		const legacyRole = [...content.matchAll(/^(implementer|reviewer|judge) · Outcome: .+$/gm)].at(-1);
		const legacyReason = legacyRole && content.slice(legacyRole.index! + legacyRole[0].length).match(/^\s+(?:Reason|Recorded work): (.+)$/m)?.[1];
		const legacy = legacyRole
			? `${content.split("\n")[0]?.split(" · generation")[0]} · ${legacyRole[0].replace("Outcome:", "reported")}${legacyReason ? ` — ${legacyReason}` : ""}`
			: content.split("\n")[0];
		const display = expanded ? content : message.details?.collapsed ?? compactLine(legacy) ?? "Herder attempt evidence unavailable";
		box.addChild(new Text(display, 0, 0));
		return box;
	});
}
