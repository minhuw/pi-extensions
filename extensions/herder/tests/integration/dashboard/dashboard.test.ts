#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { recordUsage } from "../../../src/core/plans.ts"
import { executionDatabasePath, executionReport } from "../../../src/daemon/execution-store.ts"
import type { UsageRecord } from "../../../src/daemon/execution-store.ts"
import { buildCompletionProofPayload, writeCompletionProof } from "../../../src/daemon/git/completion-proof.ts"
import { buildDashboardState, buildForecast, derivePlanPhase, parseLease, parseWorktreeList } from "../../../src/dashboard/dashboard-state.ts"
import { detectDashboardEnvironment, enableDashboardHostAccess, resolveOrcaCommand, runHostCommand } from "../../../src/dashboard/dashboard-host.ts"
import { createDashboardServer, parseDashboardArguments } from "../../../src/dashboard/herder-dashboard.ts"

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

function addCompletionProof(repo: string, planId: string): void {
  const head = git(repo, "rev-parse", "HEAD")
  const payload = buildCompletionProofPayload({
    runId: "dashboard-test",
    planId,
    generation: 1,
    round: 1,
    reviewerActionId: `reviewer-${planId}`,
    decisionActionId: `reviewer-${planId}`,
    decisionRole: "plan-reviewer",
    assignmentSha256: "a".repeat(64),
    approvedBase: head,
    approvedHead: head,
    approvedTree: git(repo, "rev-parse", "HEAD^{tree}"),
    reviewResultSha256: "b".repeat(64),
    decisionResultSha256: "b".repeat(64),
    integratedHead: head,
  })
  writeCompletionProof(repo, `refs/plan-herder/demo/completed/${planId}`, payload, `herder-demo-${planId}-generation-1`)
}

function requestWithHost(url: string, host: string): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: host } }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }))
    })
    request.on("error", reject)
  })
}

function planBody(id: string, title: string, dependencies: string): string {
  return `# Plan ${id}: ${title}

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: ${dependencies}
- **Category**: dashboard-fixture
- **Planned at**: commit \`abc1234\`, 2026-08-03
- **Kind**: behavioral
- **Parent objective**: Exercise the local Herder dashboard

## Why this matters

The dashboard needs a realistic, validated plan fixture.

## Current state

The fixture is self-contained.

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

Consumes declared predecessors and provides one validated fixture state.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Use one focused conventional commit.
- Do not push or open a pull request.

## Steps

### Step 1: Exercise the dashboard

Run the fixture.

## Test plan

Run the fixture test.

## Review map

- Outcome: the dashboard state is observable.
- Modified symbols: the fixture scope only.
- Proof: \`true\`.
- Expected unchanged behavior: all other fixtures remain unchanged.
- Expected diff: the scoped fixture path and direct tests.

## Done criteria

- [ ] \`true\` exits 0.

## STOP conditions

Stop if the fixture becomes invalid.

## Maintenance notes

Keep this fixture deterministic.
`
}

function writePlans(repo: string): string {
  const planDir = path.join(repo, "herder-plans")
  fs.mkdirSync(planDir, { recursive: true })
  fs.writeFileSync(path.join(planDir, ".gitignore"), ".herder/\n")
  fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-foundation.md) | Build execution store | P1 | M | — | DONE |
| [002](002-pipeline.md) | Run implementation review loop | P1 | L | 001 | IN PROGRESS |
| [003](003-integration.md) | Integrate reviewed branch | P1 | M | 002 | TODO |
| [004](004-recovery.md) | Recover interrupted worker | P2 | S | — | BLOCKED — awaiting operator evidence |
| [005](005-report.md) | Publish final report | P2 | S | 001 | DONE |
| [006](006-followup.md) | Prepare follow-up work | P2 | S | 001 | TODO |

## Dependency notes

The pipeline consumes the execution store; integration consumes the reviewed pipeline.

## Considered and rejected

The fixture intentionally contains one blocked plan.
`)
  const plans: Array<[string, string, string, string]> = [
    ["001", "Build execution store", "none", "foundation"],
    ["002", "Run implementation review loop", "herder-plans/001-*.md", "pipeline"],
    ["003", "Integrate reviewed branch", "herder-plans/002-*.md", "integration"],
    ["004", "Recover interrupted worker", "none", "recovery"],
    ["005", "Publish final report", "herder-plans/001-*.md", "report"],
    ["006", "Prepare follow-up work", "herder-plans/001-*.md", "followup"],
  ]
  for (const [id, title, dependencies, slug] of plans) {
    fs.writeFileSync(path.join(planDir, `${id}-${slug}.md`), planBody(id, title, dependencies))
  }
  return planDir
}

type UsageInput = Parameters<typeof recordUsage>[1]

function usage(planDir: string, input: Partial<UsageInput>): void {
  recordUsage(planDir, {
    model: "gpt-5.6-sol",
    effort: "xhigh",
    source: "codex-exec",
    generation: "generation-1",
    harness: "codex",
    serviceTier: "fast",
    inputTokens: "1000",
    cachedInputTokens: "350",
    outputTokens: "200",
    reasoningTokens: "50",
    durationMs: "120000",
    ...input,
  })
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-dashboard-test-"))
  const repo = path.join(root, "repo")
  fs.mkdirSync(repo)
  git(repo, "init", "-q")
  git(repo, "config", "user.name", "Herder Dashboard Test")
  git(repo, "config", "user.email", "dashboard-test@example.invalid")
  const planDir = writePlans(repo)
  fs.writeFileSync(path.join(repo, "fixture.txt"), "fixture\n")
  git(repo, "add", ".")
  git(repo, "commit", "-qm", "test: initialize dashboard fixture")

  usage(planDir, {
    attempt: "demo-001-implementer-1",
    plan: "001",
    role: "plan-implementer",
    outcome: "COMPLETE",
    round: "1",
    startedAt: "2026-08-03T00:00:00Z",
    finishedAt: "2026-08-03T00:02:00Z",
  })
  usage(planDir, {
    attempt: "demo-001-reviewer-1",
    plan: "001",
    role: "plan-reviewer",
    outcome: "APPROVE",
    round: "1",
    startedAt: "2026-08-03T00:02:00Z",
    finishedAt: "2026-08-03T00:04:00Z",
  })
  usage(planDir, {
    attempt: "demo-002-implementer-1",
    plan: "002",
    role: "plan-implementer",
    outcome: "COMPLETE",
    round: "1",
    startedAt: "2026-08-03T00:04:00Z",
    finishedAt: "2026-08-03T00:06:00Z",
  })
  usage(planDir, {
    attempt: "demo-002-reviewer-1",
    plan: "002",
    role: "plan-reviewer",
    outcome: "REVISE",
    round: "1",
    startedAt: "2026-08-03T00:06:00Z",
    finishedAt: "2026-08-03T00:08:00Z",
  })
  usage(planDir, {
    attempt: "demo-004-saver-1",
    plan: "004",
    role: "plan-judge",
    outcome: "INTERRUPTED",
    round: "1",
    startedAt: "2026-08-03T00:08:00Z",
    finishedAt: "2026-08-03T00:10:00Z",
  })
  usage(planDir, {
    attempt: "demo-005-implementer-1",
    plan: "005",
    role: "plan-implementer",
    outcome: "COMPLETE",
    round: "1",
    startedAt: "2026-08-03T00:10:00Z",
    finishedAt: "2026-08-03T00:12:00Z",
  })
  usage(planDir, {
    attempt: "demo-005-reviewer-1",
    plan: "005",
    role: "plan-reviewer",
    outcome: "APPROVE",
    round: "1",
    startedAt: "2026-08-03T00:12:00Z",
    finishedAt: "2026-08-03T00:14:00Z",
  })

  git(repo, "branch", "herder/demo/integration")
  git(repo, "branch", "herder/demo/002")
  const worker = path.join(root, "worker-002")
  git(repo, "worktree", "add", "-q", worker, "herder/demo/002")
  git(repo, "worktree", "lock", "--reason", "plan-herder:demo:002:plan-reviewer:demo-002-reviewer-2:review", worker)
  addCompletionProof(repo, "001")
  addCompletionProof(repo, "005")
  return {
    root,
    repo,
    planDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

async function runTests(): Promise<void> {
  const fixture = createFixture()
  try {
    assert.deepEqual(parseDashboardArguments(["--plan-dir", fixture.planDir, "--port", "0", "--pretty"]), {
      planDir: fixture.planDir,
      planName: null,
      port: 0,
      snapshot: false,
      pretty: true,
      hostIntegration: true,
      help: false,
    })
    assert.equal(parseDashboardArguments(["--no-host-integration"]).hostIntegration, false)
    assert.throws(() => parseDashboardArguments(["--port", "70000"]), /0 through 65535/)
    assert.deepEqual(detectDashboardEnvironment({ TERM_PROGRAM: "Orca" }), { kind: "orca" })
    assert.deepEqual(detectDashboardEnvironment({
      TERM_PROGRAM: "vscode",
      ORCA_PI_STATUS_OWNED: "30011",
    }), { kind: "orca" })
    assert.deepEqual(detectDashboardEnvironment({
      TERM_PROGRAM: "vscode",
      VSCODE_REMOTE_NAME: "ssh-remote",
    }), { kind: "terminal" })
    assert.deepEqual(detectDashboardEnvironment({}), { kind: "terminal" })
    assert.equal(resolveOrcaCommand({ ORCA_CLI_COMMAND: "/opt/orca-cli" }, "linux"), "/opt/orca-cli")
    assert.equal(resolveOrcaCommand({ TERM_PROGRAM: "vscode", ORCA_PI_STATUS_OWNED: "30011" }, "linux"), "orca")
    const hostCalls: Array<{ command: string; args: string[] }> = []
    const fakeRunCommand: NonNullable<Parameters<typeof enableDashboardHostAccess>[0]["runCommand"]> = async (command, args) => {
      hostCalls.push({ command, args })
      return { ok: true, code: 0, stdout: "", stderr: "", error: null }
    }
    const unsupportedAccess = await enableDashboardHostAccess({
      url: "http://127.0.0.1:4321/",
      env: { TERM_PROGRAM: "vscode", VSCODE_REMOTE_NAME: "ssh-remote" },
      runCommand: fakeRunCommand,
    })
    assert.equal(unsupportedAccess.attempted, false)
    assert.equal(unsupportedAccess.forwardedUrl, null)
    assert.deepEqual(hostCalls, [])
    const suppressedTestAccess = await enableDashboardHostAccess({
      url: "http://127.0.0.1:4321/",
      env: { NODE_TEST_CONTEXT: "child-v8", ORCA_PI_STATUS_OWNED: "30011", ORCA_CLI_COMMAND: "/opt/orca-cli" },
      runCommand: fakeRunCommand,
    })
    assert.equal(suppressedTestAccess.attempted, false)
    assert.deepEqual(hostCalls, [])
    const orcaAccess = await enableDashboardHostAccess({
      url: "http://127.0.0.1:4321/",
      env: { TERM_PROGRAM: "vscode", ORCA_PI_STATUS_OWNED: "30011", ORCA_CLI_COMMAND: "/opt/orca-cli", HERDER_ALLOW_TEST_DASHBOARD_OPEN: "1" },
      platform: "linux",
      runCommand: fakeRunCommand,
    })
    assert.equal(orcaAccess.opened, true)
    assert.deepEqual(hostCalls.pop(), {
      command: "/opt/orca-cli",
      args: ["tab", "create", "--url", "http://127.0.0.1:4321/", "--json"],
    })
    const timedOutCommand = await runHostCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 })
    assert.equal(timedOutCommand.ok, false)
    assert.equal(timedOutCommand.error, "host command timed out")
    assert.deepEqual(parseLease("plan-herder:demo:002:plan-reviewer:attempt-2:review", "demo", "002"), {
      role: "plan-reviewer",
      attempt: "attempt-2",
      task: "review",
      reason: "plan-herder:demo:002:plan-reviewer:attempt-2:review",
    })
    assert.deepEqual(parseWorktreeList("worktree /tmp/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /tmp/worker\nHEAD def456\nbranch refs/heads/herder/demo/002\nlocked plan-herder:demo:002:plan-reviewer:a:r\n"), [
      { path: "/tmp/repo", head: "abc123", branch: "main", detached: false, locked: false, lockReason: null },
      { path: "/tmp/worker", head: "def456", branch: "herder/demo/002", detached: false, locked: true, lockReason: "plan-herder:demo:002:plan-reviewer:a:r" },
    ])
    const reviewAttempt: UsageRecord = {
      attempt: "attempt-2",
      plan: "002",
      role: "plan-reviewer",
      model: "gpt-5.6-luna",
      effort: "max",
      outcome: "REVISE",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      source: "test",
      round: 3,
      generation: "generation-1",
      harness: "pi",
      serviceTier: "fast",
      startedAt: null,
      finishedAt: "2026-08-03T00:00:00Z",
      durationMs: null,
    }
    assert.equal(derivePlanPhase(
      { status: "IN PROGRESS", unsatisfied: [] },
      [reviewAttempt],
      null,
      null,
    ), "judge-queued")
    assert.equal(derivePlanPhase(
      { status: "IN PROGRESS", unsatisfied: [] },
      [],
      { role: "plan-judge", attempt: null, task: null, reason: "test" },
      null,
    ), "judge")
    assert.deepEqual(buildForecast([], executionReport([])), {
      finished: 0,
      unfinished: 0,
      percent: 0,
      sufficientEvidence: false,
      samples: 0,
      elapsedMs: null,
      estimatedPlanMs: null,
      estimatedRemainingMs: null,
      byPlan: {},
    })
    const emptyReport = executionReport([])
    const oneSample = buildForecast([
      {
        id: "001",
        phase: "complete",
        report: {
          ...emptyReport,
          attempts: 1,
          timing: { ...emptyReport.timing, attemptDurationMs: 120000, durationCoverage: { reported: 1, total: 1 } },
        },
      },
      {
        id: "002",
        phase: "ready",
        report: {
          ...emptyReport,
          timing: { ...emptyReport.timing, attemptDurationMs: null, durationCoverage: { reported: 0, total: 0 } },
        },
      },
    ], { ...emptyReport, timing: { ...emptyReport.timing, wallClockMs: 120000 } })
    assert.equal(oneSample.sufficientEvidence, false)
    assert.equal(oneSample.estimatedRemainingMs, null)
    assert.ok(oneSample.byPlan["002"])
    assert.equal(oneSample.byPlan["002"].remainingMs, null)

    const statusBefore = git(fixture.repo, "status", "--porcelain=v1")
    const databaseBefore = fs.readFileSync(executionDatabasePath(fixture.planDir))
    const state = buildDashboardState({ planDir: fixture.planDir, planName: "demo" })
    assert.equal(state.version, 1)
    assert.equal(state.readOnly, true)
    assert.equal(state.planSet.name, "demo")
    assert.deepEqual(state.planSet.counts, { total: 6, todo: 2, inProgress: 1, done: 2, blocked: 1, rejected: 0, actionable: 4 })
    assert.equal(state.accounting.storage, "sqlite")
    assert.equal(state.accounting.attempts, 7)
    assert.equal(state.accounting.tokens.reportedInputOutput, 8400)
    assert.ok(state.integration.branch)
    assert.equal(state.integration.branch.name, "herder/demo/integration")
    assert.deepEqual(state.integration.completedPlans, ["001", "005"])
    const plans = new Map(state.plans.map((plan) => [plan.id, plan]))
    const plan = (id: string) => {
      const value = plans.get(id)
      assert.ok(value, id)
      return value
    }
    assert.equal(plan("001").phase, "complete")
    const reviewingPlan = plan("002")
    assert.equal(reviewingPlan.phase, "review")
    assert.ok(reviewingPlan.lease)
    assert.equal(reviewingPlan.lease.role, "plan-reviewer")
    assert.equal(reviewingPlan.rounds[0].attempts.length, 2)
    assert.equal(plan("003").phase, "waiting")
    assert.deepEqual(plan("003").unsatisfied, ["002"])
    assert.equal(plan("004").phase, "blocked")
    assert.equal(plan("005").phase, "complete")
    assert.equal(plan("006").phase, "ready")
    assert.deepEqual(state.forecast, {
      finished: 2,
      unfinished: 4,
      percent: 33,
      sufficientEvidence: true,
      samples: 2,
      elapsedMs: 840000,
      estimatedPlanMs: 240000,
      estimatedRemainingMs: 1680000,
      byPlan: {
        "001": { remainingMs: 0 },
        "002": { remainingMs: 60000 },
        "003": { remainingMs: 240000 },
        "004": { remainingMs: null },
        "005": { remainingMs: 0 },
        "006": { remainingMs: 240000 },
      },
    })
    assert.equal(git(fixture.repo, "status", "--porcelain=v1"), statusBefore)
    assert.deepEqual(fs.readFileSync(executionDatabasePath(fixture.planDir)), databaseBefore)

    const dashboard = await createDashboardServer({ planDir: fixture.planDir, planName: "demo", port: 0 })
    try {
      const page = await fetch(dashboard.url)
      assert.equal(page.status, 200)
      assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/)
      const pageText = await page.text()
      assert.match(pageText, /Herder dashboard overview/)
      assert.equal((pageText.match(/data-section-toggle/g) ?? []).length, 3)
      assert.match(pageText, /aria-controls="pipeline-content"/)
      assert.doesNotMatch(pageText, /Observer confidence/)
      const css = await fetch(new URL("dashboard.css", dashboard.url))
      assert.equal(css.status, 200)
      assert.match(await css.text(), /--background: oklch/)
      const script = await fetch(new URL("dashboard.js", dashboard.url))
      assert.equal(script.status, 200)
      const scriptText = await script.text()
      assert.match(scriptText, /REFRESH_INTERVAL_MS = 2000/)
      assert.match(scriptText, /installSectionControls/)
      const api = await fetch(new URL("api/state", dashboard.url))
      assert.equal(api.status, 200)
      assert.equal(api.headers.get("cache-control"), "no-store")
      const apiState = await api.json() as { planSet: { name: string } }
      assert.equal(apiState.planSet.name, "demo")
      const health = await fetch(new URL("api/health", dashboard.url))
      assert.deepEqual(await health.json(), { ok: true, readOnly: true })
      const head = await fetch(dashboard.url, { method: "HEAD" })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), "")
      const post = await fetch(new URL("api/state", dashboard.url), { method: "POST" })
      assert.equal(post.status, 405)
      assert.equal(post.headers.get("allow"), "GET, HEAD")
      assert.equal((await requestWithHost(dashboard.url, `localhost:${dashboard.port}`)).status, 200)
      dashboard.allowHost("forwarded.example.invalid")
      assert.equal((await requestWithHost(dashboard.url, "forwarded.example.invalid")).status, 200)
      const rebound = await requestWithHost(dashboard.url, "dashboard.example.invalid")
      assert.equal(rebound.status, 421)
      assert.deepEqual(JSON.parse(rebound.body), { error: "invalid-host" })
      assert.equal((await fetch(new URL("missing", dashboard.url))).status, 404)
    } finally {
      await dashboard.close()
    }
    process.stdout.write("herder dashboard tests passed\n")
  } finally {
    fixture.cleanup()
  }
}

async function serveFixture(): Promise<void> {
  const fixture = createFixture()
  const dashboard = await createDashboardServer({ planDir: fixture.planDir, planName: "demo", port: 0 })
  process.stdout.write(`HERDER_DASHBOARD_URL=${dashboard.url}\n`)
  const shutdown = async () => {
    await dashboard.close()
    fixture.cleanup()
    process.exitCode = 0
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

const serve = process.argv.slice(2).includes("--serve")
if (serve) {
  await serveFixture()
} else {
  test("dashboard state, host access, and HTTP behavior remain observable", runTests)
}
