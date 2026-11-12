import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelClosed, NodeChannel, NodeRequestError } from "../src/nodes/channel";
import { generateIdentity, type Identity, type TerminalInfo } from "../src/nodes/contract";
import { clientIdentity, MemoryKeyStore } from "../src/nodes/identity";
import { FakeNode, nodeCrypto, settle } from "./support/fakeNode";

// jsdom has no SubtleCrypto; Node's WebCrypto is what browsers implement.
beforeAll(() => {
	vi.stubGlobal("crypto", nodeCrypto);
});

let client: Identity;
let node: FakeNode;
beforeEach(async () => {
	client = await clientIdentity(new MemoryKeyStore());
	node = await FakeNode.create("node-1");
});

/** Bodies the client sent, by `t`. */
const sentTypes = (fake: FakeNode) =>
	fake.wire.flatMap((item) => (item.from !== "client" ? [] : "body" in item ? [item.body.t as string] : [`close:${item.close}`]));

const terminal: TerminalInfo = { terminalId: "t1", title: "bash", cwd: "/home/me", cols: 80, rows: 24, pid: 42, createdAt: 1, argv: [] };

describe("the client identity", () => {
	it("is a non-extractable P-256 key, kept across loads", async () => {
		const store = new MemoryKeyStore();
		const first = await clientIdentity(store);
		expect(first.privateKey.extractable).toBe(false);
		expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect((await clientIdentity(store)).fingerprint).toBe(first.fingerprint);
	});

	it("refuses a stored extractable key", async () => {
		const store = new MemoryKeyStore();
		store.identity = await generateIdentity({ extractable: true });
		await expect(clientIdentity(store)).rejects.toThrow(/extractable/);
	});
});

describe("a channel to a pinned node", () => {
	it("handshakes, gets welcome, and carries requests and events", async () => {
		node.allowed.add(client.fingerprint);
		node.onMessage = (message, fake) => {
			if (message.type === "term.list") void fake.send({ type: "reply", id: message.id, result: { terminals: [terminal] } });
			if (message.type === "term.kill") void fake.send({ type: "reply", id: message.id, error: { code: "not_found", message: "no such terminal" } });
		};
		const channel = new NodeChannel(node.route(), { identity: client, pinned: await nodeFingerprint(node), label: "Test browser" });
		const events: string[] = [];
		channel.onEvent((event) => events.push(event.type));
		await channel.start();
		await settle();
		expect(channel.state.kind).toBe("ready");
		expect(sentTypes(node)).toEqual(["hs1", "hs3"]);

		await expect(channel.request("term.list", {})).resolves.toEqual({ terminals: [terminal] });
		await expect(channel.request("term.kill", { terminalId: "t9" })).rejects.toBeInstanceOf(NodeRequestError);
		await channel.notify({ type: "term.input", terminalId: "t1", data: "ls\r" });
		await settle();
		expect(node.received.map((message) => message.type)).toEqual(["term.list", "term.kill", "term.input"]);

		await node.send({ type: "term.output", terminalId: "t1", seq: 1, data: "hi" });
		await node.send({ type: "pane.status", terminalId: "t1", status: null });
		await settle();
		expect(events).toEqual(["term.output", "pane.status"]);
	});

	it("rejects open requests when the node closes the channel", async () => {
		node.allowed.add(client.fingerprint);
		const channel = new NodeChannel(node.route(), { identity: client, pinned: await nodeFingerprint(node) });
		await channel.start();
		await settle();
		const reply = channel.request("term.list", {});
		await settle();
		node.closeChannel("client_removed");
		await expect(reply).rejects.toBeInstanceOf(ChannelClosed);
		expect(channel.state).toEqual({ kind: "closed", code: "client_removed" });
	});

	it("fails loudly with node_key_changed and sends nothing after hs1", async () => {
		node.allowed.add(client.fingerprint);
		const impostor = await FakeNode.create("node-1");
		impostor.allowed.add(client.fingerprint);
		const pinned = await nodeFingerprint(node);
		const channel = new NodeChannel(impostor.route(), { identity: client, pinned });
		await channel.start();
		await settle();
		expect(channel.state).toEqual({
			kind: "closed",
			code: "node_key_changed",
			reason: expect.any(String),
			nodeFingerprint: await nodeFingerprint(impostor),
			pinnedFingerprint: pinned,
		});
		expect(sentTypes(impostor)).toEqual(["hs1", "close:node_key_changed"]);
		await expect(channel.request("term.list", {})).rejects.toBeInstanceOf(ChannelClosed);
		await expect(channel.notify({ type: "term.input", terminalId: "t1", data: "x" })).rejects.toBeInstanceOf(ChannelClosed);
		expect(sentTypes(impostor)).toEqual(["hs1", "close:node_key_changed"]);
	});
});

describe("a channel to an unpinned node", () => {
	it("enrols: shows both fingerprints and records the client, sending no record", async () => {
		const channel = new NodeChannel(node.route(), { identity: client });
		await channel.start();
		await settle();
		expect(channel.state).toEqual({ kind: "enrol", clientFingerprint: client.fingerprint, nodeFingerprint: await nodeFingerprint(node) });
		expect(node.pendingEnrolments).toEqual([client.fingerprint]);
		expect(sentTypes(node)).toEqual(["hs1", "hs3"]);
		await expect(channel.request("term.list", {})).rejects.toBeInstanceOf(ChannelClosed);
		expect(sentTypes(node)).toEqual(["hs1", "hs3"]);
	});

	it("asks for confirmation when the node already allows the client, and never sends an inner message", async () => {
		node.allowed.add(client.fingerprint);
		const channel = new NodeChannel(node.route(), { identity: client });
		await channel.start();
		await settle();
		expect(channel.state).toMatchObject({ kind: "confirm", nodeFingerprint: await nodeFingerprint(node), welcome: { node: "node-1" } });
		await expect(channel.request("term.list", {})).rejects.toBeInstanceOf(ChannelClosed);
		await expect(channel.notify({ type: "pane.seen", terminalId: "t1" })).rejects.toBeInstanceOf(ChannelClosed);
		// Events from the node do nothing either.
		const events: string[] = [];
		channel.onEvent((event) => events.push(event.type));
		await node.send({ type: "term.output", terminalId: "t1", seq: 1, data: "x" });
		await settle();
		expect(events).toEqual([]);
		expect(sentTypes(node)).toEqual(["hs1", "hs3"]);
		expect(node.received).toEqual([]);
	});
});

describe("a broken channel", () => {
	it("closes with protocol_error on an inner message that fails its spec", async () => {
		node.allowed.add(client.fingerprint);
		const channel = new NodeChannel(node.route(), { identity: client, pinned: await nodeFingerprint(node) });
		await channel.start();
		await settle();
		await node.send({ type: "term.output", terminalId: "t1", seq: 0, data: "x" });
		await settle();
		expect(channel.state).toMatchObject({ kind: "closed", code: "protocol_error" });
		expect(sentTypes(node).at(-1)).toBe("close:protocol_error");
	});

	it("closes with handshake_timeout when the node never answers", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const route = node.route();
			route.send = () => {};
			const channel = new NodeChannel(route, { identity: client, pinned: "0".repeat(64) });
			await channel.start();
			vi.advanceTimersByTime(10_000);
			expect(channel.state).toEqual({ kind: "closed", code: "handshake_timeout" });
		} finally {
			vi.useRealTimers();
		}
	});
});

async function nodeFingerprint(fake: FakeNode): Promise<string> {
	return fake.identity.fingerprint;
}
