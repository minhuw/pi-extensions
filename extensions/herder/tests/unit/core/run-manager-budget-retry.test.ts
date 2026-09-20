import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { grantHostAttention } from "../../../src/core/run-revision.ts";
import { attentionResolutionFromRequest } from "../../../adapters/attention.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";
import type { ManagerAction } from "../../../src/shared/protocol.ts";

test("host grant and additional budget cannot invent a repair list after unreviewed implementation failures", async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-budget-retry-"));
 const { repo, originalHead } = initFixtureRepo(root, { name: "Budget retry", email: "test@example.invalid", files: { "src/value.mjs": "export const value = 1;\n" } });
 const directory = path.join(repo, "herder-plans");
 initPlanDir(directory);
 fs.writeFileSync(path.join(directory, "README.md"), "# Plans\n\n## Execution order & status\n\n| Plan | Title | Priority | Effort | Depends on | Status |\n|---|---|---|---|---|---|\n| [001](001-value.md) | Value | P1 | S | — | TODO |\n\n## Dependency notes\n\nNone.\n\n## Considered and rejected\n\nNone.\n");
 fs.writeFileSync(path.join(directory, "001-value.md"), fixturePlan({ id: "001", title: "Value", head: originalHead }));
 const manager = new HerderRunManager(directory);
 try {
  let reply = await manager.start({ mode: "fire", repositoryRoot: repo, planDirectory: directory, profile: "eclipse", maxParallel: 1 });
  async function fail(action: ManagerAction) {
   await manager.event({ eventId: `dispatch:${action.actionId}`, kind: "dispatch_results", dispatchResults: [{ actionId: action.actionId, accepted: true, hostHandle: action.actionId }] });
   return manager.event({ eventId: `terminal:${action.actionId}`, kind: "terminals", terminals: [{ actionId: action.actionId, hostHandle: action.actionId, response: "STATUS: FAILED\nCOMMITS: none\nCHECKS: none\nFILES CHANGED: none\nDISCOVERED_PATHS: none\nNOTES: bounded product failure" }] });
  }
  for (let round = 1; round <= 3; round++) {
   assert.equal(reply.actions[0].round, round);
   reply = await fail(reply.actions[0]);
  }
  const store = manager.store;
  const run = store.getRun()!;
  const before = store.getPlan(run.runId, "001")!;
  const specs = store.getPlanSpecs(run.runId);
  const request = store.getNextAttention(run.runId)!;
  assert.equal(request.kind, "plan_recovery");
  assert.equal(request.cause, "implementer_exhausted");
  assert.equal(before.phase, "BLOCKED");
  const resolution = { ...attentionResolutionFromRequest(request), action: "retry", rationale: "Retry the approved implementation without changing its contract." };
  await assert.rejects(manager.event({ eventId: "unapproved", kind: "attention", attention: resolution }), /host grant/);
  store.grantBudget({ requestId: "one-extra-attempt", runId: run.runId, generation: run.currentGeneration, graphSha256: run.graphSha256, amount: 1, planId: "001", implementationRounds: 1 });
  grantHostAttention(run, resolution);
  await assert.rejects(manager.event({ eventId: "approved", kind: "attention", attention: resolution }), /bounded Judge REPAIR list/);
  assert.equal(store.getPlan(run.runId, "001")!.phase, "BLOCKED");
  assert.deepEqual(store.getPlanSpecs(run.runId), specs);
  assert.equal(store.getRun()!.graphSha256, run.graphSha256);
  assert.equal(store.getBudget(run.runId)!.used, 3);
  assert.equal(store.getNextAttention(run.runId)!.requestId, request.requestId);
 } finally { manager.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
