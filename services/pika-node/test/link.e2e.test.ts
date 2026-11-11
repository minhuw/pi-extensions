/**
 * End to end through a fake pika server: an in-process WebSocket server that authenticates the node, assigns
 * channels, and forwards bodies verbatim, as NODE.md §1–2 describe. The daemon runs in this process; the test is
 * the browser: it does the handshake with src/crypto.ts, enrols, and speaks inner messages in records.
 */
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { finishClientHandshake, generateIdentity, startHandshake, type Identity, type Session } from "../src/crypto.ts";
import {
    fromBase64Url, parseNodeMessage, parseNodeToServer, timing, toBase64Url,
    type Body, type Hs2, type Rec, type Snapshot, type TerminalInfo,
} from "../src/protocol.ts";
import { runDaemon, type Running } from "../src/run.ts";
import { allowPending, readPending, removeClient } from "../src/store.ts";
import { Inbox, innerClient, outputAfter, settle, tempHome, until, type InnerClient } from "./support.ts";

const CREDENTIAL = `pkn_${randomBytes(32).toString("base64url")}`;
const NODE_ID = "11111111-2222-3333-4444-555555555555";

/** The routing half of the pika server, for one node. */
class FakeServer {
    wss: WebSocketServer;
    node: WebSocket | undefined;
    hello: Record<string, unknown> | undefined;
    rejected = 0;
    #channels = new Map<string, (frame: Record<string, unknown>) => void>();
    #helloWaiters: (() => void)[] = [];

    constructor() {
        this.wss = new WebSocketServer({
            port: 0,
            path: "/api/node/v1/connect",
            verifyClient: (info, done) => {
                if (info.req.headers.authorization === `Bearer ${CREDENTIAL}`) return done(true);
                this.rejected++;
                done(false, 401, "unauthorized");
            },
        });
        this.wss.on("connection", ws => {
            this.node = ws;
            ws.on("message", data => {
                const parsed = parseNodeToServer(JSON.parse(data.toString()));
                if (!parsed.ok) throw new Error(`node sent a bad frame: ${data}`);
                const frame = parsed.message;
                if (frame.type === "hello") {
                    this.hello = frame as unknown as Record<string, unknown>;
                    ws.send(JSON.stringify({ type: "welcome", node: NODE_ID, nodeName: "test-node", serverVersion: "test", limits: { heartbeatSeconds: 20, maxFrameBytes: 2 << 20, maxChannels: 64 } }));
                    for (const waiter of this.#helloWaiters.splice(0)) waiter();
                } else if (frame.type === "frame" || frame.type === "close") {
                    this.#channels.get(frame.channel)?.(frame as unknown as Record<string, unknown>);
                }
            });
        });
    }

    get url(): string { return `http://127.0.0.1:${(this.wss.address() as AddressInfo).port}`; }

    online(): Promise<void> {
        if (this.hello) return Promise.resolve();
        return new Promise(resolve => this.#helloWaiters.push(resolve));
    }

    /** Opens a channel; frames and closes from the node go to `onFrame`. */
    open(onFrame: (frame: Record<string, unknown>) => void): { channel: string; send: (body: Body) => void } {
        const channel = randomBytes(16).toString("base64url");
        this.#channels.set(channel, onFrame);
        this.node!.send(JSON.stringify({ type: "open", channel, client: { session: "abcdef012345" } }));
        return { channel, send: body => this.node!.send(JSON.stringify({ type: "frame", channel, body })) };
    }

    close(): Promise<void> { return new Promise(resolve => this.wss.close(() => resolve())); }
}

interface BrowserChannel {
    channel: string;
    closed: Promise<{ code: string }>;
    hsError: Promise<{ code: string; fingerprint?: string }>;
    nodeFingerprint: Promise<string>;
    session: Promise<Session>;
    /** The first client-side failure (e.g. `node_key_changed`). */
    failure: Promise<Error>;
    client: InnerClient;
    sendRaw: (body: Body) => void;
}

/** A browser tab's channel: handshake, then records both ways. */
function browserChannel(server: FakeServer, identity: Identity, pinned?: string): BrowserChannel {
    const inbox = new Inbox();
    let resolveClosed!: (value: { code: string }) => void;
    let resolveHsError!: (value: { code: string; fingerprint?: string }) => void;
    let resolveSession!: (session: Session) => void;
    let resolveFingerprint!: (fingerprint: string) => void;
    let resolveFailure!: (error: Error) => void;
    const failure = new Promise<Error>(resolve => { resolveFailure = resolve; });
    const closed = new Promise<{ code: string }>(resolve => { resolveClosed = resolve; });
    const hsError = new Promise<{ code: string; fingerprint?: string }>(resolve => { resolveHsError = resolve; });
    const session = new Promise<Session>(resolve => { resolveSession = resolve; });
    const nodeFingerprint = new Promise<string>(resolve => { resolveFingerprint = resolve; });
    let tail = Promise.resolve();
    let pending: Awaited<ReturnType<typeof startHandshake>>;
    let live: Session | undefined;
    const { channel, send } = server.open(frame => {
        if (frame.type === "close") return resolveClosed({ code: frame.code as string });
        const body = frame.body as Record<string, unknown>;
        tail = tail.then(async () => {
            if (body.t === "hs2") {
                const finished = await finishClientHandshake(pending, body as unknown as Hs2, pinned);
                live = finished.session;
                resolveFingerprint(finished.nodeFingerprint);
                send(finished.hs3 as unknown as Body);
                resolveSession(finished.session);
            } else if (body.t === "hs_error") {
                resolveHsError(body as { code: string; fingerprint?: string });
            } else if (body.t === "rec") {
                const text = await live!.open(body as unknown as Rec);
                const message = JSON.parse(text);
                // Everything the node sends must pass the shared validator.
                const parsed = parseNodeMessage(message);
                if (!parsed.ok) throw new Error(`node sent an invalid ${message.type}: ${text.slice(0, 300)}`);
                inbox.push(message);
            }
        }).catch((error: Error) => resolveFailure(error));
    });
    void startHandshake(identity, { channel, node: NODE_ID }, "vitest browser").then(started => {
        pending = started;
        send(started.hs1 as unknown as Body);
    });
    let sendTail = Promise.resolve();
    const client = innerClient(inbox, message => {
        sendTail = sendTail.then(async () => send((await (await session).seal(JSON.stringify(message))) as unknown as Body));
    }, () => {});
    return { channel, closed, hsError, nodeFingerprint, session, failure, client, sendRaw: send };
}

const home = tempHome();
const server = new FakeServer();
let running: Running;

beforeAll(async () => {
    writeFileSync(home.config, JSON.stringify({ version: 1, server: { url: server.url, credential: CREDENTIAL } }));
    running = (await runDaemon(home))!;
    await server.online();
});

afterAll(async () => {
    await running?.stop("test done");
    await server.close();
    home.cleanup();
});

describe("node link through a forwarding server", () => {
    it("says hello with its key and answers pings", async () => {
        expect(server.hello).toMatchObject({ type: "hello", version: "0.1.0", protocolVersions: [1] });
        expect(fromBase64Url(server.hello!.publicKey as string)).toBeDefined();
        const pong = new Promise<void>(resolve => server.node!.once("message", data => { if (JSON.parse(data.toString()).type === "pong") resolve(); }));
        server.node!.send(JSON.stringify({ type: "ping", at: Date.now() }));
        await pong;
        expect(running.link.state).toMatchObject({ state: "online", node: NODE_ID, nodeName: "test-node" });
    });

    it("enrols a client, then carries terminals end to end, and closes it when its key is removed", async () => {
        const browser = await generateIdentity();
        // 1. Not allowed yet: hs_error with the fingerprint, a pending entry, and the channel closes.
        const first = browserChannel(server, browser);
        const nodeFingerprint = await first.nodeFingerprint;
        expect(await first.hsError).toEqual({ t: "hs_error", code: "client_not_allowed", fingerprint: browser.fingerprint });
        expect((await first.closed).code).toBe("client_not_allowed");
        expect(readPending(home).map(row => row.fingerprint)).toEqual([browser.fingerprint]);
        expect(readPending(home)[0]!.label).toBe("vitest browser");

        // 2. `pika-node clients add <prefix>` moves it into the allowlist; a fresh channel with the pin works.
        expect(() => allowPending(home, browser.fingerprint.slice(0, 19))).toThrow(/at least 20/);
        expect(allowPending(home, browser.fingerprint.slice(0, 32)).fingerprint).toBe(browser.fingerprint);
        const second = browserChannel(server, browser, nodeFingerprint);
        const welcome = await second.client.inbox.waitFor(m => m.type === "welcome");
        expect(welcome).toMatchObject({ node: NODE_ID, name: "test-node", protocolVersion: 1 });

        const { terminal } = await second.client.request<{ terminal: TerminalInfo }>("term.create", { cols: 80, rows: 24, argv: ["bash", "--noprofile", "--norc"] });
        const id = terminal.terminalId;
        const attached = await second.client.request<{ snapshot: Snapshot }>("term.attach", { terminalId: id });
        expect(attached.snapshot.outputSequence).toBeGreaterThanOrEqual(0);
        await settle(second.client.inbox, id);
        second.client.send({ type: "term.input", terminalId: id, data: "echo e2e-$((6*7))\r" });
        await until(() => outputAfter(second.client.inbox, id).includes("e2e-42"), 10_000, "terminal output through the channel");

        // 3. Removing the key closes its channel at once (within the 1 s allowlist poll).
        removeClient(home, browser.fingerprint.slice(0, 24));
        expect((await second.closed).code).toBe("client_removed");
        await running.daemon.handle({ name: "test", closed: false, send: () => {}, buffered: () => 0 }, { type: "term.kill", id: "k", terminalId: id, signal: "SIGKILL" });
    }, 30_000);

    it("closes a channel on a pinned key mismatch, a tampered record, a replay, and a handshake timeout", async () => {
        const browser = await generateIdentity();
        const probe = browserChannel(server, browser);
        await probe.closed;
        allowPending(home, browser.fingerprint);

        // The client refuses a node whose key is not the pinned one (client side check, nothing is sent).
        const wrongPin = browserChannel(server, browser, "0".repeat(64));
        expect(await wrongPin.failure).toMatchObject({ code: "node_key_changed" });

        // A record whose ciphertext was flipped.
        const tampered = browserChannel(server, browser);
        const session = await tampered.session;
        await tampered.client.inbox.waitFor(m => m.type === "welcome");
        const rec = await session.seal(JSON.stringify({ type: "term.list", id: "x" }));
        const bytes = fromBase64Url(rec.ct)!;
        bytes[0]! ^= 1;
        tampered.sendRaw({ ...rec, ct: toBase64Url(bytes) } as unknown as Body);
        expect((await tampered.closed).code).toBe("decrypt_failed");

        // A replayed record.
        const replayed = browserChannel(server, browser);
        const replaySession = await replayed.session;
        await replayed.client.inbox.waitFor(m => m.type === "welcome");
        const once = await replaySession.seal(JSON.stringify({ type: "term.list", id: "y" }));
        replayed.sendRaw(once as unknown as Body);
        await replayed.client.inbox.waitFor(m => m.type === "reply" && m.id === "y");
        replayed.sendRaw(once as unknown as Body);
        expect((await replayed.closed).code).toBe("replay");

        // A client that never finishes the handshake.
        const saved = timing.handshakeTimeoutMs;
        timing.handshakeTimeoutMs = 300;
        try {
            const silent: Record<string, unknown>[] = [];
            const { channel } = server.open(frame => silent.push(frame));
            await until(() => silent.some(frame => frame.type === "close"), 5_000, "handshake timeout");
            expect(silent.find(frame => frame.type === "close")).toMatchObject({ channel, code: "handshake_timeout" });
        } finally { timing.handshakeTimeoutMs = saved; }
        removeClient(home, browser.fingerprint);
    }, 30_000);
});
