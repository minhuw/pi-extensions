import { afterEach, beforeEach, expect, it } from "vitest";
import { BUDGET, PREAMBLE } from "../../recall/format.ts";
import { FakePika } from "./support/pika-server.ts";
import { callTool, type Harness, setCredentials, startSession, Workspace } from "./support/runtime.ts";

let workspace: Workspace;
let pika: FakePika;
let h: Harness;
beforeEach(async () => {
	workspace = await Workspace.create();
	pika = await new FakePika().start("/pika");
	setCredentials(pika.url);
	h = await startSession({ workspace });
});
afterEach(async () => {
	await h.shutdown();
	await pika.stop();
	await workspace.cleanup();
});

const SUMMARY = {
	id: "s-1", device: "d-1", deviceName: "Laptop", project: "pi-extensions", cwd: "/home/me/pi-extensions", title: "Fix the parser",
	startedAt: "2026-10-30T09:00:00.000Z", lastAt: "2026-10-30T10:30:00.000Z", durationMs: 5_400_000, entryCount: 60, models: ["gpt-6.1-sol", "claude-x"],
	tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 0.5, childCount: 1, parentSessionId: "s-0",
};

const turn = (index: number, extra: Record<string, unknown> = {}) => ({
	index, startSeq: index * 10, endSeq: index * 10 + 9, userText: `prompt ${index}`, at: `2026-10-30T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
	durationMs: 1000, modelCalls: 1, toolCalls: 0, toolErrors: 0, cost: 0, tokens: {}, finalText: `answer ${index}`, ...extra,
});
const tool = (turnIndex: number, seq: number, name: string, summary: string, extra: Record<string, unknown> = {}) =>
	({ kind: "tool", seq, turn: turnIndex, callId: `c${seq}`, name, isError: false, summary, ...extra });

function serve(turns: ReturnType<typeof turn>[], records: unknown[], children: unknown[] = []): void {
	pika.routes.set("sessions/s-1", { body: { ...SUMMARY, children: [] } });
	pika.routes.set("sessions/s-1/trace", { body: { sessionId: "s-1", turns: turns.map(({ finalText: _final, ...rest }) => rest), records, children } });
	pika.routes.set("sessions/s-1/turns", { body: { items: turns, nextCursor: null } });
}

it("reads an overview: the session, its children, and every turn with its tool calls", async () => {
	const many = Array.from({ length: 33 }, (_, i) => tool(1, 20 + i, "read", `src/file${i}.ts`));
	serve([turn(0, { customType: "relay-message" }), turn(1)], [
		{ kind: "llm", seq: 1, turn: 0, toolCalls: 2 },
		tool(0, 2, "bash", "npm test", { isError: true }),
		tool(0, 3, "Agent", "recon: map the parser", { childSessionId: "c-1" }),
		...many,
	], [{ sessionId: "c-1", agentType: "recon", description: "map the parser", kind: "subagent", title: "Map it" }, { sessionId: "c-2", kind: "herder-step", title: "Step 2" }]);
	const result = await callTool(h, "recall_read", { sessionId: "s-1" });
	expect(result.isError).toBe(false);
	for (const path of ["sessions/s-1", "sessions/s-1/trace", "sessions/s-1/turns"]) {
		expect(pika.requestsTo(path)).toHaveLength(1);
		expect(pika.requestsTo(path)[0]!.authorization).toBe("Bearer recall-test-token");
	}
	expect(pika.requestsTo("sessions/s-1/turns")[0]!.query.get("limit")).toBe("100");
	expect(result.text).toBe([
		PREAMBLE,
		"Session s-1: \"Fix the parser\"",
		"Project pi-extensions · cwd /home/me/pi-extensions · device Laptop",
		"Started 2026-10-30 09:00 UTC · last active 2026-10-30 10:30 UTC · models gpt-6.1-sol, claude-x · 2 turns",
		"Parent session s-0",
		"Child sessions (2):",
		"  - c-1 · recon · map the parser",
		"  - c-2 · herder-step · Step 2",
		"",
		"## Turn 0 · 2026-10-30 09:00 UTC · seq 0–9",
		"Message (relay-message): prompt 0",
		"Tool calls (2, 1 failed):",
		"  bash npm test [error]",
		"  Agent recon: map the parser → child session c-1",
		"Final answer: answer 0",
		"",
		"## Turn 1 · 2026-10-30 09:01 UTC · seq 10–19",
		"User: prompt 1",
		"Tool calls (33):",
		...many.slice(0, 30).map((record) => `  read ${record.summary}`),
		"  … 3 more tool calls",
		"Final answer: answer 1",
		"",
		"Shown turns 0 to 1 of 2: the end of the session.",
		"Read the entries around a point with recall_read({ sessionId, seq }), using a seq from a turn's range.",
	].join("\n"));
	expect(result.details).toEqual({ sessionId: "s-1", turns: [0, 1] });
});

it("uses zero-filled optional arguments to read and page the overview, then inspect details", async () => {
	const turns = Array.from({ length: 25 }, (_, i) => turn(i, { finalText: `answer ${i} ${"x".repeat(1_500)}` }));
	serve(turns, []);
	pika.routes.set("sessions/s-1/entries", (request) => {
		const seq = Number(request.query.get("from"));
		return { body: { items: [{ seq, type: "message", raw: { type: "message", message: { role: "user", content: `entry ${seq}` } } }] } };
	});

	// The reported failure supplied both optional numbers, initially as zero.
	const first = await callTool(h, "recall_read", { sessionId: "s-1", fromTurn: 0, seq: 0 });
	expect(first.isError).toBe(false);
	expect(first.text).toContain("## Turn 0 ·");
	expect(first.text).toContain("seq: 0 was treated as an unused placeholder");
	expect(pika.requestsTo("sessions/s-1/entries")).toHaveLength(0);
	const next = (first.details as { next: { fromTurn: number } }).next.fromTurn;
	expect(next).toBeGreaterThan(0);

	const later = await callTool(h, "recall_read", { sessionId: "s-1", fromTurn: next, seq: 0 });
	expect(later.isError).toBe(false);
	expect(later.text).toContain(`## Turn ${next} ·`);
	expect(later.text).not.toContain(`## Turn ${next - 1} ·`);

	const details = await callTool(h, "recall_read", { sessionId: "s-1", fromTurn: 0, seq: 13 });
	expect(details.isError).toBe(false);
	expect(details.text).toContain("entries 9 to 21 around seq 13");
	expect(details.text).toContain("fromTurn: 0 was treated as an unused placeholder");
	expect(details.details).toMatchObject({ sessionId: "s-1", seq: 13 });

	// A genuine request for seq 0 remains available without fromTurn.
	const zero = await callTool(h, "recall_read", { sessionId: "s-1", seq: 0 });
	expect(zero.isError).toBe(false);
	expect(zero.text).toContain("entries 0 to 8 around seq 0");
	expect(zero.text).toContain("entry 0");

	const before = pika.requests.length;
	const conflict = await callTool(h, "recall_read", { sessionId: "s-1", fromTurn: 2, seq: 13 });
	expect(conflict.isError).toBe(true);
	expect(conflict.text).toContain("choose either seq for entries or fromTurn for an overview");
	expect(pika.requests).toHaveLength(before);
});

it("stops an overview at the budget and says which fromTurn continues, which then reads on", async () => {
	const turns = Array.from({ length: 40 }, (_, i) => turn(i, { finalText: `answer ${i} ${"x".repeat(1_500)}` }));
	serve(turns, []);
	const first = await callTool(h, "recall_read", { sessionId: "s-1" });
	expect(first.text.length).toBeLessThan(BUDGET + 2_000);
	const next = (first.details as { next: { fromTurn: number } }).next.fromTurn;
	expect(next).toBeGreaterThan(5);
	expect(next).toBeLessThan(40);
	expect(first.text).toContain(`Shown turns 0 to ${next - 1} of 40. Continue with recall_read({ sessionId: "s-1", fromTurn: ${next} }).`);
	const second = await callTool(h, "recall_read", { sessionId: "s-1", fromTurn: next });
	expect(second.text).toContain(`## Turn ${next} ·`);
	expect(second.text).not.toContain(`## Turn ${next - 1} ·`);
	const past = await callTool(h, "recall_read", { sessionId: "s-1", fromTurn: 99 });
	expect(past.text).toContain("No turn 99: the session has 40 turns (0 to 39).");
});

it("shows a single turn over the budget, cut", async () => {
	serve([turn(0, { userText: "y".repeat(50_000), finalText: "z".repeat(50_000) }), turn(1)], []);
	const result = await callTool(h, "recall_read", { sessionId: "s-1" });
	expect(result.text).toContain("## Turn 0 ·");
	expect(result.text.length).toBeLessThan(BUDGET + 1_000);
	expect(result.text).toContain("Continue with recall_read({ sessionId: \"s-1\", fromTurn: 1 }).");
});

it("pages through turns with the cursor to reach fromTurn", async () => {
	const all = Array.from({ length: 250 }, (_, i) => turn(i));
	pika.routes.set("sessions/s-1", { body: SUMMARY });
	pika.routes.set("sessions/s-1/trace", { body: { sessionId: "s-1", turns: all, records: [], children: [] } });
	pika.routes.set("sessions/s-1/turns", (request) => {
		const start = Number(request.query.get("cursor") ?? 0);
		const end = start + Number(request.query.get("limit"));
		return { body: { items: all.slice(start, end), nextCursor: end < all.length ? String(end) : null } };
	});
	const result = await callTool(h, "recall_read", { sessionId: "s-1", fromTurn: 230 });
	expect(pika.requestsTo("sessions/s-1/turns").map((request) => request.query.get("cursor"))).toEqual([null, "100", "200"]);
	expect(result.text).toContain("## Turn 230 ·");
	expect(result.text).toContain("Shown turns 230 to 249 of 250: the end of the session.");
});

it("reads the entries around a seq as text", async () => {
	pika.routes.set("sessions/s-1", { body: SUMMARY });
	const at = "2026-10-30T09:05:00.000Z";
	const entries = [
		{ seq: 37, id: "e37", type: "model_change", timestamp: at, raw: { type: "model_change", provider: "magpie", modelId: "gpt-6.1-sol" } },
		{ seq: 38, id: "e38", type: "message", timestamp: at, raw: { type: "message", message: { role: "user", content: [{ type: "text", text: "Fix the parser" }, { type: "image", data: "", mimeType: "image/png" }] } } },
		{ seq: 39, id: "e39", type: "message", timestamp: at, raw: { type: "message", message: { role: "assistant", model: "gpt-6.1-sol", content: [
			{ type: "thinking", thinking: "Look at the tokenizer" }, { type: "text", text: "Running the tests." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
		] } } },
		{ seq: 40, id: "e40", type: "message", timestamp: at, raw: { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "1 failed" }] } } },
		{ seq: 41, id: "e41", type: "compaction", timestamp: at, raw: { type: "compaction", summary: "We fixed X.", tokensBefore: 5000 } },
		{ seq: 42, id: "e42", type: "custom_message", timestamp: at, raw: { type: "custom_message", customType: "relay-message", content: "hello from laptop", display: true } },
		{ seq: 43, id: "e43", type: "branch_summary", timestamp: at, raw: { type: "branch_summary", summary: "Tried approach A." } },
		{ seq: 44, id: "e44", type: "custom", timestamp: at, raw: { type: "custom", customType: "pi-extensions.session-link", data: { kind: "subagent" } } },
		{ seq: 45, id: "e45", type: "session_info", timestamp: at, raw: { type: "session_info", name: "Parser" } },
		{ seq: 46, id: "e46", type: "label", timestamp: at, raw: { type: "label", targetId: "e38", label: "checkpoint" }, truncated: true },
	];
	pika.routes.set("sessions/s-1/entries", { body: { items: entries } });
	const result = await callTool(h, "recall_read", { sessionId: "s-1", seq: 41 });
	expect(Object.fromEntries(pika.requestsTo("sessions/s-1/entries")[0]!.query)).toEqual({ from: "37", to: "49", limit: "13" });
	const when = "2026-10-30 09:05 UTC";
	expect(result.text).toBe([
		PREAMBLE,
		"Session s-1: \"Fix the parser\", entries 37 to 49 around seq 41",
		"",
		`[seq 37 · ${when} · model changed to magpie/gpt-6.1-sol]`,
		"",
		`[seq 38 · ${when} · user]`, "Fix the parser", "[image]",
		"",
		`[seq 39 · ${when} · assistant (gpt-6.1-sol)]`, "(thinking) Look at the tokenizer", "Running the tests.", "→ tool call bash {\"command\":\"npm test\"}",
		"",
		`[seq 40 · ${when} · tool result bash [error]]`, "1 failed",
		"",
		`[seq 41 · ${when} · compaction, 5000 tokens before]`, "We fixed X.",
		"",
		`[seq 42 · ${when} · message relay-message]`, "hello from laptop",
		"",
		`[seq 43 · ${when} · branch summary]`, "Tried approach A.",
		"",
		`[seq 44 · ${when} · extension data pi-extensions.session-link]`, "{\"kind\":\"subagent\"}",
		"",
		`[seq 45 · ${when} · session named "Parser"]`,
		"",
		`[seq 46 · ${when} · label (cut by the server)]`, "{\"targetId\":\"e38\",\"label\":\"checkpoint\"}",
		"",
		"Continue after seq 46 with recall_read({ sessionId: \"s-1\", seq: 51 }).",
	].join("\n"));
	expect(result.details).toEqual({ sessionId: "s-1", seq: 41, next: { seq: 51 } });
});

it("cuts long entries, stops at the budget, and says the session's last entry or that there are none", async () => {
	pika.routes.set("sessions/s-1", { body: { ...SUMMARY, entryCount: 12 } });
	const big = (seq: number) => ({ seq, id: `e${seq}`, type: "message", raw: { type: "message", message: {
		role: "toolResult", toolName: "read", content: [{ type: "text", text: "r".repeat(100_000) }],
	} } });
	pika.routes.set("sessions/s-1/entries", (request) => {
		const from = Number(request.query.get("from"));
		if (from >= 12) return { body: { items: [] } };
		if (from === 0) return { body: { items: Array.from({ length: 12 }, (_, seq) => big(seq)) } };
		return { body: { items: [{ seq: 11, id: "e11", type: "message", raw: { type: "message", message: { role: "user", content: "last" } } }] } };
	});
	const cut = await callTool(h, "recall_read", { sessionId: "s-1", seq: 2 });
	expect(Object.fromEntries(pika.requestsTo("sessions/s-1/entries")[0]!.query)).toMatchObject({ from: "0", to: "10" });
	expect(cut.text.length).toBeLessThan(BUDGET + 1_000);
	const shown = cut.text.match(/\[seq \d+ ·/g)!.length;
	expect(shown).toBeGreaterThan(1);
	expect(shown).toBeLessThan(12);
	expect(cut.text).toContain(`Continue after seq ${shown - 1} with recall_read({ sessionId: "s-1", seq: ${shown + 4} }).`);
	const end = await callTool(h, "recall_read", { sessionId: "s-1", seq: 11 });
	expect(end.text.endsWith("[seq 11 · user]\nlast\n\nSeq 11 is the last entry of the session.")).toBe(true);
	const none = await callTool(h, "recall_read", { sessionId: "s-1", seq: 30 });
	expect(none.text).toBe(`${PREAMBLE}\nSession s-1: "Fix the parser", entries 26 to 38 around seq 30\n\nNo entries there: the session has 12 entries (seq 0 to 11).`);
});
