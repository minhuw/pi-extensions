#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import { loadPiProfileCatalog, resolvePiProfile } from "../../../src/core/profile-registry.ts";
import { sha256, stableJson, WORKER_ROLES } from "../../../src/shared/protocol.ts";
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
	orchestrator?: { model: string; effort: string; service_tier?: string };
};

type ProfileSummary = { name: string; description: string; sha256: string };
type ProfileCheck = { ok: boolean; profiles: number };

function run(command: "check"): ProfileCheck;
function run(command: "list"): ProfileSummary[];
function run(command: "resolve", requested?: string): ResolvedProfile;
function run(command: "check" | "list" | "resolve", requested?: string): unknown {
	const catalog = loadPiProfileCatalog();
	if (command === "check") return { ok: true, profiles: catalog.profiles.length };
	if (command === "list") return catalog.profiles.map((profile) => ({
		name: profile.name,
		description: profile.description,
		sha256: sha256(stableJson(profile)),
	}));
	return resolvePiProfile(requested);
}

test("profile registry exposes the supported Pi profiles", () => {
	assert.deepEqual(run("check"), { ok: true, profiles: 4 });
	const listed = run("list");
	assert.deepEqual(listed.map((profile) => profile.name), ["eclipse", "poorman", "epic", "lightspeed"]);
	for (const profile of listed) assert.equal(profile.sha256, resolvePiProfile(profile.name).profile_sha256);

	const expectedProfiles: Record<string, { orchestrator: NonNullable<ResolvedProfile["orchestrator"]>; roles: Record<string, ProfileRole> }> = {
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

	const eclipse = run("resolve");
	assert.equal(eclipse.profile, "eclipse");
	assert.equal(eclipse.host, "pi");
	assert.deepEqual(eclipse.orchestrator, expectedProfiles.eclipse.orchestrator);
	assert.deepEqual(eclipse.roles, expectedProfiles.eclipse.roles);
	assert.deepEqual(Object.keys(eclipse.roles), WORKER_ROLES);

	for (const name of ["poorman", "epic", "lightspeed"]) {
		const profile = run("resolve", name);
		assert.equal(profile.profile, name);
		assert.equal(profile.host, "pi");
		assert.deepEqual(profile.orchestrator, expectedProfiles[name].orchestrator);
		assert.deepEqual(profile.roles, expectedProfiles[name].roles);
		assert.deepEqual(Object.keys(profile.roles), WORKER_ROLES);
	}

	assert.throws(() => run("resolve", "codex"), /Unknown Herder profile/);
});
