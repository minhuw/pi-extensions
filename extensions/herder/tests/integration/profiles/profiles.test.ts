import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPiProfileCatalog, resolvePiProfile } from "../../../src/core/profile-registry.ts";
import { sha256, stableJson, WORKER_ROLES, type ResolvedProfile } from "../../../src/shared/protocol.ts";

test("profile registry exposes the supported Pi profiles", () => {
	const catalog = loadPiProfileCatalog();
	assert.equal(catalog.profiles.length, 4);
	assert.deepEqual(catalog.profiles.map((profile) => profile.name), ["poorman", "epic", "lightspeed", "universe"]);
	for (const profile of catalog.profiles) assert.equal(sha256(stableJson(profile)), resolvePiProfile(profile.name).profile_sha256);

	const expectedProfiles: Record<string, { orchestrator: ResolvedProfile["orchestrator"]; roles: ResolvedProfile["roles"] }> = {
		poorman: {
			orchestrator: { model: "gpt-6-luna", effort: "max", service_tier: "fast" },
			roles: {
				"plan-implementer": { agent_type: "herder.plan-implementer", model: "deepseek/deepseek-flash", effort: "high" },
				"plan-reviewer": {
					agent_type: "herder.plan-reviewer",
					model: "gpt-6-luna",
					effort: "max",
					service_tier: "fast",
				},
				"plan-judge": {
					agent_type: "herder.plan-judge",
					model: "gpt-6-luna",
					effort: "max",
					service_tier: "fast",
				},
			},
		},
		epic: {
			orchestrator: { model: "gpt-6-astra", effort: "high" },
			roles: {
				"plan-implementer": { agent_type: "herder.plan-implementer", model: "claude-opus-5-5", effort: "high" },
				"plan-reviewer": { agent_type: "herder.plan-reviewer", model: "gpt-6.1-sol", effort: "xhigh" },
				"plan-judge": { agent_type: "herder.plan-judge", model: "claude-fable-5-1", effort: "high" },
			},
		},
		lightspeed: {
			orchestrator: { model: "grok-4.6", effort: "xhigh" },
			roles: {
				"plan-implementer": { agent_type: "herder.plan-implementer", model: "grok-4.6", effort: "xhigh" },
				"plan-reviewer": {
					agent_type: "herder.plan-reviewer",
					model: "gpt-6-luna",
					effort: "max",
					service_tier: "fast",
				},
				"plan-judge": {
					agent_type: "herder.plan-judge",
					model: "gpt-6-luna",
					effort: "max",
					service_tier: "fast",
				},
			},
		},
	};

	const expectedHashes = {
		poorman: "97a6d2505bff72f466494a7050ebf5f3187262b2b242f536143eb5189eef2023",
		epic: "fe6d2f6999d8fc4598e670af46146eeca8c88df3d86b2d4a7d20a8fa56b71e12",
		lightspeed: "cb67146ee26d31ed0e6aba3e5982bc3fb1f20a9eee648ae4bd69d72c06465c6e",
	};
	for (const [name, hash] of Object.entries(expectedHashes)) {
		const profile = resolvePiProfile(name);
		assert.equal(profile.profile_sha256, hash);
		if (name !== "epic") {
			assert.equal(Object.hasOwn(profile, "rescue"), false);
			assert.equal(Object.hasOwn(profile, "searcher"), false);
		}
	}
	assert.equal(catalog.default, "universe");
	const universe = resolvePiProfile("universe");
	assert.deepEqual(universe.orchestrator, { model: "gpt-6-astra", effort: "high" });
	assert.deepEqual(universe.roles, {
		"plan-implementer": { agent_type: "herder.plan-implementer", model: "gpt-6-astra", effort: "medium" },
		"plan-reviewer": { agent_type: "herder.plan-reviewer", model: "gpt-6.1-sol", effort: "xhigh" },
		"plan-judge": { agent_type: "herder.plan-judge", model: "gpt-6-astra", effort: "xhigh" },
	});
	assert.deepEqual(universe.rescue, { agent_type: "herder.plan-implementer", model: "gpt-6-astra", effort: "xhigh" });
	assert.deepEqual(universe.searcher, { model: "gpt-6.1-sol", effort: "xhigh" });
	assert.deepEqual(Object.keys(universe.roles), WORKER_ROLES);

	assert.deepEqual(resolvePiProfile(), universe);

	const epic = resolvePiProfile("epic");
	assert.deepEqual(epic.rescue, { agent_type: "herder.plan-implementer", model: "gpt-6-astra", effort: "xhigh" });
	assert.deepEqual(epic.searcher, { model: "gpt-6.1-sol", effort: "xhigh" });

	for (const name of ["poorman", "epic", "lightspeed"]) {
		const profile = resolvePiProfile(name);
		assert.equal(profile.profile, name);
		assert.equal(profile.host, "pi");
		assert.deepEqual(profile.orchestrator, expectedProfiles[name].orchestrator);
		assert.deepEqual(profile.roles, expectedProfiles[name].roles);
		assert.deepEqual(Object.keys(profile.roles), WORKER_ROLES);
	}

	assert.throws(() => resolvePiProfile("eclipse"), /Unknown Herder profile/);
	assert.throws(() => resolvePiProfile("codex"), /Unknown Herder profile/);
});


test("optional profile mappings use strict model, effort, tier, and field validation", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-profile-mapping-"));
	const file = path.join(root, "profiles.json");
	try {
		const base = loadPiProfileCatalog().profiles.find((profile) => profile.name === "universe")!;
		for (const key of ["rescue", "searcher"]) {
			for (const [invalid, error] of [
				[null, /must be an object/],
				[[], /must be an object/],
				[{ model: "bad model", effort: "medium" }, /invalid model/],
				[{ effort: "medium" }, /invalid model/],
				[{ model: "gpt-6-astra", effort: "ultra" }, /invalid effort/],
				[{ model: "gpt-6-astra" }, /invalid effort/],
				[{ model: "gpt-6-astra", effort: "medium", service_tier: "priority" }, /invalid service tier/],
				[{ model: "gpt-6-astra", effort: "medium", service_tier: ["fast", "standard"] }, /invalid service tier/],
				[{ model: "gpt-6-astra", effort: "medium", agent_type: "custom" }, /unknown fields/],
				[{ model: "gpt-6-astra", effort: "medium", extra: true }, /unknown fields/],
			] as const) {
				fs.writeFileSync(file, JSON.stringify({ schema_version: 1, default: "universe", profiles: [{ ...base, [key]: invalid }] }));
				assert.throws(() => loadPiProfileCatalog(file), error, key);
			}
			for (const service_tier of ["fast", "standard"]) {
				const mapping = { model: "gpt-6-astra", effort: "medium", service_tier };
				fs.writeFileSync(file, JSON.stringify({ schema_version: 1, default: "universe", profiles: [{ ...base, [key]: mapping }] }));
				assert.deepEqual(loadPiProfileCatalog(file).profiles[0][key as "rescue" | "searcher"], mapping);
			}
		}
		fs.writeFileSync(file, JSON.stringify({ schema_version: 1, default: "universe", profiles: [{ ...base, rescuer: base.rescue }] }));
		assert.throws(() => loadPiProfileCatalog(file), /unknown fields: rescuer/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
