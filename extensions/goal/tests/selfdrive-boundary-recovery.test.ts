import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../index.ts";
import selfdriveExtension, { runtime as selfdriveRuntime, timing } from "../../selfdrive/index.ts";

it("coordinates real Goal and Selfdrive sessions at the activation boundary", async () => {
 const directory = await mkdtemp(join(tmpdir(), "pi-goal-boundary-"));
 const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
 const oldAwake = selfdriveRuntime.keepAwake;
 const oldTiming = { ...timing };
 selfdriveRuntime.keepAwake = () => ({ kill() {} });
 timing.startMs = 60_000;
 const noop = () => {};
 const notes: string[] = [];
 const ui = { confirm: async () => true, notify: (message: string) => notes.push(message), setStatus: noop, setWidget: noop, setWorkingMessage: noop, setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop } as unknown as ExtensionUIContext;
 try {
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  async function start() {
   const faux = fauxProvider({ api: `goal-boundary-${sessions.length}`, provider: `goal-boundary-${sessions.length}`, models: [{ id: "test" }] });
   faux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("ok")));
   const resources = new DefaultResourceLoader({ cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => pi.registerProvider(faux.provider), goalExtension, selfdriveExtension] });
   await resources.reload();
   const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model: faux.getModel("test")!, resourceLoader: resources, sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false } }) });
   sessions.push(session);
   const errors: unknown[] = [];
   await session.bindExtensions({ mode: "rpc", uiContext: ui, onError: error => errors.push(error) });
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
  for (const session of sessions) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
  selfdriveRuntime.keepAwake = oldAwake;
  Object.assign(timing, oldTiming);
  await rm(directory, { recursive: true, force: true });
 }
}, 10000);
