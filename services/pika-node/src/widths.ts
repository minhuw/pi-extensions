/**
 * Character widths: NODE.md "One version". Programs in the PTY (pi-tui's `visibleWidth`) measure emoji as two
 * cells, VS16 and ZWJ sequences as one emoji; xterm 6's default Unicode 6 table gives most emoji one. The grapheme
 * provider of @xterm/addon-unicode-graphemes 0.4.0 ("15-graphemes") agrees with pi on emoji, keycaps, skin tones,
 * ZWJ sequences, flags, CJK, and Private Use Area icons. The web UI loads the same addon and version
 * (`services/pika/web/src/nodes/widths.ts`): snapshots and replies follow the headless screen's widths.
 */
import { createRequire } from "node:module";
import type { Terminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
const { UnicodeGraphemesAddon } = require("@xterm/addon-unicode-graphemes") as typeof import("@xterm/addon-unicode-graphemes");

export const UNICODE_VERSION = "15-graphemes";

/** Switches a terminal (with `allowProposedApi`) to pi's widths, before anything is written to it. */
export function applyWidths(terminal: Terminal): void {
    terminal.loadAddon(new UnicodeGraphemesAddon());
    terminal.unicode.activeVersion = UNICODE_VERSION;
}
