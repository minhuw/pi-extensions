import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const promptEntry = "./extensions/benchmark/prompts/benchmark.md";
const manifest: { pi: { extensions: string[]; prompts: string[] } } = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));

// Pi's native expansion helper is exported by this module, but not its package entry point.
const { expandPromptTemplate } = await import(
	new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };

it("loads the extension before pika, which stays last, and lists the /benchmark prompt", () => {
	const { extensions, prompts } = manifest.pi;
	expect(extensions).toContain("./extensions/benchmark/index.ts");
	expect(extensions.at(-1)).toBe("./extensions/pika/index.ts");
	expect(prompts.filter(entry => entry.includes("extensions/benchmark/"))).toEqual([promptEntry]);
});

it("keeps Autoresearch importing only core.ts from the benchmark directory", async () => {
	const directory = path.join(repositoryRoot, "extensions/autoresearch");
	const files = (await readdir(directory, { recursive: true })).filter(file => file.endsWith(".ts"));
	const specifiers = (await Promise.all(files.map(file => readFile(path.join(directory, file), "utf8"))))
		.flatMap(source => [...source.matchAll(/from\s+"([^"]*benchmark[^"]*)"/g)].map(match => match[1]!));
	expect(specifiers.length).toBeGreaterThan(0);
	for (const specifier of specifiers) expect(specifier).toMatch(/^(\.\.\/)+benchmark\/core\.ts$/);
});

it("loads /benchmark through Pi's resource loader and expands it with the instructions in order", async () => {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-benchmark-prompt-"));
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
		const matches = prompts.filter(prompt => prompt.name === "benchmark");
		expect(matches).toHaveLength(1);
		const [prompt] = matches as [PromptTemplate];
		expect(prompt.filePath).toBe(path.resolve(repositoryRoot, promptEntry));
		expect(prompt.description).toBe("Measure a performance claim with benchmark_compare and report the verdict with medians, ranges, and run counts");
		expect(prompt.argumentHint).toBe("<change or claim to measure>");
		expect(prompt.content.trimEnd().endsWith("What to measure:\n$ARGUMENTS")).toBe(true);

		const argument = "the new parser against main on the large fixture";
		const expanded = expandPromptTemplate(`/benchmark ${argument}`, prompts);
		expect(expanded).toBe(prompt.content.replace("$ARGUMENTS", () => argument));
		expect(expanded.trimEnd().endsWith(argument)).toBe(true);
		let previous = -1;
		for (const instruction of [
			/Write down the claim you expect to make before running anything/,
			/Read the measurement script.*note what it times/,
			/Check machine load and core count \(`uptime`.*if the machine is busy, keep the sides alternating/,
			/one `METRIC name=value` line per metric.*an errors count.*a work count/,
			/Run both sides the way production runs them.*call the result inconclusive/,
			/Measure only with `benchmark_compare`.*Use 5 repetitions unless a single run is very slow/,
			/What limits the number\?.*why it is not twice as fast/,
			/break a physical limit.*more time than the changed part takes/,
			/Were errors zero in every run.*work actually ran/,
			/matter end to end/,
			/Lead with the verdict.*median, min–max range, and run count/,
			/Never report a number the tool did not produce/,
			/coarse check, not a significance test/,
		]) {
			const match = instruction.exec(expanded);
			expect(match, String(instruction)).not.toBeNull();
			expect(match!.index, `${instruction} follows the previous instruction`).toBeGreaterThan(previous);
			previous = match!.index;
		}
	} finally { await rm(temporary, { recursive: true, force: true }); }
});

it("documents the extension, its tool, and its prompt", async () => {
	const [readme, root, agents] = await Promise.all(["extensions/benchmark/README.md", "README.md", "AGENTS.md"].map(file => readFile(path.join(repositoryRoot, file), "utf8")));
	for (const text of ["benchmark_compare", "/benchmark", "about 2 times in 252", "coarse check, not a significance test", "core.ts"]) expect(readme).toContain(text);
	expect(root).toMatch(/\| \[Benchmark\]\(extensions\/benchmark\/README\.md\) \|.*`\/benchmark <what>`.*`benchmark_compare`/);
	expect(agents).toMatch(/`extensions\/benchmark\/`.*`core\.ts`.*registers nothing.*`benchmark_compare`.*`\/benchmark <what>`/);
});
