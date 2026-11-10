import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const promptEntry = "./extensions/agents-md/prompts/agents-md.md";
const manifest: { pi: { extensions: string[]; prompts: string[] }; scripts: Record<string, string> } = JSON.parse(
	await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);

// Pi's native expansion helper is exported by this module, but not its package entry point.
const { expandPromptTemplate } = await import(
	new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };

async function loadPrompts(): Promise<PromptTemplate[]> {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-agents-md-prompt-"));
	try {
		const cwd = path.join(temporary, "project"), agentDir = path.join(temporary, "agent");
		await mkdir(cwd); await mkdir(agentDir);
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager: SettingsManager.inMemory(),
			noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
			additionalPromptTemplatePaths: manifest.pi.prompts.map(entry => path.resolve(repositoryRoot, entry)),
		});
		await loader.reload();
		const { prompts, diagnostics } = loader.getPrompts();
		expect(diagnostics).toEqual([]);
		return prompts;
	} finally { await rm(temporary, { recursive: true, force: true }); }
}

it("loads the extension before pika, which stays last, lists the prompt, and runs its tests in npm test", () => {
	const { extensions, prompts } = manifest.pi;
	expect(extensions).toContain("./extensions/agents-md/index.ts");
	expect(extensions.indexOf("./extensions/agents-md/index.ts")).toBeLessThan(extensions.indexOf("./extensions/pika/index.ts"));
	expect(extensions.at(-1)).toBe("./extensions/pika/index.ts");
	expect(prompts.filter(entry => entry.includes("extensions/agents-md/"))).toEqual([promptEntry]);
	expect(manifest.scripts["test:agents-md"]).toBe("vitest run extensions/agents-md");
	expect(manifest.scripts.test.split(" && ")).toContain("npm run test:agents-md");
});

it("parses the /agents-md frontmatter and expands the focus", async () => {
	const prompts = await loadPrompts();
	const matches = prompts.filter(prompt => prompt.name === "agents-md");
	expect(matches).toHaveLength(1);
	const [prompt] = matches as [PromptTemplate];
	expect(prompt.filePath).toBe(path.resolve(repositoryRoot, promptEntry));
	expect(prompt.description).toBe("Audit the repository's AGENTS.md files against the code and move standing rules out of project memory");
	expect(prompt.argumentHint).toBe("[focus]");
	expect(prompt.content).not.toMatch(/^---/);
	expect(prompt.content.trimEnd().endsWith("Focus:\n${@:-every context file in the repository}")).toBe(true);

	expect(expandPromptTemplate("/agents-md", prompts).trimEnd().endsWith("Focus:\nevery context file in the repository")).toBe(true);
	const expanded = expandPromptTemplate("/agents-md the herder section", prompts);
	expect(expanded.trimEnd().endsWith("Focus:\nthe herder section")).toBe(true);
	expect(expanded).not.toContain("${");
});

it("keeps the audit's key instructions in order", async () => {
	const template = await readFile(path.resolve(repositoryRoot, promptEntry), "utf8");
	let previous = -1;
	for (const instruction of [
		/only to this invocation, not as permanent session rules/,
		/do not change code/,
		/Run `agents_md_lint` without a path/,
		/check every command, path, and claim against the code/,
		/do not run long or networked commands just to check them/,
		/If the `memory_read` tool is available, read the project's notes \(`scope: "project"`\)/,
		/Remove what is stale or wrong, what the code already shows, and task-specific items/,
		/When a line and the code disagree, fix the line/,
		/Move a project memory note that states a standing rule for this repository into AGENTS\.md\. After the edit is applied, `memory_forget` the note/,
		/`memory_forget` a note that AGENTS\.md already says/,
		/under 200 lines, with one line per rule\. Do not add explanatory prose/,
		/Make every change with `edit`, never with `bash` or a script, so each change goes through the user's review dialog/,
		/Do not retry a rejected change unchanged/,
		/If an edit is rejected or blocked, keep the memory note/,
		/blocked because the user is away, list it in the report as waiting for review/,
		/Run `agents_md_lint` again after your edits/,
		/End with a short report/,
		/which changes the user rejected/,
	]) {
		const match = instruction.exec(template);
		expect(match, String(instruction)).not.toBeNull();
		expect(match!.index, `${instruction} follows the previous instruction`).toBeGreaterThan(previous);
		previous = match!.index;
	}
});

it("documents the extension, its tool, and its prompt", async () => {
	const [readme, root, agents] = await Promise.all(["extensions/agents-md/README.md", "README.md", "AGENTS.md"].map(file => readFile(path.join(repositoryRoot, file), "utf8")));
	for (const text of ["agents_md_lint", "/agents-md [focus]", "Reject with a note", "npm run test:agents-md"]) expect(readme).toContain(text);
	expect(root).toMatch(/\| \[AGENTS\.md\]\(extensions\/agents-md\/README\.md\) \|.*`agents_md_lint`.*`\/agents-md \[focus\]`/);
	expect(agents).toMatch(/^- `extensions\/agents-md\/` — .*`agents_md_lint`.*`gate\.ts`.*`\/agents-md \[focus\]`/m);
	expect(agents).toContain("`npm run test:agents-md`");
});
