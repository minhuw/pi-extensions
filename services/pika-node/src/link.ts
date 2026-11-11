/**
 * The node's WebSocket to the pika server (NODE.md §1) and its end-to-end channels (§3). The server only pairs
 * channels and forwards bodies; every channel runs the signed handshake, checks the allowlist, and then carries
 * inner messages as AES-GCM records into the `Daemon`.
 */
import { hostname } from "node:os";
import WebSocket from "ws";
import { answerHandshake, ChannelError, finishNodeHandshake, type Identity, type NodePending, type Session } from "./crypto.ts";
import type { Daemon, Peer } from "./daemon.ts";
import type { Paths } from "./paths.ts";
import { VERSION } from "./paths.ts";
import {
    LIMITS, parseChannelBody, parseJson, parseServerToNode, PROTOCOL_VERSIONS, timing, toBase64Url,
    type Body, type ChannelCloseCode, type NodeMessage, type NodeToServer, type NodeWelcome,
} from "./protocol.ts";
import { addPending, Allowlist, loadConfig, type ServerConfig } from "./store.ts";

const MAX_CHANNELS = 64;
const MAX_BACKOFF_MS = 60_000;

export interface LinkState {
    state: "disabled" | "connecting" | "online" | "offline";
    url?: string;
    node?: string;
    nodeName?: string;
    since: number;
    error?: string;
    channels: number;
}

class Channel implements Peer {
    readonly id: string;
    readonly name: string;
    phase: "hs1" | "hs3" | "open" | "closed" = "hs1";
    pending: NodePending | undefined;
    session: Session | undefined;
    clientFingerprint: string | undefined;
    sealing = 0;
    #tail: Promise<void> = Promise.resolve();
    #link: Link;
    timer: NodeJS.Timeout;

    constructor(link: Link, id: string, onTimeout: () => void) {
        this.#link = link;
        this.id = id;
        this.name = `channel ${id.slice(0, 8)}`;
        this.timer = setTimeout(onTimeout, timing.handshakeTimeoutMs);
    }

    get closed(): boolean { return this.phase === "closed"; }

    /** Runs channel work strictly in frame order. */
    serial(work: () => Promise<void>): void {
        this.#tail = this.#tail.then(work, work);
    }

    send(message: NodeMessage): void {
        if (this.phase !== "open" || !this.session) return;
        const text = JSON.stringify(message);
        this.sealing += text.length;
        this.session.seal(text).then(rec => {
            this.sealing -= text.length;
            if (this.phase === "open") this.#link.sendRaw({ type: "frame", channel: this.id, body: rec as unknown as Body });
        }, (error: unknown) => {
            this.sealing -= text.length;
            this.#link.closeChannel(this, error instanceof ChannelError ? error.code : "protocol_error", (error as Error).message);
        });
    }

    buffered(): number { return this.sealing + this.#link.bufferedAmount; }
}

export class Link {
    #paths: Paths;
    #daemon: Daemon;
    #identity: Identity;
    #allowlist: Allowlist;
    #log: (line: string) => void;
    #ws: WebSocket | undefined;
    #channels = new Map<string, Channel>();
    #welcome: NodeWelcome | undefined;
    #backoff = 1_000;
    #reconnect: NodeJS.Timeout | undefined;
    #dead: NodeJS.Timeout | undefined;
    #allowlistTimer: NodeJS.Timeout;
    #stopped = false;
    state: LinkState = { state: "disabled", since: Date.now(), channels: 0 };
    onState: (state: LinkState) => void = () => {};

    constructor(options: { paths: Paths; daemon: Daemon; identity: Identity; log: (line: string) => void }) {
        this.#paths = options.paths;
        this.#daemon = options.daemon;
        this.#identity = options.identity;
        this.#log = options.log;
        this.#allowlist = new Allowlist(options.paths);
        this.#allowlistTimer = setInterval(() => this.#checkAllowlist(), 1_000);
        this.#allowlistTimer.unref();
    }

    get node(): string | undefined { return this.#welcome?.node; }
    get nodeName(): string | undefined { return this.#welcome?.nodeName; }
    get bufferedAmount(): number { return this.#ws?.bufferedAmount ?? 0; }

    #setState(patch: Omit<LinkState, "since" | "channels">): void {
        this.state = { ...patch, since: Date.now(), channels: this.#channels.size };
        this.onState(this.state);
    }

    /** Connects when `config.json` has a server, and keeps reconnecting with backoff. */
    start(): void {
        if (this.#stopped) return;
        let server: ServerConfig | undefined;
        try { server = loadConfig(this.#paths).server; }
        catch (error) {
            this.#setState({ state: "offline", error: (error as Error).message });
            this.#schedule();
            return;
        }
        if (!server) {
            this.#setState({ state: "disabled" });
            // Check again later, so `pika-node server` takes effect without a restart.
            this.#reconnect = setTimeout(() => this.start(), 5_000);
            this.#reconnect.unref();
            return;
        }
        const url = `${server.url.replace(/^http/, "ws")}/api/node/v1/connect`;
        this.#setState({ state: "connecting", url });
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${server.credential}` }, maxPayload: LIMITS.maxFrameBytes, handshakeTimeout: 10_000 });
        this.#ws = ws;
        ws.on("open", () => {
            this.#alive();
            this.sendRaw({ type: "hello", host: (hostname() || "localhost").slice(0, 255), version: VERSION, protocolVersions: [...PROTOCOL_VERSIONS], publicKey: toBase64Url(this.#identity.spki) });
        });
        ws.on("message", (data, binary) => {
            this.#alive();
            if (binary) return this.#fail(ws, 4400, "binary frame");
            this.#onFrame(data.toString());
        });
        ws.on("unexpected-response", (_request, response) => {
            this.#setState({ state: "offline", url, error: `HTTP ${response.statusCode}` });
            ws.terminate();
        });
        ws.on("error", error => { if (this.state.state !== "offline") this.#setState({ state: "offline", url, error: error.message }); });
        ws.on("close", (code, reason) => {
            if (this.#ws !== ws) return;
            this.#ws = undefined;
            this.#welcome = undefined;
            if (this.#dead) clearTimeout(this.#dead);
            for (const channel of [...this.#channels.values()]) this.#drop(channel);
            const why = code === 4401 ? "credential revoked" : code === 4410 ? "replaced by a newer connection for this node" : `closed ${code}${reason.length ? ` ${reason}` : ""}`;
            this.#log(`server link: ${why}`);
            if (this.state.state !== "offline" || !this.state.error) this.#setState({ state: "offline", url, error: why });
            if (code === 4401 || code === 4410) this.#backoff = MAX_BACKOFF_MS;
            this.#schedule();
        });
    }

    #schedule(): void {
        if (this.#stopped) return;
        const delay = this.#backoff;
        this.#backoff = Math.min(MAX_BACKOFF_MS, this.#backoff * 2);
        this.#reconnect = setTimeout(() => this.start(), delay);
        this.#reconnect.unref();
    }

    #alive(): void {
        if (this.#dead) clearTimeout(this.#dead);
        const ws = this.#ws;
        this.#dead = setTimeout(() => { if (ws) { this.#log("server link silent; reconnecting"); ws.terminate(); } }, timing.deadAfterMs);
        this.#dead.unref();
    }

    #fail(ws: WebSocket, code: number, reason: string): void {
        this.#log(`server link: ${reason}`);
        ws.close(code, reason);
    }

    sendRaw(frame: NodeToServer): void {
        const ws = this.#ws;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    }

    #onFrame(text: string): void {
        const ws = this.#ws!;
        const parsed = parseServerToNode(parseJson(text));
        if (!parsed.ok) {
            if (parsed.reason === "invalid") this.#log(`server link: invalid ${parsed.type} frame ignored`);
            return;
        }
        const frame = parsed.message;
        switch (frame.type) {
            case "welcome":
                this.#welcome = frame;
                this.#backoff = 1_000;
                this.#log(`server link: online as node ${frame.node} (${frame.nodeName})`);
                this.#setState({ state: "online", url: this.state.url, node: frame.node, nodeName: frame.nodeName });
                return;
            case "ping": return this.sendRaw({ type: "pong" });
            case "open": {
                if (!this.#welcome) return this.#fail(ws, 4400, "open before welcome");
                if (this.#channels.has(frame.channel)) return;
                if (this.#channels.size >= MAX_CHANNELS) return this.sendRaw({ type: "close", channel: frame.channel, code: "too_many_channels" });
                const channel: Channel = new Channel(this, frame.channel, () => this.closeChannel(channel, "handshake_timeout"));
                this.#channels.set(frame.channel, channel);
                this.state = { ...this.state, channels: this.#channels.size };
                return;
            }
            case "close": {
                const channel = this.#channels.get(frame.channel);
                if (channel) this.#drop(channel);
                return;
            }
            case "frame": {
                const channel = this.#channels.get(frame.channel);
                if (!channel) return;
                channel.serial(() => this.#onBody(channel, frame.body));
                return;
            }
        }
    }

    async #onBody(channel: Channel, body: Body): Promise<void> {
        if (channel.closed) return;
        const parsed = parseChannelBody(body);
        if (!parsed.ok) {
            if (parsed.reason === "invalid") this.closeChannel(channel, "protocol_error", `invalid ${parsed.type}`);
            return;
        }
        const message = parsed.message;
        const ids = { channel: channel.id, node: this.#welcome!.node };
        try {
            if (channel.phase === "hs1" && message.t === "hs1") {
                const { hs2, pending } = await answerHandshake(this.#identity, ids, message);
                channel.pending = pending;
                channel.phase = "hs3";
                this.sendRaw({ type: "frame", channel: channel.id, body: hs2 as unknown as Body });
            } else if (channel.phase === "hs3" && message.t === "hs3") {
                const { session, clientFingerprint } = await finishNodeHandshake(channel.pending!, message);
                this.#reloadAllowlist();
                if (!this.#allowlist.has(clientFingerprint)) {
                    const pending = channel.pending!;
                    addPending(this.#paths, { fingerprint: clientFingerprint, publicKey: toBase64Url(pending.clientSpki), label: pending.label, at: Date.now() });
                    this.#log(`${channel.name}: client ${clientFingerprint.slice(0, 32)} (${pending.label || "no label"}) is not allowed; recorded as pending`);
                    this.sendRaw({ type: "frame", channel: channel.id, body: { t: "hs_error", code: "client_not_allowed", fingerprint: clientFingerprint } });
                    this.closeChannel(channel, "client_not_allowed");
                    return;
                }
                clearTimeout(channel.timer);
                channel.pending = undefined;
                channel.session = session;
                channel.clientFingerprint = clientFingerprint;
                channel.phase = "open";
                this.#log(`${channel.name}: open for client ${clientFingerprint.slice(0, 32)}`);
                this.#daemon.addPeer(channel);
            } else if (channel.phase === "open" && message.t === "rec") {
                const text = await channel.session!.open(message);
                if (!channel.closed) this.#daemon.handle(channel, parseJson(text));
            } else {
                this.closeChannel(channel, "protocol_error", `unexpected ${message.t} during ${channel.phase}`);
            }
        } catch (error) {
            if (error instanceof ChannelError) {
                if (channel.phase !== "open") this.sendRaw({ type: "frame", channel: channel.id, body: { t: "hs_error", code: error.code } });
                this.closeChannel(channel, error.code, error.message);
            } else {
                this.#log(`${channel.name}: ${(error as Error).stack ?? error}`);
                this.closeChannel(channel, "protocol_error");
            }
        }
    }

    #reloadAllowlist(): boolean {
        const changed = this.#allowlist.reload();
        if (changed && this.#allowlist.error) this.#log(`allowlist unreadable, denying every client: ${this.#allowlist.error}`);
        return changed;
    }

    /** Removing a key closes that key's open channels at once. */
    #checkAllowlist(): void {
        if (!this.#reloadAllowlist()) return;
        for (const channel of [...this.#channels.values()]) {
            if (channel.phase === "open" && !this.#allowlist.has(channel.clientFingerprint!)) this.closeChannel(channel, "client_removed");
        }
    }

    /** Ends a channel from this side and tells the server. */
    closeChannel(channel: Channel, code: ChannelCloseCode, reason?: string): void {
        if (channel.closed) return;
        if (code !== "closed") this.#log(`${channel.name}: closing with ${code}${reason ? ` (${reason})` : ""}`);
        // `reason` must be nonblank single-line text of at most 200 characters, or absent.
        const text = reason?.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 200);
        this.sendRaw({ type: "close", channel: channel.id, code, ...(text ? { reason: text } : {}) });
        this.#drop(channel);
    }

    /** Forgets a channel and its key material. */
    #drop(channel: Channel): void {
        if (channel.closed) return;
        channel.phase = "closed";
        clearTimeout(channel.timer);
        channel.pending = undefined;
        channel.session = undefined;
        this.#channels.delete(channel.id);
        this.state = { ...this.state, channels: this.#channels.size };
        this.#daemon.removePeer(channel);
    }

    stop(): void {
        this.#stopped = true;
        clearInterval(this.#allowlistTimer);
        if (this.#reconnect) clearTimeout(this.#reconnect);
        if (this.#dead) clearTimeout(this.#dead);
        for (const channel of [...this.#channels.values()]) this.closeChannel(channel, "closed");
        this.#ws?.close(1001, "node shutting down");
    }
}
