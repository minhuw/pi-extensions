import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { compileGraphIdentity } from "../../core/plan-identity.ts";
import { sha256 } from "../../shared/protocol.ts";
import { buildGraph, projectStatuses } from "../../core/plans.ts";
import { RunStore, type StoredPlanSpec, type StoredRun } from "../run-store.ts";
import { clearExecutionRotationMarker } from "../execution-store.ts";
import { listHerderBranches, listWorktreeInventory, type WorktreeRecord } from "./namespace-inventory.ts";
import { listCoordinationRefs, parseCoordinationRefRelative, validatePlanName } from "./coordination-ref.ts";
import { allowedWorktreePaths, worktreeRelativeName } from "./worktree-locations.ts";
import { currentCheckout, fail, isAncestor, isInside, realpathIfPresent, runGit } from "./primitives.ts";

export interface HerderResetInput {
  repoRoot: string;
  planDirectory: string;
  revision?: { runId: string; graphSha256: string; baseCommit: string };
}
export interface HerderResetResult { planName: string; removedBranches: string[]; removedWorktrees: string[]; removedRefs: string[]; resetPlans: string[] }
type Worktree = WorktreeRecord;

function target(repo: string, ref: string): string | null { const r = runGit(repo, ["rev-parse", "--verify", ref], { allowFailure: true }); return r.status === 0 ? r.stdout.trim() : null; }
function snapshot<T>(items: T[]): string { return JSON.stringify(items); }
function executionIdentity(run: StoredRun): string {
  return snapshot([run.runId, run.currentGeneration, run.graphSha256, run.baseCommit, run.checkoutStateToken,
    run.repositoryRoot, run.planDirectory, run.planName, run.integrationBranch, run.integrationWorktree,
    run.host, run.profileName, run.profileSha256, run.maxParallel]);
}
// Filesystem identity handles case-insensitive paths and symlinks without case-folding unrelated paths.
function pathIdentity(candidate: string): string {
  try {
    const stat = fs.statSync(candidate, { bigint: true });
    return `inode:${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    return `path:${realpathIfPresent(candidate)}`;
  }
}
function validateWorktree(repo: string, item: Worktree): void {
  if (!fs.existsSync(item.path)) fail(`Herder reset cannot remove missing worktree: ${item.path}`);
  if (realpathIfPresent(item.path) === realpathIfPresent(repo)) fail("Herder reset cannot remove the user checkout.");
}
function deleteRef(repo: string, ref: string, expected: string): void { const current = target(repo, ref); if (current !== expected) fail(`Herder reset found moved ref ${ref}; expected ${expected}, found ${current ?? "missing"}`); if (runGit(repo, ["update-ref", "--no-deref", "-d", ref, expected], { allowFailure: true }).status !== 0) fail(`Herder reset could not delete moved ref ${ref}`); }
function deleteBranch(repo: string, branch: string, expected: string): void { deleteRef(repo, `refs/heads/${branch}`, expected); }
function readExecution(planDir: string): { specs: StoredPlanSpec[]; run: StoredRun | null; executedPlanIds: Set<string> } {
  let store: RunStore;
  try { store = new RunStore(planDir, { readOnly: true }); } catch { fail("Herder reset requires an intact initialized execution database."); }
  try {
    const run = store.getRun();
    return { run, specs: run ? store.getPlanSpecs(run.runId, run.currentGeneration) : [],
      executedPlanIds: new Set(run ? store.getPlans(run.runId).map((plan) => plan.planId) : []) };
  } finally { store.close(); }
}

function validateSpecs(graph: ReturnType<typeof buildGraph>, specs: StoredPlanSpec[], revision?: HerderResetInput["revision"]): void {
  if (revision) {
    if (!graph.shapeReady || !graph.plans.length) fail("Herder revision reset requires a nonempty, structurally valid, shape-ready graph.");
    if (compileGraphIdentity(graph) !== revision.graphSha256) fail("Herder revision reset graph hash does not match the authorized graph.");
  } else if (specs.length !== graph.plans.length) fail("Herder reset refused: stored plan graph does not match the plan index.");
  const seen = new Set<string>();
  for (const spec of specs) {
    if (!/^\d{3,}$/.test(spec.planId) || seen.has(spec.planId) || spec.assignment.plan.id !== spec.planId
      || snapshot(spec.dependencies) !== snapshot(spec.assignment.plan.dependencies)) fail("Herder reset refused: corrupt stored plan ownership.");
    seen.add(spec.planId);
    if (!["TODO", "DONE", "BLOCKED", "REJECTED"].includes(spec.initialStatus)) fail(`Herder reset refused: invalid initial status for plan ${spec.planId}.`);
  }
  if (!revision) for (const plan of graph.plans) {
    const spec = specs.find((candidate) => candidate.planId === plan.id);
    if (!spec || spec.planFile !== path.basename(plan.file) || snapshot(spec.dependencies) !== snapshot(plan.dependencies)) fail(`Herder reset refused: stored plan graph is corrupt or has drifted (${plan.id}).`);
  }
}

function projectedResetStatuses(specs: StoredPlanSpec[], executedPlanIds: Set<string>): Array<{ id: string; status: string; detail: string }> {
  return specs.map((spec) => {
    const detail = String(spec.initialStatusDetail ?? "").trim();
    if (spec.initialStatus === "BLOCKED" || spec.initialStatus === "REJECTED") {
      if (!detail) fail(`Herder reset refused: ${spec.initialStatus} plan ${spec.planId} is missing its status detail.`);
      if (/[\r\n|]/.test(detail)) fail(`Herder reset refused: status detail for plan ${spec.planId} is not a single table-safe line.`);
      return { id: spec.planId, status: spec.initialStatus, detail };
    }
    // Recovery retry/revise used to persist the rationale on TODO. That is not a
    // README status detail; drop it rather than failing after Git mutations.
    // Selective retention can promote DONE while keeping an older generation's runtime.
    // Reset discards that work, but an authored DONE without runtime remains authored.
    const status = spec.initialStatus === "DONE" && executedPlanIds.has(spec.planId) ? "TODO" : spec.initialStatus;
    return { id: spec.planId, status, detail: "" };
  });
}

type ResetManifest = {
  input: { repoRoot: string; planDirectory: string; revision: HerderResetInput["revision"] | null };
  run: StoredRun;
  specs: StoredPlanSpec[];
  graphSha256: string;
  current: ReturnType<typeof currentCheckout>;
  projected: ReturnType<typeof projectedResetStatuses>;
  branches: ReturnType<typeof listHerderBranches>;
  refs: ReturnType<typeof listCoordinationRefs>;
  worktrees: ReturnType<typeof listWorktreeInventory>;
  owned: Array<ReturnType<typeof listWorktreeInventory>[number] & { identity: string | null; attachment: string }>;
  slots: Array<{ path: string; identity: string | null }>;
  result: HerderResetResult;
};
type ResetIntent = {
  version: 1;
  manifest: ResetManifest;
  manifestSha256: string;
  next: number;
  pending: boolean;
  databasePending: boolean;
  completed: boolean;
};

function statIfPresent(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

function assertSafePath(file: string): void {
  for (let candidate = path.resolve(file); ; candidate = path.dirname(candidate)) {
    if (statIfPresent(candidate)?.isSymbolicLink()) fail(`Herder reset refused symlink artifact: ${candidate}`);
    if (path.dirname(candidate) === candidate) break;
  }
}

function slotIdentity(file: string): string | null {
  assertSafePath(file);
  const stat = statIfPresent(file);
  if (!stat) return null;
  if (!stat.isDirectory()) fail(`Herder reset refused non-directory worktree artifact: ${file}`);
  return pathIdentity(file);
}

function attachment(worktree: string): string {
  const file = path.join(worktree, ".git");
  assertSafePath(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) fail(`Herder reset refused non-regular worktree attachment: ${file}`);
  return `${pathIdentity(file)}:${sha256(fs.readFileSync(file))}`;
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function readIntent(file: string): ResetIntent | null {
  assertSafePath(file);
  const before = statIfPresent(file);
  if (!before) return null;
  if (!before.isFile()) fail("Herder reset intent must be a private, owned regular file.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail("Herder reset intent must be a private, owned regular file.");
    const intent = JSON.parse(fs.readFileSync(fd, "utf8")) as ResetIntent;
    const count = intent.manifest?.owned.length + intent.manifest?.branches.length + intent.manifest?.refs.length;
    if (intent.version !== 1 || intent.manifestSha256 !== sha256(JSON.stringify(intent.manifest))
      || !Number.isSafeInteger(intent.next) || intent.next < 0 || intent.next > count
      || typeof intent.pending !== "boolean" || typeof intent.databasePending !== "boolean" || typeof intent.completed !== "boolean"
      || (intent.pending && intent.next === count) || (intent.databasePending && (intent.next !== count || intent.pending))
      || (intent.completed && !intent.databasePending)) fail("Herder reset intent is corrupt or unsupported.");
    return intent;
  } finally { fs.closeSync(fd); }
}

function writeIntent(file: string, intent: ResetIntent): void {
  assertSafePath(file);
  // Random, exclusive staging in the same private namespace; never follow a supplied path.
  const temporary = path.join(path.dirname(file), `.reset-intent-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(intent)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); syncDirectory(path.dirname(file)); }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** Missing is authorized only for completed deletions or the single durable in-flight deletion. */
function validateReplay(repo: string, planDir: string, name: string, intent: ResetIntent): void {
  const m = intent.manifest;
  if (compileGraphIdentity(buildGraph(planDir)) !== m.graphSha256) fail("Herder reset graph changed after preflight.");
  if (m.input.repoRoot !== repo || m.input.planDirectory !== planDir || m.run.repositoryRoot !== repo
    || m.run.planName !== name || m.run.integrationBranch !== `herder/${name}/integration`
    || JSON.stringify(currentCheckout(repo)) !== JSON.stringify(m.current)) fail("Herder reset checkout or run identity changed after preflight.");
  const relatives = new Set(["integration", ...m.specs.map((s) => s.planId)]);
  const allowed = [...relatives].flatMap((relative) => allowedWorktreePaths(repo, planDir, name, relative));
  if (snapshot(m.slots.map((s) => s.path)) !== snapshot([...new Set(allowed)])) fail("Herder reset intent contains foreign worktree paths.");
  const mayBeMissing = (index: number) => index < intent.next || (index === intent.next && intent.pending);
  const checkPresence = (index: number, exists: boolean) => {
    if (exists ? index < intent.next : !mayBeMissing(index)) fail("Herder reset found a new or unexpectedly missing artifact after preflight.");
  };
  const inventory = listWorktreeInventory(repo);
  const remaining = [...inventory];
  for (const [index, w] of m.owned.entries()) {
    const relative = w.branch.slice(`herder/${name}/`.length);
    const expectedPaths = allowedWorktreePaths(repo, planDir, name, relative);
    if (!relatives.has(relative) || !w.branch.startsWith(`herder/${name}/`) || !w.identity
      || !m.slots.some((slot) => expectedPaths.includes(slot.path) && slot.identity === w.identity)) fail("Herder reset intent contains foreign worktree ownership.");
    const found = remaining.findIndex((item) => item.path === w.path);
    const actual = found < 0 ? null : remaining.splice(found, 1)[0]!;
    const identity = slotIdentity(w.path);
    checkPresence(index, actual !== null || identity !== null);
    if (actual) {
      const { identity: _identity, attachment: _attachment, ...expected } = w;
      // Unlock is part of the pending remove operation, so its crash window is replayable too.
      const unlocked = intent.pending && intent.next === index && w.locked && !actual.locked;
      const removalInterrupted = intent.pending && intent.next === index && (identity === null
        || (identity === w.identity && statIfPresent(path.join(w.path, ".git")) === null));
      if (JSON.stringify(actual) !== JSON.stringify(unlocked ? { ...expected, locked: false, lockReason: null } : expected)
        || (!removalInterrupted && (identity !== w.identity || attachment(w.path) !== w.attachment))) fail(`Herder reset found moved or foreign worktree attachment: ${w.path}`);
    } else if (identity !== null) fail(`Herder reset found an unregistered worktree artifact: ${w.path}`);
  }
  const foreign = m.worktrees.filter((w) => !m.owned.some((owned) => owned.path === w.path));
  if (snapshot(remaining) !== snapshot(foreign)) fail("Herder reset found new, moved, or foreign worktree attachments after preflight.");
  for (const slot of m.slots) {
    const ownedIndex = m.owned.findIndex((w) => w.path === slot.path || (slot.identity !== null && w.identity === slot.identity));
    const identity = slotIdentity(slot.path);
    if (ownedIndex < 0 ? identity !== slot.identity : identity !== slot.identity && !(identity === null && mayBeMissing(ownedIndex))) fail(`Herder reset found a changed worktree path: ${slot.path}`);
  }
  const common = realpathIfPresent(runGit(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim());
  const refs = [
    ...m.branches.map((b) => ({ ref: `refs/heads/${b.branch}`, target: b.head })),
    ...m.refs.map((r) => ({ ref: r.ref, target: r.target })),
  ];
  // Git omits dangling symlinks and malformed loose refs from for-each-ref.
  // Inspect only the two fixed owned namespaces, never paths supplied by an intent.
  const expectedRefs = new Set(refs.map((ref) => ref.ref));
  function validateLooseRefs(relative: string): void {
    const file = path.join(common, relative);
    assertSafePath(file);
    const stat = statIfPresent(file);
    if (!stat) return;
    if (stat.isDirectory()) for (const entry of fs.readdirSync(file)) validateLooseRefs(`${relative}/${entry}`);
    else if (!stat.isFile() || !expectedRefs.has(relative)) fail(`Herder reset found a new or foreign loose ref artifact: ${relative}`);
  }
  validateLooseRefs(`refs/heads/herder/${name}`);
  validateLooseRefs(`refs/plan-herder/${name}`);
  const actualRefs = new Map([
    ...listHerderBranches(repo, name).map((b) => [`refs/heads/${b.branch}`, b.head] as const),
    ...listCoordinationRefs(repo, name).map((r) => [r.ref, r.target] as const),
  ]);
  for (const [index, ref] of refs.entries()) {
    const branch = ref.ref.slice(`refs/heads/herder/${name}/`.length);
    const coordination = ref.ref.slice(`refs/plan-herder/${name}/`.length);
    if (!(ref.ref.startsWith(`refs/heads/herder/${name}/`) && relatives.has(branch))
      && !(ref.ref.startsWith(`refs/plan-herder/${name}/`) && parseCoordinationRefRelative(coordination))) fail("Herder reset intent contains a foreign ref.");
    assertSafePath(path.join(common, ref.ref));
    if (runGit(repo, ["symbolic-ref", "-q", ref.ref], { allowFailure: true }).status === 0) fail(`Herder reset refused symbolic ref artifact: ${ref.ref}`);
    const actual = actualRefs.get(ref.ref);
    checkPresence(m.owned.length + index, actual !== undefined);
    if (actual !== undefined && actual !== ref.target) fail(`Herder reset found moved ref ${ref.ref}`);
    actualRefs.delete(ref.ref);
  }
  if (actualRefs.size) fail("Herder reset found new or foreign refs after preflight.");
}

function executeIntent(repo: string, planDir: string, name: string, file: string, intent: ResetIntent): HerderResetResult {
  const m = intent.manifest;
  const deletions = [
    ...m.owned.map((w) => () => {
      const actual = listWorktreeInventory(repo).find((item) => item.path === w.path);
      if (!actual) return;
      if (actual.locked) runGit(repo, ["worktree", "unlock", "--", w.path]);
      // Git cannot remove a surviving directory after its .git file was deleted.
      // Replay above verified this pending slot's original inode and registration.
      if (statIfPresent(path.join(w.path, ".git")) === null) fs.rmSync(w.path, { recursive: true, force: true });
      runGit(repo, ["worktree", "remove", "--force", "--", w.path]);
    }),
    ...m.branches.map((b) => () => { if (target(repo, `refs/heads/${b.branch}`) !== null) deleteBranch(repo, b.branch, b.head); }),
    ...m.refs.map((r) => () => { if (target(repo, r.ref) !== null) deleteRef(repo, r.ref, r.target); }),
  ];
  validateReplay(repo, planDir, name, intent);
  if (intent.completed) return m.result;
  // ponytail: re-inventory per deletion is quadratic; batch only if large namespaces make it costly.
  while (intent.next < deletions.length) {
    intent.pending = true;
    writeIntent(file, intent);
    validateReplay(repo, planDir, name, intent);
    deletions[intent.next]!();
    intent.next++;
    intent.pending = false;
    writeIntent(file, intent);
  }
  validateReplay(repo, planDir, name, intent);
  // README projection is replayable; make it durable before clearing execution evidence.
  projectStatuses(planDir, m.projected);
  const readme = fs.openSync(path.join(planDir, "README.md"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(readme); } finally { fs.closeSync(readme); }
  syncDirectory(planDir);
  intent.databasePending = true;
  writeIntent(file, intent);
  const writable = new RunStore(planDir);
  try {
    const run = writable.getRun();
    if (run && run.runId !== m.run.runId) fail("Herder reset refused a successor run before clearing execution state.");
    writable.resetExecutionState();
  } finally { writable.close(); }
  clearExecutionRotationMarker(planDir);
  intent.completed = true;
  writeIntent(file, intent);
  return m.result;
}

/** Reset an entire initialized plan namespace; caller must hold service exclusion.
 * Revision callers must additionally await snapshotCheckout({ repo, excludes: [planDirectory],
 * expect: run.checkoutStateToken }) and require ok under that exclusion. That verifier is async;
 * this synchronous primitive checks HEAD/base and binds the checkout identity across retries.
 */
export function resetHerderPlanSet(input: HerderResetInput): HerderResetResult {
  const repo = realpathIfPresent(path.resolve(input.repoRoot));
  if (realpathIfPresent(runGit(repo, ["rev-parse", "--show-toplevel"]).stdout.trim()) !== repo) fail(`Repository root mismatch: ${repo}`);
  const planDirCandidate = path.resolve(repo, input.planDirectory);
  if (!fs.existsSync(planDirCandidate) || fs.lstatSync(planDirCandidate).isSymbolicLink()) fail(`Plan directory is missing or unsafe: ${planDirCandidate}`);
  const planDir = realpathIfPresent(planDirCandidate);
  if (!isInside(repo, planDir, { allowEqual: false })) fail(`Plan directory must be inside the repository: ${planDir}`);
  const name = path.basename(planDir);
  validatePlanName(name);
  const intentPath = path.join(planDir, ".herder", "reset-intent.json");
  assertSafePath(path.dirname(intentPath));
  const saved = readIntent(intentPath);
  const graph = buildGraph(planDir);
  const execution = readExecution(planDir);
  const binding = { repoRoot: repo, planDirectory: planDir, revision: input.revision ? {
    runId: input.revision.runId, graphSha256: input.revision.graphSha256, baseCommit: input.revision.baseCommit,
  } : null };
  const successor = saved && execution.run && execution.run.runId !== saved.manifest.run.runId;
  if (successor && input.revision && input.revision.runId !== execution.run!.runId) fail("Herder reset refused a stale revision targeting a successor run.");
  // Under caller exclusion, a fresh reset may supersede a completed receipt, never
  // an unfinished deletion. Retain the old receipt until the new preflight passes;
  // writeIntent then replaces it atomically with authority for the current run.
  const freshReset = saved?.completed && successor;
  if (freshReset && (saved.manifest.input.repoRoot !== repo || saved.manifest.input.planDirectory !== planDir)) fail("Herder reset intent does not match this input or graph.");
  if (saved && !freshReset) {
    if (JSON.stringify(saved.manifest.input) !== JSON.stringify(binding) || saved.manifest.graphSha256 !== compileGraphIdentity(graph)) fail("Herder reset intent does not match this input or graph.");
    if (execution.run ? executionIdentity(execution.run) !== executionIdentity(saved.manifest.run) || snapshot(execution.specs) !== snapshot(saved.manifest.specs)
      : !saved.databasePending) fail("Herder reset intent run identity changed or a successor run exists.");
    validateSpecs(graph, saved.manifest.specs, input.revision);
    return executeIntent(repo, planDir, name, intentPath, saved);
  }
  const { specs, run } = execution;
  if (!run) fail("Herder reset requires an initialized Herder run.");
  validateSpecs(graph, specs, input.revision);
  if (run.repositoryRoot !== repo || run.planName !== name || run.integrationBranch !== `herder/${name}/integration`) fail("Herder reset refused: execution identity does not match this repository and plan set.");
  const integration = `herder/${name}/integration`, integrationRef = `refs/heads/${integration}`, baseRef = `refs/plan-herder/${name}/base`;
  const current = currentCheckout(repo);
  if (!current.branch || !current.head) fail("Herder reset cannot run from a detached or unreadable checkout.");
  if (current.branch === integration) fail("Herder reset cannot run from the integration checkout.");
  if (current.branch.startsWith(`herder/${name}/`)) fail("Herder reset cannot run from a Herder-owned plan checkout.");
  // Validate the README projection before any Git mutation so a later
  // status-format failure cannot leave a half-deleted namespace.
  if (input.revision && (input.revision.runId !== run.runId || input.revision.baseCommit !== run.baseCommit || current.head !== run.baseCommit)) fail("Herder revision reset requires the recorded runId and checkout HEAD equal to run.baseCommit and revision.baseCommit.");
  const projected = input.revision ? graph.plans.map((plan) => ({ id: plan.id, status: "TODO", detail: "" })) : projectedResetStatuses(specs, execution.executedPlanIds);
  const integrationHead = target(repo, integrationRef), base = target(repo, baseRef);
  const allBranches = listHerderBranches(repo, name);
  const allRefs = listCoordinationRefs(repo, name);
  const worktrees = listWorktreeInventory(repo);
  function validateAttachments(inventory: typeof worktrees): void {
    const expectedAttachments = new Map<string, Set<string>>();
    for (const relative of ["integration", ...specs.map((spec) => spec.planId)]) {
      for (const candidate of allowedWorktreePaths(repo, planDir, name, relative)) {
        const identity = pathIdentity(candidate);
        const expected = expectedAttachments.get(identity) ?? new Set<string>();
        expected.add(`herder/${name}/${relative}`);
        expectedAttachments.set(identity, expected);
      }
    }
    for (const w of inventory) {
      if (!w.path) continue; // Owned pathless records are rejected below.
      for (const expected of expectedAttachments.get(pathIdentity(w.path)) ?? []) {
        if (w.detached || w.branch !== expected) fail(`Herder reset refused worktree attachment at ${w.path}: expected ${expected}, found ${w.detached ? "detached" : w.branch || "no branch"}.`);
      }
    }
  }
  validateAttachments(worktrees);
  const owned = worktrees.filter((w) => w.branch.startsWith(`herder/${name}/`));
  const namespaceEmpty = !integrationHead && !base && allBranches.length === 0 && allRefs.length === 0 && owned.length === 0;
  if (!namespaceEmpty) {
    if (!integrationHead) fail(`Herder reset requires integration branch ${integration}.`);
    if (!base) fail(`Herder reset requires a valid base coordination ref ${baseRef}.`);
    if (!isAncestor(repo, base, integrationHead)) fail("Herder reset refused: integration branch is unrelated to its base coordination ref.");
    if (integrationHead !== base && isAncestor(repo, integrationHead, current.head)) fail("Herder reset cannot be performed because the integration branch has already been merged.");
    const allowedPlans = new Set(specs.map((spec) => spec.planId));
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
      validateWorktree(repo, w);
      const expected = allowedWorktreePaths(repo, planDir, name, worktreeRelativeName(w.branch, name, integration));
      if (!expected.some((candidate) => pathIdentity(w.path) === pathIdentity(candidate))) fail(`Herder reset refused moved or foreign worktree: ${w.path}`);
    }
  }
  // Revalidate even an empty namespace before changing the README or execution evidence.
  const finalWorktrees = listWorktreeInventory(repo);
  validateAttachments(finalWorktrees);
  if (snapshot(listHerderBranches(repo, name)) !== snapshot(allBranches) || snapshot(listCoordinationRefs(repo, name)) !== snapshot(allRefs) || snapshot(finalWorktrees) !== snapshot(worktrees) || JSON.stringify(currentCheckout(repo)) !== JSON.stringify(current)) fail("Herder reset Git namespace changed after preflight.");
  const slots = [...new Set(["integration", ...specs.map((spec) => spec.planId)].flatMap((relative) => allowedWorktreePaths(repo, planDir, name, relative)))];
  const manifest: ResetManifest = {
    input: binding, run, specs, graphSha256: compileGraphIdentity(graph), current, projected,
    branches: allBranches, refs: allRefs, worktrees,
    owned: owned.map((w) => ({ ...w, identity: slotIdentity(w.path), attachment: attachment(w.path) })),
    slots: slots.map((slot) => ({ path: slot, identity: slotIdentity(slot) })),
    result: { planName: name, removedBranches: allBranches.map((b) => b.branch), removedWorktrees: owned.map((w) => w.path), removedRefs: allRefs.map((r) => r.ref), resetPlans: projected.map((p) => p.id) },
  };
  const intent: ResetIntent = { version: 1, manifest, manifestSha256: sha256(JSON.stringify(manifest)), next: 0, pending: false, databasePending: false, completed: false };
  // Validate filesystem/ref identities too, before publishing deletion authority.
  validateReplay(repo, planDir, name, intent);
  writeIntent(intentPath, intent);
  return executeIntent(repo, planDir, name, intentPath, intent);
}
