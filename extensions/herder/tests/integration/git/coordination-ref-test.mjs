#!/usr/bin/env node

import assert from "node:assert/strict"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  formatCheckpointRef,
  parseCheckpointRefRelative,
  parseCoordinationRefRelative,
} from "../../../src/daemon/git/coordination-ref.ts"

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/daemon/git/coordination-ref.ts")

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
  assert.equal(
    parseCheckpointRefRelative(`checkpoints/${plan}/generation-1-001`)?.plan,
    plan,
  )
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

const cli = spawnSync(process.execPath, [
  script,
  "format-checkpoint",
  "--plan-name", "herder-plans",
  "--plan", "021",
  "--generation", "generation-2",
  "--ordinal", "12",
], { encoding: "utf8" })
assert.equal(cli.status, 0, cli.stderr || cli.stdout)
assert.equal(JSON.parse(cli.stdout).ref, "refs/plan-herder/herder-plans/checkpoints/021/generation-2-012")

process.stdout.write("herder coordination-ref tests passed\n")
