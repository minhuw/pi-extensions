/**
 * lint.ts — offline checks for agent context files (AGENTS.md, CLAUDE.md, ...).
 *
 * Pure apart from reading the filesystem and running read-only `git` commands (`rev-parse`, `ls-files`,
 * `check-ignore`); no network, no model. Nothing is cached across calls: each call lists the repository afresh.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";

/** Pi's candidate context-file names, in its precedence order (first match per directory wins). */
export const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

/** The size past which a context file is reported: every session loads it in full. */
export const MAX_LINES = 200;
export const MAX_BYTES = 25_000;

export type FindingKind = "budget" | "dead-path" | "dead-script" | "dead-link" | "duplicate";

export interface LintFinding {
	kind: FindingKind;
	/** 1-based line of the finding; absent for whole-file findings such as the budget. */
	line?: number;
	/** One plain sentence, e.g. "`extensions/foo/` does not exist in the repository." */
	message: string;
}

/** Whether `path` (absolute or relative) names a context file by its base name. */
export function isContextFile(path: string): boolean {
	return (CONTEXT_FILE_NAMES as readonly string[]).includes(basename(path));
}

/**
 * Findings for one context file's `text`. `file` is the file's absolute path; `root` is the repository root that
 * paths, links, and `npm run` scripts are resolved against.
 */
export function lintContextFile(text: string, options: { file: string; root: string }): LintFinding[] {
	const root = resolve(options.root);
	const context: LintContext = {
		root,
		fileDir: dirname(resolve(root, options.file)),
		index: indexPaths(listRepositoryPaths(root)),
		scripts: new Map(),
	};
	const findings: LintFinding[] = [];
	const budget = budgetFinding(text);
	if (budget) findings.push(budget);

	const pathTokens: { token: string; line: number }[] = [];
	const seenLines = new Set<string>();
	let fence: { char: string; length: number; cwd: string | undefined } | undefined;
	splitLines(text).forEach((content, index) => {
		const line = index + 1;
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
		if (fence) {
			if (fenceMatch && fenceMatch[1]![0] === fence.char && fenceMatch[1]!.length >= fence.length && !fenceMatch[2]!.trim()) {
				fence = undefined;
			} else {
				fence.cwd = checkCommands(content, line, fence.cwd, context, findings);
			}
			return;
		}
		if (fenceMatch && !(fenceMatch[1]![0] === "`" && fenceMatch[2]!.includes("`"))) {
			fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length, cwd: root };
			return;
		}
		const spans = codeSpans(content);
		for (const span of spans) {
			const token = pathCandidate(span.content);
			if (token !== undefined) pathTokens.push({ token, line });
			checkCommands(span.content, line, root, context, findings);
		}
		checkLinks(withoutSpans(content, spans), line, context, findings);
		checkDuplicate(content, line, seenLines, findings);
	});

	const dead = deadPaths([...new Set(pathTokens.map((entry) => entry.token))], context);
	for (const { token, line } of pathTokens) {
		if (dead.has(token)) findings.push({ kind: "dead-path", line, message: `\`${token}\` names no file in the repository.` });
	}
	return findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/** The findings of `after` that `before` does not have (compared by kind and message, ignoring line numbers). */
export function newFindings(before: LintFinding[], after: LintFinding[]): LintFinding[] {
	// A multiset: a second occurrence of a finding `before` has once is still new.
	const remaining = new Map<string, number>();
	for (const finding of before) remaining.set(findingKey(finding), (remaining.get(findingKey(finding)) ?? 0) + 1);
	return after.filter((finding) => {
		const count = remaining.get(findingKey(finding)) ?? 0;
		if (count === 0) return true;
		remaining.set(findingKey(finding), count - 1);
		return false;
	});
}

/**
 * The context files of the repository holding `cwd`: every tracked file with a context-file name (git ls-files),
 * or, outside git, the first context file in `cwd` and each of its ancestors. Absolute paths, root first.
 *
 * Inside git, untracked files git does not ignore count as well (a context file added but not committed yet).
 * Outside git the root is `cwd`.
 */
export function repositoryContextFiles(cwd: string): { root: string; files: string[] } {
	const start = resolve(cwd);
	const topLevel = git(start, ["rev-parse", "--show-toplevel"])?.trim();
	if (topLevel) {
		const files = (listRepositoryPaths(topLevel) ?? [])
			.filter((path) => isContextFile(path))
			.sort(compareContextPaths)
			.map((path) => join(topLevel, ...path.split("/")))
			.filter(isFile);
		return { root: topLevel, files };
	}
	const files: string[] = [];
	for (let directory = start; ; directory = dirname(directory)) {
		const found = CONTEXT_FILE_NAMES.map((name) => join(directory, name)).find(isFile);
		if (found) files.push(found);
		if (dirname(directory) === directory) break;
	}
	return { root: start, files: files.reverse() };
}

// ---------------------------------------------------------------------------------------------------------------

interface PathIndex {
	/** Every listed file and each of its parent directories, `/`-separated and relative to the root. */
	paths: Set<string>;
	directories: Set<string>;
	/** Listed paths by their last segment, for suffix matching. */
	byLastSegment: Map<string, string[]>;
}

interface LintContext {
	root: string;
	fileDir: string;
	/** Absent outside git, where only the filesystem is consulted. */
	index: PathIndex | undefined;
	/** `package.json` scripts by directory; `null` when the directory has no readable `package.json`. */
	scripts: Map<string, Set<string> | null>;
}

/** Extensions that make a slash-free backticked token look like a file name (not `pi.extensions` or `Symbol.for`). */
const FILE_EXTENSIONS = new Set([
	"ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "jsonc", "json5", "md", "mdx", "markdown", "rs",
	"toml", "yaml", "yml", "py", "go", "sh", "bash", "zsh", "fish", "ps1", "txt", "html", "htm", "css", "scss", "sass",
	"less", "sql", "lock", "c", "h", "cc", "cpp", "hpp", "cxx", "java", "kt", "kts", "swift", "rb", "php", "lua",
	"vue", "svelte", "astro", "xml", "ini", "cfg", "conf", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "pdf",
	"csv", "tsv", "proto", "graphql", "gql", "wasm", "zig", "nix", "dart", "scala", "gradle", "tf", "hcl", "mk",
]);

/** Root names that are git ref namespaces or remotes rather than directories (`refs/heads/main`, `origin/main`). */
const REF_ROOTS = new Set(["refs", "origin", "upstream"]);

function findingKey(finding: LintFinding): string {
	return `${finding.kind}\u0000${finding.message}`;
}

function splitLines(text: string): string[] {
	const lines = text.split(/\r?\n/);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function budgetFinding(text: string): LintFinding | undefined {
	// The message names the limit, not the count, so an edit to a file that stays over budget adds no new finding.
	const overLines = splitLines(text).length > MAX_LINES;
	const overBytes = Buffer.byteLength(text, "utf8") > MAX_BYTES;
	if (!overLines && !overBytes) return undefined;
	const what = [overLines ? `longer than ${MAX_LINES} lines` : "", overBytes ? `larger than ${MAX_BYTES} bytes` : ""].filter(Boolean).join(" and ");
	return { kind: "budget", message: `The file is ${what}, and every session loads it in full.` };
}

// --- git ---------------------------------------------------------------------------------------------------------

function git(cwd: string, args: string[], input?: string): string | undefined {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		input,
		maxBuffer: 256 * 1024 * 1024,
		timeout: 30_000,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
	});
	if (result.error) return undefined;
	// `git check-ignore` exits 1 when no path is ignored: a valid, empty answer.
	if (result.status === 0 || (result.status === 1 && args[0] === "check-ignore")) return result.stdout;
	return undefined;
}

/** Tracked files plus untracked files git does not ignore, relative to `root`; `undefined` outside git. */
function listRepositoryPaths(root: string): string[] | undefined {
	if (!existsSync(root)) return undefined;
	const output = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	return output === undefined ? undefined : output.split("\0").filter(Boolean);
}

function indexPaths(files: string[] | undefined): PathIndex | undefined {
	if (!files) return undefined;
	const index: PathIndex = { paths: new Set(), directories: new Set(), byLastSegment: new Map() };
	const add = (path: string) => {
		if (index.paths.has(path)) return;
		index.paths.add(path);
		const last = path.slice(path.lastIndexOf("/") + 1);
		const list = index.byLastSegment.get(last);
		if (list) list.push(path);
		else index.byLastSegment.set(last, [path]);
	};
	for (const file of files) {
		add(file);
		for (let slash = file.lastIndexOf("/"); slash > 0; slash = file.lastIndexOf("/", slash - 1)) {
			const directory = file.slice(0, slash);
			index.directories.add(directory);
			add(directory);
		}
	}
	return index;
}

/** Listed paths equal to `path` or ending with `/<path>` (whole segments only). */
function suffixMatches(index: PathIndex, path: string): string[] {
	const last = path.slice(path.lastIndexOf("/") + 1);
	return (index.byLastSegment.get(last) ?? []).filter((candidate) => candidate === path || candidate.endsWith(`/${path}`));
}

function compareContextPaths(a: string, b: string): number {
	const depth = (path: string) => path.split("/").length;
	if (depth(a) !== depth(b)) return depth(a) - depth(b);
	const directory = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
	if (directory(a) !== directory(b)) return directory(a) < directory(b) ? -1 : 1;
	const rank = (path: string) => (CONTEXT_FILE_NAMES as readonly string[]).indexOf(path.slice(path.lastIndexOf("/") + 1));
	return rank(a) - rank(b);
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// --- inline code -------------------------------------------------------------------------------------------------

interface CodeSpan {
	content: string;
	start: number;
	end: number;
}

/** CommonMark-style code spans of one line: a run of N backticks closed by the next run of exactly N. */
function codeSpans(line: string): CodeSpan[] {
	const spans: CodeSpan[] = [];
	let index = 0;
	while (index < line.length) {
		if (line[index] === "\\") {
			index += 2;
			continue;
		}
		if (line[index] !== "`") {
			index++;
			continue;
		}
		let open = index;
		while (line[open] === "`") open++;
		const length = open - index;
		let close = -1;
		for (let scan = open; scan < line.length; ) {
			if (line[scan] !== "`") {
				scan++;
				continue;
			}
			let end = scan;
			while (line[end] === "`") end++;
			if (end - scan === length) {
				close = scan;
				break;
			}
			scan = end;
		}
		if (close < 0) {
			index = open;
			continue;
		}
		spans.push({ content: line.slice(open, close), start: index, end: close + length });
		index = close + length;
	}
	return spans;
}

function withoutSpans(line: string, spans: CodeSpan[]): string {
	let result = line;
	for (const span of spans) result = result.slice(0, span.start) + " ".repeat(span.end - span.start) + result.slice(span.end);
	return result;
}

// --- dead paths --------------------------------------------------------------------------------------------------

/** The path a backticked token names, or `undefined` when the token is not a checkable repository path. */
function pathCandidate(content: string): string | undefined {
	let token = content.trim();
	if (!token || /\s/.test(token) || token.includes("...") || token.includes("…")) return undefined;
	// Absolute paths, `~/` paths, flags, npm scopes and decorators, Windows-style paths.
	if (/^[/~\-@\\]/.test(token)) return undefined;
	token = token.replace(/^([^#]+)#[^/]*$/, "$1").replace(/:\d+(?::\d+)?$/, "");
	// URLs and other schemes (`https:`, `npm:`, `node:`, `test:`), and protocol-relative URLs.
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(token) || token.startsWith("//")) return undefined;
	// Placeholders and globs (`<`, `>`, `*`, `$`, `{`, `}`, `?`, `[`), quotes, calls, assignments.
	if (!/^[\w.\-+/@~]+$/.test(token) || /^[\d./]+$/.test(token)) return undefined;
	const segments = token.replace(/\/+$/, "").split("/");
	if (!token.includes("/")) {
		// A bare name needs a file extension and a stem: `.ts` and `.test.ts` name suffixes, not files.
		if (token.startsWith(".")) return undefined;
		const dot = token.lastIndexOf(".");
		if (dot <= 0 || !FILE_EXTENSIONS.has(token.slice(dot + 1).toLowerCase())) return undefined;
	}
	// A host name first (`github.com/owner/repo`) is a URL without its scheme.
	if (/^[\w-]+(\.[\w-]+)*\.(com|org|net|io|dev|app|ai|co|me|gg|xyz|edu|gov)$/i.test(segments[0] ?? "")) return undefined;
	return token;
}

/** The tokens of `tokens` that name nothing in the repository. */
function deadPaths(tokens: string[], context: LintContext): Set<string> {
	const unresolved = tokens.filter((token) => !pathResolves(token, context));
	const { index } = context;
	if (!index || unresolved.length === 0) return new Set(unresolved);
	const remaining = unresolved.filter((token) => !inUnlistedNamespace(token, index));
	const candidates = new Map(remaining.map((token) => [token, ignoreCandidates(token, context, index)]));
	const ignored = ignoredPaths([...new Set([...candidates.values()].flat())], context.root);
	return new Set(remaining.filter((token) => !candidates.get(token)!.some((candidate) => ignored.has(candidate))));
}

function pathResolves(token: string, context: LintContext): boolean {
	const path = token.replace(/\/+$/, "");
	if (existsSync(resolve(context.root, path)) || existsSync(resolve(context.fileDir, path))) return true;
	const relativePath = repositoryRelative(path);
	return Boolean(context.index && relativePath && suffixMatches(context.index, relativePath).length > 0);
}

/** `path` normalised to a `/`-separated path inside the root, or `undefined` when it climbs out with `..`. */
function repositoryRelative(path: string): string | undefined {
	const normalized = posix.normalize(path).replace(/\/+$/, "");
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
	return normalized;
}

/**
 * A path under a dot directory (`.pi/`, `.git/`, `.cache/`) or a git ref namespace (`refs/`, `origin/`) that holds no
 * listed file: local tool state or a ref name, which a fresh clone does not have.
 */
function inUnlistedNamespace(token: string, index: PathIndex): boolean {
	const first = repositoryRelative(token.replace(/\/+$/, ""))?.split("/")[0];
	if (!first || !token.includes("/")) return false;
	const namespace = (first.startsWith(".") && first !== "." && first !== "..") || REF_ROOTS.has(first);
	return namespace && !index.paths.has(first);
}

/**
 * Repository-relative paths that would make `token` a git-ignored path (a build output such as `web/dist` that a
 * fresh checkout lacks): the token from the root and from the file's directory, and the token's remainder under
 * every listed directory that its longest resolvable prefix names. Each in both forms, since git matches
 * directory-only patterns (`dist/`) against a path that does not exist only when it ends in `/`.
 */
function ignoreCandidates(token: string, context: LintContext, index: PathIndex): string[] {
	const path = repositoryRelative(token.replace(/\/+$/, ""));
	const bases: string[] = [];
	if (path) bases.push(path);
	const fromFile = relative(context.root, resolve(context.fileDir, token.replace(/\/+$/, "")));
	if (fromFile && !fromFile.startsWith("..") && !isAbsolute(fromFile)) bases.push(fromFile.split(sep).join("/"));
	if (path) {
		const segments = path.split("/");
		for (let length = segments.length - 1; length >= 1; length--) {
			const prefix = segments.slice(0, length).join("/");
			const directories = suffixMatches(index, prefix).filter((candidate) => index.directories.has(candidate));
			if (directories.length === 0) continue;
			const rest = segments.slice(length).join("/");
			for (const directory of directories.slice(0, 64)) bases.push(`${directory}/${rest}`);
			break;
		}
	}
	return [...new Set(bases)].filter((base) => base.split("/")[0] !== ".git").flatMap((base) => [base, `${base}/`]);
}

function ignoredPaths(paths: string[], root: string): Set<string> {
	if (paths.length === 0) return new Set();
	const query = (batch: string[]) => git(root, ["check-ignore", "-z", "--stdin"], `${batch.join("\0")}\0`);
	const batch = query(paths);
	// One bad path (outside the repository, beyond a symlink) fails the whole batch; then ask path by path.
	const outputs = batch !== undefined ? [batch] : paths.map((path) => query([path]) ?? "");
	return new Set(outputs.flatMap((output) => output.split("\0")).filter(Boolean));
}

// --- npm scripts -------------------------------------------------------------------------------------------------

/**
 * Checks every `npm run <name>` of one command line and returns the working directory after it: `cd <dir>`
 * moves it (so `cd web && npm run build` is checked against `web/package.json`); `undefined` means unknown.
 */
function checkCommands(text: string, line: number, cwd: string | undefined, context: LintContext, findings: LintFinding[]): string | undefined {
	let directory = cwd;
	for (const command of text.split(/&&|\|\||[;|()]/)) {
		const words = command.trim().split(/\s+/).filter(Boolean);
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
		if (words[0] === "cd") {
			const target = words[1];
			directory = directory && target && /^[\w.\-+/@]+$/.test(target) && !target.startsWith("-") ? resolve(directory, target) : undefined;
			continue;
		}
		if (words[0] !== "npm" || (words[1] !== "run" && words[1] !== "run-script")) continue;
		const name = words[2];
		if (!name || !directory || name.startsWith("-") || !/^[\w:.\-@/+]+$/.test(name)) continue;
		const scripts = packageScripts(directory, context);
		if (!scripts || scripts.has(name)) continue;
		const manifest = relative(context.root, join(directory, "package.json")).split(sep).join("/");
		findings.push({ kind: "dead-script", line, message: `\`npm run ${name}\` names no script in ${manifest}.` });
	}
	return directory;
}

function packageScripts(directory: string, context: LintContext): Set<string> | null {
	const cached = context.scripts.get(directory);
	if (cached !== undefined) return cached;
	let scripts: Set<string> | null = null;
	try {
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { scripts?: unknown };
		const entries = manifest.scripts && typeof manifest.scripts === "object" ? Object.keys(manifest.scripts) : [];
		scripts = new Set(entries);
	} catch {
		scripts = null;
	}
	context.scripts.set(directory, scripts);
	return scripts;
}

// --- links -------------------------------------------------------------------------------------------------------

const LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

function checkLinks(text: string, line: number, context: LintContext, findings: LintFinding[]): void {
	for (const match of text.matchAll(LINK)) {
		let target = match[1]!;
		if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
		target = target.trim();
		if (!target || target.startsWith("#") || target.startsWith("//") || target.startsWith("~")) continue;
		if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) continue;
		const path = target.replace(/[?#].*$/, "");
		if (!path || /[<>{}$*]/.test(path)) continue;
		let decoded = path;
		try {
			decoded = decodeURIComponent(path);
		} catch {
			// Keep the raw target when it is not valid percent-encoding.
		}
		const absolute = decoded.startsWith("/") ? join(context.root, decoded) : resolve(context.fileDir, decoded);
		if (!existsSync(absolute)) findings.push({ kind: "dead-link", line, message: `The link to \`${path}\` names no file in the repository.` });
	}
}

// --- duplicates --------------------------------------------------------------------------------------------------

function checkDuplicate(content: string, line: number, seen: Set<string>, findings: LintFinding[]): void {
	const text = content
		.trim()
		.replace(/^(?:>\s?)+/, "")
		.replace(/^(?:[-*+]|\d+[.)])\s+/, "")
		.replace(/^\[[ xX]\]\s+/, "")
		.trim();
	// Headings, table separators, rules, and bare HTML tags or comments legitimately repeat.
	if (!text || /^#{1,6}(\s|$)/.test(text) || !/[\p{L}\p{N}]/u.test(text)) return;
	if (/^<\/?[A-Za-z][\w-]*(\s[^>]*)?\/?>$/.test(text) || /^<!--.*-->$/.test(text)) return;
	if (!seen.has(text)) {
		seen.add(text);
		return;
	}
	const excerpt = text.length > 80 ? `${text.slice(0, 79)}…` : text;
	findings.push({ kind: "duplicate", line, message: `The line "${excerpt}" repeats an earlier line.` });
}
