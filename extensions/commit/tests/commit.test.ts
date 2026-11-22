import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const promptEntry = "./extensions/commit/prompts/commit.md";

describe("commit prompt template", () => {
	it("package loads /commit as a native prompt with no Commit runtime", async () => {
		const manifest: { pi: { extensions: string[]; prompts: string[] } } = JSON.parse(
			await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
		);
		expect(manifest.pi.prompts).toContain(promptEntry);
		expect(manifest.pi.extensions.some((entry) => entry.includes("extensions/commit/"))).toBe(false);

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
			expect(diagnostics).toEqual([]);
			const matches = prompts.filter((prompt) => prompt.name === "commit");
			expect(matches).toHaveLength(1);
			const [prompt] = matches;
			expect(prompt.filePath).toBe(path.resolve(repositoryRoot, promptEntry));
			expect(prompt.description).toBe("Commit existing changes as a self-contained patch series");
			expect(prompt.argumentHint).toBe("[instructions]");
			expect(prompt.content).toMatch(/^Commit the existing changes/);
			expect(prompt.content).toMatch(/Additional user instructions:\n\$ARGUMENTS\s*$/);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	it("prompt retains self-contained grouping, safety, verification, and message guidance", async () => {
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
		]) expect(prompt).toMatch(guidance);
		expect(prompt).not.toMatch(/commit_(?:git|list|read)|COMMIT_WORKFLOW_RUN_ID/);
	});
});
