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

export type Mode = "ok" | "hang";

/** An in-memory ingest server with the spec's append, duplicate, gap, conflict, and idempotency rules. */
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
	readonly responses: number[] = [];
	readonly gaps: string[] = [];
	readonly conflicts: string[] = [];
	readonly headers: IncomingMessage["headers"][] = [];
	mode: Mode = "ok";
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

	private reply(response: ServerResponse, status: number, body: unknown): void {
		this.responses.push(status);
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		if (this.mode === "hang") return;
		if (request.method !== "POST" || request.url !== "/pika/api/ingest/v1/batch") return this.reply(response, 404, { error: "not found" });
		if (request.headers.authorization !== `Bearer ${TOKEN}`) return this.reply(response, 401, { error: "unauthorized" });
		this.headers.push(request.headers);
		let raw = Buffer.concat(chunks);
		if (request.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
		const body = JSON.parse(raw.toString("utf8")) as BatchBody;
		this.bodies.push(body);

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
