import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const AGENT_BROWSER_STATUS_KEY = "agent-browser";
export const AGENT_BROWSER_SHARED_KEY = Symbol.for("pi-extensions.agent-browser");
export const CHILD_SESSION_HOOKS = Symbol.for("pi-extensions.child-session-hooks");

export const DEFAULT_TIMEOUT_MS = 120_000;
export const EXIT_STDIO_GRACE_MS = 100;
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_RESULT_BYTES = 50 * 1024;
export const MAX_RESULT_LINES = 2000;

export const INSTALL_HINT =
	"agent-browser CLI is not installed or not in PATH. Install it with: npm install -g agent-browser && agent-browser install";

export interface ChildSessionHook {
	name: string;
	extensionFactory: (pi: ExtensionAPI) => void;
}

export interface AgentBrowserSharedState {
	openInstances: Set<object>;
	hook?: ChildSessionHook;
}

export type AgentBrowserRunStatus =
	| "success"
	| "truncated"
	| "timeout"
	| "cancelled"
	| "unavailable"
	| "error";

export interface AgentBrowserImage {
	data: string;
	mimeType: string;
	path: string;
}

export interface AgentBrowserRunResult {
	ok: boolean;
	status: AgentBrowserRunStatus;
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
	subcommand?: string;
	message?: string;
	image?: AgentBrowserImage;
}

export interface RunAgentBrowserOptions {
	argv: readonly string[];
	cwd?: string;
	session?: string;
	timeoutMs?: number;
	binary?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export interface ParsedAgentBrowserArgv {
	explicitSession?: string;
	subcommand?: string;
	subcommandIndex: number;
	screenshotPath?: string;
	screenshotBase64: boolean;
}

const GLOBAL_VALUE_FLAGS = new Set([
	"--session",
	"-s",
	"--cdp",
	"--provider",
	"-p",
	"--engine",
	"--config",
	"--namespace",
	"--profile",
	"--allowed-domains",
	"--idle-timeout",
	"--user-agent",
	"--proxy",
	"--headers",
]);

const SCREENSHOT_VALUE_FLAGS = new Set([
	"--selector",
	"-S",
	"--format",
	"--quality",
	"-q",
	"--clip",
]);

const META_SUBCOMMANDS = new Set([
	"close",
	"skills",
	"doctor",
	"install",
	"upgrade",
	"help",
	"--help",
	"-h",
	"--version",
	"-V",
	"version",
]);

const boundApis = new WeakSet<ExtensionAPI>();

function getSharedState(): AgentBrowserSharedState {
	const g = globalThis as Record<symbol, unknown>;
	let state = g[AGENT_BROWSER_SHARED_KEY] as AgentBrowserSharedState | undefined;
	if (!state) {
		state = {
			openInstances: new Set<object>(),
		};
		g[AGENT_BROWSER_SHARED_KEY] = state;
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
	state.hook ??= { name: "agent-browser", extensionFactory: agentBrowserExtension };
	const hooks = getChildHooksSet();
	if (active) {
		for (const item of [...hooks]) {
			if (item.name === "agent-browser" && item !== state.hook) {
				hooks.delete(item);
			}
		}
		hooks.add(state.hook);
	} else {
		for (const item of [...hooks]) {
			if (item.name === "agent-browser") {
				hooks.delete(item);
			}
		}
	}
}

export function deriveBrowserSessionId(ctx?: {
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

export function parseAgentBrowserArgv(argv: readonly string[]): ParsedAgentBrowserArgv {
	let explicitSession: string | undefined;
	let subcommand: string | undefined;
	let subcommandIndex = -1;
	let screenshotPath: string | undefined;
	let screenshotBase64 = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (token === "--session" || token === "-s") {
			const next = argv[i + 1];
			if (typeof next === "string" && next.length > 0) {
				explicitSession = next;
			}
			i++;
			continue;
		}
		if (token.startsWith("--session=")) {
			const val = token.slice("--session=".length);
			if (val.length > 0) explicitSession = val;
			continue;
		}
		if (token.startsWith("-s=")) {
			const val = token.slice("-s=".length);
			if (val.length > 0) explicitSession = val;
			continue;
		}

		if (subcommand === undefined) {
			if (GLOBAL_VALUE_FLAGS.has(token)) {
				i++;
				continue;
			}
			if (token === "--help" || token === "-h" || token === "--version" || token === "-V") {
				subcommand = token;
				subcommandIndex = i;
				continue;
			}
			if (token.startsWith("-")) {
				continue;
			}
			subcommand = token;
			subcommandIndex = i;
			continue;
		}

		if (subcommand === "screenshot") {
			if (GLOBAL_VALUE_FLAGS.has(token) || SCREENSHOT_VALUE_FLAGS.has(token)) {
				i++;
				continue;
			}
			if (token === "--base64" || token === "--base64=true") {
				screenshotBase64 = true;
				continue;
			}
			if (token.startsWith("-")) {
				continue;
			}
			if (screenshotPath === undefined) {
				screenshotPath = token;
			}
		}
	}

	return {
		explicitSession,
		subcommand,
		subcommandIndex,
		screenshotPath,
		screenshotBase64,
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

export function truncateText(
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

export function formatBrowserStatus(activeSessions: ReadonlySet<string>): string | undefined {
	if (activeSessions.size === 0) return undefined;
	const list = [...activeSessions];
	if (list.length === 1) return `browser: ${list[0]}`;
	return `browser: ${list[0]} (+${list.length - 1})`;
}

export async function runAgentBrowser(options: RunAgentBrowserOptions): Promise<AgentBrowserRunResult> {
	const binary =
		options.binary?.trim() ||
		process.env.AGENT_BROWSER_BIN?.trim() ||
		"agent-browser";
	const cwd = path.resolve(options.cwd ?? process.cwd());

	if (
		!Array.isArray(options.argv) ||
		options.argv.length === 0 ||
		!options.argv.every((arg) => typeof arg === "string" && arg.length > 0)
	) {
		const message = "argv must be a non-empty array of non-empty strings.";
		return {
			ok: false,
			status: "error",
			exitCode: null,
			signal: null,
			stdout: "",
			stderr: message,
			stdoutTruncated: false,
			stderrTruncated: false,
			binary,
			cwd,
			argv: options.argv ?? [],
			session: options.session?.trim() || "pi-default",
			message,
		};
	}

	const parsed = parseAgentBrowserArgv(options.argv);
	const session =
		parsed.explicitSession ??
		(options.session?.trim() || undefined) ??
		(options.env?.AGENT_BROWSER_SESSION?.trim() || undefined) ??
		"pi-default";

	let tempDir: string | undefined;
	let tempScreenshotPath: string | undefined;

	try {
		let finalArgv = [...options.argv];
		if (parsed.subcommand === "screenshot" && !parsed.screenshotPath && !parsed.screenshotBase64) {
			tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-browser-shot-"));
			tempScreenshotPath = path.join(tempDir, "screenshot.png");
			finalArgv = [...options.argv, tempScreenshotPath];
		} else if (parsed.subcommand === "close" && !parsed.explicitSession) {
			finalArgv = ["--session", session, ...options.argv];
		}

		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let reason: "timeout" | "cancelled" | undefined;
		if (options.signal?.aborted) {
			return {
				ok: false,
				status: "cancelled",
				exitCode: null,
				signal: null,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				binary,
				cwd,
				argv: options.argv,
				session,
				subcommand: parsed.subcommand,
				message: "agent-browser invocation was cancelled before spawn.",
			};
		}

		const stdoutCapture = new BoundedOutput(MAX_CAPTURE_BYTES);
		const stderrCapture = new BoundedOutput(MAX_CAPTURE_BYTES);

		const child = spawn(binary, finalArgv, {
			cwd,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				...options.env,
				AGENT_BROWSER_SESSION: session,
			},
		});

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
			// `close` waits for stdout and stderr, which a descendant that inherited them
			// (such as the browser daemon) can hold open long after the child has exited.
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
		child.stdout?.destroy();
		child.stderr?.destroy();

		if (spawnError) {
			if (spawnError.code === "ENOENT") {
				return {
					ok: false,
					status: "unavailable",
					exitCode: null,
					signal: null,
					stdout: "",
					stderr: INSTALL_HINT,
					stdoutTruncated: false,
					stderrTruncated: false,
					binary,
					cwd,
					argv: options.argv,
					session,
					subcommand: parsed.subcommand,
					message: INSTALL_HINT,
				};
			}
			const errMsg = `Failed to execute ${binary}: ${spawnError.message}`;
			return {
				ok: false,
				status: "error",
				exitCode: null,
				signal: null,
				stdout: "",
				stderr: errMsg,
				stdoutTruncated: false,
				stderrTruncated: false,
				binary,
				cwd,
				argv: options.argv,
				session,
				subcommand: parsed.subcommand,
				message: errMsg,
			};
		}

		const stdout = truncateText(stdoutCapture.text(), MAX_RESULT_BYTES, MAX_RESULT_LINES);
		const stderr = truncateText(stderrCapture.text(), MAX_RESULT_BYTES, MAX_RESULT_LINES);
		const stdoutTruncated = stdoutCapture.truncated || stdout.truncated;
		const stderrTruncated = stderrCapture.truncated || stderr.truncated;

		if (reason === "timeout") {
			const message = `agent-browser timed out after ${timeoutMs} ms.`;
			return {
				ok: false,
				status: "timeout",
				exitCode: exit.code,
				signal: exit.signal,
				stdout: stdout.text,
				stderr: stderr.text || message,
				stdoutTruncated,
				stderrTruncated,
				binary,
				cwd,
				argv: options.argv,
				session,
				subcommand: parsed.subcommand,
				message,
			};
		}

		if (reason === "cancelled") {
			const message = "agent-browser invocation was cancelled.";
			return {
				ok: false,
				status: "cancelled",
				exitCode: exit.code,
				signal: exit.signal,
				stdout: stdout.text,
				stderr: stderr.text,
				stdoutTruncated,
				stderrTruncated,
				binary,
				cwd,
				argv: options.argv,
				session,
				subcommand: parsed.subcommand,
				message,
			};
		}

		let image: AgentBrowserImage | undefined;
		if (parsed.subcommand === "screenshot" && exit.code === 0 && !parsed.screenshotBase64) {
			const targetShotPath =
				tempScreenshotPath ??
				(parsed.screenshotPath ? path.resolve(cwd, parsed.screenshotPath) : undefined);
			if (targetShotPath) {
				try {
					const st = await stat(targetShotPath);
					if (st.isFile()) {
						const bytes = await readFile(targetShotPath);
						image = {
							data: bytes.toString("base64"),
							mimeType: detectImageMimeType(targetShotPath),
							path: targetShotPath,
						};
					}
				} catch {
					// If the command did not write a file, proceed with text output only.
				}
			}
		}

		const ok = exit.code === 0;
		let status: AgentBrowserRunStatus;
		let message: string | undefined;
		if (ok) {
			status = stdoutTruncated || stderrTruncated ? "truncated" : "success";
			if (status === "truncated") {
				message = `Output exceeded ${MAX_RESULT_LINES} lines or ${Math.round(MAX_RESULT_BYTES / 1024)} KiB and was truncated.`;
			}
		} else {
			status = "error";
			message = exit.signal
				? `agent-browser terminated by signal ${exit.signal}.`
				: `agent-browser exited with code ${exit.code ?? "null"}.`;
		}

		return {
			ok,
			status,
			exitCode: exit.code,
			signal: exit.signal,
			stdout: stdout.text,
			stderr: stderr.text,
			stdoutTruncated,
			stderrTruncated,
			binary,
			cwd,
			argv: options.argv,
			session,
			subcommand: parsed.subcommand,
			message,
			...(image ? { image } : {}),
		};
	} finally {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true }).catch(() => {});
		}
	}
}

export function renderAgentBrowserResult(result: AgentBrowserRunResult): string {
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
				`agent-browser ${result.argv.join(" ")} completed (session: ${result.session}, exit: ${result.exitCode ?? 0}).`,
			);
		}
	}

	return truncateText(parts.join("\n\n"), MAX_RESULT_BYTES, MAX_RESULT_LINES).text;
}

export const AgentBrowserToolParameters = Type.Object({
	argv: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		maxItems: 64,
		description:
			"Direct agent-browser CLI arguments, e.g. ['open', 'https://example.com'], ['snapshot', '-i'], ['click', '@e1'], ['screenshot'], or ['close'].",
	}),
	session: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 64,
			description: "Optional browser session name override; defaults to an isolated session per Pi session.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Optional working directory (defaults to session cwd).",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1_000,
			maximum: 600_000,
			description: `Wall-clock timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`,
		}),
	),
});

export type AgentBrowserToolInput = Static<typeof AgentBrowserToolParameters>;

export default function agentBrowserExtension(pi: ExtensionAPI): void {
	if (boundApis.has(pi)) return;
	boundApis.add(pi);

	// Deduplicate if loaded both by path and via CHILD_SESSION_HOOKS in the same ResourceLoader pass.
	let inLoadPass = true;
	if (pi.events && typeof pi.events.emit === "function" && typeof pi.events.on === "function") {
		const probe = { alreadyLoaded: false };
		pi.events.emit("pi-extensions.agent-browser.load-probe", probe);
		if (probe.alreadyLoaded) return;
		pi.events.on("pi-extensions.agent-browser.load-probe", (data) => {
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
		const text = activeSet ? formatBrowserStatus(activeSet) : undefined;
		try {
			(ctx ?? lastCtx)?.ui?.setStatus?.(AGENT_BROWSER_STATUS_KEY, text);
		} catch {
			// Ignore UI errors in non-UI contexts.
		}
	}

	async function closeTrackedBrowserSessions(
		ctx?: ExtensionContext,
		explicitTargets?: readonly string[],
	): Promise<string[]> {
		const targetCtx = ctx ?? lastCtx;
		const piKey = targetCtx ? deriveBrowserSessionId(targetCtx) : (lastPiKey ?? "pi-default");
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
			targetCtx?.ui?.setStatus?.(AGENT_BROWSER_STATUS_KEY, undefined);
		} catch {
			// Ignore UI errors in non-UI contexts.
		}

		const closed = [...sessionsToClose];
		if (closed.length > 0) {
			const runCwd = targetCtx?.cwd ?? process.cwd();
			await Promise.all(
				closed.map((s) =>
					runAgentBrowser({
						argv: ["--session", s, "close"],
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
		const nextPiKey = deriveBrowserSessionId(ctx);
		if (lastPiKey && lastPiKey !== nextPiKey && (activeByPiKey.get(lastPiKey)?.size ?? 0) > 0) {
			await closeTrackedBrowserSessions(ctx);
		}
		lastCtx = ctx;
		lastPiKey = nextPiKey;
		setUiStatus(ctx, nextPiKey);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		await closeTrackedBrowserSessions(ctx);
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await closeTrackedBrowserSessions(ctx);
		state.openInstances.delete(instanceToken);
		if (state.openInstances.size === 0) {
			ensureChildSessionHook(false);
		}
	});

	pi.registerTool({
		name: "agent_browser",
		label: "Agent Browser",
		description:
			"Run the agent-browser CLI directly (no shell) to drive an isolated headless or headed Chrome/Chromium browser over CDP: open pages, inspect compact accessibility-tree snapshots with @eN element refs, click/fill/interact with elements, capture inline screenshot images, and close the browser session.",
		promptSnippet:
			"Drive an isolated browser session with agent-browser CLI (open, snapshot, click/fill @ref, inline screenshot, close).",
		parameters: AgentBrowserToolParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const piKey = deriveBrowserSessionId(ctx);
			lastPiKey = piKey;

			const parsed = parseAgentBrowserArgv(params.argv);
			const targetSession = parsed.explicitSession ?? params.session?.trim() ?? piKey;
			const targetCwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;

			const result = await runAgentBrowser({
				argv: params.argv,
				session: targetSession,
				cwd: targetCwd,
				timeoutMs: params.timeoutMs,
				signal,
			});

			const activeSet = getActiveSet(piKey);
			if (parsed.subcommand === "close") {
				activeSet.delete(result.session);
				if (activeSet.size === 0) activeByPiKey.delete(piKey);
				setUiStatus(ctx, piKey);
			} else if (result.ok && parsed.subcommand && !META_SUBCOMMANDS.has(parsed.subcommand)) {
				activeSet.add(result.session);
				setUiStatus(ctx, piKey);
			}

			const text = renderAgentBrowserResult(result);
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

	pi.registerCommand("agent-browser", {
		description:
			"Inspect or control the session's agent-browser daemon: /agent-browser [status | close | doctor]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const piKey = deriveBrowserSessionId(ctx);
			lastPiKey = piKey;

			const trimmed = args.trim();
			const tokens = trimmed ? trimmed.split(/\s+/) : [];
			const subcommand = (tokens[0] ?? "status").toLowerCase();

			if (!trimmed || subcommand === "status") {
				const active = [...(activeByPiKey.get(piKey) ?? [])];
				const statusMsg =
					active.length === 0
						? `Agent Browser: idle (default session: ${piKey}, active sessions: none)`
						: `Agent Browser: active (${active.join(", ")}; default session: ${piKey})`;
				ctx.ui.notify(statusMsg, "info");
				return;
			}

			if (subcommand === "close") {
				const active = [...(activeByPiKey.get(piKey) ?? [])];
				const targets = active.length > 0 ? active : [piKey];
				await closeTrackedBrowserSessions(ctx, targets);
				ctx.ui.notify(`Closed agent-browser session(s): ${targets.join(", ")}`, "info");
				return;
			}

			if (subcommand === "doctor") {
				const result = await runAgentBrowser({
					argv: ["doctor"],
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
					`agent-browser doctor exited with code ${result.exitCode ?? 0}`;
				ctx.ui.notify(output, result.ok ? "info" : "warning");
				return;
			}

			ctx.ui.notify("Usage: /agent-browser [status | close | doctor]", "warning");
		},
	});
}
