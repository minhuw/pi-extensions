import {
	formatSize,
	keyHint,
	truncateHead,
	type ExtensionAPI,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ManagerAction, TerminalEvent, UsageEvidence } from "../src/shared/protocol.ts";

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

export interface HerderWorkerOutputEntry extends HerderWorkerTranscriptContext {
	completedAt: number;
	durationMs: number;
	status: "returned" | "interrupted";
	response?: string;
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
		...(terminal.response ? { response: boundedTranscript(terminal.response) } : {}),
		...(terminal.error ? { error: boundedTranscript(terminal.error, ERROR_MAX_LINES, ERROR_MAX_BYTES) } : {}),
		usage: terminal.usage ?? {},
	};
}

function roleLabel(role: ManagerAction["role"]): string {
	const label = role.replace(/^plan-/, "");
	return label.charAt(0).toUpperCase() + label.slice(1);
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
	const identity = theme.fg("muted", `Plan ${entry.planId} · round ${entry.round} · ${entry.workerMode}`);
	const invocation = [entry.taskName, entry.model, `thinking: ${entry.effort}`, entry.serviceTier ? `tier: ${entry.serviceTier}` : undefined]
		.filter((value): value is string => Boolean(value))
		.join(" · ");
	const lines = [
		`${title}  ${identity}`,
		theme.fg("dim", `  ${invocation}`),
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
	const icon = interrupted ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const state = interrupted ? "interrupted" : "returned";
	const stats = [formatTokens(entry.usage), formatDuration(entry.durationMs)].filter((value): value is string => Boolean(value)).join(" · ");
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(`Herder ${roleLabel(entry.role)}`))}  ${theme.fg("muted", `Plan ${entry.planId} · round ${entry.round} · ${state}`)}`;
	const body = entry.response || entry.error || "No worker response recorded.";
	const lines = [header, ...(stats ? [theme.fg("dim", `  ${stats}`)] : []), ...themedLines(body, expanded, theme, expandHint)];
	if (entry.error && entry.response) lines.push(...themedLines(`ERROR: ${entry.error}`, expanded, theme, expandHint, "error"));
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
		const background = data.status === "interrupted" ? "toolErrorBg" : "toolSuccessBg";
		const box = new Box(1, 1, (text) => theme.bg(background, text));
		box.addChild(new Text(workerOutputDisplay(data, expanded, theme, keyHint("app.tools.expand", "to expand")), 0, 0));
		return box;
	});
}
