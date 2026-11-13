/**
 * Deck's shortcuts, all in one registry: what each action is, its default chords per platform, where it may
 * fire, and the user's rebindings from `localStorage`.
 *
 * - **Platforms:** chords use Cmd on macOS; elsewhere Ctrl+Shift, as Ctrl-F, Ctrl-P, and most other Ctrl letters are
 *   readline's (and pi's) own keys.
 * - **Never taken:** the browser's and the system's own chords (Cmd-W, T, N, L and the like, `RESERVED`).
 * - **The terminal:** while focus is in it, only a Cmd chord (macOS) or a Ctrl+Shift chord (elsewhere) is intercepted;
 *   every other key goes to the shell or pi. Some actions do not fire there at all.
 * - **Text:** in a text field or the editor, a chord without Cmd, Ctrl, or Alt is typing, never a shortcut.
 * - **Tabs on macOS:** ⌘⌃ chords (⌘⌃←/→, ⌘⌃1–9, ⌘⌃W), as Chrome and Firefox take ⌘⌥←/→ and ⌘1–9 for their own tabs,
 *   and Firefox also ⌘⌥↑/↓ (`ShortcutUtils.getSystemActionForEvent`), even from a page that handles them.
 */

import { PANE_ACTIONS, type PaneActionId } from "./panes/keys";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export type ActionId =
	| PaneActionId
	| TabNumberId
	| "tab.next"
	| "tab.previous"
	| "tab.close"
	| "tab.reopen"
	| "sidebar.left"
	| "help"
	| "quickOpen"
	| "find"
	| "pane.next"
	| "pane.previous"
	| "pane.waiting"
	| "terminal.new"
	| "focus.terminal"
	| "focus.files"
	| "focus.editor"
	| "files.toggle"
	| "diff.next"
	| "diff.previous"
	| "rail.filter"
	| "rail.find"
	| "rail.rename"
	| "rail.remove";

/** "Go to tab N" in the focused group; tab 9 is the last tab, as in browsers. */
export type TabNumberId = "tab.1" | "tab.2" | "tab.3" | "tab.4" | "tab.5" | "tab.6" | "tab.7" | "tab.8" | "tab.9";
const TAB_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export interface ActionSpec {
	id: ActionId;
	label: string;
	group: "General" | "Agents" | "Panes" | "Tabs" | "Terminal" | "Files" | "Diff";
	mac: readonly string[];
	other: readonly string[];
	/** May fire while focus is in the terminal (then only with a Cmd or Ctrl+Shift chord). */
	terminal: boolean;
	/** May fire while focus is in a text field or the editor. */
	text: boolean;
	/** Fires only while focus is there (the agent list: on its rows, never in its filter). */
	only?: "terminal" | "diff" | "rail";
}

export const ACTIONS: readonly ActionSpec[] = [
	{ id: "help", label: "Show these shortcuts", group: "General", mac: ["?", "Cmd+/"], other: ["?", "Ctrl+/"], terminal: false, text: false },
	{ id: "quickOpen", label: "Open a file by name", group: "General", mac: ["Cmd+P"], other: ["Ctrl+Shift+P"], terminal: true, text: true },
	{ id: "sidebar.left", label: "Show or hide the agent list", group: "General", mac: ["Cmd+Shift+\\"], other: ["Ctrl+Shift+Alt+B"], terminal: true, text: true },
	{ id: "files.toggle", label: "Show or hide the explorer and changes", group: "General", mac: ["Cmd+\\"], other: ["Ctrl+Shift+\\"], terminal: true, text: true },
	{ id: "rail.filter", label: "Filter the agent list", group: "Agents", mac: ["Cmd+Alt+F"], other: ["Ctrl+Shift+Alt+F"], terminal: true, text: true },
	{ id: "rail.find", label: "Filter the agent list (in the list)", group: "Agents", mac: ["/"], other: ["/"], terminal: false, text: false, only: "rail" },
	{ id: "rail.rename", label: "Rename the agent, project, or checkout", group: "Agents", mac: ["F2"], other: ["F2"], terminal: false, text: false, only: "rail" },
	{ id: "rail.remove", label: "Remove the checkout from Deck, or the worktree", group: "Agents", mac: ["Delete", "Backspace"], other: ["Delete", "Backspace"], terminal: false, text: false, only: "rail" },
	{ id: "pane.next", label: "Next agent in the list", group: "Panes", mac: ["Cmd+Ctrl+ArrowDown"], other: ["Ctrl+Shift+ArrowDown"], terminal: true, text: true },
	{ id: "pane.previous", label: "Previous agent in the list", group: "Panes", mac: ["Cmd+Ctrl+ArrowUp"], other: ["Ctrl+Shift+ArrowUp"], terminal: true, text: true },
	{ id: "pane.waiting", label: "Next pane waiting for you", group: "Panes", mac: ["Cmd+Alt+Enter"], other: ["Ctrl+Shift+Enter"], terminal: true, text: true },
	{ id: "terminal.new", label: "New terminal in this worktree", group: "Panes", mac: ["Cmd+Alt+T"], other: ["Ctrl+Shift+`"], terminal: true, text: true },
	{ id: "focus.terminal", label: "Focus the terminal", group: "Panes", mac: ["Cmd+Alt+1"], other: ["Ctrl+Shift+1"], terminal: true, text: true },
	{ id: "focus.files", label: "Focus the file tree or changes", group: "Panes", mac: ["Cmd+Alt+2"], other: ["Ctrl+Shift+2"], terminal: true, text: true },
	{ id: "focus.editor", label: "Focus the editor", group: "Panes", mac: ["Cmd+Alt+3"], other: ["Ctrl+Shift+3"], terminal: true, text: true },
	{ id: "tab.next", label: "Next tab in the group", group: "Tabs", mac: ["Cmd+Ctrl+ArrowRight"], other: ["Ctrl+Shift+Alt+PageDown"], terminal: true, text: true },
	{ id: "tab.previous", label: "Previous tab in the group", group: "Tabs", mac: ["Cmd+Ctrl+ArrowLeft"], other: ["Ctrl+Shift+Alt+PageUp"], terminal: true, text: true },
	...TAB_NUMBERS.map((n): ActionSpec => ({
		id: `tab.${n}`,
		label: n === 9 ? "Last tab in the group" : `Tab ${n} in the group`,
		group: "Tabs",
		mac: [`Cmd+Ctrl+${n}`],
		other: [`Ctrl+Shift+Alt+${n}`],
		terminal: true,
		text: true,
	})),
	{ id: "tab.close", label: "Close the tab", group: "Tabs", mac: ["Cmd+Ctrl+W"], other: ["Ctrl+Shift+Alt+W"], terminal: true, text: true },
	{ id: "tab.reopen", label: "Reopen the closed tab", group: "Tabs", mac: ["Cmd+Ctrl+Shift+T"], other: ["Ctrl+Shift+Alt+T"], terminal: true, text: true },
	{ id: "find", label: "Find in the terminal", group: "Terminal", mac: ["Cmd+F"], other: ["Ctrl+Shift+F"], terminal: true, text: true, only: "terminal" },
	...PANE_ACTIONS,
	{ id: "diff.next", label: "Next change", group: "Diff", mac: ["F7", "Alt+ArrowDown"], other: ["F7", "Alt+ArrowDown"], terminal: false, text: true, only: "diff" },
	{ id: "diff.previous", label: "Previous change", group: "Diff", mac: ["Shift+F7", "Alt+ArrowUp"], other: ["Shift+F7", "Alt+ArrowUp"], terminal: false, text: true, only: "diff" },
];

const SPECS = new Map(ACTIONS.map((spec) => [spec.id, spec]));

/** Keys that are not the registry's: listed in the help, not rebindable. */
export const BUILT_IN: readonly { label: string; mac: string; other: string }[] = [
	{ label: "Save the file", mac: "⌘S", other: "Ctrl+S" },
	{ label: "Find in the editor", mac: "⌘F", other: "Ctrl+F" },
	{ label: "Open a path printed in the terminal", mac: "⌘-click", other: "Ctrl-click" },
	{ label: "Next or previous match while finding in the terminal", mac: "Enter, ⇧Enter", other: "Enter, Shift+Enter" },
	{ label: "Close a dialog or the find widget", mac: "Esc", other: "Esc" },
];

/** The browser's and the system's own chords: a binding to one is refused. */
export const RESERVED: { readonly mac: readonly string[]; readonly other: readonly string[] } = {
	mac: [
		"Cmd+W", "Cmd+T", "Cmd+N", "Cmd+L", "Cmd+Q", "Cmd+H", "Cmd+M", "Cmd+R", "Cmd+Shift+T", "Cmd+Shift+N", "Cmd+Shift+W",
		"Cmd+[", "Cmd+]", "Cmd+Shift+[", "Cmd+Shift+]", "Cmd+Alt+ArrowLeft", "Cmd+Alt+ArrowRight", "Cmd+Alt+I", "Cmd+Alt+J", "Cmd+Alt+B",
		"Cmd+C", "Cmd+V", "Cmd+X", "Cmd+A", "Cmd+Z", "Cmd+Shift+Z", "Cmd+`", "Cmd+Tab",
		"Cmd+1", "Cmd+2", "Cmd+3", "Cmd+4", "Cmd+5", "Cmd+6", "Cmd+7", "Cmd+8", "Cmd+9",
		// Firefox's tab keys, which it acts on even when the page handles them; and its full screen.
		"Cmd+Alt+ArrowUp", "Cmd+Alt+ArrowDown", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+PageUp", "Ctrl+PageDown", "Ctrl+Shift+PageUp", "Ctrl+Shift+PageDown",
		"Cmd+Ctrl+F",
	],
	other: [
		"Ctrl+W", "Ctrl+T", "Ctrl+N", "Ctrl+L", "Ctrl+Shift+T", "Ctrl+Shift+N", "Ctrl+Shift+W", "Ctrl+Shift+Q", "Ctrl+Tab", "Ctrl+Shift+Tab",
		"Ctrl+Shift+I", "Ctrl+Shift+J", "Ctrl+Shift+C", "Ctrl+Shift+V", "Ctrl+Shift+B", "Ctrl+Shift+Delete", "Alt+ArrowLeft", "Alt+ArrowRight", "Alt+F4",
		"Ctrl+C", "Ctrl+V", "Ctrl+X", "Ctrl+A", "Ctrl+Z", "Ctrl+Shift+Z",
		"Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5", "Ctrl+6", "Ctrl+7", "Ctrl+8", "Ctrl+9",
		"Ctrl+PageUp", "Ctrl+PageDown", "Ctrl+Shift+PageUp", "Ctrl+Shift+PageDown", "Ctrl+F4",
	],
};

// ---------------------------------------------------------------------------------------------------------------
// Chords

export interface Chord {
	meta: boolean;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	/** A lowercase letter, a digit, a punctuation character, or a named key (`ArrowDown`, `Enter`, `F7`, ...). */
	key: string;
}

const MODIFIERS: Record<string, "meta" | "ctrl" | "alt" | "shift"> = {
	cmd: "meta", command: "meta", meta: "meta", "⌘": "meta",
	ctrl: "ctrl", control: "ctrl", "⌃": "ctrl",
	alt: "alt", option: "alt", opt: "alt", "⌥": "alt",
	shift: "shift", "⇧": "shift",
};

const NAMED = new Map(
	["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown"]
		.concat(Array.from({ length: 12 }, (_, i) => `F${i + 1}`))
		.map((name) => [name.toLowerCase(), name] as const),
);
const ALIASES: Record<string, string> = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", esc: "Escape", return: "Enter" };

/** Punctuation that has a key of its own, matched by its physical key so Shift or Alt changing the character does not matter. */
const PUNCTUATION_CODES: Record<string, string> = {
	"/": "Slash", "\\": "Backslash", ".": "Period", ",": "Comma", ";": "Semicolon", "'": "Quote", "`": "Backquote",
	"[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal",
};

const isLetter = (key: string) => /^[a-z]$/.test(key);
const isDigit = (key: string) => /^[0-9]$/.test(key);
/** A character typed with Shift on most layouts (`?`): it matches whatever Shift says. */
const isShifted = (key: string) => key.length === 1 && !isLetter(key) && !isDigit(key) && !(key in PUNCTUATION_CODES);

/** `Cmd+Alt+ArrowDown`, `Ctrl+Shift+P`, `?`, `F7`: modifiers in any order and case, then one key. */
export function parseChord(text: string): Chord | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	// The last part is the key, which may itself be "+".
	const parts = trimmed.endsWith("++") ? [...trimmed.slice(0, -2).split("+"), "+"] : trimmed.split("+");
	const rawKey = parts.pop()!.trim();
	const chord: Chord = { meta: false, ctrl: false, alt: false, shift: false, key: "" };
	for (const part of parts) {
		const modifier = MODIFIERS[part.trim().toLowerCase()];
		if (!modifier || chord[modifier]) return undefined;
		chord[modifier] = true;
	}
	if (rawKey.length === 1) {
		if (/\s/.test(rawKey)) return undefined;
		chord.key = rawKey.toLowerCase();
	} else {
		const named = NAMED.get(rawKey.toLowerCase()) ?? ALIASES[rawKey.toLowerCase()];
		if (!named) return undefined;
		chord.key = named;
	}
	if (isShifted(chord.key) && chord.shift) return undefined;
	return chord;
}

/** The chord in one spelling, for comparing. */
export const chordId = (chord: Chord): string =>
	`${chord.meta ? "Cmd+" : ""}${chord.ctrl ? "Ctrl+" : ""}${chord.alt ? "Alt+" : ""}${chord.shift ? "Shift+" : ""}${isLetter(chord.key) ? chord.key.toUpperCase() : chord.key}`;

const KEY_NAMES: Record<string, readonly [string, string]> = {
	ArrowUp: ["↑", "Up"], ArrowDown: ["↓", "Down"], ArrowLeft: ["←", "Left"], ArrowRight: ["→", "Right"],
	Enter: ["↩", "Enter"], Escape: ["Esc", "Esc"], Tab: ["⇥", "Tab"], Space: ["Space", "Space"], Backspace: ["⌫", "Backspace"], Delete: ["⌦", "Delete"],
};

/** How the page writes a chord: `⌘⌥↓` on macOS, `Ctrl+Shift+Down` elsewhere. */
export function formatChord(chord: Chord, mac: boolean = IS_MAC): string {
	const names = KEY_NAMES[chord.key];
	const key = names ? names[mac ? 0 : 1] : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
	if (mac) return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.meta ? "⌘" : ""}${key}`;
	return [chord.ctrl && "Ctrl", chord.meta && "Meta", chord.alt && "Alt", chord.shift && "Shift", key].filter(Boolean).join("+");
}

export type KeyEventLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & { code?: string };

/** Whether `event` is `chord`. Letters, digits, and punctuation also match by physical key, as Alt (and Shift) change the character. */
export function matchChord(chord: Chord, event: KeyEventLike): boolean {
	if (event.metaKey !== chord.meta || event.ctrlKey !== chord.ctrl || event.altKey !== chord.alt) return false;
	if (isShifted(chord.key)) return event.key === chord.key;
	if (event.shiftKey !== chord.shift) return false;
	const code = event.code ?? "";
	if (isLetter(chord.key)) return event.key.toLowerCase() === chord.key || code === `Key${chord.key.toUpperCase()}`;
	if (isDigit(chord.key)) return event.key === chord.key || code === `Digit${chord.key}`;
	if (chord.key in PUNCTUATION_CODES) return event.key === chord.key || code === PUNCTUATION_CODES[chord.key];
	if (chord.key === "Space") return event.key === " " || code === "Space";
	return event.key === chord.key;
}

/** A chord the terminal lets the page have: Cmd on macOS, Ctrl+Shift (without Cmd) elsewhere. */
export const terminalSafe = (chord: Chord, mac: boolean = IS_MAC): boolean => (mac ? chord.meta : chord.ctrl && chord.shift && !chord.meta);

/** A chord a text field would type: no Cmd, Ctrl, or Alt, and not a function key. */
const typesText = (chord: Chord): boolean => !chord.meta && !chord.ctrl && !chord.alt && !/^F\d+$/.test(chord.key);

// ---------------------------------------------------------------------------------------------------------------
// Keymaps

export interface KeyProblem {
	action?: ActionId;
	message: string;
}

export interface Keymap {
	mac: boolean;
	bindings: ReadonlyMap<ActionId, readonly Chord[]>;
	/** Actions the settings rebound. */
	custom: ReadonlySet<ActionId>;
	/** Settings that were refused, and chords two actions wanted. */
	problems: readonly KeyProblem[];
}

/** Two actions can share a chord when focus can never be in both their places at once. */
const exclusive = (a: ActionSpec, b: ActionSpec): boolean => a.only !== undefined && b.only !== undefined && a.only !== b.only;

/**
 * The defaults, with `settings` (`{ "bindings": { "<action>": "Cmd+K" | ["Cmd+K", "F8"] | [] } }`) over them. Each
 * refused setting keeps the action's defaults and is reported; a chord two actions want goes to the rebound one (then
 * to the one listed first), and the other loses it, also reported.
 */
export function buildKeymap(settings: unknown, mac: boolean = IS_MAC): Keymap {
	const problems: KeyProblem[] = [];
	const bindings = new Map<ActionId, Chord[]>(ACTIONS.map((spec) => [spec.id, (mac ? spec.mac : spec.other).map((text) => parseChord(text)!)]));
	const custom = new Set<ActionId>();
	const reserved = new Set((mac ? RESERVED.mac : RESERVED.other).map((text) => chordId(parseChord(text)!)));

	if (settings !== undefined && settings !== null) {
		const rebound = typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>).bindings : undefined;
		if (typeof settings !== "object" || Array.isArray(settings)) problems.push({ message: "The settings are not a JSON object; the defaults apply." });
		else {
			for (const key of Object.keys(settings)) if (key !== "bindings" && key !== "version") problems.push({ message: `Unknown setting "${key}".` });
			if (rebound !== undefined && (typeof rebound !== "object" || rebound === null || Array.isArray(rebound)))
				problems.push({ message: '"bindings" is not an object of action names to chords.' });
		}
		if (rebound && typeof rebound === "object" && !Array.isArray(rebound)) {
			for (const [name, value] of Object.entries(rebound as Record<string, unknown>)) {
				const spec = SPECS.get(name as ActionId);
				if (!spec) {
					problems.push({ message: `Unknown action "${name}".` });
					continue;
				}
				const texts = typeof value === "string" ? [value] : Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
				if (!texts) {
					problems.push({ action: spec.id, message: `${spec.label}: give a chord, a list of chords, or [] for none.` });
					continue;
				}
				const chords: Chord[] = [];
				let refused = false;
				for (const text of texts) {
					const chord = parseChord(text);
					if (!chord) problems.push({ action: spec.id, message: `${spec.label}: "${text}" is not a chord.` });
					else if (reserved.has(chordId(chord))) problems.push({ action: spec.id, message: `${spec.label}: ${formatChord(chord, mac)} belongs to the browser.` });
					else {
						chords.push(chord);
						continue;
					}
					refused = true;
				}
				if (refused) continue;
				bindings.set(spec.id, chords);
				custom.add(spec.id);
			}
		}
	}

	// Conflicts: the rebound action, then the earlier one, keeps the chord.
	const order = [...ACTIONS].sort((a, b) => Number(custom.has(b.id)) - Number(custom.has(a.id)));
	const owners = new Map<string, ActionSpec[]>();
	for (const spec of order) {
		const kept: Chord[] = [];
		for (const chord of bindings.get(spec.id)!) {
			const id = chordId(chord);
			const holder = owners.get(id)?.find((other) => !exclusive(other, spec));
			if (holder) {
				problems.push({ action: spec.id, message: `${formatChord(chord, mac)} is bound to both "${holder.label}" and "${spec.label}"; "${holder.label}" keeps it.` });
				continue;
			}
			owners.set(id, [...(owners.get(id) ?? []), spec]);
			kept.push(chord);
		}
		bindings.set(spec.id, kept);
	}
	return { mac, bindings, custom, problems };
}

/** Where focus is, for deciding what a key may do. */
export interface KeyFocus {
	terminal: boolean;
	/** A text field or the editor (the terminal's own text area counts as the terminal). */
	text: boolean;
	diff: boolean;
	/** The agent list (a row or its filter). */
	rail?: boolean;
}

export function focusOf(target: EventTarget | null): KeyFocus {
	if (!(target instanceof Element)) return { terminal: false, text: false, diff: false, rail: false };
	const terminal = target.closest(".xterm") !== null;
	const element = target as HTMLElement;
	const text =
		!terminal &&
		(element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT" || element.isContentEditable || target.closest(".monaco-editor") !== null);
	return { terminal, text, diff: target.closest("[data-diff-view]") !== null, rail: target.closest("[data-agent-list]") !== null };
}

/** The action `event` asks for with focus at `focus`, if any. */
export function resolveKey(keymap: Keymap, event: KeyEventLike, focus: KeyFocus): ActionId | undefined {
	for (const spec of ACTIONS) {
		if (spec.only === "terminal" && !focus.terminal) continue;
		if (spec.only === "diff" && !focus.diff) continue;
		if (spec.only === "rail" && !focus.rail) continue;
		if (focus.terminal && !spec.terminal) continue;
		if (focus.text && !spec.text) continue;
		for (const chord of keymap.bindings.get(spec.id) ?? []) {
			if (!matchChord(chord, event)) continue;
			if (focus.terminal && !terminalSafe(chord, keymap.mac)) continue;
			if ((focus.terminal || focus.text) && typesText(chord)) continue;
			return spec.id;
		}
	}
	return undefined;
}

/**
 * What the page's parts do for an action; each part registers its own while it shows. A handler that returns false
 * had nothing to do, and the key goes on to the page as if unbound.
 */
export type PageCommands = Partial<Record<ActionId, () => boolean | void>>;

/** Whether `event` is one of `action`'s chords, wherever focus is. */
export const isAction = (keymap: Keymap, action: ActionId, event: KeyEventLike): boolean =>
	(keymap.bindings.get(action) ?? []).some((chord) => matchChord(chord, event));

/** An action's first chord as the page writes it, for hints; undefined when it has none. */
export function actionShortcut(action: ActionId, keymap: Keymap = currentKeymap()): string | undefined {
	const chord = keymap.bindings.get(action)?.[0];
	return chord && formatChord(chord, keymap.mac);
}

// ---------------------------------------------------------------------------------------------------------------
// Settings in localStorage

export const KEYS_KEY = "pika.nodes.keys";

export const KEYS_EXAMPLE = `{
  "bindings": {
    "pane.next": "${IS_MAC ? "Cmd+Alt+N" : "Ctrl+Shift+Alt+N"}",
    "diff.next": ["F8", "Alt+ArrowDown"],
    "tab.close": []
  }
}`;

export interface KeySettings {
	/** The stored JSON, or null for none. */
	text: string | null;
	keymap: Keymap;
}

/** The keymap stored settings give; unreadable JSON is a problem and the defaults apply. */
export function keymapFrom(text: string | null, mac: boolean = IS_MAC): Keymap {
	if (text === null || text.trim() === "") return buildKeymap(undefined, mac);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const keymap = buildKeymap(undefined, mac);
		return { ...keymap, problems: [{ message: `The settings are not JSON (${error instanceof Error ? error.message : String(error)}); the defaults apply.` }] };
	}
	return buildKeymap(parsed, mac);
}

function readStored(): string | null {
	try {
		return globalThis.localStorage?.getItem(KEYS_KEY) ?? null;
	} catch {
		return null;
	}
}

let settings: KeySettings | undefined;
const listeners = new Set<() => void>();

/** The page's settings and keymap, read once and kept current with other tabs' changes. */
export function keySettings(): KeySettings {
	if (!settings) {
		const text = readStored();
		settings = { text, keymap: keymapFrom(text) };
		if (typeof window !== "undefined")
			window.addEventListener("storage", (event) => {
				if (event.key !== KEYS_KEY && event.key !== null) return;
				const next = readStored();
				settings = { text: next, keymap: keymapFrom(next) };
				for (const listener of listeners) listener();
			});
	}
	return settings;
}

export const currentKeymap = (): Keymap => keySettings().keymap;

export function subscribeKeys(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Stores new settings (null removes them) and returns the keymap they give, problems included. */
export function saveKeySettings(text: string | null): Keymap {
	const keymap = keymapFrom(text);
	try {
		if (text === null || text.trim() === "") globalThis.localStorage?.removeItem(KEYS_KEY);
		else globalThis.localStorage?.setItem(KEYS_KEY, text);
	} catch {
		// Private browsing or a full quota: the settings last for this page only.
	}
	settings = { text: text?.trim() ? text : null, keymap };
	for (const listener of listeners) listener();
	return keymap;
}

// ---------------------------------------------------------------------------------------------------------------
// The terminal's own checks

/** Find in the terminal (Cmd-F, or Ctrl-Shift-F, unless rebound). */
export const isFindKey = (event: KeyEventLike, mac: boolean = IS_MAC): boolean =>
	isAction(mac === IS_MAC ? currentKeymap() : buildKeymap(undefined, mac), "find", event);

/** Quick open (Cmd-P, or Ctrl-Shift-P, unless rebound). */
export const isQuickOpenKey = (event: KeyEventLike, mac: boolean = IS_MAC): boolean =>
	isAction(mac === IS_MAC ? currentKeymap() : buildKeymap(undefined, mac), "quickOpen", event);

/** The modifier a link click needs, for hints. */
export const LINK_MODIFIER = IS_MAC ? "⌘" : "Ctrl";
