import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { liveBridge, NodesClient, orderTerminals } from "../src/nodes/client";
import type { Body, TerminalInfo } from "../src/nodes/contract";
import { MemoryKeyStore } from "../src/nodes/identity";
import type { WebSocketLike } from "../src/nodes/socket";
import { FakeNode, settle } from "./support/fakeNode";

beforeAll(() => {
	vi.stubGlobal("crypto", webcrypto);
});

const shell: TerminalInfo = { terminalId: "t1", title: "bash", cwd: "/home/me", cols: 80, rows: 24, pid: 7, createdAt: 1, argv: ["/bin/bash", "-l"] };

/** The pika server in memory: one browser socket, routing channels to fake nodes, frames verbatim. */
class FakeServer {
	readonly nodes = new Map<string, FakeNode>();
	readonly toServer: Record<string, unknown>[] = [];
	socket: FakeSocket | undefined;
	online = true;
	channels = 0;

	create = (): WebSocketLike => {
		this.socket = new FakeSocket(this);
		return this.socket;
	};

	nodeList() {
		return [...this.nodes.values()].map((node) => ({ id: node.id, name: "node01", online: this.online }));
	}
}

class FakeSocket implements WebSocketLike {
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	readonly #server: FakeServer;

	constructor(server: FakeServer) {
		this.#server = server;
		queueMicrotask(() => {
			this.readyState = 1;
			this.onopen?.(new Event("open"));
			this.emit({ type: "welcome", serverVersion: "0.9.0", limits: { heartbeatSeconds: 20, maxFrameBytes: 2 << 20, maxChannels: 16 } });
			this.emit({ type: "nodes", items: server.nodeList() });
		});
	}

	emit(frame: object) {
		const data = JSON.stringify(frame);
		queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data })));
	}

	send(text: string) {
		const frame = JSON.parse(text) as { type: string; ref?: string; node?: string; channel?: string; body?: Body; code?: string };
		this.#server.toServer.push(frame);
		if (frame.type === "open") {
			const node = this.#server.nodes.get(frame.node!);
			if (!node) return this.emit({ type: "refused", ref: frame.ref, code: "unknown_node" });
			const channel = `ch${++this.#server.channels}`;
			const route = node.route(channel);
			route.onFrame = (body) => this.emit({ type: "frame", channel, body });
			route.onClose = (code) => this.emit({ type: "close", channel, code });
			routes.set(channel, route);
			this.emit({ type: "opened", ref: frame.ref, channel, node: node.id });
		} else if (frame.type === "frame") routes.get(frame.channel!)?.send(frame.body!);
		else if (frame.type === "close") routes.get(frame.channel!)?.close(frame.code!);
	}

	close() {
		this.readyState = 3;
	}
}

const routes = new Map<string, { send(body: Body): void; close(code: string): void }>();

let client: NodesClient | undefined;
afterEach(() => {
	client?.dispose();
	routes.clear();
});

async function setup() {
	const server = new FakeServer();
	const node = await FakeNode.create("node-1");
	node.onMessage = (message, fake) => {
		if (message.type === "term.list") void fake.send({ type: "reply", id: message.id, result: { terminals: [shell] } });
	};
	server.nodes.set(node.id, node);
	const store = new MemoryKeyStore();
	client = new NodesClient({ socketUrl: "ws://pika.test/api/v1/node/connect", store, label: "Test", socket: { create: server.create } });
	await client.start();
	await settle();
	return { server, node, store, client };
}

const link = (c: NodesClient) => c.getSnapshot().nodes[0]!.link;

describe("the Nodes page client", () => {
	it("lists nodes and opens no channel to an unpinned node on its own", async () => {
		const { server, client: c } = await setup();
		expect(c.getSnapshot()).toMatchObject({ status: "open", nodes: [{ info: { id: "node-1", online: true }, link: { kind: "idle" } }] });
		expect(c.getSnapshot().fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(server.toServer).toEqual([]);
	});

	it("enrols, confirms, pins, and then talks to the node on a new channel", async () => {
		const { server, node, store, client: c } = await setup();
		const fingerprint = c.getSnapshot().fingerprint!;

		c.pair("node-1");
		await settle();
		expect(link(c)).toEqual({ kind: "enrol", clientFingerprint: fingerprint, nodeFingerprint: node.identity.fingerprint });
		expect(node.pendingEnrolments).toEqual([fingerprint]);

		// `pika-node clients add <prefix>` on the node.
		node.allowed.add(fingerprint);
		c.pair("node-1");
		await settle();
		expect(link(c)).toMatchObject({ kind: "confirm", nodeFingerprint: node.identity.fingerprint });
		expect(node.received).toEqual([]);

		await c.confirmPin("node-1");
		await settle();
		expect(link(c).kind).toBe("ready");
		expect((await store.pins()).map((pin) => [pin.node, pin.fingerprint])).toEqual([["node-1", node.identity.fingerprint]]);
		expect(c.getSnapshot().nodes[0]!.terminals).toEqual([shell]);
		expect(node.received.map((message) => message.type)).toEqual(["term.list"]);
		// Three channels: the enrolment, the confirmation, and the pinned one.
		expect(server.channels).toBe(3);
	});

	it("reconnects a pinned node by itself, and applies pane status in waiting-first order", async () => {
		const { node, store, client: first } = await setup();
		node.allowed.add(first.getSnapshot().fingerprint!);
		first.pair("node-1");
		await settle();
		await first.confirmPin("node-1");
		await settle();
		first.dispose();

		// A new page load: the pin is stored, so the channel opens without asking.
		const server = new FakeServer();
		server.nodes.set(node.id, node);
		node.onMessage = (message, fake) => {
			if (message.type === "term.list") {
				void fake.send({ type: "reply", id: message.id, result: { terminals: [shell, { ...shell, terminalId: "t2", title: "pi" }] } });
			}
		};
		client = new NodesClient({ socketUrl: "ws://pika.test/x", store, label: "Test", socket: { create: server.create } });
		await client.start();
		await settle();
		expect(link(client).kind).toBe("ready");
		await node.send({
			type: "pane.status",
			terminalId: "t2",
			status: { state: "waiting", bridgeConnected: false, unread: false, program: { state: "blocked", app: "pi", kind: "question", at: 1 } },
		});
		await settle();
		const terminals = client.getSnapshot().nodes[0]!.terminals;
		expect(orderTerminals(terminals).map((item) => item.terminalId)).toEqual(["t2", "t1"]);
	});

	it("lists terminals once per channel and then follows term.created and term.removed", async () => {
		const { node, client: c } = await setup();
		const other = { ...shell, terminalId: "t2", title: "pi", createdAt: 2 };
		node.onMessage = (message, fake) => {
			if (message.type === "term.list") void fake.send({ type: "reply", id: message.id, result: { terminals: [shell] } });
			if (message.type === "term.create") {
				void fake.send({ type: "reply", id: message.id, result: { terminal: other } }).then(() => fake.send({ type: "term.created", terminal: other }));
			}
			if (message.type === "term.kill") void fake.send({ type: "reply", id: message.id, result: {} });
		};
		node.allowed.add(c.getSnapshot().fingerprint!);
		c.pair("node-1");
		await settle();
		await c.confirmPin("node-1");
		await settle();
		const ids = () => c.getSnapshot().nodes[0]!.terminals.map((item) => item.terminalId);
		expect(ids()).toEqual(["t1"]);

		// Another tab creates a terminal: it arrives as an event, first in the list, with its text cleaned.
		await node.send({ type: "term.created", terminal: { ...shell, terminalId: "t3", title: "x\u001b[31my", createdAt: 3 } });
		await settle();
		expect(ids()).toEqual(["t3", "t1"]);
		expect(c.getSnapshot().nodes[0]!.terminals[0]!.title).not.toContain("\u001b");

		// This tab creates one: its reply and its own term.created leave one entry.
		await c.createTerminal("node-1", { cols: 80, rows: 24 });
		await settle();
		expect(ids()).toEqual(["t2", "t3", "t1"]);

		await c.killTerminal("node-1", "t3");
		await node.send({ type: "term.removed", terminalId: "t3" });
		await settle();
		expect(ids()).toEqual(["t2", "t1"]);

		// Status for a terminal the list does not hold is dropped, not answered with another term.list.
		await node.send({ type: "term.title", terminalId: "t9", title: "ghost" });
		await settle();
		expect(ids()).toEqual(["t2", "t1"]);
		expect(node.received.filter((message) => message.type === "term.list")).toHaveLength(1);
	});

	it("shows node_key_changed and does not reconnect or send", async () => {
		const { node, store, client: c } = await setup();
		await store.pin({ node: "node-1", fingerprint: "f".repeat(64), publicKey: "x", name: "node01", pinnedAt: 1 });
		c.dispose();
		const server = new FakeServer();
		server.nodes.set(node.id, node);
		node.allowed.add((await store.loadIdentity())!.fingerprint);
		client = new NodesClient({ socketUrl: "ws://pika.test/x", store, label: "Test", socket: { create: server.create } });
		await client.start();
		await settle();
		expect(link(client)).toMatchObject({ kind: "closed", code: "node_key_changed", pinnedFingerprint: "f".repeat(64), nodeFingerprint: node.identity.fingerprint });
		expect(node.received).toEqual([]);
		const opens = server.toServer.filter((frame) => frame.type === "open").length;
		await settle();
		expect(server.toServer.filter((frame) => frame.type === "open").length).toBe(opens);
	});
});

describe("liveBridge", () => {
	const bridge = {
		state: "busy" as const,
		activities: [{ source: "subagents", id: "a1", label: "reviewer", state: "running" as const }],
		activityCount: 1,
		title: "pi - review",
		updatedAt: 1,
	};

	it("is the bridge's status while its socket is open", () => {
		expect(liveBridge({ state: "busy", bridge, bridgeConnected: true, unread: false })).toBe(bridge);
	});

	it("drops a closed bridge's activities and title: pi may have been killed while they ran", () => {
		expect(liveBridge({ state: "idle", bridge, bridgeConnected: false, unread: false })).toBeUndefined();
		expect(liveBridge(undefined)).toBeUndefined();
	});
});
