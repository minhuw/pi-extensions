/** Test helpers: temporary node homes, an inner-protocol client over the daemon socket, and a headless screen. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, type Paths } from "../src/paths.ts";
import { encodeLine, LineDecoder, PROTOCOL_VERSION, sanitize, type NodeMessage, type Snapshot } from "../src/protocol.ts";
import { applyWidths } from "../src/widths.ts";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const BIN = join(ROOT, "bin", "pika-node");

/** A short temporary home (unix socket paths are limited to ~104 bytes on macOS). */
export function tempHome(): Paths & { cleanup: () => void } {
    const base = realpathSync(process.platform === "darwin" ? "/tmp" : tmpdir());
    const home = mkdtempSync(join(base, "pn-"));
    return { ...paths(home), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function cli(p: Paths, args: string[], options: { input?: string; env?: Record<string, string> } = {}): string {
    return execFileSync(BIN, args, { env: { ...process.env, PIKA_NODE_HOME: p.home, ...options.env }, input: options.input, encoding: "utf8", timeout: 30_000 });
}

type Message = NodeMessage & Record<string, unknown>;

/** Collects messages and resolves waiters; shared by the socket client and the E2E test client. */
export class Inbox {
    messages: Message[] = [];
    #waiters: { match: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
    #next = 0;

    push(message: Message): void {
        this.messages.push(message);
        for (const waiter of [...this.#waiters]) {
            if (waiter.match(message)) {
                this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
                waiter.resolve(message);
            }
        }
    }

    /** The first message (already received or future) that matches. */
    waitFor(match: (message: Message) => boolean, timeoutMs = 10_000, label = "message"): Promise<Message> {
        const found = this.messages.find(match);
        if (found) return Promise.resolve(found);
        return this.next(match, timeoutMs, label);
    }

    /** The next future message that matches. */
    next(match: (message: Message) => boolean, timeoutMs = 10_000, label = "message"): Promise<Message> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#waiters = this.#waiters.filter(waiter => waiter.resolve !== done);
                reject(new Error(`timed out waiting for ${label}; last messages: ${JSON.stringify(this.messages.slice(-5)).slice(0, 2_000)}`));
            }, timeoutMs);
            const done = (message: Message) => { clearTimeout(timer); resolve(message); };
            this.#waiters.push({ match, resolve: done });
        });
    }

    newId(): string { return `r${++this.#next}`; }
}

export interface InnerClient {
    inbox: Inbox;
    send(message: object): void;
    request<T = Record<string, unknown>>(type: string, params?: object): Promise<T>;
    requestError(type: string, params?: object): Promise<{ code: string; message: string }>;
    close(): void;
}

export function innerClient(inbox: Inbox, send: (message: object) => void, close: () => void): InnerClient {
    const call = async (type: string, params: object = {}) => {
        const id = inbox.newId();
        send({ type, id, ...params });
        return inbox.waitFor(message => message.type === "reply" && message.id === id, 15_000, `reply to ${type}`) as Promise<Message & { result?: unknown; error?: { code: string; message: string } }>;
    };
    return {
        inbox,
        send,
        close,
        async request<T>(type: string, params?: object) {
            const reply = await call(type, params);
            if (reply.error) throw new Error(`${type} failed: ${reply.error.code}: ${reply.error.message}`);
            return reply.result as T;
        },
        async requestError(type: string, params?: object) {
            const reply = await call(type, params);
            if (!reply.error) throw new Error(`${type} unexpectedly succeeded`);
            return reply.error;
        },
    };
}

/** `role: "client"` on the daemon socket: what `pika-node attach` does. */
export async function socketClient(p: Paths): Promise<InnerClient & { socket: Socket }> {
    const socket = connect(p.socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const inbox = new Inbox();
    const decoder = new LineDecoder();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { for (const line of decoder.push(chunk)) inbox.push(JSON.parse(line)); });
    socket.write(encodeLine({ type: "hello", role: "client", version: "test", protocolVersion: PROTOCOL_VERSION }));
    await inbox.waitFor(message => message.type === "welcome");
    return { ...innerClient(inbox, message => socket.write(encodeLine(message)), () => socket.destroy()), socket };
}

/** A client-side screen: a snapshot, then `term.output` from `outputSequence + 1`, as the web UI does. */
export class Screen {
    terminal: InstanceType<typeof Terminal>;
    seq: number;
    constructor(snapshot: Snapshot) {
        this.terminal = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 1_000, allowProposedApi: true });
        applyWidths(this.terminal);
        this.terminal.write(snapshot.data);
        this.seq = snapshot.outputSequence;
    }
    apply(messages: Message[], terminalId: string): void {
        for (const message of messages) {
            if (message.type !== "term.output" || message.terminalId !== terminalId) continue;
            const seq = message.seq as number;
            if (seq <= this.seq) continue;
            if (seq !== this.seq + 1) throw new Error(`gap: ${this.seq} → ${seq}`);
            this.terminal.write(message.data as string);
            this.seq = seq;
        }
    }
    /** The visible rows, trailing spaces trimmed. */
    async text(): Promise<string> {
        await new Promise<void>(resolve => this.terminal.write("", resolve));
        const buffer = this.terminal.buffer.active;
        const rows: string[] = [];
        for (let y = 0; y < this.terminal.rows; y++) rows.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "");
        return rows.join("\n").replace(/\n+$/, "");
    }
    dispose(): void { this.terminal.dispose(); }
}

/** All `term.output` data of a terminal after `after`, in seq order. */
export const outputAfter = (inbox: Inbox, terminalId: string, after = 0): string => inbox.messages
    .filter(message => message.type === "term.output" && message.terminalId === terminalId && (message.seq as number) > after)
    .map(message => message.data as string).join("");

export const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = "condition"): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!await check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 25));
    }
};

/** Whether an attach reply's snapshot shows any text: a prompt printed before the attach is there, not in `term.output`. */
const snapshotShows = (message: Message, terminalId: string): boolean => {
    const result = message.type === "reply" ? message.result as { terminal?: { terminalId?: string }; snapshot?: { data?: string } } | undefined : undefined;
    return result?.terminal?.terminalId === terminalId && sanitize(result.snapshot?.data).trim() !== "";
};

/**
 * Waits until a terminal printed something and then stayed quiet for `quietMs` (a shell is at its prompt). What it
 * printed may be in an attach snapshot already in the inbox, and then no `term.output` need follow.
 */
export async function settle(inbox: Inbox, terminalId: string, quietMs = 700, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const count = () => inbox.messages.filter(message => (message.type === "term.output" && message.terminalId === terminalId) || snapshotShows(message, terminalId)).length;
    let seen = count();
    let quietSince = Date.now();
    while (seen === 0 || Date.now() - quietSince < quietMs) {
        if (Date.now() > deadline) throw new Error(`terminal ${terminalId} did not settle`);
        await new Promise(resolve => setTimeout(resolve, 50));
        const now = count();
        if (now !== seen) { seen = now; quietSince = Date.now(); }
    }
}
