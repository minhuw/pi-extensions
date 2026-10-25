import type { CheckResult } from "../types.ts";
import type { HistoryEvent, RunState, TaskRecord } from "./fold.ts";

const short = (sha: string | undefined) => (sha ? sha.slice(0, 12) : "—");
const cell = (text: string) => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim() || "—";
const inline = (text: string) => text.replace(/\s+/g, " ").trim();
const checksSummary = (checks: readonly CheckResult[] | undefined) => {
	if (!checks?.length) return "";
	const failed = checks.filter((check) => !check.passed).map((check) => check.id);
	return failed.length ? `; checks failed: ${failed.join(", ")}` : `; ${checks.length} check(s) passed`;
};
const sessionSummary = (sessionId: string | undefined) => (sessionId ? `; session ${sessionId}` : "");

function describe(event: HistoryEvent): string {
	switch (event.t) {
		case "script.settled": return `launch ${event.launch} ${event.status} (reused ${event.reused}, changed ${event.changed}, new ${event.new})${event.error ? `: ${inline(event.error)}` : ""}`;
		case "step.completed": return `step \`${event.key}\` ${event.status}${event.commit ? ` at ${short(event.commit)}` : ""}${checksSummary(event.checks)}${event.warning ? `; warning: ${inline(event.warning)}` : ""}${sessionSummary(event.sessionId)}`;
		case "step.failed": return `step \`${event.key}\` attempt ${event.attempt} ${event.final ? "failed" : "failed (will retry)"}: ${event.errorClass}: ${inline(event.message)}${sessionSummary(event.sessionId)}`;
		case "check.completed": return `check \`${event.checkId}\` ${event.exitCode === 0 && !event.timedOut ? "passed" : event.timedOut ? "timed out" : `failed (exit ${event.exitCode})`} at ${short(event.commit)}${event.purpose ? ` (${event.purpose})` : ""}`;
		case "integrate.completed": return `integrated ${short(event.source)}${event.task ? ` for ${event.task}` : ""} → ${short(event.head)}: ${inline(event.message)}`;
		case "integrate.failed": return `integration of ${short(event.source)}${event.task ? ` for ${event.task}` : ""} failed: ${event.reason}${event.conflicts?.length ? ` (${event.conflicts.join(", ")})` : ""}${checksSummary(event.checks)}`;
		case "verify.completed": return `verification ${event.verdict} at ${short(event.head)}${event.verifierRan ? " (verifier ran)" : ""}`;
		case "decision.recorded": return `decision: ${inline(event.question)} → ${inline(event.answer)}`;
		case "delivery.completed": return `delivered (${event.mode}) to ${event.target} at ${short(event.tip)}, ${event.commits.length} commit(s)`;
		case "run.finished": return `run ${event.status}: ${inline(event.reason)}`;
	}
}

/** Deterministic progress.md for a folded run. Prints only journaled values. */
export function renderProgress(state: RunState, tasks?: ReadonlyArray<{ id: string; text: string }>): string {
	const verification = state.verification;
	const lines = [
		`# Herder run ${state.runId ?? "—"}${state.title ? `: ${inline(state.title)}` : ""}`,
		"",
		`- Status: ${state.status}`,
		`- Verdict: ${verification ? `${verification.verdict} at ${short(verification.head)}` : "not verified"}`,
		`- Base: ${short(state.base)}`,
		`- Integration head: ${short(state.integrationHead)}`,
		`- Launches: ${state.launches.size}`,
		"",
		"## Tasks",
		"",
	];
	const rows: Array<{ id: string; text?: string; record?: TaskRecord }> = (tasks ?? []).map((task) => ({ id: task.id, text: task.text, record: state.tasks.get(task.id) }));
	for (const record of state.tasks.values()) if (!rows.some((row) => row.id === record.id)) rows.push({ id: record.id, record });
	if (rows.length) {
		lines.push("| Task | Status | Last step | Integrated commit |", "| --- | --- | --- | --- |");
		for (const { id, text, record } of rows) {
			lines.push(`| ${cell(text ? `${id} ${text}` : id)} | ${record?.status ?? "pending"} | ${cell(record?.lastStep ?? "")} | ${short(record?.integratedCommit)} |`);
		}
	} else lines.push("No tasks yet.");
	lines.push("", "## History", "");
	if (state.history.length) state.history.forEach((event, index) => lines.push(`${index + 1}. ${event.at} ${describe(event)}`));
	else lines.push("Nothing has settled yet.");
	return `${lines.join("\n")}\n`;
}
