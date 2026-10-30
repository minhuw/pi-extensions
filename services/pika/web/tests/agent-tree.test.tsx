import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSession, SessionDetail, SessionLink, SessionTree } from "../src/lib/types";
import { LIVE_WINDOW_MS, TRACE_REFRESH_MS } from "../src/session/live";
import { entry, header, iso, summary, turn, userMessage } from "./support/fixtures";
import { mockLayout, renderApp } from "./support/render";
import { createFakeServer, treeOf, type FakeSession } from "./support/server";

/** The session page and its views load on demand, which takes longer than the default second on a busy machine. */
const LOAD_MS = 4000;

function fake(detail: SessionDetail): FakeSession {
	return { detail, entries: [entry(0, header(detail.id)), entry(1, userMessage(`Prompt for ${detail.id}`))], turns: [turn(0, 1, 1)] };
}

function listed({ children: _children, ...detail }: SessionDetail): ChildSession {
	return detail;
}

function child(id: string, parent: string, link: Partial<SessionLink>, extra: Partial<SessionDetail> = {}): SessionDetail {
	return summary(id, { parentSessionId: parent, link: { kind: "subagent", parentSessionId: parent, ...link }, ...extra });
}

// r ─┬─ a (worker) ── a1 (recon)
//    └─ h (implementer step)
function family(): FakeSession[] {
	const a1 = child("a1", "a", { agentType: "recon", description: "Look around" }, { cost: 0.25, startedAt: iso(120_000), lastAt: iso(300_000), durationMs: 180_000 });
	const a = child("a", "r", { agentType: "worker", description: "Fix tests" }, { cost: 0.5, startedAt: iso(60_000), lastAt: iso(400_000), durationMs: 340_000, childCount: 1, children: [listed(a1)] });
	const h = child(
		"h",
		"r",
		{ kind: "herder-step", herder: { runId: "run1", stepKey: "k", stepId: "s", task: "T1", role: "implementer", attempt: 1, launch: 1 } },
		{ cost: 0.1, startedAt: iso(450_000), lastAt: iso(500_000), durationMs: 50_000 },
	);
	const r = summary("r", { title: "Ship the feature", cost: 1, childCount: 2, children: [listed(a), listed(h)] });
	const solo = summary("solo", { title: "Alone" });
	return [r, a, a1, h, solo].map(fake);
}

async function tree(): Promise<HTMLElement> {
	return waitFor(() => {
		const node = document.querySelector<HTMLElement>("[data-agent-tree]");
		if (!node) throw new Error("no agent tree");
		return node;
	}, { timeout: LOAD_MS });
}

function rows(): [string, string][] {
	return [...document.querySelectorAll<HTMLElement>("[data-tree-node]")].map((row) => [row.dataset.treeNode ?? "", row.dataset.depth ?? ""]);
}

function rowOf(id: string): HTMLElement {
	const row = document.querySelector<HTMLElement>(`[data-tree-node="${id}"]`);
	if (!row) throw new Error(`no row ${id}`);
	return row;
}

function viewOptions(): string[] {
	return within(screen.getByRole("radiogroup", { name: "View" }))
		.getAllByRole("radio")
		.map((option) => option.textContent ?? "");
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
	localStorage.clear();
});
afterEach(() => {
	restore();
	vi.useRealTimers();
});

describe("the agent tree", () => {
	it("offers the Agents view only for a session with a family", async () => {
		const first = renderApp("/s/solo", createFakeServer({ sessions: family() }).fetch);
		await screen.findByRole("heading", { name: "Alone" }, { timeout: LOAD_MS });
		expect(viewOptions()).toEqual(["Trajectory", "Transcript"]);
		expect(document.querySelector("[data-open-agent-tree]")).toBeNull();
		first.unmount();
		renderApp("/s/a1", createFakeServer({ sessions: family() }).fetch);
		await screen.findByRole("heading", { name: "Session a1" }, { timeout: LOAD_MS });
		expect(viewOptions()).toEqual(["Trajectory", "Transcript", "Agents"]);
	});

	it("shows a grandchild's whole family from the root, with the current session marked", async () => {
		renderApp("/s/a1?view=agents", createFakeServer({ sessions: family() }).fetch);
		await tree();
		await waitFor(() => expect(rows()).toEqual([["r", "0"], ["a", "1"], ["a1", "2"], ["h", "1"]]));
		expect(document.querySelector("[data-session-page='agents']")).toBeTruthy();
		expect(screen.getByRole("radio", { name: "Agents" }).getAttribute("aria-checked")).toBe("true");
		const current = rowOf("a1");
		expect(current.hasAttribute("data-current")).toBe(true);
		expect(current.getAttribute("aria-current")).toBe("page");
		expect(current.getAttribute("aria-level")).toBe("3");
		expect(current.querySelector("[data-this-session]")?.textContent).toBe("this session");
		expect(document.querySelectorAll("[data-current]")).toHaveLength(1);
		expect(within(rowOf("r")).getByText("main")).toBeTruthy();
		expect(within(rowOf("r")).getByText("Ship the feature")).toBeTruthy();
		expect(within(rowOf("a")).getByText("worker")).toBeTruthy();
		expect(within(rowOf("a")).getByText("Fix tests")).toBeTruthy();
		expect(within(rowOf("h")).getByText("implementer step")).toBeTruthy();
		// A step has no description, so it reads its title rather than its task's id.
		expect(within(rowOf("h")).getByText("Session h")).toBeTruthy();
		expect(screen.getByRole("tree", { name: "Agent tree" })).toBeTruthy();
	});

	it("links each other row to its agents view and its trajectory", async () => {
		renderApp("/s/a1?view=agents", createFakeServer({ sessions: family() }).fetch);
		await waitFor(() => rowOf("a"));
		expect(within(rowOf("a")).getByRole("link", { name: "Fix tests" }).getAttribute("href")).toBe("/s/a?view=agents");
		expect(within(rowOf("a")).getByRole("link", { name: "Open the trajectory" }).getAttribute("href")).toBe("/s/a?view=trajectory");
		expect(within(rowOf("a1")).queryByRole("link", { name: "Look around" })).toBeNull();
		fireEvent.click(within(rowOf("r")).getByRole("link", { name: "Ship the feature" }));
		await screen.findByRole("heading", { name: "Ship the feature" }, { timeout: LOAD_MS });
		await waitFor(() => expect(rowOf("r").hasAttribute("data-current")).toBe(true));
		expect(rowOf("a1").hasAttribute("data-current")).toBe(false);
	});

	it("totals the family and each subtree", async () => {
		renderApp("/s/a1?view=agents", createFakeServer({ sessions: family() }).fetch);
		await waitFor(() => rowOf("h"));
		expect(document.querySelector("[data-tree-summary]")?.textContent).toBe("4 sessions · 3 levels · $1.85 · 386k tokens across the tree");
		const subtree = (id: string) => rowOf(id).querySelector("[data-tree-subtree]")?.textContent;
		expect(subtree("r")).toBe("$1.85");
		expect(subtree("a")).toBe("$0.75");
		expect(subtree("a1")).toBe("");
		expect(subtree("h")).toBe("");
		expect(within(rowOf("a")).getByText("$0.50")).toBeTruthy();
		expect(rowOf("a").querySelector("[data-tree-bar]")?.getAttribute("title")).toMatch(/ – .* · 5m 40s$/);
	});

	it("collapses and expands with the caret, showing how many sessions a closed row hides", async () => {
		renderApp("/s/a1?view=agents", createFakeServer({ sessions: family() }).fetch);
		await waitFor(() => rowOf("a1"));
		expect(rowOf("a").getAttribute("aria-expanded")).toBe("true");
		expect(rowOf("a1").hasAttribute("aria-expanded")).toBe(false);
		expect(rowOf("a").querySelector("[data-tree-hidden]")).toBeNull();
		fireEvent.click(rowOf("a").querySelector("[data-tree-toggle]")!);
		expect(rows().map(([id]) => id)).toEqual(["r", "a", "h"]);
		expect(rowOf("a").getAttribute("aria-expanded")).toBe("false");
		expect(rowOf("a").querySelector("[data-tree-hidden]")?.textContent).toBe("+1");
		fireEvent.click(rowOf("r").querySelector("[data-tree-toggle]")!);
		expect(rows().map(([id]) => id)).toEqual(["r"]);
		expect(rowOf("r").querySelector("[data-tree-hidden]")?.textContent).toBe("+3");
		fireEvent.click(rowOf("r").querySelector("[data-tree-toggle]")!);
		fireEvent.click(rowOf("a").querySelector("[data-tree-toggle]")!);
		expect(rows().map(([id]) => id)).toEqual(["r", "a", "a1", "h"]);
	});

	it("expands and collapses everything at once, and keeps the choice across views", async () => {
		renderApp("/s/a1?view=agents", createFakeServer({ sessions: family() }).fetch);
		await waitFor(() => rowOf("a1"));
		fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
		expect(rows().map(([id]) => id)).toEqual(["r"]);
		fireEvent.click(screen.getByRole("radio", { name: "Transcript" }));
		await waitFor(() => expect(document.querySelector("[data-session-page='transcript']")).toBeTruthy());
		fireEvent.click(screen.getByRole("radio", { name: "Agents" }));
		await waitFor(() => rowOf("r"));
		expect(rows().map(([id]) => id)).toEqual(["r"]);
		fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
		expect(rows().map(([id]) => id)).toEqual(["r", "a", "a1", "h"]);
	});

	it("moves, folds, and opens rows from the keyboard", async () => {
		renderApp("/s/a1?view=agents", createFakeServer({ sessions: family() }).fetch);
		await waitFor(() => rowOf("a1"));
		expect(rowOf("a1").tabIndex).toBe(0);
		expect(rowOf("a").tabIndex).toBe(-1);
		const key = (id: string, name: string) => fireEvent.keyDown(rowOf(id), { key: name });
		act(() => rowOf("a1").focus());
		key("a1", "ArrowLeft");
		expect(document.activeElement).toBe(rowOf("a"));
		key("a", "ArrowLeft");
		expect(rows().map(([id]) => id)).toEqual(["r", "a", "h"]);
		key("a", "ArrowRight");
		expect(rows().map(([id]) => id)).toEqual(["r", "a", "a1", "h"]);
		key("a", "ArrowRight");
		expect(document.activeElement).toBe(rowOf("a1"));
		key("a1", "ArrowDown");
		expect(document.activeElement).toBe(rowOf("h"));
		key("h", "ArrowDown");
		expect(document.activeElement).toBe(rowOf("h"));
		key("h", "Home");
		expect(document.activeElement).toBe(rowOf("r"));
		expect(rowOf("r").tabIndex).toBe(0);
		key("r", "End");
		expect(document.activeElement).toBe(rowOf("h"));
		key("h", "ArrowUp");
		expect(document.activeElement).toBe(rowOf("a1"));
		key("a1", "Home");
		key("r", "Enter");
		await screen.findByRole("heading", { name: "Ship the feature" }, { timeout: LOAD_MS });
		await waitFor(() => expect(rowOf("r").hasAttribute("data-current")).toBe(true));
	});

	it("drops a session's live mark once it goes idle, though its tree is unchanged", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const sessions = family();
		const a = sessions.find((session) => session.detail.id === "a")!;
		// Live for another 15 seconds: the refetch after one interval still finds it live, the next one does not.
		Object.assign(a.detail, { startedAt: new Date(Date.now() - 200_000).toISOString(), lastAt: new Date(Date.now() - LIVE_WINDOW_MS + 15_000).toISOString() });
		renderApp("/s/r?view=agents", createFakeServer({ sessions }).fetch);
		await tree();
		expect(rowOf("a").querySelector("[data-live]")).not.toBeNull();
		await act(() => vi.advanceTimersByTimeAsync(TRACE_REFRESH_MS * 2 + 1_000));
		await waitFor(() => expect(rowOf("a").querySelector("[data-live]")).toBeNull());
	});

	it("opens the Agents view from the Subagents tile", async () => {
		renderApp("/s/r", createFakeServer({ sessions: family() }).fetch);
		await screen.findByRole("heading", { name: "Ship the feature" }, { timeout: LOAD_MS });
		await waitFor(() => expect(document.querySelector("[data-session-page='trajectory']")).toBeTruthy());
		const button = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-kpi='subagents'] [data-open-agent-tree]");
			if (!node) throw new Error("no tile button");
			return node;
		});
		expect(button.textContent).toBe("2");
		expect(button.getAttribute("title")).toBe("Show the agent tree");
		expect(document.querySelector("[data-kpi='subagents'] [data-subagents]")).toBeTruthy();
		fireEvent.click(button);
		await waitFor(() => expect(document.querySelector("[data-session-page='agents']")).toBeTruthy());
		expect(screen.getByRole("radio", { name: "Agents" }).getAttribute("aria-checked")).toBe("true");
		await waitFor(() => expect(rowOf("r").hasAttribute("data-current")).toBe(true));
	});

	it("says when the server left part of the family out", async () => {
		const sessions = family();
		const partial: SessionTree = { ...treeOf(sessions, "a1"), truncated: true };
		renderApp("/s/a1?view=agents", createFakeServer({ sessions, trees: { a1: partial } }).fetch);
		const callout = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-tree-truncated]");
			if (!node) throw new Error("no callout");
			return node;
		});
		expect(callout.textContent).toMatch(/Only the first 2,000 sessions/);
		expect(rows()).toHaveLength(4);
	});

	it("explains a server without session trees", async () => {
		renderApp("/s/a1?view=agents", createFakeServer({ sessions: family(), tree: false }).fetch);
		const callout = await waitFor(() => {
			const node = document.querySelector<HTMLElement>("[data-tree-missing]");
			if (!node) throw new Error("no callout");
			return node;
		});
		expect(callout.textContent).toMatch(/This server does not serve session trees yet/);
		expect(screen.getByRole("heading", { name: "Session a1" })).toBeTruthy();
	});

	it("shows the trajectory for a session without a family", async () => {
		renderApp("/s/solo?view=agents", createFakeServer({ sessions: family() }).fetch);
		await screen.findByRole("heading", { name: "Alone" }, { timeout: LOAD_MS });
		await waitFor(() => expect(document.querySelector("[data-session-page='trajectory']")).toBeTruthy());
		expect(document.querySelector("[data-agent-tree]")).toBeNull();
		expect(screen.getByRole("radio", { name: "Trajectory" }).getAttribute("aria-checked")).toBe("true");
	});

	it("renders the public tree with titles for labels and public links", async () => {
		const source = createFakeServer({ sessions: family() });
		const calls: string[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push(url);
			if (url === "/api/health") return source.fetch(input, init);
			if (!url.startsWith("/api/public/v1/")) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
			const response = await source.fetch(url.replace("/api/public/v1/", "/api/v1/"), init);
			if (!url.endsWith("/tree")) return response;
			// The public namespace strips links and Herder runs from summaries.
			const body = (await response.json()) as SessionTree;
			const nodes = body.nodes.map(({ link: _link, herderRunId: _run, parentSessionId: _parent, ...node }) => node);
			return new Response(JSON.stringify({ ...body, nodes }), { status: 200, headers: { "Content-Type": "application/json" } });
		};
		renderApp("/public/s/a1?view=agents", fetchImpl);
		await waitFor(() => expect(rows()).toEqual([["r", "0"], ["a", "1"], ["a1", "2"], ["h", "1"]]));
		expect(within(rowOf("r")).getByText("main")).toBeTruthy();
		expect(within(rowOf("a")).getByText("subagent")).toBeTruthy();
		expect(within(rowOf("a")).getByRole("link", { name: "Session a" }).getAttribute("href")).toBe("/public/s/a?view=agents");
		expect(calls).toContain("/api/public/v1/sessions/a1/tree");
		expect(calls.some((call) => call.startsWith("/api/v1/"))).toBe(false);
	});
});
