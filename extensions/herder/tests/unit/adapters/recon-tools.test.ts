import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReconTools, reconRelativePath } from "../../../adapters/recon-tools.ts";

async function fixture(t: test.TestContext) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "herder-recon-tools-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const root = path.join(directory, ".herder/worktrees/003");
	for (const folder of ["src", ".github", ".herder/pi-sessions", "nested/.git", "node_modules/pkg"]) {
		await mkdir(path.join(root, folder), { recursive: true });
	}
	for (const [file, content] of Object.entries({
		"src/main.ts": "before\nNeedle(value)\nafter\nneedle plain\n",
		"src/fixture.jsonl": '{"source":"needle fixture"}\n',
		".github/ci.yml": "needle hidden\n",
		".git": "gitdir: /outside/metadata\nneedle secret\n",
		"nested/.git/config": "needle secret\n",
		".herder/pi-sessions/own.jsonl": "needle secret\n",
		"node_modules/pkg/index.js": "needle dependency\n",
	})) await writeFile(path.join(root, file), content);
	const outside = path.join(directory, "coordinator");
	await mkdir(outside);
	await writeFile(path.join(outside, "secret.txt"), "needle secret\n");
	await mkdir(path.join(root, "../003-prefix"));
	await writeFile(path.join(root, "../003-prefix/secret.txt"), "needle secret\n");
	await symlink(outside, path.join(root, "escape"));
	await symlink(path.join(outside, "secret.txt"), path.join(root, "escape.txt"));
	await symlink(path.join(root, "src"), path.join(root, "internal-link"));
	const scope = new AbortController();
	const agentDir = path.join(directory, "agent");
	const tools = createReconTools(root, scope.signal, agentDir);
	const run = async (name: string, input: Record<string, unknown>, signal?: AbortSignal) => {
		const result = await tools.find((tool) => tool.name === name)!.execute("test", input, signal, undefined, {} as never);
		return { ...result, text: result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") };
	};
	return { root, directory, outside, scope, agentDir, run, tools };
}

test("Recon lexical admission supports native Windows round trips without path aliases", () => {
	const root = "C:\\repo\\.herder\\worktrees\\003";
	for (const input of ["src/main.ts", "src\\main.ts", `${root}\\src\\main.ts`, "c:/repo/.herder/worktrees/003/src/main.ts"]) {
		const relative = reconRelativePath(input, root, root, path.win32);
		assert.equal(relative, "src\\main.ts");
		assert.equal(reconRelativePath(path.win32.join(root, relative), root, root, path.win32), relative, "operation hook round trip");
	}
	assert.equal(reconRelativePath(root, root, root, path.win32), "");
	for (const input of [
		"C:src\\main.ts", "C:", "D:\\outside", `${root}-prefix\\secret`, "..\\003-prefix\\secret",
		"\\\\server\\share", "//server/share", "\\\\?\\C:\\repo", "\\\\.\\C:\\repo", "/c/repo", "\\repo",
		"src\\main.ts:stream", `${root}\\src\\main.ts::$DATA`, "file:///C:/repo", "@src/main.ts", "~/secret",
		".git\\config", ".HeRdEr\\log", `${root}\\.git\\config`, ".git.\\config", ".herder \\log",
	]) assert.throws(() => reconRelativePath(input, root, root, path.win32), /Recon filesystem scope denied/, input);
	assert.equal(reconRelativePath("/private/tmp/repo/src", "/tmp/repo", "/private/tmp/repo", path.posix), "src");
	for (const input of ["C:\\repo\\src", "C:/repo/src", "src\\main.ts", "src/main.ts:stream"]) {
		assert.throws(() => reconRelativePath(input, "/tmp/repo", "/private/tmp/repo", path.posix), /Recon filesystem scope denied/);
	}
});

test("Recon search metadata advertises disabled ignore files and explicit hidden glob components", async (t) => {
	const { tools } = await fixture(t);
	for (const tool of tools.filter((tool) => ["find", "grep"].includes(tool.name))) {
		assert.doesNotMatch(`${tool.description} ${tool.promptSnippet}`, /respects \.gitignore/i);
		assert.match(tool.description, /does not process ignore files/);
		assert.match(tool.promptSnippet!, /ignore files disabled/);
	}
	assert.match(tools.find((tool) => tool.name === "find")!.description, /name hidden path components explicitly/);
});

test("Recon reads and lists source, including hidden and JSONL fixtures, under a runtime worktree root", async (t) => {
	const { root, run } = await fixture(t);
	assert.match((await run("read", { path: "src/main.ts", offset: 2, limit: 1 })).text, /^Needle\(value\)/);
	assert.match((await run("read", { path: path.join(root, "src/fixture.jsonl") })).text, /needle fixture/);
	assert.match((await run("read", { path: path.join(await realpath(root), "src/main.ts") })).text, /Needle/);
	const listing = (await run("ls", {})).text;
	assert.match(listing, /\.github\//);
	assert.match(listing, /src\//);
	assert.doesNotMatch(listing, /\.git\n|\.herder|escape|internal-link/);
	assert.match((await run("ls", { path: ".github" })).text, /ci.yml/);
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
	await writeFile(path.join(root, "pixel.png"), Buffer.from(png, "base64"));
	assert.ok((await run("read", { path: "pixel.png" })).content.some((part) => part.type === "image"));
});

test("all Recon tools reject external paths, reserved metadata and symlinks before backend access", async (t) => {
	const { root, outside, run } = await fixture(t);
	const denied = [
		"../003-prefix", path.join(root, "../003-prefix"), "../../coordinator", outside,
		".git", ".GIT", "nested/.git", "nested/.git/config", ".herder/pi-sessions/own.jsonl", ".HeRdEr/pi-sessions/own.jsonl", ".git/../src",
		"escape", "escape/secret.txt", "escape.txt", "internal-link/main.ts",
		"~/secret", "@src/main.ts", `file://${outside}/secret.txt`, "C:\\secret", "C:secret", "..\\secret",
		"//server/share", "src\u00a0/main.ts", "src/main.ts\0", "\\\\?\\C:\\secret",
	];
	for (const name of ["read", "ls", "find", "grep"]) {
		for (const target of denied) {
			await assert.rejects(run(name, { path: target, pattern: "needle" }), /Recon filesystem scope denied:.*caller.*excerpt inline/, `${name}: ${target}`);
		}
	}
	if (process.platform !== "win32") {
		execFileSync("mkfifo", [path.join(root, "pipe")]);
		await assert.rejects(run("read", { path: "pipe" }), /only regular files and directories/);
		assert.doesNotMatch((await run("ls", {})).text, /pipe/);
	}
});

test("native Recon searches prune metadata and symlinks even when caller globs explicitly include them", async (t) => {
	const { root, run } = await fixture(t);
	assert.deepEqual((await run("find", { pattern: "*.ts" })).text.split("\n"), ["src/main.ts"]);
	assert.equal((await run("find", { pattern: "src/*.jsonl" })).text, "src/fixture.jsonl");
	// Node matchesGlob follows shell dotfile semantics: explicitly name hidden components.
	assert.match((await run("find", { pattern: ".github/*" })).text, /\.github\/ci.yml/);
	assert.match((await run("grep", { pattern: "needle", ignoreCase: true })).text, /src\/main.ts:2: Needle/);
	for (const glob of [undefined, "**/*", "**/.herder/**", "**/.git/**", "**/node_modules/**", "**/escape*"]) {
		const search = (await run("grep", { pattern: "needle", path: ".", glob, ignoreCase: true })).text;
		assert.doesNotMatch(search, /secret|dependency|escape|internal-link|own.jsonl/);
		const found = (await run("find", { pattern: glob ?? "**/*", path: "." })).text;
		assert.doesNotMatch(found, /\.herder|\/\.git|node_modules|escape|internal-link/);
	}
	const context = (await run("grep", { pattern: "NEEDLE(value)", ignoreCase: true, literal: true, context: 1, glob: "*.ts" })).text;
	assert.match(context, /src\/main.ts-1- before/);
	assert.match(context, /src\/main.ts:2: Needle\(value\)/);
	assert.match(context, /src\/main.ts-3- after/);
	assert.match((await run("grep", { pattern: "Needle", path: "src/main.ts" })).text, /main.ts:2:/);
	assert.match((await run("grep", { pattern: "needle", glob: "*.jsonl" })).text, /fixture.jsonl:1:/);
	await writeFile(path.join(root, "src/-option.txt"), "--help\n");
	assert.match((await run("grep", { pattern: "--help", literal: true, path: "src/-option.txt" })).text, /-option.txt:1:/);
	await assert.rejects(run("grep", { pattern: "[" }), /Recon search failed:/);
	await assert.rejects(run("grep", { path: "node_modules", pattern: "needle" }), /search traversal is excluded/);
});

test("Recon deliberately ignores all ignore files and ripgrep configuration",  async (t) => {
	const { directory, root, run } = await fixture(t);
	await writeFile(path.join(directory, ".ignore"), "*\n");
	await writeFile(path.join(root, ".gitignore"), "*\n");
	await writeFile(path.join(root, ".ignore"), "*\n");
	const config = path.join(directory, "rg-config");
	await writeFile(config, "--follow\n--glob=!*\n");
	const previous = process.env.RIPGREP_CONFIG_PATH;
	process.env.RIPGREP_CONFIG_PATH = config;
	t.after(() => { if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = previous; });
	assert.match((await run("find", { pattern: "*.jsonl" })).text, /src\/fixture.jsonl/);
	assert.equal((await run("find", { pattern: "*.ts" })).text, "src/main.ts");
	assert.match((await run("grep", { pattern: "Needle" })).text, /src\/main.ts:2:/);
	assert.doesNotMatch((await run("grep", { pattern: "needle", glob: "**/*" })).text, /secret/);
});

test("Recon never processes symlinked .ignore or .gitignore outside the worktree", async (t) => {
	const { root, outside, run } = await fixture(t);
	const payload = path.join(outside, "ignore-payload");
	await writeFile(payload, "*\n");
	for (const name of [".ignore", ".gitignore"]) {
		await symlink(payload, path.join(root, name));
		assert.equal((await run("find", { pattern: "*.ts" })).text, "src/main.ts", name);
		assert.match((await run("grep", { pattern: "Needle" })).text, /src\/main.ts:2:/, name);
		await rm(path.join(root, name));
	}
	if (process.platform !== "win32") {
		const fifo = path.join(outside, "ignore-fifo");
		execFileSync("mkfifo", [fifo]);
		for (const name of [".ignore", ".gitignore"]) {
			await symlink(fifo, path.join(root, name));
			// Reading this ignore target would block; cancellation bounds the regression instead of hanging.
			assert.equal((await run("find", { pattern: "*.ts" }, AbortSignal.timeout(3000))).text, "src/main.ts", name);
			assert.match((await run("grep", { pattern: "Needle" }, AbortSignal.timeout(3000))).text, /src\/main.ts:2:/, name);
			await rm(path.join(root, name));
		}
	}
});

test("Recon prunes mixed-case metadata aliases independently of filesystem casing", async (t) => {
	const { root, run } = await fixture(t);
	await mkdir(path.join(root, "mixed/.GiT"), { recursive: true });
	await mkdir(path.join(root, "mixed/.HeRdEr"));
	await writeFile(path.join(root, "mixed/.GiT/config"), "needle case secret\n");
	await writeFile(path.join(root, "mixed/.HeRdEr/log.jsonl"), "needle case secret\n");
	assert.doesNotMatch((await run("ls", { path: "mixed" })).text, /GiT|HeRdEr/);
	assert.doesNotMatch((await run("grep", { pattern: "needle", glob: "**/*" })).text, /case secret/);
	for (const pattern of ["**/.GiT/*", "**/.HeRdEr/*"]) {
		assert.equal((await run("find", { pattern })).text, "No files found matching pattern");
		assert.equal((await run("grep", { pattern: "needle", glob: pattern })).text, "No matches found");
	}
});

test("Recon result limits and SDK truncation metadata remain truthful and bounded", async (t) => {
	const { root, run } = await fixture(t);
	assert.equal((await run("find", { pattern: "**/*", limit: 1 })).details?.resultLimitReached, 1);
	assert.equal((await run("grep", { pattern: "needle", ignoreCase: true, limit: 1 })).details?.matchLimitReached, 1);
	assert.equal((await run("ls", { limit: 1 })).details?.entryLimitReached, 1);
	await writeFile(path.join(root, "long.txt"), `${"needle".repeat(200)}\n`.repeat(120));
	const long = await run("grep", { path: "long.txt", pattern: "needle", limit: 200 });
	assert.equal(long.details?.linesTruncated, true);
	assert.equal(long.details?.truncation?.truncated, true);
	assert.match(long.text, /output truncated.*long lines truncated/);
	assert.ok(Buffer.byteLength(long.text) < 52_000);
	for (const limit of [0, -1, NaN, Infinity, 1.5]) await assert.rejects(run("find", { pattern: "*", limit }), /Expected an integer/);
	await writeFile(path.join(root, "huge.txt"), "needle ".repeat(700_000));
	await assert.rejects(run("grep", { path: "huge.txt", pattern: "needle" }), /Recon search failed:.*maxBuffer.*hand off/);
});

test("Recon cancellation is inherited from scope and individual executions", async (t) => {
	const { scope, run } = await fixture(t);
	for (const name of ["read", "ls", "find", "grep"]) {
		await assert.rejects(run(name, { path: "src/main.ts", pattern: "needle" }, AbortSignal.abort(new Error("execute cancelled"))), /execute cancelled/);
	}
	scope.abort(new Error("scope cancelled"));
	for (const name of ["read", "ls", "find", "grep"]) {
		await assert.rejects(run(name, { path: "src/main.ts", pattern: "needle" }), /scope cancelled/);
	}
});

test("missing ripgrep never downloads; existing Pi bin fallback supports errors and active cancellation", async (t) => {
	const { agentDir, root, run, scope } = await fixture(t);
	const original = process.env.PATH;
	process.env.PATH = "";
	t.after(() => { if (original === undefined) delete process.env.PATH; else process.env.PATH = original; });
	for (const name of ["grep", "find"]) await assert.rejects(run(name, { pattern: "needle" }), /ripgrep is missing.*No download attempted.*excerpt inline/);
	if (process.platform === "win32") return;
	const binary = path.join(agentDir, "bin/rg");
	await mkdir(path.dirname(binary), { recursive: true });
	await writeFile(binary, "#!/bin/sh\nprintf 'src/main.ts\\0'\n");
	await chmod(binary, 0o755);
	assert.equal((await run("find", { pattern: "*.ts" })).text, "src/main.ts");
	await writeFile(binary, "#!/bin/sh\necho 'traversal denied' >&2\nexit 2\n");
	await assert.rejects(run("grep", { pattern: "needle" }), /Recon search failed: traversal denied/);
	await writeFile(binary, "#!/bin/sh\necho 'traversal warning' >&2\nexit 1\n");
	await assert.rejects(run("grep", { pattern: "needle" }), /Recon search failed: traversal warning/);
	// A real subprocess, not a mocked promise: cancellation must terminate native work.
	await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(root, "started"))}, 'ready'); setInterval(() => {}, 1000);\n`);
	const running = run("grep", { pattern: "needle" });
	const rejected = assert.rejects(running, /cancelled/);
	for (let attempt = 0; attempt < 200; attempt++) {
		try { await access(path.join(root, "started")); break; }
		catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
	}
	scope.abort();
	await rejected;
});
