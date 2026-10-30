import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULT_DOWNLOAD_BASE, ENGINE_VERSION, parseChecksums, resolveEngine, runEngine, sha256, type EngineRunResult } from "../../src/engine.ts";
import { runOperation } from "../../src/operations.ts";
import { readConfigs, resolveProject } from "../../src/project.ts";
import { getChecksumsPath } from "../../src/resources.ts";

const exec = promisify(execFile);
const api = { getCommands: () => [] };

/** Explicit network smoke; never included by the offline suite. No provider/browser calls. */
it("compares management scope and literal workspace patterns with the verified pinned native engine", async () => {
	if (process.env.IMPECCABLE_BIN?.trim()) throw new Error("Engine parity refuses ambient IMPECCABLE_BIN; unset it to verify the pinned release.");
	const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-impeccable-parity-")));
	try {
		for (const key of Object.keys(process.env)) if (/^(IMPECCABLE_|GIT_|PI_)/.test(key)) vi.stubEnv(key, undefined);
		const isolated = {
			HOME: path.join(temporary, "home"), USERPROFILE: path.join(temporary, "home"),
			PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
			XDG_CONFIG_HOME: path.join(temporary, "config"), XDG_CACHE_HOME: path.join(temporary, "cache"),
			IMPECCABLE_HOME: path.join(temporary, "engine"),
		};
		for (const [key, directory] of Object.entries(isolated)) { await fs.mkdir(directory, { recursive: true }); vi.stubEnv(key, directory); }
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(temporary, "gitconfig"));
		// Remove ambient credentials/context/provider/Git overrides from native child processes.
		const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
		Object.assign(env, isolated, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: temporary, TMP: temporary, TEMP: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL });
		const options = { binary: "", cacheRoot: isolated.IMPECCABLE_HOME, downloadBase: DEFAULT_DOWNLOAD_BASE, env, timeoutMs: 120_000 };
		const resolved = await resolveEngine(options);
		expect(resolved.trustedOverride).toBe(false);
		expect(resolved.asset).not.toBeNull();
		const digest = sha256(await fs.readFile(resolved.binary));
		expect(digest).toBe(parseChecksums(await fs.readFile(getChecksumsPath(), "utf8"), ENGINE_VERSION).get(resolved.asset!));
		const native = (cwd: string, argv: string[]) => runEngine({ ...options, cwd, argv });
		const adapter = (cwd: string, argv: string[]) => runOperation({ ...options, cwd, argv }, api);
		const complete = (result: EngineRunResult) => {
			expect(result, result.message ?? result.stderr).toMatchObject({ ok: true, status: "success", trustedOverride: false, stdoutTruncated: false, stderrTruncated: false });
			return JSON.parse(result.stdout);
		};
		const probeResult = await native(temporary, ["engine-probe"]);
		expect(probeResult).toMatchObject({ ok: true, status: "success", stdout: `impeccable-engine ${ENGINE_VERSION}\n`, trustedOverride: false });
		const probe = probeResult.stdout.trim();
		process.stdout.write(`Pinned engine identity: ${JSON.stringify({ version: ENGINE_VERSION, asset: resolved.asset, sha256: digest, probe })}\n`);

		const fixture = async (root: string) => {
			for (const dir of [".git", ".impeccable", "apps/mobile/ios", "apps/web/src"]) await fs.mkdir(path.join(root, dir), { recursive: true });
			await fs.writeFile(path.join(root, ".impeccable/config.json"), JSON.stringify({ projectRoots: ["apps/mobile"], keep: true }));
			await fs.writeFile(path.join(root, "package.json"), '{"workspaces":["apps/*"]}');
			await fs.writeFile(path.join(root, "PRODUCT.md"), "# Product\n\n## Platform\nweb\n\n## Audience\nPeople\n");
			await fs.writeFile(path.join(root, "apps/mobile/ios/Podfile"), "platform :ios, '16.0'\n");
			await fs.writeFile(path.join(root, "apps/mobile/package.json"), '{}');
			await fs.writeFile(path.join(root, "apps/web/package.json"), '{"dependencies":{"react":"*"}}');
			await fs.writeFile(path.join(root, "apps/web/src/App.tsx"), "export const App = () => <main/>;");
			await fs.writeFile(path.join(root, "DESIGN.json"), '{"legacy":true}');
		};
		const rawRoot = path.join(temporary, "native"); const piRoot = path.join(temporary, "adapter");
		await fixture(rawRoot); await fixture(piRoot);
		const ordinary = complete(await native(rawRoot, ["doctor", "--json"]));
		const normalize = (text: string, root: string) => text.replaceAll(root, "<root>");
		const rawFixResult = await native(rawRoot, ["doctor", "--fix", "--json"]);
		const rawFix = complete(rawFixResult);
		const piFixResult = await adapter(piRoot, ["doctor", "--fix", "--json"]);
		const piFix = complete(piFixResult);
		expect(normalize(piFixResult.stdout, piRoot)).toBe(normalize(rawFixResult.stdout, rawRoot));
		expect(rawFix.workspaces).toEqual(ordinary.workspaces);
		expect(rawFix.workspaces.map((row: { path: string }) => row.path)).toEqual(["apps/mobile", "apps/web"]);
		const workspaceFindingIds = ["workspace-context-inherited", "workspace-platform-native-evidence"];
		for (const report of [ordinary, rawFix, piFix]) {
			expect(report.findings.map((finding: { id: string }) => finding.id)).toEqual(expect.arrayContaining(workspaceFindingIds));
			expect(report.workspaces.every((row: { productStatus: string }) => row.productStatus === "inherited")).toBe(true);
		}
		expect(rawFix.fixes.applied).toEqual(["Moved DESIGN.json to .impeccable/design.json."]);
		for (const root of [rawRoot, piRoot]) {
			expect(await fs.readFile(path.join(root, ".impeccable/design.json"), "utf8")).toBe('{"legacy":true}');
			await expect(fs.stat(path.join(root, "DESIGN.json"))).rejects.toMatchObject({ code: "ENOENT" });
		}
		expect(piFixResult.argv).toEqual(["doctor", "--fix", "--json"]);
		expect(piFixResult.integration).not.toHaveProperty("effectiveTarget");
		expect(piFixResult.integration).not.toHaveProperty("originalTarget");
		process.stdout.write(`Targetless doctor parity: ${JSON.stringify({ workspaces: rawFix.workspaces, retainedFindings: workspaceFindingIds, fixes: rawFix.fixes.applied })}\n`);

		// Explicit targets retain canonical dispatch, strict forms and last-target wins.
		const rawSelectedRoot = path.join(temporary, "native-selected"); const piSelectedRoot = path.join(temporary, "adapter-selected");
		await fixture(rawSelectedRoot); await fixture(piSelectedRoot);
		const rootConfig = await fs.readFile(path.join(piSelectedRoot, ".impeccable/config.json"), "utf8");
		const legacy = '{"selected":true}';
		for (const flags of [["--target", "web"], ["--target=web"], ["-t", "web"], ["--target", "missing", "-t", "web"]]) {
			const rawApp = path.join(rawSelectedRoot, "apps/web"); const piApp = path.join(piSelectedRoot, "apps/web");
			for (const app of [rawApp, piApp]) {
				await fs.writeFile(path.join(app, "DESIGN.json"), legacy);
				await fs.rm(path.join(app, ".impeccable/design.json"), { force: true });
			}
			const raw = await native(rawApp, ["doctor", "--fix", "--json", "--target", rawApp]);
			const adapted = await adapter(piSelectedRoot, ["doctor", "--fix", "--json", ...flags]);
			complete(raw); const report = complete(adapted);
			expect(normalize(adapted.stdout, piSelectedRoot)).toBe(normalize(raw.stdout, rawSelectedRoot));
			expect(adapted).toMatchObject({ cwd: piApp, argv: ["doctor", "--fix", "--json", "--target", piApp], integration: { originalTarget: "web", effectiveTarget: piApp } });
			expect(report.fixes.applied).toContain("Moved DESIGN.json to .impeccable/design.json.");
			expect(await fs.readFile(path.join(piApp, ".impeccable/design.json"), "utf8")).toBe(legacy);
			expect(await fs.readFile(path.join(piSelectedRoot, "DESIGN.json"), "utf8")).toBe('{"legacy":true}');
		}
		expect(await fs.readFile(path.join(piSelectedRoot, ".impeccable/config.json"), "utf8")).toBe(rootConfig);

		const snapshot = async (root: string): Promise<Record<string, string>> => {
			const files: Record<string, string> = {};
			const walk = async (dir: string) => {
				for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
					const file = path.join(dir, entry.name); const relative = path.relative(root, file);
					if (entry.isDirectory()) { files[`${relative}/`] = "directory"; await walk(file); }
					else files[relative] = sha256(await fs.readFile(file));
				}
			};
			await walk(root); return files;
		};
		const beforeInvalid = await snapshot(piSelectedRoot);
		for (const flags of [["--target", "missing.v2"], ["--target=missing.v2"], ["-t", "missing.v2"], ["--target", "web", "-t", "missing.v2"], ["--target"], ["--target="], ["-t"], ["--target", "--fix"]]) {
			const result = await adapter(piSelectedRoot, ["doctor", "--fix", "--json", ...flags]);
			expect(result).toMatchObject({ ok: false, integration: { engineRun: false, committed: [] } });
			expect(result.stderr).toMatch(/Unresolved target|requires a path/);
			expect(await snapshot(piSelectedRoot)).toEqual(beforeInvalid);
		}
		// Native observation: its unresolved dotted selector really does migrate the root.
		const rawInvalid = complete(await native(rawSelectedRoot, ["doctor", "--fix", "--json", "--target", "missing.v2"]));
		expect(rawInvalid.fixes.applied).toContain("Moved DESIGN.json to .impeccable/design.json.");
		expect(await fs.readFile(path.join(rawSelectedRoot, ".impeccable/design.json"), "utf8")).toBe('{"legacy":true}');
		process.stdout.write("Explicit doctor parity: four valid target forms migrated only the app; eight invalid forms refused dispatch with identical project snapshots; native dotted fallback migrated the root.\n");

		const bracketRoot = path.join(temporary, "bracket-repository");
		await fs.mkdir(path.join(bracketRoot, ".impeccable"), { recursive: true });
		await exec("git", ["init", "--quiet"], { cwd: bracketRoot, env });
		await fs.writeFile(path.join(bracketRoot, ".impeccable/config.json"), '{"projectRoots":["apps/*","!apps/web[1]"],"keep":{"unrelated":true}}');
		await fs.writeFile(path.join(bracketRoot, "PRODUCT.md"), "# Product\n\n## Platform\nweb\n");
		for (const name of ["web[1]", "web1"]) {
			const app = path.join(bracketRoot, "apps", name);
			await fs.mkdir(app, { recursive: true });
			await fs.writeFile(path.join(app, "package.json"), '{"dependencies":{"react":"*"}}');
		}
		const excludedApp = path.join(bracketRoot, "apps/web[1]"); const permittedApp = path.join(bracketRoot, "apps/web1");
		await exec("git", ["init", "--quiet"], { cwd: excludedApp, env });
		const bracketReport = complete(await native(bracketRoot, ["doctor", "--json"]));
		expect(bracketReport.workspaces.map((row: { path: string }) => row.path)).toEqual(["apps/web1"]);
		const context = await native(bracketRoot, ["context"]);
		expect(context).toMatchObject({ ok: true, stdoutTruncated: false });
		expect(context.stdout).toContain("apps/web1");
		expect(context.stdout).not.toContain("apps/web[1]");
		const beforeExcluded = await snapshot(bracketRoot);
		for (const argv of [["hooks", "on"], ["doctor", "--fix"], ["ignores", "add-file", "page.html"], ["pin", "layout"]]) {
			const result = await adapter(bracketRoot, [...argv, "--target", "web[1]"]);
			expect(result).toMatchObject({ ok: false, integration: { engineRun: false, committed: [] } });
			expect(result.stderr).toContain("Unresolved target");
			expect(await snapshot(bracketRoot)).toEqual(beforeExcluded);
		}
		const configsBefore = (await readConfigs(bracketRoot)).map((config) => config.text);
		const permitted = await adapter(bracketRoot, ["hooks", "on", "--target", "web1"]);
		expect(permitted, permitted.stderr).toMatchObject({ ok: true, integration: { root: permittedApp } });
		expect((await readConfigs(permittedApp))[0]!.value).toMatchObject({ hook: { enabled: true } });
		expect((await readConfigs(bracketRoot)).map((config) => config.text)).toEqual(configsBefore);
		// Existing direct paths have their own precedence and child-Git isolation.
		expect(await resolveProject(bracketRoot, "apps/web[1]")).toBe(excludedApp);
		await fs.mkdir(path.join(bracketRoot, "web[1]"));
		await fs.writeFile(path.join(bracketRoot, "web[1]/package.json"), '{}');
		expect(await resolveProject(bracketRoot, "web[1]")).toBe(path.join(bracketRoot, "web[1]"));
		process.stdout.write(`Literal exclusion parity: native doctor/context offered only ${bracketReport.workspaces[0].path}; adapter rejected web[1] before four management operations and enabled web1 without changing root config.\n`);
	} finally {
		vi.unstubAllEnvs();
		await fs.rm(temporary, { recursive: true, force: true });
	}
});
