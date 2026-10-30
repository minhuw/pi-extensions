import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { EngineRunResult } from "../../src/engine.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const harness = fileURLToPath(new URL("./", import.meta.url));
const extensionPath = "extensions/impeccable";

async function walk(dir: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) files.push(...(await walk(path.join(dir, entry.name))).map((name) => `${entry.name}/${name}`));
		else files.push(entry.name);
	}
	return files.sort();
}

function digest(bytes: Uint8Array, algorithm = "sha256"): string {
	return createHash(algorithm).update(bytes).digest("hex");
}

// Scope binary/image restrictions to Impeccable; other collection resources are legitimate.
function nativeOrGeneratedBytes(bytes: Buffer): boolean {
	// Detect renamed native executables as well as the path/extension checks below.
	const magic = bytes.subarray(0, 4).toString("hex");
	return ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(magic)
		|| bytes.subarray(0, 2).toString() === "MZ"
		|| bytes.subarray(0, 16).toString() === "SQLite format 3\0";
}

function forbiddenEntry(entry: string): boolean {
	if (/(^|\/)(node_modules|\.impeccable|\.cache|\.npm|\.env|test-results|playwright-report|coverage|blob-report)(\/|$)/i.test(entry)) return true;
	if (/(^|\/)(auth|credentials|config\.local)\.json$|(^|\/)\.env\..+$/i.test(entry)) return true;
	if (!entry.startsWith(`${extensionPath}/`)) return false;
	return /(^|\/)(chromium[^/]*|chrome[^/]*|firefox[^/]*|webkit[^/]*|ms-playwright|audit|cache|previews?|screenshots?|artifacts|dist|build|\.vitest)(\/|$)/i.test(entry)
		|| /\.(exe|dll|so|dylib|node|png|jpe?g|webp|webm|zip|tgz|db|sqlite3?|log|tsbuildinfo)$/i.test(entry)
		|| /(^|\/)impeccable-(darwin|linux|windows)-/.test(entry);
}

it("checks an actual npm tarball, guarded extracted activation, and offline executable relocation", async () => {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi impeccable package spaces "));
	try {
		const temp = await realpath(temporary);
		const { stdout } = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], {
			cwd: root, maxBuffer: 20 * 1024 * 1024, timeout: 90_000,
			env: { ...process.env, npm_config_cache: path.join(temp, "npm cache"), npm_config_userconfig: path.join(temp, "no user npmrc"), npm_config_offline: "true" },
		});
		const packs = JSON.parse(stdout) as { filename: string; integrity: string; shasum: string; files: { path: string }[] }[];
		expect(packs).toHaveLength(1);
		const packed = packs[0];
		expect(packed.filename).toBe("pi-extensions-0.2.0.tgz");
		const tarball = await readFile(path.join(temp, packed.filename));
		expect(packed.integrity).toBe(`sha512-${createHash("sha512").update(tarball).digest("base64")}`);
		expect(packed.shasum).toBe(digest(tarball, "sha1"));
		const entries = packed.files.map((file) => file.path).sort();
		expect(entries.filter(forbiddenEntry)).toEqual([]);
		await exec("tar", ["-xzf", path.join(temp, packed.filename), "-C", temp]);
		const installed = path.join(temp, "package");
		const ext = path.join(installed, extensionPath);
		const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
		const sourceManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
		for (const key of ["pi", "engines", "peerDependencies"]) expect(installedManifest[key]).toEqual(sourceManifest[key]);
		const sourceFiles = await walk(path.join(root, extensionPath));
		expect(await walk(ext)).toEqual(sourceFiles);
		for (const relative of sourceFiles) {
			expect(entries, `missing ${relative}`).toContain(`${extensionPath}/${relative}`);
			const bytes = await readFile(path.join(ext, relative));
			expect(nativeOrGeneratedBytes(bytes), `bundled native/runtime data: ${relative}`).toBe(false);
			expect(bytes, `changed ${relative}`).toEqual(await readFile(path.join(root, extensionPath, relative)));
		}
		for (const required of ["index.ts", "src/resources.ts", "src/engine.ts", "LICENSE", "NOTICE.md", "upstream.json", "LOCAL-PATCHES.md", "README.md", "scripts/transform.mjs", "skills/impeccable/SKILL.md"]) {
			expect(sourceFiles).toContain(required);
		}
		// Verify the packed snapshot's own manifest, including complete canonical roles.
		const vendor = path.join(ext, "vendor/impeccable-4.8.0");
		const lines = (await readFile(path.join(vendor, "MANIFEST.sha256"), "utf8")).trim().split("\n");
		const vendorFiles: string[] = [];
		for (const line of lines) {
			const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
			if (!match) throw new Error(`Malformed packed vendor manifest: ${line}`);
			vendorFiles.push(match[2]);
			expect(digest(await readFile(path.join(vendor, match[2])))).toBe(match[1]);
		}
		expect(vendorFiles.length).toBeGreaterThanOrEqual(63);
		expect((await walk(vendor)).filter((name) => name !== "MANIFEST.sha256")).toEqual(vendorFiles.sort());
		expect(await walk(path.join(vendor, "source/agents"))).toHaveLength(4);
		expect(await walk(path.join(ext, "skills/impeccable/reference/agents"))).toHaveLength(4);
		const provenance = JSON.parse(await readFile(path.join(ext, "upstream.json"), "utf8"));
		expect(provenance.upstream).toMatchObject({ tag: "skill-v4.8.0", commit: "414603bf14c7a344edb466bb1f85690c77ce8b7d", engineVersion: "0.1.18", license: "Apache-2.0" });
		expect(await readFile(path.join(ext, "LICENSE"), "utf8")).toContain("Apache License");
		expect(await readFile(path.join(ext, "NOTICE.md"), "utf8")).toContain("platform-design-skills");
		const cwd = path.join(temp, "unrelated project with spaces");
		const agentDir = path.join(temp, "isolated agent with spaces");
		const home = path.join(temp, "private home");
		await Promise.all([cwd, agentDir, home].map((dir) => mkdir(dir)));
		await writeFile(path.join(cwd, "existing project.txt"), "unchanged project bytes\n");
		await writeFile(path.join(agentDir, "existing agent.txt"), "unchanged agent bytes\n");
		await symlink(path.join(root, "node_modules"), path.join(installed, "node_modules"), "dir");
		// Disable only the SDK's Jiti compilation cache so all mutation guards remain strict.
		const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TMPDIR: temp, TEMP: temp, TMP: temp, NO_COLOR: "1", JITI_FS_CACHE: "false" };
		const activation = JSON.parse((await exec(process.execPath, ["--experimental-strip-types", path.join(harness, "activation.mjs"), installed, cwd, agentDir], { cwd, env, timeout: 30_000 })).stdout);
		expect(activation).toMatchObject({ prompts: 26, guardControls: 7, activationAttempts: [] });
		expect(activation.tools).toHaveLength(5);
		expect(await walk(cwd)).toEqual(["existing project.txt"]);
		expect(await readFile(path.join(cwd, "existing project.txt"), "utf8")).toBe("unchanged project bytes\n");
		expect(await walk(agentDir)).toEqual(["existing agent.txt"]);
		expect(await readFile(path.join(agentDir, "existing agent.txt"), "utf8")).toBe("unchanged agent bytes\n");
		expect(await walk(home)).toEqual([]);

		// A real executable under a trusted override exercises the extracted raw runner.
		// It deliberately does not stand in for managed-download or upstream browser evidence.
		const binary = path.join(temp, "local protocol executable with spaces");
		await writeFile(binary, `#!${process.execPath}\n${await readFile(path.join(harness, "protocol-engine.mjs"), "utf8")}`);
		await chmod(binary, 0o700);
		const cacheRoot = path.join(temp, "unused managed cache");
		const results = JSON.parse((await exec(process.execPath, ["--experimental-strip-types", path.join(harness, "runner.mjs"), installed, cwd, binary, cacheRoot], { cwd, env, timeout: 30_000 })).stdout) as EngineRunResult[];
		expect(results.map((result) => result.status)).toEqual(["success", "findings", "error"]);
		const checksumBytes = await readFile(path.join(ext, "skills/impeccable/scripts/engine-checksums.txt"));
		const checksums = checksumBytes.toString().split(/\r?\n/).filter((line) => line.startsWith("0.1.18 "));
		expect(checksums).toHaveLength(5);
		for (const line of checksums) expect(line).toMatch(/^0\.1\.18\s+impeccable-\S+\s+[a-f0-9]{64}$/);
		for (const [index, result] of results.entries()) {
			const verb = ["context", "detect", "fail"][index];
			const argv = [verb, "--target", "surface with spaces", "$(literal)", "a;b", "$ARGUMENTS"];
			expect(result).toMatchObject({ binary, cwd, argv, trustedOverride: true, exitCode: [0, 2, 7][index], ok: index !== 2, findings: index === 1, signal: null, stdoutTruncated: false, stderrTruncated: false });
			expect(JSON.parse(result.stdout)).toEqual({
				argv, cwd, stdin: JSON.stringify({ event: "package-relocation", literal: "$ARGUMENTS" }),
				skill: path.join(ext, "skills/impeccable"), self: path.join(ext, "skills/impeccable/scripts/impeccable"), provider: "pi",
				literal: "literal $1 $(value); with spaces", skillExists: true, launcherExists: true, version: "0.1.18", checksums: digest(checksumBytes),
			});
		}
		expect(results[2].stderr).toBe("protocol fixture failure\n");
		expect((await readdir(temp))).not.toContain(path.basename(cacheRoot));
		process.stdout.write(`Package evidence: ${JSON.stringify({ tarball: packed.filename, integrity: packed.integrity, impeccableFiles: sourceFiles.length, skillFiles: sourceFiles.filter((name) => name.startsWith("skills/")).length, vendorHashes: vendorFiles.length, roles: 4, prompts: activation.prompts, tools: activation.tools.length, guardControls: activation.guardControls, activationAttempts: activation.activationAttempts, executable: "local trusted protocol fixture (offline)", runnerStatuses: results.map((result) => result.status), installedSkill: path.join(ext, "skills/impeccable") })}\n`);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});

it("rejects Impeccable runtime artifacts while retaining canonical scripts and unrelated collection assets", () => {
	for (const magic of ["7f454c46", "cffaedfe", "4d5a9000"]) expect(nativeOrGeneratedBytes(Buffer.from(magic, "hex"))).toBe(true);
	expect(nativeOrGeneratedBytes(Buffer.from("SQLite format 3\0"))).toBe(true);
	expect(nativeOrGeneratedBytes(Buffer.from("#!/bin/sh\n"))).toBe(false);
	for (const entry of ["extensions/impeccable/cache/engine", "extensions/impeccable/engine.exe", "extensions/impeccable/test-results/trace.zip", "extensions/impeccable/.impeccable/audit.json", "extensions/impeccable/credentials.json", "extensions/impeccable/node_modules/foo/index.js", "extensions/impeccable/impeccable-linux-x64", "extensions/impeccable/screenshots/output.png"]) expect(forbiddenEntry(entry), entry).toBe(true);
	for (const entry of ["extensions/other/assets/icon.png", "extensions/other/fixture.exe", "extensions/impeccable/skills/impeccable/scripts/impeccable", "extensions/impeccable/skills/impeccable/scripts/impeccable.cmd", "extensions/impeccable/skills/impeccable/scripts/live-browser.js", "extensions/impeccable/skills/impeccable/scripts/modern-screenshot.umd.js"]) expect(forbiddenEntry(entry), entry).toBe(false);
});
