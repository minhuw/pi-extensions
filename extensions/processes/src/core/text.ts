import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

/** Longest single line kept for matching and reads; the rest of the line is dropped. */
export const MAX_LINE_CHARS = 16 * 1024;
/** Longest regex source accepted from callers. */
export const MAX_PATTERN_LENGTH = 500;

// Tab survives; every other C0 control and DEL goes after escape sequences are stripped.
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/g;

/** ANSI escape sequences and control characters removed from one line. */
export function cleanLine(line: string): string {
	return stripVTControlCharacters(line).replace(CONTROL, "");
}

/** Compiles a caller-supplied regex, throwing a message that names the field. */
export function compilePattern(source: string, field: string): RegExp {
	if (source.length > MAX_PATTERN_LENGTH) throw new Error(`${field} is longer than ${MAX_PATTERN_LENGTH} characters.`);
	try {
		return new RegExp(source);
	} catch (error) {
		throw new Error(`${field} is not a valid regular expression: ${(error as Error).message}`);
	}
}

/**
 * Splits a byte stream into cleaned lines for matching. `\r`, `\n`, and `\r\n` all end
 * a line, so progress bars yield one line per redraw; empty lines are skipped.
 */
export class LineSplitter {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	private skipping = false;

	push(chunk: Buffer): string[] {
		return this.split(this.decoder.write(chunk));
	}

	/** Remaining partial line at end of stream. */
	end(): string[] {
		const rest = this.split(this.decoder.end());
		const last = this.skipping ? "" : cleanLine(this.pending);
		this.pending = "";
		this.skipping = false;
		return last ? [...rest, last] : rest;
	}

	private split(text: string): string[] {
		const lines: string[] = [];
		let start = 0;
		for (let index = 0; index < text.length; index++) {
			const char = text.charCodeAt(index);
			if (char !== 10 && char !== 13) continue;
			this.append(text.slice(start, index), lines);
			if (!this.skipping) {
				const line = cleanLine(this.pending);
				if (line) lines.push(line);
			}
			this.pending = "";
			this.skipping = false;
			start = index + 1;
		}
		this.append(text.slice(start), lines);
		return lines;
	}

	/** Adds to the current line; past the cap, emits its head and drops the rest of it. */
	private append(text: string, lines: string[]): void {
		if (this.skipping) return;
		this.pending += text;
		if (this.pending.length <= MAX_LINE_CHARS) return;
		const line = cleanLine(this.pending.slice(0, MAX_LINE_CHARS));
		if (line) lines.push(line);
		this.pending = "";
		this.skipping = true;
	}
}

/**
 * Raw log bytes as display lines: split on `\n`, keep what a terminal shows after the
 * last `\r` redraw, strip escapes, and cap each line.
 */
export function displayLines(raw: Buffer): string[] {
	const text = raw.toString("utf8");
	if (!text) return [];
	return text.split("\n").map((line) => {
		const segments = line.split("\r");
		let visible = "";
		for (let index = segments.length - 1; index >= 0; index--) {
			if (segments[index]) {
				visible = segments[index];
				break;
			}
		}
		return cleanLine(visible).slice(0, MAX_LINE_CHARS);
	});
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\])(?::\d{1,5})?(?:\/[^\s"'<>`]*)?/g;

/** Local http(s) URLs in a cleaned line, trailing punctuation removed. */
export function findLocalUrls(line: string): string[] {
	return [...line.matchAll(LOCAL_URL)].map((match) => match[0].replace(/[.,;:!?)\]}]+$/, "")).filter((url) => URL.canParse(url));
}

/** Port a local URL points at, defaulting by scheme. */
export function urlPort(url: string): number {
	const parsed = new URL(url);
	if (parsed.port) return Number(parsed.port);
	return parsed.protocol === "https:" ? 443 : 80;
}
