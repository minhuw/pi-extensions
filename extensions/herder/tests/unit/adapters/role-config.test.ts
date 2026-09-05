import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePiProfile } from "../../../src/core/profile-registry.ts";
import { HERDER_NESTED_AGENT_TYPES, loadHerderNestedAgent, loadHerderPiRole, resolveNestedBinding, validateHerderRoleAgents } from "../../../adapters/role-config.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const catalog = path.join(packageRoot, "assets/profiles/profiles.json");
const agentRoot = path.join(packageRoot, "assets/roles/pi");

const available = [
	{ provider: "proxy", id: "kimi-k3", fullId: "proxy/kimi-k3", thinkingLevelMap: { max: "max" } },
	{ provider: "proxy", id: "deepseek-v4-flash", fullId: "proxy/deepseek-v4-flash", thinkingLevelMap: { high: "high", max: null } },
	{ provider: "proxy", id: "gpt-5.6-luna", fullId: "proxy/gpt-5.6-luna", api: "cliproxyapi-codex-responses", thinkingLevelMap: { max: "max" } },
];

test("Herder loads exact scoped Pi role definitions", async () => {
	const implementer = await loadHerderPiRole(agentRoot, "plan-implementer");
	const reviewer = await loadHerderPiRole(agentRoot, "plan-reviewer");
	const judge = await loadHerderPiRole(agentRoot, "plan-judge");
	assert.equal(implementer.agentType, "herder.plan-implementer");
	assert.deepEqual(implementer.tools, ["read", "edit", "write", "bash", "ffgrep", "fffind", "ls", "Agent", "get_subagent_result"]);
	assert.deepEqual(implementer.extensions, ["git:github.com/DietrichGebert/ponytail", "npm:@ff-labs/pi-fff"]);
	assert.deepEqual(reviewer.tools, ["read", "bash", "ffgrep", "fffind", "ls", "Agent", "get_subagent_result"]);
	assert.deepEqual(reviewer.extensions, ["npm:@ff-labs/pi-fff"]);
	assert.deepEqual(judge.extensions, ["npm:@ff-labs/pi-fff"]);
	assert.doesNotMatch(implementer.systemPrompt, /^---/);
	assert.match(implementer.systemPrompt, /ROLE_CONTRACT_PATH/);
});

test("Herder loads package-owned nested definitions with reviewer-only delegation", async () => {
	assert.deepEqual(HERDER_NESTED_AGENT_TYPES, ["recon", "searcher", "worker", "reviewer"]);
	const recon = await loadHerderNestedAgent(agentRoot, "recon");
	const searcher = await loadHerderNestedAgent(agentRoot, "searcher");
	const worker = await loadHerderNestedAgent(agentRoot, "worker");
	const reviewer = await loadHerderNestedAgent(agentRoot, "reviewer");
	assert.deepEqual(recon.tools, ["read", "ffgrep", "fffind", "ls"]);
	assert.deepEqual(recon.extensions, ["npm:@ff-labs/pi-fff"]);
	assert.equal(recon.readOnly, true);
	assert.equal(recon.binding, "own");
	assert.deepEqual(recon.modelBinding, { model: "gpt-5.6-luna", effort: "max", serviceTier: "fast" });
	assert.equal(searcher.readOnly, true);
	assert.equal(searcher.binding, "own");
	assert.deepEqual(searcher.modelBinding, { model: "gpt-5.6-luna", effort: "max", serviceTier: "fast" });
	assert.deepEqual(searcher.extensions, ["npm:pi-web-access", "npm:@ff-labs/pi-fff"]);
	assert.deepEqual(searcher.tools, ["web_search", "source_check", "fetch_content", "get_search_content", "fffind", "ffgrep"]);
	assert.equal(worker.readOnly, false);
	assert.equal(worker.binding, "inherit");
	assert.equal(worker.modelBinding, undefined);
	assert.deepEqual(worker.extensions, ["git:github.com/DietrichGebert/ponytail", "npm:@ff-labs/pi-fff"]);
	assert.deepEqual(worker.tools, ["read", "edit", "write", "bash", "ffgrep", "fffind", "ls"]);
	assert.equal(reviewer.readOnly, false);
	assert.equal(reviewer.binding, "inherit");
	assert.equal(reviewer.modelBinding, undefined);
	assert.deepEqual(reviewer.extensions, ["npm:@ff-labs/pi-fff"]);
	assert.deepEqual(reviewer.tools, ["read", "bash", "ffgrep", "fffind", "ls", "Agent", "get_subagent_result"]);
	for (const serviceTier of ["fast", "standard", undefined] as const) {
		const parent = { model: "parent/reviewer", effort: "max", ...(serviceTier ? { serviceTier } : {}) };
		assert.deepEqual(resolveNestedBinding(reviewer, parent), parent);
	}
	for (const definition of [recon, searcher, worker]) {
		assert.equal(definition.tools.includes("Agent"), false);
		assert.equal(definition.tools.includes("get_subagent_result"), false);
	}
});

test("roles encourage bounded Recon exploration without delegating judgment", async () => {
	for (const role of ["plan-implementer", "plan-reviewer", "plan-judge"] as const) {
		const { systemPrompt } = await loadHerderPiRole(agentRoot, role);
		assert.match(systemPrompt, /Prefer (?:bounded )?Recon/);
		assert.match(systemPrompt, /concrete question, starting paths, stopping boundary, and compact evidence request/);
		assert.match(systemPrompt, /direct known-path reads need no scout/i);
	}
	const { systemPrompt } = await loadHerderNestedAgent(agentRoot, "reviewer");
	assert.match(systemPrompt, /Prefer `recon` for a bounded unfamiliar-code/);
	assert.match(systemPrompt, /not a runtime tester or general reviewer/);
});

test("recon positively defines bounded static work and early caller-owned handoff", async () => {
	const { systemPrompt } = await loadHerderNestedAgent(agentRoot, "recon");
	assert.match(systemPrompt, /source-navigation child in the supplied current worktree/);
	assert.match(systemPrompt, /reading files, locating paths and symbols with FFF/);
	assert.match(systemPrompt, /tracing static callers, data flow, and contracts/);
	assert.match(systemPrompt, /Start with capability triage/);
	assert.match(systemPrompt, /runtime execution, implementation, or general code-review objective, return `HANDOFF_REQUIRED` immediately/);
	assert.match(systemPrompt, /Return `PARTIAL` as soon as relevant static sources are exhausted or a tool mismatch appears/);
	assert.match(systemPrompt, /Success includes an early useful handoff/);
	assert.match(systemPrompt, /caller owns continuation; relaunch requires an explicit caller decision and a revised task or added capability/);
	assert.match(systemPrompt, /fixed hard one-hour \(1h\) wall-clock deadline, including compaction and retries/);
	assert.match(systemPrompt, /STATUS: ANSWERED \| PARTIAL \| HANDOFF_REQUIRED/);
	for (const field of ["ANSWER", "EVIDENCE", "REMAINING"]) assert.match(systemPrompt, new RegExp(`^${field}:`, "m"));
	assert.doesNotMatch(systemPrompt, /\b(?:do not|don't|don’t|never|cannot|must not|forbidden)\b/i);
});

test("subreviewer contract preserves sources and hands unresolved proof to its parent", async () => {
	const { systemPrompt } = await loadHerderNestedAgent(agentRoot, "reviewer");
	assert.match(systemPrompt, /source preservation is a behavioral contract, not a sandbox/);
	assert.match(systemPrompt, /primary hunk\/subsystem ownership, named cross-boundary questions/);
	assert.match(systemPrompt, /parent owns the compiled assignment, hash verification, and frozen authority/);
	assert.match(systemPrompt, /parent runs required shared gates once/);
	assert.match(systemPrompt, /writes in external scratch directories/);
	assert.match(systemPrompt, /at most one concurrent recon and two launches total/);
	assert.match(systemPrompt, /uncollected grandchildren fail this review closed/);
	assert.match(systemPrompt, /wait_any: true/);
	assert.match(systemPrompt, /60 seconds, then returns running without cancelling/);
	assert.match(systemPrompt, /including timeout\/error/);
	assert.match(systemPrompt, /Missing proof belongs in UNRESOLVED/);
	assert.match(systemPrompt, /Child confidence scores are not an admission gate/);
	for (const field of ["PROPOSED_FINDINGS", "UNRESOLVED", "COVERAGE"]) assert.match(systemPrompt, new RegExp(`^${field}:`, "m"));
});

test("nested reviewer rejects widened, incomplete, or dishonest permission metadata", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-pi-reviewer-metadata-"));
	try {
		await mkdir(path.join(root, "nested"));
		const file = path.join(root, "nested/reviewer.md");
		const original = await readFile(path.join(agentRoot, "nested/reviewer.md"), "utf8");
		const tools = "read, bash, ffgrep, fffind, ls, Agent, get_subagent_result";
		const cases: [string, string, RegExp][] = [
			["binding: inherit", "binding: own\nmodel: gpt-5.6-luna\neffort: max", /must inherit its parent binding/],
			["binding: inherit", "binding: other", /invalid binding/],
			["binding: inherit", "binding: inherit\nmodel: gpt-5.6-luna\neffort: max\nservice_tier: fast", /cannot declare its own model/],
			["readOnly: false", "readOnly: true", /mutating or unrestricted tool/],
			["readOnly: false", 'readOnly: "false"', /missing readOnly/],
			["package: herder", "package: other", /mismatched nested agent metadata/],
			["name: reviewer", "name: recon", /mismatched nested agent metadata/],
			["kind: nested", "kind: root", /mismatched nested agent metadata/],
			[`tools: ${tools}`, `tools: [${tools}, 42]`, /invalid tools/],
			[`tools: ${tools}`, `tools: ${tools}, read`, /duplicate tools/],
		];
		for (const tool of tools.split(", ")) {
			cases.push([`tools: ${tools}`, `tools: ${tools.split(", ").filter((item) => item !== tool).join(", ")}`, /exact reviewer tool envelope/]);
		}
		for (const tool of ["edit", "write", "unexpected", "web_search"]) {
			cases.push([`tools: ${tools}`, `tools: ${tools}, ${tool}`, /exact reviewer tool envelope/]);
		}
		for (const tool of ["herder", "subagent", "steer_subagent"]) {
			cases.push([`tools: ${tools}`, `tools: ${tools}, ${tool}`, /recursive agent tool .* is forbidden/]);
		}
		for (const extension of ["git:github.com/DietrichGebert/ponytail", "npm:pi-web-access", "npm:untrusted-extension"]) {
			cases.push(["extensions: npm:@ff-labs/pi-fff", `extensions: npm:@ff-labs/pi-fff, ${extension}`, /requests forbidden extension/]);
		}
		for (const [before, after, error] of cases) {
			await writeFile(file, original.replace(before, after));
			await assert.rejects(() => loadHerderNestedAgent(root, "reviewer"), error, after);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Herder validates package roles against the built-in engine model catalog", async () => {
	const profile = resolvePiProfile("poorman", catalog);
	await assert.doesNotReject(() => validateHerderRoleAgents(agentRoot, profile, available));
	await assert.rejects(
		() => validateHerderRoleAgents(agentRoot, profile, available.map((model) => model.id === "deepseek-v4-flash" ? { ...model, thinkingLevelMap: { high: null, max: null } } : model)),
		/does not support thinking high/,
	);
});

test("Herder refuses own-model nested agents when Luna cannot honor the scout tier", async () => {
	const profile = resolvePiProfile("poorman", catalog);
	await assert.rejects(
		() => validateHerderRoleAgents(agentRoot, profile, available.map((model) => model.id === "gpt-5.6-luna" ? { ...model, api: "openai-completions" } : model)),
		/nested agent recon cannot start because gpt-5.6-luna .* does not support service tier fast/,
	);
});

test("Herder refuses tiered roles when the resolved model cannot honor the tier", async () => {
	const profile = resolvePiProfile("eclipse", catalog);
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

		for (const [type, extension] of [
			["recon", "git:github.com/DietrichGebert/ponytail"],
			["searcher", "git:github.com/DietrichGebert/ponytail"],
			["worker", "npm:pi-web-access"],
		] as const) {
			await writeFile(path.join(nestedRoot, `${type}.md`), `---
name: ${type}
package: herder
kind: nested
description: Cross-type extension
readOnly: ${type !== "worker"}
binding: inherit
tools: read
extensions: ${extension}
---
Test.
`);
			await assert.rejects(() => loadHerderNestedAgent(root, type), new RegExp(`nested agent ${type} requests forbidden extension`));
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("role loading fails closed on disallowed extension metadata", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "herder-pi-role-extension-"));
	try {
		for (const role of ["plan-reviewer", "plan-judge"] as const) {
			await writeFile(path.join(root, `${role}.md`), `---
name: ${role}
package: herder
description: Read-only role
tools: read
extensions: git:github.com/DietrichGebert/ponytail
---
Review.
`);
			await assert.rejects(() => loadHerderPiRole(root, role), new RegExp(`role ${role} requests forbidden extension`));
		}
		await writeFile(path.join(root, "plan-implementer.md"), `---
name: plan-implementer
package: herder
description: Implementer
tools: read
extensions: git:github.com/example/unknown
---
Implement.
`);
		await assert.rejects(() => loadHerderPiRole(root, "plan-implementer"), /requests forbidden extension git:github.com\/example\/unknown/);
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
