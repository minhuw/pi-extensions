import fs from "node:fs";
import path from "node:path";
import { buildGraph, projectStatuses } from "../../core/plans.ts";
import { RunStore, type StoredPlanSpec } from "../run-store.ts";
import { clearExecutionRotationMarker } from "../execution-store.ts";
import { listHerderBranches, listWorktreeInventory, type WorktreeRecord } from "./namespace-inventory.ts";
import { listCoordinationRefs, validatePlanName } from "./coordination-ref.ts";
import { allowedWorktreePaths, worktreeRelativeName } from "./worktree-locations.ts";
import { fail, isInside, realpathIfPresent, runGit } from "./primitives.ts";

export interface HerderResetInput { repoRoot: string; planDirectory: string }
export interface HerderResetResult { planName: string; removedBranches: string[]; removedWorktrees: string[]; removedRefs: string[]; resetPlans: string[] }
type Worktree = WorktreeRecord;

function target(repo: string, ref: string): string | null { const r = runGit(repo, ["rev-parse", "--verify", ref], { allowFailure: true }); return r.status === 0 ? r.stdout.trim() : null; }
function ancestor(repo: string, a: string, b: string): boolean { const r = runGit(repo, ["merge-base", "--is-ancestor", a, b], { allowFailure: true }); const status = r.status ?? 1; if (status === 0) return true; if (status === 1) return false; fail(`Cannot compare Git ancestry: ${(r.stderr || r.stdout).trim()}`); }
function checkout(repo: string): { branch: string | null; head: string | null } { const b = runGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }); const h = runGit(repo, ["rev-parse", "--verify", "HEAD"], { allowFailure: true }); return { branch: b.status === 0 ? b.stdout.trim() : null, head: h.status === 0 ? h.stdout.trim() : null }; }
function snapshot<T>(items: T[]): string { return JSON.stringify(items); }
function cleanWorktree(repo: string, item: Worktree): void {
  if (!fs.existsSync(item.path)) fail(`Herder reset cannot remove missing worktree: ${item.path}`);
  if (realpathIfPresent(item.path) === realpathIfPresent(repo)) fail("Herder reset cannot remove the user checkout.");
  const status = runGit(item.path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.stdout !== "") fail(`Herder reset cannot remove dirty worktree: ${item.path}`);
}
function deleteRef(repo: string, ref: string, expected: string): void { const current = target(repo, ref); if (current !== expected) fail(`Herder reset found moved ref ${ref}; expected ${expected}, found ${current ?? "missing"}`); if (runGit(repo, ["update-ref", "-d", ref, expected], { allowFailure: true }).status !== 0) fail(`Herder reset could not delete moved ref ${ref}`); }
function deleteBranch(repo: string, branch: string, expected: string): void { deleteRef(repo, `refs/heads/${branch}`, expected); }
function validateSpecs(planDir: string): { graph: ReturnType<typeof buildGraph>; specs: StoredPlanSpec[]; run: ReturnType<RunStore["getRun"]> } {
  const graph = buildGraph(planDir);
  let store: RunStore;
  try { store = new RunStore(planDir, { readOnly: true }); } catch { fail("Herder reset requires an intact initialized execution database."); }
  try {
    const run = store.getRun(); if (!run) fail("Herder reset requires an initialized Herder run.");
    const specs = store.getPlanSpecs(run.runId, run.currentGeneration);
    if (specs.length !== graph.plans.length) fail("Herder reset refused: stored plan graph does not match the plan index.");
    for (const plan of graph.plans) {
      const spec = specs.find((candidate) => candidate.planId === plan.id);
      if (!spec || spec.planFile !== path.basename(plan.file) || spec.assignment.plan.id !== plan.id || snapshot(spec.dependencies) !== snapshot(plan.dependencies)) fail(`Herder reset refused: stored plan graph is corrupt or has drifted (${plan.id}).`);
      if (!["TODO", "DONE", "BLOCKED", "REJECTED"].includes(spec.initialStatus)) fail(`Herder reset refused: invalid initial status for plan ${plan.id}.`);
    }
    return { graph, specs, run };
  } finally { store.close(); }
}

function projectedResetStatuses(specs: StoredPlanSpec[]): Array<{ id: string; status: string; detail: string }> {
  return specs.map((spec) => {
    const detail = String(spec.initialStatusDetail ?? "").trim();
    if (spec.initialStatus === "BLOCKED" || spec.initialStatus === "REJECTED") {
      if (!detail) fail(`Herder reset refused: ${spec.initialStatus} plan ${spec.planId} is missing its status detail.`);
      if (/[\r\n|]/.test(detail)) fail(`Herder reset refused: status detail for plan ${spec.planId} is not a single table-safe line.`);
      return { id: spec.planId, status: spec.initialStatus, detail };
    }
    // Recovery retry/revise used to persist the rationale on TODO. That is not a
    // README status detail; drop it rather than failing after Git mutations.
    return { id: spec.planId, status: spec.initialStatus, detail: "" };
  });
}

/** Reset an entire initialized plan namespace. This intentionally does not use one-plan recovery cleanup. */
export function resetHerderPlanSet(input: HerderResetInput): HerderResetResult {
  const repo = realpathIfPresent(path.resolve(input.repoRoot));
  if (realpathIfPresent(runGit(repo, ["rev-parse", "--show-toplevel"]).stdout.trim()) !== repo) fail(`Repository root mismatch: ${repo}`);
  const planDirCandidate = path.resolve(repo, input.planDirectory);
  if (!fs.existsSync(planDirCandidate) || fs.lstatSync(planDirCandidate).isSymbolicLink()) fail(`Plan directory is missing or unsafe: ${planDirCandidate}`);
  const planDir = realpathIfPresent(planDirCandidate);
  if (!isInside(repo, planDir, { allowEqual: false })) fail(`Plan directory must be inside the repository: ${planDir}`);
  const name = path.basename(planDir);
  validatePlanName(name);
  const { graph, specs, run } = validateSpecs(planDir);
  if (run!.repositoryRoot !== repo || run!.planName !== name || run!.integrationBranch !== `herder/${name}/integration`) fail("Herder reset refused: execution identity does not match this repository and plan set.");
  const integration = `herder/${name}/integration`, integrationRef = `refs/heads/${integration}`, baseRef = `refs/plan-herder/${name}/base`;
  const current = checkout(repo);
  if (!current.branch || !current.head) fail("Herder reset cannot run from a detached or unreadable checkout.");
  if (current.branch === integration) fail("Herder reset cannot run from the integration checkout.");
  if (current.branch.startsWith(`herder/${name}/`)) fail("Herder reset cannot run from a Herder-owned plan checkout.");
  // Validate the README projection before any Git mutation so a later
  // status-format failure cannot leave a half-deleted namespace.
  const projected = projectedResetStatuses(specs);
  const integrationHead = target(repo, integrationRef), base = target(repo, baseRef);
  const allBranches = listHerderBranches(repo, name);
  const allRefs = listCoordinationRefs(repo, name);
  const worktrees = listWorktreeInventory(repo);
  const owned = worktrees.filter((w) => w.branch.startsWith(`herder/${name}/`));
  const namespaceEmpty = !integrationHead && !base && allBranches.length === 0 && allRefs.length === 0 && owned.length === 0;
  const removedWorktrees: string[] = [];
  const removedBranches: string[] = [];
  const removedRefs: string[] = [];
  if (!namespaceEmpty) {
    if (!integrationHead) fail(`Herder reset requires integration branch ${integration}.`);
    if (!base) fail(`Herder reset requires a valid base coordination ref ${baseRef}.`);
    if (!ancestor(repo, base, integrationHead)) fail("Herder reset refused: integration branch is unrelated to its base coordination ref.");
    if (integrationHead !== base && ancestor(repo, integrationHead, current.head)) fail("Herder reset cannot be performed because the integration branch has already been merged.");
    const allowedPlans = new Set(graph.plans.map((p) => p.id));
    for (const branch of allBranches) {
      if (branch.relative !== "integration" && !/^\d{3,}$/.test(branch.relative)) fail(`Herder reset refused unknown branch in namespace: ${branch.branch}`);
      if (branch.relative !== "integration" && !allowedPlans.has(branch.relative)) fail(`Herder reset refused branch for unknown plan: ${branch.branch}`);
    }
    for (const ref of allRefs) if (!ref.identity) fail(`Herder reset refused unknown coordination ref: ${ref.ref}`);
    const branchMap = new Map(allBranches.map((b) => [b.branch, b]));
    const integrationWorktrees = worktrees.filter((w) => w.branch === integration);
    if (integrationWorktrees.length !== 1) fail(`Herder reset requires exactly one registered integration worktree for ${integration}.`);
    for (const w of owned) {
      if (!w.path) fail(`Herder reset refused pathless worktree record for branch: ${w.branch}`);
      if (!branchMap.has(w.branch)) fail(`Herder reset refused worktree for missing Herder branch: ${w.path}`);
      cleanWorktree(repo, w);
      const expected = allowedWorktreePaths(repo, planDir, name, worktreeRelativeName(w.branch, name, integration));
      if (!expected.some((candidate) => realpathIfPresent(w.path) === realpathIfPresent(candidate))) fail(`Herder reset refused moved or foreign worktree: ${w.path}`);
    }
    const currentBranchSnapshot = snapshot(allBranches), currentRefSnapshot = snapshot(allRefs), currentWorktreeSnapshot = snapshot(worktrees);
    // Revalidate every identity immediately before the first mutation.
    if (snapshot(listHerderBranches(repo, name)) !== currentBranchSnapshot || snapshot(listCoordinationRefs(repo, name)) !== currentRefSnapshot || snapshot(listWorktreeInventory(repo)) !== currentWorktreeSnapshot || JSON.stringify(checkout(repo)) !== JSON.stringify(current)) fail("Herder reset Git namespace changed after preflight.");
    for (const w of owned) {
      if (w.locked) runGit(repo, ["worktree", "unlock", "--", w.path]);
      runGit(repo, ["worktree", "remove", "--", w.path]);
      removedWorktrees.push(w.path);
    }
    for (const b of allBranches) { deleteBranch(repo, b.branch, b.head); removedBranches.push(b.branch); }
    for (const ref of allRefs) { deleteRef(repo, ref.ref, ref.target); removedRefs.push(ref.ref); }
  }
  // The README is the durable user-facing projection; use the immutable initial values, never current statuses.
  projectStatuses(planDir, projected);
  const writable = new RunStore(planDir);
  try { writable.resetExecutionState(); } finally { writable.close(); }
  clearExecutionRotationMarker(planDir);
  return { planName: name, removedBranches, removedWorktrees, removedRefs, resetPlans: specs.map((s) => s.planId) };
}
