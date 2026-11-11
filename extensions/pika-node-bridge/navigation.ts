/**
 * `/pika-open` and `/pika-diff`: ask the pika web UI, through the daemon, to open a file or a diff. Argument
 * parsing follows `extensions/orca-bridge/navigation.ts`; the daemon checks the path against its roots.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { Reply } from "./transport.ts";

type Mode = "open" | "diff";
export type Options = { path: string; staged: boolean; line?: number; column?: number };
export type Send = (request: { type: "open"; path: string; line?: number; column?: number } | { type: "diff"; path: string; staged?: boolean }) => Promise<Reply>;

export class NavigationError extends Error {}

const usage = (mode: Mode): string => mode === "open"
	? "Usage: /pika-open <path> [--line N] [--column N]"
	: "Usage: /pika-diff <path> [--staged]";

// Quotes group arguments; backslashes remain literal. No shell expansion, interpolation, or command execution.
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

export function parse(input: string, mode: Mode): Options {
	const tokens = tokenize(input);
	const result: Options = { path: "", staged: false };
	const seen = new Set<string>();
	let positionalOnly = false;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!positionalOnly && token === "--") { positionalOnly = true; continue; }
		if (!positionalOnly && token.startsWith("-")) {
			if (seen.has(token)) throw new NavigationError("Duplicate option. " + usage(mode));
			seen.add(token);
			if (token === "--staged" && mode === "diff") result.staged = true;
			else if ((token === "--line" || token === "--column") && mode === "open") {
				const value = tokens[++i];
				if (!value || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
					throw new NavigationError("Line and column must be positive safe integers. " + usage(mode));
				}
				result[token === "--line" ? "line" : "column"] = Number(value);
			} else throw new NavigationError("Unknown or unsupported option. " + usage(mode));
		} else {
			if (result.path || !token) throw new NavigationError(usage(mode));
			result.path = token;
		}
	}
	if (!result.path) throw new NavigationError(usage(mode));
	if (result.column && !result.line) throw new NavigationError("--column requires --line. " + usage(mode));
	return result;
}

const ADVICE: Record<string, string> = {
	outside_roots: "The path is outside the node's roots; add its directory to `roots` in ~/.pika-node/config.json.",
	not_found: "The file does not exist on this node.",
	is_a_directory: "The path is a directory; /pika-open opens files.",
	unavailable: "Check that pika-node is running on this machine (`pika-node status`).",
	timeout: "The daemon may be overloaded; retry.",
};

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	// Escape terminal controls in filenames and daemon text.
	const safe = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
	try { ctx.ui.notify(safe, level); } catch { /* stale or noninteractive UI */ }
}

export async function navigate(send: Send | undefined, input: string, ctx: ExtensionCommandContext, mode: Mode): Promise<void> {
	let options: Options;
	try { options = parse(input, mode); }
	catch (error) {
		notify(ctx, error instanceof NavigationError ? error.message : usage(mode), "error");
		return;
	}
	if (!send) {
		notify(ctx, "pika-node bridge is inactive: this pi was not started in a pika-node terminal.", "error");
		return;
	}
	// The daemon wants absolute paths; it resolves symlinks and checks its roots itself.
	const path = resolve(ctx.cwd, options.path);
	const reply = await send(mode === "open"
		? { type: "open", path, ...(options.line ? { line: options.line } : {}), ...(options.column ? { column: options.column } : {}) }
		: { type: "diff", path, ...(options.staged ? { staged: true } : {}) });
	const what = mode === "diff" ? `diff for ${options.path}${options.staged ? " (staged)" : ""}` : options.path;
	if ("error" in reply) {
		const { code, message } = reply.error;
		const detail = message && !/[.!?]$/.test(message) ? `${message}.` : message;
		notify(ctx, [`pika ${mode} failed (${code}).`, detail, ADVICE[code]].filter(Boolean).join(" "), "error");
		return;
	}
	if (reply.delivered === 0) notify(ctx, `No pika window is connected to this node; ${what} was not shown.`, "warning");
	else notify(ctx, `Sent ${what} to ${reply.delivered} pika window${reply.delivered === 1 ? "" : "s"}.`, "info");
}

export function registerNavigationCommands(pi: ExtensionAPI, send: () => Send | undefined): void {
	pi.registerCommand("pika-open", {
		description: "Open a file in the pika web UI's editor for this node: /pika-open <path> [--line N] [--column N]",
		handler: (args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: "pika-open", kind: "extension", extension: "pika-node-bridge" });
			return navigate(send(), args, ctx, "open");
		},
	});
	pi.registerCommand("pika-diff", {
		description: "Show a file's diff in the pika web UI for this node: /pika-diff <path> [--staged]",
		handler: (args, ctx) => {
			pi.appendEntry("pi-extensions.command", { command: "pika-diff", kind: "extension", extension: "pika-node-bridge" });
			return navigate(send(), args, ctx, "diff");
		},
	});
}
