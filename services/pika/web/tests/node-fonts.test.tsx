import { act, render } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeChannel } from "../src/nodes/channel";
import type { TerminalInfo } from "../src/nodes/contract";
import { followFonts, MONO_FONT_FAMILY, SYMBOLS_FONT, type FontSet } from "../src/nodes/fonts";
import { TERMINAL_OPTIONS, TerminalView } from "../src/nodes/TerminalView";

/** `document.fonts` in small: loads wait until `finish`, and `loadingdone` is fired by hand. */
class FakeFonts implements FontSet {
	loaded = false;
	loads: string[] = [];
	#pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
	#listeners = new Set<() => void>();

	load(font: string): Promise<unknown> {
		this.loads.push(font);
		return new Promise<void>((resolve, reject) => this.#pending.push({ resolve, reject }));
	}
	check(): boolean {
		return this.loaded;
	}
	addEventListener(_type: "loadingdone", listener: () => void): void {
		this.#listeners.add(listener);
	}
	removeEventListener(_type: "loadingdone", listener: () => void): void {
		this.#listeners.delete(listener);
	}
	get listening(): number {
		return this.#listeners.size;
	}
	async finish(error?: Error): Promise<void> {
		this.loaded = !error;
		for (const load of this.#pending.splice(0)) error ? load.reject(error) : load.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}
	loadingDone(): void {
		for (const listener of this.#listeners) listener();
	}
}

describe("the symbols font", () => {
	const css = readFileSync("src/styles.css", "utf8");
	const face = /@font-face\s*{[^}]*font-family:\s*"Symbols Nerd Font Mono";[^}]*}/.exec(css)?.[0];

	it("is declared for the Private Use Area only, from a bundled file", () => {
		expect(face).toBeDefined();
		expect(face).toMatch(/unicode-range:\s*U\+E000-F8FF,\s*U\+F0000-FFFFD;/);
		const src = /src:\s*url\("\.\/([^"]+)"\)\s*format\("woff2"\)/.exec(face!)?.[1];
		expect(src).toBe("assets/fonts/symbols-nerd-font-mono-pua.woff2");
		expect(existsSync(`src/${src}`)).toBe(true);
		expect(existsSync("src/assets/fonts/LICENSE-SymbolsNerdFont.txt")).toBe(true);
	});

	it("comes after the system monospace fonts in the terminal, before the generic family", () => {
		expect(SYMBOLS_FONT).toBe("Symbols Nerd Font Mono");
		expect(TERMINAL_OPTIONS.fontFamily).toBe(MONO_FONT_FAMILY);
		const families = TERMINAL_OPTIONS.fontFamily.split(",").map((family) => family.trim());
		expect(families.slice(0, 2)).toEqual(["ui-monospace", '"SF Mono"']);
		expect(families.at(-2)).toBe('"Symbols Nerd Font Mono"');
		expect(families.at(-1)).toBe("monospace");
		// Box, block and powerline characters are drawn by xterm to the cell, not from a font.
		expect(TERMINAL_OPTIONS.customGlyphs).toBe(true);
	});
});

describe("followFonts", () => {
	afterEach(() => vi.useRealTimers());

	it("opens once the fonts load, then reports each later face", async () => {
		const fonts = new FakeFonts();
		const ready = vi.fn();
		const changed = vi.fn();
		const stop = followFonts(fonts, 13, { ready, changed });
		expect(fonts.loads).toEqual(['13px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas', '13px "Symbols Nerd Font Mono"']);
		fonts.loadingDone();
		expect(ready).not.toHaveBeenCalled();
		expect(changed).not.toHaveBeenCalled();
		await fonts.finish();
		expect(ready).toHaveBeenCalledTimes(1);
		fonts.loadingDone();
		expect(changed).toHaveBeenCalledTimes(1);
		stop();
		fonts.loadingDone();
		expect(changed).toHaveBeenCalledTimes(1);
		expect(fonts.listening).toBe(0);
	});

	it("opens at once when the font is already loaded", () => {
		const fonts = new FakeFonts();
		fonts.loaded = true;
		const ready = vi.fn();
		followFonts(fonts, 13, { ready, changed: () => {} });
		expect(ready).toHaveBeenCalledTimes(1);
		expect(fonts.loads).toEqual([]);
	});

	it("opens without the fonts when they are slow, and redraws when they come", async () => {
		vi.useFakeTimers();
		const fonts = new FakeFonts();
		const ready = vi.fn();
		const changed = vi.fn();
		followFonts(fonts, 13, { ready, changed }, 500);
		vi.advanceTimersByTime(499);
		expect(ready).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(ready).toHaveBeenCalledTimes(1);
		await fonts.finish();
		fonts.loadingDone();
		expect(ready).toHaveBeenCalledTimes(1);
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("opens, and says so, when a font fails to load", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fonts = new FakeFonts();
		const ready = vi.fn();
		followFonts(fonts, 13, { ready, changed: () => {} });
		await fonts.finish(new Error("404"));
		expect(ready).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("fonts failed"), expect.any(Error));
	});

	it("does nothing once stopped before the fonts load", async () => {
		const fonts = new FakeFonts();
		const ready = vi.fn();
		followFonts(fonts, 13, { ready, changed: () => {} })();
		await fonts.finish();
		expect(ready).not.toHaveBeenCalled();
	});

	it("opens at once without a font set", () => {
		const ready = vi.fn();
		followFonts(undefined, 13, { ready, changed: () => {} });
		expect(ready).toHaveBeenCalledTimes(1);
	});
});

describe("TerminalView fonts", () => {
	const fonts = new FakeFonts();

	beforeEach(() => {
		Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
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

	afterEach(() => {
		delete (document as { fonts?: unknown }).fonts;
		vi.unstubAllGlobals();
	});

	const channel = {
		request: () => new Promise(() => {}),
		notify: () => Promise.resolve(),
		onEvent: () => () => {},
	} as unknown as NodeChannel;
	const terminal: TerminalInfo = { terminalId: "t1", title: "", cwd: "/p", cols: 80, rows: 24, pid: 1, createdAt: 1, argv: ["pi"] };

	it("opens the terminal after its fonts load and redraws it, not remounts it, for a late face", async () => {
		const open = vi.spyOn(Terminal.prototype, "open");
		const clear = vi.spyOn(Terminal.prototype, "clearTextureAtlas");
		const view = render(<TerminalView channel={channel} terminal={terminal} theme="dark" home="/home/me" onKill={() => {}} onOpenFile={() => {}} />);
		expect(open).not.toHaveBeenCalled();
		await act(() => fonts.finish());
		expect(open).toHaveBeenCalledTimes(1);
		expect(view.container.querySelector("[data-terminal-host] .xterm")).not.toBeNull();
		act(() => fonts.loadingDone());
		expect(clear).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledTimes(1);
		view.unmount();
		fonts.loadingDone();
		expect(clear).toHaveBeenCalledTimes(1);
		expect(fonts.listening).toBe(0);
	});
});
