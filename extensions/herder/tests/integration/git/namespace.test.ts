#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { inspectNamespace, validatePlanName } from "../../../src/daemon/git/namespace-run.ts"
import { formatCheckpointRef } from "../../../src/daemon/git/coordination-ref.ts"

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/daemon/git/namespace-run.ts")

function run(command: string, args: string[], { cwd, allowFailure = false }: { cwd?: string; allowFailure?: boolean } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}

function git(repo: string, ...args: string[]): string {
  return run("git", ["-C", repo, ...args]).stdout.trim()
}

function withGitShim<T>(output: string, callback: () => T): T {
  const originalPath = process.env.PATH ?? ""
  const realGitLink = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
  assert.ok(realGitLink)
  const realGit = fs.realpathSync(realGitLink)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-namespace-shim-"))
  const shim = path.join(directory, "git")
  const quotedGit = `'${realGit.replaceAll("'", "'\\\"'\\\"'")}'`
  fs.writeFileSync(shim, `#!/bin/sh
case "$*" in
  *"worktree list --porcelain -z"*)
    ${quotedGit} "$@"; printf '${output.replaceAll("'", "'\\\"'\\\"'")}' ; exit ;;
esac
exec ${quotedGit} "$@"
`)
  fs.chmodSync(shim, 0o755)
  process.env.PATH = `${directory}:${originalPath}`
  try { return callback() } finally {
    process.env.PATH = originalPath
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function planBody(id: string): string {
  return `# Plan ${id}: Namespace fixture

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-07-19

## Why this matters

Exercise Fire namespace checks.

## Current state

The fixture is empty.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

Namespace checks only.

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

Stop if repository state is ambiguous.

## Maintenance notes

Keep the fixture small.
`
}

function writePlans(repo: string): string {
  const planDir = path.join(repo, "plans")
  const planIds = ["001", "009", "019", "020", "021", "023"]
  fs.mkdirSync(planDir)
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
${planIds.map((id) => `| [${id}](${id}-namespace.md) | Namespace ${id} | P1 | S | — | TODO |`).join("\n")}
`)
  for (const id of planIds) {
    fs.writeFileSync(path.join(planDir, `${id}-namespace.md`), planBody(id))
  }
  return planDir
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-namespace-test-"))
test("namespace inspection excludes pathless worktree records", () => {
  const repo = path.join(root, "pathless-repo")
  fs.mkdirSync(repo)
  try {
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "Herder Namespace Test")
    git(repo, "config", "user.email", "herder-namespace@example.invalid")
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n")
    git(repo, "add", "base.txt")
    git(repo, "commit", "-q", "-m", "test: base")
    const planDir = writePlans(repo)
    git(repo, "branch", "herder/plans/001", "main")
    const result = withGitShim("branch refs/heads/herder/plans/009\\0\\0", () => inspectNamespace({ repo, planDir, mode: "fire" }))
    assert.equal(result.worktrees.some((item) => item.path === ""), false)
    assert.equal(result.worktrees.every((item) => item.path.length > 0), true)
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})


test("Git namespace inspection rejects collisions and preserves coordination refs", () => {
try {
  const repo = path.join(root, "repo")
  fs.mkdirSync(repo)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.name", "Herder Namespace Test")
  git(repo, "config", "user.email", "herder-namespace@example.invalid")
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n")
  git(repo, "add", "base.txt")
  git(repo, "commit", "-q", "-m", "test: base")
  const planDir = writePlans(repo)

  assert.equal(validatePlanName("plans"), "plans")
  assert.throws(() => validatePlanName("Plans"), /lowercase Git-safe basename/)
  assert.throws(() => validatePlanName("plans/other"), /lowercase Git-safe basename/)

  const fresh = inspectNamespace({ repo, planDir, mode: "fire" })
  assert.equal(fresh.ok, true)
  assert.equal(fresh.planName, "plans")
  assert.equal(fresh.namespace, "herder/plans")
  assert.equal(fresh.integrationBranch, "herder/plans/integration")
  assert.deepEqual(fresh.conflicts, [])

  git(repo, "branch", "herder/plans/integration", "main")
  git(repo, "branch", "herder/plans/001", "main")
  git(repo, "update-ref", "refs/plan-herder/plans/base", git(repo, "rev-parse", "main"), "")

  const collision = inspectNamespace({ repo, planDir, mode: "fire" })
  assert.equal(collision.ok, false)
  assert.equal(collision.reason, "namespace-conflict")
  assert.deepEqual(collision.conflicts.map((item) => item.branch).filter(Boolean).sort(), [
    "herder/plans/001",
    "herder/plans/integration",
  ])

  const resumed = inspectNamespace({ repo, planDir, mode: "resume" })
  assert.equal(resumed.ok, true)
  assert.ok(resumed.integration)
  assert.ok(resumed.baseRef)
  assert.equal(resumed.integration.branch, "herder/plans/integration")
  assert.equal(resumed.baseRef.ref, "refs/plan-herder/plans/base")
  assert.deepEqual(resumed.planBranches.map((item) => item.relative), ["001"])

  const currentCheckpoints = ["009", "019", "020", "021"].map((plan) => formatCheckpointRef({
    planName: "plans",
    plan,
    generation: "generation-1",
    ordinal: "1",
  }).ref)
  const numericCheckpoint = "refs/plan-herder/plans/checkpoints/001/0-1"
  for (const currentCheckpoint of currentCheckpoints) {
    git(repo, "update-ref", currentCheckpoint, git(repo, "rev-parse", "main"), "")
  }
  git(repo, "update-ref", numericCheckpoint, git(repo, "rev-parse", "main"), "")
  const checkpointResume = inspectNamespace({ repo, planDir, mode: "resume" })
  assert.equal(checkpointResume.ok, true)
  assert.deepEqual(checkpointResume.unknownCoordinationRefs, [])
  for (const currentCheckpoint of currentCheckpoints) {
    assert.equal(checkpointResume.coordinationRefs.some((item) => item.ref === currentCheckpoint), true)
  }
  assert.equal(checkpointResume.coordinationRefs.some((item) => item.ref === numericCheckpoint), true)

  const coordinationTarget = git(repo, "rev-parse", "main")
  const unknownRef = "refs/plan-herder/plans/unknown/value"
  const unindexedRef = "refs/plan-herder/plans/completed/999"
  git(repo, "update-ref", unknownRef, coordinationTarget, "")
  git(repo, "update-ref", unindexedRef, coordinationTarget, "")
  const shapedResume = inspectNamespace({ repo, planDir, mode: "resume" })
  assert.equal(shapedResume.ok, false)
  assert.deepEqual(shapedResume.baseRef, {
    ref: "refs/plan-herder/plans/base",
    target: coordinationTarget,
    relative: "base",
  })
  assert.equal(shapedResume.coordinationRefs.every((item) => Object.keys(item).sort().join(",") === "ref,relative,target"), true)
  assert.deepEqual(shapedResume.unknownCoordinationRefs, [{
    ref: unknownRef,
    target: coordinationTarget,
    relative: "unknown/value",
  }])
  assert.deepEqual(shapedResume.unindexedCoordinationRefs, [{
    ref: unindexedRef,
    target: coordinationTarget,
    relative: "completed/999",
  }])
  assert.equal(shapedResume.conflicts.some((item) => item.type === "unknown-coordination-ref" && item.ref === unknownRef), true)
  assert.equal(shapedResume.conflicts.some((item) => item.type === "unindexed-coordination-ref" && item.ref === unindexedRef), true)
  git(repo, "update-ref", "-d", unknownRef)
  git(repo, "update-ref", "-d", unindexedRef)

  const malformedCheckpoint = "refs/plan-herder/plans/checkpoints/001/generation-x-001"
  git(repo, "update-ref", malformedCheckpoint, git(repo, "rev-parse", "main"), "")
  const malformedResume = inspectNamespace({ repo, planDir, mode: "resume" })
  assert.equal(malformedResume.ok, false)
  assert.equal(malformedResume.reason, "namespace-ambiguous")
  assert.equal(malformedResume.conflicts.some((item) => item.type === "unknown-coordination-ref" && item.ref === malformedCheckpoint), true)
  git(repo, "update-ref", "-d", malformedCheckpoint)

  const other = inspectNamespace({ repo, planDir, planName: "other-plans", mode: "fire" })
  assert.equal(other.ok, true)
  assert.equal(other.integrationBranch, "herder/other-plans/integration")

  git(repo, "branch", "herder/plans/manual", "main")
  const ambiguous = inspectNamespace({ repo, planDir, mode: "resume" })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.reason, "namespace-ambiguous")
  assert.equal(ambiguous.conflicts.some((item) => item.type === "unknown-branch"), true)

  git(repo, "branch", "herder/blocked", "main")
  const parentConflict = inspectNamespace({ repo, planDir, planName: "blocked", mode: "fire" })
  assert.equal(parentConflict.ok, false)
  assert.deepEqual(parentConflict.conflicts, [{ type: "parent-ref", ref: "refs/heads/herder/blocked" }])

  const cli = run(process.execPath, [
    script,
    "--repo", repo,
    "--plan-dir", planDir,
    "--mode", "fire",
    "--pretty",
  ], { cwd: repo, allowFailure: true })
  assert.equal(cli.status, 2)
  assert.equal(JSON.parse(cli.stdout).reason, "namespace-conflict")
  assert.equal(cli.stderr, "")

  console.log("herder Fire namespace tests passed")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
})
