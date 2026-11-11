/**
 * One PTY with its headless screen. The headless emulator is the PTY's only query answerer (its `onData` goes
 * back to the PTY), parses OSC 7501, and is serialized for snapshots. Output is cut into numbered chunks
 * (`seqIn`); `seqApplied` advances in the headless write callback, and a snapshot is taken inside the callback
 * of the chunk it covers, so `outputSequence` is exact.
 */
import { createRequire } from "node:module";
import { constants } from "node:os";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon as Serializer } from "@xterm/addon-serialize";
import type { IPty } from "node-pty";
import { LogFile } from "./logfile.ts";
import { LIMITS, parseProgramStatus, type ProgramStatus, type Signal, type Snapshot } from "./protocol.ts";
import { checkInternals, serializeScreen } from "./snapshot.ts";

const require = createRequire(import.meta.url);
const { Terminal: Headless } = require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
const pty = require("node-pty") as typeof import("node-pty");

export const SCROLLBACK = 1_000;
const LOG_BYTES = 8 * 1024 * 1024;

export interface TerminalHooks {
    output(seq: number, data: string): void;
    title(title: string): void;
    program(status: ProgramStatus | "clear"): void;
    exit(code: number | null, signal: string | null): void;
}

export interface TerminalOptions {
    file: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    logPath: string;
    hooks: TerminalHooks;
}

const SIGNAL_NAMES = new Map(Object.entries(constants.signals).map(([name, number]) => [number, name]));

/** Splits text into pieces of at most `max` UTF-8 bytes without cutting a surrogate pair. */
export function chunks(text: string, max: number): string[] {
    const out: string[] = [];
    let start = 0;
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length;
        const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
        if (bytes + size > max) {
            out.push(text.slice(start, i));
            start = i;
            bytes = 0;
        }
        bytes += size;
        if (pair) i++;
    }
    if (start < text.length) out.push(text.slice(start));
    return out;
}

export class Terminal {
    readonly pid: number;
    cols: number;
    rows: number;
    title = "";
    exited: { code: number | null; signal: string | null } | undefined;
    seqIn = 0;
    seqApplied = 0;
    #pty: IPty;
    #screen: HeadlessTerminal;
    #serializer: Serializer;
    #hooks: TerminalHooks;
    #log: LogFile;
    #pending = "";
    #disposed = false;
    #flushing: NodeJS.Immediate | undefined;
    #waiters: { seq: number; resolve: (snapshot: Snapshot) => void; reject: (error: Error) => void }[] = [];

    constructor(options: TerminalOptions) {
        this.cols = options.cols;
        this.rows = options.rows;
        this.#hooks = options.hooks;
        this.#log = new LogFile(options.logPath, LOG_BYTES);
        // Reply-affecting options must match the web UI's xterm.js (windowOptions stay off).
        this.#screen = new Headless({ cols: options.cols, rows: options.rows, scrollback: SCROLLBACK, allowProposedApi: true });
        this.#serializer = new SerializeAddon();
        this.#screen.loadAddon(this.#serializer);
        checkInternals(this.#screen);
        this.#screen.parser.registerOscHandler(7501, payload => {
            const status = parseProgramStatus(payload, Date.now());
            if (status) this.#hooks.program(status);
            return true;
        });
        this.#screen.onTitleChange(title => {
            this.title = title;
            this.#hooks.title(title);
        });
        this.#pty = pty.spawn(options.file, options.args, {
            name: "xterm-256color", cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env, encoding: "utf8",
        });
        this.pid = this.#pty.pid;
        // The headless terminal's replies to queries (DA1, CPR, DECRQM, …) go to the PTY, never user input.
        this.#screen.onData(reply => { if (!this.exited) this.#pty.write(reply); });
        this.#pty.onData(data => {
            this.#pending += data;
            this.#flushing ??= setImmediate(() => this.#flush());
        });
        this.#pty.onExit(({ exitCode, signal }) => {
            this.#flush();
            const name = signal ? SIGNAL_NAMES.get(signal) ?? `SIG${signal}` : null;
            this.exited = { code: name ? null : exitCode, signal: name };
            this.#log.close();
            this.#hooks.exit(this.exited.code, this.exited.signal);
        });
    }

    /** The PTY's foreground process name (node-pty's `process`). */
    get foreground(): string | undefined {
        if (this.exited) return undefined;
        try { return this.#pty.process; }
        catch { return undefined; }
    }

    #flush(): void {
        if (this.#flushing) clearImmediate(this.#flushing);
        this.#flushing = undefined;
        const text = this.#pending;
        this.#pending = "";
        if (!text || this.#disposed) return;
        for (const piece of chunks(text, LIMITS.maxOutputChunkBytes)) {
            const seq = ++this.seqIn;
            this.#log.append(Buffer.from(piece, "utf8"));
            this.#screen.write(piece, () => this.#applied(seq));
            this.#hooks.output(seq, piece);
        }
    }

    #applied(seq: number): void {
        this.seqApplied = seq;
        while (this.#waiters[0] && this.#waiters[0].seq <= seq) {
            const waiter = this.#waiters.shift()!;
            try { waiter.resolve(this.#serialize(seq)); }
            catch (error) { waiter.reject(error as Error); }
        }
    }

    #serialize(seq: number): Snapshot {
        return { data: serializeScreen(this.#screen, this.#serializer), cols: this.#screen.cols, rows: this.#screen.rows, outputSequence: seq };
    }

    /** The screen once the headless terminal has parsed every chunk read so far. */
    snapshot(): Promise<Snapshot> {
        this.#flush();
        const target = this.seqIn;
        if (this.seqApplied >= target) {
            try { return Promise.resolve(this.#serialize(target)); }
            catch (error) { return Promise.reject(error); }
        }
        return new Promise((resolve, reject) => this.#waiters.push({ seq: target, resolve, reject }));
    }

    write(data: string): void {
        if (!this.exited) this.#pty.write(data);
    }

    resize(cols: number, rows: number): void {
        this.cols = cols;
        this.rows = rows;
        this.#screen.resize(cols, rows);
        if (!this.exited) this.#pty.resize(cols, rows);
    }

    kill(signal: Signal = "SIGTERM"): void {
        if (!this.exited) this.#pty.kill(signal);
    }

    /** Frees the headless screen and deletes the raw log; the terminal must have exited. */
    dispose(): void {
        this.#disposed = true;
        for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error("terminal removed"));
        this.#screen.dispose();
        this.#log.remove();
    }
}
