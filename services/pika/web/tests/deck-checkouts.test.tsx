/**
 * Deck's page on the checkout contract, end to end in jsdom: a fake pika server (the browser socket, the health and
 * Deck routes) and a fake node that speaks the real crypto and answers the checkout requests (NODE.md, "Checkouts").
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NodesClient } from "../src/nodes/client";
import type { Body, Checkout, ClientMessage, TerminalInfo } from "../src/nodes/contract";
import { clientIdentity, MemoryKeyStore } from "../src/nodes/identity";
import type { WebSocketLike } from "../src/nodes/socket";
import { DeckPage, NodesClientFactory } from "../src/pages/Deck";
import { placeKey } from "../src/nodes/workspace/places";
import { WORKSPACE_KEY_PREFIX } from "../src/nodes/workspace/store";
import { fakeKey, gitCheckout, worktree } from "./support/checkouts";
import { FakeNode, nodeCrypto, settle } from "./support/fakeNode";
import { renderWithApi } from "./support/render";

class StubResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

beforeAll(() => {
	vi.stubGlobal("crypto", nodeCrypto);
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	Element.prototype.scrollIntoView = () => {};
});

/** The pika server's browser socket in memory: one node, its channels' frames forwarded verbatim. */
function socketTo(node: FakeNode): () => WebSocketLike {
	return () => {
		const routes = new Map<string, ReturnType<FakeNode["route"]>>();
		let channels = 0;
		const socket: WebSocketLike = {
			readyState: 0,
			onopen: null,
			onmessage: null,
			onclose: null,
			onerror: null,
			send(text: string) {
				const frame = JSON.parse(text) as { type: string; ref?: string; channel?: string; body?: Body; code?: string };
				if (frame.type === "open") {
					const channel = `ch${++channels}`;
					const route = node.route(channel);
					route.onFrame = (body) => emit({ type: "frame", channel, body });
					route.onClose = (code) => emit({ type: "close", channel, code });
					routes.set(channel, route);
					emit({ type: "opened", ref: frame.ref, channel, node: node.id });
				} else if (frame.type === "frame") routes.get(frame.channel!)?.send(frame.body!);
				else if (frame.type === "close") routes.get(frame.channel!)?.close(frame.code!);
			},
			close() {
				(socket as { readyState: number }).readyState = 3;
			},
		} as WebSocketLike;
		const emit = (frame: object) => {
			const data = JSON.stringify(frame);
			queueMicrotask(() => socket.onmessage?.(new MessageEvent("message", { data })));
		};
		queueMicrotask(() => {
			(socket as { readyState: number }).readyState = 1;
			socket.onopen?.(new Event("open"));
			emit({ type: "welcome", serverVersion: "0.9.0", limits: { heartbeatSeconds: 20, maxFrameBytes: 2 << 20, maxChannels: 16 } });
			emit({ type: "nodes", items: [{ id: node.id, name: "node01", online: true }] });
		});
		return socket;
	};
}

interface Sent {
	method: string;
	path: string;
	body?: unknown;
}

/** The server's health and Deck routes: keys as `fakeKey` computes them, rows kept in memory. */
function deckServer() {
	const sent: Sent[] = [];
	const rows = new Map<string, { key: string; name: string | null; collapsed: boolean; updatedAt: string }>();
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "http://pika.test");
		const method = init?.method ?? "GET";
		const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
		sent.push({ method, path: url.pathname, ...(body ? { body } : {}) });
		if (url.pathname === "/api/health") return json({ ok: true, version: "0.9.0", basePath: "/", features: ["nodes"] });
		if (url.pathname === "/api/v1/deck/project-keys") return json({ keys: (body as { items: Parameters<typeof fakeKey>[0][] }).items.map(fakeKey) });
		if (url.pathname === "/api/v1/deck/projects") return json({ projects: [...rows.values()] });
		const match = /^\/api\/v1\/deck\/projects\/(.+)$/.exec(url.pathname);
		if (match) {
			const key = decodeURIComponent(match[1]!);
			if (method === "DELETE") return json({ deleted: rows.delete(key) });
			const row = { key, name: null, collapsed: false, ...rows.get(key), ...(body as object), updatedAt: "2026-11-12T00:00:00Z" };
			rows.set(key, row);
			return json(row);
		}
		return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
	}) as typeof fetch;
	return { sent, rows, fetchImpl };
}

const HOME = "/home/me";
const shell = (terminalId: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({ terminalId, title: terminalId, cwd: HOME, cols: 80, rows: 24, pid: 1, createdAt: 1, argv: ["/bin/zsh", "-l"], ...extra });

describe("Deck on checkouts", () => {
	let node: FakeNode;
	let store: MemoryKeyStore;
	let client: NodesClient | undefined;
	let repo: Checkout;
	let checkouts: Checkout[];
	let terminals: TerminalInfo[];
	/** How the fake node answers a request; undefined leaves it unanswered (attach, files). */
	let answer: (message: ClientMessage) => { result?: object; error?: { code: string; message: string } } | undefined;

	beforeEach(async () => {
		localStorage.clear();
		repo = gitCheckout("a", `${HOME}/repo`);
		checkouts = [repo];
		terminals = [shell("t1", { cwd: `${HOME}/repo`, checkoutId: repo.id, worktreePath: `${HOME}/repo` }), shell("t2", { cwd: "/srv" })];
		node = await FakeNode.create("node-1");
		const welcome = node.welcome.bind(node);
		node.welcome = () => ({ ...welcome(), home: HOME, capabilities: [...welcome().capabilities, "checkouts", "term.rename", "pane.unread"] });
		answer = (message) => {
			if (message.type === "term.list") return { result: { terminals } };
			if (message.type === "checkouts.list") return { result: { checkouts, truncated: false } };
			return undefined;
		};
		node.onMessage = (message, fake) => {
			if (!("id" in message)) return;
			const reply = answer(message);
			if (reply) void fake.send({ type: "reply", id: message.id, ...reply } as never);
		};
		store = new MemoryKeyStore();
		const identity = await clientIdentity(store);
		node.allowed.add(identity.fingerprint);
		await store.pin({ node: node.id, fingerprint: node.identity.fingerprint, publicKey: "k", name: "node01", pinnedAt: 1 });
	});

	afterEach(() => {
		client?.dispose();
		client = undefined;
	});

	async function open() {
		const server = deckServer();
		const factory = (options: ConstructorParameters<typeof NodesClient>[0]) => {
			client = new NodesClient({ ...options, store, socket: { create: socketTo(node) } });
			return client;
		};
		renderWithApi(
			<NodesClientFactory.Provider value={factory}>
				<Routes>
					<Route path="/deck/:node?/:terminal?" element={<DeckPage />} />
				</Routes>
			</NodesClientFactory.Provider>,
			server.fetchImpl,
			"/deck/node-1",
		);
		await waitFor(() => expect(document.querySelector("[data-agent-list]")).not.toBeNull());
		await act(() => settle(40));
		fireEvent.click(screen.getByRole("button", { name: "Projects" }));
		await waitFor(() => expect(document.querySelector("[data-project-heading]")).not.toBeNull());
		return server;
	}

	const menuItem = (menu: string, item: string) => document.querySelector<HTMLElement>(`[${menu}] [data-menu-item='${item}']`)!;
	const openMenu = (row: Element) => {
		fireEvent.pointerDown(row, { button: 2 });
		fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
	};
	const agentsUnder = (path: string) => [...document.querySelectorAll(`[data-worktree-card='${path}'] [data-agent-row]`)].map((row) => row.getAttribute("data-agent-row"));
	const received = (type: string) => node.received.filter((message) => message.type === type);

	it("groups by the server's key, places terminals by checkoutId and worktreePath, and keeps a layout per worktree", async () => {
		const server = await open();
		// One batch of keys for the node's checkouts.
		expect(server.sent.filter((item) => item.path === "/api/v1/deck/project-keys")).toEqual([
			{ method: "POST", path: "/api/v1/deck/project-keys", body: { items: [{ repository: repo.repository, project: "repo", node: "node-1" }] } },
		]);
		expect(document.querySelector("[data-project-name]")!.textContent).toBe("repo");
		expect(agentsUnder(`${HOME}/repo`)).toEqual(["t1"]);
		expect(agentsUnder("other:")).toEqual(["t2"]);
		// The worktree on screen is the newest terminal's; its layout is stored under its place, version 2.
		await waitFor(() => expect(document.querySelector("[data-workspace-place]")!.textContent).toBe("main · repo"));
		const stored = JSON.parse(localStorage.getItem(`${WORKSPACE_KEY_PREFIX}node-1`)!) as { version: number; layouts: Record<string, unknown> };
		expect(stored.version).toBe(2);
		expect(Object.keys(stored.layouts).sort()).toEqual([placeKey(repo.id, `${HOME}/repo`), "other:"].sort());

		// The terminal moves: term.placed puts it under Other, and the inbox row's second line follows.
		await act(async () => {
			await node.send({ type: "term.placed", terminalId: "t1", checkoutId: null, worktreePath: null });
			await settle();
		});
		expect(agentsUnder("other:").sort()).toEqual(["t1", "t2"]);

		// Folding the heading goes to the server, the key one path segment.
		fireEvent.click(document.querySelector("[data-project-heading]")!);
		await waitFor(() => expect(server.sent.some((item) => item.method === "PATCH")).toBe(true));
		expect(server.sent.find((item) => item.method === "PATCH")).toEqual({ method: "PATCH", path: `/api/v1/deck/projects/${encodeURIComponent(`repo:${repo.repository}`)}`, body: { collapsed: true } });
		expect(document.querySelector("[data-project-heading]")!.getAttribute("aria-expanded")).toBe("false");
	});

	it("creates a worktree from the heading's menu, opens it, and shows its setup terminal under its card", async () => {
		repo = { ...repo, settings: { setupScript: "npm ci" } };
		checkouts = [repo];
		const fix = worktree(`${HOME}/repo-fix`, "fix");
		const withFix: Checkout = { ...repo, worktrees: [...repo.worktrees, fix] };
		const setup = shell("t9", { argv: ["sh", "-c", "npm ci"], cwd: fix.path, checkoutId: repo.id, worktreePath: fix.path });
		answer = ((base) => (message: ClientMessage) => {
			if (message.type === "worktree.create") return { result: { checkout: withFix, worktree: fix, setupTerminal: setup } };
			return base(message);
		})(answer);
		await open();
		openMenu(document.querySelector("[data-project-heading]")!);
		fireEvent.click(menuItem("data-project-menu", "new-worktree"));
		const dialog = await screen.findByRole("dialog", { name: "New worktree of repo" });
		fireEvent.change(dialog.querySelector("[data-worktree-name]")!, { target: { value: "fix" } });
		expect(dialog.querySelector("[data-worktree-path-preview]")!.textContent).toBe("~/repo-fix");
		expect(dialog.querySelector("[data-worktree-setup]")).not.toBeNull();
		fireEvent.click(within(dialog).getByRole("checkbox", { name: "Start pi in it" }));
		fireEvent.click(dialog.querySelector("[data-worktree-submit]")!);
		await waitFor(() => expect(received("worktree.create")).toHaveLength(1));
		expect(received("worktree.create")[0]).toMatchObject({ checkoutId: repo.id, name: "fix", base: "HEAD", cols: 80, rows: 24 });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await act(() => settle());
		expect(document.querySelector("[data-workspace-place]")!.textContent).toBe("fix · repo");
		expect(agentsUnder(fix.path)).toEqual(["t9"]);
		// No pi was asked for.
		expect(received("term.create")).toHaveLength(0);
	});

	it("removes a worktree: busy offers to stop its terminals, the branch kept unless asked", async () => {
		const fix = worktree(`${HOME}/repo-fix`, "fix");
		repo = { ...repo, worktrees: [...repo.worktrees, fix] };
		checkouts = [repo];
		terminals = [shell("t3", { cwd: fix.path, checkoutId: repo.id, worktreePath: fix.path })];
		const removals: ClientMessage[] = [];
		answer = ((base) => (message: ClientMessage) => {
			if (message.type !== "worktree.remove") return base(message);
			removals.push(message);
			if (removals.length === 1) return { error: { code: "busy", message: "1 live terminal uses the worktree" } };
			return { result: { checkout: { ...repo, worktrees: [repo.worktrees[0]!] }, branch: { name: "fix", deleted: false, message: "error: the branch 'fix' is not fully merged" } } };
		})(answer);
		await open();
		openMenu(document.querySelector(`[data-worktree-card='${fix.path}'] [data-worktree-open]`)!);
		fireEvent.click(menuItem("data-worktree-menu", "remove-worktree"));
		const dialog = await screen.findByRole("alertdialog", { name: "Remove the worktree fix?" });
		fireEvent.click(within(dialog).getByRole("checkbox", { name: "Also delete branch fix" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Remove Worktree" }));
		fireEvent.click(await within(dialog).findByRole("button", { name: "Stop 1 terminal and Remove" }));
		await waitFor(() => expect(removals).toHaveLength(2));
		expect(removals.map((message) => ({ ...message, id: undefined }))).toEqual([
			{ type: "worktree.remove", id: undefined, checkoutId: repo.id, path: fix.path, deleteBranch: true },
			{ type: "worktree.remove", id: undefined, checkoutId: repo.id, path: fix.path, deleteBranch: true, force: true },
		]);
		await waitFor(() => expect(document.querySelector("[data-undo-notice]")!.textContent).toContain("kept the branch fix: error: the branch 'fix' is not fully merged"));
		expect(document.querySelector(`[data-worktree-card='${fix.path}']`)).toBeNull();
	});

	it("removes a checkout from Deck with an undo that unhides it", async () => {
		const hidden: string[] = [];
		answer = ((base) => (message: ClientMessage) => {
			if (message.type === "checkout.hide") {
				hidden.push(message.checkoutId);
				return { result: {} };
			}
			if (message.type === "checkout.unhide") return { result: { checkout: repo } };
			return base(message);
		})(answer);
		await open();
		openMenu(document.querySelector("[data-project-heading]")!);
		fireEvent.click(menuItem("data-project-menu", "hide"));
		await waitFor(() => expect(hidden).toEqual([repo.id]));
		await waitFor(() => expect(document.querySelector("[data-project-heading]")).toBeNull());
		expect(document.querySelector("[data-undo-notice]")!.textContent).toContain("Removed repo from Deck");
		fireEvent.click(document.querySelector("[data-undo]")!);
		await waitFor(() => expect(received("checkout.unhide")).toHaveLength(1));
		await waitFor(() => expect(document.querySelector("[data-project-heading]")).not.toBeNull());
	});
});
