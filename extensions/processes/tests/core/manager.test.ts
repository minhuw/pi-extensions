import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessManager } from "../../src/manager.ts";
import type { ManagerOptions, ProcessEvent, ProcessManager, StartOptions } from "../../src/types.ts";

const NODE = JSON.stringify(process.execPath);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "processes-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function setup(options: Partial<ManagerOptions> = {}) {
	const cwd = tempDir();
	const manager = createProcessManager({ stateDir: path.join(cwd, "state"), shell: { shell: "/bin/sh", args: ["-c"] }, ...options });
	cleanups.push(() => manager.shutdown());
	const events: ProcessEvent[] = [];
	manager.subscribe((event) => events.push(event));
	const start = (command: string, extra: Partial<StartOptions> = {}) => manager.start({ command, cwd, owner: "test", ...extra });
	return { manager, events, cwd, start };
}

async function next<T extends ProcessEvent["type"]>(events: ProcessEvent[], type: T, ms = 5000, match: (event: Extract<ProcessEvent, { type: T }>) => boolean = () => true) {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = events.find((event): event is Extract<ProcessEvent, { type: T }> => event.type === type && match(event as Extract<ProcessEvent, { type: T }>));
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`No "${type}" event within ${ms} ms; saw ${events.map((event) => event.type).join(", ")}`);
		await sleep(25);
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function gone(pid: number, ms = 3000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (pidAlive(pid)) {
		if (Date.now() > deadline) return false;
		await sleep(50);
	}
	return true;
}

async function freePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as net.AddressInfo;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/** `node server.cjs <port> <delayMs> [print]`: listens on 127.0.0.1 after the delay, optionally printing its URL. */
function serverScript(dir: string): string {
	const file = path.join(dir, "server.cjs");
	fs.writeFileSync(
		file,
		`const [port, delay, print] = process.argv.slice(2);
setTimeout(() => require("node:http").createServer((_, res) => res.end("ok")).listen(Number(port), "127.0.0.1", () => {
	if (print) console.log("  Local:   \\x1b[36mhttp://127.0.0.1:" + port + "/\\x1b[0m");
}), Number(delay));
`,
	);
	return `${NODE} ${JSON.stringify(file)}`;
}

describe("lifecycle", () => {
	it("records the exit code and emits one exit event with the tail", async () => {
		const { start, events } = setup();
		const { process: info } = await start("echo hello; sleep 0.3; exit 7", { ready: false });
		expect(info.status).toBe("running");
		const exit = await next(events, "exit");
		expect(exit.process).toMatchObject({ status: "exited", exitCode: 7 });
		expect(exit.requested).toBe(false);
		expect(exit.tail).toEqual(["hello"]);
		await sleep(200);
		expect(events.filter((event) => event.type === "exit")).toHaveLength(1);
	});

	it("shows an immediate exit in the start result", async () => {
		const { start } = setup();
		const { process: info } = await start("exit 3", { ready: false });
		expect(info).toMatchObject({ status: "exited", exitCode: 3 });
	});

	it("throws a clear error when the cwd does not exist", async () => {
		const { manager, start, cwd } = setup();
		await expect(start("true", { cwd: path.join(cwd, "missing") })).rejects.toThrow(/Failed to start "true" in .*missing/);
		expect(manager.list()).toEqual([]);
	});

	it("escalates to SIGKILL for a group that traps TERM and kills grandchildren", async () => {
		const { manager, start, events } = setup();
		const { process: info } = await start("trap '' TERM; sleep 30 & echo $!; wait", { ready: false });
		const deadline = Date.now() + 2000;
		while (manager.get(info.id).logBytes === 0 && Date.now() < deadline) await sleep(25);
		const grandchild = Number((await manager.logs(info.id)).lines[0]);
		expect(pidAlive(grandchild)).toBe(true);
		const result = await manager.stop(info.id, 300);
		expect(result.outcome).toBe("killed");
		expect(result.process.status).toBe("stopped");
		expect(await gone(grandchild)).toBe(true);
		const exit = await next(events, "exit");
		expect(exit.requested).toBe(true);
		expect((await manager.stop(info.id)).outcome).toBe("already");
	});

	it("kills leftover group members when the shell exits on its own", async () => {
		const { manager, start, events } = setup();
		const { process: info } = await start("sleep 30 >/dev/null 2>&1 & echo $!", { ready: false });
		await next(events, "exit");
		const leftover = Number((await manager.logs(info.id)).lines[0]);
		expect(await gone(leftover)).toBe(true);
	});

	it("restarts with the same id, a separator, and restarts + 1", async () => {
		const { manager, start, events } = setup();
		const { process: first } = await start("echo run; sleep 30", { name: "srv", ready: { pattern: "^run$" } });
		await next(events, "ready");
		const second = await manager.restart("srv");
		expect(second).toMatchObject({ id: first.id, name: "srv", restarts: 1 });
		expect(second.pid).not.toBe(first.pid);
		await next(events, "ready", 5000, (event) => event.process.restarts === 1);
		expect((await manager.logs("srv")).lines).toEqual(["run", "--- restart 1 ---", "run"]);
		expect(events.filter((event) => event.type === "exit").map((event) => event.type === "exit" && event.requested)).toEqual([true]);
	});

	it("clear removes finished records and their logs", async () => {
		const { manager, start } = setup();
		const { process: done } = await start("echo x", { ready: false });
		await start("sleep 30", { ready: false });
		await sleep(300);
		expect(manager.clear()).toBe(1);
		expect(fs.existsSync(done.logPath)).toBe(false);
		expect(manager.list().map((info) => info.status)).toEqual(["running"]);
	});
});

describe("readiness", () => {
	it("becomes ready via pattern", async () => {
		const { start, events } = setup();
		await start("sleep 0.2; printf '\\033[32mListening\\033[0m on 9\\n'; sleep 30", { ready: { pattern: "^Listening on \\d+$" } });
		const ready = await next(events, "ready");
		expect(ready.via).toBe("pattern");
		expect(ready.process.status).toBe("ready");
	});

	it("becomes ready via port and url together", async () => {
		const { start, events, cwd } = setup();
		const port = await freePort();
		await start(`${serverScript(cwd)} ${port} 300`, { ready: { port, url: `http://127.0.0.1:${port}/` } });
		const ready = await next(events, "ready");
		expect(["port", "url"]).toContain(ready.via);
		expect(ready.process.readyAt).toBeGreaterThan(ready.process.startedAt);
	});

	it("becomes ready via the first local URL in output", async () => {
		const { start, events, cwd } = setup();
		const port = await freePort();
		await start(`${serverScript(cwd)} ${port} 200 print`);
		const ready = await next(events, "ready");
		expect(ready.via).toBe("auto-url");
		expect(ready.process.urls).toEqual([`http://127.0.0.1:${port}/`]);
	});

	it("emits ready_timeout once and keeps the process running", async () => {
		const { manager, start, events } = setup();
		const { process: info } = await start("echo booting; sleep 30", { ready: { pattern: "never", timeoutSeconds: 0.3 } });
		const timeout = await next(events, "ready_timeout");
		expect(timeout.tail).toEqual(["booting"]);
		await sleep(400);
		expect(events.filter((event) => event.type === "ready_timeout")).toHaveLength(1);
		expect(manager.get(info.id).status).toBe("starting");
	});
});

it("rate-limits error output with a suppressed count", async () => {
	const { start, events } = setup({ errorCooldownMs: 400 });
	await start('i=1; while [ $i -le 15 ]; do echo "ERROR $i"; echo ok; i=$((i+1)); done; sleep 30', { ready: false, errorPattern: "^ERROR" });
	const first = await next(events, "error_output");
	expect(first).toMatchObject({ lines: ["ERROR 1"], suppressed: 0 });
	const batch = await next(events, "error_output", 2000, (event) => event !== first);
	expect(batch.lines).toEqual(Array.from({ length: 10 }, (_, index) => `ERROR ${index + 2}`));
	expect(batch.suppressed).toBe(4);
});

describe("logs", () => {
	it("reads the tail, filters, and follows a cursor", async () => {
		const { manager, start, events } = setup();
		const { process: info } = await start("i=1; while [ $i -le 100 ]; do echo \"line $i\"; i=$((i+1)); done", { ready: false });
		await next(events, "exit");
		expect((await manager.logs(info.id, { tail: 3 })).lines).toEqual(["line 98", "line 99", "line 100"]);
		expect((await manager.logs(info.id, { filter: "^line 9\\d$" })).lines).toHaveLength(10);
		await expect(manager.logs(info.id, { filter: "[" })).rejects.toThrow(/not a valid regular expression/);
		const page = await manager.logs(info.id, { cursor: 0, maxBytes: 20 });
		expect(page).toMatchObject({ lines: ["line 1", "line 2"], more: true, truncated: false });
		expect(manager.get(info.id).logBytes).toBe(fs.statSync(info.logPath).size);
	});

	it("rotates large output and reports truncation for stale cursors", async () => {
		const { manager, start, events } = setup({ maxLogBytes: 500 });
		const { process: info } = await start("i=1; while [ $i -le 200 ]; do echo \"line $i\"; i=$((i+1)); done", { ready: false });
		await next(events, "exit");
		const bytes = manager.get(info.id).logBytes;
		expect(bytes).toBe(Array.from({ length: 200 }, (_, index) => `line ${index + 1}\n`).join("").length);
		expect(fs.existsSync(`${info.logPath}.1`)).toBe(true);
		const read = await manager.logs(info.id, { cursor: 0 });
		expect(read.truncated).toBe(true);
		expect(read.lines.at(-1)).toBe("line 200");
		expect(read.nextCursor).toBe(bytes);
	});

	it("writes logs under a run dir with an owner marker and sweeps dead old runs", async () => {
		const stateDir = path.join(tempDir(), "state");
		const stale = path.join(stateDir, "99999999-1");
		const fresh = path.join(stateDir, "99999999-2");
		const mine = path.join(stateDir, `${process.pid}-1`);
		for (const dir of [stale, fresh, mine]) fs.mkdirSync(dir, { recursive: true });
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(stale, old, old);
		fs.utimesSync(mine, old, old);
		const manager = createProcessManager({ stateDir, shell: { shell: "/bin/sh", args: ["-c"] } });
		cleanups.push(() => manager.shutdown());
		expect(fs.existsSync(stale)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
		expect(fs.existsSync(mine)).toBe(true);
		const { process: info } = await manager.start({ command: "true", cwd: stateDir, owner: "t", ready: false });
		const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(info.logPath), "owner.json"), "utf8"));
		expect(owner.pid).toBe(process.pid);
	});
});

describe("names and limits", () => {
	it("reuses a live process with the same name, command, and cwd and rejects a clash", async () => {
		const { start } = setup();
		const first = await start("sleep 30", { name: "srv", ready: false });
		const again = await start("sleep 30", { name: "srv", ready: false });
		expect(again.reused).toBe(true);
		expect(again.process.id).toBe(first.process.id);
		await expect(start("sleep 31", { name: "srv", ready: false })).rejects.toThrow(/already running/);
	});

	it("derives unique default names from the first command word", async () => {
		const { start } = setup();
		const a = await start("FOO=1 /bin/sleep 30", { ready: false });
		const b = await start("sleep 31", { ready: false });
		expect([a.process.name, b.process.name]).toEqual(["sleep", "sleep-2"]);
	});

	it("enforces maxLive", async () => {
		const { start } = setup({ maxLive: 2 });
		await start("sleep 30", { ready: false });
		await start("sleep 31", { ready: false });
		await expect(start("sleep 32", { ready: false })).rejects.toThrow(/limit reached \(2\)/);
	});
});

describe("wait", () => {
	it("is satisfied by ready, or immediately when already ready", async () => {
		const { manager, start, events } = setup();
		const { process: info } = await start("sleep 0.3; echo up; sleep 30", { ready: { pattern: "up" } });
		const id = manager.wait(info.id, { until: "ready" });
		expect((await next(events, "wait_done", 3000, (event) => event.waitId === id)).outcome).toBe("satisfied");
		const again = manager.wait(info.id, { until: "ready" });
		expect((await next(events, "wait_done", 500, (event) => event.waitId === again)).outcome).toBe("satisfied");
	});

	it("is satisfied by exit, including for an already finished process", async () => {
		const { manager, start, events } = setup();
		const { process: info } = await start("sleep 0.3", { ready: false });
		const id = manager.wait(info.id, { until: "exit" });
		await next(events, "wait_done", 3000, (event) => event.waitId === id && event.outcome === "satisfied");
		const late = manager.wait(info.id, { until: "exit" });
		await next(events, "wait_done", 500, (event) => event.waitId === late && event.outcome === "satisfied");
		expect(() => manager.wait(info.id, { until: "ready" })).toThrow(/readiness disabled/);
	});

	it("matches only new lines and reports the matching line", async () => {
		const { manager, start, events } = setup();
		const { process: info } = await start("echo done-early; sleep 0.4; echo build done; sleep 30", { ready: false });
		const id = manager.wait(info.id, { until: "match", pattern: "done" });
		const done = await next(events, "wait_done", 3000, (event) => event.waitId === id);
		expect(done).toMatchObject({ outcome: "satisfied", line: "build done" });
	});

	it("times out, reports exited, and can be cancelled", async () => {
		const { manager, start, events } = setup();
		const { process: info } = await start("sleep 0.5", { ready: false });
		const timeout = manager.wait(info.id, { until: "match", pattern: "x", timeoutSeconds: 0.1 });
		const exited = manager.wait(info.id, { until: "match", pattern: "x" });
		const cancelled = manager.wait(info.id, { until: "exit" });
		expect(manager.cancelWait(cancelled)).toBe(true);
		expect(manager.cancelWait(cancelled)).toBe(false);
		expect((await next(events, "wait_done", 2000, (event) => event.waitId === timeout)).outcome).toBe("timeout");
		expect((await next(events, "wait_done", 3000, (event) => event.waitId === exited)).outcome).toBe("exited");
		await sleep(100);
		expect(events.some((event) => event.type === "wait_done" && event.waitId === cancelled)).toBe(false);
	});
});

it("killAllSync SIGKILLs every live group", async () => {
	const { manager, start } = setup();
	const { process: info } = await start("sleep 30", { ready: false });
	manager.killAllSync();
	expect(await gone(info.pid!)).toBe(true);
	await sleep(200);
	expect(manager.get(info.id)).toMatchObject({ status: "exited", signal: "SIGKILL" });
});

// Exercises the type import so a contract drift fails typecheck here too.
export type { ProcessManager };
