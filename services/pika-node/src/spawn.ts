/**
 * The clean login environment and command of a terminal (NODE.md, "Spawning"). The daemon's own environment is
 * not trusted: it may come from a non-login ssh command or a service manager with a stripped PATH.
 */
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { PANE_ENV, PROGRAM_STATUS_ENV, SOCKET_ENV } from "./protocol.ts";

export class SpawnError extends Error {}

/** Names a client's `env` may not set; `__*` guards such as `__ETC_PROFILE_NIX_SOURCED` never reach a PTY. */
export const reservedEnv = (name: string): boolean => name.startsWith("PIKA_NODE_") || name === PROGRAM_STATUS_ENV || name.startsWith("ORCA_") || name.startsWith("__");

export interface Account { home: string; user: string; shell: string }

export function account(): Account {
    const info = userInfo();
    if (!info.shell) throw new SpawnError("the passwd entry has no login shell");
    return { home: info.homedir, user: info.username, shell: info.shell };
}

export function spawnEnv(options: { account: Account; socket: string; paneId: string; env?: Record<string, string>; lang?: string | undefined }): Record<string, string> {
    const { home, user, shell } = options.account;
    const env: Record<string, string> = {
        HOME: home,
        USER: user,
        LOGNAME: user,
        SHELL: shell,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: options.lang || "C.UTF-8",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "pika-node",
        [PROGRAM_STATUS_ENV]: "1",
        [SOCKET_ENV]: options.socket,
        [PANE_ENV]: options.paneId,
    };
    for (const [name, value] of Object.entries(options.env ?? {})) {
        if (reservedEnv(name)) throw new SpawnError(`env may not set ${name}`);
        env[name] = value;
    }
    return env;
}

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "ksh", "mksh", "dash", "ash", "yash", "oksh", "loksh"]);

/**
 * `[shell, "-l"]`, or a requested argv run through the login shell so the profile builds PATH first. fish has its
 * own `exec $argv[2..]`; any other shell that is not POSIX runs the argv through `/bin/sh -l`.
 */
export function spawnCommand(shell: string, argv?: string[]): { file: string; args: string[] } {
    if (!argv?.length) return { file: shell, args: ["-l"] };
    const name = basename(shell);
    if (name === "fish") return { file: shell, args: ["-l", "-c", "exec $argv[2..]", "pika-node", ...argv] };
    return { file: POSIX_SHELLS.has(name) ? shell : "/bin/sh", args: ["-l", "-c", 'exec "$@"', "pika-node", ...argv] };
}

/**
 * node-pty's prebuilt `spawn-helper` (macOS) ships without its execute bit when npm skips install scripts,
 * and every spawn then fails with `posix_spawnp failed`. Restores the bit, or throws when it cannot.
 */
export function ensureSpawnHelper(): void {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve("node-pty/package.json"));
    for (const dir of [join(root, "build", "Release"), join(root, "prebuilds", `${process.platform}-${process.arch}`)]) {
        const helper = join(dir, "spawn-helper");
        if (!existsSync(helper)) continue;
        try { accessSync(helper, constants.X_OK); }
        catch { chmodSync(helper, statSync(helper).mode | 0o111); }
    }
}
