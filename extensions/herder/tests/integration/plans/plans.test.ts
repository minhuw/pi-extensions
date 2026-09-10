#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  buildGraph,
  buildWaves,
  getShapeReport,
  initPlanDir,
  planIndexReworkLayout,
  projectStatuses,
  setTracking,
  snapshotPlan,
  snapshotPlansFromGraph,
} from "../../../src/core/plans.ts"
import { captureReworkSnapshot, validateReworkGraphFiles } from "../../../src/core/plan-edit.ts"
import type { StoredRun } from "../../../src/daemon/run-store.ts"
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

## Outcome and acceptance

Fixture intent: preserve a syntactically valid independent fixture.

| ID | Required behavior | Proof |
| --- | --- | --- |
| A1 | The scoped fixture is valid JavaScript | V1 |

## Boundaries

**Write paths**:
- \`src/${id}.mjs\`

**Out of scope**:
- Every other fixture file. Preserve their callers and syntax.

## Starting conditions

**Observed baseline**: The fixture manager currently reads a numbered plan.

**Required starting state**: Declared predecessors have integrated their fixture.

${dependencies === "none" ? "Dependencies: none." : `| Plan | Consumes |
| --- | --- |
${dependencies.split(",").map((dependency) => `| ${dependency.trim()} | The predecessor provides its independent syntactically valid fixture |`).join("\n")}`}

**Expected dependency changes**: Predecessors may add their declared fixture, without changing this fixture's contract.

## Implementation route

Suggested: implement A1 in the scoped fixture's module body, then use V1 to check its syntax.

## Verification

| ID | Phase | Criteria | Toolchain | Command | Expected |
| --- | --- | --- | --- | --- | --- |
| V1 | acceptance | A1 | T1 | \`node --check src/${id}.mjs\` | exit 0; scoped fixture parses |

| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
| --- | --- | --- | --- | --- | --- |
| T1 | npm project scripts | . | Node >=22.19; locked dependencies installed | \`node --version\` | \`package.json\`; \`package-lock.json\`; AGENTS.md |

## Escalation and handoff

Stop if fixture ownership changed; report unavailable toolchain manager/command/cwd/error.
Provide a valid module to downstream consumers and keep integration syntactically valid.
Defer unrelated fixtures.

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
  fs.writeFileSync(path.join(planDir, "001-first.md"), planBody("001", "First", cycle ? "002" : "none"))
  fs.writeFileSync(path.join(planDir, "002-second.md"), planBody("002", "Second", mismatch ? "none" : "001"))
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
  assert.deepEqual(shapePlan.contract.dependencies, [{ plan: "001", consumes: "The predecessor provides its independent syntactically valid fixture" }])
  assert.deepEqual(shapePlan.contract, required(valid.plans.find((plan) => plan.id === "002")).contract)

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
  assert.equal(snapshot.planText, fs.readFileSync(snapshot.plan.file, "utf8"))
  assert.equal(snapshot.sourcePlanText, snapshot.planText)
  assert.equal(snapshot.contextText, "")
  assert.equal(snapshot.snapshotSha256, createHash("sha256").update(snapshot.sourcePlanText).digest("hex"))
  assert.deepEqual(snapshot.contract, snapshot.plan.contract)
  assert.deepEqual(snapshot.contract, shapePlan.contract)

  fs.writeFileSync(path.join(valid.planDir, "CONTEXT.md"), `# Herder Plan-Set Context

## Objective

Keep shared fixture facts in one compiled snapshot input.

| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
| --- | --- | --- | --- | --- | --- |
| T2 | npm workspace scripts | future/package | Dependency provides this package; locked install | \`node --version\` | Root package.json and AGENTS.md |
`)
  const composedSnapshot = snapshotPlan(valid.planDir, "2")
  assert.match(composedSnapshot.planText, /herder-snapshot:shared-context/)
  assert.match(composedSnapshot.planText, /Keep shared fixture facts/)
  assert.match(composedSnapshot.planText, /Plan 002/)
  assert.equal(composedSnapshot.snapshotInputs.length, 2)
  assert.equal(composedSnapshot.contextText.includes("Plan-Set Context"), true)
  assert.equal(composedSnapshot.sourcePlanText, snapshot.sourcePlanText)
  assert.notEqual(composedSnapshot.snapshotSha256, snapshot.snapshotSha256)
  assert.deepEqual(composedSnapshot.contract.toolchains.map((row) => [row.id, row.source]), [["T2", "shared"], ["T1", "local"]])
  assert.equal(composedSnapshot.snapshotSha256, createHash("sha256").update(composedSnapshot.planText).digest("hex"))

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
  fs.writeFileSync(malformedPlan, fs.readFileSync(malformedPlan, "utf8").replace("## Escalation and handoff", "## Notes"))
  expectFailure(() => buildGraph(malformed), /unexpected heading "## Notes"/)

  const legacyBudget = writeFixture(path.join(root, "legacy-budget"))
  const legacyBudgetPlan = path.join(legacyBudget, "002-second.md")
  fs.writeFileSync(
    legacyBudgetPlan,
    fs.readFileSync(legacyBudgetPlan, "utf8").replace(
      "- **Parent objective**: Exercise the plan manager fixture\n",
      "- **Parent objective**: Exercise the plan manager fixture\n- **Review budget**: arbitrary legacy value, changed_lines<=0\n",
    ),
  )
  expectFailure(() => buildGraph(legacyBudget), /unexpected metadata "Review budget"/)

  const legacyShape = writeFixture(path.join(root, "legacy-shape"))
  const legacyShapePlan = path.join(legacyShape, "002-second.md")
  fs.writeFileSync(
    legacyShapePlan,
    fs.readFileSync(legacyShapePlan, "utf8")
      .replace("- **Kind**: behavioral\n", "")
      .replace("- **Parent objective**: Exercise the plan manager fixture\n", ""),
  )
  expectFailure(() => buildGraph(legacyShape), /missing required metadata "Kind"/)

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
  assert.equal(overlapShape.shapeReady, false)
  assert.equal(required(overlapShape.plans.find((plan) => plan.id === "002")).shapeReady, false)
  assert.equal(required(overlapShape.plans.find((plan) => plan.id === "003")).shapeReady, false)
  assert.match(required(overlapShape.plans.find((plan) => plan.id === "003")).issues.join("\n"), /unordered overlapping/)

  const ordered = writeFixture(path.join(root, "ordered-overlap"))
  const orderedPlan = path.join(ordered, "002-second.md")
  fs.writeFileSync(orderedPlan, fs.readFileSync(orderedPlan, "utf8").replace("src/002.mjs", "src/001.mjs"))
  const orderedShape = getShapeReport(ordered)
  assert.deepEqual(orderedShape.overlaps, [{ plans: ["001", "002"], paths: ["src/001.mjs"], ordered: true }])
  assert.equal(orderedShape.shapeReady, true)

  const verbose = writeFixture(path.join(root, "verbose"))
  const verbosePlan = path.join(verbose, "002-second.md")
  fs.writeFileSync(
    verbosePlan,
    `${fs.readFileSync(verbosePlan, "utf8")}\n${"repeated ".repeat(1300)}\n`,
  )
  const verboseShape = getShapeReport(verbose)
  assert.equal(verboseShape.shapeReady, false)
  assert.match(verboseShape.warnings.join("\n"), /compact subplans must stay at or below 1200/)

  const legacyFormat = writeFixture(path.join(root, "legacy-format"))
  const legacyFormatPlan = path.join(legacyFormat, "002-second.md")
  fs.writeFileSync(legacyFormatPlan, `# Plan 002: Legacy

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 001
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-07-15

${["Why this matters", "Current state", "Commands you will need", "Scope", "Git workflow", "Steps", "Test plan", "Done criteria", "STOP conditions", "Maintenance notes"].map((heading) => `## ${heading}\n\nLegacy content.\n`).join("\n")}
- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
`)
  expectFailure(() => buildGraph(legacyFormat), /unexpected heading "## Why this matters"/)

  const sharedConflict = writeFixture(path.join(root, "shared-conflict"))
  fs.writeFileSync(path.join(sharedConflict, "CONTEXT.md"), composedSnapshot.contextText.replace("T2", "T1"))
  expectFailure(() => buildGraph(sharedConflict), /duplicate ID T1/)

  const badConsumes = writeFixture(path.join(root, "bad-consumes"))
  const badConsumesPlan = path.join(badConsumes, "002-second.md")
  fs.writeFileSync(badConsumesPlan, fs.readFileSync(badConsumesPlan, "utf8").replace("| 001 | The predecessor", "| 003 | The predecessor"))
  expectFailure(() => buildGraph(badConsumes), /Consumes rows must agree exactly/)

  const unindexed = writeFixture(path.join(root, "unindexed"))
  fs.writeFileSync(path.join(unindexed, "004-forgotten.md"), "# Plan 004\n\n- **Depends on**: none\n")
  expectFailure(() => buildGraph(unindexed), /missing from .*README\.md/)

  process.stdout.write("herder-plans tests passed\n")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
})


test("only one visible index supplies graph, layout, projection, and source provenance", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "herder-visible-index-"))
  try {
    const planDir = writeFixture(temporary)
    const readme = path.join(planDir, "README.md")
    const original = fs.readFileSync(readme, "utf8")
    const table = original.slice(original.indexOf("| Plan"))
    const hidden = table.replace("| DONE |", "| TODO |").replace("| 001 | TODO |", "| — | DONE |")
    const examples = [
      `<!--\n${hidden}-->`,
      `\`\`\`markdown\n${hidden}\`\`\``,
      `~~~markdown\n${hidden}~~~`,
      hidden.trimEnd().split("\n").map((line) => `    ${line}`).join("\n"),
      hidden.trimEnd().split("\n").map((line) => `\t${line}`).join("\n"),
    ]
    // An extra column must not change which table is authoritative.
    const visible = table.trimEnd().split("\n").map((line, index) => `${line} ${index === 0 ? "Notes" : index === 1 ? "---" : "kept"} |`).join("\n") + "\n"
    for (const newline of ["\n", "\r\n"] as const) {
      for (const example of examples) {
        const prefix = `# Plans\n\n${example}\n\n## Real index\n\n`.replaceAll("\n", newline)
        const source = prefix + visible.replaceAll("\n", newline)
        fs.writeFileSync(readme, source)
        const graph = buildGraph(planDir)
        assert.deepEqual(graph.ready, ["002"])
        assert.deepEqual(graph.plans.map(({ id, status, dependencies }) => ({ id, status, dependencies })), [
          { id: "001", status: "DONE", dependencies: [] },
          { id: "002", status: "TODO", dependencies: ["001"] },
          { id: "003", status: "BLOCKED", dependencies: [] },
        ])
        assert.equal(graph.indexSha256, createHash("sha256").update(source).digest("hex"))
        assert.ok(snapshotPlansFromGraph(graph).every((snapshot) => snapshot.indexText === source))
        const layout = planIndexReworkLayout(source, readme)
        assert.deepEqual(layout.lines, source.split(newline))
        assert.equal(layout.newline, newline)
        assert.equal(layout.statusColumn, 5)
        const firstRow = prefix.split(newline).length - 1 + 2
        assert.deepEqual(layout.rows, ["001", "002", "003"].map((planId, index) => ({ planId, lineIndex: firstRow + index })))
        projectStatuses(planDir, [{ id: "002", status: "DONE" }])
        assert.equal(fs.readFileSync(readme, "utf8"), prefix + visible.replace("| TODO |", "| DONE |").replaceAll("\n", newline))
        assert.throws(() => snapshotPlansFromGraph(graph), /changed since graph validation/)
      }
    }
    for (const source of [...examples, `${table}\n${table}`, `${table}\n${table.split("\n").slice(0, 2).join("\n")}\n`]) {
      fs.writeFileSync(readme, source)
      const error = examples.includes(source) ? /no Markdown table/ : /multiple visible Markdown tables/
      assert.throws(() => buildGraph(planDir), error)
      assert.throws(() => planIndexReworkLayout(source, readme), error)
      assert.throws(() => projectStatuses(planDir, [{ id: "002", status: "DONE" }]), error)
      assert.equal(fs.readFileSync(readme, "utf8"), source)
    }
    for (const name of ["001-first.md", "002-second.md", "003-parallel.md"]) fs.unlinkSync(path.join(planDir, name))
    const empty = table.split("\n").slice(0, 2).join("\n") + "\n"
    fs.writeFileSync(readme, empty)
    assert.equal(buildGraph(planDir).complete, true)
    assert.deepEqual(planIndexReworkLayout(empty, readme).rows, [])
    projectStatuses(planDir, [])
    assert.equal(fs.readFileSync(readme, "utf8"), empty)
    fs.writeFileSync(readme, empty.replace("Depends on", "Other"))
    assert.throws(() => buildGraph(planDir), /required columns/)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})


test("inline index comments preserve source bytes or fail closed before edits", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "herder-index-comments-"))
  try {
    const planDir = writeFixture(temporary)
    const readme = path.join(planDir, "README.md")
    const base = fs.readFileSync(readme, "utf8")
    const run = { runId: "fixture", planDirectory: planDir } as StoredRun
    const capture = () => captureReworkSnapshot(run, "001", "11111111-1111-1111-1111-111111111111",
      "a".repeat(40), "b".repeat(40), "001-first.md", []).snapshot
    for (const newline of ["\n", "\r\n"]) {
      for (const outerPipes of [true, false]) {
        let source = base.replace("Second |", "Second <!-- retain me --> |")
          .replace("| TODO |", "|\tTODO   |")
        if (!outerPipes) source = source.split("\n").map((line) => line.replace(/^\|/, "").replace(/\|$/, "")).join("\n")
        source = source.replaceAll("\n", newline)
        fs.writeFileSync(readme, source)
        const snapshot = capture()
        const graph = buildGraph(planDir)
        assert.equal(graph.indexSha256, createHash("sha256").update(source).digest("hex"))
        assert.deepEqual(planIndexReworkLayout(source, readme).lines, source.split(newline))
        projectStatuses(planDir, [{ id: "002", status: "TODO" }])
        assert.equal(fs.readFileSync(readme, "utf8"), source)
        projectStatuses(planDir, [{ id: "002", status: "DONE" }])
        const projected = source.replace("\tTODO   ", "\tDONE   ")
        assert.equal(fs.readFileSync(readme, "utf8"), projected)
        assert.doesNotThrow(() => validateReworkGraphFiles(run, snapshot, "001-first.md"))
        for (const changed of [projected.replace("retain me", "changed"), projected.replace("| 001 |", "| 003 |")]) {
          fs.writeFileSync(readme, changed)
          assert.throws(() => validateReworkGraphFiles(run, snapshot, "001-first.md"), /outside plan 001/)
        }
      }
      for (const unsafe of [
        base.replace("Second |", "Second <!-- note | x --> |"),
        base.replace("| TODO |", "| TODO <!-- note | x --> |"),
        base.replace("| TODO |", "| TODO <!-- retain me --> |"),
        base.replace("| [002]", "<!-- prefix --> | [002]"),
        base.replace("| TODO |", "| TODO | <!-- suffix -->"),
      ]) {
        const source = unsafe.replaceAll("\n", newline)
        fs.writeFileSync(readme, source)
        const snapshot = capture()
        assert.throws(() => buildGraph(planDir), /cannot safely map/)
        assert.throws(() => planIndexReworkLayout(source, readme), /cannot safely map/)
        assert.throws(() => projectStatuses(planDir, [{ id: "001", status: "TODO" }, { id: "002", status: "DONE" }]), /cannot safely map/)
        assert.equal(fs.readFileSync(readme, "utf8"), source)
        assert.throws(() => validateReworkGraphFiles(run, snapshot, "001-first.md"), /cannot safely map/)
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})


test("duplicate Status projection and raw safety follow the graph's last column", () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "herder-duplicate-status-"))
  try {
    fs.writeFileSync(path.join(planDir, "002-second.md"), planBody("002", "Second", "none"))
    const readme = path.join(planDir, "README.md")
    for (const newline of ["\n", "\r\n"]) {
      for (const outerPipes of [true, false]) {
        for (const header of ["Status", "**sTaTuS**"]) {
          const source = [
            "# Plans", "",
            `| Plan | Title | Priority | Effort | Depends on | Status | ${header} | Notes |`,
            "| --- | --- | --- | --- | --- | --- | --- | --- |",
            "| 002 | Second <!-- retain title --> | P1 | S | — | TODO |\tTODO   | keep <!-- retain note --> |",
            "", "Unchanged footer.", "",
          ].map((line) => outerPipes ? line : line.replace(/^\|/, "").replace(/\|$/, "")).join(newline)
          for (const earlier of ["TODO", "IN PROGRESS <!-- retain duplicate -->"]) {
            const original = source.replace("| TODO |", `| ${earlier} |`)
            fs.writeFileSync(readme, original)
            assert.equal(buildGraph(planDir).plans[0].status, "TODO")
            projectStatuses(planDir, [{ id: "002", status: "TODO" }])
            assert.equal(fs.readFileSync(readme, "utf8"), original)
            projectStatuses(planDir, [{ id: "002", status: "DONE" }])
            const expected = original.replace("\tTODO   ", "\tDONE   ")
            assert.equal(fs.readFileSync(readme, "utf8"), expected)
            assert.equal(buildGraph(planDir).plans[0].status, "DONE")
            const projectedInode = fs.statSync(readme).ino
            projectStatuses(planDir, [{ id: "002", status: "DONE" }])
            assert.equal(fs.readFileSync(readme, "utf8"), expected)
            assert.equal(fs.statSync(readme).ino, projectedInode)
          }
          for (const comment of ["<!-- status note -->", "<!-- status | note -->"]) {
            const unsafe = source.replace("\tTODO   ", `\tTODO ${comment}   `)
            fs.writeFileSync(readme, unsafe)
            const originalInode = fs.statSync(readme).ino
            assert.throws(() => buildGraph(planDir), /cannot safely map/)
            assert.throws(() => planIndexReworkLayout(unsafe, readme), /cannot safely map/)
            assert.throws(() => projectStatuses(planDir, [{ id: "002", status: "DONE" }]), /cannot safely map/)
            assert.equal(fs.readFileSync(readme, "utf8"), unsafe)
            assert.equal(fs.statSync(readme).ino, originalInode)
          }
        }
      }
    }
  } finally {
    fs.rmSync(planDir, { recursive: true, force: true })
  }
})


test("graph snapshots bind contracts and hashes to the same unchanged source inputs", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "herder-snapshot-inputs-"))
  try {
    const planDir = writeFixture(temporary)
    const contextFile = path.join(planDir, "CONTEXT.md")
    const local = planBody("002", "Second", "001")
    const toolchain = required(local.match(/\| ID \| Owner \|[\s\S]*?(?=\n\n)/))[0]
    const contextText = `# Shared context\n\n${toolchain}\n`
    fs.writeFileSync(contextFile, contextText)
    for (const name of ["001-first.md", "002-second.md", "003-parallel.md"]) {
      const file = path.join(planDir, name)
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(toolchain, "Use shared T1."))
    }
    const graph = buildGraph(planDir)
    const snapshots = snapshotPlansFromGraph(graph)
    assert.equal(graph.indexSha256, createHash("sha256").update(fs.readFileSync(graph.readme)).digest("hex"))
    assert.equal(graph.contextSha256, createHash("sha256").update(contextText).digest("hex"))
    for (const snapshot of snapshots) {
      assert.deepEqual(snapshot.contract, snapshot.plan.contract)
      assert.notEqual(snapshot.contract, snapshot.plan.contract, "compile the captured inputs, not the cached object")
      assert.equal(snapshot.plan.sourcePlanSha256, createHash("sha256").update(snapshot.sourcePlanText).digest("hex"))
      assert.equal(snapshot.contract.toolchains[0].source, "shared")
      assert.equal(snapshot.contextText, contextText)
      assert.equal(snapshot.sourcePlanText, fs.readFileSync(snapshot.plan.file, "utf8"))
      assert.equal(snapshot.indexText, fs.readFileSync(graph.readme, "utf8"))
      assert.equal(snapshot.planText, `<!-- herder-snapshot:shared-context -->\n${contextText.trim()}\n\n<!-- herder-snapshot:local-plan -->\n${snapshot.sourcePlanText.trim()}\n`)
      assert.equal(snapshot.snapshotSha256, createHash("sha256").update(snapshot.planText).digest("hex"))
      assert.deepEqual(snapshot.snapshotInputs, [
        { kind: "shared-context", file: contextFile, sha256: createHash("sha256").update(contextText).digest("hex") },
        { kind: "plan", file: snapshot.plan.file, sha256: createHash("sha256").update(snapshot.sourcePlanText).digest("hex") },
      ])
    }
    const target = required(snapshots.find((snapshot) => snapshot.plan.id === "002"))
    const changes = [
      [target.plan.file, target.sourcePlanText.replace("The scoped fixture is valid JavaScript", "The scoped fixture exports a function")],
      [target.plan.file, target.sourcePlanText.replace("node --check src/002.mjs", "node src/002.mjs")],
      [target.plan.file, target.sourcePlanText + "\n"],
      [contextFile, contextText.replace("node --version", "npm --version")],
      [contextFile, contextText + "\n"],
      [graph.readme, target.indexText.replace("| TODO |", "| DONE |")],
      [graph.readme, target.indexText + "\n"],
    ]
    for (const [file, changed] of changes) {
      const original = fs.readFileSync(file, "utf8")
      fs.writeFileSync(file, changed)
      assert.throws(() => snapshotPlansFromGraph(graph), /changed since graph validation/, file)
      assert.equal(fs.readFileSync(file, "utf8"), changed, "drift rejection must not rewrite source")
      fs.writeFileSync(file, original)
      assert.deepEqual(snapshotPlansFromGraph(graph), snapshots)
    }
    const command = target.plan.contract.verification[0].command
    target.plan.contract.verification[0].command = "`unvalidated command`"
    assert.throws(() => snapshotPlansFromGraph(graph), /contract disagrees with the validated graph/)
    assert.equal(target.contract.verification[0].command, command)
    target.plan.contract.verification[0].command = command
    fs.unlinkSync(contextFile)
    assert.throws(() => snapshotPlansFromGraph(graph), /changed since graph validation/)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test("graph snapshots reject a newly added context, even when it is empty", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "herder-snapshot-context-"))
  try {
    const graph = buildGraph(writeFixture(temporary))
    const contextFile = path.join(graph.planDir, "CONTEXT.md")
    for (const text of ["", "# New shared context\n"]) {
      fs.writeFileSync(contextFile, text)
      assert.throws(() => snapshotPlansFromGraph(graph), /changed since graph validation/)
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
})

test("optional run bindings round-trip immutably through roles_json", () => {
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "herder-optional-bindings-"))
  try {
    const roles = {
      "plan-implementer": { agent_type: "herder.plan-implementer", model: "gpt-6-astra", effort: "medium" },
      "plan-reviewer": { agent_type: "herder.plan-reviewer", model: "gpt-5.6-sol", effort: "xhigh" },
      "plan-judge": { agent_type: "herder.plan-judge", model: "gpt-6-astra", effort: "xhigh" },
      rescue: { agent_type: "herder.plan-implementer", model: "gpt-6-astra", effort: "xhigh", service_tier: "standard" },
      searcher: { agent_type: "herder.searcher", model: "gpt-6-astra", effort: "medium", service_tier: "fast" },
    }
    const configuration = { profile: "universe", profileSha256: "a".repeat(64), host: "pi", roles }
    assert.equal(recordRunConfiguration(planDir, configuration).recorded, true)
    assert.deepEqual(required(readRunConfiguration(planDir).configuration).roles, roles)
    assert.equal(recordRunConfiguration(planDir, { ...configuration, roles: JSON.stringify(roles) }).recorded, false)
    for (const key of ["rescue", "searcher"] as const) {
      for (const change of [{ model: "gpt-5.6-sol" }, { effort: "high" }, { service_tier: "standard" === roles[key].service_tier ? "fast" : "standard" }]) {
        expectFailure(() => recordRunConfiguration(planDir, { ...configuration, roles: { ...roles, [key]: { ...roles[key], ...change } } }), /already bound/)
      }
      const without = { ...roles } as Record<string, unknown>
      delete without[key]
      expectFailure(() => recordRunConfiguration(planDir, { ...configuration, roles: without }), /already bound/)
      for (const [change, error] of [
        [{ agent_type: "herder.custom" }, /must use agent type/],
        [{ model: "bad model" }, /invalid model/],
        [{ effort: "ultra" }, /invalid effort/],
        [{ service_tier: "priority" }, /invalid service tier/],
        [{ extra: true }, /unknown fields/],
      ] as const) {
        expectFailure(() => recordRunConfiguration(planDir, { ...configuration, roles: { ...roles, [key]: { ...roles[key], ...change } } }), error)
      }
      expectFailure(() => recordRunConfiguration(planDir, { ...configuration, roles: { ...roles, [key]: null } }), /Missing run role/)
    }
    assert.deepEqual(required(readRunConfiguration(planDir).configuration).roles, roles)
  } finally {
    fs.rmSync(planDir, { recursive: true, force: true })
  }
})
