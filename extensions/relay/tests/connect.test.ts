import { hostname } from "node:os";
import { basename, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { RELAY_VERSION, wsUrl } from "../protocol.ts";
import { shared } from "../shared.ts";
import { FakeRelay, TOKEN } from "./support/relay-server.ts";
import { Notes, setCredentials, sleep, startSession, waitFor, Workspace, type Harness } from "./support/runtime.ts";

let workspace: Workspace;
let relay: FakeRelay;
const harnesses: Harness[] = [];
beforeEach(async () => { workspace = await Workspace.create(); relay = await new FakeRelay().start("/pika"); });
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.shutdown();
	await relay.stop();
	await workspace.cleanup();
	shared().unsupportedNotified = false;
});

async function open(options: Partial<Parameters<typeof startSession>[0]> = {}): Promise<Harness> {
	const h = await startSession({ workspace, ...options });
	harnesses.push(h);
	return h;
}

/** What `/relay` says in a session. */
async function relayStatus(h: Harness, notes: Notes): Promise<string> {
	await h.session.prompt("/relay");
	return notes.last!.message;
}

it("maps the pika URL to ws or wss and keeps its base path", () => {
	expect(wsUrl("http://host:8080/pika", "/api/relay/v1/connect")).toBe("ws://host:8080/pika/api/relay/v1/connect");
	expect(wsUrl("https://example.org/a/b", "/api/relay/v1/connect")).toBe("wss://example.org/a/b/api/relay/v1/connect");
	expect(wsUrl("https://example.org", "/api/relay/v1/connect")).toBe("wss://example.org/api/relay/v1/connect");
});

it("connects after session_start with the bearer token and sends a complete hello", async () => {
	setCredentials(relay.url);
	const h = await open();
	const id = h.session.sessionId;
	await waitFor(() => relay.online(id) !== undefined, 5_000, "welcome");
	expect(relay.upgrades).toEqual([expect.objectContaining({ authorization: `Bearer ${TOKEN}`, path: "/pika/api/relay/v1/connect" })]);
	expect(relay.hellos()).toEqual([{
		id, cwd: workspace.cwd, project: basename(workspace.cwd), host: hostname(), model: "relay-test/test", state: "idle",
		piVersion: VERSION, relayVersion: RELAY_VERSION,
	}]);
	expect(h.errors).toEqual([]);
});

it("stays offline and without tools outside the TUI and RPC modes, and connects with tools in both", async () => {
	setCredentials(relay.url);
	const json = await open({ mode: "json" });
	const print = await open({ mode: "print" });
	const tui = await open({ mode: "tui" });
	const rpc = await open({ mode: "rpc" });
	await waitFor(() => relay.online(rpc.session.sessionId) !== undefined, 5_000, "the RPC session");
	await waitFor(() => relay.online(tui.session.sessionId) !== undefined, 5_000, "the TUI session");
	await sleep(300);
	expect(relay.hellos().map((hello) => hello.id).sort()).toEqual([tui.session.sessionId, rpc.session.sessionId].sort());
	const statuses = [...shared().members.values()].map((member) => [member.sessionId, member.member.status()]);
	expect(statuses).toContainEqual([json.session.sessionId, "relay connects only in the TUI and RPC modes, and this session runs in json mode"]);
	expect(statuses).toContainEqual([print.session.sessionId, "relay connects only in the TUI and RPC modes, and this session runs in print mode"]);
	expect(statuses).toContainEqual([tui.session.sessionId, "online"]);
	// Print and JSON sessions, which every Subagents and Herder child is, never get the tools.
	const relayTools = (h: Harness) => h.session.getAllTools().map((tool) => tool.name).filter((name) => name.startsWith("relay_"));
	expect(relayTools(json)).toEqual([]);
	expect(relayTools(print)).toEqual([]);
	for (const h of [tui, rpc]) expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["relay_list", "relay_send", "relay_status"]));
});

it("stays offline with PI_RELAY_DISABLED=1, in an excluded cwd, and without credentials, and /relay says why", async () => {
	const notes = new Notes();
	process.env.PI_RELAY_DISABLED = "1";
	setCredentials(relay.url);
	const disabled = await open({ ui: notes.context() });
	expect(await relayStatus(disabled, notes)).toMatch(/^Relay is offline: PI_RELAY_DISABLED=1 is set\./);
	delete process.env.PI_RELAY_DISABLED;

	const secret = join(workspace.root, "secret");
	await mkdir(secret, { recursive: true });
	setCredentials(relay.url, { excluded: (cwd) => cwd.startsWith(secret) });
	const excluded = await open({ cwd: secret, ui: notes.context() });
	await sleep(300);
	expect(await relayStatus(excluded, notes)).toMatch(new RegExp(`^Relay is offline: ${secret.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is excluded by pika's exclude list\\.`));

	setCredentials(undefined);
	const unconfigured = await open({ ui: notes.context() });
	await sleep(300);
	const text = await relayStatus(unconfigured, notes);
	expect(text).toMatch(/^Relay is offline: pika is not logged in or is disabled; run \/pika login\./);
	expect(text).toContain("Server: none (pika is not logged in)");
	expect(text).toContain(`This session: ${unconfigured.session.sessionId}`);
	expect(relay.upgrades).toEqual([]);
});

it("stays offline with an unsupported server and notifies once per process", async () => {
	relay.features = undefined;
	setCredentials(relay.url);
	const notes = new Notes();
	const first = await open({ ui: notes.context() });
	await waitFor(() => notes.notes.length === 1, 5_000, "the notice");
	expect(notes.last).toEqual({ type: "warning", message: `relay: the pika server at ${relay.url} has no relay; relay needs pika 0.3.0 or newer. Sessions stay offline from relay; pika uploads are not affected.` });
	const second = await open({ ui: notes.context() });
	relay.features = [];
	const third = await open({ ui: notes.context() });
	await sleep(500);
	expect(notes.notes).toHaveLength(1);
	expect(await relayStatus(third, notes)).toMatch(new RegExp(`^Relay is offline: relay is turned off on the pika server at .* \\(PIKA_RELAY=off\\); /relay on retries\\.`));
	expect(relay.upgrades).toEqual([]);
	void first; void second;
});

it("connects when credentials appear late, moves to a new server, and disconnects on logout", async () => {
	const other = await new FakeRelay().start();
	try {
		const h = await open();
		const id = h.session.sessionId;
		await sleep(300);
		expect(relay.upgrades).toEqual([]);
		setCredentials(relay.url);
		await waitFor(() => relay.online(id) !== undefined, 5_000, "the first server");
		setCredentials(other.url, { token: "other-token" });
		other.tokens.add("other-token");
		await waitFor(() => other.online(id) !== undefined, 5_000, "the second server");
		await waitFor(() => relay.online(id) === undefined, 5_000, "the first connection to close");
		expect(other.upgrades.map((upgrade) => upgrade.authorization)).toEqual(["Bearer other-token"]);
		setCredentials(undefined);
		await waitFor(() => other.online(id) === undefined, 5_000, "logout");
		await sleep(300);
		expect(relay.upgrades).toHaveLength(1);
		expect(other.upgrades).toHaveLength(1);
		expect(h.errors).toEqual([]);
	} finally { await other.stop(); }
});
