/**
 * The daemon's inner-protocol core (NODE.md §4–5): terminals, attachments with per-client backlogs, the size
 * owner, pane status, checkouts and where each terminal sits in them, and bridge requests. Transports (an E2E
 * channel, or `pika-node attach` over the unix socket) are `Peer`s; this file does no networking.
 */
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { Checkouts, place, type CheckoutList, type Placement } from "./checkouts.ts";
import { asNodeError, NodeError } from "./errors.ts";
import { Files } from "./files.ts";
import { Pane } from "./pane.ts";
import type { Paths } from "./paths.ts";
import { VERSION } from "./paths.ts";
import {
    CAPABILITIES, LIMITS, parseClientMessage, PROTOCOL_VERSION, SETUP_ENV, SETUP_ROLE, timing, utf8Length,
    type BridgeStatus, type Checkout, type ClientMessage, type NodeEvent, type NodeMessage, type Notice, type Request,
    type Requests, type Snapshot, type TerminalInfo, type Welcome, type Worktree,
} from "./protocol.ts";
import { account, spawnCommand, spawnEnv, SpawnError, type Account } from "./spawn.ts";
import { loadConfig, roots, saveConfig, type Config } from "./store.ts";
import { processCwd, processCwds, Terminal } from "./terminal.ts";

/** One inner-protocol endpoint. `send` is ordered and never throws; after `closed`, messages are dropped. */
export interface Peer {
    readonly name: string;
    readonly closed: boolean;
    send(message: NodeMessage): void;
    /** Bytes handed to the transport but not yet written out (for channels: sealing plus the server socket's buffer). */
    buffered(): number;
}


const KiB = 1024;
const MiB = 1024 * KiB;
/** Stop handing a peer more once its transport holds this much. */
const PUMP_HIGH = 256 * KiB;
/** Leave resync (send a fresh snapshot) once the transport is below this. */
const RESYNC_BELOW = 256 * KiB;
/** The server socket's own buffer past which a channel resyncs its terminals. */
const TRANSPORT_LIMIT = 4 * MiB;
const MAX_TERMINALS = 128;
/** `worktree.remove` with `force` waits this long for the worktree's terminals to exit after SIGHUP. */
const FORCE_EXIT_MS = 5_000;

interface Item { message: NodeMessage; bytes: number; seq?: number }

/** One peer attached to one terminal: its output queue and resync state. */
interface Attachment {
    peer: Peer;
    queue: Item[];
    queuedBytes: number;
    /** `live` streams; `resync` drops output until the backlog drains; `snapshotting` queues until a snapshot is sent. */
    mode: "live" | "resync" | "snapshotting";
    /** Output with a smaller `seq` is covered by the last snapshot. */
    minSeq: number;
}

interface Pty {
    id: string;
    terminal: Terminal;
    pane: Pane;
    cwd: string;
    /** The start cwd's real path, and the shell's live cwd as last seen (NODE.md "Checkouts", "Terminals"). */
    realCwd: string;
    liveCwd: string | undefined;
    /** The checkout and worktree holding the cwd; kept once the terminal exits, while that checkout is listed. */
    placed: Placement | undefined;
    argv: string[];
    /** The requested argv and env as given, which `term.restart` starts again. */
    spawn: { argv?: string[]; env?: Record<string, string> };
    /** `TerminalInfo.role`. */
    role: string | undefined;
    createdAt: number;
    owner: Peer | undefined;
    attachments: Map<Peer, Attachment>;
    bridge: object | undefined;
    /** The user's name for it (`term.rename`). */
    label: string | undefined;
}

export interface DaemonOptions {
    paths: Paths;
    /** The node id once the server assigned one; `local` before (ssh attach still works). */
    nodeId?: () => string;
    nodeName?: () => string | undefined;
    log?: (line: string) => void;
    account?: Account;
}

const newId = (): string => randomBytes(9).toString("base64url");

export class Daemon {
    readonly paths: Paths;
    readonly account: Account;
    readonly files: Files;
    readonly checkouts: Checkouts;
    #terminals = new Map<string, Pty>();
    #peers = new Set<Peer>();
    #options: DaemonOptions;
    #log: (line: string) => void;
    #pumpTimer: NodeJS.Timeout | undefined;
    #foregroundTimer: NodeJS.Timeout;
    #cwdPoll: Promise<void> | undefined;
    onTerminalsChanged: () => void = () => {};

    constructor(options: DaemonOptions) {
        this.#options = options;
        this.paths = options.paths;
        this.account = options.account ?? account();
        this.#log = options.log ?? (() => {});
        this.files = new Files({ home: this.account.home, uploads: join(this.paths.home, "uploads"), log: this.#log });
        this.checkouts = new Checkouts({
            config: () => this.config(),
            save: config => saveConfig(this.paths, config),
            terminalCwds: () => [...this.#terminals.values()].filter(pty => !pty.terminal.exited).map(pty => pty.liveCwd ?? pty.realCwd),
            scanned: (list, changed) => this.#checkoutsScanned(list, changed),
            log: this.#log,
        });
        this.checkouts.poke();
        this.#foregroundTimer = setInterval(() => {
            this.#pollForeground();
            this.#pollCwds().catch((error: Error) => this.#log(`cwd poll failed: ${error.message}`));
        }, timing.foregroundPollMs);
        this.#foregroundTimer.unref();
    }

    config(): Config { return loadConfig(this.paths); }

    get terminalCount(): number { return this.#terminals.size; }
    get liveTerminals(): number { return [...this.#terminals.values()].filter(t => !t.terminal.exited).length; }

    // -----------------------------------------------------------------------------------------------------------
    // Peers

    welcome(): Welcome {
        return {
            type: "welcome",
            node: this.#options.nodeId?.() ?? "local",
            name: this.#options.nodeName?.() || hostname().slice(0, 64) || "pika-node",
            host: hostname().slice(0, 255) || "localhost",
            home: this.account.home,
            version: VERSION,
            protocolVersion: PROTOCOL_VERSION,
            capabilities: [...CAPABILITIES],
            limits: {
                maxRecordBytes: LIMITS.maxRecordBytes, maxSnapshotBytes: LIMITS.maxSnapshotBytes, maxReadBytes: LIMITS.maxReadBytes,
                maxUploadBytes: LIMITS.maxUploadBytes, maxUploadChunkBytes: LIMITS.maxUploadChunkBytes,
            },
        };
    }

    addPeer(peer: Peer): void {
        this.#peers.add(peer);
        peer.send(this.welcome());
    }

    removePeer(peer: Peer): void {
        if (!this.#peers.delete(peer)) return;
        for (const pty of this.#terminals.values()) {
            pty.attachments.delete(peer);
            if (pty.owner === peer) pty.owner = undefined;
        }
        this.files.closePeer(peer);
    }

    /** Sends to every peer; to an attached one through its terminal queue, so it stays ordered with output. */
    #broadcast(message: NodeEvent, pty?: Pty): number {
        let delivered = 0;
        for (const peer of this.#peers) {
            const attachment = pty?.attachments.get(peer);
            if (attachment) this.#enqueue(pty!, attachment, { message, bytes: messageBytes(message) });
            else peer.send(message);
            delivered++;
        }
        return delivered;
    }

    // -----------------------------------------------------------------------------------------------------------
    // Messages

    /** Handles one inner message from a peer (already decrypted and JSON-parsed). */
    handle(peer: Peer, value: unknown): void {
        const parsed = parseClientMessage(value);
        if (!parsed.ok) {
            if (parsed.id) {
                const code = parsed.reason === "unknown" ? "unsupported" : "invalid";
                peer.send({ type: "reply", id: parsed.id, error: { code, message: parsed.reason === "unknown" ? `unknown request ${parsed.type ?? ""}`.trim() : `invalid ${parsed.type} parameters` } });
            } else if (parsed.reason === "invalid") {
                peer.send({ type: "error", code: "invalid", message: `invalid ${parsed.type} message` });
            }
            return;
        }
        const message = parsed.message as ClientMessage;
        if (!("id" in message)) {
            try { this.#notice(peer, message); }
            catch (error) {
                const failure = asNodeError(error);
                peer.send({ type: "error", code: failure.code, message: failure.message, terminalId: message.terminalId });
            }
            return;
        }
        const request = message as Request;
        void (async () => {
            try { return { type: "reply", id: request.id, result: await this.#request(peer, request) } as NodeMessage; }
            catch (error) {
                const failure = asNodeError(error);
                if (failure.code === "io" && !(error instanceof NodeError)) this.#log(`request ${request.type} failed: ${(error as Error).stack ?? error}`);
                return { type: "reply", id: request.id, error: { code: failure.code, message: failure.message, ...(failure.current ? { current: failure.current } : {}) } } as NodeMessage;
            }
        })().then(reply => peer.send(reply));
    }

    async #request(peer: Peer, request: Request): Promise<object> {
        switch (request.type) {
            case "term.create": return { terminal: this.#announce(peer, this.create(request, peer)) };
            case "term.list": return { terminals: [...this.#terminals.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)).map(pty => this.#info(pty)) };
            case "term.attach": {
                const pty = this.#terminal(request.terminalId);
                return { terminal: this.#info(pty), snapshot: await this.#attach(pty, peer) };
            }
            case "term.detach": {
                const pty = this.#terminal(request.terminalId);
                pty.attachments.delete(peer);
                return {};
            }
            case "term.cwd": {
                const pty = this.#terminal(request.terminalId);
                if (pty.terminal.exited) throw new NodeError("exited", "the terminal has exited");
                // The shell's own directory: it is the PTY's process, and a program it runs (pi) usually shares it.
                const live = await processCwd(pty.terminal.pid);
                if (live) this.#moved(pty, live);
                return { cwd: live ?? pty.cwd };
            }
            case "term.rename": {
                const pty = this.#terminal(request.terminalId);
                const label = request.label?.trim() || undefined;
                if (label !== pty.label) {
                    pty.label = label;
                    this.#broadcast({ type: "term.renamed", terminalId: pty.id, label: label ?? null }, pty);
                }
                return { terminal: this.#info(pty) };
            }
            // NODE.md "Checkouts". A `checkouts.changed` an edit causes goes out after its reply (`#checkoutsScanned`).
            case "checkouts.list": return await this.checkouts.scan();
            case "checkout.add": return { checkout: await this.checkouts.add(request.path) };
            case "checkout.hide":
                await this.checkouts.hide(request.checkoutId);
                return {};
            case "checkout.unhide": return { checkout: await this.checkouts.unhide(request.checkoutId) };
            case "checkout.update": return { checkout: await this.checkouts.update(request.checkoutId, request) };
            case "worktree.create": return this.#worktreeCreate(peer, request);
            case "worktree.remove": return this.checkouts.removeWorktree(request.checkoutId, request.path, {
                deleteBranch: request.deleteBranch === true,
                ready: (checkout, worktree) => this.#releaseWorktree(checkout, worktree, request.force === true),
            });
            case "term.kill": {
                const pty = this.#terminal(request.terminalId);
                if (pty.terminal.exited) this.#remove(pty);
                else pty.terminal.kill(request.signal ?? "SIGTERM");
                return {};
            }
            case "term.restart": return { terminal: this.#restart(peer, this.#terminal(request.terminalId)) };
            default: return this.files.request(peer, request);
        }
    }

    /** Tells every other channel of a new terminal now, and its creator after the reply (which goes out first). */
    #announce(peer: Peer, pty: Pty): TerminalInfo {
        const terminal = this.#info(pty);
        for (const other of this.#peers) if (other !== peer) other.send({ type: "term.created", terminal });
        setImmediate(() => { if (!peer.closed) peer.send({ type: "term.created", terminal: this.#info(pty) }); });
        return terminal;
    }

    /**
     * Starts an exited terminal's argv, env, cwd, size, role, and label again as a new terminal, then removes the old
     * one (`term.removed` with `replacedBy`, after the new one's `term.created`). The old one makes room for the
     * new one under the terminal limit; it stays when the new one fails to start.
     */
    #restart(peer: Peer, old: Pty): TerminalInfo {
        if (!old.terminal.exited) throw new NodeError("busy", "the terminal is still running");
        this.#terminals.delete(old.id);
        let pty: Pty;
        try {
            pty = this.create({
                cols: old.terminal.cols, rows: old.terminal.rows, cwd: old.cwd,
                ...(old.spawn.argv ? { argv: old.spawn.argv } : {}), ...(old.spawn.env ? { env: old.spawn.env } : {}), ...(old.role ? { role: old.role } : {}),
            }, peer);
        } catch (error) {
            this.#terminals.set(old.id, old);
            throw error;
        }
        pty.label = old.label;
        const terminal = this.#announce(peer, pty);
        // After the reply and the creator's `term.created` (`#announce`), so no client sees the pane end before its successor.
        setImmediate(() => this.#remove(old, pty.id));
        return terminal;
    }

    #notice(peer: Peer, notice: Notice): void {
        const pty = this.#terminal(notice.terminalId);
        switch (notice.type) {
            case "term.input":
                if (pty.terminal.exited) throw new NodeError("exited", "the terminal has exited");
                pty.terminal.write(notice.data);
                return;
            case "term.resize": return this.#resize(pty, peer, notice.cols, notice.rows, notice.claim === true);
            case "pane.seen":
                if (pty.pane.seen()) this.#paneChanged(pty);
                return;
            case "pane.unread":
                if (pty.terminal.exited) throw new NodeError("exited", "the terminal has exited");
                if (pty.pane.markUnread()) this.#paneChanged(pty);
                return;
        }
    }

    #terminal(id: string): Pty {
        const pty = this.#terminals.get(id);
        if (!pty) throw new NodeError("not_found", `no terminal ${id}`);
        return pty;
    }

    #info(pty: Pty): TerminalInfo {
        const status = pty.pane.view();
        return {
            terminalId: pty.id, title: pty.terminal.title, cwd: pty.cwd, cols: pty.terminal.cols, rows: pty.terminal.rows,
            pid: pty.terminal.pid, createdAt: pty.createdAt, argv: pty.argv,
            ...(pty.terminal.exited ? { exited: pty.terminal.exited } : {}),
            ...(status ? { status } : {}),
            ...(pty.label ? { label: pty.label } : {}),
            ...(pty.placed ? { checkoutId: pty.placed.checkoutId, worktreePath: pty.placed.worktreePath } : {}),
            ...(pty.role ? { role: pty.role } : {}),
        };
    }

    // -----------------------------------------------------------------------------------------------------------
    // Terminals

    create(params: { cols: number; rows: number; cwd?: string; argv?: string[]; env?: Record<string, string>; role?: string }, owner?: Peer): Pty {
        if (this.#terminals.size >= MAX_TERMINALS) throw new NodeError("limit", `at most ${MAX_TERMINALS} terminals`);
        const cwd = params.cwd ?? this.account.home;
        let stat;
        try { stat = statSync(cwd); }
        catch { throw new NodeError("not_found", `no directory ${cwd}`); }
        if (!stat.isDirectory()) throw new NodeError("not_a_directory", `${cwd} is not a directory`);
        const id = newId();
        let env;
        try { env = spawnEnv({ account: this.account, socket: this.paths.socket, paneId: id, env: params.env, lang: process.env.LANG }); }
        catch (error) {
            if (error instanceof SpawnError) throw new NodeError("invalid", error.message);
            throw error;
        }
        const { file, args } = spawnCommand(this.account.shell, params.argv);
        const pane = new Pane();
        let pty: Pty | undefined;
        const terminal = new Terminal({
            file, args, cwd, env, cols: params.cols, rows: params.rows, logPath: join(this.paths.logs, `${id}.log`),
            hooks: {
                output: (seq, data) => { if (pty) this.#output(pty, seq, data); },
                title: title => { if (pty) this.#broadcast({ type: "term.title", terminalId: id, title }, pty); },
                program: status => { if (pty && pty.pane.setProgram(status, pty.terminal.foreground)) this.#paneChanged(pty); },
                exit: (code, signal) => {
                    if (!pty) return;
                    this.#broadcast({ type: "term.exit", terminalId: id, code, signal }, pty);
                    if (pty.pane.exit()) this.#paneChanged(pty);
                    this.onTerminalsChanged();
                    // Its checkout may have been listed only for this terminal.
                    this.checkouts.poke();
                },
            },
        });
        let realCwd = cwd;
        try { realCwd = realpathSync(cwd); }
        catch { /* gone since the check; placed by its live cwd later */ }
        pty = {
            id, terminal, pane, cwd, realCwd, liveCwd: undefined, placed: place(realCwd, this.checkouts.list.checkouts),
            argv: params.argv ?? [this.account.shell, "-l"], spawn: { ...(params.argv ? { argv: params.argv } : {}), ...(params.env ? { env: params.env } : {}) },
            role: params.role, createdAt: Date.now(), owner, attachments: new Map(), bridge: undefined, label: undefined,
        };
        this.#terminals.set(id, pty);
        this.#log(`terminal ${id} pid ${terminal.pid}: ${[file, ...args].join(" ")}`);
        this.onTerminalsChanged();
        // Its cwd may be in a repository no checkout lists yet.
        this.checkouts.poke();
        return pty;
    }

    #remove(pty: Pty, replacedBy?: string): void {
        this.#terminals.delete(pty.id);
        pty.terminal.dispose();
        this.#broadcast({ type: "term.removed", terminalId: pty.id, ...(replacedBy ? { replacedBy } : {}) });
        this.onTerminalsChanged();
    }

    #output(pty: Pty, seq: number, data: string): void {
        if (pty.attachments.size === 0) return;
        const message: NodeMessage = { type: "term.output", terminalId: pty.id, seq, data };
        const bytes = messageBytes(message);
        for (const attachment of pty.attachments.values()) this.#enqueue(pty, attachment, { message, bytes, seq });
    }

    #resize(pty: Pty, peer: Peer, cols: number, rows: number, claim: boolean): void {
        if (claim || !pty.owner || pty.owner.closed) pty.owner = peer;
        if (pty.owner !== peer) {
            // A non-owner learns the size it must render at instead.
            const attachment = pty.attachments.get(peer);
            const message: NodeMessage = { type: "term.resized", terminalId: pty.id, cols: pty.terminal.cols, rows: pty.terminal.rows, owned: false };
            if (attachment) this.#enqueue(pty, attachment, { message, bytes: messageBytes(message) });
            else peer.send(message);
            return;
        }
        if (cols !== pty.terminal.cols || rows !== pty.terminal.rows) pty.terminal.resize(cols, rows);
        for (const attachment of pty.attachments.values()) {
            const message: NodeMessage = { type: "term.resized", terminalId: pty.id, cols, rows, owned: attachment.peer === pty.owner };
            this.#enqueue(pty, attachment, { message, bytes: messageBytes(message) });
        }
        if (!pty.attachments.has(peer)) peer.send({ type: "term.resized", terminalId: pty.id, cols, rows, owned: true });
    }

    // -----------------------------------------------------------------------------------------------------------
    // Attachments and backpressure

    async #attach(pty: Pty, peer: Peer): Promise<Snapshot> {
        let attachment = pty.attachments.get(peer);
        if (!attachment) {
            attachment = { peer, queue: [], queuedBytes: 0, mode: "snapshotting", minSeq: 1 };
            pty.attachments.set(peer, attachment);
        }
        attachment.mode = "snapshotting";
        let snapshot: Snapshot;
        try { snapshot = await pty.terminal.snapshot(); }
        catch (error) {
            pty.attachments.delete(peer);
            throw new NodeError("too_large", (error as Error).message);
        }
        // The reply goes out through `handle`, after this resolves; the queue is released on the next tick, after it.
        setImmediate(() => this.#resume(pty, attachment, snapshot));
        return snapshot;
    }

    /** Drops queued output the snapshot covers and streams again. */
    #resume(pty: Pty, attachment: Attachment, snapshot: Snapshot): void {
        attachment.minSeq = snapshot.outputSequence + 1;
        attachment.queue = attachment.queue.filter(item => item.seq === undefined || item.seq >= attachment.minSeq);
        attachment.queuedBytes = attachment.queue.reduce((total, item) => total + item.bytes, 0);
        attachment.mode = "live";
        this.#pump(pty, attachment);
    }

    #enqueue(pty: Pty, attachment: Attachment, item: Item): void {
        if (item.seq !== undefined && (attachment.mode === "resync" || item.seq < attachment.minSeq)) return;
        attachment.queue.push(item);
        attachment.queuedBytes += item.bytes;
        if (item.seq !== undefined && attachment.mode === "live"
            && (attachment.queuedBytes > LIMITS.maxClientBacklogBytes || attachment.peer.buffered() > TRANSPORT_LIMIT)) {
            this.#log(`terminal ${pty.id}: ${attachment.peer.name} fell behind (${attachment.queuedBytes} bytes queued); resyncing`);
            attachment.mode = "resync";
            attachment.queue = attachment.queue.filter(row => row.seq === undefined);
            attachment.queuedBytes = attachment.queue.reduce((total, row) => total + row.bytes, 0);
        }
        this.#pump(pty, attachment);
    }

    #pump(pty: Pty, attachment: Attachment): void {
        const { peer } = attachment;
        if (peer.closed || pty.attachments.get(peer) !== attachment) return;
        if (attachment.mode === "snapshotting") return;
        while (attachment.queue.length && peer.buffered() < PUMP_HIGH) {
            const item = attachment.queue.shift()!;
            attachment.queuedBytes -= item.bytes;
            peer.send(item.message);
        }
        if (attachment.mode === "resync" && attachment.queue.length === 0 && peer.buffered() < RESYNC_BELOW) {
            attachment.mode = "snapshotting";
            pty.terminal.snapshot().then(snapshot => {
                if (peer.closed || pty.attachments.get(peer) !== attachment) return;
                peer.send({ type: "term.snapshot", terminalId: pty.id, snapshot });
                this.#resume(pty, attachment, snapshot);
            }, (error: Error) => {
                this.#log(`terminal ${pty.id}: resync snapshot failed: ${error.message}`);
                pty.attachments.delete(peer);
                peer.send({ type: "error", code: "too_large", message: error.message, terminalId: pty.id });
            });
            return;
        }
        if (attachment.queue.length || attachment.mode === "resync") this.#schedulePump();
    }

    #schedulePump(): void {
        this.#pumpTimer ??= setTimeout(() => {
            this.#pumpTimer = undefined;
            for (const pty of this.#terminals.values()) for (const attachment of pty.attachments.values()) this.#pump(pty, attachment);
        }, 10);
    }

    // -----------------------------------------------------------------------------------------------------------
    // Pane status

    #paneChanged(pty: Pty): void {
        this.#broadcast({ type: "pane.status", terminalId: pty.id, status: pty.pane.view() });
    }

    #pollForeground(): void {
        for (const pty of this.#terminals.values()) {
            if (pty.terminal.exited || !pty.pane.program) continue;
            if (pty.pane.foreground(pty.terminal.foreground)) this.#paneChanged(pty);
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Checkouts

    /**
     * After each scan: a changed list goes to every channel, then each terminal whose checkout or worktree changed is
     * placed again. Both wait a turn, so an edit's reply goes out first.
     */
    #checkoutsScanned(list: CheckoutList, changed: boolean): void {
        setImmediate(() => {
            if (changed) this.#broadcast({ type: "checkouts.changed", checkouts: list.checkouts, truncated: list.truncated });
            for (const pty of this.#terminals.values()) this.#place(pty);
        });
    }

    /**
     * Places a terminal by its live cwd (else its start cwd) in the current list. An exited terminal stays where it was,
     * unless its checkout left the list (hidden or gone), so no terminal names a checkout clients cannot see.
     */
    #place(pty: Pty): void {
        const listed = this.checkouts.list.checkouts;
        const placed = pty.terminal.exited
            ? pty.placed && listed.some(checkout => checkout.id === pty.placed!.checkoutId) ? pty.placed : undefined
            : place(pty.liveCwd ?? pty.realCwd, listed);
        if (placed?.checkoutId === pty.placed?.checkoutId && placed?.worktreePath === pty.placed?.worktreePath) return;
        pty.placed = placed;
        this.#broadcast({ type: "term.placed", terminalId: pty.id, checkoutId: placed?.checkoutId ?? null, worktreePath: placed?.worktreePath ?? null }, pty);
    }

    /** A terminal's shell was seen in `cwd`: placed again now, and its checkout listed by the next scan if it is new. */
    #moved(pty: Pty, cwd: string): void {
        if (pty.terminal.exited || cwd === (pty.liveCwd ?? pty.realCwd)) {
            pty.liveCwd = cwd;
            return;
        }
        pty.liveCwd = cwd;
        this.#place(pty);
        this.checkouts.poke();
    }

    /** Every live terminal's cwd, every 2 s (one `lsof` on macOS); a call during a poll shares it. */
    #pollCwds(): Promise<void> {
        return this.#cwdPoll ??= (async () => {
            const live = [...this.#terminals.values()].filter(pty => !pty.terminal.exited);
            const cwds = await processCwds(live.map(pty => pty.terminal.pid));
            for (const pty of live) {
                const cwd = cwds.get(pty.terminal.pid);
                if (cwd) this.#moved(pty, cwd);
            }
        })().finally(() => { this.#cwdPoll = undefined; });
    }

    async #worktreeCreate(peer: Peer, request: Requests["worktree.create"]): Promise<object> {
        const { checkout, worktree, main } = await this.checkouts.createWorktree(request.checkoutId, request.name, request.base);
        const script = checkout.settings.setupScript;
        if (!script) return { checkout, worktree };
        let pty: Pty;
        try {
            pty = this.create({
                cols: request.cols ?? 80, rows: request.rows ?? 24, cwd: worktree.path, argv: ["sh", "-c", script],
                env: { [SETUP_ENV.worktree]: worktree.path, [SETUP_ENV.checkout]: main, [SETUP_ENV.branch]: request.name }, role: SETUP_ROLE,
            }, peer);
        } catch (error) {
            // The worktree stays created; only its setup terminal is missing.
            if (error instanceof NodeError && error.code === "limit") return { checkout, worktree };
            throw error;
        }
        return { checkout, worktree, setupTerminal: this.#announce(peer, pty) };
    }

    /**
     * `worktree.remove`'s busy check: refuses while live terminals sit in the worktree, or, with `force`, hangs them up
     * and waits up to 5 s for them to exit. Cwds are polled first, so a terminal that just changed into it counts.
     */
    async #releaseWorktree(checkout: Checkout, worktree: Worktree, force: boolean): Promise<void> {
        await this.#pollCwds();
        const using = () => [...this.#terminals.values()].filter(pty => !pty.terminal.exited
            && pty.placed?.checkoutId === checkout.id && pty.placed.worktreePath === worktree.path);
        const busy = using();
        if (busy.length === 0) return;
        const count = (n: number) => `${n} live terminal${n === 1 ? "" : "s"}`;
        const use = (n: number) => (n === 1 ? "uses" : "use");
        if (!force) throw new NodeError("busy", `${count(busy.length)} ${use(busy.length)} ${worktree.path}`);
        for (const pty of busy) pty.terminal.kill("SIGHUP");
        for (let waited = 0; waited < FORCE_EXIT_MS && busy.some(pty => !pty.terminal.exited); waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
        const left = busy.filter(pty => !pty.terminal.exited).length;
        if (left) throw new NodeError("busy", `${count(left)} did not exit after SIGHUP and still ${use(left)} ${worktree.path}`);
    }

    // -----------------------------------------------------------------------------------------------------------
    // Bridge (§5)

    /** A bridge `hello` for `paneId`; the token identifies this connection, and a newer one replaces it. */
    bridgeHello(paneId: string, token: object): void {
        const pty = this.#terminals.get(paneId);
        if (!pty || pty.terminal.exited) throw new NodeError("not_found", `no live terminal ${paneId}`);
        pty.bridge = token;
    }

    #bridgePane(paneId: string, token: object): Pty | undefined {
        const pty = this.#terminals.get(paneId);
        return pty && pty.bridge === token ? pty : undefined;
    }

    bridgeStatus(paneId: string, token: object, status: BridgeStatus): void {
        const pty = this.#bridgePane(paneId, token);
        if (pty && !pty.terminal.exited && pty.pane.setBridge(status)) this.#paneChanged(pty);
    }

    bridgeClosed(paneId: string, token: object): void {
        const pty = this.#bridgePane(paneId, token);
        if (!pty) return;
        pty.bridge = undefined;
        if (pty.pane.bridgeClosed()) this.#paneChanged(pty);
    }

    /** `open` / `diff` from a bridge: contains the path in the roots, then sends `pane.open` / `pane.diff` everywhere. */
    bridgeRequest(paneId: string, token: object, request: { type: "open"; path: string; line?: number; column?: number } | { type: "diff"; path: string; staged?: boolean }): number {
        if (!this.#bridgePane(paneId, token)) throw new NodeError("not_found", "this bridge connection was replaced");
        const resolved = this.contain(request.path, request.type === "diff");
        if (request.type === "open") {
            let stat;
            try { stat = statSync(resolved); }
            catch { throw new NodeError("not_found", `no file ${request.path}`); }
            if (stat.isDirectory()) throw new NodeError("is_a_directory", `${request.path} is a directory`);
            if (!stat.isFile()) throw new NodeError("not_found", `${request.path} is not a regular file`);
            return this.#broadcast({ type: "pane.open", terminalId: paneId, path: resolved, ...(request.line ? { line: request.line } : {}), ...(request.column ? { column: request.column } : {}) });
        }
        return this.#broadcast({ type: "pane.diff", terminalId: paneId, path: resolved, staged: request.staged === true });
    }

    /** The real path of `path`, which must lie inside a configured root (`outside_roots`). */
    contain(path: string, allowMissing: boolean): string {
        let resolved: string;
        try { resolved = realpathSync(path); }
        catch {
            if (!allowMissing) throw new NodeError("not_found", `no file ${path}`);
            try { resolved = join(realpathSync(dirname(path)), basename(path)); }
            catch { throw new NodeError("not_found", `no directory ${dirname(path)}`); }
        }
        const inside = roots(this.config()).some(root => {
            let real: string;
            try { real = realpathSync(root); }
            catch { return false; }
            return resolved === real || resolved.startsWith(real.endsWith(sep) ? real : real + sep);
        });
        if (!inside) throw new NodeError("outside_roots", `${path} is outside the configured roots`);
        return resolved;
    }

    // -----------------------------------------------------------------------------------------------------------

    /** Hangs up every PTY (daemon stop) and deletes the raw logs once they exited. */
    async shutdown(): Promise<void> {
        clearInterval(this.#foregroundTimer);
        this.checkouts.dispose();
        if (this.#pumpTimer) clearTimeout(this.#pumpTimer);
        this.files.shutdown();
        const ptys = [...this.#terminals.values()];
        for (const pty of ptys) pty.terminal.kill("SIGHUP");
        for (let waited = 0; waited < 2_000 && ptys.some(pty => !pty.terminal.exited); waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
        for (const pty of ptys) {
            if (!pty.terminal.exited) pty.terminal.kill("SIGKILL");
            this.#terminals.delete(pty.id);
            pty.terminal.dispose();
        }
    }
}

const messageBytes = (message: NodeMessage): number => utf8Length(JSON.stringify(message));
