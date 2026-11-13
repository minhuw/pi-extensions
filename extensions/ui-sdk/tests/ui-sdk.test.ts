// The vendored UI SDK skill: byte-identical to upstream.json, loadable by Pi, and offered only through Impeccable as a design companion.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import uiSdkExtension, { DESIGN_COMPANIONS, UI_SDK_COMPANION, type DesignCompanion } from "../index.ts";

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

});

describe("design companion", () => {
	const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { pi: { skills: string[]; extensions: string[] } };

	it("stays out of pi.skills, so ui-sdk never reaches <available_skills>", () => {
		expect(manifest.pi.skills.filter((path) => path.includes("ui-sdk"))).toEqual([]);
		expect(manifest.pi.extensions).toContain("./extensions/ui-sdk/index.ts");
		expect(manifest.pi.extensions.at(-1)).toBe("./extensions/pika/index.ts");
	});

	it("publishes one companion entry with the vendored SKILL.md, idempotently across reloads", () => {
		const registry = globalThis as { [DESIGN_COMPANIONS]?: Map<string, DesignCompanion> };
		const previous = registry[DESIGN_COMPANIONS];
		delete registry[DESIGN_COMPANIONS];
		try {
			uiSdkExtension({} as ExtensionAPI);
			uiSdkExtension({} as ExtensionAPI);
			const companions = [...registry[DESIGN_COMPANIONS]!.values()];
			expect(companions).toEqual([UI_SDK_COMPANION]);
			expect(UI_SDK_COMPANION.skillPath).toBe(join(skillDir, "SKILL.md"));
			expect(existsSync(UI_SDK_COMPANION.skillPath)).toBe(true);
			expect(UI_SDK_COMPANION.installedSkillPath).toBe("node_modules/@ui-sdk/core/skills/ui-sdk/SKILL.md");
		} finally {
			if (previous) registry[DESIGN_COMPANIONS] = previous;
			else delete registry[DESIGN_COMPANIONS];
		}
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
});
