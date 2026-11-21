import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalAgentView } from "../src/external-agents.js";
import { renderRunningAgentStatus } from "../src/index.js";
import type { AgentInvocation, WidgetMode } from "../src/types.js";
import { type AgentActivity, AgentWidget, fgPreservingNestedStyles, formatCost, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe(" 1.2k");
    expect(formatSessionTokens(1234, 50, theme)).toBe(" 1.2k (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe(" 1.2k (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe(" 1.2k (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe(" 1.2k (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe(" 1.2k (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe(" 1.2k (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe(" 1.2k (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe(" 1.2k (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe(" 1.2k (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe(" 1.2k (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m 1.2k (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    };
  }

  function makeRecord(
    id: string,
    opts: { isBackground?: boolean; parentAgentId?: string; workflowId?: string } = {},
  ) {
    return {
      id,
      type: "worker",
      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: { modelName: "sonnet 4.6", modelId: "anthropic/claude-sonnet-4-6", thinking: "high" } as AgentInvocation,
      isBackground: opts.isBackground,
      parentAgentId: opts.parentAgentId,
      workflowId: opts.workflowId,
    };
  }

  /** Render the widget for a manager and return the produced lines ("" if nothing rendered). */
  function renderLines(manager: unknown, activityId: string, mode?: () => WidgetMode, showModel = false): string {
    const widget = new AgentWidget(
      manager as any,
      new Map([[activityId, makeActivity()]]),
      mode,
      () => false,
      () => showModel,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    try {
      if (!factory) return "";
      return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
        .render()
        .join("\n");
    } finally {
      widget.dispose();
    }
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("hides nested children in every coordinator widget mode", () => {
    const manager = {
      listAgents: () => [makeRecord("nested", { isBackground: true, parentAgentId: "parent" })],
    };
    expect(renderLines(manager, "nested", () => "all")).toBe("");
    expect(renderLines(manager, "nested", () => "background")).toBe("");
  });

  it("hides a workflow's agents in every coordinator widget mode", () => {
    // They belong to the run, which reports for them through its own card and
    // its own row in the fleet list.
    const manager = {
      listAgents: () => [makeRecord("child", { isBackground: true, workflowId: "wf_abc" })],
    };
    expect(renderLines(manager, "child", () => "all")).toBe("");
    expect(renderLines(manager, "child", () => "background")).toBe("");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers scheduler-spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  // The model is opt-in: the row is already dense, and the same pair is on the
  // tool result and in the conversation viewer either way.
  it("names the model and thinking on a running row under showModel", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    const on = renderLines(manager, "bg", () => "background", true);
    // Bare level, not "thinking: high" — the label is dropped on this surface.
    expect(on).toContain("sonnet 4.6 · high");
    expect(on).not.toContain("thinking:");
  });

  it("renders the row exactly as before when showModel is off", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    const off = renderLines(manager, "bg", () => "background");
    expect(off).toContain("bg description");
    expect(off).not.toContain("sonnet 4.6");
    expect(off).not.toContain("thinking:");
  });

  it("carries the short label, never the canonical id, onto the row", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    expect(renderLines(manager, "bg", () => "background", true))
      .not.toContain("anthropic/claude-sonnet-4-6");
  });

  it("discloses a level the run did not honor", () => {
    const record = makeRecord("bg", { isBackground: true });
    record.invocation = { modelName: "haiku 4.5", thinking: "high", requestedThinking: "max" };
    const manager = { listAgents: () => [record] };

    // Label stripped, but the "(asked max)" annotation survives the strip.
    expect(renderLines(manager, "bg", () => "background", true))
      .toContain("haiku 4.5 · high (asked max)");
  });

  // Queued agents stay a one-line count. A fan-out of ten would otherwise eat
  // the whole widget and push every finished agent out of it.
  it("keeps queued agents on one summary line and finished agents visible", () => {
    const records = [
      ...[1, 2, 3].map(i => ({ ...makeRecord(`run${i}`, { isBackground: true }), status: "running" })),
      ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ ...makeRecord(`q${i}`, { isBackground: true }), status: "queued" })),
      ...[1, 2, 3].map(i => ({
        ...makeRecord(`fin${i}`, { isBackground: true }),
        status: "completed",
        completedAt: Date.now(),
      })),
    ];
    const widget = new AgentWidget(
      { listAgents: () => records } as any,
      new Map(),
      () => "background",
      () => false,
      () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
    for (const r of records) if (r.status === "completed") widget.markFinished(r.id);
    widget.update();
    const lines = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");
    widget.dispose();

    expect(lines).toContain("7 queued");
    expect(lines).not.toContain("q1 description");
    for (const i of [1, 2, 3]) expect(lines).toContain(`fin${i} description`);
    expect(lines).not.toContain("more (");
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });
});

// The widget caps itself at MAX_WIDGET_LINES (12) and, past that, hands out a
// line budget in priority order: running pairs, then the queued summary, then
// finished lines. Running and finished increment `hiddenRunning`/`hiddenFinished`
// when they don't fit; the queued line is dropped with NO counter at all, so the
// footer under-reports and — worse — the queue vanishes from the UI entirely.
// That happens exactly when the concurrency limit is saturated, i.e. when the
// queue is the thing the user most needs to see.
describe("formatCost", () => {
  it("keeps the precision that distinguishes one run from another", () => {
    // Rounding to cents would print the same figure for a run that cost four
    // times another — the band most single subagent runs fall in.
    expect(formatCost(0.0042)).toBe("~$0.0042");
    expect(formatCost(0.0123)).toBe("~$0.0123");
    expect(formatCost(1.239)).toBe("~$1.24");
  });

  it("never pads a round figure with noise, nor cuts it below cents", () => {
    expect(formatCost(0.05)).toBe("~$0.05");    // not ~$0.0500
    expect(formatCost(0.4)).toBe("~$0.40");     // not ~$0.4
    expect(formatCost(12)).toBe("~$12.00");
  });

  it("shows nothing when there is nothing to show", () => {
    // Zero is what a model with no pricing data reports, so `$0.00` would claim
    // a measurement that was never made.
    expect(formatCost(0)).toBe("");
    expect(formatCost(Number.NaN)).toBe("");
    expect(formatCost(-1)).toBe("");
  });

  it("says a real but tiny cost is tiny, not zero", () => {
    // The distinction the whole helper turns on: "measured, below what four
    // decimals can show" must not render the same as "never measured".
    expect(formatCost(0.00002)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("");
  });

  it("marks the figure as an estimate", () => {
    // The tilde is the whole disclaimer — it sits beside exact token counts.
    expect(formatCost(0.5).startsWith("~")).toBe(true);
  });
});

describe("AgentWidget cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function render(showCost: boolean, cost: number): string {
    const agent = {
      id: "a1",
      type: "worker",
      description: "spending agent",
      status: "running",
      toolUses: 1,
      startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
      compactionCount: 0,
    };
    // Carries figures of its own, in the shape the tracker used to have: spend
    // is read from the record now, so these must not reach the line. Only the
    // record accumulates a nested child's spend, and only it outlives the run.
    const activity = new Map([["a1", {
      activeTools: new Map(),
      toolUses: 1,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 9, output: 9, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);
    const widget = new AgentWidget(
      { listAgents: () => [agent] } as any,
      activity,
      () => "all",
      () => showCost,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } });
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");
    widget.dispose();
    return out;
  }

  it("shows the cost beside the token count when enabled", () => {
    const line = render(true, 0.0042);
    expect(line).toContain(" 1.2k");
    expect(line).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const line = render(false, 0.0042);
    expect(line).toContain(" 1.2k");
    expect(line).not.toContain("$");
  });

  it("shows no cost for an unpriced model, even when enabled", () => {
    const line = render(true, 0);
    expect(line).toContain(" 1.2k");
    expect(line).not.toContain("$");
  });

  it("keeps the cost visible after the agent finishes", () => {
    // The activity entry is deleted the moment an agent finishes, so a finished
    // line reading from it would drop the number precisely when the question
    // "what did that cost" gets asked.
    const finished = {
      id: "a1", type: "worker", description: "done agent", status: "completed",
      toolUses: 2, startedAt: Date.now() - 1000, completedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [finished] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } });
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("done agent");
    expect(out).toContain("~$0.0042");
  });

  it("shows stats for an agent nobody is tracking live", () => {
    // A scheduled agent has no activity entry — it spawns through the manager
    // directly — and used to render with no tokens and no cost at all.
    const running = {
      id: "sched", type: "worker", description: "scheduled agent", status: "running",
      toolUses: 1, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [running] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } });
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");
    widget.dispose();

    expect(out).toContain(" 1.2k");
    expect(out).toContain("~$0.0042");
  });

  it("defaults to hiding it", () => {
    const agent = {
      id: "a1", type: "worker", description: "d", status: "running",
      toolUses: 0, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.5 }, compactionCount: 0,
    };
    const activity = new Map([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } });
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");
    widget.dispose();
    expect(out).not.toContain("$");
  });
});

describe("AgentWidget overflow accounting", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function record(id: string, status: string) {
    return {
      id,
      type: "worker",
      description: `${id} description`,
      status,
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: status === "completed" ? Date.now() : undefined,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: true,
    };
  }

  /** Render a whole fleet (mixed statuses) and return the produced lines. */
  function renderFleet(counts: { running: number; queued: number; finished: number }): string[] {
    const agents = [
      ...Array.from({ length: counts.running }, (_, i) => record(`run${i}`, "running")),
      ...Array.from({ length: counts.queued }, (_, i) => record(`q${i}`, "queued")),
      ...Array.from({ length: counts.finished }, (_, i) => record(`fin${i}`, "completed")),
    ];
    const activity = new Map(agents.map(a => [a.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]));
    const widget = new AgentWidget({ listAgents: () => agents } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } });
    widget.update();
    try {
      if (!factory) return [];
      return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render();
    } finally {
      widget.dispose();
    }
  }

  /** The `+N more (…)` footer, if the widget overflowed. */
  const footer = (lines: string[]) => lines.find(l => l.includes("more ("));

  /** Every fleet shape worth rendering — swept, not sampled. */
  const SHAPES: { running: number; queued: number; finished: number }[] = [];
  for (let running = 0; running <= 8; running++)
    for (let queued = 0; queued <= 8; queued++)
      for (let finished = 0; finished <= 8; finished++) SHAPES.push({ running, queued, finished });

  // Swept rather than sampled: reserving the queued row moves `budget` around by
  // hand, and an off-by-one there overflows the cap only for specific shapes.
  it("never exceeds the line cap, for any fleet shape", () => {
    for (const counts of SHAPES) {
      expect(renderFleet(counts).length, JSON.stringify(counts)).toBeLessThanOrEqual(12);
    }
  });

  it("never prints a footer that miscounts what it hid, for any fleet shape", () => {
    for (const counts of SHAPES) {
      const f = footer(renderFleet(counts));
      if (!f) continue;
      const total = Number(/\+(\d+) more/.exec(f)?.[1]);
      const where = `${JSON.stringify(counts)} → ${f}`;
      // A visible footer means something was dropped, so "+0 more ()" is a lie...
      expect(total, where).toBeGreaterThan(0);
      // ...and it counts agents that have their own row, so it can never exceed
      // them — in particular the queued summary must not be counted as an agent.
      expect(total, where).toBeLessThanOrEqual(counts.running + counts.finished);
    }
  });

  it("keeps the queued summary visible when the running agents fill the widget", () => {
    // 5 running (10 lines) consume the entire budget, so the queued line is
    // dropped — and with it, any sign that 3 agents are waiting to start.
    const lines = renderFleet({ running: 5, queued: 3, finished: 1 });
    expect(lines.join("\n")).toContain("3 queued");
  });

  it("counts everything it hid — the footer total matches what is missing", () => {
    // Computed rather than hardcoded, so this survives a scenario change but not
    // a change to what the footer counts.
    const counts = { running: 5, queued: 3, finished: 1 };
    const lines = renderFleet(counts);
    const body = lines.join("\n");

    const shownRunning = counts.running - [...Array(counts.running).keys()]
      .filter(i => !body.includes(`run${i} description`)).length;
    const shownFinished = counts.finished - [...Array(counts.finished).keys()]
      .filter(i => !body.includes(`fin${i} description`)).length;
    const actuallyHidden = (counts.running - shownRunning) + (counts.finished - shownFinished);

    const reported = Number(/\+(\d+) more/.exec(footer(lines) ?? "")?.[1] ?? -1);
    expect(reported).toBe(actuallyHidden);
  });

  it("gives the queued summary priority over finished lines", () => {
    const lines = renderFleet({ running: 4, queued: 2, finished: 3 });
    expect(lines.join("\n")).toContain("2 queued");
  });

  it("renders everything with no footer when the fleet fits", () => {
    const lines = renderFleet({ running: 2, queued: 1, finished: 1 });
    expect(lines.join("\n")).toContain("1 queued");
    expect(footer(lines)).toBeUndefined();
  });

  // A background resume runs an agent that already finished once. markFinished
  // only seeds an age it has not seen before, so without markRunning the agent
  // carries its previous run's age — already past the linger limit — and the
  // resumed run's ✓ line never renders: the agent just disappears.
  it("shows the completion line again after a finished agent is resumed", () => {
    const agent = record("resumed", "completed");
    const activity = new Map([[agent.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: any, c: any) => { factory = c; } } as any);
    const render = () => {
      widget.update();
      return (factory?.({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render() ?? []).join("\n");
    };

    // First run finishes and ages out of the widget.
    widget.markFinished(agent.id);
    widget.onTurnStart();
    widget.onTurnStart();
    expect(render()).not.toContain("resumed description");

    // Background resume puts it back on the running list.
    agent.status = "running";
    widget.markRunning(agent.id);
    expect(render()).toContain("resumed description");

    // ...and its completion is visible when the resumed run settles.
    agent.status = "completed";
    widget.markFinished(agent.id);
    expect(render()).toContain("resumed description");
    widget.dispose();
  });
});

describe("AgentWidget timer lifecycle", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeInternal(id: string, status: string) {
    return {
      id,
      type: "worker",
      description: `${id} description`,
      status,
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: status === "running" || status === "queued" ? undefined : Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: true,
    };
  }

  function makeExternal(id: string, status: ExternalAgentView["agent"]["status"]): ExternalAgentView {
    return {
      agent: {
        id,
        source: "herder",
        group: "Herder run-1",
        name: id,
        role: "worker",
        description: `${id} external`,
        status,
        startedAt: Date.now(),
        completedAt: status === "running" ? undefined : Date.now(),
      },
      activity: { activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1 },
      usage: { input: 0, output: 0, cacheWrite: 0 },
      compactions: 0,
    };
  }

  function mountWidget(
    agents: () => any[],
    external: () => readonly ExternalAgentView[] = () => [],
    mode: () => WidgetMode = () => "all",
  ) {
    const widget = new AgentWidget(
      { listAgents: agents } as any,
      new Map(),
      mode,
      () => false,
      () => false,
      external,
    );
    const requestRender = vi.fn();
    const setStatus = vi.fn();
    let component: { render(): string[]; invalidate(): void } | undefined;
    const setWidget = vi.fn((_key: string, content: any) => {
      component = content
        ? content({ terminal: { columns: 200 }, requestRender }, theme)
        : undefined;
    });
    widget.setUICtx({ setStatus, setWidget });
    return {
      widget,
      requestRender,
      setStatus,
      setWidget,
      render: () => (component ? component.render().join("\n") : ""),
    };
  }

  it("ticks every 80ms while an internal agent runs, stops once settled (while staying visible), and resumes on new active work", () => {
    const a1 = makeInternal("a1", "running");
    const list: any[] = [a1];
    const { widget, requestRender, setStatus, render } = mountWidget(() => list);

    widget.ensureTimer();
    widget.update();
    expect(vi.getTimerCount()).toBe(1);
    expect(render()).toContain("a1 description");

    vi.advanceTimersByTime(240);
    expect(requestRender).toHaveBeenCalledTimes(3);

    // Agent settles — completed entry stays visible in the widget, but the 80ms timer must stop.
    a1.status = "completed";
    a1.completedAt = Date.now();
    widget.markFinished(a1.id);
    requestRender.mockClear();

    widget.update();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenLastCalledWith("subagents", undefined);
    expect(render()).toContain("✓");
    expect(render()).toContain("a1 description");
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(800);
    expect(requestRender).toHaveBeenCalledTimes(1);

    // New active internal agent starts — timer resumes automatically.
    list.push(makeInternal("a2", "running"));
    requestRender.mockClear();
    widget.update();
    expect(vi.getTimerCount()).toBe(1);
    expect(requestRender).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(160);
    expect(requestRender).toHaveBeenCalledTimes(3);

    widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the 80ms timer running while an internal agent is queued and stops on the tick that observes settlement", () => {
    const q1 = makeInternal("q1", "queued");
    const { widget, requestRender, render } = mountWidget(() => [q1]);

    widget.update();
    expect(vi.getTimerCount()).toBe(1);
    expect(render()).toContain("1 queued");

    vi.advanceTimersByTime(160);
    expect(requestRender).toHaveBeenCalledTimes(2);

    // Transition without calling widget.update() directly — the next 80ms tick renders the settled view and stops the timer.
    q1.status = "aborted";
    q1.completedAt = Date.now();
    widget.markFinished(q1.id);
    requestRender.mockClear();

    vi.advanceTimersByTime(80);
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(render()).toContain("aborted");
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(800);
    expect(requestRender).toHaveBeenCalledTimes(1);

    widget.dispose();
  });

  it("runs the 80ms timer for an active external agent, stops when it settles, and resumes for new external work", () => {
    const ext1 = makeExternal("ext-1", "running");
    const externals: ExternalAgentView[] = [ext1];
    const { widget, requestRender, render } = mountWidget(() => [], () => externals);

    widget.ensureTimer();
    widget.update();
    expect(vi.getTimerCount()).toBe(1);
    expect(render()).toContain("ext-1");

    vi.advanceTimersByTime(240);
    expect(requestRender).toHaveBeenCalledTimes(3);

    // External agent settles — still visible in the widget, timer stops after rendering the settled view.
    ext1.agent.status = "completed";
    ext1.agent.completedAt = Date.now();
    requestRender.mockClear();

    widget.update();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(render()).toContain("✓");
    expect(render()).toContain("ext-1");
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(800);
    expect(requestRender).toHaveBeenCalledTimes(1);

    // A new running external agent resumes the 80ms timer.
    externals.push(makeExternal("ext-2", "running"));
    requestRender.mockClear();
    widget.update();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(160);
    expect(requestRender).toHaveBeenCalledTimes(3);

    widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ticking until both internal and external agents settle, and does not start when idle", () => {
    const internal = makeInternal("int-1", "running");
    const external = makeExternal("ext-1", "running");
    const { widget, requestRender } = mountWidget(() => [internal], () => [external]);

    widget.update();
    expect(vi.getTimerCount()).toBe(1);

    // Internal finishes, external still running -> timer stays active.
    internal.status = "completed";
    internal.completedAt = Date.now();
    widget.markFinished(internal.id);
    widget.update();
    expect(vi.getTimerCount()).toBe(1);

    requestRender.mockClear();
    vi.advanceTimersByTime(160);
    expect(requestRender).toHaveBeenCalledTimes(2);

    // External finishes too -> both settled -> timer stops.
    external.agent.status = "failed";
    external.agent.completedAt = Date.now();
    requestRender.mockClear();
    widget.update();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    // Calling ensureTimer() while idle does not start a timer.
    widget.ensureTimer();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(800);
    expect(requestRender).toHaveBeenCalledTimes(1);

    widget.dispose();
  });

  it("clears an active timer cleanly on dispose", () => {
    const a1 = makeInternal("a1", "running");
    const { widget, requestRender } = mountWidget(() => [a1]);

    widget.update();
    expect(vi.getTimerCount()).toBe(1);

    widget.dispose();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(800);
    expect(requestRender).not.toHaveBeenCalled();
  });
});
