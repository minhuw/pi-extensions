import { expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import selfdriveExtension, { runtime as selfdriveRuntime, timing } from "../../selfdrive/index.ts";
import { createGoalTestEnv } from "./support/session.ts";

it("coordinates real Goal and Selfdrive sessions at the activation boundary", async () => {
 const env = await createGoalTestEnv("pi-goal-boundary-");
 const oldAwake = selfdriveRuntime.keepAwake;
 const oldTiming = { ...timing };
 selfdriveRuntime.keepAwake = () => ({ kill() {} });
 timing.startMs = 60_000;
 const noop = () => {};
 const notes: string[] = [];
 const ui = { confirm: async () => true, notify: (message: string) => notes.push(message), setStatus: noop, setWidget: noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop } as unknown as ExtensionUIContext;
 try {
  async function start() {
   const { session, faux, errors } = await env.createSession({
    api: `goal-boundary-${env.sessionCount}`,
    extraExtensions: [selfdriveExtension],
    uiContext: ui,
   });
   faux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("ok")));
   const goal = () => session.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "goal-state");
   return { session, faux, errors, goal };
  }
  const a = await start();
  const b = await start();
  await a.session.prompt("/selfdrive on");
  await a.session.waitForIdle();
  await a.session.prompt("/goal blocked objective");
  expect(notes.at(-1)).toContain("Turn off Selfdrive before starting Goal");
  expect(a.goal()).toBeUndefined();
  await b.session.prompt("/goal independent objective");
  await b.session.waitForIdle();
  expect(b.goal()).toMatchObject({ data: { objective: "independent objective" } });
  await a.session.prompt("/selfdrive off");
  await a.session.waitForIdle();
  // Keep the Goal turn in flight until the Selfdrive activation aborts it.
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  a.faux.setResponses([(_context, options) => new Promise(resolve => { entered(); options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }); })]);
  await a.session.prompt("/goal active objective");
  await started;
  await a.session.prompt("/selfdrive on");
  await a.session.waitForIdle();
  expect(a.goal()).toMatchObject({ data: { state: "paused", objective: "active objective" } });
  // Selfdrive can turn itself off after an aborted run; explicitly turn it on to test resume refusal.
  await a.session.prompt("/selfdrive on");
  await a.session.waitForIdle();
  await a.session.prompt("/goal resume");
  expect(notes.at(-1)).toContain("Turn off Selfdrive before resuming Goal");
  await a.session.prompt("/selfdrive off");
  await a.session.waitForIdle();
  expect(a.goal()).toMatchObject({ data: { state: "paused" } });
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
 } finally {
  try {
   await env.dispose();
  } finally {
   selfdriveRuntime.keepAwake = oldAwake;
   Object.assign(timing, oldTiming);
  }
 }
}, 10000);
