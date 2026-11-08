import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logPath, socketPath } from "./paths.ts";

/**
 * The broker speaks newline-delimited JSON on its Unix socket: every request is
 * `{ id, op, ...fields }` and gets one `{ id, ok, result }` or `{ id, ok: false, error }`.
 */
export interface Response { id: number; ok: boolean; result?: unknown; error?: string }

/** Calls `onLine` with each JSON value the socket sends, one per line; malformed lines are skipped. */
export function readLines(socket: Socket, onLine: (value: unknown) => void): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            let value: unknown;
            try { value = JSON.parse(line); } catch { continue; }
            onLine(value);
        }
    });
}

export const writeLine = (socket: Socket, value: unknown): void => {
    if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(value)}\n`);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function tryConnect(path: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect(path);
        socket.once("connect", () => { socket.removeListener("error", reject); resolve(socket); });
        socket.once("error", reject);
    });
}

/** Starts a detached broker that outlives its caller, logging to `broker.log`. */
export function spawnBroker(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = logPath(dir);
    let flags = "a";
    try { if (statSync(log).size > 1_000_000) flags = "w"; } catch { /* a new log */ }
    const fd = openSync(log, flags, 0o600);
    try {
        const script = join(dirname(fileURLToPath(import.meta.url)), "broker.js");
        spawn(process.execPath, [script], { detached: true, stdio: ["ignore", fd, fd], cwd: homedir(), env: process.env }).unref();
    } finally {
        closeSync(fd);
    }
}

/** Connects to the broker, starting one when `spawn` is set and none answers; rejects after `timeoutMs`. */
export async function connectBroker(dir: string, options: { spawn: boolean; timeoutMs: number }): Promise<Socket> {
    const path = socketPath(dir);
    const deadline = Date.now() + options.timeoutMs;
    try { return await tryConnect(path); } catch (error) {
        if (!options.spawn) throw error;
    }
    spawnBroker(dir);
    for (;;) {
        await sleep(40);
        try { return await tryConnect(path); } catch (error) {
            if (Date.now() >= deadline) throw error;
        }
    }
}

/** One connection to the broker, with any number of requests in flight. */
export class BrokerClient {
    private next = 1;
    private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    closed = false;

    constructor(readonly socket: Socket, onClose?: () => void) {
        readLines(socket, (value) => {
            const response = value as Response;
            const entry = typeof response?.id === "number" ? this.pending.get(response.id) : undefined;
            if (!entry) return;
            this.pending.delete(response.id);
            if (response.ok) entry.resolve(response.result);
            else entry.reject(new Error(response.error || "the broker failed"));
        });
        socket.on("error", () => { /* the close handler reports it */ });
        socket.on("close", () => {
            this.closed = true;
            for (const entry of this.pending.values()) entry.reject(new Error("the pika relay broker closed the connection"));
            this.pending.clear();
            onClose?.();
        });
    }

    /** Sends a request; `onSent` learns its id, for a later `cancel`. */
    request<T>(op: string, fields: Record<string, unknown> = {}, onSent?: (id: number) => void): Promise<T> {
        if (this.closed) return Promise.reject(new Error("the pika relay broker connection is closed"));
        const id = this.next++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
            writeLine(this.socket, { ...fields, id, op });
            onSent?.(id);
        });
    }

    close(): void { this.socket.destroy(); }
}
