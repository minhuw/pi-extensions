import { execFile } from "node:child_process";
import { constants, lstatSync, realpathSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import type { TSchema } from "typebox";
import {
	createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition,
	defineTool, getAgentDir, truncateHead, truncateLine, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isInside } from "../src/daemon/git/primitives.ts";

const HANDOFF = "Ask the caller to supply the needed target excerpt inline; Recon cannot inspect outside its assigned worktree or runtime metadata.";
const reserved = (name: string) => [".git", ".herder"].includes(name.toLowerCase());
const components = (value: string) => value.split(path.sep).filter(Boolean);
const deny = (reason: string): never => { throw new Error(`Recon filesystem scope denied: ${reason}. ${HANDOFF}`); };

/** Lexical admission only; checked() subsequently validates every component on the native filesystem. */
export function reconRelativePath(raw: string, lexicalRoot: string, canonicalRoot: string, paths: path.PlatformPath = path): string {
	if (!raw || raw.startsWith("@") || raw.startsWith("~") || /[\x00-\x1f\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(raw)) return deny("unsupported path syntax");
	if (paths.sep === "\\") {
		// Accept drive-absolute paths and native relative separators, never drive-relative, UNC, device or ADS aliases.
		const withoutDrive = /^[a-z]:[\\/]/i.test(raw) ? raw.slice(2) : raw;
		if (/^[\\/]/.test(raw) || withoutDrive.includes(":")) return deny("unsupported Windows path syntax");
		if (raw.split(/[\\/]/).some((part) => part !== "." && part !== ".." && /[ .]$/.test(part))) return deny("Windows trailing-dot/space aliases are not allowed");
	} else if (/[\\:]/.test(raw) || raw.startsWith("//")) return deny("unsupported path syntax");
	const lexical = paths.resolve(lexicalRoot, raw);
	const base = [lexicalRoot, canonicalRoot].find((candidate) => {
		const relative = paths.relative(candidate, lexical);
		return relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
	});
	if (!base) return deny("path is outside the assigned worktree");
	const relative = paths.relative(base, lexical);
	const rawRelative = paths.isAbsolute(raw) ? raw.slice(base.length) : raw;
	if ([rawRelative, relative].some((value) => value.split(paths.sep === "\\" ? /[\\/]/ : "/").some(reserved))) return deny(".git and .herder are reserved");
	return relative;
}

function boundedNumber(value: number | undefined, fallback: number, max: number, min = 1): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < min) throw new Error(`Expected an integer >= ${min}.`);
	return Math.min(value, max);
}

/** Same-name overrides, used only by Recon (including reviewer grandchildren). */
export function createReconTools(worktree: string, scopeSignal: AbortSignal, agentDir = getAgentDir()) {
	const lexicalRoot = path.resolve(worktree);
	const root = realpathSync(lexicalRoot);
	const checked = (raw: string = "."): string => {
		scopeSignal.throwIfAborted();
		const relative = reconRelativePath(raw, lexicalRoot, root);
		let candidate = root;
		// ponytail: reject all in-tree symlinks, including internal ones; caller supplies target excerpts instead.
		for (const component of components(relative)) {
			candidate = path.join(candidate, component);
			const stat = lstatSync(candidate);
			if (stat.isSymbolicLink()) return deny("symlinks below the worktree root are not allowed");
			if (!stat.isFile() && !stat.isDirectory()) return deny("only regular files and directories are allowed");
		}
		const canonical = realpathSync(candidate);
		if (!isInside(root, canonical) || components(path.relative(root, canonical)).some(reserved)) return deny("resolved path leaves source scope");
		return canonical;
	};
	const read = createReadToolDefinition(root, {
		operations: {
			access: async (file) => {
				if (!lstatSync(checked(file)).isFile()) deny("read requires a regular file");
			},
			readFile: async (file) => {
				const handle = await open(checked(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					if (!(await handle.stat()).isFile()) deny("read requires a regular file");
					checked(file);
					return await handle.readFile();
				} finally { await handle.close(); }
			},
			detectImageMimeType: async (file) => {
				const extension = path.extname(checked(file)).toLowerCase();
				return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" } as Record<string, string>)[extension];
			},
		},
	});
	const ls = createLsToolDefinition(root, {
		operations: {
			exists: (file) => { checked(file); return true; },
			stat: (file) => lstatSync(checked(file)),
			readdir: async (directory) => (await readdir(checked(directory), { withFileTypes: true }))
				.filter((entry) => !reserved(entry.name) && (entry.isFile() || entry.isDirectory()))
				.map((entry) => entry.name),
		},
	});

	async function runRg(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
		const run = (binary: string): Promise<string> => new Promise((resolve, reject) => {
			signal.throwIfAborted();
			execFile(binary, args, { cwd, signal, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
				if (signal.aborted) { reject(new Error("Recon search cancelled.")); return; }
				// rg exit 1 means no matches, but warnings/traversal failures are never a successful empty search.
				if (stderr.trim() || (error && error.code !== 1)) {
					if (error && error.code === "ENOENT") { reject(error); return; }
					reject(new Error(`Recon search failed: ${truncateLine(stderr.trim() || error?.message || "unknown ripgrep error").text}. Narrow the search or hand off. ${HANDOFF}`));
				} else resolve(stdout);
			});
		});
		try { return await run("rg"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try { return await run(path.join(agentDir, "bin", process.platform === "win32" ? "rg.exe" : "rg")); }
			catch (fallbackError) {
				if ((fallbackError as NodeJS.ErrnoException).code !== "ENOENT") throw fallbackError;
				throw new Error(`Recon search unavailable: ripgrep is missing from PATH and Pi bin. No download attempted. ${HANDOFF}`);
			}
		}
	}
	const searchArgs = (glob?: string): string[] => [
		// --no-follow alone still reads symlinked ignore files. Disable their processing entirely.
		"--no-config", "--no-follow", "--hidden", "--no-ignore", "--sort=path",
		...(glob === undefined ? [] : ["--glob", glob]),
		// Final overrides win even over a caller's **/* or explicit metadata glob; prune before traversal.
		...[".git", ".herder", "node_modules"].flatMap((name) => ["--iglob", `!**/${name}`, "--iglob", `!**/${name}/**`]),
	];
	const searchLocation = (file: string) => {
		const target = checked(file);
		if (components(path.relative(root, target)).some((part) => part.toLowerCase() === "node_modules")) deny("node_modules search traversal is excluded");
		return lstatSync(target).isDirectory() ? { cwd: target, target: "." } : { cwd: path.dirname(target), target: path.basename(target) };
	};
	const find = createFindToolDefinition(root);
	find.description = find.description.replace(/respects \.gitignore/gi, "does not process ignore files") + " Uses Node glob semantics: name hidden path components explicitly.";
	find.promptSnippet = "Find source files by glob; ignore files disabled; name hidden path components explicitly";
	find.execute = async (_id, input, signal) => {
		const location = searchLocation(input.path ?? ".");
		if (location.target !== ".") throw new Error("Recon find requires a directory.");
		const limit = boundedNumber(input.limit, 1000, 2000);
		const stdout = await runRg([...searchArgs(), "--files", "--null", "--", location.target], location.cwd, signal!);
		const results = stdout.split("\0").filter(Boolean).map((file) => file.replace(/^\.\//, ""))
			.filter((file) => path.matchesGlob(input.pattern.includes("/") ? file : path.basename(file), input.pattern));
		const truncation = truncateHead(results.slice(0, limit).join("\n"));
		const details = {
			...(results.length > limit ? { resultLimitReached: limit } : {}),
			...(truncation.truncated ? { truncation } : {}),
		};
		const notices = [results.length > limit ? `${limit} results limit reached` : "", truncation.truncated ? "output truncated (line/byte limit)" : ""].filter(Boolean);
		return { content: [{ type: "text", text: (truncation.content || (results.length ? "" : "No files found matching pattern")) + (notices.length ? `\n\n[${notices.join("; ")}. Narrow the search.]` : "") }], details };
	};
	const grep = createGrepToolDefinition(root);
	grep.description = grep.description.replace(/respects \.gitignore/gi, "does not process ignore files");
	grep.promptSnippet = "Search source contents for patterns; ignore files disabled";
	grep.execute = async (_id, input, signal) => {
		const location = searchLocation(input.path ?? ".");
		const limit = boundedNumber(input.limit, 100, 2000);
		const context = boundedNumber(input.context, 0, 100, 0);
		const stdout = await runRg([
			...searchArgs(input.glob), "--json", "--line-number", "--color=never", "--context", String(context),
			...(input.ignoreCase ? ["--ignore-case"] : []), ...(input.literal ? ["--fixed-strings"] : []),
			"--", input.pattern, location.target,
		], location.cwd, signal!);
		const lines: string[] = [];
		let matches = 0;
		let linesTruncated = false;
		for (const line of stdout.split("\n").filter(Boolean)) {
			const event = JSON.parse(line);
			if (event.type !== "match" && event.type !== "context") continue;
			if (event.type === "match" && ++matches > limit) break;
			const decode = (value: { text?: string; bytes?: string }) => value.text ?? Buffer.from(value.bytes!, "base64").toString("utf8");
			const file = decode(event.data.path).replace(/^\.\//, "");
			const shortened = truncateLine(decode(event.data.lines).replace(/\r?\n$/, ""));
			linesTruncated ||= shortened.wasTruncated;
			const separator = event.type === "match" ? ":" : "-";
			lines.push(`${file}${separator}${event.data.line_number}${separator} ${shortened.text}`);
		}
		const truncation = truncateHead(lines.join("\n"));
		const details = {
			...(matches > limit ? { matchLimitReached: limit } : {}),
			...(truncation.truncated ? { truncation } : {}), ...(linesTruncated ? { linesTruncated } : {}),
		};
		const notices = [matches > limit ? `${limit} matches limit reached` : "", truncation.truncated ? "output truncated (line/byte limit)" : "", linesTruncated ? "long lines truncated" : ""].filter(Boolean);
		return { content: [{ type: "text", text: (truncation.content || (matches ? "" : "No matches found")) + (notices.length ? `\n\n[${notices.join("; ")}. Narrow the search.]` : "") }], details };
	};
	function scoped<T extends TSchema, D>(tool: ToolDefinition<T, D>) {
		return defineTool({
			...tool,
			description: `${tool.description} Recon scope: assigned worktree only; .git/.herder and symlinks excluded. ${HANDOFF}`,
			execute: async (id, input, signal, onUpdate, ctx) => {
				const combined = signal ? AbortSignal.any([scopeSignal, signal]) : scopeSignal;
				combined.throwIfAborted();
				const params = input as { path?: string; limit?: number };
				const target = checked(params.path ?? ".");
				const result = await tool.execute(id, Object.assign({}, input, { path: target }, tool.name === "ls" ? { limit: boundedNumber(params.limit, 500, 2000) } : {}), combined, onUpdate, ctx);
				combined.throwIfAborted();
				return result;
			},
		});
	}
	return [scoped(read), scoped(ls), scoped(find), scoped(grep)];
}
