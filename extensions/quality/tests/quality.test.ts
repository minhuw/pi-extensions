import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate } from "@earendil-works/pi-coding-agent";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const qualityRoot = path.join(repositoryRoot, "extensions/quality");
const definitions = {
	simplify: {
		description: "Review and simplify changed code with bounded, behavior-preserving fixes",
		argumentHint: "[scope or focus]",
		argumentLabel: "Optional scope or focus:",
	},
	review: {
		description: "Review changes for correctness bugs and regressions without editing",
		argumentHint: "[scope or focus]",
		argumentLabel: "Optional scope or focus:",
	},
	verify: {
		description: "Run checks and exercise changed behavior, reporting evidence without repairs",
		argumentHint: "[scope or acceptance criteria]",
		argumentLabel: "Optional scope or acceptance criteria:",
	},
	deslop: {
		description: "Find and fix AI code slop such as needless guards, narration comments, and hollow tests",
		argumentHint: "[scope or focus]",
		argumentLabel: "Optional scope or focus:",
	},
};
const names = Object.keys(definitions);

// Pi's native expansion helper is exported by this module, but not its package entry point.
const { expandPromptTemplate } = await import(
	new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };

test("package loads four native Quality prompts without runtime and expands arguments", async () => {
	const manifest: { pi: { extensions: string[]; prompts: string[] }; scripts: Record<string, string> } = JSON.parse(
		await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
	);
	assert.deepEqual(
		manifest.pi.prompts.filter((entry) => entry.includes("extensions/quality/")),
		names.map((name) => `./extensions/quality/prompts/${name}.md`),
	);
	assert.ok(!manifest.pi.extensions.some((entry) => entry.includes("extensions/quality/")));
	assert.ok(!manifest.pi.prompts.some((entry) => entry.includes("extensions/simplify/")));
	assert.equal(manifest.scripts["test:quality"], "node --experimental-strip-types --test extensions/quality/tests/*.test.ts");
	assert.equal(manifest.scripts["test:simplify"], "npm run test:quality");
	assert.ok(manifest.scripts.test.split(" && ").includes("npm run test:quality"));
	assert.ok(!manifest.scripts.test.split(" && ").includes("npm run test:simplify"));

	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-quality-prompts-"));
	try {
		const cwd = path.join(temporary, "project");
		const agentDir = path.join(temporary, "agent");
		await mkdir(cwd);
		await mkdir(agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
			noPromptTemplates: true,
			additionalPromptTemplatePaths: manifest.pi.prompts.map((entry) => path.resolve(repositoryRoot, entry)),
		});
		await loader.reload();
		const { prompts, diagnostics } = loader.getPrompts();
		assert.deepEqual(diagnostics, []);
		for (const [name, definition] of Object.entries(definitions)) {
			const matches = prompts.filter((prompt) => prompt.name === name);
			assert.equal(matches.length, 1, `exactly one /${name}`);
			const [prompt] = matches;
			assert.equal(prompt.filePath, path.join(qualityRoot, "prompts", `${name}.md`));
			assert.equal(prompt.description, definition.description);
			assert.equal(prompt.argumentHint, definition.argumentHint);
			assert.ok(prompt.content.trimEnd().endsWith(`${definition.argumentLabel}\n$ARGUMENTS`));
			assert.match(prompt.content, /only to this invocation, not as permanent session rules/);
			for (const [args, expandedArgs] of [
				["", ""],
				["src/auth", "src/auth"],
				["main...HEAD", "main...HEAD"],
				['"src/auth flow"   focus on errors', "src/auth flow focus on errors"],
				['"focus on literal $1 handling"', "focus on literal $1 handling"],
			]) {
				assert.equal(
					expandPromptTemplate(`/${name}${args ? ` ${args}` : ""}`, prompts),
					prompt.content.replace("$ARGUMENTS", () => expandedArgs),
				);
			}
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

const contracts: Record<string, RegExp[]> = {
	"bounded scope and work preservation": [
		/Inspect Git status first.*staged and unstaged diff versus HEAD.*relevant nonignored untracked source files.*include new files/,
		/A focus alone.*does not widen.*Scope is the reviewed change locations.*searches are for context/,
		/Without a Git repository, accept explicit paths.*no changes.*clearly identified by the current session.*report no target.*Never invent scope.*modification times.*last commit.*whole repository/,
		/Read applicable repository instructions and the complete bounded diffs.*callers/,
		/Preserve preexisting work and the index; do not stage, commit, reset, or stash/,
	],
	"read-only reviewers and main-session edits": [
		/only to this invocation.*normal tools; do not launch scripted workflows or Herder/,
		/main session, capture a common target\/context packet.*Give every reviewer this same scope and diff/,
		/exactly three read-only reviewer agents via `Agent` in ONE message.*reuse, quality, and efficiency/,
		/Reviewers must not edit files or the index.*file\/line locations, concrete evidence, the smallest proposed fix, and behavior risk, or.*no findings/,
		/`Agent` is unavailable.*same three lenses serially.*Wait for all reviewers before editing.*incomplete coverage.*finish the missing lens.*disclose/,
		/Deduplicate findings in the main session and verify each.*Reject stylistic guesses.*main session alone edits/,
	],
	"review lenses and behavior preservation": [
		/Reuse:.*Search existing helpers and semantic duplicate logic.*do not force unrelated similar code/,
		/Quality:.*redundant state, parameter sprawl, unnecessary abstractions, unsafe casts, swallowed errors.*Do not impose blanket bans.*or add dependencies/,
		/Efficiency:.*repeated work, hot-path cost, overly broad I\/O, and resource lifecycle.*concurrency only for independent operations with preserved order, error propagation, and cancellation/,
		/Preserve APIs, truthiness\/null semantics, error propagation and cancellation, external input validation, and justified why comments.*Correctness bugs requiring behavior changes.*reported separately, not silently fixed/,
	],
	"verification and stopping": [
		/Run appropriate existing checks.*regression test only where behavior risk warrants.*Do not weaken tests or change expectations.*Report existing and new failures accurately/,
		/Examine the final diff and status, including new files.*only intended edits.*Stop once justified fixes are verified.*not run an arbitrary repeated cleanup loop/,
		/short summary of the scope, changes \(or no justified changes\), actual checks and outcomes, and unresolved issues/,
	],
};

for (const [name, patterns] of Object.entries(contracts)) {
	test(`simplify retains ${name}`, async () => {
		const prompt = await readFile(path.join(qualityRoot, "prompts/simplify.md"), "utf8");
		for (const pattern of patterns) assert.match(prompt, pattern);
	});
}

const newCommandContracts = {
	review: [
		/Report verified findings without applying fixes/,
		/Default to staged and unstaged changes versus HEAD plus relevant nonignored untracked source files/,
		/A focus alone does not widen the default scope/,
		/no changes and no explicit target.*current session.*report no target and stop/,
		/Preserve the worktree and index.*Do not edit source.*This command authorizes review, not repairs/,
		/one independent read-only review to `subagent_type: "reviewer"`.*must not edit or launch more agents/,
		/If `Agent` is unavailable.*main session.*fails or is incomplete.*finish the missing coverage.*disclose/,
		/main session verifies every proposed finding.*deduplicates.*rejects false positives/,
		/Never claim a failure was reproduced unless it was actually observed/,
		/Do not repair findings or start `\/simplify`, `\/verify`, or `\/commit` automatically/,
	],
	verify: [
		/Report evidence and gaps without repairing failures/,
		/Default to staged and unstaged changes versus HEAD plus relevant nonignored untracked source files/,
		/working tree does not prove an intermediate staged tree passed/,
		/no changes and no explicit target.*current session.*report no target and stop/,
		/requirement is unknown.*report that gap rather than inventing an expected result/,
		/Run the repository's appropriate existing checks first/,
		/Exercise the actual changed behavior.*Observe expected output and failure behavior/,
		/Preserve source, tests, documentation, configuration, existing work, and the index/,
		/Clean up only scratch files and processes created by this invocation/,
		/Do not install or upgrade dependencies.*paid external checks unless separately authorized/,
		/Label uncertain attribution as unknown/,
		/loading and argument expansion verify integration, not model compliance/,
		/Never reset or switch the user's checkout/,
		/passed, failed, or not verified.*A missing check is not a pass.*verification is incomplete/,
		/Do not repair failures or start `\/review`, `\/simplify`, or `\/commit` automatically/,
	],
};

test("deslop retains its bounded scope, slop catalog, and evidence-gated fixes", async () => {
	const prompt = await readFile(path.join(qualityRoot, "prompts/deslop.md"), "utf8");
	for (const pattern of [
		/Default to staged and unstaged changes versus HEAD plus relevant nonignored untracked source files/,
		/A focus alone does not widen the default scope.*targets are only the lines the scoped change added or modified; preexisting code is evidence of local convention/,
		/no changes and no explicit target.*current session.*report no target and stop.*Never invent scope/,
		/Preserve preexisting work and the index; do not stage, commit, reset, or stash/,
		/Slop is relative to this codebase.*matches established local convention is not slop/,
		/Noise and residue:.*restate the next line.*task or edit history.*debug output.*unused imports/,
		/Defensive and type slop:.*guards.*excluded by the types, every caller, or upstream validation.*returns an empty\/default value.*`as any`.*compatibility shims.*speculative abstraction/,
		/Test slop:.*cannot fail.*mock returns its configured value.*conditional assertions.*what plausible product regression would make it fail/,
		/one read-only `reviewer` agent per applicable catalog lens via `Agent` in ONE message.*skip the test lens when no tests are in scope/,
		/Reviewers must not edit files or the index or launch more agents.*or explicitly reports no findings/,
		/`Agent` is unavailable.*serially.*Wait for all reviewers before editing.*incomplete coverage.*disclose/,
		/main session alone edits/,
		/Remove a guard or check only with evidence.*Keep validation at trust boundaries.*security and authorization checks/,
		/swallowed error or hidden fallback only when the scoped change introduced it.*Report it instead/,
		/Never weaken assertions, change expectations to force a pass, or delete the only test of a changed behavior without a stronger replacement/,
		/Report correctness bugs found along the way separately/,
		/Stop once justified fixes are verified; do not run an arbitrary repeated cleanup loop/,
		/fixes grouped by catalog category with counts.*items deliberately left with reasons/,
		/Do not start `\/simplify`, `\/review`, `\/verify`, or `\/commit` automatically/,
		/do not launch scripted workflows or Herder/,
	]) assert.match(prompt, pattern);
});

for (const [name, patterns] of Object.entries(newCommandContracts)) {
	test(`${name} retains its scope, evidence, and no-repair contract`, async () => {
		const prompt = await readFile(path.join(qualityRoot, "prompts", `${name}.md`), "utf8");
		for (const pattern of patterns) assert.match(prompt, pattern);
		assert.match(prompt, /do not launch scripted workflows or Herder/);
	});
}

test("documentation distinguishes the commands and explains Simplify migration", async () => {
	const readme = await readFile(path.join(qualityRoot, "README.md"), "utf8");
	for (const name of names) {
		assert.ok(readme.includes(`| \`/${name}\` |`));
		assert.ok(readme.includes(`extensions/quality/prompts/${name}.md`));
	}
	for (const pattern of [
		/No Quality runtime.*automatic pipeline/,
		/Findings and suggested fixes only/,
		/No repairs/,
		/integration.*do not prove model compliance/,
		/command name `\/simplify` and its behavior are unchanged/,
		/extensions\/simplify\/prompts\/simplify\.md/,
		/update the path/,
		/\/reload/,
		/--prompt-template/,
		/test:simplify.*alias/,
	]) assert.match(readme, pattern);
	const rootReadme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
	assert.match(rootReadme, /\[Quality\]\(extensions\/quality\/README\.md\)/);
	for (const name of names) assert.ok(rootReadme.includes(`\`/${name}\``), `root README lists /${name}`);
	assert.ok(!rootReadme.includes("extensions/simplify/"));
});
