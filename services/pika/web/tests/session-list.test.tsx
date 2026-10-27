import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summary } from "./support/fixtures";
import { mockLayout, renderApp, scrollMain } from "./support/render";
import { createFakeServer, type FakeSession } from "./support/server";

function session(id: string, extra: Parameters<typeof summary>[1] = {}): FakeSession {
	return { detail: summary(id, extra), turns: [], entries: [] };
}

const sessions = [
	session("a", { title: "Refactor auth", device: "mini", project: "api", childCount: 2, models: ["claude-sonnet-4-5", "gpt-5"] }),
	session("b", { title: "Write the docs", device: "laptop", project: "docs", cost: 0.004 }),
	session("c", { title: "Recon subagent", device: "mini", project: "api", parentSessionId: "a", link: { kind: "subagent" } }),
];

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 2000, rowHeight: 72 });
});
afterEach(() => restore());

describe("session list", () => {
	it("lists root sessions with their summary", async () => {
		const server = createFakeServer({ sessions });
		renderApp("/", server.fetch);
		const row = (await screen.findByText("Refactor auth")).closest("a")!;
		expect(row.getAttribute("href")).toBe("/s/a");
		expect(within(row).getByText("mini")).toBeTruthy();
		expect(within(row).getByText("api")).toBeTruthy();
		expect(within(row).getByText("10m")).toBeTruthy();
		expect(within(row).getByText("96.4k tokens")).toBeTruthy();
		expect(within(row).getByText("$0.31")).toBeTruthy();
		expect(within(row).getByText("gpt-5")).toBeTruthy();
		expect(within(row).getByTitle("Child sessions").textContent).toBe("2");
		expect(screen.getByText("Write the docs")).toBeTruthy();
		expect(screen.queryByText("Recon subagent")).toBeNull();
		expect(server.calls).toContain("/api/v1/sessions?root=true&limit=50");
	});

	it("includes child sessions when asked", async () => {
		const server = createFakeServer({ sessions });
		renderApp("/", server.fetch);
		await screen.findByText("Refactor auth");
		fireEvent.click(screen.getByLabelText(/Include subagents/));
		expect(await screen.findByText("Recon subagent")).toBeTruthy();
		expect(server.calls).toContain("/api/v1/sessions?limit=50");
	});

	it("filters by a facet chosen from a filter chip", async () => {
		const server = createFakeServer({ sessions });
		renderApp("/", server.fetch);
		await screen.findByText("Refactor auth");
		fireEvent.click(screen.getByRole("button", { name: /Device/ }));
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "laptop" }));
		expect(await screen.findByText("Write the docs")).toBeTruthy();
		expect(screen.queryByText("Refactor auth")).toBeNull();
		expect(server.calls).toContain("/api/v1/sessions?device=laptop&root=true&limit=50");
		expect(screen.getByRole("button", { name: /Device: laptop/ })).toBeTruthy();
	});

	it("sends a date range as ISO bounds", async () => {
		const server = createFakeServer({ sessions });
		renderApp("/?from=2026-10-01&to=2026-10-02", server.fetch);
		await screen.findByText("Refactor auth");
		const call = server.calls.find((c) => c.startsWith("/api/v1/sessions?"))!;
		const params = new URL(call, "http://x").searchParams;
		expect(new Date(params.get("from")!).getTime()).toBe(new Date("2026-10-01T00:00:00").getTime());
		expect(new Date(params.get("to")!).getTime()).toBe(new Date("2026-10-02T23:59:59.999").getTime());
	});

	it("shows a first-run empty state that says how to add a machine", async () => {
		renderApp("/", createFakeServer({ sessions: [] }).fetch);
		const empty = (await screen.findByText("No sessions yet")).closest<HTMLElement>("[data-state=empty]")!;
		expect(empty.textContent).toContain("Run /pika login in pi on each machine. Sessions appear here as they run.");
		expect(empty.querySelector("code")?.textContent).toBe("/pika login");
		expect(empty.querySelector("svg[data-pika-logo]")).not.toBeNull();
	});

	it("keeps a filtered empty state plain", async () => {
		renderApp("/?device=nowhere", createFakeServer({ sessions }).fetch);
		const empty = (await screen.findByText("Nothing matches these filters.")).closest<HTMLElement>("[data-state=empty]")!;
		expect(within(empty).getByText("No sessions")).toBeTruthy();
		expect(empty.querySelector("svg")).toBeNull();
	});

	it("loads further pages as the list scrolls", async () => {
		const many = Array.from({ length: 120 }, (_, i) => session(`s${i}`, { title: `Session number ${i}` }));
		const server = createFakeServer({ sessions: many });
		renderApp("/", server.fetch);
		await screen.findByText("Session number 0");
		scrollMain(48 * 72);
		await waitFor(() => expect(server.calls).toContain("/api/v1/sessions?root=true&cursor=50&limit=50"));
		expect(document.querySelectorAll("[data-session-row]").length).toBeLessThan(100);
	});
});
