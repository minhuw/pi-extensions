/**
 * The real extension's wiring of external agents: the tracker starts on
 * session_start, feeds the widget, and lets go of the registry and every
 * session on session_shutdown.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExternalAgent, externalAgents } from "../src/external-agents.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(), getFlag: vi.fn(), on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) }, appendEntry: vi.fn(), sendMessage: vi.fn(),
  } as any;
  return { pi, lifecycle };
}

function ctxWith(sessionId: string) {
  const ui = { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), onTerminalInput: vi.fn(() => vi.fn()), getEditorText: vi.fn(() => ""), custom: vi.fn() };
  const ctx = {
    hasUI: true, ui, cwd: process.cwd(), model: undefined, modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] }, getSystemPrompt: () => "parent",
  } as any;
  return { ctx, ui };
}

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

describe("external agents (real extension lifecycle)", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  const ids: string[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-external-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-external-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    for (const id of ids.splice(0)) externalAgents().agents.delete(id);
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function publish(agent: ExternalAgent) {
    const registry = externalAgents();
    ids.push(agent.id);
    registry.agents.set(agent.id, agent);
    for (const listener of registry.listeners) listener(agent.id);
  }

  it("shows the session's external agents in the widget and releases everything on shutdown", async () => {
    const registry = externalAgents();
    const listenersBefore = registry.listeners.size;
    const subscribers = new Set<unknown>();
    const session = {
      messages: [], model: { id: "gpt-x" }, thinkingLevel: "high",
      subscribe: (listener: unknown) => { subscribers.add(listener); return () => subscribers.delete(listener); },
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 } }),
    };
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    const { ctx, ui } = ctxWith("s1");
    await lifecycle.get("session_start")?.({}, ctx);
    expect(registry.listeners.size).toBe(listenersBefore + 1);

    const base = { source: "herder", group: "Herder run-9 · launch 1", role: "worker", status: "running" as const, startedAt: Date.now() };
    publish({ ...base, id: "herder:run-9:impl-0:1@1", ownerSessionId: "s1", name: "T1 · implement", session: session as any });
    publish({ ...base, id: "herder:run-9:impl-1:1@1", ownerSessionId: "s2", name: "Elsewhere" });
    expect(subscribers.size).toBe(1);
    const factory = ui.setWidget.mock.calls.filter(call => call[0] === "agents" && typeof call[1] === "function").at(-1)?.[1];
    expect(factory, "the widget registers for an external agent alone").toBeDefined();
    const text = factory({ terminal: { columns: 400 }, requestRender() {} }, theme).render().join("\n");
    expect(text).toContain("Herder run-9 · launch 1");
    expect(text).toContain("T1 · implement · worker");
    expect(text).not.toContain("Elsewhere");

    // Session events do not update the widget; its timer keeps a running external agent moving.
    const tui = { terminal: { columns: 400 }, requestRender: vi.fn() };
    factory(tui, theme);
    await vi.waitFor(() => expect(tui.requestRender).toHaveBeenCalled(), { timeout: 1_000, interval: 20 });

    await lifecycle.get("session_shutdown")?.({}, ctx);
    expect(registry.listeners.size).toBe(listenersBefore);
    expect(subscribers.size).toBe(0);
    expect(ui.setWidget).toHaveBeenLastCalledWith("agents", undefined);

    // The next session follows only its own agents.
    const next = ctxWith("s2");
    await lifecycle.get("session_start")?.({}, next.ctx);
    expect(registry.listeners.size).toBe(listenersBefore + 1);
    expect(subscribers.size).toBe(0);
    const nextFactory = next.ui.setWidget.mock.calls.filter(call => call[0] === "agents" && typeof call[1] === "function").at(-1)?.[1];
    const nextText = nextFactory ? nextFactory({ terminal: { columns: 400 }, requestRender() {} }, theme).render().join("\n") : "";
    expect(nextText).toContain("Elsewhere");
    expect(nextText).not.toContain("T1 · implement");
    await lifecycle.get("session_shutdown")?.({}, next.ctx);
    expect(registry.listeners.size).toBe(listenersBefore);
  });
});
