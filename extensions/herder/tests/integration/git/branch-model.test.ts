#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { buildCompletionProofPayload, writeCompletionProof } from "../../../src/daemon/git/completion-proof.ts"
import { cleanupRun } from "../../../src/daemon/git/cleanup-run.ts"
import { formatCheckpointRef } from "../../../src/daemon/git/coordination-ref.ts"
import { inspectNamespace } from "../../../src/daemon/git/namespace-run.ts"
import { projectStatuses } from "../../../src/core/plans.ts"

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
- **Kind**: behavioral
- **Parent objective**: Exercise the deterministic fixture lifecycle without changing user-owned state.

## Outcome and acceptance

Exercise one branch per plan.

| ID | Required behavior | Proof |
|---|---|---|
| A1 | One plan branch rebases, integrates, and cleans up without changing unrelated work. | V1 |

## Boundaries

**Write paths**
- \`plan.txt\`

**Out of scope**
- User checkout, unrelated files, and manager-owned state.

Git lifecycle only.

Preserve user-owned files and the existing fixture interfaces; review only the declared transition.

## Starting conditions

**Observed baseline**

No plan branch exists.

**Required starting state**

The stated fixture assumptions and direct interfaces still hold. Run the T1 probe before edits; report unavailable prerequisites without treating them as code defects.

**Expected dependency changes**

Dependencies: none.

## Implementation route

### Step 1: Test

Create one committed file.

Suggested route above implements A1; V1 is its acceptance proof. Binding decisions: retain the declared boundaries and direct interfaces.

## Verification

| ID | Phase | Criteria | Toolchain | Command | Expected |
|---|---|---|---|---|---|
| V1 | acceptance | A1 | T1 | \`npm run test:herder -- extensions/herder/tests/integration/git/branch-model.test.ts\` | exit 0; named fixture assertions preserve the documented lifecycle and safety behavior |

| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
|---|---|---|---|---|---|
| T1 | npm project scripts | . | Node >=22.19; repository locked dependencies installed | \`node --version\` | \`package.json\`; \`package-lock.json\` |

Use V1; a no-op command is not acceptance evidence.

## Escalation and handoff

Provides the bounded fixture transition. Safe intermediate state: unrelated files and manager state remain unchanged.

Stop on ambiguous Git state.

Environment or invocation failure: report the exact manager, command, cwd, error, and missing prerequisite; do not guess a substitute. Missing product authority requires a decision.

Deferred work: Keep the fixture deterministic.
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

  const cleaned = cleanupRun({
    repo,
    planDir,
    plan: "001",
    dryRun: false,
    includeFailed: false,
    deep: false,
  })
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
