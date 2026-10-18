import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { Extension, ExtensionContext, ExtensionToolContext, LoadExtensionsResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createReconPathGuard, reconRelativePath } from "./recon-tools.ts";

const require = createRequire(import.meta.url);
export const FFF_EXTENSION_PATH = require.resolve("@ff-labs/pi-fff/src/index.ts");
export const FFF_TOOL_NAMES = ["fffind", "ffgrep"] as const;

const SCOPE_ERROR = "FFF result is outside the assigned source scope. Use built-in scoped grep/find or ask the caller for the needed excerpt.";
const RESERVED = new Set([".git", ".herder", "node_modules"]);
const IGNORE_NAMES = new Set([".ignore", ".gitignore", ".rgignore"]);
const TEXT = (result: any): string => Array.isArray(result?.content)
	? result.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n")
	: "";

function sourceScope(worktree: string, signal: AbortSignal) {
	const lexicalRoot = path.resolve(worktree);
	const guard = createReconPathGuard(lexicalRoot, signal);
	const canonicalRoot = guard();
	const checkedPatternPath = (raw?: string): string | undefined => {
		if (raw === undefined || raw === "") return undefined;
		const relative = reconRelativePath(raw, lexicalRoot, canonicalRoot);
		const normalized = relative.split(path.sep).join("/");
		const segments = normalized.split("/");
		if (segments.some((part) => RESERVED.has(part.toLowerCase()))) throw new Error(SCOPE_ERROR);
		// FFF accepts globs. Admit the literal directory prefix so a wildcard suffix
		// remains useful while the full lexical expression stays rooted in worktree.
		const prefix: string[] = [];
		for (const segment of segments) {
			if (/[*?{[!]/.test(segment)) break;
			prefix.push(segment);
		}
		let candidate = prefix.join(path.sep) || ".";
		while (true) {
			try { guard(candidate); break; }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				const parent = path.dirname(candidate);
				if (parent === candidate) throw error;
				candidate = parent;
			}
		}
		return normalized || ".";
	};

	const validateOutput = (toolName: string, text: string): void => {
		if (!text || /^No (matches found|files found matching pattern)$/i.test(text.trim())) return;
		const lines = text.split(/\r?\n/);
		for (const line of lines) {
			if (line.trim() === "") continue;
			if (toolName === "ffgrep" && /^ \d+[-:] /.test(line)) continue;
			const candidates = [line, line.replace(/  \[[^\]]*\]$/, "")];
			let admitted = false;
			for (const candidate of candidates) {
				try {
					const relative = reconRelativePath(candidate, lexicalRoot, canonicalRoot);
					if (relative.split(path.sep).some((part) => RESERVED.has(part.toLowerCase()))) continue;
					guard(candidate);
					admitted = true;
					break;
				} catch { /* Try the native git/frecency annotation form. */ }
			}
			if (admitted) continue;
			if (candidates.some(candidate => existsSync(path.resolve(canonicalRoot, candidate)))) throw new Error(SCOPE_ERROR);
			// Only native notices may be non-path output; blank lines separate grep files too.
			if (/^\[(?:0 exact matches\. Maybe you meant this\?|Query .* produced only weak scattered fuzzy matches\.|\d+ more match(?:es)? available\.|Continue with cursor=|Invalid regex:).*\]$/.test(line)) continue;
			throw new Error(SCOPE_ERROR);
		}
	};

	const preflight = async () => {
		const root = await realpath(lexicalRoot);
		const inspect = async (directory: string): Promise<void> => {
			signal.throwIfAborted();
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (/[\x00-\x1f]/.test(entry.name)) throw new Error(SCOPE_ERROR);
				if (RESERVED.has(entry.name.toLowerCase())) continue;
				const filename = path.join(directory, entry.name);
				const stat = await lstat(filename);
				if (IGNORE_NAMES.has(entry.name.toLowerCase()) && (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))) {
					throw new Error(SCOPE_ERROR);
				}
				if (stat.isDirectory()) await inspect(filename);
				else if (!stat.isFile() && IGNORE_NAMES.has(entry.name.toLowerCase())) throw new Error(SCOPE_ERROR);
			}
		};
		// Ancestor ignore files can affect ripgrep's native ignore processing too.
		let ancestor = path.dirname(root);
		while (true) {
			for (const name of IGNORE_NAMES) {
				try {
					const stat = await lstat(path.join(ancestor, name));
					if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(SCOPE_ERROR);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			const parent = path.dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
		await inspect(root);
	};
	return { checkedPatternPath, validateOutput, preflight };
}

function extensionMatches(extension: Extension): boolean {
	return extension.resolvedPath === FFF_EXTENSION_PATH || extension.path === FFF_EXTENSION_PATH;
}

export function configureHerderFff(
	base: LoadExtensionsResult,
	options: { worktree: string; agentDir: string; sourceOnly: boolean; signal?: AbortSignal },
): LoadExtensionsResult {
	const matches = base.extensions.filter(extensionMatches);
	if (matches.length !== 1) throw new Error("Herder FFF extension was not loaded exactly once.");
	const target = matches[0]!;
	for (const name of FFF_TOOL_NAMES) if (!target.tools.has(name)) throw new Error(`Herder FFF extension lacks required tool ${name}.`);

	base.runtime.flagValues.set("fff-mode", "tools-only");
	base.runtime.flagValues.set("fff-follow-symlinks", false);
	base.runtime.flagValues.set("fff-frecency-db", path.join(options.agentDir, "fff", "frecency"));
	base.runtime.flagValues.set("fff-history-db", path.join(options.agentDir, "fff", "history"));

	for (const name of [...target.tools.keys()]) if (!(FFF_TOOL_NAMES as readonly string[]).includes(name)) target.tools.delete(name);
	target.commands.clear();
	target.shortcuts.clear();
	const initializers = [...(target.handlers.get("session_start") ?? [])];
	target.handlers.delete("session_start");
	target.handlers.delete("before_agent_start");

	const scopeSignal = options.signal ?? new AbortController().signal;
	const scope = options.sourceOnly ? sourceScope(options.worktree, scopeSignal) : undefined;
	let initialization: Promise<void> | undefined;
	const activeCalls = new Set<Promise<void>>();
	let closed = false;
	const shutdownHandlers = [...(target.handlers.get("session_shutdown") ?? [])];
	target.handlers.set("session_shutdown", [async (...args: unknown[]) => {
		closed = true;
		// A tool can still be opening an auxiliary finder after the main index is ready.
		await Promise.allSettled([...activeCalls]);
		// Native creation can still be waiting for its initial scan when cancellation arrives.
		try { await initialization; } catch { /* Cleanup also follows failed initialization. */ }
		for (const handler of shutdownHandlers) await handler(...args);
	}]);
	const assertOpen = () => {
		if (closed) throw new Error("Herder FFF session has shut down.");
		options.signal?.throwIfAborted();
	};
	const initialize = async (context: ExtensionContext, toolSignal?: AbortSignal): Promise<void> => {
		assertOpen();
		toolSignal?.throwIfAborted();
		if (!initialization) {
			initialization = (async () => {
				if (scope) await scope.preflight();
				assertOpen();
				toolSignal?.throwIfAborted();
				const ctx = {
					...context,
					cwd: options.worktree,
					ui: { ...context.ui, notify: () => undefined },
				};
				for (const handler of initializers) await (handler as (event: unknown, ctx: ExtensionContext) => unknown)(undefined, ctx);
			})();
		}
		await initialization;
		assertOpen();
		toolSignal?.throwIfAborted();
	};

	for (const name of FFF_TOOL_NAMES) {
		const registered = target.tools.get(name)!;
		const original = registered.definition;
		const execute = original.execute;
		const schema = original.parameters as unknown as { properties: Record<string, Record<string, unknown>> };
		const cursors = new Set<string>();
		const wrapped = {
			...original,
			...(scope ? {
				description: `${original.description} Herder source scope: assigned worktree only; .git, .herder, node_modules and symlink traversal are excluded. Use built-in scoped grep/find if native indexing is unavailable.`,
				parameters: { ...original.parameters, properties: {
					...schema.properties,
					path: { ...schema.properties.path, description: "Path or glob inside the assigned worktree. In-worktree absolute paths are accepted; external paths and metadata are forbidden." },
				} },
			} : {}),
			execute: async (callId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, toolContext: ExtensionToolContext) => {
				assertOpen();
				let settle!: () => void;
				const settled = new Promise<void>(resolve => { settle = resolve; });
				activeCalls.add(settled);
				try {
					signal?.throwIfAborted();
					if (params?.cursor && !cursors.has(params.cursor)) throw new Error("FFF pagination cursor is not valid for this session.");
					if (scope) {
						const admittedPath = scope.checkedPatternPath(params?.path);
						params = { ...params, path: admittedPath, exclude: [params?.exclude, ".git", ".git/", ".herder/", "node_modules/"].filter(Boolean).flat() };
					}
					await initialize(toolContext, signal);
					assertOpen();
					const result = await execute.call(original, callId, params, signal, onUpdate, toolContext);
					assertOpen();
					signal?.throwIfAborted();
					const text = TEXT(result);
					if (scope) scope.validateOutput(name, text);
					// Capture only the formatter's final pagination notice, never matching file contents.
					const lastLine = text.trimEnd().split("\n").at(-1) ?? "";
					const cursor = name === "fffind"
						? lastLine.match(/^\[\d+ more match(?:es)? available\. cursor="(\d+)" to continue\]$/)?.[1]
						: lastLine.match(/^\[(?:Invalid regex: .*\. )?Continue with cursor="(fff_c\d+)"\]$/)?.[1];
					if (cursor) {
						cursors.add(cursor);
						if (cursors.size > 200) cursors.delete(cursors.values().next().value!);
					}
					return result;
				} finally {
					activeCalls.delete(settled);
					settle();
				}
			},
		};
		target.tools.set(name, { ...registered, definition: wrapped as ToolDefinition });
	}
	return base;
}
