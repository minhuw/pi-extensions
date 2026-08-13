#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { cleanupRun, parseWorktreeRecords } from "../../../src/daemon/git/cleanup-run.ts"
import { buildCompletionProofPayload, writeCompletionProof } from "../../../src/daemon/git/completion-proof.ts"
import { RunStore, type StoredPlan, type StoredPlanSpec } from "../../../src/daemon/run-store.ts"

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
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

## Why this matters

Cleanup fixture.

## Current state

Complete.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

Cleanup fixture.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.

## Steps

### Step 1: Test

Run the fixture.

## Test plan

Run the fixture test.

## Done criteria

- [x] Complete.

## STOP conditions

Stop on unsafe cleanup.

## Maintenance notes

Keep small.
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
    gateCommands: [],
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

test("worktree parser handles modern and legacy porcelain", () => {
  const modern = "worktree /tmp/one\0HEAD abc\0branch refs/heads/main\0\0worktree /tmp/two\0HEAD def\0detached\0locked reason\0\0"
  assert.deepEqual(parseWorktreeRecords(modern, true), [
    { path: "/tmp/one", branch: "main", locked: false },
    { path: "/tmp/two", branch: "", locked: true },
  ])
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
