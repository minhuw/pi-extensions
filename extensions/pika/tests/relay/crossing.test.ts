import { afterEach, beforeEach, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MESSAGE_TYPE, timing } from "../../relay/protocol.ts";
import { SENT_TYPE } from "../../relay/viewer.ts";
import { FakeRelay } from "./support/relay-server.ts";
import { setCredentials, sleep, startSession, texts, waitFor, waitOnline, Workspace, type Harness } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); setCredentials(relay.url); relay.recorded.add("peer"); });
afterEach(async () => {
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

const PEER = { kind: "session", sessionId: "peer", device: "desktop", name: "Peer" };
const STEER = { deliverAs: "steer", triggerTurn: true };
const FOLLOW_UP = { deliverAs: "followUp", triggerTurn: true };

/** What every model request held, serialized, in order. */
let requests: string[];
beforeEach(() => { requests = []; });
const answer = (message: AssistantMessage): FauxResponseFactory => (context) => { requests.push(JSON.stringify(context.messages)); return message; };
const send = (args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall("relay_send", args)], { stopReason: "toolUse" });

/** A response that waits for `release`, so the session stays busy inside that model call meanwhile. */
function held(message: AssistantMessage): { step: FauxResponseFactory; release(): void; started: Promise<void> } {
	let release!: () => void;
	let started!: () => void;
	const released = new Promise<void>((resolve) => { release = resolve; });
	const begun = new Promise<void>((resolve) => { started = resolve; });
	return { step: async (context) => { requests.push(JSON.stringify(context.messages)); started(); await released; return message; }, release, started: begun };
}

/** How relay handed each message to pi, by message id. */
const deliveries = (h: Harness) => h.sent.filter((sent) => sent.message.customType === MESSAGE_TYPE)
	.map((sent) => [(sent.message.details as { id: string }).id, sent.options]);
const results = (h: Harness) => h.session.messages.filter((message) => message.role === "toolResult" && message.toolName === "relay_send").map((message) => {
	const result = message as { content: { type: string; text?: string }[]; isError: boolean };
	return { text: result.content.map((part) => part.text ?? "").join(""), isError: result.isError };
});
const sentTexts = (h: Harness) => relay.frames(h.session.sessionId, "send").map((frame) => frame.text);

it("steers into a busy turn the messages of a session it sent to, and queues a stranger's after the turn", async () => {
	const h = await online();
	const id = h.session.sessionId;
	h.faux.setResponses([send({ to: "peer", text: "Can you check the build?" }), fauxAssistantMessage("asked")]);
	await h.session.prompt("ask the peer");

	const busy = held(fauxAssistantMessage("first answer"));
	h.faux.setResponses([busy.step, answer(fauxAssistantMessage("second answer")), answer(fauxAssistantMessage("third answer"))]);
	const prompt = h.session.prompt("work on something");
	await busy.started;
	const fromPeer = relay.push(id, { from: PEER, text: "the build is green" });
	const fromStranger = relay.push(id, { text: "unrelated news" });
	await relay.waitForAck(id, fromStranger);
	expect(deliveries(h)).toEqual([[fromPeer, STEER], [fromStranger, FOLLOW_UP]]);
	busy.release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("third answer"), 5_000, "the follow-up turn");
	// The peer's message reached the model's next call inside the turn; the stranger's only after it.
	const [, second, third] = requests.slice(-3);
	expect(second).toContain(`[relay] Message ${fromPeer}`);
	expect(second).not.toContain(`[relay] Message ${fromStranger}`);
	expect(third).toContain(`[relay] Message ${fromStranger}`);
	expect(h.errors).toEqual([]);
});

it("talks with a session or room whose message the model read, until timing.conversationMs passes", async () => {
	const h = await online();
	const id = h.session.sessionId;
	h.faux.setResponses([fauxAssistantMessage("read the peer"), fauxAssistantMessage("read the room")]);
	const direct = relay.push(id, { from: PEER, text: "hello" });
	await waitFor(() => texts(h.session, "assistant").includes("read the peer"), 5_000, "the peer's turn");
	await h.session.waitForIdle();
	const room = relay.push(id, { room: "ops", from: { ...PEER, sessionId: "first-member" }, text: "standup" });
	await waitFor(() => texts(h.session, "assistant").includes("read the room"), 5_000, "the room's turn");
	await h.session.waitForIdle();

	const busy = held(fauxAssistantMessage("busy"));
	// Steered messages may come one model call each.
	h.faux.setResponses([busy.step, fauxAssistantMessage("after the steers"), fauxAssistantMessage("after the second steer")]);
	const prompt = h.session.prompt("work on something");
	await busy.started;
	// A room is one conversation, whoever in it writes.
	const again = relay.push(id, { from: PEER, text: "one more thing" });
	const inRoom = relay.push(id, { room: "ops", from: { ...PEER, sessionId: "second-member" }, text: "blocked on review" });
	await relay.waitForAck(id, inRoom);
	busy.release();
	await prompt;
	await h.session.waitForIdle();

	timing.conversationMs = 100;
	await sleep(150);
	const later = held(fauxAssistantMessage("busy again"));
	h.faux.setResponses([later.step, fauxAssistantMessage("after the queue")]);
	const next = h.session.prompt("more work");
	await later.started;
	const stale = relay.push(id, { from: PEER, text: "much later" });
	await relay.waitForAck(id, stale);
	later.release();
	await next;
	await waitFor(() => texts(h.session, "assistant").includes("after the queue"), 5_000, "the queued turn");
	expect(deliveries(h)).toEqual([[direct, { triggerTurn: true }], [room, { triggerTurn: true }], [again, STEER], [inRoom, STEER], [stale, FOLLOW_UP]]);
	expect(h.errors).toEqual([]);
});

it("refuses once a send that would cross the peer's steered message, which the model reads right after the refusal", async () => {
	const h = await online();
	const id = h.session.sessionId;
	h.faux.setResponses([send({ to: "peer", text: "Can you check the build?" }), fauxAssistantMessage("asked")]);
	await h.session.prompt("ask the peer");

	const draft = held(send({ to: "peer", text: "Still waiting on the build." }));
	h.faux.setResponses([draft.step, answer(send({ to: "peer", text: "Thanks, merging now." })), fauxAssistantMessage("done")]);
	const prompt = h.session.prompt("follow up with the peer");
	await draft.started;
	const reply = relay.push(id, { from: PEER, text: "the build is green" });
	await relay.waitForAck(id, reply);
	draft.release();
	await prompt;
	expect(deliveries(h)).toEqual([[reply, STEER]]);
	expect(results(h).slice(1).map((result) => ({ ...result, text: result.text.split(". Any answer")[0] }))).toEqual([
		{
			text: `Not sent: message ${reply} from pi session peer ("Peer") on desktop arrived while you were writing yours, and you have not read it yet. It follows this result: read it, then send again if your message still adds something.`,
			isError: true,
		},
		{ text: expect.stringMatching(/^Queued message msg-\d+ for pi session peer: /), isError: false },
	]);
	// The model saw the refusal and then the message before it wrote the second send.
	const after = requests.at(-1)!;
	expect(after.indexOf("Not sent:")).toBeGreaterThan(-1);
	expect(after.indexOf(`[relay] Message ${reply}`)).toBeGreaterThan(after.indexOf("Not sent:"));
	expect(sentTexts(h)).toEqual(["Can you check the build?", "Thanks, merging now."]);
	// The refused draft never reached the server, so the branch records no relay-sent entry for it.
	const recorded = h.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SENT_TYPE);
	expect(recorded.map((entry) => (entry as { data?: { text?: string } }).data?.text)).toEqual(["Can you check the build?", "Thanks, merging now."]);
	expect(h.errors).toEqual([]);
});

it("refuses once per message a send to a peer whose message waits for the turn's end, and keeps later messages behind it", async () => {
	const h = await online();
	const id = h.session.sessionId;
	const first = held(send({ to: "peer", text: "first try" }));
	const second = held(send({ to: "peer", text: "second try" }));
	h.faux.setResponses([
		first.step, second.step, send({ to: "peer", text: "third try" }), fauxAssistantMessage("done"),
		answer(fauxAssistantMessage("read them")), answer(fauxAssistantMessage("read the rest")),
	]);
	const prompt = h.session.prompt("message the peer");
	await first.started;
	// Not talking with the peer yet: the message waits for the turn's end.
	const early = relay.push(id, { from: PEER, text: "early news" });
	await relay.waitForAck(id, early);
	first.release();
	await second.started;
	// Talking with it now, but this one stays behind the waiting one.
	const later = relay.push(id, { from: PEER, text: "later news" });
	await relay.waitForAck(id, later);
	second.release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("read them"), 5_000, "the follow-up turn");
	await h.session.waitForIdle();
	expect(deliveries(h)).toEqual([[early, FOLLOW_UP], [later, FOLLOW_UP]]);
	const waits = (messageId: string) => `Not sent: message ${messageId} from pi session peer ("Peer") on desktop waits for you until your current turn ends. End your turn now to read it, then reply if your message still adds something.`;
	expect(results(h)).toEqual([
		{ text: waits(early), isError: true },
		{ text: waits(later), isError: true },
		{ text: expect.stringMatching(/^Queued message msg-\d+ for pi session peer: /), isError: false },
	]);
	expect(sentTexts(h)).toEqual(["third try"]);
	const relayed = h.session.messages.filter((message) => message.role === "custom" && (message as { customType?: string }).customType === MESSAGE_TYPE);
	expect(relayed.map((message) => (message as { details?: { id?: string } }).details?.id)).toEqual([early, later]);
	expect(h.errors).toEqual([]);
});

it("forgets the unread messages a cleared queue dropped, so the next send goes through", async () => {
	const h = await online();
	const id = h.session.sessionId;
	const busy = held(fauxAssistantMessage("first answer"));
	h.faux.setResponses([busy.step]);
	const prompt = h.session.prompt("work on something");
	await busy.started;
	const dropped = relay.push(id, { from: PEER, text: "lost in the queue" });
	await relay.waitForAck(id, dropped);
	h.session.clearQueue();
	busy.release();
	await prompt;
	await h.session.waitForIdle();

	h.faux.setResponses([send({ to: "peer", text: "anything new?" }), fauxAssistantMessage("asked")]);
	await h.session.prompt("ask the peer");
	expect(results(h)).toEqual([{ text: expect.stringMatching(/^Queued message msg-\d+ for pi session peer: /), isError: false }]);
	expect(sentTexts(h)).toEqual(["anything new?"]);
	expect(h.errors).toEqual([]);
});
