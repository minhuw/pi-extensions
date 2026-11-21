/**
 * schedule.test.ts — SubagentScheduler engine.
 *
 * Tests:
 *   - Static format parsers (cron / relative / interval / detection)
 *   - Job lifecycle (add / update / remove / cleanup)
 *   - Fire path (interval, one-shot) with mocked AgentManager + fake timers
 *   - Past-timestamp rejection
 *   - One-shot auto-disable
 *   - Concurrency-bypass option flows through to manager.spawn
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cron } from "croner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_FALLBACK, registerAgents, setFallbackSubagent } from "../src/agent-types.js";
import { MAX_TIMEOUT_MS, SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

function makeMockManager() {
  const spawnFn = vi.fn(() => "agent-" + Math.random().toString(36).slice(2, 10));
  return {
    spawn: spawnFn,
    awaitStartup: vi.fn(async () => {}),
    getRecord: vi.fn(() => ({ promise: Promise.resolve("done") })),
  } as any;
}

function makeMockPi() {
  return {
    events: { emit: vi.fn() },
  } as any;
}

function makeMockCtx() {
  return {
    cwd: "/tmp",
    modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
    sessionManager: { getSessionId: () => "sess-1" },
  } as any;
}

describe("SubagentScheduler — static format parsers", () => {
  it("parseRelativeTime accepts +Ns/Nm/Nh/Nd and rejects bare numbers", () => {
    const before = Date.now();
    const iso = SubagentScheduler.parseRelativeTime("+10s");
    expect(iso).not.toBeNull();
    const t = new Date(iso!).getTime();
    expect(t - before).toBeGreaterThanOrEqual(9_000);
    expect(t - before).toBeLessThanOrEqual(11_000);

    expect(SubagentScheduler.parseRelativeTime("+5m")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+1h")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+2d")).not.toBeNull();

    // Bare digits / wrong unit / no plus → null
    expect(SubagentScheduler.parseRelativeTime("10s")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+5x")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("hello")).toBeNull();
  });

  it("parseInterval converts unit-suffixed strings to milliseconds", () => {
    expect(SubagentScheduler.parseInterval("10s")).toBe(10_000);
    expect(SubagentScheduler.parseInterval("5m")).toBe(300_000);
    expect(SubagentScheduler.parseInterval("1h")).toBe(3_600_000);
    expect(SubagentScheduler.parseInterval("2d")).toBe(172_800_000);

    expect(SubagentScheduler.parseInterval("+5m")).toBeNull();   // relative isn't an interval
    expect(SubagentScheduler.parseInterval("5x")).toBeNull();
    expect(SubagentScheduler.parseInterval("five-minutes")).toBeNull();
  });

  it("validateCronExpression rejects non-6-field expressions", () => {
    expect(SubagentScheduler.validateCronExpression("* * * * *").valid).toBe(false);  // 5 fields
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * 1").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * *").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("not-a-cron").valid).toBe(false);
  });

  it("detectSchedule tags type and normalizes input", () => {
    expect(SubagentScheduler.detectSchedule("+10m").type).toBe("once");
    expect(SubagentScheduler.detectSchedule("5m").type).toBe("interval");
    expect(SubagentScheduler.detectSchedule("5m").intervalMs).toBe(300_000);
    expect(SubagentScheduler.detectSchedule("0 0 9 * * 1").type).toBe("cron");

    const iso = "2099-01-01T00:00:00.000Z";
    const r = SubagentScheduler.detectSchedule(iso);
    expect(r.type).toBe("once");
    expect(r.normalized).toBe(iso);

    expect(() => SubagentScheduler.detectSchedule("garbage")).toThrow(/Invalid schedule/);
  });

  it("rejects non-positive (<= 0) intervals and relative durations", () => {
    for (const bad of ["+0s", "+0m", "+0h", "+0d", "+00s", "-5s", "+-5s", "0", "-10"]) {
      expect(SubagentScheduler.parseRelativeTime(bad)).toBeNull();
    }
    for (const bad of ["0s", "0m", "0h", "0d", "00s", "-5s", "-1m", "0", "-10"]) {
      expect(SubagentScheduler.parseInterval(bad)).toBeNull();
    }
    for (const bad of ["0s", "0m", "0h", "0d", "+0s", "+0m", "0", "-5s", "-10"]) {
      expect(() => SubagentScheduler.detectSchedule(bad)).toThrow(/Invalid schedule/);
    }
  });

  it("validateCronExpression does not leak active Cron timers", () => {
    vi.useFakeTimers();
    const stopSpy = vi.spyOn(Cron.prototype, "stop");
    try {
      expect(vi.getTimerCount()).toBe(0);

      expect(SubagentScheduler.validateCronExpression("0 0 9 * * 1")).toEqual({ valid: true });
      expect(vi.getTimerCount()).toBe(0);

      expect(SubagentScheduler.validateCronExpression("* * * * * *")).toEqual({ valid: true });
      expect(vi.getTimerCount()).toBe(0);

      expect(SubagentScheduler.validateCronExpression("60 0 9 * * *").valid).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      expect(SubagentScheduler.detectSchedule("0 0 9 * * 1")).toEqual({
        type: "cron",
        normalized: "0 0 9 * * 1",
      });
      expect(vi.getTimerCount()).toBe(0);

      // Each successfully constructed Cron validation instance was explicitly stopped.
      expect(stopSpy).toHaveBeenCalledTimes(3);
    } finally {
      stopSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("SubagentScheduler — lifecycle", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    registerAgents(new Map());
    tmp = mkdtempSync(join(tmpdir(), "scheduler-test-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("isActive() reports start/stop state", () => {
    expect(scheduler.isActive()).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive()).toBe(false);
  });

  it("addJob persists, arms, and emits added event", () => {
    const job = scheduler.addJob({
      name: "j1",
      description: "test",
      schedule: "1h",
      subagent_type: "worker",
      prompt: "hi",
    });
    expect(job.scheduleType).toBe("interval");
    expect(scheduler.list()).toHaveLength(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "added" }));
  });

  it("addJob rejects duplicate names", () => {
    scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "worker", prompt: "p" });
    expect(() => scheduler.addJob({
      name: "j1", description: "y", schedule: "2h", subagent_type: "worker", prompt: "p2",
    })).toThrow(/already exists/);
  });

  it("removeJob clears the job and emits removed", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "worker", prompt: "p" });
    expect(scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.list()).toEqual([]);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "removed", jobId: job.id }));
  });

  it("updateJob({enabled: false}) unschedules but keeps the record", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "worker", prompt: "p" });
    scheduler.updateJob(job.id, { enabled: false });
    expect(scheduler.list()[0].enabled).toBe(false);
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });

  // Regression: getNextRun on a freshly-created interval used to return undefined
  // (the lastRun-based branch needs lastRun, which is undefined before first fire),
  // surfacing as "Next run: (unknown)" in the agent's create-response.
  it("getNextRun returns an approximate future time for a fresh interval (no lastRun yet)", () => {
    const before = Date.now();
    const job = scheduler.addJob({
      name: "fresh-interval", description: "x", schedule: "1h",
      subagent_type: "worker", prompt: "p",
    });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBeDefined();
    const t = new Date(next!).getTime();
    // Should be ~now + 1h, with a small tolerance for the time spent in the call
    expect(t - before).toBeGreaterThanOrEqual(3_600_000 - 1_000);
    expect(t - before).toBeLessThanOrEqual(3_600_000 + 1_000);
  });

  // Once a fire happens and `lastRun` is set, getNextRun should pivot to it.
  it("getNextRun uses lastRun when present for interval jobs", () => {
    const job = scheduler.addJob({
      name: "ran-once", description: "x", schedule: "1h",
      subagent_type: "worker", prompt: "p",
    });
    const lastRun = new Date(Date.now() - 30 * 60_000).toISOString(); // 30m ago
    scheduler.updateJob(job.id, { lastRun });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBe(new Date(new Date(lastRun).getTime() + 3_600_000).toISOString());
  });

  it("rejects past one-shot timestamps upfront — no record created", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() => scheduler.addJob({
      name: "past", description: "x", schedule: past, subagent_type: "worker", prompt: "p",
    })).toThrow(/in the past/);
    // No dead-on-arrival record left behind
    expect(scheduler.list()).toEqual([]);
  });

  // The safety net in scheduleJob's past-branch only fires on store reload —
  // a once-job persisted with a future ISO whose time has now passed (process
  // restart after the trigger window). detectSchedule rejects past timestamps
  // at create time, so this is the only remaining production path.
  it("disables a previously-enabled one-shot reloaded from disk past its time", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    // Direct store insert bypasses addJob's upfront validation, mimicking a
    // record that was valid when written but is now stale on reload.
    store.add({
      id: "reload-test",
      name: "reload",
      description: "reload",
      schedule: past,
      scheduleType: "once",
      subagent_type: "worker",
      prompt: "x",
      enabled: true,
      createdAt: past,
      runCount: 0,
    });
    // Re-arm: stop drops timers, start re-reads store.list() and calls scheduleJob
    // for every enabled job → the past-branch fires for our seeded record.
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    const reloaded = scheduler.list().find(j => j.id === "reload-test");
    expect(reloaded?.enabled).toBe(false);
    expect(reloaded?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: "reload-test", error: expect.stringMatching(/in the past/),
    }));
  });

  it("addJob rejects zero and negative intervals/relatives without creating records", () => {
    for (const schedule of ["0s", "0m", "+0s", "0", "-5s"]) {
      expect(() => scheduler.addJob({
        name: `bad-${schedule}`,
        description: "x",
        schedule,
        subagent_type: "worker",
        prompt: "p",
      })).toThrow(/Invalid schedule/);
    }
    expect(scheduler.list()).toEqual([]);
  });

  it("disables a reloaded interval job whose persisted intervalMs is <= 0", () => {
    const now = new Date().toISOString();
    store.add({
      id: "zero-interval",
      name: "zero-interval",
      description: "bad persisted interval",
      schedule: "0s",
      scheduleType: "interval",
      intervalMs: 0,
      subagent_type: "worker",
      prompt: "x",
      enabled: true,
      createdAt: now,
      runCount: 0,
    });
    store.add({
      id: "neg-interval",
      name: "neg-interval",
      description: "negative persisted interval",
      schedule: "-5s",
      scheduleType: "interval",
      intervalMs: -5_000,
      subagent_type: "worker",
      prompt: "x",
      enabled: true,
      createdAt: now,
      runCount: 0,
    });

    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    for (const id of ["zero-interval", "neg-interval"]) {
      const reloaded = scheduler.list().find(j => j.id === id);
      expect(reloaded?.enabled).toBe(false);
      expect(reloaded?.lastStatus).toBe("error");
      expect(scheduler.getNextRun(id)).toBeUndefined();
      expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
        type: "error",
        jobId: id,
        error: expect.stringMatching(/Invalid interval/),
      }));
    }
  });
});

describe("SubagentScheduler — fire path", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: any;
  let pi: any;
  let ctx: any;

  beforeEach(() => {
    registerAgents(new Map());
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "scheduler-fire-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    // Module-global: restore here, not at the end of a test body, so a failing
    // assertion can't leak strict dispatch into every test that follows.
    setFallbackSubagent(undefined);
    registerAgents(new Map());
    rmSync(tmp, { recursive: true, force: true });
  });

  it("interval jobs fire repeatedly via setInterval", () => {
    scheduler.addJob({
      name: "every-10s", description: "tick", schedule: "10s",
      subagent_type: "worker", prompt: "tick",
    });

    expect(manager.spawn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(10_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(manager.spawn).toHaveBeenCalledTimes(3);
  });

  it("a throwing store at fire time emits an error instead of crashing the timer tick", () => {
    scheduler.addJob({
      name: "contended", description: "tick", schedule: "10s",
      subagent_type: "general-purpose", prompt: "tick",
    });
    vi.spyOn(store, "update").mockImplementation(() => {
      throw new Error("locked by live process 999");
    });

    // An uncaught throw here would fail the test outright (uncaught in tick).
    vi.advanceTimersByTime(10_000);

    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", error: expect.stringContaining("locked by live process"),
    }));
    // The failure is bookkeeping-only; the job still spawned.
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("a throwing store at completion emits an error instead of an unhandled rejection", async () => {
    const job = scheduler.addJob({
      name: "contended-finalize", description: "tick", schedule: "10s",
      subagent_type: "general-purpose", prompt: "tick",
    });
    vi.spyOn(store, "update").mockImplementation(() => {
      throw new Error("locked by live process 999");
    });

    vi.advanceTimersByTime(10_000);
    await vi.advanceTimersByTimeAsync(0);  // drain awaitStartup -> promise -> finalize

    const errors = pi.events.emit.mock.calls.filter(
      ([channel, e]: [string, any]) => channel === "subagents:scheduled" && e.type === "error" && e.jobId === job.id,
    );
    // One for the "running" write, one for the completion write.
    expect(errors).toHaveLength(2);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("a throwing store when a one-shot auto-disables emits an error and no update", () => {
    const job = scheduler.addJob({
      name: "contended-once", description: "once", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "once",
    });
    vi.spyOn(store, "update").mockImplementation(() => {
      throw new Error("locked by live process 999");
    });

    vi.advanceTimersByTime(2_000);

    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id, error: expect.stringContaining("locked by live process"),
    }));
    expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "updated" }));
  });

  it("refuses at fire time when the job's agent type no longer resolves", () => {
    // The registry is what production populates at activation; a job outliving
    // its agent must not silently run something else (#183).
    registerAgents(new Map());
    setFallbackSubagent(NO_FALLBACK);
    const job = scheduler.addJob({
      name: "gone", description: "vanished agent", schedule: "+1s",
      subagent_type: "deleted-since", prompt: "run",
    });

    vi.advanceTimersByTime(2_000);

    expect(manager.spawn).not.toHaveBeenCalled();
    const stored = store.get(job.id);
    expect(stored?.lastStatus).toBe("error");
    // Pin WHY it failed — "didn't spawn" alone would be satisfied by any
    // unrelated pre-spawn throw.
    expect(pi.events.emit).toHaveBeenCalledWith(
      "subagents:scheduled",
      expect.objectContaining({
        type: "error",
        error: expect.stringContaining("Unknown or disabled agent type"),
      }),
    );
  });

  it("one-shot fires once and auto-disables", async () => {
    const job = scheduler.addJob({
      name: "soon", description: "once", schedule: "+1s",
      subagent_type: "worker", prompt: "once",
    });

    vi.advanceTimersByTime(2_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);

    // The auto-disable update happens synchronously inside the timer callback
    expect(scheduler.list().find(j => j.id === job.id)?.enabled).toBe(false);

    // Subsequent ticks shouldn't fire again
    vi.advanceTimersByTime(60_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
  });

  it("fire passes bypassQueue: true to manager.spawn", () => {
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "worker", prompt: "x",
    });

    vi.advanceTimersByTime(1_000);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    const optsArg = manager.spawn.mock.calls[0][4];
    expect(optsArg.bypassQueue).toBe(true);
    expect(optsArg.isBackground).toBe(true);
  });

  it("fire passes the job's configuration as the invocation snapshot", () => {
    // A scheduled run has no tool call to build one, so without this the
    // conversation viewer can say nothing about how the job was configured.
    // The model is left out on purpose: agent-manager fills in the effective one
    // once the session reports it.
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "worker", prompt: "x",
      thinking: "high", max_turns: 12, isolated: true,
    });

    vi.advanceTimersByTime(1_000);
    const optsArg = manager.spawn.mock.calls[0][4];
    expect(optsArg.invocation).toEqual({
      thinking: "high",
      maxTurns: 12,
      isolated: true,
      runInBackground: true,
      isolation: undefined,
    });
  });

  it("fire normalizes an unlimited turn budget out of the snapshot", () => {
    // 0 means unlimited; "max turns: 0" would read as a limit of none.
    scheduler.addJob({
      name: "unlimited", description: "x", schedule: "1s",
      subagent_type: "worker", prompt: "x", max_turns: 0,
    });

    vi.advanceTimersByTime(1_000);
    expect(manager.spawn.mock.calls[0][4].invocation.maxTurns).toBeUndefined();
  });

  it("disabled jobs do not fire", () => {
    const job = scheduler.addJob({
      name: "off", description: "x", schedule: "1s",
      subagent_type: "worker", prompt: "x",
    });
    scheduler.updateJob(job.id, { enabled: false });
    vi.advanceTimersByTime(5_000);
    expect(manager.spawn).toHaveBeenCalledTimes(0);
  });

  it("emits fired event with agentId on successful spawn", () => {
    scheduler.addJob({
      name: "fire-once", description: "x", schedule: "+1s",
      subagent_type: "worker", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "fired", name: "fire-once", agentId: expect.stringMatching(/^agent-/),
    }));
  });

  it("records lastStatus error and emits when manager.spawn throws", async () => {
    manager.spawn.mockImplementationOnce(() => { throw new Error("no slots"); });
    const job = scheduler.addJob({
      name: "boom", description: "x", schedule: "+1s",
      subagent_type: "worker", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);

    // Update is synchronous in the spawn-throw path
    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id, error: "no slots",
    }));
  });

  it("rejects a stored job that still names a raw model instead of spawning with it", () => {
    const job = scheduler.addJob({
      name: "legacy-model", description: "x", schedule: "+1s",
      subagent_type: "worker", prompt: "x", model: "openai/gpt-legacy",
    });
    vi.advanceTimersByTime(2_000);

    expect(manager.spawn).not.toHaveBeenCalled();
    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    expect(pi.events.emit).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id, error: expect.stringContaining("Model overrides are unavailable"),
    }));
  });

  it("records lastStatus error when the agent fails to start after spawn returns", async () => {
    // Under isolation: "worktree" the agent is not running when spawn() returns
    // — the repo copy is awaited. A failure there must be recorded as a failed
    // run, not as the success the missing run promise would otherwise imply.
    manager.awaitStartup.mockRejectedValueOnce(new Error('Cannot run with isolation: "worktree"'));
    const job = scheduler.addJob({
      name: "no-worktree", description: "x", schedule: "+1s",
      subagent_type: "worker", prompt: "x", isolation: "worktree",
    });
    vi.advanceTimersByTime(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
  });

  // ── Status reflection from record.status (regression for bug #1) ────
  // The real AgentManager's promise *always* resolves (its .catch returns ""),
  // so the schedule's success/error must be inferred from `record.status`,
  // not from promise resolution. These two tests model that contract.
  describe("infers success vs error from record.status, not promise resolution", () => {
    type FakeRecord = { status: string; promise: Promise<string>; resolve: () => void };

    function installFaithfulMock(): Map<string, FakeRecord> {
      const records = new Map<string, FakeRecord>();
      manager.spawn.mockImplementation(() => {
        const id = "agent-" + Math.random().toString(36).slice(2, 10);
        let resolve!: () => void;
        const promise = new Promise<string>(r => { resolve = () => r(""); });
        records.set(id, { status: "running", promise, resolve });
        return id;
      });
      manager.getRecord.mockImplementation((id: string) => records.get(id));
      return records;
    }

    it("records lastStatus 'error' when the agent terminates with status='error'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "fail-job", description: "x", schedule: "+1s",
        subagent_type: "worker", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      expect(manager.spawn).toHaveBeenCalledTimes(1);

      // The agent ran and ended in error — same shape the real AgentManager produces.
      const r = [...records.values()][0];
      r.status = "error";
      r.resolve();

      // Flush microtasks so .then(finalize) runs.
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    });

    it("records lastStatus 'success' when the agent terminates with status='completed'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "ok-job", description: "x", schedule: "+1s",
        subagent_type: "worker", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      const r = [...records.values()][0];
      r.status = "completed";
      r.resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("success");
    });

    it("treats aborted and stopped as errors (terminal failure states)", async () => {
      const records = installFaithfulMock();
      const a = scheduler.addJob({
        name: "abort-job", description: "x", schedule: "+1s",
        subagent_type: "worker", prompt: "x",
      });
      const b = scheduler.addJob({
        name: "stop-job", description: "x", schedule: "+2s",
        subagent_type: "worker", prompt: "x",
      });

      vi.advanceTimersByTime(3_000);
      const recs = [...records.values()];
      recs[0].status = "aborted";
      recs[0].resolve();
      recs[1].status = "stopped";
      recs[1].resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === a.id)?.lastStatus).toBe("error");
      expect(scheduler.list().find(j => j.id === b.id)?.lastStatus).toBe("error");
    });
  });

  describe("delays exceeding 32-bit signed setTimeout limit (> 2_147_483_647 ms)", () => {
    it("chains one-shot timers across MAX_TIMEOUT_MS hops instead of firing early", () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        const thirtyDaysMs = 30 * 86_400_000; // 2_592_000_000 ms > MAX_TIMEOUT_MS
        const job = scheduler.addJob({
          name: "far-once", description: "30d out", schedule: "+30d",
          subagent_type: "worker", prompt: "future",
        });

        // First hop must be clamped to MAX_TIMEOUT_MS, never exceeding 2^31 - 1.
        expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
        expect(setTimeoutSpy.mock.calls[0][1]).toBe(MAX_TIMEOUT_MS);

        // Must not overflow into an immediate 1ms firing.
        vi.advanceTimersByTime(1_000);
        expect(manager.spawn).not.toHaveBeenCalled();

        // Advance through the first MAX_TIMEOUT_MS hop — wakes up, sees remaining
        // time, and schedules the next hop without firing.
        vi.advanceTimersByTime(MAX_TIMEOUT_MS - 1_000);
        expect(manager.spawn).not.toHaveBeenCalled();
        expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
        const remaining = thirtyDaysMs - MAX_TIMEOUT_MS;
        expect(setTimeoutSpy.mock.calls[1][1]).toBe(remaining);

        // Still not fired 1ms before target.
        vi.advanceTimersByTime(remaining - 1);
        expect(manager.spawn).not.toHaveBeenCalled();

        // Fires at the exact target time and auto-disables.
        vi.advanceTimersByTime(1);
        expect(manager.spawn).toHaveBeenCalledTimes(1);
        expect(scheduler.list().find(j => j.id === job.id)?.enabled).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it("chains multi-hop one-shot delays (> 2 * MAX_TIMEOUT_MS)", () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        const sixtyDaysMs = 60 * 86_400_000; // 5_184_000_000 ms > 2 * MAX_TIMEOUT_MS
        scheduler.addJob({
          name: "very-far-once", description: "60d out", schedule: "+60d",
          subagent_type: "worker", prompt: "future",
        });

        vi.advanceTimersByTime(MAX_TIMEOUT_MS);
        expect(manager.spawn).not.toHaveBeenCalled();

        vi.advanceTimersByTime(MAX_TIMEOUT_MS);
        expect(manager.spawn).not.toHaveBeenCalled();

        const tail = sixtyDaysMs - 2 * MAX_TIMEOUT_MS;
        vi.advanceTimersByTime(tail - 1);
        expect(manager.spawn).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(manager.spawn).toHaveBeenCalledTimes(1);

        // Every scheduled step stayed within Node's 32-bit signed limit.
        for (const call of setTimeoutSpy.mock.calls) {
          const delay = call[1] as number;
          expect(delay).toBeGreaterThan(0);
          expect(delay).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
        }
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it("cleanly cancels a chained one-shot mid-chain via removeJob and stop", () => {
      const jobA = scheduler.addJob({
        name: "cancel-remove", description: "30d", schedule: "+30d",
        subagent_type: "worker", prompt: "a",
      });
      scheduler.addJob({
        name: "cancel-stop", description: "30d", schedule: "+30d",
        subagent_type: "worker", prompt: "b",
      });

      // Advance past the first MAX_TIMEOUT_MS hop so both jobs are on hop #2.
      vi.advanceTimersByTime(MAX_TIMEOUT_MS);
      expect(manager.spawn).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(2);

      // Remove jobA mid-chain; only jobB's hop #2 remains.
      scheduler.removeJob(jobA.id);
      expect(vi.getTimerCount()).toBe(1);

      // Stop scheduler mid-chain; zero timers remain.
      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);

      // Advancing well past target never fires either job.
      vi.advanceTimersByTime(60 * 86_400_000);
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("chains repeating intervals exceeding MAX_TIMEOUT_MS without overflowing", () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        const thirtyDaysMs = 30 * 86_400_000;
        scheduler.addJob({
          name: "monthly", description: "every 30d", schedule: "30d",
          subagent_type: "worker", prompt: "tick",
        });

        vi.advanceTimersByTime(MAX_TIMEOUT_MS);
        expect(manager.spawn).not.toHaveBeenCalled();

        // First fire at 30d.
        vi.advanceTimersByTime(thirtyDaysMs - MAX_TIMEOUT_MS);
        expect(manager.spawn).toHaveBeenCalledTimes(1);

        // Second fire at 60d (another chained cycle).
        vi.advanceTimersByTime(MAX_TIMEOUT_MS);
        expect(manager.spawn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(thirtyDaysMs - MAX_TIMEOUT_MS);
        expect(manager.spawn).toHaveBeenCalledTimes(2);

        for (const call of setTimeoutSpy.mock.calls) {
          const delay = call[1] as number;
          expect(delay).toBeGreaterThan(0);
          expect(delay).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
        }

        // Stop clears the armed next cycle cleanly.
        scheduler.stop();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(60 * 86_400_000);
        expect(manager.spawn).toHaveBeenCalledTimes(2);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });
});

describe("SubagentScheduler — stopped state", () => {
  it("throws on mutation when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(() => scheduler.addJob({
      name: "x", description: "x", schedule: "1h", subagent_type: "worker", prompt: "p",
    })).toThrow(/not started/);
  });

  it("list() returns empty array when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(scheduler.list()).toEqual([]);
  });
});
