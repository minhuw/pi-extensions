import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootManager } from "./helpers/manager-probe.js";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../src/worktree.js", async () => {
  const actual = await vi.importActual<typeof import("../src/worktree.js")>("../src/worktree.js");
  return {
    ...actual,
    createWorktree: vi.fn(),
    cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
    pruneWorktrees: vi.fn(async () => {}),
  };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function persistedSession(file: string) {
  return {
    dispose: vi.fn(),
    messages: [{ role: "user" }, { role: "assistant" }],
    getSessionStats: () => ({ contextUsage: { percent: 42 } }),
    sessionManager: { getSessionFile: () => file },
    extensionRunner: {
      hasHandlers: vi.fn((event: string) => event === "session_shutdown"),
      emit: vi.fn(async () => {}),
    },
  } as any;
}

function inMemorySession() {
  return {
    dispose: vi.fn(),
    messages: [{ role: "user" }],
    getSessionStats: () => ({ contextUsage: { percent: 18 } }),
    extensionRunner: {
      hasHandlers: vi.fn((event: string) => event === "session_shutdown"),
      emit: vi.fn(async () => {}),
    },
  } as any;
}

function makePi() {
  const lifecycle = new Map<string, any>();
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  const bus = {
    emit: vi.fn((event: string, data: unknown) => {
      for (const h of [...(handlers.get(event) ?? [])]) h(data);
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    }),
  };
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: bus,
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, lifecycle, bus };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

describe("subagents:rpc:release", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-release-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-release-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "subagents.json"),
      JSON.stringify({ schedulingEnabled: false, outputTranscript: false }),
    );
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    delete (globalThis as any)[Symbol.for("pi-subagents:host")];
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function boot() {
    const booted = makePi();
    subagentsExtension(booted.pi);
    await booted.lifecycle.get("session_start")({}, ctx());
    shutdown = () => booted.lifecycle.get("session_shutdown")();
    return booted;
  }

  async function rpcCall<T = void>(
    bus: ReturnType<typeof makePi>["bus"],
    channel: string,
    payload: Record<string, unknown>,
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    const requestId = `req-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const unsub = bus.on(`subagents:rpc:${channel}:reply:${requestId}`, (reply: any) => {
        unsub();
        resolve(reply);
      });
      bus.emit(`subagents:rpc:${channel}`, { requestId, ...payload });
    });
  }

  it("clears retain and tears down a settled retained persisted session immediately", async () => {
    const session = persistedSession("/tmp/council-r1.jsonl");
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false } as any;
    });

    const { bus } = await boot();
    const spawnReply = await rpcCall<{ id: string }>(bus, "spawn", {
      type: "worker",
      prompt: "analyze",
      options: { description: "retained", isBackground: true, retain: true, notifyParent: false },
    });
    expect(spawnReply.success).toBe(true);
    const id = spawnReply.data!.id;

    const manager = rootManager()!;
    await manager.getRecord(id)!.promise;

    // While retained, the session stays attached and undisposed.
    expect(manager.getRecord(id)!.retain).toBe(true);
    expect(manager.getRecord(id)!.session).toBe(session);
    expect(session.dispose).not.toHaveBeenCalled();

    const releaseReply = await rpcCall(bus, "release", { agentId: id });
    expect(releaseReply).toEqual({ success: true });

    expect(manager.getRecord(id)!.retain).toBe(false);
    expect(manager.getRecord(id)!.session).toBeUndefined();
    expect(manager.getRecord(id)!.sessionFile).toBe("/tmp/council-r1.jsonl");
    expect(manager.getRecord(id)!.contextPercent).toBe(42);
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
  });

  it("clears retain and tears down a settled retained in-memory session immediately", async () => {
    const session = inMemorySession();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false } as any;
    });

    const { bus } = await boot();
    const spawnReply = await rpcCall<{ id: string }>(bus, "spawn", {
      type: "worker",
      prompt: "analyze",
      options: { description: "retained-mem", isBackground: true, retain: true, notifyParent: false },
    });
    const id = spawnReply.data!.id;
    const manager = rootManager()!;
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.session).toBe(session);
    const releaseReply = await rpcCall(bus, "release", { agentId: id });
    expect(releaseReply).toEqual({ success: true });

    expect(manager.getRecord(id)!.retain).toBe(false);
    expect(manager.getRecord(id)!.session).toBeUndefined();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
  });

  it("clears retain on a still-running agent and tears down its session automatically upon settle", async () => {
    const session = persistedSession("/tmp/council-running.jsonl");
    let finishRun!: () => void;
    let sessionReady!: () => void;
    const ready = new Promise<void>((r) => { sessionReady = r; });

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      sessionReady();
      await new Promise<void>((r) => { finishRun = r; });
      return { responseText: "done", session, aborted: false, steered: false } as any;
    });

    const { bus } = await boot();
    const spawnReply = await rpcCall<{ id: string }>(bus, "spawn", {
      type: "worker",
      prompt: "analyze",
      options: { description: "retained-running", isBackground: true, retain: true, notifyParent: false },
    });
    const id = spawnReply.data!.id;
    await ready;

    const manager = rootManager()!;
    const releaseReply = await rpcCall(bus, "release", { agentId: id });
    expect(releaseReply).toEqual({ success: true });

    // Still running: retain is cleared, but session is NOT torn down mid-run.
    expect(manager.getRecord(id)!.retain).toBe(false);
    expect(manager.getRecord(id)!.session).toBe(session);
    expect(session.dispose).not.toHaveBeenCalled();

    // Once the run settles, the session tears down automatically.
    finishRun();
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.session).toBeUndefined();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
  });

  it("waits for an aborted running agent to finish unwinding before tearing down its session", async () => {
    const session = inMemorySession();
    let finishUnwind!: () => void;
    let sessionReady!: () => void;
    const ready = new Promise<void>((r) => { sessionReady = r; });

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      sessionReady();
      await new Promise<void>((r) => { finishUnwind = r; });
      return { responseText: "", session, aborted: true, steered: false } as any;
    });

    const { bus } = await boot();
    const spawnReply = await rpcCall<{ id: string }>(bus, "spawn", {
      type: "worker",
      prompt: "analyze",
      options: { description: "stop-then-release", isBackground: true, retain: true, notifyParent: false },
    });
    const id = spawnReply.data!.id;
    await ready;

    const manager = rootManager()!;
    // Simulate council cancellation: stop followed immediately by release while runAgent unwinds.
    const stopReply = await rpcCall(bus, "stop", { agentId: id });
    expect(stopReply).toEqual({ success: true });
    const releaseReply = await rpcCall(bus, "release", { agentId: id });
    expect(releaseReply).toEqual({ success: true });

    // Session must remain live until runAgent finishes unwinding its abort.
    expect(manager.getRecord(id)!.retain).toBe(false);
    expect(manager.getRecord(id)!.session).toBe(session);
    expect(session.dispose).not.toHaveBeenCalled();

    finishUnwind();
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.session).toBeUndefined();
    await vi.waitFor(() => expect(session.dispose).toHaveBeenCalledOnce());
  });

  it("refuses to release non-top-level (nested child or workflow) agents", async () => {
    const childSession = persistedSession("/tmp/nested-child.jsonl");
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(childSession);
      return { responseText: "done", session: childSession, aborted: false, steered: false } as any;
    });

    const { pi, bus } = await boot();
    const manager = rootManager()!;
    const nestedId = manager.spawn(pi, ctx(), "worker", "nested", {
      description: "nested",
      isBackground: true,
      retain: true,
      parentAgentId: "parent-1",
    });
    const workflowId = manager.spawn(pi, ctx(), "worker", "wf", {
      description: "wf",
      isBackground: true,
      retain: true,
      workflowId: "wf-1",
    });
    await Promise.all([manager.getRecord(nestedId)!.promise, manager.getRecord(workflowId)!.promise]);

    const nestedReply = await rpcCall(bus, "release", { agentId: nestedId });
    expect(nestedReply).toEqual({
      success: false,
      error: "Agent is owned by another agent or workflow",
    });
    expect(manager.getRecord(nestedId)!.retain).toBe(true);
    expect(manager.getRecord(nestedId)!.session).toBe(childSession);

    const wfReply = await rpcCall(bus, "release", { agentId: workflowId });
    expect(wfReply).toEqual({
      success: false,
      error: "Agent is owned by another agent or workflow",
    });
    expect(manager.getRecord(workflowId)!.retain).toBe(true);
  });
});

describe("AgentManager.release — record GC eligibility", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await manager?.dispose();
    vi.useRealTimers();
  });

  it("makes a released retained record eligible for 10-minute cleanup eviction", async () => {
    const session = persistedSession("/tmp/gc-retained.jsonl");
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onSessionCreated?.(session);
      return { responseText: "done", session, aborted: false, steered: false } as any;
    });

    manager = new AgentManager();
    const id = manager.spawn({} as any, { cwd: "/tmp" } as any, "worker", "retain-me", {
      description: "retain-me",
      isBackground: true,
      retain: true,
    });
    await manager.getRecord(id)!.promise;

    const record = manager.getRecord(id)!;
    record.completedAt = Date.now() - 11 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    // Still retained -> skipped by cleanup.
    expect(manager.getRecord(id)).toBeDefined();

    expect(manager.release(id)).toBe(true);
    expect(record.retain).toBe(false);
    expect(record.session).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    // Once released, cleanup evicts the expired record.
    expect(manager.getRecord(id)).toBeUndefined();
  });
});
