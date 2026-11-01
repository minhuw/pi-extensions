import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import { useVisitorView } from "../src/components/useVisitorView";
import { VisitorOriginsSection } from "../src/components/VisitorOrigins";
import { PikaApi, type VisitorOrigins } from "../src/lib/api";
import { renderApp, renderWithApi } from "./support/render";
import { createFakeServer } from "./support/server";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const data: VisitorOrigins = { mode: "direct", days: 30, views: 9, dailyVisitors: 6, daily: [], countries: [{ country: "US", views: 5, dailyVisitors: 3 }, { country: null, views: 4, dailyVisitors: 3 }], projects: [{ project: "pika", views: 4, dailyVisitors: 2 }] };

function Tracker({ api, guest = false }: { api: PikaApi; guest?: boolean }) {
	const location = useLocation();
	useVisitorView(api, location, guest);
	return <nav>{["/public?project=pika", "/public?project=pika&view=grid", "/public?project=other", "/public/s/a%2Eb", "/public/s/a%2Eb?view=transcript", "/public/search?q=foo", "/public", "/public/s/%ZZ", "/public/s/%00", "/public/s/a%2Fb"].map((path) => <Link key={path} to={path}>{path}</Link>)}</nav>;
}

describe("public visitor tracking", () => {
	it("sends a gallery view from the real public layout without fetching owner analytics", async () => {
		const source = createFakeServer({});
		const calls: { url: string; init?: RequestInit }[] = [];
		renderApp("/public?project=pika", async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url === "/api/public/v1/visitor-view") return new Response(null, { status: 204 });
			return source.fetch(url.replace("/api/public/v1/", "/api/v1/"), init);
		});
		await waitFor(() => expect(calls.some((call) => call.url === "/api/public/v1/visitor-view")).toBe(true));
		expect(JSON.parse(String(calls.find((call) => call.url.endsWith("visitor-view"))?.init?.body))).toEqual({ page: "gallery", project: "pika" });
		expect(calls.some((call) => call.url.includes("visitor-origins"))).toBe(false);
	});
	it("tracks meaningful navigation once under strict effects, with anonymous base-aware requests and harmless failures", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const api = new PikaApi("/pika", async (input, init) => { calls.push({ url: String(input), init }); throw new Error("offline"); }).forPublic();
		render(<StrictMode><MemoryRouter initialEntries={["/public"]}><Tracker api={api} /></MemoryRouter></StrictMode>);
		const click = (path: string) => fireEvent.click(screen.getByRole("link", { name: path }));
		click("/public?project=pika"); click("/public?project=pika&view=grid"); click("/public?project=other");
		click("/public/s/a%2Eb"); click("/public/s/a%2Eb?view=transcript"); click("/public/search?q=foo"); click("/public");
		click("/public/s/%ZZ"); click("/public/s/%00"); click("/public/s/a%2Fb");
		await waitFor(() => expect(calls).toHaveLength(6));
		expect(calls.map((call) => JSON.parse(String(call.init?.body)))).toEqual([{ page: "gallery" }, { page: "gallery", project: "pika" }, { page: "gallery", project: "other" }, { page: "session", sessionId: "a.b" }, { page: "gallery" }, { page: "session", sessionId: "a/b" }]);
		expect(calls.every((call) => call.url === "/pika/api/public/v1/visitor-view" && call.init?.credentials === "omit" && call.init?.method === "POST")).toBe(true);
	});
	it("excludes the marked owner guest view", () => {
		const calls: string[] = [];
		const api = new PikaApi("/", async (input) => { calls.push(String(input)); return new Response(null, { status: 204 }); }).forPublic();
		render(<MemoryRouter initialEntries={["/public"]}><Tracker api={api} guest /></MemoryRouter>);
		fireEvent.click(screen.getByRole("link", { name: "/public?project=pika" }));
		expect(calls).toEqual([]);
	});
});

describe("visitor origins dashboard", () => {
	it("shows accurate totals, country and project breakdowns, and 30 UTC dates using the owner API", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const dates = Array.from({ length: 30 }, (_, index) => `2024-01-${String(index + 1).padStart(2, "0")}`);
		renderWithApi(<VisitorOriginsSection />, async (input, init) => { calls.push({ url: String(input), init }); return json({ ...data, daily: dates.map((date, index) => ({ date, views: index === 29 ? 7 : 0, dailyVisitors: 0 })) }); });
		expect(await screen.findByText("United States")).toBeTruthy();
		expect(screen.getByText("Unknown")).toBeTruthy();
		expect(screen.getByText("pika")).toBeTruthy();
		expect(screen.getByText("Total views").nextElementSibling?.textContent).toBe("9");
		expect(screen.getByText("Sum of daily estimated visitors", { selector: "dt" }).nextElementSibling?.textContent).toBe("6");
		expect(screen.getByText(/not unique people over 30 days/)).toBeTruthy();
		fireEvent.click(screen.getByText(/Daily views ·/));
		// The daily table is the third table and contains the full UTC window.
		const rows = within(screen.getAllByRole("table")[2]!).getAllByRole("row");
		expect(rows).toHaveLength(31);
		expect(within(rows[30]!).getByText("2024-01-30")).toBeTruthy();
		expect(within(rows[30]!).getByText("7")).toBeTruthy();
		expect(calls[0]?.url).toBe("/api/v1/visitor-origins");
		expect(calls[0]?.init?.credentials).toBe("same-origin");
	});
	it("explains disabled analytics without showing results", async () => {
		renderWithApi(<VisitorOriginsSection />, async () => json({ ...data, mode: "off" }));
		expect(await screen.findByText(/Visitor analytics is off/)).toBeTruthy();
		expect(screen.getByText("PIKA_TRUST_PROXY=1")).toBeTruthy();
		expect(screen.getByText(/Remove the server option or environment variable/)).toBeTruthy();
		expect(screen.queryByText("Total views")).toBeNull();
	});
	it("shows empty and error states", async () => {
		const result = renderWithApi(<VisitorOriginsSection />, async () => json({ ...data, views: 0, dailyVisitors: 0, countries: [], projects: [] }));
		expect(await screen.findByText("No views yet")).toBeTruthy();
		expect(screen.getAllByText("No data yet.")).toHaveLength(2);
		result.unmount();
		renderWithApi(<VisitorOriginsSection />, async () => json({ error: "unavailable" }, 500));
		expect(await screen.findByText("unavailable")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
	});
});
