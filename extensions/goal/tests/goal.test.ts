import { describe, expect, it } from "vitest";
import goalExtension from "../index.ts";
import { CompletionOutbox } from "../../subagents/src/completion-outbox.ts";

let sequence = 0;
function fixture(branch: any[] = [], mode = "rpc") {
 const sessionId = `goal-test-${++sequence}`; let aborted = 0;
 const handlers: Record<string, Function> = {}; const commands: Record<string, any> = {}; const tools: Record<string, any> = {};
 const notifications: string[] = []; const statuses: (string | undefined)[] = []; const sent: any[] = [];
 let pending = false; let idle = true;
 const ctx: any = { mode, sessionManager: { getBranch: () => branch, getSessionId: () => sessionId }, isIdle: () => idle, hasPendingMessages: () => pending, abort: () => { aborted++; }, ui: { notify: (s: string) => notifications.push(s), setStatus: (_: string, s: string | undefined) => statuses.push(s) } };
 const pi: any = { on: (name: string, fn: Function) => { handlers[name] = fn; }, registerCommand: (name: string, value: any) => { commands[name] = value; }, registerTool: (value: any) => { tools[value.name] = value; }, appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }), sendMessage: (message: any) => sent.push(message) };
 goalExtension(pi); handlers.session_start({ reason: "startup" }, ctx);
 const command = (s: string) => commands.goal.handler(s, ctx);
 const start = () => handlers.before_agent_start({ messageType: "custom", message: sent.at(-1) }, ctx);
 const boundary = (overrides: any = {}) => handlers.agent_before_settle({ outcome: "completed", entries: [], continue: false, context: { pendingMessages: [], canContinue: true }, ...overrides }, ctx);
 return { handlers, tools, ctx, command, start, boundary, branch, sent, notifications, statuses, sessionId, aborted: () => aborted, setPending: (v: boolean) => { pending = v; }, setIdle: (v: boolean) => { idle = v; } };
}

describe("goal lifecycle", () => {
 it("starts immediately, retains competing entries, and does not duplicate continuation", async () => {
  const h = fixture(); await h.command("build it"); expect(h.sent).toHaveLength(1); h.start();
  const entry = { type: "custom", customType: "other" }; const result = h.boundary({ entries: [entry] });
  expect(result.continue).toBe(true); expect(result.entries[0]).toEqual(entry); expect(result.entries[1].content).toContain("build it");
  expect(h.boundary({ continue: true, entries: [entry] })).toBeUndefined();
  await h.command("another goal"); expect(h.notifications.at(-1)).toMatch(/already exists/);
 });
 it.each(["completed", "blocked", "waiting"])("honors explicit %s and does not spin", async state => {
  const h = fixture(); await h.command("do work"); h.start();
  await h.tools.goal_update.execute("", { state, reason: "evidence" }, undefined, undefined, h.ctx);
  expect(h.boundary().entries.at(-1).content).toContain(`goal is ${state}`); expect(h.statuses.at(-1)).toContain(state);
 });
 it("pauses for input, dialogs, errors, and abort", async () => {
  for (const kind of ["pending", "dialog", "error", "abort"]) {
   const h = fixture(); await h.command("do work"); h.start();
   if (kind === "pending") h.setPending(true);
   if (kind === "dialog") h.handlers.ui_prompt_start({}, h.ctx);
   if (kind === "error") h.boundary({ outcome: "error" });
   else if (kind === "abort") h.handlers.agent_settled({ aborted: true }, h.ctx);
   else h.boundary();
   expect(h.statuses.at(-1)).toContain("paused");
  }
 });
 it("pauses after three identical responses without tool work", async () => {
  const h = fixture(); await h.command("investigate"); h.start();
  for (let i = 0; i < 3; i++) {
   h.handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "Still looking" }], usage: {} } }, h.ctx);
   h.boundary();
  }
  expect(h.statuses.at(-1)).toContain("paused"); expect(h.notifications.at(-1)).toMatch(/repeated identical/);
 });
 it("counts input output and cache writes, persists usage, and requires budget increase", async () => {
  const h = fixture(); await h.command("--budget 10 investigate"); h.start();
  h.handlers.message_end({ message: { role: "assistant", content: [], usage: { input: 4, output: 3, cacheWrite: 3, cacheRead: 100 } } }, h.ctx);
  expect(h.boundary().entries.at(-1).content).toContain("goal is budget"); expect(h.branch.at(-1).data).toMatchObject({ usage: 10, state: "budget" });
  await h.command("resume"); expect(h.notifications.at(-1)).toMatch(/increase/);
  h.handlers.agent_settled({ aborted: false }, h.ctx); await h.command("budget 20"); await h.command("resume"); expect(h.sent).toHaveLength(2);
 });
 it("restores active snapshots paused on reload and tree, fails closed on corrupt latest state", async () => {
  const h = fixture(); await h.command("-- stop the regression");
  const fork = fixture([...h.branch]); expect(fork.statuses.at(-1)).toContain("paused"); expect(fork.sent).toHaveLength(0);
  fork.handlers.session_tree({}, fork.ctx); expect(fork.statuses.at(-1)).toContain("paused");
  const bad = fixture([...h.branch, { type: "custom", customType: "goal-state", data: null }]); await bad.command("new goal"); expect(bad.notifications.at(-1)).toMatch(/unreadable/i); expect(bad.sent).toHaveLength(0);
 });
 it("cleans status on shutdown and does not run in print mode", async () => {
  const h = fixture(); await h.command("target"); h.handlers.session_shutdown({}, h.ctx); expect(h.statuses.at(-1)).toBeUndefined();
  const p = fixture([], "print"); await p.command("target"); expect(p.sent).toHaveLength(0);
 });
});

describe("goal coordination", () => {
 it.each(["pause", "stop"])("%s aborts only an owned turn", async action => {
  const h = fixture(); await h.command("objective"); await h.command(action); expect(h.aborted()).toBe(0);
  const owned = fixture(); await owned.command("objective"); owned.start(); await owned.command(action); expect(owned.aborted()).toBe(1);
  const user = fixture(); await user.command("objective"); user.handlers.before_agent_start({ messageType: "user" }, user.ctx); await user.command(action); expect(user.aborted()).toBe(0);
 });
 it("stops exact repeated failing calls but resets on a changed result", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const fail = (result: string) => { h.handlers.tool_execution_start({ toolCallId: "1", toolName: "test", args: { b: 2, a: 1 } }); h.handlers.tool_execution_end({ toolCallId: "1", isError: true, result }, h.ctx); };
  fail("a"); fail("a"); fail("b"); expect(h.aborted()).toBe(0); fail("b"); fail("b"); expect(h.aborted()).toBe(1); expect(h.statuses.at(-1)).toContain("paused");
 });
 it("preserves competing proposals and evaluates repeated answers", async () => {
  const h = fixture(); await h.command("objective"); h.start(); const entry = { type: "custom", customType: "other" };
  for (let i = 0; i < 3; i++) { h.handlers.message_end({ message: { role: "assistant", content: [{ type: "text", text: "same" }], usage: {} } }, h.ctx); const result = h.boundary({ continue: true, entries: [entry] }); if (i === 2) { expect(result.entries[0]).toEqual(entry); expect(result.entries[1].content).toContain("goal is paused"); expect(result.continue).not.toBe(false); } }
 });
 it("wakes on grouped matching notifications, ignoring unrelated messages and duplicates", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ["expected"] }, undefined, undefined, h.ctx);
  h.boundary(); h.handlers.agent_settled({ aborted: false }, h.ctx);
  h.handlers.before_agent_start({ messageType: "custom", message: { customType: "subagent-notification", details: { id: "other" } } }, h.ctx);
  expect(h.statuses.at(-1)).toContain("waiting");
  const result = h.handlers.before_agent_start({ messageType: "custom", message: { customType: "subagent-notification", details: { id: "other", others: [{ id: "expected" }] } } }, h.ctx);
  expect(result.message.content).toContain("objective"); expect(h.statuses.at(-1)).toContain("active");
  await h.tools.goal_update.execute("", { state: "waiting", reason: "again", subagentIds: ["expected"] }, undefined, undefined, h.ctx);
  h.handlers.message_start({ message: { role: "custom", customType: "subagent-notification", details: { id: "expected" } } }, h.ctx);
  expect(h.statuses.at(-1)).toContain("waiting");
 });
 it("handles early completion once and matches Herder launch during a run", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const msg = { role: "custom", customType: "herder:launch", details: { runId: "run", launch: 2 } };
  h.handlers.message_start({ message: msg }, h.ctx);
  const early = await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", herder: { runId: "run", launch: 2 } }, undefined, undefined, h.ctx);
  expect(early.content[0].text).toContain("already arrived");
  await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", herder: { runId: "run", launch: 2 } }, undefined, undefined, h.ctx);
  h.handlers.message_start({ message: msg }, h.ctx); expect(h.statuses.at(-1)).toContain("waiting");
 });
 it("wakes after an unrelated run without taking ownership or charging it", async () => {
  const h = fixture(); await h.command("objective"); h.start(); await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", herder: { runId: "r", launch: 1 } }, undefined, undefined, h.ctx); h.boundary(); h.handlers.agent_settled({ aborted: false }, h.ctx);
  h.handlers.before_agent_start({ messageType: "user" }, h.ctx);
  h.handlers.message_start({ message: { role: "custom", customType: "herder:launch", details: { runId: "r", launch: 1 } } }, h.ctx);
  expect(h.boundary({ continue: true, entries: [{ type: "custom", customType: "other" }] })).toBeUndefined();
  h.handlers.message_end({ message: { role: "assistant", content: [], usage: { input: 500 } } }, h.ctx);
  expect(h.branch.at(-1).data.usage).toBe(0); expect(h.sent).toHaveLength(1);
  h.handlers.agent_settled({ aborted: false }, h.ctx); expect(h.sent).toHaveLength(2); expect(h.statuses.at(-1)).toContain("active");
  await h.command("pause"); expect(h.aborted()).toBe(0);
 });
 it("respects session Selfdrive activation and requires explicit resume", async () => {
  const h = fixture(); const registry = (globalThis as any)[Symbol.for("pi-extensions.session-modes")];
  registry.modes.set(h.sessionId, new Set(["selfdrive"])); await h.command("objective"); expect(h.sent).toHaveLength(0);
  registry.modes.delete(h.sessionId); await h.command("objective"); h.start(); registry.modes.set(h.sessionId, new Set(["selfdrive"])); for (const listener of registry.listeners) listener(h.sessionId);
  expect(h.aborted()).toBe(1); expect(h.statuses.at(-1)).toContain("paused"); h.handlers.agent_settled({ aborted: true }, h.ctx); await h.command("resume"); expect(h.notifications.at(-1)).toContain("Selfdrive");
  registry.modes.delete(h.sessionId); for (const listener of registry.listeners) listener(h.sessionId); expect(h.sent).toHaveLength(1); await h.command("resume"); expect(h.sent).toHaveLength(2);
 });
});

it("does not wake without a target, on a different launch, or after a branch change", async () => {
 const h = fixture(); await h.command("objective"); h.start();
 await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting" }, undefined, undefined, h.ctx);
 h.handlers.message_start({ message: { role: "custom", customType: "herder:launch", details: { runId: "r", launch: 1 } } }, h.ctx); expect(h.statuses.at(-1)).toContain("waiting");
 h.handlers.agent_settled({ aborted: false }, h.ctx); await h.command("resume"); h.start();
 await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", herder: { runId: "r", launch: 2 } }, undefined, undefined, h.ctx);
 h.handlers.message_start({ message: { role: "custom", customType: "herder:launch", details: { runId: "r", launch: 1 } } }, h.ctx); expect(h.statuses.at(-1)).toContain("waiting");
 h.handlers.session_tree({}, h.ctx);
 h.handlers.before_agent_start({ messageType: "custom", message: { customType: "herder:launch", details: { runId: "r", launch: 2 } } }, h.ctx); expect(h.statuses.at(-1)).toContain("paused");
});

describe("review regressions", () => {
 it("detects repeated failing cycles with identical inspection and resets for changes or productive work", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const call = (name: string, result: string, isError = false) => { h.handlers.tool_execution_start({ toolCallId: "x", toolName: name, args: { path: "file" } }); h.handlers.tool_execution_end({ toolCallId: "x", result, isError }, h.ctx); };
  for (let i = 0; i < 2; i++) { call("read", "same"); call("bash", "failure", true); }
  call("read", "changed"); call("bash", "failure", true); expect(h.aborted()).toBe(0);
  call("read", "same"); call("bash", "failure", true); call("edit", "written");
  for (let i = 0; i < 2; i++) { call("read", "same"); call("bash", "failure", true); }
  expect(h.aborted()).toBe(0); call("read", "same"); call("bash", "failure", true); expect(h.aborted()).toBe(1);
 });
 it.each(["error", "aborted"])("marks completion uncertain on %s while preserving the summary", async outcome => {
  const h = fixture(); await h.command("objective"); h.start(); await h.tools.goal_update.execute("", { state: "completed", reason: "verified summary" }, undefined, undefined, h.ctx);
  if (outcome === "error") h.boundary({ outcome: "error" }); else h.handlers.agent_settled({ aborted: true }, h.ctx);
  expect(h.branch.at(-1).data).toMatchObject({ state: "paused", reason: expect.stringContaining("verified summary") }); expect(h.branch.at(-1).data.reason).toContain(outcome);
 });
 it("does not invalidate completion on a later unrelated aborted run", async () => {
  const h = fixture(); await h.command("objective"); h.start(); await h.tools.goal_update.execute("", { state: "completed", reason: "done" }, undefined, undefined, h.ctx); h.boundary(); h.handlers.agent_settled({ aborted: false }, h.ctx);
  h.handlers.before_agent_start({ messageType: "user" }, h.ctx); h.handlers.agent_settled({ aborted: true }, h.ctx); expect(h.branch.at(-1).data).toMatchObject({ state: "completed", reason: "done" });
 });
 it("keeps a completion received before an owned waiting run settles", async () => {
  const h = fixture(); await h.command("objective"); h.start(); await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ["a"] }, undefined, undefined, h.ctx);
  h.handlers.message_start({ message: { role: "custom", customType: "subagent-notification", details: { id: "a" } } }, h.ctx);
  const entry = { type: "custom", customType: "other" }; const result = h.boundary({ continue: true, entries: [entry], context: { pendingMessages: [{ role: "custom" }], canContinue: true } });
  expect(result.entries[0]).toEqual(entry); expect(result.continue).not.toBe(false); expect(h.statuses.at(-1)).toContain("waiting");
  h.handlers.agent_settled({ aborted: false }, h.ctx); expect(h.sent).toHaveLength(2); expect(h.statuses.at(-1)).toContain("active");
 });
 it.each(["pause", "stop", "human", "branch"])("cancels a pending wake on %s", async action => {
  const h = fixture(); await h.command("objective"); h.start(); await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ["a"] }, undefined, undefined, h.ctx); h.handlers.agent_settled({ aborted: false }, h.ctx);
  h.handlers.before_agent_start({ messageType: "user" }, h.ctx); h.handlers.message_start({ message: { role: "custom", customType: "subagent-notification", details: { id: "a" } } }, h.ctx);
  if (action === "human") h.handlers.message_start({ message: { role: "user" } }, h.ctx); else if (action === "branch") h.handlers.session_tree({}, h.ctx); else await h.command(action);
  h.handlers.agent_settled({ aborted: false }, h.ctx); expect(h.sent).toHaveLength(1); expect(h.aborted()).toBe(0);
 });
 it("consumes only one grouped early completion and deduplicates repeats", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const msg = { role: "custom", customType: "subagent-notification", details: { id: "a", others: [{ id: "b" }] } };
  h.handlers.message_start({ message: msg }, h.ctx);
  const update = (ids: string[]) => h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ids }, undefined, undefined, h.ctx);
  expect((await update(["a", "b"])).content[0].text).toContain("already arrived");
  expect((await update(["b"])).content[0].text).toContain("already arrived");
  h.handlers.message_start({ message: msg }, h.ctx); await update(["b"]); expect(h.statuses.at(-1)).toContain("waiting");
 });
});

describe("resumed completion and start boundary regressions", () => {
 it("distinguishes resumed same-ID completions while deduplicating grouped and early delivery", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const update = (ids: string[]) => h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ids }, undefined, undefined, h.ctx);
  const first = { id: "a", status: "completed", durationMs: 100, totalTokens: 200, resultPreview: "first" };
  const second = { ...first, durationMs: 150, totalTokens: 400, resultPreview: "second" };
  const other = { ...first, id: "b" };
  const msg = (details: any) => ({ role: "custom", customType: "subagent-notification", details });
  h.handlers.message_start({ message: msg({ ...first, others: [other] }) }, h.ctx);
  expect((await update(["a", "b"])).content[0].text).toContain("already arrived");
  expect((await update(["b"])).content[0].text).toContain("already arrived");
  h.handlers.message_start({ message: msg(first) }, h.ctx); await update(["a"]); expect(h.statuses.at(-1)).toContain("waiting");
  h.handlers.message_start({ message: msg(second) }, h.ctx); h.handlers.agent_settled({ aborted: false }, h.ctx);
  expect(h.sent).toHaveLength(2); h.start();
  h.handlers.message_start({ message: msg(second) }, h.ctx); await update(["a"]); expect(h.statuses.at(-1)).toContain("waiting");
 });
 it("defers an idle notification turn when a dialog is open and wakes after it closes", async () => {
  const h = fixture(); await h.command("objective"); h.start(); await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ["a"] }, undefined, undefined, h.ctx); h.handlers.agent_settled({ aborted: false }, h.ctx);
  h.handlers.ui_prompt_start({}, h.ctx);
  const result = h.handlers.before_agent_start({ messageType: "custom", message: { customType: "subagent-notification", details: { id: "a", durationMs: 10 } } }, h.ctx);
  expect(result).toBeUndefined(); h.handlers.message_end({ message: { role: "assistant", content: [], usage: { input: 50 } } }, h.ctx); expect(h.branch.at(-1).data.usage).toBe(0);
  h.handlers.agent_settled({ aborted: false }, h.ctx); expect(h.sent).toHaveLength(1); expect(h.statuses.at(-1)).toContain("waiting");
  h.handlers.ui_prompt_end({}, h.ctx); expect(h.sent).toHaveLength(2);
 });
 it("prioritizes queued human input over a notification at turn start", async () => {
  const h = fixture(); await h.command("objective"); h.start(); await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ["a"] }, undefined, undefined, h.ctx); h.handlers.agent_settled({ aborted: false }, h.ctx);
  h.setPending(true); expect(h.handlers.before_agent_start({ messageType: "custom", message: { customType: "subagent-notification", details: { id: "a", durationMs: 10 } } }, h.ctx)).toBeUndefined();
  h.handlers.agent_settled({ aborted: false }, h.ctx); expect(h.sent).toHaveLength(1);
  h.setPending(false); h.handlers.before_agent_start({ messageType: "user" }, h.ctx); h.handlers.message_start({ message: { role: "user" } }, h.ctx); h.handlers.agent_settled({ aborted: false }, h.ctx);
  expect(h.sent).toHaveLength(1); expect(h.statuses.at(-1)).toContain("paused");
 });
 it("detects repeated failed shell commands interleaved with git status and resets on visible change", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const call = (command: string, result: string, isError = false) => { h.handlers.tool_execution_start({ toolCallId: "shell", toolName: "bash", args: { command } }); h.handlers.tool_execution_end({ toolCallId: "shell", result, isError }, h.ctx); };
  call("git status --short", "clean"); call("npm test", "failure", true);
  call("git status --short", "clean"); call("npm test", "failure", true);
  call("git status --short", " M file"); call("npm test", "failure", true); expect(h.aborted()).toBe(0);
  call("git status --short", "clean"); call("npm test", "failure", true);
  call("touch file", "");
  for (let i = 0; i < 3; i++) { call("git status --short", "clean"); call("npm test", "failure", true); }
  expect(h.aborted()).toBe(1);
 });
});

it("detects repeated failed commands interleaved with git status --porcelain", async () => {
 const h = fixture(); await h.command("objective"); h.start();
 const call = (command: string, result: string, isError: boolean) => {
  h.handlers.tool_execution_start({ toolCallId: "shell", toolName: "bash", args: { command } });
  h.handlers.tool_execution_end({ toolCallId: "shell", result, isError }, h.ctx);
 };
 for (let i = 0; i < 3; i++) { call("git status --porcelain", " M file", false); call("npm test", "failure", true); }
 expect(h.aborted()).toBe(1); expect(h.statuses.at(-1)).toContain("paused");
});

describe("Subagents execution identities", () => {
 it("wakes successive waits for identical results from distinct executions and ignores redelivery", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const update = () => h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ["a"] }, undefined, undefined, h.ctx);
  const deliver = (executionId: string, preview = "same") => h.handlers.message_start({ message: { role: "custom", customType: "subagent-notification", details: { id: "a", executionId, resultPreview: preview } } }, h.ctx);
  deliver("first"); expect((await update()).content[0].text).toContain("already arrived");
  deliver("first", "changed metadata"); await update(); expect(h.statuses.at(-1)).toContain("waiting");
  deliver("second"); h.handlers.agent_settled({ aborted: false }, h.ctx); expect(h.sent).toHaveLength(2); h.start();
  deliver("second"); await update(); expect(h.statuses.at(-1)).toContain("waiting");
  deliver("third"); h.handlers.agent_settled({ aborted: false }, h.ctx); expect(h.sent).toHaveLength(3);
 });
 it("consumes grouped early completions independently through the real Subagents outbox", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const delivered: any[] = [];
  const outbox = new CompletionOutbox(message => { delivered.push(message); h.handlers.message_start({ message: { role: "custom", customType: "subagent-notification", details: message.details } }, h.ctx); }, () => true);
  const add = (id: string, executionId: string) => outbox.add({ ids: [id], build: () => ({ content: "same", details: { id, executionId, resultPreview: "same" } as any }) });
  try {
   add("a", "exec-a"); add("b", "exec-b"); outbox.onTurnEnd("stop");
   expect(delivered[0].details).toMatchObject({ id: "a", executionId: "exec-a", others: [{ id: "b", executionId: "exec-b" }] });
   const update = (ids: string[]) => h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ids }, undefined, undefined, h.ctx);
   expect((await update(["a", "b"])).content[0].text).toContain("already arrived");
   expect((await update(["b"])).content[0].text).toContain("already arrived");
   h.handlers.message_start({ message: { role: "custom", customType: "subagent-notification", details: delivered[0].details } }, h.ctx);
   await update(["b"]); expect(h.statuses.at(-1)).toContain("waiting");
  } finally { outbox.dispose(); }
 });
});

describe("exact Subagents waits", () => {
 const message = (details: any) => ({ role: "custom", customType: "subagent-notification", details });
 const update = (h: ReturnType<typeof fixture>, executions: { id: string; executionId: string }[]) => h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentExecutions: executions }, undefined, undefined, h.ctx);
 it("ignores an earlier unconsumed execution and wakes only for the requested pair", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  h.handlers.message_start({ message: message({ id: "a", executionId: "old" }) }, h.ctx);
  h.handlers.message_start({ message: message({ id: "b", executionId: "new" }) }, h.ctx);
  await update(h, [{ id: "a", executionId: "new" }]); expect(h.statuses.at(-1)).toContain("waiting");
  h.handlers.message_start({ message: message({ id: "a" }) }, h.ctx);
  h.handlers.agent_settled({ aborted: false }, h.ctx); expect(h.sent).toHaveLength(1);
  const result = h.handlers.before_agent_start({ messageType: "custom", message: message({ id: "a", executionId: "new" }) }, h.ctx);
  expect(result.message.content).toContain("objective"); expect(h.statuses.at(-1)).toContain("active");
 });
 it("consumes early grouped pairs individually and ignores duplicates across manual resume", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const grouped = message({ id: "a", executionId: "one", others: [{ id: "b", executionId: "two" }, { id: "a", executionId: "one" }] });
  h.handlers.message_start({ message: grouped }, h.ctx);
  expect((await update(h, [{ id: "b", executionId: "two" }])).content[0].text).toContain("already arrived");
  expect((await update(h, [{ id: "a", executionId: "one" }])).content[0].text).toContain("already arrived");
  await h.command("pause"); h.handlers.agent_settled({ aborted: true }, h.ctx); await h.command("resume"); h.start();
  h.handlers.message_start({ message: grouped }, h.ctx);
  await update(h, [{ id: "a", executionId: "one" }, { id: "b", executionId: "two" }]); expect(h.statuses.at(-1)).toContain("waiting");
 });
 it("rejects multiple target types and targets on non-waiting updates", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const execute = (params: any) => h.tools.goal_update.execute("", params, undefined, undefined, h.ctx);
  const pairs = [{ id: "a", executionId: "one" }];
  await expect(execute({ state: "waiting", reason: "x", subagentIds: ["a"], subagentExecutions: pairs })).rejects.toThrow(/one wake target/);
  await expect(execute({ state: "completed", reason: "x", subagentExecutions: pairs })).rejects.toThrow(/one wake target/);
 });
});

describe("paused completion retention", () => {
 const msg = (details: any) => ({ role: "custom", customType: "subagent-notification", details });
 const wait = (h: ReturnType<typeof fixture>, id: string, executionId: string) => h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentExecutions: [{ id, executionId }] }, undefined, undefined, h.ctx);
 it("retains unconsumed grouped completions and records arrivals without waking while paused", async () => {
  const h = fixture(); await h.command("objective"); h.start();
  const group = msg({ id: "a", executionId: "one", others: [{ id: "b", executionId: "two" }] });
  h.handlers.message_start({ message: group }, h.ctx);
  expect((await wait(h, "a", "one")).content[0].text).toContain("already arrived");
  await h.command("pause"); h.handlers.agent_settled({ aborted: true }, h.ctx);
  const paused = msg({ id: "c", executionId: "three" });
  expect(h.handlers.before_agent_start({ messageType: "custom", message: paused }, h.ctx)).toBeUndefined();
  h.handlers.message_start({ message: paused }, h.ctx);
  h.handlers.message_start({ message: group }, h.ctx);
  h.handlers.agent_settled({ aborted: false }, h.ctx);
  expect(h.sent).toHaveLength(1); expect(h.statuses.at(-1)).toContain("paused");
  await h.command("resume"); h.start();
  expect((await wait(h, "b", "two")).content[0].text).toContain("already arrived");
  expect((await wait(h, "c", "three")).content[0].text).toContain("already arrived");
  await wait(h, "a", "one"); expect(h.statuses.at(-1)).toContain("waiting");
 });
 it.each(["stop", "branch"])("clears retained completions on %s", async action => {
  const h = fixture(); await h.command("objective"); h.start();
  h.handlers.message_start({ message: msg({ id: "a", executionId: "one" }) }, h.ctx);
  await h.command("pause"); h.handlers.agent_settled({ aborted: true }, h.ctx);
  if (action === "stop") { await h.command("stop"); await h.command("replacement"); }
  else { h.handlers.session_tree({}, h.ctx); await h.command("resume"); }
  h.start(); await wait(h, "a", "one"); expect(h.statuses.at(-1)).toContain("waiting");
 });
});

describe("goal_update tool gating", () => {
 function activeFixture(branch: any[] = [], mode = "rpc") {
  let active = ["bash"];
  const sessionId = `goal-active-test-${++sequence}`;
  const handlers: Record<string, Function> = {}, commands: Record<string, any> = {}, tools: Record<string, any> = {}, statuses: (string | undefined)[] = [], sent: any[] = [];
  const ctx: any = { mode, sessionManager: { getBranch: () => branch, getSessionId: () => sessionId }, isIdle: () => true, hasPendingMessages: () => false, abort: () => {}, ui: { notify: () => {}, setStatus: (_: string, s: string | undefined) => statuses.push(s) } };
  goalExtension({ on: (n: string, f: Function) => { handlers[n] = f; }, registerCommand: (n: string, v: any) => { commands[n] = v; }, registerTool: (v: any) => { tools[v.name] = v; }, appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }), sendMessage: (m: any) => sent.push(m), getActiveTools: () => [...active], setActiveTools: (next: string[]) => { active = [...next]; } } as any);
  handlers.session_start({ reason: "startup" }, ctx);
  return { handlers, commands, tools, ctx, statuses, sent, active: () => active, resetActive: () => { active = ["bash"]; } };
 }

 it("activates on broken snapshot restore, wake notifications, and print mentions while preserving takeover pause", async () => {
  const broken = activeFixture([{ type: "custom", customType: "goal-state", data: null }]);
  expect(broken.tools.goal_update.defaultActive).toBe(false);
  expect(broken.active()).toEqual(["bash", "goal_update"]);

  const print = activeFixture([], "print");
  expect(print.active()).toEqual(["bash"]);
  for (const prompt of ["the goal is to fix X", "https://example.com/goal", "/goals"]) {
   print.handlers.before_agent_start({ messageType: "user", prompt }, print.ctx);
   expect(print.active()).toEqual(["bash"]);
  }
  print.handlers.before_agent_start({ messageType: "user", prompt: "explain /goal status" }, print.ctx);
  expect(print.active()).toEqual(["bash", "goal_update"]);

  const h = activeFixture();
  expect(h.active()).toEqual(["bash"]);
  await h.commands.goal.handler("finish work", h.ctx);
  expect(h.active()).toEqual(["bash", "goal_update"]);
  h.handlers.before_agent_start({ messageType: "custom", message: h.sent.at(-1) }, h.ctx);
  await h.tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentIds: ["w1"] }, undefined, undefined, h.ctx);
  h.handlers.agent_settled({ aborted: false }, h.ctx);
  h.resetActive();
  const woken = h.handlers.before_agent_start({ messageType: "custom", message: { customType: "subagent-notification", details: { id: "w1" } } }, h.ctx);
  expect(woken?.message.content).toContain("finish work");
  expect(h.active()).toEqual(["bash", "goal_update"]);

  // A user prompt mentioning goal_update activates the tool AND still pauses the active goal on takeover.
  h.resetActive();
  h.handlers.before_agent_start({ messageType: "user", prompt: "Why didn't you call goal_update?" }, h.ctx);
  expect(h.active()).toEqual(["bash", "goal_update"]);
  expect(h.statuses.at(-1)).toContain("paused");
 });
});
