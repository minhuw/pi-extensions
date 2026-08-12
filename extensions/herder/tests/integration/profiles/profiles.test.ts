#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const registry = path.resolve(scriptDir, "../../../src/core/profile-registry.ts");
const roles = ["plan-implementer", "plan-reviewer", "plan-judge"];

type ProfileRole = {
	agent_type: string;
	model: string;
	effort: string;
	service_tier?: string;
};

type ResolvedProfile = {
	profile: string;
	host: string;
	roles: Record<string, ProfileRole>;
	orchestrator?: { model: string; effort: string };
};

type ProfileSummary = { name: string };
type ProfileCheck = { ok: boolean; profiles: number };

function run(command: "check"): ProfileCheck;
function run(command: "list"): ProfileSummary[];
function run(command: "resolve", ...args: string[]): ResolvedProfile;
function run(...args: string[]): unknown {
	return JSON.parse(execFileSync(process.execPath, [registry, ...args], { encoding: "utf8" }));
}

test("profile registry exposes the supported Pi profiles", () => {
	assert.deepEqual(run("check"), { ok: true, profiles: 4 });
	assert.deepEqual(run("list").map((profile) => profile.name), ["eclipse", "poorman", "comet", "maxi"]);

	const eclipse = run("resolve");
	assert.equal(eclipse.profile, "eclipse");
	assert.equal(eclipse.host, "pi");
	assert.deepEqual(eclipse.orchestrator, { model: "gpt-5.6-sol", effort: "xhigh" });
	assert.deepEqual(Object.keys(eclipse.roles), roles);
	assert.deepEqual(eclipse.roles["plan-implementer"], {
		agent_type: "herder.plan-implementer",
		model: "gpt-5.6-luna",
		effort: "max",
		service_tier: "fast",
	});

	const poorman = run("resolve", "--host", "pi", "--profile", "poorman");
	assert.deepEqual(poorman.orchestrator, { model: "gpt-5.6-luna", effort: "max" });
	assert.equal(poorman.roles["plan-implementer"].model, "deepseek-v4-flash");
	assert.equal(poorman.roles["plan-reviewer"].model, "gpt-5.6-luna");
	assert.equal(poorman.roles["plan-judge"].effort, "max");

	const comet = run("resolve", "--host", "pi", "--profile", "comet");
	assert.deepEqual(comet.orchestrator, { model: "kimi-k3", effort: "max" });
	assert.equal(comet.roles["plan-implementer"].model, "grok-4.5");
	assert.equal(comet.roles["plan-reviewer"].model, "kimi-k3");
	assert.equal(comet.roles["plan-judge"].model, "kimi-k3");

	const maxi = run("resolve", "--host", "pi", "--profile", "maxi");
	assert.deepEqual(maxi.orchestrator, { model: "claude-fable-5", effort: "high" });
	assert.deepEqual(maxi.roles["plan-implementer"], {
		agent_type: "herder.plan-implementer",
		model: "claude-opus-5",
		effort: "high",
	});
	assert.deepEqual(maxi.roles["plan-reviewer"], {
		agent_type: "herder.plan-reviewer",
		model: "gpt-5.6-sol",
		effort: "xhigh",
	});
	assert.deepEqual(maxi.roles["plan-judge"], {
		agent_type: "herder.plan-judge",
		model: "claude-fable-5",
		effort: "high",
	});

	const unsupported = spawnSync(process.execPath, [registry, "resolve", "--host", "codex"], { encoding: "utf8" });
	assert.equal(unsupported.status, 2);
	assert.match(unsupported.stderr, /supports only the Pi host/);
});
