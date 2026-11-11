import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { swallowQueries } from "../src/nodes/queries";

/**
 * The guard for NODE.md "Terminal queries": a browser terminal must answer nothing, because the daemon's headless
 * terminal already does and a second answer lands in pi's input as stray bytes. A missing swallow handler fails
 * silently in production, so every query xterm.js can answer is fed into a real Terminal with the handlers installed,
 * and, as the control, into one without them, which must answer each (proving the test exercises real replies).
 */

const ST = "\x1b\\";

/** Queries @xterm/xterm 6.0.0 answers (the control asserts it does). */
const ANSWERED: Record<string, string> = {
	"DA1 (CSI c)": "\x1b[c",
	"DA1 (CSI 0 c)": "\x1b[0c",
	"DA2 (CSI > c)": "\x1b[>c",
	"DA2 (CSI > 0 c)": "\x1b[>0c",
	"DSR status (CSI 5 n)": "\x1b[5n",
	"CPR (CSI 6 n)": "\x1b[6n",
	"DEC CPR (CSI ? 6 n)": "\x1b[?6n",
	"DECRQM ANSI insert (CSI 4 $ p)": "\x1b[4$p",
	"DECRQM ANSI newline (CSI 20 $ p)": "\x1b[20$p",
	"DECRQM DEC cursor keys (CSI ? 1 $ p)": "\x1b[?1$p",
	"DECRQM DEC cursor (CSI ? 25 $ p)": "\x1b[?25$p",
	"DECRQM DEC bracketed paste (CSI ? 2004 $ p)": "\x1b[?2004$p",
	"DECRQM DEC alt screen (CSI ? 1049 $ p)": "\x1b[?1049$p",
	"DECRQM DEC unknown mode (CSI ? 9999 $ p)": "\x1b[?9999$p",
	"window pixels (CSI 14 t)": "\x1b[14t",
	"cell pixels (CSI 16 t)": "\x1b[16t",
	"window chars (CSI 18 t)": "\x1b[18t",
	"DECRQSS SGR (DCS $ q m ST)": `\x1bP$qm${ST}`,
	"DECRQSS margins (DCS $ q r ST)": `\x1bP$qr${ST}`,
	"DECRQSS cursor style (DCS $ q SP q ST)": `\x1bP$q q${ST}`,
	"DECRQSS conformance (DCS $ q \" p ST)": `\x1bP$q"p${ST}`,
	"DECRQSS protection (DCS $ q \" q ST)": `\x1bP$q"q${ST}`,
	"DECRQSS unknown (DCS $ q x ST)": `\x1bP$qx${ST}`,
	"palette (OSC 4 ; 1 ; ? ST)": `\x1b]4;1;?${ST}`,
	"palette, BEL (OSC 4 ; 255 ; ? BEL)": "\x1b]4;255;?\x07",
	"foreground (OSC 10 ; ? ST)": `\x1b]10;?${ST}`,
	"background (OSC 11 ; ? ST)": `\x1b]11;?${ST}`,
	"background, BEL (OSC 11 ; ? BEL)": "\x1b]11;?\x07",
	"cursor colour (OSC 12 ; ? ST)": `\x1b]12;?${ST}`,
	"chained foreground and background (OSC 10 ; ? ; ? ST)": `\x1b]10;?;?${ST}`,
};

/**
 * Queries the handlers swallow that @xterm/xterm 6.0.0 does not answer even without them: it registers no DA3, keyboard
 * flags, XTVERSION, or XTGETTCAP handler, and its window operations report only 14, 16, and 18. They are fed through
 * both terminals anyway; if a newer xterm starts answering one, the control fails here and the query moves up.
 */
const UNANSWERED: Record<string, string> = {
	"DA3 (CSI = c)": "\x1b[=c",
	"keyboard flags (CSI ? u)": "\x1b[?u",
	"XTVERSION (CSI > q)": "\x1b[>q",
	"XTVERSION (CSI > 0 q)": "\x1b[>0q",
	"window state (CSI 11 t)": "\x1b[11t",
	"window position (CSI 13 t)": "\x1b[13t",
	"screen pixels (CSI 15 t)": "\x1b[15t",
	"screen chars (CSI 19 t)": "\x1b[19t",
	"icon label (CSI 20 t)": "\x1b[20t",
	"window title (CSI 21 t)": "\x1b[21t",
	"XTGETTCAP (DCS + q 544e ST)": `\x1bP+q544e${ST}`,
	"DEC DSR printer (CSI ? 15 n)": "\x1b[?15n",
};

/**
 * Every window report enabled: the page keeps xterm's default (all off, the same as the daemon), but the guard
 * must hold even if that option changes.
 */
const ALL_WINDOW_REPORTS: ITerminalOptions = {
	windowOptions: {
		getWinState: true,
		getWinPosition: true,
		getWinSizePixels: true,
		getScreenSizePixels: true,
		getCellSizePixels: true,
		getWinSizeChars: true,
		getScreenSizeChars: true,
		getIconTitle: true,
		getWinTitle: true,
		setWinSizeChars: true,
		pushTitle: true,
		popTitle: true,
	},
};

const terminals: Terminal[] = [];
afterEach(() => {
	while (terminals.length) terminals.pop()!.dispose();
});

/** An opened terminal (the pixel reports need a renderer) and what it sends to the PTY. */
function terminal(withHandlers: boolean, options: ITerminalOptions = ALL_WINDOW_REPORTS) {
	const term = new Terminal({ cols: 80, rows: 24, ...options });
	terminals.push(term);
	const handlers = withHandlers ? swallowQueries(term) : undefined;
	const host = document.createElement("div");
	document.body.append(host);
	term.open(host);
	const sent: string[] = [];
	term.onData((data) => sent.push(data));
	const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
	return { term, sent, write, handlers };
}

describe("browser terminal queries", () => {
	it.each(Object.entries(ANSWERED))("the control answers %s without the handlers", async (_name, query) => {
		const { sent, write } = terminal(false);
		await write(query);
		expect(sent.join("")).not.toBe("");
	});

	it.each(Object.entries(UNANSWERED))("@xterm/xterm 6.0.0 does not answer %s even without the handlers", async (_name, query) => {
		const { sent, write } = terminal(false);
		await write(query);
		expect(sent).toEqual([]);
	});

	it.each(Object.entries({ ...ANSWERED, ...UNANSWERED }))("swallows %s", async (_name, query) => {
		const { sent, write } = terminal(true);
		await write(query);
		expect(sent).toEqual([]);
	});

	it("answers nothing to every query in one burst, as pi's startup sends them", async () => {
		const { sent, write } = terminal(true);
		await write(`before${Object.values({ ...ANSWERED, ...UNANSWERED }).join("text")}after`);
		expect(sent).toEqual([]);
		// The control with the same burst answers at least once per answered query.
		const control = terminal(false);
		await control.write(Object.values(ANSWERED).join(""));
		expect(control.sent.length).toBeGreaterThanOrEqual(Object.keys(ANSWERED).length);
	});

	it("keeps swallowing after a reset, as every attach does before writing the snapshot", async () => {
		const { term, sent, write } = terminal(true);
		term.reset();
		await write(Object.values(ANSWERED).join(""));
		expect(sent).toEqual([]);
	});

	it("also with the page's options, xterm's default window options", async () => {
		const { sent, write } = terminal(true, {});
		await write(Object.values({ ...ANSWERED, ...UNANSWERED }).join(""));
		expect(sent).toEqual([]);
	});
});

describe("state-setting sequences still apply", () => {
	it("keeps modes set through the output stream", async () => {
		const { term, write } = terminal(true);
		await write("\x1b[?2004h\x1b[?1h\x1b[?1000h\x1b[?1006h");
		expect(term.modes.bracketedPasteMode).toBe(true);
		expect(term.modes.applicationCursorKeysMode).toBe(true);
		expect(term.modes.mouseTrackingMode).toBe("vt200");
	});

	it("keeps window operations that act rather than report (CSI 22 t, CSI 23 t: the title stack)", async () => {
		const { term, write } = terminal(true);
		const titles: string[] = [];
		term.onTitleChange((title) => titles.push(title));
		await write(`\x1b]2;one${ST}\x1b[22;0t\x1b]2;two${ST}\x1b[23;0t`);
		expect(titles).toEqual(["one", "two", "one"]);
	});

	it("keeps colour sets, also those next to a query in one OSC", async () => {
		const { sent, write, handlers } = terminal(true);
		await write(`\x1b]11;#102030${ST}\x1b]4;2;#405060;3;?${ST}\x1b]10;#708090;?${ST}`);
		// The sets written back are queued behind the burst; one more write lets them apply.
		await write("");
		expect(sent).toEqual([]);
		// Read the colours back through xterm's own reports once the handlers are gone.
		handlers!.dispose();
		await write(`\x1b]11;?${ST}\x1b]4;2;?${ST}\x1b]10;?${ST}`);
		expect(sent).toEqual([
			`\x1b]11;rgb:1010/2020/3030${ST}`,
			`\x1b]4;2;rgb:4040/5050/6060${ST}`,
			`\x1b]10;rgb:7070/8080/9090${ST}`,
		]);
	});
});
