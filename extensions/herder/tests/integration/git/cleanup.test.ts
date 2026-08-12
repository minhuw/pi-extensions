#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { cleanupRun, parseWorktreeRecords } from "../../../src/daemon/git/cleanup-run.ts"
import { buildCompletionProofPayload, writeCompletionProof } from "../../../src/daemon/git/completion-proof.ts"

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function planBody(): string {
  return `# Plan 001: Cleanup fixture

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

Use the assigned branch.

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

function setup(): Fixture {
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
| [001](001-cleanup-fixture.md) | Cleanup fixture | P1 | S | — | DONE |
`)
  fs.writeFileSync(path.join(planDir, "001-cleanup-fixture.md"), planBody())
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "test: initialize cleanup fixture")
  const base = git(repo, "rev-parse", "HEAD")
  const integrationBranch = "herder/plans/integration"
  const planBranch = "herder/plans/001"
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
  const proof = buildCompletionProofPayload({
    runId: "cleanup-test", planId: "001", generation: 1, round: 1,
    reviewerActionId: "reviewer-001", decisionActionId: "reviewer-001", decisionRole: "plan-reviewer",
    assignmentSha256: "a".repeat(64), approvedBase: base, approvedHead: completed,
    approvedTree: git(repo, "rev-parse", `${completed}^{tree}`), reviewResultSha256: "b".repeat(64),
    decisionResultSha256: "b".repeat(64), integratedHead: completed,
  })
  writeCompletionProof(repo, "refs/plan-herder/plans/completed/001", proof, "cleanup-test-proof")
  return { root, repo, planDir, planBranch, planWorktree, integrationBranch, integrationWorktree }
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
