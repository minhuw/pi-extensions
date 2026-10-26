import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakeRelay } from "./support/relay-server.ts";
import { setCredentials, sleep, startSession, texts, waitFor, waitOnline, Workspace, type Harness } from "./support/runtime.ts";
import { MESSAGE_TYPE, timing } from "../protocol.ts";

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

const states = (id: string) => relay.frames(id, "state").map(({ type: _type, ...rest }) => rest);

it("sends state on agent_start and agent_end, and when the session name or model changes", async () => {
	let api: ExtensionAPI | undefined;
	const h = await online({ extensions: [(pi) => { api = pi; }] });
	const id = h.session.sessionId;
	h.faux.setResponses([fauxAssistantMessage("done")]);
	await h.session.prompt("Fix the flaky upload test");
	await waitFor(() => states(id).some((state) => state.state === "idle"), 5_000, "idle");
	expect(states(id)).toEqual([{ state: "busy", title: "Fix the flaky upload test" }, { state: "idle" }]);

	api!.setSessionName("Upload fixes");
	await waitFor(() => states(id).length === 3, 5_000, "the name");
	expect(states(id)[2]).toEqual({ name: "Upload fixes", title: "Upload fixes" });

	await h.session.setModel(h.faux.getModel("other")!);
	await waitFor(() => states(id).length === 4, 5_000, "the model");
	expect(states(id)[3]).toEqual({ model: "relay-test/other" });
	expect(relay.online(id)!.session).toMatchObject({ state: "idle", name: "Upload fixes", model: "relay-test/other" });
	expect(h.errors).toEqual([]);
});

it("closes the old connection and connects the new session on /new, fork, and /resume, and closes on shutdown", async () => {
	const h = await online();
	const first = h.session.sessionId;
	h.faux.setResponses([fauxAssistantMessage("one")]);
	await h.session.prompt("first prompt");
	const firstFile = h.session.sessionFile!;

	await h.runtime.newSession();
	const second = h.session.sessionId;
	expect(second).not.toBe(first);
	await waitFor(() => relay.online(second) !== undefined && relay.online(first) === undefined, 5_000, "the new session");

	await h.runtime.switchSession(firstFile);
	await waitFor(() => relay.online(first) !== undefined && relay.online(second) === undefined, 5_000, "the resumed session");

	const prompt = h.session.sessionManager.getEntries().find((entry) => entry.type === "message")!;
	await h.runtime.fork(prompt.id, { position: "at" });
	const forked = h.session.sessionId;
	expect(forked).not.toBe(first);
	await waitFor(() => relay.online(forked) !== undefined && relay.online(first) === undefined, 5_000, "the fork");

	await h.shutdown();
	await waitFor(() => relay.online(forked) === undefined, 5_000, "the shutdown");
	await sleep(300);
	expect(relay.connections.every((connection) => connection.closed)).toBe(true);
	expect(relay.hellos().map((hello) => hello.id)).toEqual([first, second, first, forked]);
	expect(h.errors).toEqual([]);
});

const relaySent = (h: Harness) => h.sent.filter((sent) => sent.message.customType === MESSAGE_TYPE);
const relayTexts = (h: Harness) => relaySent(h).map((sent) => (sent.message.details as { text: string }).text);
/** The connections of a session that passed `hello`, in order. */
const welcomed = (id: string) => relay.connections.filter((connection) => connection.hello?.id === id && connection.welcomed);

it("goes offline while it is being replaced, so a message for it stays queued on the server and never reaches the outgoing session", async () => {
	timing.leaveTimeoutMs = 400;
	let switching = false;
	let forking: (() => void) | undefined;
	const h = await online({
		extensions: [(pi) => {
			pi.on("session_before_switch", () => { switching = true; });
			pi.on("session_before_fork", async () => { await new Promise<void>((resolve) => { forking = resolve; }); });
		}],
	});
	const first = h.session.sessionId;
	// A busy session: pi aborts the run and waits for it before session_shutdown.
	let release!: () => void;
	let started!: () => void;
	const begun = new Promise<void>((resolve) => { started = resolve; });
	h.faux.setResponses([async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); return fauxAssistantMessage("first answer"); }]);
	const prompt = h.session.prompt("work on something");
	await begun;
	const replaced = h.runtime.newSession();
	await waitFor(() => switching, 5_000, "session_before_switch");
	await waitFor(() => welcomed(first)[0]!.closed !== undefined, 5_000, "the closed connection");
	expect(welcomed(first)[0]!.closed!.code).toBe(1000);
	const during = relay.queue(first, { text: "arrived while leaving" });
	release();
	await prompt;
	await replaced;
	const second = h.session.sessionId;
	await waitFor(() => relay.online(second) !== undefined, 5_000, "the new session");
	// Past the leave timeout: session_shutdown cleared it, so the outgoing session never came back.
	await sleep(700);
	expect(welcomed(first)).toHaveLength(1);
	expect(relay.mailbox.has(during)).toBe(true);
	expect(relaySent(h)).toEqual([]);

	// The same holds before a fork, here while another extension's handler still runs.
	h.faux.setResponses([fauxAssistantMessage("two")]);
	await h.session.prompt("second prompt");
	const entry = h.session.sessionManager.getEntries().find((item) => item.type === "message")!;
	const forked = h.runtime.fork(entry.id, { position: "at" });
	await waitFor(() => forking !== undefined, 5_000, "session_before_fork");
	await waitFor(() => relay.online(second) === undefined, 5_000, "the closed connection");
	const forkMessage = relay.queue(second, { text: "arrived while forking" });
	forking!();
	await forked;
	await waitFor(() => relay.online(h.session.sessionId) !== undefined, 5_000, "the fork");
	await sleep(700);
	expect(welcomed(second)).toHaveLength(1);
	expect(relay.mailbox.has(forkMessage)).toBe(true);
	expect(relaySent(h)).toEqual([]);
	expect(h.errors).toEqual([]);
}, 20_000);

it("reconnects within the leave timeout after a fork fails on an unsaved session, then delivers what is still queued", async () => {
	timing.leaveTimeoutMs = 500;
	const h = await online();
	const id = h.session.sessionId;
	// What /clone does before the first reply: the session file does not exist yet.
	const leaf = h.session.sessionManager.getLeafId()!;
	await expect(h.runtime.fork(leaf, { position: "at" })).rejects.toThrow("This session has not been saved yet");
	expect(h.session.sessionId).toBe(id);
	await waitFor(() => relay.online(id) === undefined, 5_000, "the closed connection");
	h.faux.setResponses([fauxAssistantMessage("relay answer")]);
	const queued = relay.queue(id, { text: "sent while it was leaving" });
	const expired = relay.queue(id, { text: "expired while it was leaving" });
	relay.expire(expired);
	const waited = await waitFor(() => welcomed(id).length === 2, 5_000, "the reconnect");
	expect(waited).toBeLessThan(2_000);
	await relay.waitForAck(id, queued);
	await waitFor(() => texts(h.session, "assistant").includes("relay answer"), 5_000, "the queued message's turn");
	await sleep(200);
	// The server's push decides: an expired message is never delivered.
	expect(relayTexts(h)).toEqual(["sent while it was leaving"]);
	expect(relay.acks(id)).toEqual([queued]);
	expect(h.errors).toEqual([]);
});

it("reconnects after a /resume fails because the session's cwd is gone", async () => {
	timing.leaveTimeoutMs = 500;
	const gone = join(workspace.root, "gone");
	await mkdir(gone);
	const other = await startSession({ workspace, cwd: gone, noRelay: true });
	other.faux.setResponses([fauxAssistantMessage("saved")]);
	await other.session.prompt("save this session");
	const file = other.session.sessionFile!;
	await other.shutdown();
	await rm(gone, { recursive: true });

	const h = await online();
	const id = h.session.sessionId;
	await expect(h.runtime.switchSession(file)).rejects.toThrow("Stored session working directory does not exist");
	expect(h.session.sessionId).toBe(id);
	await waitFor(() => relay.online(id) === undefined, 5_000, "the closed connection");
	h.faux.setResponses([fauxAssistantMessage("relay answer")]);
	const queued = relay.queue(id, { text: "still here?" });
	await waitFor(() => welcomed(id).length === 2, 5_000, "the reconnect");
	await relay.waitForAck(id, queued);
	expect(relayTexts(h)).toEqual(["still here?"]);
	expect(h.errors).toEqual([]);
});

it("reconnects after a cancelled replacement at the next user prompt, at /relay, or after the leave timeout", async () => {
	const h = await online({ extensions: [(pi) => { pi.on("session_before_switch", () => ({ cancel: true })); }] });
	const id = h.session.sessionId;
	expect(await h.runtime.newSession()).toEqual({ cancelled: true });
	await waitFor(() => relay.online(id) === undefined, 5_000, "the closed connection");
	const held = relay.queue(id, { text: "held" });
	await sleep(300);
	expect(welcomed(id)).toHaveLength(1);
	// The user's next prompt shows the session is still live.
	h.faux.setResponses([fauxAssistantMessage("prompt answer"), fauxAssistantMessage("relay answer")]);
	await h.session.prompt("still here");
	await relay.waitForAck(id, held);
	await waitFor(() => texts(h.session, "assistant").includes("relay answer"), 5_000, "the held message's turn");
	expect(relayTexts(h)).toEqual(["held"]);

	// So does /relay.
	expect(await h.runtime.newSession()).toEqual({ cancelled: true });
	await waitFor(() => welcomed(id).length === 2 && welcomed(id)[1]!.closed !== undefined, 5_000, "the closed connection");
	const second = relay.queue(id, { text: "held again" });
	h.faux.setResponses([fauxAssistantMessage("second relay answer")]);
	await h.session.prompt("/relay");
	await relay.waitForAck(id, second);
	await waitFor(() => texts(h.session, "assistant").includes("second relay answer"), 5_000, "the second held message's turn");

	// And, with nothing else happening, the leave timeout.
	timing.leaveTimeoutMs = 300;
	expect(await h.runtime.newSession()).toEqual({ cancelled: true });
	await waitFor(() => welcomed(id).length === 3 && welcomed(id)[2]!.closed !== undefined, 5_000, "the closed connection");
	const third = relay.queue(id, { text: "held a third time" });
	h.faux.setResponses([fauxAssistantMessage("third relay answer")]);
	await relay.waitForAck(id, third);
	await waitFor(() => texts(h.session, "assistant").includes("third relay answer"), 5_000, "the third held message's turn");
	expect(relayTexts(h)).toEqual(["held", "held again", "held a third time"]);
	expect(h.errors).toEqual([]);
});

it("keeps relay working after /reload", async () => {
	const h = await online();
	const id = h.session.sessionId;
	await h.session.reload();
	await waitFor(() => relay.connections.length === 2 && relay.connections[1]!.welcomed && relay.connections[0]!.closed !== undefined, 5_000, "the reconnect");
	expect(relay.online(id)).toBe(relay.connections[1]);
	expect(relay.hellos(id)).toHaveLength(2);
	h.faux.setResponses([fauxAssistantMessage("after reload")]);
	const messageId = relay.push(id, { text: "still there?" });
	await relay.waitForAck(id, messageId);
	await waitFor(() => texts(h.session, "assistant").includes("after reload"), 5_000, "the turn");
	expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["relay_list", "relay_send", "relay_status"]));
	expect(h.errors).toEqual([]);
});
