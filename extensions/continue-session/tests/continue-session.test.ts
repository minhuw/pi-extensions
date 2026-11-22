import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entry = "./extensions/continue-session/prompts/continue-session.md";

// Pi's native expander is exported by this module, but not its package entry point.
const { expandPromptTemplate } = await import(
	new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };

describe("continue-session prompt template", () => {
	it("package loads the continuation command and expands the session ID and optional instructions", async () => {
		const manifest: { pi: { prompts: string[] }; scripts: Record<string, string> } = JSON.parse(
			await readFile(path.join(root, "package.json"), "utf8"),
		);
		expect(manifest.pi.prompts.filter((item) => item === entry)).toHaveLength(1);
		expect(manifest.scripts["test:continue-session"]).toBe("vitest run extensions/continue-session");
		const vitestTargets = manifest.scripts.test.split(" && ").find((step) => step.startsWith("vitest run "))?.split(/\s+/) ?? [];
		expect(vitestTargets).toContain("extensions/continue-session");

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
			expect(diagnostics).toEqual([]);
			const matches = prompts.filter((prompt) => prompt.name === "continue-session");
			expect(matches).toHaveLength(1);
			const [prompt] = matches;
			expect(prompt.filePath).toBe(path.resolve(root, entry));
			expect(prompt.argumentHint).toBe("<session ID> [instructions]");

			const id = "550e8400-e29b-41d4-a716-446655440000";
			for (const [command, argumentsText] of [
				["/continue-session", ""],
				[`/continue-session ${id}`, id],
				[`/continue-session ${id} finish the failing tests first`, `${id} finish the failing tests first`],
				[`/continue-session ${id} "keep literal $1"`, `${id} keep literal $1`],
			]) {
				expect(expandPromptTemplate(command, prompts)).toBe(prompt.content.replace("$ARGUMENTS", () => argumentsText));
			}
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});
