import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate } from "@earendil-works/pi-coding-agent";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const writerRoot = path.join(repositoryRoot, "extensions/writer");
const descriptions = {
	"conference-reviewer": "Review a paper as a top-tier systems conference reviewer.",
	evaluate: "Score research-paper text for flow, structure, and clarity.",
	"grammar-checker": "Scan and fix typos, grammar, and awkward academic phrasing.",
	"paper-validator": "Review a paper draft for weaknesses, evidence gaps, and structure.",
	polish: "Polish academic text for grammar, fluency, and conference style.",
	selection: "Propose scored word or phrase candidates for a placeholder.",
	summary: "Summarize research-paper text while preserving technical claims.",
	validation: "Validate whether a marked word or phrase fits academic usage.",
};
const names = Object.keys(descriptions);

// Pi's native expansion helper is exported by this module, but not its package entry point.
const { expandPromptTemplate } = await import(
	new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };

test("package loads eight explicit native Writer prompts without runtime or skills", async () => {
	const manifest: { pi: { extensions: string[]; prompts: string[]; skills?: string[] } } = JSON.parse(
		await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
	);
	assert.deepEqual(
		manifest.pi.prompts.filter((entry) => entry.includes("extensions/writer/")),
		names.map((name) => `./extensions/writer/prompts/${name}.md`),
	);
	assert.ok(!manifest.pi.extensions.some((entry) => entry.includes("extensions/writer/")));
	assert.ok(!manifest.pi.skills?.some((entry) => entry.includes("extensions/writer/")));
	assert.deepEqual((await readdir(path.join(writerRoot, "prompts"))).sort(), names.map((name) => `${name}.md`).sort());

	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-writer-prompts-"));
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
		for (const [name, description] of Object.entries(descriptions)) {
			const matches = prompts.filter((prompt) => prompt.name === name);
			assert.equal(matches.length, 1);
			const [prompt] = matches;
			assert.equal(prompt.filePath, path.join(writerRoot, "prompts", `${name}.md`));
			assert.equal(prompt.description, description);
			assert.equal(prompt.argumentHint, "[task or excerpt]");
			assert.match(prompt.content, /only to this invocation, not as permanent session rules/);
			assert.match(prompt.content, /Writing task or excerpt:\n\$ARGUMENTS\s*$/);
			assert.doesNotMatch(prompt.content, /<skill\b|SKILL\.md|^description:|When to Use This Skill/m);
			for (const [args, expandedArgs] of [
				["", ""],
				["introduction.tex", "introduction.tex"],
				['"the abstract"   and conclusion', "the abstract and conclusion"],
				['"The system achieves [word_to_select] and <good> results; $1 stays literal."', "The system achieves [word_to_select] and <good> results; $1 stays literal."],
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

test("templates retain core writing workflows and constraints", async () => {
	const guidance: Record<string, RegExp[]> = {
		"conference-reviewer": [/Paper Summary/, /Strengths/, /Weaknesses/, /Questions for Authors/, /Overall Recommendation/, /Confidence Level/, /Score should match written feedback/, /Admit when outside your expertise/],
		evaluate: [/without modifying the original content/, /five dimensions/, /overall quality score \(0-100\)/, /Bad-first Approach/, /Only suggest significant improvements/, /estimated score impact/],
		"grammar-checker": [/Pass 1: Typos and Spelling/, /Pass 2: Grammar Errors/, /Pass 3: Inappropriate Words and Phrases/, /Pass 4: Awkward Expressions/, /Pass 5: Academic Writing Style/, /Do not modify LaTeX commands or environments/, /Only flag genuine errors/, /Corrected Text/],
		"paper-validator": [/six key areas/, /Always include file paths and line numbers/, /Read Paper Files/, /Search for Patterns/, /Analyze Structure/, /Only make edits if explicitly requested/, /Avoid pedantic or nit-picking/],
		polish: [/preserving technical accuracy and LaTeX integrity/, /Avoid hyphens for connecting independent clauses/, /Prefer active voice/, /Define on first use/, /Change Justification/, /No significant improvements needed/, /Preserve the author's intended meaning/],
		selection: [/three distinct candidate words or short phrases/, /\[word_to_select\]/, /Preference score.*0-100/, /Meaning and nuance/, /Suitability reasoning/, /Usage context/, /Explain trade-offs between candidates/],
		summary: [/maintaining technical accuracy/, /2-5 sentences/, /1-2 sentences/, /Avoid editorializing or adding opinions/, /Do not introduce information not in the source text/],
		validation: [/`<>` delimiters/, /confidence score \(0-100\)/, /If Score > 80/, /If Score ≤ 80/, /Provide 2-3 better candidates/, /Be honest about scores/],
	};
	for (const [name, patterns] of Object.entries(guidance)) {
		const prompt = await readFile(path.join(writerRoot, "prompts", `${name}.md`), "utf8");
		for (const pattern of patterns) assert.match(prompt, pattern, `${name}: ${pattern}`);
	}
});

test("documentation lists every command and explains native template migration", async () => {
	const readme = await readFile(path.join(writerRoot, "README.md"), "utf8");
	assert.match(readme, /\[claude-writer\]\(https:\/\/github.com\/minhuw\/claude-writer\)/);
	for (const name of names) {
		assert.match(readme, new RegExp(`^\\| \`/${name}\` \\|`, "m"));
		assert.match(readme, new RegExp(`^/${name}`, "m"));
	}
	for (const pattern of [/--prompt-template/, /extensions\/writer\/index\.ts/, /\/skill:<name>/, /Package filters/, /\/reload/]) {
		assert.match(readme, pattern);
	}
});
