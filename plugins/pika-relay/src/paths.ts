import { homedir } from "node:os";
import { join } from "node:path";

/** The broker's state: `${CODEX_HOME:-~/.codex}/pika-relay/`, or `PIKA_RELAY_CODEX_DIR`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    if (env.PIKA_RELAY_CODEX_DIR) return env.PIKA_RELAY_CODEX_DIR;
    return join(env.CODEX_HOME || join(homedir(), ".codex"), "pika-relay");
}

/** Pi's agent dir, where `pika.json` holds the server URL and device token. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export const socketPath = (dir: string) => join(dir, "broker.sock");
export const logPath = (dir: string) => join(dir, "broker.log");
export const pidPath = (dir: string) => join(dir, "broker.pid");

/** A thread id as a file name. */
export const fileName = (thread: string) => encodeURIComponent(thread);
export const inboxPath = (dir: string, thread: string) => join(dir, "inbox", `${fileName(thread)}.jsonl`);
/** Exists while a thread's inbox is not empty, so a hook can skip the broker cheaply. */
export const pendingPath = (dir: string, thread: string) => join(dir, "pending", fileName(thread));
