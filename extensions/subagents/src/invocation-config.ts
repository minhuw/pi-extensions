import { Type } from "typebox";
import { parseServiceTier } from "./service-tier.js";
import {
  type AgentConfig,
  type IsolationMode,
  type JoinMode,
  type ServiceTierInput,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./types.js";

/** Matches empty or whitespace-only filler strings that models sometimes emit for omitted optional fields. */
const BLANK_STRING_SCHEMA = Type.String({ pattern: "^\\s*$" });

const VALID_THINKING_LEVELS = new Set<string>(THINKING_LEVELS);
const VALID_ISOLATION_MODES = new Set<string>(["off", "worktree"]);

/**
 * The model-facing `isolation` parameter, shared by the `Agent` tool and the
 * nested delegation tool so the two cannot drift.
 *
 * Shape matters more than wording here. As a single-value optional literal,
 * models that fill every optional parameter — the transcript on #231 shows one
 * emitting `resume: ""`, `schedule: ""` and `model: "default"` alongside it —
 * had only `"worktree"` available to fill it with, and kept spawning worktrees
 * across three turns while their own reasoning said to omit the field. Every
 * other optional parameter has an inert filler; this one did not. `"off"` is
 * listed first and described as the default so the harmless value is the
 * obvious one to reach for. Blank/whitespace-only strings are also accepted at
 * schema validation time and normalized to omitted before execution.
 *
 * The wording tracks Claude Code's own `isolation` parameter, whose phrasing
 * models have the most exposure to: one description on the union rather than
 * per-value ones, opening "Isolation mode.", then a sentence per value in
 * schema order, each with its caveats in a trailing parenthetical. Two clauses
 * are ours, because our shape is not theirs — `"off"` has no counterpart there
 * (their enum is `worktree | remote`, so both of their values do something),
 * and neither does the uncommitted-work warning, which is the specific trap
 * #231 fell into. Deliberately absent is any "only use a worktree when…"
 * restriction: Claude Code's `Agent` tool states the capability and stops, and
 * a second legal value is what lets a model decline one, not being told to.
 */
const isolationParamShape = {
  isolation: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("worktree"), BLANK_STRING_SCHEMA], {
      description:
        'Isolation mode. Default "off". "off" runs the agent in the current checkout, the same as omitting the field. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo (a copy cannot see uncommitted or staged changes in the main checkout).',
    }),
  ),
};

/** Shared optional `thinking` schema accepting valid thinking levels or blank strings (treated as omitted). */
export function thinkingParam(description: string) {
  return Type.Optional(
    Type.Union(
      [
        Type.Literal("off"),
        Type.Literal("minimal"),
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
        BLANK_STRING_SCHEMA,
      ],
      { description },
    ),
  );
}

/** Shared optional `service_tier` schema accepting valid service tiers or blank strings (treated as omitted). */
export function serviceTierParam(description: string) {
  return Type.Optional(
    Type.Union(
      [
        Type.Literal("fast"),
        Type.Literal("standard"),
        Type.Literal("priority"),
        Type.Literal("default"),
        Type.Literal("flex"),
        Type.Literal("auto"),
        BLANK_STRING_SCHEMA,
      ],
      { description },
    ),
  );
}

/** Shared optional `max_turns` schema accepting `0` (treated as omitted) or positive numbers, while rejecting negatives. */
export function maxTurnsParam(description?: string) {
  return Type.Optional(
    Type.Number({
      ...(description ? { description } : {}),
      minimum: 0,
    }),
  );
}

/** Trim an optional string and collapse empty/whitespace-only values to `undefined`. */
export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Normalize an optional positive numeric limit (`0` treated as omitted; negative/non-finite rejected). */
export function normalizeOptionalPositiveLimit(
  value: unknown,
  fieldName = "max_turns",
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${fieldName}: expected a non-negative number.`);
  }
  if (value < 0) {
    throw new Error(`Invalid ${fieldName}: ${value}. Must be >= 0 (0 or omitted for unlimited).`);
  }
  return value === 0 ? undefined : value;
}

/** Normalize and validate an optional `thinking` parameter. Blank/whitespace-only values become `undefined`. */
export function normalizeOptionalThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid thinking: expected string, got ${typeof value}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = trimmed.toLowerCase();
  if (!VALID_THINKING_LEVELS.has(normalized)) {
    throw new Error(
      `Invalid thinking: "${trimmed}". Expected one of: ${THINKING_LEVELS.join(", ")}.`,
    );
  }
  return normalized as ThinkingLevel;
}

/** Normalize and validate an optional `service_tier` parameter. Blank/whitespace-only values become `undefined`. */
export function normalizeOptionalServiceTier(value: unknown): ServiceTierInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    return parseServiceTier(value);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return parseServiceTier(trimmed);
}

/** Normalize and validate an optional `isolation` parameter. Blank/whitespace-only values become `undefined`. */
export function normalizeOptionalIsolation(value: unknown): IsolationMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid isolation: expected string, got ${typeof value}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const normalized = trimmed.toLowerCase();
  if (!VALID_ISOLATION_MODES.has(normalized)) {
    throw new Error(
      `Invalid isolation: "${trimmed}". Expected one of: off, worktree.`,
    );
  }
  return normalized as IsolationMode;
}

export interface RawAgentToolParams {
  prompt: string;
  description: string;
  subagent_type: string;
  name?: unknown;
  thinking?: unknown;
  service_tier?: unknown;
  max_turns?: unknown;
  run_in_background?: boolean;
  resume?: unknown;
  isolated?: boolean;
  inherit_context?: boolean;
  isolation?: unknown;
  schedule?: unknown;
}

export interface NormalizedAgentToolParams {
  prompt: string;
  description: string;
  subagent_type: string;
  name?: string;
  thinking?: ThinkingLevel;
  service_tier?: ServiceTierInput;
  max_turns?: number;
  run_in_background?: boolean;
  resume?: string;
  isolated?: boolean;
  inherit_context?: boolean;
  isolation?: IsolationMode;
  schedule?: string;
}

export type NormalizeAgentToolParamsResult =
  | { ok: true; params: NormalizedAgentToolParams }
  | { ok: false; error: string };

/**
 * Normalize and validate optional Agent tool parameters shared by both
 * top-level and nested `Agent` tools so the two cannot drift:
 * - blank/whitespace-only optional strings collapse to `undefined`
 * - `max_turns: 0` collapses to `undefined` (omitted)
 * - invalid non-blank enum values and negative numeric limits fail loudly
 */
export function normalizeAgentToolParams(raw: RawAgentToolParams): NormalizeAgentToolParamsResult {
  try {
    return {
      ok: true,
      params: {
        prompt: raw.prompt,
        description: raw.description,
        subagent_type: raw.subagent_type,
        name: normalizeOptionalString(raw.name),
        thinking: normalizeOptionalThinking(raw.thinking),
        service_tier: normalizeOptionalServiceTier(raw.service_tier),
        max_turns: normalizeOptionalPositiveLimit(raw.max_turns, "max_turns"),
        run_in_background: raw.run_in_background,
        resume: normalizeOptionalString(raw.resume),
        isolated: raw.isolated,
        inherit_context: raw.inherit_context,
        isolation: normalizeOptionalIsolation(raw.isolation),
        schedule: normalizeOptionalString(raw.schedule),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build the `isolation` parameter for a tool schema, or nothing when the
 * project disabled worktrees (`worktreeIsolation: false`).
 *
 * Dropping the field beats accepting it and quietly downgrading. The setting is
 * for a project whose model passes `"worktree"` on *every* call, so a
 * per-result "isolation was disabled" note would be noise on every result and
 * would keep raising the salience of a capability that isn't there. With no
 * field there is nothing to pass, nothing to drop, and nothing to explain — the
 * same trade `scheduleParam` makes for disabled scheduling, at zero LLM-context
 * cost. The resolver gate and the `agent-manager` check still cover the paths a
 * schema can't reach: agent files, the scheduler, and cross-extension RPC.
 *
 * Like `scheduleParam`, this is read once at tool registration — flipping the
 * setting needs a new pi session for the schema to change.
 */
export function isolationParam(enabled: boolean): Partial<typeof isolationParamShape> {
  return enabled ? isolationParamShape : {};
}

/** Model selection at LLM boundaries is limited to user-configured agent types. */
export const MODEL_SELECTION_GUIDANCE =
  "Select an existing agent type; its configured model is authoritative, otherwise inherit the current parent model. Model overrides are unavailable.";

export const MODEL_OVERRIDE_ERROR =
  "Model overrides are unavailable. Remove the model field and select an existing agent type (subagent_type or agentType); configure its model in the agent definition, or inherit the current parent model.";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  service_tier?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  /**
   * Untyped on purpose. Both tool schemas now build this field conditionally
   * and spread it, which erases TypeBox's literal inference to `unknown` (the
   * `schedule` param has the same shape). The resolver below narrows by
   * comparison rather than trusting the declaration, which also makes it safe
   * for the cross-extension RPC path, where options arrive unvalidated.
   */
  isolation?: unknown;
}

interface ResolveOptions {
  /**
   * Whether worktree isolation is permitted at all. False when the project set
   * `worktreeIsolation: false`, which drops a requested worktree rather than
   * failing the call: the fail-loud precedent covers spawns that *cannot* work,
   * while this one is the user opting out, and throwing would break exactly the
   * calls the `"off"` value exists to tolerate. Defaults to allowed.
   */
  worktreeAllowed?: boolean;
  /**
   * What an unqualified spawn means — neither the call nor the agent file said.
   *
   * Top-level callers pass the `backgroundByDefault` setting (default `false`). Nested callers pass `false` unconditionally: a
   * detached child is killed by `abortOwnedChildren` when its parent settles
   * and has no notification path of its own, so backgrounding one loses its
   * work. Both call sites pass it explicitly; the `false` fallback only covers
   * a caller that supplies no options at all, which in-tree means tests.
   */
  defaultRunInBackground?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  opts?: ResolveOptions,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  serviceTier?: ServiceTierInput;
  serviceTierFromParams: boolean;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
  /**
   * Caller parameters an agent file's frontmatter outranked, so the surfaces can
   * say "(asked X)" instead of presenting the effective value as the requested
   * one (#182). Populated only where both sides named something and they
   * disagree — a caller who asked for what they got was still honored.
   *
   * `max_turns` is deliberately absent: no surface renders a requested-vs-
   * effective turn limit, so recording one would be dead data.
   */
  overridden?: { thinking?: ThinkingLevel; model?: string };
} {
  const paramModel = normalizeOptionalString(params.model);
  const paramThinking = normalizeOptionalString(params.thinking) as ThinkingLevel | undefined;
  const paramServiceTier = normalizeOptionalString(params.service_tier) as ServiceTierInput | undefined;
  const paramMaxTurns = params.max_turns === 0 ? undefined : params.max_turns;
  const paramIsolation = normalizeOptionalString(params.isolation);

  // Precedence first, collapse second — reversing these loses the veto, since
  // an agent file's "off" only outranks a caller's "worktree" while it is still
  // a value. Everything downstream then sees "worktree" or nothing at all.
  const requested = agentConfig?.isolation ?? paramIsolation;
  const isolation = requested === "worktree" && opts?.worktreeAllowed !== false ? "worktree" : undefined;

  const configThinking = normalizeOptionalString(agentConfig?.thinking) as ThinkingLevel | undefined;
  const configModel = normalizeOptionalString(agentConfig?.model);

  const overriddenThinking = configThinking != null && paramThinking != null
    && configThinking !== paramThinking
    ? paramThinking
    : undefined;
  const overriddenModel = configModel != null && paramModel != null
    && configModel !== paramModel
    ? paramModel
    : undefined;

  return {
    modelInput: configModel ?? paramModel,
    modelFromParams: configModel == null && paramModel != null,
    thinking: (configThinking ?? paramThinking) as ThinkingLevel | undefined,
    // Frontmatter is authoritative when set (same as model).
    serviceTier: (agentConfig?.serviceTier ?? paramServiceTier) as ServiceTierInput | undefined,
    serviceTierFromParams: agentConfig?.serviceTier == null && paramServiceTier != null,
    maxTurns: agentConfig?.maxTurns ?? paramMaxTurns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? opts?.defaultRunInBackground ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation,
    // Undefined rather than an empty object when nothing was overridden: callers
    // spread this into the invocation snapshot, and an always-present key would
    // put `requestedThinking: undefined` on every record.
    overridden: overriddenThinking || overriddenModel
      ? { thinking: overriddenThinking, model: overriddenModel }
      : undefined,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
