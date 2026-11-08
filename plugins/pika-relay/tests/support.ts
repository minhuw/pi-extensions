import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { FakeRelay, TOKEN } from "../../../extensions/pika/tests/relay/support/relay-server.ts";
import { BrokerClient, connectBroker } from "../src/ipc.ts";
import { pidPath, socketPath } from "../src/paths.ts";

export { FakeRelay, TOKEN };

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

export const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DIST = join(PLUGIN, "dist");

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(check: () => T | Promise<T>, what: string, timeoutMs = 10_000): Promise<NonNullable<T>> {
    const started = Date.now();
    for (;;) {
        const value = await check();
        if (value) return value as NonNullable<T>;
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await sleep(25);
    }
}

/** A temp directory with the broker's state dir, Pi's agent dir, and a project cwd; short, for the socket path. */
export class Env {
    private constructor(readonly root: string) {}
    static async create(): Promise<Env> {
        const env = new Env(await mkdtemp(join(tmpdir(), "pcr-")));
        await mkdir(env.agentDir, { recursive: true });
        await mkdir(env.cwd, { recursive: true });
        return env;
    }
    get stateDir() { return join(this.root, "s"); }
    get agentDir() { return join(this.root, "agent"); }
    get cwd() { return join(this.root, "project"); }
    async configure(config: Record<string, unknown>): Promise<void> {
        await writeFile(join(this.agentDir, "pika.json"), JSON.stringify(config));
    }
    vars(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
        const vars: NodeJS.ProcessEnv = { ...process.env, PIKA_RELAY_CODEX_DIR: this.stateDir, PI_CODING_AGENT_DIR: this.agentDir, PIKA_RELAY_BROKER_IDLE_MS: "60000", ...extra };
        for (const name of ["PIKA_URL", "PIKA_TOKEN", "PIKA_DISABLED"]) if (!(name in extra)) delete vars[name];
        return vars;
    }
    brokerPid(): number | undefined {
        try { return Number(readFileSync(pidPath(this.stateDir), "utf8").trim()) || undefined; } catch { return undefined; }
    }
    async broker(): Promise<BrokerClient> {
        return new BrokerClient(await connectBroker(this.stateDir, { spawn: false, timeoutMs: 1_000 }));
    }
    /** The broker's view of its threads. */
    async inspect(): Promise<{ id: string; cwd?: string; state: string; hops: number; title?: string; connection: string; clients: number; waiters: number }[]> {
        const client = await this.broker();
        try { return await client.request("inspect"); } finally { client.close(); }
    }
    async stopBroker(): Promise<void> {
        const pid = this.brokerPid();
        if (existsSync(socketPath(this.stateDir))) {
            try {
                const client = await this.broker();
                await client.request("shutdown").catch(() => {});
                client.close();
            } catch { /* not running */ }
        }
        if (pid) {
            await waitFor(() => !alive(pid), "the broker to exit", 5_000).catch(() => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
        }
    }
    async cleanup(): Promise<void> {
        await this.stopBroker();
        await rm(this.root, { recursive: true, force: true });
    }
}

export function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Runs `dist/hook.js <event>` with `input` on stdin. */
export function runHook(env: Env, event: string, input: Record<string, unknown>, extra: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; output?: any }> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(DIST, "hook.js"), event], { env: env.vars({ PLUGIN_ROOT: PLUGIN, ...extra }), cwd: env.cwd });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => { stdout += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
            let output: unknown;
            try { output = stdout.trim() ? JSON.parse(stdout) : undefined; } catch { output = undefined; }
            resolve({ code, stdout, output });
        });
        child.stdin.end(JSON.stringify({ hook_event_name: event, turn_id: "turn-1", transcript_path: null, ...input }));
    });
}

export interface ToolResult { content: { type: string; text: string }[]; isError: boolean }

/** `dist/mcp.js` over stdio, as Codex spawns it. */
export class Mcp {
    readonly child: ChildProcessWithoutNullStreams;
    private next = 1;
    private buffer = "";
    readonly responses = new Map<number, { result?: any; error?: any }>();
    private readonly waiting = new Map<number, (value: { result?: any; error?: any }) => void>();

    constructor(env: Env) {
        this.child = spawn(process.execPath, ["./dist/mcp.js"], { cwd: PLUGIN, env: env.vars() });
        this.child.stdout.setEncoding("utf8");
        this.child.stdout.on("data", (chunk: string) => {
            this.buffer += chunk;
            for (let newline = this.buffer.indexOf("\n"); newline >= 0; newline = this.buffer.indexOf("\n")) {
                const line = this.buffer.slice(0, newline);
                this.buffer = this.buffer.slice(newline + 1);
                const message = JSON.parse(line) as { id: number; result?: unknown; error?: unknown };
                this.responses.set(message.id, message);
                this.waiting.get(message.id)?.(message);
            }
        });
    }

    send(message: Record<string, unknown>): void { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); }

    /** Sends a request; `id` is known at once, for a cancellation. */
    request(method: string, params?: Record<string, unknown>): { id: number; response: Promise<{ result?: any; error?: any }> } {
        const id = this.next++;
        const response = new Promise<{ result?: any; error?: any }>((resolve) => this.waiting.set(id, resolve));
        this.send({ id, method, ...(params ? { params } : {}) });
        return { id, response };
    }

    async initialize(): Promise<any> {
        const { response } = this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "test" } });
        const answer = await response;
        this.send({ method: "notifications/initialized" });
        return answer.result;
    }

    callAsync(thread: string, name: string, args: Record<string, unknown> = {}): { id: number; result: Promise<ToolResult> } {
        const { id, response } = this.request("tools/call", {
            name, arguments: args,
            _meta: { threadId: thread, sessionId: thread, callId: `call-${this.next}`, "x-codex-turn-metadata": { session_id: thread, thread_id: thread, turn_id: "turn-1", model: "gpt-5.5" } },
        });
        return { id, result: response.then((answer) => answer.result as ToolResult) };
    }

    async call(thread: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
        const result = await this.callAsync(thread, name, args).result;
        return { text: result.content.map((part) => part.text).join(""), isError: result.isError };
    }

    async close(): Promise<void> {
        if (this.child.exitCode !== null) return;
        const exited = new Promise((resolve) => this.child.once("exit", resolve));
        this.child.stdin.end();
        await Promise.race([exited, sleep(2_000).then(() => this.child.kill("SIGKILL"))]);
    }
}
