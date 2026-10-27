import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
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
/** The names a pika server older than 0.4 accepted. */
const LEGACY_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const KEY = /^[0-9a-f]{64}$/;
/** The contract's name rule: 1 to 64 characters after trimming, without control characters or U+2028/U+2029. */
export const validName = (name: unknown): name is string => {
	if (typeof name !== "string") return false;
	const length = [...name.trim()].length;
	return length >= 1 && length <= 64 && !/[\p{Cc}\u2028\u2029]/u.test(name.trim());
};
const hashId = (id: string) => createHash("sha256").update(id).digest("hex");
const normalizeCode = (code: string) => code.toUpperCase().replace(/-/g, "");

/** A pending or decided pairing, keyed by the SHA-256 of its secret id as the server stores it. */
export interface PollAnswer { status: number; body: Record<string, unknown> }

export interface MockPairing {
	code: string;
	/** The requested name. */
	device: string;
	host?: string;
	pikaVersion?: string;
	ip?: string;
	requestedAt: number;
	expiresAt: number;
	state: "pending" | "approved" | "denied";
	/** The SHA-256 of the device key the request sent. */
	keyHash?: string;
	/** The device the request was recognized as at start, and by what. */
	match?: { id: string; by: "token" | "key" };
	/** What approval decided: the device id the token will belong to, its name, and whether it continues an existing device. */
	approved?: { target: string; name: string; continued: boolean };
}

export interface MockDevice {
	name: string;
	/** Absent once revoked; the device itself stays. */
	token?: string;
	keyHash?: string;
	createdVia: "pairing" | "cli";
}

/** A `POST /api/pair/v1/bind` the server answered. */
export interface MockBind { authorization?: string; body: Record<string, unknown>; status: number }

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
	/** Devices by id, as pairing created or continued them. */
	readonly devices = new Map<string, MockDevice>();
	readonly pairings = new Map<string, MockPairing>();
	/** Every pairing request: its path, body, and the Authorization header when it had one. */
	readonly pairRequests: { path: string; body: Record<string, unknown>; authorization?: string }[] = [];
	/** Every bind request with its answer; they are not counted in `responses`. */
	readonly binds: MockBind[] = [];
	/** Bind requests get no answer; each one is counted in `hungBinds`, and in `closedBinds` once the client gives up on it. */
	hangBinds = false;
	hungBinds = 0;
	closedBinds = 0;
	/** Answers `start` like a pika server older than 0.4: names limited to the old characters, and no recognition. */
	legacyNames = false;
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

	/** The id of the only device called `name`; throws unless exactly one is. */
	deviceId(name: string): string {
		const ids = [...this.devices].filter(([, device]) => device.name === name).map(([id]) => id);
		if (ids.length !== 1) throw new Error(`${ids.length} devices are called ${name}`);
		return ids[0]!;
	}

	/** The only device called `name`. */
	deviceNamed(name: string): MockDevice {
		return this.devices.get(this.deviceId(name))!;
	}

	/** Adds a device with a token, as `pika token create` does; returns its id. */
	addDevice(name: string, options: { id?: string; keyHash?: string } = {}): { id: string; token: string } {
		const id = options.id ?? randomUUID();
		const token = `pika_${randomBytes(32).toString("hex")}`;
		this.devices.set(id, { name, token, createdVia: "cli", ...(options.keyHash ? { keyHash: options.keyHash } : {}) });
		this.tokens.add(token);
		return { id, token };
	}

	private findPending(code: string): MockPairing | undefined {
		return this.pendingPairings().find((pairing) => normalizeCode(pairing.code) === normalizeCode(code));
	}

	/**
	 * `POST /api/v1/pairings/:code/approve`: the HTTP status it answers. `continues` omitted takes
	 * the pairing's match, `null` makes a new device, and an id continues that device.
	 */
	approve(code: string, options: { name?: string; continues?: string | null } = {}): 200 | 400 | 404 {
		const pairing = this.findPending(code);
		if (!pairing) return 404;
		const continues = options.continues === undefined ? pairing.match?.id ?? null : options.continues;
		if (continues !== null && !this.devices.has(continues)) return 404;
		const name = options.name ?? (continues !== null ? this.devices.get(continues)!.name : pairing.device);
		if (!validName(name)) return 400;
		// A server older than 0.4 has no ids: the device id is its name.
		const target = continues ?? (this.legacyNames ? name : randomUUID());
		pairing.state = "approved";
		pairing.approved = { target, name: name.trim(), continued: continues !== null || (this.legacyNames && this.devices.has(target)) };
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

	/** The id of the device `token` belongs to. */
	private tokenDevice(token: string | undefined): string | undefined {
		return token === undefined ? undefined : [...this.devices].find(([, device]) => device.token === token)?.[0];
	}

	private bind(body: Record<string, unknown>, authorization: string | undefined, response: ServerResponse): void {
		if (this.hangBinds) {
			this.hungBinds++;
			response.on("close", () => { this.closedBinds++; });
			return;
		}
		const answer = (status: number, json?: unknown) => {
			this.binds.push({ ...(authorization ? { authorization } : {}), body, status });
			response.writeHead(status, json ? { "content-type": "application/json" } : {});
			response.end(json ? JSON.stringify(json) : undefined);
		};
		const id = this.tokenDevice(authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined);
		if (!id) return answer(401, { error: "unauthorized" });
		if (typeof body.key !== "string" || !KEY.test(body.key)) return answer(400, { error: "invalid_key" });
		const hash = hashId(body.key);
		const device = this.devices.get(id)!;
		if (device.keyHash === hash) return answer(204);
		if (!device.keyHash && ![...this.devices.values()].some((other) => other.keyHash === hash)) {
			device.keyHash = hash;
			return answer(204);
		}
		answer(409, { error: "key_conflict" });
	}

	private async pair(path: string, body: Record<string, unknown>, ip: string | undefined, authorization: string | undefined, response: ServerResponse): Promise<void> {
		if (path === "bind" && !this.legacyNames) return this.bind(body, authorization, response);
		this.pairRequests.push({ path, body, ...(authorization ? { authorization } : {}) });
		const now = Date.now();
		if (path === "start") {
			const { device, host, pikaVersion, key } = body;
			if (!validName(device) || (this.legacyNames && !LEGACY_NAME.test(device)) || (host !== undefined && (typeof host !== "string" || host.length > 255))) {
				return this.reply(response, 400, { error: "invalid_device" });
			}
			if (key !== undefined && !this.legacyNames && (typeof key !== "string" || !KEY.test(key))) return this.reply(response, 400, { error: "invalid_key" });
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
			const keyHash = typeof key === "string" && !this.legacyNames ? hashId(key) : undefined;
			const byToken = this.legacyNames ? undefined : this.tokenDevice(authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined);
			const byKey = keyHash === undefined ? undefined : [...this.devices].find(([, known]) => known.keyHash === keyHash)?.[0];
			const match = byToken ? { id: byToken, by: "token" as const } : byKey ? { id: byKey, by: "key" as const } : undefined;
			this.pairings.set(hashId(pairingId), {
				code, device: device.trim(), requestedAt: now, expiresAt, state: "pending", ip,
				...(typeof host === "string" ? { host } : {}), ...(typeof pikaVersion === "string" ? { pikaVersion } : {}),
				...(keyHash ? { keyHash } : {}), ...(match ? { match } : {}),
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
			const { target, name, continued } = pairing.approved!;
			const token = `pika_${randomBytes(32).toString("hex")}`;
			const old = this.devices.get(target);
			if (old?.token) this.tokens.delete(old.token);
			const device: MockDevice = old ? Object.assign(old, { name, token }) : { name, token, createdVia: "pairing" };
			this.devices.set(target, device);
			this.tokens.add(token);
			// A machine's key points at the device it was last paired as.
			if (pairing.keyHash) {
				for (const other of this.devices.values()) if (other.keyHash === pairing.keyHash) delete other.keyHash;
				device.keyHash = pairing.keyHash;
			}
			this.pairings.delete(id);
			return { status: 200, body: this.legacyNames ? { status: "approved", device: target, token } : { status: "approved", device: target, name, token, continued } };
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
			return this.pair(path.slice("/pika/api/pair/v1/".length), body as Record<string, unknown>, request.socket.remoteAddress, request.headers.authorization, response);
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
