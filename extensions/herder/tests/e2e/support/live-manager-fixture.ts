#!/usr/bin/env node

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import type { SpawnSyncReturns } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { readManagerState, readUsageState } from "../../../src/daemon/execution-store.ts"
import { buildGraph, initPlanDir } from "../../../src/core/plans.ts"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "../../..")

type FixtureCommand = "create" | "verify"
interface FixtureOptions { command: FixtureCommand; workspace: string; host: string; profile: string }
interface RunOptions { cwd?: string; allowFailure?: boolean }
interface FixtureRecord { repository: string; planDirectory: string; originalHead: string; pluginRoot: string }
interface ResolvedProfileRecord {
  roles: Record<string, { model: string; effort: string; service_tier?: string }>
}

function fail(message: string): never {
  throw new Error(message)
}

function run(command: string, args: string[], options: RunOptions = {}): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    input: "",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0 && !options.allowFailure) {
    fail(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`)
  }
  return result
}

function parse(argv: string[]): FixtureOptions {
  const command = argv.shift()
  if (!command || !new Set(["create", "verify"]).has(command)) fail("usage: live-manager-fixture.ts create|verify <workspace> [--host name] [--profile name]")
  const workspace = argv.shift()
  if (!workspace) fail("workspace is required")
  const options: FixtureOptions = { command: command as FixtureCommand, workspace: path.resolve(workspace), host: "", profile: "" }
  while (argv.length) {
    const option = argv.shift()
    if (!option || !["--host", "--profile"].includes(option)) fail(`unknown option: ${option}`)
    const value = argv.shift()
    if (!value) fail(`${option} requires a value`)
    if (option === "--host") options.host = value
    else options.profile = value
  }
  if (command === "verify" && (!options.host || !options.profile)) fail("verify requires --host and --profile")
  return options
}

function createFixture(workspace: string): void {
  if (fs.existsSync(workspace) && fs.readdirSync(workspace).length > 0) fail(`workspace must be empty: ${workspace}`)
  const repository = path.join(workspace, "repository")
  fs.mkdirSync(path.join(repository, "src"), { recursive: true })
  fs.mkdirSync(path.join(repository, "test"), { recursive: true })
  fs.writeFileSync(path.join(repository, "package.json"), `${JSON.stringify({
    name: "herder-live-manager-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(repository, "AGENTS.md"), "# Test repository\n\nKeep the project dependency-free. Run `npm test` after changes.\n")
  fs.writeFileSync(path.join(repository, ".gitignore"), ".codex/\n")
  fs.writeFileSync(path.join(repository, "src/value.mjs"), "export const value = 1\n")
  fs.writeFileSync(path.join(repository, "test/value.test.mjs"), `import assert from "node:assert/strict"
import test from "node:test"
import { value } from "../src/value.mjs"

test("exports the current value", () => assert.equal(value, 1))
`)
  run("git", ["init", "-q"], { cwd: repository })
  run("git", ["config", "user.name", "Herder Live Test"], { cwd: repository })
  run("git", ["config", "user.email", "herder-live@example.invalid"], { cwd: repository })
  run("git", ["add", "."], { cwd: repository })
  run("git", ["commit", "-q", "-m", "test: add live manager fixture"], { cwd: repository })
  const originalHead = run("git", ["rev-parse", "HEAD"], { cwd: repository }).stdout.trim()
  const planDirectory = path.join(repository, "herder-plans")
  initPlanDir(planDirectory)
  fs.writeFileSync(path.join(planDirectory, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-update-value.md) | Update the exported value | P1 | S | — | TODO |

## Dependency notes

None.

## Considered and rejected

None.
`)
  fs.writeFileSync(path.join(planDirectory, "001-update-value.md"), `# Plan 001: Update the exported value

> **Executor instructions**: Follow this plan exactly. Do not edit the plan index; the deterministic Run Manager owns lifecycle state.
>
> **Drift check (run first)**: \`git diff --stat ${originalHead}..HEAD -- src/value.mjs test/value.test.mjs\`
> Stop if either file drifted from the Current state below.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`${originalHead.slice(0, 12)}\`, 2026-08-07
- **Kind**: behavioral
- **Parent objective**: Prove one complete live deterministic-manager implementation and review pipeline.

## Why this matters

The fixture provides a tiny, deterministic behavioral change that every supported host can implement and independently review without dependencies or network access.

### Accepted decisions

- Change the exported numeric value from one to two.
- Update the existing focused assertion from one to two.
- Keep the module name, export name, package format, and test command unchanged.

## Current state

- \`src/value.mjs\` exports \`value\` with the numeric value \`1\`.
- \`test/value.test.mjs\` imports \`value\` and asserts that it equals \`1\`.
- \`npm test\` passes with Node's built-in test runner.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | \`npm test\` | exits 0 with one passing test |

## Dependency contract

- **Consumes**: none.
- **Provides**: \`value\` equals two and the focused test enforces that behavior.
- **Safe intermediate state**: both owned files change in one commit and \`npm test\` passes.

## Scope

**In scope**:

- \`src/value.mjs\`
- \`test/value.test.mjs\`

**Out of scope**:

- Package metadata, dependencies, filenames, module format, exported names, and unrelated documentation.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Create one focused conventional commit.
- Do not push or merge into the user's branch.

## Steps

### Step 1: Update the implementation

Change only the numeric literal exported by \`src/value.mjs\` from \`1\` to \`2\`.

### Step 2: Update focused coverage

Change only the expected numeric literal in \`test/value.test.mjs\` from \`1\` to \`2\`.

**Verify**: \`npm test\` exits 0 with one passing test.

## Test plan

- Run \`npm test\` and require the existing focused assertion to pass.
- Inspect the diff and require exactly the two intended numeric-literal changes.

## Review map

- **Outcome**: \`value\` is two.
- **Modified symbols**: the \`value\` initializer and its focused assertion.
- **Direct contracts**: ESM import/export and strict equality.
- **Expected unchanged behavior**: filenames, export name, package format, and test command.
- **Proof**: \`npm test\` and the two-file diff.
- **Expected diff**: one numeric literal in each owned file.

## Done criteria

- [ ] \`npm test\` exits 0.
- [ ] \`src/value.mjs\` exports \`value\` as \`2\`.
- [ ] \`test/value.test.mjs\` asserts that \`value\` equals \`2\`.
- [ ] No file outside the two declared paths changes.

## STOP conditions

Stop if either owned file has drifted, if a dependency appears necessary, or if any file outside the two declared paths must change.

## Maintenance notes

Keep this fixture deliberately small so host-transport failures remain distinguishable from implementation complexity.
`)
  const graph = buildGraph(planDirectory)
  assert.equal(graph.shapeReady, true)
  assert.deepEqual(graph.ready, ["001"])
  fs.writeFileSync(path.join(workspace, "fixture.json"), `${JSON.stringify({ repository, planDirectory, originalHead, pluginRoot: PLUGIN_ROOT }, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ok: true, repository, planDirectory, originalHead, pluginRoot: PLUGIN_ROOT }, null, 2)}\n`)
}

async function verifyFixture(workspace: string, host: string, profile: string): Promise<void> {
  const fixture = JSON.parse(fs.readFileSync(path.join(workspace, "fixture.json"), "utf8")) as FixtureRecord
  const resolvedProfile = JSON.parse(run(process.execPath, [
    path.join(PLUGIN_ROOT, "src", "core", "profile-registry.ts"),
    "resolve", "--host", host, "--profile", profile,
  ], { cwd: PLUGIN_ROOT }).stdout) as ResolvedProfileRecord
  const graph = buildGraph(fixture.planDirectory)
  assert.equal(graph.complete, true)
  assert.equal(graph.counts.done, 1)
  const manager = readManagerState(fixture.planDirectory)
  assert.equal(manager.run?.status, "complete")
  assert.equal(manager.run?.host, host)
  assert.equal(manager.run?.profile, profile)
  assert.equal(manager.actions.some((action) => action.role === "plan-judge"), false)
  assert.equal(manager.actions.filter((action) => action.role === "plan-implementer").length, 1)
  assert.equal(manager.actions.filter((action) => action.role === "plan-reviewer").length, 2)
  assert.equal(manager.actions.length, 3)
  assert.equal(manager.actions.every((action) => action.state === "terminal"), true)
  assert.equal(manager.actions.every((action) => {
    const expected = resolvedProfile.roles[action.role]
    return expected
      && action.model === expected.model
      && action.effort === expected.effort
      && (action.serviceTier || null) === (expected.service_tier || null)
  }), true)
  const usage = readUsageState(fixture.planDirectory)
  assert.equal(usage.records.filter((record) => record.role === "plan-implementer").length, 1)
  assert.equal(usage.records.filter((record) => record.role === "plan-reviewer").length, 2)
  assert.equal(usage.records.length, 3)
  assert.deepEqual(usage.records.map((record) => record.outcome), ["COMPLETE", "APPROVE", "APPROVE"])
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: fixture.repository }).stdout.trim(), fixture.originalHead)
  assert.equal(run("git", ["status", "--short"], { cwd: fixture.repository }).stdout.trim(), "")
  assert.equal(fs.readFileSync(path.join(fixture.repository, "src/value.mjs"), "utf8"), "export const value = 1\n")
  const integrationBranch = "herder/herder-plans/integration"
  assert.equal(run("git", ["show", `${integrationBranch}:src/value.mjs`], { cwd: fixture.repository }).stdout, "export const value = 2\n")
  const integrationWorktree = manager.run!.integrationWorktree
  run("npm", ["test"], { cwd: integrationWorktree })
  const dashboardUrl = manager.run!.dashboardUrl as string
  assert.match(dashboardUrl, /^https?:\/\//)
  const health = await fetch(new URL("api/health", dashboardUrl))
  assert.equal(health.status, 200)
  if (host === "pi") {
    assert.equal(fs.existsSync(path.join(fixture.repository, ".pi-subagents")), false)
    const sessionRoot = path.join(fixture.planDirectory, ".herder", "pi-sessions")
    const sessionFiles = fs.readdirSync(sessionRoot).filter((file) => file.endsWith(".jsonl"))
    assert.equal(sessionFiles.length, 3)
    for (const file of sessionFiles) {
      const [firstLine] = fs.readFileSync(path.join(sessionRoot, file), "utf8").split("\n")
      const header = JSON.parse(firstLine)
      assert.equal(header.type, "session")
      assert.equal(header.parentSession, undefined)
      assert.match(header.cwd, /[/\\]\.herder[/\\]worktrees[/\\]/)
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    host,
    profile,
    runId: manager.run!.runId,
    dashboardUrl,
    actions: manager.actions.map(({ planId, role, model, effort, state, hostHandle }) => ({ planId, role, model, effort, state, hostHandle })),
    attempts: usage.records.map(({ attempt, plan, role, model, effort, outcome, source }) => ({ attempt, plan, role, model, effort, outcome, source })),
  }, null, 2)}\n`)
}

const options = parse(process.argv.slice(2))
if (options.command === "create") createFixture(options.workspace)
else await verifyFixture(options.workspace, options.host, options.profile)
