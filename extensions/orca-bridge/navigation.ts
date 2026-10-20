import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { posix, resolve, win32 } from "node:path";

type Mode = "open" | "diff";
type Options = { path: string; focus: boolean; staged: boolean; line?: string; column?: string };

class NavigationError extends Error {}

const usage = (mode: Mode): string => mode === "open"
	? "Usage: /orca-open <path> [--line N] [--column N] [--focus]"
	: "Usage: /orca-diff <path> [--staged] [--focus]";

// Quotes group arguments; backslashes remain literal, including Windows paths.
// No shell expansion, interpolation, or command execution happens here.
function tokenize(input: string): string[] {
	if (input.length > 16_384 || input.includes("\0")) throw new NavigationError("Invalid or oversized arguments.");
	const tokens: string[] = [];
	let token = "";
	let quote = "";
	let started = false;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = "";
			else token += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (/\s/u.test(char)) {
			if (started) tokens.push(token);
			token = "";
			started = false;
		} else {
			token += char;
			started = true;
		}
	}
	if (quote) throw new NavigationError("Unclosed quote. Wrap the filename in matching single or double quotes.");
	if (started) tokens.push(token);
	if (tokens.length > 64) throw new NavigationError("Too many arguments.");
	return tokens;
}

function parse(input: string, mode: Mode): Options {
	const tokens = tokenize(input);
	const result: Options = { path: "", focus: false, staged: false };
	const seen = new Set<string>();
	let positionalOnly = false;
	let hasPath = false;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!positionalOnly && token === "--") { positionalOnly = true; continue; }
		if (!positionalOnly && token.startsWith("-")) {
			if (seen.has(token)) throw new NavigationError("Duplicate option. " + usage(mode));
			seen.add(token);
			if (token === "--focus") result.focus = true;
			else if (token === "--staged" && mode === "diff") result.staged = true;
			else if ((token === "--line" || token === "--column") && mode === "open") {
				const value = tokens[++i];
				if (!value || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
					throw new NavigationError("Line and column must be positive safe integers. " + usage(mode));
				}
				result[token === "--line" ? "line" : "column"] = value;
			} else throw new NavigationError("Unknown or unsupported option. " + usage(mode));
		} else {
			if (hasPath || !token) throw new NavigationError(usage(mode));
			result.path = token;
			hasPath = true;
		}
	}
	if (!hasPath) throw new NavigationError(usage(mode));
	if (result.column && !result.line) throw new NavigationError("--column requires --line. " + usage(mode));
	return result;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

// Only known codes are displayed; CLI messages, stderr, config, and exception
// text can contain credentials and are deliberately never forwarded to the UI.
function failure(code: unknown): NavigationError {
	const advice: Record<string, string> = {
		renderer_unavailable: "Open an Orca app window connected to this workspace, then retry.",
		runtime_unavailable: "Start Orca and check the CLI connection, then retry.",
		selector_not_found: "The pane workspace is unavailable. Reopen the pane in the intended workspace; no other target was tried.",
		selector_ambiguous: "Workspace identity is ambiguous. Run from a pane with ORCA_WORKTREE_ID set.",
		invalid_argument: "Check the path and position. Remote navigation needs an explicit pane workspace ID; inherited CLI routing is preserved.",
		file_not_opened: "Orca declined the file. Check the target and update the Orca app if needed.",
		file_not_found: "Check the requested file path in the pane workspace.",
	};
	if (typeof code === "string" && Object.hasOwn(advice, code)) {
		return new NavigationError(`Orca navigation failed (${code}). ${advice[code]}`);
	}
	return new NavigationError("Orca navigation failed. Check the CLI connection and workspace, then retry.");
}

function launcher(): string {
	const paths = process.platform === "win32" ? win32 : posix;
	const command = process.env.ORCA_CLI_COMMAND;
	const binDir = process.env.ORCA_CLI_BIN_DIR;
	if (command !== undefined) {
		const wslDir = process.env.ORCA_WSL_CLI_DIR;
		if (process.platform === "linux" && (command === "orca-ide" || command === "orca-dev")
			&& identity(wslDir) && posix.isAbsolute(wslDir)) {
			return posix.join(wslDir, command);
		}
		if (!identity(command) || !paths.isAbsolute(command)) {
			throw new NavigationError("The inherited Orca CLI launcher is invalid. Reopen the intended Orca pane.");
		}
		return command;
	}
	if (binDir !== undefined) {
		if (!identity(binDir) || !paths.isAbsolute(binDir)) {
			throw new NavigationError("The inherited Orca CLI directory is invalid. Reopen the intended Orca pane.");
		}
		return paths.join(binDir, process.platform === "win32" ? "orca.cmd" : "orca");
	}
	return process.platform === "linux" ? "orca-ide" : "orca";
}

async function execute(pi: ExtensionAPI, executable: string, cwd: string, args: string[]): Promise<Record<string, unknown>> {
	let response;
	try {
		response = await pi.exec(executable, args, { cwd, timeout: 10_000 });
	} catch (error: unknown) {
		if (record(error) && error.code === "ENOENT") {
			throw new NavigationError("Orca CLI was not found. Check the inherited launcher or install the CLI on PATH; no other launcher was tried.");
		}
		throw failure(undefined);
	}
	if (response.killed) throw new NavigationError("Orca CLI timed out or was cancelled. Check Orca before retrying; the request may have reached it.");
	let json: unknown;
	try { json = JSON.parse(response.stdout) as unknown; }
	catch {
		if (response.code !== 0) throw failure(undefined);
		throw new NavigationError("Orca CLI returned invalid JSON. Check the installed CLI version and connection.");
	}
	if (!record(json)) throw new NavigationError("Orca CLI returned an invalid response. Check the installed CLI version.");
	if (json.ok === false || Object.hasOwn(json, "error")) {
		throw failure(record(json.error) ? json.error.code : undefined);
	}
	if (response.code !== 0) throw failure(undefined);
	if (Object.hasOwn(json, "ok")) {
		if (json.ok !== true || !record(json.result)) throw new NavigationError("Orca CLI returned an invalid response. Check the installed CLI version.");
		json = json.result;
	}
	if (!record(json)) throw failure(undefined);
	if (Object.hasOwn(json, "error") || json.ok === false) throw failure(record(json.error) ? json.error.code : undefined);
	return json;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "error"): void {
	// Escape terminal controls in filenames without altering the actual CLI path.
	const safe = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
	try { ctx.ui.notify(safe, level); } catch { /* stale or noninteractive UI */ }
}

async function navigate(pi: ExtensionAPI, input: string, ctx: ExtensionCommandContext, mode: Mode): Promise<void> {
	try {
		const options = parse(input, mode);
		const cwd = ctx.cwd;
		const path = resolve(cwd, options.path);
		const inheritedId = process.env.ORCA_WORKTREE_ID;
		if (inheritedId !== undefined && !identity(inheritedId)) {
			throw new NavigationError("The pane workspace ID is invalid or missing. Reopen the intended Orca pane.");
		}
		const executable = launcher();
		// The CLI scopes the inherited pane ID to its caller host, including SSH twins.
		const current = await execute(pi, executable, cwd, ["worktree", "current", "--json"]);
		if (!record(current.worktree) || !identity(current.worktree.id) || !identity(current.worktree.path)) {
			throw new NavigationError("Orca did not return a unique workspace identity. Run from the intended Orca pane.");
		}
		if (inheritedId !== undefined && current.worktree.id !== inheritedId) {
			throw new NavigationError("Orca returned a different pane workspace. Reopen the intended Orca pane; no file was opened.");
		}
		let selector = `id:${current.worktree.id}`;
		if (Object.hasOwn(current.worktree, "identity")) {
			if (!record(current.worktree.identity) || !identity(current.worktree.identity.key)) {
				throw new NavigationError("Orca returned an invalid workspace identity. Reopen the intended Orca pane.");
			}
			selector = `identity:${current.worktree.identity.key}`;
		}
		// Orca validates the workspace boundary, including remote and WSL paths.
		// No filesystem checks: folder workspaces and deleted diff paths are valid.
		const args = ["file", mode, "--path", path, "--worktree", selector, "--json"];
		if (options.line) args.push("--line", options.line);
		if (options.column) args.push("--column", options.column);
		if (options.staged) args.push("--staged");
		if (options.focus) args.push("--focus");
		const result = await execute(pi, executable, cwd, args);
		if (result.opened !== true) throw failure("file_not_opened");
		const shownPath = typeof result.relativePath === "string" && result.relativePath.length > 0 ? result.relativePath : options.path;
		notify(ctx, `Opened ${mode === "diff" ? "diff for " : ""}${shownPath} in Orca.`, "info");
	} catch (error: unknown) {
		const message = error instanceof NavigationError ? error.message : "Orca navigation failed. Check the CLI connection and workspace, then retry.";
		notify(ctx, message, "error");
		// Orca's RPC client ignores notify decorations; command failure remains visible.
		if (ctx.mode === "rpc") throw new NavigationError(message);
	}
}

export function registerNavigationCommands(pi: ExtensionAPI): void {
	pi.registerCommand("orca-open", {
		description: "Open a file or existing review report in the pane's Orca workspace; --focus switches view",
		handler: (args, ctx) => navigate(pi, args, ctx, "open"),
	});
	pi.registerCommand("orca-diff", {
		description: "Open a file diff in the pane's Orca workspace; --staged selects staged changes, --focus switches view",
		handler: (args, ctx) => navigate(pi, args, ctx, "diff"),
	});
}
