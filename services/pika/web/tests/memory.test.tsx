import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDateTime, formatRelative } from "../src/lib/format";
import type { MemoryNote, MemoryRevision, MemoryScope, MemoryScopeSummary } from "../src/lib/types";
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
});
