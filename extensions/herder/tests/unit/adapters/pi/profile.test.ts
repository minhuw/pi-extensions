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
	unavailableProfileModels,
} from "../../../../adapters/pi/lib/profile.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const catalog = path.join(packageRoot, "assets/profiles/profiles.json");
const registry = path.join(packageRoot, "src/core/profile-registry.ts");

test("Pi resolves profile models into three generic package agents", async () => {
	const profile = await loadPiProfile(catalog, "poorman");
	assert.equal(profile.host, "pi");
	assert.deepEqual(profile.orchestrator, { model: "kimi-k3", effort: "max" });
	assert.equal(profile.roles["plan-implementer"].agent_type, "herder.plan-implementer");
	assert.equal(profile.roles["plan-implementer"].model, "deepseek-v4-flash");
	assert.equal(profile.roles["plan-implementer"].effort, "high");
	assert.equal(profile.roles["plan-reviewer"].agent_type, "herder.plan-reviewer");

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

test("model checks accept provider-qualified catalog entries without substitution", async () => {
	const profile = await loadPiProfile(catalog, "poorman");
	const available = [
		{ provider: "proxy", id: "kimi-k3", fullId: "proxy/kimi-k3" },
		{ provider: "proxy", id: "deepseek-v4-flash", fullId: "proxy/deepseek-v4-flash" },
		{ provider: "proxy", id: "gpt-5.6-luna", fullId: "proxy/gpt-5.6-luna" },
	];
	assert.deepEqual(unavailableProfileModels(profile, available), []);
	assert.equal(activeModelMatches(profile, available[0]), true);
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
