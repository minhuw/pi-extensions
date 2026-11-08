import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDateTime, formatRelative } from "../src/lib/format";
import type { MemoryBatch, MemoryNote, MemoryRevision, MemoryScope } from "../src/lib/types";
import { renderApp } from "./support/render";
import { createFakeServer, type FakeMemory } from "./support/server";

const USER: MemoryScope = { key: "user", kind: "user", label: "user" };
const PIKA: MemoryScope = { key: "repo:https://github.com/acme/pika", kind: "project", label: "pika" };
const QUIET: MemoryScope = { key: "local:quiet@00000000-0000-4000-8000-000000000001", kind: "project", label: "quiet" };
const DEVICE = "00000000-0000-4000-8000-000000000001";

function at(minutes: number): string {
	return new Date(Date.parse("2026-11-01T09:00:00.000Z") + minutes * 60_000).toISOString();
}

function note(id: string, fields: Partial<MemoryNote> = {}): MemoryNote {
	return {
		id,
		scope: PIKA,
		category: "project",
		title: `Note ${id}`,
		hook: `Hook ${id}`,
		body: "",
		provenance: "agent",
		sources: [],
		revision: 1,
		createdAt: at(0),
		updatedAt: at(0),
		deletedAt: null,
		deviceId: DEVICE,
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
		deviceId: DEVICE,
		sessionId: null,
		reason: null,
		...fields,
	};
}

function batch(id: string, fields: Partial<MemoryBatch> = {}): MemoryBatch {
	return {
		id,
		leaseId: `lease-${id}`,
		scope: PIKA,
		mode: "auto",
		at: at(0),
		deviceId: DEVICE,
		sessionId: null,
		dreamSessionId: null,
		summary: null,
		sessions: [],
		changes: [],
		revertedAt: null,
		...fields,
	};
}

/**
 * Three batches of `pika`: the newest updated, created, and forgot a note each; an older one updated a note an agent
 * has changed since; the oldest is already reverted.
 */
function memory(): FakeMemory {
	const dream = [{ sessionId: "sess-a", seq: 4 }, { sessionId: "sess-b", seq: 12 }];
	return {
		scopes: [
			{ ...USER, noteCount: 0, updatedAt: null },
			{ ...PIKA, noteCount: 3, updatedAt: at(150) },
			{ ...QUIET, noteCount: 0, updatedAt: null },
		],
		notes: [
			note("dddddddddd01", { title: "Tests run offline", provenance: "dream", sources: dream, revision: 2, updatedAt: at(120), sessionId: "dream-1" }),
			note("dddddddddd02", { title: "Fake server first", provenance: "dream", sources: [{ sessionId: "sess-a", seq: 7 }], createdAt: at(120), updatedAt: at(120) }),
			note("dddddddddd03", { title: "Old build note", revision: 2, deletedAt: at(120) }),
			note("dddddddddd04", { title: "Release steps", revision: 3, updatedAt: at(150) }),
		],
		revisions: {
			dddddddddd01: [
				revision({ revision: 1, action: "save", title: "Tests are offline" }),
				revision({ revision: 2, action: "save", title: "Tests run offline", provenance: "dream", sources: dream, batchId: "b-new", at: at(120) }),
			],
			dddddddddd02: [revision({ revision: 1, action: "save", title: "Fake server first", provenance: "dream", batchId: "b-new", at: at(120) })],
			dddddddddd03: [
				revision({ revision: 1, action: "save", title: "Old build note" }),
				revision({ revision: 2, action: "forget", title: "Old build note", provenance: "dream", batchId: "b-new", at: at(120) }),
			],
			dddddddddd04: [
				revision({ revision: 1, action: "save", title: "Release steps" }),
				revision({ revision: 2, action: "save", title: "Release steps", provenance: "dream", batchId: "b-conflict", at: at(60) }),
				revision({ revision: 3, action: "save", title: "Release steps", at: at(150) }),
			],
		},
		batches: [
			batch("b-old", {
				at: at(30),
				summary: "An early dream",
				changes: [{ noteId: "dddddddddd05", revision: 1, action: "save", title: "Scratch note", created: true }],
				revertedAt: at(40),
			}),
			batch("b-new", {
				at: at(120),
				dreamSessionId: "dream-1",
				summary: "Merged the test notes.\n<b>not bold</b>",
				sessions: ["sess-a", "sess-b"],
				changes: [
					{ noteId: "dddddddddd01", revision: 2, action: "save", title: "Tests run offline", created: false },
					{ noteId: "dddddddddd02", revision: 1, action: "save", title: "Fake server first", created: true },
					{ noteId: "dddddddddd03", revision: 2, action: "forget", title: "Old build note", created: false },
				],
			}),
			batch("b-conflict", {
				at: at(60),
				mode: "manual",
				sessions: ["sess-c"],
				changes: [{ noteId: "dddddddddd04", revision: 2, action: "save", title: "Release steps", created: false }],
			}),
		],
	};
}

const PIKA_PATH = `/memory?${new URLSearchParams({ scope: PIKA.key })}`;

async function dreams(): Promise<HTMLElement> {
	return screen.findByRole("region", { name: "Dreams" });
}

async function batchRows(region: HTMLElement): Promise<HTMLElement[]> {
	return waitFor(() => {
		const found = [...region.querySelectorAll<HTMLElement>("[data-memory-batch]")];
		expect(found.length).toBeGreaterThan(0);
		return found;
	});
}

async function row(id: string): Promise<HTMLElement> {
	const region = await dreams();
	return waitFor(() => {
		const found = region.querySelector<HTMLElement>(`[data-memory-batch="${id}"]`);
		expect(found).toBeTruthy();
		return found!;
	});
}

function undoButton(item: HTMLElement): HTMLElement | null {
	return within(item).queryByRole("button", { name: /^Undo the dream of/ });
}

describe("Memory page dreams", () => {
	it("lists the scope's batches newest first, with time, mode, dream session, summary, sessions, and changes", async () => {
		const server = createFakeServer({ memory: memory() });
		renderApp(PIKA_PATH, server.fetch);
		const rows = await batchRows(await dreams());
		expect(rows.map((item) => item.getAttribute("data-memory-batch"))).toEqual(["b-new", "b-conflict", "b-old"]);
		expect(server.calls).toContain(`/api/v1/memory/batches?${new URLSearchParams({ scope: PIKA.key })}`);

		const [newest, manual] = rows;
		expect(within(newest).getByText("auto")).toBeTruthy();
		const time = within(newest).getByTitle(formatDateTime(at(120)));
		expect(time.textContent).toBe(formatRelative(at(120)));
		expect(within(newest).getByRole("link", { name: "Dream session →" }).getAttribute("href")).toBe("/s/dream-1");
		// The summary is plain text with its line breaks: markup in it stays text.
		const summary = within(newest).getByText(/Merged the test notes\./);
		expect(summary.textContent).toBe("Merged the test notes.\n<b>not bold</b>");
		expect(newest.querySelector("b")).toBeNull();
		expect(within(newest).getByText("Consolidated 2 sessions")).toBeTruthy();
		const sessions = within(newest).getByRole("list", { name: "Consolidated sessions" });
		expect(within(sessions).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/s/sess-a", "/s/sess-b"]);
		const changes = within(within(newest).getByRole("list", { name: "Changes" })).getAllByRole("listitem");
		expect(changes.map((item) => [item.getAttribute("data-change"), item.getAttribute("data-action")])).toEqual([
			["dddddddddd01", "updated"],
			["dddddddddd02", "created"],
			["dddddddddd03", "forgotten"],
		]);
		expect(within(changes[1]).getByText("Fake server first")).toBeTruthy();
		expect(within(changes[2]).getByText("forgotten")).toBeTruthy();
		expect(undoButton(newest)).toBeTruthy();

		expect(within(manual).getByText("manual")).toBeTruthy();
		expect(within(manual).queryByRole("link", { name: "Dream session →" })).toBeNull();
		expect(within(manual).getByText("No summary")).toBeTruthy();
		expect(server.mutations).toEqual([]);
	});

	it("shows each note's provenance and its sources, linked to their entries", async () => {
		const server = createFakeServer({ memory: memory() });
		renderApp(PIKA_PATH, server.fetch);
		const dreamt = (await screen.findByRole("heading", { name: "Tests run offline" })).closest<HTMLElement>("article")!;
		expect(dreamt.querySelector("[data-provenance]")?.getAttribute("data-provenance")).toBe("dream");
		expect(within(dreamt).getByText("dream")).toBeTruthy();
		const sources = within(dreamt).getByRole("list", { name: "Sources" });
		const links = within(sources).getAllByRole("link");
		expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
			["sess-a #4", "/s/sess-a?seq=4"],
			["sess-b #12", "/s/sess-b?seq=12"],
		]);

		const agent = screen.getByRole("heading", { name: "Release steps" }).closest<HTMLElement>("article")!;
		expect(agent.querySelector("[data-provenance]")?.getAttribute("data-provenance")).toBe("agent");
		// Notes saved without sources list none.
		expect(within(agent).queryByRole("list", { name: "Sources" })).toBeNull();

		// The history names the batch and provenance of each revision.
		fireEvent.click(within(dreamt).getByRole("button", { name: "History" }));
		const list = await within(dreamt).findByRole("list", { name: "Revisions" });
		const items = await waitFor(() => {
			const found = list.querySelectorAll<HTMLElement>(":scope > li");
			expect(found).toHaveLength(2);
			return [...found];
		});
		expect(items[0].querySelector("[data-provenance]")?.getAttribute("data-provenance")).toBe("agent");
		expect(within(items[0]).queryByText(/^Batch/)).toBeNull();
		expect(items[1].querySelector("[data-provenance]")?.getAttribute("data-provenance")).toBe("dream");
		expect(within(items[1]).getByText(/^Batch/).textContent).toBe("Batch b-new");
		expect(within(within(items[1]).getByRole("list", { name: "Sources" })).getAllByRole("link")[1].getAttribute("href")).toBe("/s/sess-b?seq=12");
	});

	it("asks before undoing: cancel does nothing, confirm reverts the batch and refetches the notes", async () => {
		const server = createFakeServer({ memory: memory() });
		renderApp(PIKA_PATH, server.fetch);
		const newest = await row("b-new");
		fireEvent.click(undoButton(newest)!);
		let dialog = await screen.findByRole("dialog", { name: "Undo this dream?" });
		expect(within(dialog).getByText(/restores the 3 notes/)).toBeTruthy();
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(server.mutations).toEqual([]);
		expect(newest.getAttribute("data-reverted")).toBe("false");

		fireEvent.click(undoButton(newest)!);
		dialog = await screen.findByRole("dialog", { name: "Undo this dream?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(server.mutations).toEqual([{ method: "POST", path: "/api/v1/memory/batches/b-new/revert", body: {}, json: true }]);

		const reverted = await waitFor(async () => {
			const item = await row("b-new");
			expect(item.getAttribute("data-reverted")).toBe("true");
			return item;
		});
		expect(within(reverted).getByText(/^Reverted/)).toBeTruthy();
		expect(undoButton(reverted)).toBeNull();
		expect(within(reverted).queryByRole("alert")).toBeNull();

		// The notes are as they were before the dream: the created one is gone, the forgotten one is back, the updated one
		// has its old title, each written by the owner's revert.
		const region = await screen.findByRole("region", { name: "pika" });
		await within(region).findByRole("heading", { name: "Old build note" });
		expect(within(region).queryByRole("heading", { name: "Fake server first" })).toBeNull();
		const restored = within(region).getByRole("heading", { name: "Tests are offline" }).closest<HTMLElement>("article")!;
		expect(restored.querySelector("[data-provenance]")?.getAttribute("data-provenance")).toBe("owner");
		fireEvent.click(within(restored).getByRole("button", { name: "History" }));
		const list = await within(restored).findByRole("list", { name: "Revisions" });
		const last = await waitFor(() => {
			const found = list.querySelectorAll<HTMLElement>(":scope > li");
			expect(found).toHaveLength(3);
			return found[2];
		});
		expect(last.getAttribute("data-action")).toBe("revert");
		expect(within(last).getByText("revert")).toBeTruthy();
		expect(last.querySelector("[data-provenance]")?.getAttribute("data-provenance")).toBe("owner");
		expect(within(last).getByText(/^Batch/).textContent).toBe("Batch b-new");
	});

	it("shows a revert conflict as an error naming the notes, and leaves the batch unreverted", async () => {
		const server = createFakeServer({ memory: memory() });
		renderApp(PIKA_PATH, server.fetch);
		const conflict = await row("b-conflict");
		fireEvent.click(undoButton(conflict)!);
		const dialog = await screen.findByRole("dialog", { name: "Undo this dream?" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Undo" }));

		const alert = await within(conflict).findByRole("alert");
		expect(alert.textContent).toContain("“Release steps” (dddddddddd04)");
		expect(alert.textContent).toContain("Nothing was restored.");
		expect(server.mutations.map((item) => item.path)).toEqual(["/api/v1/memory/batches/b-conflict/revert"]);
		await waitFor(async () => expect((await row("b-conflict")).getAttribute("data-reverted")).toBe("false"));
		expect(undoButton(await row("b-conflict"))).toBeTruthy();
		// The agent's later revision stands.
		const agent = screen.getByRole("heading", { name: "Release steps" }).closest<HTMLElement>("article")!;
		expect(within(agent).getByText("Revision 3")).toBeTruthy();
	});

	it("refetches without an error when the batch was already reverted elsewhere", async () => {
		const server = createFakeServer({ memory: memory() });
		renderApp(PIKA_PATH, server.fetch);
		const newest = await row("b-new");
		// Another tab undoes it first.
		await server.fetch("/api/v1/memory/batches/b-new/revert", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		fireEvent.click(undoButton(newest)!);
		fireEvent.click(within(await screen.findByRole("dialog", { name: "Undo this dream?" })).getByRole("button", { name: "Undo" }));
		await waitFor(async () => expect((await row("b-new")).getAttribute("data-reverted")).toBe("true"));
		expect(within(await row("b-new")).queryByRole("alert")).toBeNull();
	});

	it("offers no Undo on reverted batches", async () => {
		renderApp(PIKA_PATH, createFakeServer({ memory: memory() }).fetch);
		const old = await row("b-old");
		expect(old.getAttribute("data-reverted")).toBe("true");
		expect(undoButton(old)).toBeNull();
		const reverted = within(old).getByText(/^Reverted/);
		expect(reverted.textContent).toBe(`Reverted ${formatRelative(at(40))}`);
		expect(within(reverted).getByTitle(formatDateTime(at(40)))).toBeTruthy();
	});

	it("says when a scope has no dreams", async () => {
		const server = createFakeServer({ memory: memory() });
		renderApp(`/memory?${new URLSearchParams({ scope: QUIET.key })}`, server.fetch);
		const region = await dreams();
		expect((await within(region).findByText("No dreams")).closest("[data-state=empty]")).toBeTruthy();
		expect(within(region).queryByRole("button")).toBeNull();
		expect(server.calls).toContain(`/api/v1/memory/batches?${new URLSearchParams({ scope: QUIET.key })}`);
	});
});
