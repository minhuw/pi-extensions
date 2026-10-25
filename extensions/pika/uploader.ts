import { open, readFile, stat } from "node:fs/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { sha256, splitPayload } from "./blocks.ts";
import { MAX_ACKED, Store, type RequestRecord, type StreamKind, type StreamState } from "./store.ts";

export const PIKA_VERSION = "0.1.0";
/** Uncompressed batch body limit; the server accepts 32 MiB by default. */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024 - 64 * 1024;
const MIN_BATCH_BYTES = 256 * 1024;
const MAX_BACKOFF_MS = 60_000;
const FIRST_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const POKE_DELAY_MS = 200;
const SCAN_INTERVAL_MS = 1_000;
const MAX_GAP_RETRIES = 3;

const gzipAsync = promisify(gzip);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface UploaderOptions {
	url: string;
	token: string;
	/** `<agentDir>/pika` */
	dir: string;
	piVersion?: string;
}

export interface UploaderStatus {
	url: string;
	queuedItems: number;
	queuedBytes: number;
	lastSuccess?: string;
	lastError?: string;
	halted?: string;
	stoppedStreams: { key: string; reason: string }[];
}

export interface StreamDescriptor {
	key: string;
	kind: StreamKind;
	path: string;
	meta?: Record<string, unknown>;
}

export type RequestInput = Omit<RequestRecord, "skeleton" | "blocks">;
/** The payload as JSON text taken in the handler, or a value serialized later on the spool queue. */
export type PayloadSource = { json: string } | { value: unknown };

interface Stream {
	state: StreamState;
	open: number;
	size?: number;
	gapRetries: number;
}

interface PendingDocument {
	key: string;
	kind: "herder-goal" | "herder-plan";
	runId: string;
	content: string;
	sha256: string;
	streamKey: string;
}

interface Batch {
	streams: { key: string; kind: StreamKind; offset: number; lines: string[]; path: string; meta?: Record<string, unknown> }[];
	ends: Map<string, number>;
	documents: PendingDocument[];
	blobs: { hash: string; data: string }[];
	requests: RequestRecord[];
}

type Outcome = "progress" | "retry" | "stop";

async function readLines(path: string, offset: number, end: number, maxBytes: number): Promise<string[]> {
	const handle = await open(path, "r");
	try {
		let want = Math.max(1, Math.min(end - offset, maxBytes));
		for (;;) {
			const buffer = Buffer.alloc(want);
			const { bytesRead } = await handle.read(buffer, 0, want, offset);
			const chunk = buffer.subarray(0, bytesRead);
			const last = chunk.lastIndexOf(0x0a);
			if (last >= 0) return chunk.subarray(0, last).toString("utf8").split("\n");
			// Only a partial line so far, or one line longer than the budget.
			if (offset + bytesRead >= end) return [];
			want = Math.min(end - offset, want * 2);
		}
	} finally {
		await handle.close();
	}
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * Process-wide uploader. Session entries are read from their source files between the
 * acknowledged cursor and the last complete line, so the file itself is the durable queue;
 * requests and blobs are spooled to disk before they are sent.
 */
export class Uploader {
	readonly store: Store;
	readonly ready: Promise<void>;
	private readonly streams = new Map<string, Stream>();
	private readonly requests = new Map<string, { record: RequestRecord; bytes: number }>();
	private readonly blobs = new Map<string, number>();
	private readonly acked = new Set<string>();
	private ackedAppends = 0;
	private readonly documents = new Map<string, PendingDocument>();
	private readonly herderRuns = new Set<string>();
	private spool: Promise<void> = Promise.resolve();
	private flushing?: Promise<void>;
	private again = false;
	private pokeTimer?: ReturnType<typeof setTimeout>;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private readonly scanTimer: ReturnType<typeof setInterval>;
	private scanning = false;
	private failures = 0;
	private budget = MAX_BATCH_BYTES;
	private inflight?: ClientRequest;
	private closed = false;
	private lastSuccess?: number;
	private lastError?: { at: number; message: string };
	private halted?: string;

	constructor(readonly options: UploaderOptions) {
		this.store = new Store(options.dir);
		this.ready = this.load().catch((error) => this.noteError(`loading local state: ${errorText(error)}`));
		this.scanTimer = setInterval(() => { this.scan().catch((error) => this.noteError(errorText(error))); }, SCAN_INTERVAL_MS);
		this.scanTimer.unref();
	}

	get isClosed(): boolean { return this.closed; }

	noteError(message: string): void {
		this.lastError = { at: Date.now(), message };
	}

	private async load(): Promise<void> {
		await this.store.init();
		for (const hash of await this.store.loadAcked()) this.acked.add(hash);
		for (const state of await this.store.loadActiveStreams()) {
			if (this.streams.has(state.key)) continue;
			this.streams.set(state.key, { state, open: 0, gapRetries: 0 });
			if (state.kind === "herder-journal") this.queueDocuments(state);
		}
		for (const record of await this.store.loadRequests()) this.requests.set(record.id, { record, bytes: jsonBytes(record) });
		for (const { hash, size } of await this.store.listBlobs()) {
			if (this.acked.has(hash)) await this.store.deleteBlob(hash);
			else this.blobs.set(hash, size);
		}
		this.poke(0);
	}

	/** Runs local disk work in order, independently of network I/O. */
	private task(fn: () => Promise<void>): Promise<void> {
		this.spool = this.spool.then(async () => {
			await this.ready;
			await fn();
		}).catch((error) => this.noteError(errorText(error)));
		return this.spool;
	}

	openStream(descriptor: StreamDescriptor): Promise<void> {
		return this.task(async () => {
			let stream = this.streams.get(descriptor.key);
			if (!stream) {
				const state = await this.store.findStream(descriptor.key)
					?? { key: descriptor.key, kind: descriptor.kind, path: descriptor.path, length: 0, updatedAt: new Date().toISOString() };
				stream = { state, open: 0, gapRetries: 0 };
				this.streams.set(descriptor.key, stream);
			}
			stream.open++;
			stream.state.path = descriptor.path;
			if (descriptor.meta) stream.state.meta = descriptor.meta;
			stream.state.updatedAt = new Date().toISOString();
			await this.store.saveStream(stream.state);
			this.poke();
		});
	}

	closeStream(key: string): Promise<void> {
		return this.task(async () => {
			const stream = this.streams.get(key);
			if (stream) stream.open = Math.max(0, stream.open - 1);
			this.poke(0);
		});
	}

	enqueueRequest(input: RequestInput, payload: PayloadSource): Promise<void> {
		return this.task(async () => {
			const value: unknown = "json" in payload ? JSON.parse(payload.json) : JSON.parse(JSON.stringify(payload.value) ?? "null");
			const split = splitPayload(value);
			const record: RequestRecord = { ...input, skeleton: split.skeleton, blocks: split.blocks };
			let bytes = 0;
			for (const [hash, text] of split.data) {
				if (this.acked.has(hash) || this.blobs.has(hash)) continue;
				await this.store.saveBlob(hash, text);
				const size = Buffer.byteLength(text);
				this.blobs.set(hash, size);
				bytes += size;
			}
			bytes += await this.store.saveRequest(record);
			this.requests.set(record.id, { record, bytes });
			this.poke();
		});
	}

	/** Handles a `herder:run` event; repeated events for one run only re-check its files. */
	herderRun(payload: unknown): void {
		if (!payload || typeof payload !== "object") return;
		const run = payload as Record<string, unknown>;
		const text = (key: string) => typeof run[key] === "string" ? run[key] as string : undefined;
		const runId = text("runId"); const journalPath = text("journalPath");
		if (!runId || !journalPath) return;
		const key = `herder:${runId}`;
		const meta: Record<string, unknown> = {};
		for (const field of ["runId", "runDir", "repo", "title", "goalPath", "planPath"]) if (text(field) !== undefined) meta[field] = text(field);
		if (!this.herderRuns.has(key)) {
			this.herderRuns.add(key);
			void this.openStream({ key, kind: "herder-journal", path: journalPath, meta });
		} else this.poke();
		void this.task(async () => {
			const stream = this.streams.get(key);
			if (stream) { stream.state.meta = { ...stream.state.meta, ...meta }; this.queueDocuments(stream.state); }
		});
	}

	private queueDocuments(state: StreamState): void {
		const meta = state.meta ?? {};
		const runId = typeof meta.runId === "string" ? meta.runId : state.key.slice("herder:".length);
		const files: [string, "herder-goal" | "herder-plan", unknown][] = [["goal.md", "herder-goal", meta.goalPath], ["plan.md", "herder-plan", meta.planPath]];
		void this.task(async () => {
			for (const [name, kind, path] of files) {
				if (typeof path !== "string") continue;
				let content: string;
				try { content = await readFile(path, "utf8"); } catch { continue; }
				const key = `herder:${runId}:${name}`;
				const hash = sha256(content);
				if (hash === (this.documents.get(key)?.sha256 ?? state.docs?.[key])) continue;
				this.documents.set(key, { key, kind, runId, content, sha256: hash, streamKey: state.key });
			}
			this.poke();
		});
	}

	poke(delay = POKE_DELAY_MS): void {
		if (this.closed || this.halted) return;
		if (this.flushing) { this.again = true; return; }
		if (this.retryTimer || this.pokeTimer) return;
		this.pokeTimer = setTimeout(() => { this.pokeTimer = undefined; void this.flush(); }, delay);
		this.pokeTimer.unref();
	}

	private async scan(): Promise<void> {
		if (this.scanning || this.closed) return;
		this.scanning = true;
		try {
			for (const stream of this.streams.values()) {
				if (stream.open === 0 || stream.state.stopped) continue;
				const info = await stat(stream.state.path).catch(() => undefined);
				if (!info) continue;
				stream.size = info.size;
				if (info.size > stream.state.length) this.poke(0);
			}
		} finally { this.scanning = false; }
	}

	flush(): Promise<void> {
		if (this.flushing) { this.again = true; return this.flushing; }
		if (this.pokeTimer) { clearTimeout(this.pokeTimer); this.pokeTimer = undefined; }
		this.flushing = this.run().catch((error) => this.noteError(errorText(error))).then(() => {
			this.flushing = undefined;
			if (!this.again) return;
			this.again = false;
			try { this.poke(0); } catch (error) { this.noteError(errorText(error)); }
		});
		return this.flushing;
	}

	/** Waits for spooled work and one flush attempt, at most `ms`. Whatever remains stays on disk. */
	async drain(ms: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
		try {
			await Promise.race([deadline, (async () => {
				await this.ready;
				await this.spool;
				if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
				if (this.flushing) await this.flushing;
				await this.flush();
			})()]);
		} finally { clearTimeout(timer); }
	}

	/** Stops network activity; queued disk work still completes, so nothing accepted is lost. */
	async stop(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			clearInterval(this.scanTimer);
			if (this.pokeTimer) clearTimeout(this.pokeTimer);
			if (this.retryTimer) clearTimeout(this.retryTimer);
			this.inflight?.destroy(new Error("pika uploader stopped"));
		}
		await this.flushing;
		await this.spool;
	}

	status(): UploaderStatus {
		let queuedItems = this.requests.size + this.blobs.size + this.documents.size;
		let queuedBytes = 0;
		for (const { bytes } of this.requests.values()) queuedBytes += bytes;
		for (const size of this.blobs.values()) queuedBytes += size;
		for (const document of this.documents.values()) queuedBytes += Buffer.byteLength(document.content);
		const stoppedStreams: UploaderStatus["stoppedStreams"] = [];
		for (const stream of this.streams.values()) {
			if (stream.state.stopped) { stoppedStreams.push({ key: stream.state.key, reason: stream.state.stopped }); continue; }
			if (stream.size !== undefined && stream.size > stream.state.length) { queuedItems++; queuedBytes += stream.size - stream.state.length; }
		}
		return {
			url: this.options.url, queuedItems, queuedBytes, stoppedStreams, halted: this.halted,
			lastSuccess: this.lastSuccess === undefined ? undefined : new Date(this.lastSuccess).toISOString(),
			lastError: this.lastError && `${new Date(this.lastError.at).toISOString()} ${this.lastError.message}`,
		};
	}

	private async run(): Promise<void> {
		await this.ready;
		while (!this.closed && !this.halted) {
			const batch = await this.build();
			if (!batch) { await this.archive(); return; }
			const outcome = await this.send(batch);
			if (outcome === "stop") return;
			if (outcome === "retry") {
				this.failures++;
				const delay = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (this.failures - 1));
				if (!this.closed && !this.retryTimer) {
					this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.flush(); }, delay);
					this.retryTimer.unref();
				}
				return;
			}
		}
	}

	private async build(): Promise<Batch | undefined> {
		const batch: Batch = { streams: [], ends: new Map(), documents: [], blobs: [], requests: [] };
		let size = 512;
		let items = 0;
		const fits = (bytes: number) => items === 0 || size + bytes <= this.budget;
		for (const stream of this.streams.values()) {
			const { state } = stream;
			if (state.stopped) continue;
			const info = await stat(state.path).catch(() => undefined);
			if (!info) continue;
			stream.size = info.size;
			if (info.size < state.length) {
				state.stopped = `the source file is shorter (${info.size} bytes) than the uploaded length (${state.length} bytes)`;
				await this.store.saveStream(state);
				continue;
			}
			if (info.size === state.length || !fits(256)) continue;
			const lines = await readLines(state.path, state.length, info.size, Math.max(1, this.budget - size));
			const taken: string[] = [];
			let end = state.length;
			let streamSize = 256 + jsonBytes(state.path) + (state.meta ? jsonBytes(state.meta) : 0);
			for (const line of lines) {
				const bytes = jsonBytes(line) + 1;
				// A line larger than the whole budget still goes out, alone.
				if (size + streamSize + bytes > this.budget && !(items === 0 && taken.length === 0)) break;
				taken.push(line);
				streamSize += bytes;
				end += Buffer.byteLength(line) + 1;
			}
			if (!taken.length) continue;
			batch.streams.push({ key: state.key, kind: state.kind, offset: state.length, lines: taken, path: state.path, ...(state.meta ? { meta: state.meta } : {}) });
			batch.ends.set(state.key, end);
			size += streamSize;
			items++;
		}
		for (const document of this.documents.values()) {
			const bytes = jsonBytes(document);
			if (!fits(bytes)) break;
			batch.documents.push(document);
			size += bytes;
			items++;
		}
		const sent = new Set<string>();
		const addBlobs = async (hashes: Iterable<string>) => {
			const blobs: { hash: string; data: string }[] = [];
			let bytes = 0;
			for (const hash of hashes) {
				if (sent.has(hash) || !this.blobs.has(hash)) continue;
				const data = await this.store.readBlob(hash);
				if (data === undefined) { this.blobs.delete(hash); continue; }
				blobs.push({ hash, data });
				bytes += jsonBytes(data) + 90;
			}
			return { blobs, bytes };
		};
		for (const { record } of this.requests.values()) {
			const { blobs, bytes } = await addBlobs(record.blocks);
			const total = bytes + jsonBytes(record);
			if (!fits(total)) break;
			for (const blob of blobs) { sent.add(blob.hash); batch.blobs.push(blob); }
			batch.requests.push(record);
			size += total;
			items++;
		}
		for (const hash of [...this.blobs.keys()]) {
			if (sent.has(hash)) continue;
			const { blobs, bytes } = await addBlobs([hash]);
			if (!blobs.length) continue;
			if (!fits(bytes)) break;
			sent.add(hash);
			batch.blobs.push(...blobs);
			size += bytes;
			items++;
		}
		return items ? batch : undefined;
	}

	private post(body: Buffer): Promise<{ status: number; text: string }> {
		return new Promise((resolve, reject) => {
			const url = new URL(`${this.options.url}/api/ingest/v1/batch`);
			const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
				method: "POST",
				timeout: REQUEST_TIMEOUT_MS,
				headers: {
					Authorization: `Bearer ${this.options.token}`,
					"Content-Type": "application/json",
					"Content-Encoding": "gzip",
					"Content-Length": body.length,
				},
			}, (response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
				response.on("error", reject);
			});
			this.inflight = request;
			// Uploads never keep pi alive; session_shutdown waits explicitly instead.
			request.on("socket", (socket) => socket.unref());
			request.on("timeout", () => request.destroy(new Error(`no response within ${REQUEST_TIMEOUT_MS / 1000} s`)));
			request.on("error", reject);
			request.on("close", () => { if (this.inflight === request) this.inflight = undefined; });
			request.end(body);
		});
	}

	private async send(batch: Batch): Promise<Outcome> {
		const body = JSON.stringify({
			client: { host: hostname(), pikaVersion: PIKA_VERSION, ...(this.options.piVersion ? { piVersion: this.options.piVersion } : {}) },
			...(batch.streams.length ? { streams: batch.streams } : {}),
			...(batch.documents.length ? { documents: batch.documents.map(({ streamKey: _, ...document }) => document) } : {}),
			...(batch.blobs.length ? { blobs: batch.blobs } : {}),
			...(batch.requests.length ? { requests: batch.requests } : {}),
		});
		let response: { status: number; text: string };
		try {
			const compressed = await gzipAsync(body);
			if (this.closed) return "stop";
			response = await this.post(compressed);
		} catch (error) {
			if (this.closed) return "stop";
			this.noteError(`upload failed: ${errorText(error)}`);
			return "retry";
		}
		if (this.closed) return "stop";
		let parsed: Record<string, unknown> = {};
		try { const value: unknown = JSON.parse(response.text); if (value && typeof value === "object") parsed = value as Record<string, unknown>; } catch { /* not JSON */ }
		if (response.status === 200) return await this.accepted(batch, parsed);
		if (response.status === 401) {
			this.halted = "the server rejected the token (401); uploads stopped until pi restarts";
			this.noteError(this.halted);
			return "stop";
		}
		if (response.status === 409 && typeof parsed.key === "string" && typeof parsed.length === "number") {
			const stream = this.streams.get(parsed.key);
			if (stream && parsed.error === "gap" && parsed.length < stream.state.length && ++stream.gapRetries <= MAX_GAP_RETRIES) {
				stream.state.length = parsed.length;
			} else if (stream) {
				stream.state.stopped = parsed.error === "gap"
					? `the server keeps reporting a gap at ${parsed.length} bytes`
					: `conflict: the server's first ${parsed.length} bytes differ from the local file`;
				this.noteError(`${parsed.key}: ${stream.state.stopped}`);
			} else {
				this.noteError(`unexpected 409 for ${parsed.key}`);
				return "retry";
			}
			stream.state.updatedAt = new Date().toISOString();
			await this.store.saveStream(stream.state);
			return "progress";
		}
		if (response.status === 413 && this.budget > MIN_BATCH_BYTES) {
			this.budget = Math.max(MIN_BATCH_BYTES, Math.floor(this.budget / 2));
			return "progress";
		}
		this.noteError(`server answered ${response.status}${response.text ? `: ${response.text.slice(0, 200)}` : ""}`);
		return "retry";
	}

	private async accepted(batch: Batch, body: Record<string, unknown>): Promise<Outcome> {
		this.failures = 0;
		this.lastSuccess = Date.now();
		let progressed = batch.requests.length + batch.blobs.length > 0;
		const lengths = body.streams && typeof body.streams === "object" ? body.streams as Record<string, { length?: unknown }> : {};
		for (const item of batch.streams) {
			const stream = this.streams.get(item.key);
			if (!stream) continue;
			const reported = lengths[item.key]?.length;
			const length = typeof reported === "number" ? reported : batch.ends.get(item.key)!;
			if (length !== stream.state.length) progressed = true;
			stream.state.length = length;
			stream.gapRetries = 0;
			stream.state.updatedAt = new Date().toISOString();
			await this.store.saveStream(stream.state);
		}
		for (const document of batch.documents) {
			progressed = true;
			const stream = this.streams.get(document.streamKey);
			if (this.documents.get(document.key)?.sha256 === document.sha256) this.documents.delete(document.key);
			if (stream) {
				stream.state.docs = { ...stream.state.docs, [document.key]: document.sha256 };
				await this.store.saveStream(stream.state);
			}
		}
		const newlyAcked: string[] = [];
		for (const { hash } of batch.blobs) {
			this.blobs.delete(hash);
			this.acked.delete(hash);
			this.acked.add(hash);
			newlyAcked.push(hash);
			await this.store.deleteBlob(hash);
		}
		for (const record of batch.requests) {
			this.requests.delete(record.id);
			await this.store.deleteRequest(record.id);
		}
		const missing = Array.isArray(body.missingBlobs) ? body.missingBlobs.filter((hash): hash is string => typeof hash === "string") : [];
		let unavailable = 0;
		for (const hash of missing) {
			// Blobs still on disk go out with the next batch; the rest were acknowledged by a server that lost them.
			if (this.blobs.has(hash)) continue;
			this.acked.delete(hash);
			unavailable++;
		}
		if (unavailable) this.noteError(`the server is missing ${unavailable} blob(s) that are no longer spooled; affected requests stay incomplete`);
		for (const hash of this.acked) {
			if (this.acked.size <= MAX_ACKED) break;
			this.acked.delete(hash);
		}
		this.ackedAppends += newlyAcked.length;
		if (this.ackedAppends > MAX_ACKED) { this.ackedAppends = 0; await this.store.rewriteAcked([...this.acked]); }
		else await this.store.appendAcked(newlyAcked);
		if (!progressed) {
			this.noteError("the server accepted a batch without advancing any stream");
			return "retry";
		}
		return "progress";
	}

	/** Moves closed, fully uploaded streams out of the startup scan. */
	private async archive(): Promise<void> {
		for (const stream of [...this.streams.values()]) {
			const { state } = stream;
			if (stream.open > 0 || state.stopped) continue;
			if ([...this.documents.values()].some((document) => document.streamKey === state.key)) continue;
			const info = await stat(state.path).catch(() => undefined);
			if (info && info.size !== state.length) continue;
			this.streams.delete(state.key);
			this.herderRuns.delete(state.key);
			// Pi never wrote a file for a session without a conversation.
			if (!info && state.length === 0) await this.store.deleteStream(state.key);
			else await this.store.archiveStream(state);
		}
	}
}

const UPLOADER = Symbol.for("pi-extensions.pika.uploader");
const shared = globalThis as { [UPLOADER]?: Uploader };

/** The process-wide uploader for these options; a different configuration replaces it. */
export function acquireUploader(options: UploaderOptions): Uploader {
	const current = shared[UPLOADER];
	if (current && !current.isClosed && current.options.url === options.url && current.options.token === options.token && current.options.dir === options.dir) return current;
	if (current) void current.stop();
	const uploader = new Uploader(options);
	shared[UPLOADER] = uploader;
	return uploader;
}

export function currentUploader(): Uploader | undefined {
	const current = shared[UPLOADER];
	return current && !current.isClosed ? current : undefined;
}

/** Stops and forgets the process-wide uploader; its state stays on disk. */
export async function releaseUploader(uploader: Uploader): Promise<void> {
	if (shared[UPLOADER] === uploader) delete shared[UPLOADER];
	await uploader.stop();
}
