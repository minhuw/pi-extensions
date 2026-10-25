import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { type Answer, confirmLong, ScrollableConfirm } from "../../src/adapter/confirm.ts";

const KEYS = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F", tab: "\t", enter: "\r", esc: "\x1b" };
const keybindings = { matches: (data: string, binding: string) => ({ "tui.select.up": KEYS.up, "tui.select.down": KEYS.down, "tui.select.pageDown": KEYS.pageDown, "tui.select.confirm": KEYS.enter, "tui.select.cancel": KEYS.esc } as Record<string, string>)[binding] === data };
const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const LONG = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");

function dialog(body: string, rows = 30) {
	const answers: Answer[] = [];
	const tui = { requestRender: vi.fn(), terminal: { rows } };
	const component = new ScrollableConfirm("Approve Herder goal: X", body, tui, theme, keybindings, (yes) => answers.push(yes));
	return { component, answers, tui, press: (...keys: string[]) => { for (const key of keys) component.handleInput(key); }, text: (width = 80) => component.render(width).map(plain) };
}

describe("ScrollableConfirm", () => {
	it("keeps the choice on screen and answerable however long the body is", () => {
		for (const [key, answer] of [["y", true], ["n", false]] as const) {
			const { text, press, answers } = dialog(LONG, 30);
			const lines = text();
			expect(lines.length).toBeLessThanOrEqual(30);
			expect(lines.some((line) => line.includes("▸ Yes") && line.includes("No"))).toBe(true);
			expect(lines).toContain(" line 1");
			expect(lines).not.toContain(" line 200");
			expect(lines.some((line) => /lines 1-\d+ of 200 · \d+ more below/.test(line))).toBe(true);
			press(key);
			expect(answers).toEqual([answer]);
		}
	});

	it("never answers on scroll or choice keys", () => {
		const { press, answers, text } = dialog(LONG, 30);
		press(KEYS.down, "j", KEYS.pageDown, " ", KEYS.end, "G", KEYS.up, "k", KEYS.pageUp, KEYS.home, "g", KEYS.left, KEYS.right, KEYS.tab, "x");
		expect(answers).toEqual([]);
		// Three toggles leave No highlighted.
		expect(text().some((line) => line.includes("▸ No"))).toBe(true);
	});

	it("shows a short body whole, without a scroll status", () => {
		const lines = dialog("one\ntwo", 30).text();
		expect(lines).toEqual(expect.arrayContaining([" one", " two"]));
		expect(lines.some((line) => line.includes("lines "))).toBe(false);
	});

	it("scrolls by line, page, and to the end, clamped to the body", () => {
		const { press, text, tui } = dialog(LONG, 30);
		press(KEYS.up);
		expect(text()).toContain(" line 1");
		press(KEYS.down);
		expect(text()).toContain(" line 2");
		expect(text()).not.toContain(" line 1");
		press(KEYS.pageDown);
		expect(text()).not.toContain(" line 2");
		press(KEYS.end, KEYS.down);
		const lines = text();
		expect(lines).toContain(" line 200");
		expect(lines.some((line) => line.endsWith("of 200 · end"))).toBe(true);
		expect(tui.requestRender).toHaveBeenCalled();
	});

	it("answers with y, n, and enter on the highlighted choice; esc closes without an answer", () => {
		const yes = dialog(LONG);
		yes.press("y");
		const no = dialog(LONG);
		no.press("n");
		const esc = dialog(LONG);
		esc.press(KEYS.esc);
		const enter = dialog(LONG);
		enter.press(KEYS.enter);
		const switched = dialog(LONG);
		switched.press(KEYS.left);
		expect(switched.text().some((line) => line.includes("▸ No"))).toBe(true);
		switched.press(KEYS.enter);
		expect([yes.answers, no.answers, esc.answers, enter.answers, switched.answers]).toEqual([[true], [false], [undefined], [true], [false]]);
	});

	it("fits every line to narrow widths and tiny terminals", () => {
		for (const width of [10, 40]) for (const rows of [3, 12]) {
			for (const line of dialog(`${"word ".repeat(80)}\n${LONG}`, rows).component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("confirmLong", () => {
	const ctx = (mode: string, custom = vi.fn(), confirm = vi.fn(async () => true)) => ({ mode, ui: { custom, confirm } }) as unknown as ExtensionContext & { ui: { custom: typeof custom; confirm: typeof confirm } };

	it("uses ui.confirm outside the TUI, passing the signal", async () => {
		const context = ctx("rpc");
		const signal = new AbortController().signal;
		await expect(confirmLong(context, "T", "B", signal)).resolves.toBe(true);
		expect(context.ui.confirm).toHaveBeenCalledWith("T", "B", { signal });
		expect(context.ui.custom).not.toHaveBeenCalled();
	});

	it("shows the scrollable dialog in the TUI and returns its answer", async () => {
		const custom = vi.fn((factory: (...args: unknown[]) => ScrollableConfirm) => new Promise((resolve) => {
			factory({ requestRender() {}, terminal: { rows: 30 } }, theme, keybindings, resolve).handleInput("y");
		}));
		const context = ctx("tui", custom);
		await expect(confirmLong(context, "T", LONG)).resolves.toBe(true);
		expect(context.ui.confirm).not.toHaveBeenCalled();
	});

	it("returns a deliberate no, and no answer for an abort", async () => {
		const no = vi.fn((factory: (...args: unknown[]) => ScrollableConfirm) => new Promise((resolve) => {
			factory({ requestRender() {}, terminal: { rows: 30 } }, theme, keybindings, resolve).handleInput("n");
		}));
		await expect(confirmLong(ctx("tui", no), "T", LONG)).resolves.toBe(false);
		const controller = new AbortController();
		const custom = vi.fn((factory: (...args: unknown[]) => ScrollableConfirm) => new Promise((resolve) => {
			factory({ requestRender() {}, terminal: { rows: 30 } }, theme, keybindings, resolve);
		}));
		const answer = confirmLong(ctx("tui", custom), "T", LONG, controller.signal);
		controller.abort();
		await expect(answer).resolves.toBeUndefined();
		await expect(confirmLong(ctx("tui", custom), "T", LONG, controller.signal)).resolves.toBeUndefined();
		expect(custom).toHaveBeenCalledTimes(1);
	});
});
