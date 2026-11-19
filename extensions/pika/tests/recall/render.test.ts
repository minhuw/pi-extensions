import { expect, it } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import recallExtension from "../../recall/index.ts";
import { FakePika } from "./support/pika-server.ts";
import { setCredentials } from "./support/runtime.ts";

/** The tools recall registers, without a pi runtime. */
function tools(): Map<string, ToolDefinition> {
	const registered = new Map<string, ToolDefinition>();
	recallExtension({ registerTool: (tool: ToolDefinition) => { registered.set(tool.name, tool); } } as unknown as ExtensionAPI);
	return registered;
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const lines = (component: { render(width: number): string[] }) => component.render(200).map((line) => line.trimEnd()).join("\n");
const context = (args: unknown, isError = false) => ({ args, isError, state: {}, invalidate() {}, expanded: false, isPartial: false }) as never;

it("renders compact calls and results", () => {
	const { recall_search: search, recall_read: read } = Object.fromEntries(tools());
	expect(lines(search!.renderCall!({ query: "parser bug", scope: "project" }, theme, context({})))).toBe("recall_search \"parser bug\" · this project");
	expect(lines(read!.renderCall!({ sessionId: "s-1", seq: 41 }, theme, context({})))).toBe("recall_read s-1 · seq 41");
	expect(lines(read!.renderCall!({ sessionId: "s-1", seq: 0, fromTurn: 0 }, theme, context({})))).toBe("recall_read s-1");
	expect(lines(read!.renderCall!({ sessionId: "s-1", seq: 0, fromTurn: 8 }, theme, context({})))).toBe("recall_read s-1 · from turn 8");
	expect(lines(read!.renderCall!({ sessionId: "s-1", seq: 41, fromTurn: 0 }, theme, context({})))).toBe("recall_read s-1 · seq 41");
	expect(lines(read!.renderCall!({ sessionId: "s-1", seq: 41, fromTurn: 8 }, theme, context({})))).toBe("recall_read s-1 · choose seq or fromTurn");
	const found = { content: [{ type: "text" as const, text: "[recall] …\n2 past sessions match" }], details: { sessionIds: ["a", "b"] } };
	expect(lines(search!.renderResult!(found, { expanded: false, isPartial: false }, theme, context({})))).toBe("2 past sessions");
	expect(lines(search!.renderResult!(found, { expanded: true, isPartial: false }, theme, context({})))).toBe("2 past sessions\n[recall] …\n2 past sessions match");
	const overview = { content: [{ type: "text" as const, text: "[recall] …\nSession s-1: \"Fix it\"\nmore" }], details: { sessionId: "s-1", turns: [0, 1, 2] } };
	expect(lines(read!.renderResult!(overview, { expanded: false, isPartial: false }, theme, context({})))).toBe("Session s-1: \"Fix it\" · turns 0–2");
	const { recall_herder: herder } = Object.fromEntries(tools());
	expect(lines(herder!.renderCall!({ scope: "project" }, theme, context({})))).toBe("recall_herder runs · this project");
	expect(lines(herder!.renderCall!({ runId: "r-1", fromEvent: 40 }, theme, context({})))).toBe("recall_herder r-1 · from event 40");
	const runs = { content: [{ type: "text" as const, text: "[recall] …\n1 Herder run" }], details: { limit: 10, runIds: ["r-1"] } };
	expect(lines(herder!.renderResult!(runs, { expanded: false, isPartial: false }, theme, context({})))).toBe("1 Herder run");
	const run = { content: [{ type: "text" as const, text: "[recall] …\nHerder run r-1: \"Add it\"\nmore" }], details: { runId: "r-1", events: [0, 1, 2] } };
	expect(lines(herder!.renderResult!(run, { expanded: false, isPartial: false }, theme, context({})))).toBe("Herder run r-1: \"Add it\" · events 0–2");
	const failed = { content: [{ type: "text" as const, text: "recall needs the pika extension logged in" }], details: {} };
	expect(lines(read!.renderResult!(failed, { expanded: false, isPartial: false }, theme, context({}, true)))).toBe("recall needs the pika extension logged in");
});

it("strips ANSI/OSC/CSI control sequences from rendered recall output while preserving raw result.content and theme styling", async () => {
	const OSC52 = "\x1b]52;c;SGVsbG8=\x07";
	const CSI_RED = "\x1b[31m";
	const CSI_RESET = "\x1b[0m";
	const CSI_CLEAR = "\x1b[2J";
	const DIRTY = `${OSC52}${CSI_RED}danger${CSI_RESET}${CSI_CLEAR}`;
	const styledTheme = {
		fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as never;
	const { recall_search: search, recall_read: read, recall_herder: herder } = Object.fromEntries(tools());
	const pika = await new FakePika().start();
	const ctx = { cwd: "/tmp/proj", sessionManager: { getCwd: () => "/tmp/proj", getSessionId: () => "cur" } } as never;
	try {
		setCredentials(pika.url);
		pika.routes.set("search", {
			body: {
				items: [{
					sessionId: "s-1", sessionTitle: `Title ${DIRTY}`, project: "proj", lastAt: "2026-10-30T09:15:00.000Z", matches: 1,
					hits: [{ sessionId: "s-1", sessionTitle: `Title ${DIRTY}`, seq: 1, entryId: "e1", kind: "assistant", snippet: `hit ${DIRTY}`, at: "2026-10-30T09:00:00.000Z" }],
				}],
				nextCursor: null,
			},
		});
		pika.routes.set("sessions/s-1", {
			body: {
				id: "s-1", device: "d-1", deviceName: "Laptop", project: "proj", cwd: "/tmp/proj", title: `Session ${DIRTY}`,
				startedAt: "2026-10-30T09:00:00.000Z", lastAt: "2026-10-30T10:00:00.000Z", durationMs: 60_000, entryCount: 1, models: ["m"],
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0, childCount: 0, children: [],
			},
		});
		pika.routes.set("sessions/s-1/trace", { body: { sessionId: "s-1", turns: [{ index: 0, startSeq: 0, endSeq: 1, userText: `ask ${DIRTY}`, at: "2026-10-30T09:00:00.000Z" }], records: [], children: [] } });
		pika.routes.set("sessions/s-1/turns", { body: { items: [{ index: 0, startSeq: 0, endSeq: 1, userText: `ask ${DIRTY}`, finalText: `reply ${DIRTY}`, at: "2026-10-30T09:00:00.000Z" }], nextCursor: null } });
		pika.routes.set("herder/runs/r-1", {
			body: {
				run: {
					runId: "r-1", device: "d-1", deviceName: "Laptop", repo: "proj", title: `Run ${DIRTY}`, status: "delivered", verdict: "met",
					startedAt: "2026-10-21T10:00:00.000Z", lastAt: "2026-10-21T10:14:00.000Z", stepCount: 0, sessionId: "orch-1",
				},
				goal: `Goal ${DIRTY}`, plan: null, steps: [], events: [],
			},
		});

		const searchRes = await search!.execute("c1", { query: "danger" }, undefined, undefined, ctx);
		const readRes = await read!.execute("c2", { sessionId: "s-1" }, undefined, undefined, ctx);
		const herderRes = await herder!.execute("c3", { runId: "r-1" }, undefined, undefined, ctx);

		for (const [tool, res] of [[search!, searchRes], [read!, readRes], [herder!, herderRes]] as const) {
			const raw = res.content[0]?.type === "text" ? res.content[0].text : "";
			expect(raw).toContain(OSC52);
			expect(raw).toContain(CSI_RED);
			expect(raw).toContain(CSI_CLEAR);

			for (const expanded of [false, true]) {
				const rendered = lines(tool.renderResult!(res, { expanded, isPartial: false }, theme, context({})));
				expect(rendered).not.toContain("\x1b");
				expect(rendered).not.toContain("\x07");
				if (expanded) expect(rendered).toContain("danger");

				const styled = lines(tool.renderResult!(res, { expanded, isPartial: false }, styledTheme, context({})));
				expect(styled).toContain("\x1b[32m");
				expect(styled).not.toContain(OSC52);
				expect(styled).not.toContain(CSI_RED);
				expect(styled).not.toContain(CSI_CLEAR);
				expect(styled).not.toContain("\x07");
			}

			const errResult = { content: [{ type: "text" as const, text: `error ${DIRTY}` }], details: {} };
			const renderedErr = lines(tool.renderResult!(errResult, { expanded: false, isPartial: false }, theme, context({}, true)));
			expect(renderedErr).toBe("error danger");
			expect(errResult.content[0]!.text).toContain(OSC52);
		}

		// Expanded recall_read and recall_herder show sanitized body text without control sequences.
		expect(lines(read!.renderResult!(readRes, { expanded: true, isPartial: false }, theme, context({})))).toContain("reply danger");
		expect(lines(herder!.renderResult!(herderRes, { expanded: true, isPartial: false }, theme, context({})))).toContain("Goal danger");

		// Collapsed firstLine for recall_read and recall_herder strips raw control sequences too.
		const dirtyRead = { content: [{ type: "text" as const, text: `[recall] …\nSession s-1: "Session ${DIRTY}"\nmore` }], details: { sessionId: "s-1", turns: [0, 1, 2] } };
		expect(lines(read!.renderResult!(dirtyRead, { expanded: false, isPartial: false }, theme, context({})))).toBe('Session s-1: "Session danger" · turns 0–2');
		expect(dirtyRead.content[0]!.text).toContain(OSC52);
		const dirtyRun = { content: [{ type: "text" as const, text: `[recall] …\nHerder run r-1: "Run ${DIRTY}"\nmore` }], details: { runId: "r-1", events: [0, 1, 2] } };
		expect(lines(herder!.renderResult!(dirtyRun, { expanded: false, isPartial: false }, theme, context({})))).toBe('Herder run r-1: "Run danger" · events 0–2');
		expect(dirtyRun.content[0]!.text).toContain(OSC52);

		// renderCall strips control sequences from call arguments too.
		expect(lines(search!.renderCall!({ query: DIRTY, project: DIRTY }, theme, context({})))).toBe('recall_search "danger" · project danger');
		expect(lines(read!.renderCall!({ sessionId: DIRTY }, theme, context({})))).toBe("recall_read danger");
		expect(lines(herder!.renderCall!({ runId: DIRTY }, theme, context({})))).toBe("recall_herder danger");
		expect(lines(herder!.renderCall!({ project: DIRTY }, theme, context({})))).toBe("recall_herder runs · project danger");
	} finally {
		setCredentials(undefined);
		await pika.stop();
	}
});
