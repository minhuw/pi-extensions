import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import loopExtension from "../index.ts";
import { duration, nextDue, parseCommand } from "../command.ts";
import { completion, makeLoop, restore, SNAPSHOT, summary } from "../state.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
function harness(mode = "tui", entries: any[] = [], sessionId = "test") {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const statuses = new Map<string, string>();
	const sent: any[] = [];
	let idle = true;
	let pending = false;
	let percent = 1;
	const ctx = {
		mode, hasUI: mode === "tui" || mode === "rpc", cwd: process.cwd(),
		isIdle: () => idle, hasPendingMessages: () => pending,
		getContextUsage: () => ({ percent }),
		abort: vi.fn(),
		ui: { notify: vi.fn(), setStatus: vi.fn((key: string, value?: string) => { if (value) statuses.set(key, value); else statuses.delete(key); }) },
		sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ type: "custom", customType, data: structuredClone(data) })),
		sendMessage: vi.fn((message: any) => { sent.push(message); idle = false; }),
	} as unknown as ExtensionAPI;
	loopExtension(pi);
	const emit = async (name: string, event: any = {}, eventContext = ctx) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, eventContext); };
	const command = (args: string) => commands.get("loop").handler(args, ctx);
	const begin = async () => {
		await emit("before_agent_start", { messageType: "custom", message: sent.at(-1) });
		await emit("agent_start");
	};
	const settle = async (text = "Still waiting", outcome = "completed") => {
		await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
		await emit("agent_before_settle", { outcome });
		idle = true;
		await emit("agent_settled", { aborted: outcome === "aborted" });
	};
	return {
		pi, ctx, sent, entries, statuses, emit, command, begin, settle,
		start: (reason = "startup") => emit("session_start", { reason }),
		stop: (reason = "quit") => emit("session_shutdown", { reason }),
		advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
		tool: (name: string, params: unknown) => tools.get(name).execute("call", params, undefined, undefined, ctx),
		setIdle: (value: boolean) => { idle = value; },
		setPending: (value: boolean) => { pending = value; },
		setPercent: (value: number) => { percent = value; },
		loops: () => entries.findLast((e) => e.customType === SNAPSHOT)?.data.loops as any[],
	};
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("loop command and schedules", () => {
	it("parses composite durations and preserves prompt text", () => {
		expect(duration("1h30m")).toBe(5_400_000);
		expect(parseCommand('5m check `echo "$BUILD"`\nthen report --name build --max 6')).toMatchObject({ action: "start", options: { name: "build", prompt: 'check `echo "$BUILD"`\nthen report', max: 6, schedule: { kind: "interval", everyMs: 300_000 } } });
		expect(parseCommand('"check the build" 5m --wait')).toMatchObject({ options: { prompt: "check the build", wait: true } });
		expect(parseCommand('--name build --until "ALL GREEN" watch CI')).toMatchObject({ options: { prompt: "watch CI", until: "ALL GREEN", schedule: { kind: "dynamic" } } });
		expect(parseCommand("5m --name build check CI")).toMatchObject({ options: { name: "build", prompt: "check CI" } });
		expect(parseCommand("check CI --max 6 5m")).toMatchObject({ options: { max: 6, prompt: "check CI" } });
		expect(parseCommand("5m check it's still working")).toMatchObject({ options: { prompt: "check it's still working" } });
		expect(parseCommand("" )).toEqual({ action: "list" });
		expect(parseCommand('"stop"')).toMatchObject({ action: "start", options: { prompt: "stop" } });
	});
	it.each(["30s check CI", "5m", "--max 0 task", "task --max NaN", "task --max 10001", "task --for 0m", "task --timeout 0s", "task --converged 1", "task --until ''", "task --name ''", "task --name all", "task --max 3 --max 4", "task --max", "task --unknown", "--unknown task", "--wait task", '"unclosed', '--cron "* * * * * *" task', '--cron "0 0 31 2 *" task', '--cron "* * * * *" 5m task'])('rejects invalid command %s', (text) => {
		expect(() => parseCommand(text)).toThrow();
	});
	it("rejects prompts too large for a recoverable loop snapshot", () => {
		expect(() => parseCommand(`1m ${"x".repeat(100_001)}`)).toThrow("100,000");
	});
	it("does not drift after long work or replay missed intervals", () => {
		const schedule = { kind: "interval" as const, everyMs: 300_000 };
		expect(nextDue(schedule, 710_000, 10_000)).toBe(910_000);
		expect(nextDue(schedule, 910_000, 10_000)).toBe(1_210_000);
	});
	it("evaluates cron in local time with standard day-of-month/day-of-week OR semantics", () => {
		const now = new Date(2026, 0, 1, 10, 2).getTime();
		expect(new Date(nextDue({ kind: "cron", expression: "*/5 * * * *" }, now, now)).getMinutes()).toBe(5);
		const next = new Date(nextDue({ kind: "cron", expression: "0 9 2 * MON" }, new Date(2026, 0, 1, 10).getTime(), now));
		expect(next.getDate()).toBe(2); // Friday the 2nd matches even though it is not Monday.
	});
});

describe("loop scheduler lifecycle", () => {
	it("starts immediately, waits for full settlement, and keeps anchored cadence", async () => {
		const h = harness(); await h.start();
		await h.command("5m watch CI --name build --max 3");
		expect(h.sent).toHaveLength(0);
		await h.advance(1); await h.begin();
		expect(h.sent).toHaveLength(1);
		expect(h.statuses.get("loop")).toContain("build · run 1/3");
		await h.advance(400_000);
		expect(h.sent).toHaveLength(1);
		await h.emit("agent_end", { messages: [] });
		expect(h.loops()[0].status).toBe("running");
		await h.settle();
		expect(h.loops()[0].dueAt).toBe(new Date("2026-01-01T00:10:00Z").getTime());
		await h.advance(200_000);
		expect(h.sent).toHaveLength(2);
		await h.stop(); expect(vi.getTimerCount()).toBe(0);
	});
	it("defers the first pass to the next fixed occurrence with --wait", async () => {
		const h = harness(); await h.start(); await h.command("5m watch CI --wait");
		await h.advance(299_999); expect(h.sent).toHaveLength(0);
		await h.advance(1); await h.begin(); expect(h.sent).toHaveLength(1);
		await h.settle(); await h.stop();
	});
	it("coalesces missed ticks while busy and honors pending human prompts", async () => {
		const h = harness(); await h.start(); h.setIdle(false);
		await h.command("1m check build --name build");
		await h.advance(600_000);
		expect(h.sent).toHaveLength(0);
		expect(h.statuses.get("loop")).toContain("waiting");
		h.setIdle(true); h.setPending(true); await h.advance(60_000);
		expect(h.sent).toHaveLength(0);
		h.setPending(false); await h.advance(1000); await h.begin();
		expect(h.sent).toHaveLength(1);
		await h.settle(); await h.advance(1);
		expect(h.sent).toHaveLength(1);
		await h.stop();
	});
	it("serializes multiple loops and cannot release dispatch ownership by stopping one", async () => {
		const h = harness(); await h.start();
		await h.command("1m first --name first"); await h.command("1m second --name second");
		await h.advance(1); await h.begin();
		expect(h.sent).toHaveLength(1);
		await h.command("stop first"); await h.advance(60_000);
		expect(h.sent).toHaveLength(1);
		await h.settle(); await h.advance(1); await h.begin();
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1].content).toContain("User task:\n\nsecond");
		await h.stop();
	});
	it.each(["new-loop", "waiting", "owner"])("preserves stopped iteration ownership at the history limit when starting %s", async (name) => {
		const command = parseCommand("1m watch CI --name owner");
		if (command.action !== "start") throw new Error("Expected start command");
		const owner = makeLoop(command.options, "00000000", Date.now());
		const history = Array.from({ length: 98 }, (_, i) => ({
			...makeLoop({ ...command.options, name: `history-${i}` }, (i + 1).toString(16).padStart(8, "0"), Date.now()),
			status: "done" as const, dueAt: null,
		}));
		const waiting = makeLoop({ ...command.options, name: "waiting" }, "000000ff", Date.now());
		const h = harness("tui", [{ type: "custom", customType: SNAPSHOT, data: { version: 1, loops: [owner, ...history, waiting] } }]);
		await h.start("reload"); await h.advance(1); await h.begin();
		await h.tool("loop_stop", { reason: "Finished" });
		const before = structuredClone(h.loops());
		const snapshots = h.entries.length;
		await h.command(`1m another task --name ${name}`);
		if (name === "new-loop") {
			expect(h.loops()).toHaveLength(100);
			expect(h.loops().some((loop) => loop.id === history[0]!.id)).toBe(false);
			expect(h.loops().find((loop) => loop.name === name)?.status).toBe("scheduled");
		} else {
			expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(`Loop name '${name}' is already in use.`, "error");
			expect(h.entries).toHaveLength(snapshots);
		}
		await h.advance(30_000);
		expect(h.loops().find((loop) => loop.id === owner.id)?.status).toBe("done");
		expect(h.loops().find((loop) => loop.id === waiting.id)?.status).toBe("scheduled");
		if (name !== "new-loop") expect(h.loops()).toEqual(before);
		expect(h.sent).toHaveLength(1);
		expect(vi.mocked(h.ctx.ui.notify).mock.calls.filter((call) => call[1] === "error")).toHaveLength(name === "new-loop" ? 0 : 1);
		await h.settle(); await h.advance(1);
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1].content).toContain("/loop waiting:");
		await h.stop();
	});
	it("cancels waiting work and requires an unambiguous management target", async () => {
		const h = harness(); await h.start(); h.setIdle(false);
		await h.command("1m first --name first"); await h.command("1m second --name second");
		await h.command("stop");
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Specify a loop"), "error");
		await h.command("pause first"); await h.command("stop second");
		h.setIdle(true); await h.advance(60_000);
		expect(h.sent).toHaveLength(0);
		await h.command("resume first"); await h.advance(60_000);
		expect(h.sent).toHaveLength(1);
		await h.stop();
	});
	it("does not dispatch while an extension dialog is open", async () => {
		const h = harness(); await h.start();
		await h.emit("ui_prompt_start"); await h.command("1m watch CI"); await h.advance(60_000);
		expect(h.sent).toHaveLength(0);
		await h.emit("ui_prompt_end"); await h.advance(1);
		expect(h.sent).toHaveLength(1);
		await h.stop();
	});
	it.each(["tui", "rpc"])("supports %s mode", async (mode) => {
		const h = harness(mode); await h.start(); await h.command("1m watch CI"); await h.advance(1);
		expect(h.sent).toHaveLength(1); await h.stop();
	});
	it.each(["print", "json"])("does not run or restore timers in %s mode", async (mode) => {
		const h = harness(mode); await h.start(); await h.command("1m watch CI");
		expect(h.sent).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("TUI or RPC"), "error");
	});
	it("does not create timers just by loading the extension", () => { harness(); expect(vi.getTimerCount()).toBe(0); });
	it.each(["pause", "stop", "timeout"])("cancels a %s dispatch still in Pi run preparation before the model call", async (action) => {
		const h = harness(); await h.start(); await h.command("1m watch CI --name build"); await h.advance(1);
		if (action === "timeout") await h.advance(30_000); else await h.command(`${action} build`);
		await h.begin();
		expect(h.ctx.abort).toHaveBeenCalledOnce();
		await h.settle("", "aborted"); await h.advance(60_000);
		expect(h.sent).toHaveLength(1); await h.stop();
	});
	it("leaves unrelated scheduled loops active after a human turn is aborted", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI --wait");
		h.setIdle(false); await h.settle("", "aborted");
		expect(h.loops()[0].status).toBe("scheduled");
		await h.advance(60_000); expect(h.sent).toHaveLength(1); await h.stop();
	});
	it("requires settlement before resuming a paused in-flight iteration", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI --name build"); await h.advance(1); await h.begin();
		await h.command("pause build"); await h.command("resume build");
		expect(h.loops()[0].status).toBe("paused");
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("settle before resuming"), "error");
		await h.settle(); await h.command("resume build"); expect(h.loops()[0].status).toBe("scheduled"); await h.stop();
	});
	it("pauses its owned loop on Escape, and does not restart after settlement", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI");
		await h.advance(1); await h.begin(); await h.settle("", "aborted");
		expect(h.loops()[0].status).toBe("paused");
		await h.advance(600_000); expect(h.sent).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
		await h.stop();
	});
	it("stops at the absolute lifetime even while waiting on a busy session", async () => {
		const h = harness(); await h.start(); h.setIdle(false);
		await h.command("1m watch CI --for 2m"); await h.advance(120_001);
		expect(h.loops()[0].status).toBe("done"); expect(h.sent).toHaveLength(0);
		await h.stop();
	});
	it("times out only its own running iteration and holds ownership until settlement", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI --timeout 1m");
		await h.advance(1); await h.begin(); await h.advance(60_000);
		expect(h.ctx.abort).toHaveBeenCalledOnce(); expect(h.loops()[0].status).toBe("paused");
		await h.settle("", "aborted"); expect(vi.getTimerCount()).toBe(0);
		await h.stop();
	});
	it("does not abort a human turn after it takes over", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI --timeout 1m");
		await h.advance(1); await h.begin();
		await h.emit("message_start", { message: { role: "user", content: "human request" } });
		await h.advance(120_000);
		expect(h.ctx.abort).not.toHaveBeenCalled(); expect(h.loops()[0].status).toBe("paused");
		await expect(h.tool("loop_stop", { reason: "done" })).rejects.toThrow("owns");
		await h.stop();
	});
	it("pauses an iteration that never starts, without aborting unrelated work", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI"); await h.advance(30_001);
		expect(h.loops()[0].status).toBe("paused"); expect(h.ctx.abort).not.toHaveBeenCalled();
		await h.stop();
	});
	it("pauses before dispatch when context is too full", async () => {
		const h = harness(); await h.start(); h.setPercent(95); await h.command("1m watch CI"); await h.advance(1);
		expect(h.loops()[0].status).toBe("paused"); expect(h.sent).toHaveLength(0); await h.stop();
	});
});

describe("loop tools and completion", () => {
	it("clamps model-paced delays and starts their countdown after settlement", async () => {
		const h = harness(); await h.start(); await h.command("watch CI"); await h.advance(1); await h.begin();
		await h.tool("loop_schedule", { delaySeconds: 1, reason: "Waiting for CI" });
		await h.advance(30_000); expect(h.sent).toHaveLength(1); await h.settle();
		await h.advance(59_999); expect(h.sent).toHaveLength(1);
		await h.advance(1); expect(h.sent).toHaveLength(2); await h.stop();
	});
	it("uses a five-minute fallback if the model does not schedule a next pass", async () => {
		const h = harness(); await h.start(); await h.command("watch CI"); await h.advance(1); await h.begin(); await h.settle();
		await h.advance(299_999); expect(h.sent).toHaveLength(1); await h.advance(1); expect(h.sent).toHaveLength(2); await h.stop();
	});
	it("refuses tool calls outside the owning iteration or against fixed schedules", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI");
		await expect(h.tool("loop_stop", { reason: "done" })).rejects.toThrow("owns the current iteration");
		await h.advance(1); await h.begin();
		await expect(h.tool("loop_schedule", { delaySeconds: 60, reason: "wait" })).rejects.toThrow("fixed");
		await h.tool("loop_stop", { reason: "CI succeeded" }); await h.settle(); await h.advance(600_000);
		expect(h.sent).toHaveLength(1); expect(h.statuses.has("loop")).toBe(false); await h.stop();
	});
	it("checks only fresh assistant output for completion and max iterations", async () => {
		const h = harness(); await h.start(); await h.command('1m watch CI --until "ALL GREEN" --max 2');
		await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "ALL GREEN" }] } });
		await h.advance(1); await h.begin(); await h.settle("Pending");
		expect(h.loops()[0].status).toBe("scheduled");
		await h.advance(60_000); await h.begin(); await h.settle("Pending");
		expect(h.loops()[0]).toMatchObject({ status: "done", iteration: 2, reason: "iteration limit reached" }); await h.stop();
	});
	it("stops on completion text, convergence, and consecutive errors", async () => {
		for (const [flags, text, outcome, count, expected] of [
			['--until "ALL GREEN"', "ALL GREEN", "completed", 1, "done"],
			["--converged 2", "identical", "completed", 2, "done"],
			["", "error", "error", 3, "failed"],
		] as const) {
			const h = harness(); await h.start(); await h.command(`1m watch CI ${flags}`);
			for (let i = 0; i < count; i++) { await h.advance(i === 0 ? 1 : 60_000); await h.begin(); await h.settle(text, outcome); }
			expect(h.loops()[0].status).toBe(expected); await h.stop();
		}
	});
});

describe("loop persistence and session isolation", () => {
	it("reloads a scheduled loop without duplicating the timer or replaying an iteration", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI --wait"); await h.advance(20_000);
		await h.stop("reload"); expect(vi.getTimerCount()).toBe(0);
		const reloaded = harness("tui", structuredClone(h.entries)); await reloaded.start("reload");
		await reloaded.advance(39_999); expect(reloaded.sent).toHaveLength(0);
		await reloaded.advance(1); expect(reloaded.sent).toHaveLength(1); await reloaded.stop();
	});
	it.each(["startup", "resume", "fork", "new"])("restores paused rather than automatically firing on %s", async (reason) => {
		const h = harness(); await h.start(); await h.command("1m watch CI --wait"); await h.stop();
		const resumed = harness("tui", structuredClone(h.entries)); await resumed.start(reason); await resumed.advance(600_000);
		expect(resumed.sent).toHaveLength(0); expect(resumed.loops()[0].status).toBe("paused"); await resumed.stop();
	});
	it("does not replay a running iteration after reload", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI"); await h.advance(1); await h.begin();
		await h.stop("reload"); const reloaded = harness("tui", structuredClone(h.entries)); await reloaded.start("reload");
		await reloaded.advance(600_000); expect(reloaded.sent).toHaveLength(0); expect(reloaded.loops()[0].status).toBe("paused"); await reloaded.stop();
	});
	it("fails closed on a corrupt latest snapshot rather than falling back to an old active one", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI"); await h.stop("reload");
		const entries = [...h.entries, { type: "custom", customType: SNAPSHOT, data: { version: 1, loops: [{}] } }];
		const reloaded = harness("tui", entries); await reloaded.start("reload"); await reloaded.advance(60_000);
		expect(reloaded.sent).toHaveLength(0); expect(reloaded.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("could not be restored"), "warning"); await reloaded.stop();
	});
	it("isolates different sessions and ignores print child lifecycle", async () => {
		const root = harness("tui", [], "root"); const child = harness("print", [], "root");
		await root.start(); await root.command("1m watch CI --wait"); await child.start(); await child.stop();
		await root.advance(60_000); expect(root.sent).toHaveLength(1); expect(child.sent).toHaveLength(0); await root.stop();
	});
	it("ignores print child events even when they reach the parent's handlers with its session id", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI --wait");
		const child = { ...h.ctx, mode: "print" } as ExtensionContext;
		await h.emit("session_shutdown", { reason: "quit" }, child);
		await h.emit("agent_settled", { aborted: true }, child);
		await h.advance(60_000); expect(h.sent).toHaveLength(1); await h.stop();
	});
	it("does not arm recovered work if recording the restored state fails", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI --wait"); await h.stop("reload");
		const reloaded = harness("tui", structuredClone(h.entries));
		vi.mocked(reloaded.pi.appendEntry).mockImplementation(() => { throw new Error("storage unavailable"); });
		await reloaded.start("reload"); await reloaded.advance(60_000);
		expect(reloaded.sent).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
		vi.mocked(reloaded.pi.appendEntry).mockReset(); await reloaded.stop();
	});
	it("pauses loops on conversation tree navigation", async () => {
		const h = harness(); await h.start(); await h.command("1m watch CI --wait"); await h.emit("session_tree");
		await h.advance(60_000); expect(h.sent).toHaveLength(0); expect(h.loops()[0].status).toBe("paused"); await h.stop();
	});
	it("validates persisted fields and bounds convergence history to a digest", () => {
		const cmd = parseCommand('1m watch CI --converged 2'); if (cmd.action !== "start") throw new Error();
		const loop = makeLoop(cmd.options, "12345678", Date.now());
		expect(completion(loop, "same")).toBeUndefined(); expect(loop.lastHash).toHaveLength(64);
		expect(completion(loop, "")).toBeUndefined(); expect(loop.identical).toBe(0);
		expect(() => restore({ version: 1, loops: [{ ...loop, max: 0 }] })).toThrow();
		expect(() => restore({ version: 1, loops: [{ ...loop, dueAt: NaN }] })).toThrow();
		expect(restore({ version: 1, loops: [loop] })).toEqual([loop]);
		expect(summary([loop], undefined, Date.now())).toContain("waiting");
	});
});
