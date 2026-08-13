import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPiProfile } from "../../../adapters/profile.ts";
import { loadHerderNestedAgent, loadHerderPiRole, validateHerderRoleAgents } from "../../../adapters/role-config.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalog = path.join(packageRoot, "assets/profiles/profiles.json");
const agentRoot = path.join(packageRoot, "assets/roles/pi");

const available = [
	{ provider: "proxy", id: "kimi-k3", fullId: "proxy/kimi-k3", thinkingLevelMap: { max: "max" } },
	{ provider: "proxy", id: "deepseek-v4-flash", fullId: "proxy/deepseek-v4-flash", thinkingLevelMap: { high: "high", max: null } },
	{ provider: "proxy", id: "gpt-5.6-luna", fullId: "proxy/gpt-5.6-luna", api: "cliproxyapi-codex-responses", thinkingLevelMap: { max: "max" } },
];

test("Herder loads exact non-recursive Pi role definitions", async () => {
	const implementer = await loadHerderPiRole(agentRoot, "plan-implementer");
	assert.equal(implementer.agentType, "herder.plan-implementer");
	assert.deepEqual(implementer.tools, ["read", "edit", "write", "bash", "grep", "find", "ls", "Agent", "get_subagent_result"]);
	assert.doesNotMatch(implementer.systemPrompt, /^---/);
	assert.match(implementer.systemPrompt, /ROLE_CONTRACT_PATH/);
});

test("Herder loads package-owned one-level nested definitions with explicit permissions", async () => {
	const recon = await loadHerderNestedAgent(agentRoot, "recon");
	const searcher = await loadHerderNestedAgent(agentRoot, "searcher");
	const worker = await loadHerderNestedAgent(agentRoot, "worker");
	assert.deepEqual(recon.tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(recon.extensions, []);
	assert.equal(recon.readOnly, true);
	assert.equal(recon.binding, "own");
	assert.deepEqual(recon.modelBinding, { model: "gpt-5.6-luna", effort: "max", serviceTier: "fast" });
	assert.equal(searcher.readOnly, true);
	assert.equal(searcher.binding, "own");
	assert.deepEqual(searcher.modelBinding, { model: "gpt-5.6-luna", effort: "max", serviceTier: "fast" });
	assert.deepEqual(searcher.extensions, ["npm:pi-web-access"]);
	assert.deepEqual(searcher.tools, ["web_search", "source_check", "fetch_content", "get_search_content"]);
	assert.equal(worker.readOnly, false);
	assert.equal(worker.binding, "inherit");
	assert.equal(worker.modelBinding, undefined);
	assert.deepEqual(worker.tools, ["read", "edit", "write", "bash", "grep", "find", "ls"]);
	for (const definition of [recon, searcher, worker]) {
		assert.equal(definition.tools.includes("Agent"), false);
		assert.equal(definition.tools.includes("get_subagent_result"), false);
	}
});

test("Herder validates package roles against the built-in engine model catalog", async () => {
	const profile = await loadPiProfile(catalog, "poorman");
	await assert.doesNotReject(() => validateHerderRoleAgents(agentRoot, profile, available));
	await assert.rejects(
		() => validateHerderRoleAgents(agentRoot, profile, available.map((model) => model.id === "deepseek-v4-flash" ? { ...model, thinkingLevelMap: { high: null, max: null } } : model)),
		/does not support thinking high/,
	);
});

test("Herder refuses own-model nested agents when Luna cannot honor the scout tier", async () => {
	const profile = await loadPiProfile(catalog, "poorman");
	await assert.rejects(
		() => validateHerderRoleAgents(agentRoot, profile, available.map((model) => model.id === "gpt-5.6-luna" ? { ...model, api: "openai-completions" } : model)),
		/nested agent recon cannot start because gpt-5.6-luna .* does not support service tier fast/,
	);
});

test("Herder refuses tiered roles when the resolved model cannot honor the tier", async () => {
	const profile = await loadPiProfile(catalog, "eclipse");
	assert.equal(profile.roles["plan-implementer"].service_tier, "fast");
	const tiered = [
		{ provider: "cliproxyapi", id: "gpt-5.6-sol", fullId: "cliproxyapi/gpt-5.6-sol", api: "cliproxyapi-codex-responses", thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
		{ provider: "cliproxyapi", id: "gpt-5.6-luna", fullId: "cliproxyapi/gpt-5.6-luna", api: "cliproxyapi-codex-responses", thinkingLevelMap: { max: "max" } },
	];
	await assert.doesNotReject(() => validateHerderRoleAgents(agentRoot, profile, tiered));
	await assert.rejects(
		() => validateHerderRoleAgents(agentRoot, profile, tiered.map((model) => model.id === "gpt-5.6-luna" ? { ...model, api: "openai-completions" } : model)),
		/does not support service tier fast/,
	);
});

test("nested role loading rejects Agent and mutating tools declared read-only", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-pi-nested-role-"));
	try {
		const nestedRoot = path.join(root, "nested");
		await mkdir(nestedRoot);
		const file = path.join(nestedRoot, "searcher.md");
		await writeFile(file, `---
name: searcher
package: herder
kind: nested
description: Reviewer
readOnly: true
binding: inherit
tools: read, Agent
---
Review.
`);
		await assert.rejects(() => loadHerderNestedAgent(root, "searcher"), /recursive agent tool Agent is forbidden/);
		await writeFile(file, `---
name: searcher
package: herder
kind: nested
description: Reviewer
readOnly: true
binding: inherit
tools: read, get_subagent_result
---
Review.
`);
		await assert.rejects(() => loadHerderNestedAgent(root, "searcher"), /recursive agent tool get_subagent_result is forbidden/);
		await writeFile(file, `---
name: searcher
package: herder
kind: nested
description: Reviewer
readOnly: true
binding: inherit
tools: read, bash
---
Review.
`);
		await assert.rejects(() => loadHerderNestedAgent(root, "searcher"), /requests a mutating or unrestricted tool/);
		await writeFile(file, `---
name: searcher
package: herder
kind: nested
description: Searcher
readOnly: true
binding: inherit
tools: web_search
extensions: npm:untrusted-extension
---
Search.
`);
		await assert.rejects(() => loadHerderNestedAgent(root, "searcher"), /requests forbidden extension npm:untrusted-extension/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("role loading allows scoped nested tools but rejects broader orchestration tools", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-pi-role-"));
	try {
		const file = path.join(root, "plan-reviewer.md");
		await writeFile(file, `---
name: plan-reviewer
package: herder
description: Reviewer
tools: read, Agent, get_subagent_result
---
Review.
`);
		assert.deepEqual((await loadHerderPiRole(root, "plan-reviewer")).tools, ["read", "Agent", "get_subagent_result"]);
		for (const forbidden of ["herder", "subagent", "steer_subagent"]) {
			await writeFile(file, `---
name: plan-reviewer
package: herder
description: Reviewer
tools: read, ${forbidden}
---
Review.
`);
			await assert.rejects(() => loadHerderPiRole(root, "plan-reviewer"), new RegExp(`recursive agent tool ${forbidden} is forbidden`));
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
