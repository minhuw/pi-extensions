import { render } from "@testing-library/react";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/xterm";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeChannel } from "../src/nodes/channel";
import type { TerminalInfo } from "../src/nodes/contract";
import { TERMINAL_OPTIONS, TerminalView } from "../src/nodes/TerminalView";
import { applyWidths, UNICODE_VERSION } from "../src/nodes/widths";

/**
 * NODE.md, "One version": the browser terminal measures characters as the daemon's headless screen does, which
 * measures them as pi-tui does. `services/pika-node/test/units.test.ts` checks the same table on the daemon's side.
 */

const terminals: Terminal[] = [];
afterEach(() => {
	while (terminals.length) terminals.pop()!.dispose();
});

async function cursorAfter(text: string, widths = true, cols = 40): Promise<number> {
	const term = new Terminal({ ...TERMINAL_OPTIONS, cols, rows: 3 });
	terminals.push(term);
	if (widths) applyWidths(term);
	await new Promise<void>((resolve) => term.write(text, resolve));
	return term.buffer.active.cursorX;
}

describe("terminal widths", () => {
	// pi-tui 1.5.2's `visibleWidth` for each string (RGI emoji 2, VS16 and ZWJ sequences one emoji, East Asian Wide 2).
	const PI_WIDTHS: [string, number][] = [
		["🐝", 2], ["⚡", 2], ["✅", 2], ["🟢", 2], ["⭐", 2], ["⌚", 2],
		["❤", 1], ["❤\uFE0F", 2], ["✔\uFE0F", 2], ["🖥\uFE0F", 2], ["©", 1], ["#\uFE0F\u20E3", 2],
		["👍🏽", 2], ["👨\u200D👩\u200D👧", 2], ["🏳\uFE0F\u200D🌈", 2], ["🧑\u200D💻", 2], ["🇨🇭", 2],
		["中文", 4], ["한", 2], ["ｱ", 1], ["Ａ", 2], ["\uE0B0", 1], ["\u{F0615}", 1], ["▉", 1], ["…", 1], ["e\u0301", 1],
	];

	it("are pi's for emoji, sequences, CJK and Private Use Area icons", async () => {
		const actual: [string, number][] = [];
		for (const [text] of PI_WIDTHS) actual.push([text, await cursorAfter(text)]);
		expect(actual).toEqual(PI_WIDTHS);
	});

	it("are not pi's without the addon: xterm 6 gives emoji one cell (the control)", async () => {
		expect(await cursorAfter("🐝⚡✅", false)).toBe(3);
	});

	it("right-align pi's footer: the line ends at the right edge", async () => {
		// pi pads the footer by its own widths: the left part is 14 cells (🐝 2, the icon 1), the right 10.
		expect(await cursorAfter(`🐝 swarm  \u{F0615} 0×${" ".repeat(40 - 14 - 10)}▉▉▉▉  0.0%`)).toBe(40);
	});

	it("pin the daemon's addon and xterm versions", () => {
		const web = JSON.parse(readFileSync("package.json", "utf8")).dependencies;
		const node = JSON.parse(readFileSync("../../pika-node/package.json", "utf8")).dependencies;
		expect(web["@xterm/addon-unicode-graphemes"]).toBe(node["@xterm/addon-unicode-graphemes"]);
		expect(web["@xterm/addon-unicode-graphemes"]).toMatch(/^\d+\.\d+\.\d+$/);
		expect(web["@xterm/xterm"]).toBe(node["@xterm/headless"]);
	});
});

describe("TerminalView widths", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		// jsdom has no canvas: the view draws with the DOM renderer.
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
	});

	afterEach(() => vi.unstubAllGlobals());

	const channel = {
		request: () => new Promise(() => {}),
		notify: () => Promise.resolve(),
		onEvent: () => () => {},
	} as unknown as NodeChannel;
	const terminal: TerminalInfo = { terminalId: "t1", title: "", cwd: "/p", cols: 80, rows: 24, pid: 1, createdAt: 1, argv: ["pi"] };

	it("loads the grapheme widths into its terminal", () => {
		const load = vi.spyOn(Terminal.prototype, "loadAddon");
		const view = render(<TerminalView channel={channel} terminal={terminal} theme="dark" home="/home/me" onKill={() => {}} onOpenFile={() => {}} />);
		const index = load.mock.calls.findIndex(([addon]) => addon instanceof UnicodeGraphemesAddon);
		expect(index).toBeGreaterThanOrEqual(0);
		const term = load.mock.contexts[index] as Terminal;
		expect(term.unicode.activeVersion).toBe(UNICODE_VERSION);
		view.unmount();
	});
});
