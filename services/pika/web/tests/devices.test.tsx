import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAYOUT_GUARD_MS, PAIRINGS_POLL_MS } from "../src/pages/Devices";
import { browserSession, device, pairing, SAFARI_MAC } from "./support/fixtures";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

function card(code: string): HTMLElement {
	return screen.getByRole("region", { name: `Pairing request ${code}` });
}

async function findCard(code: string): Promise<HTMLElement> {
	return screen.findByRole("region", { name: `Pairing request ${code}` });
}

/** Seconds left on a request's countdown. */
function countdown(code: string): number {
	const match = /^Expires in (\d+):(\d\d)$/.exec(card(code).querySelector("[data-expires]")?.textContent ?? "");
	if (!match) throw new Error("no countdown");
	return Number(match[1]) * 60 + Number(match[2]);
}

/** The codes of the pairing cards, in page order. */
function cardOrder(): string[] {
	return [...document.querySelectorAll<HTMLElement>("[data-pairing]")].map((node) => node.dataset.pairing ?? "");
}

async function nextPoll(): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(PAIRINGS_POLL_MS);
	});
}

function approveButton(code: string): HTMLButtonElement {
	return within(card(code)).getByRole("button", { name: `Approve ${code}` }) as HTMLButtonElement;
}

function deviceTable(): HTMLElement {
	const table = document.querySelector<HTMLElement>("[data-device-list]");
	if (!table) throw new Error("no device list");
	return table;
}

function signedIn(extra: Parameters<typeof createFakeServer>[0] = {}) {
	return createFakeServer({ password: "hunter2", authenticated: true, ...extra });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("devices page", () => {
	it("is linked from the sidebar between Herder runs and Search", async () => {
		renderApp("/", createFakeServer({}).fetch);
		const nav = await screen.findByRole("navigation", { name: "Main" });
		const links = within(nav)
			.getAllByRole("link")
			.map((link) => link.textContent);
		expect(links.slice(0, 4)).toEqual(["Sessions", "Herder runs", "Devices", "Search"]);
		fireEvent.click(within(nav).getByRole("link", { name: "Devices" }));
		expect(await screen.findByRole("heading", { name: "Devices", level: 1 })).toBeTruthy();
	});

	it("lists devices and pending pairing requests", async () => {
		const server = signedIn({
			devices: [device("mini", { createdVia: "pairing" }), device("laptop", { lastSeenAt: null, lastHost: null })],
			pairings: [pairing("K7QM-3XRP", "studio", 120_000)],
		});
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		expect(within(request).getByText("K7QM-3XRP")).toBeTruthy();
		expect((within(request).getByLabelText("Device name") as HTMLInputElement).value).toBe("studio");
		expect(within(request).getByText("studio.local")).toBeTruthy();
		expect(within(request).getByText("192.168.1.20")).toBeTruthy();
		expect(within(request).getByText("pika 0.2.0")).toBeTruthy();
		expect(within(request).getByText("Requested 2 minutes ago")).toBeTruthy();
		expect(countdown("K7QM-3XRP")).toBeGreaterThan(470);
		expect(countdown("K7QM-3XRP")).toBeLessThanOrEqual(480);
		expect(screen.getByText(/check that the code matches the one pi shows/)).toBeTruthy();

		await waitFor(() => expect(document.querySelectorAll("[data-device]")).toHaveLength(2));
		const rows = [...document.querySelectorAll<HTMLElement>("[data-device]")];
		expect(rows.map((row) => row.dataset.device)).toEqual(["laptop", "mini"]);
		expect(within(rows[0]).getByText("CLI")).toBeTruthy();
		expect(within(rows[0]).getByText("never")).toBeTruthy();
		expect(within(rows[1]).getByText("paired")).toBeTruthy();
		expect(within(rows[1]).getByText("mini.lan")).toBeTruthy();
	});

	it("explains how to add a device when there are none", async () => {
		renderApp("/devices", signedIn().fetch);
		const empty = await screen.findByText("No devices yet");
		const text = empty.parentElement?.textContent ?? "";
		expect(text).toContain("/pika login");
		expect(text).toContain("pika token create <name>");
		expect(screen.getByText(/No pending requests/)).toBeTruthy();
	});

	it("approves with the edited name and refreshes both lists", async () => {
		const server = signedIn({ pairings: [pairing("K7QM-3XRP", "studio")] });
		renderApp("/devices?pair=K7QM-3XRP", server.fetch);
		const request = await findCard("K7QM-3XRP");
		fireEvent.change(within(request).getByLabelText("Device name"), { target: { value: "studio-mac" } });
		fireEvent.click(within(request).getByRole("button", { name: "Approve K7QM-3XRP" }));

		expect(await screen.findByText(/Approved studio-mac\./)).toBeTruthy();
		expect(server.mutations).toEqual([
			{ method: "POST", path: "/api/v1/pairings/K7QM-3XRP/approve", body: { name: "studio-mac" }, json: true },
		]);
		await waitFor(() => expect(screen.queryByRole("region", { name: "Pairing request K7QM-3XRP" })).toBeNull());
		expect(await within(deviceTable()).findByText("studio-mac")).toBeTruthy();
		expect(screen.getByText(/No pending requests\./)).toBeTruthy();
		// The deep link's request was handled here, so it isn't reported missing.
		expect(screen.queryByText(/No pending request with code/)).toBeNull();
	});

	it("rejects an invalid device name before sending", async () => {
		renderApp("/devices", signedIn({ pairings: [pairing("K7QM-3XRP", "studio")] }).fetch);
		const request = await findCard("K7QM-3XRP");
		fireEvent.change(within(request).getByLabelText("Device name"), { target: { value: "my mac" } });
		expect(within(request).getByText(/Use 1–64 letters/)).toBeTruthy();
		expect((within(request).getByRole("button", { name: "Approve K7QM-3XRP" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("requires ticking Replace for an existing device and sends replace: true", async () => {
		const server = signedIn({ devices: [device("mini")], pairings: [pairing("K7QM-3XRP", "mini")] });
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		expect(within(request).getByText("A device named mini exists.")).toBeTruthy();
		const approve = within(request).getByRole("button", { name: "Approve K7QM-3XRP" }) as HTMLButtonElement;
		expect(approve.disabled).toBe(true);
		fireEvent.click(within(request).getByRole("checkbox", { name: /Replace it/ }));
		expect(approve.disabled).toBe(false);
		fireEvent.click(approve);
		expect(await screen.findByText(/Approved mini\./)).toBeTruthy();
		expect(server.mutations[0]).toEqual({
			method: "POST",
			path: "/api/v1/pairings/K7QM-3XRP/approve",
			body: { name: "mini", replace: true },
			json: true,
		});
		expect(server.state.devices.map((d) => [d.name, d.createdVia])).toEqual([["mini", "pairing"]]);
	});

	it("shows the exists state when the server answers 409", async () => {
		const server = signedIn({ pairings: [pairing("K7QM-3XRP", "mini")] });
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		await screen.findByText("No devices yet");
		// Another browser adds the device before this one approves.
		server.state.devices.push(device("mini"));
		fireEvent.click(within(request).getByRole("button", { name: "Approve K7QM-3XRP" }));
		expect(await within(request).findByText("A device named mini exists.")).toBeTruthy();
		expect(server.state.pairings).toHaveLength(1);

		fireEvent.click(within(card("K7QM-3XRP")).getByRole("checkbox", { name: /Replace it/ }));
		fireEvent.click(within(card("K7QM-3XRP")).getByRole("button", { name: "Approve K7QM-3XRP" }));
		expect(await screen.findByText(/Approved mini\./)).toBeTruthy();
		expect(server.mutations.map((m) => m.body)).toEqual([{ name: "mini" }, { name: "mini", replace: true }]);
	});

	it("denies a request", async () => {
		const server = signedIn({ pairings: [pairing("K7QM-3XRP", "studio"), pairing("HJ2W-9NTB", "pi5")] });
		renderApp("/devices", server.fetch);
		fireEvent.click(within(await findCard("HJ2W-9NTB")).getByRole("button", { name: "Deny" }));
		expect(await screen.findByText("Denied the request from pi5.")).toBeTruthy();
		expect(server.mutations).toEqual([{ method: "POST", path: "/api/v1/pairings/HJ2W-9NTB/deny", body: {}, json: true }]);
		await waitFor(() => expect(screen.queryByRole("region", { name: "Pairing request HJ2W-9NTB" })).toBeNull());
		expect(card("K7QM-3XRP")).toBeTruthy();
	});

	it("highlights and scrolls to the deep-linked request, matching the code loosely", async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		try {
			renderApp("/devices?pair=hj2w9ntb", signedIn({ pairings: [pairing("K7QM-3XRP", "studio"), pairing("HJ2W-9NTB", "pi5")] }).fetch);
			const target = await findCard("HJ2W-9NTB");
			expect(target.hasAttribute("data-highlighted")).toBe(true);
			expect(card("K7QM-3XRP").hasAttribute("data-highlighted")).toBe(false);
			expect(scrollIntoView).toHaveBeenCalledTimes(1);
			expect(scrollIntoView.mock.contexts[0]).toBe(target);
			expect(screen.queryByText(/No pending request with code/)).toBeNull();
		} finally {
			delete (Element.prototype as Partial<Element>).scrollIntoView;
		}
	});

	it("says a deep-linked code may have expired when no request has it", async () => {
		renderApp("/devices?pair=ZZZZ-ZZZZ", signedIn({ pairings: [pairing("K7QM-3XRP", "studio")] }).fetch);
		expect(await screen.findByText("No pending request with code ZZZZ-ZZZZ")).toBeTruthy();
		expect(screen.getByText(/may have expired or already been handled/)).toBeTruthy();
		expect(card("K7QM-3XRP").hasAttribute("data-highlighted")).toBe(false);
	});

	it("refetches pending requests every 2 seconds", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = signedIn();
		renderApp("/devices", server.fetch);
		expect(await screen.findByText(/No pending requests/)).toBeTruthy();
		const polls = () => server.calls.filter((call) => call === "/api/v1/pairings").length;
		expect(polls()).toBe(1);

		server.state.pairings.push(pairing("K7QM-3XRP", "studio", 0));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PAIRINGS_POLL_MS);
		});
		expect(await findCard("K7QM-3XRP")).toBeTruthy();
		expect(polls()).toBe(2);
		const first = countdown("K7QM-3XRP");
		expect(first).toBeGreaterThan(595);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(PAIRINGS_POLL_MS);
		});
		await waitFor(() => expect(polls()).toBe(3));
		// The countdown ticks between polls.
		expect(first - countdown("K7QM-3XRP")).toBeGreaterThanOrEqual(2);
		expect(first - countdown("K7QM-3XRP")).toBeLessThanOrEqual(3);
	});

	it("keeps the deep-linked request first when a new one arrives, with the others below it", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = signedIn({ pairings: [pairing("K7QM-3XRP", "studio", 60_000)] });
		renderApp("/devices?pair=K7QM-3XRP", server.fetch);
		await findCard("K7QM-3XRP");
		// Anyone can start a pairing; the server lists the newest first.
		server.state.pairings.unshift(pairing("HJ2W-9NTB", "studio", 0));
		await nextPoll();
		await findCard("HJ2W-9NTB");
		expect(cardOrder()).toEqual(["K7QM-3XRP", "HJ2W-9NTB"]);
		expect(card("K7QM-3XRP").hasAttribute("data-highlighted")).toBe(true);
		const others = screen.getByRole("heading", { name: "Other requests" });
		expect(others.compareDocumentPosition(card("HJ2W-9NTB")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(others.compareDocumentPosition(card("K7QM-3XRP")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
	});

	it("lists requests oldest first, so a new one appends below", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = signedIn({ pairings: [pairing("HJ2W-9NTB", "pi5", 30_000), pairing("K7QM-3XRP", "studio", 90_000)] });
		renderApp("/devices", server.fetch);
		await findCard("K7QM-3XRP");
		expect(cardOrder()).toEqual(["K7QM-3XRP", "HJ2W-9NTB"]);
		server.state.pairings.unshift(pairing("ZX4C-7VBN", "studio", 0));
		await nextPoll();
		await findCard("ZX4C-7VBN");
		expect(cardOrder()).toEqual(["K7QM-3XRP", "HJ2W-9NTB", "ZX4C-7VBN"]);
		expect(screen.queryByRole("heading", { name: "Other requests" })).toBeNull();
	});

	it("labels each Approve button with its request's code", async () => {
		renderApp("/devices", signedIn({ pairings: [pairing("K7QM-3XRP", "studio"), pairing("HJ2W-9NTB", "pi5")] }).fetch);
		for (const code of ["K7QM-3XRP", "HJ2W-9NTB"]) {
			const button = within(await findCard(code)).getByRole("button", { name: `Approve ${code}` });
			expect(button.textContent).toBe(`Approve ${code}`);
			expect(button.getAttribute("aria-label")).toBe(`Approve ${code}`);
		}
	});

	it("disables Approve for a moment after the set of requests changes", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = signedIn({ pairings: [pairing("K7QM-3XRP", "studio")] });
		renderApp("/devices", server.fetch);
		await findCard("K7QM-3XRP");
		// Not when the list first loads.
		expect(approveButton("K7QM-3XRP").disabled).toBe(false);

		server.state.pairings.push(pairing("HJ2W-9NTB", "pi5", 0));
		await nextPoll();
		await findCard("HJ2W-9NTB");
		expect(approveButton("K7QM-3XRP").disabled).toBe(true);
		expect(approveButton("HJ2W-9NTB").disabled).toBe(true);
		fireEvent.click(approveButton("K7QM-3XRP"));
		expect(server.mutations).toEqual([]);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LAYOUT_GUARD_MS);
		});
		expect(approveButton("K7QM-3XRP").disabled).toBe(false);
		expect(approveButton("HJ2W-9NTB").disabled).toBe(false);

		// A request leaving moves the cards too.
		fireEvent.click(within(card("HJ2W-9NTB")).getByRole("button", { name: "Deny" }));
		await waitFor(() => expect(screen.queryByRole("region", { name: "Pairing request HJ2W-9NTB" })).toBeNull());
		expect(approveButton("K7QM-3XRP").disabled).toBe(true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LAYOUT_GUARD_MS);
		});
		expect(approveButton("K7QM-3XRP").disabled).toBe(false);
	});

	it("unticks Replace when the name changes", async () => {
		renderApp("/devices", signedIn({ devices: [device("mini")], pairings: [pairing("K7QM-3XRP", "mini")] }).fetch);
		const request = await findCard("K7QM-3XRP");
		fireEvent.click(within(request).getByRole("checkbox", { name: /Replace it/ }));
		expect(approveButton("K7QM-3XRP").disabled).toBe(false);
		const input = within(request).getByLabelText("Device name");
		fireEvent.change(input, { target: { value: "mini2" } });
		fireEvent.change(input, { target: { value: "mini" } });
		expect((within(request).getByRole("checkbox", { name: /Replace it/ }) as HTMLInputElement).checked).toBe(false);
		expect(approveButton("K7QM-3XRP").disabled).toBe(true);
	});

	it("wraps a long unbroken host instead of overflowing", async () => {
		const host = "h".repeat(255);
		renderApp(
			"/devices",
			signedIn({ devices: [device("mini", { lastHost: host })], pairings: [pairing("K7QM-3XRP", "studio", 30_000, { host, pikaVersion: "v".repeat(200) })] }).fetch,
		);
		const shown = (await findCard("K7QM-3XRP")).querySelector<HTMLElement>("[data-pairing-host]");
		expect(shown?.textContent).toBe(host);
		expect(shown?.classList.contains("min-w-0")).toBe(true);
		expect(shown?.classList.contains("break-all")).toBe(true);
		expect(within(card("K7QM-3XRP")).getByText(`pika ${"v".repeat(200)}`).classList.contains("break-all")).toBe(true);
		const lastHost = await waitFor(() => {
			const cell = document.querySelector<HTMLElement>('[data-device="mini"] [data-last-host]');
			if (!cell) throw new Error("no last host");
			return cell;
		});
		expect(lastHost.textContent).toBe(host);
		expect(lastHost.classList.contains("break-all")).toBe(true);
	});

	it("asks before revoking a device, then sends DELETE", async () => {
		const server = signedIn({ devices: [device("mini"), device("laptop")] });
		renderApp("/devices", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Revoke mini" }));
		const dialog = screen.getByRole("dialog", { name: "Revoke mini?" });
		expect(dialog.textContent).toContain("stops uploading until it logs in again");
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(server.mutations).toEqual([]);

		fireEvent.click(screen.getByRole("button", { name: "Revoke mini" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
		expect(await screen.findByText("Revoked mini.")).toBeTruthy();
		expect(server.mutations).toEqual([{ method: "DELETE", path: "/api/v1/devices/mini", body: undefined, json: false }]);
		await waitFor(() => expect(document.querySelector('[data-device="mini"]')).toBeNull());
		expect(document.querySelector('[data-device="laptop"]')).toBeTruthy();
	});

	it("closes the confirmation on Escape", async () => {
		renderApp("/devices", signedIn({ devices: [device("mini")] }).fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Revoke mini" }));
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});

describe("browser sessions", () => {
	function sessions() {
		return [browserSession("aaaaaaaaaaaa", { current: true }), browserSession("bbbbbbbbbbbb", { userAgent: SAFARI_MAC, ip: "10.0.0.7" })];
	}

	it("lists sessions and marks this browser", async () => {
		renderApp("/devices", signedIn({ browserSessions: sessions() }).fetch);
		const current = await screen.findByText("This browser");
		const row = current.closest<HTMLElement>("tr");
		expect(row?.dataset.browserSession).toBe("aaaaaaaaaaaa");
		expect(within(row!).getByText("Firefox 131 on Linux")).toBeTruthy();
		const other = document.querySelector<HTMLElement>('[data-browser-session="bbbbbbbbbbbb"]')!;
		expect(within(other).getByText("Safari 18 on macOS")).toBeTruthy();
		expect(within(other).getByText("10.0.0.7")).toBeTruthy();
		expect(within(other).queryByText("This browser")).toBeNull();
	});

	it("signs out another browser and stays on the page", async () => {
		const server = signedIn({ browserSessions: sessions() });
		renderApp("/devices", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Sign out Safari 18 on macOS" }));
		expect(await screen.findByText("Signed out Safari 18 on macOS.")).toBeTruthy();
		expect(server.mutations).toEqual([{ method: "DELETE", path: "/api/v1/auth/sessions/bbbbbbbbbbbb", body: undefined, json: false }]);
		await waitFor(() => expect(document.querySelector('[data-browser-session="bbbbbbbbbbbb"]')).toBeNull());
		expect(screen.getByRole("heading", { name: "Devices", level: 1 })).toBeTruthy();
	});

	it("returns to the login page after signing out this browser", async () => {
		const server = signedIn({ browserSessions: sessions() });
		renderApp("/devices", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Sign out this browser" }));
		expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
		expect(server.mutations).toEqual([{ method: "DELETE", path: "/api/v1/auth/sessions/aaaaaaaaaaaa", body: undefined, json: false }]);
		expect(server.state.authenticated).toBe(false);
	});

	it("signs out everywhere after confirming", async () => {
		const server = signedIn({ browserSessions: sessions() });
		renderApp("/devices", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
		const dialog = screen.getByRole("dialog", { name: "Sign out everywhere?" });
		expect(server.mutations).toEqual([]);
		fireEvent.click(within(dialog).getByRole("button", { name: "Sign out everywhere" }));
		expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
		expect(server.mutations).toEqual([{ method: "POST", path: "/api/v1/auth/sessions/revoke-all", body: {}, json: true }]);
		expect(server.state.browserSessions).toEqual([]);
	});

	it.each([
		["signing out in the sidebar", "/api/v1/logout", () => fireEvent.click(screen.getByRole("button", { name: "Sign out" }))],
		["signing out this browser", "/api/v1/auth/sessions/aaaaaaaaaaaa", () => fireEvent.click(screen.getByRole("button", { name: "Sign out this browser" }))],
		[
			"signing out everywhere",
			"/api/v1/auth/sessions/revoke-all",
			() => {
				fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
				fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out everywhere" }));
			},
		],
	] as const)("stops polling pending requests while %s", async (_label, path, signOut) => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = signedIn({ browserSessions: sessions() });
		// The server takes its time to end the session; a poll meanwhile would race it and could get a 401.
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (new URL(String(input), "http://localhost").pathname === path) await held;
			return server.fetch(input, init);
		}) as typeof fetch;
		renderApp("/devices", fetchImpl);
		await screen.findByText("This browser");
		const polls = () => server.calls.filter((call) => call === "/api/v1/pairings").length;
		await nextPoll();
		const before = polls();
		expect(before).toBeGreaterThanOrEqual(2);

		signOut();
		for (let poll = 0; poll < 3; poll += 1) await nextPoll();
		expect(polls()).toBe(before);
		release();
		expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
		expect(polls()).toBe(before);
		expect(server.calls.filter((call) => call === path)).toHaveLength(1);
	});

	it("polls again when signing out everywhere fails", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = signedIn({ browserSessions: sessions() });
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/revoke-all")) return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
			return server.fetch(input, init);
		}) as typeof fetch;
		renderApp("/devices", fetchImpl);
		fireEvent.click(await screen.findByRole("button", { name: "Sign out everywhere" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sign out everywhere" }));
		expect(await screen.findByText(/Could not sign out everywhere: boom/)).toBeTruthy();
		const polls = () => server.calls.filter((call) => call === "/api/v1/pairings").length;
		const before = polls();
		await nextPoll();
		await waitFor(() => expect(polls()).toBe(before + 1));
	});

	it("is replaced by a note when a reverse proxy handles sign-in", async () => {
		const server = createFakeServer({ authMode: "proxy", devices: [device("mini")], pairings: [pairing("K7QM-3XRP", "studio")] });
		renderApp("/devices", server.fetch);
		expect(await screen.findByText("Your reverse proxy handles sign-in")).toBeTruthy();
		expect(document.querySelector("[data-browser-sessions]")).toBeNull();
		expect(screen.queryByText("pika has no authentication")).toBeNull();
		expect(await findCard("K7QM-3XRP")).toBeTruthy();
		expect(await within(await waitFor(deviceTable)).findByText("mini")).toBeTruthy();
		expect(server.calls.some((call) => call.includes("auth/sessions"))).toBe(false);
		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
	});

	it("warns when pika has no authentication", async () => {
		const server = createFakeServer({ authMode: "none", pairings: [pairing("K7QM-3XRP", "studio")] });
		renderApp("/devices", server.fetch);
		expect(await screen.findByText("pika has no authentication")).toBeTruthy();
		expect(document.querySelector('[data-callout="yellow"]')?.textContent).toContain("pika password set");
		expect(document.querySelector("[data-browser-sessions]")).toBeNull();
		expect(screen.queryByText("Your reverse proxy handles sign-in")).toBeNull();
		fireEvent.click(within(await findCard("K7QM-3XRP")).getByRole("button", { name: "Approve K7QM-3XRP" }));
		expect(await screen.findByText(/Approved studio\./)).toBeTruthy();
		expect(server.calls.some((call) => call.includes("auth/sessions"))).toBe(false);
	});
});
