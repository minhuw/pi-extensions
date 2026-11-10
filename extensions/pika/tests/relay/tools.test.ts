import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NOTICE_TYPE, timing } from "../../relay/protocol.ts";
import { FakeRelay } from "./support/relay-server.ts";
import { Notes, setCredentials, sleep, startSession, texts, waitFor, waitOnline, Workspace, type Harness } from "./support/runtime.ts";

const ANSWER_HINT = "Any answer arrives as a new [relay] message after your current turn ends, never during it: do not sleep or poll for it. End your turn now, telling your user what you are waiting for if that helps.";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); setCredentials(relay.url); });
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
});

async function online(options: Partial<Parameters<typeof startSession>[0]> = {}): Promise<Harness> {
	const h = await startSession({ workspace, ...options });
	harnesses.push(h);
	await waitOnline(relay, h.session.sessionId);
	return h;
}

/** Results of a tool in the session, in order. */
function results(h: Harness, tool: string): { text: string; isError: boolean }[] {
	return h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === tool).map((message) => {
		const result = message as { content: { type: string; text?: string }[]; isError: boolean };
		return { text: result.content.map((part) => part.text ?? "").join(""), isError: result.isError };
	});
}

/** Makes the model call one tool in its next turn, then answer `after`. */
function callTool(h: Harness, name: string, args: Parameters<typeof fauxToolCall>[1], after = "done"): void {
	h.faux.appendResponses([fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }), fauxAssistantMessage(after)]);
}

it("lists the other online sessions, with filters", async () => {
	const a = await online();
	const b = await online();
	b.faux.setResponses([fauxAssistantMessage("b ready")]);
	await b.session.prompt("Review the parser");
	callTool(a, "relay_list", {});
	callTool(a, "relay_list", { query: "PARSER", project: "project", device: "laptop" });
	callTool(a, "relay_list", { device: "desktop" });
	await a.session.prompt("who is online?");
	await a.session.prompt("find the parser session");
	await a.session.prompt("anyone on the desktop?");
	const line = new RegExp(`^${b.session.sessionId} · laptop · project project · "Review the parser" · idle · relay-test/test · online \\d+s$`);
	const [all, found, none] = results(a, "relay_list");
	expect(all!.text.split("\n")[0]).toBe("1 online pi session:");
	expect(all!.text.split("\n")[1]).toMatch(line);
	expect(found!.text.split("\n")[0]).toBe("1 online pi session matching:");
	expect(found!.text.split("\n")[1]).toMatch(line);
	expect(none).toEqual({ text: "No other pi session is online that matches.", isError: false });
	expect(relay.sessionRequests.every((request) => request.authorization === "Bearer relay-test-token")).toBe(true);
});

it("shows each device by its name, and filters by the device name or id, ignoring case", async () => {
	relay.device = "7f9c2ba4-e88f-4a1b-9a3c-0d2f6e1b5c47";
	relay.deviceName = "Minhu's MacBook Pro";
	const a = await online();
	const b = await online();
	callTool(a, "relay_list", {});
	callTool(a, "relay_list", { device: "minhu's macbook PRO" });
	callTool(a, "relay_list", { device: "7F9C2BA4-E88F-4A1B-9A3C-0D2F6E1B5C47" });
	callTool(a, "relay_list", { device: "Minhu" });
	for (const prompt of ["all", "by name", "by id", "by part of the name"]) await a.session.prompt(prompt);
	const line = new RegExp(`^${b.session.sessionId} · Minhu's MacBook Pro · project project · untitled · idle · relay-test/test · online \\d+s$`);
	const [all, byName, byId, partial] = results(a, "relay_list");
	expect(all!.text.split("\n")[1]).toMatch(line);
	expect(byName!.text.split("\n")).toEqual(["1 online pi session matching:", expect.stringMatching(line)]);
	expect(byId!.text.split("\n")).toEqual(["1 online pi session matching:", expect.stringMatching(line)]);
	expect(partial).toEqual({ text: "No other pi session is online that matches.", isError: false });

	callTool(a, "relay_send", { to: b.session.sessionId, text: "hello" });
	b.faux.setResponses([fauxAssistantMessage("b got it")]);
	await a.session.prompt("send");
	expect(results(a, "relay_send")[0]!.text).toMatch(new RegExp(`^Delivered message msg-1 to pi session ${b.session.sessionId} on Minhu's MacBook Pro\\. `));
	await waitFor(() => texts(b.session, "assistant").includes("b got it"), 5_000, "b's turn");
	const received = b.session.messages.find((message) => message.role === "custom") as { content: string } | undefined;
	expect(received?.content.split("\n")[0]).toBe(`[relay] Message msg-1 from pi session ${a.session.sessionId} ("all") on Minhu's MacBook Pro, project project:`);
});

it("reports every outcome of relay_send and keeps them for relay_status", async () => {
	const a = await online();
	const b = await online();
	const target = b.session.sessionId;
	relay.recorded.add("offline-session");
	timing.sentTimeoutMs = 300;

	// B answers the delivered message with a turn of its own.
	callTool(a, "relay_send", { to: target, text: "Can you check the build?" }, "asked b");
	b.faux.setResponses([fauxAssistantMessage("b got it")]);
	await a.session.prompt("ask b");
	await waitFor(() => texts(b.session, "assistant").includes("b got it"), 5_000, "b's turn");
	expect(results(a, "relay_send")[0]).toEqual({ text: `Delivered message msg-1 to pi session ${target} on laptop. ${ANSWER_HINT}`, isError: false });

	callTool(a, "relay_send", { to: "offline-session", text: "later" });
	await a.session.prompt("queue one");
	expect(results(a, "relay_send")[1]).toEqual({
		text: "Queued message msg-2 for pi session offline-session: it has not been delivered yet. If it is not delivered within 5 minutes it is dropped and you will get a notice. " + ANSWER_HINT,
		isError: false,
	});

	callTool(a, "relay_send", { to: "nobody", text: "hi" });
	callTool(a, "relay_send", { to: a.session.sessionId, text: "me" });
	await a.session.prompt("unknown");
	await a.session.prompt("self");
	expect(results(a, "relay_send")[2]).toEqual({ text: "relay rejected the message (unknown_session): no online or recorded pi session has that id; call relay_list for the online sessions.", isError: true });
	expect(results(a, "relay_send")[3]).toEqual({ text: "relay rejected the message (self): that is this session's own id.", isError: true });

	relay.onSend = () => ({ status: "rejected", reason: "rate_limited" });
	callTool(a, "relay_send", { to: target, text: "spam" });
	await a.session.prompt("rate");
	expect(results(a, "relay_send")[4]).toEqual({ text: "relay rejected the message (rate_limited): this session sent too many messages in the last minute; wait before sending more.", isError: true });

	relay.onSend = () => "none";
	callTool(a, "relay_send", { to: target, text: "lost" });
	await a.session.prompt("timeout");
	expect(results(a, "relay_send")[5]).toEqual({ text: "relay_send failed: the server did not answer within 1 s; the message may or may not have been accepted.", isError: true });
	relay.onSend = undefined;

	callTool(a, "relay_send", { to: target, text: "x".repeat(32 * 1024 + 1) });
	await a.session.prompt("too large");
	expect(results(a, "relay_send")[6]).toEqual({ text: "relay rejected the message (too_large): the text is 32769 bytes, and the limit is 32768.", isError: true });

	callTool(a, "relay_status", {});
	callTool(a, "relay_status", { id: "msg-2" });
	await a.session.prompt("status");
	await a.session.prompt("status of one");
	const [all, one] = results(a, "relay_status");
	expect(all!.text.split("\n").map((line) => line.replace(/, sent \d+s ago/, ""))).toEqual([
		`(no id) to pi session ${target}: rejected (too_large): "${"x".repeat(59)}…"`,
		`(no id) to pi session ${target}: unknown (timeout): "lost"`,
		`(no id) to pi session ${target}: rejected (rate_limited): "spam"`,
		`(no id) to pi session ${a.session.sessionId}: rejected (self): "me"`,
		`(no id) to pi session nobody: rejected (unknown_session): "hi"`,
		`msg-2 to pi session offline-session: queued: "later"`,
		`msg-1 to pi session ${target} on laptop: delivered: "Can you check the build?"`,
	]);
	expect(one!.text).toMatch(/^msg-2 to pi session offline-session: queued, sent \d+s ago: "later"$/);
	expect(a.errors).toEqual([]);
}, 20_000);

it("explains that relay_send needs a connection", async () => {
	const notes = new Notes();
	const a = await online({ ui: notes.context() });
	await a.session.prompt("/relay off");
	callTool(a, "relay_send", { to: "someone", text: "hi" });
	callTool(a, "relay_list", {});
	await a.session.prompt("send");
	await a.session.prompt("list");
	expect(results(a, "relay_send")).toEqual([{ text: "This session is not connected to pika relay: relay is off for this session (/relay off); /relay on reconnects it.", isError: true }]);
	expect(results(a, "relay_list")).toEqual([{ text: "relay is offline in this session: relay is off for this session (/relay off); /relay on reconnects it", isError: true }]);
});

it("wakes the sender with a notice when a message expires, and records delivery silently", async () => {
	const a = await online();
	const id = a.session.sessionId;
	relay.recorded.add("offline-session");
	callTool(a, "relay_send", { to: "offline-session", text: "first" });
	callTool(a, "relay_send", { to: "offline-session", text: "second" });
	await a.session.prompt("send one");
	await a.session.prompt("send two");
	const before = a.sent.length;

	relay.send(id, { type: "status", id: "msg-1", status: "delivered", to: { sessionId: "offline-session", device: "desktop", name: "Docs" }, at: new Date().toISOString() });
	await sleep(300);
	expect(a.sent.length).toBe(before);

	a.faux.appendResponses([fauxAssistantMessage("noted the expiry")]);
	relay.send(id, { type: "status", id: "msg-2", status: "expired", to: { sessionId: "offline-session", device: "desktop", name: "Docs" }, at: new Date().toISOString() });
	await waitFor(() => texts(a.session, "assistant").includes("noted the expiry"), 5_000, "the woken turn");
	expect(a.sent.slice(before)).toEqual([{
		message: {
			customType: NOTICE_TYPE, display: true,
			// The session was idle, so the notice starts a turn after an answer the user has not replied to.
			content: "[relay] Your message msg-2 to pi session offline-session (\"Docs\") on desktop expired: it was not delivered within 5 minutes and was dropped.\n\n"
				+ "Your user has not written since your last answer to them, so do not take that answer as read. If it still holds something they need (a question, a decision, a result), repeat that in full, not as a summary, in the answer that ends this turn, then say what changed since.",
			details: expect.objectContaining({ id: "msg-2", status: "expired" }),
		},
		options: { deliverAs: "steer", triggerTurn: true },
	}]);
	// A repeated status does not notify twice.
	relay.send(id, { type: "status", id: "msg-2", status: "expired", to: { sessionId: "offline-session" }, at: new Date().toISOString() });
	await sleep(300);
	expect(a.sent.length).toBe(before + 1);

	callTool(a, "relay_status", {});
	await a.session.prompt("status");
	expect(results(a, "relay_status")[0]!.text.split("\n").map((line) => line.replace(/, sent \d+s ago/, ""))).toEqual([
		`msg-2 to pi session offline-session ("Docs") on desktop: expired: "second"`,
		`msg-1 to pi session offline-session ("Docs") on desktop: delivered: "first"`,
	]);
	expect(a.errors).toEqual([]);
});

it("counts hops: user turns send 1, turns started by relay messages send one more, and the server's limit stops a chain", async () => {
	const notes = new Notes();
	const a = await online({ ui: notes.context() });
	const id = a.session.sessionId;
	relay.recorded.add("peer");
	const hops = () => relay.frames(id, "send").map((frame) => frame.hops);

	callTool(a, "relay_send", { to: "peer", text: "from the user's turn" });
	await a.session.prompt("tell the peer");
	expect(hops()).toEqual([1]);

	// A message with 3 hops starts a turn that answers with 4.
	callTool(a, "relay_send", { to: "peer", text: "answer", replyTo: "m-3" });
	relay.push(id, { id: "m-3", hops: 3, from: { kind: "session", sessionId: "peer", device: "desktop" } });
	await waitFor(() => hops().length === 2, 5_000, "the answer");
	await waitFor(() => a.session.isStreaming === false, 5_000, "idle");
	expect(hops()).toEqual([1, 4]);
	expect(relay.frames(id, "send")[1]).toMatchObject({ replyTo: "m-3" });

	// A lower count does not lower it within the same run.
	callTool(a, "relay_send", { to: "peer", text: "again" });
	relay.push(id, { id: "m-4", hops: 1, from: { kind: "session", sessionId: "peer", device: "desktop" } });
	await waitFor(() => hops().length === 3, 5_000, "the second answer");
	await waitFor(() => a.session.isStreaming === false, 5_000, "idle");
	expect(hops()).toEqual([1, 4, 4]);

	// The next user prompt starts over, and so does /relay send.
	callTool(a, "relay_send", { to: "peer", text: "user again" });
	await a.session.prompt("tell the peer again");
	await a.session.prompt("/relay send peer hello from the user");
	expect(hops()).toEqual([1, 4, 4, 1, 1]);
	expect(notes.last).toEqual({ type: "info", message: expect.stringMatching(/^Queued message msg-\d+ for pi session peer: /) });

	// At 8 hops the next answer is rejected. The fake server's welcome says maxHops 8, not the default 128, so the error
	// text shows the server's limit.
	callTool(a, "relay_send", { to: "peer", text: "ninth hop" });
	relay.push(id, { id: "m-8", hops: 8, from: { kind: "session", sessionId: "peer", device: "desktop" } });
	await waitFor(() => results(a, "relay_send").length === 5, 5_000, "the rejected answer");
	expect(hops().at(-1)).toBe(9);
	expect(results(a, "relay_send").at(-1)).toEqual({
		text: "relay rejected the message (hop_limit): the message would travel more than 8 hops between sessions without the user; stop relaying and wait for your user.",
		isError: true,
	});
	await waitFor(() => a.session.isStreaming === false, 5_000, "idle");
	expect(a.errors).toEqual([]);
});

it("supports explicit chatrooms: only @mentioned members wake up, and any agent can read history via relay_room", async () => {
	const a = await online();
	const b = await online();
	const c = await online();

	await a.session.prompt("/relay join #auth-sync Coordinate token changes");
	await b.session.prompt("/relay join auth-sync");
	await c.session.prompt("/relay join auth-sync");

	// A posts without @mention: recorded in room history, neither B nor C wakes up.
	callTool(a, "relay_send", { room: "auth-sync", text: "Started backend migration." });
	await a.session.prompt("post status");
	expect(results(a, "relay_send")[0]!.text).toContain("Posted message msg-1 to room #auth-sync (recorded in room history (no @mentions notified)).");
	await sleep(150);
	expect(b.sent).toHaveLength(0);
	expect(c.sent).toHaveLength(0);

	// A posts mentioning B: only B gets a [relay] turn; C stays undisturbed.
	b.faux.setResponses([fauxAssistantMessage("b saw mention")]);
	callTool(a, "relay_send", { room: "auth-sync", text: "Please review the schema.", mentions: [b.session.sessionId] });
	await a.session.prompt("mention b");
	expect(results(a, "relay_send")[1]!.text).toContain(`notified pi session ${b.session.sessionId}`);
	await waitFor(() => texts(b.session, "assistant").includes("b saw mention"), 5_000, "b's woken turn");
	expect(c.sent).toHaveLength(0);

	// C reads the full room history on demand via relay_room.
	callTool(c, "relay_room", { action: "history", room: "auth-sync" });
	await c.session.prompt("read room history");
	const historyText = results(c, "relay_room").at(-1)!.text;
	expect(historyText).toContain("#auth-sync — Coordinate token changes · 2 msgs");
	expect(historyText).toContain("Started backend migration.");
	expect(historyText).toContain("Please review the schema.");
});


it("gives the model no way to join or leave a room: relay_room only lists, reads, and sends", async () => {
	const a = await online();
	const parameters = a.session.extensionRunner.getToolDefinition("relay_room")!.parameters as { properties: Record<string, { anyOf?: { const: string }[] }> };
	expect(parameters.properties.action!.anyOf!.map((option) => option.const)).toEqual(["list", "history", "send"]);
	expect(parameters.properties.topic).toBeUndefined();
	callTool(a, "relay_room", { action: "join", room: "ops" });
	await a.session.prompt("join ops");
	expect(results(a, "relay_room")[0]!.isError).toBe(true);
	expect(relay.rooms.size).toBe(0);
	callTool(a, "relay_room", { action: "list" });
	await a.session.prompt("list rooms");
	expect(results(a, "relay_room")[1]).toEqual({ text: "No active chatrooms; your user creates them with /relay join.", isError: false });
});

it("refuses a post to an unknown room or to a room this session is not a member of, and the server keeps nothing", async () => {
	const a = await online();
	const b = await online();
	relay.addRoom("ops", [b.session.sessionId]);
	callTool(a, "relay_room", { action: "send", room: "nowhere", text: "hello" });
	await a.session.prompt("post to nowhere");
	callTool(a, "relay_send", { room: "ops", text: "hello @all" });
	await a.session.prompt("post to ops");
	expect(results(a, "relay_room")).toEqual([{ text: "relay rejected the message (unknown_room): no such chatroom; your user creates rooms with /relay join.", isError: true }]);
	expect(results(a, "relay_send")).toEqual([{ text: "relay rejected the message (not_member): this session is not a member of that room; only your user can add it, with /relay join <room>.", isError: true }]);
	expect(relay.rooms.has("nowhere")).toBe(false);
	expect([...relay.rooms.get("ops")!.members]).toEqual([b.session.sessionId]);
	expect(relay.rooms.get("ops")!.messages).toEqual([]);
	callTool(a, "relay_status", {});
	await a.session.prompt("status");
	expect(results(a, "relay_status")[0]!.text.split("\n").map((line) => line.replace(/, sent \d+s ago/, ""))).toEqual([
		`(no id) to room #ops: rejected (not_member): "hello @all"`,
		`(no id) to room #nowhere: rejected (unknown_room): "hello"`,
	]);
	await sleep(150);
	expect(b.sent).toHaveLength(0);
	expect(a.errors).toEqual([]);
});

it("says which mentions reached nobody, and never adds a session it mentions to the room", async () => {
	const a = await online();
	const b = await online();
	const c = await online();
	await a.session.prompt("/relay join ops");
	await b.session.prompt("/relay join ops");
	b.faux.setResponses([fauxAssistantMessage("b saw the mention")]);
	callTool(a, "relay_room", { action: "send", room: "ops", text: "@ghost please look", mentions: [b.session.sessionId, c.session.sessionId] });
	await a.session.prompt("post");
	const [posted] = results(a, "relay_room");
	expect(posted!.isError).toBe(false);
	expect(posted!.text).toContain(`notified pi session ${b.session.sessionId}`);
	expect(posted!.text).toContain(`). Mentions that reached nobody (not members): ${c.session.sessionId}, ghost. ${ANSWER_HINT}`);
	await waitFor(() => texts(b.session, "assistant").includes("b saw the mention"), 5_000, "b's turn");
	await sleep(150);
	expect(c.sent).toHaveLength(0);
	expect([...relay.rooms.get("ops")!.members].sort()).toEqual([a.session.sessionId, b.session.sessionId].sort());

	// Every mention matched a member, the sender included: the result names none.
	b.faux.appendResponses([fauxAssistantMessage("b saw the thanks")]);
	callTool(a, "relay_room", { action: "send", room: "ops", text: "thanks @all", mentions: [a.session.sessionId] });
	await a.session.prompt("thank");
	expect(results(a, "relay_room")[1]!.text).not.toContain("reached nobody");
	await waitFor(() => texts(b.session, "assistant").includes("b saw the thanks"), 5_000, "b's second turn");
	expect(a.errors).toEqual([]);
});

it("treats blank or zero placeholder optional arguments as omitted across relay tools", async () => {
	const a = await online();
	const b = await online();
	await a.session.prompt("/relay join ops");
	await b.session.prompt("/relay join ops");

	// Models constrained to emit every schema key pass room: "", replyTo: "", and mentions: [] on 1:1 sends.
	b.faux.setResponses([fauxAssistantMessage("b got direct")]);
	callTool(a, "relay_send", { to: b.session.sessionId, room: "", replyTo: "  ", mentions: [""], urgent: false, text: "direct handoff" });
	await a.session.prompt("send direct");
	expect(results(a, "relay_send")[0]).toEqual({
		text: `Delivered message msg-1 to pi session ${b.session.sessionId} on laptop. ${ANSWER_HINT}`,
		isError: false,
	});
	expect(relay.frames(a.session.sessionId, "send")[0]).toMatchObject({ to: b.session.sessionId, text: "direct handoff", hops: 1 });
	expect(relay.frames(a.session.sessionId, "send")[0]).not.toHaveProperty("room");
	expect(relay.frames(a.session.sessionId, "send")[0]).not.toHaveProperty("replyTo");
	expect(relay.frames(a.session.sessionId, "send")[0]).not.toHaveProperty("mentions");
	await waitFor(() => texts(b.session, "assistant").includes("b got direct"), 5_000, "b's direct turn");

	// `to: "#ops"` still routes to the room when `room` is an empty placeholder.
	callTool(a, "relay_send", { to: "#ops", room: "   ", replyTo: "", mentions: [], urgent: false, text: "room via to" });
	await a.session.prompt("send room via to");
	expect(results(a, "relay_send")[1]!.isError).toBe(false);
	expect(results(a, "relay_send")[1]!.text).toContain("Posted message msg-2 to room #ops");

	// Blank targets on both fields are rejected before hitting the wire.
	const framesBefore = relay.frames(a.session.sessionId, "send").length;
	callTool(a, "relay_send", { to: "  ", room: " # ", text: "nowhere" });
	await a.session.prompt("blank target");
	expect(results(a, "relay_send")[2]).toEqual({
		text: "relay_send requires either `to` (a session id) or `room` (a chatroom name).",
		isError: true,
	});
	expect(relay.frames(a.session.sessionId, "send")).toHaveLength(framesBefore);

	// Zero-filled history limits and blank filters/ids behave like omitted arguments.
	callTool(b, "relay_room", { action: "history", room: "ops", limit: 0, after: 0, mentions: [], replyTo: "", text: "", urgent: false });
	callTool(a, "relay_list", { device: " ", project: "", query: " " });
	callTool(a, "relay_status", { id: " " });
	await b.session.prompt("history");
	await a.session.prompt("list");
	await a.session.prompt("status");
	expect(results(b, "relay_room")[0]!.isError).toBe(false);
	expect(results(b, "relay_room")[0]!.text).toContain("room via to");
	expect(results(a, "relay_list")[0]!.text.split("\n")[0]).toBe("1 online pi session:");
	expect(results(a, "relay_status")[0]!.text).toContain("msg-2 to room #ops: delivered");
});
