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
