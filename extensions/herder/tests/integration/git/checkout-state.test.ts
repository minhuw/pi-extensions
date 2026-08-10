#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const guard = path.resolve(scriptDir, "../../../src/daemon/git/checkout-state.ts")
const root = await mkdtemp(path.join(tmpdir(), "herder-checkout-state-test-"))
const repo = path.join(root, "repo")
const planDir = path.join(repo, "herder-plans")

type CheckoutState = {
  ok: boolean
  mode: string
  fingerprint: string
  stateToken: string
  summary: { trackedContentCount: number; untrackedContentCount: number }
  changedComponents: string[]
  error: string
}

function run(command: string, args: string[], { expectedStatus = 0 }: { expectedStatus?: number } = {}): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, { cwd: repo, encoding: "utf8" })
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout)
  return result
}

function git(...args: string[]): string {
  return run("git", ["-C", repo, ...args]).stdout.trim()
}

function checkoutState(args: string[] = [], expectedStatus = 0): CheckoutState {
  const result = run(process.execPath, [guard, "--repo", repo, "--exclude", planDir, ...args], { expectedStatus })
  return JSON.parse(result.stdout) as CheckoutState
}

test("checkout state captures and detects user-owned changes", async () => {
try {
  await mkdir(planDir, { recursive: true })
  git("init", "-q")
  git("config", "user.name", "Herder Checkout Guard")
  git("config", "user.email", "herder-checkout@example.invalid")
  await writeFile(path.join(repo, "tracked.txt"), "tracked base\n")
  await writeFile(path.join(repo, "staged.txt"), "staged base\n")
  await writeFile(path.join(planDir, "README.md"), "TODO\n")
  git("add", ".")
  git("commit", "-q", "-m", "test: add checkout fixture")

  await writeFile(path.join(repo, "tracked.txt"), "tracked user change\n")
  await writeFile(path.join(repo, "staged.txt"), "staged user change\n")
  git("add", "staged.txt")
  await writeFile(path.join(repo, "notes.txt"), "untracked user note\n")

  const captured = checkoutState(["--pretty"])
  assert.equal(captured.ok, true)
  assert.equal(captured.mode, "capture")
  assert.match(captured.fingerprint, /^[a-f0-9]{64}$/)
  assert.ok(captured.stateToken.length > 100)
  assert.equal(captured.summary.trackedContentCount, 1)
  assert.equal(captured.summary.untrackedContentCount, 1)

  const unchanged = checkoutState(["--expect", captured.stateToken])
  assert.equal(unchanged.ok, true)
  assert.deepEqual(unchanged.changedComponents, [])

  await writeFile(path.join(planDir, "README.md"), "IN PROGRESS\n")
  const excludedPlanChange = checkoutState(["--expect", captured.stateToken])
  assert.equal(excludedPlanChange.ok, true)

  await writeFile(path.join(repo, "tracked.txt"), "worker overwrote existing dirty content\n")
  const changedTracked = checkoutState(["--expect", captured.stateToken], 2)
  assert.equal(changedTracked.ok, false)
  assert.ok(changedTracked.changedComponents.includes("trackedContentSha256"))
  await writeFile(path.join(repo, "tracked.txt"), "tracked user change\n")
  assert.equal(checkoutState(["--expect", captured.stateToken]).ok, true)

  await writeFile(path.join(repo, "notes.txt"), "worker overwrote existing untracked content\n")
  const changedUntracked = checkoutState(["--expect", captured.stateToken], 2)
  assert.equal(changedUntracked.ok, false)
  assert.ok(changedUntracked.changedComponents.includes("untrackedContentSha256"))
  await writeFile(path.join(repo, "notes.txt"), "untracked user note\n")
  assert.equal(checkoutState(["--expect", captured.stateToken]).ok, true)

  await writeFile(path.join(repo, "staged.txt"), "worker replaced staged content\n")
  git("add", "staged.txt")
  const changedIndex = checkoutState(["--expect", captured.stateToken], 2)
  assert.equal(changedIndex.ok, false)
  assert.ok(changedIndex.changedComponents.includes("indexSha256"))
  await writeFile(path.join(repo, "staged.txt"), "staged user change\n")
  git("add", "staged.txt")
  assert.equal(checkoutState(["--expect", captured.stateToken]).ok, true)

  await writeFile(path.join(repo, "new-note.txt"), "new untracked file\n")
  const addedUntracked = checkoutState(["--expect", captured.stateToken], 2)
  assert.equal(addedUntracked.ok, false)
  assert.ok(addedUntracked.changedComponents.includes("untrackedContentCount"))

  const malformed = checkoutState(["--expect", "not-a-token"], 1)
  assert.equal(malformed.ok, false)
  assert.match(malformed.error, /valid checkout state token/)

  process.stdout.write("herder Fire checkout-state tests passed\n")
} finally {
  await rm(root, { recursive: true, force: true })
}
})
