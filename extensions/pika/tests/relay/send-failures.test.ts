import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { RelayConnection, RequestError } from "../../relay/connection.ts";
import { RELAY_VERSION, timing } from "../../relay/protocol.ts";
import { FakeRelay, TOKEN } from "./support/relay-server.ts";
import { setCredentials, sleep, startSession, waitFor, waitOnline, Workspace, type Harness } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
const connections: RelayConnection[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); setCredentials(relay.url); });
afterEach(async () => {
	for (const connection of connections.splice(0)) connection.close();
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
});

async function online(): Promise<Harness> {
	const h = await startSession({ workspace });
	harnesses.push(h);
	await waitOnline(relay, h.session.sessionId);
	return h;
}

/** A bare connection, online at the fake server. */
async function connect(id = "bare-session"): Promise<RelayConnection> {
	const connection = new RelayConnection({ url: relay.url, token: TOKEN }, {
		hello: () => ({ id, cwd: "/tmp", project: "project", host: "host", state: "idle", relayVersion: RELAY_VERSION }),
		onMessage() {}, onStatus() {}, onChange() {},
	});
	connections.push(connection);
	connection.start();
	await waitFor(() => connection.online, 5_000, "online");
	return connection;
}

const pendingCount = (connection: RelayConnection) => (connection as unknown as { pending: Map<string, unknown> }).pending.size;

/** Results of a tool in the session, in order. */
function results(h: Harness, tool: string): { text: string; isError: boolean }[] {
	return h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === tool).map((message) => {
		const result = message as { content: { type: string; text?: string }[]; isError: boolean };
		return { text: result.content.map((part) => part.text ?? "").join(""), isError: result.isError };
	});
}

function callTool(h: Harness, name: string, args: Parameters<typeof fauxToolCall>[1], after = "done"): void {
	h.faux.appendResponses([fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }), fauxAssistantMessage(after)]);
}

const statusLines = (h: Harness) => results(h, "relay_status").at(-1)!.text.split("\n").map((line) => line.replace(/, sent \d+s ago/, ""));

it("records a message whose connection closed before the server answered as unknown", async () => {
	const a = await online();
	relay.recorded.add("peer");
	relay.onSend = (_frame, connection) => { connection.ws.terminate(); return "none"; };
	callTool(a, "relay_send", { to: "peer", text: "dropped" });
	await a.session.prompt("send");
	expect(results(a, "relay_send")).toEqual([{
		text: "relay_send failed: the relay connection closed before the server answered; the message may or may not have been accepted.", isError: true,
	}]);
	relay.onSend = undefined;
	await waitOnline(relay, a.session.sessionId);

	callTool(a, "relay_room", { action: "send", room: "ops", text: "late" });
	relay.onSend = () => "none";
	timing.sentTimeoutMs = 200;
	await a.session.prompt("post");
	expect(results(a, "relay_room").at(-1)!.isError).toBe(true);

	callTool(a, "relay_status", {});
	await a.session.prompt("status");
	expect(statusLines(a)).toEqual([
		`(no id) to room #ops: unknown (timeout): "late"`,
		`(no id) to pi session peer: unknown (closed): "dropped"`,
	]);
	expect(a.errors).toEqual([]);
});

it("rejects a request at once and leaves nothing pending when the connection is not online", async () => {
	const connection = new RelayConnection({ url: relay.url, token: TOKEN }, { hello: () => { throw new Error("never connects"); }, onMessage() {}, onStatus() {}, onChange() {} });
	connections.push(connection);
	const error = await connection.request({ to: "peer", text: "hi", hops: 1 }).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(RequestError);
	expect(error).toMatchObject({ outcome: "unsent", code: "not_online", message: "the relay connection is not online" });
	expect(pendingCount(connection)).toBe(0);
});

it("rejects promptly when the signal aborts, clearing the pending entry and its timer", async () => {
	const connection = await connect();
	relay.onSend = () => "none";
	timing.sentTimeoutMs = 10_000;

	const controller = new AbortController();
	const request = connection.request({ to: "peer", text: "hi", hops: 1 }, controller.signal);
	await waitFor(() => relay.frames("bare-session", "send").length === 1, 5_000, "the send frame");
	expect(pendingCount(connection)).toBe(1);
	const started = Date.now();
	controller.abort();
	const error = await request.catch((caught: unknown) => caught);
	expect(Date.now() - started).toBeLessThan(500);
	expect(error).toMatchObject({ outcome: "unknown", code: "cancelled" });
	expect(pendingCount(connection)).toBe(0);

	// A signal aborted before the call sends nothing.
	const aborted = await connection.request({ to: "peer", text: "never", hops: 1 }, AbortSignal.abort()).catch((caught: unknown) => caught);
	expect(aborted).toMatchObject({ outcome: "unsent", code: "cancelled" });
	expect(relay.frames("bare-session", "send")).toHaveLength(1);
	expect(pendingCount(connection)).toBe(0);

	// An answered request detaches from its signal: a later abort changes nothing.
	relay.onSend = undefined;
	relay.recorded.add("peer");
	const later = new AbortController();
	const answer = await connection.request({ to: "peer", text: "ok", hops: 1 }, later.signal);
	expect(answer).toMatchObject({ status: "queued" });
	later.abort();
	expect(pendingCount(connection)).toBe(0);
});

it("records an aborted relay_send as unknown (cancelled) without waiting for the sent timeout", async () => {
	const a = await online();
	timing.sentTimeoutMs = 10_000;
	relay.onSend = () => "none";
	callTool(a, "relay_send", { to: "peer", text: "abandoned" });
	const prompt = a.session.prompt("send");
	await waitFor(() => relay.frames(a.session.sessionId, "send").length === 1, 5_000, "the send frame");
	const started = Date.now();
	await a.session.abort();
	await prompt;
	await waitFor(() => results(a, "relay_send").length === 1, 2_000, "the tool result");
	expect(Date.now() - started).toBeLessThan(2_000);
	expect(results(a, "relay_send")[0]).toEqual({
		text: "relay_send failed: the send was cancelled before the server answered; the message may or may not have been accepted.", isError: true,
	});

	// The aborted turn left its follow-up response unused.
	a.faux.setResponses([fauxAssistantMessage([fauxToolCall("relay_status", {})], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	await a.session.prompt("status");
	expect(statusLines(a)).toEqual([`(no id) to pi session peer: unknown (cancelled): "abandoned"`]);
	await sleep(50);
	expect(a.errors).toEqual([]);
});
