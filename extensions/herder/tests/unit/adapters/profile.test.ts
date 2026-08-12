import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	activeModelMatches,
	effectiveModelSupportsEffort,
	loadPiProfile,
	modelMatches,
	modelSupportsEffort,
	modelSupportsServiceTier,
	serviceTierRequestValue,
	unavailableProfileModels,
} from "../../../adapters/profile.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalog = path.join(packageRoot, "assets/profiles/profiles.json");
const registry = path.join(packageRoot, "src/core/profile-registry.ts");

test("Pi resolves profile models into three generic package agents", async () => {
	const eclipse = await loadPiProfile(catalog, "eclipse");
	assert.deepEqual(eclipse.orchestrator, { model: "gpt-5.6-sol", effort: "xhigh" });

	const profile = await loadPiProfile(catalog, "poorman");
	assert.equal(profile.host, "pi");
	assert.deepEqual(profile.orchestrator, { model: "gpt-5.6-luna", effort: "max" });
	assert.equal(profile.roles["plan-implementer"].agent_type, "herder.plan-implementer");
	assert.equal(profile.roles["plan-implementer"].model, "deepseek-v4-flash");
	assert.equal(profile.roles["plan-implementer"].effort, "high");
	assert.equal(profile.roles["plan-reviewer"].agent_type, "herder.plan-reviewer");

	const comet = await loadPiProfile(catalog, "comet");
	assert.deepEqual(comet.orchestrator, { model: "kimi-k3", effort: "max" });
	assert.equal(comet.roles["plan-implementer"].model, "grok-4.5");
	assert.equal(comet.roles["plan-implementer"].effort, "max");
	assert.equal(comet.roles["plan-reviewer"].model, "kimi-k3");
	assert.equal(comet.roles["plan-judge"].model, "kimi-k3");

	const maxi = await loadPiProfile(catalog, "maxi");
	assert.deepEqual(maxi.orchestrator, { model: "claude-fable-5", effort: "high" });
	assert.equal(maxi.roles["plan-implementer"].model, "claude-opus-5");
	assert.equal(maxi.roles["plan-implementer"].effort, "high");
	assert.equal(maxi.roles["plan-reviewer"].model, "gpt-5.6-sol");
	assert.equal(maxi.roles["plan-reviewer"].effort, "xhigh");
	assert.equal(maxi.roles["plan-judge"].model, "claude-fable-5");
	assert.equal(maxi.roles["plan-judge"].effort, "high");

	const registryProfile = JSON.parse(execFileSync(process.execPath, [registry, "resolve", "--host", "pi", "--profile", "poorman"], { encoding: "utf8" }));
	assert.equal(profile.profile_sha256, registryProfile.profile_sha256);
	assert.deepEqual(profile.roles, registryProfile.roles);
});

test("Pi rejects thinking levels that the resolved model cannot honor", () => {
	const grok = {
		provider: "proxy",
		id: "grok-4.5",
		fullId: "proxy/grok-4.5",
		reasoning: true,
		thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	};
	assert.equal(modelSupportsEffort(grok, "high"), true);
	assert.equal(modelSupportsEffort(grok, "max"), false);
	assert.equal(effectiveModelSupportsEffort("proxy/grok-4.5:high", "high", [grok]), true);
	assert.equal(effectiveModelSupportsEffort("proxy/grok-4.5:max", "max", [grok]), false);
	assert.equal(effectiveModelSupportsEffort("other/grok-4.5:high", "high", [grok]), false);
});

test("service tiers map to exact provider request values on capable APIs only", () => {
	assert.equal(serviceTierRequestValue("fast"), "priority");
	assert.equal(serviceTierRequestValue("standard"), "default");
	assert.throws(() => serviceTierRequestValue("flex"), /Unknown Herder service tier/);
	assert.equal(modelSupportsServiceTier({ provider: "openai", id: "gpt-5.6-luna", api: "openai-responses" }), true);
	assert.equal(modelSupportsServiceTier({ provider: "openai", id: "gpt-5.6-luna", api: "openai-codex-responses" }), true);
	assert.equal(modelSupportsServiceTier({ provider: "cliproxyapi", id: "gpt-5.6-luna", api: "cliproxyapi-codex-responses" }), true);
	assert.equal(modelSupportsServiceTier({ provider: "proxy", id: "grok-4.5", api: "openai-completions" }), false);
	assert.equal(modelSupportsServiceTier({ provider: "proxy", id: "grok-4.5" }), false);
});

test("model checks accept provider-qualified catalog entries without substitution", async () => {
	const profile = await loadPiProfile(catalog, "poorman");
	const available = [
		{ provider: "proxy", id: "kimi-k3", fullId: "proxy/kimi-k3" },
		{ provider: "proxy", id: "deepseek-v4-flash", fullId: "proxy/deepseek-v4-flash" },
		{ provider: "proxy", id: "gpt-5.6-luna", fullId: "proxy/gpt-5.6-luna" },
	];
	assert.deepEqual(unavailableProfileModels(profile, available), []);
	assert.equal(activeModelMatches(profile, available[2]), true);
	assert.equal(modelMatches("other/kimi-k3", available[0]), false);
	assert.deepEqual(unavailableProfileModels(profile, available.slice(0, 2)), ["gpt-5.6-luna"]);
});

test("Pi profile catalogs reject host-specific compatibility fields", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-pi-profiles-"));
	try {
		const modified = JSON.parse(readFileSync(catalog, "utf8"));
		modified.profiles[0].hosts = ["codex"];
		const fixture = path.join(root, "profiles.json");
		writeFileSync(fixture, JSON.stringify(modified));
		await assert.rejects(() => loadPiProfile(fixture, "eclipse"), /unknown fields: hosts/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
