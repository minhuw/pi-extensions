import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	activeModelMatches,
	loadPiProfile,
	modelMatches,
	modelSupportsEffort,
	modelSupportsServiceTier,
	serviceTierRequestValue,
	unavailableProfileModels,
} from "../../../adapters/profile.ts";
import { resolvePiProfile } from "../../../src/core/profile-registry.ts";
import { THINKING_EFFORTS, WORKER_ROLES } from "../../../src/shared/protocol.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalog = path.join(packageRoot, "assets/profiles/profiles.json");

test("Pi resolves the poorman profile into three generic package agents", async () => {
	const profile = await loadPiProfile(catalog, "poorman");
	assert.equal(profile.host, "pi");
	assert.deepEqual(profile.orchestrator, { model: "gpt-5.6-luna", effort: "max", service_tier: "fast" });
	assert.deepEqual(profile.roles, {
		"plan-implementer": {
			agent_type: "herder.plan-implementer",
			model: "deepseek-v4-flash",
			effort: "high",
		},
		"plan-reviewer": {
			agent_type: "herder.plan-reviewer",
			model: "gpt-5.6-luna",
			effort: "max",
			service_tier: "fast",
		},
		"plan-judge": {
			agent_type: "herder.plan-judge",
			model: "gpt-5.6-luna",
			effort: "max",
			service_tier: "fast",
		},
	});

	const registryProfile = resolvePiProfile("poorman", catalog);
	assert.equal(profile.profile_sha256, registryProfile.profile_sha256);
	assert.deepEqual(profile.roles, registryProfile.roles);
});

test("Pi profile vocabulary uses the canonical worker-role and effort tuples", () => {
	assert.deepEqual(WORKER_ROLES, ["plan-implementer", "plan-reviewer", "plan-judge"]);
	assert.deepEqual(THINKING_EFFORTS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("Pi profile catalogs normalize singleton service tiers", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-pi-profile-tier-"));
	try {
		const modified = JSON.parse(readFileSync(catalog, "utf8"));
		modified.profiles[0].orchestrator.service_tier = ["fast"];
		const fixture = path.join(root, "profiles.json");
		writeFileSync(fixture, JSON.stringify(modified));
		assert.equal(resolvePiProfile("eclipse", fixture).orchestrator.service_tier, "fast");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi profile catalogs reject unsupported effort values", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-pi-profile-effort-"));
	try {
		const modified = JSON.parse(readFileSync(catalog, "utf8"));
		modified.profiles[0].orchestrator.effort = "bogus";
		const fixture = path.join(root, "profiles.json");
		writeFileSync(fixture, JSON.stringify(modified));
		assert.throws(() => loadPiProfile(fixture, "eclipse"), /invalid effort/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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

test("Pi profile catalogs require exactly the canonical worker roles", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-pi-profile-roles-"));
	try {
		const missing = JSON.parse(readFileSync(catalog, "utf8"));
		delete missing.profiles[0].roles["plan-judge"];
		const missingFixture = path.join(root, "missing.json");
		writeFileSync(missingFixture, JSON.stringify(missing));
		assert.throws(
			() => loadPiProfile(missingFixture, "eclipse"),
			/must define exactly plan-implementer, plan-reviewer, plan-judge/,
		);

		const extra = JSON.parse(readFileSync(catalog, "utf8"));
		extra.profiles[0].roles["unexpected"] = extra.profiles[0].roles["plan-judge"];
		const extraFixture = path.join(root, "extra.json");
		writeFileSync(extraFixture, JSON.stringify(extra));
		assert.throws(
			() => loadPiProfile(extraFixture, "eclipse"),
			/must define exactly plan-implementer, plan-reviewer, plan-judge/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Pi profile catalogs reject host-specific compatibility fields", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-pi-profiles-"));
	try {
		const modified = JSON.parse(readFileSync(catalog, "utf8"));
		modified.profiles[0].hosts = ["codex"];
		const fixture = path.join(root, "profiles.json");
		writeFileSync(fixture, JSON.stringify(modified));
		assert.throws(() => loadPiProfile(fixture, "eclipse"), /unknown fields: hosts/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
