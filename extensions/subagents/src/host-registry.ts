import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ServiceTierInput, ThinkingLevel } from "./types.js";

const HOST_KEY = Symbol.for("pi-subagents:host");

export interface SubagentTypeDescriptor {
  name: string;
  displayName: string;
  description: string;
  /** Undefined means the type implicitly receives all built-in tools. */
  builtinToolNames?: readonly string[];
  /** True only when the type explicitly declares a built-in set without edit/write. */
  readOnly: boolean;
}

export interface SubagentHostMetadata {
  owner?: string;
  rootActionId?: string;
  planId?: string;
  parentAgentId?: string;
}

export interface SubagentHostSpawnRequest {
  prompt: string;
  description: string;
  type: string;
  resolvedModel?: Model<any>;
  thinking?: ThinkingLevel;
  serviceTier?: ServiceTierInput;
  maxTurns?: number;
  signal?: AbortSignal;
  metadata?: SubagentHostMetadata;
  /** Herder sets this unconditionally; the host also fails closed if it is false. */
  isolated: true;
  /** Stable foreground working directory selected by the caller. */
  cwd: string;
}

export interface SubagentHostResult {
  id: string;
  status: "completed" | "steered" | "aborted" | "stopped" | "error";
  output: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  turnCount: number;
  maxTurns?: number;
  toolUses: number;
  lifetimeTokens: number;
  contextPercent: number | null;
  compactionCount: number;
  sessionId?: string;
  parentSessionId?: string;
}

export type SubagentModelResolver = (input: string, registry: ExtensionContext["modelRegistry"]) => Model<any> | string;
export type SubagentHostModelScopeDecision = "allow" | "warn" | "reject";

/** Mirror Agent scope policy: explicit runtime choices reject; config/inherit warns. */
export function subagentHostModelScopeDecision(
  model: { provider: string; id: string },
  allowed: Set<string> | undefined,
  explicit: boolean,
): SubagentHostModelScopeDecision {
  if (!allowed || allowed.has(`${model.provider}/${model.id}`.toLowerCase())) return "allow";
  return explicit ? "reject" : "warn";
}

/** Resolve foreground host model precedence: explicit request, then config, then parent. */
export function resolveSubagentHostModel(
  explicitModel: Model<any> | undefined,
  configuredModel: string | undefined,
  parentModel: Model<any> | undefined,
  registry: ExtensionContext["modelRegistry"],
  resolver: SubagentModelResolver,
): Model<any> | undefined {
  if (explicitModel) return explicitModel;
  if (!configuredModel) return parentModel;
  const resolved = resolver(configuredModel, registry);
  if (typeof resolved === "string") throw new Error(resolved);
  return resolved;
}

export interface SubagentHost {
  describeTypes(): readonly SubagentTypeDescriptor[];
  resolveType(name: string): SubagentTypeDescriptor | undefined;
  spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    request: SubagentHostSpawnRequest,
  ): Promise<SubagentHostResult>;
}

export interface SubagentTelemetry {
  phase: "started" | "updated" | "compacted" | "completed";
  owner?: string;
  rootActionId?: string;
  planId?: string;
  parentAgentId?: string;
  agentId: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  displayName: string;
  type: string;
  description: string;
  model?: string;
  thinking?: string;
  serviceTier?: string;
  turnCount: number;
  maxTurns?: number;
  toolUses: number;
  lifetimeTokens: number;
  contextPercent: number | null;
  compactionCount: number;
  activeTools: string[];
  activity?: string;
  responseText?: string;
  startedAt: number;
  completedAt?: number;
  parentSessionId?: string;
  sessionId?: string;
}

interface HostSlot {
  token: symbol;
  host: SubagentHost;
}

function slot(): HostSlot | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[HOST_KEY] as HostSlot | undefined;
}

/** Return the process-global root subagent host, if the extension is active. */
export function getSubagentHost(): SubagentHost | undefined {
  return slot()?.host;
}

/** First activation wins. The returned token is required to release the slot. */
export function registerSubagentHost(host: SubagentHost): symbol | undefined {
  if (slot()) return undefined;
  const token = Symbol("pi-subagents:host-owner");
  (globalThis as Record<PropertyKey, unknown>)[HOST_KEY] = { token, host } satisfies HostSlot;
  return token;
}

/** Release only the slot owned by the supplied activation token. */
export function releaseSubagentHost(token: symbol | undefined): boolean {
  const current = slot();
  if (!token || current?.token !== token) return false;
  delete (globalThis as Record<PropertyKey, unknown>)[HOST_KEY];
  return true;
}
