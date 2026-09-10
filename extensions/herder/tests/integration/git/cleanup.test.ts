#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { cleanupRun } from "../../../src/daemon/git/cleanup-run.ts"
import {
  listHerderBranches,
  listWorktreeInventory,
  parseWorktreeInventory,
} from "../../../src/daemon/git/namespace-inventory.ts"
import { forceCleanupRun } from "../../../src/daemon/git/force-cleanup-run.ts"
import { buildCompletionProofPayload, writeCompletionProof } from "../../../src/daemon/git/completion-proof.ts"
import { RunStore, type StoredPlan, type StoredPlanSpec } from "../../../src/daemon/run-store.ts"
import { withTemporaryExecutableOnPath } from "../../support/temp-executable.ts"

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function withGitShim<T>(
  mode: "nul" | "newline" | "malformed-branch" | "fail-remove",
  branch: string,
  callback: () => T,
  failRemovePath?: string,
): T {
  const originalPath = process.env.PATH ?? ""
  const realPath = originalPath.replaceAll("'", "'\\\"'\\\"'")
  const realGit = "real_git"
  const pathless = `branch refs/heads/${branch}`
  const worktreeOutput = mode === "newline"
    ? `output=$(${realGit} "$@") && printf '%s\\n\\n${pathless}\\n\\n' "$output"`
    : `${realGit} "$@"; printf '${pathless}\\0\\0'`
  const branchOutput = `${realGit} "$@"; printf 'malformed branch row\\n'`
  const removeFailure = mode === "fail-remove"
    ? failRemovePath === undefined
      ? `  *"worktree remove"*) exit 1 ;;`
      : `  *"worktree remove"*'${failRemovePath.replaceAll("'", "'\\\''")}'*) exit 1 ;;`
    : ""
  return withTemporaryExecutableOnPath({
    prefix: "herder-git-shim-",
    script: `#!/bin/sh
real_git() { PATH='${realPath}'; export PATH; command git "$@"; }
case "$*" in
${removeFailure}
  *"worktree list --porcelain -z"*)
    ${mode === "newline" ? "exit 1" : worktreeOutput}
    exit ;;
  *"worktree list --porcelain"*)
    ${mode === "newline" ? `${realGit} "$@"; printf '${pathless}\\n\\n'` : `${realGit} "$@"`}
    exit ;;
  *"for-each-ref"*"refs/heads/${branch.slice(0, branch.lastIndexOf("/") + 1)}"*)
    ${mode === "malformed-branch" ? branchOutput : `${realGit} "$@"`}
    exit ;;
esac
real_git "$@"
`,
  }, callback)
}

function planBody(planId = "001"): string {
  return `# Plan ${planId}: Cleanup fixture

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-07-19
- **Kind**: behavioral
- **Parent objective**: Exercise the deterministic fixture lifecycle without changing user-owned state.

## Outcome and acceptance

Cleanup fixture.

| ID | Required behavior | Proof |
|---|---|---|
| A1 | Cleanup retains unproven or unsafe branches and removes only the proven completed fixture. | V1 |

## Boundaries

**Write paths**
- \`done.txt\`

**Out of scope**
- User checkout, unrelated files, and manager-owned state.

Cleanup fixture.

Preserve user-owned files and the existing fixture interfaces; review only the declared transition.

## Starting conditions

**Observed baseline**

Complete.

**Required starting state**

The stated fixture assumptions and direct interfaces still hold. Run the T1 probe before edits; report unavailable prerequisites without treating them as code defects.

**Expected dependency changes**

Dependencies: none.

## Implementation route

### Step 1: Test

Run the fixture.

Suggested route above implements A1; V1 is its acceptance proof. Binding decisions: retain the declared boundaries and direct interfaces.

## Verification

| ID | Phase | Criteria | Toolchain | Command | Expected |
|---|---|---|---|---|---|
| V1 | acceptance | A1 | T1 | \`npm run test:herder -- extensions/herder/tests/integration/git/cleanup.test.ts\` | exit 0; named fixture assertions preserve the documented lifecycle and safety behavior |

| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
|---|---|---|---|---|---|
| T1 | npm project scripts | . | Node >=22.19; repository locked dependencies installed | \`node --version\` | \`package.json\`; \`package-lock.json\` |

Run the fixture test.

## Escalation and handoff

Provides the bounded fixture transition. Safe intermediate state: unrelated files and manager state remain unchanged.

Stop on unsafe cleanup.

Environment or invocation failure: report the exact manager, command, cwd, error, and missing prerequisite; do not guess a substitute. Missing product authority requires a decision.

Deferred work: Keep small.
`
}

interface Fixture {
  root: string
  repo: string
  planDir: string
  planBranch: string
  planWorktree: string
  integrationBranch: string
  integrationWorktree: string
}

function setup(options: { planId?: string; readmeStatus?: string; writeProof?: boolean } = {}): Fixture {
  const planId = options.planId ?? "001"
  const readmeStatus = options.readmeStatus ?? "DONE"
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-cleanup-git-"))
  const repo = path.join(root, "repo")
  const worktrees = path.join(root, "worktrees")
  fs.mkdirSync(repo)
  fs.mkdirSync(worktrees)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Cleanup test")
  git(repo, "config", "user.email", "cleanup@example.invalid")
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n")
  const planDir = path.join(repo, "plans")
  fs.mkdirSync(planDir)
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [${planId}](${planId}-cleanup-fixture.md) | Cleanup fixture | P1 | S | — | ${readmeStatus} |
`)
  fs.writeFileSync(path.join(planDir, `${planId}-cleanup-fixture.md`), planBody(planId))
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "test: initialize cleanup fixture")
  const base = git(repo, "rev-parse", "HEAD")
  const integrationBranch = "herder/plans/integration"
  const planBranch = `herder/plans/${planId}`
  const integrationWorktree = path.join(worktrees, "integration")
  const planWorktree = path.join(worktrees, "plan")
  git(repo, "worktree", "add", "-q", "-b", integrationBranch, integrationWorktree, base)
  git(repo, "worktree", "add", "-q", "-b", planBranch, planWorktree, integrationBranch)
  fs.writeFileSync(path.join(planWorktree, "done.txt"), "done\n")
  git(planWorktree, "add", "done.txt")
  git(planWorktree, "commit", "-q", "-m", "feat: complete plan")
  const completed = git(planWorktree, "rev-parse", "HEAD")
  git(integrationWorktree, "merge", "-q", "--ff-only", planBranch)
  git(repo, "merge", "-q", "--ff-only", integrationBranch)
  git(repo, "update-ref", "refs/plan-herder/plans/base", base, "")
  if (options.writeProof !== false) {
    const proof = buildCompletionProofPayload({
      runId: "cleanup-test", planId, generation: 1, round: 1,
      reviewerActionId: "reviewer-001", decisionActionId: "reviewer-001", decisionRole: "plan-reviewer",
      assignmentSha256: "a".repeat(64), approvedBase: base, approvedHead: completed,
      approvedTree: git(repo, "rev-parse", `${completed}^{tree}`), reviewResultSha256: "b".repeat(64),
      decisionResultSha256: "b".repeat(64), integratedHead: completed,
    })
    writeCompletionProof(repo, `refs/plan-herder/plans/completed/${planId}`, proof, "cleanup-test-proof")
  }
  return { root, repo, planDir, planBranch, planWorktree, integrationBranch, integrationWorktree }
}

function writeOverlay(
  fixture: Fixture,
  input: {
    planId: string
    phase: StoredPlan["phase"]
    initialStatus?: StoredPlanSpec["initialStatus"]
    runStatus?: "complete" | "failed" | "stopped" | "running" | "paused" | "initializing" | "needs_input"
  },
): void {
  const store = new RunStore(fixture.planDir)
  const runId = "cleanup-overlay-run"
  store.createRun({
    runId,
    repositoryRoot: fs.realpathSync(fixture.repo),
    planDirectory: fs.realpathSync(fixture.planDir),
    planName: "plans",
    host: "pi",
    profileName: "eclipse",
    profileSha256: "c".repeat(64),
    maxParallel: 1,
    currentGeneration: 1,
    graphSha256: "d".repeat(64),
    status: input.runStatus ?? "complete",
    checkoutStateToken: "checkout-token",
    baseCommit: git(fixture.repo, "rev-parse", "HEAD"),
    integrationBranch: fixture.integrationBranch,
    integrationWorktree: fs.realpathSync(fixture.integrationWorktree),
  })
  store.putPlanSpecs([{
    runId,
    graphGeneration: 1,
    planId: input.planId,
    planFingerprint: "e".repeat(64),
    fingerprintVersion: 2,
    ordinal: 0,
    title: "Cleanup fixture",
    priority: "P1",
    effort: "S",
    kind: "behavioral",
    dependencies: [],
    initialStatus: input.initialStatus ?? "TODO",
    initialStatusDetail: "",
    planFile: `${input.planId}-cleanup-fixture.md`,
    assignment: {
      snapshotSha256: "f".repeat(64),
      snapshotInputs: [],
      plan: { id: input.planId, title: "Cleanup fixture", kind: "behavioral", parentObjective: null, dependencies: [], inScopePaths: [] },
      planText: "# overlay",
    },
  }])
  store.putPlan({
    runId,
    planId: input.planId,
    generation: 1,
    round: 1,
    phase: input.phase,
    branch: `herder/plans/${input.planId}`,
    worktree: fixture.planWorktree,
    assignmentPath: "/tmp/assignment.json",
    assignmentSha256: "a".repeat(64),
    snapshotSha256: "b".repeat(64),
    generationBase: "c".repeat(40),
    reviewPass: 0,
    findings: [],
    repair: [],
    gates: [],
    approvedBase: null,
    approvedHead: null,
    approvedTree: null,
    rebase: null,
  })
  store.close()
}

function runCleanup(fixture: Fixture, input: Partial<Parameters<typeof cleanupRun>[0]> = {}) {
  return cleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: true, includeFailed: false, deep: false, ...input })
}

test("worktree inventory retains malformed records in both formats and rejects malformed branches", () => {
  const fixture = setup()
  try {
    const pathlessBranch = "herder/plans/999"
    const nulInventory = withGitShim("nul", pathlessBranch, () => listWorktreeInventory(fixture.repo))
    assert.equal(nulInventory.some((item) => item.path && item.head), true)
    assert.equal(nulInventory.some((item) => item.path === "" && item.branch === pathlessBranch && item.head === ""), true)
    const legacyInventory = withGitShim("newline", pathlessBranch, () => listWorktreeInventory(fixture.repo))
    assert.equal(legacyInventory.some((item) => item.path && item.head), true)
    assert.equal(legacyInventory.some((item) => item.path === "" && item.branch === pathlessBranch && item.head === ""), true)
    assert.throws(() => withGitShim("malformed-branch", pathlessBranch, () => listHerderBranches(fixture.repo, "plans")), /Cannot parse Git branch record/)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("worktree parser handles modern and legacy porcelain", () => {
  const modern = "worktree /tmp/one\0HEAD abc\0branch refs/heads/main\0\0worktree /tmp/two\0HEAD def\0detached\0locked\0\0branch refs/heads/herder/plans/999\0HEAD ghi\0\0"
  const legacy = "worktree /tmp/one\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/two\nHEAD def\ndetached\nlocked\n\nbranch refs/heads/herder/plans/999\nHEAD ghi\nunknown field\n\n"
  assert.deepEqual(parseWorktreeInventory(modern, true), [
    { path: "/tmp/one", head: "abc", branch: "main", detached: false, locked: false, lockReason: null },
    { path: "/tmp/two", head: "def", branch: "", detached: true, locked: true, lockReason: "" },
    { path: "", head: "ghi", branch: "herder/plans/999", detached: false, locked: false, lockReason: null },
  ])
  assert.deepEqual(parseWorktreeInventory(legacy, false), [
    { path: "/tmp/one", head: "abc", branch: "main", detached: false, locked: false, lockReason: null },
    { path: "/tmp/two", head: "def", branch: "", detached: true, locked: true, lockReason: "" },
    { path: "", head: "ghi", branch: "herder/plans/999", detached: false, locked: false, lockReason: null },
  ])
})

test("cleanup ignores pathless worktree records", () => {
  const fixture = setup()
  try {
    const result = withGitShim("nul", "herder/plans/999", () => runCleanup(fixture, { dryRun: false }))
    assert.deepEqual(result.removed.map((item) => item.branch), [fixture.planBranch])
    assert.equal(fs.existsSync(fixture.planWorktree), false)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.integrationBranch), "")
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("ordinary cleanup removes only eligible plan artifacts and preserves the plan set", () => {
  const fixture = setup()
  try {
    const result = runCleanup(fixture, { dryRun: false })
    assert.deepEqual(result.removed.map((item) => item.branch), [fixture.planBranch])
    assert.equal(fs.existsSync(fixture.planWorktree), false)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.integrationBranch), "")
    assert.equal(fs.existsSync(fixture.integrationWorktree), true)
    assert.equal(fs.existsSync(fixture.planDir), true)
    assert.notEqual(git(fixture.repo, "show-ref", "--verify", "refs/plan-herder/plans/base"), "")
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("cleanup refuses to treat the repository root as the plan directory", () => {
  const fixture = setup()
  try {
    const before = git(fixture.repo, "status", "--porcelain=v1")
    assert.throws(() => cleanupRun({ repo: fixture.repo, planDir: ".", planName: "plans", dryRun: false, includeFailed: false, deep: true }), /repository root/)
    assert.equal(git(fixture.repo, "status", "--porcelain=v1"), before)
    assert.equal(fs.existsSync(fixture.repo), true)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})
test("006-split overlay DONE with a reachable proof is deep-cleanup eligible while README stays TODO", () => {
  const fixture = setup({ planId: "006", readmeStatus: "TODO" })
  try {
    writeOverlay(fixture, { planId: "006", phase: "DONE", initialStatus: "TODO", runStatus: "complete" })
    assert.match(fs.readFileSync(path.join(fixture.planDir, "README.md"), "utf8"), /\| TODO \|/)
    const preview = runCleanup(fixture, { deep: true })
    assert.equal(preview.destruction.eligible, true)
    assert.equal(preview.destruction.blockers.some((item) => item.reason === "plan-not-terminal"), false)
    const result = runCleanup(fixture, { deep: true, dryRun: false })
    assert.equal(result.destruction.planDirectoryRemoved, true)
    assert.equal(fs.existsSync(fixture.planDir), false)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("ordinary and deep cleanup stay fail-closed while the SQLite run is active", () => {
  const fixture = setup({ readmeStatus: "TODO" })
  try {
    writeOverlay(fixture, { planId: "001", phase: "DONE", initialStatus: "TODO", runStatus: "running" })
    const ordinaryPreview = runCleanup(fixture)
    assert.equal(ordinaryPreview.actions.some((item) => item.plan === "001" && item.status === "DONE"), true)
    assert.throws(() => runCleanup(fixture, { dryRun: false }), /run-not-terminal/)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
    assert.equal(fs.existsSync(fixture.planWorktree), true)
    assert.equal(fs.existsSync(fixture.planDir), true)

    const deepPreview = runCleanup(fixture, { deep: true })
    assert.equal(deepPreview.destruction.eligible, false)
    assert.equal(deepPreview.destruction.blockers.some((item) => item.reason === "run-not-terminal"), true)
    assert.throws(() => runCleanup(fixture, { deep: true, dryRun: false }), /run-not-terminal/)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
    assert.equal(fs.existsSync(fixture.planDir), true)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("overlay DONE without a reachable proof is completion-proof-missing", () => {
  const fixture = setup({ planId: "006", readmeStatus: "TODO", writeProof: false })
  try {
    writeOverlay(fixture, { planId: "006", phase: "DONE", initialStatus: "TODO", runStatus: "complete" })
    const result = runCleanup(fixture, { deep: true })
    assert.equal(result.destruction.eligible, false)
    assert.equal(result.destruction.blockers.some((item) => item.reason === "completion-proof-missing" && item.plan === "006"), true)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
    assert.equal(fs.existsSync(fixture.planDir), true)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("deep cleanup removes refs, all owned branches/worktrees, and the plan directory last", () => {
  const fixture = setup()
  try {
    const preview = runCleanup(fixture, { deep: true })
    assert.equal(preview.destruction.eligible, true)
    const result = runCleanup(fixture, { deep: true, dryRun: false })
    assert.equal(result.destruction.integrationRemoved, true)
    assert.equal(result.destruction.planDirectoryRemoved, true)
    assert.equal(fs.existsSync(fixture.planDir), false)
    assert.equal(fs.existsSync(fixture.integrationWorktree), false)
    assert.equal(git(fixture.repo, "branch", "--list", fixture.integrationBranch), "")
    assert.equal(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

for (const blocker of ["dirty", "locked", "missing"] as const) {
  test(`deep cleanup is mutation-free when the integration worktree is ${blocker}`, () => {
    const fixture = setup()
    try {
      if (blocker === "dirty") fs.writeFileSync(path.join(fixture.integrationWorktree, "dirty.txt"), "dirty\n")
      else if (blocker === "locked") git(fixture.repo, "worktree", "lock", fixture.integrationWorktree)
      else fs.rmSync(fixture.integrationWorktree, { recursive: true, force: true })
      const result = runCleanup(fixture, { deep: true })
      assert.equal(result.destruction.eligible, false)
      assert.equal(result.destruction.blockers.some((item) => item.reason === `integration-worktree-${blocker}`), true)
      assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
      assert.equal(fs.existsSync(fixture.planDir), true)
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
  })
}

test("plain deep cleanup removes mixed DONE, BLOCKED, and REJECTED plan branches", () => {
  const fixture = setup()
  const extraBranches = ["herder/plans/002", "herder/plans/003"]
  try {
    const readme = path.join(fixture.planDir, "README.md")
    fs.writeFileSync(readme, fs.readFileSync(readme, "utf8")
      .replace("| [001](001-cleanup-fixture.md) | Cleanup fixture | P1 | S | — | DONE |", [
        "| [001](001-cleanup-fixture.md) | Cleanup fixture | P1 | S | — | DONE |",
        "| [002](002-cleanup-fixture.md) | Blocked fixture | P1 | S | — | BLOCKED: blocked by fixture coverage |",
        "| [003](003-cleanup-fixture.md) | Rejected fixture | P1 | S | — | REJECTED: rejected by fixture coverage |",
      ].join("\n")))
    fs.writeFileSync(path.join(fixture.planDir, "002-cleanup-fixture.md"), planBody().replaceAll("001", "002").replace("## Status\n", "## Status\n\nBlocked by fixture coverage.\n").replace("| DONE |", "| BLOCKED: blocked by fixture coverage |"))
    fs.writeFileSync(path.join(fixture.planDir, "003-cleanup-fixture.md"), planBody().replaceAll("001", "003").replace("## Status\n", "## Status\n\nRejected by fixture coverage.\n").replace("| DONE |", "| REJECTED: rejected by fixture coverage |"))
    git(fixture.repo, "add", "plans")
    git(fixture.repo, "commit", "-q", "-m", "test: add mixed terminal cleanup plans")
    for (const [index, branch] of extraBranches.entries()) {
      git(fixture.repo, "worktree", "add", "-q", "-b", branch, path.join(fixture.root, `mixed-${index}`), fixture.integrationBranch)
    }
    const result = runCleanup(fixture, { deep: true, dryRun: false })
    assert.equal(result.destruction.integrationRemoved, true)
    assert.deepEqual(result.removed.map((item) => item.branch).sort(), [fixture.planBranch, ...extraBranches].sort())
    for (const branch of [fixture.planBranch, ...extraBranches]) assert.equal(git(fixture.repo, "branch", "--list", branch), "")
    assert.equal(fs.existsSync(fixture.planDir), false)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

for (const invalidRef of ["base", "unindexed", "malformed-completion", "mismatched-completion", "unreachable-completion"] as const) {
  test(`deep cleanup rejects ${invalidRef} coordination evidence without mutation`, () => {
    const fixture = setup()
    const completionRef = "refs/plan-herder/plans/completed/001"
    const baseRef = "refs/plan-herder/plans/base"
    try {
      if (invalidRef === "base") {
        const invalid = git(fixture.repo, "commit-tree", git(fixture.repo, "rev-parse", "HEAD^{tree}"), "-m", "unrelated base")
        git(fixture.repo, "update-ref", baseRef, invalid, git(fixture.repo, "rev-parse", baseRef))
      } else if (invalidRef === "unindexed") {
        git(fixture.repo, "update-ref", "refs/plan-herder/plans/completed/999", git(fixture.repo, "rev-parse", "HEAD"))
      } else if (invalidRef === "malformed-completion") {
        git(fixture.repo, "update-ref", completionRef, git(fixture.repo, "rev-parse", "HEAD"))
      } else {
        git(fixture.repo, "update-ref", "-d", completionRef)
        const tree = git(fixture.repo, "rev-parse", "HEAD^{tree}")
        const object = invalidRef === "unreachable-completion"
          ? git(fixture.repo, "commit-tree", tree, "-m", "unreachable proof")
          : git(fixture.repo, "rev-parse", "HEAD")
        const proof = buildCompletionProofPayload({
          runId: "invalid-proof", planId: invalidRef === "mismatched-completion" ? "002" : "001", generation: 1, round: 1,
          reviewerActionId: "reviewer-001", decisionActionId: "reviewer-001", decisionRole: "plan-reviewer",
          assignmentSha256: "a".repeat(64), approvedBase: git(fixture.repo, "rev-parse", baseRef), approvedHead: object,
          approvedTree: tree, reviewResultSha256: "b".repeat(64), decisionResultSha256: "b".repeat(64), integratedHead: object,
        })
        writeCompletionProof(fixture.repo, completionRef, proof, "invalid-proof")
      }
      const beforeBranch = git(fixture.repo, "rev-parse", fixture.planBranch)
      assert.throws(() => runCleanup(fixture, { deep: true, dryRun: false }), /base-ref-not-reachable|coordination-ref-plan-not-indexed|completion-approval-proof-invalid|completion-ref-not-reachable/)
      assert.equal(git(fixture.repo, "rev-parse", fixture.planBranch), beforeBranch)
      assert.equal(fs.existsSync(fixture.planWorktree), true)
      assert.equal(fs.existsSync(fixture.planDir), true)
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
  })
}

test("deep cleanup rejects detached HEAD without mutation", () => {
  const fixture = setup()
  try {
    git(fixture.repo, "checkout", "-q", "--detach")
    const result = runCleanup(fixture, { deep: true })
    assert.equal(result.destruction.blockers.some((item) => item.reason === "detached-head"), true)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
    assert.equal(fs.existsSync(fixture.planDir), true)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("deep cleanup rejects a current branch that does not contain integration", () => {
  const fixture = setup()
  try {
    git(fixture.repo, "reset", "-q", "--hard", "refs/plan-herder/plans/base")
    const result = runCleanup(fixture, { deep: true })
    assert.equal(result.destruction.blockers.some((item) => item.reason === "integration-not-ancestor-of-current"), true)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
    assert.equal(fs.existsSync(fixture.planDir), true)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("deep cleanup reports a missing integration branch clearly", () => {
  const fixture = setup()
  try {
    git(fixture.repo, "worktree", "remove", fixture.integrationWorktree)
    git(fixture.repo, "update-ref", "-d", `refs/heads/${fixture.integrationBranch}`)
    assert.throws(() => runCleanup(fixture, { deep: true }), /Integration branch does not exist/)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
    assert.equal(fs.existsSync(fixture.planDir), true)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("deep cleanup rejects plan targeting", () => {
  const fixture = setup()
  try {
    assert.throws(() => runCleanup(fixture, { deep: true, plan: "001" }), /cannot be combined with --plan/)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

for (const race of ["checkout", "namespace", "coordination-ref"] as const) {
  test(`deep cleanup detects apply-time ${race} drift before mutation`, () => {
    const fixture = setup()
    try {
      const planHead = git(fixture.repo, "rev-parse", fixture.planBranch)
      const completionTarget = git(fixture.repo, "rev-parse", "refs/plan-herder/plans/completed/001")
      assert.throws(() => runCleanup(fixture, {
        deep: true,
        dryRun: false,
        testHooks: {
          beforeMutation: () => {
            if (race === "checkout") git(fixture.repo, "checkout", "-q", "-b", "race-checkout")
            else if (race === "namespace") git(fixture.repo, "branch", "herder/plans/999", "HEAD")
            else git(fixture.repo, "update-ref", "refs/plan-herder/plans/checkpoints/RUN/999", "HEAD")
          },
        },
      }), /current branch or HEAD changed|plan branch namespace changed|coordination refs changed/)
      assert.equal(git(fixture.repo, "rev-parse", fixture.planBranch), planHead)
      assert.equal(git(fixture.repo, "rev-parse", "refs/plan-herder/plans/completed/001"), completionTarget)
      assert.equal(fs.existsSync(fixture.planWorktree), true)
      assert.equal(fs.existsSync(fixture.planDir), true)
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
  })
}

test("deep cleanup detects apply-time run-status drift before mutation", () => {
  const fixture = setup({ readmeStatus: "TODO" })
  try {
    writeOverlay(fixture, { planId: "001", phase: "DONE", initialStatus: "TODO", runStatus: "complete" })
    const planHead = git(fixture.repo, "rev-parse", fixture.planBranch)
    assert.throws(() => runCleanup(fixture, {
      deep: true,
      dryRun: false,
      testHooks: {
        beforeMutation: () => {
          const store = new RunStore(fixture.planDir)
          store.updateRun({ status: "running" })
          store.close()
        },
      },
    }), /run-not-terminal|run status changed/)
    assert.equal(git(fixture.repo, "rev-parse", fixture.planBranch), planHead)
    assert.equal(fs.existsSync(fixture.planWorktree), true)
    assert.equal(fs.existsSync(fixture.planDir), true)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("force cleanup ignores pathless worktree records", () => {
  const fixture = setup()
  try {
    const result = withGitShim("nul", "herder/plans/999", () => forceCleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: false }))
    assert.equal(result.destruction.integrationRemoved, true)
    assert.equal(fs.existsSync(fixture.planWorktree), false)
    assert.equal(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("force cleanup projects unknown coordination refs as base and deletes them", () => {
  const fixture = setup()
  try {
    const target = git(fixture.repo, "rev-parse", "HEAD")
    const ref = "refs/plan-herder/plans/unknown/value"
    git(fixture.repo, "update-ref", ref, target, "")

    const preview = forceCleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: true })
    assert.deepEqual(preview.destruction.refsPlanned.filter((item) => item.ref === ref), [
      { ref, target, kind: "base" },
    ])

    const result = forceCleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: false })
    assert.deepEqual(result.destruction.refsRemoved.filter((item) => item.ref === ref), [
      { ref, target, kind: "base" },
    ])
    assert.notEqual(spawnSync("git", ["-C", fixture.repo, "show-ref", "--verify", ref], { encoding: "utf8" }).status, 0)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("force cleanup destroys a rewritten or incomplete namespace that deep cleanup would refuse", () => {
  const fixture = setup()
  try {
    fs.writeFileSync(path.join(fixture.planWorktree, "dirty.txt"), "dirty\n")
    git(fixture.repo, "worktree", "lock", "--reason", "test", fixture.planWorktree)
    git(fixture.repo, "reset", "-q", "--hard", "refs/plan-herder/plans/base")
    writeOverlay(fixture, { planId: "001", phase: "DONE", initialStatus: "TODO", runStatus: "needs_input" })
    const preview = forceCleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: true })
    assert.equal(preview.force, true)
    assert.equal(preview.destruction.eligible, true)
    const result = forceCleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: false })
    assert.equal(result.destruction.planDirectoryRemoved, true)
    assert.equal(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
    assert.equal(git(fixture.repo, "branch", "--list", fixture.integrationBranch), "")
    assert.equal(fs.existsSync(fixture.planWorktree), false)
    assert.equal(fs.existsSync(fixture.integrationWorktree), false)
    assert.equal(fs.existsSync(fixture.planDir), false)
    assert.notEqual(spawnSync("git", ["-C", fixture.repo, "show-ref", "--verify", "refs/plan-herder/plans/base"], { encoding: "utf8" }).status, 0)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("force cleanup refuses raw deletion of an external branch-matching worktree", () => {
  const fixture = setup()
  const branch = fixture.planBranch
  const externalWorktree = fixture.planWorktree
  try {
    git(fixture.repo, "worktree", "lock", "--reason", "test", externalWorktree)
    assert.throws(
      () => withGitShim("fail-remove", branch, () => forceCleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: false }), externalWorktree),
      (error: unknown) => error instanceof Error && error.message.includes(externalWorktree),
    )
    assert.equal(fs.existsSync(externalWorktree), true)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("force cleanup uses the bounded fallback for an in-root worktree", () => {
  const fixture = setup()
  const branch = "herder/plans/999"
  const canonicalRoot = path.join(fixture.planDir, ".herder", "worktrees")
  const inRootWorktree = path.join(canonicalRoot, "fallback")
  try {
    fs.mkdirSync(canonicalRoot, { recursive: true })
    git(fixture.repo, "worktree", "add", "-q", "-b", branch, inRootWorktree, fixture.integrationBranch)
    git(fixture.repo, "worktree", "lock", "--reason", "test", inRootWorktree)
    const result = withGitShim(
      "fail-remove",
      branch,
      () => forceCleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: false }),
      inRootWorktree,
    )
    assert.equal(result.destruction.planDirectoryRemoved, true)
    assert.equal(fs.existsSync(inRootWorktree), false)
    assert.equal(fs.existsSync(fixture.planDir), false)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("force cleanup refuses to delete the current Herder-owned checkout", () => {
  const fixture = setup()
  try {
    git(fixture.repo, "worktree", "remove", fixture.integrationWorktree)
    git(fixture.repo, "checkout", "-q", fixture.integrationBranch)
    const preview = forceCleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: true })
    assert.equal(preview.destruction.eligible, false)
    assert.equal(preview.destruction.blockers.some((item) => item.reason === "current-branch-is-owned"), true)
    assert.throws(() => forceCleanupRun({ repo: fixture.repo, planDir: fixture.planDir, dryRun: false }), /current-branch-is-owned/)
    assert.equal(fs.existsSync(fixture.planDir), true)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "")
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("cleanupRun rejects --force so the fail-closed path stays isolated", () => {
  const fixture = setup()
  try {
    assert.throws(() => runCleanup(fixture, { force: true }), /forceCleanupRun/)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

test("deep cleanup revalidates checkout immediately before integration deletion and removes the plan directory last", () => {
  const fixture = setup()
  try {
    assert.throws(() => runCleanup(fixture, {
      deep: true,
      dryRun: false,
      testHooks: {
        beforeIntegrationDeletion: () => {
          assert.equal(fs.existsSync(fixture.planDir), true)
          git(fixture.repo, "checkout", "-q", "-b", "late-race")
        },
      },
    }), /current branch or HEAD changed/)
    assert.notEqual(git(fixture.repo, "branch", "--list", fixture.integrationBranch), "")
    assert.equal(fs.existsSync(fixture.integrationWorktree), true)
    assert.equal(fs.existsSync(fixture.planDir), true)
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
})

// Ignore nested checkouts so ancestor cleanliness cannot mask containment bugs.
function prepareNestedCleanup(fixture: Fixture, canonical: boolean): void {
  fs.appendFileSync(path.join(fixture.repo, ".git", "info", "exclude"), "\n.herder/\nnested/\n")
  if (canonical) {
    const root = path.join(fixture.planDir, ".herder", "worktrees")
    fs.mkdirSync(root, { recursive: true })
    for (const key of ["planWorktree", "integrationWorktree"] as const) {
      const destination = path.join(root, key)
      git(fixture.repo, "worktree", "move", fixture[key], destination)
      fixture[key] = destination
    }
  }
}

function addBlockedPlan(fixture: Fixture, worktree: string): void {
  fs.appendFileSync(path.join(fixture.planDir, "README.md"), "| [002](002-cleanup-fixture.md) | Nested fixture | P1 | S | — | BLOCKED: fixture |\n")
  fs.writeFileSync(path.join(fixture.planDir, "002-cleanup-fixture.md"), planBody("002"))
  git(fixture.repo, "add", "plans/README.md", "plans/002-cleanup-fixture.md")
  git(fixture.repo, "commit", "-q", "-m", "test: index nested blocked plan")
  git(fixture.repo, "worktree", "add", "-q", "-b", "herder/plans/002", worktree, fixture.integrationBranch)
}

function fileEvidence(directory: string): Record<string, string> {
  const files: Record<string, string> = {}
  function visit(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory() && entry.name === ".git") continue
      const relative = path.relative(directory, absolute)
      files[relative] = entry.isDirectory() ? "directory" : fs.readFileSync(absolute).toString("hex")
      if (entry.isDirectory()) visit(absolute)
    }
  }
  visit(directory)
  return files
}

function cleanupEvidence(fixture: Fixture) {
  return {
    files: fileEvidence(fixture.root),
    registry: git(fixture.repo, "worktree", "list", "--porcelain"),
    refs: git(fixture.repo, "for-each-ref", "--format=%(refname) %(objectname)"),
    checkout: git(fixture.repo, "rev-parse", "HEAD"),
  }
}

function addUncheckedDescendant(fixture: Fixture, destination: string, kind: "detached" | "foreign", state: "clean" | "dirty" | "locked"): void {
  git(fixture.repo, "worktree", "add", "-q", ...(kind === "detached" ? ["--detach"] : ["-b", "foreign/descendant"]), destination, "HEAD")
  if (state === "dirty") fs.writeFileSync(path.join(destination, "base.txt"), "precious modified contents\n")
  if (state === "locked") git(fixture.repo, "worktree", "lock", "--reason", "precious locked checkout", destination)
}

for (const canonical of [false, true]) {
  for (const target of ["planDir", "planWorktree", "integrationWorktree"] as const) {
    for (const kind of ["detached", "foreign"] as const) {
      for (const state of ["clean", "dirty", "locked"] as const) {
        test(`deep cleanup preserves all evidence for ${canonical ? "canonical" : "external"} ${target} with ${state} ${kind} descendant`, () => {
          const fixture = setup()
          try {
            prepareNestedCleanup(fixture, canonical)
            writeOverlay(fixture, { planId: "001", phase: "DONE" })
            const descendant = path.join(fixture[target], "nested", "unchecked")
            addUncheckedDescendant(fixture, descendant, kind, state)
            const before = cleanupEvidence(fixture)
            const preview = runCleanup(fixture, { deep: true })
            assert.equal(preview.destruction.eligible, false)
            assert.deepEqual(cleanupEvidence(fixture), before, "preview mutated evidence")
            assert.throws(() => runCleanup(fixture, { deep: true, dryRun: false }), /worktree|descendant/i)
            assert.deepEqual(cleanupEvidence(fixture), before, "apply mutated evidence before refusing")
          } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
        })
      }
    }
  }
}

for (const state of ["dirty", "locked"] as const) {
  test(`deep cleanup preserves external DONE ancestor, ignored ${state} BLOCKED child, integration and foreign sibling`, () => {
    const fixture = setup()
    try {
      prepareNestedCleanup(fixture, false)
      const child = path.join(fixture.planWorktree, "nested", "002")
      addBlockedPlan(fixture, child)
      if (state === "dirty") fs.writeFileSync(path.join(child, "base.txt"), "blocked evidence\n")
      else git(fixture.repo, "worktree", "lock", child)
      const sibling = path.join(fixture.root, "worktrees", "foreign")
      addUncheckedDescendant(fixture, sibling, "foreign", "dirty")
      writeOverlay(fixture, { planId: "001", phase: "DONE" })
      assert.equal(git(fixture.planWorktree, "status", "--porcelain=v1", "--untracked-files=all"), "")
      const before = cleanupEvidence(fixture)
      const preview = runCleanup(fixture, { deep: true })
      assert.equal(preview.actions.some((item) => item.branch === fixture.planBranch), true)
      assert.equal(preview.destruction.eligible, false)
      assert.throws(() => runCleanup(fixture, { deep: true, dryRun: false }), /worktree|descendant|plan-branch-would-remain/i)
      assert.deepEqual(cleanupEvidence(fixture), before)
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
  })
}

for (const hook of ["beforeMutation", "beforeIntegrationDeletion"] as const) {
  for (const target of ["planDir", "planWorktree", "integrationWorktree"] as const) {
    test(`deep cleanup refuses late detached ${target} descendant at ${hook} before any mutation`, () => {
      const fixture = setup()
      try {
        prepareNestedCleanup(fixture, false)
        writeOverlay(fixture, { planId: "001", phase: "DONE" })
        assert.equal(runCleanup(fixture, { deep: true }).destruction.eligible, true)
        let injected: ReturnType<typeof cleanupEvidence> | undefined
        assert.throws(() => runCleanup(fixture, {
          deep: true, dryRun: false,
          testHooks: {
            [hook]: () => {
              addUncheckedDescendant(fixture, path.join(fixture[target], "nested", "late"), "detached", "clean")
              injected = cleanupEvidence(fixture)
            },
          },
        }), /worktree|descendant/i)
        assert.ok(injected, "race hook must run")
        assert.deepEqual(cleanupEvidence(fixture), injected)
      } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
    })
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

for (const target of ["planWorktree", "integrationWorktree", "planDir"] as const) {
  for (const kind of ["detached", "foreign"] as const) {
    test(`deep cleanup guards remaining ${target} against ${kind} after a post-preflight Git removal race`, () => {
      const fixture = setup()
      try {
        prepareNestedCleanup(fixture, false)
        const second = path.join(fixture.root, "worktrees", "002")
        addBlockedPlan(fixture, second)
        // The first removal is 001; inject into the still-pending 002, integration, or final directory.
        const ancestor = target === "planWorktree" ? second : fixture[target]
        const descendant = path.join(ancestor, "nested", "late")
        const marker = path.join(fixture.root, "injected")
        const originalPath = process.env.PATH ?? ""
        const beforeFiles = fileEvidence(ancestor)
        assert.equal(runCleanup(fixture, { deep: true }).destruction.eligible, true)
        assert.throws(() => withTemporaryExecutableOnPath({
          prefix: "herder-cleanup-late-descendant-",
          script: `#!/bin/sh
PATH=${shellQuote(originalPath)}; export PATH
case "$*" in
  *"worktree remove"*)
    if [ ! -f ${shellQuote(marker)} ]; then
      command git -C ${shellQuote(fixture.repo)} worktree add -q ${kind === "detached" ? "--detach" : "-b foreign/late"} ${shellQuote(descendant)} HEAD || exit 91
      printf 'injected' > ${shellQuote(marker)}
    fi ;;
esac
exec git "$@"
`,
        }, () => runCleanup(fixture, { deep: true, dryRun: false })), /worktree|descendant/i)
        assert.equal(fs.readFileSync(marker, "utf8"), "injected", "must inject after fresh preflight")
        assert.equal(fs.existsSync(fixture.planWorktree), false, "earlier legitimate removal should complete")
        const inventory = listWorktreeInventory(fixture.repo)
        assert.equal(inventory.some((item) => item.path === fs.realpathSync(descendant) && (kind === "detached" ? item.detached : item.branch === "foreign/late")), true)
        assert.equal(fs.readFileSync(path.join(descendant, "base.txt"), "utf8"), "base\n")
        assert.equal(git(descendant, "status", "--porcelain=v1", "--untracked-files=all"), "", "all injected checkout files remain intact")
        const afterFiles = fileEvidence(ancestor)
        for (const [file, contents] of Object.entries(beforeFiles)) assert.equal(afterFiles[file], contents, file)
        if (target !== "planDir") {
          assert.equal(inventory.some((item) => item.path === fs.realpathSync(ancestor)), true)
          assert.notEqual(git(fixture.repo, "branch", "--list", target === "planWorktree" ? "herder/plans/002" : fixture.integrationBranch), "")
        }
        assert.equal(fs.existsSync(fixture.planDir), true)
      } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
    })
  }
}

for (const canonical of [false, true]) {
  test(`deep cleanup refuses clean foreign sibling beneath ${canonical ? "canonical" : "external"} eligible ancestor before removing checked descendants`, () => {
    const fixture = setup()
    try {
      prepareNestedCleanup(fixture, canonical)
      const second = path.join(fixture.planWorktree, "nested", "002")
      addBlockedPlan(fixture, second)
      const integration = path.join(fixture.planWorktree, "nested", "integration")
      git(fixture.repo, "worktree", "move", fixture.integrationWorktree, integration)
      fixture.integrationWorktree = integration
      addUncheckedDescendant(fixture, path.join(fixture.planWorktree, "nested", "foreign"), "foreign", "clean")
      writeOverlay(fixture, { planId: "001", phase: "DONE" })
      for (const worktree of [fixture.planWorktree, second, integration]) {
        assert.equal(git(worktree, "status", "--porcelain=v1", "--untracked-files=all"), "")
      }
      const before = cleanupEvidence(fixture)
      const preview = runCleanup(fixture, { deep: true })
      assert.deepEqual(preview.actions.map((item) => item.branch).sort(), [fixture.planBranch, "herder/plans/002"])
      assert.equal(preview.destruction.eligible, false)
      assert.ok(preview.destruction.blockers.some((item) => item.reason === "unchecked-worktree-descendant"))
      assert.deepEqual(cleanupEvidence(fixture), before)
      assert.throws(() => runCleanup(fixture, { deep: true, dryRun: false }), /unchecked-worktree-descendant/)
      assert.deepEqual(cleanupEvidence(fixture), before)
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
  })

  test(`deep cleanup removes all-owned nested 002 and integration before ${canonical ? "canonical" : "external"} 001 and plan directory last`, () => {
    const fixture = setup()
    try {
      prepareNestedCleanup(fixture, canonical)
      const second = path.join(fixture.planWorktree, "nested", "002")
      addBlockedPlan(fixture, second)
      const integration = path.join(second, "nested", "integration")
      fs.mkdirSync(path.dirname(integration), { recursive: true })
      git(fixture.repo, "worktree", "move", fixture.integrationWorktree, integration)
      fixture.integrationWorktree = integration
      const sibling = path.join(fixture.root, "worktrees", "foreign")
      addUncheckedDescendant(fixture, sibling, "foreign", "dirty")
      const siblingFiles = fileEvidence(sibling)
      const siblingHead = git(sibling, "rev-parse", "HEAD")
      const expectedRemovalOrder = [integration, second, fixture.planWorktree].map((directory) => fs.realpathSync(directory))
      const removals = path.join(fixture.root, "removals")
      const originalPath = process.env.PATH ?? ""
      assert.equal(runCleanup(fixture, { deep: true }).destruction.eligible, true)
      const result = withTemporaryExecutableOnPath({
        prefix: "herder-cleanup-removal-order-",
        script: `#!/bin/sh
PATH=${shellQuote(originalPath)}; export PATH
case "$*" in
  *"worktree remove"*|*"update-ref -d"*)
    [ -d ${shellQuote(fixture.planDir)} ] || exit 92
    printf '%s\\n' "$*" >> ${shellQuote(removals)} ;;
esac
exec git "$@"
`,
      }, () => runCleanup(fixture, { deep: true, dryRun: false }))
      assert.equal(result.destruction.planDirectoryRemoved, true)
      assert.equal(result.destruction.integrationRemoved, true)
      assert.deepEqual(result.removed.map((item) => item.branch).sort(), [fixture.planBranch, "herder/plans/002"])
      const commands = fs.readFileSync(removals, "utf8").trim().split("\n")
      const removedPaths = commands.filter((line) => line.includes("worktree remove")).map((line) => line.split(" -- ")[1])
      assert.deepEqual(removedPaths, expectedRemovalOrder)
      const integrationBranchDeletion = commands.findIndex((line) => line.includes(`update-ref -d refs/heads/${fixture.integrationBranch} `))
      assert.ok(integrationBranchDeletion > commands.findLastIndex((line) => line.includes("worktree remove")), "integration branch deletion stays late")
      assert.equal(git(fixture.repo, "for-each-ref", "--format=%(refname)", "refs/heads/herder/plans/", "refs/plan-herder/plans/"), "")
      assert.deepEqual(listWorktreeInventory(fixture.repo).map((item) => item.path).sort(), [fs.realpathSync(fixture.repo), fs.realpathSync(sibling)].sort())
      for (const directory of [fixture.planDir, fixture.planWorktree, second, integration]) assert.equal(fs.existsSync(directory), false)
      assert.deepEqual(fileEvidence(sibling), siblingFiles)
      assert.equal(git(sibling, "rev-parse", "HEAD"), siblingHead)
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }) }
  })
}
