import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVED_WATCH_MS, LAYOUT_GUARD_MS, PAIRINGS_POLL_MS } from "../src/pages/Devices";
import { browserSession, device, pairing, SAFARI_MAC } from "./support/fixtures";
import { installMatchMedia } from "./support/media";
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

const STUDIO_ID = "4f1c2b9e-0d7a-4c3e-9b8f-2a6d5e1c0b7a";
const OTHER_ID = "0a9b8c7d-1111-4222-8333-444455556666";

function signedIn(extra: Parameters<typeof createFakeServer>[0] = {}) {
	return createFakeServer({ password: "hunter2", authenticated: true, ...extra });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("devices page", () => {
	it("is linked from the band between Active sessions and Search", async () => {
		renderApp("/", createFakeServer({}).fetch);
		const nav = await screen.findByRole("navigation", { name: "Main" });
		await within(nav).findByRole("link", { name: "Active sessions" });
		// By accessible name: the Search link also shows its `/` shortcut, hidden from assistive technology.
		const links = within(nav).getAllByRole("link");
		const order = ["Sessions", "Herder runs", "Active sessions", "Devices", "Search"].map((name) => links.indexOf(within(nav).getByRole("link", { name })));
		expect(order).toEqual([0, 1, 2, 3, 4]);
		fireEvent.click(within(nav).getByRole("link", { name: "Devices" }));
		expect(await screen.findByRole("heading", { name: "Devices", level: 1 })).toBeTruthy();
	});

	it("lists devices and pending pairing requests", async () => {
		const server = signedIn({
			devices: [
				device("mini", { createdVia: "pairing" }),
				device("laptop", { lastSeenAt: null, lastHost: null }),
				device(STUDIO_ID, { name: "Studio Mac", hasKey: true }),
			],
			pairings: [pairing("K7QM-3XRP", "studio", 120_000)],
		});
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		expect(within(request).getByText("K7QM-3XRP")).toBeTruthy();
		expect(request.querySelector("[data-pairing-name]")?.textContent).toBe("Requested name studio");
		expect((within(request).getByLabelText("Device name") as HTMLInputElement).value).toBe("studio");
		expect(within(request).getByText("studio.local")).toBeTruthy();
		expect(within(request).getByText("192.168.1.20")).toBeTruthy();
		expect(within(request).getByText("pika 0.2.0")).toBeTruthy();
		expect(within(request).getByText("Requested 2 minutes ago")).toBeTruthy();
		expect(countdown("K7QM-3XRP")).toBeGreaterThan(470);
		expect(countdown("K7QM-3XRP")).toBeLessThanOrEqual(480);
		expect(screen.getByText(/check that the code matches the one pi shows/)).toBeTruthy();

		await waitFor(() => expect(document.querySelectorAll("[data-device]")).toHaveLength(3));
		const rows = [...document.querySelectorAll<HTMLElement>("[data-device]")];
		// By name, case-insensitively.
		expect(rows.map((row) => row.dataset.device)).toEqual(["laptop", "mini", STUDIO_ID]);
		expect(rows.map((row) => row.dataset.deviceName)).toEqual(["laptop", "mini", "Studio Mac"]);
		expect(within(rows[0]).getByText("CLI")).toBeTruthy();
		expect(within(rows[0]).getByText("never")).toBeTruthy();
		expect(within(rows[1]).getByText("paired")).toBeTruthy();
		expect(within(rows[1]).getByText("mini.lan")).toBeTruthy();
		// The name, with the id muted in monospace below it: its first 8 characters, and all of it in the title.
		expect(rows[2].querySelector("[data-device-label]")?.textContent).toBe("Studio Mac");
		const id = rows[2].querySelector<HTMLElement>("[data-device-id]");
		expect(id?.textContent).toBe("4f1c2b9e…");
		expect(id?.dataset.deviceId).toBe(STUDIO_ID);
		expect(id?.title).toBe(STUDIO_ID);
		expect(id?.classList.contains("font-mono")).toBe(true);
		expect(id?.classList.contains("text-muted")).toBe(true);
		// An id of at most 8 characters shows whole.
		expect(rows[1].querySelector<HTMLElement>("[data-device-id]")?.textContent).toBe("mini");
		expect(within(rows[2]).getByRole("button", { name: "Rename Studio Mac" })).toBeTruthy();
		expect(within(rows[2]).getByRole("button", { name: "Revoke Studio Mac" })).toBeTruthy();
	});

	it("explains how to add a device when there are none", async () => {
		renderApp("/devices", signedIn().fetch);
		const empty = await screen.findByText("No devices yet");
		const text = empty.parentElement?.textContent ?? "";
		expect(text).toContain("/pika login");
		expect(text).toContain("pika token create <name>");
		expect(screen.getByText(/No pending requests/)).toBeTruthy();
	});

	it("approves a new device with the edited name and refreshes both lists", async () => {
		const server = signedIn({ pairings: [pairing("K7QM-3XRP", "studio")] });
		renderApp("/devices?pair=K7QM-3XRP", server.fetch);
		const request = await findCard("K7QM-3XRP");
		expect(request.hasAttribute("data-pairing-match")).toBe(false);
		expect(within(request).getByText("Approves a new device.")).toBeTruthy();
		// No devices yet, so nothing to continue.
		expect(within(request).queryByLabelText("Continue an existing device instead")).toBeNull();
		fireEvent.change(within(request).getByLabelText("Device name"), { target: { value: "  Studio Mac  " } });
		fireEvent.click(within(request).getByRole("button", { name: "Approve K7QM-3XRP" }));

		expect(await screen.findByText("Approved Studio Mac.")).toBeTruthy();
		// Both fields, explicitly, and the name trimmed.
		expect(server.mutations).toEqual([
			{ method: "POST", path: "/api/v1/pairings/K7QM-3XRP/approve", body: { name: "Studio Mac", continues: null }, json: true },
		]);
		await waitFor(() => expect(screen.queryByRole("region", { name: "Pairing request K7QM-3XRP" })).toBeNull());
		const row = await waitFor(() => {
			const found = document.querySelector<HTMLElement>('[data-device-name="Studio Mac"]');
			if (!found) throw new Error("no row");
			return found;
		});
		expect(row.dataset.device).toMatch(/^[0-9a-f-]{36}$/);
		expect(screen.getByText(/No pending requests\./)).toBeTruthy();
		// The deep link's request was handled here, so it isn't reported missing.
		expect(screen.queryByText(/No pending request with code/)).toBeNull();
	});

	it("lists a newly approved device once its machine has polled, without a reload", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = signedIn({ devices: [device("mini")], pairings: [pairing("K7QM-3XRP", "studio")] });
		server.state.devicesOnPoll = true;
		renderApp("/devices", server.fetch);
		fireEvent.click(within(await findCard("K7QM-3XRP")).getByRole("button", { name: "Approve K7QM-3XRP" }));
		expect(await screen.findByText("Approved studio.")).toBeTruthy();
		await waitFor(() => expect(screen.queryByRole("region", { name: "Pairing request K7QM-3XRP" })).toBeNull());
		// The machine has not polled yet, so the server lists no new device.
		await nextPoll();
		expect(document.querySelector('[data-device-name="studio"]')).toBeNull();
		server.poll();
		await nextPoll();
		await waitFor(() => expect(document.querySelector('[data-device-name="studio"]')).toBeTruthy());
		// Then the list stops refetching.
		const listed = () => server.calls.filter((call) => call === "/api/v1/devices").length;
		const count = listed();
		await nextPoll();
		await nextPoll();
		expect(listed()).toBe(count);
	});

	it("stops refetching the devices a while after an approval whose machine never polls", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const server = signedIn({ pairings: [pairing("K7QM-3XRP", "studio")] });
		server.state.devicesOnPoll = true;
		renderApp("/devices", server.fetch);
		fireEvent.click(within(await findCard("K7QM-3XRP")).getByRole("button", { name: "Approve K7QM-3XRP" }));
		expect(await screen.findByText("Approved studio.")).toBeTruthy();
		const listed = () => server.calls.filter((call) => call === "/api/v1/devices").length;
		await nextPoll();
		expect(listed()).toBeGreaterThan(2);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(APPROVED_WATCH_MS);
		});
		const count = listed();
		await nextPoll();
		await nextPoll();
		expect(listed()).toBe(count);
	});

	it.each([
		["blank", "   "],
		["65 characters", "x".repeat(65)],
		["a tab", "my\tmac"],
		// A text input drops line breaks itself, so other control characters stand in for them.
		["an escape character", "my\u001bmac"],
		["NEL (U+0085)", "my\u0085mac"],
		["a line separator", "my\u2028mac"],
	])("rejects a name that is %s before sending", async (_label, name) => {
		const server = signedIn({ pairings: [pairing("K7QM-3XRP", "studio")] });
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		const input = within(request).getByLabelText("Device name");
		fireEvent.change(input, { target: { value: name } });
		expect(within(request).getByText("Use 1-64 characters, without control characters.")).toBeTruthy();
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(approveButton("K7QM-3XRP").disabled).toBe(true);
		fireEvent.click(approveButton("K7QM-3XRP"));
		expect(server.mutations).toEqual([]);
	});

	it.each([
		["spaces", "Minhu's MacBook Pro"],
		["non-ASCII characters", "工作站 – café ☕"],
		["64 characters", "é".repeat(64)],
		["64 emoji", "😀".repeat(64)],
	])("accepts a name with %s", async (_label, name) => {
		const server = signedIn({ pairings: [pairing("K7QM-3XRP", "studio")] });
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		fireEvent.change(within(request).getByLabelText("Device name"), { target: { value: name } });
		expect(within(request).queryByText("Use 1-64 characters, without control characters.")).toBeNull();
		fireEvent.click(approveButton("K7QM-3XRP"));
		expect(await screen.findByText(`Approved ${name}.`)).toBeTruthy();
		expect(server.mutations[0]?.body).toEqual({ name, continues: null });
	});

	it("continues the device a request was recognized as by its key", async () => {
		const server = signedIn({
			devices: [device(STUDIO_ID, { name: "Studio Mac", hasKey: true }), device("mini")],
			pairings: [pairing("K7QM-3XRP", "studio", 30_000, { match: { id: STUDIO_ID, name: "Studio Mac", by: "key", active: true } })],
		});
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		expect(request.dataset.pairingMatch).toBe(STUDIO_ID);
		expect(request.querySelector("[data-pairing-recognized]")?.textContent).toBe("Recognized as Studio Mac by its device key");
		const keep = within(request).getByRole("radio", { name: /Continue Studio Mac/ }) as HTMLInputElement;
		expect(keep.checked).toBe(true);
		expect(within(request).getByText("Same history; its current token stops working.")).toBeTruthy();
		expect((within(request).getByRole("radio", { name: "Add as a new device" }) as HTMLInputElement).checked).toBe(false);
		// Continuing pre-fills the device's name, not the requested one.
		expect((within(request).getByLabelText("Device name") as HTMLInputElement).value).toBe("Studio Mac");

		fireEvent.click(approveButton("K7QM-3XRP"));
		expect(await screen.findByText("Approved Studio Mac; it continues the existing device.")).toBeTruthy();
		expect(server.mutations).toEqual([
			{ method: "POST", path: "/api/v1/pairings/K7QM-3XRP/approve", body: { name: "Studio Mac", continues: STUDIO_ID }, json: true },
		]);
		expect(server.state.devices.map((d) => d.id).sort()).toEqual(["mini", STUDIO_ID].sort());
	});

	it("adds a recognized request as a new device when the user switches", async () => {
		const server = signedIn({
			retiredDevices: [{ id: "old-mac", name: "Old Mac" }],
			pairings: [pairing("K7QM-3XRP", "studio", 30_000, { match: { id: "old-mac", name: "Old Mac", by: "token", active: false } })],
		});
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		expect(request.querySelector("[data-pairing-recognized]")?.textContent).toBe("Recognized as Old Mac by its current token");
		// Without a token there is nothing to stop.
		expect(within(request).getByText("Same history.")).toBeTruthy();
		const input = within(request).getByLabelText("Device name") as HTMLInputElement;
		expect(input.value).toBe("Old Mac");

		fireEvent.click(within(request).getByRole("radio", { name: "Add as a new device" }));
		expect(input.value).toBe("studio");
		fireEvent.click(approveButton("K7QM-3XRP"));
		expect(await screen.findByText("Approved studio.")).toBeTruthy();
		expect(server.mutations[0]?.body).toEqual({ name: "studio", continues: null });
		expect(server.state.retiredDevices).toEqual([{ id: "old-mac", name: "Old Mac" }]);
	});

	it.each([
		["light", false],
		["dark", true],
	] as const)("shows the recognized device in the %s theme", async (theme, dark) => {
		installMatchMedia(dark);
		renderApp(
			"/devices",
			signedIn({
				devices: [device(STUDIO_ID, { name: "Studio Mac" })],
				pairings: [pairing("K7QM-3XRP", "studio", 30_000, { match: { id: STUDIO_ID, name: "Studio Mac", by: "key", active: true } })],
			}).fetch,
		);
		const request = await findCard("K7QM-3XRP");
		expect(document.documentElement.dataset.theme).toBe(theme);
		// Theme tokens only, so both themes style it.
		const recognized = request.querySelector<HTMLElement>("[data-pairing-recognized]")!;
		expect(recognized.className).toContain("bg-soft");
		expect(recognized.className).not.toMatch(/(?:bg|text)-(?:white|black|gray|slate)/);
		expect(within(request).getByRole("radio", { name: /Continue Studio Mac/ })).toBeTruthy();
	});

	it("re-fills the name when the choice changes, unless the user edited it", async () => {
		renderApp(
			"/devices",
			signedIn({
				devices: [device(STUDIO_ID, { name: "Studio Mac" })],
				pairings: [pairing("K7QM-3XRP", "studio", 30_000, { match: { id: STUDIO_ID, name: "Studio Mac", by: "key", active: true } })],
			}).fetch,
		);
		const request = await findCard("K7QM-3XRP");
		const input = within(request).getByLabelText("Device name") as HTMLInputElement;
		const keep = within(request).getByRole("radio", { name: /Continue Studio Mac/ });
		const fresh = within(request).getByRole("radio", { name: "Add as a new device" });
		fireEvent.click(fresh);
		expect(input.value).toBe("studio");
		fireEvent.click(keep);
		expect(input.value).toBe("Studio Mac");

		fireEvent.change(input, { target: { value: "Studio" } });
		fireEvent.click(fresh);
		expect(input.value).toBe("Studio");
		fireEvent.click(keep);
		expect(input.value).toBe("Studio");
		// Typed back to what the choice fills in, it follows the choice again.
		fireEvent.change(input, { target: { value: "Studio Mac" } });
		fireEvent.click(fresh);
		expect(input.value).toBe("studio");
	});

	it("continues an existing device chosen for an unrecognized request", async () => {
		const server = signedIn({
			devices: [device(STUDIO_ID, { name: "MacBook" }), device(OTHER_ID, { name: "MacBook" }), device("mini")],
			pairings: [pairing("K7QM-3XRP", "studio")],
		});
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		const select = (await within(request).findByLabelText("Continue an existing device instead")) as HTMLSelectElement;
		expect(select.value).toBe("");
		// Devices that share a name show the start of their ids.
		expect([...select.options].map((option) => option.textContent)).toEqual([
			"New device",
			`MacBook (${OTHER_ID.slice(0, 8)})`,
			`MacBook (${STUDIO_ID.slice(0, 8)})`,
			"mini",
		]);
		const input = within(request).getByLabelText("Device name") as HTMLInputElement;
		expect(input.value).toBe("studio");

		fireEvent.change(select, { target: { value: STUDIO_ID } });
		expect(input.value).toBe("MacBook");
		expect(within(request).getByText("Continues MacBook; its current token stops working.")).toBeTruthy();
		fireEvent.click(approveButton("K7QM-3XRP"));
		expect(await screen.findByText("Approved MacBook; it continues the existing device.")).toBeTruthy();
		expect(server.mutations[0]?.body).toEqual({ name: "MacBook", continues: STUDIO_ID });
	});

	it("goes back to a new device when the select is cleared", async () => {
		const server = signedIn({ devices: [device("mini")], pairings: [pairing("K7QM-3XRP", "studio")] });
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		const select = (await within(request).findByLabelText("Continue an existing device instead")) as HTMLSelectElement;
		fireEvent.change(select, { target: { value: "mini" } });
		expect((within(request).getByLabelText("Device name") as HTMLInputElement).value).toBe("mini");
		fireEvent.change(select, { target: { value: "" } });
		expect((within(request).getByLabelText("Device name") as HTMLInputElement).value).toBe("studio");
		fireEvent.click(approveButton("K7QM-3XRP"));
		expect(await screen.findByText("Approved studio.")).toBeTruthy();
		expect(server.mutations[0]?.body).toEqual({ name: "studio", continues: null });
	});

	it("says so when the device to continue is gone", async () => {
		const server = signedIn({ devices: [device("mini")], pairings: [pairing("K7QM-3XRP", "studio")] });
		renderApp("/devices", server.fetch);
		const request = await findCard("K7QM-3XRP");
		fireEvent.change(await within(request).findByLabelText("Continue an existing device instead"), { target: { value: "mini" } });
		// Another browser forgets it meanwhile; the fake keeps no record of it at all.
		server.state.devices = [];
		fireEvent.click(approveButton("K7QM-3XRP"));
		expect(await within(request).findByRole("alert")).toHaveProperty(
			"textContent",
			"That device no longer exists. Choose another, or add a new device.",
		);
		expect(server.state.pairings).toHaveLength(1);
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

	it("copies a device's whole id", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		try {
			renderApp("/devices", signedIn({ devices: [device(STUDIO_ID, { name: "Studio Mac" })] }).fetch);
			fireEvent.click(await screen.findByRole("button", { name: "Copy the id of Studio Mac" }));
			expect(await screen.findByRole("button", { name: "Copied the id of Studio Mac" })).toBeTruthy();
			expect(writeText).toHaveBeenCalledWith(STUDIO_ID);
		} finally {
			Reflect.deleteProperty(navigator, "clipboard");
		}
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
		// Wraps at hyphens and dots first, so `wangminhus-Mini` breaks after its hyphen, not inside a word; a host
		// with nowhere to wrap still breaks inside the column rather than widening the table.
		expect(lastHost.classList.contains("break-all")).toBe(false);
		expect(lastHost.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
	});

	it("revokes by id, encoding it in the URL", async () => {
		const server = signedIn({ devices: [device("lab/pi #2", { name: "Lab Pi" }), device("mini")] });
		renderApp("/devices", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Revoke Lab Pi" }));
		const dialog = screen.getByRole("dialog", { name: "Revoke Lab Pi?" });
		expect(dialog.textContent).toContain("lab/pi #2");
		fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
		expect(await screen.findByText("Revoked Lab Pi.")).toBeTruthy();
		expect(server.mutations).toEqual([{ method: "DELETE", path: "/api/v1/devices/lab%2Fpi%20%232", body: undefined, json: false }]);
		await waitFor(() => expect(document.querySelector('[data-device-name="Lab Pi"]')).toBeNull());
		expect(document.querySelector('[data-device="mini"]')).toBeTruthy();
	});

	it("renames a device by id", async () => {
		const server = signedIn({ devices: [device(STUDIO_ID, { name: "MacBook" }), device("mini")] });
		renderApp("/devices", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Rename MacBook" }));
		const dialog = screen.getByRole("dialog", { name: "Rename MacBook" });
		const input = within(dialog).getByLabelText("Device name") as HTMLInputElement;
		expect(input.value).toBe("MacBook");
		expect(dialog.textContent).toContain(STUDIO_ID);
		fireEvent.change(input, { target: { value: " Studio Mac " } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));

		expect(await screen.findByText("Renamed MacBook to Studio Mac.")).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(server.mutations).toEqual([{ method: "PATCH", path: `/api/v1/devices/${STUDIO_ID}`, body: { name: "Studio Mac" }, json: true }]);
		const row = await waitFor(() => {
			const found = document.querySelector<HTMLElement>(`[data-device="${STUDIO_ID}"][data-device-name="Studio Mac"]`);
			if (!found) throw new Error("not renamed yet");
			return found;
		});
		expect(within(row).getByRole("button", { name: "Rename Studio Mac" })).toBeTruthy();
	});

	it.each([
		["blank", ""],
		["65 characters", "x".repeat(65)],
		["a control character", "Studio\u0007"],
	])("will not rename to a name that is %s", async (_label, name) => {
		const server = signedIn({ devices: [device("mini")] });
		renderApp("/devices", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Rename mini" }));
		const dialog = screen.getByRole("dialog", { name: "Rename mini" });
		fireEvent.change(within(dialog).getByLabelText("Device name"), { target: { value: name } });
		expect(within(dialog).getByText("Use 1-64 characters, without control characters.")).toBeTruthy();
		const save = within(dialog).getByRole("button", { name: "Rename" }) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		fireEvent.submit(within(dialog).getByLabelText("Device name"));
		expect(server.mutations).toEqual([]);
	});

	it("says so when the device to rename is gone, and keeps the dialog open", async () => {
		const server = signedIn({ devices: [device("mini"), device("laptop")] });
		renderApp("/devices", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Rename mini" }));
		const dialog = screen.getByRole("dialog", { name: "Rename mini" });
		server.state.devices = server.state.devices.filter((d) => d.id !== "mini");
		fireEvent.change(within(dialog).getByLabelText("Device name"), { target: { value: "mini 2" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
		expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "This device no longer exists.");
		expect(screen.getByRole("dialog", { name: "Rename mini" })).toBeTruthy();
		// The list refreshes behind the dialog.
		await waitFor(() => expect(document.querySelector('[data-device="mini"]')).toBeNull());
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("shows the server's refusal of a name", async () => {
		const server = signedIn({ devices: [device("mini")] });
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "PATCH") return new Response(JSON.stringify({ error: "invalid_name" }), { status: 400 });
			return server.fetch(input, init);
		}) as typeof fetch;
		renderApp("/devices", fetchImpl);
		fireEvent.click(await screen.findByRole("button", { name: "Rename mini" }));
		const dialog = screen.getByRole("dialog", { name: "Rename mini" });
		fireEvent.change(within(dialog).getByLabelText("Device name"), { target: { value: "mini 2" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
		expect(await within(dialog).findByRole("alert")).toHaveProperty(
			"textContent",
			"The server refused this name. Use 1-64 characters, without control characters.",
		);
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

	it("closes the rename dialog on Escape without renaming", async () => {
		const server = signedIn({ devices: [device("mini")] });
		renderApp("/devices", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Rename mini" }));
		fireEvent.change(within(screen.getByRole("dialog", { name: "Rename mini" })).getByLabelText("Device name"), { target: { value: "mini 2" } });
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(server.mutations).toEqual([]);
		expect(document.querySelector('[data-device="mini"]')?.getAttribute("data-device-name")).toBe("mini");
	});

	it.each([
		["succeeds", true, "Renamed mini to mini 2."],
		["fails", false, "Could not rename mini: the server refused the name."],
	])("says so when a rename the dialog was closed during %s", async (_label, succeeds, text) => {
		const server = signedIn({ devices: [device("mini")] });
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method !== "PATCH") return server.fetch(input, init);
			await held;
			return succeeds ? server.fetch(input, init) : new Response(JSON.stringify({ error: "invalid_name" }), { status: 400 });
		}) as typeof fetch;
		renderApp("/devices", fetchImpl);
		fireEvent.click(await screen.findByRole("button", { name: "Rename mini" }));
		const dialog = screen.getByRole("dialog", { name: "Rename mini" });
		fireEvent.change(within(dialog).getByLabelText("Device name"), { target: { value: "mini 2" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		await act(async () => {
			release();
			await held;
		});
		expect(await screen.findByText(text)).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		if (succeeds) await waitFor(() => expect(document.querySelector('[data-device="mini"]')?.getAttribute("data-device-name")).toBe("mini 2"));
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
		expect(await screen.findByRole("heading", { name: "Sign in to pika" })).toBeTruthy();
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
		expect(await screen.findByRole("heading", { name: "Sign in to pika" })).toBeTruthy();
		expect(server.mutations).toEqual([{ method: "POST", path: "/api/v1/auth/sessions/revoke-all", body: {}, json: true }]);
		expect(server.state.browserSessions).toEqual([]);
	});

	it.each([
		["signing out in the band", "/api/v1/logout", () => fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "Sign out" }))],
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
		expect(await screen.findByRole("heading", { name: "Sign in to pika" })).toBeTruthy();
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
		await waitFor(() => expect(within(deviceTable()).getByRole("button", { name: "Revoke mini" })).toBeTruthy());
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
