/**
 * The daemon process (`pika-node run`, which `pika-node start` launches detached): the unix socket, the
 * server link, the pid and state files. It never exits on its own; `pika-node stop` (SIGTERM) hangs up every PTY.
 */
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { Daemon } from "./daemon.ts";
import { Link } from "./link.ts";
import { ensureDirs, paths as defaultPaths, VERSION, writeAtomic, type Paths } from "./paths.ts";
import { accept, bind } from "./socket.ts";
import { ensureSpawnHelper } from "./spawn.ts";
import { loadIdentity } from "./store.ts";

export const log = (line: string): void => { process.stderr.write(`${new Date().toISOString()} ${line}\n`); };

export interface Running { daemon: Daemon; link: Link; stop: (reason: string) => Promise<void> }

/** Starts the daemon in this process; undefined when another daemon already answers on the socket. */
export async function runDaemon(p: Paths = defaultPaths(), options: { exitOnStop?: boolean } = {}): Promise<Running | undefined> {
    ensureDirs(p);
    ensureSpawnHelper();
    const identity = await loadIdentity(p);
    let link: Link | undefined;
    const daemon = new Daemon({ paths: p, log, nodeId: () => link?.node ?? "local", nodeName: () => link?.nodeName || undefined });
    const server = createServer(socket => accept(daemon, socket, log));
    if (!await bind(server, p.socket)) {
        log(`another daemon answers on ${p.socket}; exiting`);
        await daemon.shutdown();
        return undefined;
    }
    writeAtomic(p.pid, `${process.pid}\n`);
    const startedAt = Date.now();
    link = new Link({ paths: p, daemon, identity, log });
    let stopped = false;
    const writeState = () => stopped || writeAtomic(p.state, `${JSON.stringify({
        version: VERSION, pid: process.pid, startedAt, socket: p.socket, fingerprint: identity.fingerprint,
        terminals: daemon.terminalCount, liveTerminals: daemon.liveTerminals, link: link!.state,
    }, null, 2)}\n`);
    link.onState = writeState;
    daemon.onTerminalsChanged = writeState;
    writeState();
    link.start();
    log(`pika-node ${VERSION} daemon ${process.pid} listening on ${p.socket}; node fingerprint ${identity.fingerprint}`);

    let stopping: Promise<void> | undefined;
    const stop = (reason: string): Promise<void> => stopping ??= (async () => {
        log(`stopping (${reason})`);
        stopped = true;
        link!.stop();
        server.close();
        await daemon.shutdown();
        try {
            if (readFileSync(p.pid, "utf8").trim() === String(process.pid)) {
                rmSync(p.pid, { force: true });
                rmSync(p.socket, { force: true });
                rmSync(p.state, { force: true });
            }
        } catch { /* gone */ }
        if (options.exitOnStop) process.exit(0);
    })();
    if (options.exitOnStop) {
        for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void stop(signal));
        process.on("SIGHUP", () => log("ignoring SIGHUP"));
        // A bug in one handler must not take every PTY down with the process.
        process.on("uncaughtException", error => log(`uncaught: ${error.stack ?? error}`));
        process.on("unhandledRejection", error => log(`unhandled: ${(error as Error)?.stack ?? error}`));
    }
    return { daemon, link, stop };
}
