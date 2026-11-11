/**
 * Where a node keeps its state: `~/.pika-node/`, or `$PIKA_NODE_HOME` (tests, side installs).
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";

export interface Paths {
    home: string;
    run: string;
    socket: string;
    pid: string;
    state: string;
    daemonLog: string;
    logs: string;
    config: string;
    identity: string;
    clients: string;
    pending: string;
}

export function paths(home = process.env.PIKA_NODE_HOME || join(homedir(), ".pika-node")): Paths {
    const run = join(home, "run");
    return {
        home,
        run,
        socket: join(run, "daemon.sock"),
        pid: join(run, "daemon.pid"),
        state: join(run, "state.json"),
        daemonLog: join(home, "daemon.log"),
        logs: join(home, "logs"),
        config: join(home, "config.json"),
        identity: join(home, "identity.json"),
        clients: join(home, "clients.json"),
        pending: join(home, "pending.json"),
    };
}

/** Creates the state directories with mode 0700 (and tightens them when they already exist). */
export function ensureDirs(p: Paths): void {
    for (const dir of [p.home, p.run, p.logs]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
    }
}

/** Writes a file atomically (temporary file in the same directory, then rename) with the given mode. */
export function writeAtomic(path: string, content: string, mode = 0o600): void {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, content, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
}
