/** The extension against a fake daemon on a real unix socket (NODE.md §5). */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER_ENV } from "../compatibility.ts";
import { DaemonLink } from "../transport.ts";
import { Bus, FakeDaemon, harness, sleep, tempDir, until, type Harness } from "./support.ts";

const REGISTRY = Symbol.for("pi-extensions.pika-node-bridge.owners");
let dir: ReturnType<typeof tempDir>;
let daemon: FakeDaemon;
let live: Harness[];
let originalEnv: NodeJS.ProcessEnv;

function create(options?: Parameters<typeof harness>[0]): Harness {
	const h = harness(options);
	live.push(h);
	return h;
}

beforeEach(async () => {
	originalEnv = { ...process.env };
	delete process.env[OWNER_ENV];
	Reflect.deleteProperty(globalThis, REGISTRY);
	dir = tempDir();
	daemon = new FakeDaemon(join(dir.path, "daemon.sock"));
	await daemon.listen();
	process.env.PIKA_NODE_SOCKET = daemon.path;
	process.env.PIKA_NODE_PANE_ID = "pane-1";
	live = [];
});

afterEach(async () => {
	for (const h of live) await h.fire("session_shutdown");
	await daemon.close();
	dir.cleanup();
	for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
	Object.assign(process.env, originalEnv);
	Reflect.deleteProperty(globalThis, REGISTRY);
});

describe("status over the socket", () => {
	it("says hello, then sends the full status on connect", async () => {
		const h = create();
		await h.fire("session_start");
		await until(() => daemon.statuses().length > 0, 5000, "first status");
		expect(daemon.hellos()).toEqual([expect.objectContaining({ type: "hello", role: "bridge", paneId: "pane-1", pid: process.pid, protocolVersion: 1 })]);
		expect(daemon.last()).toMatchObject({
			state: "idle", activities: [], activityCount: 0, model: "magpie/claude-opus-5-5",
			session: { id: "session-1", name: "My session", cwd: "/workspace/project" },
		});
		expect(daemon.invalid).toEqual([]);
	});

	it("stays busy across agent_end until agent_settled, and waits while a prompt is open", async () => {
		const h = create();
		await h.fire("session_start");
		await until(() => daemon.statuses().length > 0);
		await h.fire("agent_start");
		await until(() => daemon.last()?.state === "busy", 5000, "busy");
		await h.fire("agent_end");
		await sleep(250);
		expect(daemon.last()?.state).toBe("busy");
		await h.fire("ui_prompt_start");
		await h.fire("ui_prompt_start");
		await until(() => daemon.last()?.state === "waiting", 5000, "waiting");
		await h.fire("ui_prompt_end");
		await sleep(250);
		expect(daemon.last()?.state).toBe("waiting");
		await h.fire("ui_prompt_end");
		await until(() => daemon.last()?.state === "busy", 5000, "busy again");
		await h.fire("agent_settled");
		await until(() => daemon.last()?.state === "idle", 5000, "idle");
		expect(daemon.invalid).toEqual([]);
	});

	it("aggregates activities per source, including snapshots captured before session_start and replayed on request", async () => {
		const bus = new Bus();
		const replays: unknown[] = [];
		bus.on("pi-extensions:activity-request", value => {
			replays.push(value);
			bus.emit("pi-extensions:activity", { source: "herder", activities: [{ id: "run-1", label: "Herder run", kind: "workflow", state: "running", progress: { completed: 1, total: 3 } }] });
		});
		const h = create({ bus });
		h.snapshot("subagents", ["a1", "recon"]);
		await h.fire("session_start");
		expect(replays).toEqual([{ consumer: "pika-node-bridge" }]);
		await until(() => daemon.last()?.activityCount === 2, 5000, "two activities");
		expect(daemon.last()?.activities).toEqual([
			{ source: "subagents", id: "a1", label: "recon" },
			{ source: "herder", id: "run-1", label: "Herder run", kind: "workflow", state: "running", progress: { completed: 1, total: 3 } },
		]);
		h.snapshot("subagents");
		await until(() => daemon.last()?.activityCount === 1, 5000, "subagents finished");
		expect(daemon.last()?.activities).toEqual([expect.objectContaining({ source: "herder", id: "run-1" })]);
		expect(daemon.invalid).toEqual([]);
	});

	it("updates the session on session_info_changed and sends bursts latest-wins", async () => {
		const h = create();
		await h.fire("session_start");
		await until(() => daemon.statuses().length > 0);
		const before = daemon.statuses().length;
		for (let i = 1; i <= 20; i++) h.snapshot("subagents", ...Array.from({ length: i }, (_, n) => [`a${n}`, `task ${n}`] as [string, string]));
		h.session.name = "Renamed";
		await h.fire("session_info_changed", { name: "Renamed" });
		await until(() => daemon.last()?.session?.name === "Renamed" && daemon.last()?.activityCount === 20, 5000, "latest status");
		// At most one attempt per 100 ms: a synchronous burst of 21 changes is a handful of lines, not 21.
		expect(daemon.statuses().length - before).toBeLessThanOrEqual(3);
	});

	it("sends an idle final status and closes on session_shutdown", async () => {
		const h = create();
		await h.fire("session_start");
		h.snapshot("subagents", ["a1", "recon"]);
		await h.fire("agent_start");
		await until(() => daemon.last()?.state === "busy" && daemon.last()?.activityCount === 1);
		await h.fire("session_shutdown");
		await until(() => daemon.last()?.state === "idle", 2000, "final status");
		expect(daemon.last()).toMatchObject({ state: "idle", activities: [], activityCount: 0, session: { id: "session-1" } });
		expect(process.env[OWNER_ENV]).toBeUndefined();
	});
});

describe("connection", () => {
	it("reconnects after the daemon drops it and resends the current status", async () => {
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		await until(() => daemon.last()?.state === "busy");
		daemon.dropAll();
		await until(() => daemon.hellos().length === 2, 5000, "second hello");
		await until(() => daemon.last()?.connection === 1, 5000, "status on the new connection");
		expect(daemon.last()?.state).toBe("busy");
	});

	it("connects when the daemon appears later", async () => {
		await daemon.close();
		const link = new DaemonLink({ socket: daemon.path, pane: "pane-1", version: "test", onWelcome: () => {}, backoff: { initialMs: 50, maxMs: 100 } });
		link.start();
		await sleep(150);
		expect(link.state).toBe("connecting");
		daemon = new FakeDaemon(daemon.path);
		await daemon.listen();
		await until(() => link.state === "ready", 5000, "ready");
		link.close();
	});

	it("stops after the daemon refuses the pane", async () => {
		process.env.PIKA_NODE_PANE_ID = "gone";
		const link = new DaemonLink({ socket: daemon.path, pane: "gone", version: "test", onWelcome: () => {}, backoff: { initialMs: 20, maxMs: 20 } });
		link.start();
		await until(() => link.state === "refused", 5000, "refused");
		expect(link.reason).toContain("not_found");
		await sleep(200);
		expect(daemon.hellos()).toHaveLength(1);
		expect(await link.request({ type: "open", path: "/x" })).toEqual({ error: { code: "unavailable", message: expect.stringContaining("not_found") } });
		link.close();
	});

	it("drops a daemon that never answers the hello and tries again", async () => {
		daemon.paused = true;
		const link = new DaemonLink({ socket: daemon.path, pane: "pane-1", version: "test", onWelcome: () => {}, backoff: { initialMs: 20, maxMs: 20 }, connectTimeoutMs: 100 });
		link.start();
		await until(() => daemon.connections.length >= 2, 5000, "a second attempt");
		expect(link.state).toBe("connecting");
		expect(link.reason).toBe("no welcome in time");
		link.close();
	});
});

describe("activation", () => {
	it("does nothing without the pika-node environment", async () => {
		delete process.env.PIKA_NODE_SOCKET;
		const h = create();
		await h.fire("session_start");
		await h.fire("agent_start");
		await sleep(150);
		expect(daemon.connections).toHaveLength(0);
		await h.command("pika-open", "a.ts");
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("inactive"), "error");
	});

	it("binds one bridge per pane: in-process children and child processes stay inactive", async () => {
		const parent = create();
		await parent.fire("session_start");
		await until(() => daemon.hellos().length === 1);
		expect(process.env[OWNER_ENV]).toBe(String(process.pid));
		// A second top-level-looking session in the same process (an in-process child in TUI mode).
		const sibling = create();
		await sibling.fire("session_start");
		// A live child session binds extensions without a TUI or RPC mode.
		const child = create({ mode: "print" });
		await child.fire("session_start");
		await sleep(150);
		expect(daemon.hellos()).toHaveLength(1);
		// A child process inherits the owner pid.
		Reflect.deleteProperty(globalThis, REGISTRY);
		const childProcess = create();
		process.env[OWNER_ENV] = String(process.ppid);
		await childProcess.fire("session_start");
		await sleep(150);
		expect(daemon.hellos()).toHaveLength(1);
	});

	it("lets the replacement session take the pane after /new", async () => {
		const first = create();
		await first.fire("session_start");
		await until(() => daemon.hellos().length === 1);
		await first.fire("session_shutdown", { reason: "new" });
		const second = create({ session: { id: "session-2", cwd: "/workspace/project" } });
		await second.fire("session_start", { reason: "new" });
		await until(() => daemon.last()?.session?.id === "session-2", 5000, "second session's status");
		expect(daemon.hellos()).toHaveLength(2);
	});
});

describe("navigation", () => {
	it("sends open and diff with absolute paths and shows the daemon's answer", async () => {
		const h = create();
		await h.fire("session_start");
		await until(() => daemon.hellos().length === 1);
		await h.command("pika-open", `"src/My File.ts" --line 4 --column 2`);
		expect(daemon.lines.find(line => line.type === "open")).toMatchObject({ type: "open", path: "/workspace/project/src/My File.ts", line: 4, column: 2 });
		expect(h.notify).toHaveBeenLastCalledWith("Sent src/My File.ts to 1 pika window.", "info");

		daemon.answer = message => ({ type: "reply", id: message.id, result: { delivered: 0 } });
		await h.command("pika-diff", "/abs/deleted.ts --staged");
		expect(daemon.lines.find(line => line.type === "diff")).toMatchObject({ type: "diff", path: "/abs/deleted.ts", staged: true });
		expect(h.notify).toHaveBeenLastCalledWith("No pika window is connected to this node; diff for /abs/deleted.ts (staged) was not shown.", "warning");
		expect(daemon.invalid).toEqual([]);
		expect(h.sendUserMessage).not.toHaveBeenCalled();
	});

	it("shows containment and other daemon errors", async () => {
		const h = create();
		await h.fire("session_start");
		await until(() => daemon.hellos().length === 1);
		daemon.answer = message => ({ type: "reply", id: message.id, error: { code: "outside_roots", message: `${message.path} is outside the configured roots` } });
		await h.command("pika-open", "/etc/hosts");
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringMatching(/^pika open failed \(outside_roots\)\. \/etc\/hosts is outside the configured roots\. .*roots/), "error");
		daemon.answer = message => ({ type: "reply", id: message.id, error: { code: "is_a_directory", message: "\x1b[2Jdir" } });
		await h.command("pika-open", "src");
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("(is_a_directory). \\u001b[2Jdir"), "error");
	});

	it("reports bad arguments without contacting the daemon", async () => {
		const h = create();
		await h.fire("session_start");
		await until(() => daemon.hellos().length === 1);
		await h.command("pika-open", "a.ts --column 3");
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("--column requires --line"), "error");
		expect(daemon.lines.filter(line => line.type === "open")).toEqual([]);
	});

	it("times out when the daemon does not answer, and reports a missing daemon", async () => {
		const h = create();
		await h.fire("session_start");
		await until(() => daemon.hellos().length === 1);
		daemon.answer = () => undefined;
		const link = new DaemonLink({ socket: daemon.path, pane: "pane-1", version: "test", onWelcome: () => {} });
		link.start();
		expect(await link.request({ type: "diff", path: "/a" }, 300)).toEqual({ error: { code: "timeout", message: expect.any(String) } });
		link.close();
		await daemon.close();
		await h.command("pika-diff", "a.ts");
		expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("pika diff failed (unavailable)"), "error");
	}, 10_000);
});
