import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPiProfile } from "../../../../adapters/pi/profile.ts";
import { loadHerderPiRole, validateHerderRoleAgents } from "../../../../adapters/pi/role-config.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const catalog = path.join(packageRoot, "assets/profiles/profiles.json");
const agentRoot = path.join(packageRoot, "assets/roles/pi");

const available = [
	{ provider: "proxy", id: "kimi-k3", fullId: "proxy/kimi-k3", thinkingLevelMap: { max: "max" } },
	{ provider: "proxy", id: "deepseek-v4-flash", fullId: "proxy/deepseek-v4-flash", thinkingLevelMap: { high: "high", max: null } },
	{ provider: "proxy", id: "gpt-5.6-luna", fullId: "proxy/gpt-5.6-luna", thinkingLevelMap: { max: "max" } },
];

test("Herder loads exact non-recursive Pi role definitions", async () => {
	const implementer = await loadHerderPiRole(agentRoot, "plan-implementer");
	assert.equal(implementer.agentType, "herder.plan-implementer");
	assert.deepEqual(implementer.tools, ["read", "edit", "write", "bash", "grep", "find", "ls"]);
	assert.doesNotMatch(implementer.systemPrompt, /^---/);
	assert.match(implementer.systemPrompt, /ROLE_CONTRACT_PATH/);
});

test("Herder validates package roles against the built-in engine model catalog", async () => {
	const profile = await loadPiProfile(catalog, "poorman");
	await assert.doesNotReject(() => validateHerderRoleAgents(agentRoot, profile, available));
	await assert.rejects(
		() => validateHerderRoleAgents(agentRoot, profile, available.map((model) => model.id === "deepseek-v4-flash" ? { ...model, thinkingLevelMap: { high: null, max: null } } : model)),
		/does not support thinking high/,
	);
});

test("Herder refuses tiered roles when the resolved model cannot honor the tier", async () => {
	const profile = await loadPiProfile(catalog, "eclipse");
	assert.equal(profile.roles["plan-implementer"].service_tier, "fast");
	const tiered = [
		{ provider: "openai", id: "gpt-5.6-sol", fullId: "openai/gpt-5.6-sol", api: "openai-responses", thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
		{ provider: "openai", id: "gpt-5.6-luna", fullId: "openai/gpt-5.6-luna", api: "openai-responses", thinkingLevelMap: { max: "max" } },
	];
	await assert.doesNotReject(() => validateHerderRoleAgents(agentRoot, profile, tiered));
	await assert.rejects(
		() => validateHerderRoleAgents(agentRoot, profile, tiered.map((model) => model.id === "gpt-5.6-luna" ? { ...model, api: "openai-completions" } : model)),
		/does not support service tier fast/,
	);
});

test("role loading rejects metadata drift and recursive tools", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-pi-role-"));
	try {
		await writeFile(path.join(root, "plan-reviewer.md"), `---
name: plan-reviewer
package: herder
description: Reviewer
tools: read, subagent
---
Review.
`);
		await assert.rejects(() => loadHerderPiRole(root, "plan-reviewer"), /recursive agent tools are forbidden/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
