import type { JournalEvent, JournalInput } from "../types.ts";

/** Append-only, fsynced JSONL. The runtime is the only writer. */
export class Journal {
	readonly path: string;
	constructor(path: string) { this.path = path; }
	append(input: JournalInput): JournalEvent { throw new Error("not implemented"); }
	read(): JournalEvent[] { throw new Error("not implemented"); }
}

/** Tolerant reader: skips a torn final line, unknown event types, and keeps unknown fields. */
export function readJournal(path: string): JournalEvent[] { throw new Error("not implemented"); }
