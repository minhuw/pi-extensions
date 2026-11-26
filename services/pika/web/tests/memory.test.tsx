import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDateTime, formatRelative } from "../src/lib/format";
import type { MemoryBatch, MemoryNote, MemoryRevision, MemoryScope, MemoryScopeSummary } from "../src/lib/types";
import { renderApp } from "./support/render";
import { createFakeServer, type FakeMemory } from "./support/server";

const USER: MemoryScope = { key: "user", kind: "user", label: "user" };
const PIKA: MemoryScope = { key: "repo:https://github.com/acme/pika", kind: "project", label: "pika" };
const EMPTY: MemoryScope = { key: "local:scratch@00000000-0000-4000-8000-000000000001", kind: "project", label: "scratch" };

function at(minutes: number): string {
	return new Date(Date.parse("2026-11-01T09:00:00.000Z") + minutes * 60_000).toISOString();
}

function summary(scope: MemoryScope, noteCount: number, updatedAt: string | null): MemoryScopeSummary {
	return { ...scope, noteCount, updatedAt };
}

function note(id: string, scope: MemoryScope, fields: Partial<MemoryNote> = {}): MemoryNote {
	return {
		id,
		scope,
		category: "feedback",
		title: `Note ${id}`,
		hook: `Hook ${id}`,
		body: "",
		provenance: "agent",
		sources: [],
		revision: 1,
		createdAt: at(0),
		updatedAt: at(0),
		deletedAt: null,
		deviceId: "00000000-0000-4000-8000-000000000001",
		sessionId: null,
		...fields,
	};
}

function revision(fields: Partial<MemoryRevision> & Pick<MemoryRevision, "revision" | "action">): MemoryRevision {
	return {
		provenance: "agent",
		sources: [],
		batchId: null,
		category: "project",
		title: "Title",
		hook: "Hook",
		body: "",
		at: at(fields.revision),
		deviceId: null,
		sessionId: null,
		reason: null,
		...fields,
	};
}

function memory(): FakeMemory {
	return {
		scopes: [summary(USER, 1, at(30)), summary(PIKA, 2, at(60)), summary(EMPTY, 0, at(90))],
		notes: [
			note("aaaaaaaaaaa1", USER, { title: "Prefers short answers", hook: "Keep replies to a paragraph", body: "Unless asked for detail." }),
			note("bbbbbbbbbbb1", PIKA, {
				category: "project",
				title: "Tests run offline",
				hook: "Never hit live providers in tests",
				body: "Use the fake server.\n  Indented line <b>not bold</b>",
				revision: 3,
				updatedAt: at(60),
				sessionId: "sess-42",
			}),
			note("bbbbbbbbbbb2", PIKA, { category: "reference", title: "Spec lives in docs", hook: "services/pika/docs/SPEC.md" }),
			note("ccccccccccc1", PIKA, { title: "Old forgotten note", hook: "Gone", revision: 2, deletedAt: at(20) }),
		],
		revisions: {
			bbbbbbbbbbb1: [
				revision({ revision: 1, action: "save", title: "Tests are offline", hook: "First hook", body: "First body" }),
				revision({ revision: 2, action: "forget", title: "Tests are offline", hook: "First hook", body: "First body", reason: "Superseded by a clearer note" }),
				revision({ revision: 3, action: "save", title: "Tests run offline", hook: "Never hit live providers in tests", body: "Use the fake server.", sessionId: "sess-42" }),
			],
		},
	};
}

/** The page's own region, without the band's search field and controls. */
async function page(): Promise<HTMLElement> {
	await screen.findByRole("heading", { name: "Memory", level: 1 });
	return document.querySelector<HTMLElement>("[data-memory-page]")!;
}

describe("Memory page", () => {
	it("is linked from the owner's band", async () => {
		renderApp("/", createFakeServer({ memory: memory() }).fetch);
		const nav = await screen.findByRole("navigation", { name: "Main" });
		fireEvent.click(within(nav).getByRole("link", { name: "Memory" }));
		expect(await screen.findByRole("heading", { name: "Memory", level: 1 })).toBeTruthy();
		expect(within(nav).getByRole("link", { name: "Memory" }).getAttribute("aria-current")).toBe("page");
	});

	it("lists scopes, user first, with their kinds, note counts, and update times", async () => {
		renderApp("/memory", createFakeServer({ memory: memory() }).fetch);
		const scopes = await screen.findByRole("navigation", { name: "Memory scopes" });
		const rows = await waitFor(() => {
			const found = [...scopes.querySelectorAll<HTMLElement>("[data-memory-scope]")];
			expect(found).toHaveLength(3);
			return found;
		});
		expect(rows.map((row) => row.getAttribute("data-memory-scope"))).toEqual([USER.key, PIKA.key, EMPTY.key]);
		// The user scope's label and its kind.
		expect(within(rows[0]).getAllByText("user")).toHaveLength(2);
		expect(within(rows[0]).getByText("1 note")).toBeTruthy();
		expect(within(rows[1]).getByText("pika")).toBeTruthy();
		expect(within(rows[1]).getByText("project")).toBeTruthy();
		expect(within(rows[1]).getByText("2 notes")).toBeTruthy();
		expect(within(rows[2]).getByText("0 notes")).toBeTruthy();
		// The update time reads relatively, with the exact time on hover.
		const updated = within(rows[1]).getByTitle(formatDateTime(at(60)));
		expect(updated.textContent).toBe(formatRelative(at(60)));
		// The user scope is selected until another is chosen.
		expect(rows[0].getAttribute("aria-current")).toBe("true");
		const notes = await screen.findByRole("region", { name: "user" });
		expect(within(notes).getByRole("heading", { name: "Prefers short answers" })).toBeTruthy();
	});

	it("shows the selected scope's live notes, addressable by the URL", async () => {
		const server = createFakeServer({ memory: memory() });
		renderApp("/memory", server.fetch);
		const scopes = await screen.findByRole("navigation", { name: "Memory scopes" });
		const pika = await within(scopes).findByText("pika");
		const link = pika.closest<HTMLAnchorElement>("a")!;
		expect(link.getAttribute("href")).toBe(`/memory?${new URLSearchParams({ scope: PIKA.key })}`);
		fireEvent.click(link);

		const region = await screen.findByRole("region", { name: "pika" });
		const article = (await within(region).findByRole("heading", { name: "Tests run offline" })).closest<HTMLElement>("article")!;
		expect(within(article).getByText("project")).toBeTruthy();
		expect(within(article).getByText("Never hit live providers in tests")).toBeTruthy();
		expect(within(article).getByText("Revision 3")).toBeTruthy();
		expect(within(article).getByText(/^Updated/).textContent).toBe(`Updated ${formatRelative(at(60))}`);
		expect(within(article).getByTitle(formatDateTime(at(60)))).toBeTruthy();
		expect(within(article).getByRole("link", { name: "Session →" }).getAttribute("href")).toBe("/s/sess-42");
		// The body is plain text with its whitespace kept: markup in it stays text.
		const body = within(article).getByText(/Use the fake server\./);
		expect(body.textContent).toBe("Use the fake server.\n  Indented line <b>not bold</b>");
		expect(body.className).toContain("whitespace-pre-wrap");
		expect(article.querySelector("b")).toBeNull();

		const second = within(region).getByRole("heading", { name: "Spec lives in docs" }).closest<HTMLElement>("article")!;
		expect(within(second).getByText("reference")).toBeTruthy();
		expect(within(second).getByText("No body")).toBeTruthy();
		// Forgotten notes are not listed.
		expect(within(region).queryByText("Old forgotten note")).toBeNull();
		expect(server.calls).toContain(`/api/v1/memory/notes?${new URLSearchParams({ scope: PIKA.key })}`);
	});

	it("opens a note's revision history, oldest first, including forgets", async () => {
		const server = createFakeServer({ memory: memory() });
		renderApp(`/memory?${new URLSearchParams({ scope: PIKA.key })}`, server.fetch);
		const article = (await screen.findByRole("heading", { name: "Tests run offline" })).closest<HTMLElement>("article")!;
		// Loaded on demand only.
		expect(server.calls.some((call) => call.includes("/revisions"))).toBe(false);
		fireEvent.click(within(article).getByRole("button", { name: "History" }));
		const list = await within(article).findByRole("list", { name: "Revisions" });
		const items = await waitFor(() => {
			const found = within(list).getAllByRole("listitem");
			expect(found).toHaveLength(3);
			return found;
		});
		expect(items.map((item) => [item.getAttribute("data-revision"), item.getAttribute("data-action")])).toEqual([
			["1", "save"],
			["2", "forget"],
			["3", "save"],
		]);
		expect(within(items[0]).getByText("Revision 1")).toBeTruthy();
		expect(within(items[0]).getByText("Tests are offline")).toBeTruthy();
		expect(within(items[0]).getByText("First hook")).toBeTruthy();
		expect(within(items[0]).getByText("First body")).toBeTruthy();
		expect(within(items[1]).getByText("forget")).toBeTruthy();
		expect(within(items[1]).getByText("Reason: Superseded by a clearer note")).toBeTruthy();
		expect(within(items[2]).getByText("Use the fake server.")).toBeTruthy();
		expect(within(items[2]).getByRole("link", { name: "Session →" }).getAttribute("href")).toBe("/s/sess-42");
		expect(server.calls).toContain("/api/v1/memory/notes/bbbbbbbbbbb1/revisions");
	});

	it("says when there are no scopes", async () => {
		renderApp("/memory", createFakeServer({}).fetch);
		const region = await page();
		const empty = (await within(region).findByText("No memory yet")).closest<HTMLElement>("[data-state=empty]")!;
		expect(empty).toBeTruthy();
		expect(within(region).queryByRole("navigation", { name: "Memory scopes" })).toBeNull();
	});

	it("says when a scope has no notes, and when a scope is unknown", async () => {
		const server = createFakeServer({ memory: memory() });
		const first = renderApp(`/memory?${new URLSearchParams({ scope: EMPTY.key })}`, server.fetch);
		const region = await screen.findByRole("region", { name: "scratch" });
		expect((await within(region).findByText("No notes")).closest("[data-state=empty]")).toBeTruthy();
		first.unmount();

		renderApp("/memory?scope=repo:https://example.com/gone", server.fetch);
		expect(await screen.findByText("No such scope")).toBeTruthy();
	});

	it("offers no control to create, edit, save, forget, or delete notes", async () => {
		const server = createFakeServer({ memory: memory() });
		renderApp(`/memory?${new URLSearchParams({ scope: PIKA.key })}`, server.fetch);
		const region = await page();
		const article = (await screen.findByRole("heading", { name: "Tests run offline" })).closest<HTMLElement>("article")!;
		fireEvent.click(within(article).getByRole("button", { name: "History" }));
		await within(article).findByRole("list", { name: "Revisions" });

		expect(region.querySelectorAll("input, textarea, select, form, [contenteditable]")).toHaveLength(0);
		const buttons = within(region).getAllByRole("button");
		// Only the history toggles.
		expect(buttons.map((button) => button.textContent?.replace(/[▸▾]/g, "").trim())).toEqual(["History", "History"]);
		for (const name of [/create/i, /new/i, /add/i, /edit/i, /save/i, /forget/i, /delete/i, /remove/i]) {
			expect(within(region).queryByRole("button", { name })).toBeNull();
		}
		// Nothing was written.
		expect(server.mutations).toEqual([]);
	});

	it("is not part of the public view", async () => {
		const server = createFakeServer({ memory: memory() });
		const visitor = renderApp("/public", server.fetch);
		const nav = await screen.findByRole("navigation", { name: "Public" });
		expect(within(nav).queryByRole("link", { name: "Memory" })).toBeNull();
		expect(screen.queryByRole("link", { name: "Memory" })).toBeNull();
		visitor.unmount();

		renderApp("/public/memory", server.fetch);
		expect(await screen.findByRole("heading", { name: "This page doesn’t exist", level: 1 })).toBeTruthy();
		expect(server.calls.some((call) => call.includes("memory"))).toBe(false);
	});

	it("needs the owner's sign-in", async () => {
		const server = createFakeServer({ password: "hunter2", memory: memory() });
		renderApp("/memory", server.fetch);
		expect(await screen.findByLabelText(/password/i)).toBeTruthy();
		expect(server.calls.some((call) => call.includes("/memory"))).toBe(false);
	});

	it("renders per-scope pinned budgets and tier counts, degrading cleanly when absent", async () => {
		const OVER: MemoryScope = { key: "repo:https://github.com/acme/over", kind: "project", label: "over" };
		const budgeted: FakeMemory = {
			scopes: [
				{
					...USER,
					noteCount: 17,
					updatedAt: at(30),
					pinnedCount: 12,
					archivalCount: 5,
					indexBytes: 4120,
					indexLines: 95,
					limitBytes: 8192,
					limitLines: 200,
				},
				{
					...PIKA,
					noteCount: 3,
					updatedAt: at(60),
					pinnedCount: 3,
					archivalCount: 0,
					indexBytes: 6800,
					indexLines: 140,
				},
				{
					...OVER,
					noteCount: 4,
					updatedAt: at(70),
					pinnedCount: 4,
					archivalCount: 0,
					indexBytes: 9000,
					indexLines: 210,
					limitBytes: 8192,
					limitLines: 200,
				},
				summary(EMPTY, 1, at(90)),
			],
			notes: [
				note("u1", USER, { title: "User pinned", tier: "pinned" }),
				note("p1", PIKA, { title: "Pika pinned" }),
				note("o1", OVER, { title: "Over pinned" }),
				note("e1", EMPTY, { title: "Legacy note" }),
			],
			revisions: {},
		};
		renderApp("/memory", createFakeServer({ memory: budgeted }).fetch);
		const scopes = await screen.findByRole("navigation", { name: "Memory scopes" });
		const rows = await waitFor(() => {
			const found = [...scopes.querySelectorAll<HTMLElement>("[data-memory-scope]")];
			expect(found).toHaveLength(4);
			return found;
		});

		// Scope with archival notes and healthy budget (<80%).
		expect(within(rows[0]).getByText("12 pinned · 5 archival")).toBeTruthy();
		const userRowBudget = rows[0].querySelector<HTMLElement>("[data-scope-budget]")!;
		expect(userRowBudget.getAttribute("data-budget-state")).toBe("ok");
		expect(within(userRowBudget).getByText("4,120 / 8,192 B")).toBeTruthy();

		const userRegion = await screen.findByRole("region", { name: "user" });
		const userHeaderBudget = userRegion.querySelector<HTMLElement>("[data-scope-budget-header]")!;
		expect(userHeaderBudget.getAttribute("data-budget-state")).toBe("ok");
		expect(within(userHeaderBudget).getByText("4,120 / 8,192 B · 95 / 200 lines")).toBeTruthy();

		// Scope with default limits and >=80% usage -> warn state; 0 archival stays "3 notes".
		expect(within(rows[1]).getByText("3 notes")).toBeTruthy();
		const pikaRowBudget = rows[1].querySelector<HTMLElement>("[data-scope-budget]")!;
		expect(pikaRowBudget.getAttribute("data-budget-state")).toBe("warn");
		expect(within(pikaRowBudget).getByText("6,800 / 8,192 B")).toBeTruthy();

		// Scope over 100% -> over state.
		const overRowBudget = rows[2].querySelector<HTMLElement>("[data-scope-budget]")!;
		expect(overRowBudget.getAttribute("data-budget-state")).toBe("over");
		expect(within(overRowBudget).getByText("9,000 / 8,192 B")).toBeTruthy();

		// Legacy scope without budget fields degrades cleanly.
		expect(within(rows[3]).getByText("1 note")).toBeTruthy();
		expect(rows[3].querySelector("[data-scope-budget]")).toBeNull();

		fireEvent.click(rows[1]);
		const pikaRegion = await screen.findByRole("region", { name: "pika" });
		const pikaHeaderBudget = pikaRegion.querySelector<HTMLElement>("[data-scope-budget-header]")!;
		expect(pikaHeaderBudget.getAttribute("data-budget-state")).toBe("warn");
		expect(within(pikaHeaderBudget).getByText("6,800 / 8,192 B · 140 / 200 lines")).toBeTruthy();
		expect(pikaRegion.querySelector("[data-tier-filter]")).toBeNull();

		fireEvent.click(rows[3]);
		const emptyRegion = await screen.findByRole("region", { name: "scratch" });
		expect(emptyRegion.querySelector("[data-scope-budget-header]")).toBeNull();
		expect(emptyRegion.querySelector("[data-tier-filter]")).toBeNull();
	});

	it("badges archival notes and revisions, and filters notes by tier", async () => {
		const tiered: FakeMemory = {
			scopes: [
				{
					...PIKA,
					noteCount: 3,
					updatedAt: at(60),
					pinnedCount: 2,
					archivalCount: 1,
					indexBytes: 1200,
					indexLines: 24,
					limitBytes: 8192,
					limitLines: 200,
				},
			],
			notes: [
				note("pinned000001", PIKA, { title: "Explicit pinned note", tier: "pinned" }),
				note("pinned000002", PIKA, { title: "Default pinned note" }),
				note("archival0001", PIKA, { title: "Long-tail archival note", tier: "archival", revision: 2 }),
			],
			revisions: {
				archival0001: [
					revision({ revision: 1, action: "save", title: "Long-tail archival note", tier: "pinned" }),
					revision({ revision: 2, action: "save", title: "Long-tail archival note", tier: "archival" }),
				],
			},
		};
		renderApp(`/memory?${new URLSearchParams({ scope: PIKA.key })}`, createFakeServer({ memory: tiered }).fetch);
		const region = await screen.findByRole("region", { name: "pika" });

		const explicitPinned = (await within(region).findByRole("heading", { name: "Explicit pinned note" })).closest<HTMLElement>("article")!;
		const defaultPinned = within(region).getByRole("heading", { name: "Default pinned note" }).closest<HTMLElement>("article")!;
		const archival = within(region).getByRole("heading", { name: "Long-tail archival note" }).closest<HTMLElement>("article")!;

		expect(explicitPinned.getAttribute("data-tier")).toBe("pinned");
		expect(within(explicitPinned).queryByText("archival")).toBeNull();
		expect(defaultPinned.getAttribute("data-tier")).toBe("pinned");
		expect(within(defaultPinned).queryByText("archival")).toBeNull();
		expect(archival.getAttribute("data-tier")).toBe("archival");
		expect(within(archival).getByText("archival")).toBeTruthy();

		// Revision history badges archival revisions without adding noise to pinned revisions.
		fireEvent.click(within(archival).getByRole("button", { name: "History" }));
		const revList = await within(archival).findByRole("list", { name: "Revisions" });
		const revItems = await waitFor(() => {
			const found = within(revList).getAllByRole("listitem");
			expect(found).toHaveLength(2);
			return found;
		});
		expect(revItems[0].getAttribute("data-tier")).toBe("pinned");
		expect(within(revItems[0]).queryByText("archival")).toBeNull();
		expect(revItems[1].getAttribute("data-tier")).toBe("archival");
		expect(within(revItems[1]).getByText("archival")).toBeTruthy();

		// Tier filter switches cleanly between All, Pinned, and Archival.
		const filter = within(region).getByRole("group", { name: "Note tier" });
		const allBtn = within(filter).getByRole("button", { name: "All" });
		const pinnedBtn = within(filter).getByRole("button", { name: "Pinned" });
		const archivalBtn = within(filter).getByRole("button", { name: "Archival" });

		expect(allBtn.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(pinnedBtn);
		expect(pinnedBtn.getAttribute("aria-pressed")).toBe("true");
		expect(within(region).getByRole("heading", { name: "Explicit pinned note" })).toBeTruthy();
		expect(within(region).getByRole("heading", { name: "Default pinned note" })).toBeTruthy();
		expect(within(region).queryByRole("heading", { name: "Long-tail archival note" })).toBeNull();

		fireEvent.click(archivalBtn);
		expect(archivalBtn.getAttribute("aria-pressed")).toBe("true");
		expect(within(region).queryByRole("heading", { name: "Explicit pinned note" })).toBeNull();
		expect(within(region).queryByRole("heading", { name: "Default pinned note" })).toBeNull();
		expect(within(region).getByRole("heading", { name: "Long-tail archival note" })).toBeTruthy();

		fireEvent.click(allBtn);
		expect(allBtn.getAttribute("aria-pressed")).toBe("true");
		expect(within(region).getByRole("heading", { name: "Explicit pinned note" })).toBeTruthy();
		expect(within(region).getByRole("heading", { name: "Default pinned note" })).toBeTruthy();
		expect(within(region).getByRole("heading", { name: "Long-tail archival note" })).toBeTruthy();
	});

	it("falls back to showing pinned notes when undoing a dream removes the last archival note while filtered to Archival", async () => {
		const scopeSummary: MemoryScopeSummary = {
			...PIKA,
			noteCount: 2,
			updatedAt: at(60),
			pinnedCount: 1,
			archivalCount: 1,
			indexBytes: 900,
			indexLines: 18,
			limitBytes: 8192,
			limitLines: 200,
		};
		const batch: MemoryBatch = {
			id: "b-archival",
			leaseId: "lease-1",
			scope: PIKA,
			mode: "auto",
			at: at(60),
			deviceId: "00000000-0000-4000-8000-000000000001",
			sessionId: null,
			dreamSessionId: null,
			summary: "Archived one long-tail note.",
			sessions: ["sess-1"],
			revertedAt: null,
			changes: [
				{
					noteId: "archival0001",
					revision: 1,
					action: "save",
					created: true,
					title: "Dreamt archival note",
				},
			],
		};
		const server = createFakeServer({
			memory: {
				scopes: [scopeSummary],
				notes: [
					note("pinned000001", PIKA, { title: "Existing pinned note", tier: "pinned" }),
					note("archival0001", PIKA, { title: "Dreamt archival note", tier: "archival", provenance: "dream", revision: 1 }),
				],
				revisions: {
					archival0001: [
						revision({ revision: 1, action: "save", provenance: "dream", batchId: "b-archival", title: "Dreamt archival note", tier: "archival" }),
					],
				},
				batches: [batch],
			},
		});
		const fetchWithScopeCounts: typeof fetch = async (input, init) => {
			const response = await server.fetch(input, init);
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/api/v1/memory/batches/b-archival/revert") && response.ok) {
				scopeSummary.noteCount = 1;
				scopeSummary.pinnedCount = 1;
				scopeSummary.archivalCount = 0;
			}
			return response;
		};

		renderApp(`/memory?${new URLSearchParams({ scope: PIKA.key })}`, fetchWithScopeCounts);
		const region = await screen.findByRole("region", { name: "pika" });
		await within(region).findByRole("heading", { name: "Dreamt archival note" });

		const filter = within(region).getByRole("group", { name: "Note tier" });
		fireEvent.click(within(filter).getByRole("button", { name: "Archival" }));
		expect(within(region).queryByRole("heading", { name: "Existing pinned note" })).toBeNull();
		expect(within(region).getByRole("heading", { name: "Dreamt archival note" })).toBeTruthy();

		const batchRow = await waitFor(() => {
			const el = document.querySelector<HTMLElement>('[data-memory-batch="b-archival"]');
			expect(el).toBeTruthy();
			return el!;
		});
		fireEvent.click(within(batchRow).getByRole("button", { name: /^Undo/ }));
		const dialog = await screen.findByRole("dialog", { name: "Undo this dream?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Undo" }));

		await waitFor(() => {
			expect(within(region).queryByRole("group", { name: "Note tier" })).toBeNull();
			expect(within(region).getByRole("heading", { name: "Existing pinned note" })).toBeTruthy();
		});
		expect(within(region).queryByRole("heading", { name: "Dreamt archival note" })).toBeNull();
		expect(within(region).queryByText("No archival notes")).toBeNull();
	});

	it("shows the line budget readout in ScopeRow when line pressure exceeds byte pressure", async () => {
		const LINE_BOUND: MemoryScope = { key: "repo:https://github.com/acme/lines", kind: "project", label: "lines" };
		const budgeted: FakeMemory = {
			scopes: [
				{
					...LINE_BOUND,
					noteCount: 5,
					updatedAt: at(30),
					pinnedCount: 5,
					archivalCount: 0,
					indexBytes: 2400,
					indexLines: 170,
					limitBytes: 8192,
					limitLines: 200,
				},
				{
					...PIKA,
					noteCount: 3,
					updatedAt: at(60),
					pinnedCount: 3,
					archivalCount: 0,
					indexBytes: 6800,
					indexLines: 50,
					limitBytes: 8192,
					limitLines: 200,
				},
			],
			notes: [
				note("l1", LINE_BOUND, { title: "Line bound note" }),
				note("p1", PIKA, { title: "Byte bound note" }),
			],
			revisions: {},
		};
		renderApp("/memory", createFakeServer({ memory: budgeted }).fetch);
		const scopes = await screen.findByRole("navigation", { name: "Memory scopes" });
		const rows = await waitFor(() => {
			const found = [...scopes.querySelectorAll<HTMLElement>("[data-memory-scope]")];
			expect(found).toHaveLength(2);
			return found;
		});

		const lineBoundBudget = rows[0].querySelector<HTMLElement>("[data-scope-budget]")!;
		expect(lineBoundBudget.getAttribute("data-budget-state")).toBe("warn");
		expect(within(lineBoundBudget).getByText("170 / 200 lines")).toBeTruthy();
		expect(within(lineBoundBudget).queryByText("2,400 / 8,192 B")).toBeNull();
		expect(lineBoundBudget.getAttribute("title")).toBe("Pinned index: 2,400 / 8,192 B · 170 / 200 lines");

		const byteBoundBudget = rows[1].querySelector<HTMLElement>("[data-scope-budget]")!;
		expect(byteBoundBudget.getAttribute("data-budget-state")).toBe("warn");
		expect(within(byteBoundBudget).getByText("6,800 / 8,192 B")).toBeTruthy();
		expect(byteBoundBudget.getAttribute("title")).toBe("Pinned index: 6,800 / 8,192 B · 50 / 200 lines");
	});
});
