#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const gateRunner = path.resolve(scriptDir, "../../../src/daemon/git/run-gate.ts");
const roundPolicy = path.resolve(scriptDir, "../../../src/daemon/git/round-policy.ts");
const pluginRoot = path.resolve(scriptDir, "../../..");
const root = await mkdtemp(path.join(tmpdir(), "herder-fire-test-"));

test("Fire policy and gate execution remain isolated and fail-closed", async () => {
try {
  const policy = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [roundPolicy, ...args], { encoding: "utf8" }));
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
  const reviewProtocol = await readFile(path.join(pluginRoot, "assets", "review", "code-review-protocol.md"), "utf8");
  assert.match(reviewProtocol, /four fresh `recon` children/);
  assert.match(reviewProtocol, /CONFIDENCE: <integer 0-100>/);
  assert.match(reviewProtocol, /confidence at least 80/);

  const gateWorktree = path.join(root, "gate-worktree");
  const gateLogs = path.join(root, "gate-logs");
  const isInside = (parent: string, candidate: string) => {
    const relative = path.relative(parent, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  await mkdir(gateWorktree);

  const ambientHome = path.join(root, "ambient-home-sentinel");
  const ambientXdg = path.join(root, "ambient-xdg-sentinel");
  const ambientSentinel = "herder-ambient-sentinel";
  const isolationScript = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const names = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"];',
    'const values = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));',
    'for (const directory of [...new Set(Object.values(values).filter(Boolean))]) fs.accessSync(directory);',
    'const probePath = path.join(process.env.TMPDIR, "probe.txt");',
    'fs.writeFileSync(probePath, "usable");',
    'process.stdout.write(JSON.stringify({ ...values, sentinel: process.env.HERDER_SYNTHETIC_SENTINEL ?? null, probe: fs.readFileSync(probePath, "utf8") }));',
  ].join("");
  const isolation = spawnSync(process.execPath, [
    gateRunner, "--cwd", gateWorktree, "--log-dir", gateLogs, "--label", "isolation", "--",
    process.execPath, "-e", isolationScript,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: ambientHome,
      XDG_CONFIG_HOME: path.join(ambientXdg, "config"),
      XDG_CACHE_HOME: path.join(ambientXdg, "cache"),
      XDG_DATA_HOME: path.join(ambientXdg, "data"),
      XDG_STATE_HOME: path.join(ambientXdg, "state"),
      XDG_RUNTIME_DIR: path.join(ambientXdg, "runtime"),
      HERDER_SYNTHETIC_SENTINEL: ambientSentinel,
    },
  });
  assert.equal(isolation.status, 0);
  const isolationEvidence = JSON.parse(isolation.stdout);
  const isolationLog = await readFile(isolationEvidence.logPath, "utf8");
  const isolationReport = JSON.parse(isolationLog);
  assert.equal(isolationReport.sentinel, null);
  assert.equal(isolationReport.probe, "usable");
  for (const directory of [
    isolationReport.HOME,
    isolationReport.XDG_CONFIG_HOME,
    isolationReport.XDG_CACHE_HOME,
    isolationReport.XDG_DATA_HOME,
    isolationReport.XDG_STATE_HOME,
    isolationReport.XDG_RUNTIME_DIR,
    isolationReport.TMPDIR,
    isolationReport.TMP,
    isolationReport.TEMP,
  ]) {
    assert.equal(path.isAbsolute(directory), true);
    assert.equal(isInside(gateWorktree, directory), false);
  }
  assert.notEqual(isolationReport.HOME, ambientHome);
  assert.equal(isolationLog.includes(ambientSentinel), false);
  assert.equal(isolationLog.includes(ambientHome), false);
  assert.equal(isolationLog.includes(ambientXdg), false);
  await assert.rejects(stat(isolationReport.HOME), { code: "ENOENT" });
  assert.ok((await stat(isolationEvidence.logPath)).isFile());

  const cleanupScript = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const report = { home: process.env.HOME, marker: "cleanup" };',
    'fs.writeFileSync(path.join(process.env.HOME, "created.txt"), "created");',
    'process.stdout.write(JSON.stringify(report));',
    'fs.chmodSync(process.env.HOME, 0o000);',
  ].join("");
  const cleanup = spawnSync(process.execPath, [
    gateRunner, "--cwd", gateWorktree, "--log-dir", gateLogs, "--label", "cleanup", "--",
    process.execPath, "-e", cleanupScript,
  ], { encoding: "utf8" });
  assert.equal(cleanup.status, 0);
  const cleanupEvidence = JSON.parse(cleanup.stdout);
  const cleanupLog = await readFile(cleanupEvidence.logPath, "utf8");
  const cleanupReport = JSON.parse(cleanupLog);
  assert.equal(cleanupReport.marker, "cleanup");
  assert.equal(cleanupEvidence.exitCode, 0);
  assert.equal(cleanupEvidence.signal, null);
  assert.equal(cleanupEvidence.timedOut, false);
  assert.equal(cleanupEvidence.logBytes, Buffer.byteLength(cleanupLog));
  assert.equal(cleanupEvidence.logSha256, createHash("sha256").update(cleanupLog).digest("hex"));
  await assert.rejects(stat(cleanupReport.home), { code: "ENOENT" });

  if (process.platform === "darwin") {
    const foundationScript = [
      'ObjC.import("Foundation");',
      'const applicationSupport = $.NSFileManager.defaultManager.URLsForDirectoryInDomains($.NSApplicationSupportDirectory, $.NSUserDomainMask).objectAtIndex(0).path.js;',
      'JSON.stringify({ home: $.NSHomeDirectory().js, applicationSupport });',
    ].join("");
    const foundation = spawnSync(process.execPath, [
      gateRunner, "--cwd", gateWorktree, "--log-dir", gateLogs, "--label", "darwin-foundation", "--",
      "/usr/bin/osascript", "-l", "JavaScript", "-e", foundationScript,
    ], { encoding: "utf8", env: { ...process.env, HOME: ambientHome } });
    assert.equal(foundation.status, 0);
    const foundationEvidence = JSON.parse(foundation.stdout);
    const foundationReport = JSON.parse(await readFile(foundationEvidence.logPath, "utf8"));
    assert.equal(path.isAbsolute(foundationReport.home), true);
    assert.equal(path.isAbsolute(foundationReport.applicationSupport), true);
    assert.equal(isInside(gateWorktree, foundationReport.home), false);
    assert.equal(isInside(gateWorktree, foundationReport.applicationSupport), false);
    assert.notEqual(foundationReport.home, ambientHome);
    assert.equal(isInside(foundationReport.home, foundationReport.applicationSupport), true);
    await assert.rejects(stat(foundationReport.home), { code: "ENOENT" });
  }

  const commandName = path.basename(process.execPath);
  const discoveryPath = [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter);
  const discovery = spawnSync(process.execPath, [
    gateRunner, "--cwd", gateWorktree, "--log-dir", gateLogs, "--label", "discovery", "--",
    commandName, "-e", 'process.stdout.write("command discovered")',
  ], { encoding: "utf8", env: { ...process.env, PATH: discoveryPath } });
  assert.equal(discovery.status, 0);
  const discoveryEvidence = JSON.parse(discovery.stdout);
  assert.match(await readFile(discoveryEvidence.logPath, "utf8"), /command discovered/);

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
});
