import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runEngine } from "../src/engine.ts";
import { runOperation } from "../src/operations.ts";
import { readConfigs, resolveProject } from "../src/project.ts";
import { detectorFixture } from "./support/detector-fixture.ts";
import { isolateEngineEnvironment } from "./support/engine-environment.ts";

isolateEngineEnvironment();

it("validates mutating doctor before dispatch and forwards only canonical scope (protocol fixture)", async () => {
	const h = await detectorFixture();
	try {
		process.env.IMPECCABLE_BIN = h.binary;
		await h.config({ projectRoots: ["apps/*"], keep: true });
		const app = path.join(h.directory, "apps/web.v2");
		await fs.mkdir(path.join(app, "src"), { recursive: true });
		await fs.writeFile(path.join(app, "package.json"), '{}');
		const legacy = '{"legacy":"root"}';
		await fs.writeFile(path.join(h.directory, "DESIGN.json"), legacy);
		for (const flags of [["--target", "missing"], ["--target"], ["--target="], ["-t"], ["--target", "--fix"], ["--target", " "]]) {
			const result = await runOperation({ argv: ["doctor", "--fix", ...flags], cwd: h.directory }, h.api);
			expect(result).toMatchObject({ ok: false, integration: { engineRun: false, committed: [] } });
		}
		await expect(fs.readFile(path.join(h.directory, "doctor-calls.ndjson"))).rejects.toMatchObject({ code: "ENOENT" });
		for (const flags of [["--target", "web.v2"], ["--target=web.v2"], ["-t", "web.v2"], ["--target", path.join(h.directory, "web.v2")], ["--target=missing.v2", "-t", "web.v2"], ["--target", "apps/web.v2/src/new.tsx"]]) {
			await fs.writeFile(path.join(app, "DESIGN.json"), '{"legacy":"app"}');
			const result = await runOperation({ argv: ["doctor", "--json", "--fix", ...flags], cwd: h.directory }, h.api);
			expect(result, result.stderr).toMatchObject({ ok: true, cwd: app, argv: ["doctor", "--json", "--fix", "--target", app], integration: { engineRun: true, root: app, originalTarget: flags.at(-1)!.replace(/^--target=/, ""), effectiveTarget: app } });
			expect(JSON.parse(result.stdout)).toMatchObject({ cwd: app, selected: app, findings: [{ id: "product-missing" }], ruleRegistryAvailable: false });
			expect(await fs.readFile(path.join(app, ".impeccable/design.json"), "utf8")).toBe('{"legacy":"app"}');
			await expect(fs.stat(path.join(app, "DESIGN.json"))).rejects.toMatchObject({ code: "ENOENT" });
		}
		expect(await fs.readFile(path.join(h.directory, "DESIGN.json"), "utf8")).toBe(legacy);
		// Calibrate the double: raw dispatch reproduces the pinned missing-dotted
		// parent fallback and migration that adapter validation must prevent.
		const raw = await runEngine({ argv: ["doctor", "--fix", "--target", "missing.v2"], cwd: h.directory });
		expect(raw.ok).toBe(true);
		expect(await fs.readFile(path.join(h.directory, ".impeccable/design.json"), "utf8")).toBe(legacy);
	} finally { await h.close(); }
});

it("retains actual doctor schema/error output for reports and validated fixes", async () => {
	const h = await detectorFixture();
	try {
		await fs.writeFile(h.binary, `#!/usr/bin/env node
console.log(JSON.stringify({findings:[{id:'design-schema',severity:'error'}]}));
console.error('fixture schema diagnostic'); process.exit(3);
`);
		for (const argv of [["doctor", "--json", "--target=missing.v2"], ["context", "--target=missing.v2"], ["doctor", "--json", "--fix"]]) {
			const result = await runOperation({ argv, cwd: h.directory, binary: h.binary }, h.api);
			expect(result).toMatchObject({ ok: false, status: "error", exitCode: 3, integration: { engineRun: true } });
			expect(JSON.parse(result.stdout).findings).toEqual([{ id: "design-schema", severity: "error" }]);
			expect(result.stderr).toBe("fixture schema diagnostic\n");
		}
	} finally { await h.close(); }
});

it("retains a cancelled doctor's engine outcome after its fixture migration without claiming no changes", async () => {
	const h = await detectorFixture();
	const controller = new AbortController();
	try {
		await h.config({ fixtureDoctorDelay: 5000 });
		await fs.writeFile(path.join(h.directory, "DESIGN.json"), '{"legacy":true}');
		const operation = runOperation({ argv: ["doctor", "--fix"], cwd: h.directory, binary: h.binary, signal: controller.signal }, h.api);
		const migrated = path.join(h.directory, ".impeccable/design.json");
		const deadline = Date.now() + 3000;
		while (!await fs.stat(migrated).catch(() => undefined)) {
			if (Date.now() > deadline) throw new Error("Fixture migration did not start");
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		controller.abort();
		const result = await operation;
		expect(result).toMatchObject({ ok: false, status: "cancelled", binary: h.binary, argv: ["doctor", "--fix"], integration: { engineRun: true, root: h.directory } });
		expect(result.integration).not.toHaveProperty("effectiveTarget");
		expect(result.stderr).not.toContain("no managed files committed");
		expect(await fs.readFile(migrated, "utf8")).toBe('{"legacy":true}');
	} finally { controller.abort(); await h.close(); }
});

it.each(["explicit exclusion", "explicit boundary", "package exclusion", "permitted", "explicit precedence"])("checks declaring repository rules before child Git boundaries: %s", async (kind) => {
	const h = await detectorFixture();
	try {
		const nested = kind === "explicit boundary";
		const candidate = path.join(h.directory, nested ? "apps/web/nested.v2" : "apps/web.v2");
		await fs.mkdir(path.join(candidate, ".git"), { recursive: true });
		await fs.writeFile(path.join(candidate, "package.json"), '{}');
		const explicit = kind === "package exclusion" ? [] : ["apps/*", ...(kind === "explicit exclusion" ? ["!apps/web.v2"] : [])];
		await h.config({ projectRoots: explicit, keep: true });
		await fs.writeFile(path.join(h.directory, "package.json"), JSON.stringify({ workspaces: ["apps/**", ...(["package exclusion", "explicit precedence"].includes(kind) ? ["!apps/web.v2"] : [])] }));
		const allowed = ["permitted", "explicit precedence"].includes(kind);
		const before = (await readConfigs(h.directory)).map((config) => config.text);
		for (const argv of [["hooks", "on"], ["ignores", "add-file", "page.html"], ["doctor", "--fix"], ["pin", "layout"]]) {
			const result = await runOperation({ argv: [...argv, "--target", path.basename(candidate)], cwd: h.directory, binary: h.binary }, h.api);
			expect(result, result.stderr).toMatchObject({ ok: allowed, integration: { ...(allowed ? { root: candidate } : { engineRun: false, committed: [] }) } });
			if (!allowed) expect(result.stderr).toContain("Unresolved target");
		}
		if (!allowed) {
			await expect(fs.stat(path.join(candidate, ".impeccable"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(path.join(h.directory, "doctor-calls.ndjson"))).rejects.toMatchObject({ code: "ENOENT" });
		}
		expect((await readConfigs(h.directory)).map((config) => config.text)).toEqual(before);
		// Explicit existing paths retain actual child-Git isolation, separately
		// from permission to discover that child using the declaring root.
		expect(await resolveProject(h.directory, candidate)).toBe(candidate);
	} finally { await h.close(); }
});

it("uses path segments for dot-prefixed boundaries and preserves actual parent/source targets", async () => {
	const h = await detectorFixture();
	try {
		const repository = path.join(h.directory, "repository");
		const app = path.join(repository, "apps/..web.v2");
		const source = path.join(app, "src");
		await fs.mkdir(source, { recursive: true });
		await fs.mkdir(path.join(repository, ".git"));
		await fs.writeFile(path.join(repository, "package.json"), '{"workspaces":["apps/*"]}');
		await fs.writeFile(path.join(app, "package.json"), '{}');
		expect(await resolveProject(repository, "apps/..web.v2/src/new.tsx")).toBe(app);
		expect(await resolveProject(source, "../new.tsx")).toBe(app);
		expect(await resolveProject(source, "..")).toBe(app);
		await fs.mkdir(path.join(repository, ".impeccable"));
		await fs.writeFile(path.join(repository, ".impeccable/config.json"), '{"projectRoots":["apps/..web.v2"]}');
		expect(await resolveProject(repository, "..web.v2")).toBe(app);
	} finally { await h.close(); }
});

it("repins an owned prompt after real symlink discovery/reload while protecting competing commands", async () => {
	const writer = fileURLToPath(new URL("../../writer/prompts/polish.md", import.meta.url));
	const h = await detectorFixture((pi) => { pi.registerCommand("layout", { description: "Competing real extension command", handler: async () => {} }); }, [writer], { cwd: "project", cwdAlias: "project alias", promptDefaults: true });
	try {
		const root = path.join(h.directory, "project");
		const alias = path.join(h.directory, "project alias");
		await fs.writeFile(path.join(root, "package.json"), '{}');
		const execute = (argv: string[]) => runOperation({ argv, cwd: alias }, h.api, alias);
		expect((await execute(["pin", "craft"])).ok).toBe(true);
		const file = path.join(root, ".pi/prompts/craft.md");
		await h.session.reload();
		expect(h.api.getCommands().find((command) => command.name === "craft")).toMatchObject({ source: "prompt", sourceInfo: { path: path.join(alias, ".pi/prompts/craft.md") } });
		expect((await execute(["pin", "craft"])).ok).toBe(true);
		const owned = await fs.readFile(file, "utf8");
		// Matching owned content and filename elsewhere do not establish identity.
		const competing = path.join(h.directory, "competing/prompts/craft.md");
		await fs.mkdir(path.dirname(competing), { recursive: true });
		await fs.writeFile(competing, owned);
		const discovered = h.api.getCommands().find((command) => command.name === "craft")!;
		for (const candidate of [
			{ ...discovered, sourceInfo: { ...discovered.sourceInfo, path: competing } },
			{ ...discovered, source: "extension" as const },
			{ ...discovered, sourceInfo: { ...discovered.sourceInfo, path: path.join(h.directory, "missing/craft.md") } },
		]) {
			const result = await runOperation({ argv: ["pin", "craft"], cwd: alias }, { getCommands: () => [candidate] }, alias);
			expect(result.stderr).toContain("already belongs");
			expect(await fs.readFile(file, "utf8")).toBe(owned);
		}
		expect((await execute(["pin", "layout"])).stderr).toContain("already belongs to extension");
		expect((await execute(["pin", "polish"])).stderr).toContain("already belongs to prompt");
		const writerBefore = await fs.readFile(writer, "utf8");
		expect((await execute(["unpin", "craft"])).ok).toBe(true);
		await h.session.reload();
		await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(competing, "utf8")).toBe(owned);
		expect(await fs.readFile(writer, "utf8")).toBe(writerBefore);
		expect(h.api.getCommands().some((command) => command.name === "polish")).toBe(true);
		expect(h.errors).toEqual([]);
	} finally { await h.close(); }
});
