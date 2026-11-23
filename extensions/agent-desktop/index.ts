import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const AGENT_DESKTOP_STATUS_KEY = "agent-desktop";
export const AGENT_DESKTOP_SHARED_KEY = Symbol.for("pi-extensions.agent-desktop");
export const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");

const DEFAULT_TIMEOUT_MS = 120_000;
const EXIT_STDIO_GRACE_MS = 100;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_RESULT_LINES = 2000;

export const INSTALL_HINT =
	"agent-desktop binary is unavailable. Run npm ci in pi-extensions or set AGENT_DESKTOP_BIN.";

export const PHYSICAL_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"double-click",
	"triple-click",
	"hover",
	"drag",
	"mouse-move",
	"mouse-click",
	"mouse-down",
	"mouse-up",
	"mouse-wheel",
	"key-down",
	"key-up",
]);

export const META_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"status",
	"permissions",
	"version",
	"skills",
	"help",
	"--help",
	"-h",
	"--version",
	"-V",
]);

export interface ChildSessionHook {
	name: string;
	extensionFactory: (pi: ExtensionAPI) => void;
}

interface AgentDesktopSharedState {
	openInstances: Set<object>;
	hook?: ChildSessionHook;
}

export type AgentDesktopRunStatus =
	| "success"
	| "truncated"
	| "timeout"
	| "cancelled"
	| "unavailable"
	| "error";

export interface AgentDesktopImage {
	data: string;
	mimeType: string;
	path: string;
}

export interface AgentDesktopRunResult {
	ok: boolean;
	status: AgentDesktopRunStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	binary: string;
	cwd: string;
	argv: readonly string[];
	session: string;
	headed: boolean;
	subcommand?: string;
	message?: string;
	image?: AgentDesktopImage;
}

export interface RunAgentDesktopOptions {
	argv: readonly string[];
	headed?: boolean;
	stdin?: string;
	cwd?: string;
	session?: string;
	timeoutMs?: number;
	binary?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export interface ParsedAgentDesktopArgv {
	explicitSession?: string;
	hasHeadedFlag: boolean;
	hasStdinFlag: boolean;
	subcommand?: string;
	sessionAction?: string;
	sessionTargetId?: string;
	screenshotPath?: string;
}

export interface ResolvedBundledAgentDesktop {
	binary: string;
	macosHelperPath?: string;
}

interface AgentDesktopPlatformEntry {
	target: string;
	binaryName: string;
	entries: string[];
	released: boolean;
}

interface AgentDesktopPlatformModule {
	MACOS_HELPER_NAME: string;
	resolve(osPlatform: string, osArch: string): AgentDesktopPlatformEntry | undefined;
	helperNames(entry: AgentDesktopPlatformEntry): string[];
}

const GLOBAL_VALUE_FLAGS = new Set([
	"--session",
	"--agent-id",
	"--trace",
	"--wait-for",
	"-w",
	"--wait-for-gone",
	"--wait-timeout",
	"--screenshot",
]);

const SCREENSHOT_VALUE_FLAGS = new Set([
	"--app",
	"--window-id",
	"--screen",
	"--format",
	"--quality",
]);

const HELP_OR_VERSION_SUBCOMMANDS = new Set(["--help", "-h", "--version", "-V"]);

const USAGE_MESSAGE =
	"Usage: /agent-desktop [status | close | permissions [--guide|--request] | doctor]";

const boundApis = new WeakSet<ExtensionAPI>();

function normalizeOptionalString(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.toLowerCase() === "none") return undefined;
	return trimmed;
}

function normalizeOptionalCwd(value: string | undefined): string | undefined {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return undefined;
	const stripped = normalized.replace(/^@/, "").trim();
	if (stripped.length === 0 || stripped.toLowerCase() === "none") return undefined;
	return stripped;
}

function normalizeOptionalStdin(value: string | undefined): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value;
}

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

function clampTimeoutMs(value: number): number | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(value)));
}

function normalizeTimeoutMs(value: number | undefined): number {
	if (typeof value !== "number") return DEFAULT_TIMEOUT_MS;
	return clampTimeoutMs(value) ?? DEFAULT_TIMEOUT_MS;
}

function normalizeArgv(argv: readonly unknown[] | undefined): string[] {
	if (!Array.isArray(argv)) return [];
	return argv.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
}

function getSharedState(): AgentDesktopSharedState {
	const g = globalThis as Record<symbol, unknown>;
	let state = g[AGENT_DESKTOP_SHARED_KEY] as AgentDesktopSharedState | undefined;
	if (!state) {
		state = {
			openInstances: new Set<object>(),
		};
		g[AGENT_DESKTOP_SHARED_KEY] = state;
	}
	return state;
}

function getChildHooksSet(): Set<ChildSessionHook> {
	const g = globalThis as Record<symbol, unknown>;
	let hooks = g[CHILD_SESSION_HOOKS] as Set<ChildSessionHook> | undefined;
	if (!(hooks instanceof Set)) {
		hooks = new Set<ChildSessionHook>();
		g[CHILD_SESSION_HOOKS] = hooks;
	}
	return hooks;
}

function ensureChildSessionHook(active: boolean): void {
	const state = getSharedState();
	state.hook ??= { name: "agent-desktop", extensionFactory: agentDesktopExtension };
	const hooks = getChildHooksSet();
	if (active) {
		for (const item of [...hooks]) {
			if (item.name === "agent-desktop" && item !== state.hook) {
				hooks.delete(item);
			}
		}
		hooks.add(state.hook);
	} else {
		for (const item of [...hooks]) {
			if (item.name === "agent-desktop") {
				hooks.delete(item);
			}
		}
	}
}

export function deriveDesktopSessionId(ctx?: {
	sessionId?: string;
	sessionManager?: {
		getSessionId?: () => string | undefined;
		getSessionFile?: () => string | undefined;
	};
}): string {
	const fromManager = ctx?.sessionManager?.getSessionId?.();
	const fromCtx = ctx?.sessionId;
	const sessionFile = ctx?.sessionManager?.getSessionFile?.();
	const fromFile = sessionFile ? path.basename(sessionFile, path.extname(sessionFile)) : undefined;

	const raw = (fromManager || fromCtx || fromFile || "").trim();
	if (!raw) return "pi-default";

	const sanitized = raw
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");

	if (!sanitized) return "pi-default";
	return `pi-${sanitized}`;
}

export function parseAgentDesktopArgv(argv: readonly string[]): ParsedAgentDesktopArgv {
	let explicitSession: string | undefined;
	let hasHeadedFlag = false;
	let hasStdinFlag = false;
	let subcommand: string | undefined;
	let sessionAction: string | undefined;
	let sessionTargetId: string | undefined;
	let screenshotPath: string | undefined;
	let endOfFlags = false;
	let isHelp = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (typeof token !== "string" || token.trim().length === 0) {
			continue;
		}

		if (!endOfFlags) {
			if (token === "--") {
				endOfFlags = true;
				continue;
			}

			if (token === "--headed" || token.startsWith("--headed=")) {
				hasHeadedFlag = true;
				continue;
			}

			if (token === "--stdin" || token === "--stdin=true") {
				hasStdinFlag = true;
				continue;
			}

			if (token === "--session") {
				const next = argv[i + 1];
				const normalized = normalizeOptionalString(next);
				if (normalized !== undefined) {
					explicitSession = normalized;
				}
				i++;
				continue;
			}

			if (token.startsWith("--session=")) {
				const val = normalizeOptionalString(token.slice("--session=".length));
				if (val !== undefined) {
					explicitSession = val;
				}
				continue;
			}

			if (GLOBAL_VALUE_FLAGS.has(token)) {
				i++;
				continue;
			}

			if (subcommand === "screenshot" && SCREENSHOT_VALUE_FLAGS.has(token)) {
				i++;
				continue;
			}

			if (token === "--help" || token === "-h") {
				isHelp = true;
				subcommand = token;
				sessionAction = undefined;
				sessionTargetId = undefined;
				screenshotPath = undefined;
				continue;
			}

			if (subcommand === undefined && (token === "--version" || token === "-V")) {
				subcommand = token;
				continue;
			}

			if (token.startsWith("-")) {
				continue;
			}
		}

		if (isHelp) {
			continue;
		}

		if (subcommand === undefined) {
			subcommand = token;
			continue;
		}

		if (subcommand === "session") {
			if (sessionAction === undefined) {
				sessionAction = token;
				continue;
			}
			if (sessionAction === "end" && sessionTargetId === undefined) {
				sessionTargetId = token;
				continue;
			}
			continue;
		}

		if (subcommand === "screenshot" && screenshotPath === undefined) {
			screenshotPath = token;
		}
	}

	return {
		explicitSession,
		hasHeadedFlag,
		hasStdinFlag,
		subcommand,
		sessionAction,
		sessionTargetId,
		screenshotPath,
	};
}

class BoundedOutput {
	private chunks: Buffer[] = [];
	private storedBytes = 0;
	public totalBytes = 0;
	private readonly maxBytes: number;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	push(chunk: Buffer): void {
		this.totalBytes += chunk.length;
		const remaining = this.maxBytes - this.storedBytes;
		if (remaining <= 0) return;
		if (chunk.length <= remaining) {
			this.chunks.push(chunk);
			this.storedBytes += chunk.length;
		} else {
			this.chunks.push(chunk.subarray(0, remaining));
			this.storedBytes += remaining;
		}
	}

	get truncated(): boolean {
		return this.totalBytes > this.maxBytes;
	}

	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

function truncateText(
	input: string,
	maxBytes = MAX_RESULT_BYTES,
	maxLines = MAX_RESULT_LINES,
): { text: string; truncated: boolean } {
	let text = input;
	let truncated = false;
	const lines = text.split("\n");
	if (lines.length > maxLines) {
		text = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}
	const buf = Buffer.from(text, "utf8");
	if (buf.length > maxBytes) {
		text = buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
		truncated = true;
	}
	return { text, truncated };
}

function detectImageMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return "image/png";
}

export function formatDesktopStatus(activeSessions: ReadonlySet<string>): string | undefined {
	if (activeSessions.size === 0) return undefined;
	const list = [...activeSessions];
	if (list.length === 1) return `desktop: ${list[0]}`;
	return `desktop: ${list[0]} (+${list.length - 1})`;
}

function inspectJsonEnvelopeFailure(rawStdout: string): {
	failed: boolean;
	errorMessage?: string;
} {
	const trimmed = rawStdout.trim();
	if (!trimmed.startsWith("{")) {
		return { failed: false };
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;
			if (record.ok === false) {
				let errorMessage: string | undefined;
				const errField = record.error;
				if (typeof errField === "string" && errField.trim().length > 0) {
					errorMessage = errField.trim();
				} else if (errField !== null && typeof errField === "object") {
					const msg = (errField as Record<string, unknown>).message;
					if (typeof msg === "string" && msg.trim().length > 0) {
						errorMessage = msg.trim();
					}
				}
				if (!errorMessage && typeof record.message === "string" && record.message.trim().length > 0) {
					errorMessage = record.message.trim();
				}
				return { failed: true, errorMessage };
			}
		}
	} catch {
		// Ignore non-JSON or truncated stdout; fall back to exit code.
	}
	return { failed: false };
}

function extractStartedSessionId(stdout: string): string | undefined {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;
			const data = record.data;
			if (data !== null && typeof data === "object" && !Array.isArray(data)) {
				const rawId = (data as Record<string, unknown>).session_id;
				const sid = normalizeOptionalString(typeof rawId === "string" ? rawId : undefined);
				if (sid) return sid;
			}
			const topId = normalizeOptionalString(
				typeof record.session_id === "string" ? record.session_id : undefined,
			);
			if (topId) return topId;
		}
	} catch {
		// Ignore non-JSON stdout.
	}
	return undefined;
}

function ensurePosixExecutable(targetPath: string): void {
	try {
		accessSync(targetPath, constants.X_OK);
	} catch {
		try {
			chmodSync(targetPath, 0o755);
		} catch {
			// Ignore on read-only filesystems.
		}
	}
}

export function resolveBundledAgentDesktop(
	osPlatform: NodeJS.Platform = os.platform(),
	osArch: string = os.arch(),
): ResolvedBundledAgentDesktop | undefined {
	let pkgPath: string;
	let platformMod: AgentDesktopPlatformModule;
	try {
		const req = createRequire(import.meta.url);
		pkgPath = req.resolve("agent-desktop/package.json");
		platformMod = req("agent-desktop/lib/platform") as AgentDesktopPlatformModule;
	} catch {
		return undefined;
	}

	const entry = platformMod.resolve(osPlatform, osArch);
	if (!entry?.released) {
		return undefined;
	}

	const binDir = path.join(path.dirname(pkgPath), "bin");
	const platformKey = `${osPlatform}-${osArch}`;
	const binaryPath = path.join(binDir, entry.binaryName);
	if (!existsSync(binaryPath)) {
		return undefined;
	}

	if (osPlatform !== "win32") {
		ensurePosixExecutable(binaryPath);
	}

	let macosHelperPath: string | undefined;
	const [helperName] = platformMod.helperNames(entry);
	if (helperName) {
		const installedHelper = path.join(binDir, helperName);
		const bundledHelper = path.join(binDir, `${helperName}-${platformKey}`);

		if (osPlatform !== "win32") {
			if (existsSync(installedHelper)) {
				ensurePosixExecutable(installedHelper);
			}
			if (existsSync(bundledHelper)) {
				ensurePosixExecutable(bundledHelper);
			}
		}

		if (!existsSync(installedHelper) && existsSync(bundledHelper)) {
			try {
				copyFileSync(bundledHelper, installedHelper);
				if (osPlatform !== "win32") {
					chmodSync(installedHelper, 0o755);
				}
			} catch {
				// Ignore on read-only filesystems.
			}
		}

		if (osPlatform === "darwin" && helperName === platformMod.MACOS_HELPER_NAME) {
			macosHelperPath = existsSync(installedHelper)
				? installedHelper
				: existsSync(bundledHelper)
					? bundledHelper
					: undefined;
		}
	}

	return {
		binary: binaryPath,
		...(macosHelperPath ? { macosHelperPath } : {}),
	};
}

async function checkWorkingDirectoryError(cwd: string): Promise<string | undefined> {
	try {
		const st = await stat(cwd);
		if (!st.isDirectory()) {
			return `Working directory is not a directory: ${cwd}`;
		}
		return undefined;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return `Working directory does not exist: ${cwd}`;
		}
		if (code === "ENOTDIR") {
			return `Working directory is not a directory: ${cwd}`;
		}
		const detail = err instanceof Error ? err.message : String(err);
		return `Working directory is not accessible (${cwd}): ${detail}`;
	}
}

export async function runAgentDesktop(
	options: RunAgentDesktopOptions,
): Promise<AgentDesktopRunResult> {
	const explicitBinary =
		normalizeOptionalString(options.binary) ??
		normalizeOptionalString(process.env.AGENT_DESKTOP_BIN);
	const bundled = explicitBinary === undefined ? resolveBundledAgentDesktop() : undefined;
	const binary = explicitBinary ?? bundled?.binary ?? "agent-desktop";
	const cwd = path.resolve(normalizeOptionalCwd(options.cwd) ?? process.cwd());
	const headed = Boolean(options.headed);
	const cleanedArgv = normalizeArgv(options.argv);
	const parsed = cleanedArgv.length > 0 ? parseAgentDesktopArgv(cleanedArgv) : undefined;
	const session =
		parsed?.explicitSession ??
		normalizeOptionalString(options.session) ??
		normalizeOptionalString(options.env?.AGENT_DESKTOP_SESSION) ??
		"pi-default";

	const makeResult = (
		overrides: Partial<AgentDesktopRunResult> & { status: AgentDesktopRunStatus },
	): AgentDesktopRunResult => ({
		ok: false,
		exitCode: null,
		signal: null,
		stdout: "",
		stderr: "",
		stdoutTruncated: false,
		stderrTruncated: false,
		binary,
		cwd,
		argv: cleanedArgv,
		session,
		headed,
		...(parsed ? { subcommand: parsed.subcommand } : {}),
		...overrides,
	});

	if (!parsed) {
		const message = "argv must be a non-empty array of non-empty strings.";
		return makeResult({ status: "error", stderr: message, message });
	}

	if (parsed.hasHeadedFlag) {
		const message =
			"Pass headed: true instead of --headed in argv so physical cursor/keyboard delivery is explicit.";
		return makeResult({ status: "error", stderr: message, message });
	}

	if (parsed.subcommand && PHYSICAL_SUBCOMMANDS.has(parsed.subcommand) && !headed) {
		const message = `"${parsed.subcommand}" moves the real cursor/keyboard; set headed: true when physical input is required.`;
		return makeResult({ status: "error", stderr: message, message });
	}

	let tempDir: string | undefined;
	let tempScreenshotPath: string | undefined;

	try {
		const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
		let reason: "timeout" | "cancelled" | undefined;
		if (options.signal?.aborted) {
			return makeResult({
				status: "cancelled",
				message: "agent-desktop invocation was cancelled before spawn.",
			});
		}

		const isHelpOrVersion =
			parsed.subcommand !== undefined && HELP_OR_VERSION_SUBCOMMANDS.has(parsed.subcommand);

		let finalArgv = [...cleanedArgv];
		if (headed && !isHelpOrVersion) {
			finalArgv = ["--headed", ...finalArgv];
		}
		if (parsed.subcommand === "screenshot" && !parsed.screenshotPath) {
			tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-desktop-shot-"));
			tempScreenshotPath = path.join(tempDir, "screenshot.png");
			finalArgv = [...finalArgv, tempScreenshotPath];
		}

		const stdoutCapture = new BoundedOutput(MAX_CAPTURE_BYTES);
		const stderrCapture = new BoundedOutput(MAX_CAPTURE_BYTES);

		const normalizedStdin = normalizeOptionalStdin(options.stdin);
		const usePipeStdin =
			normalizedStdin !== undefined || (parsed.hasStdinFlag && !isHelpOrVersion);

		const spawnEnv: NodeJS.ProcessEnv = {
			...process.env,
			...options.env,
			AGENT_DESKTOP_SESSION: session,
		};
		if (
			bundled?.macosHelperPath &&
			!options.env?.AGENT_DESKTOP_MACOS_HELPER_PATH?.trim() &&
			!process.env.AGENT_DESKTOP_MACOS_HELPER_PATH?.trim()
		) {
			spawnEnv.AGENT_DESKTOP_MACOS_HELPER_PATH = bundled.macosHelperPath;
		}

		const handleSpawnError = async (err: NodeJS.ErrnoException): Promise<AgentDesktopRunResult> => {
			if (err.code === "ENOENT" || err.code === "ENOTDIR") {
				const cwdError = await checkWorkingDirectoryError(cwd);
				if (cwdError) {
					return makeResult({
						status: "error",
						stderr: cwdError,
						message: cwdError,
					});
				}
				if (err.code === "ENOENT") {
					return makeResult({
						status: "unavailable",
						stderr: INSTALL_HINT,
						message: INSTALL_HINT,
					});
				}
			}
			const errMsg = `Failed to execute ${binary}: ${err.message}`;
			return makeResult({
				status: "error",
				stderr: errMsg,
				message: errMsg,
			});
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(binary, finalArgv, {
				cwd,
				shell: false,
				windowsHide: true,
				stdio: [usePipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
				env: spawnEnv,
			});
		} catch (err) {
			return await handleSpawnError(err as NodeJS.ErrnoException);
		}

		if (usePipeStdin && child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(normalizedStdin ?? "", "utf8");
		}

		child.stdout?.on("data", (chunk: Buffer) => stdoutCapture.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderrCapture.push(chunk));

		let spawnError: NodeJS.ErrnoException | undefined;
		let childExited = false;
		let graceTimer: NodeJS.Timeout | undefined;
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child.on("error", (err: NodeJS.ErrnoException) => {
				spawnError = err;
				resolve({ code: null, signal: null });
			});
			child.on("close", (code, sig) => {
				resolve({ code, signal: sig });
			});
			// `close` waits for stdout and stderr, which a background cursor overlay or helper
			// that inherited them can hold open long after the CLI child has exited.
			child.on("exit", (code, sig) => {
				childExited = true;
				graceTimer = setTimeout(() => resolve({ code, signal: sig }), EXIT_STDIO_GRACE_MS);
			});
		});

		const terminateChild = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// Ignore if already exited.
			}
			const killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Ignore if already exited.
				}
			}, 500);
			killTimer.unref?.();
		};

		const onAbort = () => {
			if (reason === undefined && !childExited) {
				reason = "cancelled";
				terminateChild();
			}
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const timer = setTimeout(() => {
			if (reason === undefined && !childExited) {
				reason = "timeout";
				terminateChild();
			}
		}, timeoutMs);
		timer.unref?.();

		const exit = await exited;
		clearTimeout(timer);
		clearTimeout(graceTimer);
		options.signal?.removeEventListener("abort", onAbort);
		// Stop reading, so pipes a descendant still holds do not keep this process alive.
		child.stdin?.destroy();
		child.stdout?.destroy();
		child.stderr?.destroy();

		if (spawnError) {
			return await handleSpawnError(spawnError);
		}

		const rawStdout = stdoutCapture.text();
		const stdout = truncateText(rawStdout, MAX_RESULT_BYTES, MAX_RESULT_LINES);
		const stderr = truncateText(stderrCapture.text(), MAX_RESULT_BYTES, MAX_RESULT_LINES);
		const stdoutTruncated = stdoutCapture.truncated || stdout.truncated;
		const stderrTruncated = stderrCapture.truncated || stderr.truncated;

		if (reason === "timeout") {
			const message = `agent-desktop timed out after ${timeoutMs} ms.`;
			return makeResult({
				status: "timeout",
				exitCode: exit.code,
				signal: exit.signal,
				stdout: stdout.text,
				stderr: stderr.text || message,
				stdoutTruncated,
				stderrTruncated,
				message,
			});
		}

		if (reason === "cancelled") {
			const message = "agent-desktop invocation was cancelled.";
			return makeResult({
				status: "cancelled",
				exitCode: exit.code,
				signal: exit.signal,
				stdout: stdout.text,
				stderr: stderr.text,
				stdoutTruncated,
				stderrTruncated,
				message,
			});
		}

		const envelope = inspectJsonEnvelopeFailure(rawStdout);
		const ok = exit.code === 0 && !envelope.failed;

		let image: AgentDesktopImage | undefined;
		if (parsed.subcommand === "screenshot" && ok) {
			const candidatePaths: string[] = [];
			if (tempScreenshotPath) {
				candidatePaths.push(tempScreenshotPath);
			} else if (parsed.screenshotPath) {
				const stripped = parsed.screenshotPath.replace(/^@/, "");
				candidatePaths.push(path.resolve(cwd, stripped));
				if (stripped !== parsed.screenshotPath) {
					candidatePaths.push(path.resolve(cwd, parsed.screenshotPath));
				}
			}
			for (const targetShotPath of candidatePaths) {
				try {
					const st = await stat(targetShotPath);
					if (st.isFile() && st.size > 0) {
						const bytes = await readFile(targetShotPath);
						image = {
							data: bytes.toString("base64"),
							mimeType: detectImageMimeType(targetShotPath),
							path: targetShotPath,
						};
						break;
					}
				} catch {
					// If the command did not write this path, check next candidate or proceed with text only.
				}
			}
		}

		let status: AgentDesktopRunStatus;
		let message: string | undefined;
		if (ok) {
			status = stdoutTruncated || stderrTruncated ? "truncated" : "success";
			if (status === "truncated") {
				message = `Output exceeded ${MAX_RESULT_LINES} lines or ${Math.round(MAX_RESULT_BYTES / 1024)} KiB and was truncated.`;
			}
		} else {
			status = "error";
			const fallbackExitMsg = exit.signal
				? `agent-desktop terminated by signal ${exit.signal}.`
				: `agent-desktop exited with code ${exit.code ?? "null"}.`;
			message = envelope.errorMessage ?? fallbackExitMsg;
		}

		return makeResult({
			ok,
			status,
			exitCode: exit.code,
			signal: exit.signal,
			stdout: stdout.text,
			stderr: stderr.text,
			stdoutTruncated,
			stderrTruncated,
			message,
			...(image ? { image } : {}),
		});
	} finally {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

function renderAgentDesktopResult(result: AgentDesktopRunResult): string {
	if (result.status === "unavailable") {
		return result.message ?? INSTALL_HINT;
	}

	const parts: string[] = [];
	if (result.stdout.trim()) {
		parts.push(result.stdout.trimEnd());
	}
	if (result.stderr.trim()) {
		parts.push(result.stderr.trimEnd());
	}
	if (result.stdoutTruncated || result.stderrTruncated) {
		parts.push(
			`[Output truncated to ${MAX_RESULT_LINES} lines / ${Math.round(MAX_RESULT_BYTES / 1024)} KiB]`,
		);
	}
	if (!result.ok && result.message && !parts.some((p) => p.includes(result.message!))) {
		parts.push(result.message);
	}
	if (parts.length === 0) {
		if (result.image) {
			parts.push(`Captured screenshot (${result.image.mimeType}) in session ${result.session}.`);
		} else {
			parts.push(
				`agent-desktop ${result.argv.join(" ")} completed (session: ${result.session}, exit: ${result.exitCode ?? 0}).`,
			);
		}
	}

	return truncateText(parts.join("\n\n"), MAX_RESULT_BYTES, MAX_RESULT_LINES).text;
}

const AgentDesktopToolParameters = Type.Object({
	argv: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 64,
		description:
			"Direct agent-desktop CLI arguments, e.g. ['snapshot', '-i', '--app', 'Finder'], ['click', '@s8f3k2p9:e8'], ['type', '@s8f3k2p9:e3', 'hello'], ['screenshot'], or ['session', 'end'].",
	}),
	headed: Type.Optional(
		Type.Boolean({
			description:
				"Set true only when physical cursor/keyboard delivery is required (e.g. hover, drag, double-click, mouse-*, key-*). Defaults to false (headless accessibility actions).",
		}),
	),
	stdin: Type.Optional(
		Type.String({
			description:
				"Optional UTF-8 text piped to agent-desktop stdin (for example with ['type', '@ref', '--stdin'] or ['clipboard-set', '--stdin']).",
		}),
	),
	session: Type.Optional(
		Type.String({
			maxLength: 64,
			description:
				"Optional desktop session ID override; defaults to an isolated session per Pi session.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Optional working directory (defaults to session cwd).",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 600_000,
			description: `Wall-clock timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`,
		}),
	),
});

type AgentDesktopToolInput = Static<typeof AgentDesktopToolParameters>;

function prepareAgentDesktopToolArguments(raw: unknown): AgentDesktopToolInput {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return raw as AgentDesktopToolInput;
	}
	const input = raw as Record<string, unknown>;
	const next: Record<string, unknown> = { ...input };

	if (typeof next.session === "string") {
		const norm = normalizeOptionalString(next.session);
		if (norm === undefined) delete next.session;
		else next.session = norm;
	}
	if (typeof next.cwd === "string") {
		const norm = normalizeOptionalCwd(next.cwd);
		if (norm === undefined) delete next.cwd;
		else next.cwd = norm;
	}
	if (typeof next.stdin === "string") {
		const norm = normalizeOptionalStdin(next.stdin);
		if (norm === undefined) delete next.stdin;
		else next.stdin = norm;
	}
	if (typeof next.timeoutMs === "number") {
		const clamped = clampTimeoutMs(next.timeoutMs);
		if (clamped === undefined) delete next.timeoutMs;
		else next.timeoutMs = clamped;
	}
	if (Array.isArray(next.argv)) {
		const filtered = normalizeArgv(next.argv);
		if (filtered.length > 0) {
			next.argv = filtered;
		}
	}

	return next as AgentDesktopToolInput;
}

export default function agentDesktopExtension(pi: ExtensionAPI): void {
	if (boundApis.has(pi)) return;
	boundApis.add(pi);

	// Deduplicate if loaded both by path and via CHILD_SESSION_HOOKS in the same ResourceLoader pass.
	let inLoadPass = true;
	if (pi.events && typeof pi.events.emit === "function" && typeof pi.events.on === "function") {
		const probe = { alreadyLoaded: false };
		pi.events.emit("pi-extensions.agent-desktop.load-probe", probe);
		if (probe.alreadyLoaded) return;
		pi.events.on("pi-extensions.agent-desktop.load-probe", (data) => {
			if (inLoadPass && data && typeof data === "object") {
				(data as { alreadyLoaded: boolean }).alreadyLoaded = true;
			}
		});
	}

	const instanceToken = {};
	const state = getSharedState();
	state.openInstances.add(instanceToken);
	ensureChildSessionHook(true);

	const activeByPiKey = new Map<string, Set<string>>();
	let lastCtx: ExtensionContext | undefined;
	let lastPiKey: string | undefined;

	function getActiveSet(piKey: string): Set<string> {
		let set = activeByPiKey.get(piKey);
		if (!set) {
			set = new Set<string>();
			activeByPiKey.set(piKey, set);
		}
		return set;
	}

	function setUiStatus(ctx: ExtensionContext | undefined, piKey: string): void {
		const activeSet = activeByPiKey.get(piKey);
		const text = activeSet ? formatDesktopStatus(activeSet) : undefined;
		try {
			(ctx ?? lastCtx)?.ui?.setStatus?.(AGENT_DESKTOP_STATUS_KEY, text);
		} catch {
			// Ignore UI errors in non-UI contexts.
		}
	}

	async function closeTrackedDesktopSessions(
		ctx?: ExtensionContext,
		explicitTargets?: readonly string[],
	): Promise<string[]> {
		const targetCtx = ctx ?? lastCtx;
		const piKey = targetCtx ? deriveDesktopSessionId(targetCtx) : (lastPiKey ?? "pi-default");
		const sessionsToClose = new Set<string>(explicitTargets ?? []);

		const currentSet = activeByPiKey.get(piKey);
		if (currentSet) {
			for (const s of currentSet) sessionsToClose.add(s);
			currentSet.clear();
			activeByPiKey.delete(piKey);
		}

		if (lastPiKey && lastPiKey !== piKey) {
			const prevSet = activeByPiKey.get(lastPiKey);
			if (prevSet) {
				for (const s of prevSet) sessionsToClose.add(s);
				prevSet.clear();
				activeByPiKey.delete(lastPiKey);
			}
		}

		try {
			targetCtx?.ui?.setStatus?.(AGENT_DESKTOP_STATUS_KEY, undefined);
		} catch {
			// Ignore UI errors in non-UI contexts.
		}

		const closed = [...sessionsToClose];
		if (closed.length > 0) {
			const runCwd = targetCtx?.cwd ?? process.cwd();
			await Promise.all(
				closed.map((s) =>
					runAgentDesktop({
						argv: ["--session", s, "session", "end"],
						session: s,
						cwd: runCwd,
						timeoutMs: 15_000,
					}).catch(() => undefined),
				),
			);
		}
		return closed;
	}

	pi.on("session_start", async (_event, ctx) => {
		inLoadPass = false;
		state.openInstances.add(instanceToken);
		ensureChildSessionHook(true);
		const nextPiKey = deriveDesktopSessionId(ctx);
		if (lastPiKey && lastPiKey !== nextPiKey && (activeByPiKey.get(lastPiKey)?.size ?? 0) > 0) {
			await closeTrackedDesktopSessions(ctx);
		}
		lastCtx = ctx;
		lastPiKey = nextPiKey;
		setUiStatus(ctx, nextPiKey);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		await closeTrackedDesktopSessions(ctx);
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await closeTrackedDesktopSessions(ctx);
		state.openInstances.delete(instanceToken);
		if (state.openInstances.size === 0) {
			ensureChildSessionHook(false);
		}
	});

	pi.registerTool({
		name: "agent_desktop",
		label: "Agent Desktop",
		description:
			"Run the agent-desktop CLI directly (no shell) to drive native desktop applications headlessly via OS accessibility trees: inspect compact accessibility-tree snapshots with @snapshot:eN element refs, click/type/interact with controls without moving the real cursor, capture inline screenshot images, and manage isolated desktop sessions. Physical cursor/keyboard subcommands require headed: true.",
		promptSnippet:
			"Drive native desktop apps headlessly via OS accessibility trees with agent-desktop CLI (snapshot, click/type @ref, inline screenshot).",
		parameters: AgentDesktopToolParameters,
		prepareArguments: prepareAgentDesktopToolArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const piKey = deriveDesktopSessionId(ctx);
			lastPiKey = piKey;

			const cleanedArgv = normalizeArgv(params.argv);
			const parsed = parseAgentDesktopArgv(cleanedArgv);
			const targetSession =
				parsed.explicitSession ?? normalizeOptionalString(params.session) ?? piKey;
			const normalizedCwd = normalizeOptionalCwd(params.cwd);
			const targetCwd = normalizedCwd ? path.resolve(ctx.cwd, normalizedCwd) : ctx.cwd;
			const normalizedStdin = normalizeOptionalStdin(params.stdin);

			const result = await runAgentDesktop({
				argv: cleanedArgv,
				headed: params.headed,
				stdin: normalizedStdin,
				session: targetSession,
				cwd: targetCwd,
				timeoutMs: params.timeoutMs,
				signal,
			});

			if (parsed.subcommand === "session") {
				if (parsed.sessionAction === "end") {
					const activeSet = activeByPiKey.get(piKey);
					if (activeSet) {
						const endedId = normalizeOptionalString(parsed.sessionTargetId) ?? result.session;
						activeSet.delete(endedId);
						if (activeSet.size === 0) activeByPiKey.delete(piKey);
					}
					setUiStatus(ctx, piKey);
				} else if (parsed.sessionAction === "start" && result.ok) {
					const activeSet = getActiveSet(piKey);
					const startedId = extractStartedSessionId(result.stdout) ?? result.session;
					activeSet.add(startedId);
					setUiStatus(ctx, piKey);
				}
			} else if (result.ok && parsed.subcommand && !META_SUBCOMMANDS.has(parsed.subcommand)) {
				const activeSet = getActiveSet(piKey);
				activeSet.add(result.session);
				setUiStatus(ctx, piKey);
			}

			const text = renderAgentDesktopResult(result);
			const content: Array<
				| { type: "text"; text: string }
				| { type: "image"; data: string; mimeType: string }
			> = [{ type: "text", text }];

			if (result.image) {
				content.push({
					type: "image",
					data: result.image.data,
					mimeType: result.image.mimeType,
				});
			}

			return {
				content,
				details: result,
			};
		},
	});

	async function runDiagnosticCommand(
		ctx: ExtensionContext,
		piKey: string,
		argv: readonly [string, ...string[]],
	): Promise<void> {
		const result = await runAgentDesktop({
			argv,
			session: piKey,
			cwd: ctx.cwd,
			timeoutMs: 30_000,
		});
		if (result.status === "unavailable") {
			ctx.ui.notify(result.message ?? INSTALL_HINT, "warning");
			return;
		}
		const output =
			[result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") ||
			`agent-desktop ${argv[0]} exited with code ${result.exitCode ?? 0}`;
		ctx.ui.notify(output, result.ok ? "info" : "warning");
	}

	pi.registerCommand("agent-desktop", {
		description:
			"Inspect or control the session's agent-desktop state: /agent-desktop [status | close | permissions [--guide|--request] | doctor]",
		handler: async (args, ctx) => {
			pi.appendEntry("pi-extensions.command", {
				command: "agent-desktop",
				kind: "extension",
				extension: "agent-desktop",
			});
			lastCtx = ctx;
			const piKey = deriveDesktopSessionId(ctx);
			lastPiKey = piKey;

			const trimmed = args.trim();
			const tokens = trimmed ? trimmed.split(/\s+/) : [];
			const subcommand = (tokens[0] ?? "status").toLowerCase();

			if (!trimmed || (subcommand === "status" && tokens.length === 1)) {
				const active = [...(activeByPiKey.get(piKey) ?? [])];
				const statusMsg =
					active.length === 0
						? `Agent Desktop: idle (default session: ${piKey}, active sessions: none)`
						: `Agent Desktop: active (${active.join(", ")}; default session: ${piKey})`;
				ctx.ui.notify(statusMsg, "info");
				return;
			}

			if (subcommand === "close" && tokens.length === 1) {
				const active = [...(activeByPiKey.get(piKey) ?? [])];
				const targets = active.length > 0 ? active : [piKey];
				await closeTrackedDesktopSessions(ctx, targets);
				ctx.ui.notify(`Closed agent-desktop session(s): ${targets.join(", ")}`, "info");
				return;
			}

			if (subcommand === "doctor" && tokens.length === 1) {
				await runDiagnosticCommand(ctx, piKey, ["status"]);
				return;
			}

			if (subcommand === "permissions") {
				const extra = tokens.slice(1);
				if (
					extra.length > 1 ||
					(extra.length === 1 && extra[0] !== "--guide" && extra[0] !== "--request")
				) {
					ctx.ui.notify(USAGE_MESSAGE, "warning");
					return;
				}
				await runDiagnosticCommand(ctx, piKey, ["permissions", ...extra]);
				return;
			}

			ctx.ui.notify(USAGE_MESSAGE, "warning");
		},
	});
}
