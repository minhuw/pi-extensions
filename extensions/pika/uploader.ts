import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { sha256, splitPayload } from "./blocks.ts";
import { MAX_ACKED, Store, type RequestRecord, type SpooledRequest, type StreamKind, type StreamState } from "./store.ts";

export const PIKA_VERSION = "0.1.0";
/** Uncompressed batch body limit; the server accepts 32 MiB by default. */
export const MAX_BATCH_BYTES = 8 * 1024 * 1024 - 64 * 1024;
const MIN_BATCH_BYTES = 256 * 1024;
const BATCH_OVERHEAD = 512;
const STREAM_OVERHEAD = 256;
const BLOB_OVERHEAD = 90;
/** 413s for a batch of one item before that item is parked. */
export const MAX_TOO_LARGE = 3;
/** Batches in which the server still reports a request's resent blocks missing before the client gives up on them. */
const MAX_MISSING_ROUNDS = 3;
const MAX_BACKOFF_MS = 60_000;
const FIRST_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const POKE_DELAY_MS = 200;
const SCAN_INTERVAL_MS = 1_000;
const MAX_GAP_RETRIES = 3;
const STOP_WAIT_MS = 1_000;
/** Unreferenced spooled blobs younger than this may belong to a request another process is spooling. */
const ORPHAN_BLOB_AGE_MS = 60_000;
/** How long a verdict on whether the process holding a request is alive stands before it is checked again. */
const HELD_CHECK_MS = 5_000;
/**
 * A held request whose process cannot be verified from here, because it ran on another machine or
 * has no start time to rule out a reused pid, is uploaded as it is after this.
 */
const MAX_UNVERIFIED_HOLD_MS = 6 * 60 * 60 * 1000;
/** Start times `processStart` reports: epoch seconds, or Linux's boot id and clock ticks. Earlier versions stored a localized date. */
const COMPARABLE_START = /^(?:\d+|[0-9a-f-]*:\d+)$/;

const gzipAsync = promisify(gzip);
const execFileAsync = promisify(execFile);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface UploaderOptions {
	url: string;
	token: string;
	/** `<agentDir>/pika` */
	dir: string;
	piVersion?: string;
	/** This process as recorded in the requests it holds; tests substitute another one. */
	owner?: OwnerProcess;
}

/** A process that holds requests: its pid, machine, and start time as `processStart` reports it, when known. */
export interface OwnerProcess {
	pid: number;
	machine?: string;
	/** What earlier versions recorded instead of `machine`. */
	host?: string;
	started?: string;
}

export interface UploaderStatus {
	url: string;
	queuedItems: number;
	queuedBytes: number;
	/** Items the server refused as too large; they stay in `dir` and are not retried. */
	parked: { items: number; bytes: number; dir: string };
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
/** What the assistant message adds to a spooled request. */
export type RequestCompletion = Pick<RequestRecord, "assistant" | "provider" | "api" | "model">;
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

interface PendingRequest {
	/** The version last read or written; other processes may since have completed or removed the file. */
	record: SpooledRequest;
	bytes: number;
	missingRounds: number;
}

/** A spooled block text and how many pending requests reference it. */
interface SpooledBlob {
	size: number;
	refs: number;
}

/** One unit of a batch; the unit that is parked after repeated 413s. */
type Item =
	| { kind: "line"; key: string; offset: number }
	| { kind: "blob"; hash: string }
	| { kind: "request"; id: string }
	| { kind: "document"; key: string };

interface Batch {
	streams: { key: string; kind: StreamKind; offset: number; lines: string[]; path: string; meta?: Record<string, unknown> }[];
	ends: Map<string, number>;
	documents: PendingDocument[];
	blobs: { hash: string; data: string }[];
	requests: SpooledRequest[];
	units: number;
	first?: Item;
}

type Outcome = "progress" | "retry" | "stop";
/** What can be told from here about the process holding a request; `unverified` holds are capped by age. */
type Holder = "alive" | "dead" | "unverified";

/** The complete lines between `offset` and `end`, or none when the file ends before a newline. */
export async function readLines(path: string, offset: number, end: number, maxBytes: number): Promise<string[]> {
	const handle = await open(path, "r");
	try {
		let want = Math.max(1, Math.min(end - offset, maxBytes));
		for (;;) {
			const buffer = Buffer.alloc(want);
			const { bytesRead } = await handle.read(buffer, 0, want, offset);
			const chunk = buffer.subarray(0, bytesRead);
			const last = chunk.lastIndexOf(0x0a);
			if (last >= 0) return chunk.subarray(0, last).toString("utf8").split("\n");
			// Only a partial line so far, or the file shrank after `end` was taken.
			if (bytesRead < want || offset + bytesRead >= end) return [];
			want = Math.min(end - offset, want * 2);
		}
	} finally {
		await handle.close();
	}
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const wireRecord = ({ awaiting: _, ...record }: SpooledRequest): RequestRecord => record;
const itemId = (item: Item) => item.kind === "line" ? `line:${item.key}:${item.offset}` : `${item.kind}:${"hash" in item ? item.hash : "id" in item ? item.id : item.key}`;

function alive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

let bootId: Promise<string> | undefined;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/;

/**
 * When `pid` started, so a reused pid does not pass for an exited process; undefined if unknown.
 * Linux: boot id and clock ticks; other platforms with `ps`: epoch seconds; Windows: unknown.
 */
export async function processStart(pid: number): Promise<string | undefined> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		if (process.platform === "linux") {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			// Field 22, counted after the command name, which may contain spaces and parentheses.
			const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
			bootId ??= readFile("/proc/sys/kernel/random/boot_id", "utf8").then((text) => text.trim(), () => "");
			return ticks ? `${await bootId}:${ticks}` : undefined;
		}
		if (process.platform === "win32") return undefined;
		// `lstart` is in the caller's time zone and locale; fixing both makes it the same for every caller.
		const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, TZ: "UTC0", LC_ALL: "C" }, timeout: 5_000 });
		const match = LSTART.exec(stdout.trim());
		const month = match ? MONTHS.indexOf(match[1]!) : -1;
		if (!match || month < 0) return undefined;
		return String(Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000);
	} catch {
		return undefined;
	}
}

let machine: Promise<string> | undefined;

/** A stable id of this machine: Linux's machine-id, macOS's IOPlatformUUID, otherwise the hostname. */
export function machineId(): Promise<string> {
	return machine ??= (async () => {
		try {
			if (process.platform === "linux") {
				for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
					const id = (await readFile(file, "utf8").catch(() => "")).trim();
					if (id) return id;
				}
			} else if (process.platform === "darwin") {
				const { stdout } = await execFileAsync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 5_000 });
				const id = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(stdout)?.[1];
				if (id) return id;
			}
		} catch { /* the hostname below */ }
		return hostname();
	})();
}

let thisProcess: Promise<OwnerProcess> | undefined;
const currentProcess = () => thisProcess ??= Promise.all([processStart(process.pid), machineId()])
	.then(([started, machine]) => ({ pid: process.pid, machine, ...(started ? { started } : {}) }));

const OWNERS = Symbol.for("pi-extensions.pika.owners");
/** Ids of the uploaders created in this process, shared by module copies. */
const localOwners = (): Set<string> => (globalThis as { [OWNERS]?: Set<string> })[OWNERS] ??= new Set();

/**
 * Process-wide uploader. Session entries are read from their source files between the
 * acknowledged cursor and the last complete line, so the file itself is the durable queue;
 * requests and their block texts are spooled to disk before they are sent and kept until the
 * server has every block.
 */
export class Uploader {
	readonly store: Store;
	readonly ready: Promise<void>;
	/** Owner of the requests this uploader spools while their call is still streaming. */
	readonly id = randomUUID();
	private readonly streams = new Map<string, Stream>();
	private readonly requests = new Map<string, PendingRequest>();
	private readonly blobs = new Map<string, SpooledBlob>();
	private readonly acked = new Set<string>();
	private ackedAppends = 0;
	private readonly parked = new Map<string, number>();
	private readonly strikes = new Map<string, number>();
	private readonly documents = new Map<string, PendingDocument>();
	private readonly herderRuns = new Set<string>();
	private self: OwnerProcess = { pid: process.pid };
	/** Whether the processes holding requests read from the spool were alive when last checked, and when. */
	private readonly owners = new Map<string, { verdict: Holder; at: number }>();
	private heldElsewhere = false;
	private heldCheckedAt = 0;
	private spool: Promise<void> = Promise.resolve();
	private flushing?: Promise<void>;
	private again = false;
	private pokeTimer?: ReturnType<typeof setTimeout>;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private readonly scanTimer: ReturnType<typeof setInterval>;
	private scanning = false;
	private failures = 0;
	private budget = MAX_BATCH_BYTES;
	private oneItem = false;
	private inflight?: ClientRequest;
	private closed = false;
	private lastSuccess?: number;
	private lastError?: { at: number; message: string };
	private halted?: string;

	/** `after` is the stop of the uploader this one replaces in the same process, so its spooled requests are loaded too. */
	constructor(readonly options: UploaderOptions, after?: Promise<void>) {
		this.store = new Store(options.dir);
		// An uploader standing in for another process (`owner`) holds only its own requests.
		if (!options.owner) localOwners().add(this.id);
		this.ready = this.load(after).catch((error) => this.noteError(`loading local state: ${errorText(error)}`));
		this.scanTimer = setInterval(() => { this.scan().catch((error) => this.noteError(errorText(error))); }, SCAN_INTERVAL_MS);
		this.scanTimer.unref();
	}

	get isClosed(): boolean { return this.closed; }

	noteError(message: string): void {
		this.lastError = { at: Date.now(), message };
	}

	private async load(after?: Promise<void>): Promise<void> {
		await after;
		this.self = this.options.owner ?? await currentProcess();
		await this.store.init();
		// Acknowledgements hold only for the server that gave them.
		const acked = await this.store.loadAcked();
		if (acked.url === this.options.url) for (const hash of acked.hashes) this.acked.add(hash);
		else await this.store.rewriteAcked(this.options.url, []);
		for (const state of await this.store.loadActiveStreams()) {
			if (this.streams.has(state.key)) continue;
			this.streams.set(state.key, { state, open: 0, gapRetries: 0 });
			if (state.kind === "herder-journal") this.queueDocuments(state);
		}
		for (const [name, size] of await this.store.listParked()) this.parked.set(name, size);
		const blobs = await this.store.listBlobs();
		const refs = new Map<string, number>();
		for (const record of await this.store.loadRequests()) {
			this.requests.set(record.id, { record, bytes: jsonBytes(record), missingRounds: 0 });
			for (const hash of record.blocks) refs.set(hash, (refs.get(hash) ?? 0) + 1);
		}
		const cutoff = Date.now() - ORPHAN_BLOB_AGE_MS;
		for (const { hash, size, mtimeMs } of blobs) {
			const count = refs.get(hash);
			if (count) this.blobs.set(hash, { size, refs: count });
			else if (mtimeMs < cutoff) await this.store.deleteBlob(hash);
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

	/**
	 * Spools a request and its block texts. With `awaiting`, it is held back until
	 * `completeRequest`; if this process ends first, a later one uploads it as it is.
	 */
	enqueueRequest(input: RequestInput, payload: PayloadSource, options: { awaiting?: boolean } = {}): Promise<void> {
		return this.task(async () => {
			const value: unknown = "json" in payload ? JSON.parse(payload.json) : JSON.parse(JSON.stringify(payload.value) ?? "null");
			const split = splitPayload(value);
			const record: SpooledRequest = {
				...input, skeleton: split.skeleton, blocks: split.blocks,
				...(options.awaiting ? { awaiting: { ...this.self, owner: this.id } } : {}),
			};
			const previous = this.requests.get(record.id);
			for (const [hash, text] of split.data) {
				if (this.parked.has(hash)) continue;
				const blob = this.blobs.get(hash);
				if (blob) { blob.refs++; continue; }
				await this.store.saveBlob(hash, text);
				this.blobs.set(hash, { size: Buffer.byteLength(text), refs: 1 });
			}
			const bytes = await this.store.saveRequest(record);
			// A payload replaces the context spooled earlier for the same call.
			if (previous) for (const hash of this.forget(previous.record)) await this.store.deleteBlob(hash);
			this.requests.set(record.id, { record, bytes, missingRounds: 0 });
			this.poke();
		});
	}

	/**
	 * Rewrites a request held in this process with what its assistant message adds, if anything,
	 * and releases it for upload. An uploader this one replaced may have spooled it.
	 */
	completeRequest(id: string, completion: RequestCompletion = {}): Promise<void> {
		return this.task(async () => {
			const held = await this.store.loadRequest(id);
			if (!held?.awaiting || !this.holds(held.awaiting)) return;
			const { awaiting: _, ...record } = held;
			for (const [key, value] of Object.entries(completion)) if (value !== undefined) (record as Record<string, unknown>)[key] = value;
			const bytes = await this.store.saveRequest(record);
			const pending = this.requests.get(id);
			if (pending) { pending.record = record; pending.bytes = bytes; }
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
			// Requests held elsewhere go out once their process completes them or is gone.
			if (this.heldElsewhere && Date.now() - this.heldCheckedAt >= HELD_CHECK_MS) this.poke(0);
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
		// A flush stuck on local I/O must not hold up pi's shutdown; it stops at its next check.
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([this.flushing, new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_WAIT_MS); })]);
		clearTimeout(timer);
		await this.spool;
	}

	status(): UploaderStatus {
		let queuedItems = this.requests.size + this.documents.size;
		let queuedBytes = 0;
		for (const { bytes } of this.requests.values()) queuedBytes += bytes;
		for (const [hash, { size }] of this.blobs) if (!this.acked.has(hash)) { queuedItems++; queuedBytes += size; }
		for (const document of this.documents.values()) queuedBytes += Buffer.byteLength(document.content);
		const stoppedStreams: UploaderStatus["stoppedStreams"] = [];
		for (const stream of this.streams.values()) {
			if (stream.state.stopped) { stoppedStreams.push({ key: stream.state.key, reason: stream.state.stopped }); continue; }
			if (stream.size !== undefined && stream.size > stream.state.length) { queuedItems++; queuedBytes += stream.size - stream.state.length; }
		}
		let parkedBytes = 0;
		for (const size of this.parked.values()) parkedBytes += size;
		return {
			url: this.options.url, queuedItems, queuedBytes, stoppedStreams, halted: this.halted,
			parked: { items: this.parked.size, bytes: parkedBytes, dir: this.store.parked },
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

	/** Whether a call is still streaming in this process; its assistant message comes through `completeRequest`. */
	private holds(awaiting: NonNullable<SpooledRequest["awaiting"]>): boolean {
		return awaiting.owner === this.id || (!this.options.owner && awaiting.pid === process.pid && localOwners().has(awaiting.owner));
	}

	/**
	 * Whether the process holding a request may still complete it. The verdict on its process stands
	 * for `HELD_CHECK_MS`; the cap on unverified holds applies to each request's own age.
	 */
	private async holderAlive(record: SpooledRequest): Promise<boolean> {
		const awaiting = record.awaiting!;
		const known = this.owners.get(awaiting.owner);
		let verdict = known && Date.now() - known.at < HELD_CHECK_MS ? known.verdict : undefined;
		if (!verdict) {
			verdict = await this.checkHolder(awaiting);
			this.owners.set(awaiting.owner, { verdict, at: Date.now() });
		}
		if (verdict === "unverified") return Date.now() - Date.parse(record.at) < MAX_UNVERIFIED_HOLD_MS;
		return verdict === "alive";
	}

	private async checkHolder(awaiting: NonNullable<SpooledRequest["awaiting"]>): Promise<Holder> {
		const comparable = awaiting.started !== undefined && COMPARABLE_START.test(awaiting.started);
		const sameStart = async () => comparable && alive(awaiting.pid) && await processStart(awaiting.pid) === awaiting.started;
		const local = awaiting.machine !== undefined ? awaiting.machine === this.self.machine
			// Earlier versions recorded the hostname, which can change while the process runs.
			: awaiting.host === undefined || awaiting.host === hostname() || await sameStart();
		if (!local) return "unverified";
		if (!alive(awaiting.pid)) return "dead";
		// Uploaders in this process are known; another one with this pid has exited.
		if (awaiting.pid === process.pid) return localOwners().has(awaiting.owner) ? "alive" : "dead";
		if (comparable) {
			const started = await processStart(awaiting.pid);
			if (started !== undefined) return started === awaiting.started ? "alive" : "dead";
		}
		return "unverified";
	}

	/**
	 * Re-reads a request before it is sent, since another process may have uploaded it or completed
	 * it. A held request goes out once its call completes, or as it is once its process is gone.
	 */
	private async sendable(pending: PendingRequest): Promise<boolean> {
		if (pending.record.awaiting && this.holds(pending.record.awaiting)) return false;
		if (!(await this.reload(pending))) return false;
		const { record } = pending;
		if (!record.awaiting) return true;
		if (this.holds(record.awaiting)) return false;
		if (!(await this.holderAlive(record))) return true;
		this.heldElsewhere = true;
		return false;
	}

	/** Replaces a request with its current file; false, and forgotten, once another process removed it. */
	private async reload(pending: PendingRequest): Promise<boolean> {
		const record = await this.store.loadRequest(pending.record.id);
		if (!record) { this.forget(pending.record); return false; }
		pending.record = record;
		pending.bytes = jsonBytes(record);
		return true;
	}

	/**
	 * Fills a batch up to the budget: new stream lines, documents, then requests. A request goes
	 * out once its new blocks are in this batch or acknowledged, so its blocks may span earlier
	 * batches. An item larger than the budget is sent alone once nothing else is left.
	 */
	private async build(): Promise<Batch | undefined> {
		const batch: Batch = { streams: [], ends: new Map(), documents: [], blobs: [], requests: [], units: 0 };
		let size = BATCH_OVERHEAD;
		let solo: (() => Promise<void>) | undefined;
		const oversized = (bytes: number) => BATCH_OVERHEAD + bytes > this.budget;
		const room = (bytes: number) => !(this.oneItem && batch.units > 0) && size + bytes <= this.budget;
		const add = (bytes: number, item: Item, units = 1) => { size += bytes; batch.units += units; batch.first ??= item; };

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
			const overhead = STREAM_OVERHEAD + jsonBytes(state.path) + (state.meta ? jsonBytes(state.meta) : 0);
			if (info.size === state.length || !room(overhead)) continue;
			const lines = await readLines(state.path, state.length, info.size, Math.max(1, this.budget - size - overhead));
			const taken: string[] = [];
			let end = state.length;
			let bytes = overhead;
			for (const line of lines) {
				const lineBytes = jsonBytes(line) + 1;
				if (!room(bytes + lineBytes) || (this.oneItem && taken.length)) break;
				taken.push(line);
				bytes += lineBytes;
				end += Buffer.byteLength(line) + 1;
			}
			const push = (sent: string[], to: number, sentBytes: number) => {
				batch.streams.push({ key: state.key, kind: state.kind, offset: state.length, lines: sent, path: state.path, ...(state.meta ? { meta: state.meta } : {}) });
				batch.ends.set(state.key, to);
				add(sentBytes, { kind: "line", key: state.key, offset: state.length }, sent.length);
			};
			if (taken.length) { push(taken, end, bytes); continue; }
			const first = lines[0];
			if (first !== undefined && oversized(overhead + jsonBytes(first) + 1)) {
				solo ??= async () => push([first], state.length + Buffer.byteLength(first) + 1, overhead + jsonBytes(first) + 1);
			}
		}

		for (const document of this.documents.values()) {
			const bytes = jsonBytes(document);
			if (oversized(bytes)) { solo ??= async () => { batch.documents.push(document); add(bytes, { kind: "document", key: document.key }); }; continue; }
			if (!room(bytes)) continue;
			batch.documents.push(document);
			add(bytes, { kind: "document", key: document.key });
		}

		const inBatch = new Set<string>();
		// Blocks not spooled here are not waited for; the server reports them missing if it lacks them.
		const needed = (hash: string) => !this.acked.has(hash) && !inBatch.has(hash) && !this.parked.has(hash) && this.blobs.has(hash);
		const soloBlob = (hash: string) => async () => {
			const data = await this.store.readBlob(hash);
			if (data === undefined) { this.blobs.delete(hash); return; }
			batch.blobs.push({ hash, data });
			add(jsonBytes(data) + BLOB_OVERHEAD, { kind: "blob", hash });
		};
		this.heldElsewhere = false;
		this.heldCheckedAt = Date.now();
		for (const pending of [...this.requests.values()]) {
			if (!oversized(pending.bytes) && !room(pending.bytes)) continue;
			if (!(await this.sendable(pending))) continue;
			const { record } = pending;
			for (const hash of record.blocks) {
				if (!needed(hash)) continue;
				const blob = this.blobs.get(hash)!;
				if (oversized(blob.size + BLOB_OVERHEAD)) { solo ??= soloBlob(hash); continue; }
				if (!room(blob.size + BLOB_OVERHEAD)) continue;
				const data = await this.store.readBlob(hash);
				if (data === undefined) { this.blobs.delete(hash); continue; }
				const bytes = jsonBytes(data) + BLOB_OVERHEAD;
				if (oversized(bytes)) { solo ??= soloBlob(hash); continue; }
				if (!room(bytes)) continue;
				batch.blobs.push({ hash, data });
				inBatch.add(hash);
				add(bytes, { kind: "blob", hash });
			}
			if (record.blocks.some(needed)) continue;
			const bytes = jsonBytes(wireRecord(record)) + 2;
			if (oversized(bytes)) { solo ??= async () => { batch.requests.push(record); add(bytes, { kind: "request", id: record.id }); }; continue; }
			if (!room(bytes)) continue;
			batch.requests.push(record);
			add(bytes, { kind: "request", id: record.id });
		}

		if (!batch.units && solo) await solo();
		return batch.units ? batch : undefined;
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
			...(batch.requests.length ? { requests: batch.requests.map(wireRecord) } : {}),
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
		if (response.status === 413) return await this.tooLarge(batch);
		this.noteError(`server answered ${response.status}${response.text ? `: ${response.text.slice(0, 200)}` : ""}`);
		return "retry";
	}

	/** Smaller batches first; a single item that keeps getting 413 is parked so the rest of the queue moves on. */
	private async tooLarge(batch: Batch): Promise<Outcome> {
		if (batch.units > 1) {
			if (this.budget > MIN_BATCH_BYTES) this.budget = Math.max(MIN_BATCH_BYTES, Math.floor(this.budget / 2));
			else this.oneItem = true;
			return "progress";
		}
		const item = batch.first!;
		const id = itemId(item);
		const strikes = (this.strikes.get(id) ?? 0) + 1;
		if (strikes < MAX_TOO_LARGE) {
			this.strikes.set(id, strikes);
			this.noteError(`the server refused ${id} as too large (413)`);
			return "retry";
		}
		this.strikes.delete(id);
		this.failures = 0;
		await this.park(item);
		return "progress";
	}

	private async park(item: Item): Promise<void> {
		let what: string;
		if (item.kind === "line") {
			const stream = this.streams.get(item.key);
			what = `the line at byte ${item.offset} of ${item.key}`;
			if (stream) {
				// Later lines of the stream depend on this one, so the stream stops here.
				stream.state.stopped = `the line at byte ${item.offset} is larger than the server accepts (413)`;
				stream.state.updatedAt = new Date().toISOString();
				await this.store.saveStream(stream.state);
			}
		} else if (item.kind === "blob") {
			what = `block ${item.hash}`;
			await this.store.parkBlob(item.hash);
			this.parked.set(item.hash, this.blobs.get(item.hash)?.size ?? 0);
			this.blobs.delete(item.hash);
		} else if (item.kind === "request") {
			what = `request ${item.id}`;
			const pending = this.requests.get(item.id);
			await this.store.parkRequest(item.id);
			this.parked.set(`${item.id}.json`, pending?.bytes ?? 0);
			if (pending) await this.finish(pending.record, false);
		} else {
			what = `document ${item.key}`;
			const document = this.documents.get(item.key);
			if (document) {
				const name = encodeURIComponent(item.key);
				await this.store.parkDocument(name, document.content);
				this.parked.set(name, Buffer.byteLength(document.content));
				this.documents.delete(item.key);
				const stream = this.streams.get(document.streamKey);
				if (stream) {
					stream.state.docs = { ...stream.state.docs, [document.key]: document.sha256 };
					await this.store.saveStream(stream.state);
				}
			}
		}
		this.noteError(`parked ${what}: the server keeps refusing it as too large (413); it stays in ${this.store.parked}`);
	}

	/** Forgets a request and returns the spooled blocks no other pending request references. */
	private forget(record: SpooledRequest): string[] {
		this.requests.delete(record.id);
		this.strikes.delete(itemId({ kind: "request", id: record.id }));
		const unused: string[] = [];
		for (const hash of record.blocks) {
			const blob = this.blobs.get(hash);
			if (!blob || --blob.refs > 0) continue;
			this.blobs.delete(hash);
			unused.push(hash);
		}
		return unused;
	}

	/** Forgets a request and deletes the block texts no other pending request references. */
	private async finish(record: SpooledRequest, deleteRecord = true): Promise<void> {
		const unused = this.forget(record);
		if (deleteRecord) await this.store.deleteRequest(record.id);
		for (const hash of unused) await this.store.deleteBlob(hash);
	}

	private async accepted(batch: Batch, body: Record<string, unknown>): Promise<Outcome> {
		this.failures = 0;
		this.oneItem = false;
		this.lastSuccess = Date.now();
		let progressed = batch.requests.length + batch.blobs.length > 0;
		const lengths = body.streams && typeof body.streams === "object" ? body.streams as Record<string, { length?: unknown }> : {};
		for (const item of batch.streams) {
			const stream = this.streams.get(item.key);
			if (!stream) continue;
			this.strikes.delete(itemId({ kind: "line", key: item.key, offset: item.offset }));
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
			this.strikes.delete(itemId({ kind: "document", key: document.key }));
			const stream = this.streams.get(document.streamKey);
			if (this.documents.get(document.key)?.sha256 === document.sha256) this.documents.delete(document.key);
			if (stream) {
				stream.state.docs = { ...stream.state.docs, [document.key]: document.sha256 };
				await this.store.saveStream(stream.state);
			}
		}
		const missing = new Set(Array.isArray(body.missingBlobs) ? body.missingBlobs.filter((hash): hash is string => typeof hash === "string") : []);
		const newlyAcked: string[] = [];
		for (const { hash } of batch.blobs) {
			this.strikes.delete(itemId({ kind: "blob", hash }));
			if (missing.has(hash)) continue;
			this.acked.delete(hash);
			this.acked.add(hash);
			newlyAcked.push(hash);
		}
		// The server lost these, or never had them: send them again with the requests that need them.
		for (const hash of missing) this.acked.delete(hash);
		let unavailable = 0;
		for (const record of batch.requests) {
			const pending = this.requests.get(record.id);
			const lacking = record.blocks.filter((hash) => missing.has(hash) && !this.parked.has(hash));
			const resend = lacking.filter((hash) => this.blobs.has(hash)).length;
			if (resend && pending && ++pending.missingRounds <= MAX_MISSING_ROUNDS) continue;
			unavailable += lacking.length;
			await this.finish(record);
		}
		if (unavailable) this.noteError(`the server is missing ${unavailable} block(s) that cannot be sent; affected requests stay incomplete`);
		for (const hash of this.acked) {
			if (this.acked.size <= MAX_ACKED) break;
			this.acked.delete(hash);
		}
		this.ackedAppends += newlyAcked.length;
		if (this.ackedAppends > MAX_ACKED) { this.ackedAppends = 0; await this.store.rewriteAcked(this.options.url, [...this.acked]); }
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
	const uploader = new Uploader(options, current?.stop());
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
