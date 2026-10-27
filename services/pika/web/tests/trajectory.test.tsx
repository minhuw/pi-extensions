import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSession, Entry, SessionLink, Turn } from "../src/lib/types";
import { VIEW_STORAGE_KEY } from "../src/pages/SessionView";
import { LIVE_POLL_MS, TRACE_REFRESH_MS } from "../src/session/live";
import { foldGaps, layoutOverview, makeScale, overviewLanes, traceIntervals } from "../src/trace/axis";
import { assistantMessage, entry, header, iso, summary, toolCall, toolResultMessage, turn, userMessage } from "./support/fixtures";
import { mockLayout, renderApp } from "./support/render";
import { anthropicPayload, modelRequest } from "./support/requests";
import { createFakeServer, traceOf, type FakeSession } from "./support/server";
import { entryCalls, inspector, key, row, rows, selected, session, slideOver } from "./support/trajectory";

function child(id: string, parent: string, toolCallId: string, link: Partial<SessionLink>, at: number): ChildSession {
	return {
		...summary(id, { parentSessionId: parent, startedAt: iso(at), lastAt: iso(at + 5000), title: `Child ${id}` }),
		parentToolCallId: toolCallId,
		link: { kind: "subagent", parentSessionId: parent, parentToolCallId: toolCallId, ...link },
	};
}

function simple(id: string, prompt: string, calls: ReturnType<typeof toolCall>[], children: ChildSession[] = []): FakeSession {
	const entries: Entry[] = [entry(0, header(id)), entry(1, userMessage(prompt))];
	let seq = 2;
	for (const call of calls) {
		entries.push(entry(seq++, assistantMessage([call], 1000 + seq * 100)));
		entries.push(entry(seq++, toolResultMessage(call.id, call.name, `${call.name} finished`, { at: 1050 + seq * 100 })));
	}
	entries.push(entry(seq, assistantMessage([{ type: "text", text: `${id} done` }], 1000 + seq * 100)));
	return {
		detail: summary(id, { childCount: children.length, children, title: prompt }),
		entries,
		turns: [turn(0, 1, seq, { userText: prompt, modelCalls: calls.length + 1, toolCalls: calls.length })],
	};
}

function agents(): FakeSession[] {
	const worker = child("c1", "p1", "call_agent", { agentType: "worker", description: "Fix tests" }, 1000);
	const nested = child("c1n", "c1", "call_nested", { agentType: "recon", description: "Look around" }, 2000);
	const reviewA = child("w1", "p1", "call_wf", { agentType: "reviewer", description: "Review A", workflowId: "wf" }, 3000);
	const reviewB = child("w2", "p1", "call_wf", { agentType: "reviewer", description: "Review B", workflowId: "wf" }, 4000);
	const parent = simple(
		"p1",
		"Ship it",
		[toolCall("call_agent", "Agent", { subagent_type: "worker", description: "Fix tests" }), toolCall("call_wf", "SubagentWorkflow", { name: "review-fanout" })],
		[worker, reviewA, reviewB],
	);
	const c1 = simple("c1", "Child prompt", [toolCall("call_nested", "Agent", { subagent_type: "recon", description: "Look around" })], [nested]);
	return [parent, c1, simple("c1n", "Nested prompt", [toolCall("n_read", "read", { path: "README.md" })]), simple("w1", "Review A", []), simple("w2", "Review B", [])];
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
});
afterEach(() => restore());

describe("trajectory ledger", () => {
	it("shows one row per record under sticky turn headers, with badges by family and summaries", async () => {
		const server = createFakeServer({ sessions: [session()] });
		renderApp("/s/t1", server.fetch);
		await waitFor(() => expect(rows().length).toBe(9));
		expect(document.querySelector("[data-trajectory]")).not.toBeNull();
		expect(server.calls).toContain("/api/v1/sessions/t1/trace");
		// The ledger needs no entries.
		expect(entryCalls(server.calls)).toEqual([]);
		expect(rows().map((node) => `${node.dataset.turnIndex}:${node.dataset.seq}:${node.dataset.kind}:${node.querySelector("[data-badge]")?.textContent}`)).toEqual([
			"0:2:llm:LLM",
			"0:2:shell:BASH",
			"0:4:llm:LLM",
			"0:4:read:READ",
			"0:4:read:GREP",
			"0:7:llm:LLM",
			"0:7:write:EDIT",
			"0:9:llm:LLM",
			"1:11:llm:LLM",
		]);
		const head = document.querySelector<HTMLElement>("[data-turn='0'][data-turn-head]")!;
		expect(head.textContent).toContain("#1");
		// Markdown marks are dropped in the one-line prompt.
		expect(head.textContent).toContain("Fix the flaky test");
		expect(head.textContent).toContain("1 err");
		const bash = row("[data-kind='shell']");
		expect(bash.dataset.error).toBe("true");
		expect(bash.textContent).toContain("$ npm test");
		expect(bash.textContent).not.toContain("--watch");
		// The exit code is known only once the result is loaded.
		expect(within(bash).getByText("failed")).toBeTruthy();
		expect(row("[data-seq='2'][data-kind='llm']").textContent).toContain("→ bash");
		expect(row("[data-seq='4'][data-kind='llm']").textContent).toContain("read · grep");
		expect(row("[data-kind='read']").textContent).toContain("src/api.ts");
		expect(row("[data-seq='9']").textContent).toContain("Fixed the retry count.");
		// Durations come from the trace: 1.5 s for the first call, 2.5 s for the failing command after it.
		expect(row("[data-seq='2'][data-kind='llm']").textContent).toContain("1.5s");
		expect(bash.textContent).toContain("2.5s");
		const listbox = screen.getByRole("listbox", { name: "Session records" });
		expect(within(listbox).getAllByRole("option").every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
	});

	it("keeps the shortcuts and colors in the toolbar's help, and the inspector hidden until something is inspected", async () => {
		renderApp("/s/t1", createFakeServer({ sessions: [session()] }).fetch);
		const shell = await waitFor(() => row("[data-kind='shell']"));
		const pane = slideOver()!;
		expect(pane.dataset.inspectorPane).toBe("hidden");
		expect(pane.className).toContain("min-[1200px]:hidden");
		expect(pane.textContent).not.toContain("fold a turn");
		expect(document.querySelector("[data-trajectory]")?.textContent).not.toContain("Drag to filter");

		const help = document.querySelector<HTMLElement>("[data-ledger-help]")!;
		const tip = within(help).getByRole("tooltip");
		const button = within(help).getByRole("button", { name: "Keyboard shortcuts and colors" });
		expect(button.getAttribute("aria-describedby")).toBe(tip.id);
		for (const text of ["filter the timeline by time", "fold a turn", "Model call", "Error"]) expect(tip.textContent).toContain(text);

		fireEvent.click(shell);
		expect(pane.dataset.inspectorPane).toBe("shown");
		expect(pane.className).not.toContain("min-[1200px]:hidden");

		// `?` opens the help; Esc there closes it and keeps the selection.
		fireEvent.keyDown(document.body, { key: "?" });
		expect(document.activeElement).toBe(button);
		fireEvent.keyDown(button, { key: "Escape" });
		expect(document.activeElement).not.toBe(button);
		expect(selected()).toBe(row("[data-kind='shell']"));
		expect(pane.dataset.inspectorPane).toBe("shown");
	});

	it("inspects a record, loading only its entries, with Rendered, Input, Output, and Raw tabs", async () => {
		const server = createFakeServer({ sessions: [session()] });
		renderApp("/s/t1", server.fetch);
		expect(document.querySelector("[data-inspector-empty]")).toBeNull();
		fireEvent.click(await waitFor(() => row("[data-kind='shell']")));
		expect(selected()).toBe(row("[data-kind='shell']"));
		await waitFor(() => expect(inspector().querySelector("[data-tool='bash']")).not.toBeNull());
		expect(inspector().dataset.tab).toBe("rendered");
		expect(entryCalls(server.calls)).toEqual(["/api/v1/sessions/t1/entries?from=2&to=2&limit=1", "/api/v1/sessions/t1/entries?from=3&to=3&limit=1"]);
		expect(within(inspector()).getByRole("alert").textContent).toContain("Exited with code 1");

		fireEvent.click(within(inspector()).getByRole("tab", { name: "Input" }));
		expect(inspector().dataset.tab).toBe("input");
		expect(inspector().querySelector("[data-json-tree]")?.textContent).toContain("command");
		fireEvent.click(within(inspector()).getByRole("tab", { name: "Output" }));
		expect(inspector().textContent).toContain("1 failed");
		fireEvent.click(within(inspector()).getByRole("tab", { name: "Raw" }));
		expect(inspector().textContent).toContain('"toolCallId": "c_bash"');
		expect(localStorage.getItem("pika-inspector-tab")).toBe("raw");

		// Selecting the edit reuses the cache for nothing it does not need and shows its diff.
		fireEvent.click(row("[data-kind='write']"));
		fireEvent.click(within(inspector()).getByRole("tab", { name: "Rendered" }));
		await waitFor(() => expect(inspector().querySelector("[data-diff]")).not.toBeNull());
		expect(inspector().querySelector("[data-diffstat]")?.getAttribute("data-diffstat")).toBe("+2 -1");
		// Once loaded, the ledger row shows the diffstat too.
		await waitFor(() => expect(row("[data-kind='write'] [data-diffstat]")).toBeTruthy());
		expect(entryCalls(server.calls)).toHaveLength(4);
	});

	it("shows what the model saw in the Context tab, with the drawer's attributes", async () => {
		const server = createFakeServer({ sessions: [session()], requests: [modelRequest("r1", anthropicPayload)] });
		renderApp("/s/t1", server.fetch);
		fireEvent.click(await waitFor(() => row("[data-seq='2'][data-kind='llm']")));
		await waitFor(() => expect(within(inspector()).getByRole("button", { name: /Thinking/ })).toBeTruthy());
		expect(inspector().textContent).toContain("npm test");
		expect(inspector().querySelector("[data-usage]")?.textContent).toContain("8,000");
		fireEvent.click(within(inspector()).getByRole("tab", { name: "Context" }));
		const panel = await waitFor(() => {
			const node = inspector().querySelector<HTMLElement>("[data-context-panel='r1']");
			if (!node?.querySelector("[data-context-message]")) throw new Error("no context yet");
			return node;
		});
		expect(server.calls).toContain("/api/v1/requests/r1");
		expect(panel.querySelector("[data-system-sections]")).not.toBeNull();
		expect(panel.querySelectorAll("[data-tool-decl]").length + panel.querySelectorAll("[data-raw-json]").length).toBeGreaterThanOrEqual(0);
		expect(within(panel).getByText("Anthropic messages")).toBeTruthy();
		// A model call without a captured request says so.
		fireEvent.click(row("[data-seq='9']"));
		await waitFor(() => expect(inspector().textContent).toContain("No request was captured"));
	});

	it("moves with j, k, and arrows, folds turns with ← and →, jumps with [ and ], and filters with /", async () => {
		const server = createFakeServer({ sessions: [session()] });
		renderApp("/s/t1", server.fetch);
		await waitFor(() => expect(rows().length).toBe(9));
		key("j");
		await waitFor(() => expect(selected()?.dataset.seq).toBe("2"));
		key("ArrowDown");
		await waitFor(() => expect(selected()?.dataset.kind).toBe("shell"));
		key("k");
		await waitFor(() => expect(selected()?.dataset.kind).toBe("llm"));
		// ← folds the turn and selects its header; → unfolds it.
		key("ArrowLeft");
		await waitFor(() => expect(rows().map((node) => node.dataset.turnIndex)).toEqual(["1"]));
		expect(document.querySelector("[data-turn='0'] button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
		key("ArrowRight");
		await waitFor(() => expect(rows()).toHaveLength(9));
		key("]");
		await waitFor(() => expect(inspector().textContent).toContain("Prompt 2"));
		key("[");
		await waitFor(() => expect(inspector().textContent).toContain("Prompt 1"));
		key("Enter");
		await waitFor(() => expect(rows().map((node) => node.dataset.turnIndex)).toEqual(["1"]));
		// `/` focuses the ledger's filter instead of opening search.
		key("/");
		const input = screen.getByRole("searchbox", { name: "Filter records" });
		expect(document.activeElement).toBe(input);
		expect(screen.getByRole("heading", { name: "Fix the flaky test", level: 1 })).toBeTruthy();
		fireEvent.change(input, { target: { value: "grep" } });
		await waitFor(() => expect(rows().map((node) => node.dataset.kind)).toEqual(["read"]));
		// Esc clears the filter; the turn folded with Enter stays folded.
		fireEvent.keyDown(input, { key: "Escape" });
		await waitFor(() => expect(rows().map((node) => node.dataset.turnIndex)).toEqual(["1"]));
	});

	it("filters by text, family, and errors, and counts what it shows", async () => {
		renderApp("/s/t1", createFakeServer({ sessions: [session()] }).fetch);
		await waitFor(() => expect(rows().length).toBe(9));
		const count = () => document.querySelector("[data-ledger-count]")?.textContent;
		expect(count()).toBe("9 records");
		fireEvent.change(screen.getByRole("searchbox", { name: "Filter records" }), { target: { value: "api.ts" } });
		await waitFor(() => expect(rows().map((node) => node.dataset.kind)).toEqual(["read", "write"]));
		expect(count()).toBe("2 of 9");
		fireEvent.change(screen.getByRole("searchbox", { name: "Filter records" }), { target: { value: "" } });
		fireEvent.click(document.querySelector<HTMLElement>("[data-family-filter='llm']")!);
		await waitFor(() => expect(rows().every((node) => node.dataset.kind === "llm")).toBe(true));
		expect(rows()).toHaveLength(5);
		fireEvent.click(document.querySelector<HTMLElement>("[data-family-filter='llm']")!);
		fireEvent.click(document.querySelector<HTMLElement>("[data-errors-filter]")!);
		await waitFor(() => expect(rows().map((node) => node.dataset.kind)).toEqual(["shell"]));
		// The turn without a match is hidden.
		expect(document.querySelector("[data-turn='1']")).toBeNull();
		key("Escape");
		await waitFor(() => expect(rows()).toHaveLength(9));
	});

	it("starts with all turns expanded up to 40, else the last three, and collapses or expands them all", async () => {
		const entries: Entry[] = [entry(0, header("many"))];
		const turns: Turn[] = [];
		for (let i = 0; i < 45; i++) {
			const seq = 1 + i * 2;
			entries.push(entry(seq, userMessage(`Question ${i}`, i * 10_000)), entry(seq + 1, assistantMessage([{ type: "text", text: `Answer ${i}` }], i * 10_000 + 2000)));
			turns.push(turn(i, seq, seq + 1, { userText: `Question ${i}`, at: iso(i * 10_000), durationMs: 2000 }));
		}
		renderApp("/s/many", createFakeServer({ sessions: [{ detail: summary("many", { entryCount: entries.length }), entries, turns }] }).fetch);
		await waitFor(() => expect(rows().map((node) => node.dataset.turnIndex)).toEqual(["42", "43", "44"]));
		const expanded = () => [...document.querySelectorAll("[data-turn-head] button[aria-expanded='true']")].length;
		expect(expanded()).toBe(3);
		fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
		await waitFor(() => expect(rows()).toHaveLength(0));
		fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
		await waitFor(() => expect(rows()).toHaveLength(45));
	});
});

describe("trajectory overview", () => {
	it("describes the session in text, selects a record on click, and brushes a time range", async () => {
		const fixture = session();
		renderApp("/s/t1", createFakeServer({ sessions: [fixture] }).fetch);
		const overview = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-overview]");
			if (!node) throw new Error("no overview");
			return node;
		});
		expect(overview.getAttribute("aria-label")).toBe("Session timeline: 2 turns, 5 model calls, 4 tool calls, 1m 10s active.");
		expect(overview.querySelectorAll("canvas")).toHaveLength(2);
		// The plot is 800 px wide in jsdom; place the edit call the way the overview does.
		const trace = traceOf(fixture);
		const items = layoutOverview(trace, makeScale(foldGaps(traceIntervals(trace)), 800), overviewLanes(false));
		const edit = items.find((item) => item.key === "t:t1:c_edit")!;
		const plot = overview.querySelector<HTMLElement>("[data-overview-plot]")!;
		const at = { clientX: (edit.x0 + edit.x1) / 2, clientY: (edit.y0 + edit.y1) / 2, button: 0 };
		fireEvent.pointerMove(plot, at);
		expect(within(overview).getByRole("tooltip").textContent).toContain("EDIT");
		fireEvent.pointerDown(plot, at);
		fireEvent.pointerUp(plot, at);
		await waitFor(() => expect(selected()?.dataset.kind).toBe("write"));
		// jsdom's viewport is narrow: the inspector slides over, and Esc closes it first.
		expect(slideOver()?.dataset.slideOver).toBe("open");
		key("Escape");
		await waitFor(() => expect(slideOver()?.dataset.slideOver).toBe("closed"));

		// Dragging filters the ledger to the range; Esc clears it.
		const llm = items.find((item) => item.key === "l:t1:11")!;
		fireEvent.pointerDown(plot, { clientX: llm.x0 - 4, clientY: 30, button: 0 });
		fireEvent.pointerMove(plot, { clientX: llm.x1 + 4, clientY: 30 });
		fireEvent.pointerUp(plot, { clientX: llm.x1 + 4, clientY: 30 });
		await waitFor(() => expect(rows().map((node) => node.dataset.seq)).toEqual(["11"]));
		expect(document.querySelector("[data-clear-range]")).not.toBeNull();
		expect(overview.querySelector("[data-range]")).not.toBeNull();
		key("Escape");
		await waitFor(() => expect(rows()).toHaveLength(9));
		expect(document.querySelector("[data-clear-range]")).toBeNull();
	});

	it("replays: plays, pauses, changes speed, and stops with Esc", async () => {
		renderApp("/s/t1", createFakeServer({ sessions: [session()] }).fetch);
		const replay = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-replay]");
			if (!node) throw new Error("no replay");
			return node;
		});
		expect(replay.dataset.status).toBe("stopped");
		expect(within(replay).getByRole("button", { name: "10×" }).getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(within(replay).getByRole("button", { name: "60×" }));
		expect(within(replay).getByRole("button", { name: "60×" }).getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(within(replay).getByRole("button", { name: "Replay the session" }));
		await waitFor(() => expect(replay.dataset.status).toBe("playing"));
		expect(document.querySelector("[data-playhead]")).not.toBeNull();
		fireEvent.click(within(replay).getByRole("button", { name: "Pause replay" }));
		expect(replay.dataset.status).toBe("paused");
		key("Escape");
		await waitFor(() => expect(replay.dataset.status).toBe("stopped"));
		expect(document.querySelector("[data-playhead]")).toBeNull();
	});

	it("steps from record to record with reduced motion, previewing each in the inspector", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const media = window.matchMedia;
		window.matchMedia = ((query: string) => ({ ...media(query), matches: query.includes("reduce") })) as typeof window.matchMedia;
		try {
			const server = createFakeServer({ sessions: [session()] });
			renderApp("/s/t1", server.fetch);
			fireEvent.click(await screen.findByRole("button", { name: "Replay the session" }));
			const current = () => document.querySelector<HTMLElement>("[data-replay-current]");
			await act(async () => {
				await vi.advanceTimersByTimeAsync(700);
			});
			await waitFor(() => expect(current()?.dataset.kind).toBe("llm"));
			// Replay highlights its record and previews it, but neither selects it nor slides the inspector over the ledger.
			expect(current()?.getAttribute("aria-selected")).toBe("false");
			expect(selected()).toBeNull();
			expect(inspector().querySelector("[data-inspector-preview]")).not.toBeNull();
			expect(slideOver()?.dataset.slideOver).toBe("closed");
			// The preview loads no entries.
			expect(entryCalls(server.calls)).toEqual([]);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(700);
			});
			await waitFor(() => expect(current()?.dataset.kind).toBe("shell"));
			expect(document.querySelectorAll("[data-replay-current]")).toHaveLength(1);
		} finally {
			window.matchMedia = media;
			vi.useRealTimers();
		}
	});
});

describe("session views", () => {
	it("switches between trajectory and transcript and remembers the choice", async () => {
		const server = createFakeServer({ sessions: [session()] });
		const first = renderApp("/s/t1", server.fetch);
		await waitFor(() => expect(document.querySelector("[data-trajectory]")).not.toBeNull());
		const views = screen.getByRole("radiogroup", { name: "View" });
		expect(within(views).getByRole("radio", { name: "Trajectory" }).getAttribute("aria-checked")).toBe("true");
		fireEvent.click(within(views).getByRole("radio", { name: "Transcript" }));
		await waitFor(() => expect(document.querySelector("[data-turn-list]")).not.toBeNull());
		expect(document.querySelector("[data-trajectory]")).toBeNull();
		// The transcript has the compact overview above it, loaded on demand like the trajectory.
		await waitFor(() => expect(document.querySelector("[data-transcript-overview] [data-overview][data-compact]")).not.toBeNull());
		expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBe("transcript");
		first.unmount();

		const second = renderApp("/s/t1", server.fetch);
		await waitFor(() => expect(document.querySelector("[data-turn-list]")).not.toBeNull());
		second.unmount();
		// The URL wins over the stored choice.
		renderApp("/s/t1?view=trajectory", server.fetch);
		await waitFor(() => expect(document.querySelector("[data-trajectory]")).not.toBeNull());
	});

	it("falls back to the transcript when the server has no trace route", async () => {
		renderApp("/s/t1", createFakeServer({ sessions: [session()], trace: false }).fetch);
		expect(await screen.findByText("Transcript only")).toBeTruthy();
		expect(await screen.findByText("Thanks", { selector: "[data-turn] p" })).toBeTruthy();
		expect(document.querySelector("[data-trajectory]")).toBeNull();
	});

	it("deep-links to a record: selects, highlights, and scrolls to it", async () => {
		renderApp("/s/t1?seq=5", createFakeServer({ sessions: [session()] }).fetch);
		// Seq 5 is the read call's result.
		await waitFor(() => expect(document.querySelector("[data-ledger-row][data-highlighted]")?.getAttribute("data-kind")).toBe("read"));
		expect(selected()?.textContent).toContain("src/api.ts");
		expect(document.querySelectorAll("[data-highlighted]")).toHaveLength(1);
	});

	it("deep-links into a collapsed turn of a long session", async () => {
		const entries: Entry[] = [entry(0, header("many"))];
		const turns: Turn[] = [];
		for (let i = 0; i < 45; i++) {
			const seq = 1 + i * 2;
			entries.push(entry(seq, userMessage(`Question ${i}`, i * 10_000)), entry(seq + 1, assistantMessage([{ type: "text", text: `Answer ${i}` }], i * 10_000 + 2000)));
			turns.push(turn(i, seq, seq + 1, { userText: `Question ${i}`, at: iso(i * 10_000), durationMs: 2000 }));
		}
		renderApp("/s/many?seq=6", createFakeServer({ sessions: [{ detail: summary("many", { entryCount: entries.length }), entries, turns }] }).fetch);
		await waitFor(() => expect(document.querySelector("[data-ledger-row][data-highlighted]")?.getAttribute("data-seq")).toBe("6"));
		expect(selected()?.textContent).toContain("Answer 2");
	});
});

describe("live trajectory", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});
	afterEach(() => vi.useRealTimers());

	it("appends new records, shows running tools, and follows the trace", async () => {
		const now = Date.now();
		const at = (ms: number) => new Date(now - 60_000 + ms).toISOString();
		const raw = (seq: number, body: Record<string, unknown>, ms: number) => entry(seq, { ...body, timestamp: at(ms) } as never);
		const fixture: FakeSession = {
			detail: summary("live", { title: "Live session", lastAt: at(5000), entryCount: 3, startedAt: at(0) }),
			entries: [
				entry(0, header("live")),
				raw(1, { type: "message", id: "u", message: { role: "user", content: "Go", timestamp: now - 60_000 } }, 0),
				raw(
					2,
					{
						type: "message",
						id: "a",
						message: { role: "assistant", content: [toolCall("run", "bash", { command: "sleep 100" })], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, timestamp: now - 59_000 },
					},
					1000,
				),
			],
			turns: [turn(0, 1, 2, { userText: "Go", at: at(0), durationMs: 1000 })],
		};
		const server = createFakeServer({ sessions: [fixture] });
		renderApp("/s/live", server.fetch);
		const bash = await waitFor(() => row("[data-kind='shell']"));
		expect(bash.dataset.running).toBe("true");
		expect(bash.textContent).toContain("running");

		fixture.entries.push(
			raw(3, { type: "message", id: "r", message: { role: "toolResult", toolCallId: "run", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: now - 2000 } }, 58_000),
			raw(4, { type: "message", id: "b", message: { role: "assistant", content: [{ type: "text", text: "All done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, timestamp: now - 1000 } }, 59_000),
		);
		fixture.turns[0] = { ...fixture.turns[0], endSeq: 4 };
		fixture.detail = { ...fixture.detail, entryCount: 5, lastAt: new Date().toISOString() };
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		// The trace refetches at most every 10 s.
		expect(server.calls.filter((call) => call === "/api/v1/sessions/live/trace")).toHaveLength(1);
		const traceCalls = () => server.calls.filter((call) => call === "/api/v1/sessions/live/trace").length;
		for (let waited = 0; traceCalls() < 2 && waited <= TRACE_REFRESH_MS; waited += 500) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});
		}
		await waitFor(() => expect(traceCalls()).toBe(2));
		const added = await waitFor(() => row("[data-seq='4']"));
		expect(added.textContent).toContain("All done");
		expect(added.classList).toContain("row-in");
		expect(row("[data-kind='shell']").dataset.running).toBeUndefined();
	});
});

describe("subagents in the ledger", () => {
	it("expands an Agent row into its child's records lazily, and nests again", async () => {
		const server = createFakeServer({ sessions: agents() });
		renderApp("/s/p1", server.fetch);
		const agent = await waitFor(() => row("[data-kind='agent'][data-seq='2']"));
		expect(agent.textContent).toContain("worker");
		expect(agent.textContent).toContain("Fix tests");
		expect(server.calls.some((call) => call.startsWith("/api/v1/sessions/c1"))).toBe(false);
		fireEvent.click(within(agent).getByRole("button", { name: "Expand subagent" }));
		await waitFor(() => expect(document.querySelectorAll("[data-ledger-row][data-depth='1']").length).toBeGreaterThan(0));
		expect(server.calls).toContain("/api/v1/sessions/c1/trace");
		expect(server.calls.some((call) => call.startsWith("/api/v1/sessions/c1/entries"))).toBe(false);
		const nested = row("[data-depth='1'][data-kind='agent']");
		expect(nested.textContent).toContain("recon");
		expect(within(nested).getByRole("link", { name: /Open as page/ }).getAttribute("href")).toBe("/s/c1n");
		fireEvent.click(within(nested).getByRole("button", { name: "Expand subagent" }));
		await waitFor(() => expect(document.querySelector("[data-ledger-row][data-depth='2'][data-kind='read']")).not.toBeNull());
		expect(server.calls).toContain("/api/v1/sessions/c1n/trace");

		// Selecting a nested record inspects the child session's entries.
		fireEvent.click(row("[data-depth='2'][data-kind='read']"));
		await waitFor(() => expect(entryCalls(server.calls)).toContain("/api/v1/sessions/c1n/entries?from=2&to=2&limit=1"));
	});

	it("lists a workflow's children as rows, each expandable", async () => {
		const server = createFakeServer({ sessions: agents() });
		renderApp("/s/p1", server.fetch);
		const workflow = await waitFor(() => row("[data-kind='agent'][data-seq='4']"));
		expect(workflow.textContent).toContain("review-fanout");
		expect(workflow.textContent).toContain("2 agents");
		fireEvent.click(within(workflow).getByRole("button", { name: "Expand subagent" }));
		await waitFor(() => expect(document.querySelectorAll("[data-ledger-row][data-record='child']")).toHaveLength(2));
		const children = [...document.querySelectorAll<HTMLElement>("[data-ledger-row][data-record='child']")];
		expect(children.map((node) => node.dataset.child)).toEqual(["w1", "w2"]);
		expect(server.calls.some((call) => call.includes("/w1/") || call.includes("/w2/"))).toBe(false);
		fireEvent.click(within(children[1]).getByRole("button", { name: "Expand subagent" }));
		await waitFor(() => expect(server.calls).toContain("/api/v1/sessions/w2/trace"));
		expect(server.calls).not.toContain("/api/v1/sessions/w1/trace");
	});
});

describe("trajectory virtualization", () => {
	it("keeps a 5,000-entry session under 300 entry nodes, expanded and scrolled", async () => {
		restore();
		restore = mockLayout({ viewport: 800, rowHeight: 100 });
		const entries: Entry[] = [entry(0, header("big")), entry(1, userMessage("Run the migration"))];
		let seq = 2;
		let call = 0;
		const turns: Turn[] = [];
		let start = 1;
		while (seq < 5000) {
			const id = `call_${call++}`;
			entries.push(entry(seq++, assistantMessage([toolCall(id, "bash", { command: `step ${id}` })], seq * 100)));
			entries.push(entry(seq++, toolResultMessage(id, "bash", `done ${id}`, { at: seq * 100 })));
			if (call % 100 === 0) {
				turns.push(turn(turns.length, start, seq - 1, { at: iso(start * 100), durationMs: (seq - start) * 100 }));
				if (seq < 5000) entries.push(entry(seq, userMessage(`Continue ${turns.length}`, seq * 100)));
				start = seq++;
			}
		}
		expect(entries.length).toBeGreaterThanOrEqual(5000);
		const server = createFakeServer({ sessions: [{ detail: summary("big", { entryCount: entries.length }), entries, turns }] });
		renderApp("/s/big", server.fetch);
		const count = () => document.querySelectorAll("[data-turn], [data-entry-seq]").length;
		await waitFor(() => expect(count()).toBeGreaterThan(0));
		expect(count()).toBeLessThan(300);
		fireEvent.click(screen.getByRole("button", { name: /Collapse all|Expand all/ }));
		if (screen.queryByRole("button", { name: "Expand all" })) fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
		await waitFor(() => expect(document.querySelector("[data-ledger-count]")?.textContent).toBe("5k records"));
		const pane = document.querySelector<HTMLElement>("[data-ledger] [data-scroll-pane]")!;
		for (const fraction of [0.25, 0.5, 0.99]) {
			await act(async () => {
				pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * fraction;
				pane.dispatchEvent(new Event("scroll"));
			});
			await waitFor(() => expect(rows().length).toBeGreaterThan(0));
			expect(count()).toBeLessThan(300);
		}
		expect(Math.max(...rows().map((node) => Number(node.dataset.seq)))).toBeGreaterThan(4000);
		// Nothing but the trace was fetched.
		expect(entryCalls(server.calls)).toEqual([]);
	});
});
