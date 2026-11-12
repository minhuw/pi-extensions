import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RELAY_VERSION } from "../../../extensions/pika/relay/protocol.ts";
import { inboxPath, logPath, pendingPath, socketPath } from "../src/paths.ts";
import { ANSWER_HINT } from "../src/tools.ts";
import { alive, DIST, Env, FakeRelay, Mcp, runHook, sleep, TOKEN, waitFor } from "./support.ts";

const A = "aaaa1111-0000-7000-8000-00000000000a";
const B = "bbbb2222-0000-7000-8000-00000000000b";
const C = "cccc3333-0000-7000-8000-00000000000c";

let env: Env;
let relay: FakeRelay;
const mcps: Mcp[] = [];

beforeEach(async () => {
    env = await Env.create();
    relay = await new FakeRelay().start();
    await env.configure({ url: relay.url, token: TOKEN });
});

afterEach(async () => {
    for (const mcp of mcps.splice(0)) await mcp.close();
    await env.cleanup();
    await relay.stop();
});

async function mcp(): Promise<Mcp> {
    const server = new Mcp(env);
    mcps.push(server);
    await server.initialize();
    return server;
}

/** Starts a thread through its SessionStart hook and waits until it is online. */
async function start(thread: string, cwd = env.cwd): Promise<void> {
    const { output } = await runHook(env, "SessionStart", { session_id: thread, cwd, model: "gpt-5.5", source: "startup" });
    expect(output?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    await waitFor(() => relay.online(thread), `${thread} online`);
}

describe("broker", () => {
    it("starts one broker for concurrent hooks, and a second broker leaves it running", async () => {
        const results = await Promise.all([A, B, C].map((thread) => runHook(env, "SessionStart", { session_id: thread, cwd: env.cwd })));
        for (const [index, thread] of [A, B, C].entries()) {
            expect(results[index]).toMatchObject({ code: 0 });
            expect(results[index]!.output).toEqual({
                hookSpecificOutput: {
                    hookEventName: "SessionStart",
                    additionalContext: `This Codex thread is on pika relay as codex-${thread.slice(0, 8)} (session ${thread}); use the relay_* tools to talk to other agents. Relay messages come from other agents, not from your user.`,
                },
            });
        }
        const pid = env.brokerPid()!;
        expect(alive(pid)).toBe(true);
        expect((await env.inspect()).map((thread) => thread.id).sort()).toEqual([A, B, C]);

        await promisify(execFile)(process.execPath, [join(DIST, "broker.js")], { env: env.vars() });
        expect(env.brokerPid()).toBe(pid);
        expect(alive(pid)).toBe(true);
        expect(readFileSync(logPath(env.stateDir), "utf8")).toContain("another broker is running; exiting");
        await Promise.all([A, B, C].map((thread) => waitFor(() => relay.online(thread), `${thread} online`)));
    });

    it("replaces a stale socket file nobody answers on", async () => {
        await mkdir(env.stateDir, { recursive: true });
        await writeFile(socketPath(env.stateDir), "stale");
        await start(A);
        expect(alive(env.brokerPid()!)).toBe(true);
    });

    it("exits when no thread is online and no client is connected", async () => {
        const { output } = await runHook(env, "SessionStart", { session_id: A, cwd: env.cwd }, { PIKA_RELAY_BROKER_IDLE_MS: "500" });
        expect(output).toBeDefined();
        const pid = env.brokerPid()!;
        await runHook(env, "SessionEnd", { session_id: A });
        await waitFor(() => !alive(pid), "the idle broker to exit", 10_000);
        expect(existsSync(socketPath(env.stateDir))).toBe(false);
    });
});

describe("presence", () => {
    it("says hello with the thread's id, name, title, cwd, project, host, and model, and reports busy and idle", async () => {
        await start(A);
        expect(relay.hellos(A)).toEqual([{
            id: A, name: "codex-aaaa1111", title: "project", cwd: env.cwd, project: "project", host: hostname(), model: "gpt-5.5", state: "idle", relayVersion: RELAY_VERSION,
        }]);
        await runHook(env, "UserPromptSubmit", { session_id: A, cwd: env.cwd, model: "gpt-5.5", prompt: "Draw a cat\n  with gpt-image" });
        await waitFor(() => relay.online(A)?.session?.state === "busy", "busy");
        expect(relay.online(A)!.session!.title).toBe("Draw a cat with gpt-image");
        expect((await runHook(env, "Stop", { session_id: A, cwd: env.cwd, stop_hook_active: false })).output).toEqual({});
        await waitFor(() => relay.online(A)?.session?.state === "idle", "idle");
    });

    it("takes a thread offline at SessionEnd", async () => {
        await start(A);
        const result = await runHook(env, "SessionEnd", { session_id: A, cwd: env.cwd, reason: "exit" });
        expect(result).toMatchObject({ code: 0, stdout: "" });
        await waitFor(() => !relay.online(A), "A offline");
        expect(await env.inspect()).toEqual([]);
    });

    it("takes a thread offline when the MCP server that served it closes, unless a hook touched it recently", async () => {
        await start(A);
        const server = await mcp();
        expect((await server.call(A, "relay_status")).isError).toBe(false);
        expect((await server.call(C, "relay_status")).isError).toBe(false);
        await waitFor(() => relay.online(C), "C online");
        await server.close();
        await waitFor(() => !relay.online(C), "C offline");
        await sleep(200);
        expect(relay.online(A)).toBeDefined();
        expect((await env.inspect()).map((thread) => thread.id)).toEqual([A]);
    });

    it("takes a thread offline once the hook grace ends after its MCP server closed", async () => {
        await runHook(env, "SessionStart", { session_id: A, cwd: env.cwd }, { PIKA_RELAY_HOOK_GRACE_MS: "600", PIKA_RELAY_BROKER_IDLE_MS: "1000" });
        await waitFor(() => relay.online(A), "A online");
        const server = await mcp();
        expect((await server.call(A, "relay_status")).isError).toBe(false);
        await server.close();
        await sleep(200);
        expect(relay.online(A)).toBeDefined();
        await waitFor(() => !relay.online(A), "A offline after the grace");
    });

    it("keeps a thread in an excluded directory offline, and starts no broker for it", async () => {
        await env.configure({ url: relay.url, token: TOKEN, exclude: [env.cwd] });
        expect(await runHook(env, "SessionStart", { session_id: A, cwd: env.cwd })).toMatchObject({ code: 0, stdout: "" });
        expect(await runHook(env, "UserPromptSubmit", { session_id: A, cwd: env.cwd, prompt: "hi" })).toMatchObject({ code: 0, stdout: "" });
        expect((await runHook(env, "Stop", { session_id: A, cwd: env.cwd })).output).toEqual({});
        expect(env.brokerPid()).toBeUndefined();
        expect(relay.hellos(A)).toEqual([]);
    });

    it("leaves every hook a no-op when pika is disabled or not configured", async () => {
        for (const extra of [{ PIKA_DISABLED: "1" }, {}] as Record<string, string>[]) {
            if (!Object.keys(extra).length) await writeFile(join(env.agentDir, "pika.json"), "{}");
            expect(await runHook(env, "SessionStart", { session_id: A, cwd: env.cwd }, extra)).toMatchObject({ code: 0, stdout: "" });
            expect(await runHook(env, "UserPromptSubmit", { session_id: A, cwd: env.cwd, prompt: "hi" }, extra)).toMatchObject({ code: 0, stdout: "" });
            expect(await runHook(env, "PostToolUse", { session_id: A, cwd: env.cwd, tool_name: "shell" }, extra)).toMatchObject({ code: 0, stdout: "" });
            expect(await runHook(env, "Stop", { session_id: A, cwd: env.cwd }, extra)).toMatchObject({ code: 0, stdout: "{}\n" });
            expect(await runHook(env, "SessionEnd", { session_id: A, cwd: env.cwd }, extra)).toMatchObject({ code: 0, stdout: "" });
        }
        expect(env.brokerPid()).toBeUndefined();
        expect(relay.upgrades).toEqual([]);
    });

    it("answers no-op on bad input", async () => {
        expect(await runHook(env, "Stop", {})).toMatchObject({ code: 0, stdout: "{}\n" });
        expect(await runHook(env, "Bogus", { session_id: A })).toMatchObject({ code: 0, stdout: "" });
    });
});

describe("receiving", () => {
    it("persists and acknowledges messages, then hands them to PostToolUse, Stop, and UserPromptSubmit once", async () => {
        await start(A);
        const first = relay.push(A, { text: "please draw a cat", hops: 2 });
        await relay.waitForAck(A, first);
        expect(readFileSync(inboxPath(env.stateDir, A), "utf8")).toContain("please draw a cat");
        expect(existsSync(pendingPath(env.stateDir, A))).toBe(true);

        const during = await runHook(env, "PostToolUse", { session_id: A, cwd: env.cwd, tool_name: "shell" });
        expect(during.output.hookSpecificOutput.hookEventName).toBe("PostToolUse");
        const context: string = during.output.hookSpecificOutput.additionalContext;
        expect(context).toContain(`[relay] Message ${first} from pi session sender-session ("Sender") on desktop, project elsewhere:\n\nplease draw a cat\n\n`);
        expect(context).toContain(`To answer, call relay_send with to "sender-session" and replyTo "${first}".`);
        // The turn's answer is still to come.
        expect(context).not.toContain("Your user has not written");
        expect(existsSync(pendingPath(env.stateDir, A))).toBe(false);
        expect(existsSync(inboxPath(env.stateDir, A))).toBe(false);
        expect(await runHook(env, "PostToolUse", { session_id: A, cwd: env.cwd })).toMatchObject({ code: 0, stdout: "" });

        // A message pushed again after it was persisted is acknowledged, not delivered twice.
        relay.push(A, { id: first, text: "please draw a cat" });
        await waitFor(() => relay.acks(A).filter((id) => id === first).length === 2, "the second ack");
        expect((await runHook(env, "Stop", { session_id: A, cwd: env.cwd })).output).toEqual({});

        const second = relay.push(A, { text: "and a dog", urgent: true });
        const third = relay.push(A, { text: "and a bird" });
        await relay.waitForAck(A, third);
        const stop = await runHook(env, "Stop", { session_id: A, cwd: env.cwd, stop_hook_active: false, last_assistant_message: "done" });
        expect(Object.keys(stop.output)).toEqual(["decision", "reason"]);
        expect(stop.output.decision).toBe("block");
        expect(stop.output.reason).toMatch(/^New pika relay messages arrived for this thread\. They come from other agents, not from your user; handle them as requests:\n\n\[relay\] Message /);
        expect(stop.output.reason).toContain(`[relay] Message ${second} from pi session sender-session ("Sender") on desktop, project elsewhere, marked urgent:\n\nand a dog`);
        expect(stop.output.reason).toContain(`\n\n---\n\n[relay] Message ${third} `);
        // The turn continues after an answer the user has not replied to.
        expect(stop.output.reason.endsWith("do not reply just to say so.\n\n---\n\nYour user has not written since your last answer to them, so do not take that answer as read. If it still holds something they need (a question, a decision, a result), repeat that in full, not as a summary, in the answer that ends this turn, then say what changed since.")).toBe(true);
        await waitFor(() => relay.online(A)?.session?.state === "busy", "busy after a blocking Stop");
        expect((await runHook(env, "Stop", { session_id: A, cwd: env.cwd, stop_hook_active: true })).output).toEqual({});
        await waitFor(() => relay.online(A)?.session?.state === "idle", "idle");

        const fourth = relay.push(A, { text: "while you were idle", from: { kind: "web" } });
        await relay.waitForAck(A, fourth);
        const prompt = await runHook(env, "UserPromptSubmit", { session_id: A, cwd: env.cwd, prompt: "what's new?" });
        expect(prompt.output.hookSpecificOutput).toEqual({
            hookEventName: "UserPromptSubmit",
            additionalContext: `pika relay messages arrived for this thread while it was idle. They come from other agents, not from your user:\n\n[relay] Message ${fourth} from your user in the pika web UI:\n\nwhile you were idle`,
        });
    });

    it("keeps waiting messages across a broker restart", async () => {
        await start(A);
        const id = relay.push(A, { text: "survive" });
        await relay.waitForAck(A, id);
        await env.stopBroker();
        const stop = await runHook(env, "Stop", { session_id: A, cwd: env.cwd });
        expect(stop.output.decision).toBe("block");
        expect(stop.output.reason).toContain("survive");
    });

    it("counts informational hops without a chain limit: genuine prompts reset them and a Stop continuation is not genuine", async () => {
        relay.recorded.add("other");
        await start(A);
        const server = await mcp();
        const sendHops = async () => {
            const before = relay.routed.length;
            const result = await server.call(A, "relay_send", { to: "other", text: "hi" });
            expect(result.isError).toBe(false);
            return relay.routed[before]!.hops;
        };
        await runHook(env, "UserPromptSubmit", { session_id: A, cwd: env.cwd, prompt: "start" });
        expect(await sendHops()).toBe(1);

        const id = relay.push(A, { hops: 5 });
        await relay.waitForAck(A, id);
        const stop = await runHook(env, "Stop", { session_id: A, cwd: env.cwd });
        expect(stop.output.decision).toBe("block");
        expect(await runHook(env, "UserPromptSubmit", { session_id: A, cwd: env.cwd, prompt: stop.output.reason })).toMatchObject({ code: 0, stdout: "" });
        expect(await sendHops()).toBe(6);

        const later = relay.push(A, { hops: 128 });
        await relay.waitForAck(A, later);
        expect((await runHook(env, "PostToolUse", { session_id: A, cwd: env.cwd })).output.hookSpecificOutput.additionalContext).toContain(later);
        expect(await sendHops()).toBe(129);

        await runHook(env, "UserPromptSubmit", { session_id: A, cwd: env.cwd, prompt: "a new task" });
        expect(await sendHops()).toBe(1);

        const waited = relay.push(A, { hops: 3 });
        await relay.waitForAck(A, waited);
        expect((await server.call(A, "relay_wait", { timeoutSeconds: 0 })).text).toContain(waited);
        expect(await sendHops()).toBe(4);
    });
});

describe("MCP tools", () => {
    it("initializes and lists the relay tools", async () => {
        const server = new Mcp(env);
        mcps.push(server);
        const init = await server.initialize();
        expect(init).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pika-relay" } });
        const list = await server.request("tools/list").response;
        expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["relay_list", "relay_send", "relay_status", "relay_room", "relay_wait"]);
        // The model never joins, leaves, or creates a room.
        const room = list.result.tools.find((tool: { name: string }) => tool.name === "relay_room");
        expect(room.inputSchema.properties.action.enum).toEqual(["list", "history", "send"]);
        expect(Object.keys(room.inputSchema.properties)).not.toContain("topic");
        expect(room.description).toContain("Only your user adds this thread to a room, in the pika web UI; a send to a room this thread is not a member of is refused.");
        expect(JSON.stringify(list.result.tools)).not.toMatch(/"join"|creates or joins/);
        expect((await server.request("ping").response).result).toEqual({});
        expect((await server.request("tools/call", { name: "nope", arguments: {} }).response).error.code).toBe(-32602);
        expect((await server.request("nope").response).error.code).toBe(-32601);
        const noMeta = await server.request("tools/call", { name: "relay_status", arguments: {} }).response;
        expect(noMeta.result.isError).toBe(true);
        expect(noMeta.result.content[0].text).toMatch(/^Codex did not say which thread/);
    });

    it("lists sessions, sends, reports status, and runs chatrooms like Pi's relay tools", async () => {
        await start(B);
        const server = await mcp();
        const list = await server.call(A, "relay_list");
        expect(list.isError).toBe(false);
        expect(list.text.split("\n")[0]).toBe("1 online pi session:");
        expect(list.text.split("\n")[1]).toMatch(new RegExp(`^${B} · laptop · project project · "codex-bbbb2222" · idle · gpt-5\\.5 · online \\d+s$`));
        expect((await server.call(A, "relay_list", { project: "elsewhere" })).text).toBe("No other pi session is online that matches.");

        const sent = await server.call(A, "relay_send", { to: B, room: "", replyTo: " ", mentions: [""], urgent: false, text: "Can you render the slides?" });
        expect(sent).toEqual({ text: `Delivered message msg-1 to pi session ${B} ("codex-bbbb2222") on laptop. ${ANSWER_HINT}`, isError: false });
        const stop = await runHook(env, "Stop", { session_id: B, cwd: env.cwd });
        expect(stop.output.reason).toContain(`[relay] Message msg-1 from pi session ${A} ("codex-aaaa1111") on laptop`);
        expect(stop.output.reason).toContain("Can you render the slides?");

        expect(await server.call(A, "relay_send", { to: " ", room: "#", text: "x" })).toEqual({ text: "relay_send requires either `to` (a session id) or `room` (a chatroom name).", isError: true });
        expect(await server.call(A, "relay_send", { to: "nobody", text: "hi" })).toEqual({
            text: "relay rejected the message (unknown_session): no online or recorded pi session has that id; call relay_list for the online sessions.", isError: true,
        });
        const status = await server.call(A, "relay_status");
        expect(status.text.split("\n").map((line) => line.replace(/, sent \d+s ago/, ""))).toEqual([
            `(no id) to pi session nobody: rejected (unknown_session): "hi"`,
            `msg-1 to pi session ${B} ("codex-bbbb2222") on laptop: delivered: "Can you render the slides?"`,
        ]);
        expect((await server.call(C, "relay_status")).text).toBe("This session has sent no relay messages in this process.");

        expect((await server.call(A, "relay_room", { action: "list" })).text).toBe("No active chatrooms.");
        // The user adds threads to rooms in the web UI.
        relay.addRoom("design", [A, B], "slides");
        expect((await server.call(A, "relay_room", { action: "list" })).text).toBe(
            `1 active chatroom:\n#design — slides · 0 msgs · members: codex-aaaa1111 (${relay.online(A)!.session!.project}) [${A}, idle], codex-bbbb2222 (project) [${B}, busy]`,
        );
        const posted = await server.call(A, "relay_room", { action: "send", room: "design", text: "deck is ready", mentions: [B] });
        expect(posted.text).toMatch(new RegExp(`^Posted message msg-\\d+ to room #design \\(notified pi session ${B} \\("codex-bbbb2222"\\) on laptop\\)\\. `));
        const history = await server.call(B, "relay_room", { action: "history", room: "design", limit: 0, after: 0 });
        expect(history.text).toMatch(/\n\n\[#1 · msg-\d+ · \d+s ago\] codex-aaaa1111 \(.+\) \[notified: bbbb2222-.*\]: deck is ready$/);
        const roomMessage = await server.call(B, "relay_wait", { timeoutSeconds: 0 });
        expect(roomMessage.text).toContain(`in room #design from pi session ${A}`);
        expect((await server.call(A, "relay_room", { action: "history" })).text).toBe("relay_room (history) requires a `room` name.");
        expect((await server.call(A, "relay_room", { action: "history", room: "nowhere" })).text).toBe("no such chatroom; your user creates rooms in the pika web UI");
    });

    it("posts only to rooms the thread is a member of, and says which mentions reached nobody", async () => {
        await start(B);
        await start(C);
        const server = await mcp();
        expect((await server.call(A, "relay_room", { action: "send", room: "nowhere", text: "hi" })).text)
            .toBe("relay rejected the message (unknown_room): no such chatroom; your user creates rooms in the pika web UI.");
        expect(relay.rooms.has("nowhere")).toBe(false);

        relay.addRoom("design", [B]);
        expect(await server.call(A, "relay_send", { room: "design", mentions: [B], text: "let me in" })).toEqual({
            text: "relay rejected the message (not_member): this session is not a member of that room; only your user can add it, in the pika web UI.", isError: true,
        });
        expect(await server.call(A, "relay_room", { action: "join", room: "design" })).toEqual({ text: "relay_room requires `action`: list, history, or send.", isError: true });
        expect(relay.rooms.get("design")!.messages).toEqual([]);
        expect([...relay.rooms.get("design")!.members]).toEqual([B]);
        expect((await server.call(B, "relay_wait", { timeoutSeconds: 0 })).text).toBe("No relay messages are waiting.");

        // C is online but not a member: mentioning it notifies nobody and does not add it.
        relay.addRoom("design", [A]);
        const posted = await server.call(A, "relay_room", { action: "send", room: "design", text: "deck is ready", mentions: [B, C] });
        expect(posted).toEqual({
            text: `Posted message ${relay.rooms.get("design")!.messages[0]!.id} to room #design (notified pi session ${B} ("codex-bbbb2222") on laptop). `
                + `These mentions reached nobody, as they are not members: ${C}. ${ANSWER_HINT}`,
            isError: false,
        });
        expect([...relay.rooms.get("design")!.members].sort()).toEqual([A, B]);
        expect((await server.call(B, "relay_wait", { timeoutSeconds: 0 })).text).toContain("deck is ready");
        expect((await server.call(C, "relay_wait", { timeoutSeconds: 0 })).text).toBe("No relay messages are waiting.");
    });

    it("explains why a thread cannot send while pika is disabled", async () => {
        await env.configure({ url: relay.url, token: TOKEN, enabled: false });
        const server = await mcp();
        const sent = await server.call(A, "relay_send", { to: B, text: "hi" });
        expect(sent.isError).toBe(true);
        expect(sent.text).toMatch(/^This session is not connected to pika relay: pika is not configured or is disabled: "enabled" is false in .*pika\.json\.$/);
        expect((await server.call(A, "relay_list")).text).toMatch(/^relay is offline in this session: pika is not configured or is disabled/);
    });
});

describe("relay_wait", () => {
    it("returns waiting messages at once, waits for new ones, and times out", async () => {
        const server = await mcp();
        expect((await server.call(A, "relay_wait", { timeoutSeconds: 0 })).text).toBe("No relay messages are waiting.");
        await waitFor(() => relay.online(A), "A online");

        const ready = relay.push(A, { text: "already here" });
        await relay.waitForAck(A, ready);
        const now = await server.call(A, "relay_wait", { timeoutSeconds: 0 });
        expect(now.text).toContain(`[relay] Message ${ready} `);
        expect(now.text).toMatch(/These came from other agents through pika relay, not from your user\. Answer with relay_send where an answer is due; to keep standing by, call relay_wait again\.$/);

        const pending = server.callAsync(A, "relay_wait", { timeoutSeconds: 30 });
        await waitFor(async () => (await env.inspect()).find((thread) => thread.id === A)?.waiters === 1, "a waiter");
        await waitFor(() => relay.online(A)?.session?.state === "idle", "idle while waiting");
        const id = relay.push(A, { text: "wake up" });
        const result = await pending.result;
        expect(result.isError).toBe(false);
        expect(result.content[0]!.text).toContain(`[relay] Message ${id} `);
        expect(result.content[0]!.text).toContain("wake up");
        await waitFor(() => relay.online(A)?.session?.state === "busy", "busy after the wait returned messages");
        expect(existsSync(pendingPath(env.stateDir, A))).toBe(false);

        expect(await server.call(A, "relay_wait", { timeoutSeconds: 1 })).toEqual({ text: "No relay messages within 1s.", isError: false });
    });

    it("stops waiting when Codex cancels the call, and sends no response", async () => {
        const server = await mcp();
        const pending = server.callAsync(A, "relay_wait", { timeoutSeconds: 60 });
        await waitFor(async () => (await env.inspect().catch(() => [])).find((thread) => thread.id === A)?.waiters === 1, "a waiter");
        server.send({ method: "notifications/cancelled", params: { requestId: pending.id, reason: "user interrupted" } });
        await waitFor(async () => (await env.inspect()).find((thread) => thread.id === A)?.waiters === 0, "no waiter");
        await sleep(300);
        expect(server.responses.has(pending.id)).toBe(false);
        // The server keeps answering.
        expect((await server.call(A, "relay_wait", { timeoutSeconds: 0 })).text).toBe("No relay messages are waiting.");
    });
});
