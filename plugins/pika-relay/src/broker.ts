/**
 * The per-user pika relay broker for Codex: one detached process that keeps one relay connection
 * per Codex thread, persists received messages to each thread's inbox, and answers the plugin's
 * MCP servers and hooks on a Unix socket. Hooks and MCP servers start it when it is not running;
 * it exits after `PIKA_RELAY_BROKER_IDLE_MS` (10 minutes) without threads or clients.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir, hostname } from "node:os";
import { basename } from "node:path";
import { isExcluded, loadConfig, type PikaConfig } from "../../../extensions/pika/config.ts";
import { type ConnectionState, RelayConnection, RequestError } from "../../../extensions/pika/relay/connection.ts";
import {
    cut, expiredContent, headerField, type HelloSession, type MessageFrame, messageContent, type OnlineSession, type RelayRoom, type RelayRoomDetail,
    RELAY_VERSION, type SentFrame, type SessionState, since, type StatusFrame, targetLabel, UNANSWERED,
} from "../../../extensions/pika/relay/protocol.ts";
import { resolveRepository } from "../../../extensions/pika/repository.ts";
import { preview, REJECTIONS, roomLine, roomMessageLine, sendResult, sessionLine } from "./format.ts";
import { readLines, writeLine } from "./ipc.ts";
import { agentDir, inboxPath, pendingPath, pidPath, socketPath, stateDir } from "./paths.ts";
import { ANSWER_HINT, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "./tools.ts";

const SENT_KEPT = 200;
const SENT_SHOWN = 50;
const SEEN_KEPT = 2_000;
/** A thread whose MCP server went away stays online while a hook touched it this recently. */
const HOOK_GRACE_MS = Number(process.env.PIKA_RELAY_HOOK_GRACE_MS) > 0 ? Number(process.env.PIKA_RELAY_HOOK_GRACE_MS) : 2 * 60_000;
/** A thread with no hook or tool call for this long goes offline. */
const STALE_MS = 24 * 60 * 60_000;
/** How long a tool call waits for a thread's first connection to come online. */
const CONNECT_WAIT_MS = 5_000;
const IDLE_EXIT_MS = Number(process.env.PIKA_RELAY_BROKER_IDLE_MS) > 0 ? Number(process.env.PIKA_RELAY_BROKER_IDLE_MS) : 10 * 60_000;
const SEPARATOR = "\n\n---\n\n";

type SentStatus = "queued" | "delivered" | "expired" | "rejected" | "failed" | "unknown";
interface SentRecord { id?: string; to: string; label: string; status: SentStatus; reason?: string; at: number; text: string }

/** One inbox line: a message as received, or a delivery notice. */
type InboxEntry = { kind: "message"; id: string; hops: number; frame: MessageFrame } | { kind: "notice"; id: string; text: string };

interface Waiter { resolve(text: string): void }

interface Client { socket: Socket; threads: Set<Thread>; inflight: Map<number, AbortController> }

interface Thread {
    id: string;
    /** Unknown until a hook names it; the home directory stands in. */
    cwd?: string;
    model?: string;
    title?: string;
    state: SessionState;
    /** The highest hop count of a message this run handled; a genuine user prompt resets it. */
    hops: number;
    /** The prompt the last blocking Stop hook made Codex continue with. */
    continuation?: string;
    hookAt: number;
    activeAt: number;
    clients: Set<Client>;
    /** Set when its last MCP server closed; the sweep takes it offline once the hook grace ends. */
    orphaned?: boolean;
    connection?: RelayConnection;
    /** The cwd the current connection's hello registered. */
    connectedCwd?: string;
    reported: Partial<Pick<HelloSession, "state" | "name" | "title" | "model">>;
    project?: { cwd: string; name?: string; pending: Promise<void> };
    waiters: Set<Waiter>;
    sent: SentRecord[];
    notified: Set<string>;
    seen: Set<string>;
    limits: { ttlSeconds: number; maxTextBytes: number };
}

type HookEvent = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "SessionEnd";
interface HookInput { session_id?: unknown; cwd?: unknown; model?: unknown; prompt?: unknown }
type HookOutput =
    | { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    | { decision: "block"; reason: string }
    | Record<string, never>;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const text = (value: unknown, max: number): string | undefined => typeof value === "string" && value.trim() ? cut(value, max) : undefined;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

const relayName = (id: string) => `codex-${id.slice(0, 8)}`;

class Broker {
    readonly threads = new Map<string, Thread>();
    readonly clients = new Set<Client>();
    private idleSince = Date.now();
    private stopping = false;

    constructor(readonly dir: string, readonly onExit: () => void) {
        mkdirSync(`${dir}/inbox`, { recursive: true, mode: 0o700 });
        mkdirSync(`${dir}/pending`, { recursive: true, mode: 0o700 });
        const sweep = setInterval(() => this.sweep(), Math.min(60_000, Math.max(250, Math.floor(IDLE_EXIT_MS / 4))));
        sweep.unref();
    }

    // ---- config and connections ----

    private config(): { config?: PikaConfig; reason?: string } {
        const result = loadConfig(agentDir());
        return result.enabled ? { config: result.config } : { reason: `pika is not configured or is disabled: ${result.reason}` };
    }

    private cwdOf(thread: Thread): string { return thread.cwd ?? homedir(); }

    /** Why a thread must stay offline, or its config when it may connect. */
    private blocked(thread: Thread): { config?: PikaConfig; reason?: string } {
        const { config, reason } = this.config();
        if (!config) return { reason };
        const cwd = this.cwdOf(thread);
        if (isExcluded(cwd, config.exclude)) return { reason: `${cwd} is excluded by pika's exclude list` };
        return { config };
    }

    offlineReason(thread: Thread): string | undefined {
        const { reason } = this.blocked(thread);
        if (reason) return reason;
        const state = thread.connection?.state;
        if (!state || state.kind === "closed") return "it is not connected";
        if (state.kind === "connecting") return state.reason ? `it is reconnecting after: ${state.reason}` : "it is still connecting";
        if (state.kind === "retrying") return `${state.reason}; it retries in ${Math.max(0, Math.ceil((state.at - Date.now()) / 1000))} s`;
        if (state.kind === "stopped") return `${state.reason}; it reconnects when pika's credentials change`;
        return undefined;
    }

    /** Connects, reconnects (new credentials or cwd), or disconnects a thread as its conditions say. */
    private evaluate(thread: Thread): void {
        const { config } = this.blocked(thread);
        if (!config) { this.disconnect(thread); return; }
        const current = thread.connection;
        const cwd = this.cwdOf(thread);
        if (current && current.credentials.url === config.url && current.credentials.token === config.token && thread.connectedCwd === cwd) return;
        this.disconnect(thread);
        thread.connectedCwd = cwd;
        const connection: RelayConnection = new RelayConnection({ url: config.url, token: config.token }, {
            prepare: () => this.prepare(thread),
            hello: () => this.hello(thread),
            onMessage: (frame) => { if (thread.connection === connection) this.receive(thread, connection, frame); },
            onStatus: (frame) => { if (thread.connection === connection) this.status(thread, frame); },
            onChange: (state) => { if (thread.connection === connection) this.onChange(thread, state); },
            onUnsupported: (reason) => log(`thread ${thread.id}: ${reason}`),
        });
        thread.connection = connection;
        connection.start();
    }

    private disconnect(thread: Thread): void {
        thread.connection?.close();
        thread.connection = undefined;
        thread.connectedCwd = undefined;
    }

    private describe(thread: Thread): Partial<HelloSession> & { state: SessionState; name: string } {
        const cwd = this.cwdOf(thread);
        const title = thread.title || basename(cwd) || cwd;
        return {
            state: thread.state, name: relayName(thread.id),
            ...(title ? { title: cut(title, 200) } : {}),
            ...(thread.model ? { model: cut(thread.model, 200) } : {}),
        };
    }

    /** Asks git once per cwd for the repository name, as Pi's relay asks pika's registry. */
    private prepare(thread: Thread): Promise<void> {
        const cwd = this.cwdOf(thread);
        if (thread.project?.cwd !== cwd) {
            const entry: NonNullable<Thread["project"]> = { cwd, pending: Promise.resolve() };
            entry.pending = resolveRepository(cwd).then((info) => {
                if (typeof info.project === "string" && info.project.trim()) entry.name = info.project;
            }, () => undefined);
            thread.project = entry;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, 3_000); timer.unref?.(); });
        return Promise.race([thread.project.pending, timeout]).finally(() => clearTimeout(timer));
    }

    private hello(thread: Thread): HelloSession {
        const cwd = this.cwdOf(thread);
        const info = this.describe(thread);
        thread.reported = info;
        const project = (thread.project?.cwd === cwd ? thread.project.name : undefined) || basename(cwd) || cwd;
        return { id: thread.id, ...info, cwd: cut(cwd, 1024)!, project: cut(project, 255)!, host: cut(hostname(), 255)!, relayVersion: RELAY_VERSION };
    }

    private pushState(thread: Thread): void {
        const connection = thread.connection;
        if (!connection?.online) return;
        const now = this.describe(thread);
        const changes: Record<string, string> = {};
        for (const key of ["state", "name", "title", "model"] as const) {
            const value = now[key];
            if (value !== undefined && value !== thread.reported[key]) changes[key] = value;
        }
        if (!Object.keys(changes).length) return;
        if (connection.send({ type: "state", ...changes })) thread.reported = { ...thread.reported, ...changes };
    }

    private setState(thread: Thread, state: SessionState): void {
        thread.state = state;
        this.pushState(thread);
    }

    private onChange(thread: Thread, state: ConnectionState): void {
        if (state.kind === "stopped") log(`thread ${thread.id}: stopped: ${state.reason}`);
        if (state.kind !== "online") return;
        const limits = state.welcome.limits;
        if (Number.isFinite(limits?.ttlSeconds) && limits.ttlSeconds > 0) thread.limits.ttlSeconds = limits.ttlSeconds;
        if (Number.isFinite(limits?.maxTextBytes) && limits.maxTextBytes > 0) thread.limits.maxTextBytes = limits.maxTextBytes;
        // The state may have changed between hello and welcome.
        this.pushState(thread);
    }

    // ---- inbox ----

    private append(thread: Thread, entry: InboxEntry): void {
        appendFileSync(inboxPath(this.dir, thread.id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        writeFileSync(pendingPath(this.dir, thread.id), "", { mode: 0o600 });
    }

    private readInbox(thread: Thread): InboxEntry[] {
        let raw: string;
        try { raw = readFileSync(inboxPath(this.dir, thread.id), "utf8"); } catch { return []; }
        const entries: InboxEntry[] = [];
        for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            try { entries.push(JSON.parse(line) as InboxEntry); } catch { /* a torn line */ }
        }
        return entries;
    }

    /** Takes every waiting entry, as the text the model reads, and raises the thread's hops to theirs. */
    drain(thread: Thread): string[] {
        const entries = this.readInbox(thread);
        rmSync(inboxPath(this.dir, thread.id), { force: true });
        rmSync(pendingPath(this.dir, thread.id), { force: true });
        const texts: string[] = [];
        for (const entry of entries) {
            if (entry.kind === "message") {
                thread.hops = Math.max(thread.hops, entry.hops);
                texts.push(messageContent({ ...entry.frame, hops: entry.hops }));
            } else if (entry.kind === "notice") texts.push(entry.text);
        }
        return texts;
    }

    private remember(thread: Thread, id: string): void {
        thread.seen.add(id);
        if (thread.seen.size > SEEN_KEPT) thread.seen.delete(thread.seen.values().next().value!);
    }

    /** Persists a message, then acknowledges it; a message that could not be persisted is pushed again later. */
    private receive(thread: Thread, connection: RelayConnection, frame: MessageFrame): void {
        if (thread.seen.has(frame.id)) { connection.send({ type: "ack", id: frame.id }); return; }
        const hops = Number.isInteger(frame.hops) && frame.hops >= 0 ? frame.hops : 0;
        const urgent = frame.urgent === true;
        this.append(thread, { kind: "message", id: frame.id, hops, frame: { ...frame, urgent, hops } });
        this.remember(thread, frame.id);
        connection.send({ type: "ack", id: frame.id });
        this.wake(thread);
    }

    private status(thread: Thread, frame: StatusFrame): void {
        if (frame.status === "expired" && thread.notified.has(frame.id)) return;
        const record = thread.sent.find((item) => item.id === frame.id);
        if (record && frame.to) record.label = targetLabel(frame.to, record.to);
        if (frame.status === "delivered") {
            if (record) record.status = "delivered";
            return;
        }
        if (frame.status !== "expired") return;
        thread.notified.add(frame.id);
        if (record) record.status = "expired";
        this.append(thread, { kind: "notice", id: frame.id, text: expiredContent(frame.id, record?.label ?? targetLabel(frame.to), thread.limits.ttlSeconds) });
        this.wake(thread);
    }

    /** Hands waiting entries to a pending relay_wait. */
    private wake(thread: Thread): void {
        const [waiter] = thread.waiters;
        if (!waiter) return;
        const texts = this.drain(thread);
        if (!texts.length) return;
        waiter.resolve(waitText(texts));
        this.setState(thread, "busy");
    }

    // ---- threads ----

    private touch(id: string, fields: { cwd?: string; model?: string }): Thread {
        let thread = this.threads.get(id);
        if (!thread) {
            thread = {
                id, state: "idle", hops: 0, hookAt: 0, activeAt: Date.now(), clients: new Set(), reported: {}, waiters: new Set(), sent: [], notified: new Set(), seen: new Set(),
                limits: { ttlSeconds: 300, maxTextBytes: 32 * 1024 },
            };
            for (const entry of this.readInbox(thread)) this.remember(thread, entry.id);
            this.threads.set(id, thread);
            log(`thread ${id}: registered`);
        }
        if (fields.cwd) thread.cwd = fields.cwd;
        if (fields.model) thread.model = fields.model;
        thread.activeAt = Date.now();
        this.evaluate(thread);
        this.pushState(thread);
        return thread;
    }

    /** Takes a thread offline and forgets it; its inbox file stays for when it comes back. */
    offline(thread: Thread, why: string): void {
        this.disconnect(thread);
        for (const waiter of [...thread.waiters]) waiter.resolve("This thread went offline from pika relay.");
        for (const client of thread.clients) client.threads.delete(thread);
        this.threads.delete(thread.id);
        log(`thread ${thread.id}: offline (${why})`);
    }

    private sweep(): void {
        const now = Date.now();
        for (const thread of [...this.threads.values()]) {
            if (now - thread.activeAt > STALE_MS && !thread.waiters.size) this.offline(thread, "no activity for 24 h");
            else if (thread.orphaned && !thread.clients.size && now - thread.hookAt > HOOK_GRACE_MS) this.offline(thread, "its MCP server closed");
        }
        if (this.threads.size || this.clients.size) this.idleSince = now;
        else if (now - this.idleSince >= IDLE_EXIT_MS) this.shutdown("idle");
    }

    shutdown(why: string): void {
        if (this.stopping) return;
        this.stopping = true;
        log(`broker exiting (${why})`);
        for (const thread of [...this.threads.values()]) this.offline(thread, "broker exit");
        for (const client of this.clients) client.socket.destroy();
        this.onExit();
    }

    // ---- clients ----

    accept(socket: Socket): void {
        const client: Client = { socket, threads: new Set(), inflight: new Map() };
        this.clients.add(client);
        socket.on("error", () => { /* closed below */ });
        socket.on("close", () => this.closed(client));
        readLines(socket, (value) => { void this.handle(client, value as { id?: unknown; op?: unknown; [key: string]: unknown }); });
    }

    private closed(client: Client): void {
        this.clients.delete(client);
        for (const controller of client.inflight.values()) controller.abort();
        const now = Date.now();
        for (const thread of client.threads) {
            thread.clients.delete(client);
            if (thread.clients.size || this.threads.get(thread.id) !== thread) continue;
            if (now - thread.hookAt > HOOK_GRACE_MS) this.offline(thread, "its MCP server closed");
            else thread.orphaned = true;
        }
        this.idleSince = now;
    }

    private async handle(client: Client, request: { id?: unknown; op?: unknown; [key: string]: unknown }): Promise<void> {
        const id = typeof request.id === "number" ? request.id : 0;
        const controller = new AbortController();
        client.inflight.set(id, controller);
        try {
            const result = await this.dispatch(client, request, controller.signal);
            writeLine(client.socket, { id, ok: true, result });
        } catch (error) {
            writeLine(client.socket, { id, ok: false, error: errorText(error) });
        } finally {
            client.inflight.delete(id);
        }
    }

    private async dispatch(client: Client, request: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        switch (request.op) {
            case "ping": return { pid: process.pid };
            case "hook": return this.hook(String(request.event) as HookEvent, (request.input ?? {}) as HookInput);
            case "tool": {
                const meta = (request.thread ?? {}) as { id?: unknown; model?: unknown };
                if (typeof meta.id !== "string" || !meta.id) throw new Error("no Codex thread id");
                const thread = this.touch(meta.id, { model: text(meta.model, 200) });
                client.threads.add(thread);
                thread.clients.add(client);
                thread.orphaned = false;
                try {
                    return { text: await this.tool(thread, String(request.name), (request.args ?? {}) as Record<string, unknown>, signal), isError: false };
                } catch (error) {
                    return { text: errorText(error), isError: true };
                }
            }
            case "cancel": client.inflight.get(Number(request.target))?.abort(); return {};
            case "inspect": return [...this.threads.values()].map((thread) => ({
                id: thread.id, cwd: thread.cwd, state: thread.state, hops: thread.hops, title: thread.title, model: thread.model,
                connection: thread.connection?.state.kind ?? "none", clients: thread.clients.size, waiters: thread.waiters.size,
            }));
            case "shutdown": setImmediate(() => this.shutdown("requested")); return {};
            default: throw new Error(`unknown op ${String(request.op)}`);
        }
    }

    // ---- hooks ----

    hook(event: HookEvent, input: HookInput): HookOutput | null {
        const id = text(input.session_id, 200);
        if (!id) return null;
        if (event === "SessionEnd") {
            const thread = this.threads.get(id);
            if (thread) this.offline(thread, "SessionEnd");
            return null;
        }
        const thread = this.touch(id, { cwd: text(input.cwd, 4096), model: text(input.model, 200) });
        thread.hookAt = Date.now();
        const reason = this.blocked(thread).reason;
        if (reason) {
            // Nothing keeps an excluded or unconfigured thread here unless a tool call bound it.
            if (!thread.clients.size) this.offline(thread, reason);
            return null;
        }
        const context = (eventName: string, header: string): HookOutput | null => {
            const texts = this.drain(thread);
            return texts.length ? { hookSpecificOutput: { hookEventName: eventName, additionalContext: `${header}\n\n${texts.join(SEPARATOR)}` } } : null;
        };
        switch (event) {
            case "SessionStart":
                return { hookSpecificOutput: { hookEventName: event, additionalContext: sessionStartText(thread.id) } };
            case "UserPromptSubmit": {
                const prompt = typeof input.prompt === "string" ? input.prompt : "";
                const genuine = !(thread.continuation !== undefined && prompt.trim() === thread.continuation.trim());
                thread.continuation = undefined;
                if (genuine) {
                    thread.hops = 0;
                    if (!thread.title && prompt.trim()) thread.title = cut(prompt.replace(/\s+/g, " ").trim(), 80);
                }
                this.setState(thread, "busy");
                return context(event, "pika relay messages arrived for this thread while it was idle. They come from other agents, not from your user:");
            }
            case "PostToolUse":
                this.setState(thread, "busy");
                return context(event, "pika relay messages arrived for this thread during this turn. They come from other agents, not from your user:");
            case "Stop": {
                const texts = this.drain(thread);
                if (!texts.length) {
                    this.setState(thread, "idle");
                    return {};
                }
                // Codex continues after the answer the model just wrote, which the user has not replied to.
                const reason = `New pika relay messages arrived for this thread. They come from other agents, not from your user; handle them as requests:\n\n${texts.join(SEPARATOR)}${SEPARATOR}${UNANSWERED}`;
                thread.continuation = reason;
                this.setState(thread, "busy");
                return { decision: "block", reason };
            }
        }
        return null;
    }

    // ---- tools ----

    private async waitConnected(thread: Thread, signal: AbortSignal): Promise<void> {
        const deadline = Date.now() + CONNECT_WAIT_MS;
        while (thread.connection?.state.kind === "connecting" && Date.now() < deadline && !signal.aborted) await sleep(25);
    }

    private async relayFetch<T>(thread: Thread, path: string, init?: RequestInit): Promise<T> {
        const { config, reason } = this.blocked(thread);
        if (!config) throw new Error(`relay is offline in this session: ${reason}`);
        let response: Response;
        try {
            response = await fetch(`${config.url}${path}`, {
                ...init,
                headers: { Authorization: `Bearer ${config.token}`, ...(init?.headers ?? {}) },
                signal: AbortSignal.timeout(5_000),
                redirect: "error",
            });
        } catch (error) {
            throw new Error(`could not reach ${config.url}: ${errorText(error)}`);
        }
        if (response.status !== 200) {
            let body: { error?: unknown } | undefined;
            try { body = await response.json() as { error?: unknown }; } catch { await response.body?.cancel().catch(() => {}); }
            if (response.status === 401) throw new Error("the server rejected this device's token (HTTP 401)");
            if (response.status === 404 && body?.error === "not_found") throw new Error(REJECTIONS.unknown_room);
            if (response.status === 404) throw new Error(`the pika server at ${config.url} has no relay (HTTP 404)`);
            if (typeof body?.error === "string") throw new Error(`relay error (${body.error}): ${REJECTIONS[body.error] ?? body.error}`);
            throw new Error(`unexpected HTTP ${response.status} from ${config.url}`);
        }
        return await response.json() as T;
    }

    /** Sends one message (1:1 or chatroom) and records it; throws with the text an error result shows. */
    private async send(
        thread: Thread, to: string, body: string, options: { room?: string; mentions?: string[]; urgent?: boolean; replyTo?: string }, signal: AbortSignal,
    ): Promise<string> {
        await this.waitConnected(thread, signal);
        const connection = thread.connection;
        const reason = this.offlineReason(thread);
        if (reason || !connection) throw new Error(`This session is not connected to pika relay: ${reason ?? "it is not connected"}.`);
        const roomKey = (name: string) => name.trim().replace(/^#/, "").trim();
        const cleanTo = to.trim();
        const room = (options.room ? roomKey(options.room) : "") || (cleanTo.startsWith("#") ? roomKey(cleanTo) : "") || undefined;
        const targetTo = room ? "" : cleanTo;
        const targetKey = room ? `#${room}` : targetTo;
        const mentions = options.mentions?.map((item) => item.trim()).filter(Boolean);
        const replyTo = options.replyTo?.trim() || undefined;
        const record: SentRecord = { to: targetKey, label: targetLabel(undefined, targetKey), status: "queued", at: Date.now(), text: body };
        const remember = () => { thread.sent.push(record); if (thread.sent.length > SENT_KEPT) thread.sent.splice(0, thread.sent.length - SENT_KEPT); };
        const bytes = Buffer.byteLength(body, "utf8");
        if (bytes > thread.limits.maxTextBytes) {
            record.status = "rejected"; record.reason = "too_large"; remember();
            throw new Error(`relay rejected the message (too_large): the text is ${bytes} bytes, and the limit is ${thread.limits.maxTextBytes}.`);
        }
        let answer: SentFrame;
        try {
            answer = await connection.request({
                ...(room ? { room } : { to: targetTo }),
                ...(mentions?.length ? { mentions } : {}),
                text: body,
                hops: thread.hops + 1,
                ...(options.urgent ? { urgent: true } : {}),
                ...(replyTo ? { replyTo } : {}),
            }, signal);
        } catch (error) {
            record.status = error instanceof RequestError && error.outcome === "unsent" ? "failed" : "unknown";
            record.reason = error instanceof RequestError ? error.code : errorText(error);
            remember();
            throw new Error(`relay_send failed: ${errorText(error)}.`);
        }
        if (answer.status === "rejected") {
            record.status = "rejected"; record.reason = answer.reason; remember();
            throw new Error(`relay rejected the message (${answer.reason}): ${REJECTIONS[answer.reason] ?? "see the reason"}.`);
        }
        record.id = answer.id;
        record.label = answer.room ? `room #${headerField(answer.room)}` : targetLabel(answer.to, targetTo);
        record.status = answer.status;
        remember();
        return sendResult(answer, record.label, thread.limits.ttlSeconds);
    }

    private statusLines(thread: Thread, id?: string): string {
        const records = [...thread.sent].reverse().filter((record) => !id || record.id === id).slice(0, SENT_SHOWN);
        if (!records.length) return id ? `No message ${id} was sent from this session in this process.` : "This session has sent no relay messages in this process.";
        return records.map((record) => `${record.id ?? "(no id)"} to ${record.label}: ${record.status}${record.reason ? ` (${record.reason})` : ""}, sent ${since(record.at)} ago: "${preview(record.text)}"`).join("\n");
    }

    private async tool(thread: Thread, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
        const str = (key: string) => typeof args[key] === "string" ? args[key] as string : undefined;
        const list = (key: string) => Array.isArray(args[key]) ? (args[key] as unknown[]).filter((item): item is string => typeof item === "string") : undefined;
        const int = (key: string) => typeof args[key] === "number" && Number.isFinite(args[key]) ? Math.trunc(args[key] as number) : undefined;
        switch (name) {
            case "relay_list": {
                const body = await this.relayFetch<{ items?: unknown }>(thread, "/api/relay/v1/sessions");
                const all = (Array.isArray(body.items) ? body.items as OnlineSession[] : []).filter((session) => session.id !== thread.id);
                const lower = (value: string | undefined) => value?.toLowerCase() ?? "";
                const device = str("device")?.trim() || undefined, project = str("project")?.trim() || undefined, query = lower(str("query")?.trim());
                const matches = all.filter((session) =>
                    (!device || [session.deviceName, session.device].some((value) => lower(value) === lower(device)))
                    && (!project || lower(session.project) === lower(project))
                    && (!query || [session.id, session.name, session.title, session.cwd].some((value) => lower(value).includes(query))));
                const filtered = device || project || query;
                return matches.length
                    ? `${matches.length} online pi session${matches.length === 1 ? "" : "s"}${filtered ? " matching" : ""}:\n${matches.map(sessionLine).join("\n")}`
                    : `No other pi session is online${filtered && all.length ? " that matches" : ""}.`;
            }
            case "relay_send": {
                const roomKey = (name: string) => name.trim().replace(/^#/, "").trim();
                const rawTo = str("to")?.trim() ?? "", rawRoom = str("room"), body = str("text");
                const room = (rawRoom ? roomKey(rawRoom) : "") || (rawTo.startsWith("#") ? roomKey(rawTo) : "") || undefined;
                const to = room || rawTo.startsWith("#") ? "" : rawTo;
                if (!to && !room) throw new Error("relay_send requires either `to` (a session id) or `room` (a chatroom name).");
                if (body === undefined) throw new Error("relay_send requires `text`.");
                const result = await this.send(thread, to, body, { room, mentions: list("mentions"), urgent: args.urgent === true, replyTo: str("replyTo") }, signal);
                return `${result} ${ANSWER_HINT}`;
            }
            case "relay_status":
                return this.statusLines(thread, str("id")?.trim() || undefined);
            case "relay_room": {
                const action = str("action");
                if (action === "list") {
                    const body = await this.relayFetch<{ items?: unknown }>(thread, "/api/relay/v1/rooms");
                    const items = Array.isArray(body.items) ? body.items as RelayRoom[] : [];
                    return items.length
                        ? `${items.length} active chatroom${items.length === 1 ? "" : "s"}:\n${items.map(roomLine).join("\n")}`
                        : "No active chatrooms.";
                }
                // Only the user adds a thread to a room (in the pika web UI); the model never joins or leaves.
                if (action !== "history" && action !== "send") throw new Error("relay_room requires `action`: list, history, or send.");
                const room = str("room")?.trim().replace(/^#/, "").trim();
                if (!room) throw new Error(`relay_room (${action}) requires a \`room\` name.`);
                if (action === "history") {
                    const rawLimit = int("limit"), rawAfter = int("after");
                    const limit = rawLimit && rawLimit > 0 ? Math.min(200, rawLimit) : 50;
                    const after = rawAfter && rawAfter > 0 ? rawAfter : 0;
                    const params = new URLSearchParams({ limit: String(limit), ...(after > 0 ? { after: String(after) } : {}) });
                    const detail = await this.relayFetch<RelayRoomDetail>(thread, `/api/relay/v1/rooms/${encodeURIComponent(room)}?${params}`);
                    const body = detail.messages.length ? detail.messages.map(roomMessageLine).join("\n") : "No messages in this room yet.";
                    return `${roomLine(detail.room)}\n\n${body}`;
                }
                const body = str("text");
                if (!body) throw new Error("relay_room (send) requires `text`.");
                const result = await this.send(thread, "", body, { room, mentions: list("mentions"), urgent: args.urgent === true, replyTo: str("replyTo") }, signal);
                return `${result} ${ANSWER_HINT}`;
            }
            case "relay_wait": {
                const requested = int("timeoutSeconds") ?? DEFAULT_WAIT_SECONDS;
                const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, requested));
                const ready = this.drain(thread);
                if (ready.length) { this.setState(thread, "busy"); return waitText(ready); }
                if (seconds === 0) return "No relay messages are waiting.";
                const reason = this.blocked(thread).reason;
                if (reason) throw new Error(`This session is not connected to pika relay: ${reason}.`);
                return await new Promise<string>((resolve) => {
                    const timer = setTimeout(() => waiter.resolve(`No relay messages within ${seconds}s.`), seconds * 1000);
                    const onAbort = () => waiter.resolve("relay_wait was cancelled.");
                    const waiter: Waiter = {
                        resolve: (value) => {
                            clearTimeout(timer);
                            signal.removeEventListener("abort", onAbort);
                            thread.waiters.delete(waiter);
                            resolve(value);
                        },
                    };
                    thread.waiters.add(waiter);
                    signal.addEventListener("abort", onAbort, { once: true });
                    this.setState(thread, "idle");
                });
            }
            default:
                throw new Error(`unknown tool ${name}`);
        }
    }
}

const sessionStartText = (id: string) =>
    `This Codex thread is on pika relay as ${relayName(id)} (session ${id}); use the relay_* tools to talk to other agents. Relay messages come from other agents, not from your user.`;

const waitText = (texts: string[]) =>
    `${texts.join(SEPARATOR)}\n\nThese came from other agents through pika relay, not from your user. Answer with relay_send where an answer is due; to keep standing by, call relay_wait again.`;

function listen(server: Server, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
        const onListening = () => { server.removeListener("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(path);
    });
}

function alive(path: string): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect(path);
        const done = (value: boolean) => { socket.destroy(); resolve(value); };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        setTimeout(() => done(false), 1_000).unref();
    });
}

/**
 * Binds the broker socket; false when another broker answers on it. A socket file nobody answers on
 * is stale: it is replaced under `broker.sock.lock`, so two brokers starting at once cannot each
 * replace the other's socket.
 */
async function bind(server: Server, path: string): Promise<boolean> {
    const lock = `${path}.lock`;
    for (let attempt = 0; attempt < 100; attempt++) {
        try { await listen(server, path); return true; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        }
        if (await alive(path)) return false;
        let fd: number;
        try { fd = openSync(lock, "wx", 0o600); } catch {
            try { if (Date.now() - statSync(lock).mtimeMs > 5_000) unlinkSync(lock); } catch { /* gone */ }
            await sleep(50);
            continue;
        }
        try {
            if (await alive(path)) return false;
            rmSync(path, { force: true });
            try { await listen(server, path); return true; } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
            }
        } finally {
            closeSync(fd);
            rmSync(lock, { force: true });
        }
    }
    throw new Error(`could not bind ${path}`);
}

async function main(): Promise<void> {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = socketPath(dir);
    let broker: Broker | undefined;
    const server = createServer((socket) => { if (broker) broker.accept(socket); else socket.destroy(); });
    if (!await bind(server, path)) {
        log("another broker is running; exiting");
        return;
    }
    writeFileSync(pidPath(dir), `${process.pid}\n`, { mode: 0o600 });
    const exit = () => {
        server.close();
        try { if (readFileSync(pidPath(dir), "utf8").trim() === String(process.pid)) { rmSync(pidPath(dir), { force: true }); rmSync(path, { force: true }); } } catch { /* gone */ }
        setTimeout(() => process.exit(0), 50).unref();
    };
    broker = new Broker(dir, exit);
    log(`broker ${process.pid} listening on ${path}`);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => broker!.shutdown(signal));
    process.on("uncaughtException", (error) => log(`uncaught: ${error.stack ?? errorText(error)}`));
    process.on("unhandledRejection", (error) => log(`unhandled: ${errorText(error)}`));
}

void main().catch((error) => { log(`broker failed: ${errorText(error)}`); process.exit(1); });
