/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { renderAgentName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, AgentRecord, SubagentType, WidgetMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage, type SessionLike } from "../usage.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Show the ctrl+b hint on this running foreground call's row — one row per batch. */
  backgroundHint?: boolean;
  /** Short label for the model the run used, e.g. "haiku 4.5". */
  modelName?: string;
  /** Effective thinking level for this spawn, when known. */
  thinking?: AgentInvocation["thinking"];
  /** User-facing service tier when pinned for this spawn. */
  serviceTier?: AgentInvocation["serviceTier"];
  /** Compact model · thinking · tier shown next to agent names. */
  identity?: string;
  /** Non-identity spawn flags (e.g. ["worktree", "background"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  /** Estimated cost in USD; 0 when the model has no pricing data. */
  cost?: number;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

/** Format the exact effective model, including provider whenever available. */
export function formatModelName(model: { provider?: string; id: string; name?: string } | undefined): string | undefined {
  if (!model) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id || model.name;
}

/** Build authoritative UI metadata when continuing an existing child session. */
export function buildResumedInvocation(source: {
  invocation?: AgentInvocation;
  session?: { model?: { provider?: string; id: string; name?: string }; thinkingLevel?: AgentInvocation["thinking"] };
  model?: string;
  thinking?: AgentInvocation["thinking"];
  serviceTier?: AgentInvocation["serviceTier"];
  maxTurns?: number;
  isBackground?: boolean;
  worktree?: unknown;
}): AgentInvocation {
  return {
    ...source.invocation,
    modelName: formatModelName(source.session?.model) ?? source.model ?? source.invocation?.modelName,
    thinking: source.session?.thinkingLevel ?? source.thinking ?? source.invocation?.thinking,
    serviceTier: source.serviceTier ?? source.invocation?.serviceTier,
    maxTurns: source.maxTurns ?? source.invocation?.maxTurns,
    runInBackground: source.isBackground ?? source.invocation?.runInBackground,
    isolation: source.invocation?.isolation ?? (source.worktree ? "worktree" : undefined),
  };
}

/** Resolve the effective invocation metadata for every spawn path. */
export function buildRecordInvocation(record: Pick<AgentRecord,
  "invocation" | "session" | "model" | "thinking" | "serviceTier" | "maxTurns" | "isBackground" | "worktree"
>): AgentInvocation {
  return buildResumedInvocation({
    invocation: record.invocation,
    session: record.session,
    model: record.model,
    thinking: record.thinking,
    serviceTier: record.serviceTier,
    maxTurns: record.maxTurns,
    isBackground: record.isBackground,
    worktree: record.worktree,
  });
}

const TOOL_USES_ICON = "\uF0AD"; // Nerd Font wrench
const TOKEN_USAGE_ICON = "\uF1C0"; // Nerd Font database

/** Compact token magnitude without a label: "33.8k", "1.2M". */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

/** Human-readable token count for tool result text. */
export function formatTokens(count: number): string {
  return `${formatTokenCount(count)} token`;
}

/** Compact UI counters, matching the existing `↻5` turn counter. */
export function formatToolUses(count: number): string {
  return `${TOOL_USES_ICON} ${count}`;
}

export function formatTokenUsage(count: number): string {
  return `${TOKEN_USAGE_ICON} ${formatTokenCount(count)}`;
}

function formatTokenUsageText(text: string): string {
  if (text.startsWith(TOKEN_USAGE_ICON)) return text;
  return `${TOKEN_USAGE_ICON} ${text.replace(/\s+tokens?$/, "")}`;
}

/**
 * Format a cost as `~$0.0042`, or "" when there is nothing to show.
 *
 * The tilde is load-bearing: this is pi's own estimate from the model's listed
 * rates, not a billed figure, and the surfaces that print it sit next to token
 * counts that ARE exact.
 *
 * Nothing is printed for zero, which is also what a model with no pricing data
 * reports: `$0.00` beside a local model's tokens would claim its cost was
 * measured and found to be nothing, rather than never measured at all. For the
 * same reason a real cost too small for four decimals reads `<$0.0001` — it was
 * measured, and rounding it to `~$0.0000` would say the opposite.
 */
export function formatCost(cost: number): string {
  if (!(cost > 0)) return "";                     // also catches NaN
  if (cost < 0.0001) return "<$0.0001";
  if (cost >= 1) return `~$${cost.toFixed(2)}`;
  // Under a dollar: cents at minimum, four decimals at most, nothing trailing.
  // Most single runs land between a tenth of a cent and a dime, where rounding
  // to cents would collapse a 4x difference in spend into the same figure.
  const rounded = Number(cost.toFixed(4));
  const decimals = (String(rounded).split(".")[1] ?? "").length;
  return `~$${rounded.toFixed(Math.max(2, decimals))}`;
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim.
 *
 *   " 12.3k"               — no annotations
 *   " 12.3k (45%)"         — percent only
 *   " 12.3k (⇊2)"          — compactions only (e.g. right after compact)
 *   " 12.3k (45% · ⇊2)"    — both
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokenUsage(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getConfig(type);
  return config.promptMode === "append" ? "twin" : undefined;
}

/**
 * Compact model/thinking/tier identity shown next to agent names everywhere.
 * Order is always: model · thinking · service tier (omit missing fields).
 */
export function formatAgentIdentity(source?: {
  modelName?: string | null;
  thinking?: string | null;
  serviceTier?: string | null;
} | null): string | undefined {
  if (!source) return undefined;
  const parts = [source.modelName, source.thinking, source.serviceTier]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Mode label is not included — callers add it where they want it. */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; modelId?: string; identity?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  const asked = (value: string | undefined, requested: string | undefined) =>
    value && requested && requested !== value ? `${value} (asked ${requested})` : value;
  const modelName = asked(invocation.modelName, invocation.requestedModel);
  const thinking = asked(invocation.thinking, invocation.requestedThinking);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.runInBackground === true) tags.push("background");
  else if (invocation.runInBackground === false) tags.push("foreground");
  return {
    modelName,
    modelId: asked(invocation.modelId, invocation.requestedModel),
    identity: formatAgentIdentity({ ...invocation, modelName, thinking }),
    tags,
  };
}

/** Dim suffix for agent names: ` · model · thinking · tier`. */
export function formatAgentNameIdentity(
  theme: Pick<Theme, "fg">,
  invocation: AgentInvocation | undefined,
): string {
  const { identity } = buildInvocationTags(invocation);
  return identity ? ` ${theme.fg("dim", `· ${identity}`)}` : "";
}

/** Ordered stats shown by the inline foreground Agent renderer. */
export function getAgentStatsParts(details: AgentDetails): string[] {
  const parts: string[] = [];
  const identity = details.identity ?? formatAgentIdentity({
    modelName: details.modelName,
    thinking: details.thinking,
    serviceTier: details.serviceTier,
  });
  if (identity) parts.push(identity);
  if (details.tags) parts.push(...details.tags);
  if (details.turnCount != null && details.turnCount > 0) {
    parts.push(formatTurns(details.turnCount, details.maxTurns));
  }
  if (details.toolUses > 0) parts.push(formatToolUses(details.toolUses));
  if (details.tokens) parts.push(formatTokenUsageText(details.tokens));
  return parts;
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Selects which agents the widget shows — see
     * `WidgetMode`. Defaults to `"all"` when a caller supplies no policy; the
     * extension also defaults to `"all"`.
     */
    private mode: () => WidgetMode = () => "all",
    /**
     * Read live at render time, like `mode`. Whether running agents show an
     * estimated cost beside their token count. Defaults to off — the extension
     * supplies the user's `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    /**
     * Read live at render time, like `mode`. Whether running agents name the
     * model driving them and the thinking level it is running at. Defaults to
     * off — the extension supplies the user's `showModel` setting — because the
     * row is already dense and the same pair is on the tool result and in the
     * conversation viewer unconditionally.
     */
    private showModel: () => boolean = () => false,
  ) {}

  /**
   * Agents eligible for the widget, per the current `WidgetMode`:
   *   - `off`: none (the widget's existing empty-state path hides it entirely).
   *   - `background`: drop only agents *known* to be foreground
   *     (`isBackground === false`); keep everything else — background, queued,
   *     scheduled, or RPC-spawned (`undefined`). Keying off the `isBackground`
   *     record flag rather than the UI-only `invocation` snapshot (which only the
   *     Agent-tool path sets), and excluding rather than allow-listing, means
   *     only proven-foreground runs drop out — nothing else silently vanishes.
   *   - `all`: every agent.
   */
  private widgetAgents() {
    const all = this.manager.listAgents().filter(record => !record.owner && isTopLevelAgent(record));
    switch (this.mode()) {
      case "off": return [];
      case "background": return all.filter(a => a.isBackground !== false);
      default: return all;
    }
  }

  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    return age < maxAge;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
  }

  /**
   * Drop an agent's finished-age (call when a settled agent starts running
   * again, i.e. a background resume). markFinished only seeds an age it has not
   * seen before, so a resumed agent would otherwise keep the age from its
   * previous run — already past the linger limit, hiding the new run's
   * completion line entirely.
   */
  markRunning(agentId: string) {
    this.finishedTurnAge.delete(agentId);
  }

  /** Render a finished agent line. */
  private renderFinishedLine(a: AgentRecord, theme: Theme): string {
    const modeLabel = getPromptModeLabel(a.type);
    const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

    let icon: string;
    let statusText: string;
    if (a.status === "completed") {
      icon = theme.fg("success", "✓");
      statusText = "";
    } else if (a.status === "steered") {
      icon = theme.fg("warning", "✓");
      statusText = theme.fg("warning", " (turn limit)");
    } else if (a.status === "stopped") {
      icon = theme.fg("dim", "■");
      statusText = theme.fg("dim", " stopped");
    } else if (a.status === "error") {
      icon = theme.fg("error", "✗");
      const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
      statusText = theme.fg("error", ` error${errMsg}`);
    } else {
      // aborted
      icon = theme.fg("error", "✗");
      statusText = theme.fg("warning", " aborted");
    }

    const invocation = buildRecordInvocation(a);
    const { tags } = buildInvocationTags(invocation);
    const parts: string[] = [...tags];
    const activity = this.agentActivity.get(a.id);
    const turnCount = activity?.turnCount ?? a.turnCount;
    const maxTurns = activity?.maxTurns ?? a.maxTurns;
    if (turnCount > 0) parts.push(formatTurns(turnCount, maxTurns));
    if (a.toolUses > 0) parts.push(formatToolUses(a.toolUses));
    const costText = this.showCost() ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";
    if (costText) parts.push(costText);
    parts.push(duration);

    const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
    const identityTag = formatAgentNameIdentity(theme, invocation);
    return `${icon} ${renderAgentName(a.type, theme, { fallbackColor: "dim" })}${modeTag}${identityTag}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const allAgents = this.widgetAgents();
    const running = allAgents.filter(a => a.status === "running");
    const queued = allAgents.filter(a => a.status === "queued");
    const finished = allAgents.filter(a =>
      a.status !== "running" && a.status !== "queued" && a.completedAt
      && this.shouldShowFinished(a.id, a.status),
    );

    const hasActive = running.length > 0 || queued.length > 0;
    const hasFinished = finished.length > 0;

    // Nothing to show — return empty (widget will be unregistered by update())
    if (!hasActive && !hasFinished) return [];

    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);
    const headingColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const frame = SPINNER[this.widgetFrame % SPINNER.length];

    // Build sections separately for overflow-aware assembly.
    // Each running agent = 2 lines (header + activity), finished = 1 line, queued = 1 line.

    const finishedLines: string[] = [];
    for (const a of finished) {
      finishedLines.push(truncate(theme.fg("dim", "├─") + " " + this.renderFinishedLine(a, theme)));
    }

    const runningLines: string[][] = []; // each entry is [header, activity]
    for (const a of running) {
      const modeLabel = getPromptModeLabel(a.type);
      const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
      const elapsed = formatMs(Date.now() - a.startedAt);

      const bg = this.agentActivity.get(a.id);
      const toolUses = bg?.toolUses ?? a.toolUses;
      // Spend comes from the record, never from the activity tracker: the record
      // is the one that survives the agent finishing, and the one nested-tools
      // folds a hidden child's spend into. Reading the tracker while an agent
      // runs and the record once it stops made the figure jump at completion.
      const tokens = getLifetimeTotal(a.lifetimeUsage);
      const contextPercent = getSessionContextPercent(bg?.session);
      const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme, a.compactionCount) : "";
      const costText = this.showCost() ? formatCost(getLifetimeCost(a.lifetimeUsage)) : "";

      const invocation = buildRecordInvocation(a);
      const { tags } = buildInvocationTags(invocation);
      const parts: string[] = [...tags];
      const turnCount = bg?.turnCount ?? a.turnCount;
      const maxTurns = bg?.maxTurns ?? a.maxTurns;
      if (turnCount > 0) parts.push(formatTurns(turnCount, maxTurns));
      if (toolUses > 0) parts.push(formatToolUses(toolUses));
      if (tokenText) parts.push(tokenText);
      if (costText) parts.push(costText);
      parts.push(elapsed);
      const statsText = parts.join(" · ");

      const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";
      const identityTag = this.showModel() ? formatAgentNameIdentity(theme, invocation) : "";

      runningLines.push([
        truncate(theme.fg("dim", "├─") + ` ${theme.fg("accent", frame)} ${renderAgentName(a.type, theme, { bold: true })}${modeTag}${identityTag}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${fgPreservingNestedStyles(theme, "dim", statsText)}`),
        truncate(theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${activity}`)),
      ]);
    }

    const queuedLine = queued.length > 0
      ? truncate(theme.fg("dim", "├─") + ` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`)
      : undefined;

    // Assemble with overflow cap (heading + overflow indicator = 2 reserved lines).
    const maxBody = MAX_WIDGET_LINES - 1; // heading takes 1 line
    const totalBody = finishedLines.length + runningLines.length * 2 + (queuedLine ? 1 : 0);

    const lines: string[] = [truncate(theme.fg(headingColor, headingIcon) + " " + theme.fg(headingColor, "Agents"))];

    if (totalBody <= maxBody) {
      // Everything fits — add all lines and fix up connectors for the last item.
      lines.push(...finishedLines);
      for (const pair of runningLines) lines.push(...pair);
      if (queuedLine) lines.push(queuedLine);

      // Fix last connector: swap ├─ → └─ and │ → space for activity lines.
      if (lines.length > 1) {
        const last = lines.length - 1;
        lines[last] = lines[last].replace("├─", "└─");
        // If last item is a running agent activity line, fix indent of that line
        // and fix the header line above it.
        if (runningLines.length > 0 && !queuedLine) {
          // The last two lines are the last running agent's header + activity.
          if (last >= 2) {
            lines[last - 1] = lines[last - 1].replace("├─", "└─");
            lines[last] = lines[last].replace("│  ", "   ");
          }
        }
      }
    } else {
      // Overflow — prioritize: running > queued > finished.
      // Reserve 1 line for overflow indicator.
      let budget = maxBody - 1;
      let hiddenRunning = 0;
      let hiddenFinished = 0;

      // Reserve the queued line's row up front. It is a single summary of N
      // waiting agents, so it cannot be folded into the "+N more" count (which
      // is denominated in agents) without either under-reporting it as 1 or
      // inflating the total with agents that were never getting their own rows.
      // Reserving costs at most one running agent — which IS counted below —
      // and makes the drop unreachable. It matters most exactly when it used to
      // vanish: the pool is saturated and the queue is what the user needs to see.
      const queuedReserve = queuedLine ? 1 : 0;
      budget -= queuedReserve;

      // 1. Running agents (2 lines each)
      for (const pair of runningLines) {
        if (budget >= 2) {
          lines.push(...pair);
          budget -= 2;
        } else {
          hiddenRunning++;
        }
      }

      // 2. Queued line (always fits — its row was reserved above)
      if (queuedLine) {
        budget += queuedReserve;
        lines.push(queuedLine);
        budget--;
      }

      // 3. Finished agents
      for (const fl of finishedLines) {
        if (budget >= 1) {
          lines.push(fl);
          budget--;
        } else {
          hiddenFinished++;
        }
      }

      // Overflow summary
      const overflowParts: string[] = [];
      if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
      if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
      const overflowText = overflowParts.join(", ");
      lines.push(truncate(theme.fg("dim", "└─") + ` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowText})`)}`)
      );
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const allAgents = this.widgetAgents();

    // Lightweight existence checks — full categorization happens in renderWidget()
    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of allAgents) {
      if (a.status === "running") { runningCount++; }
      else if (a.status === "queued") { queuedCount++; }
      else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) { hasFinished = true; }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("subagents", undefined);
        this.lastStatusText = undefined;
      }
      if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
      // Clean up stale entries
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some(a => a.id === id)) this.finishedTurnAge.delete(id);
      }
      return;
    }

    // Status bar — only call setStatus when the text actually changes
    let newStatusText: string | undefined;
    if (hasActive) {
      const statusParts: string[] = [];
      if (runningCount > 0) statusParts.push(`${runningCount} running`);
      if (queuedCount > 0) statusParts.push(`${queuedCount} queued`);
      const total = runningCount + queuedCount;
      newStatusText = `${statusParts.join(", ")} agent${total === 1 ? "" : "s"}`;
    }
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      // Widget already registered — just request a re-render of existing components.
      this.tui?.requestRender();
    }
  }

  dispose() {
    this.finishedTurnAge.clear();
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastStatusText = undefined;
  }
}
