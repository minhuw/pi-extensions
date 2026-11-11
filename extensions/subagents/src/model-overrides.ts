/**
 * model-overrides.ts — User-level persistent (`subagent-models.json`) and
 * session-scoped model overrides for subagent types.
 *
 * Precedence (for non-council agents):
 *   session override > persistent override > custom .md frontmatter > DEFAULT_AGENTS
 *
 * Built-in council advisors (`council-caspar`, `council-melchior`, `council-balthasar`)
 * have pinned models for multi-model deliberation and can never be overridden.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { COUNCIL_AGENT_NAMES, type AgentConfig } from "./types.js";

export const SUBAGENT_MODELS_FILENAME = "subagent-models.json";

export type ModelOverrideScope = "persistent" | "session";
export type ModelOverrideValue = { mode: "model"; model: string } | { mode: "inherit" };

export interface ActiveModelOverride {
  scope: ModelOverrideScope;
  value: ModelOverrideValue;
}

const COUNCIL_AGENT_SET = new Set<string>(COUNCIL_AGENT_NAMES);
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** In-memory session overrides keyed by normalized lowercase agent name. */
const sessionOverrides = new Map<string, ModelOverrideValue>();

type PersistentOverridesCache =
  | { path: string; missing: true }
  | {
      path: string;
      missing: false;
      mtimeMs: number;
      size: number;
      overrides: Record<string, ModelOverrideValue>;
    };

/** Stat-keyed cache for `<agentDir>/subagent-models.json` to avoid repeated disk reads + JSON.parse. */
let persistentOverridesCache: PersistentOverridesCache | undefined;

/** Check whether an agent name refers to one of the pinned council advisors. */
export function isCouncilAgentName(name: string): boolean {
  return COUNCIL_AGENT_SET.has(name.trim().toLowerCase());
}

function resolveAgentDir(agentDir?: string): string {
  return agentDir ?? getAgentDir();
}

function overridesFilePath(agentDir?: string): string {
  return join(resolveAgentDir(agentDir), SUBAGENT_MODELS_FILENAME);
}

function normalizeAgentKey(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  return FORBIDDEN_KEYS.has(normalized) ? "" : normalized;
}

/**
 * Validate and normalize a `"provider/model"` string.
 * Splits on the first `/` so multi-segment model IDs (e.g. `magpie/codex/gpt-6-luna`)
 * remain intact while rejecting empty providers or empty model IDs.
 */
function parseProviderModel(raw: string): string | undefined {
  const trimmed = raw.trim();
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0) return undefined;
  const provider = trimmed.slice(0, slashIdx).trim();
  const modelId = trimmed.slice(slashIdx + 1).trim();
  if (!provider || !modelId) return undefined;
  if (!modelId.replace(/\//g, "").trim()) return undefined;
  return `${provider}/${modelId}`;
}

function cloneOverrideValue(value: ModelOverrideValue): ModelOverrideValue {
  return value.mode === "inherit" ? { mode: "inherit" } : { mode: "model", model: value.model };
}

function cloneOverridesRecord(
  source: Record<string, ModelOverrideValue>,
): Record<string, ModelOverrideValue> {
  const out: Record<string, ModelOverrideValue> = {};
  for (const [key, val] of Object.entries(source)) {
    out[key] = cloneOverrideValue(val);
  }
  return out;
}

function validateOverrideValue(value: ModelOverrideValue): ModelOverrideValue {
  if (value.mode === "inherit") {
    return { mode: "inherit" };
  }
  if (value.mode === "model") {
    const model = typeof value.model === "string" ? parseProviderModel(value.model) : undefined;
    if (!model) {
      throw new Error(
        `Invalid model override "${String((value as { model?: unknown }).model ?? "")}": expected "provider/model" with non-empty provider and model ID.`,
      );
    }
    return { mode: "model", model };
  }
  throw new Error("Invalid model override value.");
}

function writePersistentOverrides(overrides: Record<string, ModelOverrideValue>, agentDir?: string): void {
  const dir = resolveAgentDir(agentDir);
  const filePath = join(dir, SUBAGENT_MODELS_FILENAME);
  const entries = Object.entries(overrides);

  if (entries.length === 0) {
    rmSync(filePath, { force: true });
    persistentOverridesCache = { path: filePath, missing: true };
    return;
  }

  const serialized: Record<string, string> = {};
  for (const [name, val] of entries) {
    serialized[name] = val.mode === "inherit" ? "inherit" : val.model;
  }

  mkdirSync(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.${SUBAGENT_MODELS_FILENAME}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmpPath, `${JSON.stringify(serialized, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    persistentOverridesCache = undefined;
    throw err;
  }

  const stat = statSync(filePath, { throwIfNoEntry: false });
  persistentOverridesCache = stat
    ? {
        path: filePath,
        missing: false,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        overrides: cloneOverridesRecord(overrides),
      }
    : undefined;
}

function readPersistentOverrides(agentDir?: string): Record<string, ModelOverrideValue> {
  const filePath = overridesFilePath(agentDir);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath, { throwIfNoEntry: false });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring unreadable model overrides at ${filePath}: ${reason}`);
    persistentOverridesCache = undefined;
    return {};
  }

  if (!stat) {
    persistentOverridesCache = { path: filePath, missing: true };
    return {};
  }

  if (
    persistentOverridesCache &&
    !persistentOverridesCache.missing &&
    persistentOverridesCache.path === filePath &&
    persistentOverridesCache.mtimeMs === stat.mtimeMs &&
    persistentOverridesCache.size === stat.size
  ) {
    return persistentOverridesCache.overrides;
  }

  let rawText: string;
  try {
    rawText = readFileSync(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      persistentOverridesCache = { path: filePath, missing: true };
      return {};
    }
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring unreadable model overrides at ${filePath}: ${reason}`);
    persistentOverridesCache = undefined;
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagents] Ignoring malformed JSON in ${filePath}: ${reason}`);
    persistentOverridesCache = undefined;
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(`[pi-subagents] Ignoring non-object model overrides in ${filePath}`);
    persistentOverridesCache = undefined;
    return {};
  }

  const out: Record<string, ModelOverrideValue> = {};
  for (const [rawKey, rawVal] of Object.entries(parsed as Record<string, unknown>)) {
    const name = normalizeAgentKey(rawKey);
    if (!name || isCouncilAgentName(name)) continue;
    if (typeof rawVal !== "string") continue;
    const trimmed = rawVal.trim();
    if (trimmed === "inherit") {
      out[name] = { mode: "inherit" };
      continue;
    }
    const model = parseProviderModel(trimmed);
    if (model) {
      out[name] = { mode: "model", model };
    }
  }

  persistentOverridesCache = {
    path: filePath,
    missing: false,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    overrides: out,
  };
  return out;
}

/**
 * Read persistent overrides from `<agentDir>/subagent-models.json`.
 * Returns `{}` if the file does not exist (`ENOENT`), and silently skips
 * malformed entries or council keys so a hand-edited file never bricks startup.
 */
export function getPersistentModelOverrides(agentDir?: string): Record<string, ModelOverrideValue> {
  return cloneOverridesRecord(readPersistentOverrides(agentDir));
}

/** Get a snapshot of current in-memory session model overrides. */
export function getSessionModelOverrides(): Record<string, ModelOverrideValue> {
  const out: Record<string, ModelOverrideValue> = {};
  for (const [name, val] of sessionOverrides) {
    out[name] = cloneOverrideValue(val);
  }
  return out;
}

/**
 * Resolve the active override for `agentName` (`session` beats `persistent`).
 * Always returns `undefined` for empty or council agent names.
 */
export function getActiveModelOverride(agentName: string, agentDir?: string): ActiveModelOverride | undefined {
  const name = normalizeAgentKey(agentName);
  if (!name || isCouncilAgentName(name)) return undefined;

  const sessionVal = sessionOverrides.get(name);
  if (sessionVal !== undefined) {
    return { scope: "session", value: cloneOverrideValue(sessionVal) };
  }

  const persistent = readPersistentOverrides(agentDir);
  const persistentVal = persistent[name];
  if (persistentVal !== undefined) {
    return { scope: "persistent", value: cloneOverrideValue(persistentVal) };
  }

  return undefined;
}

/**
 * Set a persistent or session-scoped model override for `agentName`.
 * Strictly validates the agent name, council pin rule, and model format.
 */
export function setAgentModelOverride(
  agentName: string,
  value: ModelOverrideValue,
  scope: ModelOverrideScope = "persistent",
  agentDir?: string,
): void {
  const name = normalizeAgentKey(agentName);
  if (!name) {
    throw new Error("Agent name must not be empty.");
  }
  if (isCouncilAgentName(name)) {
    throw new Error(`Council advisor "${name}" has a pinned model and cannot be overridden.`);
  }
  if (scope !== "persistent" && scope !== "session") {
    throw new Error(`Invalid model override scope: "${String(scope)}".`);
  }

  const validated = validateOverrideValue(value);
  if (scope === "session") {
    sessionOverrides.set(name, validated);
    return;
  }

  const persistent = getPersistentModelOverrides(agentDir);
  persistent[name] = validated;
  writePersistentOverrides(persistent, agentDir);
  sessionOverrides.delete(name);
}

/**
 * Clear an agent's model override from `"session"`, `"persistent"`, or `"all"` (default).
 * Removes `subagent-models.json` when the persistent map becomes empty.
 * Returns `true` if at least one override was removed.
 */
export function clearAgentModelOverride(
  agentName: string,
  scope: ModelOverrideScope | "all" = "all",
  agentDir?: string,
): boolean {
  const name = normalizeAgentKey(agentName);
  if (!name) return false;

  let changed = false;

  if (scope === "session" || scope === "all") {
    if (sessionOverrides.delete(name)) {
      changed = true;
    }
  }

  if (scope === "persistent" || scope === "all") {
    const persistent = getPersistentModelOverrides(agentDir);
    if (Object.prototype.hasOwnProperty.call(persistent, name)) {
      delete persistent[name];
      writePersistentOverrides(persistent, agentDir);
      changed = true;
    }
  }

  return changed;
}

/** Clear all in-memory session model overrides (e.g. on `/new` or session reset). */
export function clearSessionModelOverrides(): void {
  sessionOverrides.clear();
}

/**
 * Apply active model overrides (`session` > `persistent`) to existing entries in `registry`.
 * Never mutates `AgentConfig` objects in place and never modifies council advisors.
 */
export function applyModelOverridesToRegistry(
  registry: Map<string, AgentConfig>,
  agentDir?: string,
): Map<string, AgentConfig> {
  const persistent = readPersistentOverrides(agentDir);
  for (const [key, cfg] of registry) {
    const normalizedKey = normalizeAgentKey(key);
    if (!normalizedKey || isCouncilAgentName(normalizedKey)) continue;
    const overrideValue = sessionOverrides.get(normalizedKey) ?? persistent[normalizedKey];
    if (!overrideValue) continue;
    registry.set(key, {
      ...cfg,
      model: overrideValue.mode === "inherit" ? undefined : overrideValue.model,
    });
  }
  return registry;
}
