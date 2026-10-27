import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSession, Entry } from "../src/lib/types";
import { applySessionUpdates, isLive, LIVE_POLL_MS, TRACE_REFRESH_MS } from "../src/session/live";
import { assistantMessage, entry, header, summary, toolCall, turn, userMessage } from "./support/fixtures";
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
		renderApp("/s/live?view=transcript", server.fetch);
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

	it("stops polling when the server has no updates route", async () => {
		const fixture = liveSession(new Date(Date.now() - 10_000).toISOString());
		const server = createFakeServer({ sessions: [fixture], updates: false });
		renderApp("/s/live?view=transcript", server.fetch);
		await screen.findByText("Working on it", { selector: "[data-final-answer] p" });
		grow(fixture);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 3);
		});
		expect(server.calls.filter((call) => call.includes("/updates"))).toEqual(["/api/v1/sessions/live/updates?since=4"]);
		// No fallback refetches the turns or the summary.
		expect(server.calls.filter((call) => call.includes("/turns"))).toHaveLength(1);
		expect(server.calls.filter((call) => call === "/api/v1/sessions/live")).toHaveLength(1);
		expect(server.calls.filter((call) => call.includes("/trace"))).toHaveLength(1);
	});

	it("refetches the turns list when the update is truncated", async () => {
		const fixture = liveSession(new Date(Date.now() - 10_000).toISOString());
		const server = createFakeServer({ sessions: [fixture] });
		renderApp("/s/live?view=transcript", server.fetch);
		await screen.findByText("Working on it", { selector: "[data-final-answer] p" });
		expect(server.calls).toContain("/api/v1/sessions/live/turns?limit=100");

		// 60 new turns: more than one updates response carries.
		for (let i = 2; i < 62; i++) {
			const seq = 1 + i * 2;
			fixture.entries.push(entry(seq, userMessage(`Prompt ${i}`)), entry(seq + 1, assistantMessage([{ type: "text", text: `Answer ${i}` }])));
			fixture.turns.push(turn(i, seq, seq + 1, { userText: `Prompt ${i}`, finalText: `Answer ${i}`, modelCalls: 1, toolCalls: 0 }));
		}
		fixture.detail = { ...fixture.detail, entryCount: fixture.entries.length, lastAt: new Date().toISOString() };
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		await waitFor(() => expect(server.calls.filter((call) => call.includes("/turns"))).toHaveLength(2));
		const indices = () => [...document.querySelectorAll("[data-turn]")].map((node) => Number(node.getAttribute("data-turn")));
		await waitFor(() => expect(indices()).toEqual(Array.from({ length: 62 }, (_, i) => i)));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		await waitFor(() => expect(server.calls).toContain(`/api/v1/sessions/live/updates?since=${fixture.entries.length - 1}`));
	});

	it("refetches the session detail when its child count changes", async () => {
		const fixture = liveSession(new Date(Date.now() - 10_000).toISOString());
		const server = createFakeServer({ sessions: [fixture] });
		renderApp("/s/live?view=transcript", server.fetch);
		await screen.findByText("Working on it", { selector: "[data-final-answer] p" });
		expect(document.querySelector("[data-subagents]")).toBeNull();

		grow(fixture);
		const child = summary("child", { title: "Scout the repo", parentSessionId: "live", lastAt: new Date().toISOString() });
		fixture.detail = { ...fixture.detail, childCount: 1, children: [child] };
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		await waitFor(() => expect(server.calls.filter((call) => call === "/api/v1/sessions/live")).toHaveLength(2));
		await waitFor(() => expect(document.querySelector("[data-subagents] a")?.getAttribute("href")).toBe("/s/child"));
	});

	it("does not poll sessions idle for more than two minutes", async () => {
		const server = createFakeServer({ sessions: [liveSession(new Date(Date.now() - 5 * 60_000).toISOString())] });
		renderApp("/s/live?view=transcript", server.fetch);
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

describe("live traces", () => {
	it("invalidates only the updated session's own trace", () => {
		const queryClient = new QueryClient();
		for (const id of ["a", "b", "a-child"]) queryClient.setQueryData(["trace", id], { sessionId: id, turns: [], records: [], children: [] });
		applySessionUpdates(queryClient, "a", { lastSeq: 5 });
		expect(["a", "b", "a-child"].map((id) => queryClient.getQueryState(["trace", id])?.isInvalidated)).toEqual([true, false, false]);
	});

	/** A live session with two Agent calls whose subagents are running. */
	function delegating(): { parent: FakeSession; sessions: FakeSession[] } {
		const now = Date.now();
		const at = (ms: number) => new Date(now - 60_000 + ms).toISOString();
		const kid = (id: string, callId: string): ChildSession => ({
			...summary(id, { parentSessionId: "p", entryCount: 3, startedAt: at(2000), lastAt: at(5000), title: `Child ${id}` }),
			parentToolCallId: callId,
			link: { kind: "subagent", parentSessionId: "p", parentToolCallId: callId, agentType: "worker", description: `Do ${id}` },
		});
		const children = [kid("c1", "call_1"), kid("c2", "call_2")];
		const entries: Entry[] = [
			entry(0, header("p")),
			entry(1, userMessage("Split it", now - 60_000)),
			entry(2, assistantMessage([toolCall("call_1", "Agent", { subagent_type: "worker", description: "Do c1" }), toolCall("call_2", "Agent", { subagent_type: "worker", description: "Do c2" })], now - 59_000)),
		];
		const parent: FakeSession = {
			detail: summary("p", { title: "Delegating", entryCount: entries.length, lastAt: at(5000), childCount: 2, children }),
			entries,
			turns: [turn(0, 1, 2, { userText: "Split it", at: at(0), durationMs: 1000, modelCalls: 1, toolCalls: 2 })],
		};
		const child = (id: string): FakeSession => ({
			detail: summary(id, { entryCount: 3, parentSessionId: "p" }),
			entries: [entry(0, header(id)), entry(1, userMessage(`Do ${id}`, now - 58_000)), entry(2, assistantMessage([{ type: "text", text: `${id} working` }], now - 57_000))],
			turns: [turn(0, 1, 2, { userText: `Do ${id}`, at: at(2000), durationMs: 1000 })],
		});
		return { parent, sessions: [parent, child("c1"), child("c2")] };
	}

	it("refetches the session's trace at most every 10 s, and an expanded subagent's only when it changed", async () => {
		const { parent, sessions } = delegating();
		const server = createFakeServer({ sessions });
		const traces = (id: string) => server.calls.filter((call) => call === `/api/v1/sessions/${id}/trace`).length;
		renderApp("/s/p", server.fetch);
		await waitFor(() => expect(document.querySelectorAll("[data-ledger-row][data-kind='agent']")).toHaveLength(2));
		for (const agent of document.querySelectorAll<HTMLElement>("[data-ledger-row][data-kind='agent']")) {
			fireEvent.click(within(agent).getByRole("button", { name: "Expand subagent" }));
		}
		await waitFor(() => expect([traces("c1"), traces("c2")]).toEqual([1, 1]));

		// The parent records something, and its trace shows that c1 grew.
		const grow = (seq: number) => {
			parent.entries.push(entry(seq, userMessage(`Nudge ${seq}`)));
			parent.turns.push(turn(parent.turns.length, seq, seq, { userText: `Nudge ${seq}` }));
			parent.detail = { ...parent.detail, entryCount: parent.entries.length, lastAt: new Date().toISOString() };
		};
		grow(3);
		parent.detail = { ...parent.detail, children: [{ ...parent.detail.children[0], entryCount: 5, lastAt: new Date().toISOString() }, parent.detail.children[1]] };
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		await waitFor(() => expect(server.calls).toContain("/api/v1/sessions/p/updates?since=2"));
		// Within 10 s of the trace's arrival it waits.
		expect(traces("p")).toBe(1);
		for (let waited = 0; traces("p") < 2 && waited <= TRACE_REFRESH_MS; waited += 500) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(500);
			});
		}
		await waitFor(() => expect([traces("p"), traces("c1"), traces("c2")]).toEqual([2, 2, 1]));
		const refreshed = Date.now();

		// More polls with news: still one trace refetch per 10 s.
		grow(4);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS * 2);
		});
		await waitFor(() => expect(server.calls).toContain("/api/v1/sessions/p/updates?since=3"));
		grow(5);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS);
		});
		expect(Date.now() - refreshed).toBeLessThan(TRACE_REFRESH_MS);
		expect(traces("p")).toBe(2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(TRACE_REFRESH_MS);
		});
		await waitFor(() => expect(traces("p")).toBe(3));
		// Nothing changed in the subagents this time.
		expect([traces("c1"), traces("c2")]).toEqual([2, 1]);
	});

	it("refetches only the session's trace in the transcript view", async () => {
		const fixture = liveSession(new Date(Date.now() - 10_000).toISOString());
		const server = createFakeServer({ sessions: [fixture] });
		renderApp("/s/live?view=transcript", server.fetch);
		await screen.findByText("Working on it", { selector: "[data-final-answer] p" });
		grow(fixture);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + TRACE_REFRESH_MS);
		});
		await waitFor(() => expect(server.calls.filter((call) => call.includes("/trace"))).toEqual(["/api/v1/sessions/live/trace", "/api/v1/sessions/live/trace"]));
	});
});
