import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunStore, type StoredPlanSpec } from "../../../src/daemon/run-store.ts";
import { EXECUTION_SCHEMA_VERSION } from "../../../src/daemon/execution-store.ts";
import { createVerificationRequest, normalizeVerificationManifest } from "../../../src/core/verification.ts";
import { sha256, stableJson, type ManagerAction } from "../../../src/shared/protocol.ts";

function fixture() {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-budget-"));
 const store = new RunStore(directory);
 const run = { runId: "run", repositoryRoot: directory, planDirectory: directory, planName: "budget", host: "pi" as const, profileName: "test", profileSha256: "a".repeat(64), maxParallel: 1, currentGeneration: 1, graphSha256: "b".repeat(64), status: "running" as const, checkoutStateToken: "token", baseCommit: "c".repeat(40), integrationBranch: "integration", integrationWorktree: directory };
 store.createRun(run);
 const spec: StoredPlanSpec = { runId: run.runId, graphGeneration: 1, planId: "001", planFingerprint: "f".repeat(64), fingerprintVersion: 2, ordinal: 0, title: "task", priority: "P1", effort: "S", kind: "code", dependencies: [], initialStatus: "TODO", initialStatusDetail: "", planFile: "001.md", assignment: { snapshotSha256: "s", snapshotInputs: [], plan: { id: "001", title: "task", kind: "code", parentObjective: null, dependencies: [], inScopePaths: ["src"] }, planText: "immutable" } };
 store.putPlanSpecs([spec]);
 const action = (id: string, generation = 1, round = 1, role: ManagerAction["role"] = "plan-implementer", planId = "001"): ManagerAction => ({ actionId: id, attemptId: id, runId: store.getRun()!.runId, planId, generation, round, role, agentType: "worker", model: "model", effort: "high", workerMode: "INITIAL", taskName: id, worktree: directory, branch: "task", assignmentPath: "assignment", assignmentSha256: "a".repeat(64), leaseReason: id, prompt: "work" });
 return { store, directory, run, spec, action, cleanup() { store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("three implementation rounds survive generations, cancellation, internal reset and transport is separate", () => {
 const f = fixture();
 try {
  f.store.grantBudget({ requestId: "retained", runId: "run", generation: 1, graphSha256: f.run.graphSha256, amount: 2 });
  for (let generation = 1; generation <= 3; generation++) {
   f.store.updateRun({ currentGeneration: generation });
   const action = f.action(`a${generation}`, generation);
   f.store.putAction(action); f.store.putAction(action);
   f.store.markCancelled(action.actionId, {});
  }
  assert.equal(f.store.getBudget("run")!.used, 3);
  assert.equal(f.store.reserveTransportRecovery("run", "001", "a1"), true);
  assert.equal(f.store.reserveTransportRecovery("run", "001", "a1"), true);
  assert.equal(f.store.reserveTransportRecovery("run", "001", "a2"), false);
  f.store.updateRun({ currentGeneration: 4 });
  assert.throws(() => f.store.transaction(() => f.store.putAction(f.action("four", 4))), /implementation budget exhausted/);
  assert.equal(f.store.getRun()!.status, "paused");
  f.store.updateRun({ status: "running", terminalDetail: null });
  assert.equal(f.store.getRun()!.status, "paused");
  assert.equal(f.store.getAction("four"), null);
  const tables = ["manager_budgets", "manager_task_budgets", "manager_budget_ledger", "manager_budget_grants"];
  const accounting = () => tables.map(table => f.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = accounting();
  f.store.resetExecutionState();
  assert.deepEqual(accounting(), before);
  f.store.createRun({ ...f.run, runId: "successor" });
  f.store.putPlanSpecs([{ ...f.spec, runId: "successor" }]);
  assert.equal(f.store.getBudget("successor")!.used, 3);
  assert.equal(f.store.getBudget("successor")!.limit, 23);
  assert.ok(f.store.getBudget("successor")!.stopReason);
  assert.equal(f.store.reserveTransportRecovery("successor", "001", "new"), false);
  assert.throws(() => f.store.putAction(f.action("after-reset")), /implementation budget exhausted/);
 } finally { f.cleanup(); }
});

test("explicit reset clears allocations, usage, stops and grants; next run seals a fresh baseline", () => {
 const f = fixture();
 try {
  f.store.grantBudget({ requestId: "grant", runId: "run", generation: 1, graphSha256: f.run.graphSha256, amount: 5, planId: "001", implementationRounds: 1, infrastructureRecoveries: 1 });
  for (let i = 0; i < 4; i++) f.store.putAction(f.action(`old${i}`));
  assert.equal(f.store.reserveTransportRecovery("run", "001", "old0"), true);
  assert.equal(f.store.reserveTransportRecovery("run", "001", "old1"), true);
  assert.throws(() => f.store.putAction(f.action("exhausted")), /implementation budget exhausted/);
  const before = f.store.getBudget("run")!;
  assert.equal(before.limit, 26);
  assert.equal(before.used, 4);
  assert.ok(before.stopReason);
  // Clearing accounting participates in the same execution reset transaction.
  assert.throws(() => f.store.transaction(() => {
   f.store.resetExecutionState({ clearBudgets: true });
   throw new Error("rollback reset");
  }), /rollback reset/);
  assert.deepEqual(f.store.getBudget("run"), before);
  assert.ok(f.store.getRun());
  f.store.resetExecutionState({ clearBudgets: true });
  for (const table of ["manager_budgets", "manager_task_budgets", "manager_budget_ledger", "manager_budget_grants"]) {
   assert.equal(f.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 0, table);
  }
  assert.equal(f.store.getBudget("run"), null);
  const run = { ...f.run, runId: "fresh", currentGeneration: 2, graphSha256: "d".repeat(64) };
  f.store.createRun(run);
  const specs = ["001", "002"].map((planId, ordinal) => ({ ...f.spec, runId: run.runId, graphGeneration: 2, planId, ordinal }));
  f.store.putPlanSpecs(specs);
  assert.deepEqual(f.store.getBudget("fresh"), {
   runId: "fresh", baselineGeneration: 2, baselineGraphSha256: run.graphSha256,
   baselineSpecsJson: stableJson(f.store.getPlanSpecs("fresh")), generation: 2,
   graphSha256: run.graphSha256, limit: 30, used: 0, stopReason: null,
  });
  for (const planId of ["001", "002"]) {
   const allocation = f.store.database.prepare("SELECT round_limit, recovery_limit FROM manager_task_budgets WHERE run_id = ? AND plan_id = ?").get("fresh", planId)!;
   assert.equal(allocation.round_limit, 3);
   assert.equal(allocation.recovery_limit, 1);
  }
  for (let i = 0; i < 3; i++) f.store.putAction(f.action(`new${i}`, 2));
  assert.throws(() => f.store.putAction(f.action("fourth", 2)), /implementation budget exhausted/);
  assert.equal(f.store.reserveTransportRecovery("fresh", "001", "new0"), true);
  assert.equal(f.store.reserveTransportRecovery("fresh", "001", "new1"), false);
  // A previous grant ID no longer carries replay authority into the fresh run.
  f.store.grantBudget({ requestId: "grant", runId: "fresh", generation: 2, graphSha256: run.graphSha256, amount: 1 });
  assert.equal(f.store.getBudget("fresh")!.limit, 31);
 } finally { f.cleanup(); }
});

test("all roles, verification and repair share finite ledger; grant identity and replay are atomic", () => {
 const f = fixture();
 try {
  const limit = f.store.getBudget("run")!.limit;
  for (let i = 0; i < limit - 2; i++) f.store.putAction(f.action(`review${i}`, 1, 1, i % 2 ? "plan-reviewer" : "plan-judge"));
  const verification = { runId: "run", generation: 1, reservationId: "verification:v", kind: "verification", payloadSha256: "v" };
  f.store.reserveBudget(verification); f.store.reserveBudget(verification);
  f.store.reserveBudget({ ...verification, reservationId: "repair:r", kind: "repair", payloadSha256: "r" });
  assert.equal(f.store.getBudget("run")!.used, limit);
  assert.throws(() => f.store.putAction(f.action("final", 1, 1, "plan-reviewer", "RUN")), /Run execution budget exhausted/);
  const grant = { requestId: "grant", runId: "run", generation: 1, graphSha256: f.run.graphSha256, amount: 2 };
  assert.throws(() => f.store.grantBudget({ ...grant, generation: 2 }), /stale/);
  f.store.grantBudget(grant); f.store.grantBudget(grant);
  assert.equal(f.store.getBudget("run")!.limit, limit + 2);
  assert.throws(() => f.store.grantBudget({ ...grant, amount: 3 }), /different evidence/);
  f.store.putAction(f.action("final", 1, 1, "plan-reviewer", "RUN"));
 } finally { f.cleanup(); }
});

test("failed admission and durable stop share one outer commit, including caller rollback", () => {
 const f = fixture();
 try {
  const limit = f.store.getBudget("run")!.limit;
  for (let i = 0; i < limit; i++) f.store.putAction(f.action(`reserved${i}`, 1, 1, "plan-reviewer"));
  const commands: string[] = [];
  const exec = f.store.database.exec.bind(f.store.database);
  f.store.database.exec = (sql: string) => { commands.push(sql); exec(sql); };
  assert.throws(() => f.store.transaction(() => {
   f.store.updateRun({ dashboardUrl: "must-be-rolled-back" });
   f.store.putAction(f.action("over-budget", 1, 1, "plan-reviewer"));
  }), /budget exhausted/);
  assert.equal(f.store.getRun()!.dashboardUrl, null);
  assert.equal(f.store.getRun()!.status, "paused");
  assert.ok(f.store.getBudget("run")!.stopReason);
  assert.equal(f.store.getAction("over-budget"), null);
  assert.equal(commands.filter(sql => sql === "BEGIN IMMEDIATE").length, 1);
  assert.equal(commands.filter(sql => sql === "COMMIT").length, 1);
  assert.equal(commands.includes("ROLLBACK"), false, "no rollback-to-second-transaction crash window");
  assert.throws(() => f.store.markDispatched("reserved0", "stale-host"), /budget|exhausted/i);
 } finally { f.cleanup(); }
});

test("graph additions and renamed tasks get zero allocation, explicit task grant does not silently restore recovery", () => {
 const f = fixture();
 try {
  f.store.updateRun({ currentGeneration: 2, graphSha256: "d".repeat(64) });
  f.store.putPlanSpecs([{ ...f.spec, graphGeneration: 2, planId: "renamed" }]);
  assert.equal(f.store.getBudget("run")!.limit, 9 * 1 + 12);
  assert.equal(f.store.getBudget("run")!.baselineGraphSha256, f.run.graphSha256);
  assert.throws(() => f.store.putAction(f.action("renamed", 2, 1, "plan-implementer", "renamed")), /no implementation allocation/);
  f.store.grantBudget({ requestId: "task-grant", runId: "run", generation: 2, graphSha256: "d".repeat(64), amount: 1, planId: "renamed", implementationRounds: 1 });
  f.store.putAction(f.action("renamed", 2, 1, "plan-implementer", "renamed"));
  assert.equal(f.store.reserveTransportRecovery("run", "renamed", "renamed"), false);
 } finally { f.cleanup(); }
});

function verification(f: ReturnType<typeof fixture>, requestId = "verification") {
 const run = f.store.getRun()!;
 const request = createVerificationRequest({ requestId, runId: run.runId, generation: run.currentGeneration, graphSha256: run.graphSha256, runAssignmentPath: "assignment", runAssignmentSha256: "a".repeat(64), integrationBranch: run.integrationBranch, integrationWorktree: run.integrationWorktree, integrationHead: run.baseCommit, integrationTree: "d".repeat(40), requestedAt: new Date().toISOString() });
 const { manifest, manifestSha256 } = normalizeVerificationManifest(request, { ...request, rationale: "Bounded test", gates: [{ gateId: "test", label: "test", cwd: ".", argv: ["node", "--version"], rationale: "test" }] });
 f.store.putVerificationRequest(request);
 return { request, manifest, manifestSha256 };
}

test("verification admission is atomic, charged once and fails closed before gate execution", () => {
 const f = fixture();
 try {
  const { request, manifest, manifestSha256 } = verification(f);
  const limit = f.store.getBudget("run")!.limit;
  for (let i = 0; i < limit; i++) f.store.putAction(f.action(`review${i}`, 1, 1, "plan-reviewer"));
  assert.throws(() => f.store.transaction(() => f.store.startVerification(request.requestId, manifest, manifestSha256)), /Run execution budget exhausted/);
  assert.equal(f.store.getVerificationByRequestId(request.requestId)!.state, "awaiting_manifest");
  assert.equal(f.store.getRun()!.status, "paused");
  f.store.grantBudget({ requestId: "verify-grant", runId: "run", generation: 1, graphSha256: f.run.graphSha256, amount: 1 });
  f.store.startVerification(request.requestId, manifest, manifestSha256);
  f.store.startVerification(request.requestId, manifest, manifestSha256);
  assert.equal(f.store.getBudget("run")!.used, limit + 1);
 } finally { f.cleanup(); }
});

test("schema19 additive migration preserves current graph and reservations and pauses before dispatch", () => {
 const f = fixture();
 try {
  f.store.putAction(f.action("old"));
  const { request, manifest, manifestSha256 } = verification(f);
  f.store.startVerification(request.requestId, manifest, manifestSha256);
  f.store.finishVerification(request.requestId, "failed", {}, "failed gate");
  const repair = f.store.recordInitialIntegrationRepairFailure(f.store.getVerificationByRequestId(request.requestId)!, "failed gate");
  f.store.recordIntegrationRepairAudit(repair.repairId, "historical-begin", "begin", "a".repeat(64), {});
  f.store.updateRun({ currentGeneration: 2, graphSha256: "d".repeat(64) });
  f.store.putPlanSpecs([{ ...f.spec, graphGeneration: 2, planId: "current" }]);
  // Synthetic schema19 fixture: strip only the additive tables from a fresh test DB.
  f.store.database.exec("DROP TABLE manager_budgets; DROP TABLE manager_task_budgets; DROP TABLE manager_budget_ledger; DROP TABLE manager_budget_grants; PRAGMA user_version = 19");
  const migrated = new RunStore(f.directory);
  try {
   assert.equal((migrated.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, EXECUTION_SCHEMA_VERSION);
   assert.equal(migrated.getRun()!.status, "paused");
   assert.equal(migrated.getBudget("run")!.used, 3);
   assert.equal(migrated.getBudget("run")!.limit, 8 * 1 + 12);
   assert.equal(migrated.getBudget("run")!.baselineGeneration, 2);
   assert.match(migrated.getBudget("run")!.baselineSpecsJson, /current/);
   assert.equal(migrated.getAction("old")!.actionId, "old");
   assert.throws(() => migrated.markDispatched("old", "host"), /migration requires explicit host/);
   migrated.updateRun({ status: "running" });
   assert.equal(migrated.getRun()!.status, "paused");
   assert.throws(() => migrated.putAction(f.action("new", 2, 1, "plan-implementer", "current")), /migration requires explicit host/);
  } finally { migrated.close(); }
 } finally { f.cleanup(); }
});

test("same-round attempts are charged; one durable transport retry and one explicit grant cannot be reused", () => {
 const f = fixture();
 try {
  for (let i = 1; i <= 3; i++) f.store.putAction(f.action(`attempt${i}`, 1, 3));
  assert.equal(f.store.reserveTransportRecovery("run", "001", "attempt3"), true);
  const retry = f.action("safe-retry", 1, 3);
  f.store.putAction(retry);
  const reservation = { runId: "run", generation: 1, reservationId: "action:safe-retry", kind: "action:plan-implementer", planId: "001", round: 3, payloadSha256: sha256(stableJson(retry)) };
  f.store.reserveBudget(reservation);
  assert.throws(() => f.store.reserveBudget({ ...reservation, payloadSha256: "changed" }), /different evidence/);
  assert.throws(() => f.store.reserveBudget({ ...reservation, runId: "other" }), /stale/);
  assert.equal(f.store.getBudget("run")!.used, 4);
  assert.equal(f.store.reserveTransportRecovery("run", "001", "safe-retry"), false);
  assert.throws(() => f.store.putAction(f.action("fourth", 1, 3)), /implementation budget exhausted/);
  const graph = f.store.getPlanSpecs("run");
  f.store.grantBudget({ requestId: "one-more", runId: "run", generation: 1, graphSha256: f.run.graphSha256, amount: 1, planId: "001", implementationRounds: 1 });
  f.store.putAction(f.action("fourth", 1, 3));
  assert.equal(f.store.getBudget("run")!.used, 5);
  assert.throws(() => f.store.putAction(f.action("fifth", 1, 3)), /implementation budget exhausted/);
  assert.equal(f.store.getRun()!.currentGeneration, 1);
  assert.deepEqual(f.store.getPlanSpecs("run"), graph);
 } finally { f.cleanup(); }
});

test("transport exemption requires the immediately prior implementation with matching generation and round", () => {
 for (const mismatch of ["predecessor", "generation", "round"]) {
  const f = fixture();
  try {
   f.store.putAction(f.action("old"));
   f.store.reserveTransportRecovery("run", "001", "old");
   if (mismatch === "generation") f.store.updateRun({ currentGeneration: 2 });
   const generation = mismatch === "generation" ? 2 : 1;
   const round = mismatch === "round" ? 2 : 1;
   if (mismatch === "predecessor") f.store.putAction(f.action("intervening", 1, 2));
   for (let i = mismatch === "predecessor" ? 2 : 1; i < 3; i++) f.store.putAction(f.action(`charged${i}`, generation, round));
   assert.throws(() => f.store.putAction(f.action("excess", generation, round)), /implementation budget exhausted/);
   assert.equal(f.store.getBudget("run")!.used, 3);
  } finally { f.cleanup(); }
 }
});

test("safe transport still consumes run allocation and cannot bypass a run stop", () => {
 const f = fixture();
 try {
  const limit = f.store.getBudget("run")!.limit;
  for (let i = 0; i < limit - 3; i++) f.store.putAction(f.action(`review${i}`, 1, 1, "plan-reviewer"));
  for (let i = 0; i < 3; i++) f.store.putAction(f.action(`implement${i}`, 1, 3));
  assert.equal(f.store.reserveTransportRecovery("run", "001", "implement2"), true);
  assert.throws(() => f.store.putAction(f.action("transport-retry", 1, 3)), /Run execution budget exhausted/);
  f.store.grantBudget({ requestId: "run-only", runId: "run", generation: 1, graphSha256: f.run.graphSha256, amount: 1 });
  f.store.putAction(f.action("transport-retry", 1, 3));
  assert.equal(f.store.getBudget("run")!.used, limit + 1);
 } finally { f.cleanup(); }
});
