import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { FakeRelay } from "./support/relay-server.ts";
import { Notes, setCredentials, sleep, startSession, texts, waitFor, waitOnline, Workspace, type Harness } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); setCredentials(relay.url); });
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
});

async function online(notes = new Notes()): Promise<Harness> {
	const h = await startSession({ workspace, ui: notes.context() });
	harnesses.push(h);
	await waitOnline(relay, h.session.sessionId);
	return h;
}

it("/relay shows the connection, the server, this session, and the other online sessions", async () => {
	const notes = new Notes();
	const a = await online(notes);
	const b = await online();
	await a.session.prompt("/relay");
	const lines = notes.last!.message.split("\n");
	expect(lines.slice(0, 4)).toEqual(["Relay is online as device laptop.", `Server: ${relay.url}`, `This session: ${a.session.sessionId}`, "Online sessions:"]);
	expect(lines[4]).toMatch(new RegExp(`^  ${b.session.sessionId} · laptop · project project · untitled · idle · relay-test/test · online \\d+s$`));
	expect(lines).toHaveLength(5);
	await b.shutdown();
	await waitFor(() => relay.online(b.session.sessionId) === undefined, 5_000, "b offline");
	await a.session.prompt("/relay status");
	expect(notes.last!.message.split("\n").at(-1)).toBe("No other pi session is online.");
});

it("/relay send sends as the user and reports the outcome", async () => {
	const notes = new Notes();
	const a = await online(notes);
	const b = await online();
	b.faux.setResponses([fauxAssistantMessage("received")]);
	await a.session.prompt(`/relay send ${b.session.sessionId} Please   look at\nthe logs`);
	expect(notes.last).toEqual({ type: "info", message: `Delivered message msg-1 to pi session ${b.session.sessionId} on laptop.` });
	expect(relay.frames(a.session.sessionId, "send")).toEqual([expect.objectContaining({ to: b.session.sessionId, text: "Please   look at\nthe logs", hops: 1 })]);
	await waitFor(() => texts(b.session, "assistant").includes("received"), 5_000, "b's turn");

	await a.session.prompt("/relay send nobody hi");
	expect(notes.last).toEqual({ type: "error", message: "relay rejected the message (unknown_session): no online or recorded pi session has that id; call relay_list for the online sessions." });
	await a.session.prompt("/relay send onlyanid");
	expect(notes.last).toEqual({ type: "error", message: "Usage: /relay send <sessionId> <text>" });
	// The user's commands are not model turns.
	expect(texts(a.session, "assistant")).toEqual([]);
});

it("/relay off disconnects for the session's lifetime and /relay on reconnects", async () => {
	const notes = new Notes();
	const a = await online(notes);
	const id = a.session.sessionId;
	await a.session.prompt("/relay off");
	expect(notes.last).toEqual({ type: "info", message: "Relay is off for this session: it is offline and receives no messages. /relay on reconnects it." });
	await waitFor(() => relay.online(id) === undefined, 5_000, "the disconnect");
	// New credentials do not override /relay off.
	setCredentials(relay.url, { token: "relay-test-token" });
	relay.tokens.add("another");
	setCredentials(relay.url, { token: "another" });
	await sleep(300);
	expect(relay.upgrades).toHaveLength(1);
	await a.session.prompt("/relay");
	expect(notes.last!.message).toBe(`Relay is offline: relay is off for this session (/relay off); /relay on reconnects it.\nServer: ${relay.url}\nThis session: ${id}`);

	await a.session.prompt("/relay on");
	expect(notes.last).toEqual({ type: "info", message: "Relay is on for this session; /relay shows the connection." });
	await waitFor(() => relay.online(id) !== undefined, 5_000, "the reconnect");
	expect(relay.upgrades.at(-1)!.authorization).toBe("Bearer another");
	// /relay on while online keeps the connection.
	await a.session.prompt("/relay on");
	await sleep(200);
	expect(relay.upgrades).toHaveLength(2);
});

it("/relay on says why a session stays offline, and unknown subcommands show the usage", async () => {
	const notes = new Notes();
	setCredentials(undefined);
	const h = await startSession({ workspace, ui: notes.context() });
	harnesses.push(h);
	await h.session.prompt("/relay on");
	expect(notes.last).toEqual({ type: "warning", message: "Relay stays offline: pika is not logged in or is disabled; run /pika login." });
	for (const text of ["/relay bogus", "/relay off now", "/relay status now"]) {
		await h.session.prompt(text);
		expect(notes.last).toEqual({ type: "error", message: "Usage: /relay [status|send <sessionId> <text>|off|on]" });
	}
	const command = h.session.extensionRunner.getCommand("relay")!;
	expect(await command.getArgumentCompletions!("o")).toEqual([{ value: "off", label: "off" }, { value: "on", label: "on" }]);
	// A subcommand typed in full gets no menu, so Enter runs it.
	expect(await command.getArgumentCompletions!("off")).toBeNull();
});
