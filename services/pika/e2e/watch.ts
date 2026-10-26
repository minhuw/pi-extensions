import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { allEntries, type ReadApi } from "./api.ts";

interface WatchedFile {
	path: string;
	sessionId?: string;
	size: number;
	/** When each complete line, by byte offset, was first seen in the file. */
	written: Map<number, number>;
	/** When each line, by byte offset, was first returned by the read API. */
	served: Map<number, number>;
}

/**
 * Finds every pi session file under the roots, records when each line appears in its file, and polls the read API
 * for the same lines, so upload latency can be checked per entry.
 */
export class SessionWatcher {
	readonly files = new Map<string, WatchedFile>();
	private timers: ReturnType<typeof setInterval>[] = [];
	private polling = false;
	private paused = false;

	private readonly roots: string[];
	private readonly api: ReadApi;

	constructor(roots: string[], api: ReadApi) {
		this.roots = roots;
		this.api = api;
	}

	start(): void {
		this.timers.push(setInterval(() => this.scan(), 40));
		this.timers.push(setInterval(() => { void this.poll(); }, 150));
	}

	stop(): void {
		for (const timer of this.timers) clearInterval(timer);
		this.timers = [];
	}

	/** Stops polling the API, for example while the server is down. */
	pause(paused: boolean): void { this.paused = paused; }

	bySession(sessionId: string): WatchedFile | undefined {
		return [...this.files.values()].find((file) => file.sessionId === sessionId);
	}

	sessions(): { sessionId: string; path: string }[] {
		return [...this.files.values()].flatMap((file) => (file.sessionId ? [{ sessionId: file.sessionId, path: file.path }] : []));
	}

	scan(): void {
		const now = Date.now();
		for (const path of this.candidates()) {
			let file = this.files.get(path);
			if (!file) {
				file = { path, size: 0, written: new Map(), served: new Map() };
				this.files.set(path, file);
			}
			let size: number;
			try { size = statSync(path).size; } catch { continue; }
			if (size <= file.size) continue;
			const buffer = Buffer.alloc(size - file.size);
			const fd = openSync(path, "r");
			try { readSync(fd, buffer, 0, buffer.length, file.size); } finally { closeSync(fd); }
			let start = 0;
			for (let end = buffer.indexOf(10); end !== -1; start = end + 1, end = buffer.indexOf(10, start)) {
				const offset = file.size + start;
				if (offset === 0) {
					try {
						const header = JSON.parse(buffer.subarray(0, end).toString("utf8")) as { type?: string; id?: string };
						if (header.type === "session" && typeof header.id === "string") file.sessionId = header.id;
					} catch { /* not a session file */ }
				}
				file.written.set(offset, now);
			}
			file.size += start;
		}
	}

	private candidates(): string[] {
		const out: string[] = [];
		const visit = (dir: string, depth: number) => {
			let names: import("node:fs").Dirent[];
			try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const entry of names) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					// Session files never live in git objects, node_modules, or pika's own state.
					if (depth < 8 && !["objects", "node_modules", "pika", "worktrees", "refs"].includes(entry.name)) visit(path, depth + 1);
				} else if (entry.name.endsWith(".jsonl") && entry.name !== "journal.jsonl") out.push(path);
			}
		};
		for (const root of this.roots) visit(root, 0);
		return out;
	}

	private async poll(): Promise<void> {
		if (this.polling || this.paused) return;
		this.polling = true;
		try {
			for (const file of this.files.values()) {
				if (!file.sessionId || file.served.size >= file.written.size) continue;
				let entries;
				try { entries = await allEntriesFrom(this.api, file.sessionId, file.served.size); } catch { continue; }
				const now = Date.now();
				for (const entry of entries ?? []) if (!file.served.has(entry.offset)) file.served.set(entry.offset, now);
			}
		} finally {
			this.polling = false;
		}
	}
}

/** Entries from seq `from` on; the seq of a line is its index in the file. */
async function allEntriesFrom(api: ReadApi, sessionId: string, from: number) {
	if (from === 0) return allEntries(api, sessionId);
	const page = await api.get<{ items: { offset: number }[] }>(`sessions/${encodeURIComponent(sessionId)}/entries?from=${from}&limit=1000`);
	return page?.items;
}
