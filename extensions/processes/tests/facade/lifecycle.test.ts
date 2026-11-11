import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProcesses } from "../../src/extension.ts";
import { CHANGED } from "../../src/footer.ts";
import { sharedState } from "../../src/state.ts";
import type { ManagerOptions } from "../../src/types.ts";
import { createBus, createCtx, createPi, FakeManager, info, resetShared } from "./fakes.ts";

let created: FakeManager[];
let exitHooks: (() => void)[];

beforeEach(() => {
	resetShared();
	created = [];
	exitHooks = [];
	vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
		if (event === "exit") exitHooks.push(listener);
		return process;
	}) as typeof process.on);
});
afterEach(() => vi.restoreAllMocks());

const create = (options: ManagerOptions) => {
	const manager = new FakeManager(options);
	created.push(manager);
	return manager;
};

/** One extension instance, as Pi creates for each session runtime. */
function instance(bus = createBus()) {
	const pi = createPi(bus);
	registerProcesses(pi.api, create);
	return pi;
}

describe("manager lifecycle", () => {
	it("creates one manager on the first session start, with the agent dir and the shell", async () => {
		const pi = instance();
		expect(created).toHaveLength(0);
		await pi.fire("session_start", { reason: "startup" }, createCtx("a"));
		expect(created).toHaveLength(1);
		expect(created[0]!.options!.stateDir).toBe(join(getAgentDir(), "processes"));
		expect(created[0]!.options!.shell.shell).toMatch(/sh$/);
		expect(exitHooks).toHaveLength(1);
		exitHooks[0]!();
		expect(created[0]!.killed).toBe(1);
	});

	it("survives reload, /new, and resume, and stops on the replacing session's quit", async () => {
		let pi = instance();
		await pi.fire("session_start", { reason: "startup" }, createCtx("a"));
		for (const reason of ["reload", "new", "resume", "fork"]) {
			await pi.fire("session_shutdown", { reason }, createCtx("a"));
			pi = instance();
			await pi.fire("session_start", { reason }, createCtx(reason === "reload" ? "a" : `after-${reason}`));
		}
		expect(created).toHaveLength(1);
		expect(created[0]!.shutdowns).toBe(0);
		expect(created[0]!.listeners.size).toBe(1);
		await pi.fire("session_shutdown", { reason: "quit" }, createCtx("after-fork"));
		expect(created[0]!.shutdowns).toBe(1);
		expect(sharedState().manager).toBeUndefined();
		expect(exitHooks).toHaveLength(1);
	});

	it("a child session's quit neither stops the manager nor the parent's subscription", async () => {
		const parent = instance();
		await parent.fire("session_start", { reason: "startup" }, createCtx("parent"));
		const child = instance();
		await child.fire("session_start", { reason: "startup" }, createCtx("child", { mode: "print", hasUI: false }));
		expect(created).toHaveLength(1);
		expect(created[0]!.listeners.size).toBe(2);
		sharedState().waits.set("w_child", "child");
		sharedState().waits.set("w_parent", "parent");
		await child.fire("session_shutdown", { reason: "quit" }, createCtx("child", { mode: "print", hasUI: false }));
		expect(created[0]!.shutdowns).toBe(0);
		expect(created[0]!.listeners.size).toBe(1);
		expect(created[0]!.cancelled).toEqual(["w_child"]);
		expect([...sharedState().waits.keys()]).toEqual(["w_parent"]);
		await parent.fire("session_shutdown", { reason: "quit" }, createCtx("parent"));
		expect(created[0]!.shutdowns).toBe(1);
	});

	it("a child starting while the root is replaced does not take over", async () => {
		const parent = instance();
		await parent.fire("session_start", { reason: "startup" }, createCtx("parent"));
		await parent.fire("session_shutdown", { reason: "new" }, createCtx("parent"));
		const child = instance();
		await child.fire("session_start", { reason: "startup" }, createCtx("child", { mode: "print" }));
		await child.fire("session_shutdown", { reason: "quit" }, createCtx("child", { mode: "print" }));
		expect(created[0]!.shutdowns).toBe(0);
		const replaced = instance();
		await replaced.fire("session_start", { reason: "new" }, createCtx("next"));
		await replaced.fire("session_shutdown", { reason: "quit" }, createCtx("next"));
		expect(created[0]!.shutdowns).toBe(1);
	});

	it("routes manager events to the session's notifier and footer while subscribed", async () => {
		vi.useFakeTimers();
		try {
			const bus = createBus();
			const pi = instance(bus);
			await pi.fire("session_start", { reason: "startup" }, createCtx("a"));
			const manager = created[0]!;
			const changes = () => bus.emits.filter((e) => e.channel === CHANGED).length;
			const before = changes();
			manager.emit({ type: "changed", process: info({ owner: "a" }) });
			expect(changes()).toBe(before + 1);
			manager.emit({ type: "exit", requested: false, tail: [], process: info({ owner: "a", status: "exited", exitCode: 2, endedAt: 2_000 }) });
			await vi.advanceTimersByTimeAsync(300);
			expect(pi.sent).toHaveLength(1);
			expect(pi.sent[0]!.options.triggerTurn).toBe(true);
			await pi.fire("session_shutdown", { reason: "reload" }, createCtx("a"));
			manager.emit({ type: "changed", process: info() });
			expect(changes()).toBe(before + 1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("tools fail loudly before any session started a manager", async () => {
		const pi = instance();
		await expect(pi.tools.get("process_list")!.execute("call", {}, undefined, undefined, createCtx("a"))).rejects.toThrow(/not running/);
	});

	it("registers the tools, /ps, and the bash guard", () => {
		const pi = instance();
		expect([...pi.tools.keys()].sort()).toEqual(["bash", "process_list", "process_logs", "process_restart", "process_start", "process_stop", "process_wait"]);
		expect([...pi.commands.keys()]).toEqual(["ps"]);
		expect(pi.handlers.has("tool_call")).toBe(true);
	});
});
