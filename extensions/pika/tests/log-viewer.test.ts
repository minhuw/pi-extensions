import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { localTime, type LogView, type LogViewItem, LogViewer, overlayOptions, showLog } from "../log-viewer.ts";

const KEYS = { up: "\x1b[A", down: "\x1b[B", home: "\x1b[H", end: "\x1b[F", enter: "\r", esc: "\x1b" };
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const colorTheme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` } as unknown as Theme;
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
/** A line without its frame. */
const inside = (line: string) => plain(line).replace(/^│ /, "").replace(/\s*│$/, "");

const item = (index: number, overrides: Partial<LogViewItem> = {}): LogViewItem => ({
	at: new Date(2026, 10, 10, 9, index).toISOString(), parts: [`item ${index}`, "", `part ${index}`], heading: `Item ${index}`,
	fields: [["Kind", "test"], ["Empty", ""], ["Missing", undefined], ["Zero", "0"]], text: `text of ${index}`, ...overrides,
});

function viewer(log: Partial<LogView> & Pick<LogView, "items">, { rows = 20, mode = "regular" as "regular" | "fullscreen", theme = plainTheme } = {}) {
	const done = vi.fn();
	const tui = { mode, terminal: { rows }, requestRender: vi.fn() };
	const view = new LogViewer(tui, theme, undefined, { title: "test log", noun: ["entry", "entries"], ...log }, done);
	return { view, done, tui, press: (...input: string[]) => { for (const key of input) view.handleInput(key); }, text: (width = 60) => view.render(width).map(inside) };
}

describe("LogViewer", () => {
	it("shows the caller's title and noun, rows without an icon, and leaves empty parts out", () => {
		const { text, press } = viewer({ items: [item(1), item(2)] });
		expect(text()).toEqual([
			plain(`╭${"─".repeat(58)}╮`), "test log · 2 entries on this branch", `├${"─".repeat(58)}┤`,
			"  09:01  item 1  part 1",
			"▸ 09:02  item 2  part 2",
			`├${"─".repeat(58)}┤`, "2/2 · ↑↓ move · Enter open · Esc close", `╰${"─".repeat(58)}╯`,
		]);
		press(KEYS.up);
		expect(text()[1]).toBe("test log · 2 entries on this branch");
		expect(viewer({ items: [item(1)] }).text()[1]).toBe("test log · 1 entry on this branch");
	});

	it("puts an icon between the mark and the time", () => {
		expect(viewer({ items: [item(1, { icon: "←" })] }).text()[3]).toBe("▸ ← 09:01  item 1  part 1");
	});

	it("opens an item with its heading, the fields that have a value, and its text, tabs as three spaces", () => {
		const { text, press } = viewer({ items: [item(1, { text: "first\n\tindented\n\nlast" }), item(2)] });
		press(KEYS.home, KEYS.enter);
		expect(text().slice(1, 12)).toEqual([
			"test log · entry 1 of 2", `├${"─".repeat(58)}┤`,
			"Item 1", "Kind: test", "Zero: 0", "", "first", "   indented", "", "last",
			`├${"─".repeat(58)}┤`,
		]);
		expect(text().at(-2)).toBe("Esc back");
	});

	it("wraps long fields and text to the width and keeps every line within it, in both views and modes", () => {
		const long = item(0, { heading: "H ".repeat(200), parts: ["p".repeat(300)], fields: [["Field", "word ".repeat(100)]], text: `${"x".repeat(500)}\n${"y ".repeat(300)}`, icon: "→" });
		for (const mode of ["regular", "fullscreen"] as const) {
			for (const width of [1, 4, 9, 30, 77]) {
				const { view, press } = viewer({ items: [long, item(1)] }, { mode, theme: colorTheme });
				const check = () => { for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width); };
				check();
				press(KEYS.home, KEYS.enter);
				check();
				press(KEYS.end);
				check();
			}
		}
		const { text, press } = viewer({ items: [item(0, { fields: [["Field", "word ".repeat(20).trim()]] })] }, { rows: 40 });
		press(KEYS.enter);
		// 30 columns leave 26 inside the frame.
		const words = "word word word word word";
		expect(text(30).slice(4, 10)).toEqual(["Field: word word word word", words, words, words, "word", ""]);
	});

	it("does nothing on Enter without items and closes on Esc", () => {
		const { text, press, done } = viewer({ items: [] });
		press(KEYS.enter, KEYS.down);
		expect(text()[1]).toBe("test log · 0 entries on this branch");
		press(KEYS.esc);
		expect(done).toHaveBeenCalledTimes(1);
	});
});

describe("localTime", () => {
	it("gives the local clock, or the full local time, and says when it cannot read one", () => {
		const at = new Date(2026, 0, 2, 3, 4, 5).toISOString();
		expect(localTime(at)).toBe("03:04");
		expect(localTime(at, true)).toBe("2026-01-02 03:04:05");
		expect(localTime("not a time")).toBe("--:--");
		expect(localTime("", true)).toBe("unknown time");
	});
});

describe("showLog", () => {
	it("opens the log the builder makes with the TUI's theme as an overlay sized for the TUI's mode, until it closes", async () => {
		let viewerOf: LogViewer | undefined;
		let options: { overlay?: boolean; overlayOptions?: () => unknown } | undefined;
		const tui = { mode: "fullscreen" as const, terminal: { rows: 30 }, requestRender: vi.fn() };
		const build = vi.fn((_theme: Theme): LogView => ({ title: "built", noun: ["entry", "entries"], items: [item(1)] }));
		const context = {
			ui: {
				custom: (factory: (...args: unknown[]) => LogViewer, given: typeof options) => new Promise((resolve) => {
					options = given;
					expect(options?.overlayOptions?.()).toEqual(overlayOptions({ mode: "regular" }));
					viewerOf = factory(tui, plainTheme, undefined, resolve);
				}),
			},
		} as unknown as ExtensionCommandContext;
		const opened = showLog(context, build);
		expect(build).toHaveBeenCalledWith(plainTheme);
		expect(options?.overlay).toBe(true);
		expect(options?.overlayOptions?.()).toEqual({ anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
		expect(inside(viewerOf!.render(40)[1]!)).toBe("built · 1 entry on this branch");
		viewerOf!.handleInput("q");
		await expect(opened).resolves.toBeUndefined();
	});

	it("sizes the overlay for the regular and the fullscreen TUI", () => {
		expect(overlayOptions({ mode: "regular" })).toEqual({ anchor: "center", width: "90%", maxHeight: "70%" });
		expect(overlayOptions({ mode: "fullscreen" })).toEqual({ anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
	});
});
