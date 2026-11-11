import { LIMITS, utf8Length } from "./contract";

/**
 * Splits keyboard or paste input into `term.input` frames of at most `maxBytes` UTF-8 bytes each, never inside a
 * surrogate pair, so a large paste reaches the PTY whole and in order.
 */
export function splitInput(data: string, maxBytes: number = LIMITS.maxInputBytes): string[] {
	if (utf8Length(data) <= maxBytes) return data ? [data] : [];
	const chunks: string[] = [];
	let start = 0;
	let bytes = 0;
	for (let i = 0; i < data.length; ) {
		const code = data.codePointAt(i)!;
		const units = code > 0xffff ? 2 : 1;
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (bytes + size > maxBytes) {
			chunks.push(data.slice(start, i));
			start = i;
			bytes = 0;
		}
		bytes += size;
		i += units;
	}
	if (start < data.length) chunks.push(data.slice(start));
	return chunks;
}

/** Focus reports (DECSET 1004) and mouse reports: SGR (1006), URXVT (1015), and X10/default (`CSI M` + 3 bytes). */
const REPORTS = /^(?:\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M|\x1b\[M[\s\S]{3})+$/;

/**
 * Whether `onData` output is the user typing or pasting, which claims the size (NODE.md, "Resize"). Reports the
 * terminal sends by itself are not: a window that gains or loses focus, or a pointer moving over it, must not take
 * the size from the window the user types in.
 */
export function claimsSize(data: string): boolean {
	return data.length > 0 && !REPORTS.test(data);
}
