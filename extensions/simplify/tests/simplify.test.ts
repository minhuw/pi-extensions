import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate } from "@earendil-works/pi-coding-agent";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const promptEntry = "./extensions/simplify/prompts/simplify.md";

// Pi's native expansion helper is exported by this module, but not its package entry point.
const { expandPromptTemplate } = await import(
	new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };

test("package loads exactly one native /simplify prompt without a Simplify runtime and expands arguments", async () => {
	const manifest: { pi: { extensions: string[]; prompts: string[] }; scripts: Record<string, string> } = JSON.parse(
		await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
	);
	assert.deepEqual(manifest.pi.prompts.filter((entry) => entry.includes("extensions/simplify/")), [promptEntry]);
	assert.ok(!manifest.pi.extensions.some((entry) => entry.includes("extensions/simplify/")));
	assert.equal(manifest.scripts["test:simplify"], "node --experimental-strip-types --test extensions/simplify/tests/*.test.ts");
	assert.ok(manifest.scripts.test.split(" && ").includes("npm run test:simplify"));

	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-simplify-prompt-"));
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
		const matches = prompts.filter((prompt) => prompt.name === "simplify");
		assert.equal(matches.length, 1);
		const [prompt] = matches;
		assert.equal(prompt.filePath, path.resolve(repositoryRoot, promptEntry));
		assert.equal(prompt.description, "Review and simplify changed code with bounded, behavior-preserving fixes");
		assert.equal(prompt.argumentHint, "[scope or focus]");
		assert.match(prompt.content, /^Review the current changes/);
		assert.match(prompt.content, /Optional scope or focus:\n\$ARGUMENTS\s*$/);
		for (const [args, expandedArgs] of [
			["", ""],
			['"src/auth flow"   focus on errors', "src/auth flow focus on errors"],
			['"focus on literal $1 handling"', "focus on literal $1 handling"],
		]) {
			assert.equal(
				expandPromptTemplate(`/simplify${args ? ` ${args}` : ""}`, prompts),
				prompt.content.replace("$ARGUMENTS", () => expandedArgs),
			);
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
	test(`prompt retains ${name}`, async () => {
		const prompt = await readFile(path.resolve(repositoryRoot, promptEntry), "utf8");
		for (const pattern of patterns) assert.match(prompt, pattern);
	});
}
