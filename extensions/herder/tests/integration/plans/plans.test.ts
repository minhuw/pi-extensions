#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import {
  buildGraph,
  buildWaves,
  getShapeReport,
  initPlanDir,
  projectStatuses,
  setTracking,
  snapshotPlan,
} from "../../../src/core/plans.ts"
import { getExecutionReport } from "../../../src/core/plan-report.ts"
import {
  executionDatabasePath,
  readRunConfiguration,
  readUsageState,
  recordRunConfiguration,
  recordUsageRecord,
  usageReport,
} from "../../../src/daemon/execution-store.ts"

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function planBody(id: string, title: string, dependencies: string): string {
  return `# Plan ${id}: ${title}

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: ${dependencies}
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-07-15
- **Kind**: behavioral
- **Parent objective**: Exercise the plan manager fixture

## Why this matters

Fixture intent.

## Current state

Fixture state.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

**In scope** (declared write paths):
- \`src/${id}.mjs\`

**Out of scope**:
- Every other fixture file.

## Dependency contract

Consumes the declared predecessor state and provides one passing fixture.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Use one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Test

Run the fixture.

## Test plan

Run the fixture test.

## Review map

- Outcome: the fixture command passes.
- Modified symbols: the scoped fixture file only.
- Proof: \`true\`.
- Expected unchanged behavior: every other fixture remains unchanged.
- Expected diff: the scoped fixture path and its direct tests.

## Done criteria

- [ ] \`true\` exits 0.

## STOP conditions

Stop if the fixture changed.

## Maintenance notes

Keep the fixture small.
`
}

function writeFixture(root: string, { cycle = false, mismatch = false }: { cycle?: boolean; mismatch?: boolean } = {}): string {
  const planDir = path.join(root, "herder-plans")
  fs.mkdirSync(planDir, { recursive: true })
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-first.md) | First | P1 | S | ${cycle ? "002" : "—"} | DONE |
| [002](002-second.md) | Second | P1 | M | 001 | TODO |
| 003 | Parallel | P2 | S | — | BLOCKED — previous attempt stopped |
`)
  fs.writeFileSync(path.join(planDir, "001-first.md"), planBody("001", "First", cycle ? "herder-plans/002-*.md" : "none"))
  fs.writeFileSync(path.join(planDir, "002-second.md"), planBody("002", "Second", mismatch ? "none" : "herder-plans/001-*.md"))
  fs.writeFileSync(path.join(planDir, "003-parallel.md"), planBody("003", "Parallel", "none"))
  return planDir
}

function expectFailure(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, pattern)
}

function required<T>(value: T | null | undefined): T {
  assert.ok(value)
  return value
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-plans-test-"))
test("plan graph, snapshots, and usage reports preserve their contracts", () => {
try {
  const repo = path.join(root, "repo")
  fs.mkdirSync(repo)
  git(repo, "init", "-q")

  const initialized = initPlanDir(path.join(repo, "herder-plans"))
  assert.equal(initialized.createdReadme, true)
  assert.equal(initialized.tracking, "local")
  assert.equal(buildGraph(initialized.planDir).complete, true)
  assert.match(fs.readFileSync(path.join(initialized.planDir, "README.md"), "utf8"), /## Considered and rejected/)
  assert.doesNotMatch(fs.readFileSync(initialized.readme, "utf8"), /## Execution usage/)
  assert.equal(fs.existsSync(executionDatabasePath(initialized.planDir)), true)
  assert.equal(fs.statSync(executionDatabasePath(initialized.planDir)).mode & 0o777, 0o600)
  const emptyUsage = { ...readUsageState(initialized.planDir), ...usageReport(readUsageState(initialized.planDir).records) }
  assert.equal(emptyUsage.attempts, 0)
  assert.equal(emptyUsage.storage, "sqlite")
  const excludeFile = git(repo, "rev-parse", "--git-path", "info/exclude")
  const resolvedExclude = path.isAbsolute(excludeFile) ? excludeFile : path.join(repo, excludeFile)
  assert.match(fs.readFileSync(resolvedExclude, "utf8"), /^\/herder-plans\/$/m)

  const tracked = setTracking(initialized.planDir, true)
  assert.equal(tracked.tracking, "tracked")
  assert.doesNotMatch(fs.readFileSync(resolvedExclude, "utf8"), /^\/herder-plans\/$/m)
  assert.equal(fs.readFileSync(path.join(initialized.planDir, ".gitignore"), "utf8"), ".herder/\n")

  const local = setTracking(initialized.planDir, false)
  assert.equal(local.tracking, "local")
  assert.match(fs.readFileSync(resolvedExclude, "utf8"), /^\/herder-plans\/$/m)

  const validDir = writeFixture(path.join(root, "valid"))
  const leakDir = path.join(validDir, "leak")
  fs.mkdirSync(leakDir)
  fs.writeFileSync(path.join(leakDir, "001-F004-deferred-example.md"), "# Deferred finding\n\nStatus: PENDING\n")
  const valid = buildGraph(validDir)
  assert.deepEqual(valid.ready, ["002"])
  assert.deepEqual(valid.blocked, ["003"])
  assert.deepEqual(valid.waiting, [])
  assert.deepEqual(valid.waves, [["001", "003"], ["002"]])
  assert.equal(valid.complete, false)
  assert.equal(valid.shapeReady, true)
  assert.equal(valid.plans.length, 3, "non-executable leak records entered the plan graph")
  assert.deepEqual(valid.overlaps, [])
  assert.equal(required(valid.plans.find((plan) => plan.id === "003")).statusDetail, "previous attempt stopped")
  const shape = getShapeReport(valid.planDir)
  assert.equal(shape.shapeReady, true)
  const shapePlan = required(shape.plans.find((plan) => plan.id === "002"))
  assert.equal(shapePlan.planWords < 1200, true)
  assert.equal(Number.isSafeInteger(shapePlan.planLines), true)
  assert.equal(Object.hasOwn(shapePlan, "reviewBudget"), false)

  const readmeBeforeUsage = fs.readFileSync(valid.readme, "utf8")
  const runProfile = {
    profile: "poorman",
    profileSha256: "1c5a08366d983d588fe0b8dfaf9f2c03d1c0801ab194b27c85da8b5e7f6453e2",
    host: "pi",
    roles: {
      "plan-implementer": { agent_type: "herder.plan-implementer", model: "deepseek-v4-flash", effort: "high" },
      "plan-reviewer": { agent_type: "herder.plan-reviewer", model: "gpt-5.6-luna", effort: "max" },
      "plan-judge": { agent_type: "herder.plan-judge", model: "gpt-5.6-luna", effort: "max" },
    },
  }
  assert.equal(recordRunConfiguration(valid.planDir, runProfile).recorded, true)
  const missingRoles = {
    "plan-implementer": runProfile.roles["plan-implementer"],
    "plan-reviewer": runProfile.roles["plan-reviewer"],
  }
  expectFailure(
    () => recordRunConfiguration(valid.planDir, { ...runProfile, roles: missingRoles }),
    /Missing run role plan-judge/,
  )
  expectFailure(
    () => recordRunConfiguration(valid.planDir, {
      ...runProfile,
      roles: { ...runProfile.roles, unexpected: runProfile.roles["plan-judge"] },
    }),
    /Run roles contain an unknown role/,
  )
  assert.equal(recordRunConfiguration(valid.planDir, runProfile).recorded, false)
  assert.deepEqual(required(readRunConfiguration(valid.planDir).configuration).roles, runProfile.roles)
  expectFailure(
    () => recordRunConfiguration(valid.planDir, { ...runProfile, profile: "eclipse" }),
    /already bound to poorman/,
  )
  const implementerUsage = {
    plan: "002",
    role: "plan-implementer",
    attempt: "run-1-002-implementer-1",
    model: "deepseek-v4-flash",
    effort: "high",
    outcome: "COMPLETE",
    inputTokens: "1000",
    cachedInputTokens: "400",
    outputTokens: "200",
    reasoningTokens: "50",
    source: "herder pi worker session",
    round: "1",
    generation: "generation-1",
    harness: "pi",
    serviceTier: "fast",
    startedAt: "2026-08-03T00:00:00Z",
    finishedAt: "2026-08-03T00:00:02Z",
    durationMs: "2000",
  }
  assert.equal(recordUsageRecord(valid.planDir, implementerUsage).recorded, true)
  assert.equal(recordUsageRecord(valid.planDir, implementerUsage).recorded, false)
  assert.equal(recordUsageRecord(valid.planDir, {
    plan: "002",
    role: "plan-reviewer",
    attempt: "run-1-002-reviewer-1",
    model: "gpt-5.6-luna",
    effort: "max",
    outcome: "APPROVE",
    source: "unknown",
    round: "1",
    generation: "generation-1",
    harness: "pi",
    serviceTier: "standard",
    startedAt: "2026-08-03T00:00:02Z",
    finishedAt: "2026-08-03T00:00:05Z",
    durationMs: "3000",
  }).recorded, true)

  const usageState = readUsageState(valid.planDir)
  const usage = { ...usageState, ...usageReport(usageState.records) }
  assert.equal(usage.attempts, 2)
  assert.deepEqual(usage.byPlan, [{
    key: "002",
    attempts: 2,
    tokenAttempts: 1,
    knownTokens: 1200,
  }])
  assert.equal(required(usage.byRole.find((row) => row.key === "plan-implementer")).knownTokens, 1200)
  assert.equal(required(usage.byModel.find((row) => row.key === "gpt-5.6-luna / max")).tokenAttempts, 0)
  assert.equal(usage.storage, "sqlite")
  assert.equal(required(usage.runConfiguration).profile, "poorman")
  assert.equal(fs.readFileSync(valid.readme, "utf8"), readmeBeforeUsage)
  assert.equal(fs.existsSync(executionDatabasePath(valid.planDir)), true)
  const databaseBeforeReports = fs.readFileSync(executionDatabasePath(valid.planDir))
  const planReport = getExecutionReport(valid.planDir, "002")
  assert.equal(planReport.attempts, 2)
  assert.deepEqual(planReport.rounds, [1])
  assert.deepEqual(planReport.tokenCoverage, { reported: 1, total: 2 })
  assert.equal(planReport.tokens.reportedInputOutput, 1200)
  assert.equal(planReport.timing.wallClockMs, 5000)
  assert.equal(planReport.timing.attemptDurationMs, 5000)
  assert.deepEqual(planReport.timing.durationCoverage, { reported: 2, total: 2 })
  assert.equal(required(planReport.byRole.find((row) => row.key === "plan-reviewer")).attempts, 1)
  assert.equal(required(planReport.byHarness.find((row) => row.key === "pi")).attempts, 2)
  assert.equal(required(planReport.byGeneration.find((row) => row.key === "generation-1")).attempts, 2)
  assert.equal(required(planReport.byServiceTier.find((row) => row.key === "fast")).attempts, 1)
  assert.equal(planReport.lifecycle.status, "TODO")
  assert.equal(required(planReport.runConfiguration).profile, "poorman")
  expectFailure(() => getExecutionReport(valid.planDir, "999"), /is not indexed/)
  assert.equal(getExecutionReport(valid.planDir, "0002").lifecycle.status, "TODO")
  expectFailure(() => getExecutionReport(valid.planDir, "missing"), /Cannot find a numeric plan ID in plan ID: "missing"/)
  expectFailure(() => getExecutionReport(valid.planDir, "9007199254740992"), /Invalid plan ID in plan ID: "9007199254740992"/)
  assert.deepEqual(fs.readFileSync(executionDatabasePath(valid.planDir)), databaseBeforeReports)
  expectFailure(
    () => recordUsageRecord(valid.planDir, { ...implementerUsage, outcome: "FAILED" }),
    /already recorded with different values/,
  )
  expectFailure(
    () => recordUsageRecord(valid.planDir, { ...implementerUsage, attempt: "bad-source", source: "unknown" }),
    /numeric usage but an unknown source/,
  )

  const snapshot = snapshotPlan(valid.planDir, "2")
  assert.equal(snapshot.plan.id, "002")
  assert.match(snapshot.planText, /Plan 002/)
  assert.match(snapshot.indexText, /Execution order/)
  assert.match(snapshot.snapshotSha256, /^[a-f0-9]{64}$/)
  assert.equal(snapshot.snapshotInputs.length, 1)

  fs.writeFileSync(path.join(valid.planDir, "CONTEXT.md"), `# Herder Plan-Set Context

## Objective

Keep shared fixture facts in one compiled snapshot input.
`)
  const composedSnapshot = snapshotPlan(valid.planDir, "2")
  assert.match(composedSnapshot.planText, /herder-snapshot:shared-context/)
  assert.match(composedSnapshot.planText, /Keep shared fixture facts/)
  assert.match(composedSnapshot.planText, /Plan 002/)
  assert.equal(composedSnapshot.snapshotInputs.length, 2)
  assert.equal(composedSnapshot.contextText.includes("Plan-Set Context"), true)

  projectStatuses(valid.planDir, [{ id: "002", status: "IN PROGRESS" }])
  assert.equal(required(buildGraph(valid.planDir).plans.find((plan) => plan.id === "002")).status, "IN PROGRESS")
  expectFailure(() => projectStatuses(valid.planDir, [{ id: "002", status: "BLOCKED" }]), /requires a one-line status detail/)
  projectStatuses(valid.planDir, [{ id: "002", status: "BLOCKED", detail: "verification failed" }])
  assert.equal(required(buildGraph(valid.planDir).plans.find((plan) => plan.id === "002")).statusDetail, "verification failed")
  projectStatuses(valid.planDir, [{ id: "002", status: "DONE" }])
  assert.equal(required(buildGraph(valid.planDir).plans.find((plan) => plan.id === "002")).status, "DONE")

  expectFailure(
    () => buildGraph(writeFixture(path.join(root, "mismatch"), { mismatch: true })),
    /dependency mismatch/,
  )
  expectFailure(
    () => buildGraph(writeFixture(path.join(root, "cycle"), { cycle: true })),
    /Dependency cycle/,
  )
  expectFailure(
    () => buildWaves([
      { id: "001", dependencies: ["002"] },
      { id: "002", dependencies: ["001"] },
    ]),
    /Cannot build dependency waves; the graph contains a cycle/,
  )

  const missingColumn = writeFixture(path.join(root, "missing-column"))
  const missingColumnIndex = path.join(missingColumn, "README.md")
  fs.writeFileSync(missingColumnIndex, fs.readFileSync(missingColumnIndex, "utf8").replace(" | Effort", ""))
  expectFailure(() => buildGraph(missingColumn), /required columns/)

  const unexplainedBlocked = writeFixture(path.join(root, "unexplained-blocked"))
  const unexplainedIndex = path.join(unexplainedBlocked, "README.md")
  fs.writeFileSync(unexplainedIndex, fs.readFileSync(unexplainedIndex, "utf8").replace("BLOCKED — previous attempt stopped", "BLOCKED"))
  expectFailure(() => buildGraph(unexplainedBlocked), /must explain why it is BLOCKED/)

  const malformed = writeFixture(path.join(root, "malformed"))
  const malformedPlan = path.join(malformed, "002-second.md")
  fs.writeFileSync(malformedPlan, fs.readFileSync(malformedPlan, "utf8").replace("## Maintenance notes", "## Notes"))
  expectFailure(() => buildGraph(malformed), /missing required heading "## Maintenance notes"/)

  const legacyBudget = writeFixture(path.join(root, "legacy-budget"))
  const legacyBudgetPlan = path.join(legacyBudget, "002-second.md")
  fs.writeFileSync(
    legacyBudgetPlan,
    fs.readFileSync(legacyBudgetPlan, "utf8").replace(
      "- **Parent objective**: Exercise the plan manager fixture\n",
      "- **Parent objective**: Exercise the plan manager fixture\n- **Review budget**: arbitrary legacy value, changed_lines<=0\n",
    ),
  )
  const ignoredLegacyBudget = required(buildGraph(legacyBudget).plans.find((plan) => plan.id === "002"))
  assert.equal(Object.hasOwn(ignoredLegacyBudget, "reviewBudget"), false)
  assert.equal(ignoredLegacyBudget.shapeReady, true)

  const legacyShape = writeFixture(path.join(root, "legacy-shape"))
  const legacyShapePlan = path.join(legacyShape, "002-second.md")
  fs.writeFileSync(
    legacyShapePlan,
    fs.readFileSync(legacyShapePlan, "utf8")
      .replace("- **Kind**: behavioral\n", "")
      .replace("- **Parent objective**: Exercise the plan manager fixture\n", "")
      .replace(/## Dependency contract[\s\S]*?(?=## Git workflow)/, "")
      .replace(/## Review map[\s\S]*?(?=## Done criteria)/, ""),
  )
  const legacyGraph = buildGraph(legacyShape)
  assert.equal(legacyGraph.shapeReady, false)
  assert.match(legacyGraph.warnings.join("\n"), /Plan 002 shape: missing metadata "Kind"/)

  const overlap = writeFixture(path.join(root, "overlap"))
  const overlapPlan = path.join(overlap, "003-parallel.md")
  fs.writeFileSync(
    overlapPlan,
    fs.readFileSync(overlapPlan, "utf8").replace("src/003.mjs", "src/002.mjs"),
  )
  const overlapShape = getShapeReport(overlap)
  assert.deepEqual(overlapShape.overlaps, [{
    plans: ["002", "003"],
    paths: ["src/002.mjs"],
    ordered: false,
  }])
  assert.match(overlapShape.warnings.join("\n"), /unordered overlapping in-scope paths/)

  const verbose = writeFixture(path.join(root, "verbose"))
  const verbosePlan = path.join(verbose, "002-second.md")
  fs.writeFileSync(
    verbosePlan,
    `${fs.readFileSync(verbosePlan, "utf8")}\n${"repeated ".repeat(1300)}\n`,
  )
  const verboseShape = getShapeReport(verbose)
  assert.equal(verboseShape.shapeReady, false)
  assert.match(verboseShape.warnings.join("\n"), /compact subplans must stay at or below 1200/)

  const legacyBranch = writeFixture(path.join(root, "legacy-branch"))
  const legacyBranchPlan = path.join(legacyBranch, "002-second.md")
  fs.writeFileSync(
    legacyBranchPlan,
    fs.readFileSync(legacyBranchPlan, "utf8").replace(
      "use the exact branch/worktree assigned by Herder Fire; never create or switch branches.",
      "use `herder/002-second`",
    ),
  )
  expectFailure(() => buildGraph(legacyBranch), /must delegate branch ownership to Herder Fire/)

  const misplacedBranch = writeFixture(path.join(root, "misplaced-branch"))
  const misplacedBranchPlan = path.join(misplacedBranch, "002-second.md")
  const canonicalBranch = "- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches."
  fs.writeFileSync(
    misplacedBranchPlan,
    fs.readFileSync(misplacedBranchPlan, "utf8")
      .replace(`${canonicalBranch}\n`, "")
      .replace("## Status", `${canonicalBranch}\n\n## Status`),
  )
  expectFailure(() => buildGraph(misplacedBranch), /exactly one "- Branch:" instruction in "## Git workflow"/)

  const unindexed = writeFixture(path.join(root, "unindexed"))
  fs.writeFileSync(path.join(unindexed, "004-forgotten.md"), "# Plan 004\n\n- **Depends on**: none\n")
  expectFailure(() => buildGraph(unindexed), /missing from .*README\.md/)

  process.stdout.write("herder-plans tests passed\n")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
})
