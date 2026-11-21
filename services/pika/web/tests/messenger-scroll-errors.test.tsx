import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_MS } from "../src/lib/relay";
import type { RelayRoomMember, RelayRoomMessage } from "../src/lib/types";
import { onlineSession, relayEvent } from "./support/fixtures";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

const ROOM_CAP = 150;
const DM_CAP = 100;

function roomMessage(room: string, seq: number, text = `Message ${seq}`): RelayRoomMessage {
	return {
		id: `m-${seq}`,
		seq,
		room,
		from: { kind: "session", sessionId: "s-lead", device: "mini", name: "Lead", project: "pika" },
		text,
		mentions: [],
		notified: [],
		urgent: false,
		hops: 1,
		at: new Date(Date.parse("2026-10-20T09:00:00.000Z") + seq * 1_000).toISOString(),
	};
}

function member(sessionId: string, name: string, at: string): RelayRoomMember {
	return {
		sessionId,
		device: "mini",
		name,
		project: "pika",
		state: "idle",
		online: true,
		joinedAt: at,
	};
}

/** Gives `[data-imessage-stream]` controllable scroll geometry in jsdom. */
function mockStreamGeometry(initialScrollHeight: number, clientHeight = 400) {
	let scrollHeight = initialScrollHeight;
	const proto = HTMLElement.prototype;
	const savedHeight = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
	const savedClient = Object.getOwnPropertyDescriptor(proto, "clientHeight");
	Object.defineProperty(proto, "scrollHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.hasAttribute("data-imessage-stream") ? scrollHeight : 0;
		},
	});
	Object.defineProperty(proto, "clientHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.hasAttribute("data-imessage-stream") ? clientHeight : 0;
		},
	});
	return {
		setScrollHeight(next: number) {
			scrollHeight = next;
		},
		restore() {
			if (savedHeight) Object.defineProperty(proto, "scrollHeight", savedHeight);
			else delete (proto as unknown as Record<string, unknown>).scrollHeight;
			if (savedClient) Object.defineProperty(proto, "clientHeight", savedClient);
			else delete (proto as unknown as Record<string, unknown>).clientHeight;
		},
	};
}

function trackUnhandledRejections() {
	const reasons: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		reasons.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	return {
		reasons,
		stop() {
			process.off("unhandledRejection", onUnhandled);
		},
	};
}

let restoreGeometry: (() => void) | null = null;

afterEach(() => {
	restoreGeometry?.();
	restoreGeometry = null;
	vi.useRealTimers();
});

describe("Messenger auto-scroll at the 150-message cap", () => {
	it("continues auto-scrolling when a room stays at the 150-message cap and drops the oldest message", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const geometry = mockStreamGeometry(3_000);
		restoreGeometry = geometry.restore;

		const at = new Date().toISOString();
		const initialMessages = Array.from({ length: ROOM_CAP }, (_, i) => roomMessage("ops", i + 1));
		const server = createFakeServer({
			online: [onlineSession("s-lead", { name: "Lead" })],
			relayRooms: [
				{
					room: {
						name: "ops",
						createdAt: at,
						updatedAt: at,
						messageCount: ROOM_CAP,
						members: [member("s-lead", "Lead", at)],
						lastMessage: initialMessages.at(-1),
					},
					messages: initialMessages,
				},
			],
		});

		renderApp("/chatrooms/ops", server.fetch);
		const stream = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-imessage-stream]");
			expect(node?.querySelectorAll("[data-imessage-bubble]").length).toBe(ROOM_CAP);
			return node!;
		});
		expect(stream.scrollTop).toBe(3_000);

		// Evict the oldest message and append #151 so length remains strictly 150.
		const nextMsg = roomMessage("ops", ROOM_CAP + 1, "Message 151 at cap");
		server.state.relayRooms[0]!.messages = [...server.state.relayRooms[0]!.messages.slice(1), nextMsg];
		server.state.relayRooms[0]!.room.lastMessage = nextMsg;
		server.state.relayRooms[0]!.room.messageCount = ROOM_CAP + 1;
		geometry.setScrollHeight(3_120);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(RELAY_POLL_MS);
		});

		await waitFor(() => expect(stream.querySelector('[data-imessage-bubble="m-151"]')).toBeTruthy());
		expect(stream.querySelector('[data-imessage-bubble="m-1"]')).toBeNull();
		expect(stream.querySelectorAll("[data-imessage-bubble]")).toHaveLength(ROOM_CAP);
		expect(stream.scrollTop).toBe(3_120);
	});

	it("preserves the user-scrolled-up guard at the 150-message cap and resumes auto-scroll after jumping to latest", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const geometry = mockStreamGeometry(3_000);
		restoreGeometry = geometry.restore;

		const at = new Date().toISOString();
		const initialMessages = Array.from({ length: ROOM_CAP }, (_, i) => roomMessage("ops", i + 1));
		const server = createFakeServer({
			online: [onlineSession("s-lead", { name: "Lead" })],
			relayRooms: [
				{
					room: {
						name: "ops",
						createdAt: at,
						updatedAt: at,
						messageCount: ROOM_CAP,
						members: [member("s-lead", "Lead", at)],
						lastMessage: initialMessages.at(-1),
					},
					messages: initialMessages,
				},
			],
		});

		renderApp("/chatrooms/ops", server.fetch);
		const stream = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-imessage-stream]");
			expect(node?.querySelectorAll("[data-imessage-bubble]").length).toBe(ROOM_CAP);
			return node!;
		});
		expect(stream.scrollTop).toBe(3_000);

		// User scrolls up well past STICK_PX to read older messages.
		stream.scrollTop = 1_000;
		fireEvent.scroll(stream);
		expect(document.querySelector("[data-imessage-jump-latest]")).toBeTruthy();

		// Message #151 arrives while scrolled up: stream must NOT yank the user back to bottom.
		const msg151 = roomMessage("ops", ROOM_CAP + 1);
		server.state.relayRooms[0]!.messages = [...server.state.relayRooms[0]!.messages.slice(1), msg151];
		server.state.relayRooms[0]!.room.lastMessage = msg151;
		geometry.setScrollHeight(3_120);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(RELAY_POLL_MS);
		});
		await waitFor(() => expect(stream.querySelector('[data-imessage-bubble="m-151"]')).toBeTruthy());
		expect(stream.scrollTop).toBe(1_000);
		expect(document.querySelector("[data-imessage-jump-latest]")).toBeTruthy();

		// Jumping to latest re-engages bottom sticking for subsequent at-cap messages.
		fireEvent.click(document.querySelector<HTMLButtonElement>("[data-imessage-jump-latest]")!);
		expect(stream.scrollTop).toBe(3_120);
		expect(document.querySelector("[data-imessage-jump-latest]")).toBeNull();

		const msg152 = roomMessage("ops", ROOM_CAP + 2);
		server.state.relayRooms[0]!.messages = [...server.state.relayRooms[0]!.messages.slice(1), msg152];
		server.state.relayRooms[0]!.room.lastMessage = msg152;
		geometry.setScrollHeight(3_240);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(RELAY_POLL_MS);
		});
		await waitFor(() => expect(stream.querySelector('[data-imessage-bubble="m-152"]')).toBeTruthy());
		expect(stream.scrollTop).toBe(3_240);
	});

	it("continues auto-scrolling DM streams when events roll over at the 100-event cap", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const geometry = mockStreamGeometry(2_400);
		restoreGeometry = geometry.restore;

		// Relay events are returned newest-first by the API, capped at 100 items by default.
		const dmEvents = Array.from({ length: DM_CAP }, (_, i) => {
			const seq = DM_CAP - i;
			return relayEvent(`dm-${seq}`, (DM_CAP - seq + 1) * 1_000, {
				from: { kind: "session", sessionId: "s-web", device: "mini", name: "Frontend" },
				to: { sessionId: "s-other", name: "Reviewer" },
				text: `DM ${seq}`,
			});
		});
		const server = createFakeServer({
			online: [onlineSession("s-web", { name: "Frontend" })],
			relayEvents: dmEvents,
		});

		renderApp("/chatrooms?dm=s-web", server.fetch);
		const stream = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-imessage-stream]");
			expect(node?.querySelectorAll("[data-imessage-bubble]").length).toBe(DM_CAP);
			return node!;
		});
		expect(stream.scrollTop).toBe(2_400);

		// Prepend newest DM event; the API window drops the oldest so length stays strictly 100.
		const newest = relayEvent("dm-101", 0, {
			from: { kind: "session", sessionId: "s-web", device: "mini", name: "Frontend" },
			to: { sessionId: "s-other", name: "Reviewer" },
			text: "DM 101 at cap",
		});
		server.state.relayEvents.unshift(newest);
		geometry.setScrollHeight(2_520);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(RELAY_POLL_MS);
		});
		await waitFor(() => expect(stream.querySelector('[data-imessage-bubble="dm-101"]')).toBeTruthy());
		expect(stream.querySelector('[data-imessage-bubble="dm-1"]')).toBeNull();
		expect(stream.querySelectorAll("[data-imessage-bubble]")).toHaveLength(DM_CAP);
		expect(stream.scrollTop).toBe(2_520);
	});
});

describe("Messenger async error handling", () => {
	it("surfaces send rejections, resets sending state, preserves the draft, and clears stale errors on thread switch", async () => {
		const tracker = trackUnhandledRejections();
		try {
			const at = new Date().toISOString();
			const server = createFakeServer({
				online: [onlineSession("s-web", { name: "Frontend" })],
				relayRooms: [
					{
						room: { name: "ops", createdAt: at, updatedAt: at, messageCount: 0, members: [member("s-web", "Frontend", at)] },
						messages: [],
					},
				],
			});

			let rejectSend: ((err: Error) => void) | null = null;
			const wrappedFetch: typeof fetch = (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (init?.method === "POST" && url.includes("/api/v1/relay/messages")) {
					return new Promise<Response>((_, reject) => {
						rejectSend = reject;
					});
				}
				return server.fetch(input, init);
			};

			renderApp("/chatrooms/ops", wrappedFetch);
			const input = await waitFor(() => {
				const node = document.querySelector<HTMLTextAreaElement>("[data-imessage-input]");
				expect(node).toBeTruthy();
				return node!;
			});
			const sendBtn = document.querySelector<HTMLButtonElement>("[data-imessage-send]")!;

			fireEvent.change(input, { target: { value: "Deploy status update" } });
			fireEvent.click(sendBtn);

			// In-flight loading state.
			await waitFor(() => expect(sendBtn.disabled).toBe(true));
			expect(sendBtn.textContent).toBe("Sending…");

			// Reject the network request.
			await act(async () => {
				rejectSend!(new Error("Relay backend unreachable"));
				await Promise.resolve();
			});

			const alert = await waitFor(() => {
				const node = document.querySelector<HTMLElement>('[data-imessage-feedback="error"]');
				expect(node).toBeTruthy();
				return node!;
			});
			expect(alert.getAttribute("role")).toBe("alert");
			expect(alert.textContent).toContain("Relay backend unreachable");
			expect(sendBtn.disabled).toBe(false);
			expect(sendBtn.textContent).toBe("Send");
			expect(input.value).toBe("Deploy status update");
			expect(tracker.reasons).toEqual([]);

			// Switching conversations clears stale send error.
			fireEvent.click(document.querySelector<HTMLElement>('[data-imessage-thread="dm:s-web"]')!);
			await waitFor(() => expect(document.querySelector('[data-imessage-feedback="error"]')).toBeNull());
		} finally {
			tracker.stop();
		}
	});

	it("surfaces room history load errors with Retry instead of false empty or missing-room states", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const tracker = trackUnhandledRejections();
		try {
			const at = new Date().toISOString();
			const server = createFakeServer({
				relayRooms: [
					{
						room: { name: "ops", createdAt: at, updatedAt: at, messageCount: 1, members: [] },
						messages: [roomMessage("ops", 1, "Recovered history message")],
					},
				],
			});

			let failDetail = true;
			const wrappedFetch: typeof fetch = (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if ((!init?.method || init.method === "GET") && /\/api\/v1\/relay\/rooms\/ops(?:\?|$)/.test(url) && failDetail) {
					return Promise.resolve(
						new Response(JSON.stringify({ error: "database temporarily locked" }), {
							status: 500,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				return server.fetch(input, init);
			};

			const first = renderApp("/chatrooms/ops", wrappedFetch);
			const alert = await waitFor(() => {
				const node = document.querySelector<HTMLElement>("[data-imessage-room-error]");
				expect(node).toBeTruthy();
				return node!;
			});
			expect(alert.getAttribute("role")).toBe("alert");
			expect(alert.textContent).toContain("Couldn’t load room history");
			expect(alert.textContent).toContain("database temporarily locked");
			expect(screen.queryByText(/Nothing posted in/i)).toBeNull();

			// Retrying after the server recovers clears the alert and renders history.
			failDetail = false;
			fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
			await waitFor(() => expect(document.querySelector('[data-imessage-bubble="m-1"]')).toBeTruthy());
			expect(document.querySelector("[data-imessage-room-error]")).toBeNull();

			// If a subsequent refresh fails while messages are already rendered, show a non-destructive banner.
			failDetail = true;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(RELAY_POLL_MS);
			});
			const refreshAlert = await waitFor(() => {
				const node = document.querySelector<HTMLElement>("[data-imessage-room-error]");
				expect(node).toBeTruthy();
				return node!;
			});
			expect(refreshAlert.getAttribute("role")).toBe("alert");
			expect(refreshAlert.textContent).toContain("Couldn’t refresh room history");
			expect(document.querySelector('[data-imessage-bubble="m-1"]')).toBeTruthy();
			first.unmount();

			// Deep-linking when both room list and room detail return 500 must NOT say "does not exist".
			const failAllRoomsFetch: typeof fetch = (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if ((!init?.method || init.method === "GET") && url.includes("/api/v1/relay/rooms")) {
					return Promise.resolve(
						new Response(JSON.stringify({ error: "upstream timeout" }), {
							status: 503,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				return server.fetch(input, init);
			};
			renderApp("/chatrooms/ops", failAllRoomsFetch);
			const deepAlert = await waitFor(() => {
				const node = document.querySelector<HTMLElement>("[data-imessage-room-error]");
				expect(node).toBeTruthy();
				return node!;
			});
			expect(deepAlert.getAttribute("role")).toBe("alert");
			expect(deepAlert.textContent).toContain("Couldn’t load #ops");
			expect(deepAlert.textContent).toContain("upstream timeout");
			expect(screen.queryByText(/does not exist/i)).toBeNull();

			const listAlert = document.querySelector<HTMLElement>("[data-imessage-rooms-error]");
			expect(listAlert?.getAttribute("role")).toBe("alert");
			expect(listAlert?.textContent).toContain("upstream timeout");
			expect(tracker.reasons).toEqual([]);
		} finally {
			tracker.stop();
		}
	});

	it("surfaces member, representative, topic, and room-deletion errors without unhandled rejections or stuck loading states", async () => {
		const tracker = trackUnhandledRejections();
		try {
			const at = new Date().toISOString();
			const server = createFakeServer({
				online: [onlineSession("s-lead", { name: "Lead" }), onlineSession("s-web", { name: "Frontend" })],
				relayRooms: [
					{
						room: {
							name: "ops",
							topic: "Original topic",
							createdAt: at,
							updatedAt: at,
							messageCount: 0,
							members: [member("s-lead", "Lead", at)],
						},
						messages: [],
					},
				],
			});

			const wrappedFetch: typeof fetch = (input, init) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const method = init?.method ?? "GET";
				if (method === "POST" && url.includes("/api/v1/relay/rooms/ops/members")) {
					return Promise.resolve(
						new Response(JSON.stringify({ error: "member mutation failed" }), {
							status: 500,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				if (method === "POST" && /\/api\/v1\/relay\/rooms(?:\?|$)/.test(url)) {
					return Promise.resolve(
						new Response(JSON.stringify({ error: "topic save failed" }), {
							status: 500,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				if (method === "DELETE" && url.includes("/api/v1/relay/rooms/ops")) {
					return Promise.resolve(
						new Response(JSON.stringify({ error: "delete room failed" }), {
							status: 500,
							headers: { "Content-Type": "application/json" },
						}),
					);
				}
				return server.fetch(input, init);
			};

			renderApp("/chatrooms/ops", wrappedFetch);
			await waitFor(() => expect(document.querySelector("[data-imessage-active-title]")?.textContent).toBe("#ops"));

			// 1. Open Members rail and fail Make rep, Remove, and Add member.
			fireEvent.click(document.querySelector<HTMLButtonElement>("[data-imessage-manage-members]")!);
			const repBtn = await waitFor(() => {
				const node = document.querySelector<HTMLButtonElement>('[data-imessage-represent-member="s-lead"]');
				expect(node).toBeTruthy();
				return node!;
			});
			fireEvent.click(repBtn);
			const repAlert = await waitFor(() => {
				const node = document.querySelector<HTMLElement>("[data-imessage-member-error]");
				expect(node).toBeTruthy();
				return node!;
			});
			expect(repAlert.getAttribute("role")).toBe("alert");
			expect(repAlert.textContent).toContain("member mutation failed");
			expect(repBtn.disabled).toBe(false);

			// Dismiss, then fail Remove member.
			fireEvent.click(within(repAlert).getByRole("button", { name: "Dismiss member error" }));
			expect(document.querySelector("[data-imessage-member-error]")).toBeNull();

			const removeBtn = document.querySelector<HTMLButtonElement>('[data-imessage-toggle-member="s-lead"]')!;
			fireEvent.click(removeBtn);
			const removeAlert = await waitFor(() => {
				const node = document.querySelector<HTMLElement>("[data-imessage-member-error]");
				expect(node).toBeTruthy();
				return node!;
			});
			expect(removeAlert.textContent).toContain("member mutation failed");
			expect(removeBtn.disabled).toBe(false);

			// Dismiss, then fail Add member from candidate list.
			fireEvent.click(within(removeAlert).getByRole("button", { name: "Dismiss member error" }));
			const addBtn = document.querySelector<HTMLButtonElement>('[data-imessage-toggle-member="s-web"]')!;
			fireEvent.click(addBtn);
			const addAlert = await waitFor(() => {
				const node = document.querySelector<HTMLElement>("[data-imessage-member-error]");
				expect(node).toBeTruthy();
				return node!;
			});
			expect(addAlert.textContent).toContain("member mutation failed");
			expect(addBtn.disabled).toBe(false);

			// 2. Fail inline topic save.
			fireEvent.click(document.querySelector<HTMLButtonElement>("[data-imessage-edit-topic]")!);
			const topicInput = screen.getByLabelText("Room topic") as HTMLInputElement;
			fireEvent.change(topicInput, { target: { value: "New topic" } });
			fireEvent.submit(topicInput.closest("form")!);
			const topicAlert = await waitFor(() => {
				const node = document.querySelector<HTMLElement>("[data-imessage-topic-error]");
				expect(node).toBeTruthy();
				return node!;
			});
			expect(topicAlert.getAttribute("role")).toBe("alert");
			expect(topicAlert.textContent).toContain("topic save failed");
			expect(within(topicInput.closest("form")!).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);

			// 3. Fail Delete room inside confirmation dialog.
			fireEvent.click(document.querySelector<HTMLButtonElement>("[data-imessage-delete-room-ask]")!);
			const confirmDeleteBtn = document.querySelector<HTMLButtonElement>("[data-imessage-delete-room]")!;
			fireEvent.click(confirmDeleteBtn);
			const deleteAlert = await waitFor(() => {
				const node = document.querySelector<HTMLElement>("[data-imessage-delete-error]");
				expect(node).toBeTruthy();
				return node!;
			});
			expect(deleteAlert.getAttribute("role")).toBe("alert");
			expect(deleteAlert.textContent).toContain("delete room failed");
			expect(confirmDeleteBtn.disabled).toBe(false);
			expect(confirmDeleteBtn.textContent).toBe("Delete room");

			// Flush microtasks to guarantee no unhandled rejection escaped from any action.
			await act(async () => {
				await Promise.resolve();
			});
			expect(tracker.reasons).toEqual([]);
		} finally {
			tracker.stop();
		}
	});
});
