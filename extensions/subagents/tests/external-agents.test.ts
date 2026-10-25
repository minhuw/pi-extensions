import type { OverlayOptions } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import {
  EXTERNAL_AGENTS,
  type ExternalAgent,
  type ExternalAgentRegistry,
  ExternalAgentTracker,
  externalAgents,
  externalRecord,
  externalStatus,
} from "../src/external-agents.js";
import { AgentWidget, type UICtx } from "../src/ui/agent-widget.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";

const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => `*${s}*` };
const plain = (row: string) => row.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");

/** A session that records its subscribers and replays events to them. */
function fakeSession(messages: unknown[] = []) {
  const listeners = new Set<(event: any) => void>();
  return {
    listeners,
    messages,
    model: { id: "gpt-x" },
    thinkingLevel: "high",
    subscribe(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event: object) { for (const listener of [...listeners]) listener(event); },
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 42 } }),
  };
}
type FakeSession = ReturnType<typeof fakeSession>;

function registry(): ExternalAgentRegistry {
  return { agents: new Map(), listeners: new Set() };
}

/** Publishes like Herder: replaces the entry, then notifies every listener. */
function publish(reg: ExternalAgentRegistry, agent: ExternalAgent | string) {
  const id = typeof agent === "string" ? agent : agent.id;
  if (typeof agent === "string") reg.agents.delete(id);
  else reg.agents.set(id, agent);
  for (const listener of reg.listeners) listener(id);
}

function agent(over: Partial<ExternalAgent> & { session?: FakeSession } = {}): ExternalAgent {
  return {
    id: "herder:run-1:impl-0:1@100", source: "herder", ownerSessionId: "session-a", group: "Herder run-1 · launch 2",
    name: "T1 · implement", role: "worker", description: "Implement the parser.", model: "gpt-x", thinking: "high",
    status: "running", startedAt: Date.now() - 65_000, ...over,
  } as ExternalAgent;
}

function tracker(reg: ExternalAgentRegistry, owner: string | undefined = "session-a") {
  const changes: string[] = [];
  const t = new ExternalAgentTracker({ registry: reg, ownerSessionId: () => owner, onChange: id => changes.push(id) });
  return { t, changes };
}

afterEach(() => vi.useRealTimers());

describe("externalAgents", () => {
  it("creates the registry once, on globalThis under the shared symbol", () => {
    const shared = globalThis as { [EXTERNAL_AGENTS]?: ExternalAgentRegistry };
    const before = shared[EXTERNAL_AGENTS];
    delete shared[EXTERNAL_AGENTS];
    try {
      const first = externalAgents();
      expect(shared[Symbol.for("pi-extensions.external-agents") as typeof EXTERNAL_AGENTS]).toBe(first);
      expect(externalAgents()).toBe(first);
    } finally {
      if (before) shared[EXTERNAL_AGENTS] = before;
      else delete shared[EXTERNAL_AGENTS];
    }
  });
});

describe("ExternalAgentTracker", () => {
  it("lists existing and new entries of the current session, oldest first", () => {
    const reg = registry();
    publish(reg, agent({ id: "b", startedAt: 2 }));
    const { t, changes } = tracker(reg);
    t.start();
    publish(reg, agent({ id: "a", startedAt: 1 }));
    publish(reg, agent({ id: "other", ownerSessionId: "session-z" }));
    publish(reg, agent({ id: "anyone", ownerSessionId: undefined, startedAt: 3 }));
    expect(t.list().map(view => view.agent.id)).toEqual(["a", "b", "anyone"]);
    expect(t.get("other")).toBeUndefined();
    // Another session's agent is not followed at all.
    expect(changes).toEqual(["b", "a", "anyone"]);
    t.dispose();
  });

  it("builds activity, turns, usage, and compactions from the live session, like Subagents' own agents", () => {
    const reg = registry();
    const session = fakeSession([
      { role: "assistant", usage: { input: 100, output: 10, cacheWrite: 5, cacheRead: 50, cost: { total: 0.01 } } },
      { role: "toolResult" },
    ]);
    const { t } = tracker(reg);
    t.start();
    publish(reg, agent({ session }));
    const view = t.get(agent().id)!;
    expect(view.usage).toEqual({ input: 100, output: 10, cacheWrite: 5, cacheRead: 50, cost: 0.01 });
    expect(view.activity.toolUses).toBe(1);
    expect(view.activity.session).toBe(session);
    session.emit({ type: "message_start", message: { role: "assistant" } });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Reading " } });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "the parser" } });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } });
    expect(view.activity.responseText).toBe("Reading the parser");
    session.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" });
    expect([...view.activity.activeTools.values()]).toEqual(["bash"]);
    session.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash" });
    expect(view.activity.activeTools.size).toBe(0);
    expect(view.activity.toolUses).toBe(2);
    session.emit({ type: "message_end", message: { role: "assistant", usage: { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 } } });
    session.emit({ type: "message_end", message: { role: "user", usage: { input: 1000 } } });
    expect(view.usage).toMatchObject({ input: 101, output: 12, cacheWrite: 8, cacheRead: 54 });
    // One turn had passed before the tracker saw the session.
    expect(view.activity.turnCount).toBe(1);
    session.emit({ type: "turn_end" });
    session.emit({ type: "turn_end" });
    expect(view.activity.turnCount).toBe(3);
    session.emit({ type: "compaction_end", aborted: false, result: {} });
    session.emit({ type: "compaction_end", aborted: true, result: {} });
    expect(view.compactions).toBe(1);
    t.dispose();
  });

  it("unsubscribes when the session goes away, the entry is removed, or the tracker is disposed", () => {
    const reg = registry();
    const first = fakeSession();
    const { t } = tracker(reg);
    t.start();
    publish(reg, agent({ session: first }));
    expect(first.listeners.size).toBe(1);
    publish(reg, agent({ status: "completed", completedAt: Date.now() }));
    expect(first.listeners.size).toBe(0);
    expect(t.get(agent().id)!.activity.session).toBeUndefined();
    const second = fakeSession();
    publish(reg, agent({ id: "b", session: second }));
    publish(reg, "b");
    expect(second.listeners.size).toBe(0);
    expect(t.get("b")).toBeUndefined();
    const third = fakeSession();
    publish(reg, agent({ id: "c", session: third }));
    t.dispose();
    expect(third.listeners.size).toBe(0);
    expect(reg.listeners.size).toBe(0);
    expect(t.list()).toEqual([]);
  });

  it("maps statuses and gives the viewer a record that follows the entry", () => {
    expect([externalStatus("running"), externalStatus("completed"), externalStatus("failed"), externalStatus("stopped")])
      .toEqual(["running", "completed", "error", "stopped"]);
    const reg = registry();
    const { t } = tracker(reg);
    t.start();
    publish(reg, agent());
    const record = externalRecord(() => t.get(agent().id), t.get(agent().id)!);
    expect(record).toMatchObject({ type: "worker", description: "Implement the parser.", status: "running", invocation: { modelName: "gpt-x", thinking: "high" } });
    publish(reg, agent({ status: "failed", completedAt: 5 }));
    expect(record.status).toBe("error");
    expect(record.completedAt).toBe(5);
    t.dispose();
  });
});

function widget(views: () => ReturnType<ExternalAgentTracker["list"]>, mode: "all" | "off" = "all") {
  let factory: ((tui: any, theme: any) => { render(): string[] }) | undefined;
  const ui: UICtx = { setStatus: vi.fn(), setWidget: (_key, content) => { factory = content as any; } };
  const manager = { listAgents: () => [] } as unknown as AgentManager;
  const w = new AgentWidget(manager, new Map(), () => mode, () => false, () => true, views);
  w.setUICtx(ui);
  const render = () => {
    w.update();
    // Wide: the fake theme's tags count toward the width.
    return factory ? factory({ terminal: { columns: 400 }, requestRender() {} }, theme).render().map(plain) : [];
  };
  return { w, ui, render };
}

describe("AgentWidget with external agents", () => {
  it("lists them under their group in the same row format, only for their session", () => {
    const reg = registry();
    const session = fakeSession();
    const { t } = tracker(reg);
    t.start();
    publish(reg, agent({ session }));
    publish(reg, agent({ id: "done", name: "T0 · survey", status: "completed", startedAt: Date.now() - 30_000, completedAt: Date.now() }));
    publish(reg, agent({ id: "theirs", ownerSessionId: "session-z", name: "Theirs" }));
    session.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" });
    const { render } = widget(() => t.list());
    const lines = render();
    expect(lines[0]).toBe("● Herder run-1 · launch 2");
    expect(lines[1]).toMatch(/^├─ ✓ T0 · survey · worker · gpt-x · high {2}Implement the parser\. · ↻1 · 30\.0s$/);
    expect(lines[2]).toMatch(/^└─ \S T1 · implement · worker · gpt-x · high {2}Implement the parser\. · ↻1 · 6\d\.\ds$/);
    expect(lines[3]).toBe("     ⎿  running command…");
    expect(lines.join("\n")).not.toContain("Theirs");
    t.dispose();
  });

  it("caps every group together, running agents first, with one overflow line", () => {
    const reg = registry();
    const { t } = tracker(reg);
    t.start();
    for (let i = 0; i < 4; i++) publish(reg, agent({ id: `run-a-${i}`, name: `A${i}`, group: "Herder run-a · launch 1", session: fakeSession(), startedAt: i }));
    for (let i = 0; i < 4; i++) publish(reg, agent({ id: `run-b-${i}`, name: `B${i}`, group: "Herder run-b · launch 1", session: fakeSession(), startedAt: 10 + i }));
    publish(reg, agent({ id: "done", name: "Done", group: "Herder run-b · launch 1", status: "completed", completedAt: Date.now(), startedAt: 20 }));
    const lines = widget(() => t.list()).render();
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe("● Herder run-a · launch 1");
    expect(lines.filter(line => line.startsWith("● "))).toEqual(["● Herder run-a · launch 1", "● Herder run-b · launch 1"]);
    // Running agents first (run-a's four fill 8 lines), then finished ones fill what is left, as in the main list.
    expect(lines.at(-2)).toMatch(/^└─ ✓ Done/);
    expect(lines.at(-1)).toBe("└─ +4 more");
    t.dispose();
  });

  it("drops finished ones after a turn, keeps them dropped, and hides them in off mode", () => {
    const reg = registry();
    const { t } = tracker(reg);
    t.start();
    publish(reg, agent({ status: "failed", completedAt: Date.now() }));
    const { w, render, ui } = widget(() => t.list());
    expect(render()[1]).toMatch(/✗ T1 · implement.* failed$/);
    w.onTurnStart();
    w.onTurnStart();
    expect(render()).toEqual([]);
    expect(ui.setStatus).not.toHaveBeenCalledWith("subagents", expect.any(String));
    w.onTurnStart();
    expect(render()).toEqual([]);
    publish(reg, agent({ id: "live", session: fakeSession() }));
    expect(widget(() => t.list(), "off").render()).toEqual([]);
    w.dispose();
    t.dispose();
  });
});

describe("FleetList with external agents", () => {
  it("lists running external agents with a session and opens a read-only viewer on Enter", () => {
    const reg = registry();
    const session = fakeSession();
    const { t } = tracker(reg);
    t.start();
    publish(reg, agent({ session }));
    publish(reg, agent({ id: "gating", name: "T2 · gates" }));

    let widgetFactory: ((tui: any, theme: any) => { render(w: number): string[] }) | undefined;
    let input: ((data: string) => { consume?: boolean } | undefined) | undefined;
    let overlay: unknown;
    const ui: FleetUICtx = {
      setWidget: (_key, content) => { widgetFactory = content as any; },
      onTerminalInput: handler => { input = handler; return () => { input = undefined; }; },
      getEditorText: () => "",
      notify: vi.fn(),
      custom: ((factory: any, options?: { overlayOptions?: () => OverlayOptions }) => {
        overlay = factory({ mode: "regular", requestRender() {}, terminal: { columns: 120, rows: 40 } }, theme, undefined, () => {});
        options?.overlayOptions?.();
        return new Promise(() => {});
      }) as FleetUICtx["custom"],
    };
    const manager = { listAgents: () => [], abort: vi.fn(), steer: vi.fn() } as unknown as AgentManager;
    const fleet = new FleetList(manager, new Map());
    fleet.setExternalSource(() => t.list());
    fleet.setUICtx(ui);
    fleet.setEnabled(true);
    const rows = widgetFactory!({ requestRender() {} }, theme).render(300).map(plain);
    expect(rows.filter(row => row.includes("T1 · implement"))).toEqual([expect.stringMatching(/^ {2}○ T1 · implement · worker · gpt-x · high {2}Implement the parser\. +6\ds · \S+ 0$/)]);
    expect(rows.join("\n")).not.toContain("T2 · gates");

    input!("\x1b[B");
    input!("\x1b[B");
    input!("\r");
    expect(overlay).toBeInstanceOf(ConversationViewer);
    const header = (overlay as ConversationViewer).render(100).map(plain).find(line => line.includes("T1 · implement"))!;
    expect(header).toContain("T1 · implement · worker");
    expect(session.listeners.size).toBe(2);
    expect((overlay as ConversationViewer).render(100).map(plain).join("\n")).not.toMatch(/stop/i);
    fleet.dispose();
    t.dispose();
  });
});
