import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * NODE.md, "Terminal queries": exactly one emulator answers a PTY's queries, the daemon's headless one. A browser
 * terminal that answered too would put a duplicate reply into pi's input, so every query xterm.js could answer is
 * swallowed here before xterm's own handler sees it. Handlers return false for the sequences that set state, so those
 * fall through to xterm's (custom handlers run newest first, and `false` passes the sequence on).
 *
 * The guard test (`tests/node-queries.test.ts`) feeds every query below into a real xterm.js Terminal, with and without
 * these handlers.
 */

type Params = (number | number[])[];

const swallow = (): boolean => true;

const firstParam = (params: Params): number => {
	const value = params[0];
	return typeof value === "number" ? value : (value?.[0] ?? 0);
};

/** `CSI Ps t` window reports (xterm's window operations): every Ps that answers, never the ones that act (22/23, 8, …). */
const WINDOW_REPORTS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);

/** The OSC colour numbers whose `?` spec asks for a report: palette (4), and foreground, background, cursor (10–12). */
export const COLOR_OSCS = [4, 10, 11, 12] as const;

/**
 * An OSC 4/10/11/12 payload with at least one `?` spec is swallowed whole; the specs in it that set a colour are
 * written back as their own sequences (without `?`, so these handlers pass them to xterm). Without `?` the payload is
 * xterm's to apply.
 */
function colorQuery(term: Terminal, ident: number, data: string): boolean {
	const parts = data.split(";");
	const sets: string[] = [];
	let query = false;
	if (ident === 4) {
		for (let i = 0; i + 1 < parts.length; i += 2) {
			if (parts[i + 1] === "?") query = true;
			else sets.push(`\x1b]4;${parts[i]};${parts[i + 1]}\x1b\\`);
		}
	} else {
		// OSC 10;a;b sets (or asks for) 10 and then 11, and so on up to 19.
		parts.forEach((spec, i) => {
			if (spec === "?") query = true;
			else sets.push(`\x1b]${ident + i};${spec}\x1b\\`);
		});
	}
	if (!query) return false;
	if (sets.length) term.write(sets.join(""));
	return true;
}

/** Installs the swallowing handlers on `term`; call before the first write. */
export function swallowQueries(term: Terminal): IDisposable {
	const parser = term.parser;
	const disposables: IDisposable[] = [
		parser.registerCsiHandler({ final: "c" }, swallow), // DA1
		parser.registerCsiHandler({ prefix: ">", final: "c" }, swallow), // DA2
		parser.registerCsiHandler({ prefix: "=", final: "c" }, swallow), // DA3
		parser.registerCsiHandler({ final: "n" }, swallow), // DSR: status (5n), cursor position (6n)
		parser.registerCsiHandler({ prefix: "?", final: "n" }, swallow), // DEC DSR (?6n …)
		parser.registerCsiHandler({ intermediates: "$", final: "p" }, swallow), // DECRQM, ANSI modes
		parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, swallow), // DECRQM, DEC modes
		// Keyboard protocol flags. Only the `?u` query: `>u`, `<u`, and `=u` push, pop, and set them.
		parser.registerCsiHandler({ prefix: "?", final: "u" }, swallow),
		parser.registerCsiHandler({ prefix: ">", final: "q" }, swallow), // XTVERSION
		parser.registerCsiHandler({ final: "t" }, (params) => WINDOW_REPORTS.has(firstParam(params))),
		parser.registerDcsHandler({ intermediates: "$", final: "q" }, swallow), // DECRQSS
		parser.registerDcsHandler({ intermediates: "+", final: "q" }, swallow), // XTGETTCAP
		...COLOR_OSCS.map((ident) => parser.registerOscHandler(ident, (data) => colorQuery(term, ident, data))),
	];
	return { dispose: () => disposables.forEach((item) => item.dispose()) };
}
