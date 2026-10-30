import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ENGINE_VERSION, getChecksumsPath, getLauncherPath, getSkillDir } from "./resources.ts";

/**
 * Managed engine runner.
 *
 * `runEngine` is the typed entry point used by the `impeccable_run` tool and by
 * the later hook/live integrations: it resolves a pinned, verified engine binary
 * (a deliberately trusted override, a verified cache entry, or a verified
 * download), spawns it with a direct argv array and the upstream
 * `IMPECCABLE_SKILL_DIR`/`IMPECCABLE_SELF` context, and returns a structured,
 * bounded result. Nothing here fetches or spawns at module load.
 */

export { ENGINE_VERSION };

/** Upstream release channel; overridable via `IMPECCABLE_DOWNLOAD_BASE` for hermetic tests. */
export const DEFAULT_DOWNLOAD_BASE = "https://github.com/pbakaus/impeccable/releases/download";
/** Default wall-clock bound for one engine invocation (download included). */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Hard memory bound per captured stream; output beyond this is counted but not stored. */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
/** Model-facing output limits, matching Pi's built-in tool conventions. */
export const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_RESULT_LINES = 2000;

/** Checksums keyed by released asset name (`impeccable-darwin-arm64`, …). */
export type Checksums = ReadonlyMap<string, string>;

export type EngineStatus =
	| "success" // exit 0, output within bounds
	| "findings" // detector exit 2, output within bounds
	| "truncated" // exited 0 (or detector findings) but output overflowed the bounds
	| "timeout" // killed for exceeding timeoutMs
	| "cancelled" // killed by an external abort signal
	| "unavailable" // prerequisite missing: download, cache, checksum, or platform
	| "error"; // any other nonzero exit or spawn failure

export type EngineUnavailableKind =
	| "unsupported-platform"
	| "no-checksums"
	| "no-checksum"
	| "override-invalid"
	| "cache-unwritable"
	| "cache-mismatch"
	| "download-failed"
	| "empty-download"
	| "checksum-mismatch"
	| "chmod-failed"
	| "rename-failed";

export class EngineUnavailableError extends Error {
	readonly kind: EngineUnavailableKind;
	constructor(kind: EngineUnavailableKind, message: string) {
		super(message);
		this.name = "EngineUnavailableError";
		this.kind = kind;
	}
}

export interface ResolvedEngine {
	/** Absolute path of the engine binary that will run. */
	binary: string;
	/** True when the binary came from the deliberate trusted override (IMPECCABLE_BIN). */
	trustedOverride: boolean;
	/** Released asset name (`impeccable-darwin-arm64`, …), null for an override. */
	asset: string | null;
	/** Cache path this asset resolves to, null for an override. */
	cachePath: string | null;
	/** The cache root in effect for this resolution. */
	cacheRoot: string;
}

export interface EngineRunResult {
	ok: boolean;
	status: EngineStatus;
	/** Unavailable-kind (and a few other) detail for callers that need it. */
	kind?: EngineUnavailableKind;
	message?: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	findings: boolean;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	binary: string;
	cwd: string;
	argv: readonly string[];
	trustedOverride: boolean;
}

export interface ResolveEngineOptions {
	/** Deliberate trusted binary override (upstream `IMPECCABLE_BIN` semantics). */
	binary?: string;
	/** Cache root (upstream `IMPECCABLE_HOME` semantics). */
	cacheRoot?: string;
	/** Download base URL (upstream `IMPECCABLE_DOWNLOAD_BASE` semantics). */
	downloadBase?: string;
	/** Asset digests; defaults to the installed `engine-checksums.txt`. */
	checksums?: Checksums;
	platform?: NodeJS.Platform;
	arch?: string;
	signal?: AbortSignal;
}

export interface RunEngineOptions extends ResolveEngineOptions {
	argv: readonly string[];
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	/** Direct UTF-8 hook envelope, bounded before engine resolution. */
	stdin?: string;
}

/** Human-readable release asset for a platform/arch pair, or null when unsupported. */
export interface PlatformAsset {
	os: "darwin" | "linux" | "windows";
	arch: "arm64" | "x64";
	/** Released asset name recorded in engine-checksums.txt. */
	asset: string;
}

export function platformAsset(platform: NodeJS.Platform, arch: string): PlatformAsset | null {
	let os: PlatformAsset["os"];
	if (platform === "darwin") os = "darwin";
	else if (platform === "linux") os = "linux";
	else if (platform === "win32") os = "windows";
	else return null;

	let normalized: PlatformAsset["arch"];
	if (arch === "arm64") normalized = "arm64";
	else if (arch === "x64") normalized = "x64";
	else return null;

	// Upstream's documented fallback: Windows on ARM runs the x64 binary.
	const assetArch = os === "windows" && normalized === "arm64" ? "x64" : normalized;
	const suffix = os === "windows" ? ".exe" : "";
	return { os, arch: normalized, asset: `impeccable-${os}-${assetArch}${suffix}` };
}

/** Parses an `engine-checksums.txt` manifest, returning asset -> sha256 for `version`. */
export function parseChecksums(text: string, version: string): Checksums {
	const map = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const [entryVersion, asset, digest] = line.split(/\s+/);
		if (entryVersion === version && asset && digest) map.set(asset, digest.toLowerCase());
	}
	return map;
}

export function sha256(buffer: Uint8Array): string {
	return createHash("sha256").update(buffer).digest("hex");
}

async function isFile(binary: string): Promise<boolean> {
	try {
		return (await stat(binary)).isFile();
	} catch {
		return false;
	}
}

async function isExecutable(binary: string): Promise<boolean> {
	try {
		await access(binary, process.platform === "win32" ? 0 : 1 /* X_OK */);
		return true;
	} catch {
		return false;
	}
}

function envValue(name: string, fallback: string): string {
	const value = process.env[name];
	return value && value.trim() !== "" ? value : fallback;
}

/**
 * Resolve and verify the engine binary for this platform. Selection order:
 * deliberate trusted override, verified version-pinned cache, verified download.
 * Ambient executables (PATH, unversioned home binary) are never selected.
 */
export async function resolveEngine(options: ResolveEngineOptions = {}): Promise<ResolvedEngine> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;

	let checksums = options.checksums;
	if (!checksums) {
		let text: string;
		try {
			text = await readFile(getChecksumsPath(), "utf8");
		} catch {
			throw new EngineUnavailableError(
				"no-checksums",
				`impeccable: cannot read the engine checksum manifest ${getChecksumsPath()}; refusing to run an unverified engine.`,
			);
		}
		checksums = parseChecksums(text, ENGINE_VERSION);
		if (checksums.size === 0) {
			throw new EngineUnavailableError(
				"no-checksums",
				`impeccable: no checksums for engine ${ENGINE_VERSION} in ${getChecksumsPath()}; refusing to run an unverified engine.`,
			);
		}
	}

	// Deliberate trusted override, consistent with upstream IMPECCABLE_BIN: exec'd
	// without a digest check, but reported as unverified so callers know its
	// version is not confirmed against engine-checksums.txt.
	const override = options.binary ?? envValue("IMPECCABLE_BIN", "");
	if (override !== "") {
		const binary = path.resolve(override);
		if (!(await isFile(binary)) || !(await isExecutable(binary))) {
			throw new EngineUnavailableError(
				"override-invalid",
				`impeccable: IMPECCABLE_BIN override ${binary} is not an executable file; refusing to run it.`,
			);
		}
		const cacheRoot = options.cacheRoot ?? envValue("IMPECCABLE_HOME", path.join(os.homedir(), ".impeccable"));
		return { binary, trustedOverride: true, asset: null, cachePath: null, cacheRoot };
	}

	const selected = platformAsset(platform, arch);
	if (!selected) {
		throw new EngineUnavailableError(
			"unsupported-platform",
			`impeccable: no engine asset for ${platform}-${arch}; supported platforms are darwin arm64/x64, linux arm64/x64, and windows x64 (windows arm64 runs the x64 asset).`,
		);
	}
	const expected = checksums.get(selected.asset);
	if (!expected) {
		throw new EngineUnavailableError(
			"no-checksum",
			`impeccable: no checksum for engine ${ENGINE_VERSION} asset ${selected.asset} in the manifest; refusing the unverified download.`,
		);
	}

	const cacheRoot = options.cacheRoot ?? envValue("IMPECCABLE_HOME", path.join(os.homedir(), ".impeccable"));
	const cacheDir = path.join(cacheRoot, "bin", ENGINE_VERSION);
	const cachePath = path.join(cacheDir, selected.asset);
	const verifiedPath = `${cachePath}.verified`;

	// Verified cache fast path: a `.verified` stamp recording the digest we
	// checked means a later run skips re-hashing, as upstream does for hooks.
	if (await isFile(cachePath)) {
		try {
			if ((await readFile(verifiedPath, "utf8")).trim().toLowerCase() === expected) {
				return { binary: cachePath, trustedOverride: false, asset: selected.asset, cachePath, cacheRoot };
			}
		} catch {
			// No valid stamp; fall through to the digest check below.
		}
		let actual: string;
		try {
			actual = sha256(await readFile(cachePath));
		} catch {
			throw new EngineUnavailableError(
				"cache-mismatch",
				`impeccable: cannot read the cached engine ${cachePath}; refusing to run it unverified.`,
			);
		}
		if (actual !== expected) {
			throw new EngineUnavailableError(
				"cache-mismatch",
				`impeccable: cached engine ${cachePath} does not match the manifest checksum for ${ENGINE_VERSION} ${selected.asset}; remove it and retry, or set IMPECCABLE_BIN to a trusted engine.`,
			);
		}
		await writeFile(verifiedPath, `${actual}\n`, "utf8").catch(() => {});
		return { binary: cachePath, trustedOverride: false, asset: selected.asset, cachePath, cacheRoot };
	}

	// Download into the version-pinned cache atomically, verify, then run.
	await mkdir(cacheDir, { recursive: true }).catch(() => {
		throw new EngineUnavailableError(
			"cache-unwritable",
			`impeccable: engine ${ENGINE_VERSION} is not installed and the cache directory ${cacheDir} cannot be created; choose a writable IMPECCABLE_HOME or repair its permissions and retry.`,
		);
	});
	const downloadBase = (options.downloadBase ?? envValue("IMPECCABLE_DOWNLOAD_BASE", DEFAULT_DOWNLOAD_BASE)).replace(/\/+$/, "");
	const url = `${downloadBase}/engine-v${ENGINE_VERSION}/${selected.asset}`;
	const staging = path.join(cacheDir, `.impeccable.part.${randomBytes(8).toString("hex")}`);
	try {
		let response: Response;
		try {
			response = await fetch(url, { signal: options.signal, redirect: "follow" });
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new EngineUnavailableError(
				"download-failed",
				`impeccable: could not download engine ${ENGINE_VERSION} from ${url}; check network access and the release URL.`,
			);
		}
		if (!response.ok) {
			throw new EngineUnavailableError(
				"download-failed",
				`impeccable: could not download engine ${ENGINE_VERSION} from ${url} (HTTP ${response.status}).`,
			);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength === 0) {
			throw new EngineUnavailableError(
				"empty-download",
				`impeccable: downloaded file is empty: ${url}; refusing the unverified download.`,
			);
		}
		const actual = sha256(bytes);
		if (actual !== expected) {
			throw new EngineUnavailableError(
				"checksum-mismatch",
				`impeccable: checksum mismatch downloading ${url}; refusing the unverified download.`,
			);
		}
		await writeFile(staging, bytes, { mode: 0o755 });
		if (process.platform !== "win32") {
			try {
				await chmod(staging, 0o755);
			} catch {
				throw new EngineUnavailableError(
					"chmod-failed",
					`impeccable: could not make the verified download executable: ${url}.`,
				);
			}
		}
		try {
			await rename(staging, cachePath);
		} catch (error) {
			if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			throw new EngineUnavailableError(
				"rename-failed",
				`impeccable: could not cache the verified download: ${url}.`,
			);
		}
		await writeFile(verifiedPath, `${actual}\n`, "utf8").catch(() => {});
		return { binary: cachePath, trustedOverride: false, asset: selected.asset, cachePath, cacheRoot };
	} catch (error) {
		if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
			throw new EngineUnavailableError(
				"cache-unwritable",
				`impeccable: cannot write or rename the engine in cache directory ${cacheDir}; choose a writable IMPECCABLE_HOME or repair the directory permissions and retry.`,
			);
		}
		throw error;
	} finally {
		await rm(staging, { force: true }).catch(() => {});
	}
}

/** Bounded in-memory capture of one process stream. */
export class BoundedOutput {
	private readonly chunks: Buffer[] = [];
	private storedBytes = 0;
	private totalBytes = 0;
	private overflowed = false;
	constructor(readonly maxBytes: number) {}

	get truncated(): boolean {
		return this.overflowed;
	}

	push(chunk: Buffer): void {
		this.totalBytes += chunk.length;
		if (this.overflowed) return;
		if (this.storedBytes + chunk.length > this.maxBytes) {
			const keep = this.maxBytes - this.storedBytes;
			if (keep > 0) this.chunks.push(chunk.subarray(0, keep));
			this.storedBytes += keep;
			this.overflowed = true;
			return;
		}
		this.chunks.push(chunk);
		this.storedBytes += chunk.length;
	}

	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

/** Head-truncate text to whole-line bounds; returns the kept text and truncation info. */
export function truncateText(
	text: string,
	maxBytes: number,
	maxLines: number,
): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	if (lines.length <= maxLines && Buffer.byteLength(text, "utf8") <= maxBytes) {
		return { text, truncated: false };
	}
	const kept: string[] = [];
	let bytes = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const withNewline = i < lines.length - 1 ? `${line}\n` : line;
		const lineBytes = Buffer.byteLength(withNewline, "utf8");
		if (i + 1 > maxLines) break;
		if (bytes + lineBytes > maxBytes) break;
		kept.push(withNewline);
		bytes += lineBytes;
	}
	return { text: kept.join(""), truncated: true };
}

export interface EngineProcess {
	readonly child: ChildProcess;
	readonly binary: string;
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly stdout: BoundedOutput;
	readonly stderr: BoundedOutput;
	readonly spawnError: Error | undefined;
	/** Resolves once the child has exited or failed to spawn. */
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	/** Idempotent kill of the child (process group on POSIX). */
	cancel(reason?: "cancelled" | "timeout"): void;
	readonly reason: "cancelled" | "timeout" | undefined;
}

export interface SpawnEngineOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdin?: string;
}

/** Spawn the resolved engine with a direct argv array (never a shell string). */
export function spawnEngine(resolved: ResolvedEngine, argv: readonly string[], options: SpawnEngineOptions = {}): EngineProcess {
	if (options.stdin !== undefined && Buffer.byteLength(options.stdin) > 2 * 1024 * 1024) throw new Error("Engine stdin exceeds 2 MiB");
	const cwd = options.cwd ?? process.cwd();
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...options.env,
		// Upstream launcher exports these before exec'ing the engine so emitted
		// references and native-platform guidance resolve to real installed files.
		IMPECCABLE_SKILL_DIR: getSkillDir(),
		IMPECCABLE_SELF: getLauncherPath(),
		IMPECCABLE_PROVIDER_ID: "pi",
	};

	const child = spawn(resolved.binary, [...argv], {
		cwd,
		env,
		stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});

	child.stdin?.on("error", () => { /* EPIPE is represented by the process outcome. */ });
	child.stdin?.end(options.stdin);
	const stdout = new BoundedOutput(MAX_CAPTURE_BYTES);
	const stderr = new BoundedOutput(MAX_CAPTURE_BYTES);
	child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

	let spawnError: Error | undefined;
	let reason: "cancelled" | "timeout" | undefined;
	let settleExit!: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		settleExit = resolve;
	});

	child.on("error", (error) => {
		spawnError = error;
	});
	child.on("close", (code, signal) => {
		settleExit({ code, signal });
	});

	function killTree(): void {
		const pid = child.pid;
		if (pid == null) return;
		if (process.platform !== "win32") {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				// Group may already be gone; fall back to the child alone.
				try {
					child.kill("SIGTERM");
				} catch {
					/* already dead */
				}
			}
			const killer = setTimeout(() => {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					try {
						child.kill("SIGKILL");
					} catch {
						/* already dead */
					}
				}
			}, 1_000);
			killer.unref?.();
		} else {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already dead */
			}
		}
	}

	return {
		child,
		binary: resolved.binary,
		argv,
		cwd,
		stdout,
		stderr,
		get spawnError() {
			return spawnError;
		},
		exited,
		cancel(next = "cancelled") {
			if (reason === undefined) {
				reason = next;
				killTree();
			}
		},
		get reason() {
			return reason;
		},
	};
}

const isDetector = (argv: readonly string[]) => argv[0] === "detect";

async function resolveCwd(cwd: string | undefined): Promise<{ cwd: string } | { error: string }> {
	const resolved = path.resolve(cwd ?? process.cwd());
	try {
		if (!(await stat(resolved)).isDirectory()) return { error: `cwd is not a directory: ${resolved}` };
		return { cwd: resolved };
	} catch {
		return { error: `cwd does not exist or is not accessible: ${resolved}` };
	}
}

function unavailableResult(options: RunEngineOptions, cwd: string, kind: EngineUnavailableKind, message: string): EngineRunResult {
	return {
		ok: false,
		status: "unavailable",
		kind,
		message,
		exitCode: null,
		signal: null,
		findings: false,
		stdout: "",
		stderr: "",
		stdoutTruncated: false,
		stderrTruncated: false,
		binary: "",
		cwd,
		argv: options.argv,
		trustedOverride: false,
	};
}

/**
 * Resolve, spawn, and settle one engine invocation. A timeout or abort signal
 * bounds the download and the process; both kill the child (process group on
 * POSIX) so nothing is left hanging. Excess output is captured to a hard memory
 * bound and never presented as a complete success.
 */
export async function runEngine(options: RunEngineOptions): Promise<EngineRunResult> {
	if (options.stdin !== undefined && Buffer.byteLength(options.stdin) > 2 * 1024 * 1024) throw new Error("Engine stdin exceeds 2 MiB");
	const cwdResult = await resolveCwd(options.cwd);
	if ("error" in cwdResult) {
		return {
			ok: false,
			status: "error",
			message: cwdResult.error,
			exitCode: null,
			signal: null,
			findings: false,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			binary: "",
			cwd: path.resolve(options.cwd ?? process.cwd()),
			argv: options.argv,
			trustedOverride: false,
		};
	}
	const cwd = cwdResult.cwd;

	const controller = new AbortController();
	let reason: "cancelled" | "timeout" | undefined;
	const onAbort = () => {
		if (reason === undefined) {
			reason = "cancelled";
			controller.abort();
		}
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted && reason === undefined) {
		reason = "cancelled";
		controller.abort();
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timer = setTimeout(() => {
		if (reason === undefined) {
			reason = "timeout";
			controller.abort();
		}
	}, timeoutMs);
	timer.unref?.();

	try {
		let resolved: ResolvedEngine;
		try {
			if (controller.signal.aborted) throw new Error("Engine setup cancelled");
			resolved = await resolveEngine({ ...options, signal: controller.signal });
		} catch (error) {
			if (controller.signal.aborted) {
				return {
					ok: false,
					status: reason === "timeout" ? "timeout" : "cancelled",
					message: reason === "timeout" ? `engine setup did not finish within ${timeoutMs} ms` : "engine setup was cancelled",
					exitCode: null,
					signal: null,
					findings: false,
					stdout: "",
					stderr: "",
					stdoutTruncated: false,
					stderrTruncated: false,
					binary: "",
					cwd,
					argv: options.argv,
					trustedOverride: false,
				};
			}
			if (error instanceof EngineUnavailableError) {
				return unavailableResult(options, cwd, error.kind, error.message);
			}
			return {
				ok: false,
				status: "error",
				message: `engine setup failed: ${String(error)}`,
				exitCode: null,
				signal: null,
				findings: false,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				binary: "",
				cwd,
				argv: options.argv,
				trustedOverride: false,
			};
		}

		if (controller.signal.aborted) return {
			ok: false, status: reason === "timeout" ? "timeout" : "cancelled", exitCode: null, signal: null, findings: false,
			stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, binary: resolved.binary, cwd,
			argv: options.argv, trustedOverride: resolved.trustedOverride, message: "Engine cancelled before spawn",
		};
		const proc = spawnEngine(resolved, options.argv, { cwd, env: options.env, stdin: options.stdin });
		const onAborted = () => proc.cancel(reason ?? "cancelled");
		controller.signal.addEventListener("abort", onAborted, { once: true });
		if (controller.signal.aborted) proc.cancel(reason ?? "cancelled");

		const exit = await proc.exited;
		controller.signal.removeEventListener("abort", onAborted);

		const stdout = truncateText(proc.stdout.text(), MAX_RESULT_BYTES, MAX_RESULT_LINES);
		const stderr = truncateText(proc.stderr.text(), MAX_RESULT_BYTES, MAX_RESULT_LINES);
		const stdoutTruncated = proc.stdout.truncated || stdout.truncated;
		const stderrTruncated = proc.stderr.truncated || stderr.truncated;

		let status: EngineStatus;
		let message: string | undefined;
		if (proc.spawnError) {
			status = "error";
			message = `could not run ${resolved.binary}: ${proc.spawnError.message}`;
		} else if (reason === "timeout") {
			status = "timeout";
			message = `engine did not exit within ${timeoutMs} ms`;
		} else if (reason === "cancelled") {
			status = "cancelled";
			message = "engine run was cancelled";
		} else if (exit.signal) {
			status = "error";
			message = `engine terminated by signal ${exit.signal}`;
		} else if (exit.code === 0) {
			status = "success";
		} else if (exit.code === 2 && isDetector(options.argv)) {
			status = "findings";
		} else {
			status = "error";
			message = `engine exited with code ${exit.code ?? "null"}`;
		}

		if ((status === "success" || status === "findings") && (stdoutTruncated || stderrTruncated)) {
			status = "truncated";
		}

		return {
			ok: status === "success" || status === "findings",
			status,
			message,
			exitCode: exit.code,
			signal: exit.signal,
			findings: status === "findings",
			stdout: stdout.text,
			stderr: stderr.text,
			stdoutTruncated,
			stderrTruncated,
			binary: resolved.binary,
			cwd,
			argv: options.argv,
			trustedOverride: resolved.trustedOverride,
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
