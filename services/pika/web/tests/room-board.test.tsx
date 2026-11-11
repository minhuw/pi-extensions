import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_MS } from "../src/lib/relay";
import type { RelayRoomMember, SwarmBoard, SwarmCard } from "../src/lib/types";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

afterEach(() => {
	vi.useRealTimers();
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const member = (sessionId: string, name: string): RelayRoomMember => ({
	sessionId, device: "studio", deviceName: "Studio Mac", name, project: "pika", state: "offline", online: false, joinedAt: minutesAgo(60),
});

const card = (id: string, status: SwarmCard["status"], extra: Partial<SwarmCard> = {}): SwarmCard => ({
	id, title: `Task ${id}`, status, createdBy: "coordinator", updatedBy: "coordinator", createdAt: minutesAgo(30), updatedAt: minutesAgo(5), ...extra,
});

const board = (sessionId: string, name: string, cards: SwarmCard[]): SwarmBoard => ({
	sessionId, device: "studio", deviceName: "Studio Mac", name, project: "pika", updatedAt: minutesAgo(2), receivedAt: minutesAgo(2), cards,
});

function server(boards: SwarmBoard[]) {
	const at = minutesAgo(60);
	return createFakeServer({
		relayRooms: [{
			room: { name: "swarm", createdAt: at, updatedAt: at, messageCount: 0, members: [member("coord-1", "Coordinator"), member("coord-2", "Second"), member("plain", "Plain")] },
			messages: [],
		}],
		swarmBoards: boards,
	});
}

/** Opens #swarm and switches it to its board. */
async function openBoard(fetch: typeof globalThis.fetch): Promise<HTMLElement> {
	renderApp("/chatrooms/swarm", fetch);
	const header = await waitFor(() => {
		const node = document.querySelector<HTMLElement>("[data-imessage-header]");
		expect(node?.querySelector("[data-imessage-active-title]")?.textContent).toBe("#swarm");
		return node!;
	});
	const view = within(header).getByRole("group", { name: "Room view" });
	fireEvent.click(within(view).getByRole("button", { name: "Board" }));
	expect(within(view).getByRole("button", { name: "Board" }).getAttribute("aria-pressed")).toBe("true");
	return waitFor(() => document.querySelector<HTMLElement>("[data-room-board]")!);
}

const column = (root: HTMLElement, key: string) => root.querySelector<HTMLElement>(`[data-board-column="${key}"]`)!;
const titles = (root: HTMLElement) => [...root.querySelectorAll("[data-board-card] p:first-child")].map((n) => n.textContent);

describe("room board", () => {
	it("shows one board per coordinator with cards in todo, doing, blocked, and done columns", async () => {
		const fake = server([
			board("coord-1", "Coordinator", [
				card("a", "todo"),
				card("b", "doing", { agent: "worker", agentId: "agent-7", note: "Halfway through the parser" }),
				card("c", "blocked", { note: "Needs the API key" }),
				card("d", "done"),
				card("e", "failed"),
				card("f", "dropped"),
			]),
			board("coord-2", "Second", [card("g", "todo")]),
		]);
		const root = await openBoard(fake.fetch);
		await waitFor(() => expect(root.querySelectorAll("[data-board]").length).toBe(2));
		expect(fake.calls).toContain("/api/v1/relay/rooms/swarm/boards");
		// Messages and the composer give way to the board.
		expect(document.querySelector("[data-imessage-stream]")).toBeNull();
		expect(document.querySelector("[data-imessage-input]")).toBeNull();

		const first = root.querySelector<HTMLElement>('[data-board="coord-1"]')!;
		expect(within(first).getByRole("heading", { name: "Coordinator" })).toBeTruthy();
		expect(first.textContent).toContain("pika · Studio Mac");
		expect(first.textContent).toContain("Updated 2 minutes ago");
		expect(titles(column(first, "todo"))).toEqual(["Task a"]);
		expect(titles(column(first, "doing"))).toEqual(["Task b"]);
		expect(titles(column(first, "blocked"))).toEqual(["Task c"]);
		expect(titles(column(first, "done"))).toEqual(["Task d", "Task e", "Task f"]);
		expect(column(first, "done").textContent).toMatch(/^Done3/);

		const doing = first.querySelector<HTMLElement>('[data-board-card="b"]')!;
		expect(doing.textContent).toContain("Halfway through the parser");
		expect(doing.textContent).toContain("worker");
		expect(doing.textContent).toContain("5 minutes ago");
		expect(first.querySelector('[data-board-card="e"]')!.textContent).toContain("Failed");
		expect(first.querySelector('[data-board-card="f"]')!.textContent).toContain("Dropped");
		expect(first.querySelector('[data-board-card="d"]')!.textContent).not.toMatch(/Failed|Dropped/);

		const second = root.querySelector<HTMLElement>('[data-board="coord-2"]')!;
		expect(column(second, "doing").textContent).toContain("None");
	});

	it("polls the boards like the room history", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const fake = server([board("coord-1", "Coordinator", [card("a", "todo")])]);
		const root = await openBoard(fake.fetch);
		await waitFor(() => expect(titles(column(root, "todo"))).toEqual(["Task a"]));
		fake.state.swarmBoards[0] = board("coord-1", "Coordinator", [card("a", "doing")]);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(RELAY_POLL_MS);
		});
		await waitFor(() => expect(titles(column(root, "doing"))).toEqual(["Task a"]));
		expect(titles(column(root, "todo"))).toEqual([]);
	});

	it("says in one line when no member has a board, and returns to messages", async () => {
		const fake = server([]);
		const root = await openBoard(fake.fetch);
		expect(await within(root).findByText("No member of this room has a swarm board.")).toBeTruthy();
		const header = document.querySelector<HTMLElement>("[data-imessage-header]")!;
		fireEvent.click(within(header).getByRole("button", { name: "Messages" }));
		await waitFor(() => expect(document.querySelector("[data-room-board]")).toBeNull());
		expect(document.querySelector("[data-imessage-input]")).toBeTruthy();
		expect(screen.queryByText("No member of this room has a swarm board.")).toBeNull();
	});
});
