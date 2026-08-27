import assert from "node:assert/strict";
import test from "node:test";
import { loadPiProfileCatalog, resolvePiProfile } from "../../../src/core/profile-registry.ts";
import { sha256, stableJson, WORKER_ROLES, type ResolvedProfile } from "../../../src/shared/protocol.ts";

test("profile registry exposes the supported Pi profiles", () => {
	const catalog = loadPiProfileCatalog();
	assert.equal(catalog.profiles.length, 4);
	assert.deepEqual(catalog.profiles.map((profile) => profile.name), ["eclipse", "poorman", "epic", "lightspeed"]);
	for (const profile of catalog.profiles) assert.equal(sha256(stableJson(profile)), resolvePiProfile(profile.name).profile_sha256);

	const expectedProfiles: Record<string, { orchestrator: ResolvedProfile["orchestrator"]; roles: ResolvedProfile["roles"] }> = {
		eclipse: {
			orchestrator: { model: "gpt-5.6-sol", effort: "xhigh" },
			roles: {
				"plan-implementer": {
					agent_type: "herder.plan-implementer",
					model: "gpt-5.6-luna",
					effort: "max",
					service_tier: "fast",
				},
				"plan-reviewer": { agent_type: "herder.plan-reviewer", model: "gpt-5.6-sol", effort: "xhigh" },
				"plan-judge": { agent_type: "herder.plan-judge", model: "gpt-5.6-sol", effort: "xhigh" },
			},
		},
		poorman: {
			orchestrator: { model: "gpt-5.6-luna", effort: "max", service_tier: "fast" },
			roles: {
				"plan-implementer": { agent_type: "herder.plan-implementer", model: "deepseek-v4-flash", effort: "high" },
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
			},
		},
		epic: {
			orchestrator: { model: "claude-fable-5", effort: "high" },
			roles: {
				"plan-implementer": { agent_type: "herder.plan-implementer", model: "claude-opus-5", effort: "high" },
				"plan-reviewer": { agent_type: "herder.plan-reviewer", model: "gpt-5.6-sol", effort: "xhigh" },
				"plan-judge": { agent_type: "herder.plan-judge", model: "claude-fable-5", effort: "high" },
			},
		},
		lightspeed: {
			orchestrator: { model: "grok-4.6", effort: "xhigh" },
			roles: {
				"plan-implementer": { agent_type: "herder.plan-implementer", model: "grok-4.6", effort: "xhigh" },
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
			},
		},
	};

	const eclipse = resolvePiProfile();
	assert.equal(eclipse.profile, "eclipse");
	assert.equal(eclipse.host, "pi");
	assert.deepEqual(eclipse.orchestrator, expectedProfiles.eclipse.orchestrator);
	assert.deepEqual(eclipse.roles, expectedProfiles.eclipse.roles);
	assert.deepEqual(Object.keys(eclipse.roles), WORKER_ROLES);

	for (const name of ["poorman", "epic", "lightspeed"]) {
		const profile = resolvePiProfile(name);
		assert.equal(profile.profile, name);
		assert.equal(profile.host, "pi");
		assert.deepEqual(profile.orchestrator, expectedProfiles[name].orchestrator);
		assert.deepEqual(profile.roles, expectedProfiles[name].roles);
		assert.deepEqual(Object.keys(profile.roles), WORKER_ROLES);
	}

	assert.throws(() => resolvePiProfile("codex"), /Unknown Herder profile/);
});
