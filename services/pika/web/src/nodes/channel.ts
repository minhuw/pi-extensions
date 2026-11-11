import {
	ChannelError,
	finishClientHandshake,
	fingerprint,
	fromBase64Url,
	LIMITS,
	parseChannelBody,
	parseJson,
	parseNodeMessage,
	startHandshake,
	timing,
	utf8Length,
	type Body,
	type ChannelBody,
	type ClientPending,
	type Identity,
	type NodeEvent,
	type Notice,
	type ReplyError,
	type Requests,
	type RequestType,
	type Results,
	type Session,
	type Welcome,
} from "./contract";
import type { ChannelRoute } from "./socket";

/**
 * Where a channel stands. Only `ready` (a pinned node key and its `welcome`) lets inner messages out: the others
 * never send anything after the handshake.
 */
export type ChannelState =
	| { kind: "handshaking" }
	/** The node does not allow this client yet; show the enrolment command. */
	| { kind: "enrol"; clientFingerprint: string; nodeFingerprint: string }
	/** The node allows this client, but its key is not pinned: the user must confirm `nodeFingerprint` first. */
	| { kind: "confirm"; nodeFingerprint: string; nodeKey: string; welcome: Welcome }
	| { kind: "ready"; nodeFingerprint: string; welcome: Welcome }
	/** Ended. `node_key_changed` carries both fingerprints. */
	| { kind: "closed"; code: string; reason?: string; nodeFingerprint?: string; pinnedFingerprint?: string };

/** A `reply` with an `error`. */
export class NodeRequestError extends Error {
	readonly code: string;
	constructor(error: ReplyError) {
		super(error.message || error.code);
		this.code = error.code;
	}
}

/** The channel closed before the reply arrived. */
export class ChannelClosed extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`The channel closed: ${code}`);
		this.code = code;
	}
}

export interface ChannelOptions {
	identity: Identity;
	/** The pinned node key's fingerprint; without one the channel can only enrol or ask for confirmation. */
	pinned?: string;
	/** `hs1.label`, e.g. "Firefox 131 on macOS". */
	label?: string;
}

/** The ids of every inner request; unique among the channel's open requests. */
let requestIds = 0;

/**
 * One end-to-end channel to a node (NODE.md §3): the signed handshake over `route`, then AES-256-GCM records carrying
 * the inner messages of §4. Every failure closes the channel with its code; nothing is retried here.
 */
export class NodeChannel {
	readonly route: ChannelRoute;
	#options: ChannelOptions;
	#state: ChannelState = { kind: "handshaking" };
	#pending: ClientPending | undefined;
	#session: Session | undefined;
	#nodeFingerprint: string | undefined;
	#nodeKey: string | undefined;
	#inbox: Promise<void> = Promise.resolve();
	#outbox: Promise<void> = Promise.resolve();
	#requests = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
	#stateListeners = new Set<(state: ChannelState) => void>();
	#eventListeners = new Set<(event: NodeEvent) => void>();
	#handshakeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(route: ChannelRoute, options: ChannelOptions) {
		this.route = route;
		this.#options = options;
		route.onFrame = (body) => {
			this.#inbox = this.#inbox.then(() => this.#receive(body)).catch((error: unknown) => this.#failWith(error));
		};
		// After the frames before it: the node's `hs_error` precedes its close, and must be read first.
		route.onClose = (code, reason) => {
			this.#inbox = this.#inbox.then(() => this.#ended(code, reason));
		};
	}

	get state(): ChannelState {
		return this.#state;
	}

	get node(): string {
		return this.route.node;
	}

	/** Sends `hs1`; the state then follows the node's answers. */
	async start(): Promise<void> {
		this.#handshakeTimer = setTimeout(() => {
			if (this.#state.kind === "handshaking") this.close("handshake_timeout");
		}, timing.handshakeTimeoutMs);
		const pending = await startHandshake(this.#options.identity, { channel: this.route.channel, node: this.route.node }, this.#options.label);
		if (this.#state.kind !== "handshaking") return;
		this.#pending = pending;
		this.route.send(pending.hs1 as unknown as Body);
	}

	onState(listener: (state: ChannelState) => void): () => void {
		this.#stateListeners.add(listener);
		return () => this.#stateListeners.delete(listener);
	}

	onEvent(listener: (event: NodeEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	/** One request and its reply's `result`; rejects with `NodeRequestError` or `ChannelClosed`. */
	request<K extends RequestType>(type: K, params: Requests[K]): Promise<Results[K]> {
		const id = `r${++requestIds}`;
		return new Promise<Results[K]>((resolve, reject) => {
			this.#requests.set(id, { resolve: resolve as (result: unknown) => void, reject });
			this.#seal({ type, id, ...params }).catch((error: unknown) => {
				this.#requests.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}

	/** A message without a reply (`term.input`, `term.resize`, `pane.seen`). */
	notify(notice: Notice): Promise<void> {
		return this.#seal(notice);
	}

	close(code = "closed", reason?: string): void {
		if (this.#state.kind === "closed") return;
		this.route.close(code, reason);
		this.#ended(code, reason);
	}

	/** Never anything but to a pinned, ready node (NODE.md: "A client never sends an inner message to a node it has not pinned"). */
	#seal(message: object): Promise<void> {
		const state = this.#state;
		const session = this.#session;
		if (state.kind !== "ready" || !session) return Promise.reject(new ChannelClosed(state.kind === "closed" ? state.code : "not_ready"));
		const text = JSON.stringify(message);
		if (utf8Length(text) > LIMITS.maxRecordBytes) return Promise.reject(new ChannelError("too_large", "message over the record limit"));
		const sealed = session.seal(text);
		const sent = this.#outbox.then(async () => {
			const rec = await sealed;
			if (this.#state.kind === "ready") this.route.send(rec as unknown as Body);
		});
		this.#outbox = sent.catch((error: unknown) => this.#failWith(error));
		return sent;
	}

	async #receive(raw: Body): Promise<void> {
		if (this.#state.kind === "closed" || this.#state.kind === "enrol") return;
		const parsed = parseChannelBody(raw);
		if (!parsed.ok) {
			if (parsed.reason === "invalid") throw new ChannelError("protocol_error", `invalid ${parsed.type ?? "channel"} body`);
			return;
		}
		const body: ChannelBody = parsed.message;
		switch (body.t) {
			case "hs2":
				return this.#hs2(body);
			case "hs_error":
				return this.#hsError(body.code);
			case "rec":
				return this.#record(body);
			default:
				throw new ChannelError("protocol_error", `unexpected ${body.t} from the node`);
		}
	}

	async #hs2(hs2: Extract<ChannelBody, { t: "hs2" }>): Promise<void> {
		const pending = this.#pending;
		if (!pending || this.#session) throw new ChannelError("protocol_error", "unexpected hs2");
		this.#pending = undefined;
		try {
			const finished = await finishClientHandshake(pending, hs2, this.#options.pinned);
			this.#nodeFingerprint = finished.nodeFingerprint;
			this.#session = finished.session;
			this.#nodeKey = finished.nodeKey;
			// `hs3` is a handshake message, not an inner one: without a pin it goes out only so the node can record
			// this client for enrolment, or show that it is already allowed.
			this.route.send(finished.hs3 as unknown as Body);
		} catch (error) {
			if (error instanceof ChannelError && error.code === "node_key_changed") {
				const spki = fromBase64Url(hs2.nodeKey);
				this.#nodeFingerprint = spki ? await fingerprint(spki) : undefined;
			}
			throw error;
		}
	}

	#hsError(code: string): void {
		if (code === "client_not_allowed" && this.#nodeFingerprint) {
			this.#setState({ kind: "enrol", clientFingerprint: this.#options.identity.fingerprint, nodeFingerprint: this.#nodeFingerprint });
			clearTimeout(this.#handshakeTimer);
			// The node closes the channel itself; enrolment stays the state.
			return;
		}
		this.close(code);
	}

	async #record(rec: Extract<ChannelBody, { t: "rec" }>): Promise<void> {
		const session = this.#session;
		if (!session) throw new ChannelError("protocol_error", "record before the handshake");
		const text = await session.open(rec);
		const parsed = parseNodeMessage(parseJson(text));
		if (!parsed.ok) {
			if (parsed.reason === "invalid") throw new ChannelError("protocol_error", `invalid ${parsed.type ?? "inner"} message from the node`);
			return;
		}
		const message = parsed.message;
		if (this.#state.kind === "handshaking") {
			if (message.type !== "welcome") throw new ChannelError("protocol_error", "the node's first record is not welcome");
			if (message.node !== this.route.node) throw new ChannelError("protocol_error", "welcome names another node");
			clearTimeout(this.#handshakeTimer);
			const nodeFingerprint = this.#nodeFingerprint!;
			if (this.#options.pinned === undefined) this.#setState({ kind: "confirm", nodeFingerprint, nodeKey: this.#nodeKey!, welcome: message });
			else this.#setState({ kind: "ready", nodeFingerprint, welcome: message });
			return;
		}
		// An unpinned channel decrypts nothing more than its welcome, and acts on nothing.
		if (this.#state.kind !== "ready") return;
		if (message.type === "reply") {
			const pending = this.#requests.get(message.id);
			if (!pending) return;
			this.#requests.delete(message.id);
			if (message.error) pending.reject(new NodeRequestError(message.error));
			else pending.resolve(message.result);
			return;
		}
		for (const listener of this.#eventListeners) listener(message);
	}

	#failWith(error: unknown): void {
		if (error instanceof ChannelError) this.close(error.code, error.message.slice(0, 200));
		else {
			console.error("pika nodes: channel failed", error);
			this.close("protocol_error");
		}
	}

	#ended(code: string, reason?: string): void {
		clearTimeout(this.#handshakeTimer);
		if (this.#state.kind === "closed") return;
		this.#session = undefined;
		this.#pending = undefined;
		const requests = [...this.#requests.values()];
		this.#requests.clear();
		for (const request of requests) request.reject(new ChannelClosed(code));
		// Enrolment outlives the node's close of the channel.
		if (this.#state.kind === "enrol") return;
		this.#setState({
			kind: "closed",
			code,
			...(reason ? { reason } : {}),
			...(code === "node_key_changed" ? { nodeFingerprint: this.#nodeFingerprint, pinnedFingerprint: this.#options.pinned } : {}),
		});
	}

	#setState(state: ChannelState): void {
		this.#state = state;
		for (const listener of this.#stateListeners) listener(state);
	}
}
