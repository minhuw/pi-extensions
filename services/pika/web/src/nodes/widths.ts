import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { Terminal } from "@xterm/xterm";

/**
 * NODE.md, "One version": the daemon's headless screen measures characters with the grapheme provider of
 * @xterm/addon-unicode-graphemes 0.4.0, as pi-tui does (emoji two cells, VS16 and ZWJ sequences one emoji). A browser
 * terminal on xterm's default Unicode 6 table would draw emoji one cell narrower than the snapshot and pi laid them
 * out, so it loads the same addon and version (`services/pika-node/src/widths.ts`).
 */
export const UNICODE_VERSION = "15-graphemes";

/** Switches a terminal (with `allowProposedApi`) to the daemon's widths, before anything is written to it. */
export function applyWidths(term: Terminal): void {
	term.loadAddon(new UnicodeGraphemesAddon());
	term.unicode.activeVersion = UNICODE_VERSION;
}
