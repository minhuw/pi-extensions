/**
 * Protocol 3 of the cross-extension RPC, against the real extension with a
 * dispatching bus and a scripted runner: `model_visible: false` types, the
 * spawn options `notifyParent` / `retain` / `parentToolCallId` / `linkData`,
 * `subagents:rpc:send`, `subagents:rpc:reopen`, and the lifecycle payloads.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});
vi.mock("../src/mention-clone.js", () => ({ runMentionClone: vi.fn() }));

const managers = vi.hoisted(() => [] as any[]);
vi.mock("../src/agent-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent-manager.js")>();
  return {
    ...actual,
    AgentManager: class extends actual.AgentManager {
      constructor(...args: ConstructorParameters<typeof actual.AgentManager>) {
        super(...args);
        managers.push(this);
      }
    },
  };
});
const rootManager = (): import("../src/agent-manager.js").AgentManager | undefined => managers[0];

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { getAgentConfig, getAvailableTypes, getEnabledTypes, NO_FALLBACK, setFallbackSubagent } from "../src/agent-types.js";
import { PROTOCOL_VERSION } from "../src/cross-extension-rpc.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "../test/helpers/boot-extension.js";

/** Past the completion outbox's 200 ms idle hold. */
const PAST_THE_HOLD_MS = 400;

/** A type no model may name, as a real agent file. */
const HIDDEN_AGENT = "---\ndescription: Not for models\nmodel_visible: false\nisolation: off\n---\nHidden.\n";

let hermetic: Hermetic | undefined;
let lifecycle: Map<string, any> | undefined;
let sessionCounter = 0;

function dispatchingBus() {
  const handlers = new Map<string, ((data: unknown) => void)[]>();
  return {
    emit: vi.fn((event: string, data: unknown) => {
      for (const h of [...(handlers.get(event) ?? [])]) h(data);
    }),
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter(h => h !== handler));
    }),
  };
}

function fakeSession(file?: string) {
  const id = `sess-${++sessionCounter}`;
  return {
    sessionId: id,
    sessionManager: { getSessionFile: () => file },
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

/** runAgent that creates a session, calls `tools` tools, then waits for `hold` (if any). */
function scriptRun(opts: { tools?: number; hold?: Promise<void>; file?: string } = {}) {
  vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, o: any) => {
    const session = fakeSession(opts.file);
    o.onSessionCreated?.(session);
    for (let i = 0; i < (opts.tools ?? 0); i++) {
      o.onToolActivity?.({ type: "start", toolName: "read" });
      o.onToolActivity?.({ type: "end", toolName: "read" });
    }
    await opts.hold;
    return { responseText: "spawn answer", session, aborted: false, steered: false } as any;
  });
}

function scriptResume(tools: number) {
  vi.mocked(resumeAgent).mockImplementation(async (_session: any, _prompt: any, o: any) => {
    for (let i = 0; i < tools; i++) {
      o.onToolActivity?.({ type: "start", toolName: "read" });
      o.onToolActivity?.({ type: "end", toolName: "read" });
    }
    return { text: "resumed answer" } as any;
  });
}

async function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({
    settings: { outputTranscript: false, schedulingEnabled: false, ...settings },
    agentFiles: { "hidden-helper": HIDDEN_AGENT },
  });
  const booted = makePi();
  const bus = dispatchingBus();
  booted.pi.events = bus;
  subagentsExtension(booted.pi);
  lifecycle = booted.lifecycle;
  const parentCtx = ctx({ isProjectTrusted: () => true });
  await booted.lifecycle.get("session_start")({}, parentCtx);
  const events: Array<{ name: string; data: any }> = [];
  for (const name of ["subagents:started", "subagents:completed", "subagents:failed"]) {
    bus.on(name, (data) => events.push({ name, data }));
  }
  let n = 0;
  const rpc = async (channel: string, payload: Record<string, unknown>): Promise<any> => {
    const requestId = `req-${++n}`;
    let reply: any;
    bus.on(`subagents:rpc:${channel}:reply:${requestId}`, (r) => { reply = r; });
    bus.emit(`subagents:rpc:${channel}`, { requestId, ...payload });
    await vi.waitFor(() => expect(reply).toBeDefined());
    return reply;
  };
  const notifications = () =>
    booted.pi.sendMessage.mock.calls.filter((c: any[]) => c[0]?.customType === "subagent-notification");
  return { ...booted, bus, rpc, events, notifications, parentCtx };
}

/** Evict settled records the way the 10-minute timer does, with the clock moved past it. */
function runCleanup(): void {
  const later = Date.now() + 11 * 60_000;
  const spy = vi.spyOn(Date, "now").mockReturnValue(later);
  try { (rootManager() as any).cleanup(); } finally { spy.mockRestore(); }
}

beforeEach(() => {
  managers.length = 0;
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(async () => {
  await lifecycle?.get("session_shutdown")?.();
  lifecycle = undefined;
  setFallbackSubagent(undefined);
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  delete (globalThis as any)[Symbol.for("pi-subagents:host")];
  hermetic?.restore();
  hermetic = undefined;
  vi.restoreAllMocks();
});

describe("protocol version", () => {
  it("ping answers 3", async () => {
    const { rpc } = await boot();
    expect(PROTOCOL_VERSION).toBe(3);
    expect(await rpc("ping", {})).toEqual({ success: true, data: { version: 3 } });
  });
});

describe("model_visible: false", () => {
  it("keeps a hidden type out of the Agent tool's description, listing and fallback", async () => {
    const { tools } = await boot();
    expect(getAgentConfig("hidden-helper")?.modelVisible).toBe(false);
    expect(getEnabledTypes()).toContain("hidden-helper");
    expect(getAvailableTypes()).not.toContain("hidden-helper");
    const agent = tools.get("Agent");
    expect(agent.description).not.toMatch(/\bhidden-helper\b/i);
    expect(JSON.stringify(agent.parameters)).not.toMatch(/\bhidden-helper\b/);
  });

  it("refuses a direct Agent call naming it, without spawning", async () => {
    const { tools } = await boot();
    setFallbackSubagent(NO_FALLBACK);
    const result = await tools.get("Agent").execute(
      "tc-1", { prompt: "go", description: "hidden", subagent_type: "hidden-helper" }, undefined, undefined, ctx(),
    );
    expect(textOf(result)).toContain('Unknown or disabled agent type: "hidden-helper"');
    expect(textOf(result)).not.toMatch(/Available:.*\bhidden-helper\b/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("falls back to worker, not to the hidden type, when the fallback policy applies", async () => {
    const { tools } = await boot();
    scriptRun();
    const result = await tools.get("Agent").execute(
      "tc-2", { prompt: "go", description: "hidden", subagent_type: "hidden-helper" }, undefined, undefined, ctx(),
    );
    expect(textOf(result)).toContain('Note: Unknown agent type "hidden-helper"');
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "worker", "go", expect.anything());
  });

  it("is never a configured fallback", async () => {
    const { tools } = await boot();
    setFallbackSubagent("hidden-helper");
    const result = await tools.get("Agent").execute(
      "tc-3", { prompt: "go", description: "x", subagent_type: "nope" }, undefined, undefined, ctx(),
    );
    expect(textOf(result)).toContain('The configured fallbackSubagent "hidden-helper" is itself unknown or disabled');
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("is not listed or spawnable by nested tools, even under allowed_subagents: all", async () => {
    await boot();
    const [agentTool] = createNestedSubagentTools({
      manager: {} as any, pi: {} as any, parentAgentId: "p", depth: 1, maxSubagentDepth: 3,
      allowedSubagents: "all", configCwd: process.cwd(),
    });
    expect(JSON.stringify(agentTool.parameters)).not.toMatch(/\bhidden-helper\b/);
    expect(JSON.stringify(agentTool.parameters)).toContain("worker");
    const result: any = await agentTool.execute(
      "tc-n", { prompt: "go", description: "x", subagent_type: "hidden-helper" } as any, undefined, undefined, ctx(),
    );
    expect(textOf(result)).toContain('Unknown or disabled nested agent type: "hidden-helper"');
  });

  it("does not start from an @type mention", async () => {
    const { lifecycle: lc } = await boot({ agentMentions: "direct" });
    scriptRun({ hold: new Promise(() => {}) });
    const hidden = await lc.get("input")({ type: "input", text: "@hidden-helper do it", source: "interactive" }, ctx());
    expect(hidden).toEqual({ action: "continue" });
    expect(runAgent).not.toHaveBeenCalled();
    const visible = await lc.get("input")({ type: "input", text: "@worker do it", source: "interactive" }, ctx());
    expect(visible).toEqual({ action: "handled" });
  });

  it("is spawnable over RPC, with its own isolation (no worktree)", async () => {
    const { rpc } = await boot();
    scriptRun();
    const cwd = realpathSync(process.cwd());
    const reply = await rpc("spawn", {
      type: "hidden-helper", prompt: "work", options: { description: "#1 t", cwd, isolation: "worktree" },
    });
    expect(reply.success).toBe(true);
    expect(runAgent).toHaveBeenCalledWith(expect.anything(), "hidden-helper", "work", expect.objectContaining({ cwd }));
    expect(vi.mocked(runAgent).mock.calls[0][3].worktreeBase).toBeUndefined();
  });
});

describe("spawn options over RPC", () => {
  it("passes parentToolCallId and linkData to the runner and the session record", async () => {
    const { rpc, pi } = await boot();
    scriptRun();
    const linkData = { origin: { id: 7, title: "X" } };
    const reply = await rpc("spawn", {
      type: "worker", prompt: "go", options: { description: "d", parentToolCallId: "call-7", linkData },
    });
    expect(reply.success).toBe(true);
    const opts = vi.mocked(runAgent).mock.calls[0][3];
    expect(opts.parentToolCallId).toBe("call-7");
    expect(opts.linkData).toEqual(linkData);
    await vi.waitFor(() => expect(pi.appendEntry).toHaveBeenCalled());
    expect(pi.appendEntry.mock.calls[0][1]).toMatchObject({ id: reply.data.id, toolCallId: "call-7" });
  });

  it.each([
    [{ agentId: "x" }, 'linkData key "agentId" collides with a standard session-link field'],
    [{ kind: "x" }, 'linkData key "kind" collides with a standard session-link field'],
    [[1, 2], "linkData must be a plain object"],
    [{ big: "x".repeat(9000) }, "linkData is too large"],
    [{ f: () => 1 }, "linkData is not JSON-serializable: linkData.f is a function"],
    [{ n: Number.NaN }, "linkData is not JSON-serializable: linkData.n is NaN"],
    [{ d: new Date(0) }, "linkData is not JSON-serializable: linkData.d is a Date object"],
  ])("refuses invalid linkData %#", async (linkData, error) => {
    const { rpc } = await boot();
    scriptRun();
    const reply = await rpc("spawn", { type: "worker", prompt: "go", options: { description: "d", linkData } });
    expect(reply.success).toBe(false);
    expect(reply.error).toContain(error);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("refuses a non-string parentToolCallId and non-boolean flags", async () => {
    const { rpc } = await boot();
    expect((await rpc("spawn", { type: "worker", prompt: "go", options: { parentToolCallId: 3 } })).error)
      .toBe("parentToolCallId must be a string");
    expect((await rpc("spawn", { type: "worker", prompt: "go", options: { notifyParent: "no" } })).error)
      .toBe("notifyParent must be a boolean");
  });

  it("notifyParent: false suppresses notifications for the spawn and a send-resume", async () => {
    const { rpc, notifications, events } = await boot();
    scriptRun();
    scriptResume(1);
    const { data } = await rpc("spawn", {
      type: "worker", prompt: "go", options: { description: "quiet", isBackground: true, notifyParent: false },
    });
    await vi.waitFor(() => expect(events.filter(e => e.name === "subagents:completed")).toHaveLength(1));
    expect(await rpc("send", { agentId: data.id, text: "more" })).toEqual({ success: true, data: { delivery: "resumed" } });
    await vi.waitFor(() => expect(events.filter(e => e.name === "subagents:completed")).toHaveLength(2));
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    expect(notifications()).toEqual([]);
  });

  it("without notifyParent, the spawn and the send-resume both notify", async () => {
    const { rpc, notifications, events } = await boot();
    scriptRun();
    scriptResume(1);
    const { data } = await rpc("spawn", {
      type: "worker", prompt: "go", options: { description: "loud", isBackground: true },
    });
    await vi.waitFor(() => expect(events.filter(e => e.name === "subagents:completed")).toHaveLength(1));
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    expect(notifications()).toHaveLength(1);
    await rpc("send", { agentId: data.id, text: "more" });
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    expect(notifications()).toHaveLength(2);
  });

  it("retain survives the 10-minute cleanup; others are evicted", async () => {
    const { rpc, events } = await boot();
    scriptRun();
    const kept = (await rpc("spawn", { type: "worker", prompt: "a", options: { description: "kept", retain: true } })).data.id;
    const gone = (await rpc("spawn", { type: "worker", prompt: "b", options: { description: "gone" } })).data.id;
    await vi.waitFor(() => expect(events.filter(e => e.name === "subagents:completed")).toHaveLength(2));
    runCleanup();
    expect(rootManager()!.getRecord(kept)).toBeDefined();
    expect(rootManager()!.getRecord(gone)).toBeUndefined();
  });
});

describe("subagents:rpc:send", () => {
  it("steers a running agent", async () => {
    const { rpc } = await boot();
    scriptRun({ hold: new Promise(() => {}) });
    const { data } = await rpc("spawn", { type: "worker", prompt: "go", options: { description: "d" } });
    await flush();
    expect(await rpc("send", { agentId: data.id, text: "also this" })).toEqual({ success: true, data: { delivery: "steered" } });
    expect(rootManager()!.getRecord(data.id)!.session!.steer).toHaveBeenCalledWith("also this");
  });

  it("steers a queued agent (delivered when its session starts)", async () => {
    const { rpc } = await boot({ maxConcurrent: 1 });
    scriptRun({ hold: new Promise(() => {}) });
    await rpc("spawn", { type: "worker", prompt: "first", options: { description: "a", isBackground: true } });
    const { data } = await rpc("spawn", { type: "worker", prompt: "second", options: { description: "b", isBackground: true } });
    expect(rootManager()!.getRecord(data.id)!.status).toBe("queued");
    expect(await rpc("send", { agentId: data.id, text: "queued note" })).toEqual({ success: true, data: { delivery: "steered" } });
    expect(rootManager()!.getRecord(data.id)!.pendingSteers).toEqual(["queued note"]);
  });

  it("resumes a settled agent", async () => {
    const { rpc } = await boot();
    scriptRun();
    scriptResume(0);
    const { data } = await rpc("spawn", { type: "worker", prompt: "go", options: { description: "d" } });
    await vi.waitFor(() => expect(rootManager()!.getRecord(data.id)!.status).toBe("completed"));
    expect(await rpc("send", { agentId: data.id, text: "next" })).toEqual({ success: true, data: { delivery: "resumed" } });
    expect(resumeAgent).toHaveBeenCalledWith(expect.anything(), "next", expect.anything());
  });

  it("answers Unknown agent for a never-seen or evicted id", async () => {
    const { rpc, events } = await boot();
    scriptRun();
    expect(await rpc("send", { agentId: "nope", text: "x" })).toEqual({ success: false, error: 'Unknown agent "nope"' });
    const { data } = await rpc("spawn", { type: "worker", prompt: "go", options: { description: "d" } });
    await vi.waitFor(() => expect(events.some(e => e.name === "subagents:completed")).toBe(true));
    runCleanup();
    expect(await rpc("send", { agentId: data.id, text: "x" })).toEqual({ success: false, error: `Unknown agent "${data.id}"` });
  });

  it("refuses an agent another agent owns", async () => {
    const { rpc, pi } = await boot();
    scriptRun({ hold: new Promise(() => {}) });
    const id = rootManager()!.spawn(pi, ctx(), "worker", "x", { description: "child", parentAgentId: "parent" } as any);
    expect(await rpc("send", { agentId: id, text: "x" }))
      .toEqual({ success: false, error: "Agent is owned by another agent or workflow" });
  });
});

describe("subagents:rpc:reopen", () => {
  function sessionsRoot(): string {
    return join(process.env.PI_CODING_AGENT_DIR!, "sessions");
  }

  function writeSession(dir: string, name: string, header: Record<string, unknown> | string): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    const line = typeof header === "string" ? header : JSON.stringify(header);
    writeFileSync(file, `${line}\n{"type":"message"}\n`);
    return file;
  }

  const childHeader = { type: "session", version: 3, id: "child-1", cwd: "/x", timestamp: "t", parentSession: "/p.jsonl" };

  it("reopens a persisted child session after its record is gone, as a new agent", async () => {
    const { rpc, events, notifications } = await boot();
    const file = writeSession(join(sessionsRoot(), "--x--"), "child.jsonl", childHeader);
    scriptRun({ file, tools: 1 });
    const first = (await rpc("spawn", { type: "worker", prompt: "go", options: { description: "orig" } })).data.id;
    await vi.waitFor(() => expect(events.some(e => e.name === "subagents:completed")).toBe(true));
    runCleanup();
    expect((await rpc("send", { agentId: first, text: "x" })).error).toBe(`Unknown agent "${first}"`);

    vi.mocked(runAgent).mockClear();
    const reply = await rpc("reopen", {
      sessionFile: file, type: "worker", prompt: "continue",
      options: { description: "again", notifyParent: false, retain: true, isBackground: true, linkData: { ignored: 1 } },
    });
    expect(reply.success).toBe(true);
    expect(reply.data.id).not.toBe(first);
    const [, type, prompt, opts] = vi.mocked(runAgent).mock.calls[0];
    expect(type).toBe("worker");
    expect(prompt).toBe("continue");
    expect(opts.resumeSessionFile).toBe(realpathSync(file));
    expect(opts.keepSessionModel).toBe(true);
    expect(opts.linkData).toBeUndefined();
    const record = rootManager()!.getRecord(reply.data.id)!;
    expect(record).toMatchObject({ notifyParent: false, retain: true, description: "again" });
    await vi.waitFor(() => expect(record.status).toBe("completed"));
    runCleanup();
    expect(rootManager()!.getRecord(reply.data.id)).toBeDefined();
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    expect(notifications()).toEqual([]);
  });

  it("accepts a hidden type, and passes thinkingLevel only when given", async () => {
    const { rpc } = await boot();
    const file = writeSession(join(sessionsRoot(), "a", "b"), "t.jsonl", childHeader);
    scriptRun();
    expect((await rpc("reopen", { sessionFile: file, type: "hidden-helper", prompt: "go" })).success).toBe(true);
    expect(vi.mocked(runAgent).mock.calls[0][3].thinkingLevel).toBeUndefined();
    expect((await rpc("reopen", { sessionFile: file, type: "hidden-helper", prompt: "go", options: { thinkingLevel: "high" } })).success).toBe(true);
    expect(vi.mocked(runAgent).mock.calls[1][3].thinkingLevel).toBe("high");
  });

  it("refuses each invalid request with a clear error, before running anything", async () => {
    const { rpc } = await boot();
    scriptRun();
    const root = sessionsRoot();
    const outside = mkdtempSync(join(tmpdir(), "reopen-outside-"));
    try {
      const good = writeSession(join(root, "d"), "good.jsonl", childHeader);
      const outsideFile = writeSession(outside, "o.jsonl", childHeader);
      mkdirSync(join(root, "d", "dir.jsonl"), { recursive: true });
      const wrongExt = writeSession(join(root, "d"), "s.json", childHeader);
      const noHeader = writeSession(join(root, "d"), "garbage.jsonl", "not json");
      const notSession = writeSession(join(root, "d"), "msg.jsonl", { type: "message" });
      const topLevel = writeSession(join(root, "d"), "top.jsonl", { ...childHeader, parentSession: undefined });
      const link = join(root, "d", "link.jsonl");
      symlinkSync(outsideFile, link);

      const cases: Array<[Record<string, unknown>, string]> = [
        [{ sessionFile: "rel/x.jsonl" }, 'sessionFile must be an absolute path: "rel/x.jsonl"'],
        [{ sessionFile: join(root, "d", "missing.jsonl") }, "sessionFile does not exist"],
        [{ sessionFile: join(root, "d", "dir.jsonl") }, "sessionFile is not a regular file"],
        [{ sessionFile: wrongExt }, "sessionFile is not a .jsonl file"],
        [{ sessionFile: outsideFile }, "sessionFile is outside the subagent session directory"],
        [{ sessionFile: link }, "sessionFile is outside the subagent session directory"],
        [{ sessionFile: noHeader }, "sessionFile does not start with a Pi session header"],
        [{ sessionFile: notSession }, "sessionFile does not start with a Pi session header"],
        [{ sessionFile: topLevel }, "sessionFile is not a child session (its header has no parentSession)"],
        [{ sessionFile: good, type: "no-such-type" }, 'Unknown or disabled agent type: "no-such-type"'],
        [{ sessionFile: good, options: { cwd: "relative" } }, "SpawnOptions.cwd must be an absolute path"],
        [{ sessionFile: good, options: { retain: "yes" } }, "retain must be a boolean"],
      ];
      for (const [payload, error] of cases) {
        const reply = await rpc("reopen", { type: "worker", prompt: "go", ...payload });
        expect(reply.success, error).toBe(false);
        expect(reply.error).toContain(error);
      }
      expect(runAgent).not.toHaveBeenCalled();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("lifecycle events", () => {
  it("carry sessionId, sessionFile and per-run tool counts for spawn, send-resume and reopen", async () => {
    const { rpc, events } = await boot();
    const file = join(process.env.PI_CODING_AGENT_DIR!, "sessions", "lc", "s.jsonl");
    mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "sessions", "lc"), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ type: "session", id: "x", parentSession: "/p.jsonl" })}\n`);
    scriptRun({ tools: 2, file });
    scriptResume(3);

    const { data } = await rpc("spawn", { type: "worker", prompt: "go", options: { description: "lc" } });
    await vi.waitFor(() => expect(events.filter(e => e.name === "subagents:completed")).toHaveLength(1));
    expect(events[0]).toEqual({ name: "subagents:started", data: { id: data.id, type: "worker", description: "lc" } });
    expect(events[1].data).toMatchObject({
      id: data.id, status: "completed", toolUses: 2, runToolUses: 2, sessionFile: file, sessionId: expect.any(String),
    });

    await rpc("send", { agentId: data.id, text: "more" });
    await vi.waitFor(() => expect(events.filter(e => e.name === "subagents:completed")).toHaveLength(2));
    expect(events[2]).toMatchObject({ name: "subagents:started", data: { id: data.id, sessionFile: file, sessionId: events[1].data.sessionId } });
    expect(events[3].data).toMatchObject({ id: data.id, toolUses: 5, runToolUses: 3, sessionFile: file });

    const reopened = (await rpc("reopen", { sessionFile: file, type: "worker", prompt: "again" })).data.id;
    await vi.waitFor(() => expect(events.filter(e => e.name === "subagents:completed")).toHaveLength(3));
    expect(events[4]).toMatchObject({ name: "subagents:started", data: { id: reopened } });
    expect(events[5].data).toMatchObject({ id: reopened, toolUses: 2, runToolUses: 2, sessionFile: file });
  });

  it("reports a stop while queued as failed, without notifying the parent", async () => {
    const { rpc, events, notifications, pi } = await boot({ maxConcurrent: 1 });
    scriptRun({ hold: new Promise(() => {}) });
    await rpc("spawn", { type: "worker", prompt: "first", options: { description: "a", isBackground: true } });
    const { data } = await rpc("spawn", { type: "worker", prompt: "second", options: { description: "b", isBackground: true } });
    expect(await rpc("stop", { agentId: data.id })).toEqual({ success: true });
    const failed = events.filter(e => e.name === "subagents:failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toMatchObject({ id: data.id, status: "stopped", toolUses: 0, runToolUses: 0 });
    expect(events.some(e => e.name === "subagents:started" && e.data.id === data.id)).toBe(false);
    expect(pi.appendEntry.mock.calls.some((c: any[]) => c[0] === "subagents:record" && c[1].id === data.id)).toBe(true);
    await new Promise(r => setTimeout(r, PAST_THE_HOLD_MS));
    expect(notifications()).toEqual([]);
  });
});
