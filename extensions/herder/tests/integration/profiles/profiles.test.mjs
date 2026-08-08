#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const registry = path.resolve(scriptDir, "../../../src/core/profile-registry.ts");
const roles = ["plan-implementer", "plan-reviewer", "plan-judge"];
const run = (...args) => JSON.parse(execFileSync(process.execPath, [registry, ...args], { encoding: "utf8" }));

assert.deepEqual(run("check"), { ok: true, profiles: 3 });
assert.deepEqual(run("list").map((profile) => profile.name), ["eclipse", "shannon", "offcut"]);

const eclipse = run("resolve");
assert.equal(eclipse.profile, "eclipse");
assert.equal(eclipse.host, "pi");
assert.deepEqual(Object.keys(eclipse.roles), roles);
assert.deepEqual(eclipse.roles["plan-implementer"], {
  agent_type: "herder.plan-implementer",
  model: "gpt-5.6-luna",
  effort: "max",
  service_tier: "fast",
});

const offcut = run("resolve", "--host", "pi", "--profile", "offcut");
assert.deepEqual(offcut.orchestrator, { model: "kimi-k3", effort: "max" });
assert.equal(offcut.roles["plan-implementer"].model, "grok-4.5");
assert.equal(offcut.roles["plan-reviewer"].model, "gpt-5.6-sol");
assert.equal(offcut.roles["plan-judge"].effort, "xhigh");

const unsupported = spawnSync(process.execPath, [registry, "resolve", "--host", "codex"], { encoding: "utf8" });
assert.equal(unsupported.status, 2);
assert.match(unsupported.stderr, /supports only the Pi host/);

console.log("herder Pi profile registry tests passed");
