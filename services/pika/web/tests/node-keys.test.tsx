import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { nextWaiting, paneOrder, stepPane, type NodeView } from "../src/nodes/client";
import type { TerminalInfo } from "../src/nodes/contract";
import {
	ACTIONS,
	buildKeymap,
	chordId,
	focusOf,
	formatChord,
	keymapFrom,
	KEYS_EXAMPLE,
	KEYS_KEY,
	matchChord,
	parseChord,
	RESERVED,
	resolveKey,
	saveKeySettings,
	terminalSafe,
	type KeyEventLike,
	type KeyFocus,
} from "../src/nodes/keys";
import { KeysHelp } from "../src/nodes/KeysHelp";

const key = (value: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: value, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });
const nowhere: KeyFocus = { terminal: false, text: false, diff: false };
const terminal: KeyFocus = { terminal: true, text: false, diff: false };
const text: KeyFocus = { terminal: false, text: true, diff: false };
const diff: KeyFocus = { terminal: false, text: true, diff: true };

afterEach(() => {
	saveKeySettings(null);
	localStorage.clear();
});

describe("chords", () => {
	it("parse modifiers in any order and case, named keys, and refuse anything else", () => {
		expect(parseChord("cmd+ALT+down")).toEqual({ meta: true, ctrl: false, alt: true, shift: false, key: "ArrowDown" });
		expect(parseChord("Ctrl+Shift+P")).toEqual({ meta: false, ctrl: true, alt: false, shift: true, key: "p" });
		expect(parseChord("?")).toMatchObject({ key: "?", shift: false });
		expect(parseChord("Shift+F7")).toMatchObject({ key: "F7", shift: true });
		expect(parseChord("Ctrl++")).toMatchObject({ ctrl: true, key: "+" });
		for (const bad of ["", "Cmd+", "Hyper+K", "Cmd+Cmd+K", "Cmd+Foo", "Shift+?"]) expect(parseChord(bad), bad).toBeUndefined();
	});

	it("write themselves the platform's way", () => {
		expect(formatChord(parseChord("Cmd+Alt+ArrowDown")!, true)).toBe("⌥⌘↓");
		expect(formatChord(parseChord("Ctrl+Shift+ArrowDown")!, false)).toBe("Ctrl+Shift+Down");
		expect(formatChord(parseChord("Cmd+\\")!, true)).toBe("⌘\\");
		expect(chordId(parseChord("shift+ctrl+p")!)).toBe(chordId(parseChord("Ctrl+Shift+P")!));
	});

	it("match by character or by physical key, as Alt and Shift change the character", () => {
		// macOS: Cmd+Alt+T types "†", Ctrl+Shift+1 types "!".
		expect(matchChord(parseChord("Cmd+Alt+T")!, key("†", { metaKey: true, altKey: true, code: "KeyT" }))).toBe(true);
		expect(matchChord(parseChord("Ctrl+Shift+1")!, key("!", { ctrlKey: true, shiftKey: true, code: "Digit1" }))).toBe(true);
		expect(matchChord(parseChord("Ctrl+Shift+\\")!, key("|", { ctrlKey: true, shiftKey: true, code: "Backslash" }))).toBe(true);
		expect(matchChord(parseChord("?")!, key("?", { shiftKey: true }))).toBe(true);
		expect(matchChord(parseChord("Cmd+P")!, key("p", { metaKey: true, shiftKey: true }))).toBe(false);
		expect(matchChord(parseChord("Cmd+P")!, key("p", { ctrlKey: true }))).toBe(false);
	});
});

describe("the default keymap", () => {
	for (const mac of [true, false]) {
		const keymap = buildKeymap(undefined, mac);
		const platform = mac ? "macOS" : "elsewhere";

		it(`has no conflicts and takes none of the browser's keys (${platform})`, () => {
			expect(keymap.problems).toEqual([]);
			const reserved = new Set((mac ? RESERVED.mac : RESERVED.other).map((chord) => chordId(parseChord(chord)!)));
			for (const spec of ACTIONS) {
				expect(keymap.bindings.get(spec.id)!.length, spec.id).toBeGreaterThan(0);
				for (const chord of keymap.bindings.get(spec.id)!) expect(reserved.has(chordId(chord)), `${spec.id} ${chordId(chord)}`).toBe(false);
			}
		});

		it(`binds every action that works in the terminal to a chord the terminal gives up (${platform})`, () => {
			for (const spec of ACTIONS.filter((item) => item.terminal)) {
				for (const chord of keymap.bindings.get(spec.id)!) expect(terminalSafe(chord, mac), `${spec.id} ${chordId(chord)}`).toBe(true);
			}
		});
	}

	it("keeps readline's keys in the terminal, and only takes Cmd or Ctrl+Shift chords there", () => {
		const mac = buildKeymap(undefined, true);
		const linux = buildKeymap(undefined, false);
		expect(resolveKey(mac, key("p", { metaKey: true, code: "KeyP" }), terminal)).toBe("quickOpen");
		expect(resolveKey(mac, key("f", { metaKey: true, code: "KeyF" }), terminal)).toBe("find");
		expect(resolveKey(linux, key("P", { ctrlKey: true, shiftKey: true, code: "KeyP" }), terminal)).toBe("quickOpen");
		expect(resolveKey(linux, key("p", { ctrlKey: true, code: "KeyP" }), terminal)).toBeUndefined();
		expect(resolveKey(linux, key("f", { ctrlKey: true, code: "KeyF" }), terminal)).toBeUndefined();
		// Not in the terminal at all: help. Ctrl-W and Alt-W are readline's; closing a tab is a Cmd (or Ctrl+Shift) chord.
		expect(resolveKey(mac, key("/", { metaKey: true, code: "Slash" }), terminal)).toBeUndefined();
		expect(resolveKey(mac, key("w", { ctrlKey: true, code: "KeyW" }), terminal)).toBeUndefined();
		expect(resolveKey(linux, key("w", { altKey: true, code: "KeyW" }), terminal)).toBeUndefined();
		expect(resolveKey(mac, key("w", { metaKey: true, ctrlKey: true, code: "KeyW" }), terminal)).toBe("tab.close");
		expect(resolveKey(linux, key("W", { ctrlKey: true, shiftKey: true, altKey: true, code: "KeyW" }), terminal)).toBe("tab.close");
		// Tabs on macOS are ⌘⌃ chords, which neither browser takes.
		expect(resolveKey(mac, key("ArrowRight", { metaKey: true, ctrlKey: true }), terminal)).toBe("tab.next");
		expect(resolveKey(mac, key("3", { metaKey: true, ctrlKey: true, code: "Digit3" }), terminal)).toBe("tab.3");
		expect(resolveKey(mac, key("T", { metaKey: true, ctrlKey: true, shiftKey: true, code: "KeyT" }), terminal)).toBe("tab.reopen");
	});

	it("never takes a typed character in a text field, and keeps diff keys to diffs and find to the terminal", () => {
		const mac = buildKeymap(undefined, true);
		expect(resolveKey(mac, key("?", { shiftKey: true }), nowhere)).toBe("help");
		expect(resolveKey(mac, key("?", { shiftKey: true }), text)).toBeUndefined();
		expect(resolveKey(mac, key("/", { metaKey: true }), text)).toBeUndefined();
		expect(resolveKey(mac, key("w", { ctrlKey: true }), text)).toBeUndefined();
		expect(resolveKey(mac, key("w", { metaKey: true, ctrlKey: true }), text)).toBe("tab.close");
		expect(resolveKey(mac, key("F7"), diff)).toBe("diff.next");
		expect(resolveKey(mac, key("F7", { shiftKey: true }), diff)).toBe("diff.previous");
		expect(resolveKey(mac, key("F7"), text)).toBeUndefined();
		expect(resolveKey(mac, key("ArrowDown", { altKey: true }), text)).toBeUndefined();
		expect(resolveKey(mac, key("f", { metaKey: true }), text)).toBeUndefined();
		expect(resolveKey(mac, key("ArrowDown", { metaKey: true, ctrlKey: true }), text)).toBe("pane.next");
		// Firefox switches tabs on ⌘⌥↓ even when the page handles it.
		expect(resolveKey(mac, key("ArrowDown", { metaKey: true, altKey: true }), text)).toBeUndefined();
	});
});

describe("rebinding", () => {
	it("applies valid bindings, and reports refused ones while keeping their defaults", () => {
		const keymap = buildKeymap(
			{
				bindings: {
					"pane.next": "Cmd+Alt+N",
					"diff.next": ["F8", "Alt+N"],
					"tab.close": [],
					"pane.previous": "Cmd+W",
					"files.toggle": "Cmd+Banana",
					"no.such": "F9",
					find: 3,
				},
				colour: "red",
			},
			true,
		);
		expect(keymap.bindings.get("pane.next")!.map(chordId)).toEqual(["Cmd+Alt+N"]);
		expect(keymap.bindings.get("diff.next")!.map(chordId)).toEqual(["F8", "Alt+N"]);
		expect(keymap.bindings.get("tab.close")).toEqual([]);
		expect(keymap.bindings.get("pane.previous")!.map(chordId)).toEqual(["Cmd+Ctrl+ArrowUp"]);
		expect(keymap.bindings.get("files.toggle")!.map(chordId)).toEqual(["Cmd+\\"]);
		expect([...keymap.custom].sort()).toEqual(["diff.next", "pane.next", "tab.close"]);
		const messages = keymap.problems.map((problem) => problem.message).join("\n");
		expect(messages).toMatch(/Unknown setting "colour"/);
		expect(messages).toMatch(/⌘W belongs to the browser/);
		expect(messages).toMatch(/"Cmd\+Banana" is not a chord/);
		expect(messages).toMatch(/Unknown action "no.such"/);
		expect(messages).toMatch(/Find in the terminal: give a chord/);
		expect(resolveKey(keymap, key("˜", { metaKey: true, altKey: true, code: "KeyN" }), nowhere)).toBe("pane.next");
		expect(resolveKey(keymap, key("ArrowDown", { metaKey: true, ctrlKey: true }), nowhere)).toBeUndefined();
	});

	it("gives a contested chord to the rebound action, and reports the one that lost it", () => {
		const keymap = buildKeymap({ bindings: { "terminal.new": "Cmd+Ctrl+ArrowDown" } }, true);
		expect(keymap.bindings.get("terminal.new")!.map(chordId)).toEqual(["Cmd+Ctrl+ArrowDown"]);
		expect(keymap.bindings.get("pane.next")).toEqual([]);
		expect(keymap.problems).toEqual([{ action: "pane.next", message: '⌃⌘↓ is bound to both "New terminal in this project" and "Next agent in the list"; "New terminal in this project" keeps it.' }]);
		// Find works only in the terminal and diff keys only in a diff, so they can share a chord.
		expect(buildKeymap({ bindings: { "diff.next": "Cmd+F" } }, true).problems).toEqual([]);
	});

	it("falls back to the defaults on unreadable JSON, and stores what it is given", () => {
		const broken = keymapFrom("{nope", true);
		expect(broken.problems[0]!.message).toMatch(/not JSON/);
		expect(broken.bindings.get("pane.next")!.map(chordId)).toEqual(["Cmd+Ctrl+ArrowDown"]);
		expect(keymapFrom(KEYS_EXAMPLE, true).problems).toEqual([]);

		saveKeySettings('{"bindings":{"help":"F1"}}');
		expect(localStorage.getItem(KEYS_KEY)).toBe('{"bindings":{"help":"F1"}}');
		saveKeySettings(null);
		expect(localStorage.getItem(KEYS_KEY)).toBeNull();
	});
});

describe("where focus is", () => {
	it("tells the terminal, text, the editor, and a diff apart", () => {
		document.body.innerHTML = `
			<div class="xterm"><textarea id="term"></textarea></div>
			<input id="field" />
			<div data-diff-view=""><div class="monaco-editor"><div id="code"></div></div><button id="next"></button></div>
			<button id="plain"></button>`;
		const at = (id: string) => focusOf(document.getElementById(id));
		expect(at("term")).toEqual({ terminal: true, text: false, diff: false });
		expect(at("field")).toEqual({ terminal: false, text: true, diff: false });
		expect(at("code")).toEqual({ terminal: false, text: true, diff: true });
		expect(at("next")).toEqual({ terminal: false, text: false, diff: true });
		expect(at("plain")).toEqual(nowhere);
		expect(focusOf(null)).toEqual(nowhere);
		document.body.innerHTML = "";
	});
});

describe("moving between panes", () => {
	const term = (terminalId: string, state?: "waiting" | "busy"): TerminalInfo => ({
		terminalId,
		title: terminalId,
		cwd: "/",
		cols: 80,
		rows: 24,
		pid: 1,
		createdAt: 1,
		argv: ["sh"],
		...(state ? { status: { state, bridgeConnected: false, unread: false } } : {}),
	});
	const view = (id: string, ready: boolean, terminals: TerminalInfo[]) =>
		({ info: { id, name: id, online: true }, link: ready ? { kind: "ready" } : { kind: "idle" }, terminals, epoch: 1 }) as unknown as NodeView;
	const nodes = [view("a", true, [term("a1"), term("a2", "waiting")]), view("off", false, [term("x")]), view("b", true, [term("b1", "busy"), term("b2", "waiting")])];

	it("follows the agent list: ready nodes only, each node's waiting panes first", () => {
		expect(paneOrder(nodes).map((pane) => `${pane.node}/${pane.terminalId}${pane.waiting ? "*" : ""}`)).toEqual(["a/a2*", "a/a1", "b/b2*", "b/b1"]);
	});

	it("steps forward and back with wrapping, and from nothing to the ends", () => {
		const order = paneOrder(nodes);
		expect(stepPane(order, "a", "a1", 1)).toMatchObject({ node: "b", terminalId: "b2" });
		expect(stepPane(order, "b", "b1", 1)).toMatchObject({ node: "a", terminalId: "a2" });
		expect(stepPane(order, "a", "a2", -1)).toMatchObject({ node: "b", terminalId: "b1" });
		expect(stepPane(order, undefined, undefined, 1)).toMatchObject({ terminalId: "a2" });
		expect(stepPane(order, undefined, undefined, -1)).toMatchObject({ terminalId: "b1" });
		expect(stepPane([], "a", "a1", 1)).toBeUndefined();
	});

	it("jumps to the next waiting pane after the one on screen, never to itself", () => {
		const order = paneOrder(nodes);
		expect(nextWaiting(order, "a", "a2")).toMatchObject({ node: "b", terminalId: "b2" });
		expect(nextWaiting(order, "b", "b2")).toMatchObject({ node: "a", terminalId: "a2" });
		expect(nextWaiting(order, undefined, undefined)).toMatchObject({ terminalId: "a2" });
		expect(nextWaiting(paneOrder([view("a", true, [term("a1"), term("a2", "waiting")])]), "a", "a2")).toBeUndefined();
	});
});

describe("the shortcuts overlay", () => {
	it("lists every action, and shows and saves rebindings with their problems", () => {
		const { container } = render(<KeysHelp onClose={() => {}} />);
		for (const spec of ACTIONS) expect(container.querySelector(`[data-key-action='${spec.id}']`), spec.id).not.toBeNull();
		expect(container.querySelector("[data-keys-problems]")).toBeNull();

		fireEvent.click(container.querySelector("[data-keys-edit]")!);
		const editor = container.querySelector<HTMLTextAreaElement>("[data-keys-editor]")!;
		fireEvent.change(editor, { target: { value: '{"bindings":{"pane.next":"F2","pane.previous":"F2"}}' } });
		expect(container.querySelector("[data-keys-problems]")!.textContent).toMatch(/F2 is bound to both/);
		fireEvent.click(container.querySelector("[data-keys-save]")!);
		expect(localStorage.getItem(KEYS_KEY)).toBe('{"bindings":{"pane.next":"F2","pane.previous":"F2"}}');
		expect(screen.getByText(/Some key settings were not applied/)).toBeTruthy();
		expect(container.querySelector("[data-key-action='pane.next']")!.textContent).toContain("(yours)");

		fireEvent.click(container.querySelector("[data-keys-edit]")!);
		fireEvent.click(container.querySelector("[data-keys-reset]")!);
		expect(localStorage.getItem(KEYS_KEY)).toBeNull();
		expect(container.querySelector("[data-keys-problems]")).toBeNull();
	});
});
