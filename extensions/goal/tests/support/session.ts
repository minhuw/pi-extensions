// Shared Pi AgentSession test harness for Goal extension runtime suites.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import {
 createAgentSession,
 DefaultResourceLoader,
 ModelRuntime,
 SessionManager,
 SettingsManager,
 type AgentSession,
 type ExtensionFactory,
 type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import goalExtension from "../../index.ts";

export interface GoalSessionOptions {
 api?: string;
 faux?: FauxProviderHandle;
 sessionManager?: SessionManager;
 defaultTools?: string[];
 extraExtensions?: ExtensionFactory[];
 bind?: boolean;
 uiContext?: ExtensionUIContext;
 errors?: unknown[];
}

export interface GoalSessionHandle {
 session: AgentSession;
 faux: FauxProviderHandle;
 errors: unknown[];
 bind(): Promise<void>;
 close(): Promise<void>;
}

export interface GoalTestEnv {
 readonly directory: string;
 readonly modelRuntime: ModelRuntime;
 readonly sessionCount: number;
 createSession(options?: GoalSessionOptions): Promise<GoalSessionHandle>;
 dispose(): Promise<void>;
}

async function shutdownSession(session: AgentSession): Promise<void> {
 await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
 session.dispose();
}

/** Creates an isolated temp directory, shared ModelRuntime, and tracked Goal Pi sessions with cleanup. */
export async function createGoalTestEnv(prefix = "pi-goal-"): Promise<GoalTestEnv> {
 const directory = await mkdtemp(join(tmpdir(), prefix));
 const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
 });
 const activeSessions = new Set<AgentSession>();
 let createdCount = 0;

 return {
  directory,
  modelRuntime,
  get sessionCount() {
   return createdCount;
  },
  async createSession(options: GoalSessionOptions = {}): Promise<GoalSessionHandle> {
   const api = options.api ?? `goal-test-${createdCount}`;
   const faux = options.faux ?? fauxProvider({ api, provider: api, models: [{ id: "test" }] });
   const resources = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
     pi => { pi.registerProvider(faux.provider); },
     goalExtension,
     ...(options.extraExtensions ?? []),
    ],
   });
   await resources.reload();
   expect(resources.getExtensions().errors).toEqual([]);

   const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    modelRuntime,
    model: faux.getModel("test")!,
    resourceLoader: resources,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(directory),
    settingsManager: SettingsManager.inMemory({
     defaultTools: options.defaultTools ?? [],
     retry: { enabled: false },
    }),
   });
   createdCount++;
   activeSessions.add(session);

   const errors = options.errors ?? [];
   const bind = async () => {
    await session.bindExtensions({
     mode: "rpc",
     ...(options.uiContext ? { uiContext: options.uiContext } : {}),
     onError: error => { errors.push(error); },
    });
   };
   if (options.bind !== false) await bind();

   let closed = false;
   const close = async () => {
    if (closed) return;
    closed = true;
    activeSessions.delete(session);
    await shutdownSession(session);
   };

   return { session, faux, errors, bind, close };
  },
  async dispose() {
   let firstError: unknown;
   for (const session of Array.from(activeSessions)) {
    activeSessions.delete(session);
    try {
     await shutdownSession(session);
    } catch (error) {
     firstError ??= error;
    }
   }
   await rm(directory, { recursive: true, force: true });
   if (firstError !== undefined) throw firstError;
  },
 };
}

export function nextSettled(session: AgentSession): Promise<void> {
 return new Promise<void>(resolve => {
  const unsubscribe = session.subscribe(event => {
   if (event.type === "agent_settled") {
    unsubscribe();
    resolve();
   }
  });
 });
}
