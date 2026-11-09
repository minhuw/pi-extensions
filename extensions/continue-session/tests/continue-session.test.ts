import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entry = "./extensions/continue-session/prompts/continue-session.md";

// Pi's native expander is exported by this module, but not its package entry point.
const { expandPromptTemplate } = await import(
	new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };

test("package loads the continuation command and expands the session ID and optional instructions", async () => {
	const manifest: { pi: { prompts: string[] }; scripts: Record<string, string> } = JSON.parse(
		await readFile(path.join(root, "package.json"), "utf8"),
	);
	assert.equal(manifest.pi.prompts.filter((item) => item === entry).length, 1);
	assert.ok(manifest.scripts.test.split(" && ").includes("npm run test:continue-session"));

	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-continue-session-"));
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
		const matches = prompts.filter((prompt) => prompt.name === "continue-session");
		assert.equal(matches.length, 1);
		const [prompt] = matches;
		assert.equal(prompt.filePath, path.resolve(root, entry));
		assert.equal(prompt.argumentHint, "<session ID> [instructions]");

		const id = "550e8400-e29b-41d4-a716-446655440000";
		for (const [command, argumentsText] of [
			["/continue-session", ""],
			[`/continue-session ${id}`, id],
			[`/continue-session ${id} finish the failing tests first`, `${id} finish the failing tests first`],
			[`/continue-session ${id} "keep literal $1"`, `${id} keep literal $1`],
		]) {
			assert.equal(expandPromptTemplate(command, prompts), prompt.content.replace("$ARGUMENTS", () => argumentsText));
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
