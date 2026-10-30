import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type PromptTemplate } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const extensionRoot = path.join(repositoryRoot, "extensions/impeccable");
const skillsRoot = path.join(extensionRoot, "skills");
const skillDir = path.join(skillsRoot, "impeccable");
const promptsDir = path.join(extensionRoot, "prompts");
const vendorRoot = path.join(extensionRoot, "vendor", "impeccable-4.8.0");
const transformScript = path.join(extensionRoot, "scripts", "transform.mjs");

// The 24 upstream command-metadata entries, in metadata order.
const expectedCommands = [
	"craft",
	"init",
	"document",
	"extract",
	"live",
	"generate",
	"adapt",
	"animate",
	"audit",
	"bolder",
	"clarify",
	"colorize",
	"critique",
	"delight",
	"distill",
	"harden",
	"onboard",
	"layout",
	"optimize",
	"overdrive",
	"polish",
	"quieter",
	"shape",
	"typeset",
] as const;
const expectedPromptNames = ["design", "impeccable", ...expectedCommands.map((command) => `design-${command}`)];
const expectedPromptEntries = expectedPromptNames
	.map((name) => `./extensions/impeccable/prompts/${name}.md`)
	.sort();

// Pi's native expansion helper is exported by this module, but not its package entry point.
const { expandPromptTemplate } = (await import(
	new URL("./core/prompt-templates.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
)) as { expandPromptTemplate: (text: string, templates: PromptTemplate[]) => string };

async function readManifest(): Promise<{
	pi: { extensions: string[]; skills: string[]; prompts: string[] };
	scripts: Record<string, string>;
}> {
	return JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
		pi: { extensions: string[]; skills: string[]; prompts: string[] };
		scripts: Record<string, string>;
	};
}

async function walk(root: string): Promise<string[]> {
	const files: string[] = [];
	async function visit(dir: string, prefix: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const relative = prefix ? path.join(prefix, entry.name) : entry.name;
			if (entry.isDirectory()) await visit(full, relative);
			else files.push(relative);
		}
	}
	await visit(root, "");
	return files.sort();
}

async function expectTreesEqual(actualRoot: string, expectedRoot: string): Promise<void> {
	const actual = await walk(actualRoot);
	const expected = await walk(expectedRoot);
	expect(actual).toEqual(expected);
	for (const relative of actual) {
		const actualContent = await readFile(path.join(actualRoot, relative));
		const expectedContent = await readFile(path.join(expectedRoot, relative));
		expect(actualContent.equals(expectedContent), `${relative} differs`).toBe(true);
	}
}

async function newIsolatedDirs(): Promise<{ cwd: string; agentDir: string; cleanup: () => Promise<void> }> {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-impeccable-contracts-"));
	const cwd = path.join(temporary, "project");
	const agentDir = path.join(temporary, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	return { cwd, agentDir, cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

describe("root package registration", () => {
	it("registers the skill, 26 native prompts, and the engine tool extension before pika", async () => {
		const manifest = await readManifest();
		expect(manifest.pi.skills).toContain("./extensions/impeccable/skills");
		expect(manifest.pi.prompts.filter((entry) => entry.includes("extensions/impeccable/")).sort()).toEqual(
			expectedPromptEntries,
		);
		const extensions = manifest.pi.extensions;
		expect(extensions).toContain("./extensions/impeccable/index.ts");
		expect(extensions.indexOf("./extensions/impeccable/index.ts")).toBeLessThan(
			extensions.indexOf("./extensions/pika/index.ts"),
		);

		expect(manifest.scripts["test:impeccable:contracts"]).toBe(
			"vitest run --config extensions/impeccable/vitest.config.ts extensions/impeccable/tests/contracts.test.ts",
		);
		expect(manifest.scripts["test:impeccable"]).toBe(
			"vitest run --config extensions/impeccable/vitest.config.ts",
		);
		expect(manifest.scripts.test.split(" && ")).toContain("npm run test:impeccable");
		expect(manifest.scripts["test:impeccable:package"]).toBe(
			"vitest run --config extensions/impeccable/vitest.package.config.ts",
		);
		const { default: packageConfig } = await import("../vitest.package.config.ts");
		expect(packageConfig.test?.include).toEqual(["extensions/impeccable/tests/package/**/*.test.ts"]);
		expect(packageConfig.test?.passWithNoTests).toBe(false);
		const { default: scopedConfig } = await import("../vitest.config.ts");
		expect(scopedConfig.test?.exclude).toContain("extensions/impeccable/tests/package/**");
		expect(scopedConfig.test?.exclude).toContain("extensions/impeccable/tests/e2e/**");
		expect(manifest.scripts["test:impeccable:visual-foundations"]).toBe(
			"vitest run --config extensions/impeccable/vitest.visual-foundations.config.ts",
		);
		expect(manifest.scripts.test).not.toContain("visual-foundations");
		expect(manifest.scripts["test:impeccable:e2e"]).toBe("vitest run --config extensions/impeccable/vitest.e2e.config.ts");
		expect(manifest.scripts.test).not.toContain("impeccable:e2e");
		const { default: e2eConfig } = await import("../vitest.e2e.config.ts");
		expect(e2eConfig.test?.include).toEqual([
			"extensions/impeccable/tests/e2e/engine-parity.test.ts",
			"extensions/impeccable/tests/e2e/live-engine.test.ts",
			"extensions/impeccable/tests/e2e/visual-foundations.test.ts",
			"extensions/impeccable/tests/e2e/live-browser.test.ts",
		]);
		expect(e2eConfig.test?.fileParallelism).toBe(false);
		expect(e2eConfig.test?.passWithNoTests).toBe(false);
		const { RequiredCoverage } = await import("./e2e/required-coverage.ts");
		expect(e2eConfig.test?.reporters).toEqual(["default", expect.any(RequiredCoverage)]);
		expect(() => new RequiredCoverage().onTestRunEnd([])).toThrow("Required Impeccable E2E phase missing, empty, skipped or failed");
		const { default: visualConfig } = await import("../vitest.visual-foundations.config.ts");
		expect(visualConfig.test?.include).toEqual(["extensions/impeccable/tests/e2e/visual-foundations.test.ts"]);
		const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
		expect(packageJson.devDependencies["playwright-core"]).toBe("1.56.1");
		expect(packageJson.dependencies).not.toHaveProperty("playwright-core");
		expect(packageJson.scripts).not.toHaveProperty("postinstall");
	});

	it("introduces no command-name collision with the rest of the collection", async () => {
		const manifest = await readManifest();
		const ours = new Set(expectedPromptNames);
		const existing = manifest.pi.prompts.map((entry) => path.basename(entry, ".md")).filter((name) => !ours.has(name));
		for (const name of ours) {
			expect(existing, `/${name} collides with an existing prompt`).not.toContain(name);
		}
		// Explicitly preserve the commands the collection already owns.
		for (const preserved of ["polish", "review", "simplify", "deslop", "verify", "commit"]) {
			expect(ours.has(preserved)).toBe(false);
		}
	});
});

describe("skill discovery and portability", () => {
	it("loads the impeccable skill through Pi with normal discovery and portable paths", async () => {
		const { cwd, agentDir, cleanup } = await newIsolatedDirs();
		try {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noContextFiles: true,
				noPromptTemplates: true,
				additionalSkillPaths: [skillsRoot],
			});
			await loader.reload();
			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const matches = skills.filter((skill) => skill.name === "impeccable");
			expect(matches).toHaveLength(1);
			const [skill] = matches;
			expect(skill.filePath).toBe(path.join(skillDir, "SKILL.md"));
			expect(skill.baseDir).toBe(skillDir);
			expect(skill.disableModelInvocation).toBe(false);
			expect(skill.description).toContain("design, redesign, shape, critique, audit, polish");
		} finally {
			await cleanup();
		}
	});

	it("documents the managed tool preference and launcher fallback in Setup", async () => {
		const skillText = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
		expect(skillText).toContain("Prefer the `impeccable_run` tool when it is available");
		expect(skillText).toContain("resolve the absolute skill launcher `<skill-base-dir>/scripts/impeccable`");
		expect(skillText).toContain("<skill-base-dir>/scripts/impeccable context");
	});

	it("never bakes an absolute or project-relative path and survives relocation", async () => {
		const skillText = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
		expect(skillText).not.toContain(".pi/skills/impeccable");
		expect(skillText).not.toContain(repositoryRoot);
		expect(skillText).toContain("<skill-base-dir>/scripts/impeccable");

		const { cwd, agentDir, cleanup } = await newIsolatedDirs();
		try {
			const relocated = path.join(agentDir, "relocated", "impeccable");
			await cp(skillDir, relocated, { recursive: true });
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noContextFiles: true,
				noPromptTemplates: true,
				additionalSkillPaths: [relocated],
			});
			await loader.reload();
			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const [skill] = skills.filter((candidate) => candidate.name === "impeccable");
			expect(skill).toBeDefined();
			expect(skill.baseDir).toBe(relocated);
			expect(skill.filePath).toBe(path.join(relocated, "SKILL.md"));

			for (const relative of await walk(relocated)) {
				if (!relative.endsWith(".md")) continue;
				const text = await readFile(path.join(relocated, relative), "utf8");
				expect(text, `${relative} bakes a project-relative path`).not.toContain(".pi/skills");
				expect(text, `${relative} bakes the repository path`).not.toContain(repositoryRoot);
			}
		} finally {
			await cleanup();
		}
	});
});

describe("native prompt templates", () => {
	it("loads 26 prompts, mirrors command metadata, and expands $ARGUMENTS natively", async () => {
		const manifest = await readManifest();
		const metadata = JSON.parse(
			await readFile(path.join(skillDir, "scripts", "command-metadata.json"), "utf8"),
		) as Record<string, { description: string; argumentHint: string }>;
		expect(Object.keys(metadata)).toEqual(expectedCommands);

		const { cwd, agentDir, cleanup } = await newIsolatedDirs();
		try {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noContextFiles: true,
				noPromptTemplates: true,
				additionalPromptTemplatePaths: manifest.pi.prompts
					.filter((entry) => entry.includes("extensions/impeccable/"))
					.map((entry) => path.resolve(repositoryRoot, entry)),
			});
			await loader.reload();
			const { prompts, diagnostics } = loader.getPrompts();
			expect(diagnostics).toEqual([]);
			const byName = new Map(prompts.map((prompt) => [prompt.name, prompt]));
			expect([...byName.keys()].sort()).toEqual(expectedPromptNames.slice().sort());

			for (const command of expectedCommands) {
				const prompt = byName.get(`design-${command}`);
				if (!prompt) throw new Error(`missing /design-${command}`);
				expect(prompt.filePath).toBe(path.join(promptsDir, `design-${command}.md`));
				expect(prompt.description).toBe(metadata[command].description);
				expect(prompt.argumentHint ?? undefined).toBe(metadata[command].argumentHint || undefined);
				expect(prompt.content).toContain(`<skill-base-dir>/reference/${command}.md`);
				expect(prompt.content).not.toContain(repositoryRoot);
				expect(prompt.content).not.toContain(".pi/skills");
				expect(prompt.content.trimEnd().endsWith("$ARGUMENTS")).toBe(true);
			}

			for (const name of ["impeccable", "design"]) {
				const prompt = byName.get(name);
				if (!prompt) throw new Error(`missing /${name}`);
				expect(prompt.filePath).toBe(path.join(promptsDir, `${name}.md`));
				expect(prompt.content).toContain("<skill-base-dir>/reference/routing.md");
				expect(prompt.content).toContain("<skill-base-dir>/reference/new-work.md");
				expect(prompt.content).not.toContain(repositoryRoot);
				expect(prompt.content).not.toContain(".pi/skills");
				expect(prompt.content.trimEnd().endsWith("$ARGUMENTS")).toBe(true);
			}

			const polish = byName.get("design-polish")!;
			const impeccable = byName.get("impeccable")!;
			const expand = (command: string) => expandPromptTemplate(command, prompts);
			expect(expand("/design-polish")).toBe(polish.content.replace("$ARGUMENTS", ""));
			expect(expand("/design-polish src/pricing")).toBe(polish.content.replace("$ARGUMENTS", "src/pricing"));
			expect(expand('/design-polish "src/pricing flow"  focus on errors')).toBe(
				polish.content.replace("$ARGUMENTS", "src/pricing flow focus on errors"),
			);
			expect(expand('/design-polish "keep literal $1 and $ARGUMENTS"')).toBe(
				polish.content.replace("$ARGUMENTS", "keep literal $1 and $ARGUMENTS"),
			);
			expect(expand("/impeccable hooks status")).toBe(impeccable.content.replace("$ARGUMENTS", "hooks status"));
			expect(expand("/design-audit src/app")).toContain("<skill-base-dir>/reference/audit.native.md");
		} finally {
			await cleanup();
		}
	});

	it("routes pin/unpin and teach without inventing nonexistent playbooks", async () => {
		const { cwd, agentDir, cleanup } = await newIsolatedDirs();
		try {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager: SettingsManager.inMemory(),
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noContextFiles: true,
				noPromptTemplates: true,
				additionalPromptTemplatePaths: (await readManifest()).pi.prompts
					.filter((entry) => entry.includes("extensions/impeccable/"))
					.map((entry) => path.resolve(repositoryRoot, entry)),
			});
			await loader.reload();
			const { prompts } = loader.getPrompts();
			const impeccable = prompts.find((prompt) => prompt.name === "impeccable");
			if (!impeccable) throw new Error("missing /impeccable");
			expect(impeccable.content).not.toContain("reference/pin.md");
			expect(impeccable.content).not.toContain("reference/unpin.md");
			expect(impeccable.content).not.toContain("reference/teach.md");
			expect(impeccable.content).toContain("Pin/Unpin section of `<skill-base-dir>/SKILL.md`");
			expect(impeccable.content).toContain("`teach`: this is an alias of `init`");
			expect(impeccable.content).toContain("<skill-base-dir>/reference/init.md");
			expect(impeccable.content).toContain("<skill-base-dir>/reference/doctor.md");
			expect(impeccable.content).toContain("<skill-base-dir>/reference/hooks.md");
		} finally {
			await cleanup();
		}
	});
});

describe("complete upstream playbooks and canonical roles", () => {
	it("preserves every upstream reference playbook without reduction", async () => {
		const references = [
			"new-work.md",
			"document.md",
			"extract.md",
			"craft-floor.md",
			"routing.md",
			"live.md",
			"live-setup.md",
			"generate.md",
			"audit.md",
			"audit.native.md",
			"adapt.md",
			"adapt.native.md",
			"ios.md",
			"android.md",
			"operate.md",
			"mode-persuade.md",
			"mode-operate.md",
			"mode-read.md",
			"region-map.md",
			"visualize.md",
			"component-review.md",
			"hooks.md",
			"doctor.md",
			"init.md",
			"shape.md",
			"critique.md",
			"polish.md",
			"bolder.md",
			"quieter.md",
			"distill.md",
			"harden.md",
			"onboard.md",
			"animate.md",
			"colorize.md",
			"typeset.md",
			"layout.md",
			"delight.md",
			"overdrive.md",
			"clarify.md",
			"optimize.md",
			"craft.md",
		];
		for (const reference of references) {
			const text = await readFile(path.join(skillDir, "reference", reference), "utf8");
			expect(text.length, `${reference} is not a real playbook`).toBeGreaterThan(100);
		}

		const newWork = await readFile(path.join(skillDir, "reference", "new-work.md"), "utf8");
		expect(newWork).toContain("PRODUCT.md owns product truth");
		expect(newWork).toContain("DESIGN.md owns durable visual decisions");
		expect(newWork).toContain("surface brief");
		expect(newWork).toContain("Comp-led");
		expect(newWork).toContain("Code-led");
		expect(newWork).toContain("## Direction contract");

		const craftFloor = await readFile(path.join(skillDir, "reference", "craft-floor.md"), "utf8");
		expect(craftFloor.length).toBeGreaterThan(200);

		const document = await readFile(path.join(skillDir, "reference", "document.md"), "utf8");
		expect(document.length).toBeGreaterThan(1000);
	});

	it("keeps canonical agent-role texts and the degraded inline fallbacks", async () => {
		const roles = [
			"impeccable-asset-producer",
			"impeccable-documenter",
			"impeccable-finish-reviewer",
			"impeccable-manual-edit-applier",
		];
		for (const role of roles) {
			const canonical = await readFile(path.join(skillDir, "reference", "agents", `${role}.md`), "utf8");
			const source = await readFile(path.join(vendorRoot, "source/agents", `${role}.md`), "utf8");
			expect(canonical).toBe(source.replace(/<codex>[\s\S]*?<\/codex>\n?/g, "").replaceAll("{{scripts_path}}", "<skill-base-dir>/scripts").replaceAll("{{reference_path}}", "<skill-base-dir>/reference"));
			expect(canonical).not.toContain("<codex>");
			expect(canonical).not.toContain("image_gen");
			expect(canonical, `canonical role ${role}`).toContain(`name: ${role}`);
			expect(canonical).not.toContain("{{scripts_path}}");
			expect(canonical).not.toContain("{{reference_path}}");
			expect(canonical).not.toContain(".pi/skills");

			const degraded = await readFile(
				path.join(skillDir, "reference", "degraded", `${role.replace(/^impeccable-/, "")}.md`),
				"utf8",
			);
			expect(degraded.length).toBeGreaterThan(100);
		}

		// The asset producer is the role that invokes the launcher; its canonical text must be localized.
		const assetProducer = await readFile(
			path.join(skillDir, "reference", "agents", "impeccable-asset-producer.md"),
			"utf8",
		);
		expect(assetProducer).toContain("<skill-base-dir>/scripts/impeccable");
		expect(assetProducer).toContain("<skill-base-dir>/reference/component-review.md");
	});
});

describe("Pi runtime adaptation contracts", () => {
	it("routes every native entry and affected playbook to one shared adapter reference", async () => {
		for (const name of expectedPromptNames) {
			const text = await readFile(path.join(promptsDir, `${name}.md`), "utf8");
			expect(text).toContain("reference/pi-runtime.md");
			expect(text.length).toBeLessThan(4000);
		}
		expect(await readFile(path.join(skillDir, "SKILL.md"), "utf8")).toContain("reference/pi-runtime.md");
		for (const reference of ["critique", "new-work", "visualize", "document", "live", "component-review"]) {
			const text = await readFile(path.join(skillDir, "reference", `${reference}.md`), "utf8");
			expect(text).toContain("[pi-runtime.md](pi-runtime.md)");
			const upstream = await readFile(path.join(vendorRoot, "pi-dist/reference", `${reference}.md`), "utf8");
			const verbs = new Set([...upstream.matchAll(/\bimpeccable ([a-z][a-z-]+)/g)].map((match) => match[1]));
			for (const verb of verbs) expect(text, `${reference} lost operation ${verb}`).toContain(`impeccable ${verb}`);
		}
	});
	it("retains visual decision pages and source operations while removing invented approval routes", async () => {
		const newWork = await readFile(path.join(skillDir, "reference/new-work.md"), "utf8");
		const visualize = await readFile(path.join(skillDir, "reference/visualize.md"), "utf8");
		for (const operation of ["serve-question --start", "--wait --key", "--update --key", "QUALITY BAR", "generate-image --ref", "embed-prompt"]) {
			expect(newWork + visualize).toContain(operation);
		}
		expect(newWork).not.toContain("proceed unattended with the assigned direction");
		expect(newWork).not.toContain("Never read the shipped agents' definition files");
		expect(visualize).not.toContain("only after both fail may you treat the choice as delegated");
		expect(visualize).not.toContain("structured simulated user");
		expect(visualize).toContain("Only explicit user words delegating the choice");
		const shared = await readFile(path.join(skillDir, "reference/pi-runtime.md"), "utf8");
		for (const requirement of ["inherit_context:false", "isolated:false", "missing engine API key", "codemode", "actual partial answers", "never describe it as independent review", "24 turns", "ceiling 12", "simulator/emulator"]) {
			// Case-insensitive prose checks protect the shared behavioral contract.
			expect(shared.toLowerCase()).toContain(requirement.toLowerCase());
		}
	});
});

describe("provenance and reproducibility", () => {
	it("records upstream provenance and matching vendor hashes", async () => {
		const manifest = (await readFile(path.join(vendorRoot, "MANIFEST.sha256"), "utf8")).trim();
		const entries = manifest.split("\n").filter(Boolean);
		expect(entries.length).toBeGreaterThanOrEqual(63);
		for (const line of entries) {
			const [hash, relative] = line.split(/\s+/);
			const content = await readFile(path.join(vendorRoot, relative));
			expect(createHash("sha256").update(content).digest("hex")).toBe(hash);
		}

		const upstream = JSON.parse(await readFile(path.join(extensionRoot, "upstream.json"), "utf8")) as {
			upstream: { repository: string; tag: string; commit: string; engineVersion: string; license: string };
		};
		expect(upstream.upstream.repository).toBe("https://github.com/pbakaus/impeccable");
		expect(upstream.upstream.tag).toBe("skill-v4.8.0");
		expect(upstream.upstream.commit).toBe("414603bf14c7a344edb466bb1f85690c77ce8b7d");
		expect(upstream.upstream.engineVersion).toBe("0.1.18");
		expect(upstream.upstream.license).toBe("Apache-2.0");

		expect(await readFile(path.join(extensionRoot, "LICENSE"), "utf8")).toContain("Apache License");
		expect(await readFile(path.join(extensionRoot, "NOTICE.md"), "utf8")).toContain("platform-design-skills");
		expect(await readFile(path.join(skillDir, "scripts", "VERSION"), "utf8")).toContain("0.1.18");
	});

	it("reproduces the committed skills/ and prompts/ trees from the vendor snapshot", async () => {
		const { cleanup, cwd, agentDir } = await newIsolatedDirs();
		try {
			const out = path.join(agentDir, "out");
			await mkdir(out);
			await execFileAsync(process.execPath, [transformScript, "--vendor", vendorRoot, "--out", out], { cwd });
			await expectTreesEqual(path.join(out, "skills"), skillsRoot);
			await expectTreesEqual(path.join(out, "prompts"), promptsDir);
		} finally {
			await cleanup();
		}
	});
});
