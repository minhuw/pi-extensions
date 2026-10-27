// How much of the ledger a replay frame re-renders. `recordIcon` runs once per render of a record row, and nowhere
// else in the trajectory, so its calls count row renders.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceRecord } from "../src/lib/types";
import { mockLayout, renderApp } from "./support/render";
import { createFakeServer } from "./support/server";
import { rows, session } from "./support/trajectory";

const rendered = vi.hoisted(() => [] as string[]);
vi.mock("../src/trace/kinds", async (importOriginal) => {
	const kinds = await importOriginal<typeof import("../src/trace/kinds")>();
	return {
		...kinds,
		recordIcon: (record: TraceRecord) => {
			rendered.push(record.kind === "tool" ? record.callId : `${record.kind}:${record.seq}`);
			return kinds.recordIcon(record);
		},
	};
});

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
	rendered.length = 0;
});
afterEach(() => restore());

describe("replay rendering", () => {
	it("re-renders only the rows whose state a replay frame changes", async () => {
		const media = window.matchMedia;
		window.matchMedia = ((query: string) => ({ ...media(query), matches: query.includes("reduce") })) as typeof window.matchMedia;
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			renderApp("/s/t1", createFakeServer({ sessions: [session()] }).fetch);
			await waitFor(() => expect(rows()).toHaveLength(9));
			const current = () => document.querySelector<HTMLElement>("[data-replay-current]");
			// With reduced motion each frame steps to the next record: the previous one and the new one change.
			fireEvent.click(screen.getByRole("button", { name: "Replay the session" }));
			await act(async () => {
				await vi.advanceTimersByTimeAsync(700);
			});
			await waitFor(() => expect(current()?.dataset.seq).toBe("2"));
			rendered.length = 0;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(650);
			});
			await waitFor(() => expect(current()?.dataset.kind).toBe("shell"));
			expect([...new Set(rendered)].sort()).toEqual(["c_bash", "llm:2"]);
			// The frame re-rendered each of those once or twice (state change, then scroll), never the other seven rows.
			expect(rendered.length).toBeLessThanOrEqual(4);

			// Pausing re-renders nothing but what the selection changes.
			rendered.length = 0;
			fireEvent.click(screen.getByRole("button", { name: "Pause replay" }));
			await waitFor(() => expect(document.querySelector("[data-replay]")?.getAttribute("data-status")).toBe("paused"));
			expect([...new Set(rendered)]).toEqual(["c_bash"]);
		} finally {
			vi.useRealTimers();
			window.matchMedia = media;
		}
	});

	it("re-renders no row for a frame that only moves the playhead", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "setInterval", "Date", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
		try {
			renderApp("/s/t1", createFakeServer({ sessions: [session()] }).fetch);
			await waitFor(() => expect(rows()).toHaveLength(9));
			fireEvent.click(screen.getByRole("button", { name: "1×" }));
			fireEvent.click(screen.getByRole("button", { name: "Replay the session" }));
			// At 1×, the first record starts at the playhead and the next one 1 s later: frames in between move only the playhead.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			const playhead = () => document.querySelector<HTMLElement>("[data-playhead]")?.style.left;
			const before = playhead();
			rendered.length = 0;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(400);
			});
			expect(playhead()).not.toBe(before);
			expect(rendered).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});
