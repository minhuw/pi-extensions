import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { HelloSession, OnlineSession, Target } from "../../protocol.ts";

export const TOKEN = "relay-test-token";

type Frame = { type: string; [key: string]: unknown };
/** A `sent` frame without its type and client id. */
export type SentAnswer = { status: "delivered" | "queued"; id: string; to: Target } | { status: "rejected"; reason: string };

/** One device WebSocket the server accepted. */
export interface Connection {
	ws: WebSocket;
	device: string;
	deviceName?: string;
	openedAt: number;
	/** The session as `hello` described it, with later `state` frames applied. */
	session?: HelloSession;
	/** The `hello` exactly as it arrived. */
	hello?: HelloSession;
	frames: Frame[];
	closed?: { code: number; reason: string };
	welcomed: boolean;
}

type PushedMessage = Partial<{ id: string; from: unknown; text: string; urgent: boolean; replyTo: string; hops: number; sentAt: string }>;

/** A message the default `send` handling routed between two connections. */
export interface Routed { id: string; from: string; to: string; text: string; hops: number; urgent: boolean; replyTo?: string }

/** The device fields of an object that names a connection's device. */
const named = (connection: Connection) => ({ device: connection.device, ...(connection.deviceName !== undefined ? { deviceName: connection.deviceName } : {}) });

const json = (response: ServerResponse, status: number, body: unknown) => {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
};

/**
 * An in-memory relay server: health with `features`, the device WebSocket with bearer auth, the
 * sessions route, and enough of `send` to route messages between two real sessions. Tests drive
 * everything else (pushes, statuses, closes) directly.
 */
export class FakeRelay {
	private server?: Server;
	private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	private readonly sockets = new Set<Socket>();
	private ids = 0;
	base = "";
	url = "";
	/** `undefined` answers health like a pika server older than 0.3.0. */
	features: string[] | undefined = ["relay"];
	readonly tokens = new Set([TOKEN]);
	device = "laptop";
	/** The device's display name; undefined answers like a server older than 0.4, which sends none. */
	deviceName: string | undefined;
	/** Every upgrade request, accepted or not. */
	readonly upgrades: { at: number; authorization?: string; path: string }[] = [];
	readonly connections: Connection[] = [];
	/** Session ids pika has "recorded"; sends to them are queued while they are offline. */
	readonly recorded = new Set<string>();
	readonly routed: Routed[] = [];
	readonly sessionRequests: { authorization?: string }[] = [];
	/** A close code to answer a `hello` with instead of `welcome`. */
	onHello?: (hello: HelloSession, connection: Connection) => number | undefined;
	/** Answers a `send` instead of the default routing; undefined routes it as usual, "none" never answers. */
	onSend?: (frame: Frame, connection: Connection) => SentAnswer | "none" | undefined;
	/** How long a routed message waits for its `ack` before `sent` says queued; 2 s as in the contract. */
	ackWaitMs = 2_000;
	limits = { ttlSeconds: 300, heartbeatSeconds: 20, maxTextBytes: 32 * 1024, maxHops: 8 };
	/** Messages `queue` accepted: pushed on every welcome of their target until acknowledged or expired. */
	readonly mailbox = new Map<string, { sessionId: string; frame: Frame }>();

	async start(base = ""): Promise<this> {
		this.base = base;
		this.server = createServer((request, response) => this.handle(request, response));
		this.server.on("connection", (socket) => { this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket)); });
		this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket as Socket, head));
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${base}`;
		return this;
	}

	async stop(): Promise<void> {
		for (const connection of this.connections) connection.ws.terminate();
		this.wss.close();
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
	}

	private authorized(request: IncomingMessage): boolean {
		const header = request.headers.authorization ?? "";
		return header.startsWith("Bearer ") && this.tokens.has(header.slice(7));
	}

	private handle(request: IncomingMessage, response: ServerResponse): void {
		const path = (request.url ?? "").split("?")[0]!;
		if (!path.startsWith(this.base)) return json(response, 404, { error: "not_found" });
		const route = path.slice(this.base.length);
		if (route === "/api/health") return json(response, 200, { ok: true, version: this.features ? "0.3.0" : "0.2.0", basePath: this.base, ...(this.features ? { features: this.features } : {}) });
		if (route === "/api/ingest/v1/batch" && request.method === "POST") {
			request.resume();
			return this.authorized(request) ? json(response, 200, { streams: [], requests: [], blobs: [], documents: [] }) : json(response, 401, { error: "unauthorized" });
		}
		if (route === "/api/relay/v1/sessions") {
			this.sessionRequests.push({ authorization: request.headers.authorization });
			if (!this.features?.includes("relay")) return json(response, 404, { error: "relay_disabled" });
			if (!this.authorized(request)) return json(response, 401, { error: "unauthorized" });
			return json(response, 200, { items: this.onlineSessions() });
		}
		json(response, 404, { error: "not_found" });
	}

	private upgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
		const path = (request.url ?? "").split("?")[0]!;
		this.upgrades.push({ at: Date.now(), authorization: request.headers.authorization, path });
		const refuse = (status: number, body: unknown) => {
			const text = JSON.stringify(body);
			socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
		};
		if (path !== `${this.base}/api/relay/v1/connect`) return refuse(404, { error: "not_found" });
		if (!this.features?.includes("relay")) return refuse(404, { error: "relay_disabled" });
		if (!this.authorized(request)) return refuse(401, { error: "unauthorized" });
		this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
	}

	private accept(ws: WebSocket): void {
		const connection: Connection = { ws, device: this.device, ...(this.deviceName !== undefined ? { deviceName: this.deviceName } : {}), openedAt: Date.now(), frames: [], welcomed: false };
		this.connections.push(connection);
		ws.on("close", (code, reason) => { connection.closed = { code, reason: reason.toString() }; });
		ws.on("message", (data, binary) => {
			if (binary) { ws.close(4400); return; }
			let frame: Frame;
			try { frame = JSON.parse(data.toString()); } catch { ws.close(4400); return; }
			connection.frames.push(frame);
			void this.receive(connection, frame);
		});
	}

	private async receive(connection: Connection, frame: Frame): Promise<void> {
		if (frame.type === "hello") {
			const hello = frame.session as HelloSession;
			connection.hello = structuredClone(hello);
			connection.session = structuredClone(hello);
			const code = this.onHello?.(hello, connection);
			if (code) { connection.ws.close(code); return; }
			// A newer connection of the same session takes over, as the server's 4410 does.
			for (const other of this.connections) {
				if (other !== connection && !other.closed && other.session?.id === hello.id) other.ws.close(4410);
			}
			connection.welcomed = true;
			this.sendTo(connection, { type: "welcome", ...named(connection), serverVersion: "0.3.0", limits: this.limits });
			for (const queued of this.mailbox.values()) if (queued.sessionId === hello.id) this.sendTo(connection, queued.frame);
		} else if (frame.type === "ack") {
			this.mailbox.delete(String(frame.id));
		} else if (frame.type === "state") {
			const { type: _type, ...changes } = frame;
			if (connection.session) Object.assign(connection.session, changes);
		} else if (frame.type === "send") {
			const answer = this.onSend?.(frame, connection) ?? await this.route(connection, frame);
			if (answer !== "none") this.sendTo(connection, { type: "sent", clientId: frame.clientId, ...answer });
		}
	}

	private target(id: string): Target {
		const session = this.online(id)?.session;
		return session ? { sessionId: id, ...named(this.online(id)!), ...(session.name ? { name: session.name } : {}), ...(session.title ? { title: session.title } : {}), project: session.project } : { sessionId: id };
	}

	private async route(from: Connection, frame: Frame): Promise<SentAnswer> {
		const to = String(frame.to);
		const hops = frame.hops as number;
		if (!String(frame.text ?? "") || !Number.isInteger(hops) || hops < 1) return { status: "rejected", reason: "invalid" };
		if (to === from.session?.id) return { status: "rejected", reason: "self" };
		if (hops > this.limits.maxHops) return { status: "rejected", reason: "hop_limit" };
		const target = this.online(to);
		if (!target && !this.recorded.has(to)) return { status: "rejected", reason: "unknown_session" };
		const id = this.nextId();
		this.routed.push({ id, from: from.session!.id, to, text: String(frame.text), hops, urgent: frame.urgent === true, ...(frame.replyTo ? { replyTo: String(frame.replyTo) } : {}) });
		if (!target) return { status: "queued", id, to: this.target(to) };
		const sender = from.session!;
		this.sendTo(target, {
			type: "message", id, text: frame.text, urgent: frame.urgent === true, hops, sentAt: new Date().toISOString(),
			from: { kind: "session", sessionId: sender.id, ...named(from), ...(sender.name ? { name: sender.name } : {}), ...(sender.title ? { title: sender.title } : {}), project: sender.project },
			...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
		});
		const acked = await this.waitForAck(to, id, this.ackWaitMs).then(() => true, () => false);
		return { status: acked ? "delivered" : "queued", id, to: this.target(to) };
	}

	nextId(): string { return `msg-${++this.ids}`; }

	private sendTo(connection: Connection, frame: Record<string, unknown>): void {
		if (connection.ws.readyState === WebSocket.OPEN) connection.ws.send(JSON.stringify(frame));
	}

	/** The welcomed, open connection of a session. */
	online(id: string): Connection | undefined {
		return this.connections.findLast((connection) => connection.welcomed && !connection.closed && connection.session?.id === id);
	}

	onlineSessions(): OnlineSession[] {
		return this.connections.filter((connection) => connection.welcomed && !connection.closed && connection.session).map((connection) => {
			const session = connection.session!;
			return {
				id: session.id, ...named(connection), host: session.host, cwd: session.cwd, project: session.project, state: session.state,
				...(session.name ? { name: session.name } : {}), ...(session.title ? { title: session.title } : {}), ...(session.model ? { model: session.model } : {}),
				...(session.piVersion ? { piVersion: session.piVersion } : {}),
				connectedAt: new Date(connection.openedAt).toISOString(), stateSince: new Date(connection.openedAt).toISOString(), lastSeenAt: new Date().toISOString(),
				recorded: this.recorded.has(session.id),
			};
		});
	}

	hellos(id?: string): HelloSession[] {
		return this.connections.flatMap((connection) => connection.hello && (!id || connection.hello.id === id) ? [connection.hello] : []);
	}

	/** Frames of one type from every connection of a session, in order. */
	frames(id: string, type?: string): Frame[] {
		return this.connections.filter((connection) => connection.hello?.id === id).flatMap((connection) => connection.frames.filter((frame) => !type || frame.type === type));
	}

	acks(id: string): string[] { return this.frames(id, "ack").map((frame) => String(frame.id)); }

	private message(message: PushedMessage): Frame & { id: string } {
		return {
			type: "message", id: message.id ?? this.nextId(), from: { kind: "session", sessionId: "sender-session", device: "desktop", name: "Sender", project: "elsewhere" },
			text: "hello there", urgent: false, hops: 1, sentAt: new Date().toISOString(), ...message,
		};
	}

	/** Pushes a message to a session's connection and returns its id. */
	push(sessionId: string, message: PushedMessage = {}): string {
		const connection = this.online(sessionId);
		if (!connection) throw new Error(`${sessionId} is not online`);
		const frame = this.message(message);
		this.sendTo(connection, frame);
		return frame.id;
	}

	/** Accepts a message into the mailbox as the server does, pushing it now if the session is online; returns its id. */
	queue(sessionId: string, message: PushedMessage = {}): string {
		const frame = this.message(message);
		this.mailbox.set(frame.id, { sessionId, frame });
		const connection = this.online(sessionId);
		if (connection) this.sendTo(connection, frame);
		return frame.id;
	}

	/** Drops a queued message, as the TTL does. */
	expire(id: string): void { this.mailbox.delete(id); }

	async waitForAck(sessionId: string, id: string, timeoutMs = 5_000): Promise<void> {
		const started = Date.now();
		while (!this.acks(sessionId).includes(id)) {
			if (Date.now() - started > timeoutMs) throw new Error(`no ack for ${id}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	send(sessionId: string, frame: Record<string, unknown>): void {
		const connection = this.online(sessionId);
		if (!connection) throw new Error(`${sessionId} is not online`);
		this.sendTo(connection, frame);
	}

	close(sessionId: string, code: number, reason = ""): void {
		const connection = this.online(sessionId);
		if (!connection) throw new Error(`${sessionId} is not online`);
		connection.ws.close(code, reason);
	}

	/** Drops every connection without a close frame, like a network failure. */
	terminateAll(): void {
		for (const connection of this.connections) if (!connection.closed) connection.ws.terminate();
	}
}
