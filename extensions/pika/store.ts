import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type StreamKind = "session" | "herder-journal";

/** Durable cursor of one stream. `length` only advances when the server acknowledges it. */
export interface StreamState {
	key: string;
	kind: StreamKind;
	path: string;
	length: number;
	meta?: Record<string, unknown>;
	/** Why uploading this stream stopped, for example a conflict. */
	stopped?: string;
	/** Acknowledged document sha256 by key, for Herder runs. */
	docs?: Record<string, string>;
	updatedAt: string;
}

export interface RequestRecord {
	id: string;
	sessionId: string;
	seq: number;
	at: string;
	fidelity: "payload" | "context";
	provider?: string;
	api?: string;
	model?: string;
	assistant?: { timestamp: number; responseId?: string };
	skeleton: unknown;
	blocks: string[];
}

export const MAX_ACKED = 100_000;
const HASH = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{1,100}$/;

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function atomicWrite(file: string, data: string): Promise<void> {
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(temp, data);
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try { return JSON.parse(await readFile(file, "utf8")) as T; } catch (error) {
		if (missing(error) || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

async function list(dir: string): Promise<string[]> {
	try { return await readdir(dir); } catch (error) { if (missing(error)) return []; throw error; }
}

/** Local state under `<agentDir>/pika/`: stream cursors, the request and blob spool, and acknowledged hashes. */
export class Store {
	readonly streams: string;
	readonly done: string;
	readonly requests: string;
	readonly blobs: string;
	readonly ackedLog: string;
	constructor(readonly dir: string) {
		this.streams = join(dir, "streams");
		this.done = join(dir, "streams", "done");
		this.requests = join(dir, "spool", "requests");
		this.blobs = join(dir, "spool", "blobs");
		this.ackedLog = join(dir, "acked.log");
	}

	async init(): Promise<void> {
		for (const dir of [this.done, this.requests, this.blobs]) await mkdir(dir, { recursive: true });
		// Temp files left by a crash before their rename hold nothing that is not also elsewhere.
		const cutoff = Date.now() - 60_000;
		for (const dir of [this.streams, this.done, this.requests, this.blobs]) {
			for (const name of await list(dir)) {
				if (!name.endsWith(".tmp")) continue;
				const file = join(dir, name);
				const info = await stat(file).catch(() => undefined);
				if (info && info.mtimeMs < cutoff) await rm(file, { force: true }).catch(() => undefined);
			}
		}
	}

	private streamFile(dir: string, key: string): string {
		return join(dir, `${encodeURIComponent(key)}.json`);
	}

	async loadActiveStreams(): Promise<StreamState[]> {
		const states: StreamState[] = [];
		for (const name of await list(this.streams)) {
			if (!name.endsWith(".json")) continue;
			const state = await readJson<StreamState>(join(this.streams, name));
			if (state && typeof state.key === "string" && typeof state.path === "string" && Number.isSafeInteger(state.length)) states.push(state);
		}
		return states;
	}

	async findStream(key: string): Promise<StreamState | undefined> {
		return await readJson<StreamState>(this.streamFile(this.streams, key)) ?? await readJson<StreamState>(this.streamFile(this.done, key));
	}

	async saveStream(state: StreamState): Promise<void> {
		await atomicWrite(this.streamFile(this.streams, state.key), JSON.stringify(state));
	}

	/** Moves a fully uploaded, closed stream out of the set scanned at startup. */
	async archiveStream(state: StreamState): Promise<void> {
		await atomicWrite(this.streamFile(this.done, state.key), JSON.stringify(state));
		await unlink(this.streamFile(this.streams, state.key)).catch((error) => { if (!missing(error)) throw error; });
	}

	async deleteStream(key: string): Promise<void> {
		await rm(this.streamFile(this.streams, key), { force: true });
	}

	async loadRequests(): Promise<RequestRecord[]> {
		const records: { record: RequestRecord; mtime: number }[] = [];
		for (const name of await list(this.requests)) {
			if (!name.endsWith(".json")) continue;
			const file = join(this.requests, name);
			const record = await readJson<RequestRecord>(file);
			const info = await stat(file).catch(() => undefined);
			if (record && typeof record.id === "string" && Array.isArray(record.blocks)) records.push({ record, mtime: info?.mtimeMs ?? 0 });
		}
		return records.sort((a, b) => a.mtime - b.mtime).map(({ record }) => record);
	}

	async saveRequest(record: RequestRecord): Promise<number> {
		if (!REQUEST_ID.test(record.id)) throw new Error(`invalid request id ${record.id}`);
		const text = JSON.stringify(record);
		await atomicWrite(join(this.requests, `${record.id}.json`), text);
		return Buffer.byteLength(text);
	}

	async deleteRequest(id: string): Promise<void> {
		if (REQUEST_ID.test(id)) await rm(join(this.requests, `${id}.json`), { force: true });
	}

	async listBlobs(): Promise<{ hash: string; size: number }[]> {
		const blobs: { hash: string; size: number }[] = [];
		for (const name of await list(this.blobs)) {
			if (!HASH.test(name)) continue;
			const info = await stat(join(this.blobs, name)).catch(() => undefined);
			if (info) blobs.push({ hash: name, size: info.size });
		}
		return blobs;
	}

	async saveBlob(hash: string, text: string): Promise<void> {
		if (!HASH.test(hash)) throw new Error(`invalid blob hash ${hash}`);
		await atomicWrite(join(this.blobs, hash), text);
	}

	async readBlob(hash: string): Promise<string | undefined> {
		if (!HASH.test(hash)) return undefined;
		try { return await readFile(join(this.blobs, hash), "utf8"); } catch (error) { if (missing(error)) return undefined; throw error; }
	}

	async deleteBlob(hash: string): Promise<void> {
		if (HASH.test(hash)) await rm(join(this.blobs, hash), { force: true });
	}

	/** The newest acknowledged hashes, oldest first. */
	async loadAcked(): Promise<string[]> {
		let text = "";
		try { text = await readFile(this.ackedLog, "utf8"); } catch (error) { if (!missing(error)) throw error; }
		const hashes = text.split("\n").filter((line) => HASH.test(line));
		const kept = [...new Set(hashes.slice(-MAX_ACKED))];
		if (hashes.length > 2 * MAX_ACKED) await this.rewriteAcked(kept);
		return kept;
	}

	async appendAcked(hashes: readonly string[]): Promise<void> {
		if (hashes.length) await appendFile(this.ackedLog, hashes.map((hash) => `${hash}\n`).join(""));
	}

	async rewriteAcked(hashes: readonly string[]): Promise<void> {
		await atomicWrite(this.ackedLog, hashes.map((hash) => `${hash}\n`).join(""));
	}
}
