import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLink, SessionTree } from "../src/lib/types";
import { iso, summary } from "./support/fixtures";
import { mockLayout, renderApp, scrollMain } from "./support/render";
import { createFakeServer, type FakeSession } from "./support/server";

/** The session page and its views load on demand, which takes longer than the default second on a busy machine. */
const LOAD_MS = 4000;

function session(id: string, extra: Parameters<typeof summary>[1] = {}): FakeSession {
	return { detail: summary(id, extra), turns: [], entries: [] };
}

function child(id: string, parent: string, link: Partial<SessionLink>, extra: Parameters<typeof summary>[1] = {}): FakeSession {
	return session(id, { parentSessionId: parent, link: { kind: "subagent", parentSessionId: parent, ...link }, ...extra });
}

async function family(id: string): Promise<HTMLElement> {
	return waitFor(() => {
		const node = document.querySelector<HTMLElement>(`[data-family="${id}"]`);
		if (!node) throw new Error(`no family under ${id}`);
		return node;
	}, { timeout: LOAD_MS });
}

function familyRows(root: ParentNode = document): [string, string][] {
	return [...root.querySelectorAll<HTMLElement>("[data-family-node]")].map((row) => [row.dataset.familyNode ?? "", row.dataset.depth ?? ""]);
}

function familyRow(id: string): HTMLElement {
	const row = document.querySelector<HTMLElement>(`[data-family-node="${id}"]`);
	if (!row) throw new Error(`no family row ${id}`);
	return row;
}

const sessions = [
	session("a", { title: "Refactor auth", device: "mini", project: "api", childCount: 2, models: ["claude-sonnet-4-5", "gpt-5"] }),
	session("b", { title: "Write the docs", device: "laptop", project: "docs", cost: 0.004 }),
	session("c", { title: "Recon subagent", device: "mini", project: "api", parentSessionId: "a", link: { kind: "subagent" } }),
];

const STUDIO_ID = "4f1c2b9e-0d7a-4c3e-9b8f-2a6d5e1c0b7a";
const OTHER_ID = "0a9b8c7d-1111-4222-8333-444455556666";

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 2000, rowHeight: 72 });
});
afterEach(() => {
	restore();
	vi.useRealTimers();
});

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
		expect(within(row).getByTitle("Child sessions").textContent).toBe("2 subagents");
		// 80,000 of the 93,000 prompt tokens came from the cache.
		expect(within(row).getByText("86% cached")).toBeTruthy();
		expect(within(row).getByText("96.4k tokens").parentElement!.getAttribute("title")).toBe("80,000 cache read · 1,000 cache write · 12,000 input · 3,400 output");
		expect(screen.getByText("Write the docs")).toBeTruthy();
		expect(screen.queryByText("Recon subagent")).toBeNull();
		expect(server.calls).toContain("/api/v1/sessions?root=true&limit=50");
	});

	it("nests each session's subagents and steps under it as a tree when asked", async () => {
		const server = createFakeServer({
			sessions: [
				session("a", { title: "Refactor auth", childCount: 2 }),
				child("c", "a", { agentType: "recon", description: "Map the auth code" }, { childCount: 1, startedAt: iso(10_000) }),
				child("g", "c", { agentType: "expert", description: "Judge the token format" }, { startedAt: iso(20_000), device: "laptop" }),
				child(
					"h",
					"a",
					{ kind: "herder-step", herder: { runId: "r1", stepKey: "k", stepId: "k", task: "T1", role: "implementer", attempt: 1, launch: 1 } },
					{ startedAt: iso(30_000) },
				),
				session("b", { title: "Write the docs" }),
			],
		});
		renderApp("/", server.fetch);
		await screen.findByText("Refactor auth");
		expect(document.querySelector("[data-family]")).toBeNull();
		fireEvent.click(screen.getByLabelText("Show subagents and steps"));
		const tree = await family("a");
		expect(familyRows(tree)).toEqual([
			["c", "1"],
			["g", "2"],
			["h", "1"],
		]);
		const recon = familyRow("c");
		expect(within(recon).getByText("recon")).toBeTruthy();
		expect(within(recon).getByText("Map the auth code")).toBeTruthy();
		expect(recon.querySelector("a")!.getAttribute("href")).toBe("/s/c");
		// The same card as a main session's, without repeating where its parent ran.
		for (const text of ["10m", "96.4k tokens", "$0.31", "claude-sonnet-4-5"]) expect(within(recon).getByText(text)).toBeTruthy();
		expect(within(recon).queryByText("mini")).toBeNull();
		expect(within(recon).queryByText("pika")).toBeNull();
		expect(within(familyRow("g")).getByText("laptop")).toBeTruthy();
		expect(within(recon).getByTitle("Child sessions").textContent).toBe("1 subagent");
		// Each card with sessions below it totals them: c and g, and the whole family under a.
		expect(within(recon).getByText("Σ $0.62 · 2 sessions")).toBeTruthy();
		expect(within(screen.getByText("Refactor auth").closest("a")!).getByText("Σ $1.24 · 4 sessions")).toBeTruthy();
		expect(within(familyRow("g")).queryByText(/^Σ/)).toBeNull();
		expect(within(familyRow("g")).getByText("expert")).toBeTruthy();
		// A step has no description, so its card reads its title.
		expect(within(familyRow("h")).getByText("implementer step")).toBeTruthy();
		expect(within(familyRow("h")).getByText("Session h")).toBeTruthy();
		expect(within(familyRow("h")).getByTitle("Herder task").textContent).toBe("T1");
		// The lines, as tree draws them: c ├, its child g │ ╰, and h ╰; open cards run a line down from their caret.
		const shape = (id: string) => [...familyRow(id).querySelectorAll<HTMLElement>("[data-tree-level]")].map((level) => level.dataset.treeLevel);
		expect([shape("c"), shape("g"), shape("h")]).toEqual([["tee"], ["trunk", "end"], ["end"]]);
		expect(familyRow("c").querySelector("[data-tree-stub]")).toBeTruthy();
		expect(familyRow("h").querySelector("[data-tree-stub]")).toBeNull();
		// The main session's card comes right before its family's list.
		expect(tree.previousElementSibling!.querySelector("[data-tree-stub]")).toBeTruthy();
		// The main session's card is tagged too, and its caret folds the whole family.
		expect(within(screen.getByText("Refactor auth").closest("a")!).getByText("main")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Collapse Refactor auth" }));
		expect(document.querySelector('[data-family="a"]')).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Expand Refactor auth" }));
		expect(familyRows(await family("a"))).toHaveLength(3);
		// Children never become rows of their own: the list still asks only for root sessions.
		expect(document.querySelector('[data-session-row="c"]')).toBeNull();
		// A divider sets each session after the first apart from the one above.
		expect(screen.getByText("Write the docs").closest("[data-family-divider]")).toBeTruthy();
		expect(screen.getByText("Refactor auth").closest("[data-family-divider]")).toBeNull();
		expect(server.calls).toContain("/api/v1/sessions/a/tree");
		expect(server.calls).not.toContain("/api/v1/sessions?limit=50");
		expect(server.calls.some((call) => call.includes("sessions/b/tree"))).toBe(false);
		expect(document.querySelector('[data-family="b"]')).toBeNull();
	});

	it("lists a subagent whose parent is not recorded at the top, tagged, with its own family", async () => {
		const server = createFakeServer({
			sessions: [
				session("m1", { title: "Refactor auth", lastAt: iso(900_000) }),
				child("lost", "never-uploaded", { agentType: "worker", description: "Port the parser" }, { title: "Port the CSV parser to SIMD", childCount: 1 }),
				child("lost-r", "lost", { agentType: "recon", description: "Find the hot loops" }),
			],
		});
		renderApp("/", server.fetch);
		// Its card reads its description, with the whole first prompt as the tooltip.
		const card = () => screen.getByText("Port the parser").closest<HTMLElement>("[data-session-row]")!;
		await screen.findByText("Port the parser");
		const lost = card();
		expect(lost.dataset.sessionRow).toBe("lost");
		expect(lost.getAttribute("title")).toBe("Port the CSV parser to SIMD");
		// Without the tree, only the orphan says what it is.
		expect(within(lost).getByText("worker")).toBeTruthy();
		expect(within(lost).getByText("parent not recorded")).toBeTruthy();
		const main = screen.getByText("Refactor auth").closest<HTMLElement>("[data-session-row]")!;
		expect(within(main).queryByText("main")).toBeNull();
		expect(main.querySelector("[data-parent-missing]")).toBeNull();
		expect(document.querySelector('[data-session-row="lost-r"]')).toBeNull();

		fireEvent.click(screen.getByLabelText("Show subagents and steps"));
		expect(familyRows(await family("lost"))).toEqual([["lost-r", "1"]]);
		// With the tree, every level says what it is.
		expect(within(screen.getByText("Refactor auth").closest("a")!).getByText("main")).toBeTruthy();
		expect(within(card()).getByText("worker")).toBeTruthy();
		expect(within(card()).getByText("parent not recorded")).toBeTruthy();
		expect(within(familyRow("lost-r")).getByText("recon")).toBeTruthy();
	});

	it("opens a large family one level deep, and the rest on demand", async () => {
		const workers = [0, 1, 2].map((w) => child(`w${w}`, "big", { agentType: "worker", description: `Batch ${w}` }, { childCount: 5, startedAt: iso(w * 60_000) }));
		const recons = [0, 1, 2].flatMap((w) =>
			[0, 1, 2, 3, 4].map((r) => child(`w${w}r${r}`, `w${w}`, { agentType: "recon", description: `Reproduce ${w}.${r}` }, { startedAt: iso(w * 60_000 + r * 1000 + 1) })),
		);
		const server = createFakeServer({ sessions: [session("big", { title: "Triage", childCount: 3 }), ...workers, ...recons] });
		renderApp("/?children=1", server.fetch);
		const tree = await family("big");
		// 19 sessions are more than open at once.
		expect(familyRows(tree)).toEqual([
			["w0", "1"],
			["w1", "1"],
			["w2", "1"],
		]);
		expect(within(familyRow("w1")).getByTitle("Child sessions").textContent).toBe("5 subagents");
		expect(screen.getByRole("button", { name: "Expand Batch 1" }).getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(screen.getByRole("button", { name: "Expand Batch 1" }));
		expect(familyRows(tree).map(([id]) => id)).toEqual(["w0", "w1", "w1r0", "w1r1", "w1r2", "w1r3", "w1r4", "w2"]);
		expect(screen.getByRole("button", { name: "Collapse Batch 1" }).getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(screen.getByRole("button", { name: "Collapse Batch 1" }));
		expect(familyRows(tree)).toHaveLength(3);
	});

	it("lists a long family's first rows, then the rest when asked", async () => {
		const kids = Array.from({ length: 15 }, (_, i) => child(`k${String(i).padStart(2, "0")}`, "long", { agentType: "reviewer", description: `Audit module ${i}` }, { startedAt: iso(i * 1000) }));
		const server = createFakeServer({ sessions: [session("long", { title: "Audit", childCount: 15 }), ...kids] });
		renderApp("/?children=1", server.fetch);
		const tree = await family("long");
		expect(familyRows(tree)).toHaveLength(12);
		expect(within(tree).getByRole("link", { name: "Open the agent tree" }).getAttribute("href")).toBe("/s/long?view=agents");
		fireEvent.click(within(tree).getByRole("button", { name: "Show 3 more" }));
		expect(familyRows(tree)).toHaveLength(15);
		expect(tree.querySelector("[data-family-more]")).toBeNull();
	});

	it("says so when the server cannot list a family", async () => {
		const server = createFakeServer({ sessions, tree: false });
		renderApp("/?children=1", server.fetch);
		await screen.findByText("Refactor auth");
		expect((await screen.findByText(/does not list subagents by family yet/)).closest("[data-family-missing]")).toBeTruthy();
		expect(document.querySelector("[data-family-node]")).toBeNull();
	});

	it("offers to try again when a family fails to load", async () => {
		const server = createFakeServer({ sessions });
		let failures = 1;
		const fetchImpl: typeof fetch = async (input, init) => {
			if (String(input).endsWith("/tree") && failures-- > 0) return new Response(JSON.stringify({ error: "internal" }), { status: 500 });
			return server.fetch(input, init);
		};
		renderApp("/?children=1", fetchImpl);
		expect(await screen.findByText("The subagents could not be loaded.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(familyRows(await family("a"))).toEqual([["c", "1"]]);
	});

	it("keeps a family's opened rows and full listing after it scrolls away and back", async () => {
		const workers = [0, 1, 2].map((w) => child(`w${w}`, "top", { agentType: "worker", description: `Batch ${w}` }, { childCount: 5, startedAt: iso(w * 60_000) }));
		const recons = [0, 1, 2].flatMap((w) =>
			[0, 1, 2, 3, 4].map((r) => child(`w${w}r${r}`, `w${w}`, { agentType: "recon", description: `Reproduce ${w}.${r}` }, { startedAt: iso(w * 60_000 + r * 1000 + 1) })),
		);
		const older = Array.from({ length: 60 }, (_, i) => session(`old${i}`, { title: `Older session ${i}`, lastAt: iso(300_000) }));
		const server = createFakeServer({ sessions: [session("top", { title: "Triage", childCount: 3, lastAt: iso(900_000) }), ...workers, ...recons, ...older] });
		renderApp("/?children=1", server.fetch);
		await family("top");
		fireEvent.click(screen.getByRole("button", { name: "Expand Batch 1" }));
		expect(familyRows()).toHaveLength(8);
		scrollMain(60 * 72);
		await waitFor(() => expect(document.querySelector('[data-family="top"]')).toBeNull());
		scrollMain(0);
		const tree = await family("top");
		expect(familyRows(tree).map(([id]) => id)).toEqual(["w0", "w1", "w1r0", "w1r1", "w1r2", "w1r3", "w1r4", "w2"]);
	});

	it("keeps a live family open as it grows past the size that opens fully", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const recent = new Date(Date.now() - 30_000).toISOString();
		// 12 sessions, so all of it opens; the worker is live.
		const growing: FakeSession[] = [
			session("grow", { title: "Growing", childCount: 8 }),
			child("w", "grow", { agentType: "worker", description: "Lead worker" }, { childCount: 3, startedAt: iso(1000), lastAt: recent }),
			...[0, 1, 2].map((i) => child(`wr${i}`, "w", { agentType: "recon", description: `Look ${i}` }, { startedAt: iso(2000 + i) })),
			...Array.from({ length: 7 }, (_, i) => child(`k${i}`, "grow", { agentType: "reviewer", description: `Check ${i}` }, { startedAt: iso(10_000 + i) })),
		];
		renderApp("/?children=1", createFakeServer({ sessions: growing }).fetch);
		await family("grow");
		expect(familyRows().map(([id]) => id)).toContain("wr0");
		growing.push(child("k7", "grow", { agentType: "reviewer", description: "Check 7" }, { startedAt: iso(20_000) }));
		await act(() => vi.advanceTimersByTimeAsync(31_000));
		await waitFor(() => expect(familyRows().map(([id]) => id)).toContain("k7"));
		expect(familyRows().map(([id]) => id)).toContain("wr0");
	});

	it("nests published subagents in the public list", async () => {
		const source = createFakeServer({ sessions });
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url === "/api/health") return source.fetch(input, init);
			if (!url.startsWith("/api/public/v1/")) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
			const response = await source.fetch(url.replace("/api/public/v1/", "/api/v1/"), init);
			if (!url.endsWith("/tree")) return response;
			// The public namespace strips links from summaries.
			const body = (await response.json()) as SessionTree;
			const nodes = body.nodes.map(({ link: _link, herderRunId: _run, ...node }) => node);
			return new Response(JSON.stringify({ ...body, nodes }), { status: 200, headers: { "Content-Type": "application/json" } });
		};
		renderApp("/public?children=1", fetchImpl);
		const tree = await family("a");
		expect(familyRows(tree)).toEqual([["c", "1"]]);
		expect(within(familyRow("c")).getByText("subagent")).toBeTruthy();
		expect(within(familyRow("c")).getByText("Recon subagent")).toBeTruthy();
		expect(familyRow("c").querySelector("a")!.getAttribute("href")).toBe("/public/s/c");
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

	it("shows device names, and ids for sessions from servers that send no name", async () => {
		const server = createFakeServer({
			sessions: [
				session("a", { title: "Named", device: STUDIO_ID, deviceName: "Studio Mac" }),
				session("b", { title: "Unnamed", device: "mini", deviceName: undefined }),
			],
		});
		renderApp("/", server.fetch);
		const named = (await screen.findByText("Named")).closest("a")!;
		expect(within(named).getByText("Studio Mac").dataset.deviceLabel).toBe(STUDIO_ID);
		expect(within(named).queryByText(STUDIO_ID)).toBeNull();
		const unnamed = screen.getByText("Unnamed").closest("a")!;
		expect(within(unnamed).getByText("mini")).toBeTruthy();
	});

	it("labels device filters by name, filters by id, and tells devices with the same name apart", async () => {
		const server = createFakeServer({
			sessions: [
				session("a", { title: "On the first MacBook", device: STUDIO_ID, deviceName: "MacBook" }),
				session("b", { title: "On the second MacBook", device: OTHER_ID, deviceName: "MacBook" }),
				session("c", { title: "On the mini", device: "mini", deviceName: "mini" }),
			],
		});
		renderApp("/", server.fetch);
		await screen.findByText("On the mini");
		fireEvent.click(screen.getByRole("button", { name: /^Device/ }));
		const options = (await screen.findAllByRole("menuitemradio")).map((option) => option.textContent);
		expect(options).toEqual(["✓Any device", `MacBook (${OTHER_ID.slice(0, 8)})`, `MacBook (${STUDIO_ID.slice(0, 8)})`, "mini"]);
		fireEvent.click(screen.getByRole("menuitemradio", { name: `MacBook (${STUDIO_ID.slice(0, 8)})` }));
		expect(await screen.findByRole("button", { name: `Device: MacBook (${STUDIO_ID.slice(0, 8)})` })).toBeTruthy();
		await waitFor(() => expect(screen.queryByText("On the mini")).toBeNull());
		expect(screen.getByText("On the first MacBook")).toBeTruthy();
		expect(screen.queryByText("On the second MacBook")).toBeNull();
		expect(server.calls).toContain(`/api/v1/sessions?device=${STUDIO_ID}&root=true&limit=50`);

		// The list's Browse index lists the same labels and links by id.
		const browse = screen.getByRole("navigation", { name: "Browse" });
		const link = within(browse).getByRole("link", { name: `MacBook (${OTHER_ID.slice(0, 8)})` });
		expect(link.getAttribute("href")).toBe(`/?device=${OTHER_ID}`);
		expect(within(browse).getByRole("link", { name: "mini" }).getAttribute("href")).toBe("/?device=mini");
	});

	it("shows a device filter's id until the facets name it", async () => {
		renderApp("/?device=gone-device", createFakeServer({ sessions }).fetch);
		expect(await screen.findByRole("button", { name: "Device: gone-device" })).toBeTruthy();
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
