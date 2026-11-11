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
