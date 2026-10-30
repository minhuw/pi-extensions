import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { runOperation } from "../src/operations.ts";
import { hookStatus, readConfigs, resolveProject } from "../src/project.ts";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

vi.mock("node:fs/promises", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));
isolateEngineEnvironment();
const exec = promisify(execFile);

it.each(["package", "projectRoots", "pnpm-block", "pnpm-flow", "lerna", "fallback"])("resolves unique bare app targets before management scope using %s discovery", async (discovery) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		const app = path.join(h.directory, "apps/web"); const sibling = path.join(h.directory, "apps/sibling");
		await fs.mkdir(path.join(app, "src"), { recursive: true }); await fs.mkdir(sibling);
		await fs.writeFile(path.join(app, "package.json"), '{}');
		await h.config({ keepRoot: 1, ...(discovery === "projectRoots" ? { projectRoots: ["./apps/*/", "!apps/sibling"] } : {}) });
		if (discovery === "package") await fs.writeFile(path.join(h.directory, "package.json"), '{"workspaces":{"packages":["apps/*"]}}');
		if (discovery === "pnpm-block") await fs.writeFile(path.join(h.directory, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*' # keep\n  - '!apps/sibling'\nother: true\n");
		if (discovery === "pnpm-flow") await fs.writeFile(path.join(h.directory, "pnpm-workspace.yaml"), "packages: ['apps/*', '!apps/sibling'] # keep\n");
		if (discovery === "lerna") await fs.writeFile(path.join(h.directory, "lerna.json"), '{"packages":["apps/*","!apps/sibling"]}');
		if (discovery === "fallback") await fs.writeFile(path.join(h.directory, "turbo.json"), '{}');
		const before = (await readConfigs(h.directory)).map((config) => config.text);
		for (const selector of [["--target", "web"], ["--target=web"], ["-t", "web"], ["--target", path.join(h.directory, "web")], ["--target", "missing", "-t", "web"]]) {
			const result = await runOperation({ argv: ["hooks", "on", ...selector], cwd: h.directory }, h.api);
			expect(result, result.stderr).toMatchObject({ ok: true, integration: { root: app } });
		}
		const ignore = await runOperation({ argv: ["hooks", "ignore-file", "src/card.tsx", "--target", "web"], cwd: h.directory }, h.api);
		expect(ignore, ignore.stderr).toMatchObject({ ok: true, integration: { root: app } });
		expect((await readConfigs(app))[0]!.value).toMatchObject({ detector: { ignoreFiles: ["src/card.tsx"] } });
		expect((await hookStatus(app)).enabled).toBe(true);
		expect((await readConfigs(h.directory)).map((config) => config.text)).toEqual(before);
		expect(await fs.readdir(sibling)).toEqual([]);
		// Existing paths beat workspace basenames, and existing/missing source
		// leaves retain their focused app boundary.
		const direct = path.join(h.directory, "web"); await fs.mkdir(direct); await fs.writeFile(path.join(direct, "package.json"), '{}');
		expect(await resolveProject(h.directory, "web")).toBe(direct);
		await fs.writeFile(path.join(app, "src/card.tsx"), "export const card = 1;");
		expect(await resolveProject(h.directory, "apps/web/src/card.tsx")).toBe(app);
		expect(await resolveProject(h.directory, "apps/web/src/new.tsx")).toBe(app);
	} finally { await h.close(); }
});

it.each([["--target", "web"], ["-t", "web"], ["--target=web"], ["--target", "missing"], ["--target", "apps/missing"], ["--target"], ["--target="], ["-t"], ["--target", "--local"], ["--target", " "], ["--target", "web", "-t"]])("refuses ambiguous or missing management selectors before any mutation: %j", async (...selector) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ projectRoots: ["apps/*", "packages/*"], keep: 1 });
		for (const dir of ["apps/web", "packages/web"]) await fs.mkdir(path.join(h.directory, dir), { recursive: true });
		const before = (await readConfigs(h.directory)).map((config) => config.text);
		for (const argv of [["hooks", "on"], ["ignores", "add-file", "page.html"]]) {
			const result = await runOperation({ argv: [...argv, ...selector], cwd: h.directory }, h.api);
			expect(result).toMatchObject({ ok: false, status: "error", integration: { committed: [] } });
			expect(result.stderr).toMatch(/Ambiguous|Unresolved|requires a path/);
		}
		expect((await readConfigs(h.directory)).map((config) => config.text)).toEqual(before);
		for (const dir of ["apps/web", "packages/web"]) expect(await fs.readdir(path.join(h.directory, dir))).toEqual([]);
	} finally { await h.close(); }
});

it("excludes workspace candidates and retains nested explicit boundaries without falling back on bare selectors", async () => {
	const h = await detectorFixture();
	try {
		await h.config({ projectRoots: ["apps/*", "!apps/excluded"] });
		await fs.writeFile(path.join(h.directory, "package.json"), '{"workspaces":["apps/**"]}');
		await fs.mkdir(path.join(h.directory, "apps/excluded"), { recursive: true });
		await fs.mkdir(path.join(h.directory, "apps/web/nested"), { recursive: true });
		await fs.writeFile(path.join(h.directory, "apps/web/nested/package.json"), '{}');
		await expect(resolveProject(h.directory, "excluded")).rejects.toThrow("Unresolved");
		await expect(resolveProject(h.directory, "nested")).rejects.toThrow("Unresolved");
		expect(await resolveProject(h.directory, "apps/web/nested/source.tsx")).toBe(path.join(h.directory, "apps/web"));
	} finally { await h.close(); }
});

it.each([true, false])("resolves recursive workspaces past nested design/config markers with package boundary=%s", async (packageBoundary) => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		const app = path.join(h.directory, "apps/web"); const source = path.join(app, "src");
		await fs.mkdir(path.join(source, ".impeccable"), { recursive: true });
		await fs.writeFile(path.join(h.directory, "package.json"), '{"workspaces":["apps/**"]}');
		if (packageBoundary) await fs.writeFile(path.join(app, "package.json"), '{}');
		await fs.writeFile(path.join(source, "DESIGN.md"), "Source-local design guidance");
		await fs.writeFile(path.join(source, ".impeccable/config.json"), '{"keepSource":true,"hook":{"enabled":false}}');
		const sourceConfig = await fs.readFile(path.join(source, ".impeccable/config.json"), "utf8");
		for (const target of ["apps/web/src/new.tsx", "apps/web/src/DESIGN.md", "apps/web/src"]) expect(await resolveProject(h.directory, target)).toBe(app);
		const on = await runOperation({ argv: ["hooks", "on", "--target", "apps/web/src/new.tsx"], cwd: h.directory }, h.api);
		expect(on).toMatchObject({ ok: true, integration: { root: app } });
		const ignore = await runOperation({ argv: ["ignores", "add-file", "other.tsx", "--target", "web"], cwd: h.directory }, h.api);
		expect(ignore).toMatchObject({ ok: true, integration: { root: app } });
		expect((await readConfigs(app))[0]!.value).toMatchObject({ hook: { enabled: true }, detector: { ignoreFiles: ["other.tsx"] } });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "apps/web/src/new.tsx", content: "export const Card = () => <main/>;" })]), fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed")]);
		await h.session.prompt("Create the UI source");
		const calls = (await fs.readFile(path.join(app, "calls.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(calls.map((call) => call.event.hook_event_name)).toEqual(["PostToolUse", "Stop"]);
		expect(calls.every((call) => call.cwd === app)).toBe(true);
		expect(await fs.readFile(path.join(source, ".impeccable/config.json"), "utf8")).toBe(sourceConfig);
		expect((await readConfigs(h.directory))[0]!.text).toBeUndefined();
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it("keeps genuine context/doctor reporting and original target flags when Pi metadata cannot resolve a selection", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		const context = await runOperation({ argv: ["context", "--target", "missing"], cwd: h.directory }, h.api);
		expect(JSON.parse(context.stdout)).toMatchObject({ args: ["context", "--target", "missing"] });
		expect(context.integration).toMatchObject({ engineRun: true, hooks: { available: false } });
		const doctor = await runOperation({ argv: ["doctor", "--json", "--target=missing"], cwd: h.directory }, h.api);
		expect(JSON.parse(doctor.stdout)).toMatchObject({ findings: [{ id: "product-missing" }] });
		expect(doctor.integration).toMatchObject({ engineRun: true, hooks: { available: false } });
	} finally { await h.close(); }
});

it("keeps native creation of extensionless non-UI files outside management selector validation", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ hook: { enabled: true } });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "new/nested/NOTICE", content: "User text" })]), fauxAssistantMessage("Done")]);
		await h.session.prompt("Create a non-UI file");
		expect(h.feedback()).toEqual([]);
		expect(await h.calls()).toEqual([]);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});

it.each([false, true])("excludes hook consent before creation with separate Git metadata=%s", async (separate) => {
	const h = await detectorFixture();
	try {
		await exec("git", separate ? ["init", "--separate-git-dir", path.join(h.directory, "git metadata")] : ["init"], { cwd: h.directory });
		const app = path.join(h.directory, "apps/web [one]");
		await fs.mkdir(app, { recursive: true });
		await fs.writeFile(path.join(app, "package.json"), '{}');
		const file = path.join(app, ".impeccable/config.local.json");
		const exclude = path.resolve(h.directory, (await exec("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: h.directory })).stdout.trim());
		const original = await fs.readFile(exclude, "utf8");
		const rename = fs.rename; let observed = false;
		vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
			if (args[1] === file) {
				expect((await exec("git", ["check-ignore", "--no-index", file], { cwd: h.directory })).stdout.trim()).toBe(file);
				observed = true;
			}
			return rename(...args);
		});
		const result = await runOperation({ argv: ["hooks", "on", "--target", app], cwd: h.directory }, h.api);
		expect(result, result.stderr).toMatchObject({ ok: true, integration: { committed: [exclude, path.join(app, ".impeccable/config.json"), file] } });
		expect(observed).toBe(true);
		expect(await fs.readFile(exclude, "utf8")).toContain(original);
		expect((await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: h.directory })).stdout).not.toContain("config.local.json");
		expect(await h.calls()).toEqual([]);
	} finally { vi.restoreAllMocks(); await h.close(); }
});

it("keeps active detector state out of Git status and removes only its owned external directory", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await exec("git", ["init"], { cwd: h.directory });
		await h.config({ hook: { enabled: true } });
		h.faux.setResponses([fauxAssistantMessage([fauxToolCall("write", { path: "page.html", content: "changed" })]), fauxAssistantMessage("Done"), fauxAssistantMessage("Assessed")]);
		await h.session.prompt("Edit with an active detector");
		const temporary = path.dirname((await h.calls())[0].env.cache);
		expect(path.relative(h.directory, temporary).startsWith("..")).toBe(true);
		expect(await fs.readdir(temporary)).toContain("audit.ndjson");
		const unrelated = `${temporary}-unrelated`;
		await fs.mkdir(unrelated);
		try {
			const status = (await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: h.directory })).stdout;
			expect(status).not.toMatch(/pi-hook-|pi-impeccable-hook-|audit\.ndjson|claims|sessions|hook\.cache/);
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			await expect(fs.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
			expect((await fs.stat(unrelated)).isDirectory()).toBe(true);
		} finally { await fs.rm(unrelated, { recursive: true }); }
	} finally { await h.close(); }
});

it("keeps in-progress ignore validation outside Git status with a deliberate Git boundary and owned cleanup", async () => {
	const h = await detectorFixture();
	let temporary: string | undefined;
	let observed = false;
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await exec("git", ["init"], { cwd: h.directory });
		await h.config({ keep: 1 });
		const before = (await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: h.directory })).stdout;
		const mkdir = fs.mkdir;
		vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
			const result = await mkdir(...args);
			if (String(args[0]).includes("/pi-impeccable-admin-") && path.basename(String(args[0])) === ".git") {
				temporary = path.dirname(String(args[0]));
				expect(path.relative(h.directory, temporary).startsWith("..")).toBe(true);
				expect((await fs.stat(path.join(temporary, ".git"))).isDirectory()).toBe(true);
				expect((await exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: h.directory })).stdout).toBe(before);
				observed = true;
			}
			return result;
		});
		const result = await runOperation({ argv: ["ignores", "add-file", "page.html"], cwd: h.directory }, h.api);
		expect(result, result.stderr).toMatchObject({ ok: true });
		expect(observed).toBe(true);
		await expect(fs.stat(temporary!)).rejects.toMatchObject({ code: "ENOENT" });
	} finally { vi.restoreAllMocks(); await h.close(); }
});
