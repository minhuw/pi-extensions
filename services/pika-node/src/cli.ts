/**
 * `pika-node <command>`: start, stop, status, run, attach, clients, identity, server (NODE.md §3 "Enrolment", §6).
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { ensureDirs, paths as defaultPaths, VERSION, type Paths } from "./paths.ts";
import { displayFingerprint, encodeLine, PROTOCOL_VERSION } from "./protocol.ts";
import { runDaemon } from "./run.ts";
import { alive } from "./socket.ts";
import { allowPending, CREDENTIAL, loadConfig, loadIdentity, readClients, readPending, removeClient, saveConfig } from "./store.ts";

const USAGE = `pika-node ${VERSION}

  pika-node start                 start the daemon in the background
  pika-node stop                  stop the daemon and hang up every terminal
  pika-node status                daemon, server link, and terminals
  pika-node run                   run the daemon in the foreground
  pika-node attach                speak the inner protocol on stdio (ssh fallback); starts the daemon if needed
  pika-node clients [list]        allowed and pending client keys
  pika-node clients add <prefix>  allow the pending client whose fingerprint starts with <prefix> (≥ 20 hex)
  pika-node clients remove <prefix>
  pika-node identity              print the node fingerprint (alias: fingerprint)
  pika-node server <url>          set the pika server; reads the pkn_ node credential from stdin
  pika-node server clear          disconnect from the server

State lives in $PIKA_NODE_HOME (default ~/.pika-node).`;

const fail = (message: string): never => {
    process.stderr.write(`pika-node: ${message}\n`);
    process.exit(1);
};

function readPid(p: Paths): number | undefined {
    try {
        const pid = Number(readFileSync(p.pid, "utf8").trim());
        return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch { return undefined; }
}

const processAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Starts the daemon detached unless one answers already; resolves with its pid. */
export async function start(p: Paths, quiet = false): Promise<number> {
    if (await alive(p.socket)) {
        const pid = readPid(p) ?? 0;
        if (!quiet) process.stdout.write(`pika-node daemon already running (pid ${pid})\n`);
        return pid;
    }
    ensureDirs(p);
    const logFd = openSync(p.daemonLog, "a", 0o600);
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "run"], {
        detached: true, stdio: ["ignore", logFd, logFd], env: process.env, cwd: "/",
    });
    child.unref();
    let exited: number | null | undefined;
    child.once("exit", code => { exited = code; });
    for (let waited = 0; waited < 15_000; waited += 100) {
        if (await alive(p.socket)) {
            const pid = readPid(p) ?? child.pid!;
            if (!quiet) process.stdout.write(`pika-node daemon started (pid ${pid}); log ${p.daemonLog}\n`);
            return pid;
        }
        if (exited !== undefined) break;
        await sleep(100);
    }
    const tail = existsSync(p.daemonLog) ? readFileSync(p.daemonLog, "utf8").split("\n").slice(-15).join("\n") : "";
    return fail(`the daemon did not start${exited !== undefined ? ` (exit ${exited})` : ""}; ${p.daemonLog}:\n${tail}`);
}

async function stop(p: Paths): Promise<void> {
    const pid = readPid(p);
    if (!pid || !processAlive(pid)) {
        process.stdout.write("pika-node daemon is not running\n");
        return;
    }
    process.kill(pid, "SIGTERM");
    for (let waited = 0; waited < 10_000; waited += 100) {
        if (!processAlive(pid)) {
            process.stdout.write(`pika-node daemon ${pid} stopped\n`);
            return;
        }
        await sleep(100);
    }
    fail(`daemon ${pid} did not exit within 10 s`);
}

async function status(p: Paths): Promise<void> {
    if (!await alive(p.socket)) {
        process.stdout.write("pika-node daemon: not running\n");
        process.exitCode = 3;
        return;
    }
    const state = JSON.parse(readFileSync(p.state, "utf8")) as {
        pid: number; version: string; startedAt: number; terminals: number; liveTerminals: number; fingerprint: string;
        link: { state: string; url?: string; node?: string; nodeName?: string; error?: string; channels: number };
    };
    const link = state.link;
    process.stdout.write([
        `pika-node daemon: running (pid ${state.pid}, version ${state.version}, since ${new Date(state.startedAt).toISOString()})`,
        `socket: ${p.socket}`,
        `node fingerprint: ${displayFingerprint(state.fingerprint)}`,
        `terminals: ${state.liveTerminals} live, ${state.terminals - state.liveTerminals} exited`,
        `server: ${link.state}${link.url ? ` ${link.url}` : ""}${link.node ? ` as ${link.nodeName} (${link.node})` : ""}${link.error ? ` — ${link.error}` : ""}; ${link.channels} channels`,
    ].join("\n") + "\n");
}

async function attach(p: Paths): Promise<void> {
    await start(p, true);
    const socket = connect(p.socket);
    socket.once("error", error => fail(`cannot reach the daemon: ${error.message}`));
    socket.once("connect", () => {
        socket.write(encodeLine({ type: "hello", role: "client", version: VERSION, protocolVersion: PROTOCOL_VERSION }));
        process.stdin.pipe(socket);
        socket.pipe(process.stdout);
    });
    socket.once("close", () => process.exit(0));
}

async function clients(p: Paths, args: string[]): Promise<void> {
    const [action = "list", prefix] = args;
    if (action === "list") {
        const allowed = readClients(p).clients;
        const pending = readPending(p);
        const out = [`allowed (${allowed.length}):`];
        for (const row of allowed) out.push(`  ${displayFingerprint(row.fingerprint)}  ${row.label || "(no label)"}  added ${new Date(row.addedAt).toISOString()}`);
        out.push(`pending (${pending.length}):`);
        for (const row of pending) out.push(`  ${displayFingerprint(row.fingerprint)}  ${row.label || "(no label)"}  at ${new Date(row.at).toISOString()}`);
        process.stdout.write(`${out.join("\n")}\n`);
        return;
    }
    if (!prefix) fail(`usage: pika-node clients ${action} <fingerprint prefix>`);
    try {
        if (action === "add") {
            const key = allowPending(p, prefix!);
            const node = await loadIdentity(p);
            process.stdout.write([
                `allowed client: ${key.label || "(no label)"}`,
                `client fingerprint: ${key.fingerprint}`,
                `node fingerprint:   ${node.fingerprint}`,
                `                    ${displayFingerprint(node.fingerprint)}`,
                "Confirm in the browser that the node fingerprint matches before you continue.",
            ].join("\n") + "\n");
        } else if (action === "remove") {
            const key = removeClient(p, prefix!);
            process.stdout.write(`removed client ${key.label || "(no label)"} ${key.fingerprint}\n`);
        } else fail(`unknown clients action ${action}`);
    } catch (error) { fail((error as Error).message); }
}

async function server(p: Paths, args: string[]): Promise<void> {
    const [url] = args;
    if (!url) fail("usage: pika-node server <url> (credential on stdin) | pika-node server clear");
    ensureDirs(p);
    const config = loadConfig(p);
    if (url === "clear") {
        delete config.server;
        saveConfig(p, config);
        process.stdout.write("server cleared; restart the daemon to disconnect now\n");
        return;
    }
    if (!/^https?:\/\/[^/]+/.test(url!)) fail("the server URL must start with http:// or https://");
    let credential = process.env.PIKA_NODE_CREDENTIAL ?? "";
    if (!credential) {
        if (process.stdin.isTTY) process.stderr.write("node credential (from `pika node create`): ");
        for await (const chunk of process.stdin) credential += String(chunk);
    }
    credential = credential.trim();
    if (!CREDENTIAL.test(credential)) fail("that is not a pkn_ node credential");
    config.server = { url: url!.replace(/\/+$/, ""), credential };
    saveConfig(p, config);
    process.stdout.write(`server set to ${config.server.url}; a running daemon connects within 5 s or at its next retry\n`);
}

async function main(argv: string[]): Promise<void> {
    const p = defaultPaths();
    const [command, ...rest] = argv;
    switch (command) {
        case "start": await start(p); return;
        case "stop": return stop(p);
        case "status": return status(p);
        case "run": {
            const running = await runDaemon(p, { exitOnStop: true });
            if (!running) process.exit(0);
            return;
        }
        case "attach": return attach(p);
        case "clients": return clients(p, rest);
        case "identity":
        case "fingerprint": {
            ensureDirs(p);
            const identity = await loadIdentity(p);
            process.stdout.write(`${displayFingerprint(identity.fingerprint)}\n${identity.fingerprint}\n`);
            return;
        }
        case "server": return server(p, rest);
        case "--version":
        case "version": process.stdout.write(`${VERSION}\n`); return;
        case undefined:
        case "help":
        case "--help":
        case "-h": process.stdout.write(`${USAGE}\n`); return;
        default: fail(`unknown command ${command}\n\n${USAGE}`);
    }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
    main(process.argv.slice(2)).catch(error => fail((error as Error).stack ?? String(error)));
}
