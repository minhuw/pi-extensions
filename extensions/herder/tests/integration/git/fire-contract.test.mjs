#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const gateRunner = path.resolve(scriptDir, "../../../src/daemon/git/run-gate.ts");
const roundPolicy = path.resolve(scriptDir, "../../../src/daemon/git/round-policy.ts");
const pluginRoot = path.resolve(scriptDir, "../../..");
const root = await mkdtemp(path.join(tmpdir(), "herder-fire-test-"));

try {
  const policy = (...args) => JSON.parse(execFileSync(process.execPath, [roundPolicy, ...args], { encoding: "utf8" }));
  assert.equal(policy("review", "--round", "1", "--verdict", "APPROVE", "--scope", "PASS", "--open-blockers", "0").action, "READY_TO_INTEGRATE");
  assert.equal(policy("review", "--round", "2", "--verdict", "REVISE", "--scope", "PASS", "--open-blockers", "1").action, "REPAIR_DIRECT");
  assert.equal(policy("review", "--round", "3", "--verdict", "REVISE", "--scope", "PASS", "--open-blockers", "1").action, "JUDGE");
  assert.equal(policy("judge", "--round", "3", "--decision", "REPAIR").nextRound, 4);
  assert.equal(policy("judge", "--round", "6", "--decision", "REPAIR").action, "BLOCKED_ROUND_LIMIT");
  assert.notEqual(spawnSync(process.execPath, [roundPolicy, "judge", "--round", "2", "--decision", "DONE"]).status, 0);

  for (const roleFile of ["plan-implementer.md", "plan-reviewer.md", "plan-judge.md"]) {
    const role = await readFile(path.join(pluginRoot, "assets", "roles", "contracts", roleFile), "utf8");
    assert.match(role, /assignment bundle/);
    assert.match(role, /Never modify the assignment bundle/);
    assert.match(role, /longest event-driven or blocking process wait/);
    assert.doesNotMatch(role, /^model:/m);
  }

  const gateWorktree = path.join(root, "gate-worktree");
  const gateLogs = path.join(root, "gate-logs");
  await mkdir(gateWorktree);
  const success = spawnSync(process.execPath, [
    gateRunner, "--cwd", gateWorktree, "--log-dir", gateLogs, "--label", "success", "--",
    process.execPath, "-e", 'process.stdout.write("x".repeat(250000))',
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(success.status, 0);
  assert.ok(Buffer.byteLength(success.stdout) < 2_000);
  const successEvidence = JSON.parse(success.stdout);
  assert.equal(successEvidence.logBytes, 250_000);
  assert.equal((await readFile(successEvidence.logPath)).byteLength, 250_000);

  const failure = spawnSync(process.execPath, [
    gateRunner, "--cwd", gateWorktree, "--log-dir", gateLogs, "--label", "failure", "--",
    process.execPath, "-e", 'console.error("FINAL FAILURE"); process.exit(7)',
  ], { encoding: "utf8" });
  assert.equal(failure.status, 1);
  const failureEvidence = JSON.parse(failure.stdout);
  assert.equal(failureEvidence.exitCode, 7);
  assert.doesNotMatch(failure.stdout, /FINAL FAILURE/);
  assert.match(await readFile(failureEvidence.logPath, "utf8"), /FINAL FAILURE/);

  const alias = path.join(root, "gate-worktree-alias");
  await symlink(gateWorktree, alias, "dir");
  const escapedLogs = path.join(alias, "hidden-logs");
  const escaped = spawnSync(process.execPath, [
    gateRunner, "--cwd", gateWorktree, "--log-dir", escapedLogs, "--label", "escape", "--",
    process.execPath, "-e", "process.exit(0)",
  ], { encoding: "utf8" });
  assert.equal(escaped.status, 1);
  assert.match(JSON.parse(escaped.stdout).error, /outside the command worktree/);
  await assert.rejects(stat(escapedLogs), { code: "ENOENT" });

  console.log("herder Fire policy and gate tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
