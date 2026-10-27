import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Entry, Turn } from "../src/lib/types";
import { assistantMessage, entry, header, summary, toolCall, toolResultMessage, turn, userMessage } from "./support/fixtures";
import { mockLayout, renderApp, scrollMain } from "./support/render";
import { createFakeServer, type FakeSession } from "./support/server";

const ROW_HEIGHT = 100;
const VIEWPORT = 800;
const ENTRY_NODES = "[data-turn], [data-entry-seq]";

function entryNodeCount(): number {
	return document.querySelectorAll(ENTRY_NODES).length;
}

function scrollRoot(): HTMLElement {
	return document.querySelector<HTMLElement>("[data-scroll-root]")!;
}

/** Scrolls down by `delta`, clamped to the content height. */
async function scrollBy(delta: number) {
	await act(async () => scrollMain(scrollRoot().scrollTop + delta));
}

function renderedSeqs(): number[] {
	return [...document.querySelectorAll("[data-entry-seq]")].map((node) => Number(node.getAttribute("data-entry-seq")));
}

/** 2,500 short turns: a prompt and an answer each, 5,000 entries in total. */
function manyTurns(): FakeSession {
	const entries: Entry[] = [entry(0, header("many"))];
	const turns: Turn[] = [];
	for (let i = 0; i < 2500; i++) {
		const seq = 1 + i * 2;
		entries.push(entry(seq, userMessage(`Question ${i}`)));
		entries.push(entry(seq + 1, assistantMessage([{ type: "text", text: `Answer ${i}` }])));
		turns.push(turn(i, seq, seq + 1, { userText: `Question ${i}`, finalText: `Answer ${i}` }));
	}
	return { detail: summary("many", { entryCount: entries.length }), entries, turns };
}

/** One turn holding 5,000 entries: a prompt, then bash calls and their results. */
function longTurn(): FakeSession {
	const entries: Entry[] = [
		entry(0, header("long")),
		entry(1, userMessage("Run the whole migration")),
		entry(2, { type: "thinking_level_change", id: "t1", parentId: null, timestamp: "2026-10-20T09:00:01.000Z", thinkingLevel: "high" }),
	];
	let seq = 3;
	let call = 0;
	while (seq < 4998) {
		const id = `call_${call++}`;
		entries.push(entry(seq++, assistantMessage([toolCall(id, "bash", { command: `step ${id}` })])));
		entries.push(entry(seq++, toolResultMessage(id, "bash", `done ${id}`)));
	}
	entries.push(entry(seq, assistantMessage([{ type: "text", text: "Migration finished." }])));
	return {
		detail: summary("long", { entryCount: entries.length }),
		entries,
		turns: [turn(0, 1, seq, { userText: "Run the whole migration", finalText: "Migration finished." })],
	};
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: VIEWPORT, rowHeight: ROW_HEIGHT });
});
afterEach(() => restore());

describe("virtualization", () => {
	it("keeps a 5,000-entry session with 2,500 prompt cards under 300 entry nodes", async () => {
		const fixture = manyTurns();
		expect(fixture.entries.length).toBe(5001);
		const server = createFakeServer({ sessions: [fixture] });
		renderApp("/s/many?view=transcript", server.fetch);
		await screen.findByText("Question 0");
		expect(entryNodeCount()).toBeGreaterThan(0);
		expect(entryNodeCount()).toBeLessThan(300);

		// Scroll through the loaded turns; more pages load and the DOM stays small.
		for (let step = 1; step <= 12; step++) {
			await scrollBy(5_000);
			await waitFor(() => expect(document.querySelectorAll("[data-turn]").length).toBeGreaterThan(0));
			expect(entryNodeCount()).toBeLessThan(300);
		}
		await waitFor(() => expect(server.calls.filter((call) => call.includes("/turns")).length).toBeGreaterThan(1));
		expect(screen.queryByText("Question 0")).toBeNull();
		const turnsShown = [...document.querySelectorAll("[data-turn]")].map((node) => Number(node.getAttribute("data-turn")));
		expect(Math.min(...turnsShown)).toBeGreaterThan(100);
	});

	it("keeps an expanded 5,000-entry turn under 300 entry nodes while paging", async () => {
		const fixture = longTurn();
		expect(fixture.entries.length).toBe(5000);
		const server = createFakeServer({ sessions: [fixture] });
		renderApp("/s/long?view=transcript", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: /model calls/ }));
		await waitFor(() => expect(document.querySelectorAll("[data-entry-seq]").length).toBeGreaterThan(0));
		expect(entryNodeCount()).toBeLessThan(300);
		const entryCalls = () => server.calls.filter((call) => call.includes("/entries"));
		expect(entryCalls()).toEqual(["/api/v1/sessions/long/entries?from=1&to=4999&limit=200"]);

		let previousMax = Math.max(...renderedSeqs());
		for (let step = 1; step <= 14; step++) {
			await scrollBy(15_000);
			await waitFor(() => expect(Math.max(...renderedSeqs(), 0)).toBeGreaterThan(previousMax));
			expect(entryNodeCount()).toBeLessThan(300);
			previousMax = Math.max(...renderedSeqs());
		}
		// Pages load lazily as the timeline scrolls, chained by the last seq of each page.
		expect(entryCalls().length).toBeGreaterThan(2);
		expect(entryCalls().length).toBeLessThan(25);
		expect(entryCalls()[1]).toBe("/api/v1/sessions/long/entries?from=201&to=4999&limit=200");
		expect(Math.min(...renderedSeqs())).toBeGreaterThan(1000);
	});
});
