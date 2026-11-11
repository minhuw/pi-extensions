import { afterEach, expect, it, vi } from "vitest";
import type * as Runner from "../../subagents/src/agent-runner.js";

vi.mock("../../subagents/src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof Runner>("../../subagents/src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { runAgent, resumeAgent } from "../../subagents/src/agent-runner.js";
import subagents from "../../subagents/src/index.js";
import { ctx, hermeticDir, makePi, type Hermetic, type BootedPi } from "../../subagents/test/helpers/boot-extension.js";
import goal from "../index.ts";

let producer: BootedPi | undefined;
let hermetic: Hermetic | undefined;
afterEach(async () => {
  await producer?.lifecycle.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  delete (globalThis as any)[Symbol.for("pi-subagents:host")];
  hermetic?.restore();
  producer = undefined;
  hermetic = undefined;
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("wakes once per execution across real grouped and resumed subagent notifications", async () => {
  vi.useFakeTimers();
  hermetic = hermeticDir({ settings: { outputTranscript: false, schedulingEnabled: false } });
  producer = makePi();
  subagents(producer.pi);
  const parent = ctx();
  Object.defineProperty(parent, "signal", { get: () => new AbortController().signal });
  await producer.lifecycle.get("session_start")({ type: "session_start" }, parent);

  const finishers = new Map<string, () => void>();
  vi.mocked(runAgent).mockImplementation((_c: any, _t: any, prompt: any) => new Promise<any>(resolve => {
    finishers.set(prompt, () => resolve({ responseText: "same result", session: { dispose: vi.fn(), messages: [] }, aborted: false, steered: false }));
  }) as any);
  vi.mocked(resumeAgent).mockImplementation((_s: any, prompt: string) => new Promise(resolve => {
    finishers.set(prompt, () => resolve({ text: "same result", aborted: false, steered: false }));
  }));
  const spawn = (prompt: string, resume?: string) => producer!.tools.get("Agent").execute(
    `call-${prompt}`, { prompt, description: prompt, subagent_type: "worker", run_in_background: true, ...(resume ? { resume } : {}) }, undefined, undefined, parent,
  );
  const sibling = await spawn("sibling");
  const target = await spawn("target");
  const id = /Agent ID: (\S+)/.exec(target.content[0].text)![1];
  const siblingId = /Agent ID: (\S+)/.exec(sibling.content[0].text)![1];

  const handlers: Record<string, Function> = {}, commands: Record<string, any> = {}, tools: Record<string, any> = {};
  const branch: any[] = [], sent: any[] = [], statuses: string[] = [];
  const goalCtx: any = { mode: "rpc", sessionManager: { getBranch: () => branch, getSessionId: () => "boundary" }, isIdle: () => true, hasPendingMessages: () => false, abort: () => {}, ui: { notify: () => {}, setStatus: (_: string, s: string) => statuses.push(s) } };
  goal({ on: (n: string, f: Function) => { handlers[n] = f; }, registerCommand: (n: string, c: any) => { commands[n] = c; }, registerTool: (t: any) => { tools[t.name] = t; }, appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }), sendMessage: (m: any) => sent.push(m) } as any);
  handlers.session_start({ reason: "startup" }, goalCtx);
  await commands.goal.handler("objective", goalCtx);
  const start = () => handlers.before_agent_start({ messageType: "custom", message: sent.at(-1) }, goalCtx);
  const wait = (agentId: string, executionId: string) => tools.goal_update.execute("", { state: "waiting", reason: "waiting", subagentExecutions: [{ id: agentId, executionId }] }, undefined, undefined, goalCtx);
  const deliver = (message: any) => handlers.message_start({ message: { role: "custom", ...message } }, goalCtx);
  const settle = () => handlers.agent_settled({ aborted: false }, goalCtx);
  const flushProducer = () => producer!.lifecycle.get("turn_end")?.({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" } });
  start();
  const siblingExecution = sibling.details.executionId;
  expect(siblingExecution).toEqual(expect.any(String));
  await wait(siblingId, siblingExecution);
  settle();

  finishers.get("sibling")!();
  finishers.get("target")!();
  await vi.advanceTimersByTimeAsync(0);
  flushProducer();
  const first = producer.pi.sendMessage.mock.calls[0][0];
  expect(first.details.id).toBe(siblingId);
  expect(first.details.others[0].id).toBe(id);
  const firstExecution = first.details.others[0].executionId;
  expect(firstExecution).toEqual(expect.any(String));
  deliver(first);
  settle();
  expect(sent).toHaveLength(2);
  start();
  const resumed = await spawn("target", id);
  const resumedExecution = resumed.details.executionId;
  expect(resumedExecution).toEqual(expect.any(String));
  expect(resumedExecution).not.toBe(firstExecution);
  await wait(id, resumedExecution);
  deliver(first);
  settle();
  expect(sent).toHaveLength(2);
  expect(statuses.at(-1)).toContain("waiting");

  finishers.get("target")!();
  await vi.advanceTimersByTimeAsync(0);
  flushProducer();
  const second = producer.pi.sendMessage.mock.calls[1][0];
  expect(second.details.id).toBe(id);
  const { executionId: _firstId, ...firstDetails } = first.details.others[0];
  const { executionId: _secondId, ...secondDetails } = second.details;
  expect(secondDetails).toEqual(firstDetails);
  expect(second.details.executionId).toBe(resumedExecution);
  deliver(second);
  settle();
  expect(sent).toHaveLength(3);
  start();
  await wait(id, resumedExecution);
  deliver(second);
  settle();
  expect(sent).toHaveLength(3);
  expect(statuses.at(-1)).toContain("waiting");
});
