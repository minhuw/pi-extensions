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
	/** The server URL that acknowledged `docs`; another server gets every document again. */
	docsUrl?: string;
	updatedAt: string;
}

/** When a model call reached each stage, in Unix epoch ms on the capturing machine; each key only when known. */
export interface RequestTiming {
	sentAt?: number;
	responseAt?: number;
	firstTokenAt?: number;
	firstToken?: "text" | "thinking" | "toolCall";
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
	timing?: RequestTiming;
	skeleton: unknown;
	blocks: string[];
}

/**
 * A spooled request. `awaiting` is local: the capturing uploader (`owner`) still waits for the
 * assistant message. `machine` and `started` (the process start time from `processStart`) tell
 * the process that holds it apart from a later one with the same pid; earlier versions recorded
 * `host` instead of `machine`.
 */
export interface SpooledRequest extends RequestRecord {
	awaiting?: { pid: number; owner: string; machine?: string; host?: string; started?: string };
}

export const MAX_ACKED = 100_000;
const HASH = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{1,100}$/;
const ACKED_URL = "# ";

const validRequest = (record: SpooledRequest | undefined): record is SpooledRequest =>
	!!record && typeof record.id === "string" && Array.isArray(record.blocks);

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

async function move(from: string, to: string): Promise<void> {
	try { await rename(from, to); } catch (error) { if (!missing(error)) throw error; }
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

/** Local state under `<agentDir>/pika/`: stream cursors, the request and blob spool, parked items, and acknowledged hashes. */
export class Store {
	readonly streams: string;
	readonly done: string;
	readonly requests: string;
	readonly blobs: string;
	readonly parked: string;
	readonly ackedLog: string;
	constructor(readonly dir: string) {
		this.streams = join(dir, "streams");
		this.done = join(dir, "streams", "done");
		this.requests = join(dir, "spool", "requests");
		this.blobs = join(dir, "spool", "blobs");
		this.parked = join(dir, "spool", "parked");
		this.ackedLog = join(dir, "acked.log");
	}

	async init(): Promise<void> {
		for (const dir of [this.done, this.requests, this.blobs, this.parked]) await mkdir(dir, { recursive: true });
		// Temp files left by a crash before their rename hold nothing that is not also elsewhere.
		const cutoff = Date.now() - 60_000;
		for (const dir of [this.streams, this.done, this.requests, this.blobs, this.parked]) {
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

	async loadRequests(): Promise<SpooledRequest[]> {
		const records: { record: SpooledRequest; mtime: number }[] = [];
		for (const name of await list(this.requests)) {
			if (!name.endsWith(".json")) continue;
			const file = join(this.requests, name);
			const record = await readJson<SpooledRequest>(file);
			const info = await stat(file).catch(() => undefined);
			if (validRequest(record)) records.push({ record, mtime: info?.mtimeMs ?? 0 });
		}
		return records.sort((a, b) => a.mtime - b.mtime).map(({ record }) => record);
	}

	async loadRequest(id: string): Promise<SpooledRequest | undefined> {
		if (!REQUEST_ID.test(id)) return undefined;
		const record = await readJson<SpooledRequest>(join(this.requests, `${id}.json`));
		return validRequest(record) ? record : undefined;
	}

	async saveRequest(record: SpooledRequest): Promise<number> {
		if (!REQUEST_ID.test(record.id)) throw new Error(`invalid request id ${record.id}`);
		const text = JSON.stringify(record);
		await atomicWrite(join(this.requests, `${record.id}.json`), text);
		return Buffer.byteLength(text);
	}

	async deleteRequest(id: string): Promise<void> {
		if (REQUEST_ID.test(id)) await rm(join(this.requests, `${id}.json`), { force: true });
	}

	async listBlobs(): Promise<{ hash: string; size: number; mtimeMs: number }[]> {
		const blobs: { hash: string; size: number; mtimeMs: number }[] = [];
		for (const name of await list(this.blobs)) {
			if (!HASH.test(name)) continue;
			const info = await stat(join(this.blobs, name)).catch(() => undefined);
			if (info) blobs.push({ hash: name, size: info.size, mtimeMs: info.mtimeMs });
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

	/** Items the server refused as too large, by file name, with their sizes. */
	async listParked(): Promise<Map<string, number>> {
		const parked = new Map<string, number>();
		for (const name of await list(this.parked)) {
			if (name.endsWith(".tmp")) continue;
			const info = await stat(join(this.parked, name)).catch(() => undefined);
			if (info) parked.set(name, info.size);
		}
		return parked;
	}

	async parkBlob(hash: string): Promise<void> {
		if (HASH.test(hash)) await move(join(this.blobs, hash), join(this.parked, hash));
	}

	async parkRequest(id: string): Promise<void> {
		if (REQUEST_ID.test(id)) await move(join(this.requests, `${id}.json`), join(this.parked, `${id}.json`));
	}

	async parkDocument(name: string, content: string): Promise<void> {
		await atomicWrite(join(this.parked, name), content);
	}

	/** The acknowledged hashes, oldest first, and the server URL that acknowledged them. */
	async loadAcked(): Promise<{ url?: string; hashes: string[] }> {
		let text = "";
		try { text = await readFile(this.ackedLog, "utf8"); } catch (error) { if (!missing(error)) throw error; }
		const lines = text.split("\n");
		const url = lines[0]?.startsWith(ACKED_URL) ? lines[0].slice(ACKED_URL.length) : undefined;
		const hashes = lines.filter((line) => HASH.test(line));
		const kept = [...new Set(hashes.slice(-MAX_ACKED))];
		if (url !== undefined && hashes.length > 2 * MAX_ACKED) await this.rewriteAcked(url, kept);
		return { url, hashes: kept };
	}

	async appendAcked(hashes: readonly string[]): Promise<void> {
		if (hashes.length) await appendFile(this.ackedLog, hashes.map((hash) => `${hash}\n`).join(""));
	}

	async rewriteAcked(url: string, hashes: readonly string[]): Promise<void> {
		await atomicWrite(this.ackedLog, `${ACKED_URL}${url}\n${hashes.map((hash) => `${hash}\n`).join("")}`);
	}
}
