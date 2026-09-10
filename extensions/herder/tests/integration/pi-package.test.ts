import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = path.resolve(extensionRoot, "../..");

function testPlanV2Template(template: string): void {
	const local = template.match(/```markdown\n(# Plan [\s\S]*?)\n```/)?.[1];
	assert.ok(local, "template has a complete local plan example");
	assert.deepEqual([...local.matchAll(/^## (.+)$/gm)].map((match) => match[1]), [
		"Status", "Outcome and acceptance", "Boundaries", "Starting conditions",
		"Implementation route", "Verification", "Escalation and handoff",
	]);
	for (const header of [
		"| ID | Required behavior | Proof |",
		"| Plan | Consumes |",
		"| ID | Phase | Criteria | Toolchain | Command | Expected |",
		"| ID | Owner | Cwd | Prerequisites | Probe | Evidence |",
	]) assert.equal(local.split(header).length - 1, 1, `one canonical ${header} table`);
	for (const label of ["Write paths", "Out of scope", "Observed baseline", "Required starting state", "Expected dependency changes"]) {
		assert.ok(local.includes(`**${label}**`));
	}
	assert.match(local, /\| A1 \|[^\n]+\| V2 \|/);
	assert.match(local, /\| V2 \| acceptance \| A1 \| T1 \|/);
	assert.doesNotMatch(local, /^- Branch:|npm install|\bwhich\s+(?:node|npm)/m);
	assert.match(template, /every A row has an acceptance-phase proof/);
	assert.match(template, /shared\/local IDs cannot shadow/);
	assert.match(template, /Parser\/shape validation runs no setup or plan/);
	assert.match(template, /agent SETUP\/CHECKS remain self-report/);
}

test("live setup installs trusted worker packages through the selected Pi before E2E", async () => {
	const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/herder-live-e2e.yml"), "utf8");
	const testing = await readFile(path.join(extensionRoot, "TESTING.md"), "utf8");
	const workflowSetup = workflow.match(/      - name: Install and configure Pi\n([\s\S]*?)(?=\n      - name:)/)?.[1];
	const localSetup = testing.match(/## Local live Pi\/Poorman setup\n[\s\S]*?```sh\n([\s\S]*?)\n```/)?.[1];
	assert.ok(workflowSetup, "workflow Pi setup step exists");
	assert.ok(localSetup, "local live setup shell block exists");
	assert.match(workflowSetup, /^          set -euo pipefail$/m);
	assert.match(workflowSetup, /^          pi_bin="\$GITHUB_WORKSPACE\/node_modules\/\.bin\/pi"$/m);
	assert.match(localSetup, /^set -eu$/m);
	assert.ok(localSetup.includes('pi_bin="${HERDER_PI_BIN:-$PWD/node_modules/.bin/pi}"'));
	for (const [label, setup, checkout] of [
		["workflow", workflowSetup, "$GITHUB_WORKSPACE"],
		["local", localSetup, "$PWD"],
	]) {
		const lines = setup.split("\n").map((line) => line.trim());
		const binary = lines.findIndex((line) => line.startsWith("pi_bin="));
		for (const source of [`"${checkout}"`, "git:github.com/DietrichGebert/ponytail", "npm:pi-web-access"]) {
			const install = lines.indexOf(`"$pi_bin" install ${source} --approve`);
			assert.ok(install > binary, `${label} installs ${source} in the user store after selecting Pi`);
		}
	}
	assert.match(workflowSetup, /echo "HERDER_PI_BIN=\$pi_bin" >> "\$GITHUB_ENV"/);
	assert.match(localSetup, /^export HERDER_PI_BIN="\$pi_bin"$/m);
	assert.ok(workflow.indexOf(workflowSetup) < workflow.indexOf("        run: npm run test:e2e:herder"));
	assert.ok(testing.indexOf(localSetup) < testing.indexOf("\n```sh\nnpm run test:e2e:herder\n```"));
});

test("Pi package registers Herder while keeping planning skills command-owned", async () => {
	const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
	const lock = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
	const rootReadme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
	const herderReadme = await readFile(path.join(extensionRoot, "README.md"), "utf8");
	const adapterReadme = await readFile(path.join(extensionRoot, "adapters/README.md"), "utf8");
	const planTemplate = await readFile(path.join(extensionRoot, "skills/plans/references/plan-template.md"), "utf8");
	assert.deepEqual(manifest.engines, { node: ">=22.19.0" });
	assert.deepEqual(lock.packages[""].engines, { node: ">=22.19.0" });
	assert.match(rootReadme, /Node >=22\.19\.0/);
	assert.match(rootReadme, /pi install git:github\.com\/minhuw\/pi-extensions/);
	assert.match(rootReadme, /pi install git:github\.com\/DietrichGebert\/ponytail/);
	assert.match(rootReadme, /pi install npm:pi-web-access/);
	assert.match(herderReadme, /Node >=22\.19\.0/);
	assert.match(herderReadme, /pi install git:github\.com\/minhuw\/pi-extensions/);
	assert.match(herderReadme, /pi install git:github\.com\/DietrichGebert\/ponytail/);
	assert.match(herderReadme, /pi install npm:pi-web-access/);
	assert.match(planTemplate, /Prerequisites/);
	assert.match(planTemplate, /restore missing dependencies with repository-declared `npm ci`/);
	assert.match(planTemplate, /pinned assets/);
	assert.match(planTemplate, /dependency\s+selection or tracked manifest\/lock changes require explicit assignment authority/);
	assert.match(planTemplate, /setup-and-check invocation inside one gate's isolated HOME\/cache/);
	assert.doesNotMatch(planTemplate, /npm install|shared registry|centralized setup service/);
	assert.match(planTemplate, /npm run focused-test/);

	testPlanV2Template(planTemplate);
	assert.ok(manifest.pi.extensions.includes("./extensions/herder/adapters/index.ts"));
	assert.match(herderReadme, /^## Planning and execution commands$/m);
	const expectedCommandNames = [
		"/herder-attach",
		"/herder-cleanup",
		"/herder-dashboard",
		"/herder-fire",
		"/herder-grill",
		"/herder-improve",
		"/herder-plans",
		"/herder-reset",
		"/herder-resume",
		"/herder-rework",
		"/herder-revise",
		"/herder-simplify",
		"/herder-status",
		"/herder-stop",
		"/herder-validate",
	].sort();
	assert.deepEqual([...new Set(herderReadme.match(/\/herder-[a-z-]+/g))].sort(), expectedCommandNames);
	const commandSection = herderReadme.split("## Planning and execution commands")[1].split("Fire, resume")[0];
	const actualCommandForms = [...commandSection.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1].replaceAll("\\|", "|"));
	assert.deepEqual(actualCommandForms, [
		"/herder-grill <change>",
		"/herder-grill --plan <id-or-path> [--plan-dir <dir>]",
		"/herder-grill --plan <id-or-path> --split [--plan-dir <dir>]",
		"/herder-improve [quick|standard|deep] [focus] [--lang <language>]",
		"/herder-simplify [quick|standard|deep] [focus-or-path] [--lang <language>]",
		"/herder-validate [plan-dir] [--fix]",
		"/herder-plans init [plan-dir] [--track]",
		"/herder-plans validate|shape|status|ready [plan-dir]",
		"/herder-plans snapshot <plan-id> [plan-dir]",
		"/herder-plans report <plan-id|RUN> [plan-dir]",
		"/herder-plans track|untrack [plan-dir]",
		"/herder-fire [plan-dir] [options]",
		"/herder-attach [plan-dir] [--dashboard-port n]",
		"/herder-resume [plan-dir] [options]",
		"/herder-revise [plan-dir] [options]",
		"/herder-rework <plan-id> [plan-dir]",
		"/herder-status [plan-dir]",
		"/herder-dashboard [plan-dir]",
		"/herder-cleanup [plan-dir] [--plan id] [--include-failed]",
		"/herder-reset [plan-dir]",
		"/herder-cleanup [plan-dir] --deep [--include-failed]",
		"/herder-cleanup [plan-dir] --force",
		"/herder-stop",
	]);
	assert.match(adapterReadme, /\[canonical planning and execution command reference\]\(\.\.\/README\.md#planning-and-execution-commands\)/);
	assert.doesNotMatch(adapterReadme, /^Available commands:/m);
	assert.doesNotMatch(adapterReadme, /^- .*\/herder-/m);

	assert.equal(Object.hasOwn(manifest.pi, "skills"), false);
	for (const skill of ["improve", "simplify", "grill", "plans", "validate"]) {
		const contents = await readFile(path.join(extensionRoot, "skills", skill, "SKILL.md"), "utf8");
		assert.match(contents, new RegExp(`^name: herder-${skill}$`, "m"));
	}
	const improve = await readFile(path.join(extensionRoot, "skills/improve/SKILL.md"), "utf8");
	const simplify = await readFile(path.join(extensionRoot, "skills/simplify/SKILL.md"), "utf8");
	const auditPlaybook = await readFile(path.join(extensionRoot, "skills/improve/references/audit-playbook.md"), "utf8");
	const simplificationPlaybook = await readFile(path.join(extensionRoot, "skills/simplify/references/simplification-playbook.md"), "utf8");
	assert.doesNotMatch(improve, /closing-the-loop|`plan <description>`|`review-plan <file>`|`execute(?: \[<plan>\])?`|`reconcile`|`--issues`/);
	assert.match(improve, /Finish investigation in this session \(main session; subagents for independent read-only passes\)/);
	assert.match(improve, /Resolve every unresolved lead in this session before the table, using additional read-only subagents/);
	assert.match(improve, /Keep characterization tests and necessary docs with the bounded invariant; split only for independently useful, gate-passing prerequisites/);
	assert.match(improve, /Do not write investigation or spike plans/);
	assert.match(auditPlaybook, /Do not plan characterization tests unless they protect or unblock a specific, already-bounded code change/);
	assert.match(auditPlaybook, /Leads never become plans/);
	assert.doesNotMatch(auditPlaybook, /get an "investigate" plan/);

	assert.match(simplify, /references\/simplification-playbook\.md/);
	assert.match(simplify, /plans\/references\/plan-format\.md/);
	assert.match(simplify, /Finish that investigation in this session/);
	assert.match(simplify, /Resolve every unresolved lead in this session before the table, using additional read-only subagents/);
	assert.match(simplify, /If `herder-plans\/README\.md` exists, do not call `init`/);
	assert.match(simplify, /never write an investigation or spike plan/);
	assert.doesNotMatch(simplificationPlaybook, /INVESTIGATE/);
	assert.match(simplificationPlaybook, /Characterization tests tied to selected, already-bounded reductions/);
	assert.match(simplify, /cold-read each compiled `snapshot`/);
	assert.match(simplify, /Then run `shape`, resolve every issue and unordered overlap/);
	assert.match(simplificationPlaybook, /^## Finding format$/m);
	await assert.rejects(() => readFile(path.join(extensionRoot, "skills/improve/references/closing-the-loop.md"), "utf8"), /ENOENT/);
	assert.equal(Object.hasOwn(manifest.pi, "subagents"), false);
});

test("Improve and Simplify explain every numbered finding before selection with invocation-scoped discussion language", async () => {
	for (const skill of ["improve", "simplify"]) {
		const contents = await readFile(path.join(extensionRoot, "skills", skill, "SKILL.md"), "utf8");
		const vet = contents.split("## 3. Vet, Prioritize, Confirm")[1].split("## 4. Write Plans")[0];
		assert.match(vet, /\| # \| Finding \|[\s\S]*automatically explain every vetted finding individually in table order, reusing the same stable finding numbers[\s\S]*2–3 plain-language sentences[\s\S]*same response before the recommendation and selection question[\s\S]*Ask which findings to plan,[^\n]*and wait/, skill);
		assert.match(vet, /what happens now or the current burden; the suggested change and benefit; and any meaningful risk, preserved behavior, or dependency when relevant/, skill);
		assert.match(vet, /not just top recommendations or only on follow-up; do not pause per finding/, skill);
		assert.match(vet, /In a noninteractive run, select that default/, skill);
		assert.match(contents, /Before selection, author nothing; afterward, write only confirmed plan-directory content/, skill);
		const invocation = contents.split("## Invocation Variants")[1];
		assert.match(invocation, /`--lang <language>`: invocation-only override for the user-facing findings table, individual explanations, recommendation, and interactive selection\/follow-up discussion/, skill);
		assert.match(invocation, /Accept a language name or locale.*`Chinese`, `zh-CN`, or `"Traditional Chinese"`; quote multiword names/, skill);
		assert.match(invocation, /Without `--lang`, follow the user's conversation language, falling back to English/, skill);
		assert.match(invocation, /language value is missing or unclear, ask for clarification before proceeding; never silently treat it as focus/, skill);
		assert.match(invocation, /Keep all authored plan content, the index, and `CONTEXT\.md`, plus internal agent prompts, replies, findings reports, and handoffs in English regardless of the user-facing language/, skill);
		assert.match(invocation, /Preserve paths, symbols, commands, and IDs verbatim/, skill);
		const audit = contents.split("## 2. Audit")[1].split("## 3. Vet")[0];
		assert.match(audit, /Because children do not inherit this skill, every audit prompt must include:[\s\S]*"Use English for all internal agent prompts, replies, findings reports, and handoffs, regardless of the user-facing language\."/, skill);
	}
});

test("planning contracts keep external release operations out of Herder completion", async () => {
	const format = await readFile(path.join(extensionRoot, "skills/plans/references/plan-format.md"), "utf8");
	const boundary = format.split("## Execution boundary")[1].split("## Index")[0];
	assert.match(boundary, /Cloud resource provisioning, deployment\/publishing, live migrations, and live database restore\/undo/);
	assert.match(boundary, /including disposable or synthetic-data targets/);
	assert.match(boundary, /Operator approval, available credentials.*do not override worker role restrictions/);
	assert.match(boundary, /local tests, emulators, and non-mutating dry-runs/);
	assert.match(boundary, /Required starting state, dependency guarantees, A criteria, and development\/acceptance\/final V checks must not require the run to perform or wait/);
	assert.match(boundary, /do not disguise them as T prerequisites or another executable Herder plan/);
	assert.match(boundary, /outside executable A\/V\/T requirements/);
	assert.match(boundary, /Never silently drop an existing live criterion or claim local simulation proves it/);
	assert.match(boundary, /semantic readiness requirement.*not a keyword ban/);
	for (const file of [
		"README.md", "skills/plans/references/plan-template.md",
		...["grill", "improve", "simplify", "plans", "validate"].map((skill) => `skills/${skill}/SKILL.md`),
	]) {
		const text = await readFile(path.join(extensionRoot, file), "utf8");
		assert.match(text, /plan-format\.md#execution-boundary/, file);
		assert.match(text, /operator/i, file);
	}
	const template = (await readFile(path.join(extensionRoot, "skills/plans/references/plan-template.md"), "utf8")).replace(/\s+/g, " ");
	assert.match(template, /no required starting state, dependency, A\/V proof, or T setup may make the run perform or wait/);
	const validate = await readFile(path.join(extensionRoot, "skills/validate/SKILL.md"), "utf8");
	assert.match(validate, /execution boundary[\s\S]*`ERROR`/i);
	assert.match(validate, /NEEDS_DECISION/);
	const implementer = await readFile(path.join(extensionRoot, "assets/roles/contracts/plan-implementer.md"), "utf8");
	assert.match(implementer, /Never modify the user's original checkout, integrate branches, push, deploy, or publish/);
});

test("planning docs carry bounded caller/regression handoffs from audit findings through shared readiness checks", async () => {
	const [improve, playbook, template, validate] = await Promise.all([
		"skills/improve/SKILL.md",
		"skills/improve/references/audit-playbook.md",
		"skills/plans/references/plan-template.md",
		"skills/validate/SKILL.md",
	].map((file) => readFile(path.join(extensionRoot, file), "utf8")));
	const finding = playbook.split("## Finding format")[1].split("## Prioritization rubric")[0];
	assert.match(finding, /\*\*Caller\/regression handoff\*\*/);
	assert.match(finding, /Direct callers: affected `path:line` \+ symbol — `change` \(necessary companion edit\) or `preserve` \(read-only contract\)/);
	assert.match(finding, /Existing regressions: `test\/path:line` \+ test name\/anchor — protected invariant; expected assertion changes versus behaviors that must remain/);
	assert.match(finding, /Gaps\/leads: known missing cases or unresolved questions; state the bounded read scope/);
	assert.match(finding, /distinguish `not inspected` from `no coverage found in <scope>`/);
	assert.match(finding, /anchors and short obligations, not file dumps/);
	assert.match(finding, /fixtures outside obvious modules; no mandatory broad searches, test runs, or full suite per finding/);

	const audit = improve.split("## 2. Audit")[1].split("## 3. Vet")[0];
	assert.match(audit, /always including `## Finding format`/);
	assert.match(audit, /findings in `Finding format`, including the caller\/regression handoff and bounded read scope/);
	const vet = improve.split("## 3. Vet, Prioritize, Confirm")[1].split("## 4. Write Plans")[0];
	assert.match(vet, /Verify cited source anchors yourself, including direct callers and named regression assertions\/fixtures/);
	assert.match(vet, /private audit ledger \(in-session, not a file\)/);
	assert.match(vet, /retain each caller\/regression handoff, verified anchors, and lead dispositions through vetting, selection, and context compaction/);
	assert.match(vet, /Before selection, author nothing/);
	const drafting = improve.split("## 4. Write Plans")[1].split("## Invocation Variants")[0];
	assert.match(drafting, /Reopen every cited file yourself; subagent excerpts and line numbers are leads, never plan evidence/);
	assert.match(drafting, /Map necessary companion edits to existing Boundaries write paths, preservation obligations to A requirements\/Boundaries, and named regression coverage to acceptance V commands\/expected observations/);
	assert.match(drafting, /unaffected read-only callers need not become write scope/);
	assert.match(drafting, /No new plan section\/table, manifest, or audit artifact/);
	assert.match(drafting, /reconcile selected ledger handoffs against each compiled snapshot through the Producer self-review in \[plan-template\.md\]/);

	const producer = template.split("## Producer self-review — before validation")[1].replace(/\s+/g, " ");
	const validator = validate.split("### 2. Per-plan semantics")[1].split("## Classify and Report")[0].replace(/\s+/g, " ");
	for (const [label, text] of [["Producer self-review", producer], ["Validate semantics", validator]]) {
		assert.match(text, /verify direct caller paths\/symbols|source-verify baseline facts/, label);
		assert.match(text, /direct caller paths\/symbols \(`change` vs `preserve`\)/, label);
		assert.match(text, /regression paths \+ test names\/anchors, and protected invariants/, label);
		assert.match(text, /fixtures outside obvious modules/, label);
		assert.match(text, /distinguish `not inspected` from `no coverage found`/, label);
		assert.match(text, /necessary companion edits (?:belong|are) in Boundaries write paths, preservation obligations in A requirements\/Boundaries, and named coverage in acceptance V/, label);
		assert.match(text, /unaffected read-only callers need no write scope/i, label);
		assert.match(text, /acceptance.*named regressions and competing negative regressions/i, label);
		assert.match(text, /expected assertion changes versus preserved behavior/, label);
		assert.match(text, /obsolete incidental assertions may migrate/i, label);
		assert.match(text, /never delete a security\/behavior invariant just to pass/, label);
		assert.match(text, /no (?:mandatory )?broad searches\/tests or full suite (?:required for every|per) plan/, label);
		assert.match(text, /[Bb]efore (?:declaring )?ready, check (?:caller\/regression )?omissions/, label);
		assert.match(text, /account for known coverage gaps in proof, and resolve material leads/, label);
		assert.match(text, /newly found shared writes and their dependency order/, label);
	}
	assert.match(validator, /without requiring an audit ledger/);
	assert.match(validator, /Missing necessary scope or proof is an `ERROR`; material scope\/order choices need confirmation, not silent widening/);
	assert.match(validate, /perform the shared template's Producer self-review/);
});

test("deterministic manager owns scheduling while Pi workers delegate only through the scoped Agent tool", async () => {
	const agentDir = path.join(extensionRoot, "assets/roles/pi");
	const extension = await readFile(path.join(extensionRoot, "adapters/index.ts"), "utf8");
	const mainSessionRequests = await readFile(path.join(extensionRoot, "adapters/main-session-requests.ts"), "utf8");
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
	assert.match(extension, /name: "herder_integration_repair"/);
	assert.match(extension, /name: "herder_reignite"/);
	for (const marker of [
		/HERDER_MAIN_SESSION_VERIFICATION_V1/,
		/HERDER_MAIN_SESSION_VERIFICATION_FAILURE_V1/,
		/HERDER_MAIN_SESSION_VERIFICATION_RECOVERY_V1/,
		/HERDER_MAIN_SESSION_VERIFICATION_REPAIR_DECISION_V1/,
		/HERDER_MAIN_SESSION_REIGNITE_V1/,
		/PATH_POLICY: INTEGRATION_WORKTREE is an absolute LocationRoot/,
		/EXAMPLE_GATE: \{"gateId":"unit"/,
	]) assert.match(mainSessionRequests, marker);
	assert.match(extension, /Tree-relative path inside the integration worktree/);
	assert.match(transcript, /theme\.bg\("userMessageBg", text\)/);
	assert.match(transcript, /"toolErrorBg" : "toolSuccessBg"/);
	assert.doesNotMatch(extension, /registerEntryRenderer<HerderRunState>/);
	assert.doesNotMatch(extension + engine + nestedExecutor + nestedTool + roleConfig, /extensions\/subagents|subagents\/src|subagents:telemetry|registerSubagentHost|getSubagentHost/);
	// worker-engine.test.ts exercises clean sessions, exact tool envelopes,
	// trusted extension loading and shutdown through the production factory.
	assert.match(engine, /noExtensions: true/);
	assert.match(engine, /getInstalledPath\(source, "user"\)/);
	assert.doesNotMatch(engine, /getInstalledPath\(source, "project"\)/);
	assert.match(engine, /realpathSync\(path\.join\(agentDir, "npm"\)\)/);
	assert.match(engine, /realpathSync\(path\.join\(agentDir, "git"\)\)/);
	assert.match(engine, /"pi-extension", "index\.js"/);
	assert.match(engine, /"github\.com", "DietrichGebert", "ponytail"/);
	assert.match(engine, /does not resolve to the exact trusted Ponytail package/);
	assert.match(engine, /resolves outside the trusted user package store/);
	assert.match(engine, /does not resolve to its exact trusted package path/);
	assert.match(engine, /entry resolves outside the trusted user package/);
	assert.match(engine, /pi install \$\{source\}/);
	assert.match(engine, /SEARCHER_WEB_TOOL_NAMES/);
	assert.match(engine, /SEARCHER_LOCAL_TOOL_NAMES/);
	assert.match(engine, /input\.workflow = "none"/);
	assert.match(engine, /Herder searcher may fetch only remote URLs/);
	assert.match(engine, /noSkills: true/);
	assert.match(engine, /noPromptTemplates: true/);
	assert.match(engine, /noThemes: true/);
	assert.match(engine, /noContextFiles: true/);
	assert.doesNotMatch(engine + nestedExecutor + nestedTool, /shouldStopAfterTurn|turnLimitReached|max_turns|maxTurns/);
	assert.doesNotMatch(engine, /forkFrom|parentSession:/);
	assert.match(nestedTool, /executionMode: "parallel"/);
	assert.match(nestedTool, /run_in_background/);
	assert.match(nestedTool, /name: "get_subagent_result"/);
	assert.doesNotMatch(nestedTool, /resolvedModel|thinking:|service_tier/);
	assert.match(roleConfig, /PONYTAIL_EXTENSION_SOURCE = "git:github\.com\/DietrichGebert\/ponytail"/);
	assert.match(roleConfig, /WEB_ACCESS_EXTENSION_SOURCE = "npm:pi-web-access"/);
	assert.match(roleConfig, /ROLE_EXTENSION_SOURCES/);
	assert.match(roleConfig, /HERDER_NESTED_AGENT_TYPES = \["recon", "searcher", "worker", "reviewer"\]/);
	assert.match(roleConfig, /\["Agent", "get_subagent_result"\]/);
	assert.match(roleConfig, /STRICT_READ_ONLY_NESTED_TOOLS/);
	assert.match(roleConfig, /export function resolveNestedBinding/);
	assert.match(roleConfig, /model: action\.model/);
	assert.match(roleConfig, /effort: action\.effort/);
	assert.match(nestedExecutor, /resolveNestedBinding/);
	assert.match(nestedExecutor, /treeSnapshots/);
	assert.match(nestedExecutor, /parentAgentId/);
	assert.match(engine, /nestedScope/);
	assert.match(nestedTool, /wait_any/);
	assert.match(nestedExecutor, /scopeController/);
	assert.match(nestedExecutor, /MAX_NESTED_CONCURRENCY_PER_ACTION = 4/);
	assert.match(nestedExecutor, /MAX_NESTED_CALLS = 8/);
	assert.doesNotMatch(nestedExecutor, /MAX_GLOBAL_NESTED_CONCURRENCY|globalLimiter/);
	for (const type of ["recon", "searcher", "worker"]) {
		const nested = await readFile(path.join(agentDir, "nested", `${type}.md`), "utf8");
		assert.match(nested, /^package: herder$/m);
		assert.match(nested, /^kind: nested$/m);
		assert.doesNotMatch(nested, /^tools: .*Agent/m);
		if (type === "worker") {
			assert.match(nested, /^binding: inherit$/m);
		} else {
			assert.match(nested, /^binding: own$/m);
		}
	}
	const recon = await readFile(path.join(agentDir, "nested/recon.md"), "utf8");
	assert.doesNotMatch(recon, /^extensions:/m);
	assert.match(recon, /^tools: read, grep, find, ls$/m);
	assert.match(recon, /runtime restricts filesystem access to the assigned worktree/);
	assert.match(nestedTool, /paths in a prompt do not grant access/);
	assert.match(nestedTool, /historical diffs or external evidence inline/);
	const searcher = await readFile(path.join(agentDir, "nested/searcher.md"), "utf8");
	assert.match(searcher, /^extensions: npm:pi-web-access$/m);
	assert.match(searcher, /^tools: web_search, source_check, fetch_content, get_search_content, find, grep$/m);
	const worker = await readFile(path.join(agentDir, "nested/worker.md"), "utf8");
	assert.match(worker, /^extensions: git:github\.com\/DietrichGebert\/ponytail$/m);
	assert.match(worker, /^tools: read, edit, write, bash, grep, find, ls$/m);
	assert.match(worker, /only when the parent explicitly delegates sole setup ownership/);
	assert.match(worker, /never compete with parent or sibling installs/);
	const reviewer = await readFile(path.join(agentDir, "nested/reviewer.md"), "utf8");
	assert.match(reviewer, /^package: herder$/m);
	assert.match(reviewer, /^kind: nested$/m);
	assert.match(reviewer, /^binding: inherit$/m);
	assert.match(reviewer, /^readOnly: false$/m);
	assert.doesNotMatch(reviewer, /^extensions:/m);
	assert.match(reviewer, /^tools: read, bash, grep, find, ls, Agent, get_subagent_result$/m);
	assert.doesNotMatch(reviewer, /^(?:model|effort|service_tier):/m);
	assert.match(reviewer, /Reuse parent-prepared dependencies/);
	assert.match(reviewer, /delegates sole pre-check setup ownership/);
	const reviewProtocol = await readFile(path.join(extensionRoot, "assets/review/code-review-protocol.md"), "utf8");
	assert.match(reviewProtocol, /For `FINAL_AUDIT`, launch four fresh `reviewer` children in one parallel wave and retain full aggregate coverage/);
	assert.match(reviewProtocol, /primary explicit hunk\/subsystem ownership and named cross-boundary questions/);
	assert.match(reviewProtocol, /four review lenses remain a coverage checklist/);
	assert.match(reviewProtocol, /Optional targeted fresh second opinions/);
	assert.match(reviewProtocol, /not a mandatory full second discovery wave/);
	assert.match(reviewProtocol, /No child confidence threshold is a prerequisite/);
	assert.match(reviewProtocol, /Missing proof alone neither rejects a credible material concern nor promotes it to a blocker/);
	assert.match(reviewProtocol, /required shared gates once per frozen review target/);
	assert.match(reviewProtocol, /runtime timeout is neither a code defect nor approval evidence/);
	assert.match(reviewProtocol, /wait_any: true/);
	assert.match(reviewProtocol, /60 seconds, then returns running without cancelling/);
	assert.match(reviewProtocol, /Root `recon` and `searcher` remain available/);
	assert.match(reviewProtocol, /tools enforce the assigned-worktree boundary/);
	assert.match(reviewProtocol, /scratch path is not an access grant/);
	assert.match(reviewProtocol, /Denied access calls for a scoped handoff/);
	assert.doesNotMatch(reviewProtocol, /CONFIDENCE:|confidence at least 80|four fresh `recon` children/);
	assert.doesNotMatch(reviewProtocol, /subagent type.*(?:critic|validator)/i);
	for (const role of ["plan-implementer", "plan-reviewer", "plan-judge"]) {
		const contents = await readFile(path.join(agentDir, `${role}.md`), "utf8");
		assert.match(contents, /^package: herder$/m);
		assert.match(contents, /^tools: .*Agent.*get_subagent_result/m);
		assert.doesNotMatch(contents, /^tools: .*(?:steer_subagent|herder)/m);
		assert.match(contents, /^tools: .*\bgrep\b.*\bfind\b/m);
		assert.match(contents, /ROLE_CONTRACT_PATH/);
		if (role === "plan-implementer") {
			assert.match(contents, /^extensions: git:github\.com\/DietrichGebert\/ponytail$/m);
		} else {
			assert.doesNotMatch(contents, /^extensions:/m);
		}
		const contract = await readFile(path.join(extensionRoot, "assets/roles/contracts", `${role}.md`), "utf8");
		assert.match(contract, /Return exactly the envelope below/);
		assert.match(contract, /^SETUP: </m);
		assert.match(contract, /repository-declared locked|repository-prescribed,? locked/);
		assert.match(contract, /tracked manifest\/lock changes.*only when this assignment explicitly authorizes|Never modify tracked manifests, locks, source/);
		assert.match(contract, /[Nn]ever[^.]*unpinned `uvx`\/`npx`/);
		assert.match(contract, /BLOCKER_KIND: <ENVIRONMENT \| INVOCATION \| REQUIREMENT; optional/);
		assert.match(contract, /(?:omit|omitting|omitted).*BLOCKER_KIND|BLOCKER_KIND omitted/);
		if (role === "plan-reviewer") {
			assert.match(contents, /REVIEW_PROTOCOL_PATH/);
			assert.match(contract, /review protocol's bounded multi-agent workflow/);
		}
	}
});

test("bounded review policy is owned by the protocol and assembled with the reviewer contract", async () => {
	const [protocol, contract, root, child] = await Promise.all([
		"assets/review/code-review-protocol.md",
		"assets/roles/contracts/plan-reviewer.md",
		"assets/roles/pi/plan-reviewer.md",
		"assets/roles/pi/nested/reviewer.md",
	].map((file) => readFile(path.join(extensionRoot, file), "utf8")));
	for (const pattern of [
		/LOW = 1, MED = 2, HIGH = 4/,
		/[Mm]issing risk[^.]*HIGH/,
		/[Ee]scalate[^.]*authorization\/authentication, persistence, concurrency, public boundaries, and executable Markdown\/prompt policies/,
		/[Nn]ever downgrade[^.]*diff\/file (?:count|size)[^.]*documentation extension/,
		/`FINAL_AUDIT`[^\n]*four[^\n]*full aggregate coverage/,
		/(?:same Plan V2 risk rule|same risk rule)[^.]*regardless of round|first discovery in a later round uses this same risk rule/i,
		/[Dd]efault(?:s)? to one scoped/,
		/[Ss]cale up only for distinct risky repair boundaries, up to four|scaling only for distinct risky repair boundaries up to four/,
		/counts are prompt policy|counts[^.]*prompt policy/,
		/[Mm]ateriality before (?:expensive )?proof/,
		/concrete plausible trigger and material consequence, or an explicit failed acceptance\/scope obligation/,
		/Do not actively seek optional P2\/P3 improvements/,
		/COVERAGE_GAP/,
		/MATERIAL_CONCERN/,
		/[Rr]eject unsupported speculation[^.]*concise reason/,
		/[Ss]erious unresolved concerns[^.]*missing required checks\/coverage[^.]*incomplete[^.]*never approval/,
		/[Mm]issing finding from a partial report is not resolution/,
		/[Dd]o not reopen[^.]*resolved\/rejected findings without new evidence/,
	]) assert.match(protocol, pattern);
	for (const text of [protocol, child]) {
		assert.match(text, /bounded static (?:defect[- ])?candidate scouting/);
		assert.match(text, /never delegate the whole review/i);
		assert.match(text, /independently validate/);
		assert.match(text, /complete owned-hunk coverage and required checks/);
		assert.match(text, /zero scout candidates do not mean reviewed or approved/i);
		assert.doesNotMatch(text, /not a code detector|not runtime testing or review/);
	}
	assert.doesNotMatch(contract, /LOW =|MED =|HIGH =|MATERIAL_CONCERN|COVERAGE_GAP|wait_any|FINAL_AUDIT/);
	for (const pattern of [
		/hash the manager-provided assignment bundle inside the worktree and require it to equal the supplied bundle SHA-256/,
		/Verify frozen branch\/HEAD\/tree integrity before every terminal report/,
		/[Ff]inal-phase V rows[^.]*cannot be the only prerequisite acceptance proof/,
		/SETUP: </,
		/BLOCKER_KIND: <ENVIRONMENT \| INVOCATION \| REQUIREMENT; optional/,
		/Only `ENVIRONMENT` and `INVOCATION` reject defect findings or `SCOPE: FAIL`/,
		/`REQUIREMENT` blocker and retains confirmed `plan_recovery`\/`user_decision` authority/,
		/Return exactly the envelope below/,
	]) assert.match(contract, pattern);
	const envelope = contract.match(/```text\n(VERDICT:[\s\S]*?)\n```/)?.[1];
	assert.ok(envelope);
	assert.deepEqual([...envelope.matchAll(/^([A-Z_]+):/gm)].map((match) => match[1]), [
		"VERDICT", "BLOCKER_KIND", "FINDINGS", "FIX_GUIDANCE", "DISCOVERED_PATHS", "SCOPE", "SETUP", "CHECKS", "RATIONALE", "USAGE",
	]);
	for (const pattern of [
		/Classify each discovered path independently/,
		/unplanned public-contract or migration transition/,
		/nonoverlapping with unordered live work/,
		/`SCOPE: FAIL` requires material out-of-plan work or an explicit constraint violation/,
		/Severity measures consequence, not confidence/,
		/suggested direction is optional and nonbinding/,
		/Before returning, collect every background direct result/,
	]) assert.match(protocol, pattern);
	assert.match(contract, /host-provided token accounting; use `unknown`/);
	assert.match(contract, /exact-tree verification evidence rather than creating a second manifest/);
	assert.match(root, /read the complete `ROLE_CONTRACT_PATH` and the complete `REVIEW_PROTOCOL_PATH` from the exact paths supplied/);
	assert.match(root, /If either is missing or unreadable, return `BLOCK`, never inferred approval/);
	assert.match(root, /Return only the contract's exact terminal envelope/);
	assert.ok(root.split("---")[2].trim().split(/\s+/).length <= 250, "Pi wrapper stays a short loader, not a duplicated policy");
	assert.doesNotMatch(root, /LOW =|MED =|HIGH =|PASS_DOCUMENT|wait_any|SETUP|COVERAGE_GAP|HERDER_REVIEW_TIMEOUT_MS/);
	const assembledRoot = `${contract}\n${protocol}`;
	assert.match(assembledRoot, /assignment authority/);
	assert.match(assembledRoot, /LOW = 1, MED = 2, HIGH = 4/);
	assert.match(assembledRoot, /Return exactly the envelope below/);
	assert.match(protocol, /A separate skeptic is not mandatory/);
	assert.match(protocol, /Verify all accepted open IDs and concrete P0\/P1 repair-delta regressions/);
	assert.match(protocol, /For later review passes, do not reopen broad discovery/);
	assert.match(protocol, /evidence-complete P0\/P1 `PLAN_REQUIREMENT` or `PATCH_REGRESSION`/);
	assert.match(protocol, /No round-3 Judge or fourth automatic mutation is allowed/);
	for (const pattern of [
		/source preservation is a behavioral contract, not a sandbox/,
		/hunk\/subsystem ownership, cross-boundary questions/,
		/at most one concurrent `recon` and two recon launches total/,
		/uncollected grandchildren fail this review closed/,
		/UNRESOLVED: <COVERAGE_GAP or MATERIAL_CONCERN/,
		/Missing proof alone neither rejects a credible concern nor promotes it to a blocker/,
		/Reject unsupported speculation with a concise reason/,
		/never suppress confirmed serious defects to meet a count/,
		/not owned-hunk coverage or required checks/,
		/`CONFIRM`, `REJECT`, or `INSUFFICIENT`/,
	]) assert.match(child, pattern);
});

test("review docs separate policy counts, opt-in deadlines, material-only Reignite, and unmeasured calibration", async () => {
	const [readme, adapter, testing] = await Promise.all([
		"README.md", "adapters/README.md", "TESTING.md",
	].map((file) => readFile(path.join(extensionRoot, file), "utf8")));
	for (const text of [readme, adapter, testing]) {
		assert.match(text, /LOW = 1, MED = 2, HIGH = 4/);
		assert.match(text, /`FINAL_AUDIT`[^\n]*four[^\n]*full aggregate coverage/);
		assert.match(text, /prompt policy counts[^\n]*hard runtime caps/);
		assert.match(text, /HERDER_REVIEW_TIMEOUT_MS[^\n]*positive integer no greater than 2147483647[^\n]*unset[^\n]*disabl/);
		assert.match(text, /deadline[^\n]*root Reviewer start[^\n]*SDK compaction[^\n]*retr(?:y|ies)[^\n]*descendant/);
		assert.match(text, /[Ee]xhaustion[^\n]*same-round[^\n]*operator[_ ]attention/);
		assert.match(text, /no automatic retry or approval|never automatic retry or approval/);
		assert.match(text, /settlement may exceed the deadline/);
		assert.match(text, /P0\/P1 `BLOCKING`[^\n]*`PLAN_REQUIREMENT`[^\n]*`PATCH_REGRESSION`/);
		assert.match(text, /[Aa]dvisories remain[^\n]*reports, not executable scope/);
	}
	for (const text of [readme, adapter, testing]) {
		assert.match(text, /defect-candidate|candidate scouting/);
	}
	assert.match(adapter, /advisory-only reports do not trigger automatic Reignite drafting/);
	assert.match(testing, /approximately 30 representative historical changes[^\n]*model bindings held constant/);
	assert.match(testing, /Human-audit material defects and misses/);
	assert.match(testing, /latency, total tokens including descendants, and human triage effort/);
	assert.match(testing, /not a completed benchmark; no live tests or benchmark are run/);
	assert.match(testing, /parent[^\n]*descendant[^\n]*cost/);
	assert.match(testing, /waiting[^\n]*scout/);
	assert.match(testing, /false positives/);
});

test("Pi exposes current-session agentic workflows, direct plan commands, and the exact plan application tool", async () => {
	const extension = await readFile(path.join(extensionRoot, "adapters/index.ts"), "utf8");
	const workflows = await readFile(path.join(extensionRoot, "adapters/planning-workflows.ts"), "utf8");
	assert.match(extension, /registerPiPlanningWorkflows\(pi, PACKAGE_ROOT/);
	for (const command of ["herder-improve", "herder-simplify", "herder-grill", "herder-validate", "herder-plans"]) {
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
