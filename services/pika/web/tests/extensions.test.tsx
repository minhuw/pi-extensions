import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionUsage } from "../src/lib/types";
import { renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

function fixture(days: number, empty = false): ExtensionUsage {
	const since = Date.now() - days * 86_400_000;
	if (empty) return { days, since, tools: [], commands: [] };
	return {
		days,
		since,
		tools: [
			{ name: "bash", calls: days + 3, sessions: 4, errors: 5, lastAt: Date.now() - 3_600_000 },
			{ name: "read", calls: 7, sessions: 2, errors: 0, lastAt: null },
		],
		commands: [
			{ command: "herder", kind: "extension", extension: "herder", uses: 3, sessions: 2, lastAt: Date.now() - 60_000 },
			{ command: "review", kind: "template", extension: null, uses: 1, sessions: 1, lastAt: null },
		],
	};
}

function server() {
	const fallback = createFakeServer({});
	const state = { empty: false };
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://localhost");
		if (!url.pathname.endsWith("/extension-usage")) return fallback.fetch(input, init);
		return Response.json(fixture(Number(url.searchParams.get("days")), state.empty));
	});
	return { fetch: fetchImpl, state, calls: () => fetchImpl.mock.calls.filter(([path]) => String(path).includes("/extension-usage")).map(([path]) => String(path)) };
}

describe("Extensions", () => {
	it("is linked from the band and shows tools and commands for the last 90 days by default", async () => {
		const api = server();
		renderApp("/", api.fetch);
		const nav = await screen.findByRole("navigation", { name: "Main" });
		fireEvent.click(within(nav).getByRole("link", { name: "Extensions" }));
		expect(await screen.findByRole("heading", { name: "Extensions", level: 1 })).toBeTruthy();
		const tools = within(await screen.findByRole("region", { name: "Tools" })).getAllByRole<HTMLTableRowElement>("row");
		expect(tools.map((row) => [...row.cells].map((cell) => cell.textContent))).toEqual([
			["Tool", "Calls", "Sessions", "Error rate", "Last used"],
			["bash", "93", "4", "5.4%", "1 hour ago"],
			["read", "7", "2", "0.0%", "—"],
		]);
		const commands = within(screen.getByRole("region", { name: "Commands" })).getAllByRole<HTMLTableRowElement>("row");
		expect(commands.map((row) => [...row.cells].map((cell) => cell.textContent))).toEqual([
			["Command", "Kind", "Extension", "Uses", "Sessions", "Last used"],
			["/herder", "extension", "herder", "3", "2", "1 minute ago"],
			["/review", "template", "—", "1", "1", "—"],
		]);
		expect(api.calls()).toEqual(["/api/v1/extension-usage?days=90"]);
		expect(screen.getByRole("button", { name: "90 days" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("refetches with the chosen range and holds it in the URL", async () => {
		const api = server();
		renderApp("/extensions?days=7", api.fetch);
		const calls = () => document.querySelector<HTMLTableRowElement>("[data-tool=bash]")?.cells[1].textContent;
		await waitFor(() => expect(calls()).toBe("10"));
		expect(api.calls()).toEqual(["/api/v1/extension-usage?days=7"]);
		fireEvent.click(screen.getByRole("button", { name: "365 days" }));
		await waitFor(() => expect(calls()).toBe("368"));
		expect(api.calls()).toEqual(["/api/v1/extension-usage?days=7", "/api/v1/extension-usage?days=365"]);
		expect(screen.getByRole("button", { name: "365 days" }).getAttribute("aria-pressed")).toBe("true");
	});

	it("shows an empty state for each table", async () => {
		const api = server();
		api.state.empty = true;
		renderApp("/extensions", api.fetch);
		expect(await screen.findByText("No tool calls in this range")).toBeTruthy();
		expect(screen.getByText("No commands in this range")).toBeTruthy();
		expect(document.querySelector("[data-extension-tools]")).toBeNull();
		expect(document.querySelector("[data-extension-commands]")).toBeNull();
	});
});
