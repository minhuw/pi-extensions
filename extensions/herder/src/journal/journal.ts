import * as fs from "node:fs";
import { dirname } from "node:path";
import { JOURNAL_SCHEMA_VERSION } from "../config.ts";
import { syncDir } from "../run/files.ts";
import type { JournalEvent, JournalInput } from "../types.ts";
import { isKnownEvent, makeEvent } from "./events.ts";

/** File-system calls used by the journal; a mutable object so tests can observe fsync. */
export const journalFs = {
	existsSync: fs.existsSync, readFileSync: fs.readFileSync, openSync: fs.openSync, writeSync: fs.writeSync,
	fsyncSync: fs.fsyncSync, ftruncateSync: fs.ftruncateSync, closeSync: fs.closeSync,
};

interface Parsed { events: JournalEvent[]; durableBytes: number }

function parse(path: string, data: Buffer): Parsed {
	const lines: Array<{ start: number; end: number }> = [];
	for (let start = 0, end: number; (end = data.indexOf(10, start)) !== -1; start = end + 1) lines.push({ start, end });
	const events: JournalEvent[] = [];
	let durableBytes = lines.length ? lines[lines.length - 1]!.end + 1 : 0;
	for (const [index, line] of lines.entries()) {
		const text = data.subarray(line.start, line.end).toString("utf8");
		if (!text.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			// A complete but unparsable final line is a torn write; anywhere else it is corruption.
			if (index === lines.length - 1) { durableBytes = line.start; break; }
			throw new Error(`journal ${path} is corrupt at line ${index + 1}: invalid JSON`);
		}
		const version = (value as { v?: unknown } | null)?.v;
		if (typeof version === "number" && version > JOURNAL_SCHEMA_VERSION) {
			throw new Error(`journal ${path} line ${index + 1} was written by a newer Herder version (schema ${version}; this version supports ${JOURNAL_SCHEMA_VERSION})`);
		}
		if (isKnownEvent(value)) events.push(value);
	}
	return { events, durableBytes };
}

function readBytes(path: string): Buffer | null {
	try {
		return journalFs.readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Tolerant reader: skips a torn final line and unknown event types, keeps unknown fields; throws on mid-file corruption and newer schema versions. */
export function readJournal(path: string): JournalEvent[] {
	const data = readBytes(path);
	return data ? parse(path, data).events : [];
}

/** Append-only, fsynced JSONL. The runtime is the only writer. */
export class Journal {
	readonly path: string;
	#repaired = false;
	readonly #listeners = new Set<(event: JournalEvent) => void>();
	constructor(path: string) { this.path = path; }

	/** Calls `listener` after each durable append; returns the unsubscribe function. Listener errors are ignored. */
	onAppend(listener: (event: JournalEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	append<I extends JournalInput>(input: I): Extract<JournalEvent, { t: I["t"] }> {
		const event = makeEvent(input);
		const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
		if (!this.#repaired) this.#repairTail();
		const created = !journalFs.existsSync(this.path);
		const fd = journalFs.openSync(this.path, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o644);
		try {
			for (let offset = 0; offset < line.length;) offset += journalFs.writeSync(fd, line, offset, line.length - offset);
			journalFs.fsyncSync(fd);
		} catch (error) {
			this.#repaired = false;
			throw error;
		} finally {
			journalFs.closeSync(fd);
		}
		if (created) syncDir(dirname(this.path));
		for (const listener of this.#listeners) try { listener(event); } catch {}
		return event;
	}

	read(): JournalEvent[] { return readJournal(this.path); }

	/** Drops a torn tail (never durable) so the next line does not get glued onto it. */
	#repairTail(): void {
		const data = readBytes(this.path);
		if (data) {
			const { durableBytes } = parse(this.path, data);
			if (durableBytes < data.length) {
				const fd = journalFs.openSync(this.path, "r+");
				try {
					journalFs.ftruncateSync(fd, durableBytes);
					journalFs.fsyncSync(fd);
				} finally {
					journalFs.closeSync(fd);
				}
			}
		}
		this.#repaired = true;
	}
}
