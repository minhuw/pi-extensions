#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import test from "node:test"
import { spawnSync } from "node:child_process"
import {
  formatCheckpointRef,
  listCoordinationRefs,
  parseCheckpointRefRelative,
  parseCoordinationRefRelative,
} from "../../../src/daemon/git/coordination-ref.ts"

test("coordination references format and reject malformed values", () => {
  const formatted = formatCheckpointRef({
    planName: "herder-plans",
    plan: "009",
    generation: "generation-1",
    ordinal: "1",
  })
  assert.deepEqual(formatted, {
    ref: "refs/plan-herder/herder-plans/checkpoints/009/generation-1-001",
    relative: "checkpoints/009/generation-1-001",
    kind: "checkpoint",
    plan: "009",
    generation: "generation-1",
    ordinal: "001",
    format: "generation",
  })

  assert.deepEqual(parseCheckpointRefRelative("checkpoints/019/generation-1-001"), {
    kind: "checkpoint",
    plan: "019",
    generation: "generation-1",
    generationNumber: "1",
    ordinal: "001",
    format: "generation",
  })
  for (const plan of ["009", "019", "020", "021"]) {
    assert.equal(parseCheckpointRefRelative(`checkpoints/${plan}/generation-1-001`)?.plan, plan)
  }
  assert.deepEqual(parseCheckpointRefRelative("checkpoints/019/0-1"), {
    kind: "checkpoint",
    plan: "019",
    generation: "0",
    generationNumber: "0",
    ordinal: "1",
    format: "numeric-legacy",
  })
  assert.deepEqual(parseCoordinationRefRelative("base"), { kind: "base", plan: null })
  assert.deepEqual(parseCoordinationRefRelative("completed/019"), { kind: "completed", plan: "019" })
  assert.deepEqual(parseCoordinationRefRelative("restacks/019/generation-2-012-onto"), {
    kind: "restack-target", plan: "019", generation: "generation-2", generationNumber: "2", ordinal: "012",
  })
  assert.deepEqual(parseCoordinationRefRelative("checkpoints/RUN/2"), { kind: "run-checkpoint", plan: null, ordinal: "2" })

  for (const malformed of [
    "checkpoints/19/generation-1-001",
    "checkpoints/019/generation-x-001",
    "checkpoints/019/generation-1-extra-001",
    "checkpoints/019/gen-1-001",
    "checkpoints/019/foreign",
  ]) {
    assert.equal(parseCheckpointRefRelative(malformed), null, malformed)
  }

  assert.throws(
    () => formatCheckpointRef({ planName: "herder-plans", plan: "009", generation: "1", ordinal: "1" }),
    /generation-<n>/,
  )
  assert.throws(
    () => formatCheckpointRef({ planName: "herder-plans", plan: "009", generation: "generation-1", ordinal: "0" }),
    /positive integer/,
  )

  assert.equal(formatCheckpointRef({
    planName: "herder-plans",
    plan: "021",
    generation: "generation-2",
    ordinal: "12",
  }).ref, "refs/plan-herder/herder-plans/checkpoints/021/generation-2-012")

  process.stdout.write("herder coordination-ref tests passed\n")
})

test("coordination ref enumeration returns parsed identities and preserves unknown records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-coordination-ref-"))
  try {
    const git = (args: string[]) => {
      const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr || result.stdout)
      return result.stdout.trim()
    }
    git(["init", "-q"])
    fs.writeFileSync(path.join(root, "base"), "base\n")
    git(["add", "base"])
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base"])
    const target = git(["rev-parse", "HEAD"])
    for (const relative of ["base", "completed/019", "checkpoints/019/generation-1-001", "checkpoints/RUN/2", "restacks/019/generation-1-001-onto", "unknown/value"]) {
      git(["update-ref", `refs/plan-herder/plans/${relative}`, target])
    }
    assert.deepEqual(listCoordinationRefs(root, "plans"), [
      { ref: "refs/plan-herder/plans/base", target, relative: "base", identity: { kind: "base", plan: null } },
      { ref: "refs/plan-herder/plans/checkpoints/019/generation-1-001", target, relative: "checkpoints/019/generation-1-001", identity: { kind: "checkpoint", plan: "019", generation: "generation-1", generationNumber: "1", ordinal: "001", format: "generation" } },
      { ref: "refs/plan-herder/plans/checkpoints/RUN/2", target, relative: "checkpoints/RUN/2", identity: { kind: "run-checkpoint", plan: null, ordinal: "2" } },
      { ref: "refs/plan-herder/plans/completed/019", target, relative: "completed/019", identity: { kind: "completed", plan: "019" } },
      { ref: "refs/plan-herder/plans/restacks/019/generation-1-001-onto", target, relative: "restacks/019/generation-1-001-onto", identity: { kind: "restack-target", plan: "019", generation: "generation-1", generationNumber: "1", ordinal: "001" } },
      { ref: "refs/plan-herder/plans/unknown/value", target, relative: "unknown/value", identity: null },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
