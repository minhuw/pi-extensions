import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { timing } from "../protocol.ts";
import { CHILD_SESSION_HOOKS, type ChildSessionHook, shared } from "../shared.ts";
import { FakeRelay } from "./support/relay-server.ts";
import { setCredentials, sleep, startSession, texts, waitFor, Workspace, type Harness } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start(); });
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
});

const registered = () => [...((globalThis as Record<symbol, Set<ChildSessionHook> | undefined>)[CHILD_SESSION_HOOKS] ?? [])];
const statusOf = (sessionId: string) => [...shared().members.values()].find((member) => member.sessionId === sessionId)?.member.status();
const RELAY_TOOLS = ["relay_list", "relay_send", "relay_status"];

async function open(options: Partial<Parameters<typeof startSession>[0]> = {}): Promise<Harness> {
	const h = await startSession({ workspace, ...options });
	harnesses.push(h);
	return h;
}

it("registers the child hook only while a relay session runs and pika has credentials", async () => {
	expect(registered()).toEqual([]);
	const h = await open();
	expect(registered()).toEqual([]);
	setCredentials(relay.url);
	expect(registered().map((hook) => hook.name)).toEqual(["relay"]);
	setCredentials(undefined);
	expect(registered()).toEqual([]);
	setCredentials(relay.url);
	await h.shutdown();
	expect(registered()).toEqual([]);
});

it("registers the child hook only while some session could connect: not excluded, not /relay off, in the TUI or RPC mode", async () => {
	setCredentials(relay.url);
	// A registered hook makes Subagents keep every child session on disk.
	const json = await open({ mode: "json" });
	const print = await open({ mode: "print" });
	await sleep(100);
	expect(registered()).toEqual([]);

	const secret = join(workspace.root, "secret");
	await mkdir(secret, { recursive: true });
	const excludeSecret = { excluded: (cwd: string) => cwd.startsWith(secret) };
	setCredentials(relay.url, excludeSecret);
	const excluded = await open({ cwd: secret });
	await sleep(100);
	expect(registered()).toEqual([]);

	const h = await open();
	await waitFor(() => relay.online(h.session.sessionId) !== undefined, 5_000, "the session");
	expect(registered().map((hook) => hook.name)).toEqual(["relay"]);
	await h.session.prompt("/relay off");
	expect(registered()).toEqual([]);
	await h.session.prompt("/relay on");
	expect(registered().map((hook) => hook.name)).toEqual(["relay"]);
	// pika's exclude list changing to cover the session takes the hook out too.
	setCredentials(relay.url, { excluded: () => true });
	expect(registered()).toEqual([]);
	setCredentials(relay.url, excludeSecret);
	expect(registered().map((hook) => hook.name)).toEqual(["relay"]);
	await h.shutdown();
	expect(registered()).toEqual([]);
	expect([json.errors, print.errors, excluded.errors]).toEqual([[], [], []]);
});

it("keeps a child session offline and without tools, even when its session_start handlers are slow", async () => {
	setCredentials(relay.url);
	const parent = await open();
	await waitFor(() => relay.online(parent.session.sessionId) !== undefined, 5_000, "the parent");
	const [hook] = registered();
	// Real I/O between relay's session_start and the hook's, as a slow extension would add.
	const slow = (pi: ExtensionAPI) => { pi.on("session_start", async () => { await sleep(300); }); };
	const manager = SessionManager.create(workspace.cwd, workspace.sessionDir, { parentSession: parent.session.sessionFile });
	const child = await open({ sessionManager: manager, extensions: [slow, hook!.extensionFactory], mode: "rpc" });
	const id = child.session.sessionId;
	await sleep(500);
	expect(statusOf(id)).toBe("this is a child session (a subagent or Herder step); relay connects only top-level sessions");
	expect(shared().children.has(id)).toBe(true);
	expect(relay.hellos().map((hello) => hello.id)).toEqual([parent.session.sessionId]);
	expect(child.session.getActiveToolNames().filter((name) => RELAY_TOOLS.includes(name))).toEqual([]);
	expect(parent.session.getActiveToolNames()).toEqual(expect.arrayContaining(RELAY_TOOLS));
	await child.shutdown();
	expect(shared().children.has(id)).toBe(false);
	expect(child.errors).toEqual([]);
});

it("disconnects a session the child hook claims after relay already decided", async () => {
	// A host without `resources_discover`: the fallback decides while a slow handler still runs.
	timing.decideFallbackMs = 50;
	setCredentials(relay.url);
	const parent = await open();
	await waitFor(() => relay.online(parent.session.sessionId) !== undefined, 5_000, "the parent");
	const [hook] = registered();
	const slow = (pi: ExtensionAPI) => { pi.on("session_start", async () => { await waitFor(() => relay.hellos().length === 2, 5_000, "the early hello"); }); };
	const manager = SessionManager.create(workspace.cwd, workspace.sessionDir, { parentSession: parent.session.sessionFile });
	const child = await open({ sessionManager: manager, extensions: [slow, hook!.extensionFactory], mode: "rpc" });
	const id = child.session.sessionId;
	await waitFor(() => relay.connections.find((connection) => connection.hello?.id === id)?.closed !== undefined, 5_000, "the child's connection to close");
	expect(statusOf(id)).toBe("this is a child session (a subagent or Herder step); relay connects only top-level sessions");
	expect(child.session.getAllTools().filter((tool) => RELAY_TOOLS.includes(tool.name)).map((tool) => tool.exposure)).toEqual(["hidden", "hidden", "hidden"]);
	expect(child.errors).toEqual([]);
});

it("keeps a real Subagents child offline while its parent is online", async () => {
	setCredentials(relay.url);
	// The child discovers relay from the agent dir, as a child of an installed package would.
	const relayPath = fileURLToPath(new URL("../index.ts", import.meta.url));
	await mkdir(join(workspace.agentDir, "extensions"), { recursive: true });
	await writeFile(join(workspace.agentDir, "extensions", "relay.ts"), `export { default } from ${JSON.stringify(relayPath)};\n`);
	const subagentsPath = fileURLToPath(new URL("../../subagents/src/index.ts", import.meta.url));
	const childIds: string[] = [];
	const witness = { name: "relay-test-witness", extensionFactory: (pi: ExtensionAPI) => { pi.on("session_start", (_event, ctx) => { childIds.push(ctx.sessionManager.getSessionId()); }); } };
	const hooks = (globalThis as Record<symbol, Set<unknown>>)[CHILD_SESSION_HOOKS] ??= new Set();
	hooks.add(witness);
	try {
		const parent = await open({ extensionPaths: [subagentsPath] });
		const parentId = parent.session.sessionId;
		await waitFor(() => relay.online(parentId) !== undefined, 5_000, "the parent");
		let childStatus: string | undefined;
		parent.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("Agent", { subagent_type: "worker", description: "child task", prompt: "Say done." })], { stopReason: "toolUse" }),
			() => {
				// The child's turn: by now its relay instance has decided.
				childStatus = statusOf(childIds[0]!);
				return fauxAssistantMessage("child done");
			},
			fauxAssistantMessage("parent done"),
		]);
		await parent.session.prompt("delegate it");
		await waitFor(() => texts(parent.session, "assistant").includes("parent done"), 20_000, "the parent's answer");
		expect(childIds).toHaveLength(1);
		expect(childStatus).toBe("this is a child session (a subagent or Herder step); relay connects only top-level sessions");
		expect(relay.hellos().map((hello) => hello.id)).toEqual([parentId]);
		expect(relay.upgrades).toHaveLength(1);
		expect(parent.errors).toEqual([]);
	} finally { hooks.delete(witness); }
}, 30_000);

it("gives a real Subagents child no relay tools when pika is logged out and no hook marks it", async () => {
	const relayPath = fileURLToPath(new URL("../index.ts", import.meta.url));
	await mkdir(join(workspace.agentDir, "extensions"), { recursive: true });
	await writeFile(join(workspace.agentDir, "extensions", "relay.ts"), `export { default } from ${JSON.stringify(relayPath)};\n`);
	const subagentsPath = fileURLToPath(new URL("../../subagents/src/index.ts", import.meta.url));
	const parent = await open({ extensionPaths: [subagentsPath] });
	expect(registered()).toEqual([]);
	// Tool declarations travel in each request's transcript.
	const requests: string[] = [];
	parent.faux.setResponses([
		(context) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage([fauxToolCall("Agent", { subagent_type: "worker", description: "child task", prompt: "Say done." })], { stopReason: "toolUse" });
		},
		(context) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("child done");
		},
		fauxAssistantMessage("parent done"),
	]);
	await parent.session.prompt("delegate it");
	await waitFor(() => texts(parent.session, "assistant").includes("parent done"), 20_000, "the parent's answer");
	expect(requests).toHaveLength(2);
	const [parentRequest, childRequest] = requests;
	for (const name of RELAY_TOOLS) expect(parentRequest).toContain(`"${name}"`);
	expect(childRequest).toContain("Say done.");
	expect(childRequest).not.toMatch(/relay_(list|send|status)/);
	expect(relay.upgrades).toEqual([]);
	expect(parent.errors).toEqual([]);
}, 30_000);
