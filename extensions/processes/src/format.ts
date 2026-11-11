import type { ProcessInfo } from "./types.ts";

/** Notifications and tool results quote at most this many trailing log lines. */
export const TAIL_LINES = 20;
const MAX_LINE_CHARS = 300;

/** "850ms", "2.1s", "34s", "5m 03s", "2h 07m". */
export function duration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const seconds = ms / 1000;
	if (seconds < 10) return `${Math.round(seconds * 10) / 10}s`;
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function isLive(process: ProcessInfo): boolean {
	return process.status === "starting" || process.status === "running" || process.status === "ready" || process.status === "stopping";
}

/** Run time so far, or until it ended. */
export function uptime(process: ProcessInfo, now = Date.now()): string {
	return duration((process.endedAt ?? now) - process.startedAt);
}

/** "code 1", "signal SIGTERM", or "" when it has not ended. */
export function exitDescription(process: ProcessInfo): string {
	if (process.signal) return `signal ${process.signal}`;
	if (process.exitCode !== undefined && process.exitCode !== null) return `code ${process.exitCode}`;
	return "";
}

/** The last `TAIL_LINES` lines, each cut to a readable length. */
export function tail(lines: string[]): string[] {
	return lines.slice(-TAIL_LINES).map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
}

/** Rows of cells as left-aligned, two-space-separated columns. */
export function table(rows: string[][]): string {
	const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
	return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n");
}

export function processTable(processes: ProcessInfo[], now = Date.now()): string {
	if (processes.length === 0) return "No processes.";
	return table([
		["NAME", "ID", "STATUS", "PID", "UPTIME", "URLS", "EXIT"],
		...processes.map((p) => [p.name, p.id, p.status, p.pid === undefined ? "-" : String(p.pid), uptime(p, now), p.urls.join(" ") || "-", exitDescription(p) || "-"]),
	]);
}

/** The last lines of `lines` as an indented block, or "" when there are none. */
export function quoteTail(lines: string[]): string {
	return tail(lines).map((line) => `  ${line}`).join("\n");
}
