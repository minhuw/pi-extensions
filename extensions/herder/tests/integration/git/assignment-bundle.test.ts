#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { initPlanDir, snapshotPlan } from "../../../src/core/plans.ts"
import { inspectActiveRebase, materializeAssignment, verifyAssignment } from "../../../src/daemon/git/assignment-bundle.ts"
import { formatCheckpointRef } from "../../../src/daemon/git/coordination-ref.ts"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-assignment-test-"))

type AssignmentResult = {
  ok: boolean
  scope: string
  branch: string
  relativePath: string
  bundlePath: string
  bundleSha256: string
  snapshotSha256: string
  verificationMode: string
  workerMode: string
  detachedHead: string
  rebaseOnto: string
  rebaseOrigHead: string
  planHead: string
  checkpointRef: string
  checkpoint: string
  rebaseStateSha256: string
  conflicts: string[]
  error: string
  [key: string]: unknown
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function assignment(call: () => unknown): AssignmentResult {
  return call() as AssignmentResult
}

function planBody(): string {
  return `# Plan 001: Keep assignment context local

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: orchestration
- **Planned at**: commit \`abc1234\`, 2026-07-28
- **Kind**: behavioral
- **Parent objective**: Keep every worker inside its assigned worktree

## Why this matters

Workers need the exact assigned plan without reading the coordinator checkout.

## Current state

The coordinator owns the source backlog.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`node --test\` | exit 0 |

## Scope

**In scope** (declared write paths):
- \`src/worker.mjs\`

**Out of scope**:
- The source plan directory.

## Dependency contract

Consumes the immutable assignment and changes no coordination state.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Use one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Read the assignment

Use the local immutable bundle.

## Test plan

Run \`node --test\`.

## Review map

- Outcome: the worker remains in its worktree.
- Modified symbols: \`src/worker.mjs\`.
- Proof: \`node --test\`.
- Expected unchanged behavior: coordination files remain unchanged.
- Expected diff: the worker module and its direct tests.

## Done criteria

- [ ] The local assignment is available.

## STOP conditions

Stop if the assignment hash changes.

## Maintenance notes

Keep assignment transport deterministic.
`
}

function writePlan(planDir: string): void {
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-local-assignment.md) | Keep assignment context local | P1 | S | — | TODO |
`)
  fs.writeFileSync(path.join(planDir, "001-local-assignment.md"), planBody())
}

function createFixture(name: string, { track }: { track: boolean }) {
  const repo = path.join(root, name)
  const worktree = path.join(root, `${name}-worktree`)
  fs.mkdirSync(repo)
  git(repo, "init", "-q")
  git(repo, "config", "user.name", "Herder Test")
  git(repo, "config", "user.email", "herder@example.invalid")
  fs.mkdirSync(path.join(repo, "src"))
  fs.writeFileSync(path.join(repo, "src", "worker.mjs"), "export const ready = true\n")
  const planDir = path.join(repo, "herder-plans")
  initPlanDir(planDir, { track })
  writePlan(planDir)
  git(repo, "add", "src/worker.mjs")
  if (track) git(repo, "add", "herder-plans")
  git(repo, "commit", "-qm", "Initial fixture")
  const head = git(repo, "rev-parse", "HEAD")
  const branch = `herder/${name}/001`
  git(repo, "worktree", "add", "-q", "-b", branch, worktree, head)
  return { repo, worktree, planDir, head, branch, snapshot: snapshotPlan(planDir, "001") }
}

test("assignment bundles remain immutable and worktree-bound", () => {
try {
  for (const track of [false, true]) {
    const name = track ? "tracked" : "local"
    const fixture = createFixture(name, { track })
    const materialized = assignment(() => materializeAssignment({
      plan: "001",
      planDir: fixture.planDir,
      worktree: fixture.worktree,
      expectedBranch: fixture.branch,
      expectedHead: fixture.head,
      expectedSnapshotSha256: fixture.snapshot.snapshotSha256,
    }))

    assert.equal(materialized.ok, true)
    assert.equal(materialized.scope, "001")
    assert.equal(materialized.branch, fixture.branch)
    assert.equal(materialized.relativePath, "herder-plans/.herder/assignment.json")
    assert.equal(git(fixture.worktree, "status", "--porcelain=v1", "--untracked-files=all"), "")
    assert.match(
      git(fixture.worktree, "check-ignore", "-v", "--no-index", "--", materialized.relativePath),
      track ? /\.gitignore:.*\.herder\// : /info\/exclude:.*\/herder-plans\//,
    )

    const bundleBytes = fs.readFileSync(materialized.bundlePath)
    const bundle = JSON.parse(bundleBytes.toString("utf8"))
    assert.equal(bundle.schemaVersion, 1)
    assert.equal(bundle.kind, "herder-plan-assignment")
    assert.equal(bundle.plan.id, "001")
    assert.equal(bundle.plan.title, "Keep assignment context local")
    assert.equal(Object.hasOwn(bundle.plan, "reviewBudget"), false)
    assert.equal(bundle.planText, fixture.snapshot.planText)
    assert.equal(bundle.snapshotSha256, fixture.snapshot.snapshotSha256)
    assert.equal(bundle.assignment.branch, fixture.branch)
    assert.equal(bundle.assignment.generationBase, fixture.head)
    assert.equal(bundle.snapshotInputs.some((input: Record<string, unknown>) => Object.hasOwn(input, "file")), false)
    assert.equal(bundleBytes.includes(Buffer.from(fixture.repo)), false)
    assert.equal(fs.statSync(materialized.bundlePath).mode & 0o222, 0)

    const rematerialized = assignment(() => materializeAssignment({
      plan: "001",
      planDir: fixture.planDir,
      worktree: fixture.worktree,
      expectedBranch: fixture.branch,
      expectedHead: fixture.head,
      expectedSnapshotSha256: fixture.snapshot.snapshotSha256,
    }))
    assert.equal(rematerialized.bundleSha256, materialized.bundleSha256)

    const verified = assignment(() => verifyAssignment({
      worktree: fixture.worktree,
      bundle: materialized.bundlePath,
      expectedBundleSha256: materialized.bundleSha256,
    }))
    assert.equal(verified.ok, true)
    assert.equal(verified.scope, "001")
    assert.equal(verified.bundleSha256, materialized.bundleSha256)

    const runMaterialized = assignment(() => materializeAssignment({
      planDir: fixture.planDir,
      worktree: fixture.worktree,
      expectedBranch: fixture.branch,
      expectedHead: fixture.head,
    }, { run: true }))
    assert.equal(runMaterialized.scope, "RUN")
    assert.equal(runMaterialized.relativePath, "herder-plans/.herder/run-assignment-generation-1.json")
    const runBundle = JSON.parse(fs.readFileSync(runMaterialized.bundlePath, "utf8"))
    assert.equal(runBundle.kind, "herder-run-assignment")
    assert.equal(runBundle.assignment.graphGeneration, 1)
    assert.equal(runBundle.plans.length, 1)
    assert.equal(runBundle.plans[0].plan.id, "001")
    assert.equal(runBundle.plans[0].planText, fixture.snapshot.planText)
    assert.equal(JSON.stringify(runBundle).includes(fixture.repo), false)
    const runVerified = assignment(() => verifyAssignment({
      worktree: fixture.worktree,
      bundle: runMaterialized.bundlePath,
      expectedBundleSha256: runMaterialized.bundleSha256,
    }))
    assert.equal(runVerified.scope, "RUN")
    assert.equal(runVerified.snapshotSha256, runMaterialized.snapshotSha256)

    const runRematerialized = assignment(() => materializeAssignment({
      planDir: fixture.planDir,
      worktree: fixture.worktree,
      expectedBranch: fixture.branch,
      expectedHead: fixture.head,
    }, { run: true }))
    assert.equal(runRematerialized.bundleSha256, runMaterialized.bundleSha256)

    fs.chmodSync(materialized.bundlePath, 0o644)
    fs.appendFileSync(materialized.bundlePath, " ")
    fs.chmodSync(materialized.bundlePath, 0o444)
    assert.throws(() => verifyAssignment({
      worktree: fixture.worktree,
      bundle: materialized.bundlePath,
      expectedBundleSha256: materialized.bundleSha256,
    }), /hash mismatch/)

    fs.chmodSync(materialized.bundlePath, 0o644)
    fs.writeFileSync(materialized.bundlePath, bundleBytes)
    fs.chmodSync(materialized.bundlePath, 0o444)
    git(fixture.worktree, "switch", "-q", "-c", `${fixture.branch}-wrong`)
    assert.throws(() => verifyAssignment({
      worktree: fixture.worktree,
      bundle: materialized.bundlePath,
      expectedBundleSha256: materialized.bundleSha256,
    }), /assignment branch mismatch/)
  }

  const stale = createFixture("stale", { track: false })
  const staleSnapshot = `${"0".repeat(63)}1`
  assert.notEqual(staleSnapshot, stale.snapshot.snapshotSha256)
  assert.throws(() => materializeAssignment({
    plan: "001",
    planDir: stale.planDir,
    worktree: stale.worktree,
    expectedBranch: stale.branch,
    expectedHead: stale.head,
    expectedSnapshotSha256: staleSnapshot,
  }), /plan snapshot mismatch/)
  assert.equal(fs.existsSync(path.join(stale.worktree, "herder-plans", ".herder", "assignment.json")), false)

  const symlinked = createFixture("symlinked", { track: false })
  const outside = path.join(root, "outside")
  fs.mkdirSync(outside)
  fs.mkdirSync(path.join(symlinked.worktree, "herder-plans"))
  fs.symlinkSync(outside, path.join(symlinked.worktree, "herder-plans", ".herder"))
  assert.throws(() => materializeAssignment({
    plan: "001",
    planDir: symlinked.planDir,
    worktree: symlinked.worktree,
    expectedBranch: symlinked.branch,
    expectedHead: symlinked.head,
    expectedSnapshotSha256: symlinked.snapshot.snapshotSha256,
  }), /contains a symlink/)
  assert.equal(fs.readdirSync(outside).length, 0)

  const unignoredRepo = path.join(root, "unignored")
  const unignoredWorktree = path.join(root, "unignored-worktree")
  fs.mkdirSync(unignoredRepo)
  git(unignoredRepo, "init", "-q")
  git(unignoredRepo, "config", "user.name", "Herder Test")
  git(unignoredRepo, "config", "user.email", "herder@example.invalid")
  fs.writeFileSync(path.join(unignoredRepo, "tracked.txt"), "base\n")
  const unignoredPlanDir = path.join(unignoredRepo, "herder-plans")
  fs.mkdirSync(unignoredPlanDir)
  writePlan(unignoredPlanDir)
  git(unignoredRepo, "add", "tracked.txt")
  git(unignoredRepo, "commit", "-qm", "Initial fixture")
  const unignoredHead = git(unignoredRepo, "rev-parse", "HEAD")
  const unignoredBranch = "herder/unignored/001"
  git(unignoredRepo, "worktree", "add", "-q", "-b", unignoredBranch, unignoredWorktree, unignoredHead)
  const unignoredSnapshot = snapshotPlan(unignoredPlanDir, "001")
  assert.throws(() => materializeAssignment({
    plan: "001",
    planDir: unignoredPlanDir,
    worktree: unignoredWorktree,
    expectedBranch: unignoredBranch,
    expectedHead: unignoredHead,
    expectedSnapshotSha256: unignoredSnapshot.snapshotSha256,
  }), /must be Git-ignored/)

  const rebase = createFixture("rebase", { track: false })
  const rebaseAssignment = assignment(() => materializeAssignment({
    plan: "001",
    planDir: rebase.planDir,
    worktree: rebase.worktree,
    expectedBranch: rebase.branch,
    expectedHead: rebase.head,
    expectedSnapshotSha256: rebase.snapshot.snapshotSha256,
  }))
  fs.writeFileSync(path.join(rebase.worktree, "src", "worker.mjs"), "export const ready = 'plan'\n")
  git(rebase.worktree, "add", "src/worker.mjs")
  git(rebase.worktree, "commit", "-qm", "Implement plan change")
  const planHead = git(rebase.worktree, "rev-parse", "HEAD")
  const checkpointRef = formatCheckpointRef({
    planName: "rebase",
    plan: "001",
    generation: "generation-1",
    ordinal: "1",
  }).ref
  git(rebase.repo, "update-ref", checkpointRef, planHead, "")

  fs.writeFileSync(path.join(rebase.repo, "src", "worker.mjs"), "export const ready = 'integration'\n")
  git(rebase.repo, "add", "src/worker.mjs")
  git(rebase.repo, "commit", "-qm", "Advance integration")
  const onto = git(rebase.repo, "rev-parse", "HEAD")
  const rebaseResult = spawnSync("git", ["-C", rebase.worktree, "rebase", "--onto", onto, rebase.head], { encoding: "utf8" })
  assert.equal(rebaseResult.status, 1, "fixture rebase must stop on a conflict")
  assert.match(rebaseResult.stderr, /conflict|could not apply/i)
  const detachedHead = git(rebase.worktree, "rev-parse", "HEAD")
  const leaseReason = "plan-herder:rebase:001:Implementer:attempt-5:guided-repair"
  git(rebase.repo, "worktree", "lock", "--reason", leaseReason, rebase.worktree)

  const activeOptions = {
    worktree: rebase.worktree,
    bundle: rebaseAssignment.bundlePath,
    expectedBundleSha256: rebaseAssignment.bundleSha256,
    expectedWorktree: fs.realpathSync(rebase.worktree),
    expectedBranch: rebase.branch,
    expectedWorkerMode: "GUIDED_REPAIR",
    expectedDetachedHead: detachedHead,
    expectedRebaseOnto: onto,
    expectedRebaseOrigHead: planHead,
    expectedPlanHead: planHead,
    expectedCheckpointRef: checkpointRef,
    expectedCheckpoint: planHead,
    expectedLeaseReason: leaseReason,
  }
  const inspected = assignment(() => inspectActiveRebase(activeOptions))
  assert.equal(inspected.verificationMode, "active-rebase")
  assert.equal(inspected.workerMode, "GUIDED_REPAIR")
  assert.equal(inspected.branch, rebase.branch)
  assert.equal(inspected.detachedHead, detachedHead)
  assert.equal(inspected.rebaseOnto, onto)
  assert.equal(inspected.rebaseOrigHead, planHead)
  assert.equal(inspected.planHead, planHead)
  assert.equal(inspected.checkpointRef, checkpointRef)
  assert.equal(inspected.checkpoint, planHead)
  assert.deepEqual(inspected.conflicts, ["src/worker.mjs"])
  assert.match(inspected.rebaseStateSha256, /^[0-9a-f]{64}$/)

  const activeVerified = assignment(() => verifyAssignment({
    verificationMode: "active-rebase",
    ...activeOptions,
    expectedRebaseStateSha256: inspected.rebaseStateSha256,
  }))
  assert.equal(activeVerified.ok, true)
  assert.equal(activeVerified.verificationMode, "active-rebase")
  assert.equal(activeVerified.rebaseStateSha256, inspected.rebaseStateSha256)

  assert.throws(() => verifyAssignment({
    worktree: rebase.worktree,
    bundle: rebaseAssignment.bundlePath,
    expectedBundleSha256: rebaseAssignment.bundleSha256,
  }), /checked-out branch/)

  assert.throws(() => inspectActiveRebase({ ...activeOptions, expectedWorktree: fs.realpathSync(rebase.repo) }), /worktree mismatch/)
  assert.throws(() => inspectActiveRebase({ ...activeOptions, expectedRebaseOnto: rebase.head }), /onto mismatch/)
  assert.throws(() => inspectActiveRebase({ ...activeOptions, expectedCheckpoint: rebase.head }), /checkpoint.*same pre-restack commit/)
  assert.throws(() => inspectActiveRebase({ ...activeOptions, expectedBundleSha256: "0".repeat(64) }), /hash mismatch/)

  const metadataDir = path.resolve(rebase.worktree, git(rebase.worktree, "rev-parse", "--git-path", "rebase-merge"))
  const headNamePath = path.join(metadataDir, "head-name")
  const headName = fs.readFileSync(headNamePath)
  fs.writeFileSync(headNamePath, "refs/heads/herder/rebase/wrong\n")
  assert.throws(() => inspectActiveRebase(activeOptions), /head-name mismatch/)
  fs.writeFileSync(headNamePath, headName)

  git(rebase.repo, "update-ref", `refs/heads/${rebase.branch}`, onto, planHead)
  assert.throws(() => inspectActiveRebase(activeOptions), /plan branch moved/)
  git(rebase.repo, "update-ref", `refs/heads/${rebase.branch}`, planHead, onto)

  const unrelated = createFixture("unrelated-detached", { track: false })
  const unrelatedAssignment = assignment(() => materializeAssignment({
    plan: "001",
    planDir: unrelated.planDir,
    worktree: unrelated.worktree,
    expectedBranch: unrelated.branch,
    expectedHead: unrelated.head,
    expectedSnapshotSha256: unrelated.snapshot.snapshotSha256,
  }))
  const unrelatedCheckpoint = "refs/plan-herder/unrelated-detached/checkpoints/001/0-1"
  const unrelatedLease = "plan-herder:unrelated-detached:001:Implementer:attempt-1:guided-repair"
  git(unrelated.repo, "update-ref", unrelatedCheckpoint, unrelated.head, "")
  git(unrelated.worktree, "switch", "--detach", "-q")
  git(unrelated.repo, "worktree", "lock", "--reason", unrelatedLease, unrelated.worktree)
  assert.throws(() => inspectActiveRebase({
    worktree: unrelated.worktree,
    bundle: unrelatedAssignment.bundlePath,
    expectedBundleSha256: unrelatedAssignment.bundleSha256,
    expectedWorktree: fs.realpathSync(unrelated.worktree),
    expectedBranch: unrelated.branch,
    expectedWorkerMode: "GUIDED_REPAIR",
    expectedDetachedHead: unrelated.head,
    expectedRebaseOnto: unrelated.head,
    expectedRebaseOrigHead: unrelated.head,
    expectedPlanHead: unrelated.head,
    expectedCheckpointRef: unrelatedCheckpoint,
    expectedCheckpoint: unrelated.head,
    expectedLeaseReason: unrelatedLease,
  }), /requires active Git rebase metadata/)

  fs.writeFileSync(path.join(rebase.worktree, "src", "worker.mjs"), "export const ready = 'resolved'\n")
  git(rebase.worktree, "add", "src/worker.mjs")
  assert.throws(() => verifyAssignment({
    verificationMode: "active-rebase",
    ...activeOptions,
    expectedRebaseStateSha256: inspected.rebaseStateSha256,
  }), /requires preserved unresolved conflicts|state mismatch/)

  const continueResult = spawnSync("git", ["-C", rebase.worktree, "rebase", "--continue"], {
    encoding: "utf8",
    env: { ...process.env, GIT_EDITOR: "true" },
  })
  assert.equal(continueResult.status, 0, continueResult.stderr || continueResult.stdout)
  assert.equal(git(rebase.worktree, "symbolic-ref", "--quiet", "--short", "HEAD"), rebase.branch)
  assert.equal(git(rebase.worktree, "status", "--porcelain=v1", "--untracked-files=all"), "")
  const attachedAfterContinue = assignment(() => verifyAssignment({
    worktree: rebase.worktree,
    bundle: rebaseAssignment.bundlePath,
    expectedBundleSha256: rebaseAssignment.bundleSha256,
  }))
  assert.equal(attachedAfterContinue.verificationMode, "branch")
  assert.equal(attachedAfterContinue.branch, rebase.branch)

  process.stdout.write("assignment bundle tests passed\n")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
})
