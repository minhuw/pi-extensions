import {
	formatSize,
	keyHint,
	truncateHead,
	type ExtensionAPI,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { parseWorkerResult, type ManagerAction, type TerminalEvent, type UsageEvidence, type WorkerResult } from "../src/shared/protocol.ts";
import { recommendedNextOperation } from "./round-progress.ts";

export const HERDER_WORKER_INPUT_ENTRY = "herder-worker-input-v1";
export const HERDER_WORKER_OUTPUT_ENTRY = "herder-worker-output-v1";

const TRANSCRIPT_MAX_LINES = 400;
const TRANSCRIPT_MAX_BYTES = 16 * 1024;
const ERROR_MAX_LINES = 100;
const ERROR_MAX_BYTES = 4 * 1024;
const COLLAPSED_LINES = 5;

export interface HerderWorkerTranscriptContext {
	version: 1;
	actionId: string;
	handle: string;
	runId: string;
	planId: string;
	round: number;
	role: ManagerAction["role"];
	workerMode: ManagerAction["workerMode"];
	taskName: string;
	model: string;
	effort: string;
	serviceTier?: string;
	worktree: string;
	assignmentPath: string;
	startedAt: number;
}

export interface HerderWorkerInputEntry extends HerderWorkerTranscriptContext {
	prompt: string;
}

interface WorkerPresentation {
	kind: WorkerResult["kind"];
	outcome: string;
	summary: string;
	stopReason?: string;
	question?: string;
}

export interface HerderWorkerOutputEntry extends HerderWorkerTranscriptContext {
	completedAt: number;
	durationMs: number;
	status: "returned" | "interrupted";
	failureKind?: TerminalEvent["failureKind"];
	response?: string;
	/** Parsed from the original response before transcript clipping; not manager acceptance. */
	presentation?: WorkerPresentation;
	error?: string;
	usage: Partial<UsageEvidence>;
}

function boundedTranscript(
	value: string,
	maxLines = TRANSCRIPT_MAX_LINES,
	maxBytes = TRANSCRIPT_MAX_BYTES,
): string {
	if (!value) return "";
	const result = truncateHead(value, { maxLines, maxBytes });
	if (!result.truncated) return value;
	const marker = `[Herder transcript truncated to ${result.outputLines}/${result.totalLines} lines and ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}. Full evidence remains in the Herder runtime.]`;
	return result.content ? `${result.content}\n\n${marker}` : marker;
}

function workerPresentation(role: ManagerAction["role"], response: string): WorkerPresentation | undefined {
	try {
		const result = parseWorkerResult(role, response);
		return {
			kind: result.kind,
			outcome: result.kind === "implementer" ? result.status : result.kind === "reviewer" ? result.verdict : result.decision,
			summary: boundedTranscript(result.kind === "implementer" ? result.notes : result.kind === "judge" && result.rationale === result.question ? "" : result.rationale, 40, 4 * 1024),
			// Keep the decision-bearing fields intact; only incidental summaries/raw previews are clipped.
			...(result.kind === "implementer" && result.stoppedBecause ? { stopReason: result.stoppedBecause } : {}),
			...(result.kind === "judge" && result.question ? { question: result.question } : {}),
		};
	} catch {
		return undefined;
	}
}

function isTruncated(value: string | undefined): boolean {
	return Boolean(value?.includes("[Herder transcript truncated to "));
}

export function createWorkerTranscriptContext(
	action: ManagerAction,
	handle: string,
	startedAt = Date.now(),
): HerderWorkerTranscriptContext {
	return {
		version: 1,
		actionId: action.actionId,
		handle,
		runId: action.runId,
		planId: action.planId,
		round: action.round,
		role: action.role,
		workerMode: action.workerMode,
		taskName: action.taskName,
		model: action.model,
		effort: action.effort,
		...(action.serviceTier ? { serviceTier: action.serviceTier } : {}),
		worktree: action.worktree,
		assignmentPath: action.assignmentPath,
		startedAt,
	};
}

export function createWorkerInputEntry(
	action: ManagerAction,
	handle: string,
	startedAt = Date.now(),
): HerderWorkerInputEntry {
	return {
		...createWorkerTranscriptContext(action, handle, startedAt),
		prompt: boundedTranscript(action.prompt),
	};
}

export function createWorkerOutputEntry(
	context: HerderWorkerTranscriptContext,
	terminal: TerminalEvent,
	completedAt = Date.now(),
): HerderWorkerOutputEntry {
	return {
		...context,
		completedAt,
		durationMs: Math.max(0, completedAt - context.startedAt),
		status: terminal.interrupted ? "interrupted" : "returned",
		...(terminal.failureKind ? { failureKind: terminal.failureKind } : {}),
		...(terminal.response ? { response: boundedTranscript(terminal.response), presentation: workerPresentation(context.role, terminal.response) } : {}),
		...(terminal.error ? { error: boundedTranscript(terminal.error, ERROR_MAX_LINES, ERROR_MAX_BYTES) } : {}),
		usage: terminal.usage ?? {},
	};
}

function roleLabel(role: ManagerAction["role"]): string {
	const label = role.replace(/^plan-/, "");
	return label.charAt(0).toUpperCase() + label.slice(1);
}

function modelLabel(model: string): string {
	return model
		.replace(/^gpt-/i, "GPT-")
		.replace(/^deepseek-/i, "DeepSeek-")
		.replace(/^kimi-/i, "Kimi-")
		.replace(/^grok-/i, "Grok-")
		.replace(/^claude-/i, "Claude-")
		.replace(/^gemini-/i, "Gemini-");
}

function serviceTierLabel(serviceTier: string | undefined): string {
	if (!serviceTier) return "Standard";
	return serviceTier.charAt(0).toUpperCase() + serviceTier.slice(1).toLowerCase();
}

function workerIdentity(entry: HerderWorkerTranscriptContext): string {
	return [
		`Plan ${entry.planId}`,
		modelLabel(entry.model),
		entry.effort.toUpperCase(),
		serviceTierLabel(entry.serviceTier),
	].join(" · ");
}

function formatDuration(durationMs: number): string {
	const seconds = Math.max(0, Math.round(durationMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatTokens(usage: Partial<UsageEvidence>): string | undefined {
	const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
	const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
	const total = input + output;
	if (total <= 0) return undefined;
	if (total < 1_000) return `${total} tokens`;
	if (total < 1_000_000) return `${(total / 1_000).toFixed(total < 100_000 ? 1 : 0)}k tokens`;
	return `${(total / 1_000_000).toFixed(1)}m tokens`;
}

function themedLines(
	value: string,
	expanded: boolean,
	theme: Theme,
	expandHint: string,
	color: ThemeColor = "dim",
): string[] {
	const lines = value.split("\n");
	const visible = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
	const rendered = visible.map((line, index) => theme.fg(color, `  ${index === 0 ? "⎿  " : "   "}${line}`));
	if (!expanded && lines.length > visible.length) {
		rendered.push(theme.fg("muted", `     … ${lines.length - visible.length} more lines (${expandHint})`));
	}
	return rendered;
}

export function workerInputDisplay(
	entry: HerderWorkerInputEntry,
	expanded: boolean,
	theme: Theme,
	expandHint = "ctrl+o to expand",
): string {
	const title = `▸ ${theme.fg("toolTitle", theme.bold(`Herder ${roleLabel(entry.role)}`))}`;
	const identity = theme.fg("muted", workerIdentity(entry));
	const lines = [
		`${title}  ${identity}`,
		theme.fg("dim", `  round ${entry.round} · ${entry.workerMode} · ${entry.taskName}`),
		...themedLines(entry.prompt || "No worker prompt recorded.", expanded, theme, expandHint),
	];
	if (expanded) {
		lines.push(theme.fg("muted", `  worktree: ${entry.worktree}`));
		lines.push(theme.fg("muted", `  assignment: ${entry.assignmentPath}`));
		lines.push(theme.fg("muted", `  handle: ${entry.handle}`));
	}
	return lines.join("\n");
}

export function workerOutputDisplay(
	entry: HerderWorkerOutputEntry,
	expanded: boolean,
	theme: Theme,
	expandHint = "ctrl+o to expand",
): string {
	const interrupted = entry.status === "interrupted";
	const transportFailed = interrupted || Boolean(entry.error || entry.failureKind);
	const responseTruncated = isTruncated(entry.response);
	// Legacy clipped prefixes cannot establish an outcome even if they still parse.
	const report = transportFailed ? undefined : entry.presentation ?? (!responseTruncated && entry.response ? workerPresentation(entry.role, entry.response) : undefined);
	const reportedOutcome = report?.outcome;
	const incomplete = responseTruncated || [report?.summary, report?.stopReason, report?.question].some(isTruncated);
	const warning = transportFailed || !report || ["FAILED", "STOPPED", "BLOCK", "BLOCKED", "NEEDS_INPUT"].includes(reportedOutcome ?? "UNKNOWN");
	const icon = theme.fg(transportFailed ? "error" : warning ? "warning" : "muted", transportFailed ? "✗" : warning ? "!" : "•");
	const state = interrupted ? "interrupted" : (entry.error || entry.failureKind) ? "returned with transport error" : "returned";
	const stats = [formatTokens(entry.usage), formatDuration(entry.durationMs)].filter((value): value is string => Boolean(value)).join(" · ");
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(`Herder ${roleLabel(entry.role)}`))}  ${theme.fg("muted", workerIdentity(entry))}`;
	const outcome = [`round ${entry.round}`, state, ...(stats ? [stats] : [])].join(" · ");
	const lines = [header, theme.fg("dim", `  ${outcome}`)];
	if (entry.failureKind) lines.push(theme.fg("error", `  Failure: ${entry.failureKind}`));
	if (entry.error) lines.push(...themedLines(`ERROR: ${entry.error}`, expanded, theme, expandHint, "error"));
	if (report) {
		const field = report.kind === "implementer" ? "STATUS" : report.kind === "reviewer" ? "VERDICT" : "DECISION";
		lines.push(theme.fg(warning ? "warning" : "muted", `  Worker-reported ${field}: ${reportedOutcome} (report only; not manager acceptance)`));
		if (report.stopReason) lines.push(theme.fg("warning", `  Reason: ${report.stopReason}`));
		if (report.question) lines.push(theme.fg("warning", `  Question: ${report.question}`));
		const notes = report.summary === report.question ? "" : report.summary;
		if (notes) lines.push(theme.fg("dim", `  ${report.kind === "implementer" ? "Recorded work" : "Reason"}: ${notes}`));
	} else {
		lines.push(theme.fg("warning", `  Outcome: UNKNOWN — ${transportFailed ? "transport failed; any reported outcome is unconfirmed" : responseTruncated ? "incomplete legacy transcript; no full worker report retained" : "no parseable worker report"}.`));
	}
	if (incomplete) {
		lines.push(theme.fg("warning", "  Evidence truncated: expansion is also bounded. Full evidence remains in the Herder runtime."));
		lines.push(theme.fg("muted", `  action: ${entry.actionId} · handle: ${entry.handle}`));
	}
	lines.push(theme.fg("muted", `  Recommended next operation: ${recommendedNextOperation(report?.kind ?? "", transportFailed ? "STOPPED" : reportedOutcome ?? "UNKNOWN")}`));
	if (expanded) {
		lines.push(...themedLines(entry.response || "No worker response recorded.", true, theme, expandHint));
	} else if (report || transportFailed || responseTruncated) {
		if (entry.response) lines.push(theme.fg("muted", `  ${responseTruncated ? "Bounded" : "Original"} worker response (${expandHint})`));
	} else {
		lines.push(...themedLines(entry.response || "No worker response recorded.", false, theme, expandHint));
	}
	if (expanded) {
		lines.push(theme.fg("muted", `  action: ${entry.actionId}`));
		lines.push(theme.fg("muted", `  handle: ${entry.handle}`));
	}
	return lines.join("\n");
}

export function registerWorkerTranscriptRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<HerderWorkerInputEntry>(HERDER_WORKER_INPUT_ENTRY, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return new Text(theme.fg("warning", "Herder worker input unavailable"), 0, 0);
		const box = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
		box.addChild(new Text(workerInputDisplay(data, expanded, theme, keyHint("app.tools.expand", "to expand")), 0, 0));
		return box;
	});

	pi.registerEntryRenderer<HerderWorkerOutputEntry>(HERDER_WORKER_OUTPUT_ENTRY, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return new Text(theme.fg("warning", "Herder worker output unavailable"), 0, 0);
		const background = data.status === "interrupted" || data.error || data.failureKind ? "toolErrorBg" : "customMessageBg";
		const box = new Box(1, 1, (text) => theme.bg(background, text));
		box.addChild(new Text(workerOutputDisplay(data, expanded, theme, keyHint("app.tools.expand", "to expand")), 0, 0));
		return box;
	});
}
