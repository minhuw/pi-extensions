/**
 * Serializing a headless screen into a `Snapshot.data` that reproduces it, modes included.
 *
 * Measured on @xterm/headless 6.0.0 + @xterm/addon-serialize 0.14.0 (test/snapshot.test.ts): the addon restores
 * the alternate buffer, cursor position, and DECSET 1, 66, 2004, 4, 6, 45, 1004, 7 and the mouse protocol
 * (9/1000/1002/1003). It omits the mouse encoding (1006 SGR, 1016 SGR pixels), cursor visibility (25),
 * the scroll region (DECSTBM), and the cursor style (DECSCUSR); `restoreSuffix` appends them. xterm.js 6.0 has
 * no kitty keyboard protocol (it leaves `CSI ? u` unanswered), so there are no keyboard flags to restore.
 */
import type { Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { LIMITS, utf8Length } from "./protocol.ts";

/** The private xterm state the serialize addon does not cover; pinned to @xterm/headless 6.0.0. */
interface Core {
    coreMouseService: { activeEncoding: string };
    coreService: { isCursorHidden: boolean; decPrivateModes: { cursorStyle?: "block" | "underline" | "bar"; cursorBlink?: boolean; origin: boolean } };
    buffer: { scrollTop: number; scrollBottom: number };
}

function core(terminal: Terminal): Core {
    const value = (terminal as unknown as { _core?: Core })._core;
    if (!value?.coreMouseService || !value.coreService?.decPrivateModes || !value.buffer || typeof value.buffer.scrollTop !== "number") {
        throw new Error("unexpected @xterm/headless internals: pin @xterm/headless to 6.0.0");
    }
    return value;
}

/** Checks once at startup that the internals `restoreSuffix` reads exist. */
export const checkInternals = (terminal: Terminal): void => void core(terminal);

const CURSOR_STYLE = { block: 1, underline: 3, bar: 5 } as const;

export function restoreSuffix(terminal: Terminal): string {
    const c = core(terminal);
    let out = "";
    if (c.coreMouseService.activeEncoding === "SGR") out += "\x1b[?1006h";
    else if (c.coreMouseService.activeEncoding === "SGR_PIXELS") out += "\x1b[?1016h";
    const { cursorStyle, cursorBlink } = c.coreService.decPrivateModes;
    if (cursorStyle !== undefined) out += `\x1b[${CURSOR_STYLE[cursorStyle] + (cursorBlink === false ? 1 : 0)} q`;
    const { scrollTop, scrollBottom } = c.buffer;
    const buffer = terminal.buffer.active;
    if (scrollTop !== 0 || scrollBottom !== terminal.rows - 1) {
        // DECSTBM homes the cursor, so the position is set again; with origin mode it counts from the margin.
        out += `\x1b[${scrollTop + 1};${scrollBottom + 1}r`;
        const row = buffer.cursorY - (c.coreService.decPrivateModes.origin ? scrollTop : 0);
        out += `\x1b[${row + 1};${buffer.cursorX + 1}H`;
    }
    if (c.coreService.isCursorHidden) out += "\x1b[?25l";
    return out;
}

/** Scrollback depths tried in turn until the snapshot fits its limits. */
const DEPTHS = [1_000, 500, 200, 50, 0];
/** Room for the rest of the record around `data` (type, ids, numbers). */
const ENVELOPE = 1_024;

/** The screen and as much scrollback as fits 512 KiB and, JSON-escaped, one record. */
export function serializeScreen(terminal: Terminal, addon: SerializeAddon): string {
    for (const scrollback of DEPTHS) {
        const data = addon.serialize({ scrollback }) + restoreSuffix(terminal);
        if (utf8Length(data) <= LIMITS.maxSnapshotBytes && utf8Length(JSON.stringify(data)) + ENVELOPE <= LIMITS.maxRecordBytes) return data;
    }
    throw new Error("the visible screen alone is over the snapshot limit");
}
