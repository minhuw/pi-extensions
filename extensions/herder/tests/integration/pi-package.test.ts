import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = path.resolve(extensionRoot, "../..");

test("Pi package registers Herder and its planning skills", async () => {
	const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
	assert.ok(manifest.pi.extensions.includes("./extensions/herder/adapters/pi/index.ts"));
	for (const skill of ["improve", "grill", "plans", "validate"]) {
		assert.ok(manifest.pi.skills.includes(`./extensions/herder/skills/${skill}`));
		const contents = await readFile(path.join(extensionRoot, "skills", skill, "SKILL.md"), "utf8");
		assert.match(contents, new RegExp(`^name: herder-${skill}$`, "m"));
	}
	assert.equal(Object.hasOwn(manifest.pi, "subagents"), false);
});

test("deterministic manager owns scheduling while Pi workers cannot recurse", async () => {
	const agentDir = path.join(extensionRoot, "assets/roles/pi");
	const extension = await readFile(path.join(extensionRoot, "adapters/pi/index.ts"), "utf8");
	const engine = await readFile(path.join(extensionRoot, "adapters/pi/lib/worker-engine.ts"), "utf8");
	assert.match(extension, /invokeHerderTool/);
	assert.doesNotMatch(extension, /requestService|ensureService/);
	assert.match(extension, /engine\.prepare\(\{ action, planDirectory: reply\.planDirectory \}\)/);
	assert.match(extension, /for \(const handle of prepared\) engine\.start\(handle\)/);
	assert.match(engine, /SessionManager\.create\(request\.action\.worktree, sessionRoot\)/);
	assert.match(engine, /noExtensions: true/);
	assert.match(engine, /session\.messages\.length !== 0/);
	assert.doesNotMatch(engine, /forkFrom|parentSession:/);
	for (const role of ["plan-implementer", "plan-reviewer", "plan-judge"]) {
		const contents = await readFile(path.join(agentDir, `${role}.md`), "utf8");
		assert.match(contents, /^package: herder$/m);
		assert.doesNotMatch(contents, /^tools: .*subagent/m);
		assert.match(contents, /ROLE_CONTRACT_PATH/);
		const contract = await readFile(path.join(extensionRoot, "assets/roles/contracts", `${role}.md`), "utf8");
		assert.match(contract, /Return exactly:/);
	}
});

test("Pi exposes clean agentic workflows, direct plan commands, and the exact plan application tool", async () => {
	const extension = await readFile(path.join(extensionRoot, "adapters/pi/index.ts"), "utf8");
	const workflows = await readFile(path.join(extensionRoot, "adapters/pi/lib/planning-workflows.ts"), "utf8");
	assert.match(extension, /registerPiPlanningWorkflows\(pi, PACKAGE_ROOT/);
	for (const command of ["herder-improve", "herder-grill", "herder-validate", "herder-plans"]) {
		assert.match(workflows, new RegExp(`command: "${command}"`));
	}
	assert.match(workflows, /ctx\.newSession\(\{/);
	assert.doesNotMatch(workflows, /parentSession:/);
	assert.match(workflows, /executePiPlanCommand/);
	assert.match(workflows, /mode: "direct"/);
	assert.match(workflows, /\["init", "track", "untrack"\]\.includes\(params\.operation\)/);
	assert.match(workflows, /name: "herder_plan"/);
});

test("Pi orchestration specifies clean sessions and serialized integration", async () => {
	const protocol = await readFile(path.join(extensionRoot, "adapters/pi/pi-orchestration.md"), "utf8");
	assert.match(protocol, /new persisted `SessionManager` with no parent/);
	assert.match(protocol, /managed temporary worktree/);
	assert.match(protocol, /opaque `pi-worker:` session handles/);
	assert.match(protocol, /No control slot is reserved/);
	assert.match(protocol, /only integration is serialized/);
});
