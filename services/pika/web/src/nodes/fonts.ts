/**
 * The fonts the Nodes terminal and editor draw with. The system monospace fonts come first; the bundled Symbols Nerd
 * Font Mono (`styles.css`, Private Use Area only) fills in the icons pi's footer and other TUIs print, which no
 * system font has. Its `unicode-range` keeps it off every other character, so it never replaces text.
 */
export const SYMBOLS_FONT = "Symbols Nerd Font Mono";
const MONO_FONTS = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas';
export const MONO_FONT_FAMILY = `${MONO_FONTS}, "${SYMBOLS_FONT}", monospace`;

/** An icon in the symbols font's range (md-source-branch, pi's branch icon): a face loads only for text it covers. */
const SYMBOL_SAMPLE = "\u{F062C}";

/** How long a terminal waits for its fonts before it opens anyway; a late font then redraws it (`followFonts`). */
export const FONT_WAIT_MS = 2_000;

/** The parts of `document.fonts` used here. */
export interface FontSet {
	load(font: string, text?: string): Promise<unknown>;
	check(font: string, text?: string): boolean;
	addEventListener(type: "loadingdone", listener: () => void): void;
	removeEventListener(type: "loadingdone", listener: () => void): void;
}

export const documentFonts = (): FontSet | undefined => (typeof document !== "undefined" && "fonts" in document ? document.fonts : undefined);

/**
 * Loads the terminal's fonts, then calls `ready` once, or after `waitMs` if they are slow or fail, so xterm measures
 * and rasterizes with the real glyphs from its first frame. After `ready`, `changed` runs whenever a face finishes
 * loading, for the terminal to redraw: xterm's WebGL renderer caches each glyph as first drawn, so an icon drawn
 * before its font arrived stays blank until the atlas is cleared. Returns a disposer; nothing runs after it.
 */
export function followFonts(
	fonts: FontSet | undefined,
	fontSize: number,
	{ ready, changed }: { ready: () => void; changed: () => void },
	waitMs = FONT_WAIT_MS,
): () => void {
	if (!fonts) {
		ready();
		return () => {};
	}
	let disposed = false;
	let opened = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const open = () => {
		if (disposed || opened) return;
		opened = true;
		clearTimeout(timer);
		ready();
	};
	const loaded = () => {
		if (!disposed && opened) changed();
	};
	fonts.addEventListener("loadingdone", loaded);
	const symbols = `${fontSize}px "${SYMBOLS_FONT}"`;
	if (fonts.check(symbols, SYMBOL_SAMPLE)) open();
	else {
		timer = setTimeout(open, waitMs);
		Promise.all([fonts.load(`${fontSize}px ${MONO_FONTS}`), fonts.load(symbols, SYMBOL_SAMPLE)]).then(open, (error: unknown) => {
			// The terminal still works, with blank or tofu icons, as before the font was bundled.
			console.warn("pika: the terminal's fonts failed to load", error);
			open();
		});
	}
	return () => {
		disposed = true;
		clearTimeout(timer);
		fonts.removeEventListener("loadingdone", loaded);
	};
}
