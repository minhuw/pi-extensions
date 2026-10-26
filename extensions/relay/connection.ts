import { randomUUID } from "node:crypto";
import {
	CLOSE_REASONS, type HelloSession, type MessageFrame, type SentFrame, type StatusFrame, TERMINAL_CLOSES, timing, type Welcome, wsUrl,
} from "./protocol.ts";

export interface Credentials { url: string; token: string }

/**
 * Where a connection is: `connecting` covers the health check, the upgrade, and the wait for
 * `welcome`; `retrying` waits for the next attempt; `stopped` waits for new credentials or
 * `/relay on`. `unsupported` marks a server without relay.
 */
export type ConnectionState =
	| { kind: "connecting"; reason?: string }
	| { kind: "online"; welcome: Welcome }
	| { kind: "retrying"; reason: string; at: number }
	| { kind: "stopped"; reason: string; unsupported?: boolean }
	| { kind: "closed" };

export interface ConnectionEvents {
	/** The session as `hello` describes it, read at each connect. */
	hello(): HelloSession;
	onMessage(frame: MessageFrame): void;
	onStatus(frame: StatusFrame): void;
	onChange(state: ConnectionState): void;
	/** The server has no relay; called once per connection. */
	onUnsupported?(reason: string): void;
}

interface Pending { resolve(frame: SentFrame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Why a server without relay is unsupported, from its health answer. */
function unsupportedReason(url: string, health: { features?: unknown }): string | undefined {
	if (Array.isArray(health.features)) return health.features.includes("relay") ? undefined : `relay is turned off on the pika server at ${url} (PIKA_RELAY=off)`;
	return `the pika server at ${url} has no relay; relay needs pika 0.3.0 or newer`;
}

/**
 * One session's relay connection to one server: health check, `hello`, liveness, and reconnects
 * with backoff until it is closed. It never throws into its caller.
 */
export class RelayConnection {
	private socket: WebSocket | undefined;
	/** Counts sockets, so events of an abandoned one are ignored. */
	private generation = 0;
	private attempts = 0;
	private onlineSince = 0;
	private liveness: ReturnType<typeof setTimeout> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly pending = new Map<string, Pending>();
	private current: ConnectionState = { kind: "connecting" };

	constructor(readonly credentials: Credentials, private readonly events: ConnectionEvents) {}

	get state(): ConnectionState { return this.current; }
	get online(): boolean { return this.current.kind === "online"; }
	/** A getter, so checks after an await are not narrowed away. */
	private get isClosed(): boolean { return this.current.kind === "closed"; }

	start(): void { void this.attempt(); }

	/** Closes for good; idempotent. */
	close(): void {
		if (this.isClosed) return;
		this.abandon();
		clearTimeout(this.retryTimer);
		this.set({ kind: "closed" });
	}

	/** Sends a frame on an online connection; false when it is not online. */
	send(frame: Record<string, unknown>): boolean {
		if (!this.online || !this.socket) return false;
		try {
			this.socket.send(JSON.stringify(frame));
			return true;
		} catch { return false; }
	}

	/** Sends `send` and waits for its `sent`; rejects when offline, on timeout, or when the connection drops. */
	request(frame: { to: string; text: string; urgent?: boolean; replyTo?: string; hops: number }): Promise<SentFrame> {
		const clientId = randomUUID();
		return new Promise<SentFrame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(clientId);
				reject(new Error(`the server did not answer within ${Math.ceil(timing.sentTimeoutMs / 1000)} s; the message may or may not have been accepted`));
			}, timing.sentTimeoutMs);
			this.pending.set(clientId, { resolve, reject, timer });
			const sent = this.send({
				type: "send", clientId, to: frame.to, text: frame.text, hops: frame.hops,
				...(frame.urgent ? { urgent: true } : {}), ...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
			});
			if (!sent) {
				clearTimeout(timer);
				this.pending.delete(clientId);
				reject(new Error("the relay connection is not online"));
			}
		});
	}

	private set(state: ConnectionState): void {
		this.current = state;
		try { this.events.onChange(state); } catch { /* the listener's own problem */ }
	}

	private async attempt(): Promise<void> {
		if (this.isClosed) return;
		const generation = ++this.generation;
		this.set({ kind: "connecting", reason: this.current.kind === "retrying" ? this.current.reason : undefined });
		const { url, token } = this.credentials;
		let health: { features?: unknown };
		try {
			const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timing.healthTimeoutMs), redirect: "error" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			health = await response.json() as { features?: unknown };
			if (!health || typeof health !== "object") throw new Error("not a JSON object");
		} catch (error) {
			if (generation === this.generation) this.retry(`could not check ${url}/api/health: ${errorText(error)}`);
			return;
		}
		if (generation !== this.generation || this.isClosed) return;
		const unsupported = unsupportedReason(url, health);
		if (unsupported) {
			this.set({ kind: "stopped", reason: unsupported, unsupported: true });
			try { this.events.onUnsupported?.(unsupported); } catch { /* as above */ }
			return;
		}
		let socket: WebSocket;
		try {
			// Node's WebSocket (undici) takes headers in its second argument; the DOM typing does not know them.
			const Socket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
			socket = new Socket(wsUrl(url, "/api/relay/v1/connect"), { headers: { Authorization: `Bearer ${token}` } });
		} catch (error) {
			this.retry(`could not open a WebSocket: ${errorText(error)}`);
			return;
		}
		this.socket = socket;
		this.touch();
		let opened = false;
		const mine = () => generation === this.generation && this.socket === socket;
		socket.onopen = () => {
			if (!mine()) return;
			opened = true;
			this.touch();
			try {
				socket.send(JSON.stringify({ type: "hello", session: this.events.hello() }));
			} catch (error) {
				this.drop(`could not send hello: ${errorText(error)}`);
			}
		};
		socket.onmessage = (event) => { if (mine()) this.receive(event.data); };
		socket.onerror = () => { /* the close event follows */ };
		socket.onclose = (event) => {
			if (!mine()) return;
			this.socket = undefined;
			void this.closed(event.code, event.reason, opened);
		};
	}

	private receive(data: unknown): void {
		this.touch();
		if (typeof data !== "string") return;
		let frame: { type?: unknown; [key: string]: unknown };
		try { frame = JSON.parse(data); } catch { return; }
		if (!frame || typeof frame !== "object") return;
		switch (frame.type) {
			case "welcome":
				this.onlineSince = Date.now();
				this.set({ kind: "online", welcome: frame as unknown as Welcome });
				break;
			case "ping":
				this.send({ type: "pong" });
				break;
			case "message":
				if (typeof frame.id === "string" && typeof frame.text === "string" && frame.from && typeof frame.from === "object") {
					try { this.events.onMessage(frame as unknown as MessageFrame); } catch { /* not acknowledged, so pushed again */ }
				}
				break;
			case "status":
				if (typeof frame.id === "string") {
					try { this.events.onStatus(frame as unknown as StatusFrame); } catch { /* as above */ }
				}
				break;
			case "sent": {
				const pending = typeof frame.clientId === "string" ? this.pending.get(frame.clientId) : undefined;
				if (!pending) break;
				this.pending.delete(frame.clientId as string);
				clearTimeout(pending.timer);
				pending.resolve(frame as unknown as SentFrame);
				break;
			}
		}
	}

	/** Any frame counts as liveness; a connection silent for `deadAfterMs` is dead. */
	private touch(): void {
		clearTimeout(this.liveness);
		this.liveness = setTimeout(() => this.drop(`no frame from the server for ${Math.round(timing.deadAfterMs / 1000)} s`), timing.deadAfterMs);
		this.liveness.unref?.();
	}

	/** Stops listening to the current socket and closes it without waiting for its close handshake. */
	private abandon(): void {
		this.generation++;
		clearTimeout(this.liveness);
		this.liveness = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (socket) {
			socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
			try { socket.close(1000); } catch { /* already closing */ }
		}
		for (const [clientId, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("the relay connection closed before the server answered; the message may or may not have been accepted"));
			this.pending.delete(clientId);
		}
	}

	private drop(reason: string): void {
		if (this.isClosed) return;
		this.abandon();
		this.retry(reason);
	}

	private async closed(code: number, reason: string, opened: boolean): Promise<void> {
		this.abandon();
		const generation = this.generation;
		if (this.isClosed) return;
		const terminal = TERMINAL_CLOSES.get(code);
		if (terminal) {
			this.set({ kind: "stopped", reason: `${terminal} (close code ${code})` });
			return;
		}
		if (!opened) {
			// The upgrade was refused; pi's WebSocket does not say why, so the token is checked over HTTP.
			const problem = await this.probe();
			if (this.isClosed || generation !== this.generation) return;
			if (problem) { this.set({ kind: "stopped", reason: problem }); return; }
			this.retry("the server refused the relay connection");
			return;
		}
		const known = CLOSE_REASONS.get(code);
		this.retry(`${known ?? `the connection closed${reason ? `: ${reason}` : ""}`} (close code ${code})`);
	}

	/** Why a refused upgrade will not succeed later, when the sessions route says so. */
	private async probe(): Promise<string | undefined> {
		try {
			const response = await fetch(`${this.credentials.url}/api/relay/v1/sessions`, {
				headers: { Authorization: `Bearer ${this.credentials.token}` }, signal: AbortSignal.timeout(timing.httpTimeoutMs), redirect: "error",
			});
			await response.body?.cancel().catch(() => {});
			if (response.status === 401) return "the server rejected this device's token (HTTP 401); run /pika login again";
		} catch { /* unreachable: retried */ }
		return undefined;
	}

	private retry(reason: string): void {
		if (this.isClosed) return;
		if (this.onlineSince && Date.now() - this.onlineSince >= timing.stableMs) this.attempts = 0;
		this.onlineSince = 0;
		const base = Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** this.attempts);
		this.attempts++;
		const delay = Math.min(timing.backoffMaxMs, Math.round(base * (1 - timing.jitter + 2 * timing.jitter * Math.random())));
		this.set({ kind: "retrying", reason, at: Date.now() + delay });
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => { void this.attempt(); }, delay);
		this.retryTimer.unref?.();
	}
}
