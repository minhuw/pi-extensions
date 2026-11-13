import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RELAY_BADGE_POLL_MS, RELAY_POLL_MS } from "../src/lib/relay";
import { onlineSession, relayEvent, summary } from "./support/fixtures";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

afterEach(() => {
	vi.useRealTimers();
});

describe("chatrooms page", () => {
	it("marks Chatrooms current in the band on /chatrooms and /chatrooms/:room, and pauses the band's slow poll", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const at = new Date().toISOString();
		const server = createFakeServer({
			online: [onlineSession("s-a", { name: "Alpha" })],
			relayRooms: [{ room: { name: "ops", createdAt: at, updatedAt: at, messageCount: 0, members: [] }, messages: [] }],
		});

		const first = renderApp("/chatrooms", server.fetch);
		const nav = await screen.findByRole("navigation", { name: "Main" });
		const item = await within(nav).findByRole("link", { name: "Chatrooms" });
		expect(item.getAttribute("aria-current")).toBe("page");

		await waitFor(() => expect(document.querySelector("[data-imessage-active-title]")?.textContent).toBe("#ops"));
		const initialSessionCalls = server.calls.filter((c) => c === "/api/v1/relay/sessions").length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(RELAY_BADGE_POLL_MS);
		});
		const afterSessionCalls = server.calls.filter((c) => c === "/api/v1/relay/sessions").length;
		expect(afterSessionCalls).toBe(initialSessionCalls + RELAY_BADGE_POLL_MS / RELAY_POLL_MS);
		first.unmount();

		renderApp("/chatrooms/ops", server.fetch);
		const nav2 = await screen.findByRole("navigation", { name: "Main" });
		const item2 = await within(nav2).findByRole("link", { name: "Chatrooms" });
		expect(item2.getAttribute("aria-current")).toBe("true");
	});

	it("explains when relay is turned off on /chatrooms", async () => {
		const server = createFakeServer({ features: [] });
		renderApp("/chatrooms", server.fetch);
		expect(await screen.findByRole("heading", { name: "Chatrooms", level: 1 })).toBeTruthy();
		expect(await screen.findByText("Relay is turned off on this server")).toBeTruthy();
	});

	it("deep-links /chatrooms/:room and /chatrooms?dm=<id>, resolving offline recorded sessions", async () => {
		const at = new Date().toISOString();
		const server = createFakeServer({
			sessions: [
				{
					detail: summary("s-offline", { title: "Investigate memory leak", project: "pika-core", device: "studio", deviceName: "Studio Mac" }),
					turns: [],
					entries: [],
				},
			],
			online: [onlineSession("s-web", { name: "Frontend", project: "pika-web" })],
			relayRooms: [
				{ room: { name: "alpha", createdAt: at, updatedAt: at, messageCount: 0, members: [] }, messages: [] },
				{ room: { name: "beta", createdAt: at, updatedAt: at, messageCount: 0, members: [] }, messages: [] },
			],
		});

		const roomView = renderApp("/chatrooms/beta", server.fetch);
		await waitFor(() => expect(document.querySelector("[data-imessage-active-title]")?.textContent).toBe("#beta"));
		roomView.unmount();

		renderApp("/chatrooms?dm=s-offline", server.fetch);
		await waitFor(() => expect(document.querySelector("[data-imessage-active-title]")?.textContent).toBe("Investigate memory leak"));
		const headerLink = document.querySelector<HTMLAnchorElement>("[data-imessage-active-title] a")!;
		expect(headerLink.getAttribute("href")).toBe("/s/s-offline");
		expect(document.querySelector("[data-imessage-header]")?.textContent).toContain("pika-core");
		expect(document.querySelector("[data-imessage-header]")?.textContent).toContain("Studio Mac");
	});

	it("supports 1:1 direct threads, room creation dialog, topic editing & clearing, and @mention notifications", async () => {
		const server = createFakeServer({
			online: [
				onlineSession("s-backend", { name: "Backend", project: "pika-server", deviceName: "Studio Mac" }),
				onlineSession("s-web", { name: "Frontend", project: "pika-web", device: "laptop", deviceName: "MacBook" }),
			],
		});
		renderApp("/chatrooms", server.fetch);
		const messenger = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-imessage]")!;
			expect(node.querySelector('[data-imessage-thread="dm:s-web"]')).toBeTruthy();
			return node;
		});

		// 1. Direct 1:1 chat in the Chatrooms workbench.
		fireEvent.click(messenger.querySelector<HTMLElement>('[data-imessage-thread="dm:s-web"]')!);
		expect(messenger.querySelector("[data-imessage-active-title]")?.textContent).toBe("Frontend");

		const input = messenger.querySelector<HTMLTextAreaElement>("[data-imessage-input]")!;
		fireEvent.change(input, { target: { value: "Check the CSS tokens." } });
		fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

		await waitFor(() =>
			expect(server.mutations).toContainEqual({
				method: "POST",
				path: "/api/v1/relay/messages",
				body: { to: "s-web", text: "Check the CSS tokens.", urgent: false },
				json: true,
			}),
		);
		await waitFor(() => expect(messenger.querySelector("[data-imessage-bubble]")?.textContent).toContain("Check the CSS tokens."));

		// 2. Create a room via the modal dialog.
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-new-room]")!);
		const dialog = screen.getByRole("dialog", { name: "New room" });
		const form = dialog.querySelector<HTMLElement>("[data-imessage-room-form]")!;
		fireEvent.change(within(form).getByLabelText("Room name"), { target: { value: "#auth-sync" } });
		fireEvent.change(within(form).getByLabelText("Topic (optional)"), { target: { value: "Sync token schema across repos" } });
		for (const checkbox of within(form).getAllByRole("checkbox")) {
			fireEvent.click(checkbox);
		}
		fireEvent.click(within(form).getByRole("button", { name: "Create room" }));

		await waitFor(() => expect(messenger.querySelector("[data-imessage-active-title]")?.textContent).toBe("#auth-sync"));
		expect(messenger.querySelector("[data-imessage-topic]")?.textContent).toBe("Sync token schema across repos");

		// 3. Edit and clear the room topic inline.
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-edit-topic]")!);
		const topicInput = screen.getByLabelText("Room topic") as HTMLInputElement;
		expect(topicInput.value).toBe("Sync token schema across repos");
		fireEvent.change(topicInput, { target: { value: "Updated auth contract" } });
		fireEvent.submit(topicInput.closest("form")!);
		await waitFor(() => expect(messenger.querySelector("[data-imessage-topic]")?.textContent).toBe("Updated auth contract"));
		expect(server.mutations.at(-1)).toEqual({
			method: "POST",
			path: "/api/v1/relay/rooms",
			body: { name: "auth-sync", topic: "Updated auth contract" },
			json: true,
		});

		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-topic]")!);
		const clearTopicInput = screen.getByLabelText("Room topic") as HTMLInputElement;
		fireEvent.change(clearTopicInput, { target: { value: "   " } });
		fireEvent.submit(clearTopicInput.closest("form")!);
		await waitFor(() => expect(messenger.querySelector("[data-imessage-topic]")).toBeNull());
		expect(server.mutations.at(-1)).toEqual({
			method: "POST",
			path: "/api/v1/relay/rooms",
			body: { name: "auth-sync", topic: null },
			json: true,
		});
		expect(messenger.querySelector("[data-imessage-edit-topic]")?.textContent).toContain("Add topic");

		// 4. Post to the room without @mentions (saved to room history without waking agents).
		const roomInput = messenger.querySelector<HTMLTextAreaElement>("[data-imessage-input]")!;
		fireEvent.change(roomInput, { target: { value: "Shared schema v2 draft." } });
		fireEvent.keyDown(roomInput, { key: "Enter", metaKey: true });
		await waitFor(() =>
			expect(messenger.querySelector("[data-imessage-stream]")?.textContent).toContain("Room history only; no one notified"),
		);

		// 5. Select Frontend chip in the Notify bar and post: notifies only s-web.
		fireEvent.click(messenger.querySelector<HTMLButtonElement>('[data-imessage-notify-chip="s-web"]')!);
		fireEvent.change(roomInput, { target: { value: "Please update the client types." } });
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-send]")!);
		await waitFor(() =>
			expect(messenger.querySelector("[data-imessage-stream]")?.textContent).toContain("Notified Frontend"),
		);
		expect(server.mutations.at(-1)).toEqual({
			method: "POST",
			path: "/api/v1/relay/messages",
			body: { room: "auth-sync", text: "Please update the client types.", mentions: ["s-web"], urgent: false },
			json: true,
		});
	});

	it("keeps an Edit topic click made as soon as a new room shows", async () => {
		const server = createFakeServer({ online: [onlineSession("s-web", { name: "Frontend", project: "pika-web" })] });
		renderApp("/chatrooms", server.fetch);
		const messenger = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-imessage]")!;
			expect(node.querySelector('[data-imessage-thread="dm:s-web"]')).toBeTruthy();
			return node;
		});
		fireEvent.click(messenger.querySelector<HTMLElement>('[data-imessage-thread="dm:s-web"]')!);
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-new-room]")!);
		const form = screen.getByRole("dialog", { name: "New room" }).querySelector<HTMLElement>("[data-imessage-room-form]")!;
		fireEvent.change(within(form).getByLabelText("Room name"), { target: { value: "#auth-sync" } });
		fireEvent.change(within(form).getByLabelText("Topic (optional)"), { target: { value: "Sync token schema" } });
		// Clicks in the microtask after the room's first commit, before React runs that commit's effects.
		const clicked = new Promise<void>((resolve) => {
			const observer = new MutationObserver(() => {
				const edit = messenger.querySelector<HTMLButtonElement>("[data-imessage-edit-topic]");
				if (messenger.querySelector("[data-imessage-active-title]")?.textContent !== "#auth-sync" || !edit) return;
				observer.disconnect();
				fireEvent.click(edit);
				resolve();
			});
			observer.observe(document.body, { subtree: true, childList: true, characterData: true });
		});
		fireEvent.click(within(form).getByRole("button", { name: "Create room" }));
		await clicked;
		expect((screen.getByLabelText("Room topic") as HTMLInputElement).value).toBe("Sync token schema");
	});

	it("supports replyTo threading from the stream into the composer and renders inline reply context", async () => {
		const at = new Date().toISOString();
		const member = { sessionId: "s-lead", device: "mini", name: "Lead", project: "pika", state: "idle" as const, online: true, joinedAt: at };
		const server = createFakeServer({
			online: [onlineSession("s-lead", { name: "Lead", project: "pika" })],
			relayRooms: [
				{
					room: { name: "ops", createdAt: at, updatedAt: at, messageCount: 1, members: [member] },
					messages: [
						{
							id: "msg-parent-12345678",
							seq: 1,
							room: "ops",
							from: { kind: "session", sessionId: "s-lead", device: "mini", name: "Lead", project: "pika" },
							text: "Can we deploy v1.4 tonight?",
							mentions: [],
							notified: [],
							urgent: false,
							hops: 1,
							at,
						},
					],
				},
			],
		});
		renderApp("/chatrooms/ops", server.fetch);
		const replyBtn = await waitFor(() => {
			const node = document.querySelector<HTMLButtonElement>('[data-imessage-reply="msg-parent-12345678"]');
			expect(node).toBeTruthy();
			return node!;
		});

		fireEvent.click(replyBtn);
		const banner = document.querySelector<HTMLElement>('[data-imessage-reply-banner="msg-parent-12345678"]')!;
		expect(banner).toBeTruthy();
		expect(banner.textContent).toContain("Lead");
		expect(banner.textContent).toContain("Can we deploy v1.4 tonight?");

		const input = document.querySelector<HTMLTextAreaElement>("[data-imessage-input]")!;
		expect(document.activeElement).toBe(input);
		fireEvent.change(input, { target: { value: "Yes, green across CI." } });
		fireEvent.click(document.querySelector<HTMLButtonElement>("[data-imessage-send]")!);

		await waitFor(() =>
			expect(server.mutations.at(-1)).toEqual({
				method: "POST",
				path: "/api/v1/relay/messages",
				body: { room: "ops", text: "Yes, green across CI.", urgent: false, replyTo: "msg-parent-12345678" },
				json: true,
			}),
		);
		expect(document.querySelector("[data-imessage-reply-banner]")).toBeNull();

		// Sent message displays inline reply context linking back to parent.
		const replyContext = await waitFor(() => {
			const node = document.querySelector<HTMLElement>('[data-imessage-reply-context="msg-parent-12345678"]');
			expect(node).toBeTruthy();
			return node!;
		});
		expect(replyContext.textContent).toContain("replying to");
		expect(replyContext.textContent).toContain("Lead");
		fireEvent.click(within(replyContext).getByRole("button"));
		expect(document.querySelector('[data-imessage-bubble="msg-parent-12345678"]')?.hasAttribute("data-highlighted")).toBe(true);
	});

	it("completes @mentions inline with keyboard navigation and click", async () => {
		const at = new Date().toISOString();
		const server = createFakeServer({
			online: [
				onlineSession("s-lead", { name: "Lead", project: "pika-server" }),
				onlineSession("s-web", { name: "Frontend", project: "pika-web" }),
			],
			relayRooms: [
				{
					room: {
						name: "ops",
						createdAt: at,
						updatedAt: at,
						messageCount: 0,
						members: [
							{ sessionId: "s-lead", device: "mini", name: "Lead", project: "pika-server", state: "idle", online: true, joinedAt: at },
							{ sessionId: "s-web", device: "laptop", name: "Frontend", project: "pika-web", state: "idle", online: true, joinedAt: at },
						],
					},
					messages: [],
				},
			],
		});
		renderApp("/chatrooms/ops", server.fetch);
		const input = await waitFor(() => {
			const node = document.querySelector<HTMLTextAreaElement>("[data-imessage-input]");
			expect(node?.placeholder).toContain("#ops");
			return node!;
		});

		fireEvent.change(input, { target: { value: "Ping @" } });
		const menu = await screen.findByRole("listbox", { name: "Mention a room member" });
		const options = within(menu).getAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual([
			expect.stringContaining("@all"),
			expect.stringContaining("@Lead"),
			expect.stringContaining("@Frontend"),
		]);

		// ArrowDown twice selects @Frontend, Enter inserts it without sending.
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "ArrowDown" });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(input.value).toBe("Ping @Frontend ");
		expect(screen.queryByRole("listbox", { name: "Mention a room member" })).toBeNull();
		expect(server.mutations).toEqual([]);

		// Typing @Le filters to @Lead, Escape dismisses, and clicking inserts.
		fireEvent.change(input, { target: { value: "Ping @Frontend and @Le" } });
		const filtered = await screen.findByRole("listbox", { name: "Mention a room member" });
		expect(within(filtered).getAllByRole("option")).toHaveLength(1);
		fireEvent.keyDown(input, { key: "Escape" });
		expect(screen.queryByRole("listbox", { name: "Mention a room member" })).toBeNull();

		fireEvent.change(input, { target: { value: "Ping @Frontend and @L" } });
		fireEvent.click(document.querySelector<HTMLButtonElement>('[data-imessage-mention-option="Lead"]')!);
		expect(input.value).toBe("Ping @Frontend and @Lead ");
	});

	it("manages members, offline recorded sessions, and room representatives in the right rail", async () => {
		const at = new Date().toISOString();
		const member = (sessionId: string, name: string) => ({
			sessionId,
			device: "mini",
			name,
			project: "pika",
			state: "idle" as const,
			online: true,
			joinedAt: at,
		});
		const server = createFakeServer({
			sessions: [
				{
					detail: summary("s-recorded", { title: "Audit SQLite migrations", project: "pika-db" }),
					turns: [],
					entries: [],
				},
			],
			online: [onlineSession("s-lead", { name: "Lead" }), onlineSession("s-web", { name: "Frontend" })],
			relayRooms: [
				{
					room: {
						name: "ops",
						createdAt: at,
						updatedAt: at,
						messageCount: 0,
						members: [member("s-lead", "Lead"), member("s-web", "Frontend")],
						representative: "s-lead",
					},
					messages: [],
				},
			],
		});
		renderApp("/chatrooms/ops", server.fetch);
		const messenger = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-imessage]")!;
			expect(node.querySelector("[data-imessage-active-title]")?.textContent).toBe("#ops");
			return node;
		});

		const badged = (selector: string) =>
			[...messenger.querySelectorAll<HTMLElement>(selector)]
				.filter((node) => node.querySelector("[data-imessage-representative]"))
				.map((node) => node.textContent);

		// Representative badge shows on the room row, header, and notify chip.
		const badge = messenger.querySelector<HTMLElement>("[data-imessage-representative]")!;
		expect(badge.textContent).toBe("rep");
		expect(badge.title).toBe("Representative");
		expect(badged("[data-imessage-notify-chip]")).toEqual(["Leadrep"]);

		// Open the Members inspector rail.
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-manage-members]")!);
		await waitFor(() => expect(messenger.querySelectorAll("[data-imessage-room-members] li")).toHaveLength(2));
		expect(badged("[data-imessage-room-members] li")).toHaveLength(1);

		// Switch representative from Lead to Frontend, then clear it.
		fireEvent.click(messenger.querySelector<HTMLButtonElement>('[data-imessage-represent-member="s-web"]')!);
		await waitFor(() => expect(badged("[data-imessage-notify-chip]")).toEqual(["Frontendrep"]));
		expect(server.mutations.at(-1)).toEqual({
			method: "POST",
			path: "/api/v1/relay/rooms/ops/members",
			body: { sessionId: "s-web", action: "represent" },
			json: true,
		});

		fireEvent.click(messenger.querySelector<HTMLButtonElement>('[data-imessage-represent-member="s-web"]')!);
		await waitFor(() => expect(messenger.querySelector("[data-imessage-representative]")).toBeNull());
		expect(server.mutations.at(-1)).toEqual({
			method: "POST",
			path: "/api/v1/relay/rooms/ops/members",
			body: { sessionId: "s-web", action: "unrepresent" },
			json: true,
		});

		// Make Lead rep again, then remove Lead — removing the rep clears representative.
		fireEvent.click(messenger.querySelector<HTMLButtonElement>('[data-imessage-represent-member="s-lead"]')!);
		await waitFor(() => expect(messenger.querySelector("[data-imessage-representative]")).toBeTruthy());
		fireEvent.click(messenger.querySelector<HTMLButtonElement>('[data-imessage-toggle-member="s-lead"]')!);
		await waitFor(() => expect(messenger.querySelectorAll("[data-imessage-room-members] li")).toHaveLength(1));
		expect(messenger.querySelector("[data-imessage-representative]")).toBeNull();

		// Add an offline recorded session from the Add member picker.
		const addOfflineBtn = await waitFor(() => {
			const node = messenger.querySelector<HTMLButtonElement>('[data-imessage-toggle-member="s-recorded"]');
			expect(node).toBeTruthy();
			return node!;
		});
		fireEvent.click(addOfflineBtn);
		await waitFor(() => expect(messenger.querySelectorAll("[data-imessage-room-members] li")).toHaveLength(2));
		expect(server.mutations.at(-1)).toEqual({
			method: "POST",
			path: "/api/v1/relay/rooms/ops/members",
			body: { sessionId: "s-recorded", action: "add" },
			json: true,
		});
	});

	const report = [
		"# Handoff",
		"",
		"## Summary",
		"",
		...Array.from({ length: 30 }, (_, i) => `- point ${i + 1}`),
		"",
		"```md",
		"## not a section",
		"```",
		"",
		"## Risks",
		"",
		"The final line.",
	].join("\n");

	const longThread = () =>
		createFakeServer({
			online: [onlineSession("s-web", { name: "Frontend", project: "pika-web" })],
			relayEvents: [
				relayEvent("e-long", 60_000, {
					from: { kind: "session", sessionId: "s-web", device: "mini", name: "Frontend" },
					to: { sessionId: "s-b", name: "Reviewer" },
					text: report,
				}),
			],
		});

	it("previews a long message with its size and sections and expands it in place on narrow screens", async () => {
		const server = longThread();
		renderApp("/chatrooms?dm=s-web", server.fetch);
		const record = await waitFor(() => {
			const node = document.querySelector<HTMLElement>('[data-imessage-bubble="e-long"]')!;
			expect(node).toBeTruthy();
			return node;
		});
		expect(record.querySelector("[data-imessage-inspect]")).toBeNull();
		expect(record.textContent).toContain("42 lines");
		expect(record.textContent).toContain("Handoff · Summary · Risks");
		expect(record.querySelector("[data-message-body]")?.textContent).not.toContain("The final line.");
		const read = within(record).getByRole("button", { name: "Show all" });
		expect(read.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(read);
		expect(record.querySelector("[data-message-body]")?.textContent).toContain("The final line.");
		expect(within(record).getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelector("[data-imessage-reader]")).toBeNull();
	});

	it("opens a long message in the reader on wide screens, with sections, raw text, and close", async () => {
		const matchMedia = window.matchMedia;
		window.matchMedia = ((query: string) => ({ ...matchMedia(query), matches: query.includes("min-width: 1280px") })) as typeof window.matchMedia;
		try {
			const server = longThread();
			renderApp("/chatrooms?dm=s-web", server.fetch);
			const record = await waitFor(() => {
				const node = document.querySelector<HTMLElement>('[data-imessage-bubble="e-long"]')!;
				expect(node).toBeTruthy();
				return node;
			});
			expect(record.querySelector("[data-imessage-inspect]")).toBeTruthy();
			fireEvent.click(within(record).getByRole("button", { name: "Read in full" }));
			const reader = screen.getByRole("complementary", { name: "Message reader" });
			expect(within(reader).getByRole("navigation", { name: "Sections" }).textContent).toBe("HandoffSummaryRisks");
			expect(reader.querySelector("[data-imessage-reader-body]")?.textContent).toContain("The final line.");
			fireEvent.click(within(reader).getByRole("button", { name: "Raw" }));
			expect(reader.querySelector("pre")?.textContent).toBe(report);
			expect(within(record).getByRole("button", { name: "Close reader" }).getAttribute("aria-pressed")).toBe("true");
			fireEvent.click(within(reader).getByRole("button", { name: "Close reader" }));
			expect(screen.queryByRole("complementary", { name: "Message reader" })).toBeNull();
		} finally {
			window.matchMedia = matchMedia;
		}
	});

	it("asks before deleting a room", async () => {
		const at = new Date().toISOString();
		const server = createFakeServer({
			relayRooms: [{ room: { name: "ops", createdAt: at, updatedAt: at, messageCount: 0, members: [] }, messages: [] }],
		});
		renderApp("/chatrooms/ops", server.fetch);
		const ask = await waitFor(() => {
			const node = document.querySelector<HTMLButtonElement>("[data-imessage-delete-room-ask]")!;
			expect(node).toBeTruthy();
			return node;
		});
		fireEvent.click(ask);
		expect(screen.getByRole("dialog", { name: "Delete #ops?" })).toBeTruthy();
		expect(server.mutations).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();

		fireEvent.click(document.querySelector<HTMLButtonElement>("[data-imessage-delete-room-ask]")!);
		fireEvent.click(document.querySelector<HTMLButtonElement>("[data-imessage-delete-room]")!);
		await waitFor(() => expect(server.mutations.map((m) => `${m.method} ${m.path}`)).toEqual(["DELETE /api/v1/relay/rooms/ops"]));
	});

	it("says plainly that a room is gone, and posting does not create it again", async () => {
		const at = new Date().toISOString();
		const server = createFakeServer({
			relayRooms: [{ room: { name: "ops", createdAt: at, updatedAt: at, messageCount: 0, members: [] }, messages: [] }],
		});
		renderApp("/chatrooms", server.fetch);
		const messenger = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-imessage-active-title]")!;
			expect(node?.textContent).toBe("#ops");
			return node.closest<HTMLElement>("[data-imessage]")!;
		});
		server.state.relayRooms.splice(0);
		fireEvent.change(messenger.querySelector<HTMLTextAreaElement>("[data-imessage-input]")!, { target: { value: "Anyone here?" } });
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-send]")!);
		const feedback = await waitFor(() => {
			const node = messenger.querySelector<HTMLElement>('[data-imessage-feedback="error"]')!;
			expect(node).toBeTruthy();
			return node;
		});
		expect(feedback.textContent).toBe("No such room. Create it here or with /relay join.");
		expect(server.state.relayRooms).toEqual([]);
	});

	it("wakes only members: a mentioned non-member is named in the feedback and is not added", async () => {
		const at = new Date().toISOString();
		const lead = { sessionId: "s-lead", device: "mini", name: "Lead", project: "pika-server", state: "idle" as const, online: true, joinedAt: at };
		const server = createFakeServer({
			online: [onlineSession("s-lead", { name: "Lead", project: "pika-server" }), onlineSession("s-bob", { name: "Bob", project: "pika-web" })],
			relayRooms: [{ room: { name: "ops", createdAt: at, updatedAt: at, messageCount: 0, members: [lead] }, messages: [] }],
		});
		renderApp("/chatrooms/ops", server.fetch);
		const messenger = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-imessage-active-title]")!;
			expect(node?.textContent).toBe("#ops");
			return node.closest<HTMLElement>("[data-imessage]")!;
		});
		fireEvent.change(messenger.querySelector<HTMLTextAreaElement>("[data-imessage-input]")!, { target: { value: "@Bob can you check?" } });
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-send]")!);
		await waitFor(() =>
			expect(messenger.querySelector('[data-imessage-feedback="ok"]')?.textContent).toBe("Posted to the room's history. Not members: @Bob"),
		);
		await waitFor(() => expect(messenger.querySelector("[data-notified]")?.textContent).toBe("Room history only; no one notified"));
		expect(server.state.relayRooms[0]!.room.members.map((m) => m.sessionId)).toEqual(["s-lead"]);

		// Only the user adds members.
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-manage-members]")!);
		fireEvent.click(messenger.querySelector<HTMLButtonElement>('[data-imessage-toggle-member="s-bob"]')!);
		await waitFor(() => expect(messenger.querySelectorAll("[data-imessage-room-members] li")).toHaveLength(2));
		expect(server.mutations.at(-1)).toEqual({
			method: "POST",
			path: "/api/v1/relay/rooms/ops/members",
			body: { sessionId: "s-bob", action: "add" },
			json: true,
		});
	});

	it("filters threads by All/Rooms/Direct and search, supports Rep quick-notify, Add by session ID, and mobile back toggle", async () => {
		const at = new Date().toISOString();
		const server = createFakeServer({
			sessions: [{ detail: summary("s-custom-id", { title: "Custom CLI session", project: "pika" }), turns: [], entries: [] }],
			online: [onlineSession("s-lead", { name: "Lead", project: "pika-server" })],
			relayRooms: [
				{
					room: {
						name: "ops",
						createdAt: at,
						updatedAt: at,
						messageCount: 0,
						members: [{ sessionId: "s-lead", device: "mini", name: "Lead", project: "pika-server", state: "idle", online: true, joinedAt: at }],
						representative: "s-lead",
					},
					messages: [],
				},
			],
		});
		renderApp("/chatrooms/ops", server.fetch);
		const messenger = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-imessage]")!;
			expect(node.querySelector("[data-imessage-active-title]")?.textContent).toBe("#ops");
			return node;
		});

		// Thread filter: All 2, Rooms 1, Direct 1.
		const filterGroup = screen.getByRole("group", { name: "Filter conversations" });
		fireEvent.click(within(filterGroup).getByRole("button", { name: "Direct 1" }));
		expect(messenger.querySelector('[data-imessage-thread="room:ops"]')).toBeNull();
		expect(messenger.querySelector('[data-imessage-thread="dm:s-lead"]')).toBeTruthy();

		fireEvent.click(within(filterGroup).getByRole("button", { name: "All 2" }));
		const search = messenger.querySelector<HTMLInputElement>("[data-imessage-search]")!;
		fireEvent.change(search, { target: { value: "ops" } });
		expect(messenger.querySelector('[data-imessage-thread="room:ops"]')).toBeTruthy();
		expect(messenger.querySelector('[data-imessage-thread="dm:s-lead"]')).toBeNull();
		fireEvent.change(search, { target: { value: "" } });

		// Rep quick-notify button selects the room's representative.
		const repQuickBtn = messenger.querySelector<HTMLButtonElement>('[data-imessage-notify-rep="s-lead"]')!;
		expect(repQuickBtn.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(repQuickBtn);
		expect(repQuickBtn.getAttribute("aria-pressed")).toBe("true");

		// Add by session ID in the Members rail.
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-manage-members]")!);
		const idInput = screen.getByLabelText("Session ID to add") as HTMLInputElement;
		fireEvent.change(idInput, { target: { value: "s-custom-id" } });
		fireEvent.submit(idInput.closest("form")!);
		await waitFor(() => expect(messenger.querySelectorAll("[data-imessage-room-members] li")).toHaveLength(2));

		// Mobile master/detail back button switches from chat pane to thread directory.
		const rail = screen.getByLabelText("Thread directory");
		expect(rail.classList.contains("max-md:hidden")).toBe(true);
		fireEvent.click(messenger.querySelector<HTMLButtonElement>("[data-imessage-back]")!);
		expect(rail.classList.contains("max-md:hidden")).toBe(false);
	});

	it("renders @mention chips only in plain prose and links recorded message senders", async () => {
		const at = new Date().toISOString();
		const server = createFakeServer({
			online: [onlineSession("s-lead", { name: "Lead", project: "pika-server", recorded: true })],
			relayRooms: [
				{
					room: {
						name: "ops",
						createdAt: at,
						updatedAt: at,
						messageCount: 1,
						members: [{ sessionId: "s-lead", device: "mini", name: "Lead", project: "pika-server", state: "idle", online: true, joinedAt: at }],
					},
					messages: [
						{
							id: "m-mentions",
							seq: 1,
							room: "ops",
							from: { kind: "session", sessionId: "s-lead", device: "mini", name: "Lead", project: "pika-server" },
							text: [
								"@rhea @stackbench check `@ignored_inline` and [@ignored_link](https://example.com) or ops@example.com.",
								"",
								"```sh",
								"echo @ignored_fenced",
								"```",
							].join("\n"),
							mentions: [],
							notified: [],
							urgent: false,
							hops: 1,
							at,
						},
					],
				},
			],
		});
		renderApp("/chatrooms/ops", server.fetch);
		const bubble = await waitFor(() => {
			const node = document.querySelector<HTMLElement>('[data-imessage-bubble="m-mentions"]');
			expect(node).toBeTruthy();
			return node!;
		});

		const senderLink = bubble.querySelector<HTMLAnchorElement>("a[data-sender]")!;
		expect(senderLink.getAttribute("href")).toBe("/s/s-lead");

		const chips = [...bubble.querySelectorAll("[data-message-body] [data-mention]")].map((el) => el.textContent);
		expect(chips).toEqual(["@rhea", "@stackbench"]);
	});
});
