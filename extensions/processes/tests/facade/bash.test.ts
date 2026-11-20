// The bash override against a real process manager: foreground results, timeout and abort, and every promotion path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerBash, type BashTiming } from "../../src/bash.ts";
import { createProcessManager } from "../../src/manager.ts";
import type { ProcessEvent, ProcessManager } from "../../src/types.ts";
import { createCtx, createPi, FakeManager } from "./fakes.ts";

const NODE = JSON.stringify(process.execPath);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(timing: Partial<BashTiming> = {}) {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "processes-bash-")));
	cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
	const manager: ProcessManager = createProcessManager({ stateDir: path.join(cwd, "state"), shell: { shell: "/bin/sh", args: ["-c"] } });
	cleanups.push(() => manager.shutdown());
	const events: ProcessEvent[] = [];
	manager.subscribe((event) => events.push(event));
	const pi = createPi();
	registerBash(pi.api, () => manager, { promoteAfterMs: 60_000, urlSettleMs: 200, inputMinRunMs: 0, ...timing });
	const ctx = { ...createCtx("session-a", { cwd }), sessionManager: { getSessionId: () => "session-a", getSessionFile: () => undefined, getEntries: () => [] } };
	const bash = (params: { command: string; timeout?: number }, signal?: AbortSignal) => pi.tools.get("bash")!.execute("call-1", params, signal, undefined, ctx);
	return { manager, events, pi, ctx, cwd, bash };
}

const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");

describe("bash override", () => {
	it("runs a command in the foreground and leaves no record", async () => {
		const { manager, bash } = setup();
		const result = await bash({ command: "echo hi; echo err >&2" });
		expect(text(result)).toContain("hi");
		expect(text(result)).toContain("err");
		expect(result.structuredContent.exit_code).toBe(0);
		expect(manager.list()).toEqual([]);
	});

	it("reports a nonzero exit as an error, like Pi's bash", async () => {
		const { bash } = setup();
		const result = await bash({ command: "echo out; exit 3" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Command exited with code 3");
	});

	it("kills the command on an explicit timeout", async () => {
		const { manager, bash } = setup({ promoteAfterMs: 100 });
		await expect(bash({ command: "sleep 30", timeout: 1 })).rejects.toThrow("Command timed out after 1 seconds");
		expect(manager.list()).toEqual([]);
	});

	it("kills the process group on abort", async () => {
		const { manager, cwd, bash } = setup();
		const controller = new AbortController();
		const pending = bash({ command: `sleep 30 & echo $! > ${cwd}/child; wait` }, controller.signal);
		await sleep(400);
		const child = Number(fs.readFileSync(path.join(cwd, "child"), "utf8"));
		controller.abort();
		await expect(pending).rejects.toThrow("Command aborted");
		expect(() => process.kill(child, 0)).toThrow();
		expect(manager.list()).toEqual([]);
	});

	it("moves a command without a timeout to the background after promoteAfterMs", async () => {
		const { manager, events, bash } = setup({ promoteAfterMs: 300 });
		const result = await bash({ command: "echo started; sleep 1; echo done" });
		expect(text(result)).toContain("started");
		expect(text(result)).toMatch(/moved to the background as process echo \(p_[0-9a-f]+\) because it was still running after 0s/);
		expect(result.isError).toBe(false);
		expect(result.structuredContent.exit_code).toBeUndefined();
		const [process] = manager.list();
		expect(process).toMatchObject({ attached: false, status: "running", owner: "session-a" });
		expect(result.structuredContent.process_id).toBe(process!.id);
		await sleep(1200);
		const exit = events.find((event) => event.type === "exit");
		expect(exit?.process).toMatchObject({ id: process!.id, attached: false, exitCode: 0 });
	});

	it("never promotes a command that starts with sleep", async () => {
		const { bash } = setup({ promoteAfterMs: 100 });
		const result = await bash({ command: "sleep 0.5; echo woke" });
		expect(text(result)).toContain("woke");
		expect(result.structuredContent.exit_code).toBe(0);
	});

	it("moves a server to the background once it prints a local URL and stays up", async () => {
		const { manager, bash } = setup();
		const server = `${NODE} -e 'require("http").createServer((q,r)=>r.end("ok")).listen(0,"127.0.0.1",function(){console.log("Local: http://127.0.0.1:"+this.address().port+"/")})'`;
		const result = await bash({ command: server });
		expect(text(result)).toMatch(/because it printed http:\/\/127\.0\.0\.1:\d+\/ and kept running/);
		const [process] = manager.list();
		expect(process).toMatchObject({ attached: false, status: "running" });
		const response = await fetch(process!.urls[0]!);
		expect(await response.text()).toBe("ok");
	});

	it("moves running commands to the background when the user sends a message", async () => {
		const { pi, ctx, manager, bash } = setup();
		const pending = bash({ command: "sleep 30" });
		await sleep(300);
		expect(await pi.fire("input", { type: "input", text: "hi", source: "extension", streamingBehavior: "steer" }, ctx)).toEqual([{ action: "continue" }]);
		await sleep(100);
		expect(manager.list()[0]).toMatchObject({ attached: true });
		await pi.fire("input", { type: "input", text: "hi", source: "interactive", streamingBehavior: "steer" }, ctx);
		const result = await pending;
		expect(text(result)).toContain("because the user sent a new message");
		expect(manager.list()[0]).toMatchObject({ attached: false, status: "running" });
	});

	it("settles cleanly when processes.clear() removes a fast-exiting record before finished() discards it", async () => {
		const { manager, bash } = setup();
		let cleared = 0;
		manager.subscribe((event) => {
			if (event.type === "exit") cleared += manager.clear();
		});

		const ok = await bash({ command: "echo fast-ok" });
		expect(text(ok)).toContain("fast-ok");
		expect(ok.structuredContent.exit_code).toBe(0);
		expect(cleared).toBe(1);

		const failed = await bash({ command: "echo fast-fail; exit 4" });
		expect(failed.isError).toBe(true);
		expect(text(failed)).toContain("fast-fail");
		expect(text(failed)).toContain("Command exited with code 4");
		expect(cleared).toBe(2);
		expect(manager.list()).toEqual([]);
	});

	it("settles cleanly when processes.discard() removes a record on exit before bash's listener runs", async () => {
		const { manager, bash } = setup();
		const discarded: string[] = [];
		// Subscribed before bash() subscribes, so this runs ahead of bash's exit listener.
		manager.subscribe((event) => {
			if (event.type !== "exit") return;
			manager.discard(event.process.id);
			discarded.push(event.process.id);
		});

		// Runs past START_SETTLE_MS so bash() enters its live exit-listener path rather than early-exit.
		const result = await bash({ command: "sleep 0.25; echo late-exit; exit 5" });
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("late-exit");
		expect(text(result)).toContain("Command exited with code 5");
		expect(discarded).toHaveLength(1);
		expect(manager.list()).toEqual([]);
	});

	it("rejects with the abort error when processes.clear() races with stopWith() cleanup", async () => {
		const { manager, bash } = setup();
		let cleared = 0;
		manager.subscribe((event) => {
			if (event.type === "exit") cleared += manager.clear();
		});

		const controller = new AbortController();
		const pending = bash({ command: "sleep 30" }, controller.signal);
		while (manager.list().length === 0) await sleep(20);
		controller.abort();

		await expect(pending).rejects.toThrow("Command aborted");
		expect(cleared).toBe(1);
		expect(manager.list()).toEqual([]);
	});

	it("rejects with the timeout error when processes.discard() races with stopWith() cleanup", async () => {
		const { manager, bash } = setup({ promoteAfterMs: 100 });
		const discarded: string[] = [];
		manager.subscribe((event) => {
			if (event.type !== "exit") return;
			manager.discard(event.process.id);
			discarded.push(event.process.id);
		});

		await expect(bash({ command: "sleep 30", timeout: 1 })).rejects.toThrow("Command timed out after 1 seconds");
		expect(discarded).toHaveLength(1);
		expect(manager.list()).toEqual([]);
	});

	it("handles an already-discarded record in checkUrl(), promote(), and stopWith() without throwing or hanging", async () => {
		const fake = new FakeManager();
		const pi = createPi();
		registerBash(pi.api, () => fake, { promoteAfterMs: 60_000, urlSettleMs: 50, inputMinRunMs: 0 });
		const ctx = { ...createCtx("session-a", { cwd: process.cwd() }), sessionManager: { getSessionId: () => "session-a", getSessionFile: () => undefined, getEntries: () => [] } };
		const bash = (params: { command: string; timeout?: number }, signal?: AbortSignal) => pi.tools.get("bash")!.execute("call-1", params, signal, undefined, ctx);

		// 1. Record is already gone when checkUrl() runs on output after start() resolved.
		let getCalls = 0;
		const origGet = fake.get.bind(fake);
		fake.get = (idOrName) => {
			getCalls++;
			return origGet(idOrName);
		};
		const pending = bash({ command: "echo hi" });
		await sleep(0);
		const [started] = fake.processes;
		expect(started).toBeDefined();
		fake.discard(started!.id);
		const beforeOutputGets = getCalls;
		fake.starts[0]!.onOutput?.(Buffer.from("http://127.0.0.1:8080/\n"));
		expect(getCalls).toBeGreaterThan(beforeOutputGets);
		fake.emit({ type: "exit", process: { ...started!, status: "exited", exitCode: 0 }, requested: false, tail: [] });
		const result = await pending;
		expect(result.structuredContent.exit_code).toBe(0);

		// 2. Record is cleared before bash's exit listener while input triggers promote().
		let detachCalls = 0;
		const origDetach = fake.detach.bind(fake);
		fake.detach = (idOrName) => {
			detachCalls++;
			return origDetach(idOrName);
		};
		const unsubRace = fake.subscribe((event) => {
			if (event.type !== "exit") return;
			fake.discard(event.process.id);
			void pi.fire("input", { type: "input", text: "steer", source: "interactive", streamingBehavior: "steer" }, ctx);
		});
		const racingPromote = bash({ command: "echo race" });
		await sleep(0);
		const [second] = fake.processes;
		expect(second).toBeDefined();
		fake.emit({ type: "exit", process: { ...second!, status: "exited", exitCode: 6 }, requested: false, tail: [] });
		unsubRace();
		const racedResult = await racingPromote;
		expect(detachCalls).toBe(1);
		expect(racedResult.isError).toBe(true);
		expect(text(racedResult)).toContain("Command exited with code 6");

		// 3. Record is already gone when stopWith() invokes processes.stop() (sync Unknown process throw).
		const controller = new AbortController();
		const aborting = bash({ command: "sleep 30" }, controller.signal);
		await sleep(0);
		const [third] = fake.processes;
		expect(third).toBeDefined();
		fake.discard(third!.id);
		let stopCalls = 0;
		fake.stop = (idOrName) => {
			stopCalls++;
			throw new Error(`Unknown process "${idOrName}".`);
		};
		controller.abort();
		await expect(aborting).rejects.toThrow("Command aborted");
		expect(stopCalls).toBe(1);

		// 4. Record is already gone when processes.stop() rejects asynchronously with Unknown process.
		const controller2 = new AbortController();
		const abortingAsync = bash({ command: "sleep 30" }, controller2.signal);
		await sleep(0);
		const [fourth] = fake.processes;
		expect(fourth).toBeDefined();
		fake.discard(fourth!.id);
		fake.stop = async (idOrName) => {
			stopCalls++;
			throw new Error(`Unknown process "${idOrName}".`);
		};
		controller2.abort();
		await expect(abortingAsync).rejects.toThrow("Command aborted");
		expect(stopCalls).toBe(2);
	});

	it("propagates unexpected discard() errors instead of swallowing them or hanging", async () => {
		const makeBash = (failDiscard: () => never) => {
			const fake = new FakeManager();
			fake.discard = failDiscard;
			const pi = createPi();
			registerBash(pi.api, () => fake, { promoteAfterMs: 60_000, urlSettleMs: 50, inputMinRunMs: 0 });
			const ctx = { ...createCtx("session-a", { cwd: process.cwd() }), sessionManager: { getSessionId: () => "session-a", getSessionFile: () => undefined, getEntries: () => [] } };
			const bash = (params: { command: string; timeout?: number }, signal?: AbortSignal) => pi.tools.get("bash")!.execute("call-1", params, signal, undefined, ctx);
			return { fake, bash };
		};

		// Unexpected error in finished()
		{
			const { fake, bash } = makeBash(() => {
				throw new Error("EACCES: unlink failed");
			});
			const pending = bash({ command: "echo boom" });
			await sleep(0);
			const [started] = fake.processes;
			fake.emit({ type: "exit", process: { ...started!, status: "exited", exitCode: 0 }, requested: false, tail: [] });
			await expect(pending).rejects.toThrow("EACCES: unlink failed");
		}

		// Unexpected error in stopWith()
		{
			const { fake, bash } = makeBash(() => {
				throw new Error("EIO: disk error");
			});
			const controller = new AbortController();
			const pending = bash({ command: "sleep 30" }, controller.signal);
			await sleep(0);
			controller.abort();
			await expect(pending).rejects.toThrow("EIO: disk error");
		}
	});
});
