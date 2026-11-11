import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SNAPSHOT = "goal-state";
const MESSAGE = "goal-instruction";
const MODES = Symbol.for("pi-extensions.session-modes");
type State = "active" | "paused" | "blocked" | "waiting" | "budget" | "completed" | "stopped";
type Target = { kind: "subagents"; ids: string[] } | { kind: "executions"; executions: { id: string; executionId: string }[] } | { kind: "herder"; runId: string; launch: number };
interface Goal { version: 1; objective: string; state: State; budget: number | null; usage: number; reason: string }
interface Registry { modes: Map<string, Set<string>>; listeners: Set<(id: string) => void> }
const HELP = "Usage: /goal <objective> | /goal --budget <tokens> <objective> | /goal status | pause | resume | stop | budget <tokens> | help. Use /goal -- <objective> for an objective beginning with a command word.";
function readGoal(ctx: ExtensionContext): Goal | undefined {
 const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === SNAPSHOT);
 if (!entry || entry.type !== "custom") return undefined;
 const g = entry.data as Goal | null;
 if (!g || g.version !== 1 || typeof g.objective !== "string" || !g.objective.trim() || !["active", "paused", "blocked", "waiting", "budget", "completed", "stopped"].includes(g.state) || !(g.budget === null || Number.isSafeInteger(g.budget) && g.budget > 0) || !Number.isSafeInteger(g.usage) || g.usage < 0 || typeof g.reason !== "string") throw new Error("Unreadable latest goal state on this branch.");
 return { ...g };
}
function instruction(g: Goal): string {
 return `Work toward the user's goal: ${g.objective}\nGather evidence, perform useful work, and report genuine blockers honestly. Call goal_update with completed and an honest summary only when you believe the objective is complete; this is your claim, not independent verification. Call goal_update with blocked and a reason for a real blocker, or waiting with a reason if external background work must finish. To wake on a completion, provide subagentExecutions [{id, executionId}] using the execution IDs returned by background spawn or resume (wake on any); use subagentIds only when execution IDs are unavailable, because resumed IDs are ambiguous; or provide herder {runId, launch}; without a target, the user must resume. Do not poll or sleep waiting. Existing permissions and approval requirements still apply; this goal grants no Selfdrive or Herder approval.`;
}
const inactive = (g: Goal) => `The goal is ${g.state}, not active. Do not continue pursuing it automatically. Respect the user's input and other extensions' instructions. Reason: ${g.reason}`;
function tokens(value: string): number {
 if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Budget must be a positive whole number of tokens.");
 return Number(value);
}
function registry(): Registry {
 const shared = globalThis as Record<symbol, unknown>;
 return (shared[MODES] ??= { modes: new Map(), listeners: new Set() }) as Registry;
}
function stable(value: unknown): string {
 return JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v) ?? "undefined";
}
function digest(value: unknown): string { return createHash("sha256").update(stable(value)).digest("hex"); }
const inspectionTools = new Set(["read", "grep", "find", "ls", "ffgrep", "fffind"]);
// Only simple commands with unambiguously observational syntax; shell operators,
// substitutions, redirections and git options can change behavior or write files.
function shellInspection(args: unknown): boolean {
 if (!args || typeof args !== "object" || !("command" in args) || typeof args.command !== "string") return false;
 const command = args.command.trim();
 return /^(?:pwd|git status(?: --short| -s| --porcelain(?:=v[12])?)?|git diff(?: --stat)?|git log(?: --oneline)?|git rev-parse (?:HEAD|--show-toplevel))$/.test(command);
}
type Completion = { target: string; identity: string };
function notification(type: string, raw: unknown): Completion[] {
 if (!raw || typeof raw !== "object") return [];
 const d = raw as { id?: unknown; others?: unknown; runId?: unknown; launch?: unknown };
 if (type === "subagent-notification") {
  const all = [d, ...(Array.isArray(d.others) ? d.others : [])];
  return all.flatMap(v => {
   if (!v || typeof v !== "object" || typeof v.id !== "string" || !v.id) return [];
   const { others: _others, ...details } = v;
   const executionId = (details as { executionId?: unknown }).executionId;
   const identity = typeof executionId === "string" && executionId.length > 0
    ? `execution:${digest([v.id, executionId])}` : `legacy:${digest(details)}`;
   return [{ target: `agent:${v.id}`, identity }];
  });
 }
 if (type === "herder:launch" && typeof d.runId === "string" && Number.isSafeInteger(d.launch) && (d.launch as number) > 0) return [{ target: `herder:${d.runId}:${d.launch}`, identity: `herder:${d.runId}:${d.launch}` }];
 return [];
}
function matches(target: Target, identity: string, key: string): boolean {
 if (target.kind === "executions") return target.executions.some(({ id, executionId }) => identity === `execution:${digest([id, executionId])}`);
 return target.kind === "subagents" ? target.ids.some(id => key === `agent:${id}`) : key === `herder:${target.runId}:${target.launch}`;
}
export default function goalExtension(pi: ExtensionAPI): void {
 let goal: Goal | undefined;
 let broken = false, uiDepth = 0, owned = false, preparing = false, inactiveSent = false;
 let abortable = false, completedInRun = false;
 let wake: string | undefined;
 let lastAnswer = "", currentAnswer = "", repeated = 0, didWork = false;
 let lastFailure = "", failures = 0, lastInspections: string | undefined, inspections = "";
 const calls = new Map<string, { name: string; args: unknown }>();
 let waiting: Target | undefined;
 const seen = new Map<string, string>();
 const consumed = new Set<string>();
 let sessionId: string | undefined, sessionCtx: ExtensionContext | undefined;
 const eligible = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";
 const selfdrive = () => sessionId !== undefined && registry().modes.get(sessionId)?.has("selfdrive") === true;
 function status(ctx: ExtensionContext) {
  const label = broken ? "goal ERROR · unreadable state" : goal && goal.state !== "stopped" ? `goal ${goal.state} · ${goal.objective.replace(/\s+/g, " ").slice(0, 60)}` : undefined;
  ctx.ui.setStatus("goal", label);
 }
 function save(ctx: ExtensionContext) { if (goal) pi.appendEntry(SNAPSHOT, { ...goal }); status(ctx); }
 function change(ctx: ExtensionContext, state: State, reason: string) {
  if (!goal) return;
  goal.state = state; goal.reason = reason; inactiveSent = false;
  if (state !== "waiting") { waiting = undefined; wake = undefined; }
  save(ctx);
  ctx.ui.notify(`Goal ${state}: ${reason}`, state === "completed" || state === "stopped" ? "info" : "warning");
 }
 function abortOwned(ctx: ExtensionContext) { if (owned && abortable) ctx.abort(); }
 const modeListener = (id: string) => {
  if (id === sessionId && selfdrive() && goal?.state === "active" && sessionCtx) {
   change(sessionCtx, "paused", "Selfdrive enabled; turn it off and resume Goal explicitly");
   abortOwned(sessionCtx);
  }
 };
 function detach() { registry().listeners.delete(modeListener); sessionCtx = undefined; sessionId = undefined; }
 function restore(ctx: ExtensionContext) {
  detach(); sessionCtx = ctx; sessionId = ctx.sessionManager.getSessionId(); registry().listeners.add(modeListener);
  goal = undefined; broken = false; owned = false; abortable = false; completedInRun = false; wake = undefined; preparing = false; inactiveSent = false; uiDepth = 0;
  lastAnswer = ""; currentAnswer = ""; repeated = 0; didWork = false; lastFailure = ""; failures = 0; lastInspections = undefined; inspections = ""; calls.clear(); waiting = undefined; seen.clear(); consumed.clear();
  try {
   goal = readGoal(ctx);
   if (goal?.state === "active" || goal?.state === "waiting") { goal.state = "paused"; goal.reason = "restored after session or branch change; use /goal resume"; save(ctx); }
  } catch (error) { broken = true; ctx.ui.notify(`Goal restore error: ${String(error)}`, "error"); }
  status(ctx);
 }
 function dispatch() {
  if (!goal || goal.state !== "active") return;
  preparing = true;
  pi.sendMessage({ customType: MESSAGE, display: false, content: instruction(goal) }, { triggerTurn: true, deliverAs: "followUp" });
 }
 function observe(type: string, details: unknown): string | undefined {
  if (!goal || !["active", "waiting", "paused"].includes(goal.state)) return;
  for (const item of notification(type, details)) if (!consumed.has(item.identity)) seen.set(item.identity, item.target);
  if (goal.state !== "waiting" || !waiting || wake) return;
  return findCompletion(waiting);
 }
 function findCompletion(target: Target): string | undefined {
  return [...seen].find(([identity, key]) => matches(target, identity, key) && !consumed.has(identity))?.[0];
 }
 function activateWake(ctx: ExtensionContext, key: string): boolean {
  if (!goal || goal.state !== "waiting" || !waiting || !matches(waiting, key, seen.get(key) ?? "") || consumed.has(key)) return false;
  if (selfdrive()) { change(ctx, "paused", "Selfdrive enabled; resume Goal after it is off"); return false; }
  if (goal.budget !== null && goal.usage >= goal.budget) { change(ctx, "budget", "soft token budget exhausted; increase it and resume"); return false; }
  consumed.add(key); seen.delete(key); wake = undefined; waiting = undefined;
  goal.state = "active"; goal.reason = "expected background work reported a result"; save(ctx); return true;
 }
 pi.registerCommand("goal", { description: "Work toward an objective: /goal <objective> | status | pause | resume | stop | budget <tokens>", handler: async (args, ctx) => {
  try {
   const text = args.trim();
   if (text === "help") { ctx.ui.notify(HELP, "info"); return; }
   if (!eligible(ctx)) throw new Error("/goal requires a TUI or RPC session.");
   if (broken) throw new Error("Goal state is unreadable on this branch; navigate to a readable branch before changing it.");
   if (!text || text === "status") { ctx.ui.notify(goal ? `Goal ${goal.state}: ${goal.objective}\nCurrent-session assistant tokens (excluding cache reads and child sessions): ${goal.usage} / ${goal.budget ?? "unbounded"}${goal.reason ? `\n${goal.reason}` : ""}` : "No goal. " + HELP, "info"); return; }
   if (text === "pause" || text === "stop") {
    if (!goal || goal.state === "completed" || goal.state === "stopped") throw new Error("No live goal to " + text + ".");
    change(ctx, text === "pause" ? "paused" : "stopped", `${text} by user`); if (text === "stop") { seen.clear(); consumed.clear(); } abortOwned(ctx); return;
   }
   if (text === "resume") {
    if (!goal || !["paused", "blocked", "waiting", "budget"].includes(goal.state)) throw new Error("No paused, blocked, waiting, or budget-limited goal to resume.");
    if (selfdrive()) throw new Error("Turn off Selfdrive before resuming Goal.");
    if (goal.budget !== null && goal.usage >= goal.budget) throw new Error("Budget exhausted; increase it with /goal budget <tokens> before resuming.");
    if (!ctx.isIdle() || ctx.hasPendingMessages() || uiDepth || preparing || owned) throw new Error("Wait until the agent, queued messages, and dialogs are idle before resuming.");
    goal.state = "active"; goal.reason = "resumed by user"; waiting = undefined; lastAnswer = ""; repeated = 0; didWork = false; lastFailure = ""; failures = 0; lastInspections = undefined; inspections = ""; save(ctx); dispatch(); return;
   }
   if (/^budget(?:\s|$)/.test(text)) {
    if (!goal || ["completed", "stopped"].includes(goal.state)) throw new Error("No live goal. " + HELP);
    goal.budget = tokens(text.slice(6).trim()); save(ctx);
    if (goal.state === "active" && goal.usage >= goal.budget) change(ctx, "budget", "soft token budget exhausted; increase it and resume");
    else ctx.ui.notify(`Goal budget: ${goal.budget} tokens; used ${goal.usage}.`, "info");
    return;
   }
   let objective = text, budget: number | null = null;
   if (text.startsWith("-- ")) objective = text.slice(3).trim();
   else if (text.startsWith("--budget")) {
    const match = /^--budget\s+(\S+)\s+([\s\S]+)$/.exec(text);
    if (!match) throw new Error(HELP);
    budget = tokens(match[1]); objective = match[2].trim();
   } else if (/^(?:pause|resume|stop|status|help)(?:\s|$)/.test(text) || text.startsWith("--")) throw new Error(HELP);
   if (!objective) throw new Error(HELP);
   if (goal && !["completed", "stopped"].includes(goal.state)) throw new Error("A goal already exists. Stop it before starting another.");
   if (selfdrive()) throw new Error("Turn off Selfdrive before starting Goal.");
   if (!ctx.isIdle() || ctx.hasPendingMessages() || uiDepth || preparing || owned) throw new Error("Wait until the agent, queued messages, and dialogs are idle before starting a goal.");
   seen.clear(); consumed.clear(); lastFailure = ""; failures = 0; lastInspections = undefined; inspections = "";
   goal = { version: 1, objective, state: "active", budget, usage: 0, reason: "" }; save(ctx); dispatch();
  } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
 } });
 pi.registerTool({ name: "goal_update", label: "Goal Update", executionMode: "sequential", description: "Report the active goal completed, blocked, or waiting for external background work. Give an honest evidence-based summary or reason. For waiting, use subagentExecutions with id and executionId returned by background spawn or resume for exact matching, or herder runId and launch. Legacy subagentIds match any execution of an ID and are ambiguous after resume.", parameters: Type.Object({ state: Type.Union([Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("waiting")]), reason: Type.String({ minLength: 1, maxLength: 2000 }), subagentIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "Legacy agent IDs; ambiguous when an agent is resumed." })), subagentExecutions: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), executionId: Type.String({ minLength: 1 }) }), { minItems: 1, description: "Exact agent and execution ID pairs from background spawn or resume; wake on any." })), herder: Type.Optional(Type.Object({ runId: Type.String({ minLength: 1 }), launch: Type.Integer({ minimum: 1 }) })) }), async execute(_id, params, _signal, _update, ctx) {
  if (!owned || !goal || goal.state !== "active") throw new Error("No active goal owns this run.");
  if (!params.reason.trim()) throw new Error("An honest summary or reason is required.");
  if ([params.subagentIds, params.subagentExecutions, params.herder].filter(Boolean).length > 1 || params.state !== "waiting" && (params.subagentIds || params.subagentExecutions || params.herder)) throw new Error("Supply one wake target only when waiting.");
  const target: Target | undefined = params.subagentIds ? { kind: "subagents", ids: params.subagentIds } : params.subagentExecutions ? { kind: "executions", executions: params.subagentExecutions } : params.herder ? { kind: "herder", ...params.herder } : undefined;
  const early = target && findCompletion(target);
  if (early) {
   // The notification was already delivered during this goal run. Consume it once.
   consumed.add(early); seen.delete(early);
   goal.reason = "expected background work already reported a result"; save(ctx);
   return { content: [{ type: "text", text: "The expected completion already arrived; continue the goal using that result." }], details: {} };
  }
  change(ctx, params.state, params.reason.trim()); waiting = target;
  if (params.state === "completed") completedInRun = true;
  return { content: [{ type: "text", text: `Goal ${params.state}: ${params.reason}` }], details: {} };
 } });
 pi.on("session_start", (_event, ctx) => { if (eligible(ctx)) restore(ctx); });
 pi.on("session_tree", (_event, ctx) => { if (eligible(ctx)) restore(ctx); });
 pi.on("before_agent_start", (event, ctx) => {
  if (!eligible(ctx)) return;
  if (event.messageType === "custom" && event.message.customType === MESSAGE) {
   if (!preparing || goal?.state !== "active") { ctx.abort(); return; }
   preparing = false; owned = true; abortable = true; inactiveSent = false; return;
  }
  const match = event.messageType === "custom" ? observe(event.message.customType, event.message.details) : undefined;
  if (match && (ctx.hasPendingMessages() || uiDepth)) wake = match;
  else if (match && activateWake(ctx, match)) {
   owned = true; abortable = true; completedInRun = false; inactiveSent = false;
   return { message: { customType: MESSAGE, content: instruction(goal!), display: false } };
  }
  if (goal?.state === "active") change(ctx, "paused", "user or another prompt took over; resume to continue");
  owned = false; abortable = false; completedInRun = false; preparing = false;
 });
 pi.on("message_start", (event, ctx) => {
  if (event.message.role === "custom") {
   const match = observe(event.message.customType, event.message.details);
   if (match) wake = match;
  } else if (event.message.role === "user") {
   if (wake && goal?.state === "waiting") change(ctx, "paused", "user input interrupted the pending wake; resume to continue");
   else if (owned && goal?.state === "active") change(ctx, "paused", "user input interrupted the goal");
  }
 });
 pi.on("tool_execution_start", event => { if (owned) { didWork = true; calls.set(event.toolCallId, { name: event.toolName, args: event.args }); } });
 pi.on("tool_execution_end", (event, ctx) => {
  if (!owned || goal?.state !== "active") return;
  const call = calls.get(event.toolCallId); calls.delete(event.toolCallId);
  if (!call) return;
  if (!event.isError) {
   if (inspectionTools.has(call.name) || call.name === "bash" && shellInspection(call.args)) inspections = digest([inspections, call.name, call.args, event.result]);
   else { lastFailure = ""; failures = 0; lastInspections = undefined; inspections = ""; }
   return;
  }
  const fingerprint = digest([call.name, call.args, event.result]);
  if (fingerprint !== lastFailure || (lastInspections !== undefined && inspections !== lastInspections)) {
   failures = 1; lastInspections = undefined;
  } else {
   failures++;
   if (lastInspections === undefined) lastInspections = inspections;
  }
  lastFailure = fingerprint; inspections = "";
  if (failures >= 3) { change(ctx, "paused", `repeated identical failing ${call.name} tool call; inspect the failure and resume`); abortOwned(ctx); }
 });
 pi.on("message_end", (event, ctx) => {
  if (!owned || !goal || event.message.role !== "assistant") return;
  currentAnswer = event.message.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
  const usage = event.message.usage;
  const total = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
  if (Number.isSafeInteger(total) && total >= 0) { goal.usage += total; save(ctx); }
 });
 pi.on("agent_before_settle", (event, ctx) => {
  if (!owned || !goal) return;
  if (wake && goal.state === "waiting" && event.outcome !== "completed") change(ctx, "paused", `agent ${event.outcome} before pending wake; resume to continue`);
  if (completedInRun && goal.state === "completed" && event.outcome !== "completed") change(ctx, "paused", `completion uncertain: agent ${event.outcome} after reported completion: ${goal.reason}`);
  if (goal.state === "active") {
   if (event.outcome !== "completed") change(ctx, "paused", `agent ${event.outcome}; resume to retry`);
   else if (goal.budget !== null && goal.usage >= goal.budget) change(ctx, "budget", "soft token budget exhausted; increase it and resume");
   else if (ctx.hasPendingMessages() || event.context.pendingMessages.length || uiDepth) change(ctx, "paused", "pending input or dialog; resume when ready");
   else {
    if (currentAnswer && !didWork && currentAnswer === lastAnswer) repeated++; else repeated = 0;
    lastAnswer = currentAnswer; currentAnswer = ""; didWork = false;
    if (repeated >= 2) change(ctx, "paused", "repeated identical responses without tool work; inspect progress and resume");
   }
  }
  if (goal.state !== "active") {
   if (inactiveSent) return;
   inactiveSent = true;
   return { entries: [...event.entries, { type: "custom_message", customType: MESSAGE, content: inactive(goal), display: false }] };
  }
  if (event.continue) return;
  return { entries: [...event.entries, { type: "custom_message", customType: MESSAGE, content: instruction(goal), display: false }], continue: true };
 });
 pi.on("agent_settled", (event, ctx) => {
  if (owned && event.aborted && completedInRun && goal?.state === "completed") change(ctx, "paused", `completion uncertain: agent aborted after reported completion: ${goal.reason}`);
  else if (owned && event.aborted && goal?.state === "active") change(ctx, "paused", "agent interrupted; resume to continue");
  owned = false; abortable = false; completedInRun = false; preparing = false; calls.clear();
  if (wake && goal?.state === "waiting") {
   if (event.aborted) { change(ctx, "paused", "interruption before pending wake; resume to continue"); return; }
   if (ctx.hasPendingMessages() || uiDepth) return;
   if (activateWake(ctx, wake)) dispatch();
  }
 });
 pi.on("ui_prompt_start", () => { uiDepth++; });
 pi.on("ui_prompt_end", (_event, ctx) => {
  uiDepth = Math.max(0, uiDepth - 1);
  if (!uiDepth && wake && ctx.isIdle() && !ctx.hasPendingMessages() && activateWake(ctx, wake)) dispatch();
 });
 pi.on("session_shutdown", (_event, ctx) => { if (!eligible(ctx)) return; if (goal?.state === "active" || goal?.state === "waiting") change(ctx, "paused", "session stopped; resume to continue"); ctx.ui.setStatus("goal", undefined); owned = false; preparing = false; waiting = undefined; seen.clear(); detach(); });
}
