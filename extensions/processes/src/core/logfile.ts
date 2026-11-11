import fs from "node:fs";
import type { LogQuery, LogRead } from "../types.ts";
import { compilePattern, displayLines } from "./text.ts";

const DEFAULT_TAIL = 50;
const MAX_TAIL = 500;
const DEFAULT_MAX_BYTES = 32 * 1024;
const TAIL_BLOCK = 64 * 1024;
/** Bytes scanned backwards for a tail read before giving up on finding more lines. */
const MAX_TAIL_SCAN = 8 * 1024 * 1024;

/**
 * One process's combined output on disk: the current generation `<path>` and one
 * previous generation `<path>.1`. Offsets are absolute byte counts since the first write.
 */
export class LogFile {
	readonly path: string;
	private readonly maxBytes: number;
	private fd: number | undefined;
	/** Absolute offset of the first byte of `<path>`. */
	private currentStart = 0;
	/** Absolute offset of the first byte of `<path>.1`, when it exists. */
	private previousStart: number | undefined;
	private size = 0;

	constructor(path: string, maxBytes: number) {
		if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error(`maxLogBytes must be a positive integer, got ${maxBytes}.`);
		this.path = path;
		this.maxBytes = maxBytes;
	}

	get bytes(): number {
		return this.currentStart + this.size;
	}

	/** Oldest absolute offset still on disk. */
	get retainedStart(): number {
		return this.previousStart ?? this.currentStart;
	}

	append(data: Buffer): void {
		let offset = 0;
		while (offset < data.length) {
			if (this.size >= this.maxBytes) this.rotate();
			const length = Math.min(this.maxBytes - this.size, data.length - offset);
			this.fd ??= fs.openSync(this.path, "a");
			fs.writeSync(this.fd, data, offset, length);
			this.size += length;
			offset += length;
		}
	}

	close(): void {
		if (this.fd === undefined) return;
		fs.closeSync(this.fd);
		this.fd = undefined;
	}

	remove(): void {
		this.close();
		fs.rmSync(this.path, { force: true });
		fs.rmSync(`${this.path}.1`, { force: true });
	}

	/**
	 * Reads by cursor (complete lines after it, paged by maxBytes) or the tail.
	 * `ended` means no more output will arrive, so a final unterminated line counts.
	 */
	read(query: LogQuery, ended: boolean): LogRead {
		const filter = query.filter === undefined ? undefined : compilePattern(query.filter, "filter");
		const maxBytes = query.maxBytes ?? DEFAULT_MAX_BYTES;
		if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error(`maxBytes must be a positive integer, got ${maxBytes}.`);
		const keep = (lines: string[]) => (filter ? lines.filter((line) => filter.test(line)) : lines);
		return query.cursor === undefined ? this.readTail(query.tail, maxBytes, keep, ended) : this.readFrom(query.cursor, maxBytes, keep, ended);
	}

	private readFrom(cursor: number, maxBytes: number, keep: (lines: string[]) => string[], ended: boolean): LogRead {
		const total = this.bytes;
		if (!Number.isInteger(cursor) || cursor < 0 || cursor > total) throw new Error(`Cursor ${cursor} is outside the log (0..${total}).`);
		const truncated = cursor < this.retainedStart;
		let start = Math.max(cursor, this.retainedStart);
		if (truncated && start > 0) {
			// Rotation can split a line; drop the fragment before the first full line.
			const head = this.range(start, Math.min(total, start + maxBytes));
			const newline = head.indexOf(10);
			if (newline < 0) return { lines: [], nextCursor: start + head.length, truncated, more: start + head.length < total };
			start += newline + 1;
		}
		const end = Math.min(total, start + maxBytes);
		const chunk = this.range(start, end);
		let take = chunk.lastIndexOf(10) + 1;
		if (end === total && ended) take = chunk.length;
		else if (take === 0 && end < total) take = chunk.length; // one line longer than the page
		const body = chunk.subarray(0, take);
		const lines = displayLines(body.at(-1) === 10 ? body.subarray(0, -1) : body);
		const nextCursor = start + take;
		return { lines: take === 0 ? [] : keep(lines), nextCursor, truncated, more: end < total };
	}

	private readTail(tail: number | undefined, maxBytes: number, keep: (lines: string[]) => string[], ended: boolean): LogRead {
		const wanted = Math.min(tail ?? DEFAULT_TAIL, MAX_TAIL);
		if (!Number.isInteger(wanted) || wanted <= 0) throw new Error(`tail must be a positive integer, got ${tail}.`);
		const total = this.bytes;
		let start = total;
		let raw: Buffer = Buffer.alloc(0);
		let lines: string[] = [];
		while (start > this.retainedStart && total - start < MAX_TAIL_SCAN) {
			const from = Math.max(this.retainedStart, start - TAIL_BLOCK);
			raw = Buffer.concat([this.range(from, start), raw]);
			start = from;
			const text = raw.at(-1) === 10 ? raw.subarray(0, -1) : raw;
			lines = displayLines(text);
			// The first line may be cut by the block boundary unless the scan reached the start.
			if (start > this.retainedStart) lines = lines.slice(1);
			lines = keep(lines);
			if (lines.length >= wanted) break;
		}
		lines = lines.slice(-wanted);
		let size = 0;
		let first = lines.length;
		while (first > 0 && size + Buffer.byteLength(lines[first - 1]) + 1 <= maxBytes) size += Buffer.byteLength(lines[--first]) + 1;
		const lastNewline = raw.lastIndexOf(10);
		const nextCursor = ended ? total : lastNewline < 0 ? start : start + lastNewline + 1;
		return { lines: lines.slice(first), nextCursor, truncated: false, more: false };
	}

	/** Bytes in [from, to) across both generations. */
	private range(from: number, to: number): Buffer {
		const parts: Buffer[] = [];
		if (this.previousStart !== undefined && from < this.currentStart) {
			parts.push(readSlice(`${this.path}.1`, from - this.previousStart, Math.min(to, this.currentStart) - from));
		}
		if (to > this.currentStart) {
			const begin = Math.max(from, this.currentStart);
			parts.push(readSlice(this.path, begin - this.currentStart, to - begin));
		}
		return Buffer.concat(parts);
	}

	private rotate(): void {
		this.close();
		fs.renameSync(this.path, `${this.path}.1`);
		this.previousStart = this.currentStart;
		this.currentStart += this.size;
		this.size = 0;
	}
}

function readSlice(path: string, position: number, length: number): Buffer {
	const buffer = Buffer.alloc(length);
	const fd = fs.openSync(path, "r");
	try {
		const read = fs.readSync(fd, buffer, 0, length, position);
		if (read !== length) throw new Error(`Short read from ${path}: ${read} of ${length} bytes at ${position}.`);
	} finally {
		fs.closeSync(fd);
	}
	return buffer;
}
