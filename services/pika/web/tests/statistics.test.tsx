import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PikaApi } from "../src/lib/api";
import { guestPath } from "../src/lib/guestView";
import { totalTokens } from "../src/lib/format";
import type { UsageGroup, UsageReport, UsageStatistics } from "../src/lib/types";
import { axisTicks, bucketParts, formatDateRange, layerOf, modelFamily, modelOrder, OTHER, splitSeries, tokenParts, UNNAMED, usageBuckets, type Series } from "../src/pages/Statistics";
import { firstRender, renderApp } from "./support/render";
import { createFakeServer } from "./support/server";

function fixture(exclude = false): UsageStatistics {
	const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const daily = [
		{ date: "2026-11-01", sessions: 1, requests: 2, tokens: { ...empty, input: 40, output: 40 }, cost: 0.2 },
		{ date: "2026-11-02", sessions: 0, requests: 0, tokens: { ...empty }, cost: 0 },
		{ date: "2026-11-03", sessions: exclude ? 0 : 1, requests: exclude ? 0 : 1, tokens: { ...empty, input: exclude ? 0 : 60, output: exclude ? 0 : 20, cacheRead: exclude ? 0 : 300 }, cost: exclude ? 0 : 0.3 },
	];
	return { from: daily[0].date, to: daily[2].date, excludeUnpublished: exclude, daily,
		totals: { sessions: exclude ? 1 : 2, requests: exclude ? 2 : 3, tokens: { ...empty, input: exclude ? 40 : 100, output: exclude ? 40 : 60, cacheRead: exclude ? 0 : 300 }, cost: exclude ? 0.2 : 0.5, activeDays: exclude ? 1 : 2 } };
}
const zero = { requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const group = (name: string | null, tokens: number, extras: Partial<UsageGroup> = {}): UsageGroup => ({ ...zero, name, tokens, ...extras });
/** The fixture's days split two ways: the same totals as `fixture()`, across two models or projects and unnamed usage. */
function usageFixture(by: "model" | "project"): UsageReport {
	const [big, small] = by === "model" ? ["claude-opus-5-5", "gpt-6-luna"] : ["pika", "widgets"];
	const periods = [
		{ ...zero, start: "2026-11-01", end: "2026-11-01", tokens: 80, groups: [group(small, 80, { requests: 2, cost: 0.2 })] },
		{ ...zero, start: "2026-11-02", end: "2026-11-02", groups: [] },
		{ ...zero, start: "2026-11-03", end: "2026-11-03", tokens: 380, groups: [group(big, 300, { requests: 1, cost: 0.25 }), group(null, 80, { cost: 0.05 })] },
	];
	return { from: "2026-11-01", to: "2026-11-03", interval: "day", by, excludeUnpublished: false, total: { ...zero, tokens: 460 },
		groups: [group(big, 300), group(small, 80), group(null, 80)], periods };
}
const noMetrics = { completed: 0, failed: 0, aborted: 0, unknown: 0, ttftMs: null, tokensPerSecond: null, ttftCalls: 0, rateCalls: 0 };
function server() {
	const fallback = createFakeServer({});
	const state = { fail: false, empty: false, usage: false, breakdowns: false };
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://localhost");
		if (url.pathname.endsWith("/usage") && state.usage) return Response.json(usageFixture(url.searchParams.get("by") === "project" ? "project" : "model"));
		if (!url.pathname.endsWith("/statistics")) return fallback.fetch(input, init);
		if (state.fail) return Response.json({ error: "internal" }, { status: 500 });
		const data = fixture(url.searchParams.get("excludeUnpublished") === "true");
		if (state.breakdowns) {
			const row = (kind: "project" | "unpublished" | "model" | "other-usage", name: string | null, input: number) =>
				({ kind, name, sessions: 1, requests: 1, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, metrics: noMetrics });
			data.projects = [row("project", "pika", 300), row("project", "widgets", 80), row("unpublished", null, 80)];
			data.models = [row("model", "claude-opus-5-5", 300), row("model", "gpt-6-luna", 80), row("other-usage", null, 80)];
		}
		if (state.empty) {
			data.totals = { sessions: 0, requests: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, activeDays: 0 };
			data.daily = data.daily.map(day => ({ ...day, ...data.totals }));
		}
		return Response.json(data);
	});
	return {
		fetch: fetchImpl,
		state,
		calls: () => fetchImpl.mock.calls.filter(([path]) => String(path).includes("/statistics")),
		usageCalls: () => fetchImpl.mock.calls.filter(([path]) => String(path).includes("/usage")),
	};
}
const totals = () => document.querySelector<HTMLElement>("[data-usage-totals]")!;

describe("Statistics", () => {
	it("opens anonymously under a base path, includes unpublished by default, and keeps owner controls absent", async () => {
		const api = server();
		renderApp("/public/statistics", api.fetch, "/pika");
		await screen.findByRole("heading", { name: "Statistics", level: 1 }, firstRender);
		await waitFor(() => expect(totals()?.textContent).toContain("460"));
		expect((screen.getByRole("checkbox", { name: "Exclude unpublished trajectories" }) as HTMLInputElement).checked).toBe(false);
		const [url, init] = api.calls()[0];
		expect(String(url)).toBe("/pika/api/public/v1/statistics?days=30&excludeUnpublished=false");
		expect(init).toMatchObject({ credentials: "omit", cache: "no-store" });
		expect(screen.getByText(/their contents stay private/)).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Devices" })).toBeNull();
		expect(within(screen.getByRole("navigation", { name: "Public" })).getByRole("link", { name: "Statistics" }).getAttribute("aria-current")).toBe("page");
		expect(api.calls()).toHaveLength(1);
	});

	it("refetches aggregates on exclusion and period changes, preserving the chosen scope in the URL", async () => {
		const api = server();
		renderApp("/public/statistics", api.fetch);
		await waitFor(() => expect(totals()?.textContent).toContain("460"), firstRender);
		fireEvent.click(screen.getByRole("checkbox", { name: "Exclude unpublished trajectories" }));
		await waitFor(() => expect(totals()?.textContent).toContain("80"));
		expect(screen.getByText("Showing published, visible trajectories only.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "All time" }));
		await waitFor(() => expect(api.calls().some(([url]) => String(url).endsWith("days=all&excludeUnpublished=true"))).toBe(true));
		fireEvent.click(screen.getByRole("checkbox", { name: "Exclude unpublished trajectories" }));
		await waitFor(() => expect(totals()?.textContent).toContain("460"));
		expect(api.calls().some(([url]) => String(url).endsWith("days=all&excludeUnpublished=false"))).toBe(true);
	});

	it("makes chart days keyboard selectable with exact values, including zero days", async () => {
		const api = server();
		renderApp("/public/statistics?days=7", api.fetch);
		const last = await screen.findByRole("button", { name: "2026-11-03: 380 tokens" }, firstRender);
		last.focus();
		fireEvent.keyDown(last, { key: "ArrowLeft" });
		expect(document.activeElement?.getAttribute("aria-label")).toBe("2026-11-02: 0 tokens");
		expect(document.querySelector("[data-chart-selection]")?.textContent).toContain("0 tokens");
		fireEvent.click(within(screen.getByRole("group", { name: "Chart metric" })).getByRole("button", { name: "Requests" }));
		expect(screen.getByRole("button", { name: "2026-11-01: 2 requests" })).toBeTruthy();
		fireEvent.click(within(screen.getByRole("group", { name: "Chart metric" })).getByRole("button", { name: "Cost" }));
		expect(screen.getByRole("button", { name: "2026-11-03: $0.30" })).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("stacks total tokens by type by default and splits the chart and the breakdown together by model or project", async () => {
		const api = server();
		api.state.usage = true;
		api.state.breakdowns = true;
		renderApp("/public/statistics?days=7", api.fetch);
		await screen.findByRole("heading", { name: "Breakdown by project" }, firstRender);
		const split = within(screen.getByRole("group", { name: "Split" }));
		expect(split.getByRole("button", { name: "Total" }).getAttribute("aria-pressed")).toBe("true");
		const parts = (date: string) => [...document.querySelectorAll(`[data-usage-bar="${date}"] [data-usage-part]`)].map((el) => el.getAttribute("data-usage-part"));
		const legend = (name: string) => document.querySelector(`[data-legend="${name}"]`)!.textContent;
		// Total tokens stack by type from the daily totals, darkest at the bottom, without asking the server for more.
		expect(parts("2026-11-03")).toEqual(["Output", "Input", "Cache read"]);
		expect(parts("2026-11-01")).toEqual(["Output", "Input"]);
		expect(legend("Cache read")).toContain("300");
		expect(legend("Input")).toContain("60");
		expect(screen.getByRole("list", { name: "Nov 3 by token type" })).toBeTruthy();
		expect(document.querySelector("[data-usage-swatch]")).toBeNull();
		expect(api.usageCalls()).toHaveLength(0);
		// Requests and cost have no token types: one black column each.
		const metric = within(screen.getByRole("group", { name: "Chart metric" }));
		fireEvent.click(metric.getByRole("button", { name: "Requests" }));
		expect(document.querySelector("[data-usage-stack]")).toBeNull();
		expect(document.querySelector("[data-chart-legend]")).toBeNull();
		fireEvent.click(metric.getByRole("button", { name: "Tokens" }));

		fireEvent.click(split.getByRole("button", { name: "By model" }));
		await waitFor(() => expect(document.querySelector("[data-usage-stack]")).toBeTruthy());
		// The range split by model, and every model in first-use order for their colours.
		expect(api.usageCalls().map(([url]) => String(url)).toSorted()).toEqual([
			"/api/public/v1/usage?days=7&by=model&excludeUnpublished=false",
			"/api/public/v1/usage?days=all&by=model&interval=month&excludeUnpublished=false",
		]);
		expect(screen.getByRole("heading", { name: "Breakdown by model" })).toBeTruthy();
		await waitFor(() => expect(parts("2026-11-03")).toEqual(["claude-opus-5-5", "No model recorded"]));
		expect(parts("2026-11-01")).toEqual(["gpt-6-luna"]);
		expect(document.querySelector('[data-usage-bar="2026-11-02"] [data-usage-stack]')).toBeNull();
		// The table rows carry the same layer swatches as the bars: the table is the chart's key.
		const swatch = (name: string) => (document.querySelector(`[data-usage-group="${name}"] [data-usage-swatch]`) as HTMLElement).style.background;
		const part = (date: string, name: string) => (document.querySelector(`[data-usage-bar="${date}"] [data-usage-part="${name}"]`) as HTMLElement).style.background;
		expect(swatch("claude-opus-5-5")).toBe(part("2026-11-03", "claude-opus-5-5"));
		expect(swatch("gpt-6-luna")).toBe(part("2026-11-01", "gpt-6-luna"));
		// The latest day with usage is chosen first; the legend reads it per layer.
		expect(legend("claude-opus-5-5")).toContain("300");
		expect(legend("No model recorded")).toContain("80");
		expect(screen.getByRole("list", { name: "Nov 3 by model" })).toBeTruthy();
		const last = screen.getByRole("button", { name: "2026-11-03: 380 tokens" });
		// Hovering a stacked bar opens a card with its layers, top of the stack first, and each one's share of the bar.
		const tooltip = () => document.querySelector("[data-chart-tooltip]");
		const tooltipRows = () => [...document.querySelectorAll("[data-tooltip-layer]")].map((el) => [el.getAttribute("data-tooltip-layer"), el.textContent]);
		expect(tooltip()).toBeNull();
		fireEvent.mouseEnter(last);
		expect(tooltipRows()).toEqual([["No model recorded", "No model recorded8021.1%"], ["claude-opus-5-5", "claude-opus-5-530078.9%"]]);
		expect(last.getAttribute("aria-describedby")).toBe(tooltip()!.id);
		fireEvent.mouseEnter(screen.getByRole("button", { name: "2026-11-01: 80 tokens" }));
		expect(tooltipRows()).toEqual([["gpt-6-luna", "gpt-6-luna80100.0%"]]);
		// A day without usage has nothing to break down.
		fireEvent.mouseEnter(screen.getByRole("button", { name: "2026-11-02: 0 tokens" }));
		expect(tooltip()).toBeNull();
		fireEvent.mouseLeave(screen.getByRole("group", { name: "Tokens by UTC date" }));
		expect(tooltip()).toBeNull();
		// Keyboard focus opens it too.
		act(() => last.focus());
		expect(tooltipRows().map(([name]) => name)).toEqual(["No model recorded", "claude-opus-5-5"]);
		fireEvent.keyDown(last, { key: "ArrowLeft" });
		fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
		expect(legend("gpt-6-luna")).toContain("80");
		fireEvent.click(within(screen.getByRole("group", { name: "Chart metric" })).getByRole("button", { name: "Requests" }));
		expect(legend("gpt-6-luna")).toContain("2");
		fireEvent.click(within(screen.getByRole("group", { name: "Chart metric" })).getByRole("button", { name: "Tokens" }));

		fireEvent.click(split.getByRole("button", { name: "By project" }));
		await waitFor(() => expect(parts("2026-11-03")).toEqual(["pika", "Unpublished & hidden"]));
		expect(String(api.usageCalls().at(-1)![0])).toBe("/api/public/v1/usage?days=7&by=project&excludeUnpublished=false");
		expect(screen.getByRole("heading", { name: "Breakdown by project" })).toBeTruthy();
		expect(swatch("pika")).toBe(part("2026-11-03", "pika"));
		expect(swatch("Unpublished & hidden")).toBe(part("2026-11-03", "Unpublished & hidden"));

		fireEvent.click(split.getByRole("button", { name: "Total" }));
		expect(parts("2026-11-03")).toEqual(["Output", "Input", "Cache read"]);
		expect(document.querySelector("[data-usage-swatch]")).toBeNull();
	});

	it("keeps the split in the URL and leaves the bars whole when the server has no usage endpoint", async () => {
		const api = server();
		api.state.breakdowns = true;
		renderApp("/public/statistics?days=7&by=model", api.fetch);
		await screen.findByRole("heading", { name: "Breakdown by model" }, firstRender);
		await waitFor(() => expect(api.usageCalls()).toHaveLength(2));
		expect(within(screen.getByRole("group", { name: "Split" })).getByRole("button", { name: "By model" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "2026-11-03: 380 tokens" })).toBeTruthy();
		expect(document.querySelector("[data-usage-stack]")).toBeNull();
		expect(document.querySelector("[data-chart-legend]")).toBeNull();
	});

	it("layers ten models, each in its maker's colour by first use, or six projects in ink, then the rest and the unnamed", () => {
		const groups = [
			group("claude-opus-5-5", 1200), group("gpt-6-luna", 1100), group("claude-haiku-5-5", 1000), group("gemini-3-pro", 900),
			group("llama-5", 800), group("gpt-6-mini", 700), group("claude-sonnet-5-5", 600), group("grok-5", 500), group("qwen3-coder", 400),
			group("k3.1-pro", 300), group("gpt-6.1-sol", 200), group("glm-5", 100), group(null, 50), group("idle", 0),
		];
		const order = ["gpt-6-luna", "claude-opus-5-5", "gpt-6.1-sol", "claude-haiku-5-5", "gpt-6-mini", "claude-sonnet-5-5"];
		const series = splitSeries(groups, "model", false, order);
		// Grouped by maker in order of each maker's largest model; unknown makers share ink.
		expect(series.map((s) => s.id)).toEqual([
			"claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "gpt-6-luna", "gpt-6-mini", "gemini-3-pro", "llama-5", "grok-5",
			"qwen3-coder", "k3.1-pro", OTHER, UNNAMED,
		]);
		const fill = (layers: Series[], id: string) => layers.find((s) => s.id === id)?.fill;
		// A maker's models take its variants in first-use order: Claude's first three, OpenAI's first and third.
		expect(series.slice(0, 5).map((s) => s.fill)).toEqual([
			"var(--color-model-claude)",
			"color-mix(in oklab, var(--color-model-claude) 66%, var(--color-page))",
			"color-mix(in oklab, var(--color-model-claude) 70%, var(--color-ink))",
			"var(--color-model-openai)",
			"color-mix(in oklab, var(--color-model-openai) 70%, var(--color-ink))",
		]);
		expect(series.slice(5, 10).map((s) => s.fill)).toEqual([
			"var(--color-model-gemini)", "var(--color-ink)", "var(--color-model-grok)", "var(--color-model-qwen)", "var(--color-model-kimi)",
		]);
		expect(new Set(series.map((s) => s.fill)).size).toBe(series.length);
		// Another range keeps each model's colour.
		const week = splitSeries([group("gpt-6-mini", 9), group("claude-sonnet-5-5", 5), group("gpt-6.1-sol", 3)], "model", false, order);
		for (const id of ["gpt-6-mini", "claude-sonnet-5-5"]) expect(fill(week, id)).toBe(fill(series, id));
		expect(fill(week, "gpt-6.1-sol")).toBe("color-mix(in oklab, var(--color-model-openai) 66%, var(--color-page))");
		// Without an order, models a maker shares take its variants in name order.
		expect(splitSeries([group("gpt-6-mini", 9), group("gpt-6-luna", 5)], "model").map((s) => s.fill)).toEqual([
			"color-mix(in oklab, var(--color-model-openai) 66%, var(--color-page))", "var(--color-model-openai)",
		]);
		expect(modelFamily("qwen3-coder")).toBe("qwen");
		expect(modelFamily("devstral-small")).toBe("mistral");
		expect(modelFamily("glm-5")).toBe("zai");
		expect(modelFamily("abab-7")).toBe("minimax");
		expect(modelFamily("llama-5")).toBeUndefined();
		// Projects named like models are still projects: one ink scale, six layers.
		const projects = splitSeries(Array.from({ length: 7 }, (_, i) => group(i ? `p${i}` : "claude-app", 10 - i)), "project");
		expect(projects.slice(0, 2).map((s) => s.fill)).toEqual(["var(--color-ink)", "color-mix(in srgb, var(--color-ink) 72%, var(--color-page))"]);
		expect(projects.map((s) => s.id).at(-1)).toBe(OTHER);
		expect(projects.at(-1)!.label).toBe("1 other project");
		expect(series[10].label).toBe("2 other models");
		expect(series[11].label).toBe("No model recorded");
		expect(splitSeries([group("pika", 10), group(null, 5)], "project", true).map((s) => s.label)).toEqual(["pika", "Unpublished & hidden"]);
		expect(splitSeries([group("pika", 10), group(null, 5)], "project").map((s) => s.label)).toEqual(["pika", "No project"]);
		expect(layerOf(series, "gpt-6.1-sol")?.id).toBe(OTHER);
		expect(layerOf(series, null)?.id).toBe(UNNAMED);

		// First use: by month, then by name; idle models, and models with failed calls alone, wait until they use tokens.
		const period = (start: string, groups: UsageGroup[]) => ({ ...zero, tokens: 0, start, end: start, groups });
		const monthly = { ...usageFixture("model"), interval: "month" as const, periods: [
			period("2026-09-01", [group("zeta", 10), group("alpha", 5)]),
			period("2026-10-01", [group("alpha", 3), group("idle", 0), group("beta", 0, { requests: 2 })]),
			period("2026-11-01", [group("beta", 2), group("idle", 1), group(null, 4)]),
		] };
		expect(modelOrder(monthly)).toEqual(["alpha", "zeta", "beta", "idle"]);

		const report = usageFixture("model");
		const { buckets } = usageBuckets(fixture().daily, "tokens");
		const layers = splitSeries(report.groups!, "model");
		expect(layers.map((s) => s.id)).toEqual(["claude-opus-5-5", "gpt-6-luna", UNNAMED]);
		expect(bucketParts(buckets, report.periods, layers, "tokens")).toEqual([[0, 80, 0], [0, 0, 0], [300, 0, 80]]);
		expect(bucketParts(buckets, report.periods, layers, "cost")).toEqual([[0, 0.2, 0], [0, 0, 0], [0.25, 0, 0.05]]);
		// Days the report does not cover are left unsplit rather than shown as zero.
		expect(bucketParts(buckets, report.periods.slice(1), layers, "tokens")[0]).toBeUndefined();
		expect(tokenParts(buckets, fixture().daily)).toEqual([[40, 40, 0, 0], [0, 0, 0, 0], [20, 60, 0, 300]]);
		const crowded = splitSeries([group("claude-opus-5-5", 300), ...Array.from({ length: 10 }, (_, i) => group(`m${i}`, 200 - i))], "model");
		expect(bucketParts(buckets, report.periods, crowded, "tokens")[0]).toEqual([...Array(10).fill(0), 80]);
	});

	it("shows an empty state and lets a failed request retry", async () => {
		const api = server();
		api.state.fail = true;
		renderApp("/public/statistics", api.fetch);
		await screen.findByRole("button", { name: "Try again" }, { timeout: 3000 });
		api.state.fail = false;
		api.state.empty = true;
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await screen.findByText("No activity in this range");
		expect(totals().querySelector('[data-kpi="tokens"] [data-kpi-value]')?.textContent).toBe("0");
		expect(document.querySelector("[data-usage-chart]")).toBeNull();
	});

	it("links the owner's tab and retains the page and filters when viewing as guest", async () => {
		const api = server();
		renderApp("/statistics?days=90&excludeUnpublished=true", api.fetch);
		await waitFor(() => expect(totals()).toBeTruthy(), firstRender);
		expect(api.calls()[0][0]).toBe("/api/v1/statistics?days=90&excludeUnpublished=true");
		const nav = screen.getByRole("navigation", { name: "Main" });
		expect(within(nav).getByRole("link", { name: "Statistics" }).getAttribute("aria-current")).toBe("page");
		expect(screen.getByRole("link", { name: "View as guest" }).getAttribute("href")).toBe("/public/statistics?days=90&excludeUnpublished=true");
		expect(guestPath("/statistics", "?days=7")).toBe("/public/statistics?days=7");
	});

	it("opens the public statistics page for a signed-out owner URL without probing private data", async () => {
		const api = server();
		const fetchImpl: typeof fetch = (input, init) => String(input).endsWith("/me") ? Promise.resolve(Response.json({ authenticated: false, passwordRequired: true, authMode: "password" })) : api.fetch(input, init);
		renderApp("/statistics?days=7", fetchImpl);
		await waitFor(() => expect(totals()).toBeTruthy(), firstRender);
		expect(api.calls()[0][0]).toBe("/api/public/v1/statistics?days=7&excludeUnpublished=false");
	});

	it("integrates project/model breakdowns and request metrics into the statistics page", async () => {
		const api = server();
		const data = fixture();
		const metrics = { completed: 2, failed: 1, aborted: 0, unknown: 0, ttftMs: 300, tokensPerSecond: 62.5, ttftCalls: 2, rateCalls: 2 };
		data.requestMetrics = metrics;
		data.projects = [{ ...data.totals, kind: "unpublished", name: null, metrics }];
		data.models = [{ ...data.totals, kind: "model", name: "gpt-6-luna", metrics }];
		const fetchImpl: typeof fetch = (input, init) => String(input).includes("/statistics") ? Promise.resolve(Response.json(data)) : api.fetch(input, init);
		renderApp("/public/statistics", fetchImpl);
		await screen.findByRole("heading", { name: "Breakdown by project" }, firstRender);
		const figures = totals().textContent;
		expect(figures).toContain("75% cache reads");
		expect(figures).toContain("1 failed");
		expect(figures).toContain("66.7% completed");
		// Timing stays in the breakdown table, not among the figures.
		expect(document.querySelector('[data-kpi="ttft"], [data-kpi="rate"]')).toBeNull();
		expect(figures).not.toContain("tok/s");
		expect(screen.getByRole("button", { name: "Unpublished & hidden" }).getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(within(screen.getByRole("group", { name: "Split" })).getByRole("button", { name: "By model" }));
		expect(await screen.findByRole("button", { name: "gpt-6-luna" })).toBeTruthy();
	});

	it("says how much of the cost pika estimated for calls that recorded none", async () => {
		const api = server();
		const data = fixture();
		const cost = () => totals().querySelector<HTMLElement>('[data-kpi="cost"]')!;
		let fetched = data;
		const fetchImpl: typeof fetch = (input, init) => String(input).includes("/statistics") ? Promise.resolve(Response.json(fetched)) : api.fetch(input, init);
		renderApp("/public/statistics", fetchImpl);
		await waitFor(() => expect(totals()?.textContent).toContain("460"), firstRender);
		// Recorded costs alone: an older server, or nothing to estimate.
		expect(cost().textContent).toContain("Recorded cost");
		expect(cost().textContent).toContain("$0.25 / active day");
		expect(cost().title).toBe("USD, as recorded with each call's usage");

		fetched = { ...data, totals: { ...data.totals, estimatedCost: 0.3, unpricedRequests: 2 } };
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(cost().textContent).toContain("incl. $0.30 estimated"));
		expect(cost().querySelector("dt")?.textContent).toBe("Cost");
		expect(cost().title).toBe("USD, as recorded with each call's usage, except $0.30 pika estimated from models.dev prices for calls that recorded no cost. No price is known for 2 calls that recorded no cost");
	});

	it("keeps a long chart bounded without dropping usage", () => {
		const daily = Array.from({ length: 366 }, (_, i) => ({ ...fixture().daily[0], date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10) }));
		const { buckets, size } = usageBuckets(daily, "tokens");
		expect(size).toBe(5);
		expect(buckets.length).toBeLessThanOrEqual(90);
		expect(buckets.reduce((n, bucket) => n + bucket.value, 0)).toBe(daily.reduce((n, day) => n + totalTokens(day.tokens), 0));
		expect(buckets.at(-1)?.to).toBe(daily.at(-1)?.date);
	});

	it("puts gridlines on round values and names each year once in the range", () => {
		expect(axisTicks(111_000_000)).toEqual([0, 50_000_000, 100_000_000, 150_000_000]);
		expect(axisTicks(2)).toEqual([0, 1, 2]);
		expect(axisTicks(1)).toEqual([0, 1]);
		expect(axisTicks(0.3, false)).toEqual([0, 0.1, 0.2, 0.3]);
		expect(axisTicks(0)).toEqual([0]);
		expect(formatDateRange("2026-08-06", "2026-11-03")).toBe("Aug 6 – Nov 3, 2026");
		expect(formatDateRange("2025-10-27", "2026-11-03")).toBe("Oct 27, 2025 – Nov 3, 2026");
		expect(formatDateRange("2026-11-03", "2026-11-03")).toBe("Nov 3, 2026");
	});

	it("keeps public statistics anonymous at the API boundary", async () => {
		const fetchImpl = vi.fn(async () => Response.json(fixture()));
		await new PikaApi("/nested/pika", fetchImpl).forPublic().statistics("all", true);
		expect(fetchImpl).toHaveBeenCalledWith("/nested/pika/api/public/v1/statistics?days=all&excludeUnpublished=true", expect.objectContaining({ credentials: "omit", cache: "no-store" }));
	});
});
