/**
 * external-agents.ts — Agents other extensions run (e.g. Herder's steps), shown beside Subagents' own.
 *
 * Extensions do not import each other, so the registry lives on `globalThis` under a shared symbol and whoever needs
 * it first creates it. Herder keeps an identical copy of the contract (`extensions/herder/src/adapter/external-agents.ts`).
 * Publishers replace an entry's object on every change and call each listener with its id after every add, update,
 * or remove. Subagents only reads: it never stops, steers, or removes an external agent.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";
import type { AgentActivity } from "./ui/agent-widget.js";
import { addUsage, type LifetimeUsage } from "./usage.js";

export const EXTERNAL_AGENTS = Symbol.for("pi-extensions.external-agents");

export interface ExternalAgent {
  /** Unique across sources, e.g. `herder:<runId>:<stepKey>:<attempt>@<attemptStartMs>`. */
  id: string;
  source: string;
  /** The Pi session that started it; other sessions do not show it. */
  ownerSessionId?: string;
  /** Heading the agent is listed under, e.g. `Herder <runId> · launch 2`. */
  group?: string;
  name: string;
  role: string;
  /** The first line of the agent's prompt. */
  description?: string;
  model?: string;
  thinking?: string;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: number;
  completedAt?: number;
  /** The live session while the agent runs; removed once it is disposed. */
  session?: AgentSession;
  /** A persisted transcript, when the source keeps one. */
  sessionFile?: string;
}

export interface ExternalAgentRegistry {
  readonly agents: Map<string, ExternalAgent>;
  readonly listeners: Set<(id: string) => void>;
}

export function externalAgents(): ExternalAgentRegistry {
  const shared = globalThis as { [EXTERNAL_AGENTS]?: ExternalAgentRegistry };
  return shared[EXTERNAL_AGENTS] ??= { agents: new Map(), listeners: new Set() };
}

/** An external agent with the live stats Subagents keeps for its own agents. */
export interface ExternalAgentView {
  readonly agent: ExternalAgent;
  readonly activity: AgentActivity;
  readonly usage: LifetimeUsage;
  readonly compactions: number;
}

interface Tracked {
  view: { agent: ExternalAgent; activity: AgentActivity; usage: LifetimeUsage; compactions: number };
  session?: AgentSession;
  unsubscribe?: () => void;
  /** The streaming assistant message's text so far. */
  text: string;
  turns: number;
}

export interface ExternalAgentTrackerOptions {
  registry?: ExternalAgentRegistry;
  /** The current Pi session's id, read as entries arrive; entries owned by another session are ignored. */
  ownerSessionId: () => string | undefined;
  /** An entry was added, changed, or removed (not called for each session event). */
  onChange: (id: string) => void;
}

/**
 * Follows the registry and, for each entry with a live session, that session's events — the same activity, usage,
 * and compaction counts `agent-runner.ts`'s `observeRun` feeds Subagents' own agents.
 */
export class ExternalAgentTracker {
  private readonly registry: ExternalAgentRegistry;
  private readonly tracked = new Map<string, Tracked>();
  private readonly listener = (id: string) => this.sync(id);
  private started = false;

  constructor(private readonly options: ExternalAgentTrackerOptions) {
    this.registry = options.registry ?? externalAgents();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.registry.listeners.add(this.listener);
    for (const id of this.registry.agents.keys()) this.sync(id);
  }

  /** The current session's external agents, oldest first. */
  list(): ExternalAgentView[] {
    return [...this.tracked.values()].map(entry => entry.view).sort((a, b) => a.agent.startedAt - b.agent.startedAt);
  }

  get(id: string): ExternalAgentView | undefined {
    return this.tracked.get(id)?.view;
  }

  dispose(): void {
    this.registry.listeners.delete(this.listener);
    for (const entry of this.tracked.values()) entry.unsubscribe?.();
    this.tracked.clear();
    this.started = false;
  }

  private sync(id: string): void {
    const found = this.registry.agents.get(id);
    // Another session's agents are neither listed nor followed.
    const agent = found && (found.ownerSessionId === undefined || found.ownerSessionId === this.options.ownerSessionId()) ? found : undefined;
    let entry = this.tracked.get(id);
    if (!agent) {
      if (!entry) return;
      entry.unsubscribe?.();
      this.tracked.delete(id);
      this.options.onChange(id);
      return;
    }
    if (!entry) {
      entry = {
        view: { agent, activity: { activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1 }, usage: { input: 0, output: 0, cacheWrite: 0 }, compactions: 0 },
        text: "",
        turns: 0,
      };
      this.tracked.set(id, entry);
    }
    entry.view.agent = agent;
    if (agent.session !== entry.session) {
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
      // A session seen for the first time may have run before this tracker started.
      if (agent.session && !entry.session) this.seed(entry, agent.session);
      entry.session = agent.session;
      if (agent.session) entry.unsubscribe = agent.session.subscribe(event => this.observe(entry!, event));
    }
    entry.view.activity.session = agent.session;
    if (agent.status !== "running") entry.view.activity.activeTools.clear();
    this.options.onChange(id);
  }

  /** What the session did before it was followed; after a compaction its messages undercount. */
  private seed(entry: Tracked, session: AgentSession): void {
    for (const message of session.messages) {
      if (message.role === "assistant") {
        addUsage(entry.view.usage, usageOf(message));
        entry.turns++;
      } else if (message.role === "toolResult") entry.view.activity.toolUses++;
    }
    entry.view.activity.turnCount = Math.max(1, entry.turns);
  }

  private observe(entry: Tracked, event: AgentSessionEvent): void {
    const { activity } = entry.view;
    switch (event.type) {
      case "turn_end":
        activity.turnCount = ++entry.turns;
        break;
      case "message_start":
        entry.text = "";
        break;
      case "message_update":
        if (event.assistantMessageEvent.type !== "text_delta") break;
        entry.text += event.assistantMessageEvent.delta;
        activity.responseText = entry.text;
        break;
      case "tool_execution_start":
        activity.activeTools.set(event.toolCallId, event.toolName);
        break;
      case "tool_execution_end":
        activity.activeTools.delete(event.toolCallId);
        activity.toolUses++;
        break;
      case "message_end":
        if (event.message.role === "assistant") addUsage(entry.view.usage, usageOf(event.message));
        break;
      case "compaction_end":
        if (!event.aborted && event.result) entry.view.compactions++;
        break;
    }
  }
}

function usageOf(message: unknown): LifetimeUsage {
  const usage = (message as { usage?: { input?: number; output?: number; cacheWrite?: number; cacheRead?: number; cost?: { total?: number } } }).usage;
  return { input: usage?.input ?? 0, output: usage?.output ?? 0, cacheWrite: usage?.cacheWrite ?? 0, cacheRead: usage?.cacheRead ?? 0, cost: usage?.cost?.total ?? 0 };
}

/** The record vocabulary for an external status: a failure renders as Subagents' error. */
export function externalStatus(status: ExternalAgent["status"]): AgentRecord["status"] {
  return status === "failed" ? "error" : status;
}

/**
 * A read-only record for the conversation viewer, which reads its record on every render: each field follows the
 * view's latest entry. `type` is the role, so unknown roles render with Subagents' fallback styling; callers pass the
 * entry's name as the viewer's label.
 */
export function externalRecord(view: () => ExternalAgentView | undefined, fallback: ExternalAgentView): AgentRecord {
  const current = () => view() ?? fallback;
  return {
    get id() { return current().agent.id; },
    get type() { return current().agent.role; },
    get description() { return current().agent.description ?? current().agent.name; },
    get status() { return externalStatus(current().agent.status); },
    get startedAt() { return current().agent.startedAt; },
    get completedAt() { return current().agent.completedAt; },
    get toolUses() { return current().activity.toolUses; },
    get turnCount() { return current().activity.turnCount; },
    get lifetimeUsage() { return current().usage; },
    get compactionCount() { return current().compactions; },
    get session() { return current().agent.session; },
    get invocation() { return { modelName: current().agent.model, thinking: current().agent.thinking }; },
  } as unknown as AgentRecord;
}
