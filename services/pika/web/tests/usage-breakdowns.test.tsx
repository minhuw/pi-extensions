import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { cacheReadShare, completionShare, UsageBreakdowns, usageGroupName } from "../src/components/UsageBreakdowns";
import type { UsageBreakdown, UsageRequestMetrics } from "../src/lib/types";

const metrics: UsageRequestMetrics = { completed: 8, failed: 1, aborted: 1, unknown: 2, ttftMs: 300, tokensPerSecond: 62.5, ttftCalls: 2, rateCalls: 2 };
function row(name: string | null, input: number, extras: Partial<UsageBreakdown> = {}): UsageBreakdown {
	return { name, kind: "project", sessions: 1, requests: 12, tokens: { input, output: 10, cacheRead: 70, cacheWrite: 10 }, cost: 0.25, metrics, ...extras };
}
const projects = [row("pika", 110), row(null, 10, { kind: "unpublished" })];
const models = [row("gpt-6-luna", 110, { kind: "model", cost: 0.1 }), row("claude-opus-5-5", 10, { kind: "model", cost: 0.4, metrics: { ...metrics, ttftMs: null, tokensPerSecond: null, ttftCalls: 0, rateCalls: 0 } })];

it("calculates cache-token share with cache writes in the prompt and excludes unknown outcomes from completion", () => {
	expect(cacheReadShare({ input: 20, cacheRead: 60, cacheWrite: 20, output: 9000 })).toBe(0.6);
	expect(cacheReadShare({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeUndefined();
	expect(completionShare(metrics)).toBe(0.8);
	expect(completionShare({ ...metrics, completed: 0, failed: 0, aborted: 0 })).toBeUndefined();
});

it("labels missing attribution without inventing model names", () => {
	expect(usageGroupName(row(null, 0))).toBe("No project");
	expect(usageGroupName(row(null, 0, { kind: "model" }))).toBe("Unknown model");
	expect(usageGroupName(row(null, 0, { kind: "other-usage" }))).toBe("Compaction & other usage");
});

it("shows projects or models as asked and expands the exact token and outcome details", () => {
	const { rerender } = render(<UsageBreakdowns projects={projects} models={models} total={300} dimension="projects" />);
	expect(screen.getByRole("heading", { name: "Breakdown by project" })).toBeTruthy();
	expect(screen.getByRole("button", { name: "Unpublished & hidden" })).toBeTruthy();
	const pika = screen.getByRole("button", { name: "pika" });
	fireEvent.click(pika);
	expect(pika.getAttribute("aria-expanded")).toBe("true");
	const detail = document.getElementById(pika.getAttribute("aria-controls")!)!;
	expect(detail.textContent).toContain("Input110");
	expect(detail.textContent).toContain("Cache write10");
	expect(detail.textContent).toContain("Outcome unknown2");
	expect(detail.textContent).toContain("TTFT timing coverage2 / 12");
	rerender(<UsageBreakdowns projects={projects} models={models} total={300} dimension="models" />);
	expect(screen.getByRole("heading", { name: "Breakdown by model" })).toBeTruthy();
	expect(screen.queryByRole("button", { name: "pika" })).toBeNull();
	expect(screen.getByRole("button", { name: "gpt-6-luna" })).toBeTruthy();
	const claude = document.querySelector('[data-usage-group="claude-opus-5-5"]')!;
	expect(claude.textContent).toContain("—");
});

it("filters locally and sorts by column header with unavailable timing last in both directions", () => {
	render(<UsageBreakdowns projects={projects} models={models} total={300} dimension="models" />);
	const groups = () => [...document.querySelectorAll("[data-usage-group]")].map(el => el.getAttribute("data-usage-group"));
	const order = (name: string) => screen.getByRole("columnheader", { name }).getAttribute("aria-sort");
	expect(order("Tokens")).toBe("descending");
	fireEvent.click(screen.getByRole("button", { name: "Cost" }));
	expect(groups()).toEqual(["claude-opus-5-5", "gpt-6-luna"]);
	expect(order("Cost")).toBe("descending");
	expect(order("Tokens")).toBeNull();
	// Latency sorts fastest first; a second click reverses it, and missing timing stays last either way.
	fireEvent.click(screen.getByRole("button", { name: "Avg TTFT" }));
	expect(groups()).toEqual(["gpt-6-luna", "claude-opus-5-5"]);
	expect(order("Avg TTFT")).toBe("ascending");
	fireEvent.click(screen.getByRole("button", { name: "Avg TTFT" }));
	expect(groups()).toEqual(["gpt-6-luna", "claude-opus-5-5"]);
	expect(order("Avg TTFT")).toBe("descending");
	fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), { target: { value: "CLAUDE" } });
	expect(groups()).toEqual(["claude-opus-5-5"]);
	fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), { target: { value: "absent" } });
	expect(screen.getByText("No models match this search.")).toBeTruthy();
});

it("paginates long breakdowns and distinguishes other usage from model requests", () => {
	const long = Array.from({ length: 23 }, (_, i) => row(`p${i}`, 100 - i));
	const other = [row(null, 0, { kind: "other-usage", requests: 0 })];
	const { rerender } = render(<UsageBreakdowns projects={long} models={other} total={1000} dimension="projects" />);
	expect(document.querySelectorAll("[data-usage-group]")).toHaveLength(10);
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	fireEvent.click(screen.getByRole("button", { name: "Next" }));
	expect(document.querySelectorAll("[data-usage-group]")).toHaveLength(3);
	rerender(<UsageBreakdowns projects={long} models={other} total={1000} dimension="models" />);
	fireEvent.click(screen.getByRole("button", { name: "Compaction & other usage" }));
	expect(screen.getByText(/without adding model requests/)).toBeTruthy();
	expect(within(screen.getByRole("table")).getByText("Compaction & other usage")).toBeTruthy();
});

it("marks each row with its chart layer when the chart is split the same way", () => {
	const fills: Record<string, string> = { pika: "black", "\u0000": "red" };
	render(<UsageBreakdowns projects={projects} models={models} total={300} dimension="projects" swatch={(r) => fills[r.name ?? "\u0000"]} />);
	const swatch = (name: string) => (document.querySelector(`[data-usage-group="${name}"] [data-usage-swatch]`) as HTMLElement | null)?.style.background;
	expect(swatch("pika")).toBe("black");
	expect(swatch("Unpublished & hidden")).toBe("red");
});
