/**
 * `node dist/hook.js <event>`: the plugin's Codex hooks. Each reads the hook's JSON from stdin and
 * asks the broker what to tell Codex, within `BUDGET_MS`; on any failure it prints the no-op
 * answer (`{}` for Stop, nothing otherwise) and exits 0, so relay never gets in the thread's way.
 */
import { existsSync } from "node:fs";
import { isExcluded, loadConfig } from "../../../extensions/pika/config.ts";
import { BrokerClient, connectBroker } from "./ipc.ts";
import { agentDir, pendingPath, stateDir } from "./paths.ts";

const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);
const BUDGET_MS = 1_500;
const started = Date.now();
const event = process.argv[2] ?? "";
let finished = false;

function finish(output: unknown): void {
    if (finished) return;
    finished = true;
    const body = output && typeof output === "object" ? JSON.stringify(output) : event === "Stop" ? "{}" : "";
    if (!body) process.exit(0);
    process.stdout.write(`${body}\n`, () => process.exit(0));
}

setTimeout(() => finish(null), BUDGET_MS);

async function readStdin(): Promise<string> {
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) raw += chunk;
    return raw;
}

async function main(): Promise<void> {
    if (!EVENTS.has(event)) return finish(null);
    const input = JSON.parse(await readStdin()) as Record<string, unknown>;
    const id = typeof input.session_id === "string" ? input.session_id : "";
    if (!id) return finish(null);
    const dir = stateDir();
    // PostToolUse runs after every tool call: without waiting messages it never touches the broker.
    if (event === "PostToolUse" && !existsSync(pendingPath(dir, id))) return finish(null);
    const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : undefined;
    const config = loadConfig(agentDir());
    const active = config.enabled && !(cwd && isExcluded(cwd, config.config.exclude));
    // An inactive thread starts no broker; a running one still hears of it, to take the thread offline.
    const socket = await connectBroker(dir, { spawn: active && event !== "SessionEnd", timeoutMs: Math.max(100, BUDGET_MS - 200 - (Date.now() - started)) });
    const client = new BrokerClient(socket);
    const fields = {
        session_id: id,
        ...(cwd ? { cwd } : {}),
        ...(typeof input.model === "string" ? { model: input.model } : {}),
        ...(event === "UserPromptSubmit" && typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
    };
    const result = await client.request("hook", { event, input: fields });
    client.close();
    finish(result);
}

main().catch(() => finish(null));
