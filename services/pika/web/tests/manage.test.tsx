import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PublishingSettings } from "../src/lib/api";
import { summary } from "./support/fixtures";
import { firstRender, mockLayout, renderApp } from "./support/render";
import { createFakeServer, type FakeSession } from "./support/server";
import { session } from "./support/trajectory";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function family(): FakeSession[] {
	const root = session();
	root.detail = { ...root.detail, childCount: 1, children: [{ ...summary("c1", { parentSessionId: "t1", title: "Child" }), parentToolCallId: "c_bash" }] };
	const child: FakeSession = { detail: summary("c1", { parentSessionId: "t1", title: "Child", childCount: 1 }), entries: [], turns: [] };
	const grandchild: FakeSession = { detail: summary("g1", { parentSessionId: "c1", title: "Grandchild" }), entries: [], turns: [] };
	return [root, child, grandchild];
}

let restore: () => void;
beforeEach(() => {
	restore = mockLayout({ viewport: 20_000, rowHeight: 80 });
});
afterEach(() => restore());

describe("hiding a session from the public", () => {
	it("hides and shows a session from its header, with a badge while hidden", async () => {
		const server = createFakeServer({ sessions: family() });
		renderApp("/s/t1", server.fetch);
		const header = await waitFor(() => {
			const element = document.querySelector("[data-session-header]");
			expect(element).toBeTruthy();
			return element as HTMLElement;
		}, firstRender);
		expect(header.querySelector("[data-hidden-badge]")).toBeNull();
		fireEvent.click(within(header).getByRole("button", { name: /Hide from public/ }));
		await waitFor(() => expect(header.querySelector("[data-hidden-badge]")?.textContent).toBe("Hidden from public"));
		const toggle = within(header).getByRole("button", { name: /Show in public/ });
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(toggle);
		await waitFor(() => expect(header.querySelector("[data-hidden-badge]")).toBeNull());
		expect(server.mutations.map((m) => [m.method, m.path, m.body, m.json])).toEqual([
			["PATCH", "/api/v1/sessions/t1", { hidden: true }, true],
			["PATCH", "/api/v1/sessions/t1", { hidden: false }, true],
		]);
	});

	it("says a session hidden with its parent is hidden there, and offers no toggle", async () => {
		const sessions = family();
		sessions[2]!.detail = { ...sessions[2]!.detail, hidden: true, hiddenBy: "c1" };
		renderApp("/s/g1", createFakeServer({ sessions }).fetch);
		const badge = await screen.findByText("Hidden from public", {}, firstRender);
		expect(badge.closest("[data-hidden-badge]")?.getAttribute("title")).toMatch(/with the session that started it/);
		expect(screen.queryByRole("button", { name: /Hide from public|Show in public/ })).toBeNull();
		const link = screen.getByRole("link", { name: "the session that started it" });
		expect(link.getAttribute("href")).toBe("/s/c1");
	});

	it("marks hidden sessions in the session list", async () => {
		const sessions = family();
		sessions[0]!.detail = { ...sessions[0]!.detail, hidden: true, hiddenBy: "t1" };
		renderApp("/", createFakeServer({ sessions }).fetch);
		const row = await waitFor(() => {
			const element = document.querySelector('[data-session-row="t1"]');
			expect(element).toBeTruthy();
			return element as HTMLElement;
		});
		expect(row.querySelector("[data-hidden-badge]")?.textContent).toBe("Hidden from public");
		expect(document.querySelectorAll("[data-hidden-badge]")).toHaveLength(1);
	});
});

describe("deleting a session", () => {
	it("confirms with the number of sessions it deletes, then goes to its parent", async () => {
		const server = createFakeServer({ sessions: family() });
		renderApp("/s/c1", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Delete…" }, firstRender));
		const dialog = await screen.findByRole("dialog");
		await waitFor(() => expect(dialog.textContent).toMatch(/This deletes 2 sessions: this one and the 1 session it started/));
		expect(dialog.textContent).toMatch(/It cannot be undone/);
		// Cancel has focus first, as in every confirmation.
		expect(document.activeElement?.textContent).toBe("Cancel");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete 2 sessions" }));
		// The parent's page opens.
		expect(await screen.findByRole("heading", { name: "Fix the flaky test", level: 1 })).toBeTruthy();
		expect(server.mutations.map((m) => [m.method, m.path])).toEqual([["DELETE", "/api/v1/sessions/c1"]]);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("cancels without deleting, and a root session goes to the session list", async () => {
		const server = createFakeServer({ sessions: family() });
		renderApp("/s/t1", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Delete…" }, firstRender));
		fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(server.mutations).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
		const dialog = await screen.findByRole("dialog");
		const confirm = await within(dialog).findByRole("button", { name: "Delete 3 sessions" });
		fireEvent.click(confirm);
		await waitFor(() => expect(document.querySelector("[data-session-header]")).toBeNull());
		expect(server.mutations.map((m) => [m.method, m.path])).toEqual([["DELETE", "/api/v1/sessions/t1"]]);
		await waitFor(() => expect(server.calls.filter((c) => c.startsWith("/api/v1/sessions?")).length).toBeGreaterThan(0));
	});
});

/** A fetch that holds every DELETE until `release` is called. */
function holdingDeletes(fetchImpl: typeof fetch) {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const wrapped: typeof fetch = async (input, init) => {
		if (init?.method === "DELETE") await held;
		return fetchImpl(input, init);
	};
	return { fetch: wrapped, release: () => release() };
}

describe("after deleting a session", () => {
	const onSessionList = async (server: ReturnType<typeof createFakeServer>) => {
		await waitFor(() => expect(document.querySelector("[data-session-header]")).toBeNull());
		await waitFor(() => expect(server.calls.filter((c) => c.startsWith("/api/v1/sessions?")).length).toBeGreaterThan(0));
	};

	it("goes to the session list when its parent was never recorded", async () => {
		const orphan: FakeSession = { detail: summary("o1", { parentSessionId: "never-uploaded", title: "Orphan" }), entries: [], turns: [] };
		const server = createFakeServer({ sessions: [...family(), orphan] });
		renderApp("/s/o1", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Delete…" }, firstRender));
		fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Delete 1 session" }));
		await onSessionList(server);
		expect(server.mutations.map((m) => [m.method, m.path])).toEqual([["DELETE", "/api/v1/sessions/o1"]]);
		expect(server.calls).toContain("/api/v1/sessions/never-uploaded");
	});

	it("goes to the session list when its parent went with it in a link cycle", async () => {
		const a: FakeSession = { detail: summary("a1", { parentSessionId: "b1", title: "Cycle A", childCount: 1 }), entries: [], turns: [] };
		const b: FakeSession = { detail: summary("b1", { parentSessionId: "a1", title: "Cycle B", childCount: 1 }), entries: [], turns: [] };
		const server = createFakeServer({ sessions: [...family(), a, b] });
		renderApp("/s/a1", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Delete…" }, firstRender));
		fireEvent.click(await within(await screen.findByRole("dialog")).findByRole("button", { name: "Delete 2 sessions" }));
		await onSessionList(server);
		expect(screen.queryByRole("heading", { name: "Cycle B", level: 1 })).toBeNull();
	});

	it("keeps the dialog open, Cancel disabled, while the deletion runs", async () => {
		const server = createFakeServer({ sessions: family() });
		const holding = holdingDeletes(server.fetch);
		renderApp("/s/c1", holding.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Delete…" }, firstRender));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(await within(dialog).findByRole("button", { name: "Delete 2 sessions" }));
		const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
		await waitFor(() => expect(cancel.disabled).toBe(true));
		expect((within(dialog).getByRole("button", { name: "Delete 2 sessions" }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(cancel);
		fireEvent.keyDown(window, { key: "Escape" });
		fireEvent.click(dialog.parentElement!);
		expect(screen.getByRole("dialog")).toBe(dialog);
		holding.release();
		expect(await screen.findByRole("heading", { name: "Fix the flaky test", level: 1 })).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("still cancels on the backdrop while it only counts", async () => {
		const server = createFakeServer({ sessions: family() });
		renderApp("/s/c1", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Delete…" }, firstRender));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(dialog.parentElement!);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(server.mutations).toEqual([]);
	});
});

describe("public pages", () => {
	it("offer no hiding or deletion, even for a session marked hidden", async () => {
		const sessions = family();
		sessions[0]!.detail = { ...sessions[0]!.detail, hidden: true, hiddenBy: "t1" };
		const source = createFakeServer({ sessions });
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			if (url.startsWith("/api/public/v1/")) return source.fetch(url.replace("/api/public/v1/", "/api/v1/"), init);
			return source.fetch(input, init);
		};
		renderApp("/public/s/t1", fetchImpl);
		expect(await screen.findByRole("heading", { name: "Fix the flaky test", level: 1 }, firstRender)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Hide from public|Show in public|Delete/ })).toBeNull();
		expect(document.querySelector("[data-hidden-badge]")).toBeNull();
		expect(screen.queryByText("Hidden from public")).toBeNull();
	});
});

describe("deleting a project", () => {
	function settingsServer() {
		const source = createFakeServer({ sessions: [...family(), { ...session(), detail: summary("p2", { project: "my widgets" }) }] });
		let settings: PublishingSettings = {
			projects: [
				{ project: "my widgets", sessionCount: 1, hiddenCount: 0, published: true },
				{ project: "pika", sessionCount: 3, hiddenCount: 2, published: false },
			],
		};
		const fetchImpl: typeof fetch = async (input, init) => {
			if (String(input) === "/api/v1/settings/publishing") return json(settings);
			const response = await source.fetch(input, init);
			if (init?.method === "DELETE" && response.ok) settings = { projects: settings.projects.filter((p) => p.project !== "my widgets") };
			return response;
		};
		return { fetch: fetchImpl, source };
	}

	it("asks for the project's name and states what goes", async () => {
		const server = settingsServer();
		renderApp("/settings", server.fetch);
		const pikaRow = await waitFor(() => {
			const element = document.querySelector('[data-publishing-project="pika"]');
			expect(element).toBeTruthy();
			return element as HTMLElement;
		});
		expect(pikaRow.querySelector("[data-hidden-count]")?.textContent).toBe("2 hidden");
		fireEvent.click(screen.getByRole("button", { name: "Delete project my widgets" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.getAttribute("data-dialog")).toBe("delete-project");
		await waitFor(() => expect(dialog.textContent).toMatch(/This deletes 1 session, .* and 0 Herder runs, and makes the project private\. It cannot be undone\./));
		const confirm = within(dialog).getByRole("button", { name: "Delete project" }) as HTMLButtonElement;
		expect(confirm.disabled).toBe(true);
		const input = within(dialog).getByLabelText(/to confirm/);
		expect(document.activeElement).toBe(input);
		fireEvent.change(input, { target: { value: "my widget" } });
		expect(confirm.disabled).toBe(true);
		fireEvent.change(input, { target: { value: "my widgets" } });
		expect(confirm.disabled).toBe(false);
		fireEvent.click(confirm);
		expect(await screen.findByText("Deleted my widgets: 1 session and 0 Herder runs.")).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(server.source.mutations.map((m) => [m.method, m.path])).toEqual([["DELETE", "/api/v1/projects/my%20widgets"]]);
		await waitFor(() => expect(document.querySelector('[data-publishing-project="my widgets"]')).toBeNull());
	});

	it("ignores Cancel, Escape, and the backdrop while the deletion runs", async () => {
		const server = settingsServer();
		const holding = holdingDeletes(server.fetch);
		renderApp("/settings", holding.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Delete project my widgets" }));
		const dialog = await screen.findByRole("dialog");
		await waitFor(() => expect(dialog.textContent).toMatch(/This deletes 1 session/));
		fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: "my widgets" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));
		const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
		await waitFor(() => expect(cancel.disabled).toBe(true));
		fireEvent.click(cancel);
		fireEvent.keyDown(window, { key: "Escape" });
		fireEvent.click(dialog.parentElement!);
		expect(screen.getByRole("dialog")).toBe(dialog);
		holding.release();
		expect(await screen.findByText("Deleted my widgets: 1 session and 0 Herder runs.")).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("closes on Escape without deleting", async () => {
		const server = settingsServer();
		renderApp("/settings", server.fetch);
		fireEvent.click(await screen.findByRole("button", { name: "Delete project pika" }));
		await screen.findByRole("dialog");
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(server.source.mutations).toEqual([]);
	});
});
