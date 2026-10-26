import type { Socket } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { RelayConnection } from "../connection.ts";
import { timing } from "../protocol.ts";
import { FakeRelay, TOKEN } from "./support/relay-server.ts";
import { Notes, relayStatus, setCredentials, sleep, startSession, waitFor, waitOnline, Workspace, type Harness } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => {
	workspace = await Workspace.create();
	relay = await new FakeRelay().start();
	Object.assign(timing, { backoffBaseMs: 100, backoffMaxMs: 800 });
});
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
});

async function open(notes = new Notes()): Promise<Harness> {
	const h = await startSession({ workspace, ui: notes.context() });
	harnesses.push(h);
	return h;
}

it("schedules reconnects with doubling, jittered delays up to the maximum", async () => {
	// Nothing listens at this URL, so every attempt fails at the health check.
	const closed = await new FakeRelay().start();
	const url = closed.url;
	await closed.stop();
	const delays: number[] = [];
	const connection = new RelayConnection({ url, token: TOKEN }, {
		hello: () => { throw new Error("never connects"); }, onMessage() {}, onStatus() {},
		onChange: (state) => { if (state.kind === "retrying") delays.push(state.at - Date.now()); },
	});
	connection.start();
	try {
		await waitFor(() => delays.length >= 6, 10_000, "six retries");
	} finally { connection.close(); }
	const bases = [100, 200, 400, 800, 800, 800];
	for (const [index, delay] of delays.slice(0, 6).entries()) {
		expect(delay, `delay ${index + 1} of ${delays.join(", ")}`).toBeGreaterThanOrEqual(bases[index]! * (1 - timing.jitter) - 2);
		expect(delay, `delay ${index + 1} of ${delays.join(", ")}`).toBeLessThanOrEqual(Math.min(800, bases[index]! * (1 + timing.jitter)) + 2);
	}
	expect(connection.state).toEqual({ kind: "closed" });
}, 20_000);

it("keeps reconnecting while the server refuses the hello with a transient code", async () => {
	relay.onHello = () => 1011;
	setCredentials(relay.url);
	await open();
	await waitFor(() => relay.upgrades.length >= 4, 10_000, "four attempts");
});

it.each([
	{ code: 4401, reason: "the server revoked this device's token" },
	{ code: 4403, reason: "this session id belongs to another device" },
	{ code: 4409, reason: "this session is already online from another device" },
	{ code: 4410, reason: "another pi process took over this session" },
	{ code: 4503, reason: "relay was turned off on the server" },
])("stops after close code $code until /relay on or new credentials", async ({ code, reason }) => {
	const notes = new Notes();
	let refuse = true;
	relay.onHello = () => refuse ? code : undefined;
	setCredentials(relay.url);
	const h = await open(notes);
	await waitFor(() => relay.connections.length === 1 && relay.connections[0]!.closed !== undefined, 5_000, "the close");
	await sleep(600);
	expect(relay.upgrades).toHaveLength(1);
	await h.session.prompt("/relay");
	expect(notes.last!.message.split("\n")[0]).toBe(`Relay is offline: ${reason} (close code ${code}); /relay on retries.`);

	await h.session.prompt("/relay on");
	await waitFor(() => relay.upgrades.length === 2, 5_000, "the retry");
	await waitFor(() => relay.connections[1]?.closed !== undefined, 5_000, "the second close");

	refuse = false;
	setCredentials(relay.url, { token: "relay-test-token" });
	await sleep(300);
	expect(relay.upgrades).toHaveLength(2);
	relay.tokens.add("new-token");
	setCredentials(relay.url, { token: "new-token" });
	await waitFor(() => relay.online(h.session.sessionId) !== undefined, 5_000, "the new credentials");
	expect(relay.upgrades.at(-1)!.authorization).toBe("Bearer new-token");
	expect(h.errors).toEqual([]);
});

it("keeps reconnecting after other close codes, such as 4429", async () => {
	setCredentials(relay.url);
	const h = await open();
	const id = h.session.sessionId;
	await waitFor(() => relay.online(id) !== undefined, 5_000, "welcome");
	relay.close(id, 4429);
	await waitFor(() => relay.connections.length === 2 && relay.connections[1]!.welcomed, 5_000, "the reconnect");
});

it("stops after another pi process takes over the session, until /relay on takes it back", async () => {
	setCredentials(relay.url);
	const notesA = new Notes();
	const notesB = new Notes();
	const a = await open(notesA);
	const id = a.session.sessionId;
	await waitOnline(relay, id);
	// pi writes the session file with the first answer.
	a.faux.setResponses([fauxAssistantMessage("saved")]);
	await a.session.prompt("save the session");
	// A second pi process opens the same session file.
	const b = await startSession({ workspace, ui: notesB.context(), sessionManager: SessionManager.open(a.session.sessionFile!, workspace.sessionDir) });
	harnesses.push(b);
	expect(b.session.sessionId).toBe(id);
	await waitFor(() => relay.connections.length === 2 && relay.connections[1]!.welcomed && relay.connections[0]!.closed?.code === 4410, 5_000, "the takeover");
	await sleep(600);
	// Neither process keeps replacing the other.
	expect(relay.upgrades).toHaveLength(2);
	await a.session.prompt("/relay");
	expect(notesA.last!.message.split("\n")[0]).toBe("Relay is offline: another pi process took over this session (close code 4410); /relay on retries.");
	await b.session.prompt("/relay");
	expect(notesB.last!.message.split("\n")[0]).toBe("Relay is online as device laptop.");
	// Only the process holding the session receives its messages.
	b.faux.setResponses([fauxAssistantMessage("b got it")]);
	const messageId = relay.push(id, { text: "for whoever holds it" });
	await relay.waitForAck(id, messageId);
	expect(relay.connections[1]!.frames.filter((frame) => frame.type === "ack")).toHaveLength(1);
	expect(a.sent).toEqual([]);
	expect(b.sent).toHaveLength(1);

	await a.session.prompt("/relay on");
	await waitFor(() => relay.connections.length === 3 && relay.connections[2]!.welcomed && relay.connections[1]!.closed?.code === 4410, 5_000, "the takeback");
	await sleep(600);
	expect(relay.upgrades).toHaveLength(3);
	await b.session.prompt("/relay");
	expect(notesB.last!.message.split("\n")[0]).toBe("Relay is offline: another pi process took over this session (close code 4410); /relay on retries.");
	expect([a.errors, b.errors]).toEqual([[], []]);
});

it("keeps its own reconnect online when the abandoned socket later receives 4410", async () => {
	timing.deadAfterMs = 500;
	setCredentials(relay.url);
	const h = await open();
	const id = h.session.sessionId;
	await waitOnline(relay, id);
	const first = relay.online(id)!;
	// The server stops reading the first socket, so it misses the client's close and still holds the
	// session there when the reconnect's hello arrives; it answers with 4410 on that old socket.
	(first.ws as unknown as { _socket: Socket })._socket.pause();
	await waitFor(() => relay.connections.length === 2 && relay.connections[1]!.welcomed, 5_000, "the reconnect");
	expect(first.closed).toBeUndefined();
	(first.ws as unknown as { _socket: Socket })._socket.resume();
	await waitFor(() => first.closed !== undefined, 5_000, "the old socket to close");
	// Pings keep the new connection alive past the liveness limit.
	for (let i = 0; i < 6; i++) {
		relay.send(id, { type: "ping", at: new Date().toISOString() });
		await sleep(150);
	}
	expect(relayStatus(id)).toBe("online");
	expect(relay.online(id)).toBe(relay.connections[1]);
	expect(relay.upgrades).toHaveLength(2);
	expect(h.errors).toEqual([]);
});

it("answers ping with pong and treats a silent connection as dead", async () => {
	timing.deadAfterMs = 400;
	setCredentials(relay.url);
	const h = await open();
	const id = h.session.sessionId;
	await waitFor(() => relay.online(id) !== undefined, 5_000, "welcome");
	const first = relay.online(id)!;
	// Pings keep it alive past the limit.
	for (let i = 0; i < 6; i++) {
		relay.send(id, { type: "ping", at: new Date().toISOString() });
		await sleep(150);
	}
	expect(first.frames.filter((frame) => frame.type === "pong")).toHaveLength(6);
	expect(relay.connections).toHaveLength(1);
	// Silence is a dead connection: the extension closes it and connects again.
	await waitFor(() => relay.connections.length === 2 && relay.connections[1]!.welcomed, 5_000, "the reconnect");
	await waitFor(() => first.closed !== undefined, 5_000, "the dead connection to close");
});

it("stops when the server refuses the upgrade for the token", async () => {
	const notes = new Notes();
	setCredentials(relay.url, { token: "unknown-token" });
	const h = await open(notes);
	await waitFor(() => relay.sessionRequests.length === 1, 5_000, "the token check");
	// Node's WebSocket may repeat a refused upgrade request itself; relay makes no further attempt.
	const attempts = relay.upgrades.length;
	await sleep(600);
	expect(relay.upgrades).toHaveLength(attempts);
	expect(relay.sessionRequests).toHaveLength(1);
	await h.session.prompt("/relay");
	expect(notes.last!.message.split("\n")[0]).toBe("Relay is offline: the server rejected this device's token (HTTP 401); run /pika login again; /relay on retries.");
});
