import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelClosed } from "../src/nodes/channel";
import { NodesClient } from "../src/nodes/client";
import type { Body } from "../src/nodes/contract";
import { MemoryKeyStore } from "../src/nodes/identity";
import { FATAL_CLOSE_CODES, NodeSocket, OpenRefused, type SocketStatus, type WebSocketLike } from "../src/nodes/socket";
import { FakeNode, nodeCrypto, settle } from "./support/fakeNode";

beforeAll(() => {
	vi.stubGlobal("crypto", nodeCrypto);
});

const WELCOME_FRAME = {
	type: "welcome",
	serverVersion: "0.9.0",
	limits: { heartbeatSeconds: 20, maxFrameBytes: 2 << 20, maxChannels: 16 },
};

class MockWebSocket implements WebSocketLike {
	readyState = 0;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	readonly sent: string[] = [];
	readonly closeCalls: Array<{ code?: number; reason?: string }> = [];

	open(): void {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}

	receive(frame: unknown): void {
		this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
	}

	serverClose(code: number, reason = ""): void {
		this.readyState = 3;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}

	send(text: string): void {
		this.sent.push(text);
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.closeCalls.push({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) });
	}
}

describe("NodeSocket", () => {
	let sockets: MockWebSocket[] = [];
	let socket: NodeSocket | undefined;

	const create = (): WebSocketLike => {
		const ws = new MockWebSocket();
		sockets.push(ws);
		return ws;
	};

	beforeEach(() => {
		vi.useFakeTimers();
		sockets = [];
		socket = undefined;
	});

	afterEach(() => {
		socket?.dispose();
		vi.useRealTimers();
	});

	it("escalates reconnect backoff across repeated open-then-close(1006) cycles without welcome", () => {
		socket = new NodeSocket("ws://pika.test/api/v1/node/connect", {
			create,
			backoffMs: [500, 1_000, 2_000, 5_000],
		});

		expect(sockets).toHaveLength(1);
		expect(socket.status).toBe("connecting");

		// Attempt 0: open -> immediate transient close (1006), no welcome.
		sockets[0]!.open();
		expect(socket.status).toBe("connecting");
		sockets[0]!.serverClose(1006, "dropped");
		expect(socket.status).toBe("closed");

		vi.advanceTimersByTime(499);
		expect(sockets).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(2);

		// Attempt 1: open -> close(1006) without welcome must wait 1_000ms (not reset to 500ms).
		sockets[1]!.open();
		sockets[1]!.serverClose(1006, "dropped again");
		vi.advanceTimersByTime(999);
		expect(sockets).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(3);

		// Attempt 2: open -> non-welcome frame (ping) + invalid welcome -> close(1011) must still escalate to 2_000ms.
		const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		sockets[2]!.open();
		sockets[2]!.receive({ type: "ping" });
		sockets[2]!.receive({ type: "welcome" }); // missing required fields -> invalid
		expect(socket.status).toBe("connecting");
		sockets[2]!.serverClose(1011, "server error");
		warnSpy.mockRestore();

		vi.advanceTimersByTime(1_999);
		expect(sockets).toHaveLength(3);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(4);

		// Attempt 3: open -> close(1012) escalates to cap (5_000ms).
		sockets[3]!.open();
		sockets[3]!.serverClose(1012, "restarting");
		vi.advanceTimersByTime(4_999);
		expect(sockets).toHaveLength(4);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(5);

		// Attempt 4: repeats the last backoff entry (5_000ms).
		sockets[4]!.open();
		sockets[4]!.serverClose(1006);
		vi.advanceTimersByTime(4_999);
		expect(sockets).toHaveLength(5);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(6);
	});

	it("resets reconnect backoff to the initial delay after receiving a valid welcome frame", () => {
		socket = new NodeSocket("ws://pika.test/api/v1/node/connect", {
			create,
			backoffMs: [500, 1_000, 2_000, 5_000],
		});

		// Escalate backoff to the third step (2_000ms).
		sockets[0]!.open();
		sockets[0]!.serverClose(1006);
		vi.advanceTimersByTime(500);
		expect(sockets).toHaveLength(2);

		sockets[1]!.open();
		sockets[1]!.serverClose(1006);
		vi.advanceTimersByTime(1_000);
		expect(sockets).toHaveLength(3);

		// Now handshake succeeds with welcome -> status becomes "open" and backoff resets.
		sockets[2]!.open();
		sockets[2]!.receive(WELCOME_FRAME);
		expect(socket.status).toBe("open");

		// Next transient close uses the initial 500ms delay again.
		sockets[2]!.serverClose(1006, "network hiccup");
		expect(socket.status).toBe("closed");

		vi.advanceTimersByTime(499);
		expect(sockets).toHaveLength(3);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(4);
		expect(socket.status).toBe("connecting");
	});

	it.each([
		[4401, "session revoked"],
		[4429, "too many sockets"],
		[4503, "nodes disabled"],
	])("stops reconnecting and enters fatal state on close code %i", async (code, reason) => {
		expect(FATAL_CLOSE_CODES.has(code)).toBe(true);

		socket = new NodeSocket("ws://pika.test/api/v1/node/connect", {
			create,
			backoffMs: [500, 1_000],
		});
		const observed: Array<{ status: SocketStatus; fatalClose: typeof socket.fatalClose }> = [];
		socket.subscribe(() => {
			observed.push({ status: socket!.status, fatalClose: socket!.fatalClose });
		});

		sockets[0]!.open();
		sockets[0]!.receive(WELCOME_FRAME);
		expect(socket.status).toBe("open");

		// Set up both an established channel route and a pending open() request.
		const routePromise = socket.open("node-1");
		const openFrame = JSON.parse(sockets[0]!.sent[0]!) as { ref: string };
		sockets[0]!.receive({ type: "opened", ref: openFrame.ref, channel: "ch-1", node: "node-1" });
		const route = await routePromise;
		const routeClosed: Array<{ code: string; reason?: string }> = [];
		route.onClose = (closeCode, closeReason) => routeClosed.push({ code: closeCode, ...(closeReason !== undefined ? { reason: closeReason } : {}) });

		const pendingOpen = socket.open("node-2");

		// Server closes with fatal code.
		sockets[0]!.serverClose(code, reason);

		expect(socket.status).toBe("fatal");
		expect(socket.fatalClose).toEqual({ code, reason });
		expect(socket.lastClose).toEqual({ code, reason });
		expect(observed.at(-1)).toEqual({ status: "fatal", fatalClose: { code, reason } });

		// Pending opens and active routes are torn down immediately with fatal code.
		await expect(pendingOpen).rejects.toMatchObject({ name: "Error", code: "fatal" });
		expect(routeClosed).toEqual([{ code: "fatal", reason }]);

		// Further open() calls fail immediately with OpenRefused("fatal").
		await expect(socket.open("node-1")).rejects.toSatisfy((error: unknown) => error instanceof OpenRefused && error.code === "fatal");

		// No reconnect timer is scheduled even far into the future.
		vi.advanceTimersByTime(600_000);
		expect(sockets).toHaveLength(1);
		expect(socket.status).toBe("fatal");
	});

	it("enters fatal state when a fatal close arrives before welcome", () => {
		socket = new NodeSocket("ws://pika.test/api/v1/node/connect", {
			create,
			backoffMs: [500, 1_000],
		});
		const statuses: SocketStatus[] = [];
		socket.subscribe(() => statuses.push(socket!.status));

		sockets[0]!.open();
		sockets[0]!.serverClose(4401, "unauthorized");

		expect(socket.status).toBe("fatal");
		expect(socket.fatalClose).toEqual({ code: 4401, reason: "unauthorized" });
		expect(statuses).toEqual(["fatal"]);

		vi.advanceTimersByTime(600_000);
		expect(sockets).toHaveLength(1);
	});

	it("explicit dispose() cleanly tears down active routes, pending opens, and timers without reconnecting", async () => {
		socket = new NodeSocket("ws://pika.test/api/v1/node/connect", {
			create,
			backoffMs: [500, 1_000],
		});

		sockets[0]!.open();
		sockets[0]!.receive(WELCOME_FRAME);

		const routePromise = socket.open("node-1");
		const openFrame = JSON.parse(sockets[0]!.sent[0]!) as { ref: string };
		sockets[0]!.receive({ type: "opened", ref: openFrame.ref, channel: "ch-1", node: "node-1" });
		const route = await routePromise;
		const routeClosed: string[] = [];
		route.onClose = (closeCode) => routeClosed.push(closeCode);

		const pendingOpen = socket.open("node-2");

		socket.dispose();

		expect(socket.status).toBe("closed");
		expect(socket.fatalClose).toBeUndefined();
		expect(sockets[0]!.closeCalls).toEqual([{ code: 1000, reason: "page closed" }]);
		expect(routeClosed).toEqual(["disconnected"]);
		await expect(pendingOpen).rejects.toSatisfy((error: unknown) => error instanceof OpenRefused && error.code === "disconnected");

		// Even if the underlying socket fires onclose later or timers advance, no reconnect occurs.
		sockets[0]!.serverClose(1006, "late close");
		vi.advanceTimersByTime(600_000);
		expect(sockets).toHaveLength(1);
		expect(socket.status).toBe("closed");
	});
});

describe("NodesClient fatal socket handling", () => {
	let client: NodesClient | undefined;

	afterEach(() => {
		client?.dispose();
		client = undefined;
	});

	it("surfaces fatal socket state and rejects in-flight channel requests without reconnecting", async () => {
		const node = await FakeNode.create("node-1");
		// Intentionally hold term.list replies so we can verify in-flight requests reject on fatal close.
		const heldIds: string[] = [];
		node.onMessage = (message) => {
			if (message.type === "term.kill") heldIds.push(message.id);
			if (message.type === "term.list") {
				void node.send({ type: "reply", id: message.id, result: { terminals: [] } });
			}
		};

		const store = new MemoryKeyStore();
		const createdSockets: MockWebSocket[] = [];
		const routes = new Map<string, { send(body: Body): void; close(code: string): void }>();
		let channelCount = 0;

		const create = (): WebSocketLike => {
			const ws = new MockWebSocket();
			const originalSend = ws.send.bind(ws);
			ws.send = (text: string) => {
				originalSend(text);
				const frame = JSON.parse(text) as { type: string; ref?: string; node?: string; channel?: string; body?: Body; code?: string };
				if (frame.type === "open" && frame.node === node.id) {
					const channel = `ch-${++channelCount}`;
					const route = node.route(channel);
					route.onFrame = (body) => queueMicrotask(() => ws.receive({ type: "frame", channel, body }));
					route.onClose = (code) => queueMicrotask(() => ws.receive({ type: "close", channel, code }));
					routes.set(channel, route);
					queueMicrotask(() => ws.receive({ type: "opened", ref: frame.ref, channel, node: node.id }));
				} else if (frame.type === "frame") {
					routes.get(frame.channel!)?.send(frame.body!);
				} else if (frame.type === "close") {
					routes.get(frame.channel!)?.close(frame.code!);
				}
			};
			createdSockets.push(ws);
			queueMicrotask(() => {
				ws.open();
				ws.receive(WELCOME_FRAME);
				ws.receive({ type: "nodes", items: [{ id: node.id, name: "node01", online: true }] });
			});
			return ws;
		};

		client = new NodesClient({
			socketUrl: "ws://pika.test/api/v1/node/connect",
			store,
			label: "Test",
			socket: { create, backoffMs: [50, 100] },
		});
		await client.start();
		await settle();

		// Pair and pin the node so a channel is ready.
		node.allowed.add(client.getSnapshot().fingerprint!);
		client.pair(node.id);
		await settle();
		await client.confirmPin(node.id);
		await settle();
		expect(client.getSnapshot().status).toBe("open");
		expect(client.getSnapshot().nodes[0]?.link.kind).toBe("ready");

		// Start a request that will still be pending when the fatal close arrives.
		const pendingRequest = client.killTerminal(node.id, "t-1");
		await settle();
		expect(heldIds).toHaveLength(1);

		// Trigger a fatal close (4401) from the server.
		createdSockets[0]!.serverClose(4401, "session revoked");

		await expect(pendingRequest).rejects.toSatisfy((error: unknown) => error instanceof ChannelClosed && error.code === "fatal");
		await settle();

		const snapshot = client.getSnapshot();
		expect(snapshot.status).toBe("fatal");
		expect(snapshot.fatalClose).toEqual({ code: 4401, reason: "session revoked" });
		expect(snapshot.failure).toBe("Closed (4401): session revoked");
		expect(snapshot.nodes[0]?.link).toEqual({ kind: "closed", code: "fatal", reason: "session revoked" });

		// Wait past backoff window and ensure no reconnect socket was created.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(createdSockets).toHaveLength(1);
		expect(client.getSnapshot().status).toBe("fatal");
	});
});
