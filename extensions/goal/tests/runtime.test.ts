import { expect, it } from "vitest";
import { getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createGoalTestEnv, nextSettled } from "./support/session.ts";

it("continues a real Pi run and finishes only on the model's goal tool", async () => {
 const env = await createGoalTestEnv("pi-goal-");
 try {
  const { faux, session, errors } = await env.createSession({ api: "goal-test" });
  const settled = nextSettled(session);
  faux.setResponses([fauxAssistantMessage("Progress made."), fauxAssistantMessage([fauxToolCall("goal_update", { state: "completed", reason: "Finished after checking" })]), fauxAssistantMessage("Finished.")]);
  await session.prompt("/goal verify the result"); await settled;
  expect(faux.state.callCount).toBe(3);
  const entry = session.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "goal-state");
  expect(entry?.type === "custom" && entry.data).toMatchObject({ state: "completed", objective: "verify the result" });
  expect(errors).toEqual([]);
 } finally { await env.dispose(); }
}, 10000);

it("registers goal_update with defaultActive: false and omits it on ordinary prompts including bare 'goal'", async () => {
 const env = await createGoalTestEnv("pi-goal-inactive-");
 try {
  const { faux, session, errors } = await env.createSession({ api: "goal-inactive", defaultTools: ["bash"] });

  expect(session.extensionRunner.getToolDefinition("goal_update")?.defaultActive).toBe(false);
  expect(session.getActiveToolNames()).toEqual(["bash"]);
  expect(session.getActiveToolNames()).not.toContain("goal_update");

  const requests: string[][] = [];
  const inspect = (message: AssistantMessage): FauxResponseFactory => context => {
   requests.push(getCurrentTools(context.messages).map(tool => tool.name));
   return message;
  };

  for (const prompt of ["Hello there", "Our goal is to speed up parsing"]) {
   faux.setResponses([inspect(fauxAssistantMessage("Understood."))]);
   const settled = nextSettled(session);
   await session.prompt(prompt);
   await settled;
  }

  expect(requests).toEqual([["bash"], ["bash"]]);
  expect(session.getActiveToolNames()).toEqual(["bash"]);
  expect(errors).toEqual([]);
 } finally {
  await env.dispose();
 }
}, 10000);

it("activates goal_update before Turn 1 when /goal <objective> starts", async () => {
 const env = await createGoalTestEnv("pi-goal-turn1-");
 try {
  const { faux, session, errors } = await env.createSession({ api: "goal-turn1", defaultTools: ["bash"] });
  expect(session.getActiveToolNames()).toEqual(["bash"]);

  const requests: string[][] = [];
  const inspect = (message: AssistantMessage): FauxResponseFactory => context => {
   requests.push(getCurrentTools(context.messages).map(tool => tool.name));
   return message;
  };

  faux.setResponses([
   inspect(fauxAssistantMessage([fauxToolCall("goal_update", { state: "completed", reason: "Completed on the first turn" })])),
   inspect(fauxAssistantMessage("All done.")),
  ]);
  const settled = nextSettled(session);
  await session.prompt("/goal finish on turn one");
  await settled;

  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(expect.arrayContaining(["bash", "goal_update"]));
  expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "goal_update"]));
  const entry = session.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "goal-state");
  expect(entry?.type === "custom" && entry.data).toMatchObject({ state: "completed", objective: "finish on turn one" });
  expect(errors).toEqual([]);
 } finally {
  await env.dispose();
 }
}, 10000);

it("activates goal_update on Turn 1 when explicitly mentioned in a prompt", async () => {
 const env = await createGoalTestEnv("pi-goal-mention-");
 try {
  const { faux, session, errors } = await env.createSession({ api: "goal-mention", defaultTools: ["bash"] });
  expect(session.getActiveToolNames()).toEqual(["bash"]);

  const requests: string[][] = [];
  faux.setResponses([context => {
   requests.push(getCurrentTools(context.messages).map(tool => tool.name));
   return fauxAssistantMessage("Inspected goal extension and goal_update.");
  }]);

  const settled = nextSettled(session);
  await session.prompt("Inspect @extensions/goal/ and goal_update");
  await settled;

  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual(expect.arrayContaining(["bash", "goal_update"]));
  expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "goal_update"]));
  expect(errors).toEqual([]);
 } finally {
  await env.dispose();
 }
}, 10000);

it("restores goal_update on reopen, reload, and tree navigation to a saved goal branch while leaving pre-goal leaves inactive", async () => {
 const env = await createGoalTestEnv("pi-goal-restore-");
 try {
  const errors: unknown[] = [];
  const manager = SessionManager.create(env.directory, env.directory);
  const first = await env.createSession({
   api: "goal-restore",
   sessionManager: manager,
   defaultTools: ["bash"],
   errors,
  });
  const { faux, session: firstSession } = first;

  // Pre-goal turn: transcript up to beforeGoalLeaf has only ["bash"].
  faux.setResponses([fauxAssistantMessage("Initial reply before any goal.")]);
  let settled = nextSettled(firstSession);
  await firstSession.prompt("Set up context");
  await settled;
  const beforeGoalLeaf = manager.getLeafId()!;
  expect(firstSession.getActiveToolNames()).toEqual(["bash"]);

  // Start a goal that reports blocked so the branch has a saved non-stopped goal-state entry.
  faux.setResponses([
   fauxAssistantMessage([fauxToolCall("goal_update", { state: "blocked", reason: "Need credentials" })]),
   fauxAssistantMessage("Blocked on credentials."),
  ]);
  settled = nextSettled(firstSession);
  await firstSession.prompt("/goal deploy staging");
  await settled;
  const goalLeaf = manager.getLeafId()!;
  const sessionFile = manager.getSessionFile()!;
  expect(sessionFile).toBeTruthy();

  await first.close();

  // Reopen saved session on the goal branch: goal_update is restored as active.
  const reopened = SessionManager.open(sessionFile, env.directory);
  const second = await env.createSession({
   faux,
   sessionManager: reopened,
   defaultTools: ["bash"],
   errors,
  });
  const reopenedSession = second.session;
  expect(reopenedSession.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "goal_update"]));

  // Deactivate manually and reload: restore(ctx) re-activates goal_update from the saved goal-state entry.
  reopenedSession.setActiveToolsByName(["bash"]);
  expect(reopenedSession.getActiveToolNames()).toEqual(["bash"]);
  await reopenedSession.reload();
  expect(reopenedSession.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "goal_update"]));

  // Navigate back to the earlier pre-goal leaf: goal_update becomes inactive and is omitted from requests.
  await reopenedSession.navigateTree(beforeGoalLeaf);
  expect(reopenedSession.getActiveToolNames()).toEqual(["bash"]);
  expect(reopenedSession.getActiveToolNames()).not.toContain("goal_update");

  const preGoalRequests: string[][] = [];
  faux.setResponses([context => {
   preGoalRequests.push(getCurrentTools(context.messages).map(tool => tool.name));
   return fauxAssistantMessage("Still pre-goal.");
  }]);
  settled = nextSettled(reopenedSession);
  await reopenedSession.prompt("Our goal is to speed up parsing");
  await settled;
  expect(preGoalRequests).toEqual([["bash"]]);
  expect(reopenedSession.getActiveToolNames()).toEqual(["bash"]);

  // Navigate back to the goal branch: goal_update is restored as active again.
  await reopenedSession.navigateTree(goalLeaf);
  expect(reopenedSession.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "goal_update"]));

  // Resume from blocked after manual deactivation: /goal resume activates goal_update before Turn 1.
  reopenedSession.setActiveToolsByName(["bash"]);
  const resumeRequests: string[][] = [];
  faux.setResponses([
   context => {
    resumeRequests.push(getCurrentTools(context.messages).map(tool => tool.name));
    return fauxAssistantMessage([fauxToolCall("goal_update", { state: "completed", reason: "Deployed after credentials arrived" })]);
   },
   fauxAssistantMessage("Deployment complete."),
  ]);
  settled = nextSettled(reopenedSession);
  await reopenedSession.prompt("/goal resume");
  await settled;
  expect(resumeRequests[0]).toEqual(expect.arrayContaining(["bash", "goal_update"]));

  // Branch from pre-goal leaf with a saved non-stopped goal-state entry and no goal_update in transcript:
  // proves restore(ctx) itself activates goal_update on both navigateTree and reopen, while stopped does not.
  await reopenedSession.navigateTree(beforeGoalLeaf);
  expect(reopenedSession.getActiveToolNames()).toEqual(["bash"]);
  const stoppedLeaf = reopened.appendCustomEntry("goal-state", {
   version: 1, objective: "cancelled objective", state: "stopped", budget: null, usage: 0, reason: "stop by user",
  });
  await reopenedSession.reload();
  expect(reopenedSession.getActiveToolNames()).toEqual(["bash"]);

  await reopenedSession.navigateTree(beforeGoalLeaf);
  const pausedSnapshotLeaf = reopened.appendCustomEntry("goal-state", {
   version: 1, objective: "saved objective", state: "paused", budget: null, usage: 0, reason: "paused by user",
  });
  await reopenedSession.navigateTree(stoppedLeaf);
  expect(reopenedSession.getActiveToolNames()).toEqual(["bash"]);
  await reopenedSession.navigateTree(pausedSnapshotLeaf);
  expect(reopenedSession.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "goal_update"]));

  await second.close();

  const thirdManager = SessionManager.open(sessionFile, env.directory);
  const third = await env.createSession({
   faux,
   sessionManager: thirdManager,
   defaultTools: ["bash"],
   bind: false,
   errors,
  });
  // Transcript at pausedSnapshotLeaf only ever declared ["bash"]; bindExtensions -> restore(ctx) activates goal_update.
  expect(third.session.getActiveToolNames()).toEqual(["bash"]);
  await third.bind();
  expect(third.session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "goal_update"]));
  expect(errors).toEqual([]);
 } finally {
  await env.dispose();
 }
}, 15000);
