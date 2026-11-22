import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupAlive, pidAlive } from "../../src/core/group.ts";
import { createProcessManager, createProcessManagerForTest } from "../../src/manager.ts";
import { isLiveStatus, type ManagerOptions, type ProcessEvent, type ProcessManager, type StartOptions } from "../../src/types.ts";

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

	it("serializes concurrent restart() calls on the same record without leaking intermediate processes", async () => {
		const { manager, start, events, cwd } = setup();
		const runsFile = path.join(cwd, "runs.log");
		const script = path.join(cwd, "worker.cjs");
		fs.writeFileSync(
			script,
			`const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.appendFileSync(${JSON.stringify(runsFile)}, process.pid + "," + child.pid + "\\n");
console.log("ready " + process.pid);
setInterval(() => {}, 1000);
`,
		);
		cleanups.push(() => {
			if (!fs.existsSync(runsFile)) return;
			for (const line of fs.readFileSync(runsFile, "utf8").trim().split("\n").filter(Boolean)) {
				for (const raw of line.split(",")) {
					const pid = Number(raw);
					if (Number.isInteger(pid) && pid > 0) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// Already exited.
						}
					}
				}
			}
		});

		const { process: first } = await start(`exec ${NODE} ${JSON.stringify(script)}`, {
			name: "srv",
			ready: { pattern: "^ready \\d+$" },
		});
		await next(events, "ready", 5000, (event) => event.process.pid === first.pid);

		const [r1, r2, r3] = await Promise.all([
			manager.restart(first.id),
			manager.restart("srv"),
			manager.restart(first.id),
		]);
		await next(events, "ready", 5000, (event) => event.process.restarts === 3 && event.process.pid === r3.pid);

		expect([r1.id, r2.id, r3.id]).toEqual([first.id, first.id, first.id]);
		expect([r1.restarts, r2.restarts, r3.restarts]).toEqual([1, 2, 3]);
		expect(new Set([first.pid, r1.pid, r2.pid, r3.pid]).size).toBe(4);

		const recorded = fs
			.readFileSync(runsFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => line.split(",").map(Number) as [number, number]);
		expect(recorded).toHaveLength(4);
		expect(recorded.map(([pid]) => pid)).toEqual([first.pid, r1.pid, r2.pid, r3.pid]);

		for (const [parentPid, childPid] of recorded.slice(0, 3)) {
			expect(await gone(parentPid)).toBe(true);
			expect(await gone(childPid)).toBe(true);
		}

		// Wait past LEFTOVER_PAUSE_MS to ensure no stale reap kills the newest run or corrupts status.
		await sleep(250);
		expect(pidAlive(r3.pid!)).toBe(true);
		expect(pidAlive(recorded[3][1])).toBe(true);
		const current = manager.get(first.id);
		expect(current).toMatchObject({ id: first.id, name: "srv", pid: r3.pid, status: "ready", restarts: 3 });
		expect(current.exitCode).toBeUndefined();
		expect(current.signal).toBeUndefined();
		expect(current.endedAt).toBeUndefined();

		const exits = events.filter((event): event is Extract<ProcessEvent, { type: "exit" }> => event.type === "exit");
		expect(exits).toHaveLength(3);
		expect(exits.every((event) => event.requested)).toBe(true);

		const lines = (await manager.logs("srv")).lines;
		expect(lines).toEqual([
			`ready ${first.pid}`,
			"--- restart 1 ---",
			`ready ${r1.pid}`,
			"--- restart 2 ---",
			`ready ${r2.pid}`,
			"--- restart 3 ---",
			`ready ${r3.pid}`,
		]);

		await manager.shutdown();
		expect(await gone(r3.pid!)).toBe(true);
		expect(await gone(recorded[3][1])).toBe(true);
	});

	it("recovers per-record restart serialization after a failed restart", async () => {
		const { manager, start } = setup();
		await expect(manager.restart("missing")).rejects.toThrow(/Unknown process/);

		const { process: first } = await start("sleep 30", { name: "srv", ready: false });
		await manager.stop(first.id, 300);
		const { process: blocker } = await start("sleep 30", { name: "srv", ready: false });

		await expect(manager.restart(first.id)).rejects.toThrow(/Another live process/);
		await manager.stop(blocker.id, 300);

		const restarted = await manager.restart(first.id);
		expect(restarted).toMatchObject({ id: first.id, name: "srv", status: "running", restarts: 1 });
		expect(pidAlive(restarted.pid!)).toBe(true);
	});

	it("ignores a delayed stale run exit after a replacement run is active without corrupting status or killing the replacement", async () => {
		const cwd = tempDir();
		const { manager, relaunchWithoutStop } = createProcessManagerForTest({
			stateDir: path.join(cwd, "state"),
			shell: { shell: "/bin/sh", args: ["-c"] },
		});
		cleanups.push(() => manager.shutdown());
		const events: ProcessEvent[] = [];
		manager.subscribe((event) => events.push(event));

		const script = path.join(cwd, "signaled-worker.cjs");
		fs.writeFileSync(
			script,
			`process.on("SIGUSR1", () => {
	console.log("ERROR stale-boom");
	process.exit(9);
});
process.on("SIGUSR2", () => {
	console.log("alive " + process.pid);
});
console.log("ready " + process.pid);
setInterval(() => {}, 1000);
`,
		);

		const { process: first } = await manager.start({
			command: `exec ${NODE} ${JSON.stringify(script)}`,
			cwd,
			owner: "test",
			name: "srv",
			ready: { pattern: "^ready \\d+$" },
			errorPattern: "^ERROR",
		});
		cleanups.push(() => {
			if (first.pid !== undefined) {
				try {
					process.kill(-first.pid, "SIGKILL");
				} catch {
					// Already exited.
				}
			}
		});
		await next(events, "ready", 5000, (event) => event.process.pid === first.pid);

		const second = await relaunchWithoutStop(first.id);
		expect(second.pid).not.toBe(first.pid);
		await next(events, "ready", 5000, (event) => event.process.pid === second.pid);

		const waitId = manager.wait(first.id, { until: "exit" });
		const eventCountBefore = events.length;

		// Trigger the stale first run to exit on its own (unrequested -> reap path would run if unguarded).
		process.kill(first.pid!, "SIGUSR1");
		expect(await gone(first.pid!)).toBe(true);

		// Wait past LEFTOVER_PAUSE_MS so any unguarded stale reap/cleanup would have settled.
		await sleep(300);

		expect(pidAlive(second.pid!)).toBe(true);
		const active = manager.get(first.id);
		expect(active).toMatchObject({ id: first.id, pid: second.pid, status: "ready" });
		expect(active.exitCode).toBeUndefined();
		expect(active.signal).toBeUndefined();
		expect(active.endedAt).toBeUndefined();

		const afterEvents = events.slice(eventCountBefore);
		expect(afterEvents.filter((event) => event.type === "exit")).toEqual([]);
		expect(afterEvents.filter((event) => event.type === "error_output")).toEqual([]);
		expect(afterEvents.filter((event) => event.type === "wait_done")).toEqual([]);

		// Verify the shared log file was not closed/broken by the stale run.
		process.kill(second.pid!, "SIGUSR2");
		const deadline = Date.now() + 2000;
		let lines: string[] = [];
		while (Date.now() < deadline) {
			lines = (await manager.logs(first.id)).lines;
			if (lines.includes(`alive ${second.pid}`)) break;
			await sleep(25);
		}
		expect(lines).toContain(`alive ${second.pid}`);

		const stopped = await manager.stop(first.id, 500);
		expect(stopped.process).toMatchObject({ id: first.id, pid: second.pid, status: "stopped" });
		expect(await gone(second.pid!)).toBe(true);
		const waitDone = await next(events, "wait_done", 3000, (event) => event.waitId === waitId);
		expect(waitDone.outcome).toBe("satisfied");
		expect(events.filter((event) => event.type === "exit")).toHaveLength(1);
	});

	it("ignores a stale run superseded mid-track while awaiting pipe close and leftover reap", async () => {
		const cwd = tempDir();
		const { manager, relaunchWithoutStop } = createProcessManagerForTest({
			stateDir: path.join(cwd, "state"),
			shell: { shell: "/bin/sh", args: ["-c"] },
		});
		cleanups.push(() => manager.shutdown());
		const events: ProcessEvent[] = [];
		manager.subscribe((event) => events.push(event));

		const childPidFile = path.join(cwd, "holder.pid");
		const script = path.join(cwd, "midtrack-worker.cjs");
		fs.writeFileSync(
			script,
			`const fs = require("node:fs");
const { spawn } = require("node:child_process");
process.on("SIGUSR1", () => {
	// Spawn a short-lived child inheriting stdout so the parent exits before stdout closes.
	const holder = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 400)"], { stdio: ["ignore", 1, 2] });
	fs.writeFileSync(${JSON.stringify(childPidFile)}, String(holder.pid));
	process.exit(7);
});
console.log("ready " + process.pid);
setInterval(() => {}, 1000);
`,
		);
		cleanups.push(() => {
			if (!fs.existsSync(childPidFile)) return;
			const pid = Number(fs.readFileSync(childPidFile, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already exited.
				}
			}
		});

		const { process: first } = await manager.start({
			command: `exec ${NODE} ${JSON.stringify(script)}`,
			cwd,
			owner: "test",
			name: "srv",
			ready: { pattern: "^ready \\d+$" },
		});
		await next(events, "ready", 5000, (event) => event.process.pid === first.pid);

		// First run exits while its child holds stdout open, keeping track() suspended in closed/reap.
		process.kill(first.pid!, "SIGUSR1");
		expect(await gone(first.pid!)).toBe(true);
		const holderPid = Number(fs.readFileSync(childPidFile, "utf8").trim());

		// Supersede the record while run1's track() is still suspended awaiting pipe close + reap.
		const second = await relaunchWithoutStop(first.id);
		await next(events, "ready", 5000, (event) => event.process.pid === second.pid);

		// Wait for holder to exit and run1's track() to finish settling.
		expect(await gone(holderPid)).toBe(true);
		await sleep(250);

		expect(pidAlive(second.pid!)).toBe(true);
		const active = manager.get(first.id);
		expect(active).toMatchObject({ id: first.id, pid: second.pid, status: "ready" });
		expect(active.exitCode).toBeUndefined();
		expect(active.endedAt).toBeUndefined();
		expect(events.filter((event) => event.type === "exit")).toEqual([]);

		await manager.stop(first.id, 500);
		expect(await gone(second.pid!)).toBe(true);
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

	it("enforces 0700 on stateDir and runDir and 0600 on owner.json and log files", async () => {
		const freshStateDir = path.join(tempDir(), "fresh-state");
		const freshManager = createProcessManager({ stateDir: freshStateDir, shell: { shell: "/bin/sh", args: ["-c"] } });
		cleanups.push(() => freshManager.shutdown());
		expect(fs.statSync(freshStateDir).mode & 0o777).toBe(0o700);

		const stateDir = path.join(tempDir(), "state");
		fs.mkdirSync(stateDir, { recursive: true, mode: 0o755 });
		fs.chmodSync(stateDir, 0o755);

		const manager = createProcessManager({ stateDir, maxLogBytes: 200, shell: { shell: "/bin/sh", args: ["-c"] } });
		cleanups.push(() => manager.shutdown());
		const events: ProcessEvent[] = [];
		manager.subscribe((event) => events.push(event));

		const { process: quiet } = await manager.start({ command: "true", cwd: stateDir, owner: "t", ready: false });
		await next(events, "exit", 5000, (event) => event.process.id === quiet.id);
		const runDir = path.dirname(quiet.logPath);
		expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
		expect(fs.statSync(runDir).mode & 0o777).toBe(0o700);
		expect(fs.statSync(path.join(runDir, "owner.json")).mode & 0o777).toBe(0o600);
		expect(fs.statSync(quiet.logPath).mode & 0o777).toBe(0o600);

		const { process: noisy } = await manager.start({
			command: "i=1; while [ $i -le 60 ]; do echo \"line $i\"; i=$((i+1)); done",
			cwd: stateDir,
			owner: "t",
			ready: false,
		});
		await next(events, "exit", 5000, (event) => event.process.id === noisy.id);
		expect(fs.statSync(noisy.logPath).mode & 0o777).toBe(0o600);
		expect(fs.statSync(`${noisy.logPath}.1`).mode & 0o777).toBe(0o600);
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

describe("error isolation", () => {
	it("isolates throwing subscribers so later listeners and exit tracking complete without unhandled rejections", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		cleanups.push(() => {
			process.off("unhandledRejection", onRejection);
		});

		const cwd = tempDir();
		const manager = createProcessManager({ stateDir: path.join(cwd, "state"), shell: { shell: "/bin/sh", args: ["-c"] } });
		cleanups.push(() => manager.shutdown());

		let thrown = 0;
		manager.subscribe(() => {
			thrown++;
			throw new Error("subscriber failure");
		});
		const received: ProcessEvent[] = [];
		manager.subscribe((event) => received.push(event));

		const { process: info } = await manager.start({ command: "echo hello; sleep 0.2; exit 0", cwd, owner: "test", ready: false });
		const waitId = manager.wait(info.id, { until: "exit" });

		const exit = await next(received, "exit");
		const waitDone = await next(received, "wait_done", 5000, (event) => event.waitId === waitId);
		expect(thrown).toBeGreaterThan(0);
		expect(exit.process).toMatchObject({ id: info.id, status: "exited", exitCode: 0 });
		expect(exit.tail).toEqual(["hello"]);
		expect(waitDone.outcome).toBe("satisfied");
		expect(manager.get(info.id)).toMatchObject({ status: "exited", exitCode: 0 });
		await sleep(50);
		expect(rejections).toEqual([]);
	});

	it("isolates track() errors during exit handling without unhandled rejections and lets stop() settle", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		cleanups.push(() => {
			process.off("unhandledRejection", onRejection);
		});

		const { manager, start, events } = setup();
		const { process: natural } = await start("echo before-unlink; sleep 0.3; exit 0", { ready: false });
		const deadline = Date.now() + 2000;
		while (manager.get(natural.id).logBytes === 0 && Date.now() < deadline) await sleep(25);
		fs.unlinkSync(natural.logPath);
		const waitId = manager.wait(natural.id, { until: "exit" });

		const exit = await next(events, "exit", 5000, (event) => event.process.id === natural.id);
		const waitDone = await next(events, "wait_done", 5000, (event) => event.waitId === waitId);
		expect(exit.process).toMatchObject({ status: "exited", exitCode: 0 });
		expect(exit.tail).toEqual([]);
		expect(waitDone.outcome).toBe("satisfied");
		expect((await manager.stop(natural.id)).outcome).toBe("already");

		const { process: stopped } = await start("echo gone-before-stop; sleep 30", { ready: false });
		const stopDeadline = Date.now() + 2000;
		while (manager.get(stopped.id).logBytes === 0 && Date.now() < stopDeadline) await sleep(25);
		fs.unlinkSync(stopped.logPath);
		const result = await manager.stop(stopped.id, 300);
		expect(result.process.status).toBe("stopped");
		await sleep(50);
		expect(rejections).toEqual([]);
	});

	it("ignores ENOENT races during startup sweep for vanishing run dirs and files", async () => {
		const stateDir = path.join(tempDir(), "state");
		const danglingDir = path.join(stateDir, "99999999-1");
		const vanishingStatDir = path.join(stateDir, "99999999-2");
		const vanishingReaddir = path.join(stateDir, "99999999-3");
		const vanishingFileDir = path.join(stateDir, "99999999-4");
		const freshDir = path.join(stateDir, "99999999-5");
		for (const dir of [danglingDir, vanishingStatDir, vanishingReaddir, vanishingFileDir, freshDir]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		const danglingOwner = path.join(danglingDir, "owner.json");
		fs.writeFileSync(danglingOwner, "{}\n");
		fs.symlinkSync(path.join(stateDir, "missing-target"), path.join(danglingDir, "dangling.log"));
		const vanishingFile = path.join(vanishingFileDir, "owner.json");
		fs.writeFileSync(vanishingFile, "{}\n");
		for (const target of [danglingOwner, danglingDir, vanishingStatDir, vanishingReaddir, vanishingFile, vanishingFileDir]) {
			fs.utimesSync(target, old, old);
		}

		const realStatSync = fs.statSync;
		const realReaddirSync = fs.readdirSync;
		const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
			const filePath = String(target);
			if (filePath === vanishingStatDir && fs.existsSync(vanishingStatDir)) {
				fs.rmSync(vanishingStatDir, { recursive: true, force: true });
			} else if (filePath === vanishingFile && fs.existsSync(vanishingFile)) {
				fs.unlinkSync(vanishingFile);
			}
			return Reflect.apply(realStatSync, fs, [target, ...args]);
		}) as typeof fs.statSync);
		const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
			if (String(target) === vanishingReaddir && fs.existsSync(vanishingReaddir)) {
				fs.rmSync(vanishingReaddir, { recursive: true, force: true });
			}
			return Reflect.apply(realReaddirSync, fs, [target, ...args]);
		}) as typeof fs.readdirSync);
		cleanups.push(() => {
			statSpy.mockRestore();
			readdirSpy.mockRestore();
		});

		const manager = createProcessManager({ stateDir, shell: { shell: "/bin/sh", args: ["-c"] } });
		cleanups.push(() => manager.shutdown());
		expect(fs.existsSync(danglingDir)).toBe(false);
		expect(fs.existsSync(vanishingStatDir)).toBe(false);
		expect(fs.existsSync(vanishingReaddir)).toBe(false);
		expect(fs.existsSync(vanishingFileDir)).toBe(false);
		expect(fs.existsSync(freshDir)).toBe(true);
		const { process: info } = await manager.start({ command: "true", cwd: stateDir, owner: "test", ready: false });
		expect(info.status).toBe("exited");
	});
});

function watchdogAlive(pgid: number): boolean {
	const out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
	const marker = `processes-watchdog ${process.pid} ${pgid}`;
	return out.split("\n").some((line) => {
		const trimmed = line.trim();
		if (!trimmed) return false;
		const space = trimmed.indexOf(" ");
		if (space < 0) return false;
		const pid = Number(trimmed.slice(0, space));
		return pid !== process.pid && trimmed.includes(marker);
	});
}

async function until(condition: () => boolean, ms = 2000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) return false;
		await sleep(25);
	}
	return true;
}

function trackActiveTimeouts() {
	const active = new Set<ReturnType<typeof setTimeout>>();
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const setSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
		let handle!: ReturnType<typeof setTimeout>;
		handle = realSetTimeout(
			(...cbArgs: unknown[]) => {
				active.delete(handle);
				callback(...cbArgs);
			},
			ms,
			...args,
		);
		active.add(handle);
		return handle;
	}) as typeof setTimeout);
	const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: ReturnType<typeof setTimeout>) => {
		if (handle !== undefined) active.delete(handle);
		return realClearTimeout(handle);
	}) as typeof clearTimeout);
	return {
		active,
		restore() {
			setSpy.mockRestore();
			clearSpy.mockRestore();
		},
	};
}

function killRecordedPids(file: string): void {
	if (!fs.existsSync(file)) return;
	for (const line of fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
		for (const raw of line.split(",")) {
			const pid = Number(raw.trim());
			if (Number.isInteger(pid) && pid > 0) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					// Not a process group or already gone.
				}
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	}
}

describe("shutdown concurrency", () => {
	it("rejects start() and restart() once shutdown() has begun and after it completes", async () => {
		const { manager, start, cwd } = setup();
		const script = path.join(cwd, "slow-term.cjs");
		fs.writeFileSync(
			script,
			`process.on("SIGTERM", () => setTimeout(() => process.exit(0), 250));
console.log("up");
setInterval(() => {}, 1000);
`,
		);
		const command = `exec ${NODE} ${JSON.stringify(script)}`;
		const { process: info } = await start(command, { name: "slow", ready: { pattern: "^up$" } });

		const shuttingDown = manager.shutdown();

		// Reject immediately while shutdown() is still draining the running process.
		await expect(start("sleep 30", { ready: false })).rejects.toThrow(/shutting down/i);
		await expect(start(command, { name: "slow", ready: false })).rejects.toThrow(/shutting down/i);
		await expect(manager.restart(info.id)).rejects.toThrow(/shutting down/i);

		await shuttingDown;

		// Continue rejecting after shutdown() has finished.
		await expect(start("sleep 30", { ready: false })).rejects.toThrow(/shutting down/i);
		await expect(manager.restart(info.id)).rejects.toThrow(/shutting down/i);
		expect(groupAlive(info.pid!)).toBe(false);
		expect(manager.list().filter((p) => isLiveStatus(p.status))).toEqual([]);
	});

	it("aborts concurrent restart() calls racing with shutdown() while stopping without leaving live children", async () => {
		const { manager, start, events, cwd } = setup();
		const runsFile = path.join(cwd, "runs.log");
		const script = path.join(cwd, "slow-restart-worker.cjs");
		fs.writeFileSync(
			script,
			`const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.appendFileSync(${JSON.stringify(runsFile)}, process.pid + "," + child.pid + "\\n");
process.on("SIGTERM", () => {
	setTimeout(() => {
		try { child.kill("SIGKILL"); } catch {}
		process.exit(0);
	}, 200);
});
console.log("ready " + process.pid);
setInterval(() => {}, 1000);
`,
		);
		cleanups.push(() => killRecordedPids(runsFile));

		const { process: first } = await start(`exec ${NODE} ${JSON.stringify(script)}`, {
			name: "srv",
			ready: { pattern: "^ready \\d+$" },
		});
		await next(events, "ready", 5000, (event) => event.process.pid === first.pid);

		const r1 = manager.restart(first.id);
		const r2 = manager.restart(first.id);
		const r1Check = expect(r1).rejects.toThrow(/shutting down/i);
		const r2Check = expect(r2).rejects.toThrow(/shutting down/i);
		const shuttingDown = manager.shutdown();

		await Promise.all([shuttingDown, r1Check, r2Check]);

		await sleep(250);
		const recorded = fs
			.readFileSync(runsFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split(",").map(Number) as [number, number]);
		expect(recorded).toHaveLength(1);
		for (const [parentPid, childPid] of recorded) {
			expect(groupAlive(parentPid)).toBe(false);
			expect(pidAlive(childPid)).toBe(false);
			expect(await until(() => !watchdogAlive(parentPid), 1000)).toBe(true);
		}
		expect(manager.list().filter((p) => isLiveStatus(p.status))).toEqual([]);
	});

	it("terminates a replacement child if restart() races with shutdown() mid-launch and drains live()", async () => {
		const { manager, start, events, cwd } = setup();
		const runsFile = path.join(cwd, "runs.log");
		const script = path.join(cwd, "launch-restart-worker.cjs");
		fs.writeFileSync(
			script,
			`const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.appendFileSync(${JSON.stringify(runsFile)}, process.pid + "," + child.pid + "\\n");
console.log("ready " + process.pid);
setInterval(() => {}, 1000);
`,
		);
		cleanups.push(() => killRecordedPids(runsFile));

		const { process: first } = await start(`exec ${NODE} ${JSON.stringify(script)}`, {
			name: "srv",
			ready: { pattern: "^ready \\d+$", timeoutSeconds: 0.2 },
		});
		await next(events, "ready", 5000, (event) => event.process.pid === first.pid);

		let replacementPid: number | undefined;
		let shuttingDown: Promise<void> | undefined;
		manager.subscribe((event) => {
			if (event.type === "changed" && event.process.restarts === 1 && event.process.status === "starting" && !shuttingDown) {
				replacementPid = event.process.pid;
				shuttingDown = manager.shutdown();
			}
		});

		const restartPromise = manager.restart(first.id);
		await expect(restartPromise).rejects.toThrow(/shutting down/i);
		expect(shuttingDown).toBeDefined();
		await shuttingDown!;

		expect(replacementPid).toBeDefined();
		expect(replacementPid).not.toBe(first.pid);
		expect(groupAlive(replacementPid!)).toBe(false);
		expect(await until(() => !watchdogAlive(replacementPid!), 1000)).toBe(true);

		const recorded = fs
			.readFileSync(runsFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split(",").map(Number) as [number, number]);
		for (const [parentPid, childPid] of recorded) {
			expect(groupAlive(parentPid)).toBe(false);
			expect(pidAlive(childPid)).toBe(false);
		}
		expect(manager.list().filter((p) => isLiveStatus(p.status))).toEqual([]);

		// Wait past ready.timeoutSeconds to confirm readiness timer was cleared.
		await sleep(300);
		expect(events.filter((event) => event.type === "ready_timeout")).toEqual([]);
	});

	it("terminates a child spawned by concurrent start() racing with shutdown() with no orphan group, watchdog, or leaked timers", async () => {
		// Window 1: shutdown() starts before the child's "spawn" event fires.
		{
			const cwd = tempDir();
			const pidsFile = path.join(cwd, "prespawn.pids");
			const grandchildrenFile = path.join(cwd, "prespawn.grandchildren");
			cleanups.push(() => {
				killRecordedPids(pidsFile);
				killRecordedPids(grandchildrenFile);
			});

			const manager = createProcessManager({
				stateDir: path.join(cwd, "state"),
				shell: {
					shell: "/bin/sh",
					args: ["-c", 'echo $$ >> "$1"; exec /bin/sh -c "$2"', "wrapper", pidsFile],
				},
			});
			cleanups.push(() => manager.shutdown());
			const events: ProcessEvent[] = [];
			manager.subscribe((event) => events.push(event));

			const timeouts = trackActiveTimeouts();
			cleanups.push(() => timeouts.restore());

			const startPromise = manager.start({
				command: `sleep 30 & echo $! >> ${JSON.stringify(grandchildrenFile)}; wait`,
				cwd,
				owner: "test",
				ready: { pattern: "never", timeoutSeconds: 0.2 },
			});
			const startCheck = expect(startPromise).rejects.toThrow(/shutting down/i);
			const shutdownPromise = manager.shutdown();

			await Promise.all([shutdownPromise, startCheck]);
			expect(timeouts.active.size).toBe(0);
			timeouts.restore();

			expect(manager.list()).toEqual([]);
			expect(events).toEqual([]);

			await sleep(250);
			for (const file of [pidsFile, grandchildrenFile]) {
				if (!fs.existsSync(file)) continue;
				for (const raw of fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
					const pid = Number(raw);
					expect(groupAlive(pid)).toBe(false);
					expect(pidAlive(pid)).toBe(false);
					expect(watchdogAlive(pid)).toBe(false);
				}
			}
			expect(events.filter((event) => event.type === "ready_timeout")).toEqual([]);
		}

		// Window 2: shutdown() starts right after "spawn" attached the run, watchdog, readiness timer, and port probe.
		{
			const { manager, start, events, cwd } = setup();
			const runsFile = path.join(cwd, "postspawn.log");
			const script = path.join(cwd, "postspawn-worker.cjs");
			fs.writeFileSync(
				script,
				`const fs = require("node:fs");
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.appendFileSync(${JSON.stringify(runsFile)}, process.pid + "," + child.pid + "\\n");
setInterval(() => {}, 1000);
`,
			);
			cleanups.push(() => killRecordedPids(runsFile));

			const unusedPort = await freePort();
			let spawnedPid: number | undefined;
			let shutdownPromise: Promise<void> | undefined;
			manager.subscribe((event) => {
				if (event.type === "changed" && event.process.status === "starting" && !shutdownPromise) {
					spawnedPid = event.process.pid;
					shutdownPromise = manager.shutdown();
				}
			});

			const timeouts = trackActiveTimeouts();
			cleanups.push(() => timeouts.restore());

			const startPromise = start(`exec ${NODE} ${JSON.stringify(script)}`, {
				ready: { pattern: "never", port: unusedPort, timeoutSeconds: 0.2 },
			});
			await expect(startPromise).rejects.toThrow(/shutting down/i);
			expect(shutdownPromise).toBeDefined();
			await shutdownPromise!;
			expect(timeouts.active.size).toBe(0);
			timeouts.restore();

			expect(spawnedPid).toBeDefined();
			expect(groupAlive(spawnedPid!)).toBe(false);
			expect(await until(() => !watchdogAlive(spawnedPid!), 1000)).toBe(true);
			expect(manager.list()).toEqual([]);

			if (fs.existsSync(runsFile)) {
				for (const line of fs.readFileSync(runsFile, "utf8").trim().split("\n").filter(Boolean)) {
					for (const raw of line.split(",")) {
						const pid = Number(raw);
						expect(groupAlive(pid)).toBe(false);
						expect(pidAlive(pid)).toBe(false);
					}
				}
			}

			// Wait past ready.timeoutSeconds to ensure neither readiness timer nor port probe fires.
			await sleep(300);
			expect(events.filter((event) => event.type === "ready_timeout")).toEqual([]);
		}
	});
});

// Exercises the type import so a contract drift fails typecheck here too.
export type { ProcessManager };
