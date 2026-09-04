#!/usr/bin/env node

import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { executionDatabasePath, executionReport, openExecutionDatabase, recordUsageRecord } from "../../../src/daemon/execution-store.ts"
import type { UsageRecord, UsageRecordInput } from "../../../src/daemon/execution-store.ts"
import { buildCompletionProofPayload, writeCompletionProof } from "../../../src/daemon/git/completion-proof.ts"
import { RunStore, type StoredPlanSpec } from "../../../src/daemon/run-store.ts"
import { attentionRequestSha256, sha256 } from "../../../src/shared/protocol.ts"
import { buildDashboardState, buildForecast, classifyPlanPhase, parseLease, type PlanPhaseObservation } from "../../../src/dashboard/dashboard-state.ts"
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

type UsageInput = UsageRecordInput

function usage(planDir: string, input: Partial<UsageInput>): void {
  recordUsageRecord(planDir, {
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

function createFixture(withUsage = true) {
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

  if (withUsage) {
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
  }

  git(repo, "branch", "herder/demo/integration")
  git(repo, "branch", "herder/demo/002")
  const worker = path.join(root, "worker-002")
  git(repo, "worktree", "add", "-q", worker, "herder/demo/002")
  git(repo, "worktree", "lock", "--reason", "plan-herder:demo:002:plan-reviewer:demo-002-reviewer-2:review", worker)
  const integration = path.join(root, "integration")
  git(repo, "worktree", "add", "-q", integration, "herder/demo/integration")
  git(repo, "worktree", "lock", integration)
  addCompletionProof(repo, "001")
  addCompletionProof(repo, "005")
  return {
    root,
    repo,
    planDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

function createAttentionFixture(afterRootCreated?: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-dashboard-attention-test-"))
  try {
    const repo = path.join(root, "repo")
    fs.mkdirSync(repo)
    afterRootCreated?.(root)
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Herder Dashboard Attention Test")
    git(repo, "config", "user.email", "dashboard-attention@example.invalid")
    const planDir = path.join(repo, "herder-plans")
    fs.mkdirSync(planDir)
    const planName = "attention-demo"
    const title = "Persisted dashboard decision"
    const planText = planBody("001", title, "none")
    fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-decision.md) | ${title} | P1 | S | — | BLOCKED — awaiting decision |
`)
    fs.writeFileSync(path.join(planDir, "001-decision.md"), planText)
    fs.writeFileSync(path.join(repo, "fixture.txt"), "fixture\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "test: initialize dashboard attention fixture")

    const runId = "attention-demo-run"
    const baseCommit = git(repo, "rev-parse", "HEAD")
    const store = new RunStore(planDir)
    try {
      store.createRun({
        runId,
        repositoryRoot: repo,
        planDirectory: planDir,
        planName,
        host: "pi",
        profileName: "eclipse",
        profileSha256: "p".repeat(64),
        maxParallel: 1,
        currentGeneration: 1,
        graphSha256: "g".repeat(64),
        status: "needs_input",
        checkoutStateToken: "checkout",
        baseCommit,
        integrationBranch: `herder/${planName}/integration`,
        integrationWorktree: path.join(planDir, "integration"),
      })
      const spec: StoredPlanSpec = {
        runId,
        graphGeneration: 1,
        planId: "001",
        planFingerprint: "f".repeat(64),
        fingerprintVersion: 2,
        ordinal: 0,
        title,
        priority: "P1",
        effort: "S",
        kind: "behavioral",
        dependencies: [],
        initialStatus: "BLOCKED",
        initialStatusDetail: "awaiting decision",
        planFile: "001-decision.md",
        assignment: {
          snapshotSha256: "s".repeat(64),
          snapshotInputs: [],
          plan: {
            id: "001",
            title,
            kind: "behavioral",
            parentObjective: "Exercise persisted dashboard attention",
            dependencies: [],
            inScopePaths: ["src/value.mjs"],
          },
          planText,
        },
      }
      store.putPlanSpecs([spec])
      store.putPlan({
        runId,
        planId: "001",
        generation: 1,
        round: 2,
        phase: "NEEDS_INPUT",
        branch: `herder/${planName}/001`,
        worktree: path.join(root, "worker-001"),
        assignmentPath: path.join(planDir, ".herder", "assignment.json"),
        assignmentSha256: "a".repeat(64),
        snapshotSha256: "s".repeat(64),
        generationBase: baseCommit,
        reviewPass: 0,
        findings: [],
        repair: [],
        gates: [],
        approvedBase: null,
        approvedHead: null,
        approvedTree: null,
        rebase: null,
      })
      const detail = "The Judge needs a recorded decision.\nReview the persisted evidence before continuing."
      const request = {
        schemaVersion: 1,
        requestId: "attention-001",
        runId,
        planId: "001",
        generation: 1,
        round: 2,
        actionId: "attention-001:action",
        kind: "user_decision",
        state: "awaiting_input",
        cause: "judge_needs_input",
        detail,
        detailSha256: sha256(detail),
        continuation: { role: "plan-judge", phase: "READY_JUDGE" },
        question: "Which recorded decision should the Judge use?\nProvide the rationale and confirm the next step for this deliberately long attention-request-wrap-check token that must remain contained at narrow dashboard widths.",
        recommendedAction: "Answer the Judge question, then record the decision in the manager.",
        createdAt: "2026-08-03T00:00:00.000Z",
        updatedAt: "2026-08-03T00:00:00.000Z",
      } as const
      const persisted = { ...request, requestSha256: attentionRequestSha256(request) }
      store.putAttention(persisted)
      return {
        root,
        planDir,
        planName,
        expectedAttention: {
          schemaVersion: 1,
          requestId: persisted.requestId,
          runId: persisted.runId,
          planId: persisted.planId,
          generation: persisted.generation,
          round: persisted.round,
          actionId: persisted.actionId,
          requestSha256: persisted.requestSha256,
          kind: persisted.kind,
          state: persisted.state,
          cause: persisted.cause,
          detail: persisted.detail,
          detailSha256: persisted.detailSha256,
          continuation: persisted.continuation,
          question: persisted.question,
          recommendedAction: persisted.recommendedAction,
          createdAt: persisted.createdAt,
          updatedAt: persisted.updatedAt,
        },
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
      }
    } finally {
      store.close()
    }
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function createManagerLifecycleFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-dashboard-manager-lifecycle-test-"))
  try {
    const repo = path.join(root, "repo")
    fs.mkdirSync(repo)
    git(repo, "init", "-q")
    git(repo, "config", "user.name", "Herder Dashboard Manager Lifecycle Test")
    git(repo, "config", "user.email", "dashboard-manager-lifecycle@example.invalid")
    const planDir = path.join(repo, "herder-plans")
    fs.mkdirSync(planDir)
    fs.writeFileSync(path.join(planDir, ".gitignore"), ".herder/\n")
    const firstText = planBody("001", "First", "none")
    const secondText = planBody("002", "Second", "herder-plans/001-first.md")
    fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-first.md) | First | P1 | S | — | TODO |
| [002](002-second.md) | Second | P1 | S | 001 | TODO |
`)
    fs.writeFileSync(path.join(planDir, "001-first.md"), firstText)
    fs.writeFileSync(path.join(planDir, "002-second.md"), secondText)
    fs.writeFileSync(path.join(repo, "fixture.txt"), "fixture\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "test: initialize manager lifecycle fixture")

    const runId = "manager-lifecycle-run"
    const baseCommit = git(repo, "rev-parse", "HEAD")
    const store = new RunStore(planDir)
    try {
      store.createRun({
        runId,
        repositoryRoot: repo,
        planDirectory: planDir,
        planName: "demo",
        host: "pi",
        profileName: "eclipse",
        profileSha256: "p".repeat(64),
        maxParallel: 1,
        currentGeneration: 1,
        graphSha256: "g".repeat(64),
        status: "running",
        checkoutStateToken: "checkout",
        baseCommit,
        integrationBranch: "herder/demo/integration",
        integrationWorktree: path.join(root, "integration"),
      })
      const makeSpec = (planId: string, title: string, dependencies: string[], planText: string, ordinal: number): StoredPlanSpec => ({
        runId,
        graphGeneration: 1,
        planId,
        planFingerprint: "f".repeat(64),
        fingerprintVersion: 2,
        ordinal,
        title,
        priority: "P1",
        effort: "S",
        kind: "behavioral",
        dependencies,
        initialStatus: "TODO",
        initialStatusDetail: "",
        planFile: `${planId}-${title.toLowerCase()}.md`,
        assignment: {
          snapshotSha256: "s".repeat(64),
          snapshotInputs: [],
          plan: {
            id: planId,
            title,
            kind: "behavioral",
            parentObjective: "Exercise manager lifecycle projections",
            dependencies,
            inScopePaths: [`src/${planId}.mjs`],
          },
          planText,
        },
      })
      store.putPlanSpecs([
        makeSpec("001", "First", [], firstText, 0),
        makeSpec("002", "Second", ["001"], secondText, 1),
      ])
      store.putPlan({
        runId,
        planId: "001",
        generation: 1,
        round: 1,
        phase: "FINAL_APPROVED",
        branch: "herder/demo/001",
        worktree: path.join(root, "worker-001"),
        assignmentPath: path.join(planDir, ".herder", "assignment.json"),
        assignmentSha256: "a".repeat(64),
        snapshotSha256: "s".repeat(64),
        generationBase: baseCommit,
        reviewPass: 0,
        findings: [],
        repair: [],
        gates: [],
        approvedBase: null,
        approvedHead: null,
        approvedTree: null,
        rebase: null,
      })
    } finally {
      store.close()
    }
    usage(planDir, {
      attempt: "demo-002-legacy-implementer-1",
      plan: "002",
      role: "plan-implementer",
      outcome: "COMPLETE",
      round: "1",
      startedAt: "2026-08-03T00:00:00Z",
      finishedAt: "2026-08-03T00:02:00Z",
    })
    addCompletionProof(repo, "002")
    const legacyWorktree = path.join(root, "worker-002")
    git(repo, "worktree", "add", "-q", "-b", "herder/demo/002", legacyWorktree, "HEAD")
    git(repo, "worktree", "lock", "--reason=plan-herder:demo:002:plan-implementer:legacy", legacyWorktree)
    return { root, planDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    throw error
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
    assert.equal(Object.hasOwn(unsupportedAccess, "forwardedUrl"), false)
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
      nestedUsage: [],
    }
    const legacyAttempt = (role: string, outcome: string, round = 1): UsageRecord => ({
      ...reviewAttempt,
      role,
      outcome,
      round,
    })
    const legacyCases: Array<{
      observation: Extract<PlanPhaseObservation, { source: "legacy" }>
      expected: ReturnType<typeof classifyPlanPhase>
    }> = [
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [], lease: null, completion: {} }, expected: "complete" },
      { observation: { source: "legacy", plan: { status: "DONE", unsatisfied: [] }, attempts: [], lease: null, completion: null }, expected: "complete" },
      { observation: { source: "legacy", plan: { status: "REJECTED", unsatisfied: [] }, attempts: [], lease: null, completion: null }, expected: "rejected" },
      { observation: { source: "legacy", plan: { status: "BLOCKED", unsatisfied: [] }, attempts: [], lease: null, completion: null }, expected: "blocked" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [], lease: { role: "plan-implementer", attempt: null, task: null, reason: "test" }, completion: null }, expected: "implementation" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [], lease: { role: "plan-reviewer", attempt: null, task: null, reason: "test" }, completion: null }, expected: "review" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [], lease: { role: "plan-judge", attempt: null, task: null, reason: "test" }, completion: null }, expected: "judge" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [], lease: { role: "other", attempt: null, task: null, reason: "test" }, completion: null }, expected: "coordination" },
      { observation: { source: "legacy", plan: { status: "TODO", unsatisfied: ["001"] }, attempts: [], lease: null, completion: null }, expected: "waiting" },
      { observation: { source: "legacy", plan: { status: "TODO", unsatisfied: [] }, attempts: [], lease: null, completion: null }, expected: "ready" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [], lease: null, completion: null }, expected: "queued" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [legacyAttempt("plan-implementer", "SUCCESS")], lease: null, completion: null }, expected: "gates" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [legacyAttempt("plan-implementer", "REVISE")], lease: null, completion: null }, expected: "repair" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [legacyAttempt("plan-reviewer", "APPROVE")], lease: null, completion: null }, expected: "integration" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [legacyAttempt("plan-reviewer", "REVISE", 2)], lease: null, completion: null }, expected: "repair" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [legacyAttempt("plan-reviewer", "REVISE", 3)], lease: null, completion: null }, expected: "judge-queued" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [legacyAttempt("plan-judge", "DONE")], lease: null, completion: null }, expected: "integration" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [legacyAttempt("plan-judge", "REJECT")], lease: null, completion: null }, expected: "repair" },
      { observation: { source: "legacy", plan: { status: "IN PROGRESS", unsatisfied: [] }, attempts: [legacyAttempt("other", "DONE")], lease: null, completion: null }, expected: "coordination" },
    ]
    for (const testCase of legacyCases) {
      assert.equal(classifyPlanPhase(testCase.observation), testCase.expected)
    }

    const managerCases: Array<{
      observation: Extract<PlanPhaseObservation, { source: "manager" }>
      expected: ReturnType<typeof classifyPlanPhase>
    }> = [
      { observation: { source: "manager", spec: { initialStatus: "DONE" }, runtime: null, activeAction: null, unsatisfied: [] }, expected: "complete" },
      { observation: { source: "manager", spec: { initialStatus: "REJECTED" }, runtime: null, activeAction: null, unsatisfied: [] }, expected: "rejected" },
      { observation: { source: "manager", spec: { initialStatus: "BLOCKED" }, runtime: null, activeAction: null, unsatisfied: [] }, expected: "blocked" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: null, activeAction: null, unsatisfied: ["001"] }, expected: "waiting" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: null, activeAction: null, unsatisfied: [] }, expected: "ready" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "DONE" }, activeAction: null, unsatisfied: [] }, expected: "complete" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "FINAL_APPROVED" }, activeAction: null, unsatisfied: [] }, expected: "complete" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "BLOCKED" }, activeAction: null, unsatisfied: [] }, expected: "blocked" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "NEEDS_INPUT" }, activeAction: null, unsatisfied: [] }, expected: "blocked" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "READY_TO_INTEGRATE" }, activeAction: null, unsatisfied: [] }, expected: "integration" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "READY_JUDGE" }, activeAction: {}, unsatisfied: [] }, expected: "judge" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "JUDGING" }, activeAction: null, unsatisfied: [] }, expected: "judge-queued" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "READY_REVIEWER" }, activeAction: null, unsatisfied: [] }, expected: "review" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "REVIEWING" }, activeAction: null, unsatisfied: [] }, expected: "review" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "READY_IMPLEMENTER", round: 2 }, activeAction: null, unsatisfied: [] }, expected: "repair" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "READY_IMPLEMENTER", round: 2 }, activeAction: {}, unsatisfied: [] }, expected: "implementation" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "IMPLEMENTING", round: 1 }, activeAction: {}, unsatisfied: [] }, expected: "implementation" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "READY_IMPLEMENTER", round: 1 }, activeAction: null, unsatisfied: [] }, expected: "ready" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "IMPLEMENTING", round: 2 }, activeAction: null, unsatisfied: [] }, expected: "repair" },
      { observation: { source: "manager", spec: { initialStatus: "TODO" }, runtime: { phase: "OTHER" }, activeAction: null, unsatisfied: [] }, expected: "coordination" },
      { observation: { source: "manager", spec: { initialStatus: "DONE" }, runtime: { phase: "READY_IMPLEMENTER", round: 1 }, activeAction: null, unsatisfied: [] }, expected: "ready" },
    ]
    for (const testCase of managerCases) {
      assert.equal(classifyPlanPhase(testCase.observation), testCase.expected)
    }
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
    assert.equal(state.version, 2)
    assert.equal(Object.hasOwn(state, "attention"), false)
    assert.equal(state.plans.some((plan) => Object.hasOwn(plan, "attention")), false)
    assert.equal(state.readOnly, true)
    assert.equal(state.planSet.name, "demo")
    assert.deepEqual(state.planSet.counts, { total: 6, todo: 2, inProgress: 1, done: 2, blocked: 1, rejected: 0, actionable: 4 })
    assert.equal(state.accounting.storage, "sqlite")
    assert.equal(state.accounting.attempts, 7)
    assert.equal(state.accounting.tokens.reportedInputOutput, 8400)
    assert.deepEqual(state.accounting.byRole, [
      { key: "plan-implementer", attempts: 3, tokenAttempts: 3, knownTokens: 3600 },
      { key: "plan-judge", attempts: 1, tokenAttempts: 1, knownTokens: 1200 },
      { key: "plan-reviewer", attempts: 3, tokenAttempts: 3, knownTokens: 3600 },
    ])
    assert.deepEqual(state.accounting.byOutcome, [
      { key: "APPROVE", attempts: 2, tokenAttempts: 2, knownTokens: 2400 },
      { key: "COMPLETE", attempts: 3, tokenAttempts: 3, knownTokens: 3600 },
      { key: "INTERRUPTED", attempts: 1, tokenAttempts: 1, knownTokens: 1200 },
      { key: "REVISE", attempts: 1, tokenAttempts: 1, knownTokens: 1200 },
    ])
    assert.deepEqual(state.accounting.byModel, [
      { key: "gpt-5.6-sol / xhigh", attempts: 7, tokenAttempts: 7, knownTokens: 8400 },
    ])
    assert.deepEqual(state.accounting.byHarness, [
      { key: "codex", attempts: 7, tokenAttempts: 7, knownTokens: 8400 },
    ])
    assert.ok(state.integration.branch)
    assert.equal(state.integration.branch.name, "herder/demo/integration")
    assert.equal(state.integration.branch.head, git(fixture.repo, "rev-parse", "HEAD"))
    assert.ok(state.integration.worktree)
    assert.equal(state.integration.worktree.head, git(fixture.repo, "rev-parse", "HEAD"))
    assert.equal(state.integration.worktree.locked, true)
    assert.equal(state.integration.worktree.lockReason, null)
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
    assert.ok(reviewingPlan.worktree)
    assert.equal(reviewingPlan.worktree.head, git(fixture.repo, "rev-parse", "herder/demo/002"))
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

    const emptyFixture = createFixture(false)
    try {
      const before = buildDashboardState({ planDir: emptyFixture.planDir, planName: "demo" })
      const accountingValues = (accounting: typeof before.accounting) => ({
        attempts: accounting.attempts,
        rounds: accounting.rounds,
        interruptions: accounting.interruptions,
        tokenCoverage: accounting.tokenCoverage,
        tokens: accounting.tokens,
        timing: accounting.timing,
        byRole: accounting.byRole,
        byOutcome: accounting.byOutcome,
        byModel: accounting.byModel,
        byHarness: accounting.byHarness,
      })
      assert.equal(before.accounting.databaseExists, false)
      assert.equal(before.accounting.storage, "uninitialized")
      assert.deepEqual(accountingValues(before.accounting), {
        attempts: 0,
        rounds: [],
        interruptions: 0,
        tokenCoverage: { reported: 0, total: 0 },
        tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0, reportedInputOutput: 0 },
        timing: {
          startedAt: null,
          finishedAt: null,
          wallClockMs: null,
          attemptDurationMs: null,
          durationCoverage: { reported: 0, total: 0 },
        },
        byRole: [],
        byOutcome: [],
        byModel: [],
        byHarness: [],
      })
      const database = openExecutionDatabase(emptyFixture.planDir, { create: true })
      database.close()
      const after = buildDashboardState({ planDir: emptyFixture.planDir, planName: "demo" })
      assert.equal(after.accounting.databaseExists, true)
      assert.equal(after.accounting.storage, "sqlite")
      assert.deepEqual(accountingValues(after.accounting), accountingValues(before.accounting))
      assert.deepEqual(after.accounting.byRole, [])
      assert.deepEqual(after.accounting.byOutcome, [])
      assert.deepEqual(after.accounting.byModel, [])
      assert.deepEqual(after.accounting.byHarness, [])
    } finally {
      emptyFixture.cleanup()
    }

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
      const cssText = await css.text()
      assert.match(cssText, /--background: oklch/)
      assert.match(cssText, /\.attention-card\s*\{/)
      assert.match(cssText, /white-space: pre-wrap/)
      assert.match(cssText, /overflow-wrap: anywhere/)
      assert.match(cssText, /\.accounting-panel\s*\{/)
      assert.match(cssText, /\.accounting-table-grid\s*\{/)
      assert.match(cssText, /\.accounting-table-wrap\s*\{/)
      assert.match(cssText, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
      assert.match(cssText, /\.accounting-table-grid[\s\S]*?grid-template-columns: 1fr/)
      assert.doesNotMatch(cssText, /data-phase="recovery"/)
      const script = await fetch(new URL("dashboard.js", dashboard.url))
      assert.equal(script.status, 200)
      const scriptText = await script.text()
      assert.match(scriptText, /REFRESH_INTERVAL_MS = 2000/)
      assert.match(scriptText, /function createAccountingPanel/)
      assert.match(scriptText, /document\.createElement\("details"\)/)
      assert.match(scriptText, /const accountingBody = createAccountingPanel\(\)/)
      assert.match(scriptText, /function renderAccounting\(accounting\)/)
      assert.match(scriptText, /No accounting data yet\./)
      assert.match(scriptText, /Cumulative attempt duration/)
      assert.match(scriptText, /Wall-clock duration/)
      assert.match(scriptText, /accountingBody\.replaceChildren/)
      assert.match(scriptText, /function renderAttention/)
      assert.match(scriptText, /attention\.question \?\? attention\.detail/)
      assert.match(scriptText, /recommendedAction/)
      assert.match(scriptText, /REQUEST \$\{String\(attention\.requestId/)
      assert.match(scriptText, /installSectionControls/)
      assert.doesNotMatch(scriptText, /"recovery",/)
      const api = await fetch(new URL("api/state", dashboard.url))
      assert.equal(api.status, 200)
      assert.equal(api.headers.get("cache-control"), "no-store")
      const apiState = await api.json() as { planSet: { name: string }; accounting: { attempts: number } }
      assert.equal(apiState.planSet.name, "demo")
      assert.equal(apiState.accounting.attempts, 7)

      const emptyFixtureForServer = createFixture(false)
      try {
        const emptyDashboard = await createDashboardServer({ planDir: emptyFixtureForServer.planDir, planName: "demo", port: 0 })
        try {
          const emptyApi = await fetch(new URL("api/state", emptyDashboard.url))
          assert.equal(emptyApi.status, 200)
          const emptyState = await emptyApi.json() as {
            accounting: {
              databaseExists: boolean
              attempts: number
              rounds: unknown[]
              interruptions: number
              tokenCoverage: { reported: number; total: number }
              tokens: { reportedInputOutput: number }
              byRole: unknown[]
              byOutcome: unknown[]
              byModel: unknown[]
              byHarness: unknown[]
            }
          }
          assert.equal(emptyState.accounting.databaseExists, false)
          assert.deepEqual({
            attempts: emptyState.accounting.attempts,
            rounds: emptyState.accounting.rounds,
            interruptions: emptyState.accounting.interruptions,
            tokenCoverage: emptyState.accounting.tokenCoverage,
            reportedInputOutput: emptyState.accounting.tokens.reportedInputOutput,
            byRole: emptyState.accounting.byRole,
            byOutcome: emptyState.accounting.byOutcome,
            byModel: emptyState.accounting.byModel,
            byHarness: emptyState.accounting.byHarness,
          }, {
            attempts: 0,
            rounds: [],
            interruptions: 0,
            tokenCoverage: { reported: 0, total: 0 },
            reportedInputOutput: 0,
            byRole: [],
            byOutcome: [],
            byModel: [],
            byHarness: [],
          })
          const emptyScript = await fetch(new URL("dashboard.js", emptyDashboard.url))
          assert.equal(await emptyScript.text(), scriptText)
          const emptyCss = await fetch(new URL("dashboard.css", emptyDashboard.url))
          assert.equal(await emptyCss.text(), cssText)
        } finally {
          await emptyDashboard.close()
        }
      } finally {
        emptyFixtureForServer.cleanup()
      }

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

async function serveFixture(fixture: { planDir: string; cleanup: () => void; planName?: string }): Promise<void> {
  const dashboard = await createDashboardServer({ planDir: fixture.planDir, planName: fixture.planName ?? "demo", port: 0 })
  process.stdout.write(`HERDER_DASHBOARD_URL=${dashboard.url}\n`)
  const shutdown = async () => {
    await dashboard.close()
    fixture.cleanup()
    process.exitCode = 0
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

const serveAttention = process.argv.slice(2).includes("--serve-attention")
const serveEmptyAccounting = process.argv.slice(2).includes("--serve-empty-accounting")
const serve = process.argv.slice(2).includes("--serve")
if (serveAttention) {
  await serveFixture(createAttentionFixture())
} else if (serveEmptyAccounting) {
  await serveFixture(createFixture(false))
} else if (serve) {
  await serveFixture(createFixture())
} else {
  test("dashboard attention fixture removes its root when setup fails", () => {
    let root: string | undefined
    const setupError = new Error("injected dashboard attention fixture setup failure")
    assert.throws(
      () => createAttentionFixture((createdRoot) => {
        root = createdRoot
        throw setupError
      }),
      (error: unknown) => error === setupError,
    )
    assert.ok(root)
    assert.equal(fs.existsSync(root), false)
  })
  test("dashboard state preserves persisted attention under manager without a root duplicate", () => {
    const fixture = createAttentionFixture()
    try {
      const state = buildDashboardState({ planDir: fixture.planDir, planName: fixture.planName })
      assert.equal(state.version, 2)
      assert.equal(Object.hasOwn(state, "attention"), false)
      assert.deepEqual(state.manager.attention, fixture.expectedAttention)
      const plan = state.plans.find((candidate) => candidate.id === "001")
      assert.ok(plan)
      assert.deepEqual(plan.attention, fixture.expectedAttention)
    } finally {
      fixture.cleanup()
    }
  })
  test("dashboard uses manager runtime status to unblock dependent plans", () => {
    const fixture = createManagerLifecycleFixture()
    try {
      const state = buildDashboardState({ planDir: fixture.planDir, planName: "demo" })
      assert.deepEqual(state.planSet.counts, {
        total: 2,
        todo: 1,
        inProgress: 0,
        done: 1,
        blocked: 0,
        rejected: 0,
        actionable: 1,
      })
      assert.deepEqual(state.planSet.waves, [["001"], ["002"]])
      const first = state.plans.find((plan) => plan.id === "001")
      const second = state.plans.find((plan) => plan.id === "002")
      assert.ok(first)
      assert.ok(second)
      assert.equal(first.status, "DONE")
      assert.equal(second.status, "TODO")
      assert.deepEqual(second.unsatisfied, [])
      assert.equal(second.report.attempts, 1)
      assert.equal(second.lease?.role, "plan-implementer")
      assert.ok(second.completion)
      assert.equal(second.phase, "ready")
      assert.deepEqual(state.planSet.ready, ["002"])
    } finally {
      fixture.cleanup()
    }
  })
  test("dashboard rejects invalid persisted plan specification fingerprints", () => {
    const fixture = createManagerLifecycleFixture()
    try {
      const store = new RunStore(fixture.planDir)
      try {
        store.database.exec("PRAGMA ignore_check_constraints = ON")
        store.database.prepare("UPDATE manager_plan_specs SET fingerprint_version = 1 WHERE run_id = ? AND graph_generation = ? AND plan_id = ?")
          .run("manager-lifecycle-run", 1, "001")
      } finally {
        store.close()
      }
      assert.throws(
        () => buildDashboardState({ planDir: fixture.planDir, planName: "demo" }),
        /Stored plan specification fingerprint version is invalid/,
      )
    } finally {
      fixture.cleanup()
    }
  })
  test("dashboard state, host access, and HTTP behavior remain observable", runTests)
}
