import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entry = "./extensions/recap/prompts/recap.md";

// Pi's native expander is exported by this module, but not its package entry point.
const { expandPromptTemplate } = await import(
	new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };

test("package loads /recap and expands bare and optional focus or time-range arguments", async () => {
	const manifest: { pi: { extensions: string[]; prompts: string[] }; scripts: Record<string, string> } = JSON.parse(
		await readFile(path.join(root, "package.json"), "utf8"),
	);
	assert.equal(manifest.pi.prompts.filter((item) => item === entry).length, 1);
	assert.ok(!manifest.pi.extensions.some((item) => item.includes("extensions/recap/")));
	assert.ok(manifest.scripts.test.split(" && ").includes("npm run test:recap"));

	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-recap-"));
	try {
		const cwd = path.join(temporary, "project");
		const agentDir = path.join(temporary, "agent");
		await mkdir(cwd);
		await mkdir(agentDir);
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager: SettingsManager.inMemory(),
			noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
			additionalPromptTemplatePaths: manifest.pi.prompts.map((item) => path.resolve(root, item)),
		});
		await loader.reload();
		const { prompts, diagnostics } = loader.getPrompts();
		assert.deepEqual(diagnostics, []);
		const matches = prompts.filter((prompt) => prompt.name === "recap");
		assert.equal(matches.length, 1);
		const [prompt] = matches;
		assert.equal(prompt.filePath, path.resolve(root, entry));
		assert.equal(prompt.description, "Recap this session's goal, recent progress, and where to pick up after a break");
		assert.equal(prompt.argumentHint, "[focus or time range]");

		for (const [command, argumentsText] of [
			["/recap", ""],
			["/recap focus on the test failures", "focus on the test failures"],
			["/recap since the last recap", "since the last recap"],
			['/recap "keep literal $1"', "keep literal $1"],
		]) {
			const expanded = expandPromptTemplate(command, prompts);
			assert.equal(expanded, prompt.content.replace("$ARGUMENTS", () => argumentsText));
			assert.match(expanded, /only to this invocation, not as permanent session rules/);
			assert.match(expanded, /do not continue the underlying task, call tools, launch agents, or change files or session settings\. Finish after the recap\./);
			assert.match(expanded, /Optional arguments narrow the topic or time range of the recap; they do not authorize investigation or execution\./);
			assert.match(expanded, /nothing to recap yet and stop; do not infer a task from repository instructions or search other sessions\./);
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
