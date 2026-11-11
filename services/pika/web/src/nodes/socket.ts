import { parseJson, parseServerToClient, timing, type Body, type ClientToServer, type NodeInfo } from "./contract";

/** The part of a browser `WebSocket` the node socket uses; tests pass an in-memory one. */
export interface WebSocketLike {
	readonly readyState: number;
	send(text: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
}

const OPEN = 1;

/** The server side of one channel, as the client sees it: frames go out, and frames and the close come in. */
export interface ChannelRoute {
	readonly channel: string;
	readonly node: string;
	send(body: Body): void;
	close(code: string, reason?: string): void;
	/** Set by the channel's owner. */
	onFrame: (body: Body) => void;
	/** The channel ended: the peer's or the server's close code, or `disconnected` when the browser socket went away. */
	onClose: (code: string, reason?: string) => void;
}

/** `refused` from the server, or the socket going away before `opened`. */
export class OpenRefused extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`The server refused the channel: ${code}`);
		this.code = code;
	}
}

export type SocketStatus = "connecting" | "open" | "closed";

export interface NodeSocketOptions {
	create?: (url: string) => WebSocketLike;
	/** Reconnect backoff, in ms, by attempt; the last repeats. */
	backoffMs?: readonly number[];
}

const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * The browser socket of NODE.md §2: node presence, and channels the server pairs with nodes. It answers `ping`, closes
 * itself after 45 s without a frame, and reconnects with backoff until `dispose`. Channels never survive a reconnect:
 * each closes with `disconnected`, and its owner opens a new one.
 */
export class NodeSocket {
	readonly url: string;
	#create: (url: string) => WebSocketLike;
	#backoff: readonly number[];
	#ws: WebSocketLike | undefined;
	#status: SocketStatus = "connecting";
	#nodes: NodeInfo[] = [];
	#listeners = new Set<() => void>();
	#opening = new Map<string, { resolve: (route: ChannelRoute) => void; reject: (error: Error) => void }>();
	#routes = new Map<string, ChannelRoute>();
	#refs = 0;
	#attempt = 0;
	#deadTimer: ReturnType<typeof setTimeout> | undefined;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;
	/** Why the last socket closed, for display. */
	lastClose: { code: number; reason: string } | undefined;

	constructor(url: string, options: NodeSocketOptions = {}) {
		this.url = url;
		this.#create = options.create ?? ((target) => new WebSocket(target));
		this.#backoff = options.backoffMs ?? BACKOFF_MS;
		this.#connect();
	}

	get status(): SocketStatus {
		return this.#status;
	}

	get nodes(): readonly NodeInfo[] {
		return this.#nodes;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Asks the server for a channel to `node`; rejects with `OpenRefused`. */
	open(node: string): Promise<ChannelRoute> {
		const ws = this.#ws;
		if (!ws || ws.readyState !== OPEN || this.#status !== "open") return Promise.reject(new OpenRefused("disconnected"));
		const ref = `open-${++this.#refs}`;
		return new Promise((resolve, reject) => {
			this.#opening.set(ref, { resolve, reject });
			this.#send({ type: "open", ref, node });
		});
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#retryTimer);
		this.#teardown("disconnected");
		this.#ws?.close(1000, "page closed");
		this.#ws = undefined;
		this.#setStatus("closed");
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}

	#setStatus(status: SocketStatus): void {
		if (this.#status === status) return;
		this.#status = status;
		this.#emit();
	}

	#send(frame: ClientToServer): void {
		this.#ws?.send(JSON.stringify(frame));
	}

	#connect(): void {
		if (this.#disposed) return;
		this.#setStatus("connecting");
		const ws = this.#create(this.url);
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#attempt = 0;
			this.#alive();
		};
		ws.onmessage = (event) => {
			if (this.#ws !== ws) return;
			this.#alive();
			this.#receive(typeof event.data === "string" ? event.data : "");
		};
		ws.onclose = (event) => {
			if (this.#ws !== ws) return;
			this.lastClose = { code: event.code, reason: event.reason };
			this.#lost();
		};
		ws.onerror = () => {};
	}

	/** Any frame counts as liveness; 45 s of silence closes the socket. */
	#alive(): void {
		clearTimeout(this.#deadTimer);
		this.#deadTimer = setTimeout(() => {
			this.lastClose = { code: 1001, reason: "no frame from the server in 45 s" };
			this.#ws?.close(1000, "silent");
			this.#lost();
		}, timing.deadAfterMs);
	}

	#lost(): void {
		clearTimeout(this.#deadTimer);
		this.#ws = undefined;
		this.#teardown("disconnected");
		this.#setStatus("closed");
		if (this.#disposed) return;
		const delay = this.#backoff[Math.min(this.#attempt++, this.#backoff.length - 1)]!;
		this.#retryTimer = setTimeout(() => this.#connect(), delay);
	}

	#teardown(code: string): void {
		clearTimeout(this.#deadTimer);
		const opening = [...this.#opening.values()];
		this.#opening.clear();
		for (const pending of opening) pending.reject(new OpenRefused(code));
		const routes = [...this.#routes.values()];
		this.#routes.clear();
		for (const route of routes) route.onClose(code);
	}

	#receive(text: string): void {
		const parsed = parseServerToClient(parseJson(text));
		if (!parsed.ok) {
			// Unknown types are ignored by contract; an invalid known one is the server's bug, shown loudly.
			if (parsed.reason === "invalid") console.error("pika nodes: invalid frame from the server", parsed.type);
			return;
		}
		const frame = parsed.message;
		switch (frame.type) {
			case "welcome":
				this.#setStatus("open");
				return;
			case "nodes":
				this.#nodes = frame.items;
				this.#emit();
				return;
			case "ping":
				this.#send({ type: "pong" });
				return;
			case "opened": {
				const pending = this.#opening.get(frame.ref);
				if (!pending) return;
				this.#opening.delete(frame.ref);
				pending.resolve(this.#route(frame.channel, frame.node));
				return;
			}
			case "refused": {
				const pending = this.#opening.get(frame.ref);
				if (!pending) return;
				this.#opening.delete(frame.ref);
				pending.reject(new OpenRefused(frame.code));
				return;
			}
			case "frame":
				this.#routes.get(frame.channel)?.onFrame(frame.body);
				return;
			case "close": {
				const route = this.#routes.get(frame.channel);
				if (!route) return;
				this.#routes.delete(frame.channel);
				route.onClose(frame.code, frame.reason);
				return;
			}
		}
	}

	#route(channel: string, node: string): ChannelRoute {
		const route: ChannelRoute = {
			channel,
			node,
			send: (body) => {
				if (this.#routes.get(channel) === route) this.#send({ type: "frame", channel, body });
			},
			close: (code, reason) => {
				if (this.#routes.get(channel) !== route) return;
				this.#routes.delete(channel);
				this.#send({ type: "close", channel, code, ...(reason ? { reason } : {}) });
			},
			onFrame: () => {},
			onClose: () => {},
		};
		this.#routes.set(channel, route);
		return route;
	}
}

/** `ws(s)://host{base}/api/v1/node/connect` for the page's location. */
export function nodeSocketUrl(path: string, location: Location = window.location): string {
	const url = new URL(path, location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}
