/**
 * wait-worktree-startup.test.ts — get_subagent_result(wait: true) during async
 * worktree startup (both top-level and nested).
 *
 * When an isolated subagent enters `startAgent()`, `record.status` flips to
 * `"running"` and `record.startGate` is cleared BEFORE `await createWorktree()`,
 * while `record.promise` is only attached AFTER `createWorktree()` resolves.
 * Calling `get_subagent_result(wait: true)` in that window must wait through
 * startup and then await completion (or report startup failure / respect caller
 * abort cleanly) rather than returning prematurely with "running".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootManager } from "./helpers/manager-probe.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof import("../src/worktree.js")>("../src/worktree.js");
  return {
    ...actual,
    createWorktree: vi.fn(),
    cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
    isWorktreeIsolationEnabled: vi.fn(() => true),
  };
});

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { cleanupWorktree, createWorktree, type WorktreeInfo } from "../src/worktree.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

const textOf = (r: any): string => r.content[0].text;

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function makeCtx(cwd: string) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd,
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []), getAll: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s-wt"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

function fakeWorktree(baseDir: string, id: string): WorktreeInfo {
  const path = join(baseDir, `wt-${id}`);
  return { path, workPath: path, branch: `pi-agent-${id}`, baseSha: "abc1234" };
}

async function isPending(p: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol("pending");
  const winner = await Promise.race([
    p.then(() => "resolved", () => "rejected"),
    new Promise((r) => setTimeout(() => r(sentinel), 25)),
  ]);
  return winner === sentinel;
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wait-wt-startup-"));
  vi.mocked(runAgent).mockReset();
  vi.mocked(createWorktree).mockReset();
  vi.mocked(cleanupWorktree).mockReset();
  vi.mocked(cleanupWorktree).mockResolvedValue({ hasChanges: false });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("top-level get_subagent_result(wait: true) during async worktree startup", () => {
  /**
   * Queue a worktree-isolated background agent behind saturated background
   * slots, then finish one filler so `drainQueue()` begins `createWorktree()`
   * while `record.promise` is still undefined.
   */
  async function enterQueuedWorktreeStartup(wtGate: ReturnType<typeof deferred<WorktreeInfo | undefined>>) {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const manager = rootManager()!;
    const c = makeCtx(tempDir);

    const runResolvers: Array<{ prompt: string; signal?: AbortSignal; resolve: (text?: string) => void }> = [];
    vi.mocked(runAgent).mockImplementation(
      (_ctx, _type, prompt, options) =>
        new Promise((resolve) => {
          runResolvers.push({
            prompt,
            signal: options.signal,
            resolve: (text = "DONE") =>
              resolve({
                responseText: text,
                session: { dispose: vi.fn() } as any,
                aborted: false,
                steered: false,
              }),
          });
        }) as any,
    );

    vi.mocked(createWorktree).mockImplementationOnce(() => wtGate.promise);

    // Fill the background pool with non-worktree agents.
    const limit = manager.getMaxConcurrent();
    for (let i = 0; i < limit; i++) {
      await tools.get("Agent").execute(
        `tc-fill-${i}`,
        { prompt: `fill-${i}`, description: `fill ${i}`, subagent_type: "worker", run_in_background: true },
        undefined,
        undefined,
        c,
      );
    }

    // Queue the worktree-isolated agent.
    const spawnRes = await tools.get("Agent").execute(
      "tc-wt",
      {
        prompt: "wt-task",
        description: "worktree task",
        subagent_type: "worker",
        run_in_background: true,
        isolation: "worktree",
      },
      undefined,
      undefined,
      c,
    );
    expect(textOf(spawnRes)).toContain("queued in background");
    const wtId = /Agent ID: (\S+)/.exec(textOf(spawnRes))![1];

    // Free one slot so drainQueue() launches the worktree agent into createWorktree().
    runResolvers.shift()!.resolve("filler-done");
    await flush();

    const record = manager.getRecord(wtId)!;
    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(record.status).toBe("running");
    expect(record.startGate).toBeUndefined();
    expect(record.promise).toBeUndefined();

    return { pi, tools, lifecycle, manager, c, wtId, record, runResolvers };
  }

  it("waits through delayed worktree startup and run completion before returning", async () => {
    const wtGate = deferred<WorktreeInfo | undefined>();
    const { tools, lifecycle, c, wtId, record, runResolvers } = await enterQueuedWorktreeStartup(wtGate);

    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-wait", { agent_id: wtId, wait: true }, undefined, undefined, c);

    // Must not return prematurely while createWorktree is still pending.
    expect(await isPending(waitPromise)).toBe(true);

    // Finish worktree creation — runAgent starts, but has not completed yet.
    wtGate.resolve(fakeWorktree(tempDir, wtId));
    await flush();
    expect(record.promise).toBeDefined();
    expect(await isPending(waitPromise)).toBe(true);

    // Complete the run and assert we receive the final payload.
    const wtRun = runResolvers.find((r) => r.prompt === "wt-task")!;
    expect(wtRun).toBeDefined();
    wtRun.resolve("WORKTREE-TOP-RESULT");

    const result = await waitPromise;
    expect(textOf(result)).toContain("Status: completed");
    expect(textOf(result)).toContain("WORKTREE-TOP-RESULT");
    expect(textOf(result)).not.toContain("still running");

    await lifecycle.get("session_shutdown")?.();
  });

  it("waits from queued state through delayed worktree startup and run completion", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const manager = rootManager()!;
    const c = makeCtx(tempDir);

    const wtGate = deferred<WorktreeInfo | undefined>();
    const runResolvers: Array<{ prompt: string; resolve: (text?: string) => void }> = [];
    vi.mocked(runAgent).mockImplementation(
      (_ctx, _type, prompt) =>
        new Promise((resolve) => {
          runResolvers.push({
            prompt,
            resolve: (text = "DONE") =>
              resolve({
                responseText: text,
                session: { dispose: vi.fn() } as any,
                aborted: false,
                steered: false,
              }),
          });
        }) as any,
    );
    vi.mocked(createWorktree).mockImplementationOnce(() => wtGate.promise);

    const limit = manager.getMaxConcurrent();
    for (let i = 0; i < limit; i++) {
      await tools.get("Agent").execute(
        `tc-q-fill-${i}`,
        { prompt: `q-fill-${i}`, description: `fill ${i}`, subagent_type: "worker", run_in_background: true },
        undefined,
        undefined,
        c,
      );
    }

    const spawnRes = await tools.get("Agent").execute(
      "tc-q-wt",
      {
        prompt: "queued-wt-task",
        description: "queued worktree task",
        subagent_type: "worker",
        run_in_background: true,
        isolation: "worktree",
      },
      undefined,
      undefined,
      c,
    );
    const wtId = /Agent ID: (\S+)/.exec(textOf(spawnRes))![1];
    const record = manager.getRecord(wtId)!;
    expect(record.status).toBe("queued");

    // Start waiting while still queued.
    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-wait-from-queued", { agent_id: wtId, wait: true }, undefined, undefined, c);

    // Free a slot — agent enters delayed worktree startup.
    runResolvers.shift()!.resolve("filler-done");
    await flush();
    expect(record.status).toBe("running");
    expect(record.promise).toBeUndefined();
    expect(await isPending(waitPromise)).toBe(true);

    // Finish worktree creation, then finish the run.
    wtGate.resolve(fakeWorktree(tempDir, wtId));
    await flush();
    expect(record.promise).toBeDefined();
    expect(await isPending(waitPromise)).toBe(true);

    runResolvers.find((r) => r.prompt === "queued-wt-task")!.resolve("QUEUED-WT-RESULT");
    const result = await waitPromise;
    expect(textOf(result)).toContain("Status: completed");
    expect(textOf(result)).toContain("QUEUED-WT-RESULT");
    expect(textOf(result)).not.toContain("still running");

    await lifecycle.get("session_shutdown")?.();
  });

  it("settles cleanly with error status when queued worktree startup fails", async () => {
    const wtGate = deferred<WorktreeInfo | undefined>();
    const { tools, lifecycle, c, wtId } = await enterQueuedWorktreeStartup(wtGate);

    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-wait-fail", { agent_id: wtId, wait: true }, undefined, undefined, c);

    expect(await isPending(waitPromise)).toBe(true);

    // Simulate createWorktree failure.
    wtGate.resolve(undefined);

    const result = await waitPromise;
    expect(textOf(result)).toContain("Status: error");
    expect(textOf(result)).toContain('Cannot run with isolation: "worktree"');
    expect(textOf(result)).not.toContain("still running");

    await lifecycle.get("session_shutdown")?.();
  });

  it("settles cleanly with error status when immediate worktree startup fails", async () => {
    const { pi, tools, lifecycle } = makePi();
    subagentsExtension(pi);
    const manager = rootManager()!;
    const c = makeCtx(tempDir);

    const wtGate = deferred<WorktreeInfo | undefined>();
    vi.mocked(createWorktree).mockImplementationOnce(() => wtGate.promise);

    // Launch an immediate background worktree agent without awaiting startup yet.
    const spawnPromise = tools.get("Agent").execute(
      "tc-immediate-wt",
      {
        prompt: "immediate-wt-task",
        description: "immediate worktree task",
        subagent_type: "worker",
        run_in_background: true,
        isolation: "worktree",
      },
      undefined,
      undefined,
      c,
    );
    await flush();

    const [record] = manager.listAgents();
    expect(record).toBeDefined();
    expect(record.status).toBe("running");
    expect(record.promise).toBeUndefined();

    const waitPromise = tools
      .get("get_subagent_result")
      .execute("tc-wait-immediate-fail", { agent_id: record.id, wait: true }, undefined, undefined, c);

    expect(await isPending(waitPromise)).toBe(true);

    wtGate.resolve(undefined);

    await expect(spawnPromise).rejects.toThrow('Cannot run with isolation: "worktree"');
    const result = await waitPromise;
    expect(textOf(result)).toContain("Status: error");
    expect(textOf(result)).toContain('Cannot run with isolation: "worktree"');
    expect(textOf(result)).not.toContain("still running");

    await lifecycle.get("session_shutdown")?.();
  });

  it("respects caller abort during worktree startup wait without aborting the child", async () => {
    const wtGate = deferred<WorktreeInfo | undefined>();
    const { tools, lifecycle, c, wtId, runResolvers } = await enterQueuedWorktreeStartup(wtGate);

    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waitOutcome = tools
      .get("get_subagent_result")
      .execute("tc-wait-abort", { agent_id: wtId, wait: true }, controller.signal, undefined, c)
      .then(
        () => "resolved",
        (err: unknown) => (err instanceof Error ? err.name : String(err)),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((r) => setTimeout(() => r("timed-out"), 100)),
    ]);

    expect(outcome).toBe("AbortError");
    expect(removeListener).toHaveBeenCalledTimes(1);

    // Child continues starting and completes unaffected.
    wtGate.resolve(fakeWorktree(tempDir, wtId));
    await flush();
    const wtRun = runResolvers.find((r) => r.prompt === "wt-task")!;
    expect(wtRun).toBeDefined();
    expect(wtRun.signal?.aborted).toBe(false);
    wtRun.resolve("AFTER-ABORT-RESULT");
    await flush();

    const completed = await tools
      .get("get_subagent_result")
      .execute("tc-fetch-after", { agent_id: wtId }, undefined, undefined, c);
    expect(textOf(completed)).toContain("Status: completed");
    expect(textOf(completed)).toContain("AFTER-ABORT-RESULT");

    await lifecycle.get("session_shutdown")?.();
  });
});

describe("nested get_subagent_result(wait: true) during async worktree startup", () => {
  function setupNested(wtGate: ReturnType<typeof deferred<WorktreeInfo | undefined>>) {
    const manager = new AgentManager(undefined, 10);
    const pi = { events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) } } as any;
    const c = makeCtx(tempDir);

    let resolveRun: ((text?: string) => void) | undefined;
    let childSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation(
      (_ctx, _type, _prompt, options) =>
        new Promise((resolve) => {
          childSignal = options.signal;
          resolveRun = (text = "WORKTREE-NESTED-RESULT") =>
            resolve({
              responseText: text,
              session: { dispose: vi.fn() } as any,
              aborted: false,
              steered: false,
            });
        }) as any,
    );
    vi.mocked(createWorktree).mockImplementationOnce(() => wtGate.promise);

    const id = manager.spawn(pi, c, "worker", "nested-wt-task", {
      description: "nested worktree child",
      isBackground: true,
      isolation: "worktree",
      parentAgentId: "parent-1",
      depth: 2,
      maxSubagentDepth: 3,
    });

    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(record.promise).toBeUndefined();

    const [, getResult] = createNestedSubagentTools({
      manager,
      pi,
      parentAgentId: "parent-1",
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: tempDir,
    });

    return {
      manager,
      c,
      id,
      record,
      getResult: getResult as any,
      getResolveRun: () => resolveRun,
      getChildSignal: () => childSignal,
    };
  }

  it("waits through delayed worktree startup and run completion before returning", async () => {
    const wtGate = deferred<WorktreeInfo | undefined>();
    const { manager, c, id, record, getResult, getResolveRun } = setupNested(wtGate);

    const waitPromise = getResult.execute("call-wait", { agent_id: id, wait: true }, undefined, undefined, c);
    expect(await isPending(waitPromise)).toBe(true);

    wtGate.resolve(fakeWorktree(tempDir, id));
    await flush();
    expect(record.promise).toBeDefined();
    expect(await isPending(waitPromise)).toBe(true);

    getResolveRun()?.("WORKTREE-NESTED-RESULT");
    const result = await waitPromise;
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("WORKTREE-NESTED-RESULT");

    await manager.dispose();
  });

  it("settles cleanly with error result when nested worktree startup fails", async () => {
    const wtGate = deferred<WorktreeInfo | undefined>();
    const { manager, c, id, getResult } = setupNested(wtGate);

    const waitPromise = getResult.execute("call-wait-fail", { agent_id: id, wait: true }, undefined, undefined, c);
    expect(await isPending(waitPromise)).toBe(true);

    wtGate.resolve(undefined);

    const result = await waitPromise;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Agent failed:");
    expect(textOf(result)).toContain('Cannot run with isolation: "worktree"');

    await manager.dispose();
  });

  it("settles cleanly as stopped when the child is aborted during worktree startup", async () => {
    const wtGate = deferred<WorktreeInfo | undefined>();
    const { manager, c, id, getResult } = setupNested(wtGate);

    const waitPromise = getResult.execute("call-wait-stopped", { agent_id: id, wait: true }, undefined, undefined, c);
    expect(await isPending(waitPromise)).toBe(true);

    // Abort the child itself while worktree creation is in flight.
    expect(manager.abort(id)).toBe(true);
    wtGate.resolve(fakeWorktree(tempDir, id));

    const result = await waitPromise;
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain("STOPPED BY THE USER");
    expect(textOf(result)).not.toContain("is running");
    expect(cleanupWorktree).toHaveBeenCalledTimes(1);

    await manager.dispose();
  });

  it("respects caller abort during nested worktree startup wait without aborting the child", async () => {
    const wtGate = deferred<WorktreeInfo | undefined>();
    const { manager, c, id, getResult, getResolveRun, getChildSignal } = setupNested(wtGate);

    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waitOutcome = getResult
      .execute("call-wait-abort", { agent_id: id, wait: true }, controller.signal, undefined, c)
      .then(
        () => "resolved",
        (err: unknown) => (err instanceof Error ? err.name : String(err)),
      );

    controller.abort();
    const outcome = await Promise.race([
      waitOutcome,
      new Promise<string>((r) => setTimeout(() => r("timed-out"), 100)),
    ]);

    expect(outcome).toBe("AbortError");
    expect(removeListener).toHaveBeenCalledTimes(1);

    // Child continues starting and completes unaffected.
    wtGate.resolve(fakeWorktree(tempDir, id));
    await flush();
    expect(getChildSignal()?.aborted).toBe(false);
    getResolveRun()?.("NESTED-AFTER-ABORT");
    await flush();

    const completed = await getResult.execute("call-fetch-after", { agent_id: id }, undefined, undefined, c);
    expect(completed.isError).toBe(false);
    expect(textOf(completed)).toBe("NESTED-AFTER-ABORT");

    await manager.dispose();
  });
});
