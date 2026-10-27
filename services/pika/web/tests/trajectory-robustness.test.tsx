// The trajectory view against what live sessions really send: missing times, crashes, keys on other controls, records
// that change while selected, replay over folded turns, the live tail, and assistive technology.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSession, Entry } from "../src/lib/types";
import { foldGaps, layoutOverview, makeScale, overviewLanes, traceIntervals } from "../src/trace/axis";
import { assistantMessage, entry, header, summary, toolCall, turn, userMessage } from "./support/fixtures";
import { mockLayout, renderApp } from "./support/render";
import { createFakeServer, traceOf, type FakeSession } from "./support/server";
import { entryCalls, inspector, key, manyTurns, row, rows, selected, session, slideOver } from "./support/trajectory";

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
});
afterEach(() => restore());

function pane(): HTMLElement {
	return document.querySelector<HTMLElement>("[data-ledger] [data-scroll-pane]")!;
}

function scrollPane(top: number) {
	const node = pane();
	act(() => {
		node.scrollTop = Math.max(0, Math.min(top, node.scrollHeight - node.clientHeight));
		node.dispatchEvent(new Event("scroll"));
	});
}

/** Advances fake time until the trace of `id` was fetched `count` times; the live trace refetches at most every 10 s. */
async function traceFetches(server: { calls: string[] }, id: string, count: number) {
	const fetched = () => server.calls.filter((call) => call === `/api/v1/sessions/${id}/trace`).length;
	for (let waited = 0; fetched() < count && waited <= 15_000; waited += 500) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
	}
	await waitFor(() => expect(fetched()).toBe(count));
}

function reducedMotion(): () => void {
	const media = window.matchMedia;
	window.matchMedia = ((query: string) => ({ ...media(query), matches: query.includes("reduce") })) as typeof window.matchMedia;
	return () => {
		window.matchMedia = media;
	};
}

describe("a trace with missing times", () => {
	/** A live session whose subagents just started: no entries, so the trace gives them no times. */
	function spawning(): FakeSession[] {
		const now = Date.now();
		const iso = (ms: number) => new Date(now - 30_000 + ms).toISOString();
		const child = (id: string, callId: string, entryCount: number): ChildSession => ({
			...summary(id, { parentSessionId: "p", entryCount, startedAt: iso(2000), lastAt: iso(entryCount ? 9000 : 2000), title: `Child ${id}` }),
			parentToolCallId: callId,
			link: { kind: "subagent", parentSessionId: "p", parentToolCallId: callId, agentType: "worker", description: `Work ${id}` },
		});
		const children = [child("fresh", "call_new", 0), child("wf_a", "call_wf", 0), child("wf_b", "call_wf", 3)];
		const entries: Entry[] = [
			entry(0, header("p")),
			entry(1, userMessage("Delegate", now - 30_000)),
			entry(
				2,
				assistantMessage(
					[toolCall("call_new", "Agent", { subagent_type: "worker", description: "Fix tests" }), toolCall("call_wf", "SubagentWorkflow", { name: "fanout" })],
					now - 28_000,
				),
			),
		];
		const empty = (id: string): FakeSession => ({ detail: summary(id, { entryCount: 0, parentSessionId: "p" }), entries: [], turns: [] });
		return [
			{
				detail: summary("p", { title: "Delegating", entryCount: entries.length, lastAt: iso(2000), childCount: children.length, children }),
				entries,
				turns: [turn(0, 1, 2, { userText: "Delegate", at: iso(0), durationMs: 2000, modelCalls: 1, toolCalls: 2 })],
			},
			empty("fresh"),
			empty("wf_a"),
			{ ...empty("wf_b"), detail: summary("wf_b", { entryCount: 3, parentSessionId: "p" }) },
		];
	}

	it("renders a subagent that just started in the trajectory, the inspector, and the transcript's overview", async () => {
		const errors = vi.spyOn(console, "error");
		const sessions = spawning();
		// The trace leaves the new children's times out, as the server does.
		expect(traceOf(sessions[0]).children.map((child) => [child.sessionId, child.startedAt === undefined])).toEqual([
			["fresh", true],
			["wf_a", true],
			["wf_b", false],
		]);
		const server = createFakeServer({ sessions });
		renderApp("/s/p", server.fetch);
		const workflow = await waitFor(() => row("[data-kind='agent'][data-seq='2'][data-running]:not([data-depth])"));
		expect(document.querySelector("[data-overview]")).not.toBeNull();
		// The overview places the new child on its Agent call.
		const trace = traceOf(sessions[0]);
		const agents = layoutOverview(trace, makeScale(foldGaps(traceIntervals(trace)), 800), overviewLanes(false)).filter((item) => item.lane === "agents");
		expect(agents.map((item) => item.childId).sort()).toEqual(["fresh", "wf_a", "wf_b"]);

		const flow = rows().find((node) => node.textContent?.includes("fanout"))!;
		fireEvent.click(within(flow).getByRole("button", { name: "Expand subagent" }));
		const fresh = await waitFor(() => row("[data-record='child'][data-child='wf_a']"));
		expect(fresh.textContent).toContain("—");
		fireEvent.click(fresh);
		await waitFor(() => expect(inspector().textContent).toContain("Work wf_a"));
		expect(inspector().textContent).toContain("—");
		fireEvent.click(within(workflow).getByRole("button", { name: "Expand subagent" }));
		await waitFor(() => expect(document.querySelector("[data-ledger-status='empty']")).not.toBeNull());
		for (const bad of ["NaN", "Invalid Date", "1970"]) expect(document.body.textContent).not.toContain(bad);

		fireEvent.click(screen.getByRole("radio", { name: "Transcript" }));
		await waitFor(() => expect(document.querySelector("[data-transcript-overview] [data-overview]")).not.toBeNull());
		expect(document.querySelector("[data-trajectory-error], [data-overview-error]")).toBeNull();
		expect(errors.mock.calls.some((call) => String(call[0]).includes("failed to render"))).toBe(false);
	});

	it("shows a calm error with a link to the transcript when the trajectory cannot render, and logs it", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const fixture = session();
		const broken = { ...traceOf(fixture), children: [null] };
		renderApp("/s/t1", createFakeServer({ sessions: [fixture], traces: { t1: broken } }).fetch);
		expect(await screen.findByText("The trajectory view could not be shown")).toBeTruthy();
		expect(errors.mock.calls.some((call) => String(call[0]).includes("pika: the trajectory view failed to render"))).toBe(true);
		// The header and its view switch still work.
		expect(screen.getByRole("heading", { name: "Fix the flaky test", level: 1 })).toBeTruthy();
		fireEvent.click(screen.getByRole("link", { name: "Open the transcript" }));
		await waitFor(() => expect(document.querySelector("[data-turn-list]")).not.toBeNull());
		// The transcript's overview fails on its own; the transcript stays.
		await waitFor(() => expect(document.querySelector("[data-transcript-overview] [data-overview-error]")).not.toBeNull());
		expect(errors.mock.calls.some((call) => String(call[0]).includes("pika: the transcript's timeline failed to render"))).toBe(true);
		expect(await screen.findByText("Thanks", { selector: "[data-turn] p" })).toBeTruthy();
	});
});

describe("keyboard scope", () => {
	it("moves through the ledger only from the ledger or the page, never from controls or the inspector", async () => {
		renderApp("/s/t1", createFakeServer({ sessions: [session()] }).fetch);
		await waitFor(() => expect(rows()).toHaveLength(9));
		const replay = document.querySelector<HTMLElement>("[data-replay]")!;
		const speed = within(replay).getByRole("button", { name: "60×" });
		const view = screen.getByRole("radio", { name: "Trajectory" });
		const exportLink = screen.getByRole("link", { name: /Export JSONL/ });
		// `fireEvent` answers false when a handler prevented the default.
		for (const target of [speed, view, exportLink]) {
			for (const name of ["ArrowDown", "ArrowUp", "j", "k", "Enter", "[", "]", "ArrowRight"]) {
				expect(fireEvent.keyDown(target, { key: name }), `${name} on ${target.textContent}`).toBe(true);
			}
		}
		expect(selected()).toBeNull();

		const listbox = screen.getByRole("listbox", { name: "Session records" });
		expect(fireEvent.keyDown(listbox, { key: "j" })).toBe(false);
		await waitFor(() => expect(selected()?.dataset.seq).toBe("2"));
		fireEvent.keyDown(listbox, { key: "j" });
		await waitFor(() => expect(selected()?.dataset.kind).toBe("shell"));

		// Keys inside the inspector are its own: its tabs and its scroll pane.
		const tab = within(inspector()).getByRole("tab", { name: "Input" });
		const scroller = inspector().querySelector<HTMLElement>("[data-scroll-pane]")!;
		for (const target of [tab, scroller]) for (const name of ["ArrowDown", "ArrowUp", "Enter", "j"]) expect(fireEvent.keyDown(target, { key: name })).toBe(true);
		expect(selected()?.dataset.kind).toBe("shell");

		// `/` and Esc work from a button; `/` focuses the filter instead of opening search.
		expect(fireEvent.keyDown(speed, { key: "/" })).toBe(false);
		expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter records" }));
		expect(screen.getByRole("heading", { name: "Fix the flaky test", level: 1 })).toBeTruthy();
		fireEvent.click(within(replay).getByRole("button", { name: "Replay the session" }));
		await waitFor(() => expect(replay.dataset.status).toBe("playing"));
		fireEvent.keyDown(within(replay).getByRole("button", { name: "Pause replay" }), { key: "Escape" });
		await waitFor(() => expect(replay.dataset.status).toBe("stopped"));
	});

	it("leaves j, k, and / to the transcript and the site search there", async () => {
		localStorage.setItem("pika-session-view", "transcript");
		renderApp("/s/t1", createFakeServer({ sessions: [session()] }).fetch);
		await waitFor(() => expect(document.querySelector("[data-turn='1']")).not.toBeNull());
		const active = () => document.querySelector("[data-turn][data-active]")?.getAttribute("data-turn");
		key("j");
		await waitFor(() => expect(active()).toBe("0"));
		key("j");
		await waitFor(() => expect(active()).toBe("1"));
		key("k");
		await waitFor(() => expect(active()).toBe("0"));
		key("/");
		expect(await screen.findByRole("searchbox", { name: /Search/ })).toBeTruthy();
	});
});

describe("a selected record in a live session", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});
	afterEach(() => vi.useRealTimers());

	it("shows a running tool's result in the inspector once it arrives", async () => {
		const now = Date.now();
		const at = (ms: number) => new Date(now - 60_000 + ms).toISOString();
		const raw = (seq: number, body: Record<string, unknown>, ms: number) => entry(seq, { ...body, timestamp: at(ms) } as never);
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
		const fixture: FakeSession = {
			detail: summary("live", { title: "Live session", lastAt: at(5000), entryCount: 3, startedAt: at(0) }),
			entries: [
				entry(0, header("live")),
				raw(1, { type: "message", id: "u", message: { role: "user", content: "Go", timestamp: now - 60_000 } }, 0),
				raw(2, { type: "message", id: "a", message: { role: "assistant", content: [toolCall("run", "bash", { command: "make check" })], usage, timestamp: now - 59_000 } }, 1000),
			],
			turns: [turn(0, 1, 2, { userText: "Go", at: at(0), durationMs: 1000 })],
		};
		const server = createFakeServer({ sessions: [fixture] });
		renderApp("/s/live", server.fetch);
		fireEvent.click(await waitFor(() => row("[data-kind='shell'][data-running]")));
		fireEvent.click(within(inspector()).getByRole("tab", { name: "Output" }));
		await waitFor(() => expect(inspector().textContent).toContain("No result recorded."));

		fixture.entries.push(
			raw(3, { type: "message", id: "r", message: { role: "toolResult", toolCallId: "run", toolName: "bash", content: [{ type: "text", text: "all checks passed" }], isError: false, timestamp: now - 2000 } }, 58_000),
		);
		fixture.turns[0] = { ...fixture.turns[0], endSeq: 3 };
		fixture.detail = { ...fixture.detail, entryCount: 4, lastAt: new Date().toISOString() };
		await traceFetches(server, "live", 2);
		await waitFor(() => expect(inspector().textContent).toContain("all checks passed"));
		expect(entryCalls(server.calls)).toContain("/api/v1/sessions/live/entries?from=3&to=3&limit=1");
		expect(row("[data-kind='shell']").dataset.running).toBeUndefined();
		expect(selected()?.dataset.kind).toBe("shell");
	});
});

describe("replay", () => {
	it("follows the playhead into collapsed turns for the replay only, without selecting or sliding the inspector over", async () => {
		const media = reducedMotion();
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			renderApp("/s/many", createFakeServer({ sessions: [manyTurns("many")] }).fetch);
			await waitFor(() => expect(rows().map((node) => node.dataset.turnIndex)).toEqual(["42", "43", "44"]));
			fireEvent.click(screen.getByRole("button", { name: "Replay the session" }));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(700);
			});
			// The first record sits in turn 0, which is collapsed: the replay opens it to show it.
			const current = await waitFor(() => {
				const node = document.querySelector<HTMLElement>("[data-replay-current]");
				if (!node) throw new Error("no current record");
				return node;
			});
			expect(current.dataset.turnIndex).toBe("0");
			expect(current.getAttribute("aria-selected")).toBe("false");
			expect(selected()).toBeNull();
			expect(slideOver()?.dataset.slideOver).toBe("closed");
			expect(slideOver()?.hasAttribute("inert")).toBe(true);
			key("Escape");
			// Stopping folds it again: the reader's turns are as they were.
			await waitFor(() => expect(rows().map((node) => node.dataset.turnIndex)).toEqual(["42", "43", "44"]));
			expect(selected()).toBeNull();
		} finally {
			vi.useRealTimers();
			media();
		}
	});

	it("drops a reveal whose record a filter hides, instead of revealing it when the filter clears", async () => {
		const fixture = session();
		renderApp("/s/t1", createFakeServer({ sessions: [fixture] }).fetch);
		await waitFor(() => expect(rows()).toHaveLength(9));
		const filter = screen.getByRole("searchbox", { name: "Filter records" });
		fireEvent.change(filter, { target: { value: "grep" } });
		await waitFor(() => expect(rows().map((node) => node.dataset.kind)).toEqual(["read"]));
		// Click the edit call, which the filter hides, on the overview.
		const trace = traceOf(fixture);
		const edit = layoutOverview(trace, makeScale(foldGaps(traceIntervals(trace)), 800), overviewLanes(false)).find((item) => item.key === "t:t1:c_edit")!;
		const plot = document.querySelector<HTMLElement>("[data-overview-plot]")!;
		const at = { clientX: (edit.x0 + edit.x1) / 2, clientY: (edit.y0 + edit.y1) / 2, button: 0 };
		fireEvent.pointerDown(plot, at);
		fireEvent.pointerUp(plot, at);
		await act(async () => {});
		expect(selected()).toBeNull();
		fireEvent.change(filter, { target: { value: "" } });
		await waitFor(() => expect(rows()).toHaveLength(9));
		await act(async () => {});
		expect(selected()).toBeNull();
		expect(document.querySelector("[data-highlighted]")).toBeNull();
	});
});

describe("the live tail", () => {
	beforeEach(() => {
		restore();
		restore = mockLayout({ viewport: 400, rowHeight: 34 });
	});

	it("opens a finished session at the top and a live one at its tail", async () => {
		const done = renderApp("/s/done", createFakeServer({ sessions: [manyTurns("done")] }).fetch);
		await waitFor(() => expect(document.querySelector("[data-turn='0'][data-turn-head]")).not.toBeNull());
		expect(pane().scrollTop).toBe(0);
		done.unmount();

		renderApp("/s/live", createFakeServer({ sessions: [manyTurns("live", 45, { lastAt: new Date().toISOString() })] }).fetch);
		await waitFor(() => expect(pane().scrollTop).toBeGreaterThan(0));
		expect(pane().scrollTop).toBe(pane().scrollHeight - pane().clientHeight);
		expect(row("[data-seq='90']").textContent).toContain("Answer 44");
	});

	it("follows arriving records only from the tail, and neither scrolls nor fades in rows that expanding reveals", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const fixture = manyTurns("live", 45, { lastAt: new Date().toISOString() });
			const server = createFakeServer({ sessions: [fixture] });
			renderApp("/s/live", server.fetch);
			await waitFor(() => expect(pane().scrollTop).toBeGreaterThan(0));
			const bottom = () => pane().scrollHeight - pane().clientHeight;
			const top = pane().scrollTop;
			expect(top).toBe(bottom());

			fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
			fireEvent.click(await screen.findByRole("button", { name: "Expand all" }));
			await waitFor(() => expect(bottom()).toBeGreaterThan(top + 400));
			// Expanding moved the tail down; the ledger stays where it was, and nothing fades in.
			expect(pane().scrollTop).toBe(top);
			expect(document.querySelector(".row-in")).toBeNull();

			const append = (n: number) => {
				const seq = fixture.entries.length;
				fixture.entries.push(entry(seq, userMessage(`Question ${n}`, n * 10_000)), entry(seq + 1, assistantMessage([{ type: "text", text: `Answer ${n}` }], n * 10_000 + 2000)));
				fixture.turns.push(turn(n, seq, seq + 1, { userText: `Question ${n}`, at: new Date(n * 10_000).toISOString(), durationMs: 2000 }));
				fixture.detail = { ...fixture.detail, entryCount: fixture.entries.length, lastAt: new Date().toISOString() };
			};
			// Not at the tail: a new record does not pull the reader down.
			append(45);
			await traceFetches(server, "live", 2);
			await waitFor(() => expect(document.querySelector("[data-turn='45']") ?? rows().length).toBeTruthy());
			expect(pane().scrollTop).toBe(top);

			// Back at the tail, the ledger follows, and the arriving row fades in.
			scrollPane(bottom());
			append(46);
			await traceFetches(server, "live", 3);
			await waitFor(() => expect(pane().scrollTop).toBe(bottom()));
			const added = await waitFor(() => row("[data-seq='94']"));
			expect(added.classList).toContain("row-in");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("accessibility", () => {
	it("gives turn headers an option role and an id, and points aria-activedescendant only at a rendered row", async () => {
		restore();
		restore = mockLayout({ viewport: 400, rowHeight: 34 });
		renderApp("/s/many", createFakeServer({ sessions: [manyTurns("many")] }).fetch);
		const listbox = await screen.findByRole("listbox", { name: "Session records" });
		fireEvent.click(await screen.findByRole("button", { name: "Collapse all" }));
		fireEvent.click(await screen.findByRole("button", { name: "Expand all" }));
		await waitFor(() => expect(rows().length).toBeGreaterThan(5));
		const options = within(listbox).getAllByRole("option");
		const heads = options.filter((option) => option.hasAttribute("data-turn-head"));
		expect(heads.length).toBeGreaterThan(0);
		expect(heads[0].getAttribute("aria-label")).toMatch(/^Turn \d+: Question \d+$/);
		expect(options.every((option) => option.id && document.getElementById(option.id) === option)).toBe(true);

		fireEvent.keyDown(listbox, { key: "j" });
		await waitFor(() => expect(selected()).not.toBeNull());
		const id = listbox.getAttribute("aria-activedescendant");
		expect(id).toBe(selected()!.id);
		expect(document.getElementById(id!)).toBe(selected());
		// Scrolled far away, the selected row is not rendered, so nothing points at it.
		scrollPane(pane().scrollHeight);
		await waitFor(() => expect(selected()).toBeNull());
		expect(listbox.hasAttribute("aria-activedescendant")).toBe(false);
	});

	it("keeps the closed slide-over inert and returns focus to the ledger when it closes", async () => {
		renderApp("/s/t1", createFakeServer({ sessions: [session()] }).fetch);
		await waitFor(() => expect(rows()).toHaveLength(9));
		const aside = slideOver()!;
		expect(aside.hasAttribute("inert")).toBe(true);
		expect(aside.getAttribute("aria-hidden")).toBe("true");
		fireEvent.click(row("[data-kind='shell']"));
		await waitFor(() => expect(aside.dataset.slideOver).toBe("open"));
		expect(aside.hasAttribute("inert")).toBe(false);
		expect(aside.hasAttribute("aria-hidden")).toBe(false);
		// Enter moves focus into the inspector; Esc closes it and brings focus back to the ledger.
		key("Enter");
		await waitFor(() => expect(document.activeElement).toBe(inspector()));
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		await waitFor(() => expect(aside.dataset.slideOver).toBe("closed"));
		expect(aside.hasAttribute("inert")).toBe(true);
		expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Session records" }));
		// The selection stays; Esc again clears it.
		expect(selected()?.dataset.kind).toBe("shell");
	});
});

describe("transcript deep links", () => {
	it("opens the tool call whose result `?seq=` names, and only that one", async () => {
		renderApp("/s/t1?view=transcript&seq=5", createFakeServer({ sessions: [session()] }).fetch);
		// Seq 5 is the read call's result; the call is at seq 4 with a grep beside it.
		const target = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-entry-seq='4'][data-highlighted]");
			if (!node) throw new Error("no highlighted entry");
			return node;
		});
		const read = target.querySelector<HTMLElement>("[data-tool='read'] > button")!;
		await waitFor(() => expect(read.getAttribute("aria-expanded")).toBe("true"));
		expect(target.textContent).toContain("export const base");
		const grep = document.querySelector<HTMLElement>("[data-tool-name='grep'] > button")!;
		expect(grep.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelectorAll("[data-highlighted]")).toHaveLength(1);
	});
});
