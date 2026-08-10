#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { buildCompletionProofPayload, writeCompletionProof } from "../../../src/daemon/git/completion-proof.ts"
import { formatCheckpointRef } from "../../../src/daemon/git/coordination-ref.ts"
import { inspectNamespace } from "../../../src/daemon/git/namespace-run.ts"
import { projectStatuses } from "../../../src/core/plans.ts"

const cleanup = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/daemon/git/cleanup-run.ts")

function run(command: string, args: string[], { cwd, input, allowFailure = false }: { cwd?: string; input?: string; allowFailure?: boolean } = {}) {
  const result = spawnSync(command, args, { cwd, input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

function git(repo: string, ...args: string[]): string {
  return run("git", ["-C", repo, ...args]).stdout.trim()
}

function planBody(): string {
  return `# Plan 001: Branch model

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-07-19

## Why this matters

Exercise one branch per plan.

## Current state

No plan branch exists.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

Git lifecycle only.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Use one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Test

Create one committed file.

## Test plan

Run \`true\`.

## Done criteria

- [ ] \`true\` exits 0.

## STOP conditions

Stop on ambiguous Git state.

## Maintenance notes

Keep the fixture deterministic.
`
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-branch-model-test-"))
test("plan branches rebase, integrate, and clean up deterministically", () => {
try {
  const repo = path.join(root, "repo")
  const worktreeRoot = path.join(root, "worktrees", "plans")
  const planDir = path.join(repo, "plans")
  fs.mkdirSync(repo)
  fs.mkdirSync(worktreeRoot, { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Herder Branch Model Test")
  git(repo, "config", "user.email", "herder-branch-model@example.invalid")
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n")
  git(repo, "add", "base.txt")
  git(repo, "commit", "-q", "-m", "test: base")
  const base = git(repo, "rev-parse", "HEAD")

  fs.mkdirSync(planDir)
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-branch-model.md) | Branch model | P1 | S | — | TODO |
`)
  fs.writeFileSync(path.join(planDir, "001-branch-model.md"), planBody())

  const fresh = inspectNamespace({ repo, planDir, mode: "fire" })
  assert.equal(fresh.ok, true)
  const integrationBranch = fresh.integrationBranch
  const baseRef = "refs/plan-herder/plans/base"
  run("git", ["-C", repo, "update-ref", "--stdin"], {
    input: `start\ncreate ${baseRef} ${base}\ncreate refs/heads/${integrationBranch} ${base}\nprepare\ncommit\n`,
  })

  const integrationWorktree = path.join(worktreeRoot, "integration")
  git(repo, "worktree", "add", "-q", integrationWorktree, integrationBranch)

  const planBranch = "herder/plans/001"
  git(repo, "update-ref", `refs/heads/${planBranch}`, base, "")
  const planWorktree = path.join(worktreeRoot, "001")
  git(repo, "worktree", "add", "-q", planWorktree, planBranch)
  projectStatuses(planDir, [{ id: "001", status: "IN PROGRESS" }])

  fs.writeFileSync(path.join(planWorktree, "plan.txt"), "plan change\n")
  git(planWorktree, "add", "plan.txt")
  git(planWorktree, "commit", "-q", "-m", "feat: add plan behavior")
  const preRestackHead = git(planWorktree, "rev-parse", "HEAD")

  fs.writeFileSync(path.join(integrationWorktree, "independent.txt"), "independent\n")
  git(integrationWorktree, "add", "independent.txt")
  git(integrationWorktree, "commit", "-q", "-m", "feat: integrate independent behavior")
  const restackBase = git(integrationWorktree, "rev-parse", "HEAD")

  const checkpointRef = formatCheckpointRef({
    planName: "plans",
    plan: "001",
    generation: "generation-1",
    ordinal: "1",
  }).ref
  git(repo, "update-ref", checkpointRef, preRestackHead, "")
  git(planWorktree, "rebase", "--onto", restackBase, base, planBranch)
  const reviewedHead = git(planWorktree, "rev-parse", "HEAD")
  const reviewedTree = git(planWorktree, "rev-parse", "HEAD^{tree}")
  assert.notEqual(reviewedHead, preRestackHead)
  assert.equal(git(planWorktree, "status", "--porcelain=v1", "--untracked-files=all"), "")
  assert.match(git(repo, "cherry", reviewedHead, preRestackHead), /^- [0-9a-f]+$/)
  assert.equal(git(repo, "rev-list", "--min-parents=2", `${restackBase}..${reviewedHead}`), "")

  const branchesBeforeIntegration = git(repo, "branch", "--list", "herder/plans/*", "--format=%(refname:short)").split(/\r?\n/).filter(Boolean).sort()
  assert.deepEqual(branchesBeforeIntegration, [integrationBranch, planBranch].sort())

  assert.equal(git(integrationWorktree, "rev-parse", "HEAD"), restackBase)
  assert.equal(git(planWorktree, "rev-parse", "HEAD"), reviewedHead)
  assert.equal(git(planWorktree, "rev-parse", "HEAD^{tree}"), reviewedTree)
  git(integrationWorktree, "merge", "-q", "--ff-only", planBranch)
  assert.equal(git(integrationWorktree, "rev-parse", "HEAD"), reviewedHead)
  assert.equal(git(repo, "rev-list", "--min-parents=2", `${base}..${integrationBranch}`), "")

  const completionRef = "refs/plan-herder/plans/completed/001"
  writeCompletionProof(repo, completionRef, buildCompletionProofPayload({
    runId: "branch-model-test",
    planId: "001",
    generation: 1,
    round: 1,
    reviewerActionId: "reviewer-001",
    decisionActionId: "reviewer-001",
    decisionRole: "plan-reviewer",
    assignmentSha256: "a".repeat(64),
    approvedBase: base,
    approvedHead: reviewedHead,
    approvedTree: reviewedTree,
    reviewResultSha256: "b".repeat(64),
    decisionResultSha256: "b".repeat(64),
    integratedHead: reviewedHead,
  }), "herder-plans-001-generation-1")
  projectStatuses(planDir, [{ id: "001", status: "DONE" }])

  const resumed = inspectNamespace({ repo, planDir, mode: "resume" })
  assert.equal(resumed.ok, true)
  assert.deepEqual(resumed.planBranches.map((item) => item.branch), [planBranch])
  assert.equal(resumed.coordinationRefs.some((item) => item.ref === checkpointRef), true)
  assert.equal(resumed.coordinationRefs.some((item) => item.ref === completionRef), true)

  const cleanupResult = run(process.execPath, [
    cleanup,
    "--repo", repo,
    "--plan-dir", planDir,
    "--plan", "001",
    "--pretty",
  ], { cwd: repo })
  const cleaned = JSON.parse(cleanupResult.stdout) as { removed: Array<{ branch: string }> }
  assert.deepEqual(cleaned.removed.map((item) => item.branch), [planBranch])
  assert.equal(git(repo, "branch", "--list", planBranch), "")
  assert.notEqual(git(repo, "branch", "--list", integrationBranch), "")
  assert.equal(git(repo, "rev-parse", checkpointRef), preRestackHead)
  assert.equal(git(repo, "rev-parse", `${completionRef}^{commit}`), reviewedHead)

  const resumedAfterCleanup = inspectNamespace({ repo, planDir, mode: "resume" })
  assert.equal(resumedAfterCleanup.ok, true)
  assert.deepEqual(resumedAfterCleanup.planBranches, [])

  const conflictingFresh = inspectNamespace({ repo, planDir, mode: "fire" })
  assert.equal(conflictingFresh.ok, false)
  assert.equal(conflictingFresh.reason, "namespace-conflict")

  console.log("herder Fire single-branch lifecycle tests passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
})
