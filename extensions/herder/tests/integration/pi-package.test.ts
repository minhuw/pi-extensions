import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = path.resolve(extensionRoot, "../..");

test("Pi package registers Herder while keeping planning skills command-owned", async () => {
	const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
	assert.ok(manifest.pi.extensions.includes("./extensions/herder/adapters/index.ts"));
	assert.equal(Object.hasOwn(manifest.pi, "skills"), false);
	for (const skill of ["improve", "grill", "plans", "validate"]) {
		const contents = await readFile(path.join(extensionRoot, "skills", skill, "SKILL.md"), "utf8");
		assert.match(contents, new RegExp(`^name: herder-${skill}$`, "m"));
	}
	const improve = await readFile(path.join(extensionRoot, "skills/improve/SKILL.md"), "utf8");
	assert.doesNotMatch(improve, /closing-the-loop|`plan <description>`|`review-plan <file>`|`execute(?: \[<plan>\])?`|`reconcile`|`--issues`/);
	await assert.rejects(() => readFile(path.join(extensionRoot, "skills/improve/references/closing-the-loop.md"), "utf8"), /ENOENT/);
	assert.equal(Object.hasOwn(manifest.pi, "subagents"), false);
});

test("deterministic manager owns scheduling while Pi workers delegate only through the scoped Agent tool", async () => {
	const agentDir = path.join(extensionRoot, "assets/roles/pi");
	const extension = await readFile(path.join(extensionRoot, "adapters/index.ts"), "utf8");
	const engine = await readFile(path.join(extensionRoot, "adapters/worker-engine.ts"), "utf8");
	const transcript = await readFile(path.join(extensionRoot, "adapters/worker-transcript.ts"), "utf8");
	const nestedExecutor = await readFile(path.join(extensionRoot, "adapters/nested-agent-executor.ts"), "utf8");
	const nestedTool = await readFile(path.join(extensionRoot, "adapters/nested-agent-tool.ts"), "utf8");
	const roleConfig = await readFile(path.join(extensionRoot, "adapters/role-config.ts"), "utf8");
	assert.match(extension, /const PACKAGE_ROOT = path\.resolve\(EXTENSION_ROOT, "\.\."\);/);
	assert.match(extension, /invokeHerderTool/);
	assert.doesNotMatch(extension, /requestService|ensureService/);
	assert.match(extension, /engine\.prepare\(\{ action, planDirectory: reply\.planDirectory \}\)/);
	assert.match(extension, /name: "herder_verification"/);
	assert.match(extension, /HERDER_MAIN_SESSION_VERIFICATION_V1/);
	assert.match(extension, /PATH_POLICY: INTEGRATION_WORKTREE is an absolute LocationRoot/);
	assert.match(extension, /Tree-relative path inside the integration worktree/);
	assert.match(extension, /EXAMPLE_GATE: \{"gateId":"unit"/);
	assert.match(extension, /pi\.sendUserMessage\(prompt/);
	assert.match(extension, /submitHerderVerification/);
	assert.match(extension, /appendWorkerEntry\(HERDER_WORKER_INPUT_ENTRY, binding\.transcript\)/);
	assert.match(extension, /createWorkerOutputEntry\(binding\.transcript, completed\)/);
	assert.match(extension, /session_shutdown[\s\S]*engine\.stop\(handle\)/);
	assert.match(extension, /if \(!shuttingDown\) await dispatchReply\(reply\)/);
	assert.match(transcript, /theme\.bg\("userMessageBg", text\)/);
	assert.match(transcript, /"toolErrorBg" : "toolSuccessBg"/);
	assert.doesNotMatch(extension, /registerEntryRenderer<HerderRunState>/);
	assert.doesNotMatch(extension + engine + nestedExecutor + nestedTool + roleConfig, /extensions\/subagents|subagents\/src|subagents:telemetry|registerSubagentHost|getSubagentHost/);
	assert.match(engine, /SessionManager\.create\(request\.action\.worktree, sessionRoot\)/);
	assert.match(engine, /noExtensions: true/);
	assert.match(engine, /additionalExtensionPaths: extensionPaths/);
	assert.match(engine, /getInstalledPath\(source, "user"\)/);
	assert.doesNotMatch(engine, /getInstalledPath\(source, "project"\)/);
	assert.match(engine, /realpathSync\(trustedRoot\)/);
	assert.match(engine, /resolves outside the trusted user package store/);
	assert.match(engine, /pi install \$\{source\}/);
	assert.match(engine, /SEARCHER_TOOL_NAMES/);
	assert.match(engine, /input\.workflow = "none"/);
	assert.match(engine, /Herder searcher may fetch only remote URLs/);
	assert.match(engine, /const cacheKey = `\$\{cwd\}\\0\$\{source\}`/);
	assert.match(engine, /missing required tools/);
	assert.match(engine, /noSkills: true/);
	assert.match(engine, /noPromptTemplates: true/);
	assert.match(engine, /noThemes: true/);
	assert.match(engine, /noContextFiles: true/);
	assert.match(engine, /customTools: \[\.\.\.nestedTools\]/);
	assert.match(engine, /createNestedAgentTools/);
	assert.match(engine, /shouldStopAfterTurn/);
	assert.match(engine, /turnLimitReached/);
	assert.match(engine, /session\.messages\.length !== 0/);
	assert.doesNotMatch(engine, /forkFrom|parentSession:/);
	assert.match(nestedTool, /executionMode: "parallel"/);
	assert.match(nestedTool, /run_in_background/);
	assert.match(nestedTool, /name: "get_subagent_result"/);
	assert.doesNotMatch(nestedTool, /resolvedModel|thinking:|service_tier/);
	assert.match(roleConfig, /HERDER_NESTED_AGENT_TYPES = \["recon", "searcher", "worker"\]/);
	assert.match(roleConfig, /\["Agent", "get_subagent_result"\]/);
	assert.match(roleConfig, /STRICT_READ_ONLY_NESTED_TOOLS/);
	assert.match(nestedExecutor, /this\.action\.model/);
	assert.match(nestedExecutor, /this\.action\.effort/);
	assert.match(nestedExecutor, /scopeController/);
	assert.match(nestedExecutor, /MAX_NESTED_CONCURRENCY_PER_ACTION = 4/);
	assert.doesNotMatch(nestedExecutor, /MAX_GLOBAL_NESTED_CONCURRENCY|globalLimiter/);
	for (const type of ["recon", "searcher", "worker"]) {
		const nested = await readFile(path.join(agentDir, "nested", `${type}.md`), "utf8");
		assert.match(nested, /^package: herder$/m);
		assert.match(nested, /^kind: nested$/m);
		assert.doesNotMatch(nested, /^tools: .*Agent/m);
	}
	const searcher = await readFile(path.join(agentDir, "nested/searcher.md"), "utf8");
	assert.match(searcher, /^extensions: npm:pi-web-access$/m);
	assert.match(searcher, /^tools: web_search, source_check, fetch_content, get_search_content$/m);
	await assert.rejects(() => readFile(path.join(agentDir, "nested/reviewer.md"), "utf8"), /ENOENT/);
	const reviewProtocol = await readFile(path.join(extensionRoot, "assets/review/code-review-protocol.md"), "utf8");
	assert.match(reviewProtocol, /Wave 1: parallel candidate detection/);
	assert.match(reviewProtocol, /Wave 2: parallel independent validation/);
	assert.match(reviewProtocol, /Only `CONFIRM` records with confidence at least 80/);
	assert.match(reviewProtocol, /fresh `recon` children/);
	assert.doesNotMatch(reviewProtocol, /subagent type.*(?:critic|validator)/i);
	for (const role of ["plan-implementer", "plan-reviewer", "plan-judge"]) {
		const contents = await readFile(path.join(agentDir, `${role}.md`), "utf8");
		assert.match(contents, /^package: herder$/m);
		assert.match(contents, /^tools: .*Agent.*get_subagent_result/m);
		assert.doesNotMatch(contents, /^tools: .*(?:steer_subagent|herder)/m);
		assert.match(contents, /ROLE_CONTRACT_PATH/);
		const contract = await readFile(path.join(extensionRoot, "assets/roles/contracts", `${role}.md`), "utf8");
		assert.match(contract, /Return exactly:/);
		if (role === "plan-reviewer") {
			assert.match(contents, /REVIEW_PROTOCOL_PATH/);
			assert.match(contract, /review protocol's bounded multi-agent workflow/);
		}
	}
});

test("Pi exposes current-session agentic workflows, direct plan commands, and the exact plan application tool", async () => {
	const extension = await readFile(path.join(extensionRoot, "adapters/index.ts"), "utf8");
	const workflows = await readFile(path.join(extensionRoot, "adapters/planning-workflows.ts"), "utf8");
	assert.match(extension, /registerPiPlanningWorkflows\(pi, PACKAGE_ROOT/);
	for (const command of ["herder-improve", "herder-grill", "herder-validate", "herder-plans"]) {
		assert.match(workflows, new RegExp(`command: "${command}"`));
	}
	assert.match(workflows, /pi\.sendUserMessage\(prompt\)/);
	assert.doesNotMatch(workflows, /ctx\.newSession\(\{/);
	assert.match(workflows, /executePiPlanCommand/);
	assert.match(workflows, /mode: "direct"/);
	assert.match(workflows, /\["init", "track", "untrack"\]\.includes\(params\.operation\)/);
	assert.match(workflows, /name: "herder_plan"/);
});

test("Pi orchestration specifies clean sessions and serialized integration", async () => {
	const protocol = await readFile(path.join(extensionRoot, "adapters/README.md"), "utf8");
	assert.match(protocol, /new persisted `SessionManager` with no parent/);
	assert.match(protocol, /managed temporary worktree/);
	assert.match(protocol, /opaque `pi-worker:` session handles/);
	assert.match(protocol, /No control slot is reserved/);
	assert.match(protocol, /only integration is serialized/);
});
