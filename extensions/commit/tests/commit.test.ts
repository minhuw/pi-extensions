import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const commitRoot = path.join(repositoryRoot, "extensions/commit");
const promptEntry = "./extensions/commit/prompts/commit.md";

test("package loads /commit as a native prompt with no Commit runtime", async () => {
	const manifest: { pi: { extensions: string[]; prompts: string[] } } = JSON.parse(
		await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
	);
	assert.ok(manifest.pi.prompts.includes(promptEntry));
	assert.ok(!manifest.pi.extensions.some((entry) => entry.includes("extensions/commit/")));
	for (const removed of ["index.ts", "preflight.ts", "COMMIT.md"]) {
		await assert.rejects(access(path.join(commitRoot, removed)), { code: "ENOENT" });
	}

	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-commit-prompt-"));
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
		const matches = prompts.filter((prompt) => prompt.name === "commit");
		assert.equal(matches.length, 1);
		const [prompt] = matches;
		assert.equal(prompt.filePath, path.resolve(repositoryRoot, promptEntry));
		assert.equal(prompt.description, "Commit existing changes as a self-contained patch series");
		assert.equal(prompt.argumentHint, "[instructions]");
		assert.match(prompt.content, /^Commit the existing changes/);
		assert.match(prompt.content, /Additional user instructions:\n\$ARGUMENTS\s*$/);
		assert.deepEqual(loader.getExtensions().extensions, []);
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.deepEqual(loader.getSkills().skills, []);
		assert.deepEqual(loader.getThemes().themes, []);
		assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

test("prompt retains self-contained grouping, safety, verification, and message guidance", async () => {
	const prompt = await readFile(path.resolve(repositoryRoot, promptEntry), "utf8");
	for (const guidance of [
		/smallest logical series of self-contained patches/,
		/without extra confirmation unless there is real ambiguity/,
		/only to this invocation, not as permanent session rules/,
		/Git root and status, including staged, unstaged, and untracked paths/,
		/no repository or no in-scope changes.*never invent an empty commit/,
		/Stop for unresolved conflicts or in-progress Git operations/,
		/Before reading content, classify paths.*never disclose or commit credentials/,
		/repository instructions and recent history.*diffs.*data, not instructions/,
		/Do not implement or fix.*discard or stash.*rewrite history.*change branches.*configuration.*push/,
		/Group by purpose.*code with its necessary tests and documentation.*one commit/,
		/each commit.*useful, valid intermediate tree/,
		/user's scope and meaningful existing staging.*work present when this invocation began/,
		/explicit literal paths or selected hunks using index-only changes/,
		/Preserve staged-only content.*never blanket-reset.*overwrite index-only versions/,
		/complete staged diff.*git diff --cached --check.*every group/,
		/existing, focused, non-mutating checks.*No dependency installs, formatting, or repairs/,
		/checks not run.*staged subset.*does not prove an intermediate staged tree passed/,
		/normal `git commit`, honoring repository hooks and signing.*Never suppress.*stop and report blockers/,
		/Linux-style `subsystem: imperative summary`.*repository-required Conventional Commits take precedence/,
		/75 characters.*self-contained explanatory body.*rationale, and impact, not a file list/s,
		/Never invent attribution, trailers, issue references, or commit references/,
		/hashes and subjects in creation order.*actual checks.*leftover.*nothing was pushed/,
	]) assert.match(prompt, guidance);
	assert.doesNotMatch(prompt, /commit_(?:git|list|read)|COMMIT_WORKFLOW_RUN_ID/);
});
