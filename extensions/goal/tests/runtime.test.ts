import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import goalExtension from "../index.ts";

it("continues a real Pi run and finishes only on the model's goal tool", async () => {
 const directory = await mkdtemp(join(tmpdir(), "pi-goal-"));
 let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
 try {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ api: "goal-test-api", provider: "goal-test", models: [{ id: "test" }] });
  const resources = new DefaultResourceLoader({ cwd: directory, agentDir: directory, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => { pi.registerProvider(faux.provider); goalExtension(pi); }] });
  await resources.reload();
  ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model: faux.getModel("test")!, resourceLoader: resources, sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory({ defaultTools: [], retry: { enabled: false } }) }));
  const errors: unknown[] = []; await session.bindExtensions({ mode: "rpc", onError: error => errors.push(error) });
  const settled = new Promise<void>(resolve => session!.subscribe(event => { if (event.type === "agent_settled") resolve(); }));
  faux.setResponses([fauxAssistantMessage("Progress made."), fauxAssistantMessage([fauxToolCall("goal_update", { state: "completed", reason: "Finished after checking" })]), fauxAssistantMessage("Finished.")]);
  await session.prompt("/goal verify the result"); await settled;
  expect(faux.state.callCount).toBe(3);
  const entry = session.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "goal-state");
  expect(entry?.type === "custom" && entry.data).toMatchObject({ state: "completed", objective: "verify the result" });
  expect(errors).toEqual([]);
 } finally { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); } await rm(directory, { recursive: true, force: true }); }
}, 10000);
