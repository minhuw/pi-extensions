import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, loadConfig } from "../config.ts";
import { fffFileAnnotation } from "../index.ts";
import {
	canonicalRoot,
	HOME_DIR,
	isFsRoot,
	isHomeDir,
	resolveDbPaths,
} from "../paths.ts";
import {
	buildQuery,
	normalizeExcludes,
	normalizePathConstraint,
	rootCovers,
	routePathConstraint,
} from "../query.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix = "pi-fff-test-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

const origXdgCache = process.env.XDG_CACHE_HOME;
const origXdgData = process.env.XDG_DATA_HOME;

afterEach(() => {
	if (origXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
	else process.env.XDG_CACHE_HOME = origXdgCache;

	if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = origXdgData;

	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

afterAll(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("loadConfig", () => {
	it("returns {} when pi-fff.json is missing", () => {
		const agentDir = makeTempDir();
		expect(loadConfig(agentDir)).toEqual({});
	});

	it("parses a valid full config across all fields and modes", () => {
		const agentDir = makeTempDir();
		const configPath = path.join(agentDir, CONFIG_FILE_NAME);
		const full = {
			$schema: "https://example.com/pi-fff.schema.json",
			mode: "override" as const,
			frecencyDbPath: "/custom/frecency",
			historyDbPath: "/custom/history",
			enableFsRootScanning: true,
			enableHomeDirScanning: false,
			warnOnHomeDirScan: false,
			followSymlinks: true,
		};
		fs.writeFileSync(configPath, JSON.stringify(full), "utf8");
		expect(loadConfig(agentDir)).toEqual(full);

		for (const mode of ["tools-and-ui", "tools-only", "override"] as const) {
			fs.writeFileSync(configPath, JSON.stringify({ mode }), "utf8");
			expect(loadConfig(agentDir).mode).toBe(mode);
		}
	});

	it("throws descriptive errors naming the config path on invalid inputs", () => {
		const agentDir = makeTempDir();
		const configPath = path.join(agentDir, CONFIG_FILE_NAME);

		const expectInvalid = (raw: string, pattern: RegExp) => {
			fs.writeFileSync(configPath, raw, "utf8");
			expect(() => loadConfig(agentDir)).toThrowError(
				new RegExp(
					`${escapeRegExp(configPath)}.*${pattern.source}`,
				),
			);
		};

		// Malformed JSON
		expectInvalid("{not-json", /not valid JSON/);

		// Non-object JSON values
		for (const nonObject of ["null", "[]", '"string"', "42", "true"]) {
			expectInvalid(nonObject, /expected a JSON object/);
		}

		// Unknown keys
		expectInvalid(JSON.stringify({ extraKey: true }), /unknown option "extraKey"/);

		// Invalid mode
		expectInvalid(
			JSON.stringify({ mode: "bogus" }),
			/"mode" must be one of tools-and-ui, tools-only, override/,
		);

		// Empty string or non-string DB / schema paths
		expectInvalid(
			JSON.stringify({ frecencyDbPath: "" }),
			/"frecencyDbPath" must be a non-empty string/,
		);
		expectInvalid(
			JSON.stringify({ historyDbPath: "" }),
			/"historyDbPath" must be a non-empty string/,
		);
		expectInvalid(
			JSON.stringify({ frecencyDbPath: 123 }),
			/"frecencyDbPath" must be a non-empty string/,
		);
		expectInvalid(
			JSON.stringify({ $schema: "" }),
			/"\$schema" must be a non-empty string/,
		);

		// Non-boolean flags
		for (const flag of [
			"enableFsRootScanning",
			"enableHomeDirScanning",
			"warnOnHomeDirScan",
			"followSymlinks",
		] as const) {
			expectInvalid(
				JSON.stringify({ [flag]: "true" }),
				new RegExp(`"${flag}" must be a boolean`),
			);
			expectInvalid(
				JSON.stringify({ [flag]: 1 }),
				new RegExp(`"${flag}" must be a boolean`),
			);
		}
	});
});

describe("paths", () => {
	it("canonicalRoot resolves symlinks to identical canonical paths and falls back on missing paths", () => {
		const base = makeTempDir();
		const realDir = path.join(base, "real");
		const linkDir = path.join(base, "link");
		fs.mkdirSync(realDir);
		fs.symlinkSync(realDir, linkDir, "dir");

		const canonReal = canonicalRoot(realDir);
		const canonLink = canonicalRoot(linkDir);
		expect(canonLink).toBe(canonReal);
		expect(canonReal).toBe(fs.realpathSync.native(realDir));

		const missing = path.join(base, "does-not-exist", "nested");
		expect(canonicalRoot(missing)).toBe(path.resolve(missing));
	});

	it("isHomeDir detects the home directory (including via symlink) and rejects others", () => {
		const base = makeTempDir();
		const homeLink = path.join(base, "home-link");
		fs.symlinkSync(HOME_DIR, homeLink, "dir");

		expect(isHomeDir(HOME_DIR)).toBe(true);
		expect(isHomeDir(homeLink)).toBe(true);
		expect(isHomeDir(base)).toBe(false);
	});

	it("isFsRoot detects the filesystem root and rejects subdirectories", () => {
		const fsRoot = path.parse(process.cwd()).root;
		const base = makeTempDir();

		expect(isFsRoot(fsRoot)).toBe(true);
		expect(isFsRoot(base)).toBe(false);
		expect(isFsRoot(HOME_DIR)).toBe(false);
	});

	it("resolveDbPaths enforces explicit overrides > existing nvim dirs > agentDir defaults", () => {
		const sandbox = makeTempDir();
		const agentDir = path.join(sandbox, "agent");
		const xdgCache = path.join(sandbox, "cache");
		const xdgData = path.join(sandbox, "data");
		process.env.XDG_CACHE_HOME = xdgCache;
		process.env.XDG_DATA_HOME = xdgData;

		// 1. Neither overrides nor nvim dirs exist -> falls back to <agentDir>/fff/*
		expect(resolveDbPaths({}, agentDir)).toEqual({
			frecency: path.join(agentDir, "fff", "frecency"),
			history: path.join(agentDir, "fff", "history"),
		});

		// Stray regular files at nvim db locations are ignored (must be directories)
		fs.mkdirSync(path.join(xdgCache, "nvim"), { recursive: true });
		fs.mkdirSync(path.join(xdgData, "nvim"), { recursive: true });
		fs.writeFileSync(path.join(xdgCache, "nvim", "fff_nvim"), "not-a-dir");
		fs.writeFileSync(path.join(xdgData, "nvim", "fff_queries"), "not-a-dir");
		expect(resolveDbPaths({}, agentDir)).toEqual({
			frecency: path.join(agentDir, "fff", "frecency"),
			history: path.join(agentDir, "fff", "history"),
		});

		// 2. Existing nvim db directories beat agentDir defaults
		fs.rmSync(path.join(xdgCache, "nvim", "fff_nvim"));
		fs.rmSync(path.join(xdgData, "nvim", "fff_queries"));
		const nvimFrecency = path.join(xdgCache, "nvim", "fff_nvim");
		const nvimHistory = path.join(xdgData, "nvim", "fff_queries");
		fs.mkdirSync(nvimFrecency, { recursive: true });
		fs.mkdirSync(nvimHistory, { recursive: true });
		expect(resolveDbPaths({}, agentDir)).toEqual({
			frecency: nvimFrecency,
			history: nvimHistory,
		});

		// 3. Explicit overrides beat existing nvim dirs
		expect(
			resolveDbPaths(
				{
					frecency: "/explicit/frecency-db",
					history: "/explicit/history-db",
				},
				agentDir,
			),
		).toEqual({
			frecency: "/explicit/frecency-db",
			history: "/explicit/history-db",
		});
	});
});

describe("query helpers", () => {
	describe("normalizePathConstraint", () => {
		it("handles empty, dot, and wildcard-all constraints", () => {
			const cwd = "/workspace/project";
			expect(normalizePathConstraint("", cwd)).toBe("");
			expect(normalizePathConstraint("   ", cwd)).toBe("");
			expect(normalizePathConstraint(".", cwd)).toBeNull();
			expect(normalizePathConstraint("./", cwd)).toBeNull();
			expect(normalizePathConstraint("**", cwd)).toBeNull();
			expect(normalizePathConstraint("**/", cwd)).toBeNull();
			expect(normalizePathConstraint("**/*", cwd)).toBeNull();
			expect(normalizePathConstraint("./**/*", cwd)).toBeNull();
		});

		it("collapses recursive directory globs, preserves file globs, and distinguishes dirs vs files", () => {
			const cwd = "/workspace/project";
			expect(normalizePathConstraint(".agents/**", cwd)).toBe(".agents/");
			expect(normalizePathConstraint(".agents/**/*", cwd)).toBe(".agents/");
			expect(normalizePathConstraint("src/**/*.ts", cwd)).toBe("src/**/*.ts");
			expect(normalizePathConstraint("./**/*.rs", cwd)).toBe("**/*.rs");
			expect(normalizePathConstraint("src/foo", cwd)).toBe("src/foo/");
			expect(normalizePathConstraint("src/foo/", cwd)).toBe("src/foo/");
			expect(normalizePathConstraint("main.rs", cwd)).toBe("main.rs");
			expect(normalizePathConstraint("src/config.json", cwd)).toBe(
				"src/config.json",
			);
		});

		it("rebases workspace-inside absolute paths and throws on outside absolute paths", () => {
			const cwd = "/workspace/project";
			expect(normalizePathConstraint("/workspace/project", cwd)).toBeNull();
			expect(normalizePathConstraint("/workspace/project/src/foo", cwd)).toBe(
				"src/foo/",
			);
			expect(normalizePathConstraint("/workspace/project/main.rs", cwd)).toBe(
				"main.rs",
			);

			expect(() =>
				normalizePathConstraint("/outside/other/src", cwd),
			).toThrow(/Path constraint must be relative to the workspace/);
			expect(() => normalizePathConstraint("/workspace", cwd)).toThrow(
				/Path constraint must be relative to the workspace/,
			);
		});
	});

	describe("normalizeExcludes and buildQuery", () => {
		it("normalizes comma/space/array excludes without double-negation", () => {
			const cwd = "/workspace/project";
			expect(normalizeExcludes(undefined, cwd)).toEqual([]);
			expect(normalizeExcludes("", cwd)).toEqual([]);
			expect(
				normalizeExcludes("test/, *.min.js !vendor/ !build", cwd),
			).toEqual(["!test/", "!*.min.js", "!vendor/", "!build/"]);
			expect(
				normalizeExcludes(["!dist/**", "config.json", "."], cwd),
			).toEqual(["!dist/", "!config.json"]);
		});

		it("builds combined query tokens in path -> excludes -> pattern order", () => {
			const cwd = "/workspace/project";
			expect(
				buildQuery("src/foo", "mySymbol", "test/, !*.min.js", cwd),
			).toBe("src/foo/ !test/ !*.min.js mySymbol");
			expect(buildQuery(".", "mySymbol", undefined, cwd)).toBe("mySymbol");
			expect(buildQuery(".agents/**", "skill", ["!vendor"], cwd)).toBe(
				".agents/ !vendor/ skill",
			);
		});
	});

	describe("routePathConstraint", () => {
		it("returns null for workspace-relative constraints and inside-workspace paths", () => {
			const parent = makeTempDir();
			const workspace = path.join(parent, "workspace");
			fs.mkdirSync(path.join(workspace, "src"), { recursive: true });

			expect(routePathConstraint(undefined, workspace)).toBeNull();
			expect(routePathConstraint("", workspace)).toBeNull();
			expect(routePathConstraint("src/foo", workspace)).toBeNull();
			expect(routePathConstraint("./src/foo.ts", workspace)).toBeNull();
			expect(
				routePathConstraint(path.join(workspace, "src"), workspace),
			).toBeNull();
			expect(
				routePathConstraint("../workspace/src", workspace),
			).toBeNull();
		});

		it("resolves ../sibling, ~/..., and outside absolute paths to deepest existing ancestor + suffix", () => {
			const parent = makeTempDir();
			const workspace = path.join(parent, "workspace");
			const sibling = path.join(parent, "sibling");
			const siblingPkg = path.join(sibling, "pkg");
			const siblingFile = path.join(siblingPkg, "entry.ts");
			fs.mkdirSync(workspace, { recursive: true });
			fs.mkdirSync(siblingPkg, { recursive: true });
			fs.writeFileSync(siblingFile, "export const x = 1;\n", "utf8");

			// ../sibling existing directory + missing descendants
			expect(
				routePathConstraint("../sibling/pkg/missing/sub", workspace),
			).toEqual({
				root: siblingPkg,
				suffix: "missing/sub",
			});

			// ../sibling pointing directly at an existing file splits parent dir + filename suffix
			expect(
				routePathConstraint("../sibling/pkg/entry.ts", workspace),
			).toEqual({
				root: siblingPkg,
				suffix: "entry.ts",
			});

			// Outside absolute path with glob segment splits before first glob
			expect(
				routePathConstraint(path.join(sibling, "pkg", "*", "index.ts"), workspace),
			).toEqual({
				root: siblingPkg,
				suffix: "*/index.ts",
			});

			// ~/... resolves against HOME_DIR (fresh temp subdir never equals or covers HOME_DIR)
			expect(routePathConstraint("~", workspace)).toEqual({
				root: HOME_DIR,
				suffix: "",
			});
			expect(
				routePathConstraint(
					"~/__definitely_nonexistent_pi_fff_test_dir__/foo.ts",
					workspace,
				),
			).toEqual({
				root: HOME_DIR,
				suffix: "__definitely_nonexistent_pi_fff_test_dir__/foo.ts",
			});
		});
	});

	describe("rootCovers", () => {
		it("checks exact match and path-boundary containment without prefix collisions", () => {
			expect(rootCovers("/a/b", "/a/b")).toBe(true);
			expect(rootCovers("/a/b", "/a/b/c/d.ts")).toBe(true);
			expect(rootCovers("/", "/a/b")).toBe(true);
			expect(rootCovers("/a/bar", "/a/barbaz")).toBe(false);
			expect(rootCovers("/a/b", "/a")).toBe(false);
		});
	});
});

describe("fffFileAnnotation", () => {
	it("prioritizes dirty git status over hot frecency", () => {
		expect(
			fffFileAnnotation({
				gitStatus: "modified",
				totalFrecencyScore: 100,
			}),
		).toBe("  [modified in git]");
		expect(
			fffFileAnnotation({
				gitStatus: "untracked",
				accessFrecencyScore: 50,
			}),
		).toBe("  [untracked in git]");
	});

	it("falls through clean/unknown/empty git status to hot (>=25), warm (>=20), or empty", () => {
		for (const gitStatus of [undefined, "", "clean", "unknown"]) {
			expect(
				fffFileAnnotation({ gitStatus, totalFrecencyScore: 25 }),
			).toBe("  [VERY often touched file]");
			expect(
				fffFileAnnotation({ gitStatus, accessFrecencyScore: 30 }),
			).toBe("  [VERY often touched file]");
			expect(
				fffFileAnnotation({ gitStatus, totalFrecencyScore: 20 }),
			).toBe("  [often touched file]");
			expect(
				fffFileAnnotation({ gitStatus, totalFrecencyScore: 24 }),
			).toBe("  [often touched file]");
			expect(
				fffFileAnnotation({ gitStatus, totalFrecencyScore: 19 }),
			).toBe("");
			expect(fffFileAnnotation({ gitStatus })).toBe("");
		}
	});
});

describe("package.json manifest invariants", () => {
	it("registers fff before workspace and pika (with pika last), declares @ff-labs/fff-node, and wires test:fff", () => {
		const repoRoot = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../..",
		);
		const pkg = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
			scripts?: Record<string, string>;
			pi?: { extensions?: string[] };
		};

		const extensions = pkg.pi?.extensions ?? [];
		const fffIdx = extensions.indexOf("./extensions/fff/index.ts");
		const workspaceIdx = extensions.indexOf("./extensions/workspace/index.ts");
		const pikaIdx = extensions.indexOf("./extensions/pika/index.ts");

		expect(fffIdx).toBeGreaterThanOrEqual(0);
		expect(workspaceIdx).toBeGreaterThan(fffIdx);
		expect(pikaIdx).toBeGreaterThan(fffIdx);
		expect(extensions.at(-1)).toBe("./extensions/pika/index.ts");

		expect(pkg.dependencies?.["@ff-labs/fff-node"]).toBeTruthy();
		expect(pkg.scripts?.["test:fff"]).toBeTruthy();
		expect(pkg.scripts?.test).toContain("npm run test:fff");
	});
});

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
