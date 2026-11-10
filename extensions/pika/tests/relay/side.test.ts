import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRelaySettings } from "../../config.ts";
import { MESSAGE_TYPE, timing } from "../../relay/protocol.ts";
import { parseSide, SIDE_TYPE } from "../../relay/side.ts";
import { FakeRelay } from "./support/relay-server.ts";
import { Notes, setCredentials, sleep, startSession, texts, waitFor, waitOnline, Workspace, type Harness } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => {
	workspace = await Workspace.create();
	relay = await new FakeRelay().start();
	setCredentials(relay.url);
	relay.recorded.add("sender-session");
	relay.recorded.add("peer");
});
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
});

const settings = (relaySettings: Record<string, unknown>) => writeFile(join(workspace.agentDir, "pika.json"), JSON.stringify({ relay: relaySettings }));

async function online(options: Partial<Parameters<typeof startSession>[0]> = {}): Promise<Harness> {
	const h = await startSession({ workspace, ...options });
	harnesses.push(h);
	await waitOnline(relay, h.session.sessionId);
	return h;
}

const PEER = { kind: "session", sessionId: "peer", device: "desktop", name: "Peer" };
const FOLLOW_UP = { deliverAs: "followUp", triggerTurn: true };
const STEER = { deliverAs: "steer", triggerTurn: true };
const SIDE_REQUEST = "[relay side request]";

/** Every model request: its messages and options, in order. */
let requests: { messages: Message[]; options: Record<string, unknown> | undefined }[];
beforeEach(() => { requests = []; });
const record: (respond: (messages: Message[]) => AssistantMessage | Promise<AssistantMessage>) => FauxResponseFactory = (respond) => (context, options) => {
	requests.push({ messages: structuredClone(context.messages), options: options as Record<string, unknown> | undefined });
	return respond(context.messages);
};
const reply = (message: AssistantMessage | string): FauxResponseFactory => record(() => typeof message === "string" ? fauxAssistantMessage(message) : message);
const noted = (h: Harness) => () => h.sent.some((sent) => sent.message.customType === SIDE_TYPE);
const sideRequests = () => requests.filter((request) => JSON.stringify(request.messages.at(-1)).includes(SIDE_REQUEST));

/** A response that waits for `release`, so the session stays busy inside that model call meanwhile. */
function held(message: AssistantMessage | string): { step: FauxResponseFactory; release(): void; started: Promise<void> } {
	let release!: () => void;
	let started!: () => void;
	const released = new Promise<void>((resolve) => { release = resolve; });
	const begun = new Promise<void>((resolve) => { started = resolve; });
	return {
		step: record(async () => { started(); await released; return typeof message === "string" ? fauxAssistantMessage(message) : message; }),
		release, started: begun,
	};
}

const textOf = (message: Message | undefined) => {
	const content = (message as { content?: unknown } | undefined)?.content;
	return typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
};

it("answers a message a busy turn leaves unread from the turn's last request, and steers the answer into the turn", async () => {
	await settings({ sideAnswerSeconds: 0.05 });
	const h = await online();
	const id = h.session.sessionId;
	const busy = held("first answer");
	h.faux.setResponses([busy.step, reply("The build went green at 10:02."), reply("after the note"), reply("after the message")]);
	const prompt = h.session.prompt("work on something");
	await busy.started;
	const message = relay.push(id, { text: "Is the build green?" });
	await waitFor(noted(h), 5_000, "the side answer");

	const [main, side] = requests;
	expect(side!.options).toMatchObject({ sessionId: id });
	// Changing tool_choice would lose the cached messages; the request's tool calls are never run instead.
	expect(side!.options?.toolChoice).toBeUndefined();
	expect(main!.options?.toolChoice).toBeUndefined();
	// The side request repeats the turn's request, so it reads its cached prefix.
	expect(side!.messages.slice(0, main!.messages.length)).toEqual(main!.messages);
	expect(side!.messages).toHaveLength(main!.messages.length + 1);
	const question = textOf(side!.messages.at(-1));
	expect(question).toContain(`${SIDE_REQUEST} Your current turn is still working.`);
	expect(question).toContain(`Message ${message} from pi session sender-session ("Sender") on desktop, project elsewhere, received`);
	expect(question).toContain("Is the build green?");
	const routed = relay.routed.find((item) => item.replyTo === message)!;
	expect(routed).toMatchObject({ to: "sender-session", hops: 2 });
	expect(routed.text).toMatch(/^\[side answer\] This session's current turn is still running, /);
	expect(routed.text.endsWith("\n\nThe build went green at 10:02.")).toBe(true);

	busy.release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("after the message"), 5_000, "the follow-up turn");
	expect(h.sent.map((sent) => [sent.message.customType, sent.options])).toEqual([[MESSAGE_TYPE, FOLLOW_UP], [SIDE_TYPE, STEER]]);
	// The turn reads what the side request answered, then the message itself after the turn.
	const noteRequest = JSON.stringify(requests.at(-2)!.messages);
	expect(noteRequest).toContain(`[relay] While this turn ran, a side request answered message ${message} from pi session sender-session (\\"Sender\\") on desktop for you`);
	expect(noteRequest).toContain("Is the build green?");
	expect(noteRequest).toContain("The build went green at 10:02.");
	expect(noteRequest).not.toContain(`[relay] Message ${message}`);
	expect(JSON.stringify(requests.at(-1)!.messages)).toContain(`[relay] Message ${message}`);
	expect(h.errors).toEqual([]);
});

it("gives a running tool call a placeholder result, and sends a busy notice when the side request defers", async () => {
	await settings({ sideAnswerSeconds: 0.05 });
	let release!: () => void;
	let started!: () => void;
	const released = new Promise<void>((resolve) => { release = resolve; });
	const running = new Promise<void>((resolve) => { started = resolve; });
	const slow = (pi: ExtensionAPI) => pi.registerTool({
		name: "slow", label: "Slow", description: "Runs until the test releases it.", parameters: Type.Object({}),
		async execute() { started(); await released; return { content: [{ type: "text", text: "slow done" }], details: undefined }; },
	});
	const h = await online({ extensions: [slow] });
	h.faux.setResponses([
		reply(fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call-slow" })], { stopReason: "toolUse" })),
		reply("DEFER: the answer needs the result of the slow tool"),
		reply("finished"),
		reply("read the message"),
	]);
	const prompt = h.session.prompt("run the slow tool");
	await running;
	const message = relay.push(h.session.sessionId, { text: "What did the slow tool find?" });
	await waitFor(() => relay.routed.some((routed) => routed.replyTo === message), 5_000, "the busy notice");

	const side = sideRequests()[0]!.messages;
	expect(side.at(-3)).toMatchObject({ role: "assistant", content: [expect.objectContaining({ type: "toolCall", id: "call-slow" })] });
	expect(side.at(-2)).toMatchObject({ role: "toolResult", toolCallId: "call-slow", toolName: "slow", isError: false });
	expect(textOf(side.at(-2))).toMatch(/^This tool call is still running \(for \d+s\); its result is not available yet\.$/);
	const notice = relay.routed.find((routed) => routed.replyTo === message)!.text;
	expect(notice).toMatch(new RegExp(`^\\[busy notice\\] This session has not read your message ${message} yet: its current turn has run for \\d+s, and it has been running slow for \\d+s\\. `
		+ "It reads your message when that turn ends\\. It could not answer from its conversation so far: the answer needs the result of the slow tool$"));

	release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("read the message"), 5_000, "the follow-up turn");
	expect(h.sent.map((sent) => sent.message.customType)).toEqual([MESSAGE_TYPE]);
	expect(h.errors).toEqual([]);
});

it("never runs a tool call the side request returns, and sends a busy notice for it", async () => {
	await settings({ sideAnswerSeconds: 0.05 });
	let calls = 0;
	const probe = (pi: ExtensionAPI) => pi.registerTool({
		name: "probe", label: "Probe", description: "Counts its calls.", parameters: Type.Object({}),
		async execute() { calls++; return { content: [{ type: "text", text: "probed" }], details: undefined }; },
	});
	const h = await online({ extensions: [probe] });
	const busy = held("first answer");
	h.faux.setResponses([busy.step, reply(fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" })), reply("after the message")]);
	const prompt = h.session.prompt("work on something");
	await busy.started;
	const message = relay.push(h.session.sessionId, { from: PEER, text: "probe it" });
	await waitFor(() => relay.routed.some((routed) => routed.replyTo === message), 5_000, "the busy notice");
	expect(relay.routed.find((routed) => routed.replyTo === message)!.text).toMatch(/^\[busy notice\] .* It could not answer from its conversation so far: the answer needs tool calls$/);
	busy.release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("after the message"), 5_000, "the follow-up turn");
	expect(calls).toBe(0);
	expect(h.errors).toEqual([]);
});

it("sends nothing for NO_REPLY, and never side-answers a side answer, a busy notice, or the web UI", async () => {
	await settings({ sideAnswerSeconds: 0.05 });
	const h = await online();
	const id = h.session.sessionId;
	const busy = held("first answer");
	h.faux.setResponses([busy.step, reply("NO_REPLY"), reply("after the messages")]);
	const prompt = h.session.prompt("work on something");
	await busy.started;
	relay.push(id, { from: PEER, text: "[side answer] The build is green." });
	relay.push(id, { from: PEER, text: "[busy notice] This session has not read your message yet." });
	relay.push(id, { from: { kind: "web" }, text: "from your user" });
	const thanks = relay.push(id, { from: PEER, text: "thanks, nothing else" });
	await waitFor(() => sideRequests().length === 1, 5_000, "the side request");
	await sleep(200);
	expect(JSON.stringify(sideRequests()[0]!.messages.at(-1))).toContain(`Message ${thanks}`);
	expect(sideRequests()).toHaveLength(1);
	expect(relay.frames(id, "send")).toEqual([]);
	busy.release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("after the messages"), 5_000, "the follow-up turn");
	expect(h.errors).toEqual([]);
});

it("drops a side answer once the turn read the message, and needs none for a message read in time", async () => {
	await settings({ sideAnswerSeconds: 0.3 });
	const h = await online();
	const id = h.session.sessionId;
	const busy = held("first answer");
	const side = held("too late");
	h.faux.setResponses([busy.step, side.step, reply("read it")]);
	const prompt = h.session.prompt("work on something");
	await busy.started;
	const message = relay.push(id, { from: PEER, text: "status?" });
	await side.started;
	busy.release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("read it"), 5_000, "the follow-up turn");
	side.release();
	await sleep(200);
	expect(relay.frames(id, "send")).toEqual([]);

	// Read before the delay passes: no side request at all.
	const short = held("short");
	h.faux.setResponses([short.step, reply("read the second")]);
	const next = h.session.prompt("short work");
	await short.started;
	relay.push(id, { from: PEER, text: "another question" });
	short.release();
	await next;
	await waitFor(() => texts(h.session, "assistant").includes("read the second"), 5_000, "the second follow-up turn");
	await sleep(400);
	expect(sideRequests()).toHaveLength(1);
	expect(relay.frames(id, "send")).toEqual([]);
	expect(message).toBeTruthy();
	expect(h.errors).toEqual([]);
});

it("answers in the room, mentioning the sender", async () => {
	await settings({ sideAnswerSeconds: 0.05 });
	const h = await online();
	const id = h.session.sessionId;
	const busy = held("first answer");
	h.faux.setResponses([busy.step, reply("Deploy is at step 3 of 5."), reply("after the note"), reply("after the room")]);
	const prompt = h.session.prompt("work on something");
	await busy.started;
	const message = relay.push(id, { room: "ops", from: PEER, text: "@me where is the deploy?" });
	await waitFor(noted(h), 5_000, "the side answer");
	expect(relay.frames(id, "send")[0]).toMatchObject({ room: "ops", mentions: ["peer"], replyTo: message, hops: 2 });
	busy.release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("after the room"), 5_000, "the follow-up turn");
	expect(JSON.stringify(requests.at(-1)!.messages)).toContain(`side request answered message ${message} from room #ops`);
	expect(h.errors).toEqual([]);
});

it("follows relay.sideAnswers in pika.json, which /relay side on|off overrides for the session", async () => {
	await settings({ sideAnswers: false, sideAnswerSeconds: 0.05 });
	const notes = new Notes();
	const h = await online({ ui: notes.context() });
	const id = h.session.sessionId;
	await h.session.prompt("/relay side");
	expect(notes.last?.message).toBe("Side answers are off.");

	const first = held("first answer");
	h.faux.setResponses([first.step, reply("after the first")]);
	const prompt = h.session.prompt("work on something");
	await first.started;
	relay.push(id, { from: PEER, text: "first question" });
	await sleep(300);
	first.release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("after the first"), 5_000, "the first follow-up turn");
	expect(sideRequests()).toEqual([]);

	await h.session.prompt("/relay side on");
	expect(notes.last?.message).toBe("Side answers are on: while this session is busy, another session's message that stays unread for 0.05 s is answered beside the turn. This holds for this session; relay.sideAnswers in pika.json sets the default.");
	const second = held("second answer");
	h.faux.setResponses([second.step, reply("Second answer."), reply("after the note"), reply("after the second")]);
	const next = h.session.prompt("more work");
	await second.started;
	const message = relay.push(id, { from: PEER, text: "second question" });
	await waitFor(noted(h), 5_000, "the side answer");
	expect(relay.routed.find((routed) => routed.replyTo === message)?.text).toMatch(/^\[side answer\] /);
	second.release();
	await next;
	await waitFor(() => texts(h.session, "assistant").includes("after the second"), 5_000, "the second follow-up turn");
	expect(h.errors).toEqual([]);
});

it("sends a busy notice when the side request fails or times out", async () => {
	await settings({ sideAnswerSeconds: 0.05 });
	timing.sideTimeoutMs = 100;
	const h = await online();
	const id = h.session.sessionId;
	const busy = held("first answer");
	const side = held("never used");
	h.faux.setResponses([busy.step, side.step, reply("after the message")]);
	const prompt = h.session.prompt("work on something");
	await busy.started;
	const message = relay.push(id, { from: PEER, text: "status?" });
	await waitFor(() => relay.routed.some((routed) => routed.replyTo === message), 5_000, "the busy notice");
	expect(relay.routed.find((routed) => routed.replyTo === message)!.text).toMatch(/^\[busy notice\] .* It reads your message when that turn ends\.$/);
	side.release();
	busy.release();
	await prompt;
	await waitFor(() => texts(h.session, "assistant").includes("after the message"), 5_000, "the follow-up turn");
	expect(h.errors).toEqual([]);
});

describe("parseSide", () => {
	it.each([
		["NO_REPLY", { kind: "none" }],
		["  NO_REPLY\n", { kind: "none" }],
		["DEFER: needs the user", { kind: "defer", reason: "needs the user" }],
		["DEFER", { kind: "defer", reason: "" }],
		["", { kind: "defer", reason: "" }],
		["The build is green.", { kind: "answer", text: "The build is green." }],
	])("%j", (text, outcome) => { expect(parseSide(text)).toEqual(outcome); });
});

describe("loadRelaySettings", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pika-relay-settings-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
	const write = (value: unknown) => writeFile(join(dir, "pika.json"), typeof value === "string" ? value : JSON.stringify(value));

	it("defaults to side answers after 60 s, and reads valid values", async () => {
		expect(loadRelaySettings(dir)).toEqual({ sideAnswers: true, sideAnswerSeconds: 60 });
		await write("{ not json");
		expect(loadRelaySettings(dir)).toEqual({ sideAnswers: true, sideAnswerSeconds: 60 });
		await write({ relay: { sideAnswers: false, sideAnswerSeconds: 0.5 } });
		expect(loadRelaySettings(dir)).toEqual({ sideAnswers: false, sideAnswerSeconds: 0.5 });
		await write({ relay: { sideAnswers: "no", sideAnswerSeconds: 0 } });
		expect(loadRelaySettings(dir)).toEqual({ sideAnswers: true, sideAnswerSeconds: 60 });
		await write({ relay: { sideAnswerSeconds: 1e12 } });
		expect(loadRelaySettings(dir).sideAnswerSeconds * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
	});
});
