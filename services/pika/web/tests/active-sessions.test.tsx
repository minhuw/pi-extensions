import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAYOUT_GUARD_MS } from "../src/lib/hooks";
import { HEALTH_RETRY_MS, RELAY_BADGE_POLL_MS, RELAY_POLL_MS } from "../src/lib/relay";
import { onlineSession, relayEvent, summary } from "./support/fixtures";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

const SESSIONS = "/api/v1/relay/sessions";
const BARE_ID = "cccc3333-0000-4000-8000-000000000001";
const EVENTS = "/api/v1/relay/events";

function count(server: { calls: string[] }, path: string): number {
	return server.calls.filter((call) => call === path).length;
}

function relayCalls(server: { calls: string[] }): string[] {
	return server.calls.filter((call) => call.startsWith("/api/v1/relay/"));
}

async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

/** Advances the clock in small steps until `done`, so a guard that started meanwhile hasn't run out yet. */
async function advanceUntil(done: () => boolean, limitMs = RELAY_POLL_MS * 2): Promise<void> {
	for (let elapsed = 0; elapsed < limitMs; elapsed += 100) {
		if (done()) return;
		await advance(100);
	}
	throw new Error("timed out");
}

/** Hides or shows the tab the way a browser does; TanStack Query pauses interval refetches while hidden. */
function setHidden(hidden: boolean): void {
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
	document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
}

function row(id: string): HTMLElement {
	const node = document.querySelector<HTMLElement>(`[data-online-session="${id}"]`);
	if (!node) throw new Error(`no row for ${id}`);
	return node;
}

function rowIds(): string[] {
	return [...document.querySelectorAll<HTMLElement>("[data-online-session]")].map((node) => node.dataset.onlineSession ?? "");
}

function eventIds(): string[] {
	return [...document.querySelectorAll<HTMLElement>("[data-relay-event]")].map((node) => node.dataset.relayEvent ?? "");
}

function event(id: string): HTMLElement {
	const node = document.querySelector<HTMLElement>(`[data-relay-event="${id}"]`);
	if (!node) throw new Error(`no event ${id}`);
	return node;
}

async function nav(): Promise<HTMLElement> {
	return screen.findByRole("navigation", { name: "Main" });
}

async function openComposer(label: string): Promise<{ dialog: HTMLElement; text: HTMLTextAreaElement }> {
	fireEvent.click(await screen.findByRole("button", { name: `Message ${label}` }));
	const dialog = screen.getByRole("dialog", { name: `Message ${label}` });
	return { dialog, text: within(dialog).getByLabelText("Message text") as HTMLTextAreaElement };
}

afterEach(() => {
	vi.useRealTimers();
	if (Object.prototype.hasOwnProperty.call(document, "visibilityState")) {
		delete (document as { visibilityState?: unknown }).visibilityState;
		document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
	}
});

describe("active sessions page", () => {
	it("groups online sessions by device, oldest connection first", async () => {
		const server = createFakeServer({
			online: [
				onlineSession("aaaa1111-0000", { name: "Refactor the parser", state: "busy", onlineMs: 2 * 3_600_000 + 5 * 60_000, model: "gpt-5" }),
				onlineSession("bbbb2222-0000", { name: undefined, title: "Fix the flaky test", onlineMs: 10 * 60_000, recorded: false, stateMs: 30_000 }),
				onlineSession(BARE_ID, {
					device: "laptop",
					host: "laptop.local",
					name: undefined,
					title: undefined,
					model: undefined,
					project: "dotfiles",
					cwd: "/Users/me/dotfiles",
					onlineMs: 30_000,
				}),
			],
		});
		renderApp("/active", server.fetch);
		expect(await screen.findByRole("heading", { name: "Active sessions", level: 1 })).toBeTruthy();
		await waitFor(() => expect(rowIds()).toHaveLength(3));

		const groups = [...document.querySelectorAll<HTMLElement>("[data-relay-device]")].map((group) => group.dataset.relayDevice);
		expect(groups).toEqual(["laptop", "mini"]);
		const mini = screen.getByRole("region", { name: "Sessions on mini" });
		expect(within(mini).getByText("2 sessions")).toBeTruthy();
		expect(within(mini).getByText("mini.lan")).toBeTruthy();
		// The server lists the newest first; newcomers append below instead of pushing the others down.
		expect(rowIds()).toEqual([BARE_ID, "aaaa1111-0000", "bbbb2222-0000"]);

		const busy = row("aaaa1111-0000");
		const link = within(busy).getByRole("link", { name: "Refactor the parser" });
		expect(link.getAttribute("href")).toBe("/s/aaaa1111-0000");
		expect(busy.querySelector("[data-session-state]")?.getAttribute("data-session-state")).toBe("busy");
		expect(within(busy).getByText("Busy")).toBeTruthy();
		expect(within(busy).getByText("gpt-5")).toBeTruthy();
		expect(within(busy).getByText("pika")).toBeTruthy();
		expect(within(busy).getByText("/home/me/code/pika")).toBeTruthy();
		expect(within(busy).getByText("Online 2h 5m")).toBeTruthy();
		expect(within(busy).getByText("Last activity 3 minutes ago")).toBeTruthy();

		// Not recorded: the title shows, without a link to a page pika doesn't have.
		const unrecorded = row("bbbb2222-0000");
		expect(within(unrecorded).getByText("Fix the flaky test")).toBeTruthy();
		expect(within(unrecorded).queryByRole("link")).toBeNull();
		expect(within(unrecorded).getByText("Idle")).toBeTruthy();
		expect(within(unrecorded).getByText("Online 10m")).toBeTruthy();
		expect(within(unrecorded).getByText("Last activity just now")).toBeTruthy();

		// Neither name nor title: the UUID, cut short.
		const bare = row(BARE_ID);
		expect(within(bare).getByRole("link", { name: "cccc3333" })).toBeTruthy();
		expect(within(bare).getByText("dotfiles")).toBeTruthy();
		expect(within(bare).getByText("Online <1m")).toBeTruthy();
		expect(bare.querySelector("[data-model]")).toBeNull();
		expect(within(bare).getByRole("button", { name: "Message cccc3333" })).toBeTruthy();
		// The row has no label of its own, so screen readers read its content.
		expect(rowIds().map((id) => row(id).getAttribute("aria-label"))).toEqual([null, null, null]);
	});

	it("explains how sessions appear when none are online", async () => {
		renderApp("/active", createFakeServer({}).fetch);
		const empty = await screen.findByText("No sessions online");
		const text = empty.parentElement?.textContent ?? "";
		expect(text).toContain("pi sessions logged into pika appear here while they run");
		expect(text).toContain("relay extension");
		expect(text).toContain("/pika login");
		expect(await screen.findByText(/No messages yet/)).toBeTruthy();
	});

	it("polls sessions and messages every 3 seconds, and pauses while the tab is hidden", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = createFakeServer({ online: [onlineSession("s-a")] });
		renderApp("/active", server.fetch);
		await waitFor(() => expect(rowIds()).toEqual(["s-a"]));
		await waitFor(() => expect(count(server, EVENTS)).toBe(1));
		expect(count(server, SESSIONS)).toBe(1);

		server.state.online.push(onlineSession("s-b", { device: "laptop" }));
		server.state.relayEvents.unshift(relayEvent("m1"));
		await advance(RELAY_POLL_MS);
		await waitFor(() => expect(rowIds()).toEqual(["s-b", "s-a"]));
		await waitFor(() => expect(eventIds()).toEqual(["m1"]));
		expect(count(server, SESSIONS)).toBe(2);
		expect(count(server, EVENTS)).toBe(2);

		setHidden(true);
		await advance(RELAY_POLL_MS * 3);
		expect(count(server, SESSIONS)).toBe(2);
		expect(count(server, EVENTS)).toBe(2);

		setHidden(false);
		await advance(RELAY_POLL_MS);
		await waitFor(() => expect(count(server, SESSIONS)).toBe(3));
		expect(count(server, EVENTS)).toBe(3);
		// The layout's slower poll stays off here, so the page's poll is the only one.
		await advance(RELAY_BADGE_POLL_MS);
		expect(count(server, SESSIONS)).toBe(3 + RELAY_BADGE_POLL_MS / RELAY_POLL_MS);
	});

	it("disables Message for a moment after sessions come or go", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		renderApp("/active", server.fetch);
		const alpha = (await screen.findByRole("button", { name: "Message Alpha" })) as HTMLButtonElement;
		// Not when the list first loads.
		expect(alpha.disabled).toBe(false);

		server.state.online.push(onlineSession("s-b", { name: "Beta", onlineMs: 1_000 }));
		await advanceUntil(() => screen.queryByRole("button", { name: "Message Beta" }) !== null);
		const beta = screen.getByRole("button", { name: "Message Beta" }) as HTMLButtonElement;
		expect((screen.getByRole("button", { name: "Message Alpha" }) as HTMLButtonElement).disabled).toBe(true);
		expect(beta.disabled).toBe(true);
		fireEvent.click(beta);
		expect(screen.queryByRole("dialog")).toBeNull();
		await advance(LAYOUT_GUARD_MS);
		expect((screen.getByRole("button", { name: "Message Beta" }) as HTMLButtonElement).disabled).toBe(false);

		// A session leaving moves the rows too.
		server.state.online = server.state.online.filter((item) => item.id !== "s-a");
		await advanceUntil(() => screen.queryByRole("button", { name: "Message Alpha" }) === null);
		expect((screen.getByRole("button", { name: "Message Beta" }) as HTMLButtonElement).disabled).toBe(true);
		await advance(LAYOUT_GUARD_MS);
		expect((screen.getByRole("button", { name: "Message Beta" }) as HTMLButtonElement).disabled).toBe(false);
	});
});

describe("device names", () => {
	const MAC_A = "4f1c2b9e-0d7a-4c3e-9b8f-2a6d5e1c0b7a";
	const MAC_B = "0a9b8c7d-1111-4222-8333-444455556666";

	it("groups sessions by device id, headed and sorted by the device's name", async () => {
		const server = createFakeServer({
			online: [
				onlineSession("s-1", { device: MAC_A, deviceName: "MacBook", host: "macbook-a.local", onlineMs: 60_000 }),
				onlineSession("s-2", { device: MAC_B, deviceName: "MacBook", host: "macbook-b.local", onlineMs: 50_000 }),
				onlineSession("s-3", { device: "zz-legacy", deviceName: "alpha box", onlineMs: 40_000 }),
				onlineSession("s-4", { device: "old-server", deviceName: undefined, host: "old-server", onlineMs: 30_000 }),
				onlineSession("s-5", { device: MAC_A, deviceName: "MacBook", host: "macbook-a.local", onlineMs: 20_000 }),
			],
		});
		renderApp("/active", server.fetch);
		await waitFor(() => expect(rowIds()).toHaveLength(5));
		const groups = [...document.querySelectorAll<HTMLElement>("[data-relay-device]")];
		// By name case-insensitively, then id; a device without a name goes by its id.
		expect(groups.map((group) => [group.dataset.relayDevice, group.dataset.deviceName])).toEqual([
			["zz-legacy", "alpha box"],
			[MAC_B, "MacBook"],
			[MAC_A, "MacBook"],
			["old-server", "old-server"],
		]);
		expect(groups[0].getAttribute("aria-label")).toBe("Sessions on alpha box");
		expect(within(groups[0]).getByText("alpha box")).toBeTruthy();
		expect(within(groups[0]).queryByText("zz-legacy")).toBeNull();
		expect(within(groups[2]).getByText("2 sessions")).toBeTruthy();
		expect(within(groups[2]).getByText("macbook-a.local")).toBeTruthy();
		expect(rowIds()).toEqual(["s-3", "s-2", "s-1", "s-5", "s-4"]);
		// A host the same as the name or id is not repeated.
		expect(within(groups[3]).getAllByText("old-server")).toHaveLength(1);
	});

	it("names devices in messages, falling back to their ids", async () => {
		const server = createFakeServer({
			relayEvents: [
				relayEvent("m1", 60_000, {
					from: { kind: "session", sessionId: "s-a", device: MAC_A, deviceName: "Studio Mac", name: "Planner" },
					to: { sessionId: "s-b", device: "laptop", name: "Reviewer" },
				}),
			],
		});
		renderApp("/active", server.fetch);
		await waitFor(() => expect(eventIds()).toEqual(["m1"]));
		expect(within(event("m1")).getByText("Planner on Studio Mac")).toBeTruthy();
		expect(within(event("m1")).getByText("Reviewer on laptop")).toBeTruthy();
	});

	it("names the device in the composer and its result", async () => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha", device: MAC_A, deviceName: "Studio Mac" })] });
		renderApp("/active", server.fetch);
		const { dialog, text } = await openComposer("Alpha");
		expect(dialog.textContent).toContain("Studio Mac");
		expect(dialog.textContent).not.toContain(MAC_A);
		fireEvent.change(text, { target: { value: "hi" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
		expect(await within(dialog).findByText("Delivered to Alpha on Studio Mac.")).toBeTruthy();
	});
});

describe("message composer", () => {
	it("sends with Ctrl+Enter and shows that the message was delivered", async () => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		renderApp("/active", server.fetch);
		const { dialog, text } = await openComposer("Alpha");
		expect(document.activeElement).toBe(text);
		const send = within(dialog).getByRole("button", { name: "Send" }) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		fireEvent.change(text, { target: { value: "Please rebase onto main." } });
		expect(send.disabled).toBe(false);
		fireEvent.keyDown(text, { key: "Enter", ctrlKey: true });

		const result = await within(dialog).findByText("Delivered to Alpha on mini.");
		expect(result.closest("[data-send-result]")?.getAttribute("data-send-result")).toBe("delivered");
		expect(result.closest("[role=status]")).toBeTruthy();
		expect(server.mutations).toEqual([
			{ method: "POST", path: "/api/v1/relay/messages", body: { to: "s-a", text: "Please rebase onto main.", urgent: false }, json: true },
		]);
		// Ready for another message.
		expect(text.value).toBe("");

		// The message shows in Recent messages without waiting for the next poll.
		const sent = await waitFor(() => event("web-1"));
		expect(within(sent).getByText("You (web)")).toBeTruthy();
		expect(within(sent).getByText("Alpha on mini")).toBeTruthy();
		expect(within(sent).getByText("delivered")).toBeTruthy();
	});

	it("sends with Cmd+Enter, marks urgent, and reports a queued message", async () => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		server.state.relayAck = false;
		renderApp("/active", server.fetch);
		const { dialog, text } = await openComposer("Alpha");
		fireEvent.change(text, { target: { value: "Stop and check the logs." } });
		fireEvent.click(within(dialog).getByRole("checkbox", { name: /Urgent/ }));
		fireEvent.keyDown(text, { key: "Enter", metaKey: true });
		const result = await within(dialog).findByText(/^Queued for Alpha on mini: it has not been delivered yet\./);
		expect(result.textContent).toContain("within 5 minutes it is dropped");
		expect(server.mutations.map((m) => m.body)).toEqual([{ to: "s-a", text: "Stop and check the logs.", urgent: true }]);
		expect((within(dialog).getByRole("checkbox", { name: /Urgent/ }) as HTMLInputElement).checked).toBe(false);
		const queued = await waitFor(() => event("web-1"));
		expect(within(queued).getByText("queued")).toBeTruthy();
		expect(within(queued).getByText("urgent")).toBeTruthy();
	});

	it.each([
		["rate_limited", "Too many messages in the last minute. Wait a moment and try again."],
		["mailbox_full", "Too many messages are waiting to be delivered. Try again later."],
		["unknown_session", "pika doesn't know this session: it is offline and was never uploaded."],
		["too_large", "The message is too long: the limit is 32 KiB."],
		["invalid", "The message is empty or the session id is not valid."],
	])("shows a %s refusal as a readable reason and keeps the text", async (reason, message) => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		server.state.relayFailure = reason;
		renderApp("/active", server.fetch);
		const { dialog, text } = await openComposer("Alpha");
		fireEvent.change(text, { target: { value: "Hello" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
		const alert = await within(dialog).findByRole("alert");
		expect(alert.textContent).toContain("Not sent");
		expect(alert.textContent).toContain(message);
		expect(text.value).toBe("Hello");
		const rejected = await waitFor(() => event("web-1"));
		expect(rejected.dataset.status).toBe("rejected");
	});

	it("reads mailbox_full from a 429 as a full mailbox", async () => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		server.state.relayFailure = "mailbox_full";
		const statuses: number[] = [];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const response = await server.fetch(input, init);
			if (String(input).includes("relay/messages")) statuses.push(response.status);
			return response;
		}) as typeof fetch;
		renderApp("/active", fetchImpl);
		const { dialog, text } = await openComposer("Alpha");
		fireEvent.change(text, { target: { value: "Hello" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
		expect((await within(dialog).findByRole("alert")).textContent).toContain("Too many messages are waiting to be delivered. Try again later.");
		expect(statuses).toEqual([429]);
		expect(within(await waitFor(() => event("web-1"))).getByText("rejected: mailbox full")).toBeTruthy();
	});

	it("says relay is off when a send gets relay_disabled", async () => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		renderApp("/active", server.fetch);
		const { dialog, text } = await openComposer("Alpha");
		server.state.relay = false;
		fireEvent.change(text, { target: { value: "Hello" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
		expect((await within(dialog).findByRole("alert")).textContent).toContain("Relay is turned off on this server.");
	});

	it("refuses text over 32 KiB before sending", async () => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		renderApp("/active", server.fetch);
		const { dialog, text } = await openComposer("Alpha");
		fireEvent.change(text, { target: { value: "é".repeat(16 * 1024 + 1) } });
		expect(within(dialog).getByText("The message is too long: the limit is 32 KiB.")).toBeTruthy();
		const send = within(dialog).getByRole("button", { name: "Send" }) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		fireEvent.keyDown(text, { key: "Enter", ctrlKey: true });
		expect(server.mutations).toEqual([]);
	});

	it("closes on Escape only while empty and returns focus to its button; plain Enter adds a line", async () => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		renderApp("/active", server.fetch);
		const opener = await screen.findByRole("button", { name: "Message Alpha" });
		opener.focus();
		fireEvent.click(opener);
		const text = within(screen.getByRole("dialog")).getByLabelText("Message text") as HTMLTextAreaElement;
		fireEvent.change(text, { target: { value: "Hello" } });
		fireEvent.keyDown(text, { key: "Enter" });
		expect(server.mutations).toEqual([]);

		// Typed text survives Escape, as it survives a click on the backdrop.
		fireEvent.keyDown(text, { key: "Escape" });
		expect(screen.getByRole("dialog")).toBeTruthy();
		expect(text.value).toBe("Hello");
		fireEvent.click(screen.getByRole("dialog").parentElement!);
		expect(screen.getByRole("dialog")).toBeTruthy();

		fireEvent.change(text, { target: { value: "" } });
		// Escape that ends an input method composition is not for the dialog.
		fireEvent.keyDown(text, { key: "Escape", isComposing: true });
		expect(screen.getByRole("dialog")).toBeTruthy();
		fireEvent.keyDown(text, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Message Alpha" }));
	});

	it("keeps the previous result, below the buttons, while the next message is sending", async () => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		renderApp("/active", server.fetch);
		const { dialog, text } = await openComposer("Alpha");
		fireEvent.change(text, { target: { value: "First" } });
		fireEvent.keyDown(text, { key: "Enter", ctrlKey: true });
		await within(dialog).findByText("Delivered to Alpha on mini.");
		const result = () => dialog.querySelector<HTMLElement>("[data-send-result]");
		const close = within(dialog).getByRole("button", { name: "Close" });
		// Results and the length warning come after the buttons, so they never push them around.
		expect(close.compareDocumentPosition(result()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		let release!: () => void;
		server.state.relayHold = new Promise((resolve) => (release = resolve));
		server.state.relayAck = false;
		fireEvent.change(text, { target: { value: "Second" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
		expect(await within(dialog).findByRole("button", { name: "Sending…" })).toBeTruthy();
		expect(result()?.dataset.sendResult).toBe("delivered");
		expect(result()?.getAttribute("aria-busy")).toBe("true");

		release();
		await waitFor(() => expect(result()?.dataset.sendResult).toBe("queued"));
		expect(result()?.hasAttribute("aria-busy")).toBe(false);

		fireEvent.change(text, { target: { value: "x".repeat(32 * 1024 + 1) } });
		const warning = within(dialog).getByText("The message is too long: the limit is 32 KiB.");
		expect(close.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("sends once when Ctrl+Enter is pressed twice before it re-renders", async () => {
		const server = createFakeServer({ online: [onlineSession("s-a", { name: "Alpha" })] });
		renderApp("/active", server.fetch);
		const { dialog, text } = await openComposer("Alpha");
		fireEvent.change(text, { target: { value: "Only once" } });
		act(() => {
			fireEvent.keyDown(text, { key: "Enter", ctrlKey: true });
			fireEvent.keyDown(text, { key: "Enter", ctrlKey: true });
		});
		await within(dialog).findByText("Delivered to Alpha on mini.");
		expect(server.mutations).toHaveLength(1);
	});
});

describe("recent messages", () => {
	it("lists messages newest first with sender, target, status, and time", async () => {
		const server = createFakeServer({
			relayEvents: [
				relayEvent("m4", 5_000, { status: "queued", urgent: true }),
				relayEvent("m3", 60_000, {
					from: { kind: "web" },
					to: { sessionId: "deadbeef-1234-4abc-8def-0123456789ab" },
					status: "rejected",
					reason: "unknown_session",
				}),
				relayEvent("m2", 120_000, { status: "expired", replyTo: "m1" }),
				relayEvent("m1", 3_600_000, {
					from: { kind: "session", sessionId: "s-c", device: "studio", title: "Write docs" },
					status: "rejected",
					reason: "hop_limit",
				}),
			],
		});
		renderApp("/active", server.fetch);
		await waitFor(() => expect(eventIds()).toEqual(["m4", "m3", "m2", "m1"]));

		const queued = event("m4");
		expect(within(queued).getByText("Planner on mini")).toBeTruthy();
		expect(within(queued).getByText("Reviewer on laptop")).toBeTruthy();
		expect(within(queued).getByText("queued")).toBeTruthy();
		expect(within(queued).getByText("urgent")).toBeTruthy();
		expect(within(queued).getByText("just now")).toBeTruthy();
		expect(within(queued).getByText("Message m4")).toBeTruthy();

		const web = event("m3");
		expect(within(web).getByText("You (web)")).toBeTruthy();
		expect(within(web).getByText("deadbeef")).toBeTruthy();
		expect(web.querySelector("[data-target]")?.getAttribute("title")).toBe("deadbeef-1234-4abc-8def-0123456789ab");
		expect(within(web).getByText("rejected: unknown session")).toBeTruthy();
		expect(within(web).getByText("1 minute ago")).toBeTruthy();

		expect(within(event("m2")).getByText("expired")).toBeTruthy();
		expect(within(event("m2")).getByText("reply")).toBeTruthy();
		expect(within(event("m1")).getByText("Write docs on studio")).toBeTruthy();
		expect(within(event("m1")).getByText("rejected: too many hops")).toBeTruthy();
		expect(within(event("m1")).getByText("1 hour ago")).toBeTruthy();
	});

	it("cuts only UUIDs short and shows other ids in full, ending long ones in an ellipsis", async () => {
		const server = createFakeServer({
			relayEvents: [
				relayEvent("m2", 60_000, { to: { sessionId: "no-such-session" } }),
				relayEvent("m1", 120_000, {
					from: { kind: "session", sessionId: "0199aa00-1111-7222-8333-444455556666", device: "mini" },
					to: { sessionId: "a".repeat(120) },
				}),
			],
		});
		renderApp("/active", server.fetch);
		await waitFor(() => expect(eventIds()).toEqual(["m2", "m1"]));
		const target = event("m2").querySelector<HTMLElement>("[data-target]")!;
		expect(target.textContent).toBe("no-such-session");
		expect(target.classList.contains("truncate")).toBe(true);
		expect(within(event("m1")).getByText("0199aa00 on mini").classList.contains("truncate")).toBe(true);
		const long = event("m1").querySelector<HTMLElement>("[data-target]")!;
		expect(long.textContent).toBe("a".repeat(120));
		expect(long.classList.contains("truncate")).toBe(true);
		// Names wrap instead.
		const named = event("m2").querySelector<HTMLElement>("[data-sender] span:last-child")!;
		expect(named.textContent).toBe("Planner on mini");
		expect(named.classList.contains("break-words")).toBe(true);
	});

	it("collapses long text to three lines and expands it, keeping that across polls", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const long = ["First line", "Second line", "Third line", "Fourth line", "Fifth line"].join("\n");
		const server = createFakeServer({ relayEvents: [relayEvent("long", 60_000, { text: long }), relayEvent("short", 120_000)] });
		renderApp("/active", server.fetch);
		await waitFor(() => expect(eventIds()).toEqual(["long", "short"]));

		expect(within(event("short")).queryByRole("button")).toBeNull();
		const text = event("long").querySelector<HTMLElement>("[data-event-text]")!;
		expect(text.textContent).toBe(long);
		expect(text.classList.contains("line-clamp-3")).toBe(true);
		const toggle = within(event("long")).getByRole("button", { name: "Show more" });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.getAttribute("aria-controls")).toBe(text.id);

		fireEvent.click(toggle);
		expect(text.classList.contains("line-clamp-3")).toBe(false);
		expect(within(event("long")).getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");

		// The status changes in place on the next poll; the message stays expanded.
		server.state.relayEvents[1] = { ...server.state.relayEvents[1], status: "expired" };
		server.state.relayEvents[0] = { ...server.state.relayEvents[0], status: "queued" };
		await advance(RELAY_POLL_MS);
		await waitFor(() => expect(event("long").dataset.status).toBe("queued"));
		expect(event("long").querySelector("[data-event-text]")?.classList.contains("line-clamp-3")).toBe(false);

		fireEvent.click(within(event("long")).getByRole("button", { name: "Show less" }));
		expect(event("long").querySelector("[data-event-text]")?.classList.contains("line-clamp-3")).toBe(true);
	});

	it("collapses a single long paragraph too", async () => {
		renderApp("/active", createFakeServer({ relayEvents: [relayEvent("para", 60_000, { text: "word ".repeat(100) })] }).fetch);
		expect(await within(await waitFor(() => event("para"))).findByRole("button", { name: "Show more" })).toBeTruthy();
	});
});

describe("active sessions in the band", () => {
	it("sits above Devices with a count of online sessions, refreshed on other pages", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = createFakeServer({ online: [onlineSession("s-a"), onlineSession("s-b", { device: "laptop" })] });
		renderApp("/", server.fetch);
		const main = await nav();
		const item = await within(main).findByRole("link", { name: /^Active sessions/ });
		await waitFor(() => expect(item.querySelector("[data-online-count]")?.textContent).toBe("2 online"));
		const links = within(main)
			.getAllByRole("link")
			.map((link) => link.getAttribute("href"));
		expect(links.slice(0, 5)).toEqual(["/", "/runs", "/active", "/devices", "/search"]);

		server.state.online.push(onlineSession("s-c"));
		await advance(RELAY_BADGE_POLL_MS);
		await waitFor(() => expect(item.querySelector("[data-online-count]")?.textContent).toBe("3 online"));
		expect(count(server, SESSIONS)).toBe(2);

		fireEvent.click(item);
		expect(await screen.findByRole("heading", { name: "Active sessions", level: 1 })).toBeTruthy();
		await waitFor(() => expect(rowIds()).toHaveLength(3));
		// On the page, the badge follows the page's faster poll.
		server.state.online = [];
		await advance(RELAY_POLL_MS);
		await waitFor(() => expect(item.querySelector("[data-online-count]")).toBeNull());
		expect(screen.getByText("No sessions online")).toBeTruthy();
	});

	it("retries a failed health request, then keeps asking slowly until the item can show", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const blip = createFakeServer({ online: [onlineSession("s-a")] });
		blip.state.healthFailures = 1;
		const first = renderApp("/", blip.fetch);
		// One failure is retried within a second or two.
		await advance(1_000);
		await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", { name: /^Active sessions/ })).toBeTruthy());
		first.unmount();

		const down = createFakeServer({ online: [onlineSession("s-a")] });
		down.state.healthFailures = 3;
		renderApp("/", down.fetch);
		const main = await nav();
		await advance(1_000 + 2_000);
		await waitFor(() => expect(count(down, "/api/health")).toBe(3));
		expect(within(main).queryByRole("link", { name: /Active sessions/ })).toBeNull();
		// Back up: the slow retry brings the item and its badge back without a reload.
		await advance(HEALTH_RETRY_MS);
		const item = await within(main).findByRole("link", { name: /^Active sessions/ });
		await waitFor(() => expect(item.querySelector("[data-online-count]")?.textContent).toBe("1 online"));
		// Once health answers, it stops asking.
		const asked = count(down, "/api/health");
		await advance(HEALTH_RETRY_MS * 2);
		expect(count(down, "/api/health")).toBe(asked);
	});

	it("stops polling relay once signing out starts", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = createFakeServer({ password: "secret", authenticated: true, online: [onlineSession("s-a")] });
		renderApp("/active", server.fetch);
		await waitFor(() => expect(rowIds()).toEqual(["s-a"]));
		fireEvent.click(within(await screen.findByRole("banner")).getByRole("button", { name: /Sign out/ }));
		expect(await screen.findByLabelText(/password/i)).toBeTruthy();
		const before = relayCalls(server).length;
		await advance(RELAY_POLL_MS * 3);
		expect(relayCalls(server).length).toBe(before);
	});

	it("hides the item and explains on the page when the server runs with PIKA_RELAY=off", async () => {
		const server = createFakeServer({ features: [] });
		renderApp("/active", server.fetch);
		const callout = await screen.findByText("Relay is turned off on this server");
		expect(callout.closest("[data-callout]")?.textContent).toContain("PIKA_RELAY=off");
		expect(within(await nav()).queryByRole("link", { name: /Active sessions/ })).toBeNull();
		expect(within(await nav()).getByRole("link", { name: "Devices" })).toBeTruthy();
		expect(relayCalls(server)).toEqual([]);
	});

	it("hides the item and says the server is too old when health has no features", async () => {
		const server = createFakeServer({ features: null });
		renderApp("/active", server.fetch);
		const callout = await screen.findByText("This pika server has no relay");
		expect(callout.closest("[data-callout]")?.textContent).toContain("too old");
		expect(within(await nav()).queryByRole("link", { name: /Active sessions/ })).toBeNull();
		expect(relayCalls(server)).toEqual([]);
	});

	it("hides the item and stops polling once relay routes answer relay_disabled", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = createFakeServer({ online: [onlineSession("s-a")] });
		renderApp("/active", server.fetch);
		await waitFor(() => expect(rowIds()).toEqual(["s-a"]));
		expect(within(await nav()).getByRole("link", { name: /^Active sessions/ })).toBeTruthy();

		server.state.relay = false;
		await advance(RELAY_POLL_MS);
		expect(await screen.findByText("Relay is turned off on this server")).toBeTruthy();
		expect(within(await nav()).queryByRole("link", { name: /Active sessions/ })).toBeNull();
		expect(document.querySelector("[data-online-session]")).toBeNull();
		const before = relayCalls(server).length;
		await advance(RELAY_POLL_MS * 3);
		expect(relayCalls(server).length).toBe(before);
	});
});

describe("session page", () => {
	const recorded = { detail: summary("s-a", { title: "Refactor the parser" }), turns: [], entries: [] };

	it("shows an Online badge and a Message action while the session is online", async () => {
		const server = createFakeServer({ sessions: [recorded], online: [onlineSession("s-a", { name: "parser" })] });
		renderApp("/s/s-a", server.fetch);
		expect(await screen.findByRole("heading", { name: "Refactor the parser", level: 1 })).toBeTruthy();
		await waitFor(() => expect(document.querySelector("[data-online]")?.textContent).toBe("Online"));
		fireEvent.click(screen.getByRole("button", { name: "Message this session" }));
		const dialog = screen.getByRole("dialog", { name: "Message parser" });
		const text = within(dialog).getByLabelText("Message text");
		fireEvent.change(text, { target: { value: "How is it going?" } });
		fireEvent.keyDown(text, { key: "Enter", ctrlKey: true });
		expect(await within(dialog).findByText("Delivered to parser on mini.")).toBeTruthy();
		expect(server.mutations.map((m) => m.body)).toEqual([{ to: "s-a", text: "How is it going?", urgent: false }]);
	});

	it("shows neither when the session is offline", async () => {
		const server = createFakeServer({ sessions: [recorded], online: [onlineSession("s-other")] });
		renderApp("/s/s-a", server.fetch);
		expect(await screen.findByRole("heading", { name: "Refactor the parser", level: 1 })).toBeTruthy();
		await waitFor(() => expect(count(server, SESSIONS)).toBe(1));
		expect(document.querySelector("[data-online]")).toBeNull();
		expect(screen.queryByRole("button", { name: "Message this session" })).toBeNull();
	});

	it("shows neither when relay is off", async () => {
		const server = createFakeServer({ sessions: [recorded], features: [], online: [onlineSession("s-a")] });
		renderApp("/s/s-a", server.fetch);
		expect(await screen.findByRole("heading", { name: "Refactor the parser", level: 1 })).toBeTruthy();
		await waitFor(() => expect(server.calls).toContain("/api/health"));
		expect(document.querySelector("[data-online]")).toBeNull();
		expect(relayCalls(server)).toEqual([]);
	});
});
