import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
	closure, FindingsPicker, initialState, parseChecklist, PickParameters, pickResult, recommendedSet, registerPickerTool, renderChecklist, toggle, validateFindings,
	type Finding, type PickerAction, type PickState, VISIBLE_ROWS,
} from "../../src/adapter/picker.ts";

const FINDINGS: Finding[] = [
	{ id: "1", title: "Delete the unused v1 plan parser", kind: "deletion", effort: "S", risk: "low", confidence: "HIGH", summary: "The v1 parser has no callers since the v2 format landed.", evidence: "src/plan/v1.ts:1", recommended: true },
	{ id: "2", title: "Merge the two retry helpers", kind: "duplicate", effort: "S", risk: "low", confidence: "HIGH", summary: "Two helpers implement the same backoff.", recommended: true },
	{ id: "3", title: "Inline the RunFactory wrapper", kind: "abstraction", effort: "M", risk: "med", confidence: "MED", summary: "The wrapper forwards every call unchanged." },
	{ id: "4", title: "Drop the legacy --plan flag", kind: "compat", effort: "S", risk: "low", confidence: "HIGH", summary: "Only the v1 parser reads the flag.", dependsOn: ["1"], recommended: true },
	{ id: "5", title: "Remove the v1 fixtures", summary: "Fixtures for the v1 format.", dependsOn: ["4"] },
];

const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b" };
const keybindings = { matches: (data: string, binding: string) => ({ "tui.select.up": KEYS.up, "tui.select.down": KEYS.down, "tui.select.confirm": KEYS.enter, "tui.select.cancel": KEYS.esc } as Record<string, string>)[binding] === data };
// Real escape codes, so width checks see styled lines as Pi renders them.
const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

function picker(state: PickState) {
	const actions: PickerAction[] = [];
	const tui = { requestRender: vi.fn() };
	const component = new FindingsPicker(state, tui, theme, keybindings, (action) => actions.push(action));
	return { component, actions, tui, press: (...keys: string[]) => { for (const key of keys) component.handleInput(key); } };
}

const many = (count: number): Finding[] => Array.from({ length: count }, (_, index) => ({ id: String(index + 1), title: `Finding number ${index + 1}`, summary: `Summary ${index + 1}` }));

describe("validateFindings", () => {
	it("accepts valid findings", () => expect(() => validateFindings(FINDINGS)).not.toThrow());
	it("rejects duplicate ids", () => expect(() => validateFindings([FINDINGS[0]!, { ...FINDINGS[1]!, id: "1" }])).toThrow('Duplicate finding id "1"'));
	it("rejects unknown dependencies", () => expect(() => validateFindings([{ ...FINDINGS[0]!, dependsOn: ["9"] }])).toThrow("Finding 1 depends on unknown finding 9."));
	it("rejects self dependencies", () => expect(() => validateFindings([{ ...FINDINGS[0]!, dependsOn: ["1"] }])).toThrow("Finding 1 depends on itself."));
	it("rejects ids with whitespace", () => {
		expect(() => validateFindings([{ ...FINDINGS[0]!, id: "1 a" }])).toThrow('Finding id "1 a" must be a single word without spaces');
		expect(Value.Check(PickParameters, { title: "x", findings: [{ ...FINDINGS[0]!, id: "1 a" }] })).toBe(false);
		expect(Value.Check(PickParameters, { title: "x", findings: [FINDINGS[0]!] })).toBe(true);
	});
});

describe("selection", () => {
	it("follows dependencies both ways, transitively", () => {
		expect([...closure(FINDINGS, "5", "needs")].sort()).toEqual(["1", "4", "5"]);
		expect([...closure(FINDINGS, "1", "neededBy")].sort()).toEqual(["1", "4", "5"]);
		expect(toggle(FINDINGS, new Set(), "5")).toEqual({ selected: new Set(["5", "4", "1"]), added: ["1", "4"], removed: [] });
		expect(toggle(FINDINGS, new Set(["1", "2", "4", "5"]), "1")).toEqual({ selected: new Set(["2"]), added: [], removed: ["4", "5"] });
	});

	it("terminates on cycles", () => {
		const cycle: Finding[] = [{ id: "1", title: "a", summary: "a", dependsOn: ["2"] }, { id: "2", title: "b", summary: "b", dependsOn: ["3"] }, { id: "3", title: "c", summary: "c", dependsOn: ["1"] }];
		expect(toggle(cycle, new Set(), "1").selected).toEqual(new Set(["1", "2", "3"]));
		expect(toggle(cycle, new Set(["1", "2", "3"]), "2").selected).toEqual(new Set());
	});

	it("starts from the recommended set with its dependencies", () => {
		expect(recommendedSet(FINDINGS)).toEqual(new Set(["1", "2", "4"]));
		expect(recommendedSet([{ ...FINDINGS[0]!, recommended: false }, { ...FINDINGS[3]!, recommended: true }])).toEqual(new Set(["4", "1"]));
	});
});

describe("FindingsPicker", () => {
	it("selects all, none, and the recommended set", () => {
		const state = initialState("Simplify", FINDINGS);
		const { press, tui } = picker(state);
		press("a");
		expect(state.selected.size).toBe(5);
		press("n");
		expect(state.selected.size).toBe(0);
		press("r");
		expect(state.selected).toEqual(new Set(["1", "2", "4"]));
		expect(tui.requestRender).toHaveBeenCalledTimes(3);
	});

	it("toggles by digit and space, reporting dependency changes", () => {
		const state = initialState("Simplify", FINDINGS);
		const { press, component } = picker(state);
		press("1");
		expect(state.selected).toEqual(new Set(["2"]));
		expect(state.cursor).toBe(0);
		expect(component.render(80).map(plain)).toContain("   also cleared #4");
		press("5");
		expect(state.selected).toEqual(new Set(["1", "2", "4", "5"]));
		expect(component.render(80).map(plain)).toContain("   also selected #1, #4");
		press(KEYS.up, KEYS.up, " ");
		expect(state.cursor).toBe(2);
		expect(state.selected.has("3")).toBe(true);
		press("9");
		expect(state.selected.has("9")).toBe(false);
	});

	it("moves, wraps, confirms, cancels, and asks for a note", () => {
		const state = initialState("Simplify", FINDINGS);
		const { press, actions } = picker(state);
		press(KEYS.down, KEYS.down);
		expect(state.cursor).toBe(2);
		press(KEYS.up, KEYS.up, KEYS.up);
		expect(state.cursor).toBe(4);
		press(KEYS.enter, KEYS.esc, "e");
		expect(actions).toEqual(["confirm", "cancel", "note"]);
	});

	it("renders rows, dependencies, the highlighted finding, and its evidence", () => {
		const state = initialState("Simplify · standard · src/", FINDINGS);
		const lines = picker(state).component.render(100).map(plain);
		expect(lines[0]).toMatch(/^ Simplify · standard · src\/ +5 findings · 3 selected $/);
		expect(lines).toContainEqual(expect.stringMatching(/^ ▸ \[x\] 1  Delete the unused v1 plan parser +deletion +S +low +HIGH/));
		expect(lines).toContainEqual(expect.stringMatching(/^   \[ \] 3  Inline the RunFactory wrapper +abstraction +M +med +MED/));
		expect(lines).toContainEqual(expect.stringContaining("Drop the legacy --plan flag (needs 1)"));
		expect(lines).toContain(" #1  The v1 parser has no callers since the v2 format landed.");
		expect(lines).toContain("     src/plan/v1.ts:1");
	});

	it("fits every line at narrow widths and with wide characters", () => {
		const wide = initialState("簡素化 · 標準 · ソース/ディレクトリ", [...FINDINGS.slice(0, 4), { ...FINDINGS[4]!, title: "削除する古いフィクスチャ", summary: "古い形式のフィクスチャは使われていません。".repeat(3) }]);
		for (const state of [initialState("Simplify · standard · src/", FINDINGS), wide]) {
			const { component, press } = picker(state);
			for (let i = 0; i < 5; i++) {
				for (const width of [30, 31, 45, 80, 200]) {
					const lines = component.render(width);
					for (const line of lines) expect(visibleWidth(line), JSON.stringify(plain(line))).toBeLessThanOrEqual(width);
					expect(lines.some((line) => plain(line).includes("▸"))).toBe(true);
				}
				press(KEYS.down, " ");
			}
		}
	});

	it("keeps newlines in fields out of the rendered lines", () => {
		const findings: Finding[] = [
			{ id: "1", title: "Delete\nthe   parser", kind: "dele\ntion", effort: "S\r\n", risk: "lo\tw", confidence: "HI\nGH", summary: "First line.\nSecond line.\r\nThird.", evidence: "a.ts:1\nb.ts:2", dependsOn: ["2"] },
			{ id: "2", title: "Merge\n\nhelpers", summary: "x" },
		];
		const state = initialState("Simplify\n· src/", findings);
		state.note = "line one\nline two";
		const { component } = picker(state);
		for (const width of [20, 40, 80, 200]) {
			const lines = component.render(width);
			for (const line of lines) {
				expect(line).not.toMatch(/[\r\n]/);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		const lines = component.render(200).map(plain);
		expect(lines[0]).toMatch(/^ Simplify · src\/ +2 findings · 0 selected $/);
		expect(lines).toContainEqual(expect.stringMatching(/^ ▸ \[ \] 1  Delete the parser \(needs 2\) +dele tion +S +lo w +HI GH$/));
		expect(lines).toContainEqual(expect.stringMatching(/^   \[ \] 2  Merge helpers +$/));
		expect(lines.slice(5, 12)).toEqual([" #1  First line.", "     Second line.", "     Third.", "     a.ts:1", "     b.ts:2", " note: line one", "       line two"]);
	});

	it("caches by width and rerenders after invalidate", () => {
		const state = initialState("Simplify", FINDINGS);
		const { component } = picker(state);
		const lines = component.render(60);
		expect(component.render(60)).toBe(lines);
		component.invalidate();
		expect(component.render(60)).not.toBe(lines);
	});

	it("windows long lists around the highlighted row", () => {
		const state = initialState("Long", many(30));
		const { component, press } = picker(state);
		const rows = () => component.render(60).map(plain).filter((line) => /^ [▸ ] \[/.test(line));
		expect(rows()).toHaveLength(VISIBLE_ROWS);
		for (let i = 0; i < 29; i++) {
			press(KEYS.down);
			const visible = rows();
			expect(visible).toHaveLength(VISIBLE_ROWS);
			expect(visible.some((line) => line.startsWith(" ▸ ") && line.includes(`Finding number ${state.cursor + 1} `))).toBe(true);
		}
		expect(component.render(60).map(plain)).toContain("   30/30");
		press(KEYS.down);
		expect(rows()[0]).toContain("Finding number 1 ");
	});
});

describe("editor checklist", () => {
	it("round-trips the selection and the note", () => {
		const text = renderChecklist("Simplify", FINDINGS, recommendedSet(FINDINGS));
		expect(text.split("\n")).toEqual([
			"# Simplify",
			"# Mark the findings to resolve with [x]; leave [ ] to skip. A line starting with \"note:\" adds a note.",
			"[x] 1  Delete the unused v1 plan parser — deletion · S · low · HIGH",
			"[x] 2  Merge the two retry helpers — duplicate · S · low · HIGH",
			"[ ] 3  Inline the RunFactory wrapper — abstraction · M · med · MED",
			"[x] 4  Drop the legacy --plan flag (needs 1) — compat · S · low · HIGH",
			"[ ] 5  Remove the v1 fixtures (needs 4)",
			"note:",
		]);
		expect(parseChecklist(text, FINDINGS)).toEqual({ selected: ["1", "2", "4"] });
		const edited = text.replace("[x] 1", "[ ] 1").replace("[x] 2", "[ ] 2").replace("[ ] 3", "[X] 3").replace(/^note:$/m, "note:  keep the flag docs  ") + "\n[x] 42 unknown\n\n# [x] 2 commented";
		expect(parseChecklist(edited, FINDINGS)).toEqual({ selected: ["1", "3", "4"], note: "keep the flag docs" });
		expect(parseChecklist("[x] 5", FINDINGS)).toEqual({ selected: ["1", "4", "5"] });
	});

	it("keeps one line per finding when fields contain newlines", () => {
		const findings: Finding[] = [{ id: "1", title: "Delete\nthe parser", kind: "dele\r\ntion", summary: "a\nb" }, { id: "2", title: "Merge", summary: "x", dependsOn: ["1"] }];
		const text = renderChecklist("Simplify\nsrc/", findings, new Set(["1"]), "keep\nit");
		expect(text.split("\n")).toEqual([
			"# Simplify src/",
			"# Mark the findings to resolve with [x]; leave [ ] to skip. A line starting with \"note:\" adds a note.",
			"[x] 1  Delete the parser — dele tion",
			"[ ] 2  Merge (needs 1)",
			"note: keep it",
		]);
		expect(parseChecklist(text, findings)).toEqual({ selected: ["1"], note: "keep it" });
	});
});

describe("pickResult", () => {
	it("describes selected, none, cancelled, and notes", () => {
		const text = (details: Parameters<typeof pickResult>[1]) => pickResult(8, details).content[0]!.text;
		expect(text({ selected: ["1", "2", "4"], cancelled: false, via: "picker" })).toBe("Selected 3 of 8: #1, #2, #4.");
		expect(text({ selected: ["1"], note: "be careful", cancelled: false, via: "editor" })).toBe("Selected 1 of 8: #1.\nNote: be careful");
		expect(text({ selected: [], cancelled: false, via: "picker" })).toBe("Selected none of 8; start no run.");
		expect(text({ selected: [], cancelled: true, via: "picker" })).toBe("The user cancelled the selection; start no run.");
		expect(pickResult(8, { selected: ["2"], cancelled: false, via: "picker" }).details).toEqual({ selected: ["2"], cancelled: false, via: "picker" });
	});
});

describe("herder_pick_findings", () => {
	function setup(mode: string, hasUI: boolean, { sessions = [] as string[][], edits = [] as Array<string | undefined>, onEdit = undefined as (() => void) | undefined } = {}) {
		const tools = new Map<string, any>();
		registerPickerTool({ registerTool: (tool: { name: string }) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
		const custom = vi.fn((factory: (...args: unknown[]) => FindingsPicker) => new Promise((resolve) => {
			const component = factory({ requestRender() {} }, theme, keybindings, resolve);
			component.render(80);
			for (const key of sessions.shift() ?? []) component.handleInput(key);
		}));
		// Without a queued answer the editor stays open until something else settles the pick.
		const editor = vi.fn((_title: string, _prefill?: string) => {
			onEdit?.();
			return edits.length ? Promise.resolve(edits.shift()) : new Promise<string | undefined>(() => {});
		});
		const ctx = { mode, hasUI, ui: { custom, editor } } as unknown as ExtensionContext;
		const tool = tools.get("herder_pick_findings");
		const run = (params: unknown = { title: "Simplify · standard · src/", findings: FINDINGS }, signal?: AbortSignal) => tool.execute("call", params, signal, undefined, ctx);
		return { tool, custom, editor, run };
	}

	it("registers a sequential tool with compact renderers", () => {
		const { tool } = setup("tui", true);
		expect(tool).toMatchObject({ name: "herder_pick_findings", label: "Herder Pick Findings", executionMode: "sequential" });
		const call = tool.renderCall({ title: "Simplify · src/", findings: FINDINGS }, theme, {});
		expect(plain(call.render(80)[0]).trim()).toBe("pick findings: Simplify · src/ (5)");
		const result = tool.renderResult(pickResult(5, { selected: ["1"], note: "n", cancelled: false, via: "picker" }), { expanded: false, isPartial: false }, theme, { isError: false });
		expect(result.render(80).map((line: string) => plain(line).trim()).filter(Boolean)).toEqual(["Selected 1 of 5: #1."]);
	});

	it("colors errors, cancels, and selections", () => {
		const { tool } = setup("tui", true);
		const fg = vi.fn((_color: string, text: string) => text);
		const color = (result: unknown, isError: boolean) => {
			fg.mockClear();
			tool.renderResult(result, { expanded: false, isPartial: false }, { ...theme, fg }, { isError });
			return fg.mock.calls[0]![0];
		};
		expect(color({ content: [{ type: "text", text: "Duplicate finding id \"1\"" }] }, true)).toBe("error");
		expect(color(pickResult(5, { selected: [], cancelled: true, via: "picker" }), false)).toBe("warning");
		expect(color(pickResult(5, { selected: ["1"], cancelled: false, via: "picker" }), false)).toBe("success");
	});

	it("accepts the recommendation with Enter in the TUI", async () => {
		const { run, editor } = setup("tui", true, { sessions: [[KEYS.enter]] });
		expect(await run()).toEqual({ content: [{ type: "text", text: "Selected 3 of 5: #1, #2, #4." }], details: { selected: ["1", "2", "4"], cancelled: false, via: "picker" } });
		expect(editor).not.toHaveBeenCalled();
	});

	it("keeps the selection across a note edit in a fresh picker", async () => {
		const { run, custom, editor } = setup("tui", true, { sessions: [["3", "e"], ["e"], ["e"], ["n", "2", KEYS.enter]], edits: [" check the docs ", undefined, "keep it short"] });
		const result = await run();
		expect(result.details).toEqual({ selected: ["2"], note: "keep it short", cancelled: false, via: "picker" });
		expect(result.content[0].text).toBe("Selected 1 of 5: #2.\nNote: keep it short");
		expect(custom).toHaveBeenCalledTimes(4);
		expect(editor.mock.calls.map((call) => call[1])).toEqual(["", "check the docs", "check the docs"]);
		expect(editor.mock.calls[0]![0]).toBe("Note for the selected findings");
		expect(new Set(custom.mock.results.map((entry) => entry.value)).size).toBe(4);
	});

	it("keeps the note when the editor is dismissed and clears it when emptied", async () => {
		const kept = await setup("tui", true, { sessions: [["e"], ["e"], [KEYS.enter]], edits: ["first", undefined] }).run();
		expect(kept.details).toEqual({ selected: ["1", "2", "4"], note: "first", cancelled: false, via: "picker" });
		const cleared = await setup("tui", true, { sessions: [["e"], ["e"], [KEYS.enter]], edits: ["first", "  \n "] }).run();
		expect(cleared.details).toEqual({ selected: ["1", "2", "4"], cancelled: false, via: "picker" });
	});

	it("cancels on abort without opening, while the picker is open, and during the note editor", async () => {
		const CANCELLED = { selected: [], cancelled: true, via: "picker" };
		const before = setup("tui", true);
		expect((await before.run(undefined, AbortSignal.abort())).details).toEqual(CANCELLED);
		expect(before.custom).not.toHaveBeenCalled();
		expect((await setup("rpc", true).run(undefined, AbortSignal.abort())).details).toEqual({ ...CANCELLED, via: "editor" });

		const open = new AbortController();
		const picking = setup("tui", true, { sessions: [["n", "2"]] });
		const result = picking.run(undefined, open.signal);
		await vi.waitFor(() => expect(picking.custom).toHaveBeenCalledTimes(1));
		const remove = vi.spyOn(open.signal, "removeEventListener");
		open.abort();
		expect((await result).details).toEqual(CANCELLED);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));

		const editing = new AbortController();
		const noting = setup("tui", true, { sessions: [["e"]], onEdit: () => queueMicrotask(() => editing.abort()) });
		expect((await noting.run(undefined, editing.signal)).details).toEqual(CANCELLED);
		expect(noting.custom).toHaveBeenCalledTimes(1);

		const checklist = new AbortController();
		const rpc = setup("rpc", true, { onEdit: () => queueMicrotask(() => checklist.abort()) });
		expect((await rpc.run(undefined, checklist.signal)).details).toEqual({ ...CANCELLED, via: "editor" });
	});

	it("confirms normally when the signal never aborts", async () => {
		const controller = new AbortController();
		expect((await setup("tui", true, { sessions: [["e"], [KEYS.enter]], edits: ["go"] }).run(undefined, controller.signal)).details).toEqual({ selected: ["1", "2", "4"], note: "go", cancelled: false, via: "picker" });
	});

	it("reports none and cancel in the TUI", async () => {
		expect((await setup("tui", true, { sessions: [["n", KEYS.enter]] }).run()).content[0].text).toBe("Selected none of 5; start no run.");
		expect((await setup("tui", true, { sessions: [[KEYS.esc]] }).run()).details).toEqual({ selected: [], cancelled: true, via: "picker" });
	});

	it("falls back to the editor over RPC", async () => {
		const prefill = renderChecklist("Simplify · standard · src/", FINDINGS, recommendedSet(FINDINGS));
		const { run, editor, custom } = setup("rpc", true, { edits: [prefill.replace("[ ] 5", "[x] 5").replace(/^note:$/m, "note: go")] });
		expect(await run()).toEqual({ content: [{ type: "text", text: "Selected 4 of 5: #1, #2, #4, #5.\nNote: go" }], details: { selected: ["1", "2", "4", "5"], note: "go", cancelled: false, via: "editor" } });
		expect(editor).toHaveBeenCalledWith("Simplify · standard · src/", prefill);
		expect(custom).not.toHaveBeenCalled();
		expect((await setup("rpc", true, { edits: [undefined] }).run()).details).toEqual({ selected: [], cancelled: true, via: "editor" });
	});

	it("needs an interactive session", async () => {
		await expect(setup("print", false).run()).rejects.toThrow("herder_pick_findings needs an interactive session; ask the user in chat which findings to resolve.");
	});

	it("validates findings before asking", async () => {
		const { run, custom } = setup("tui", true);
		await expect(run({ title: "x", findings: [FINDINGS[0], FINDINGS[0]] })).rejects.toThrow("Duplicate finding id");
		expect(custom).not.toHaveBeenCalled();
	});
});
