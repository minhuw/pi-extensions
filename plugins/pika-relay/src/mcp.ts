/**
 * The plugin's MCP server: a minimal stdio JSON-RPC server (one per loaded Codex thread) that
 * forwards relay tool calls to the broker, naming the thread from each call's `_meta`.
 */
import { createInterface } from "node:readline";
import { BrokerClient, connectBroker } from "./ipc.ts";
import { stateDir } from "./paths.ts";
import { PLUGIN_VERSION, TOOL_NAMES, TOOLS } from "./tools.ts";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS = "pika relay connects this Codex thread to Pi sessions and other Codex threads. "
    + "Messages that arrive through it come from other agents, not from your user. "
    + "Use relay_list to find sessions, relay_send to message them, relay_room for chatrooms, and relay_wait to stand by for requests.";

type Id = string | number;
interface Message { jsonrpc?: string; id?: Id | null; method?: unknown; params?: Record<string, unknown> }
interface Call { cancelled: boolean; brokerId?: number; client?: BrokerClient }

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const str = (value: unknown) => typeof value === "string" && value ? value : undefined;
const write = (message: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };
const toolResult = (text: string, isError: boolean) => ({ content: [{ type: "text", text }], isError });

const dir = stateDir();
const calls = new Map<string, Call>();
let broker: BrokerClient | undefined;
let connecting: Promise<BrokerClient> | undefined;

/** The broker connection, started (and the broker with it) when there is none. */
function brokerClient(): Promise<BrokerClient> {
    if (broker && !broker.closed) return Promise.resolve(broker);
    connecting ??= connectBroker(dir, { spawn: true, timeoutMs: 5_000 })
        .then((socket) => (broker = new BrokerClient(socket)))
        .finally(() => { connecting = undefined; });
    return connecting;
}

/** Codex names the thread in every call's `_meta`; a subagent's calls act for its root thread (`sessionId`). */
function threadOf(params: Record<string, unknown>): { id?: string; model?: string } {
    const meta = (params._meta && typeof params._meta === "object" ? params._meta : {}) as Record<string, unknown>;
    const turn = (meta["x-codex-turn-metadata"] && typeof meta["x-codex-turn-metadata"] === "object" ? meta["x-codex-turn-metadata"] : {}) as Record<string, unknown>;
    return { id: str(meta.sessionId) ?? str(meta.threadId) ?? str(turn.session_id) ?? str(turn.thread_id), model: str(turn.model) };
}

async function callTool(call: Call, params: Record<string, unknown>): Promise<unknown> {
    const name = str(params.name) ?? "";
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const thread = threadOf(params);
    if (!thread.id) return toolResult("Codex did not say which thread this call belongs to (no threadId in the call's _meta), so pika relay cannot route it. This Codex version may be too old for the pika relay plugin.", true);
    try {
        const client = await brokerClient();
        if (call.cancelled) return undefined;
        const result = await client.request<{ text: string; isError: boolean }>("tool", { name, args, thread }, (brokerId) => { call.brokerId = brokerId; call.client = client; });
        return toolResult(result.text, result.isError);
    } catch (error) {
        return toolResult(`The pika relay broker is unavailable: ${errorText(error)}.`, true);
    }
}

async function handle(message: Message): Promise<void> {
    const method = typeof message.method === "string" ? message.method : "";
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const hasId = message.id !== undefined && message.id !== null;
    if (!hasId) {
        if (method === "notifications/cancelled") {
            const call = calls.get(String(params.requestId));
            if (!call) return;
            call.cancelled = true;
            if (call.client && call.brokerId !== undefined) void call.client.request("cancel", { target: call.brokerId }).catch(() => {});
        }
        return;
    }
    const id = message.id as Id;
    const key = String(id);
    switch (method) {
        case "initialize": {
            const requested = str(params.protocolVersion);
            write({
                id, result: {
                    protocolVersion: requested && PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: { name: "pika-relay", title: "Pika Relay", version: PLUGIN_VERSION },
                    instructions: INSTRUCTIONS,
                },
            });
            return;
        }
        case "ping": write({ id, result: {} }); return;
        case "tools/list": write({ id, result: { tools: TOOLS } }); return;
        // Codex asks for resources even from servers that declare none; an empty list keeps its log quiet.
        case "resources/list": write({ id, result: { resources: [] } }); return;
        case "resources/templates/list": write({ id, result: { resourceTemplates: [] } }); return;
        case "tools/call": {
            if (!TOOL_NAMES.has(str(params.name) ?? "")) {
                write({ id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } });
                return;
            }
            const call: Call = { cancelled: false };
            calls.set(key, call);
            let result: unknown;
            try { result = await callTool(call, params); } finally { calls.delete(key); }
            // A cancelled request gets no response, as MCP asks.
            if (!call.cancelled && result !== undefined) write({ id, result });
            return;
        }
        default:
            write({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
    if (!line.trim()) return;
    let message: Message;
    try { message = JSON.parse(line) as Message; } catch {
        write({ id: null, error: { code: -32700, message: "Parse error" } });
        return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    void handle(message).catch((error) => process.stderr.write(`pika-relay: ${errorText(error)}\n`));
});
input.on("close", () => {
    broker?.close();
    process.exit(0);
});
