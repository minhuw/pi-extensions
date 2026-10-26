import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isLive, LIVE_POLL_MS } from "../src/session/live";
import { assistantMessage, entry, header, summary, turn, userMessage } from "./support/fixtures";
import { mockLayout, renderApp } from "./support/render";
import { createFakeServer, type FakeSession } from "./support/server";

function liveSession(lastAt: string): FakeSession {
	const entries = [
		entry(0, header("live")),
		entry(1, userMessage("First prompt")),
		entry(2, assistantMessage([{ type: "text", text: "First answer" }])),
		entry(3, userMessage("Second prompt")),
		entry(4, assistantMessage([{ type: "text", text: "Working on it" }])),
	];
	return {
		detail: summary("live", { title: "Live session", lastAt, entryCount: entries.length }),
		entries,
		turns: [
			turn(0, 1, 2, { userText: "First prompt", finalText: "First answer", modelCalls: 1, toolCalls: 0 }),
			turn(1, 3, 4, { userText: "Second prompt", finalText: "Working on it", modelCalls: 1, toolCalls: 0 }),
		],
	};
}

/** Appends an answer to the last turn, as a device would while the session runs. */
function grow(fixture: FakeSession) {
	fixture.entries.push(entry(5, assistantMessage([{ type: "text", text: "Finished the second prompt" }], 9000)));
	fixture.turns[1] = { ...fixture.turns[1], endSeq: 5, modelCalls: 2, finalText: "Finished the second prompt" };
	fixture.detail = { ...fixture.detail, entryCount: 6, lastAt: new Date().toISOString() };
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
	vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
	vi.useRealTimers();
	restore();
});

function entryCalls(calls: string[]) {
	return calls.filter((call) => call.includes("/entries"));
}

describe("live updates", () => {
	it("polls updates and refreshes only the affected turn", async () => {
		const fixture = liveSession(new Date(Date.now() - 10_000).toISOString());
		const server = createFakeServer({ sessions: [fixture] });
		renderApp("/s/live", server.fetch);
		expect(await screen.findByText("live")).toBeTruthy();
		// Expand both turns so each has cached entries.
		for (const strip of await screen.findAllByRole("button", { name: /1 model call/ })) fireEvent.click(strip);
		await screen.findByText("Working on it", { selector: "[data-entry-seq] p" });
		expect(entryCalls(server.calls)).toEqual([
			"/api/v1/sessions/live/entries?from=1&to=2&limit=200",
			"/api/v1/sessions/live/entries?from=3&to=4&limit=200",
		]);

		grow(fixture);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		await waitFor(() => expect(server.calls).toContain("/api/v1/sessions/live/updates?since=4"));
		expect(await screen.findByText("Finished the second prompt", { selector: "[data-entry-seq] p" })).toBeTruthy();
		expect(screen.getByText("Finished the second prompt", { selector: "[data-final-answer] p" })).toBeTruthy();
		// The first turn's entries were not fetched again; the second turn's were.
		expect(entryCalls(server.calls)).toEqual([
			"/api/v1/sessions/live/entries?from=1&to=2&limit=200",
			"/api/v1/sessions/live/entries?from=3&to=4&limit=200",
			"/api/v1/sessions/live/entries?from=3&to=5&limit=200",
		]);
		expect(server.calls.filter((call) => call.includes("/turns"))).toHaveLength(1);

		// The next poll asks only for what came after the new last seq.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		await waitFor(() => expect(server.calls).toContain("/api/v1/sessions/live/updates?since=5"));
	});

	it("falls back to the summary when the server has no updates route", async () => {
		const fixture = liveSession(new Date(Date.now() - 10_000).toISOString());
		const server = createFakeServer({ sessions: [fixture], updates: false });
		renderApp("/s/live", server.fetch);
		await screen.findByText("Working on it", { selector: "[data-final-answer] p" });
		grow(fixture);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		await waitFor(() => expect(server.calls.filter((call) => call.endsWith("/updates?since=4"))).toHaveLength(1));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		expect(await screen.findByText("Finished the second prompt", { selector: "[data-final-answer] p" })).toBeTruthy();
	});

	it("does not poll sessions idle for more than two minutes", async () => {
		const server = createFakeServer({ sessions: [liveSession(new Date(Date.now() - 5 * 60_000).toISOString())] });
		renderApp("/s/live", server.fetch);
		await screen.findByText("Working on it", { selector: "[data-final-answer] p" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 2);
		});
		expect(server.calls.some((call) => call.includes("/updates"))).toBe(false);
		expect(screen.queryByText("live")).toBeNull();
		expect(isLive(new Date(Date.now() - 119_000).toISOString())).toBe(true);
		expect(isLive(new Date(Date.now() - 121_000).toISOString())).toBe(false);
	});
});
