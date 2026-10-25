/**
 * Bind workflow handles to AgentManager records, retaining them for resume.
 * Dispatch uses the Agent tool's type and model policy. Spawn failures become
 * failed workflow results.
 *
 * Isolated gates run in onBeforeWorktreeCleanup: spawnAndWait commits and
 * removes the child's worktree before resolving. Non-isolated gates use runGate.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { getAgentConfig, resolveSpawnType } from "../agent-types.js";
import { MODEL_OVERRIDE_ERROR } from "../invocation-config.js";
import { resolveModel } from "../model-resolver.js";
import { checkModelScope } from "../model-scope.js";
import type { AgentRecord, ThinkingLevel } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import type { WorkflowGateResult, WorkflowHost, WorkflowSpawnResult } from "./runtime.js";
import { resolveWorkflowSource } from "./saved.js";

/**
 * Wall-clock bound on a `gate` command. Generous — a gate is routinely a test
 * suite — but not unbounded: `pi.exec` reports a timeout as `killed`, and a
 * gate that hangs forever would wedge the agent slot it is holding.
 */
export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

export interface WorkflowHostOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  manager: AgentManager;
  /** The run's abort signal, so killing the workflow kills its children. */
  signal?: AbortSignal;
  /** Groups child transcripts under the parent session. */
  rootSessionId?: string;
  /**
   * The run id every child is stamped with.
   *
   * What makes them the workflow's rather than the session's: stamped children
   * are filtered out of the fleet list, the widget, the `/agents` menus and
   * `@handle` resolution, and they take no `maxConcurrent` slot. The run
   * reports for them, and it has its own concurrency cap.
   */
  workflowId?: string;
  /** The workflow tool call that started the run, recorded as each child's spawning call. */
  toolCallId?: string;
  gateTimeoutMs?: number;
}

/** Cleanup removes isolated worktrees before spawnAndWait resolves; omit stale paths. */
function childCwd(record: AgentRecord): string | undefined {
  // `path`, not `workPath`: a workflow spawn never passes a cwd, so the manager
  // runs the child at the copied repo's root.
  const path = record.worktree?.path;
  return path !== undefined && existsSync(path) ? path : undefined;
}

/**
 * Whether the child itself succeeded — the same condition {@link toSpawnResult}
 * turns into `ok`, read from the live record so the pre-cleanup hook can tell a
 * finished child from a failed one before the result exists.
 */
function succeeded(record: AgentRecord | undefined): boolean {
  return record?.status === "completed" || record?.status === "steered";
}

/**
 * The effective-configuration half of a record, in the runtime's pi-free shape.
 *
 * `AgentRecord.invocation` is the one authoritative place for it (#168); this
 * only renames the fields across the boundary. Returns undefined until the
 * child's session has reported a model, which is when any of it is knowable.
 */
function resolvedInfo(record: AgentRecord | undefined) {
  const invocation = record?.invocation;
  if (invocation?.modelName === undefined) return undefined;
  return {
    modelName: invocation.modelName,
    modelId: invocation.modelId,
    thinking: invocation.thinking,
    requestedThinking: invocation.requestedThinking,
    requestedModel: invocation.requestedModel,
  };
}

/** Translate a settled record into what the script sees. */
function toSpawnResult(record: AgentRecord): WorkflowSpawnResult {
  const tokens = getLifetimeTotal(record.lifetimeUsage);
  // Reported separately from `tokens`, which is the lifetime total. The script's
  // `budget` counts *output* tokens, as Claude Code's does — billing the input
  // and cache reads a fan-out re-sends would over-report it by an order of
  // magnitude and make the documented guards useless.
  const outputTokens = record.lifetimeUsage?.output ?? 0;
  const cwd = childCwd(record);
  const common = {
    ...(tokens > 0 ? { tokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(record.toolUses > 0 ? { toolCalls: record.toolUses } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };

  if (succeeded(record)) {
    return {
      ...common,
      ok: true,
      // The schema'd payload when there is one: `result` is prose, and for a
      // worktree child it has had the branch note appended, so it would not
      // parse. A child asked for a schema that produced none never reaches
      // here — `runAgent` reports that through `failure`.
      text: record.structuredJson ?? record.result ?? "",
      ...(record.structuredRetried ? { structuredRetried: true } : {}),
    };
  }
  // "stopped" is someone reaching in and stopping this child — /agents, the
  // fleet list, a workflow abort. That is the same thing the workflows dialog's
  // skip action means, so it renders as skipped rather than failed.
  if (record.status === "stopped") {
    return { ...common, ok: false, skipped: true, error: record.error ?? "Stopped." };
  }
  return { ...common, ok: false, error: record.error ?? `Agent ${record.status}.` };
}

/** Shell used to run a `gate` command, mirroring how a user would type it. */
const GATE_SHELL: readonly [string, string] =
  process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];

export function createWorkflowHost(deps: WorkflowHostOptions): WorkflowHost {
  const { pi, ctx, manager } = deps;
  /** Runtime agent id → the manager record it spawned. Never pruned mid-run. */
  const records = new Map<string, string>();
  /**
   * scopeModels warnings already toasted, so a fan-out that pins one
   * out-of-scope agent file raises one notification rather than one per child.
   * Kept for the whole run: the same message is the same warning at agent 200
   * as it was at agent 1.
   */
  const warnedScopeMessages = new Set<string>();

  /**
   * Run a gate command in `cwd`. The only place a gate is executed — `runGate`
   * and the pre-cleanup hook both come through here — so "gate passed" is
   * decided from one behaviour, whichever route the command took.
   */
  async function executeGate(command: string, cwd: string): Promise<WorkflowGateResult> {
    const result = await pi.exec(GATE_SHELL[0], [GATE_SHELL[1], command], {
      cwd,
      timeout: deps.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const output = [result.stdout, result.stderr]
      .map(stream => stream.trim())
      .filter(Boolean)
      .join("\n");
    // `pi.exec` reports a timeout as `killed` with exit code 0, so the code
    // alone would read a killed gate as a passing one.
    if (result.killed) {
      return { ok: false, output: output || `Gate command timed out: ${command}` };
    }
    return { ok: result.code === 0, output };
  }

  return {
    async spawnAgent(request) {
      // Old persisted scripts and raw requests must fail before any side effects.
      if ("model" in request) return { ok: false, error: MODEL_OVERRIDE_ERROR };

      const dispatch = resolveSpawnType(request.agentType);
      if (!dispatch.ok) return { ok: false, error: dispatch.message };

      // The selected agent's configuration is authoritative; otherwise inherit.
      let model = ctx.model;
      const config = getAgentConfig(dispatch.type);
      const modelInput = config?.model;
      if (modelInput !== undefined) {
        const resolved = resolveModel(modelInput, ctx.modelRegistry);
        if (typeof resolved !== "string") model = resolved;
      }

      // User-authored configuration retains scopeModels warn-and-proceed policy.
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: false,
        agentLabel: config?.displayName ?? dispatch.type,
        modelInput,
      });
      // This agent's failure, not the run's — the same shape a bad agent type
      // takes above. The script sees `null` and its siblings carry on, which is
      // the difference between one refused model and a discarded fan-out.
      if (scopeVerdict.kind === "error") return { ok: false, error: scopeVerdict.message };
      if (scopeVerdict.kind === "warn" && !warnedScopeMessages.has(scopeVerdict.message)) {
        warnedScopeMessages.add(scopeVerdict.message);
        ctx.ui.notify(scopeVerdict.message, "warning");
      }

      /**
       * The gate's verdict, set only if the hook below actually ran the command.
       * Its presence is what stops the runtime running the gate a second time,
       * so it is set on the failure route too — a gate we tried and could not
       * complete is a failed gate, never an un-run one that then re-runs
       * against the wrong tree.
       */
      let gate: WorkflowGateResult | undefined;
      let spawnedId: string | undefined;

      /**
       * Hand the child's EFFECTIVE configuration back to the run.
       *
       * `AgentRecord.invocation` is the one authoritative place for it (#168),
       * filled by the manager the moment the child's session exists — which is
       * before this fires, so it is populated by the time we read it. Reading it
       * rather than re-deriving "the session, else the request" is the whole
       * point of that field existing.
       */
      let sessionReady = false;
      const reportResolved = () => {
        // Called from BOTH the session hook and the spawn hook, because their
        // order is not guaranteed: the manager fires `onSpawned` after
        // `runAgent` returns, but `runAgent` decides when its own
        // `onSessionCreated` fires — synchronously, for a stub. Each fires once,
        // so the first call finds a half missing and returns, and the second is
        // the one that reports.
        if (!sessionReady || spawnedId === undefined) return;
        const info = resolvedInfo(manager.getRecord(spawnedId));
        if (info !== undefined) request.onResolved?.(info);
      };
      const command = request.gate;
      /**
       * Verify the child's work while its worktree still exists.
       *
       * The manager destroys that copy inside the child's own settle, so this
       * is the last (and only) moment at which `npm test` can mean "the code
       * this child just wrote" rather than "whatever is in the main tree".
       */
      const onBeforeWorktreeCleanup =
        command === undefined
          ? undefined
          : async (worktreePath: string): Promise<void> => {
              // A failed child's gate is never consulted — the runtime reports
              // the child's own failure — so running it would be pure cost.
              if (spawnedId === undefined || !succeeded(manager.getRecord(spawnedId))) return;
              try {
                gate = await executeGate(command, worktreePath);
              } catch (error) {
                gate = { ok: false, output: error instanceof Error ? error.message : String(error) };
              }
            };

      try {
        const { record } = await manager.spawnAndWait(
          pi,
          ctx,
          dispatch.type,
          request.prompt,
          {
            description: request.label,
            serviceTier: config?.serviceTier,
            // Same as the Agent tool: `isolated` comes off the agent definition.
            // Left out, a hermetic agent's script-spawned children loaded every
            // host extension and picked up its MCP and web tools.
            ...(config?.isolated !== undefined ? { isolated: config.isolated } : {}),
            // The stamp is what keeps this child out of the session's
            // `maxConcurrent` pool — see `occupiesPoolSlot`. The run already
            // bounds how many of its agents run at once, and counting them
            // twice would let one fan-out starve everything else the user is
            // doing. No `bypassQueue` needed: an agent outside the pool is
            // never queued behind it.
            ...(deps.workflowId !== undefined ? { workflowId: deps.workflowId } : {}),
            ...(model !== undefined ? { model } : {}),
            // Validated worker-side against the same list pi accepts, so the
            // cast asserts what the boundary has already checked. Left unset,
            // the agent definition's `thinking` (then the parent's) still wins —
            // same precedence as `model` above.
            ...(request.effort !== undefined ? { thinkingLevel: request.effort as ThinkingLevel } : {}),
            // Seeded with the REQUEST, not the outcome. The manager overwrites
            // the effective half at session creation; without a seed there is
            // nothing for it to compare against, so a level pi clamped would be
            // indistinguishable from one that was honoured.
            //
            // Model choice comes only from user configuration or inheritance.
            invocation: {
              serviceTier: config?.serviceTier,
              ...(request.effort !== undefined ? { thinking: request.effort as ThinkingLevel } : {}),
            },
            // Fires once the child's session exists, which is where the model
            // and the clamped thinking level first become knowable.
            onSessionCreated: () => { sessionReady = true; reportResolved(); },
            ...(request.schema !== undefined ? { structuredOutput: request.schema } : {}),
            ...(request.isolation !== undefined ? { isolation: request.isolation } : {}),
            ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
            ...(deps.rootSessionId !== undefined ? { rootSessionId: deps.rootSessionId } : {}),
            ...(deps.toolCallId !== undefined ? { parentToolCallId: deps.toolCallId } : {}),
            ...(onBeforeWorktreeCleanup !== undefined ? { onBeforeWorktreeCleanup } : {}),
          },
          id => {
            spawnedId = id;
            records.set(request.agentId, id);
            // Ahead of `reportResolved`, and not folded into it: that one waits
            // for the child's session so it can name the effective model, while
            // the record id is known here and is what the inspector opens a
            // conversation on. A child that fails before its session resolves
            // would otherwise never be openable at all.
            request.onResolved?.({ recordId: id });
            reportResolved();
          },
        );
        return { ...toSpawnResult(record), ...(gate !== undefined ? { gate } : {}) };
      } catch (error) {
        // Strict worktree isolation rejects out of `awaitStartup` — the child
        // never ran. That is this agent's failure, not the run's: the script
        // sees `null` and its siblings carry on.
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    abortAgent(agentId) {
      const id = records.get(agentId);
      // Nothing to abort before the manager has issued an id — the child is
      // still in startup, and the run's own signal reaches it there.
      if (id !== undefined) manager.abort(id);
    },

    async resumeAgent(agentId, prompt, onResolved) {
      const id = records.get(agentId);
      if (id === undefined) {
        return { ok: false, error: `Cannot resume "${agentId}" — it never started.` };
      }
      const record = await manager.resume(id, prompt, deps.signal);
      if (record === undefined) {
        return {
          ok: false,
          error: `Agent ${id} has no session left to resume — records are dropped ten minutes after they finish.`,
        };
      }
      // The resumed row is built from scratch, so it has to be told the same
      // thing the first one was — the child's session already exists, so this is
      // simply read back rather than waited for. The id goes first for the same
      // reason it does on the spawn path: it is knowable even when the rest is
      // not.
      onResolved?.({ recordId: id });
      const info = resolvedInfo(record);
      if (info !== undefined) onResolved?.(info);
      return toSpawnResult(record);
    },

    /**
     * Resolve a nested `workflow()` reference. The runtime decides whether what
     * comes back is a workflow; this only finds it.
     */
    loadWorkflow(ref) {
      return resolveWorkflowSource(ref, ctx.cwd);
    },

    // Reached only for a gate the spawn did not already run — a child with no
    // worktree of its own, or a host wired without the pre-cleanup hook.
    async runGate(command, gate) {
      // The child's worktree when it had one and it survived; otherwise the
      // session's own directory, which is where a non-isolated child worked.
      return await executeGate(command, gate.cwd ?? ctx.cwd);
    },
  };
}
