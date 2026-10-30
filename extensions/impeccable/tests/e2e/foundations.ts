import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import type { BrowserContext } from "playwright-core";
import { ENGINE_VERSION, parseChecksums, resolveEngine, runEngine, sha256 } from "../../src/engine.ts";
import { getChecksumsPath } from "../../src/resources.ts";

export const exec = promisify(execFile);
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Bound the CLI and its downloader descendants, including on timeout. */
async function installBrowser(env: NodeJS.ProcessEnv) {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.resolve("playwright-core"))), "install", "--only-shell", "chromium"], { env: { ...env, NODE_OPTIONS: `--require=${JSON.stringify(fileURLToPath(new URL("./browser-installer.cjs", import.meta.url)))}` }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		let output = "", timedOut = false;
		const kill = () => { if (!child.pid) return; try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") output += String(error); } };
		const timer = setTimeout(() => { timedOut = true; kill(); }, 600_000);
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (data: Buffer) => { output = (output + data.toString()).slice(-32_000); });
		child.on("error", (error) => { clearTimeout(timer); kill(); reject(error); });
		child.on("close", (code) => { clearTimeout(timer); if (code === 0 && !timedOut) resolve(); else { kill(); reject(new Error(`Chromium installer ${timedOut ? "timed out after 10m" : `exited ${code}`}: ${output}`)); } });
	});
}

/** Test-owned home, cache, browser profile and allowlisted child environment. No ambient engine override. */
export async function foundations() {
	if (process.env.IMPECCABLE_BIN?.trim()) throw new Error("Unset IMPECCABLE_BIN: visual foundations verifies the managed pinned engine, not a trusted override.");
	const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-impeccable-visual-")));
	const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "pi-impeccable-visual-receipts-"));
	const cache = path.join(os.tmpdir(), `pi-impeccable-visual-cache-${process.getuid?.() ?? "local"}`);
	const receipt: Record<string, unknown> = { simulated: ["faux model content", "local /api/roll catalog"], artifacts };
	let browser: BrowserContext | undefined;
	const save = () => fs.writeFile(path.join(artifacts, "receipt.json"), JSON.stringify(receipt, null, 2));
	try {
		await fs.mkdir(cache, { recursive: true, mode: 0o700 });
		const cacheStat = await fs.lstat(cache);
		if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || (cacheStat.mode & 0o077) !== 0 || process.getuid && cacheStat.uid !== process.getuid()) throw new Error(`Private test cache must be an owned mode-0700 directory: ${cache}`);
		const hostPath = process.env.PATH, systemRoot = process.env.SystemRoot;
		for (const key of Object.keys(process.env)) vi.stubEnv(key, undefined);
		const env: NodeJS.ProcessEnv = {
			PATH: hostPath, SystemRoot: systemRoot,
			HOME: path.join(temp, "home"), USERPROFILE: path.join(temp, "home"),
			PI_CODING_AGENT_DIR: path.join(temp, "agent"),
			XDG_CONFIG_HOME: path.join(temp, "config"), XDG_CACHE_HOME: path.join(temp, "cache"),
			IMPECCABLE_HOME: path.join(cache, "engine"), PLAYWRIGHT_BROWSERS_PATH: path.join(cache, "browsers"),
			TMPDIR: temp, TMP: temp, TEMP: temp,
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(temp, "gitconfig"),
			IMPECCABLE_NO_STALENESS_CHECK: "1", IMPECCABLE_NO_TELEMETRY: "1", PLAYWRIGHT_SKIP_BROWSER_GC: "1",
		};
		for (const key of ["HOME", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "IMPECCABLE_HOME", "PLAYWRIGHT_BROWSERS_PATH"]) await fs.mkdir(env[key]!, { recursive: true, mode: 0o700 });
		for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
		try { receipt.git = (await exec("git", ["--version"], { env, timeout: 5_000 })).stdout.trim(); }
		catch (error) { throw new Error(`Install Git before running visual foundations: ${String(error)}`); }
		if (Number(process.versions.node.split(".")[0]) >= 26 && process.platform !== "win32") {
			try { await exec("unzip", ["-v"], { env, timeout: 5_000 }); }
			catch (error) { throw new Error(`Node 26 browser acquisition requires POSIX unzip; install unzip or use Node 22/24 LTS. ${String(error)}`); }
		}
		receipt.installer = { node: process.version, extraction: Number(process.versions.node.split(".")[0]) >= 26 && process.platform !== "win32" ? "POSIX unzip compatibility preload" : "Playwright bundled extractor" };
		// Import only after setting the private browser cache, including for the CLI child.
		const { chromium } = await import("playwright-core");
		// The pinned CLI checks its managed revision markers and downloads only when absent.
		process.stdout.write("Visual foundations: acquiring private managed Chromium headless shell.\n");
		try { await installBrowser(env); }
		catch (error) { throw new Error(`Managed test Chromium acquisition failed. Check release-download network access and host browser prerequisites: ${String(error)}`); }
		try { browser = await chromium.launchPersistentContext(path.join(temp, "profile"), { headless: true, env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")), viewport: { width: 1440, height: 1000 } }); }
		catch (error) { throw new Error(`Managed Chromium launch failed; install the host's Playwright Chromium system libraries, then rerun test:impeccable:visual-foundations. ${String(error)}`); }
		receipt.browser = { playwrightCore: "1.56.1", version: browser.browser()!.version(), managedEngine: "Chromium headless shell", cache: env.PLAYWRIGHT_BROWSERS_PATH, isolatedProfile: path.join(temp, "profile") };
		const page = await browser.newPage();
		await page.setContent("<title>Isolated Chromium smoke</title><button>Verify browser</button>");
		await page.getByRole("button", { name: "Verify browser" }).click();
		expect(await page.title()).toBe("Isolated Chromium smoke");
		await page.screenshot({ path: path.join(artifacts, "browser-smoke.png") });
		await page.close(); await save();
		process.stdout.write("Visual foundations: real Chromium smoke passed; acquiring and probing verified engine (120s bound, download included).\n");
		const options = { binary: "", cacheRoot: env.IMPECCABLE_HOME!, env, timeoutMs: 120_000 };
		const started = Date.now();
		receipt.engineAcquisition = { phase: "managed download and engine-probe", timeoutMs: options.timeoutMs, startedAt: new Date(started).toISOString() }; await save();
		const acquisition = await runEngine({ ...options, cwd: temp, argv: ["engine-probe"] });
		receipt.engineAcquisition = { ...receipt.engineAcquisition as object, elapsedMs: Date.now() - started, result: acquisition }; await save();
		try {
			expect(acquisition, `${acquisition.status}: ${acquisition.message ?? ""} ${acquisition.stderr}`).toMatchObject({ ok: true, status: "success", exitCode: 0, trustedOverride: false, stdoutTruncated: false, stderrTruncated: false });
			expect(acquisition.stdout.trim()).toBe(`impeccable-engine ${ENGINE_VERSION}`);
		} catch (error) {
			throw new Error(`Managed native engine acquisition/probe failed (${acquisition.status}, ${acquisition.kind ?? "no detail"}; 120s bound including download). Check access to https://github.com/pbakaus/impeccable/releases/download and the private engine cache permissions, then rerun test:impeccable:visual-foundations. ${String(error)}`);
		}
		// Normally a cache hit after the bounded probe; also bound any unexpected re-acquisition.
		let resolved;
		try { resolved = await resolveEngine({ ...options, signal: AbortSignal.timeout(30_000) }); }
		catch (error) { throw new Error(`Managed native engine cache verification failed (30s bound). Check private engine cache permissions and release-download access, then rerun test:impeccable:visual-foundations. ${String(error)}`); }
		expect(resolved.binary).toBe(acquisition.binary);
		expect(resolved.trustedOverride).toBe(false); expect(resolved.asset).not.toBeNull();
		const digest = sha256(await fs.readFile(resolved.binary));
		expect(digest).toBe(parseChecksums(await fs.readFile(getChecksumsPath(), "utf8"), ENGINE_VERSION).get(resolved.asset!));
		const native = async (cwd: string, argv: string[]) => {
			const result = await runEngine({ ...options, timeoutMs: 30_000, cwd, argv });
			expect(result, `${argv.join(" ")}: ${result.message ?? ""} ${result.stderr}`).toMatchObject({ ok: true, trustedOverride: false, stdoutTruncated: false, stderrTruncated: false });
			return result.stdout;
		};
		const probe = acquisition.stdout.trim();
		receipt.engine = { asset: resolved.asset, sha256: digest, probe }; await save();
		return { temp, artifacts, receipt, save, env, browser, native,
			async cleanup() {
				const failures: unknown[] = []; let projectRemoved = false;
				try { await browser!.close(); expect(browser!.browser()?.isConnected() ?? false).toBe(false); } catch (error) { failures.push(error); }
				try { await fs.rm(temp, { recursive: true, force: true }); await expect(fs.stat(temp)).rejects.toMatchObject({ code: "ENOENT" }); projectRemoved = true; } catch (error) { failures.push(error); }
				const screenshots: Record<string, string> = {};
				try {
					for (const file of await fs.readdir(artifacts)) if (file.endsWith(".png")) screenshots[file] = sha256(await fs.readFile(path.join(artifacts, file)));
					receipt.screenshotSha256 = screenshots;
					receipt.cleanup = { browserClosed: !(browser!.browser()?.isConnected() ?? false), privateHomeProfileProjectRemoved: projectRemoved, retainedPrivateTestCache: cache };
					await save();
				} catch (error) { failures.push(error); }
				vi.unstubAllEnvs(); process.stdout.write(`Visual foundations receipts: ${artifacts}\n${JSON.stringify({ engine: receipt.engine, browser: receipt.browser, cleanup: receipt.cleanup })}\n`);
				if (failures.length) throw new AggregateError(failures, "Visual foundations cleanup failed");
			},
		};
	} catch (error) {
		receipt.failure = String(error);
		const failures: unknown[] = [error]; let browserClosed = !browser, projectRemoved = false;
		try { await browser?.close(); browserClosed = !(browser?.browser()?.isConnected() ?? false); } catch (cleanupError) { failures.push(cleanupError); }
		try { await fs.rm(temp, { recursive: true, force: true }); projectRemoved = true; } catch (cleanupError) { failures.push(cleanupError); }
		receipt.cleanup = { browserClosed, privateHomeProfileProjectRemoved: projectRemoved, retainedPrivateTestCache: cache };
		try { await save(); } finally { vi.unstubAllEnvs(); }
		throw new Error(`Visual foundations prerequisite failed; receipts: ${artifacts}. ${failures.map(String).join("; ")}`);
	}
}
