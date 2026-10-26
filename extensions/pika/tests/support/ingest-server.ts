import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { gunzipSync } from "node:zlib";
import { reconstructPayload, sha256 } from "../../blocks.ts";

export const TOKEN = "test-token";

interface StreamItem { key: string; kind: string; offset: number; lines: string[]; path?: string; meta?: unknown }
interface DocumentItem { key: string; kind: string; runId: string; content: string; sha256: string }
interface RequestItem { id: string; sessionId: string; seq: number; fidelity: string; skeleton: unknown; blocks: string[]; assistant?: { timestamp: number; responseId?: string }; [key: string]: unknown }
interface BatchBody {
	client?: { host?: string; pikaVersion?: string; piVersion?: string };
	streams?: StreamItem[];
	documents?: DocumentItem[];
	blobs?: { hash: string; data: string }[];
	requests?: RequestItem[];
}

/**
 * `redirect` answers with a 307 to the same path under `/moved`, which is served as usual; `fail`
 * answers 503; `unauthorized` answers 401 whatever the token.
 */
export type Mode = "ok" | "hang" | "redirect" | "fail" | "unauthorized";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEVICE = /^[A-Za-z0-9._-]{1,64}$/;
const hashId = (id: string) => createHash("sha256").update(id).digest("hex");
const normalizeCode = (code: string) => code.toUpperCase().replace(/-/g, "");

/** A pending or decided pairing, keyed by the SHA-256 of its secret id as the server stores it. */
export interface PollAnswer { status: number; body: Record<string, unknown> }

export interface MockPairing {
	code: string;
	device: string;
	host?: string;
	pikaVersion?: string;
	ip?: string;
	requestedAt: number;
	expiresAt: number;
	state: "pending" | "approved" | "denied";
	/** The device name approval chose, and whether it replaces an existing device of that name. */
	approved?: { name: string; replace: boolean };
}

/**
 * An in-memory ingest server with the spec's append, duplicate, gap, conflict, and idempotency rules,
 * and the device side of pairing; `approve`, `deny`, and `expire` stand in for the web UI.
 */
export class MockIngest {
	readonly streams = new Map<string, { kind: string; data: Buffer; path?: string; meta?: unknown }>();
	readonly blobs = new Map<string, string>();
	readonly requests = new Map<string, RequestItem>();
	readonly documents = new Map<string, DocumentItem>();
	/** Every document upload, in order. */
	readonly documentUploads: DocumentItem[] = [];
	/** How often each request id arrived. */
	readonly requestReceipts = new Map<string, number>();
	readonly bodies: BatchBody[] = [];
	/** The uncompressed size of each body in `bodies`. */
	readonly sizes: number[] = [];
	readonly responses: number[] = [];
	readonly gaps: string[] = [];
	readonly conflicts: string[] = [];
	readonly headers: IncomingMessage["headers"][] = [];
	/** Tokens ingest accepts; pairing adds the tokens it creates. */
	readonly tokens = new Set([TOKEN]);
	/** Device tokens created by pairing, by device name. */
	readonly devices = new Map<string, { token: string; createdVia: "pairing" }>();
	readonly pairings = new Map<string, MockPairing>();
	/** Every pairing request: its path and body. */
	readonly pairRequests: { path: string; body: Record<string, unknown> }[] = [];
	/** Every `pairingId` handed out, so tests can check that none is shown. */
	readonly pairingIds: string[] = [];
	/** Without pairing, the server answers 404 under `/api/pair/`, like a pika older than 0.2. */
	pairing = true;
	/** Seconds in the `start` answer. */
	pairInterval = 2;
	pairExpiresIn = 600;
	/** Called with each new pairing's code. */
	onPairingStart?: (code: string) => void;
	/**
	 * Called with each poll's answer after the server has acted on it (an approved pairing's device
	 * exists by then); its result, once settled, is sent instead.
	 */
	onPoll?: (answer: PollAnswer) => PollAnswer | Promise<PollAnswer>;
	private readonly pairStarts: number[] = [];
	mode: Mode = "ok";
	/** Like the server's `--max-body`: a larger compressed or uncompressed body gets 413. */
	maxBody = 32 * 1024 * 1024;
	private server?: Server;
	private readonly sockets = new Set<Socket>();
	port = 0;

	get url(): string { return `http://127.0.0.1:${this.port}/pika`; }

	async start(): Promise<this> {
		const server = createServer((request, response) => { void this.handle(request, response); });
		server.on("connection", (socket) => { this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket)); });
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.port, "127.0.0.1", () => resolve()); });
		this.port = (server.address() as AddressInfo).port;
		this.server = server;
		return this;
	}

	/** Picks a free port without serving on it, so the server can come up later. */
	async reserve(): Promise<this> {
		await this.start();
		await this.stop();
		return this;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	data(key: string): string | undefined { return this.streams.get(key)?.data.toString("utf8"); }

	payload(id: string): unknown {
		const request = this.requests.get(id);
		if (!request) throw new Error(`no request ${id}`);
		return reconstructPayload(request.skeleton, (hash) => this.blobs.get(hash));
	}

	sessionRequests(sessionId: string): RequestItem[] {
		return [...this.requests.values()].filter((request) => request.sessionId === sessionId).sort((a, b) => a.seq - b.seq);
	}

	/** Pending pairings that have not expired, newest first, as `GET /api/v1/pairings` lists them. */
	pendingPairings(): MockPairing[] {
		return [...this.pairings.values()].filter((pairing) => pairing.state === "pending" && pairing.expiresAt > Date.now()).sort((a, b) => b.requestedAt - a.requestedAt);
	}

	private findPending(code: string): MockPairing | undefined {
		return this.pendingPairings().find((pairing) => normalizeCode(pairing.code) === normalizeCode(code));
	}

	/** `POST /api/v1/pairings/:code/approve`: the HTTP status it answers. */
	approve(code: string, options: { name?: string; replace?: boolean } = {}): 200 | 400 | 404 | 409 {
		const pairing = this.findPending(code);
		if (!pairing) return 404;
		const name = options.name ?? pairing.device;
		if (!DEVICE.test(name)) return 400;
		if (this.devices.has(name) && !options.replace) return 409;
		pairing.state = "approved";
		pairing.approved = { name, replace: options.replace === true };
		return 200;
	}

	/** `POST /api/v1/pairings/:code/deny`: the HTTP status it answers. */
	deny(code: string): 204 | 404 {
		const pairing = this.findPending(code);
		if (!pairing) return 404;
		pairing.state = "denied";
		return 204;
	}

	/** Makes a pairing expire now. */
	expire(code: string): void {
		const pairing = [...this.pairings.values()].find((candidate) => normalizeCode(candidate.code) === normalizeCode(code));
		if (pairing) pairing.expiresAt = Date.now() - 1;
	}

	private async pair(path: string, body: Record<string, unknown>, ip: string | undefined, response: ServerResponse): Promise<void> {
		this.pairRequests.push({ path, body });
		const now = Date.now();
		if (path === "start") {
			const { device, host, pikaVersion } = body;
			if (typeof device !== "string" || !DEVICE.test(device) || (host !== undefined && (typeof host !== "string" || host.length > 255))) {
				return this.reply(response, 400, { error: "invalid_device" });
			}
			for (const [id, pairing] of this.pairings) if (pairing.state === "pending" && pairing.expiresAt <= now) this.pairings.delete(id);
			if (this.pendingPairings().length >= 10) return this.reply(response, 429, { error: "too_many_pairings" });
			while (this.pairStarts.length && this.pairStarts[0]! <= now - 10 * 60_000) this.pairStarts.shift();
			if (this.pairStarts.length >= 5) {
				const retryAfter = Math.ceil((this.pairStarts[0]! + 10 * 60_000 - now) / 1000);
				return this.reply(response, 429, { error: "too_many_attempts", retryAfter });
			}
			this.pairStarts.push(now);
			let code: string;
			do {
				const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
				code = `${chars.slice(0, 4)}-${chars.slice(4)}`;
			} while (this.findPending(code));
			const pairingId = randomBytes(32).toString("base64url");
			this.pairingIds.push(pairingId);
			const expiresAt = now + this.pairExpiresIn * 1000;
			this.pairings.set(hashId(pairingId), {
				code, device, requestedAt: now, expiresAt, state: "pending", ip,
				...(typeof host === "string" ? { host } : {}), ...(typeof pikaVersion === "string" ? { pikaVersion } : {}),
			});
			this.reply(response, 200, { pairingId, code, expiresAt: new Date(expiresAt).toISOString(), expiresIn: this.pairExpiresIn, interval: this.pairInterval });
			this.onPairingStart?.(code);
			return;
		}
		if (path !== "poll") return this.reply(response, 404, { error: "not found" });
		const answer = this.poll(body, now);
		const sent = this.onPoll ? await this.onPoll(answer) : answer;
		this.reply(response, sent.status, sent.body);
	}

	private poll(body: Record<string, unknown>, now: number): PollAnswer {
		const id = typeof body.pairingId === "string" ? hashId(body.pairingId) : undefined;
		const pairing = id === undefined ? undefined : this.pairings.get(id);
		if (!id || !pairing) return { status: 404, body: { error: "unknown_pairing" } };
		if (pairing.state === "approved") {
			// The token exists only from this answer on; the server keeps only its hash.
			const name = pairing.approved!.name;
			const token = `pika_${randomBytes(32).toString("hex")}`;
			const old = this.devices.get(name);
			if (old) this.tokens.delete(old.token);
			this.devices.set(name, { token, createdVia: "pairing" });
			this.tokens.add(token);
			this.pairings.delete(id);
			return { status: 200, body: { status: "approved", device: name, token } };
		}
		if (pairing.state === "denied") {
			this.pairings.delete(id);
			return { status: 200, body: { status: "denied" } };
		}
		if (pairing.expiresAt <= now) {
			this.pairings.delete(id);
			return { status: 200, body: { status: "expired" } };
		}
		return { status: 200, body: { status: "pending" } };
	}

	private reply(response: ServerResponse, status: number, body: unknown): void {
		this.responses.push(status);
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		if (this.mode === "hang") return;
		const moved = request.url?.startsWith("/moved/");
		if (this.mode === "redirect" && !moved) {
			this.responses.push(307);
			response.writeHead(307, { location: `/moved${request.url ?? "/"}` });
			response.end();
			return;
		}
		if (this.mode === "fail") return this.reply(response, 503, { error: "unavailable" });
		const path = moved ? request.url!.slice("/moved".length) : request.url;
		if (request.method === "POST" && this.pairing && path?.startsWith("/pika/api/pair/v1/")) {
			let body: unknown;
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* refused below */ }
			if (!body || typeof body !== "object" || Array.isArray(body)) return this.reply(response, 400, { error: "invalid_json" });
			return this.pair(path.slice("/pika/api/pair/v1/".length), body as Record<string, unknown>, request.socket.remoteAddress, response);
		}
		if (request.method !== "POST" || path !== "/pika/api/ingest/v1/batch") return this.reply(response, 404, { error: "not found" });
		const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice("Bearer ".length) : undefined;
		if (this.mode === "unauthorized" || bearer === undefined || !this.tokens.has(bearer)) return this.reply(response, 401, { error: "unauthorized" });
		this.headers.push(request.headers);
		let raw = Buffer.concat(chunks);
		if (raw.length > this.maxBody) return this.reply(response, 413, { error: "too_large" });
		if (request.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
		if (raw.length > this.maxBody) return this.reply(response, 413, { error: "too_large" });
		const body = JSON.parse(raw.toString("utf8")) as BatchBody;
		this.bodies.push(body);
		this.sizes.push(raw.length);

		// Validate every stream before applying anything: one batch is one transaction.
		const appends: { key: string; kind: string; tail: Buffer; item: StreamItem }[] = [];
		for (const item of body.streams ?? []) {
			const committed = this.streams.get(item.key)?.data ?? Buffer.alloc(0);
			if (item.offset > committed.length) {
				this.gaps.push(item.key);
				return this.reply(response, 409, { error: "gap", key: item.key, length: committed.length });
			}
			const bytes = Buffer.from(item.lines.map((line) => `${line}\n`).join(""), "utf8");
			const overlap = Math.min(bytes.length, committed.length - item.offset);
			if (!bytes.subarray(0, overlap).equals(committed.subarray(item.offset, item.offset + overlap))) {
				this.conflicts.push(item.key);
				return this.reply(response, 409, { error: "conflict", key: item.key, length: committed.length });
			}
			appends.push({ key: item.key, kind: item.kind, tail: bytes.subarray(overlap), item });
		}
		for (const { key, kind, tail, item } of appends) {
			const existing = this.streams.get(key);
			this.streams.set(key, { kind, data: Buffer.concat([existing?.data ?? Buffer.alloc(0), tail]), path: item.path, meta: item.meta });
		}
		for (const blob of body.blobs ?? []) {
			if (sha256(blob.data) !== blob.hash) return this.reply(response, 400, { error: "bad blob hash" });
			this.blobs.set(blob.hash, blob.data);
		}
		for (const document of body.documents ?? []) {
			this.documentUploads.push(document);
			this.documents.set(document.key, document);
		}
		const missing = new Set<string>();
		for (const item of body.requests ?? []) {
			this.requestReceipts.set(item.id, (this.requestReceipts.get(item.id) ?? 0) + 1);
			if (!this.requests.has(item.id)) this.requests.set(item.id, item);
			for (const hash of item.blocks) if (!this.blobs.has(hash)) missing.add(hash);
		}
		const streams: Record<string, { length: number }> = {};
		for (const item of body.streams ?? []) streams[item.key] = { length: this.streams.get(item.key)!.data.length };
		this.reply(response, 200, { streams, missingBlobs: [...missing] });
	}
}
