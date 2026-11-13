// The vendored UI SDK skill: byte-identical to upstream.json, loadable by Pi, and outranked by a project's installed copy.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const extensionDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(extensionDir, "..", "..");
const skillsRoot = join(extensionDir, "skills");
const skillDir = join(skillsRoot, "ui-sdk");

interface Upstream {
	commit: string;
	version: string;
	license: string;
	files: Record<string, string>;
	licenseFile: Record<string, string>;
}
const upstream = JSON.parse(readFileSync(join(extensionDir, "upstream.json"), "utf8")) as Upstream;

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const listFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
		.sort();

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadSkills(cwd: string, agentDir: string, options: { additionalSkillPaths?: string[] } = {}) {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
		noExtensions: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		...options,
	});
	await loader.reload();
	return loader.getSkills();
}

describe("vendored files", () => {
	it("pins a commit and a version", () => {
		expect(upstream.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(upstream.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(upstream.license).toBe("Apache-2.0");
	});

	it("ships exactly the files upstream.json lists, unmodified", () => {
		expect(listFiles(skillDir)).toEqual(Object.keys(upstream.files).sort());
		for (const [path, hash] of Object.entries(upstream.files)) expect(sha256(join(skillDir, path)), path).toBe(hash);
		for (const [path, hash] of Object.entries(upstream.licenseFile)) expect(sha256(join(extensionDir, path)), path).toBe(hash);
	});

	it("is listed in pi.skills", () => {
		const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { pi: { skills: string[] } };
		expect(manifest.pi.skills).toContain("./extensions/ui-sdk/skills");
	});
});

describe("Pi skill loading", () => {
	it("loads ui-sdk with a description, model-invocable, without diagnostics", async () => {
		const root = mkdtempSync(join(tmpdir(), "ui-sdk-skill-"));
		temps.push(root);
		const { skills, diagnostics } = await loadSkills(join(root, "project"), join(root, "agent"), { additionalSkillPaths: [skillsRoot] });
		expect(diagnostics).toEqual([]);
		const matches = skills.filter((skill) => skill.name === "ui-sdk");
		expect(matches).toHaveLength(1);
		const [skill] = matches;
		expect(skill!.filePath).toBe(join(skillDir, "SKILL.md"));
		expect(skill!.description.trim().length).toBeGreaterThan(0);
		expect(skill!.description).toContain("ui-sdk");
		expect(skill!.disableModelInvocation).toBe(false);
	});

	// README: a project settings entry for node_modules/@ui-sdk/core/skills wins over this package's copy.
	it("prefers the project's installed copy, listed in .pi/settings.json, over the package copy", async () => {
		const root = mkdtempSync(join(tmpdir(), "ui-sdk-precedence-"));
		temps.push(root);
		const pkg = join(root, "pkg");
		cpSync(skillsRoot, join(pkg, "skills"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pkg", version: "0.0.0", pi: { skills: ["./skills"] } }));
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg] }));

		const project = join(root, "project");
		const installed = join(project, "node_modules", "@ui-sdk", "core", "skills", "ui-sdk");
		mkdirSync(installed, { recursive: true });
		writeFileSync(join(installed, "SKILL.md"), "---\nname: ui-sdk\ndescription: Installed ui-sdk skill.\n---\n\n# Installed\n");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ skills: ["../node_modules/@ui-sdk/core/skills"] }));

		const { skills, diagnostics } = await loadSkills(project, agentDir);
		const matches = skills.filter((skill) => skill.name === "ui-sdk");
		expect(matches).toHaveLength(1);
		expect(matches[0]!.filePath).toBe(join(installed, "SKILL.md"));
		expect(diagnostics.filter((item) => item.type === "collision").map((item) => item.message)).toEqual(['name "ui-sdk" collision']);
	});
});
