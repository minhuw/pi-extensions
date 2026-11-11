/**
 * The daemon's unix socket `~/.pika-node/run/daemon.sock` (NODE.md §5–6): NDJSON, first a `hello` with
 * `role: "bridge"` (a pi extension in a pane) or `role: "client"` (`pika-node attach` over ssh, inner messages
 * without the E2E layer).
 */
import { closeSync, openSync, rmSync, statSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { Daemon, Peer } from "./daemon.ts";
import { asNodeError } from "./errors.ts";
import { VERSION } from "./paths.ts";
import {
    encodeLine, LineDecoder, LineTooLong, parseBridgeMessage, parseJson, PROTOCOL_VERSION,
    type BridgeMessage, type DaemonToBridge, type NodeMessage,
} from "./protocol.ts";

const HELLO_TIMEOUT_MS = 10_000;

class SocketPeer implements Peer {
    readonly name: string;
    #socket: Socket;
    constructor(socket: Socket, name: string) {
        this.#socket = socket;
        this.name = name;
    }
    get closed(): boolean { return this.#socket.destroyed || !this.#socket.writable; }
    send(message: NodeMessage): void {
        if (!this.closed) this.#socket.write(encodeLine(message));
    }
    buffered(): number { return this.#socket.writableLength; }
}

let connections = 0;

/** Serves one socket connection until it closes. */
export function accept(daemon: Daemon, socket: Socket, log: (line: string) => void): void {
    const decoder = new LineDecoder();
    const name = `socket#${++connections}`;
    let role: { kind: "client"; peer: SocketPeer } | { kind: "bridge"; paneId: string; token: object } | undefined;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const write = (message: DaemonToBridge) => { if (!socket.destroyed) socket.write(encodeLine(message)); };

    const onHello = (message: Extract<BridgeMessage, { type: "hello" }>): void => {
        clearTimeout(helloTimer);
        if (message.protocolVersion !== PROTOCOL_VERSION) {
            write({ type: "reply", id: "hello", error: { code: "unsupported_version", message: `this daemon speaks protocol ${PROTOCOL_VERSION}` } });
            socket.end();
            return;
        }
        if (message.role === "client") {
            role = { kind: "client", peer: new SocketPeer(socket, `${name} (attach)`) };
            daemon.addPeer(role.peer);
            return;
        }
        const token = {};
        try { daemon.bridgeHello(message.paneId, token); }
        catch (error) {
            const failure = asNodeError(error);
            write({ type: "reply", id: "hello", error: { code: failure.code, message: failure.message } });
            socket.end();
            return;
        }
        role = { kind: "bridge", paneId: message.paneId, token };
        write({ type: "welcome", version: VERSION, protocolVersion: PROTOCOL_VERSION });
    };

    const onBridge = (bridge: { paneId: string; token: object }, message: BridgeMessage): void => {
        switch (message.type) {
            case "status": return daemon.bridgeStatus(bridge.paneId, bridge.token, message.status);
            case "open":
            case "diff":
                try { write({ type: "reply", id: message.id, result: { delivered: daemon.bridgeRequest(bridge.paneId, bridge.token, message) } }); }
                catch (error) {
                    const failure = asNodeError(error);
                    write({ type: "reply", id: message.id, error: { code: failure.code, message: failure.message } });
                }
                return;
            case "hello": return;
        }
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
        let lines: string[];
        try { lines = decoder.push(chunk); }
        catch (error) {
            if (error instanceof LineTooLong) log(`${name}: ${error.message}; closing`);
            socket.destroy();
            return;
        }
        for (const line of lines) {
            const value = parseJson(line);
            if (role?.kind === "client") { daemon.handle(role.peer, value); continue; }
            const parsed = parseBridgeMessage(value);
            if (!role) {
                if (!parsed.ok || parsed.message.type !== "hello") {
                    log(`${name}: first line is not a valid hello; closing`);
                    socket.destroy();
                    return;
                }
                onHello(parsed.message);
                continue;
            }
            if (parsed.ok) onBridge(role, parsed.message);
        }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
        clearTimeout(helloTimer);
        if (role?.kind === "client") daemon.removePeer(role.peer);
        else if (role?.kind === "bridge") daemon.bridgeClosed(role.paneId, role.token);
    });
}

// ---------------------------------------------------------------------------------------------------------------
// Binding (after plugins/pika-relay/src/broker.ts)

function listen(server: Server, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
        const onListening = () => { server.removeListener("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(path);
    });
}

/** Whether a daemon answers on `path`. */
export function alive(path: string): Promise<boolean> {
    return new Promise(resolve => {
        const socket = connect(path);
        const done = (value: boolean) => { socket.destroy(); resolve(value); };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        setTimeout(() => done(false), 1_000).unref();
    });
}

/**
 * Binds the daemon socket; false when another daemon answers on it. A socket file nobody answers on is stale:
 * it is replaced under `daemon.sock.lock`, so two daemons starting at once cannot each replace the other's.
 */
export async function bind(server: Server, path: string): Promise<boolean> {
    const lock = `${path}.lock`;
    for (let attempt = 0; attempt < 100; attempt++) {
        try { await listen(server, path); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
        if (await alive(path)) return false;
        let fd: number;
        try { fd = openSync(lock, "wx", 0o600); }
        catch {
            try { if (Date.now() - statSync(lock).mtimeMs > 5_000) unlinkSync(lock); } catch { /* gone */ }
            await sleep(50);
            continue;
        }
        try {
            if (await alive(path)) return false;
            rmSync(path, { force: true });
            try { await listen(server, path); return true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
        } finally {
            closeSync(fd);
            rmSync(lock, { force: true });
        }
    }
    throw new Error(`could not bind ${path}`);
}

export { createServer };
