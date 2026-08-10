#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parseWorktreeRecords } from "../../../src/daemon/git/cleanup-run.ts"
import { buildCompletionProofPayload, writeCompletionProof } from "../../../src/daemon/git/completion-proof.ts"
import { formatCheckpointRef } from "../../../src/daemon/git/coordination-ref.ts"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const cleanup = path.resolve(scriptDir, "../../../src/daemon/git/cleanup-run.ts")

type CommandOptions = { cwd?: string; allowFailure?: boolean; env?: NodeJS.ProcessEnv }

type CleanupAction = { branch: string; kind?: string; proof?: string }
type CleanupSkip = { branch: string; reason: string }
type CleanupJson = {
  planName: string
  integrationBranch: string
  actions: CleanupAction[]
  removed: CleanupAction[]
  preserved: { coordinationRefs: string | null; integrationBranch: string | null }
  skipped: CleanupSkip[]
  finalization: {
    eligible: boolean
    blockers: Array<{ reason: string; ref?: string }>
    refsPlanned: Array<{ ref: string; target: string; kind: string; plan?: string }>
  }
  handoff: { eligible: boolean; blockers: Array<{ reason: string }>; removed: boolean }
}

function run(command: string, args: string[], { cwd, allowFailure = false, env = process.env }: CommandOptions = {}): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

function git(repo: string, ...args: string[]): string {
  return run("git", ["-C", repo, ...args]).stdout.trim()
}

function planBody(id: string, title: string): string {
  return `# Plan ${id}: ${title}

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

Cleanup fixture.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

Cleanup fixture.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Use one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Test

Run the fixture.

## Test plan

Run the fixture test.

## Done criteria

- [ ] \`true\` exits 0.

## STOP conditions

Stop if the fixture changed.

## Maintenance notes

Keep the fixture small.
`
}

type PlanRow = { id: string; title: string; status: string }

function writePlans(repo: string, rows: PlanRow[]): string {
  const planDir = path.join(repo, "plans")
  fs.mkdirSync(planDir)
  const tableRows = rows.map(({ id, title, status }) => `| [${id}](${id}-${title.toLowerCase().replaceAll(" ", "-")}.md) | ${title} | P1 | S | — | ${status} |`)
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
${tableRows.join("\n")}
`)
  for (const { id, title } of rows) {
    fs.writeFileSync(path.join(planDir, `${id}-${title.toLowerCase().replaceAll(" ", "-")}.md`), planBody(id, title))
  }
  return planDir
}

function addWorktree(repo: string, root: string, branch: string, startPoint: string): string {
  git(repo, "branch", branch, startPoint)
  const worktree = path.join(root, branch.replaceAll("/", "-"))
  git(repo, "worktree", "add", "-q", worktree, branch)
  return worktree
}

function commitFile(worktree: string, name: string, contents: string, message: string): void {
  fs.writeFileSync(path.join(worktree, name), contents)
  git(worktree, "add", name)
  git(worktree, "commit", "-q", "-m", message)
}

function addCompletionProof(repo: string, ref: string, planId: string, commit: string) {
  const payload = buildCompletionProofPayload({
    runId: "cleanup-test",
    planId,
    generation: 1,
    round: 1,
    reviewerActionId: `reviewer-${planId}`,
    decisionActionId: `reviewer-${planId}`,
    decisionRole: "plan-reviewer",
    assignmentSha256: "a".repeat(64),
    approvedBase: commit,
    approvedHead: commit,
    approvedTree: git(repo, "rev-parse", `${commit}^{tree}`),
    reviewResultSha256: "b".repeat(64),
    decisionResultSha256: "b".repeat(64),
    integratedHead: commit,
  })
  return writeCompletionProof(repo, ref, payload, `herder-plans-${planId}-generation-1`)
}

type CleanupOptions = { allowFailure?: boolean; env?: NodeJS.ProcessEnv }

function cleanupResult(repo: string, planDir: string, extra: string[] = [], { allowFailure = false, env = process.env }: CleanupOptions = {}) {
  const result = run(process.execPath, [
    cleanup,
    "--repo", repo,
    "--plan-dir", planDir,
    "--pretty",
    ...extra,
  ], { cwd: repo, allowFailure, env })
  return {
    process: result,
    json: result.status === 0 ? JSON.parse(result.stdout) as CleanupJson : {} as CleanupJson,
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-cleanup-test-"))
test("cleanup preserves evidence and finalizes eligible namespaces", () => {
try {
  const removedRuntime = run(process.execPath, [
    cleanup,
    "--repo", root,
    "--plan-dir", root,
    "--runtime", "native",
  ], { allowFailure: true })
  assert.notEqual(removedRuntime.status, 0)
  assert.match(removedRuntime.stderr, /Unknown argument: --runtime/)

  const expectedWorktrees = [
    { path: "/tmp/one", branch: "main", locked: false },
    { path: "/tmp/two", branch: "topic", locked: true },
  ]
  assert.deepEqual(parseWorktreeRecords(
    "worktree /tmp/one\0HEAD abc\0branch refs/heads/main\0\0worktree /tmp/two\0HEAD def\0branch refs/heads/topic\0locked active\0\0",
    true,
  ), expectedWorktrees)
  assert.deepEqual(parseWorktreeRecords(
    "worktree /tmp/one\nHEAD abc\nbranch refs/heads/main\n\nworktree /tmp/two\nHEAD def\nbranch refs/heads/topic\nlocked active\n\n",
    false,
  ), expectedWorktrees)

  const repo = path.join(root, "repo")
  const worktrees = path.join(root, "worktrees")
  fs.mkdirSync(repo)
  fs.mkdirSync(worktrees)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Herder Cleanup Test")
  git(repo, "config", "user.email", "herder-cleanup@example.invalid")
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n")
  git(repo, "add", "base.txt")
  git(repo, "commit", "-q", "-m", "test: base")
  const initial = git(repo, "rev-parse", "HEAD")
  const planDir = writePlans(repo, [
    { id: "001", title: "Done", status: "DONE" },
    { id: "002", title: "Blocked", status: "BLOCKED — reviewer stopped" },
    { id: "003", title: "Proofless", status: "DONE" },
    { id: "004", title: "Dirty done", status: "DONE" },
    { id: "005", title: "Locked done", status: "DONE" },
  ])
  const integrationBranch = "herder/plans/integration"
  const integration = addWorktree(repo, worktrees, integrationBranch, initial)
  git(repo, "update-ref", "refs/plan-herder/plans/base", initial, "")

  const doneBranch = "herder/plans/001"
  const done = addWorktree(repo, worktrees, doneBranch, integrationBranch)
  commitFile(done, "done.txt", "done\n", "feat: add completed behavior")
  const completionCommit = git(done, "rev-parse", "HEAD")
  git(integration, "merge", "-q", "--ff-only", doneBranch)
  const completionRef = "refs/plan-herder/plans/completed/001"
  addCompletionProof(repo, completionRef, "001", completionCommit)
  assert.equal(git(integration, "rev-list", "--min-parents=2", `${initial}..HEAD`), "")
  assert.doesNotMatch(git(integration, "log", "--format=%B", `${initial}..HEAD`), /herder|plan[- ]?\d+/i)

  const blockedBranch = "herder/plans/002"
  const blocked = addWorktree(repo, worktrees, blockedBranch, integrationBranch)
  commitFile(blocked, "blocked.txt", "blocked\n", "test: preserve failed work")

  const prooflessBranch = "herder/plans/003"
  const proofless = addWorktree(repo, worktrees, prooflessBranch, integrationBranch)

  const dirtyDoneBranch = "herder/plans/004"
  const dirtyDone = addWorktree(repo, worktrees, dirtyDoneBranch, integrationBranch)
  addCompletionProof(repo, "refs/plan-herder/plans/completed/004", "004", git(dirtyDone, "rev-parse", "HEAD"))
  fs.writeFileSync(path.join(dirtyDone, "uncommitted.txt"), "preserve me\n")

  const lockedDoneBranch = "herder/plans/005"
  const lockedDone = addWorktree(repo, worktrees, lockedDoneBranch, integrationBranch)
  addCompletionProof(repo, "refs/plan-herder/plans/completed/005", "005", git(lockedDone, "rev-parse", "HEAD"))
  git(repo, "worktree", "lock", "--reason", "plan-herder:plans:005:reviewer-active", lockedDone)

  const unknownBranch = "herder/plans/manual"
  git(repo, "branch", unknownBranch, integrationBranch)

  const invalid = cleanupResult(repo, planDir, ["--plan-name", "Plans", "--dry-run"], { allowFailure: true })
  assert.notEqual(invalid.process.status, 0)
  assert.match(invalid.process.stderr, /lowercase Git-safe basename/)

  const preview = cleanupResult(repo, planDir, ["--dry-run"]).json
  assert.equal(preview.planName, "plans")
  assert.equal(preview.integrationBranch, integrationBranch)
  assert.deepEqual(preview.actions.map((item) => item.branch), [doneBranch])
  assert.equal(preview.actions[0].kind, "plan")
  assert.equal(preview.actions[0].proof, "ancestor")
  assert.equal(preview.removed.length, 0)
  assert.equal(preview.preserved.coordinationRefs, "refs/plan-herder/plans/")
  const skipped = (branch: string) => {
    const item = preview.skipped.find((candidate) => candidate.branch === branch)
    assert.ok(item)
    return item
  }
  assert.equal(skipped(blockedBranch).reason, "preserved-non-done-evidence")
  assert.equal(skipped(prooflessBranch).reason, "completion-proof-missing")
  assert.equal(skipped(dirtyDoneBranch).reason, "worktree-dirty")
  assert.equal(skipped(lockedDoneBranch).reason, "worktree-locked")
  assert.equal(skipped(unknownBranch).reason, "unrecognized-plan-branch")

  const scoped = cleanupResult(repo, planDir, ["--plan", "1", "--dry-run"]).json
  assert.deepEqual(scoped.actions.map((item) => item.branch), [doneBranch])

  const cleaned = cleanupResult(repo, planDir).json
  assert.deepEqual(cleaned.removed.map((item) => item.branch), [doneBranch])
  assert.equal(fs.existsSync(done), false)
  assert.equal(git(repo, "branch", "--list", doneBranch), "")
  assert.equal(git(repo, "rev-parse", `${completionRef}^{commit}`), completionCommit)
  assert.notEqual(git(repo, "branch", "--list", integrationBranch), "")

  const failedPreview = cleanupResult(repo, planDir, ["--include-failed", "--dry-run"]).json
  assert.deepEqual(failedPreview.actions.map((item) => item.branch), [blockedBranch])
  const failedCleanup = cleanupResult(repo, planDir, ["--include-failed"]).json
  assert.deepEqual(failedCleanup.removed.map((item) => item.branch), [blockedBranch])
  assert.equal(fs.existsSync(blocked), false)

  const currentCheckpointRef = formatCheckpointRef({
    planName: "plans",
    plan: "001",
    generation: "generation-1",
    ordinal: "1",
  }).ref
  git(repo, "update-ref", currentCheckpointRef, completionCommit, "")
  const blockedFinalization = cleanupResult(repo, planDir, ["--finalize", "--dry-run"]).json
  assert.equal(blockedFinalization.finalization.eligible, false)
  assert.equal(blockedFinalization.finalization.blockers.some((item) => item.reason === "plan-not-terminal"), true)
  assert.equal(blockedFinalization.finalization.blockers.some((item) => item.reason === "plan-branch-would-remain"), true)
  assert.equal(blockedFinalization.finalization.blockers.some((item) => item.reason === "unrecognized-coordination-ref"), false)
  assert.deepEqual(
    blockedFinalization.finalization.refsPlanned.find((item) => item.ref === currentCheckpointRef),
    { ref: currentCheckpointRef, target: completionCommit, kind: "checkpoint", plan: "001" },
  )
  assert.equal(git(repo, "rev-parse", currentCheckpointRef), completionCommit)
  assert.equal(fs.existsSync(proofless), true)

  const malformedCheckpointRef = "refs/plan-herder/plans/checkpoints/001/generation-x-001"
  git(repo, "update-ref", malformedCheckpointRef, completionCommit, "")
  const malformedFinalization = cleanupResult(repo, planDir, ["--finalize", "--dry-run"]).json
  assert.equal(
    malformedFinalization.finalization.blockers.some((item) => (
      item.reason === "unrecognized-coordination-ref" && item.ref === malformedCheckpointRef
    )),
    true,
  )
  assert.equal(git(repo, "rev-parse", malformedCheckpointRef), completionCommit)
  git(repo, "update-ref", "-d", malformedCheckpointRef, completionCommit)

  const finalRepo = path.join(root, "final-repo")
  const finalWorktrees = path.join(root, "final-worktrees")
  fs.mkdirSync(finalRepo)
  fs.mkdirSync(finalWorktrees)
  git(finalRepo, "init", "-q", "-b", "main")
  git(finalRepo, "config", "user.name", "Herder Finalize Test")
  git(finalRepo, "config", "user.email", "herder-finalize@example.invalid")
  fs.writeFileSync(path.join(finalRepo, "base.txt"), "base\n")
  git(finalRepo, "add", "base.txt")
  git(finalRepo, "commit", "-q", "-m", "test: base")
  const finalInitial = git(finalRepo, "rev-parse", "HEAD")
  const finalPlanDir = writePlans(finalRepo, [
    { id: "001", title: "Done", status: "DONE" },
    { id: "002", title: "Rejected", status: "REJECTED — superseded experiment" },
  ])
  const finalIntegrationBranch = "herder/plans/integration"
  const finalIntegration = addWorktree(finalRepo, finalWorktrees, finalIntegrationBranch, finalInitial)
  const finalBaseRef = "refs/plan-herder/plans/base"
  git(finalRepo, "update-ref", finalBaseRef, finalInitial, "")
  const finalDoneBranch = "herder/plans/001"
  const finalDone = addWorktree(finalRepo, finalWorktrees, finalDoneBranch, finalIntegrationBranch)
  commitFile(finalDone, "done.txt", "done\n", "feat: add completed behavior")
  git(finalIntegration, "merge", "-q", "--ff-only", finalDoneBranch)
  const finalCompletionCommit = git(finalIntegration, "rev-parse", "HEAD")
  const finalCompletionRef = "refs/plan-herder/plans/completed/001"
  const finalCompletion = addCompletionProof(finalRepo, finalCompletionRef, "001", finalCompletionCommit)
  const finalCheckpointRef = "refs/plan-herder/plans/checkpoints/001/0-1"
  git(finalRepo, "update-ref", finalCheckpointRef, finalCompletionCommit, "")
  const finalCurrentCheckpointRef = formatCheckpointRef({
    planName: "plans",
    plan: "001",
    generation: "generation-1",
    ordinal: "1",
  }).ref
  git(finalRepo, "update-ref", finalCurrentCheckpointRef, finalCompletionCommit, "")
  const finalRejectedBranch = "herder/plans/002"
  const finalRejected = addWorktree(finalRepo, finalWorktrees, finalRejectedBranch, finalIntegrationBranch)
  commitFile(finalRejected, "rejected.txt", "rejected\n", "test: retain rejected experiment")

  const finalizePreview = cleanupResult(finalRepo, finalPlanDir, ["--finalize", "--dry-run"]).json
  assert.equal(finalizePreview.finalization.eligible, true)
  assert.deepEqual(finalizePreview.actions.map((item) => item.branch).sort(), [finalDoneBranch, finalRejectedBranch].sort())
  assert.deepEqual(finalizePreview.finalization.refsPlanned, [
    { ref: finalBaseRef, target: finalInitial, kind: "base" },
    { ref: finalCheckpointRef, target: finalCompletionCommit, kind: "checkpoint", plan: "001" },
    { ref: finalCurrentCheckpointRef, target: finalCompletionCommit, kind: "checkpoint", plan: "001" },
    { ref: finalCompletionRef, target: finalCompletion.object, kind: "completed", plan: "001" },
  ])

  const finalized = cleanupResult(finalRepo, finalPlanDir, ["--finalize"]).json
  assert.equal(finalized.finalization.eligible, true)
  assert.equal(git(finalRepo, "branch", "--list", finalDoneBranch), "")
  assert.equal(git(finalRepo, "branch", "--list", finalRejectedBranch), "")
  assert.equal(fs.existsSync(finalDone), false)
  assert.equal(fs.existsSync(finalRejected), false)
  assert.equal(finalized.preserved.coordinationRefs, null)
  assert.notEqual(git(finalRepo, "branch", "--list", finalIntegrationBranch), "")

  const prematureHandoff = cleanupResult(finalRepo, finalPlanDir, ["--finalize", "--handoff-target", "main", "--dry-run"]).json
  assert.equal(prematureHandoff.handoff.eligible, false)
  assert.equal(prematureHandoff.handoff.blockers.some((item) => item.reason === "handoff-target-does-not-contain-integration"), true)

  git(finalRepo, "merge", "-q", "--ff-only", finalIntegrationBranch)
  const handoffCleanup = cleanupResult(finalRepo, finalPlanDir, ["--finalize", "--handoff-target", "main"]).json
  assert.equal(handoffCleanup.handoff.eligible, true)
  assert.equal(handoffCleanup.handoff.removed, true)
  assert.equal(handoffCleanup.preserved.integrationBranch, null)
  assert.equal(git(finalRepo, "branch", "--list", finalIntegrationBranch), "")
  assert.equal(fs.existsSync(finalIntegration), false)

  console.log("herder Fire cleanup tests passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
})
