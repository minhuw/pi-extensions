import type { IconName } from "../components/icons";
import type { SessionTrace, TraceChild, TraceRecord, TraceToolRecord, TraceTurn } from "../lib/types";
import { parseToolName } from "../session/tools/registry";

/** The categorical palette: every family has a `--color-k-<family>` theme token. */
export type Family = "user" | "llm" | "shell" | "read" | "write" | "other" | "agent" | "compaction";

export const FAMILIES: Family[] = ["user", "llm", "shell", "read", "write", "other", "agent", "compaction"];

export const FAMILY_LABELS: Record<Family, string> = {
	user: "Prompt",
	llm: "Model call",
	shell: "Shell",
	read: "Read & search",
	write: "Write",
	other: "Other tool",
	agent: "Subagent",
	compaction: "Compaction",
};

/** Utility classes per family; written out in full so Tailwind sees them. */
export const FAMILY_CLASSES: Record<Family, { text: string; badge: string; bar: string; rail: string; dot: string }> = {
	user: { text: "text-k-user", badge: "bg-k-user/12 text-k-user", bar: "bg-k-user", rail: "before:bg-k-user", dot: "bg-k-user" },
	llm: { text: "text-k-llm", badge: "bg-k-llm/12 text-k-llm", bar: "bg-k-llm", rail: "before:bg-k-llm", dot: "bg-k-llm" },
	shell: { text: "text-k-shell", badge: "bg-k-shell/14 text-k-shell", bar: "bg-k-shell", rail: "before:bg-k-shell", dot: "bg-k-shell" },
	read: { text: "text-k-read", badge: "bg-k-read/12 text-k-read", bar: "bg-k-read", rail: "before:bg-k-read", dot: "bg-k-read" },
	write: { text: "text-k-write", badge: "bg-k-write/12 text-k-write", bar: "bg-k-write", rail: "before:bg-k-write", dot: "bg-k-write" },
	other: { text: "text-k-other", badge: "bg-k-other/14 text-k-other", bar: "bg-k-other", rail: "before:bg-k-other", dot: "bg-k-other" },
	agent: { text: "text-k-agent", badge: "bg-k-agent/12 text-k-agent", bar: "bg-k-agent", rail: "before:bg-k-agent", dot: "bg-k-agent" },
	compaction: {
		text: "text-k-compaction",
		badge: "bg-k-compaction/16 text-k-compaction",
		bar: "bg-k-compaction",
		rail: "before:bg-k-compaction",
		dot: "bg-k-compaction",
	},
};

const SHELL = new Set(["bash", "shell", "powershell", "sh", "zsh"]);
const READ = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"glob",
	"web_fetch",
	"web_search",
	"fetch_content",
	"websearch",
	"webfetch",
	"search",
	"rg",
]);
const WRITE = new Set(["edit", "write", "apply_patch", "codemode", "multiedit", "multi_edit", "notebookedit"]);
const AGENT = new Set(["agent", "subagentworkflow", "task"]);

export function toolFamily(name: string): Family {
	const parsed = parseToolName(name);
	const base = parsed.base.toLowerCase();
	if (parsed.server === undefined) {
		if (SHELL.has(base)) return "shell";
		if (READ.has(base)) return "read";
		if (WRITE.has(base)) return "write";
		if (AGENT.has(base)) return "agent";
		return "other";
	}
	return READ.has(base) || /(^|_)(web_)?(search|fetch)(_|$)/.test(base) ? "read" : "other";
}

/** A tool record's name; the server omits one it did not record. */
export function toolName(record: TraceToolRecord): string {
	return record.name || "tool";
}

export function recordFamily(record: TraceRecord): Family {
	switch (record.kind) {
		case "llm":
			return "llm";
		case "tool":
			return toolFamily(toolName(record));
		default:
			return "compaction";
	}
}

const BADGES: Record<string, string> = {
	bash: "BASH",
	shell: "SH",
	sh: "SH",
	zsh: "SH",
	powershell: "PWSH",
	read: "READ",
	grep: "GREP",
	rg: "GREP",
	find: "FIND",
	ls: "LS",
	glob: "GLOB",
	web_fetch: "WEB",
	web_search: "WEB",
	fetch_content: "WEB",
	websearch: "WEB",
	webfetch: "WEB",
	search: "FIND",
	edit: "EDIT",
	multiedit: "EDIT",
	multi_edit: "EDIT",
	write: "WRITE",
	apply_patch: "PATCH",
	codemode: "CODE",
	notebookedit: "EDIT",
	agent: "AGENT",
	task: "AGENT",
	subagentworkflow: "FLOW",
};

/** A 2-5 letter type label: `LLM`, `BASH`, `READ`, `MCP`, … */
export function recordBadge(record: TraceRecord): string {
	if (record.kind === "llm") return "LLM";
	if (record.kind === "compaction") return "COMP";
	if (record.kind === "branch-summary") return "BRCH";
	const parsed = parseToolName(toolName(record));
	if (parsed.server !== undefined) return toolFamily(toolName(record)) === "read" ? "WEB" : "MCP";
	return BADGES[parsed.base.toLowerCase()] ?? "TOOL";
}

export function recordIcon(record: TraceRecord): IconName {
	if (record.kind === "llm") return "sparkle";
	if (record.kind === "compaction") return "compress";
	if (record.kind === "branch-summary") return "branch";
	const parsed = parseToolName(toolName(record));
	const base = parsed.base.toLowerCase();
	if (parsed.server !== undefined) return toolFamily(toolName(record)) === "read" ? "globe" : "tool";
	if (SHELL.has(base)) return "terminal";
	if (base === "read") return "file";
	if (base === "ls") return "folder";
	if (base === "grep" || base === "find" || base === "glob" || base === "rg" || base === "search") return "search";
	if (base.startsWith("web") || base === "fetch_content") return "globe";
	if (base === "codemode") return "code";
	if (base === "subagentworkflow") return "branch";
	if (AGENT.has(base)) return "agent";
	if (WRITE.has(base)) return "pencil";
	return "tool";
}

/** The record's display name: the tool, the model, or the kind. */
export function recordName(record: TraceRecord): string {
	switch (record.kind) {
		case "llm":
			return record.model ?? "model call";
		case "tool": {
			const parsed = parseToolName(toolName(record));
			return parsed.server ? `${parsed.server} · ${parsed.base}` : toolName(record);
		}
		case "compaction":
			return "Context compacted";
		case "branch-summary":
			return "Branch summary";
	}
}

/** Built-in tools whose badge already names them show no name; MCP and unknown tools do. */
export function showsToolName(record: TraceRecord): boolean {
	if (record.kind !== "tool") return false;
	return toolName(record).startsWith("mcp__") || recordBadge(record) === "TOOL";
}

/** The first short string argument, for tools without a summary of their own. */
export function firstStringArg(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	for (const value of Object.values(args as Record<string, unknown>)) if (typeof value === "string" && value.length <= 400) return value.split("\n")[0];
	return undefined;
}

/** One line describing what the record did. */
export function recordSummary(record: TraceRecord): string {
	switch (record.kind) {
		case "llm":
			if (record.error) return record.error;
			if (record.text) return record.text;
			if (record.toolCalls) return `${record.toolCalls} tool call${record.toolCalls === 1 ? "" : "s"}${record.thinking ? " after thinking" : ""}`;
			return record.thinking ? "Thinking" : "";
		case "tool":
			return record.summary ?? "";
		case "compaction":
			return record.tokensBefore ? `${record.tokensBefore.toLocaleString("en-US")} tokens summarized` : "Earlier context summarized";
		case "branch-summary":
			return "Summary of an abandoned branch";
	}
}

export function recordIsError(record: TraceRecord): boolean {
	if (record.kind === "tool") return record.isError;
	if (record.kind === "llm") return Boolean(record.error) || record.stopReason === "error" || record.stopReason === "aborted";
	return false;
}

/** Start and end in epoch ms; `end` is undefined while a tool runs, and instants have `end === start`. */
export function recordSpan(record: TraceRecord): { start: number | undefined; end: number | undefined } {
	if (record.kind === "compaction" || record.kind === "branch-summary") return { start: record.at, end: record.at };
	if (record.kind === "tool") {
		const end = record.end ?? (record.start !== undefined && record.durationMs !== undefined ? record.start + record.durationMs : undefined);
		return { start: record.start ?? record.end, end };
	}
	return { start: record.start ?? record.end, end: record.end ?? record.start };
}

/**
 * A child session's span. A child without entries yet, such as a subagent that just started, has no times of its
 * own; it runs within the tool call that spawned it, so it borrows that call's start and, once known, its end.
 */
export function childSpan(trace: Pick<SessionTrace, "records">, child: TraceChild): { start: number | undefined; end: number | undefined } {
	let start = child.startedAt;
	let end = child.lastAt;
	if (start === undefined || end === undefined) {
		const call = trace.records.find(
			(record): record is TraceToolRecord => record.kind === "tool" && (record.callId === child.parentToolCallId || record.childSessionId === child.sessionId),
		);
		const span = call ? recordSpan(call) : undefined;
		start ??= span?.start;
		end ??= span?.end;
	}
	return { start, end: end ?? start };
}

export function recordDuration(record: TraceRecord): number | undefined {
	if (record.kind === "tool" && record.durationMs !== undefined) return record.durationMs;
	const { start, end } = recordSpan(record);
	if (record.kind !== "llm" && record.kind !== "tool") return undefined;
	if (start === undefined || end === undefined) return undefined;
	// A model call whose entry has no `durationMs` and was written at its message's own timestamp has no known
	// duration; no model answers in 0 ms.
	if (record.kind === "llm" && end <= start) return undefined;
	return Math.max(0, end - start);
}

/** Context size of a model call: everything it read, cached or not. */
export function contextTokens(record: TraceRecord): number {
	return record.kind === "llm" ? record.input + record.cacheRead + record.cacheWrite : 0;
}

/** Share of the prompt served from cache, 0-1, or undefined without a prompt. */
export function cacheHit(record: TraceRecord): number | undefined {
	if (record.kind !== "llm") return undefined;
	const total = record.input + record.cacheRead + record.cacheWrite;
	return total > 0 ? record.cacheRead / total : undefined;
}

export function recordKey(sessionId: string, record: TraceRecord): string {
	switch (record.kind) {
		case "llm":
			return `l:${sessionId}:${record.seq}`;
		case "tool":
			return `t:${sessionId}:${record.callId}`;
		case "compaction":
			return `c:${sessionId}:${record.seq}`;
		case "branch-summary":
			return `b:${sessionId}:${record.seq}`;
	}
}

export function isSubagentTool(record: TraceRecord): record is TraceToolRecord {
	return record.kind === "tool" && toolFamily(toolName(record)) === "agent";
}

/** How a turn started: a user prompt, a relay message, or another extension's message. */
export function turnStart(turn: Pick<TraceTurn, "customType" | "index">): { icon: IconName; label: string } {
	if (turn.customType === undefined) return { icon: "user", label: `Prompt ${turn.index + 1}` };
	if (turn.customType === "relay-message") return { icon: "message", label: "Relay message" };
	return { icon: "message", label: "Extension message" };
}

const EXTENSION_COLORS: Record<string, string> = {
	ts: "#3178c6",
	tsx: "#3178c6",
	js: "#c9a227",
	jsx: "#c9a227",
	mjs: "#c9a227",
	rs: "#c46a3a",
	py: "#3a75a8",
	go: "#00a0c6",
	md: "#8a8a86",
	json: "#9a8d3e",
	toml: "#8b6b9b",
	yaml: "#8b6b9b",
	yml: "#8b6b9b",
	css: "#6b5bd6",
	html: "#d0573a",
	sh: "#4e9a2b",
	sql: "#c06c9a",
	txt: "#8a8a86",
};

/** A small, stable color for a file's extension, for path chips. */
export function extensionColor(path: string): string | undefined {
	const match = /\.([A-Za-z0-9]{1,8})(?::[\d-]+)?$/.exec(path.trim());
	if (!match) return undefined;
	const ext = match[1].toLowerCase();
	if (EXTENSION_COLORS[ext]) return EXTENSION_COLORS[ext];
	let hash = 0;
	for (const char of ext) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return `hsl(${hash % 360} 35% 52%)`;
}

/** Whether a tool's summary is a file path, so it renders as a path chip. */
export function summaryIsPath(record: TraceRecord): boolean {
	if (record.kind !== "tool") return false;
	const base = parseToolName(toolName(record)).base.toLowerCase();
	return base === "read" || base === "write" || base === "edit" || base === "multiedit" || base === "ls";
}

/** The host of a URL summary, for web tools. */
export function urlHost(text: string): string | undefined {
	try {
		const url = new URL(text.trim());
		return url.protocol === "http:" || url.protocol === "https:" ? url.host : undefined;
	} catch {
		return undefined;
	}
}
