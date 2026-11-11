import {
	answerHandshake,
	finishNodeHandshake,
	generateIdentity,
	parseChannelBody,
	parseClientMessage,
	parseJson,
	type Body,
	type ClientMessage,
	type Identity,
	type NodeMessage,
	type NodePending,
	type Session,
	type Welcome,
} from "../../src/nodes/contract";
import type { ChannelRoute } from "../../src/nodes/socket";

/** Everything that crossed the server, in order: the bodies the client sent, and closes from either side. */
export type Wire = { from: "client"; body: Body } | { from: "client" | "node"; close: string };

/**
 * An in-memory node built on crypto.ts, the daemon's handshake and records: it answers the handshake, checks its
 * allowlist, sends `welcome`, and hands each inner message to `onMessage`. Frames cross on microtasks, in order,
 * like the server forwards them.
 */
export class FakeNode {
	readonly id: string;
	readonly identity: Identity;
	readonly allowed = new Set<string>();
	readonly wire: Wire[] = [];
	readonly received: ClientMessage[] = [];
	readonly pendingEnrolments: string[] = [];
	onMessage: (message: ClientMessage, node: FakeNode) => void = () => {};
	#session: Session | undefined;
	#pending: NodePending | undefined;
	#route: ChannelRoute | undefined;
	#outbox: Promise<void> = Promise.resolve();

	private constructor(id: string, identity: Identity) {
		this.id = id;
		this.identity = identity;
	}

	static async create(id = "node-1"): Promise<FakeNode> {
		return new FakeNode(id, await generateIdentity({ extractable: true }));
	}

	/** A client-side route for a new channel to this node. */
	route(channel = `ch-${Math.random().toString(36).slice(2, 10)}`): ChannelRoute {
		this.#session = undefined;
		this.#pending = undefined;
		let open = true;
		const route: ChannelRoute = {
			channel,
			node: this.id,
			send: (body) => {
				if (!open) return;
				this.wire.push({ from: "client", body });
				queueMicrotask(() => void this.#receive(channel, body));
			},
			close: (code) => {
				if (!open) return;
				open = false;
				this.wire.push({ from: "client", close: code });
			},
			onFrame: () => {},
			onClose: () => {},
		};
		this.#route = route;
		return route;
	}

	/** Sends a body to the client as the server would forward it. */
	deliver(body: Body): void {
		const route = this.#route!;
		queueMicrotask(() => route.onFrame(body));
	}

	/** Ends the channel from the node's side. */
	closeChannel(code: string): void {
		const route = this.#route!;
		this.wire.push({ from: "node", close: code });
		queueMicrotask(() => route.onClose(code));
	}

	/** One inner message, sealed in order. */
	send(message: NodeMessage): Promise<void> {
		const session = this.#session!;
		const sealed = session.seal(JSON.stringify(message));
		this.#outbox = this.#outbox.then(async () => this.deliver((await sealed) as unknown as Body));
		return this.#outbox;
	}

	welcome(): Welcome {
		return {
			type: "welcome",
			node: this.id,
			name: "node01",
			host: "node01.lan",
			home: "/home/me",
			version: "0.1.0",
			protocolVersion: 1,
			capabilities: ["terminal", "files", "projects", "status"],
			limits: { maxRecordBytes: 1 << 20, maxSnapshotBytes: 512 << 10, maxReadBytes: 512 << 10, maxUploadBytes: 256 << 20, maxUploadChunkBytes: 512 << 10 },
		};
	}

	async #receive(channel: string, raw: Body): Promise<void> {
		const parsed = parseChannelBody(raw);
		if (!parsed.ok) throw new Error(`fake node: bad body ${JSON.stringify(raw)}`);
		const body = parsed.message;
		const ids = { channel, node: this.id };
		if (body.t === "hs1") {
			const { hs2, pending } = await answerHandshake(this.identity, ids, body);
			this.#pending = pending;
			this.deliver(hs2 as unknown as Body);
		} else if (body.t === "hs3") {
			const { session, clientFingerprint } = await finishNodeHandshake(this.#pending!, body);
			if (!this.allowed.has(clientFingerprint)) {
				this.pendingEnrolments.push(clientFingerprint);
				this.deliver({ t: "hs_error", code: "client_not_allowed", fingerprint: clientFingerprint });
				this.closeChannel("client_not_allowed");
				return;
			}
			this.#session = session;
			await this.send(this.welcome());
		} else if (body.t === "rec") {
			const text = await this.#session!.open(body);
			const message = parseClientMessage(parseJson(text));
			if (!message.ok) throw new Error(`fake node: bad inner message ${text}`);
			this.received.push(message.message);
			this.onMessage(message.message, this);
		}
	}
}

/** Lets every queued microtask and WebCrypto call finish. */
export async function settle(rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
