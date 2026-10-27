import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

export const LARGE_TURNS = 5;
export const LARGE_ENTRIES = 5_000;
const PER_TURN = LARGE_ENTRIES / LARGE_TURNS;

export interface LargeSession {
	id: string;
	title: string;
	/** The JSONL file text, header first. */
	text: string;
	lines: string[];
}

/**
 * One session with a header and 5,000 entries in five long turns: a prompt, tool calls with results, and a final
 * answer each, as a long agentic session produces.
 */
export function largeSession(start = Date.parse("2026-10-01T08:00:00.000Z")): LargeSession {
	const id = randomUUID();
	const title = "Refactor the inventory service end to end";
	let at = start;
	let parentId: string | null = null;
	let counter = 0;
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(at).toISOString(), cwd: "/home/dev/code/inventory" })];
	const push = (message: Record<string, unknown>) => {
		at += 1_500;
		const entryId = (++counter).toString(16).padStart(8, "0");
		lines.push(JSON.stringify({ type: "message", id: entryId, parentId, timestamp: new Date(at).toISOString(), message: { ...message, timestamp: at } }));
		parentId = entryId;
	};
	const usage = { input: 2_000, output: 120, cacheRead: 1_000, cacheWrite: 0, totalTokens: 3_120, cost: { input: 0.006, output: 0.0018, cacheRead: 0.0003, cacheWrite: 0, total: 0.0081 } };
	const assistant = (content: unknown[], stopReason: string) =>
		({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", usage, stopReason });
	for (let turn = 0; turn < LARGE_TURNS; turn++) {
		push({ role: "user", content: turn === 0 ? title : `Continue with part ${turn + 1} of the refactor.` });
		for (let i = 0; i < (PER_TURN - 2) / 2; i++) {
			const callId = `call_${turn}_${i}`;
			const command = `rg -n "stock_level" services/inventory/module_${i}.py`;
			push(assistant([{ type: "text", text: `Checking module ${i}.` }, { type: "toolCall", id: callId, name: "bash", arguments: { command } }], "toolUse"));
			push({ role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: `services/inventory/module_${i}.py:${10 + i}: stock_level = fetch(${i})` }], isError: false });
		}
		push(assistant([{ type: "text", text: `Part ${turn + 1} is done: every module now reads stock levels through one function.` }], "stop"));
	}
	return { id, title, lines, text: lines.map((line) => `${line}\n`).join("") };
}

/** Uploads the session through the ingest API in batches, as a device would. */
export async function ingestSession(baseUrl: string, token: string, session: LargeSession): Promise<void> {
	let offset = 0;
	const batch = 1_000;
	for (let start = 0; start < session.lines.length; start += batch) {
		const lines = session.lines.slice(start, start + batch);
		const body = JSON.stringify({
			client: { host: "desktop", pikaVersion: "e2e" },
			streams: [{ key: `session:${session.id}`, kind: "session", offset, lines, path: `/home/dev/.pi/agent/sessions/${session.id}.jsonl` }],
		});
		const response = await fetch(`${baseUrl}/api/ingest/v1/batch`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-encoding": "gzip" },
			body: gzipSync(body),
		});
		const text = await response.text();
		if (response.status !== 200) throw new Error(`ingest answered ${response.status}: ${text.slice(0, 200)}`);
		for (const line of lines) offset += Buffer.byteLength(line) + 1;
		const length = (JSON.parse(text) as { streams: Record<string, { length: number }> }).streams[`session:${session.id}`]?.length;
		if (length !== offset) throw new Error(`the server reports ${length} bytes after a batch; expected ${offset}`);
	}
}

/** A long MCP tool name, as the ledger's name column must truncate it. */
export const EDGE_MCP_TOOL = "mcp__chrome_devtools_extended__take_full_page_screenshot_with_annotations";
export const EDGE_LONG_TOOL = "summarize_repository_structure_and_report_every_module_dependency";

/**
 * Sessions of awkward shapes for the trajectory's screenshots: `edge` has a multi-line prompt, a long MCP tool name, a
 * very long single-line command that fails, a custom tool with a long name, a thinking block, a compaction, and an
 * errored model call, and no `durationMs` anywhere but its last turn; `chat` has no tool calls at all.
 */
export function edgeSessions(start = Date.parse("2026-10-02T09:00:00.000Z")): { edge: LargeSession; chat: LargeSession } {
	const build = (title: string, cwd: string, write: (push: (entry: Record<string, unknown>) => void, message: (message: Record<string, unknown>, extra?: Record<string, unknown>) => void) => void): LargeSession => {
		const id = randomUUID();
		let at = start;
		let parentId: string | null = null;
		let counter = 0;
		const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(at).toISOString(), cwd })];
		const push = (entry: Record<string, unknown>) => {
			at += 2_300;
			const entryId = (++counter).toString(16).padStart(8, "0");
			lines.push(JSON.stringify({ ...entry, id: entryId, parentId, timestamp: new Date(at).toISOString() }));
			parentId = entryId;
		};
		const message = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => push({ type: "message", message: { ...body, timestamp: at + 2_300 - (typeof extra.durationMs === "number" ? extra.durationMs : 0), ...extra } });
		write(push, message);
		return { id, title, lines, text: lines.map((line) => `${line}\n`).join("") };
	};
	const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: input * 3e-6, output: output * 15e-6, cacheRead: 0, cacheWrite: 0, total: input * 3e-6 + output * 15e-6 } });
	const assistant = (content: unknown[], stopReason: string, extra: Record<string, unknown> = {}) =>
		({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5", usage: usage(18_000, 400), stopReason, ...extra });
	const command = `cd /home/dev/code/inventory/services/warehouse-replenishment && ${Array.from({ length: 24 }, (_, i) => `python -m tools.audit --module module_${i} --strict --report reports/audit_${i}.json`).join(" && ")}`;
	const edge = build("Audit every warehouse module and take a screenshot of the dashboard", "/home/dev/code/inventory/services/warehouse-replenishment", (push, message) => {
		message({ role: "user", content: `Audit every warehouse module and take a screenshot of the dashboard so that we can compare it with last week's numbers before the review on Friday afternoon.\n\nKeep the report short.` });
		message(assistant([{ type: "thinking", thinking: "The dashboard first, then the audit." }, { type: "text", text: "I will capture the dashboard first." }, { type: "toolCall", id: "call_mcp", name: EDGE_MCP_TOOL, arguments: { selector: "#replenishment-dashboard", fullPage: true } }], "toolUse"));
		message({ role: "toolResult", toolCallId: "call_mcp", toolName: EDGE_MCP_TOOL, content: [{ type: "text", text: "Saved screenshot to /tmp/dashboard.png (1920×4210)." }], isError: false });
		message(assistant([{ type: "toolCall", id: "call_long", name: "bash", arguments: { command } }], "toolUse"));
		message({ role: "toolResult", toolCallId: "call_long", toolName: "bash", content: [{ type: "text", text: "Traceback (most recent call last):\n  File \"tools/audit.py\", line 12\nModuleNotFoundError: No module named 'tools.audit'\n\nCommand exited with code 1" }], isError: true });
		message(assistant([{ type: "toolCall", id: "call_custom", name: EDGE_LONG_TOOL, arguments: { scope: "services/warehouse-replenishment and every package it imports, transitively, including the vendored forecasting library and the generated protobuf stubs".repeat(2) } }], "toolUse"));
		message({ role: "toolResult", toolCallId: "call_custom", toolName: EDGE_LONG_TOOL, content: [{ type: "text", text: "12 modules, 48 dependencies." }], isError: false });
		message(assistant([], "error", { errorMessage: "529 overloaded_error: Overloaded", usage: usage(0, 0) }));
		push({ type: "compaction", summary: "## Goal\nAudit the warehouse modules.\n\n## Progress\nThe dashboard screenshot is saved; the audit tool is missing.", firstKeptEntryId: "00000001", tokensBefore: 182_400 });
		message({ role: "user", content: "Use the audit script in scripts/ instead." });
		message(assistant([{ type: "text", text: "Running the audit script." }, { type: "toolCall", id: "call_script", name: "bash", arguments: { command: "python scripts/audit.py --all" } }], "toolUse"), { durationMs: 1_800 });
		message({ role: "toolResult", toolCallId: "call_script", toolName: "bash", content: [{ type: "text", text: "12 modules audited, 0 findings." }], isError: false });
		message(assistant([{ type: "text", text: "All 12 modules pass the audit; the dashboard screenshot is in /tmp/dashboard.png." }], "stop"), { durationMs: 2_100 });
	});
	const chat = build("What is the difference between a mutex and a semaphore?", "/home/dev", (_push, message) => {
		message({ role: "user", content: "What is the difference between a mutex and a semaphore?" });
		message(assistant([{ type: "text", text: "A mutex is a lock one owner holds; a semaphore counts permits that any thread may release." }], "stop"), { durationMs: 1_900 });
		message({ role: "user", content: "And when would I pick a semaphore?" });
		message(assistant([{ type: "text", text: "When a fixed number of workers may use a resource at once, such as a pool of connections." }], "stop"), { durationMs: 2_200 });
	});
	return { edge, chat };
}
