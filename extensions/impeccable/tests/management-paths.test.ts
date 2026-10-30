import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { runOperation } from "../src/operations.ts";
import { readConfigs, resolveProject } from "../src/project.ts";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
isolateEngineEnvironment();
const exec = promisify(execFile);
const configTexts = async (roots: string[]) => Promise.all(roots.map(async (root) => (await readConfigs(root)).map((config) => config.text)));

it.each(["missing", "file", "inaccessible", "session"])("refuses %s management cwd before scope discovery, staging or mutation", async (kind) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		const repo = path.join(h.directory, "repository");
		const app = path.join(repo, "apps/web"); const sibling = path.join(repo, "apps/sibling");
		await fs.mkdir(app, { recursive: true }); await fs.mkdir(sibling);
		await exec("git", ["init"], { cwd: repo });
		await h.config({ ancestor: true });
		const roots = [h.directory, repo, app, sibling];
		for (const root of roots) {
			await fs.mkdir(path.join(root, ".impeccable"), { recursive: true });
			await fs.writeFile(path.join(root, ".impeccable/config.json"), '{"keep":"shared","projectRoots":["apps/*"]}');
			await fs.writeFile(path.join(root, ".impeccable/config.local.json"), '{"keep":"local"}');
		}
		const invalid = path.join(repo, kind === "session" ? "missing-session-cwd" : `${kind}-management-cwd`);
		if (kind === "file") await fs.writeFile(invalid, "not a directory");
		if (kind === "inaccessible") {
			await fs.mkdir(invalid);
			const access = fs.access;
			vi.spyOn(fs, "access").mockImplementation(async (...args) => {
				if (args[0] === invalid) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
				return access(...args);
			});
		}
		const before = await configTexts(roots);
		const exclude = path.join(repo, ".git/info/exclude"); const excludeBefore = await fs.readFile(exclude, "utf8");
		const mkdir = vi.spyOn(fs, "mkdir"); const stage = vi.spyOn(fs, "mkdtemp"); const open = vi.spyOn(fs, "open");
		for (const argv of [["hooks", "on"], ["ignores", "add-file", "page.html", "--local"], ["doctor", "--fix"], ["pin", "layout"]]) {
			const result = await runOperation({ argv: [...argv, "--target", sibling], cwd: kind === "session" ? repo : invalid }, h.api, kind === "session" ? invalid : repo);
			expect(result).toMatchObject({ ok: false, status: "error", integration: { engineRun: false, committed: [], partial: false } });
			expect(result.stderr).toContain("existing accessible directory");
		}
		expect(mkdir).not.toHaveBeenCalled(); expect(stage).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
		expect(await configTexts(roots)).toEqual(before);
		expect(await fs.readFile(exclude, "utf8")).toBe(excludeBefore);
		if (kind !== "session") {
			await expect(resolveProject(invalid)).rejects.toThrow("existing accessible directory");
			await expect(resolveProject(invalid, path.join(app, "new.tsx"), { sourcePath: true })).rejects.toThrow("existing accessible directory");
		}
	} finally { vi.restoreAllMocks(); await h.close(); }
});

it.each(["projectRoots", "workspaces"])("resolves unique existing dotted workspace aliases and explicit source leaves with %s", async (discovery) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await exec("git", ["init"], { cwd: h.directory });
		await h.config({ keep: true, ...(discovery === "projectRoots" ? { projectRoots: ["apps/*"] } : {}) });
		if (discovery === "workspaces") await fs.writeFile(path.join(h.directory, "package.json"), '{"workspaces":["apps/*"]}');
		const app = path.join(h.directory, "apps/web.v2");
		await fs.mkdir(path.join(app, "src"), { recursive: true });
		await fs.writeFile(path.join(app, "package.json"), '{}');
		await fs.writeFile(path.join(app, "src/existing.tsx"), "export const Card = 1;");
		const before = await configTexts([h.directory]);
		for (const flags of [["--target", "web.v2"], ["--target=web.v2"], ["-t", "web.v2"], ["--target", path.join(h.directory, "web.v2")], ["--target=missing-workspace.v2", "-t", "web.v2"]]) {
			const result = await runOperation({ argv: ["hooks", "on", ...flags], cwd: h.directory }, h.api);
			expect(result, result.stderr).toMatchObject({ ok: true, integration: { root: app } });
		}
		for (const target of ["apps/web.v2/src/new.tsx", "apps/web.v2/src/existing.tsx"]) {
			const result = await runOperation({ argv: ["ignores", "add-file", "src/other.tsx", "--target", target], cwd: h.directory }, h.api);
			expect(result, result.stderr).toMatchObject({ ok: true, integration: { root: app } });
		}
		expect(await configTexts([h.directory])).toEqual(before);
		expect((await readConfigs(app))[0]!.value).toMatchObject({ hook: { enabled: true }, detector: { ignoreFiles: ["src/other.tsx", "src/other.tsx"] } });
		// An existing direct path still takes precedence over the workspace alias.
		const direct = path.join(h.directory, "web.v2"); await fs.mkdir(direct); await fs.writeFile(path.join(direct, "package.json"), '{}');
		expect(await resolveProject(h.directory, "web.v2")).toBe(direct);
	} finally { await h.close(); }
});

it.each(["excluded", "unknown", "leading-dot", "dot-basename", "two-dots", "two-dot-basename", "three-dots", "ambiguous", "missing-app", "missing-parent"])("refuses %s dotted selectors in every target flag form without root settings or suppressions", async (kind) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await exec("git", ["init"], { cwd: h.directory });
		await h.config({ keep: true, projectRoots: ["apps/*", "packages/*", ...(kind === "excluded" ? ["!apps/web.v2"] : [])] });
		await fs.writeFile(path.join(h.directory, "package.json"), '{"workspaces":["apps/**","packages/*"]}');
		const app = path.join(h.directory, "apps/web.v2"); const sibling = path.join(h.directory, "packages/web.v2");
		await fs.mkdir(path.join(app, "src"), { recursive: true });
		if (kind === "ambiguous") await fs.mkdir(sibling, { recursive: true });
		const name = kind === "unknown" ? "missing-workspace.v2" : kind === "leading-dot" ? ".missing-workspace.v2" : kind === "dot-basename" ? ".missing" : kind === "two-dots" ? "..missing-workspace.v2" : kind === "two-dot-basename" ? "..missing" : kind === "three-dots" ? "...missing-workspace.v2" : kind === "missing-app" ? "apps/missing.v2" : kind === "missing-parent" ? "apps/unknown/src/new.tsx" : "web.v2";
		const legacy = path.join(h.directory, "DESIGN.json");
		await fs.writeFile(legacy, '{"legacy":"must remain untouched"}');
		const before = await configTexts([h.directory, app, sibling]);
		const exclude = path.join(h.directory, ".git/info/exclude"); const excludeBefore = await fs.readFile(exclude, "utf8");
		const mkdir = vi.spyOn(fs, "mkdir"); const stage = vi.spyOn(fs, "mkdtemp"); const open = vi.spyOn(fs, "open");
		for (const flags of [["--target", name], [`--target=${name}`], ["-t", name], ["--target", path.join(h.directory, name)], ["--target", "apps/web.v2", "-t", name]]) {
			for (const argv of [["hooks", "on"], ["ignores", "add-file", "page.html", "--local"], ["doctor", "--fix"], ["pin", "layout"], ["unpin", "layout"]]) {
				const result = await runOperation({ argv: [...argv, ...flags], cwd: h.directory }, h.api);
				expect(result).toMatchObject({ ok: false, status: "error", integration: { engineRun: false, committed: [] } });
				expect(result.stderr).toMatch(/Ambiguous|Unresolved/);
				expect(result.stderr).toMatch(/existing (explicit|app\/parent) path/);
			}
		}
		expect(await fs.readFile(legacy, "utf8")).toBe('{"legacy":"must remain untouched"}');
		await expect(fs.stat(path.join(h.directory, ".impeccable/design.json"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(path.join(h.directory, "doctor-calls.ndjson"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(mkdir).not.toHaveBeenCalled(); expect(stage).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
		expect(await configTexts([h.directory, app, sibling])).toEqual(before);
		expect(await fs.readFile(exclude, "utf8")).toBe(excludeBefore);
	} finally { vi.restoreAllMocks(); await h.close(); }
});

it.each(["project", "app"].flatMap((scope) => [false, true].map((existing) => ({ scope, existing }))))("establishes real Git exclusion before local commit through an existing $scope symlink (existing config=$existing)", async ({ scope, existing }) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		const repository = path.join(h.directory, "repository");
		const root = scope === "project" ? repository : path.join(repository, "apps/web [v2]");
		await fs.mkdir(root, { recursive: true });
		await exec("git", ["init"], { cwd: repository });
		await fs.writeFile(path.join(repository, "package.json"), '{"workspaces":["apps/*"]}');
		await fs.writeFile(path.join(root, "package.json"), '{}');
		const alias = path.join(h.directory, "real project alias"); await fs.symlink(root, alias);
		const local = path.join(root, ".impeccable/config.local.json");
		if (existing) {
			await fs.mkdir(path.dirname(local));
			await fs.writeFile(local, '{"keepLocal":true}');
			await fs.writeFile(path.join(root, ".impeccable/config.json"), '{"keepShared":true}');
		}
		const exclude = path.join(repository, ".git/info/exclude");
		await fs.appendFile(exclude, "\n# unrelated user exclusion\nunrelated/\n");
		const original = await fs.readFile(exclude, "utf8");
		const rename = fs.rename; let observed = false;
		vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
			if (args[1] === local) {
				expect((await exec("git", ["check-ignore", "--no-index", local], { cwd: repository })).stdout.trim()).toBe(local);
				expect(await fs.readFile(exclude, "utf8")).toContain(original);
				if (existing) expect(await fs.readFile(local, "utf8")).toBe('{"keepLocal":true}');
				else await expect(fs.stat(local)).rejects.toMatchObject({ code: "ENOENT" });
				observed = true;
			}
			return rename(...args);
		});
		const argv = scope === "project" ? ["hooks", "on"] : ["ignores", "add-file", "page.html", "--local"];
		const result = await runOperation({ argv, cwd: alias }, h.api, alias);
		expect(result, result.stderr).toMatchObject({ ok: true, integration: { root, committed: expect.arrayContaining([exclude, local]) } });
		expect(observed).toBe(true);
		const text = await fs.readFile(exclude, "utf8");
		expect(text.startsWith(original)).toBe(true); expect(text).not.toMatch(/\.\.\/|real project alias/);
		expect(text).toContain(scope === "project" ? "/.impeccable/config.local.json\n" : "/apps/web \\[v2\\]/.impeccable/config.local.json\n");
		expect((await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repository })).stdout).not.toContain("config.local.json");
		if (existing) expect((await readConfigs(root))[1]!.value).toMatchObject({ keepLocal: true });
	} finally { vi.restoreAllMocks(); await h.close(); }
});

it.each(["directory", "file"])("refuses a config %s symlink escaping the physical repository before exclude/config commits", async (kind) => {
	const h = await detectorFixture();
	try {
		const repository = path.join(h.directory, "repository"); const outside = path.join(h.directory, "outside");
		await fs.mkdir(repository); await fs.mkdir(outside);
		await exec("git", ["init"], { cwd: repository });
		const local = path.join(outside, "config.local.json"); await fs.writeFile(local, '{"keep":true}');
		if (kind === "directory") await fs.symlink(outside, path.join(repository, ".impeccable"));
		else {
			await fs.mkdir(path.join(repository, ".impeccable"));
			await fs.symlink(local, path.join(repository, ".impeccable/config.local.json"));
		}
		const exclude = path.join(repository, ".git/info/exclude"); const before = await fs.readFile(exclude, "utf8");
		const configs = await configTexts([repository]);
		const result = await runOperation({ argv: ["hooks", "on"], cwd: repository }, h.api);
		expect(result).toMatchObject({ ok: false, integration: { committed: [], partial: false } });
		expect(result.stderr).toContain("cannot establish local-config privacy inside repository");
		expect(await fs.readFile(exclude, "utf8")).toBe(before);
		expect(await fs.readFile(local, "utf8")).toBe('{"keep":true}');
		expect(await configTexts([repository])).toEqual(configs);
	} finally { await h.close(); }
});

it("discloses tracked local-config privacy limits without changing the isolated index or managed files", async () => {
	const h = await detectorFixture();
	try {
		await exec("git", ["init"], { cwd: h.directory });
		await h.config({ keep: true });
		const local = path.join(h.directory, ".impeccable/config.local.json"); await fs.writeFile(local, '{"keepLocal":true}');
		await exec("git", ["add", ".impeccable/config.local.json"], { cwd: h.directory });
		const index = path.join(h.directory, ".git/index"); const indexBefore = await fs.readFile(index);
		const exclude = path.join(h.directory, ".git/info/exclude"); const excludeBefore = await fs.readFile(exclude, "utf8");
		const before = await configTexts([h.directory]);
		const result = await runOperation({ argv: ["hooks", "on"], cwd: h.directory }, h.api);
		expect(result).toMatchObject({ ok: false, integration: { committed: [], partial: false } });
		expect(result.stderr).toContain("already tracked by Git; an exclusion cannot make it private");
		expect(await fs.readFile(index)).toEqual(indexBefore);
		expect(await fs.readFile(exclude, "utf8")).toBe(excludeBefore);
		expect(await configTexts([h.directory])).toEqual(before);
	} finally { await h.close(); }
});

it("refuses local commits when a higher-priority Git rule negates the exclusion, reporting the metadata commit", async () => {
	const h = await detectorFixture();
	try {
		await exec("git", ["init"], { cwd: h.directory });
		await h.config({ keep: true });
		await fs.writeFile(path.join(h.directory, ".gitignore"), "!/.impeccable/config.local.json\n");
		const before = await configTexts([h.directory]);
		const exclude = path.join(h.directory, ".git/info/exclude");
		const result = await runOperation({ argv: ["hooks", "on"], cwd: h.directory }, h.api);
		expect(result).toMatchObject({ ok: false, integration: { committed: [exclude], partial: true } });
		expect(result.stderr).toContain("Git local-config exclusion could not be established");
		expect(await configTexts([h.directory])).toEqual(before);
	} finally { await h.close(); }
});
