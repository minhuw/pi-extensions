import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionUIContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RECEIVED_TYPE, timing } from "../../relay/protocol.ts";
import { type LogItem, logItems, RelayLog, SENT_TYPE, size } from "../../relay/viewer.ts";
import { FakeRelay } from "./support/relay-server.ts";
import { Notes, setCredentials, sleep, startSession, texts, waitFor, waitOnline, Workspace, type Harness } from "./support/runtime.ts";

const KEYS = { up: "\x1b[A", down: "\x1b[B", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F", enter: "\r", esc: "\x1b" };
const BINDINGS: Record<string, string> = {
	"tui.select.up": KEYS.up, "tui.select.down": KEYS.down, "tui.select.pageUp": KEYS.pageUp, "tui.select.pageDown": KEYS.pageDown,
	"tui.select.confirm": KEYS.enter, "tui.select.cancel": KEYS.esc,
};
const keybindings = { matches: (data: string, binding: string) => BINDINGS[binding] === data };
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const colorTheme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); setCredentials(relay.url); });
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
});

/** A UI that records notifications and opens `ui.custom` components on a fake terminal. */
class LogUI extends Notes {
	viewer: RelayLog | undefined;
	options: { overlay?: boolean; overlayOptions?: () => unknown } | undefined;
	readonly tui = { mode: "regular" as const, terminal: { rows: 30 }, requestRender: vi.fn() };
	override context(): ExtensionUIContext {
		const base = super.context();
		const custom = (factory: (...args: unknown[]) => RelayLog, options: LogUI["options"]) => new Promise((resolve) => {
			this.options = options;
			this.viewer = factory(this.tui, plainTheme, keybindings, resolve);
		});
		return new Proxy(base, { get: (target, name) => name === "custom" ? custom : Reflect.get(target, name) });
	}
	press(...keys: string[]): void { for (const key of keys) this.viewer!.handleInput(key); }
	lines(width = 100): string[] { return this.viewer!.render(width).map((line) => plain(line).trimEnd()); }
}

async function online(options: Partial<Parameters<typeof startSession>[0]> = {}): Promise<Harness> {
	const h = await startSession({ workspace, ...options });
	harnesses.push(h);
	await waitOnline(relay, h.session.sessionId);
	return h;
}

function callTool(h: Harness, name: string, args: Parameters<typeof fauxToolCall>[1], after = "done"): void {
	h.faux.appendResponses([fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }), fauxAssistantMessage(after)]);
}

const sentData = (h: Harness) => h.session.sessionManager.getBranch().flatMap((entry) => entry.type === "custom" && entry.customType === SENT_TYPE ? [entry.data] : []);

it("records every message the server accepted as a relay-sent entry, from the tools and /relay send, and nothing for a failed one", async () => {
	const notes = new Notes();
	const a = await online({ ui: notes.context() });
	const b = await online();
	const target = b.session.sessionId;
	relay.recorded.add("offline-session");
	await a.session.prompt("/relay join ops");
	await b.session.prompt("/relay join ops");
	b.faux.setResponses([fauxAssistantMessage("joined")]);
	await b.session.prompt("join ops");
	b.faux.setResponses([fauxAssistantMessage("b got it"), fauxAssistantMessage("b saw the mention")]);

	callTool(a, "relay_send", { to: target, text: "Check the build", urgent: true, replyTo: "m-0" });
	await a.session.prompt("ask b");
	await waitFor(() => texts(b.session, "assistant").includes("b got it"), 5_000, "b's turn");
	callTool(a, "relay_send", { to: "offline-session", text: "later" });
	await a.session.prompt("queue one");
	callTool(a, "relay_room", { action: "send", room: "#ops", text: "status", mentions: [target] });
	await a.session.prompt("post");
	await waitFor(() => texts(b.session, "assistant").includes("b saw the mention"), 5_000, "b's mention turn");
	await a.session.prompt("/relay send offline-session from the user");
	expect(notes.last?.type).toBe("info");

	// Rejected, too large, and unanswered sends leave no entry.
	callTool(a, "relay_send", { to: "nobody", text: "hi" });
	await a.session.prompt("unknown");
	callTool(a, "relay_send", { to: target, text: "x".repeat(32 * 1024 + 1) });
	await a.session.prompt("too large");
	relay.onSend = () => "none";
	timing.sentTimeoutMs = 300;
	callTool(a, "relay_send", { to: target, text: "lost" });
	await a.session.prompt("timeout");
	relay.onSend = undefined;
	await a.session.prompt("/relay send nobody hi");
	expect(notes.last?.type).toBe("error");

	// b is labelled by the title its first prompt gave it.
	const at = expect.stringMatching(/^\d{4}-\d\d-\d\dT/);
	expect(sentData(a)).toEqual([
		{ id: "msg-1", to: target, label: "join ops on laptop · project", text: "Check the build", replyTo: "m-0", urgent: true, status: "delivered", at },
		{ id: "msg-2", to: "offline-session", label: "offline-session", text: "later", urgent: false, status: "queued", at },
		{ id: "msg-3", room: "ops", mentions: [target], text: "status", urgent: false, status: "delivered", at },
		{ id: "msg-4", to: "offline-session", label: "offline-session", text: "from the user", urgent: false, status: "queued", at },
	]);
	// The entries never reach the model.
	expect(a.session.messages.some((message) => (message as { customType?: string }).customType === SENT_TYPE)).toBe(false);

	// The real results render as their one status line.
	const definition = a.session.extensionRunner.getToolDefinition("relay_send")!;
	const result = a.session.messages.find((message) => message.role === "toolResult" && message.toolName === "relay_send")!;
	const context = { args: {}, expanded: false, isError: false } as never;
	expect(definition.renderResult!(result as never, { expanded: false, isPartial: false }, plainTheme, context).render(200).map((line) => line.trimEnd()))
		.toEqual(["delivered to join ops on laptop · project · msg-1"]);
	expect(a.errors).toEqual([]);
}, 20_000);

it("/relay log opens only in the TUI, and says when the branch has no relay messages", async () => {
	const notes = new Notes();
	const rpc = await online({ ui: notes.context() });
	await rpc.session.prompt("/relay log");
	expect(notes.last).toEqual({ type: "info", message: "/relay log opens only in the interactive TUI." });

	const ui = new LogUI();
	const h = await online({ mode: "tui", ui: ui.context() });
	await h.session.prompt("/relay log");
	expect(ui.last).toEqual({ type: "info", message: "No relay messages on this branch." });
	expect(ui.viewer).toBeUndefined();

	// A message on another branch does not count.
	relay.recorded.add("peer");
	callTool(h, "relay_send", { to: "peer", text: "hello" });
	await h.session.prompt("send");
	expect(sentData(h)).toHaveLength(1);
	h.session.sessionManager.branch(h.session.sessionManager.getEntries()[0]!.id);
	await h.session.prompt("/relay log");
	expect(ui.last).toEqual({ type: "info", message: "No relay messages on this branch." });
	expect(ui.viewer).toBeUndefined();
});

it("/relay log lists the branch's messages with the latest status, newest selected, and opens each in full", async () => {
	const ui = new LogUI();
	const a = await online({ mode: "tui", ui: ui.context() });
	const id = a.session.sessionId;
	relay.recorded.add("offline-session");
	a.faux.setResponses([fauxAssistantMessage("on it")]);
	const received = relay.push(id, { text: "Please run the tests.\nThen report.", replyTo: "m-0" });
	await relay.waitForAck(id, received);
	await waitFor(() => texts(a.session, "assistant").includes("on it"), 5_000, "the turn");
	callTool(a, "relay_send", { to: "offline-session", text: "later" });
	await a.session.prompt("queue one");
	await a.session.prompt("/relay send offline-session from the user");
	// The first sent message was delivered after its entry was written.
	relay.send(id, { type: "status", id: "msg-2", status: "delivered", to: { sessionId: "offline-session" }, at: new Date().toISOString() });
	await sleep(300);

	const opened = a.session.prompt("/relay log");
	await waitFor(() => ui.viewer !== undefined, 5_000, "the viewer");
	expect(ui.options?.overlay).toBe(true);
	expect(ui.options?.overlayOptions?.()).toEqual({ anchor: "center", width: "90%", maxHeight: "70%" });
	const list = ui.lines();
	expect(list[0]).toBe(`╭${"─".repeat(98)}╮`);
	expect(list.slice(1, 8).map((line) => line.replace(/\s+│$/, "").replace(/\d\d:\d\d/, "HH:MM"))).toEqual([
		"│ ✉ relay log · 3 messages on this branch",
		`├${"─".repeat(98)}┤`,
		"│   ← HH:MM  Sender on desktop · elsewhere  34 chars",
		"│   → HH:MM  offline-session  delivered  5 chars",
		"│ ▸ → HH:MM  offline-session  queued  13 chars",
		`├${"─".repeat(98)}┤`,
		"│ 3/3 · ↑↓ move · Enter open · Esc close",
	]);

	ui.press(KEYS.up, KEYS.enter);
	const detail = ui.lines().map((line) => line.replace(/\s+│$/, ""));
	expect(detail[1]).toBe("│ ✉ relay log · message 2 of 3");
	expect(detail.slice(3, 10)).toEqual([
		"│ → to offline-session",
		expect.stringMatching(/^│ Time: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
		"│ Id: msg-2",
		"│ Status: delivered",
		"│ Size: 5 chars",
		"│",
		"│ later",
	]);
	expect(detail.at(-2)).toBe("│ Esc back");

	ui.press(KEYS.esc, KEYS.up, KEYS.enter);
	expect(ui.lines().slice(3, 11).map((line) => line.replace(/\s+│$/, ""))).toEqual([
		"│ ← from Sender on desktop · elsewhere",
		expect.stringMatching(/^│ Time: /),
		"│ Id: msg-1",
		"│ Reply to: m-0",
		"│ Size: 34 chars",
		"│",
		"│ Please run the tests.",
		"│ Then report.",
	]);
	ui.press("q");
	expect(ui.lines()[1]).toMatch(/^│ ✉ relay log · 3 messages/);
	ui.press("q");
	await opened;
	expect(ui.tui.requestRender).toHaveBeenCalled();
	expect(a.errors).toEqual([]);
});

describe("size", () => {
	it.each([
		[0, "0 chars"], [1, "1 char"], [999, "999 chars"], [1000, "1k chars"], [1234, "1.2k chars"], [9949, "9.9k chars"], [9950, "10k chars"], [12_345, "12k chars"],
	])("%d characters are %s", (count, expected) => { expect(size("x".repeat(count))).toBe(expected); });
	it("counts characters, not UTF-16 units", () => { expect(size("😀😀😀")).toBe("3 chars"); });
});

describe("logItems", () => {
	const entry = (customType: string, data: unknown, timestamp = "2026-11-09T10:00:00.000Z"): SessionEntry =>
		({ type: "custom", customType, data, id: "e", parentId: null, timestamp }) as SessionEntry;

	it("reads received and sent entries in order, prefers a live status, and skips what it cannot read", () => {
		const items = logItems([
			entry(RECEIVED_TYPE, { id: "msg-1", from: { kind: "web" }, text: "hi\x1b[2J", urgent: true, room: "ops", at: "2026-11-09T10:01:00.000Z" }),
			{ type: "message", id: "m", parentId: null, timestamp: "", message: { role: "user", content: "x", timestamp: 0 } } as SessionEntry,
			entry("other", { text: "not relay" }),
			entry(SENT_TYPE, { id: "msg-2", to: "s-1", label: "Builder on laptop", text: "one", urgent: false, status: "queued", at: "2026-11-09T10:02:00.000Z" }),
			entry(SENT_TYPE, { id: "msg-3", room: "ops", mentions: ["s-1", "\x1b[2J"], text: "two", urgent: false, status: "delivered" }, "2026-11-09T10:03:00.000Z"),
			entry(SENT_TYPE, { id: "msg-4", to: "s-2", text: "three", status: "queued" }),
			entry(SENT_TYPE, { id: "msg-5", text: 42 }),
			entry(RECEIVED_TYPE, undefined),
		], (id) => id === "msg-2" ? "expired" : undefined);
		expect(items).toEqual<LogItem[]>([
			{ incoming: true, id: "msg-1", at: "2026-11-09T10:01:00.000Z", peer: "your user, from the pika web UI", room: "ops", urgent: true, text: "hi" },
			{ incoming: false, id: "msg-2", at: "2026-11-09T10:02:00.000Z", peer: "Builder on laptop", urgent: false, status: "expired", text: "one" },
			{ incoming: false, id: "msg-3", at: "2026-11-09T10:03:00.000Z", peer: "", room: "ops", mentions: ["s-1"], urgent: false, status: "delivered", text: "two" },
			{ incoming: false, id: "msg-4", at: "2026-11-09T10:00:00.000Z", peer: "s-2", urgent: false, status: "queued", text: "three" },
		]);
	});
});

describe("RelayLog", () => {
	const item = (index: number, overrides: Partial<LogItem> = {}): LogItem => ({
		incoming: index % 2 === 0, id: `msg-${index}`, at: new Date(2026, 10, 9, 10, index).toISOString(), peer: index % 2 === 0 ? "Builder on desktop · api" : "s-1",
		urgent: false, text: `message ${index}`, ...(index % 2 === 0 ? {} : { status: "delivered" }), ...overrides,
	});
	function viewer(items: LogItem[], { rows = 20, mode = "regular" as "regular" | "fullscreen", keys = keybindings as typeof keybindings | undefined } = {}) {
		const done = vi.fn();
		const tui = { mode, terminal: { rows }, requestRender: vi.fn() };
		const log = new RelayLog(tui, colorTheme, keys, items, done);
		return { log, done, tui, press: (...input: string[]) => { for (const key of input) log.handleInput(key); }, text: (width = 80) => log.render(width).map(plain) };
	}
	const selected = (lines: string[]) => lines.find((line) => line.startsWith("│ ▸"));

	it("keeps every line within the width, in both views, at any width and in fullscreen", () => {
		const long = item(0, { peer: "A very long sender name ".repeat(10), room: "a-room-with-a-long-name", text: `${"word ".repeat(400)}\n\ttabbed\n${"x".repeat(500)}`, replyTo: "msg-0", urgent: true, mentions: ["s-1", "s-2"] });
		for (const mode of ["regular", "fullscreen"] as const) {
			for (const width of [1, 5, 12, 40, 80, 133]) {
				const { log, press } = viewer([long, item(1), item(2)], { mode });
				const check = () => { for (const line of log.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width); };
				check();
				press(KEYS.home, KEYS.enter);
				check();
				press(KEYS.pageDown, KEYS.end);
				check();
			}
		}
	});

	it("moves the selection with the select keys, scrolling the list, and pages by its height", () => {
		const items = Array.from({ length: 30 }, (_, index) => item(index + 1));
		const { text, press, tui } = viewer(items);
		// 20 rows: 70% is 14, less 6 of chrome, leaves 8 rows of messages.
		let lines = text();
		expect(lines).toHaveLength(14);
		expect(selected(lines)).toMatch(/▸ ← 10:30 {2}Builder on desktop · api {2}10 chars/);
		expect(lines.at(-2)).toMatch(/^│ 30\/30 · /);
		expect(lines.filter((line) => /^│ [▸ ] [←→] /.test(line))).toHaveLength(8);
		press(KEYS.home);
		expect(text().at(-2)).toMatch(/^│ 1\/30 · /);
		press(KEYS.pageDown);
		expect(text().at(-2)).toMatch(/^│ 9\/30 · /);
		press(KEYS.down, KEYS.down, KEYS.up);
		expect(text().at(-2)).toMatch(/^│ 10\/30 · /);
		press(KEYS.pageUp, KEYS.pageUp);
		expect(text().at(-2)).toMatch(/^│ 1\/30 · /);
		press(KEYS.up);
		expect(text().at(-2)).toMatch(/^│ 1\/30 · /);
		press(KEYS.end, KEYS.down);
		lines = text();
		expect(lines.at(-2)).toMatch(/^│ 30\/30 · /);
		expect(selected(lines)).toMatch(/▸ ← 10:30 {2}Builder on desktop · api {2}10 chars/);
		press(KEYS.up);
		expect(selected(text())).toMatch(/▸ → 10:29 {2}s-1 {2}delivered {2}10 chars/);
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("scrolls a long message in the detail view, and Esc or q goes back before it closes", () => {
		const body = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
		const { text, press, done } = viewer([item(0), item(1, { text: body })]);
		press(KEYS.enter);
		let lines = text();
		expect(lines[1]).toMatch(/^│ ✉ relay log · message 2 of 2/);
		expect(lines.at(-2)).toMatch(/^│ lines 1-8 of 46 · ↑↓ scroll · Esc back/);
		press(KEYS.pageDown, KEYS.down);
		expect(text().at(-2)).toMatch(/^│ lines 10-17 of 46 /);
		press(KEYS.end);
		lines = text();
		expect(lines.at(-2)).toMatch(/^│ lines 39-46 of 46 /);
		expect(lines.at(-4)).toMatch(/^│ line 40 +│$/);
		press(KEYS.down, KEYS.home);
		expect(text().at(-2)).toMatch(/^│ lines 1-8 of 46 /);
		press(KEYS.esc);
		expect(text()[1]).toMatch(/^│ ✉ relay log · 2 messages on this branch/);
		expect(done).not.toHaveBeenCalled();
		press(KEYS.enter, "q");
		expect(done).not.toHaveBeenCalled();
		press("q");
		expect(done).toHaveBeenCalledTimes(1);
		const other = viewer([item(0)]);
		other.press(KEYS.esc);
		expect(other.done).toHaveBeenCalledTimes(1);
	});

	it("falls back to the default keys without a keybindings manager, and ignores other keys", () => {
		const { text, press, done, tui } = viewer([item(0), item(1)], { keys: undefined });
		press(KEYS.up);
		expect(text().at(-2)).toMatch(/^│ 1\/2 · /);
		press("x");
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
		press(KEYS.enter);
		expect(text()[3]).toMatch(/^│ ← from Builder on desktop · api/);
		press(KEYS.esc, KEYS.esc);
		expect(done).toHaveBeenCalledTimes(1);
	});
});
