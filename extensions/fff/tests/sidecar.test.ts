import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { SidecarFffBackend, type SidecarBackendOptions } from "../client.ts";
import { fffFileAnnotation } from "../index.ts";

const tempDirs: string[] = [];
const backends: SidecarFffBackend[] = [];
const trackedPids = new Set<number>();

function makeTempDir(label: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-fff-sidecar-${label}-`));
	tempDirs.push(dir);
	return dir;
}

function makeBackend(options?: SidecarBackendOptions): SidecarFffBackend {
	const backend = new SidecarFffBackend(options);
	backends.push(backend);
	return backend;
}

function trackPid(pid: number | undefined): number {
	expect(typeof pid).toBe("number");
	expect(pid).toBeGreaterThan(0);
	trackedPids.add(pid!);
	return pid!;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 2_000,
	intervalMs = 10,
): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await predicate()) {
			return true;
		}
		await sleep(intervalMs);
	}
	return await predicate();
}

async function waitForPidExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
	return waitForCondition(() => !isPidAlive(pid), timeoutMs, 10);
}

function initTempGitRepo(repoDir: string): void {
	fs.mkdirSync(path.join(repoDir, "src", "nested"), { recursive: true });
	fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });

	fs.writeFileSync(
		path.join(repoDir, "src", "alpha.ts"),
		[
			"export const SHARED_MARKER = 'SHARED_MARKER_TOKEN';",
			"export function computeMetric1(): number {",
			"\treturn 101;",
			"}",
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(repoDir, "src", "beta.ts"),
		[
			"export const SHARED_MARKER = 'SHARED_MARKER_TOKEN';",
			"export function computeMetric2(): number {",
			"\treturn 202;",
			"}",
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(repoDir, "src", "nested", "gamma.ts"),
		[
			"export const SHARED_MARKER = 'SHARED_MARKER_TOKEN';",
			"export function computeMetric3(): number {",
			"\treturn 303;",
			"}",
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(repoDir, "docs", "architecture.md"),
		"# Architecture\n\nReference token: SHARED_MARKER_TOKEN\n",
	);
	fs.writeFileSync(
		path.join(repoDir, "docs", "changelog.md"),
		"# Changelog\n\nReference token: SHARED_MARKER_TOKEN\n",
	);

	const gitEnv: NodeJS.ProcessEnv = {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "FFF Test",
		GIT_AUTHOR_EMAIL: "fff@test.local",
		GIT_COMMITTER_NAME: "FFF Test",
		GIT_COMMITTER_EMAIL: "fff@test.local",
	};

	execFileSync("git", ["init", "-q"], { cwd: repoDir, env: gitEnv });
	execFileSync("git", ["add", "."], { cwd: repoDir, env: gitEnv });
	execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], {
		cwd: repoDir,
		env: gitEnv,
	});

	// Modify one tracked file unstaged so git status is dirty ("modified").
	fs.appendFileSync(
		path.join(repoDir, "src", "alpha.ts"),
		"\nexport const UNSTAGED_DIRTY_EDIT = true;\n",
	);
}

afterEach(async () => {
	for (const backend of backends.splice(0)) {
		const pid = backend.getPid();
		if (pid !== undefined) {
			trackedPids.add(pid);
		}
		await backend.dispose();
	}

	for (const pid of trackedPids) {
		if (isPidAlive(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already exited.
			}
		}
		await waitForPidExit(pid, 2_000);
	}
	trackedPids.clear();

	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("SidecarFffBackend", () => {
	it("shares a single @ff-labs/fff-node sidecar and root across 20 concurrent callers (real + symlink paths)", async () => {
		const baseDir = makeTempDir("concurrent");
		const repoDir = path.join(baseDir, "repo");
		const symlinkDir = path.join(baseDir, "repo-symlink");
		const frecencyDbPath = path.join(baseDir, "db", "frecency");
		const historyDbPath = path.join(baseDir, "db", "history");

		initTempGitRepo(repoDir);
		fs.symlinkSync(repoDir, symlinkDir, "dir");

		const canonicalRepo = fs.realpathSync.native(repoDir);
		const backend = makeBackend();

		// 10 calls via real path + 10 calls via symlink alias (main session + 19 subagents).
		const callers = Array.from({ length: 20 }, (_, i) =>
			backend.ensureRoot({
				basePath: i % 2 === 0 ? repoDir : symlinkDir,
				kind: "workspace",
				frecencyDbPath,
				historyDbPath,
			}),
		);

		const results = await Promise.all(callers);
		expect(results).toHaveLength(20);
		for (const res of results) {
			expect(res.root).toBe(canonicalRepo);
			expect(res.dbFallbackError).toBeUndefined();
		}
		expect(results.filter((res) => res.created === true)).toHaveLength(1);
		expect(results.filter((res) => res.created === false)).toHaveLength(19);

		const pid = trackPid(backend.getPid());
		expect(isPidAlive(pid)).toBe(true);

		const health = await backend.healthCheck(canonicalRepo);
		expect(health.ok).toBe(true);
		if (!health.ok) return;
		expect(health.value.pid).toBe(pid);
		expect(health.value.sharedRoots).toBe(1);
		expect(health.value.git.repositoryFound).toBe(true);
		expect(health.value.filePicker.initialized).toBe(true);

		// Wait briefly if background libgit2 status cache is still settling.
		let modifiedAlphaAnnotation = "";
		const foundDirtyAlpha = await waitForCondition(async () => {
			const search = await backend.fileSearch(canonicalRepo, "alpha.ts");
			if (!search.ok) return false;
			const alpha = search.value.items.find((item) => item.relativePath === "src/alpha.ts");
			if (!alpha) return false;
			modifiedAlphaAnnotation = fffFileAnnotation(alpha);
			return alpha.gitStatus === "modified" && modifiedAlphaAnnotation.includes("[modified in git]");
		}, 3_000);
		expect(foundDirtyAlpha).toBe(true);
		expect(modifiedAlphaAnnotation).toContain("[modified in git]");

		// Literal grep + pagination across all 5 files via nextCursor.
		const collectedLiteralFiles: string[] = [];
		let cursor = null;
		let pages = 0;
		do {
			const page = await backend.grep(canonicalRepo, "SHARED_MARKER_TOKEN", {
				mode: "plain",
				pageSize: 2,
				cursor,
			});
			expect(page.ok).toBe(true);
			if (!page.ok) break;
			pages++;
			if (pages === 1) {
				expect(page.value.nextCursor).not.toBeNull();
			}
			for (const match of page.value.items) {
				collectedLiteralFiles.push(match.relativePath);
			}
			cursor = page.value.nextCursor;
		} while (cursor !== null && pages < 10);

		expect(pages).toBeGreaterThanOrEqual(2);
		expect(new Set(collectedLiteralFiles)).toEqual(
			new Set([
				"src/alpha.ts",
				"src/beta.ts",
				"src/nested/gamma.ts",
				"docs/architecture.md",
				"docs/changelog.md",
			]),
		);

		// Regex grep across TypeScript files.
		const regexGrep = await backend.grep(canonicalRepo, "computeMetric\\d+\\(\\)", {
			mode: "regex",
		});
		expect(regexGrep.ok).toBe(true);
		if (regexGrep.ok) {
			expect(new Set(regexGrep.value.items.map((m) => m.relativePath))).toEqual(
				new Set(["src/alpha.ts", "src/beta.ts", "src/nested/gamma.ts"]),
			);
		}

		// mixedSearch returns both file and directory entries.
		const mixed = await backend.mixedSearch(canonicalRepo, "src");
		expect(mixed.ok).toBe(true);
		if (mixed.ok) {
			expect(mixed.value.items.some((entry) => entry.type === "file")).toBe(true);
			expect(mixed.value.items.some((entry) => entry.type === "directory")).toBe(true);
		}

		// scanFiles triggers an async rescan and normalizes to { ok: true, value: true }.
		const scanRes = await backend.scanFiles(canonicalRepo);
		expect(scanRes).toEqual({ ok: true, value: true });
	});

	it("reuses covering parent aux root by default and initializes nested root with exact: true", async () => {
		const baseDir = makeTempDir("aux-covering");
		const parentDir = path.join(baseDir, "parent");
		const nestedDir = path.join(parentDir, "packages", "sub");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(parentDir, "root-only.ts"), "export const rootOnly = 1;\n");
		fs.writeFileSync(path.join(nestedDir, "sub-only.ts"), "export const subOnly = 2;\n");

		const canonicalParent = fs.realpathSync.native(parentDir);
		const canonicalNested = fs.realpathSync.native(nestedDir);

		const backend = makeBackend();

		const parentEnsure = await backend.ensureRoot({
			basePath: parentDir,
			kind: "aux",
		});
		expect(parentEnsure.root).toBe(canonicalParent);
		expect(parentEnsure.created).toBe(true);
		trackPid(backend.getPid());

		const healthBefore = await backend.healthCheck(canonicalParent);
		expect(healthBefore.ok).toBe(true);
		if (healthBefore.ok) {
			expect(healthBefore.value.sharedRoots).toBe(1);
		}

		// Nested directory without `exact` reuses the covering parent root.
		const coveredEnsure = await backend.ensureRoot({
			basePath: nestedDir,
			kind: "aux",
		});
		expect(coveredEnsure.root).toBe(canonicalParent);
		expect(coveredEnsure.created).toBe(false);

		const healthAfterCovered = await backend.healthCheck(canonicalParent);
		expect(healthAfterCovered.ok).toBe(true);
		if (healthAfterCovered.ok) {
			expect(healthAfterCovered.value.sharedRoots).toBe(1);
		}

		// Nested directory with `exact: true` creates a distinct root entry scoped to nestedDir.
		const exactEnsure = await backend.ensureRoot({
			basePath: nestedDir,
			kind: "aux",
			exact: true,
		});
		expect(exactEnsure.root).toBe(canonicalNested);
		expect(exactEnsure.created).toBe(true);
		expect(exactEnsure.root).not.toBe(canonicalParent);

		const healthAfterExact = await backend.healthCheck(canonicalNested);
		expect(healthAfterExact.ok).toBe(true);
		if (healthAfterExact.ok) {
			expect(healthAfterExact.value.sharedRoots).toBe(2);
		}

		const exactSearch = await backend.fileSearch(canonicalNested, "sub-only.ts");
		expect(exactSearch.ok).toBe(true);
		if (exactSearch.ok) {
			expect(exactSearch.value.items.map((i) => i.relativePath)).toContain("sub-only.ts");
			expect(exactSearch.value.items.map((i) => i.relativePath)).not.toContain("root-only.ts");
		}
	});

	it("falls back to db-less mode with persistent dbFallbackError until DB config changes", async () => {
		const baseDir = makeTempDir("db-fallback");
		const repoA = path.join(baseDir, "repo-a");
		const repoB = path.join(baseDir, "repo-b");
		fs.mkdirSync(repoA, { recursive: true });
		fs.mkdirSync(repoB, { recursive: true });
		fs.writeFileSync(path.join(repoA, "one.ts"), "export const one = 1;\n");
		fs.writeFileSync(path.join(repoB, "two.ts"), "export const two = 2;\n");

		// Regular file where LMDB expects a directory forces FileFinder.create with DB paths to fail.
		const invalidFrecencyDbFile = path.join(baseDir, "not-a-directory.lmdb");
		fs.writeFileSync(invalidFrecencyDbFile, "corrupt regular file");
		const historyDbDir = path.join(baseDir, "history-db");

		const backend = makeBackend();

		const first = await backend.ensureRoot({
			basePath: repoA,
			kind: "workspace",
			frecencyDbPath: invalidFrecencyDbFile,
			historyDbPath: historyDbDir,
		});
		trackPid(backend.getPid());
		expect(first.root).toBe(fs.realpathSync.native(repoA));
		expect(first.created).toBe(true);
		expect(typeof first.dbFallbackError).toBe("string");
		expect(first.dbFallbackError!.length).toBeGreaterThan(0);

		const health = await backend.healthCheck(first.root);
		expect(health.ok).toBe(true);
		if (health.ok) {
			expect(health.value.frecency.initialized).toBe(false);
		}

		// Subsequent ensureRoot calls persistently surface dbFallbackError so later TUI sessions don't miss it.
		const reusedSameRoot = await backend.ensureRoot({
			basePath: repoA,
			kind: "workspace",
			frecencyDbPath: invalidFrecencyDbFile,
			historyDbPath: historyDbDir,
		});
		expect(reusedSameRoot.created).toBe(false);
		expect(reusedSameRoot.dbFallbackError).toBe(first.dbFallbackError);

		const second = await backend.ensureRoot({
			basePath: repoB,
			kind: "workspace",
			frecencyDbPath: invalidFrecencyDbFile,
			historyDbPath: historyDbDir,
		});
		expect(second.root).toBe(fs.realpathSync.native(repoB));
		expect(second.created).toBe(true);
		expect(second.dbFallbackError).toBe(first.dbFallbackError);

		// Fixing DB paths (different configKey) resets dbDisabled and creates a fresh FileFinder with frecency enabled.
		const validFrecencyDbDir = path.join(baseDir, "valid-frecency-db");
		const recovered = await backend.ensureRoot({
			basePath: repoA,
			kind: "workspace",
			frecencyDbPath: validFrecencyDbDir,
			historyDbPath: historyDbDir,
		});
		expect(recovered.root).toBe(first.root);
		expect(recovered.created).toBe(true);
		expect(recovered.dbFallbackError).toBeUndefined();

		const recoveredHealth = await backend.healthCheck(first.root);
		expect(recoveredHealth.ok).toBe(true);
		if (recoveredHealth.ok) {
			expect(recoveredHealth.value.frecency.initialized).toBe(true);
		}

		const search = await backend.fileSearch(first.root, "one.ts");
		expect(search.ok).toBe(true);
		if (search.ok) {
			expect(search.value.items.map((i) => i.relativePath)).toContain("one.ts");
		}
	});

	it("seamlessly re-ensures and retries once in callWithRoot when an aux root was evicted", async () => {
		const baseDir = makeTempDir("aux-eviction");
		const backend = makeBackend();

		const auxRoots: string[] = [];
		// MAX_AUX is 16: ensuring 18 distinct unpinned aux roots evicts the earliest ones in sidecar.mjs
		// while session.ensuredRoots in client.ts still remembers them.
		for (let i = 0; i < 18; i++) {
			const dir = path.join(baseDir, `aux-${i}`);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, `item-${i}.ts`), `export const marker${i} = "EVICTED_TOKEN_${i}";\n`);
			const res = await backend.ensureRoot({ basePath: dir, kind: "aux", exact: true });
			expect(res.created).toBe(true);
			auxRoots.push(res.root);
		}
		const pid = trackPid(backend.getPid());

		// Querying evicted aux-0 succeeds seamlessly via callWithRoot catch + re-ensure + single retry.
		const grep0 = await backend.grep(auxRoots[0]!, "EVICTED_TOKEN_0", { mode: "plain" });
		expect(grep0.ok).toBe(true);
		if (grep0.ok) {
			expect(grep0.value.items.map((m) => m.relativePath)).toContain("item-0.ts");
		}
		expect(backend.getPid()).toBe(pid);
	});

	it("recovers from a deadlocked/hung sidecar via watchdog kill, respawn, and automatic root re-ensure", async () => {
		const baseDir = makeTempDir("watchdog");
		const repoDir = path.join(baseDir, "repo");
		fs.mkdirSync(repoDir, { recursive: true });
		fs.writeFileSync(path.join(repoDir, "target.ts"), "export const needle = 42;\n");

		const markerPath = path.join(baseDir, "hung-once.marker");
		const fakeSidecarPath = path.join(baseDir, "fake-sidecar.mjs");

		fs.writeFileSync(
			fakeSidecarPath,
			[
				'import fs from "node:fs";',
				`const markerPath = ${JSON.stringify(markerPath)};`,
				"const ensured = new Set();",
				// Ignore SIGTERM so only SIGKILL from watchdog teardown can terminate a hung child.
				'process.on("SIGTERM", () => {});',
				'process.on("disconnect", () => {});',
				"const keepAlive = setInterval(() => {}, 60_000);",
				"keepAlive.unref();",
				'process.on("message", (msg) => {',
				"\tif (!msg || typeof msg !== 'object') return;",
				"\tconst { id, method, params } = msg;",
				"\tif (method === 'ensure') {",
				"\t\tconst root = fs.realpathSync.native(params.basePath);",
				"\t\tensured.add(root);",
				"\t\tprocess.send({ id, ok: true, value: { root } });",
				"\t\treturn;",
				"\t}",
				"\tif (method === 'grep') {",
				"\t\tif (!ensured.has(params.root)) {",
				"\t\t\tprocess.send({ id, ok: false, error: `FFF root not initialized: ${params.root}` });",
				"\t\t\treturn;",
				"\t\t}",
				"\t\tif (!fs.existsSync(markerPath)) {",
				"\t\t\tfs.writeFileSync(markerPath, String(process.pid));",
				"\t\t\t// Simulate native FFI / fff_destroy deadlock: never reply.",
				"\t\t\tsetInterval(() => {}, 60_000);",
				"\t\t\treturn;",
				"\t\t}",
				"\t\tprocess.send({",
				"\t\t\tid,",
				"\t\t\tok: true,",
				"\t\t\tvalue: {",
				"\t\t\t\tok: true,",
				"\t\t\t\tvalue: {",
				"\t\t\t\t\titems: [{",
				"\t\t\t\t\t\trelativePath: 'target.ts',",
				"\t\t\t\t\t\tfileName: 'target.ts',",
				"\t\t\t\t\t\tgitStatus: 'clean',",
				"\t\t\t\t\t\tsize: 27,",
				"\t\t\t\t\t\tmodified: 0,",
				"\t\t\t\t\t\tisBinary: false,",
				"\t\t\t\t\t\ttotalFrecencyScore: 0,",
				"\t\t\t\t\t\taccessFrecencyScore: 0,",
				"\t\t\t\t\t\tmodificationFrecencyScore: 0,",
				"\t\t\t\t\t\tlineNumber: 1,",
				"\t\t\t\t\t\tcol: 13,",
				"\t\t\t\t\t\tbyteOffset: 0,",
				"\t\t\t\t\t\tlineContent: 'export const needle = 42;',",
				"\t\t\t\t\t\tmatchRanges: [[13, 19]],",
				"\t\t\t\t\t}],",
				"\t\t\t\t\ttotalMatched: 1,",
				"\t\t\t\t\ttotalFilesSearched: 1,",
				"\t\t\t\t\ttotalFiles: 1,",
				"\t\t\t\t\tfilteredFileCount: 1,",
				"\t\t\t\t\tnextCursor: null,",
				"\t\t\t\t},",
				"\t\t\t},",
				"\t\t});",
				"\t}",
				"});",
			].join("\n"),
		);

		const backend = makeBackend({
			sidecarPath: fakeSidecarPath,
			callTimeoutMs: 120,
			ensureTimeoutMs: 2_000,
		});

		const { root } = await backend.ensureRoot({
			basePath: repoDir,
			kind: "workspace",
		});
		const hungPid = trackPid(backend.getPid());

		// Track parent event-loop responsiveness while the child hangs.
		let eventLoopTicks = 0;
		const ticker = setInterval(() => {
			eventLoopTicks++;
		}, 15);

		const startMs = performance.now();
		try {
			await expect(backend.grep(root, "needle")).rejects.toThrow(/timed out/);
		} finally {
			clearInterval(ticker);
		}
		const elapsedMs = performance.now() - startMs;

		expect(elapsedMs).toBeLessThan(500);
		expect(eventLoopTicks).toBeGreaterThanOrEqual(2);
		expect(await waitForPidExit(hungPid)).toBe(true);
		expect(backend.getPid()).toBeUndefined();

		// Next grep automatically respawns a new sidecar, re-ensures rememberedRoots, and succeeds.
		const recovered = await backend.grep(root, "needle");
		const respawnedPid = trackPid(backend.getPid());
		expect(respawnedPid).not.toBe(hungPid);
		expect(isPidAlive(respawnedPid)).toBe(true);

		expect(recovered.ok).toBe(true);
		if (recovered.ok) {
			expect(recovered.value.items).toHaveLength(1);
			expect(recovered.value.items[0]?.relativePath).toBe("target.ts");
		}
	});

	it("handles pre-aborted and mid-flight AbortSignal without killing a healthy sidecar, and respawns after SIGKILL", async () => {
		const baseDir = makeTempDir("crash-and-abort");
		const repoDir = path.join(baseDir, "repo");
		fs.mkdirSync(repoDir, { recursive: true });
		fs.writeFileSync(path.join(repoDir, "survivor.ts"), "export const alive = true;\n");

		const backend = makeBackend();
		const { root } = await backend.ensureRoot({
			basePath: repoDir,
			kind: "workspace",
		});
		const originalPid = trackPid(backend.getPid());

		// 1. Pre-aborted signal rejects immediately without disturbing the healthy sidecar.
		await expect(
			backend.fileSearch(root, "survivor", undefined, AbortSignal.abort()),
		).rejects.toThrow("Operation aborted");
		await expect(
			backend.ensureRoot({ basePath: repoDir, kind: "workspace" }, AbortSignal.abort()),
		).rejects.toThrow("Operation aborted");
		expect(backend.getPid()).toBe(originalPid);
		expect(isPidAlive(originalPid)).toBe(true);

		// 2. Mid-flight AbortSignal rejects with "Operation aborted" while leaving the sidecar alive.
		const controller = new AbortController();
		const midFlightPromise = backend.grep(root, "alive", undefined, controller.signal);
		controller.abort();
		await expect(midFlightPromise).rejects.toThrow("Operation aborted");

		expect(backend.getPid()).toBe(originalPid);
		expect(isPidAlive(originalPid)).toBe(true);

		// Confirm the same sidecar still serves requests cleanly after the mid-flight abort.
		const postAbortSearch = await backend.fileSearch(root, "survivor.ts");
		expect(postAbortSearch.ok).toBe(true);
		expect(backend.getPid()).toBe(originalPid);

		// 3. External SIGKILL (simulating SIGSEGV / unexpected native crash) -> auto-respawn + re-ensure.
		process.kill(originalPid, "SIGKILL");
		expect(await waitForPidExit(originalPid)).toBe(true);
		expect(await waitForCondition(() => backend.getPid() === undefined)).toBe(true);

		const respawnedSearch = await backend.fileSearch(root, "survivor.ts");
		const respawnedPid = trackPid(backend.getPid());
		expect(respawnedPid).not.toBe(originalPid);
		expect(isPidAlive(respawnedPid)).toBe(true);

		expect(respawnedSearch.ok).toBe(true);
		if (respawnedSearch.ok) {
			expect(respawnedSearch.value.items.map((i) => i.relativePath)).toContain("survivor.ts");
		}
	});

	it("clears the watchdog of an aborted request so a slow sidecar survives past the call deadline", async () => {
		const baseDir = makeTempDir("abort-watchdog");
		const repoDir = path.join(baseDir, "repo");
		fs.mkdirSync(repoDir, { recursive: true });
		fs.writeFileSync(path.join(repoDir, "target.ts"), "export const needle = 42;\n");

		const fakeSidecarPath = path.join(baseDir, "fake-sidecar.mjs");
		fs.writeFileSync(
			fakeSidecarPath,
			[
				'import fs from "node:fs";',
				'process.on("message", (msg) => {',
				"\tif (!msg || typeof msg !== 'object') return;",
				"\tconst { id, method, params } = msg;",
				"\tif (method === 'ensure') {",
				"\t\tconst root = fs.realpathSync.native(params.basePath);",
				"\t\tprocess.send({ id, ok: true, value: { root } });",
				"\t}",
				"\t// Slow grep: never reply within the call deadline.",
				"});",
			].join("\n"),
		);

		const callTimeoutMs = 120;
		const backend = makeBackend({
			sidecarPath: fakeSidecarPath,
			callTimeoutMs,
			ensureTimeoutMs: 2_000,
		});

		const { root } = await backend.ensureRoot({
			basePath: repoDir,
			kind: "workspace",
		});
		const pid = trackPid(backend.getPid());

		const controller = new AbortController();
		const aborted = backend.grep(root, "needle", undefined, controller.signal);
		controller.abort();
		await expect(aborted).rejects.toThrow("Operation aborted");

		await new Promise((resolve) => setTimeout(resolve, callTimeoutMs * 3));

		expect(backend.getPid()).toBe(pid);
		expect(isPidAlive(pid)).toBe(true);
	});

	it("triggers HEAD-change scanFiles() automatically when a reused git worktree switches commits", async () => {
		const baseDir = makeTempDir("worktree-head-rescan");
		const repoDir = path.join(baseDir, "repo");
		const worktreeDir = path.join(baseDir, "rw-0");
		fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(repoDir, "src", "commit1.ts"),
			"export const COMMIT_1_MARKER = 'COMMIT_1_ONLY';\n",
		);

		const gitEnv: NodeJS.ProcessEnv = {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "FFF Test",
			GIT_AUTHOR_EMAIL: "fff@test.local",
			GIT_COMMITTER_NAME: "FFF Test",
			GIT_COMMITTER_EMAIL: "fff@test.local",
		};

		execFileSync("git", ["init", "-q"], { cwd: repoDir, env: gitEnv });
		execFileSync("git", ["add", "."], { cwd: repoDir, env: gitEnv });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "commit 1"], {
			cwd: repoDir,
			env: gitEnv,
		});
		const commit1 = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repoDir,
			env: gitEnv,
			encoding: "utf8",
		}).trim();

		fs.writeFileSync(
			path.join(repoDir, "src", "commit2-added.ts"),
			"export const COMMIT_2_MARKER = 'COMMIT_2_EXCLUSIVE_TOKEN';\n",
		);
		execFileSync("git", ["add", "."], { cwd: repoDir, env: gitEnv });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "commit 2"], {
			cwd: repoDir,
			env: gitEnv,
		});
		const commit2 = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repoDir,
			env: gitEnv,
			encoding: "utf8",
		}).trim();

		// Create a pooled detached git worktree slot at commit1 (`.git` is a `gitdir:` file).
		execFileSync("git", ["worktree", "add", "-q", "--detach", worktreeDir, commit1], {
			cwd: repoDir,
			env: gitEnv,
		});
		expect(fs.statSync(path.join(worktreeDir, ".git")).isFile()).toBe(true);

		const backend = makeBackend();
		const initialEnsure = await backend.ensureRoot({
			basePath: worktreeDir,
			kind: "workspace",
		});
		const pid = trackPid(backend.getPid());
		expect(initialEnsure.created).toBe(true);

		const beforeSearch = await backend.fileSearch(initialEnsure.root, "commit2-added.ts");
		expect(beforeSearch.ok).toBe(true);
		if (beforeSearch.ok) {
			expect(beforeSearch.value.items.map((i) => i.relativePath)).not.toContain(
				"src/commit2-added.ts",
			);
		}

		// Switch the reused worktree slot directly to commit2 via git checkout.
		execFileSync("git", ["checkout", "-q", commit2], {
			cwd: worktreeDir,
			env: gitEnv,
		});

		// Re-ensure concurrently across 5 callers to verify coalesced HEAD-change refresh.
		const reusedResults = await Promise.all(
			Array.from({ length: 5 }, () =>
				backend.ensureRoot({
					basePath: worktreeDir,
					kind: "workspace",
				}),
			),
		);
		for (const res of reusedResults) {
			expect(res.root).toBe(initialEnsure.root);
			expect(res.created).toBe(false);
		}
		expect(backend.getPid()).toBe(pid);

		// New commit's file and content must be found immediately on the reused FileFinder.
		const afterSearch = await backend.fileSearch(initialEnsure.root, "commit2-added.ts");
		expect(afterSearch.ok).toBe(true);
		if (afterSearch.ok) {
			expect(afterSearch.value.items.map((i) => i.relativePath)).toContain(
				"src/commit2-added.ts",
			);
		}

		const afterGrep = await backend.grep(
			initialEnsure.root,
			"COMMIT_2_EXCLUSIVE_TOKEN",
			{ mode: "plain" },
		);
		expect(afterGrep.ok).toBe(true);
		if (afterGrep.ok) {
			expect(afterGrep.value.items.map((m) => m.relativePath)).toContain(
				"src/commit2-added.ts",
			);
		}

		const health = await backend.healthCheck(initialEnsure.root);
		expect(health.ok).toBe(true);
		if (health.ok) {
			expect(health.value.pid).toBe(pid);
			expect(health.value.sharedRoots).toBe(1);
		}
	});

	it("prunes deleted worktree entries and transparently recycles the idle sidecar once PI_FFF_MAX_DEAD_HANDLES is reached", async () => {
		const baseDir = makeTempDir("dead-worktree-recycle");
		const mainRepo = path.join(baseDir, "main-repo");
		const wt1 = path.join(baseDir, "temp-wt-1");
		const wt2 = path.join(baseDir, "temp-wt-2");

		initTempGitRepo(mainRepo);
		const gitEnv: NodeJS.ProcessEnv = {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		};
		execFileSync("git", ["worktree", "add", "-q", "--detach", wt1, "HEAD"], {
			cwd: mainRepo,
			env: gitEnv,
		});
		execFileSync("git", ["worktree", "add", "-q", "--detach", wt2, "HEAD"], {
			cwd: mainRepo,
			env: gitEnv,
		});

		const backend = makeBackend({
			env: {
				...process.env,
				PI_FFF_MAX_DEAD_HANDLES: "2",
			},
		});

		const mainEnsure = await backend.ensureRoot({
			basePath: mainRepo,
			kind: "workspace",
		});
		const wt1Ensure = await backend.ensureRoot({
			basePath: wt1,
			kind: "workspace",
		});
		const wt2Ensure = await backend.ensureRoot({
			basePath: wt2,
			kind: "workspace",
		});
		const oldPid = trackPid(backend.getPid());

		const healthInitial = await backend.healthCheck(mainEnsure.root);
		expect(healthInitial.ok).toBe(true);
		if (healthInitial.ok) {
			expect(healthInitial.value.pid).toBe(oldPid);
			expect(healthInitial.value.sharedRoots).toBe(3);
		}

		// Delete first temporary worktree: pruned (sharedRoots drops to 2), deadHandleCount=1 < 2 -> no recycle yet.
		fs.rmSync(wt1, { recursive: true, force: true });
		const healthAfterFirstDelete = await backend.healthCheck(mainEnsure.root);
		expect(healthAfterFirstDelete.ok).toBe(true);
		if (healthAfterFirstDelete.ok) {
			expect(healthAfterFirstDelete.value.pid).toBe(oldPid);
			expect(healthAfterFirstDelete.value.sharedRoots).toBe(2);
		}
		expect(isPidAlive(oldPid)).toBe(true);

		// Delete second temporary worktree: pruned (sharedRoots drops to 1), deadHandleCount=2 >= 2 -> idle sidecar recycles!
		fs.rmSync(wt2, { recursive: true, force: true });
		const healthTriggerRecycle = await backend.healthCheck(mainEnsure.root);
		expect(healthTriggerRecycle.ok).toBe(true);
		if (healthTriggerRecycle.ok) {
			expect(healthTriggerRecycle.value.sharedRoots).toBe(1);
		}

		// Immediately issue search/grep on main workspace (even racing the setImmediate exit) — must succeed transparently!
		const raceSearch = await backend.fileSearch(mainEnsure.root, "alpha.ts");
		expect(raceSearch.ok).toBe(true);
		if (raceSearch.ok) {
			expect(raceSearch.value.items.map((i) => i.relativePath)).toContain("src/alpha.ts");
		}

		expect(await waitForPidExit(oldPid)).toBe(true);

		const postRecycleGrep = await backend.grep(mainEnsure.root, "SHARED_MARKER_TOKEN", {
			mode: "plain",
		});
		expect(postRecycleGrep.ok).toBe(true);
		if (postRecycleGrep.ok) {
			expect(postRecycleGrep.value.items.length).toBeGreaterThan(0);
		}

		const newPid = trackPid(backend.getPid());
		expect(newPid).not.toBe(oldPid);
		expect(isPidAlive(newPid)).toBe(true);

		// Verify deleted worktrees were pruned from rememberedRoots and NOT resurrected on the recycled sidecar.
		const healthPostRecycle = await backend.healthCheck(mainEnsure.root);
		expect(healthPostRecycle.ok).toBe(true);
		if (healthPostRecycle.ok) {
			expect(healthPostRecycle.value.pid).toBe(newPid);
			expect(healthPostRecycle.value.sharedRoots).toBe(1);
		}
		await expect(backend.fileSearch(wt1Ensure.root, "alpha.ts")).rejects.toThrow(
			/FFF root not initialized/,
		);
		await expect(backend.fileSearch(wt2Ensure.root, "alpha.ts")).rejects.toThrow(
			/FFF root not initialized/,
		);
	});
});
