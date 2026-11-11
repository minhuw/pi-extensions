import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COALESCE_MS, createNotifier, describeEvent, MESSAGE_TYPE, readyKey } from "../../src/notify.ts";
import { sharedState } from "../../src/state.ts";
import type { ProcessEvent } from "../../src/types.ts";
import { createCtx, createPi, info, resetShared } from "./fakes.ts";

beforeEach(() => {
	resetShared();
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function setup(sessionId = "session-a") {
	const pi = createPi();
	const ctx = createCtx(sessionId);
	const notifier = createNotifier(pi.api, ctx as never, sessionId);
	return { pi, ctx, notifier };
}

const ready: ProcessEvent = { type: "ready", via: "auto-url", process: info({ status: "ready", readyAt: 3_100, urls: ["http://127.0.0.1:5173"] }) };
const crash: ProcessEvent = { type: "exit", requested: false, tail: ["building", "Error: boom"], process: info({ name: "build", status: "exited", exitCode: 1, endedAt: 35_000 }) };

describe("describeEvent", () => {
	it("words each event concisely", () => {
		expect(describeEvent(ready)).toBe("[process dev] ready (auto-url) http://127.0.0.1:5173 after 2.1s");
		expect(describeEvent(crash)).toBe("[process build] exited with code 1 after 34s; last lines:\n  building\n  Error: boom");
		expect(describeEvent({ type: "error_output", lines: ["ERR x"], suppressed: 3, process: info() })).toBe("[process dev] error output (3 more suppressed):\n  ERR x");
		expect(describeEvent({ type: "wait_done", waitId: "w_1", until: "match", outcome: "satisfied", line: "compiled", tail: [], process: info() })).toBe("[process dev] wait w_1 (match) matched: compiled");
		expect(describeEvent({ type: "ready_timeout", tail: [], process: info() }, 121_000)).toBe("[process dev] not ready after 2m 00s; still starting");
		expect(describeEvent({ type: "changed", process: info() })).toBeUndefined();
	});

	it("quotes at most 20 tail lines", () => {
		const tail = Array.from({ length: 30 }, (_, i) => `line ${i}`);
		const text = describeEvent({ ...crash, tail } as ProcessEvent)!;
		expect(text.split("\n")).toHaveLength(21);
		expect(text).toContain("line 10");
		expect(text).not.toContain("line 9\n");
	});
});

describe("createNotifier", () => {
	it("coalesces the owner's events within the window into one triggering steer", () => {
		const { pi, notifier } = setup();
		notifier.handle(ready);
		vi.advanceTimersByTime(COALESCE_MS - 1);
		notifier.handle({ type: "error_output", lines: ["ERR"], suppressed: 0, process: info() });
		expect(pi.sent).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(pi.sent).toHaveLength(1);
		const { message, options } = pi.sent[0]!;
		expect(options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(message).toMatchObject({ customType: MESSAGE_TYPE, display: true });
		expect(message.content).toBe("[process dev] ready (auto-url) http://127.0.0.1:5173 after 2.1s\n\n[process dev] error output:\n  ERR");
		expect(message.details.events.map((e: { type: string }) => e.type)).toEqual(["ready", "error_output"]);
		notifier.handle(crash);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(pi.sent).toHaveLength(2);
	});

	it("only notifies the UI about other sessions' processes, without errors or requested exits", () => {
		const { pi, ctx, notifier } = setup("session-b");
		notifier.handle(ready);
		notifier.handle({ type: "error_output", lines: ["ERR"], suppressed: 0, process: info() });
		notifier.handle({ ...crash, requested: true } as ProcessEvent);
		notifier.handle(crash);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(pi.sent).toEqual([]);
		expect(ctx.ui.notify.mock.calls).toEqual([
			[describeEvent(ready), "info"],
			[describeEvent({ ...crash, process: { ...crash.process, owner: "session-a" } } as ProcessEvent), "warning"],
		]);
	});

	it("skips exits the agent requested and reports the user's without a turn", () => {
		const { pi, notifier } = setup();
		const stopped = info({ status: "stopped", signal: "SIGTERM", endedAt: 6_000 });
		sharedState().requested.set("p_1", { by: "agent", session: "session-a" });
		notifier.handle({ type: "exit", requested: true, tail: [], process: stopped });
		vi.advanceTimersByTime(COALESCE_MS);
		expect(pi.sent).toEqual([]);

		sharedState().requested.set("p_1", { by: "user", session: "session-a" });
		notifier.handle({ type: "exit", requested: true, tail: [], process: stopped });
		vi.advanceTimersByTime(COALESCE_MS);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]!.message.content).toBe("[process dev] stopped by the user (signal SIGTERM)");
		expect(pi.sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: false });

		// A requested exit nobody here asked for (shutdown, another session) is not reported.
		sharedState().requested.clear();
		notifier.handle({ type: "exit", requested: true, tail: [], process: stopped });
		vi.advanceTimersByTime(COALESCE_MS);
		expect(pi.sent).toHaveLength(1);
	});

	it("a batch with any unrequested event triggers a turn", () => {
		const { pi, notifier } = setup();
		sharedState().requested.set("p_1", { by: "user", session: "session-a" });
		notifier.handle({ type: "exit", requested: true, tail: [], process: info({ status: "stopped" }) });
		notifier.handle(crash);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]!.options.triggerTurn).toBe(true);
	});

	it("delivers only the waits this session registered, once", () => {
		const { pi, notifier } = setup();
		const done = (waitId: string): ProcessEvent => ({ type: "wait_done", waitId, until: "exit", outcome: "satisfied", tail: [], process: info({ owner: "session-b", status: "exited", exitCode: 0, endedAt: 3_000 }) });
		sharedState().waits.set("w_mine", "session-a");
		sharedState().waits.set("w_theirs", "session-b");
		notifier.handle(done("w_theirs"));
		notifier.handle(done("w_mine"));
		notifier.handle(done("w_mine"));
		vi.advanceTimersByTime(COALESCE_MS);
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]!.message.content).toBe("[process dev] wait w_mine (exit) done: exited with code 0 after 2s");
		expect(sharedState().waits.has("w_mine")).toBe(false);
		expect(sharedState().waits.has("w_theirs")).toBe(true);
	});

	it("drops a ready event that a start or restart result already reported", () => {
		const { pi, notifier } = setup();
		notifier.handle(ready);
		sharedState().reportedReady.add(readyKey(ready.process));
		vi.advanceTimersByTime(COALESCE_MS);
		expect(pi.sent).toHaveLength(0);
		expect(sharedState().reportedReady.size).toBe(0);
	});

	it("drops pending events on dispose", () => {
		const { pi, notifier } = setup();
		notifier.handle(ready);
		notifier.dispose();
		vi.advanceTimersByTime(COALESCE_MS);
		expect(pi.sent).toEqual([]);
	});
});
