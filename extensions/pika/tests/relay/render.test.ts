import { afterEach, beforeEach, expect, it } from "vitest";
import type { KeybindingHints, Theme } from "@earendil-works/pi-coding-agent";
import { FakeRelay } from "./support/relay-server.ts";
import { setCredentials, startSession, waitOnline, Workspace, type Harness } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
const keys: KeybindingHints = { keyText: (keybinding) => keybinding, keyHint: (keybinding, description) => `${keybinding} ${description}` };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); setCredentials(relay.url); });
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

type Args = Record<string, unknown>;
type Result = { content: { type: string; text?: string }[]; details?: unknown };

/** The call and result renderers of a registered tool, rendered at a wide width without trailing padding. */
function renderers(h: Harness, tool: string) {
	const definition = h.session.extensionRunner.getToolDefinition(tool)!;
	const context = (args: Args, expanded: boolean, isError: boolean) => ({
		...keys, args, expanded, isError, toolCallId: "call-1", invalidate() {}, lastComponent: undefined, state: {}, cwd: workspace.cwd,
		executionStarted: true, argsComplete: true, isPartial: false, showImages: false, durationMs: 1, outputPad: 0,
	}) as never;
	const lines = (component: { render(width: number): string[] }) => component.render(200).map((line) => line.trimEnd());
	return {
		definition,
		call: (args: Args, expanded = false) => lines(definition.renderCall!(args as never, theme, context(args, expanded, false))),
		result: (args: Args, result: Result, { expanded = false, isError = false } = {}) =>
			lines(definition.renderResult!(result as never, { expanded, isPartial: false }, theme, context(args, expanded, isError))),
	};
}

const text = (value: string): Result["content"] => [{ type: "text", text: value }];

it("renders a relay_send call as one line with its target and size, and the text when expanded", async () => {
	const { call } = renderers(await online(), "relay_send");
	const args = { to: "s-1", text: "one\ntwo", urgent: true, replyTo: "msg-1" };
	expect(call(args)).toEqual(["✉ relay → s-1 urgent reply to msg-1 · 7 chars"]);
	expect(call(args, true)).toEqual(["✉ relay → s-1 urgent reply to msg-1 · 7 chars", "  one", "  two"]);
	expect(call({ to: "#ops", text: "hi" })).toEqual(["✉ relay → #ops · 2 chars"]);
	expect(call({ room: "#ops", to: "ignored", text: "x".repeat(2500) })).toEqual(["✉ relay → #ops · 2.5k chars"]);
	// Arguments still streaming in.
	expect(call({})).toEqual(["✉ relay → ? · 0 chars"]);
	// The model may repeat another device's text: no terminal sequences, and the target stays on one line.
	expect(call({ to: "s-1\x1b[2J\nforged", text: "a\x1b[31mb\x07", replyTo: "m\u202e-1" }, true)).toEqual(["✉ relay → s-1 forged reply to m-1 · 2 chars", "  ab"]);
});

it("renders a relay_send result as one status line, the full text when expanded, and an error as its first line", async () => {
	const { definition, result } = renderers(await online(), "relay_send");
	const args = { to: "s-1", text: "hi" };
	const full = "Delivered message msg-1 to pi session s-1 (\"Builder\") on laptop. Any answer arrives as a new [relay] message after your current turn ends.";
	const delivered = { type: "sent", clientId: "c-1", id: "msg-1", status: "delivered", to: { sessionId: "s-1", device: "laptop", name: "Builder", project: "api" } };
	expect(result(args, { content: text(full), details: delivered })).toEqual(["delivered to Builder on laptop · api · msg-1"]);
	expect(result(args, { content: text(full), details: delivered }, { expanded: true })).toEqual([full]);
	expect(result(args, { content: text("Queued message msg-2 …"), details: { ...delivered, id: "msg-2", status: "queued", to: { sessionId: "offline" } } }))
		.toEqual(["queued for offline, not delivered yet · msg-2"]);
	const posted = { ...delivered, id: "msg-3", room: "ops", to: { sessionId: "#ops", name: "#ops" } };
	expect(result(args, { content: text("Posted …"), details: { ...posted, notified: [{ sessionId: "s-2", name: "Docs" }, { sessionId: "s-3\x1b[2J" }] } }))
		.toEqual(["posted to #ops · notified Docs, s-3 · msg-3"]);
	expect(result(args, { content: text("Posted …"), details: { ...posted, notified: [] } })).toEqual(["posted to #ops · no one notified · msg-3"]);
	const error = "relay rejected the message (self): that is this session's own id.\nsecond line";
	expect(result(args, { content: text(error), details: {} }, { isError: true })).toEqual(["relay rejected the message (self): that is this session's own id."]);
	expect(result(args, { content: text(error), details: {} }, { isError: true, expanded: true })).toEqual(error.split("\n"));
	// A result without the frame shows its first line.
	expect(result(args, { content: text("\nsomething\nelse"), details: undefined })).toEqual(["something"]);
	expect(result(args, { content: text("evil\x1b]52;c;eA==\x07 text"), details: undefined })).toEqual(["evil text"]);
	expect(definition.renderShell).toBeUndefined();
});

it("renders relay_room: send like relay_send, other calls as one line, history as its message count", async () => {
	const h = await online();
	const { call, result } = renderers(h, "relay_room");
	expect(call({ action: "send", room: "ops", text: "status", urgent: true })).toEqual(["✉ relay → #ops urgent · 6 chars"]);
	expect(call({ action: "send", room: "ops", text: "a\nb" }, true)).toEqual(["✉ relay → #ops · 3 chars", "  a", "  b"]);
	expect(call({ action: "history", room: "#auth-sync" })).toEqual(["✉ relay room history #auth-sync"]);
	expect(call({ action: "join", room: "ops\x1b[2J", topic: "Coordinate" })).toEqual(["✉ relay room join #ops"]);
	expect(call({ action: "list" })).toEqual(["✉ relay room list"]);

	const history = "#auth-sync · 2 msgs · members: …\n\n[#1 · msg-1 · 3s ago] A: first\n[#2 · msg-2 · 1s ago] B: second";
	const detail = { room: { name: "auth-sync" }, messages: [{ id: "msg-1" }, { id: "msg-2" }] };
	expect(result({ action: "history", room: "auth-sync" }, { content: text(history), details: { detail } })).toEqual(["#auth-sync · 2 messages"]);
	expect(result({ action: "history", room: "auth-sync" }, { content: text(history), details: { detail: { ...detail, messages: [{}] } } })).toEqual(["#auth-sync · 1 message"]);
	expect(result({ action: "history", room: "auth-sync" }, { content: text(history), details: { detail } }, { expanded: true })).toEqual(history.split("\n"));
	const list = "2 active chatrooms:\n#a · 1 msg · members: x\n#b · 0 msgs · members: y";
	expect(result({ action: "list" }, { content: text(list), details: { rooms: [] } })).toEqual(["2 active chatrooms:"]);
	expect(result({ action: "list" }, { content: text(list), details: { rooms: [] } }, { expanded: true })).toEqual(list.split("\n"));
	const sent = { type: "sent", clientId: "c-1", id: "msg-4", status: "delivered", to: { sessionId: "#ops" }, room: "ops", notified: [{ sessionId: "s-2", name: "Docs" }] };
	expect(result({ action: "send", room: "ops", text: "hi" }, { content: text("Posted …"), details: { sent } })).toEqual(["posted to #ops · notified Docs · msg-4"]);
	expect(result({ action: "history", room: "x" }, { content: text("no such chatroom exists yet"), details: {} }, { isError: true })).toEqual(["no such chatroom exists yet"]);

	// relay_list and relay_status keep pi's default rendering.
	for (const name of ["relay_list", "relay_status"]) {
		const definition = h.session.extensionRunner.getToolDefinition(name)!;
		expect([definition.renderCall, definition.renderResult]).toEqual([undefined, undefined]);
	}
});
