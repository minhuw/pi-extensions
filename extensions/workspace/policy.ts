import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { forEachChild, parse, type Command, type HereDoc, type SyntaxNode, type Word, type WordPart } from "unbash";

export interface ProjectPolicy {
	allowedPaths: string[];
	defaultTtlMs: number;
}

export interface PathAccessOptions {
	targetPath: string;
	cwd: string;
	/** Take `targetPath` as written, as `resolveLiteralPath` does, instead of as a shell word. */
	literal?: boolean;
	sessionAllowed?: Iterable<string>;
	projectAllowed?: Iterable<string>;
	extraAllowed?: Iterable<string>;
}

export interface PathAccessEvaluation {
	allowed: boolean;
	resolvedPath: string;
	matchedRoot?: string;
	reason?: string;
}

function expandHomeTokens(input: string): string {
	const home = os.homedir();
	let expanded = input.trim();
	if ((expanded.startsWith('"') && expanded.endsWith('"')) || (expanded.startsWith("'") && expanded.endsWith("'"))) {
		expanded = expanded.slice(1, -1);
	}
	if (expanded === "~") {
		expanded = home;
	} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
		expanded = path.join(home, expanded.slice(2));
	}
	expanded = expanded.replace(/\$\{HOME\}|\$HOME(?=$|[\\/])/g, home);
	return expanded;
}

/**
 * Resolves symlinks in the absolute `absPath` via the deepest existing ancestor on disk. A link's
 * target is read the way the OS reads it: as written, relative to the link's directory.
 */
function resolveSymlinks(absPath: string, seen: Set<string>): string {
	const trailing: string[] = [];
	let current = absPath;

	while (true) {
		try {
			const real = fs.realpathSync(current);
			return trailing.length > 0 ? path.join(real, ...trailing) : real;
		} catch {
			try {
				const stat = fs.lstatSync(current);
				if (stat.isSymbolicLink() && !seen.has(current)) {
					seen.add(current);
					const linkTarget = fs.readlinkSync(current);
					const linkDir = resolveSymlinks(path.dirname(current), seen);
					const resolvedTarget = resolveSymlinks(path.resolve(linkDir, linkTarget), seen);
					return trailing.length > 0 ? path.join(resolvedTarget, ...trailing) : resolvedTarget;
				}
			} catch {
				// Not an existing broken symlink; keep walking up to the parent directory.
			}
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return absPath;
		}
		trailing.unshift(path.basename(current));
		current = parent;
	}
}

/**
 * Resolves `targetPath` to a canonical absolute path, expanding `~` / `$HOME` and
 * resolving symlinks via the deepest existing ancestor on disk so symlinks inside
 * `<cwd>` pointing outside `<cwd>` (and `/tmp` -> `/private/tmp` on macOS) are caught.
 */
export function resolveCanonicalPath(targetPath: string, baseCwd?: string, seen = new Set<string>()): string {
	const expanded = expandHomeTokens(targetPath);
	const base = baseCwd !== undefined ? resolveCanonicalPath(baseCwd, undefined, seen) : process.cwd();
	return resolveSymlinks(path.resolve(base, expanded), seen);
}

/**
 * Resolves `targetPath` against `baseCwd` like `resolveCanonicalPath`, but takes it as written: no
 * trimming, no quote stripping, and no `~` / `$HOME` expansion. Pi's `write` and `edit` tools read a
 * `path` this way once `normalizeFileToolPath` has run.
 */
export function resolveLiteralPath(targetPath: string, baseCwd: string): string {
	return resolveSymlinks(path.resolve(resolveCanonicalPath(baseCwd), targetPath), new Set<string>());
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Normalizes a `write` / `edit` tool `path` the way Pi's file tools do before resolving it against
 * `<cwd>`: Unicode spaces become plain spaces, one leading `@` is dropped, `~` is expanded, and a
 * `file://` URL becomes its filesystem path (throwing when the URL names no local file).
 * Shell words are not normalized this way: there `@name` and `file://...` are ordinary relative names.
 */
export function normalizeFileToolPath(rawPath: string): string {
	let normalized = rawPath.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (normalized === "~") return os.homedir();
	if (normalized.startsWith("~/")) return path.join(os.homedir(), normalized.slice(2));
	return /^file:\/\//.test(normalized) ? fileURLToPath(normalized) : normalized;
}

export function workspacesDir(cwd: string): string {
	return path.join(resolveCanonicalPath(cwd), ".pi", "workspaces");
}

export function policyFilePath(cwd: string): string {
	return path.join(workspacesDir(cwd), "policy.json");
}

/**
 * Ensures `<cwd>/.pi/workspaces` and `<cwd>/.pi/workspaces/.gitignore` (containing `*\n`)
 * exist on disk without ever touching `<cwd>/.gitignore`.
 */
export async function ensureWorkspacesClosure(cwd: string): Promise<string> {
	const dir = workspacesDir(cwd);
	await mkdir(dir, { recursive: true });
	const gitignorePath = path.join(dir, ".gitignore");
	try {
		const existing = await readFile(gitignorePath, "utf8");
		if (existing.split(/\r?\n/).some((line) => line.trim() === "*")) {
			return dir;
		}
	} catch {
		// Create .gitignore below.
	}
	await writeFile(gitignorePath, "*\n", "utf8");
	return dir;
}

/** Whether the canonical path `candidate` is `parent` or lies under it. */
export function containsPath(parent: string, candidate: string): boolean {
	if (candidate === parent) return true;
	const rel = path.relative(parent, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel);
}

export function isSubpath(parentPath: string, candidatePath: string): boolean {
	return containsPath(resolveCanonicalPath(parentPath), resolveCanonicalPath(candidatePath));
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
	const dir = path.dirname(filePath);
	await mkdir(dir, { recursive: true });
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		await rename(tempPath, filePath);
	} finally {
		await rm(tempPath, { force: true });
	}
}

export async function readProjectPolicy(cwd: string): Promise<ProjectPolicy> {
	const file = policyFilePath(cwd);
	try {
		const raw = JSON.parse(await readFile(file, "utf8")) as {
			allowedPaths?: unknown;
			defaultTtlMs?: unknown;
		} | null;
		const allowedPaths = Array.isArray(raw?.allowedPaths)
			? [
					...new Set(
						raw.allowedPaths
							.filter((item): item is string => typeof item === "string" && item.length > 0)
							.map((item) => resolveLiteralPath(item, cwd)),
					),
				]
			: [];
		const defaultTtlMs = typeof raw?.defaultTtlMs === "number" && Number.isFinite(raw.defaultTtlMs) && raw.defaultTtlMs >= 0
			? raw.defaultTtlMs
			: 0;
		return { allowedPaths, defaultTtlMs };
	} catch {
		return { allowedPaths: [], defaultTtlMs: 0 };
	}
}

export async function allowProjectPath(cwd: string, targetPath: string, literal = false): Promise<string> {
	const canonical = literal ? resolveLiteralPath(targetPath, cwd) : resolveCanonicalPath(targetPath, cwd);
	await ensureWorkspacesClosure(cwd);
	const policy = await readProjectPolicy(cwd);
	const allowedPaths = [...new Set([...policy.allowedPaths, canonical])];
	await writeJsonAtomic(policyFilePath(cwd), {
		allowedPaths,
		...(policy.defaultTtlMs > 0 ? { defaultTtlMs: policy.defaultTtlMs } : {}),
	});
	return canonical;
}

export async function denyProjectPath(cwd: string, targetPath: string): Promise<string> {
	const canonical = resolveCanonicalPath(targetPath, cwd);
	await ensureWorkspacesClosure(cwd);
	const policy = await readProjectPolicy(cwd);
	const allowedPaths = policy.allowedPaths.filter((entry) => entry !== canonical);
	await writeJsonAtomic(policyFilePath(cwd), {
		allowedPaths,
		...(policy.defaultTtlMs > 0 ? { defaultTtlMs: policy.defaultTtlMs } : {}),
	});
	return canonical;
}

function resolveGitCommonDirs(canonicalCwd: string): string[] {
	const dirs: string[] = [];
	let current = canonicalCwd;
	while (true) {
		const dotGit = path.join(current, ".git");
		try {
			const stat = fs.statSync(dotGit);
			if (stat.isDirectory()) {
				const realGit = resolveCanonicalPath(dotGit);
				dirs.push(realGit);
				const commondirFile = path.join(realGit, "commondir");
				if (fs.existsSync(commondirFile)) {
					const relCommon = fs.readFileSync(commondirFile, "utf8").trim();
					if (relCommon) dirs.push(resolveCanonicalPath(relCommon, realGit));
				}
				break;
			}
			if (stat.isFile()) {
				const content = fs.readFileSync(dotGit, "utf8");
				const match = /^gitdir:\s*(.+)$/m.exec(content);
				if (match?.[1]) {
					const gitDir = resolveCanonicalPath(match[1].trim(), current);
					dirs.push(gitDir);
					const commondirFile = path.join(gitDir, "commondir");
					if (fs.existsSync(commondirFile)) {
						const relCommon = fs.readFileSync(commondirFile, "utf8").trim();
						if (relCommon) dirs.push(resolveCanonicalPath(relCommon, gitDir));
					} else {
						dirs.push(resolveCanonicalPath(path.resolve(gitDir, "../..")));
					}
				}
				break;
			}
		} catch {
			// Continue walking upwards.
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

function isRelativeParentTraversal(rawTarget: string, literal = false): boolean {
	const expanded = literal ? rawTarget : expandHomeTokens(rawTarget);
	return !path.isAbsolute(expanded) && (expanded === ".." || expanded.startsWith("../") || expanded.startsWith("..\\"));
}

export function evaluatePathAccess(options: PathAccessOptions): PathAccessEvaluation {
	const canonicalCwd = resolveCanonicalPath(options.cwd);
	const resolvedPath = options.literal
		? resolveLiteralPath(options.targetPath, canonicalCwd)
		: resolveCanonicalPath(options.targetPath, canonicalCwd);
	// `resolvedPath` and every root checked below are already canonical; `isSubpath` would expand them again.
	const isInside = (root: string): boolean => containsPath(root, resolvedPath);

	if (resolvedPath === "/dev/null") {
		return { allowed: true, resolvedPath, matchedRoot: "/dev/null" };
	}

	// 1. Always allow paths inside <cwd> (including <cwd>/.pi/workspaces).
	if (isInside(canonicalCwd)) {
		return { allowed: true, resolvedPath, matchedRoot: canonicalCwd };
	}

	// 2. Always allow git common dir of <cwd> when <cwd> is a git repo/worktree.
	for (const gitDir of resolveGitCommonDirs(canonicalCwd)) {
		if (isInside(gitDir)) {
			return { allowed: true, resolvedPath, matchedRoot: gitDir };
		}
	}

	// 3. Always allow sessionAllowed, projectAllowed, and extraAllowed roots.
	for (const group of [options.sessionAllowed, options.projectAllowed, options.extraAllowed]) {
		if (!group) continue;
		for (const allowedEntry of group) {
			const canonicalAllowed = resolveLiteralPath(allowedEntry, canonicalCwd);
			if (containsPath(canonicalAllowed, resolvedPath)) {
				return { allowed: true, resolvedPath, matchedRoot: canonicalAllowed };
			}
		}
	}

	// 4. Allow /tmp and os.tmpdir() unless the path is a sibling of <cwd> inside a test sandbox under tmpdir
	// or a relative "../" traversal escaping <cwd>.
	if (!isRelativeParentTraversal(options.targetPath, options.literal)) {
		const tmpRoots = new Set<string>([
			resolveCanonicalPath(os.tmpdir()),
			resolveCanonicalPath("/tmp"),
		]);
		for (const tmpRoot of tmpRoots) {
			if (!isInside(tmpRoot)) continue;
			if (containsPath(tmpRoot, canonicalCwd)) {
				const relCwd = path.relative(tmpRoot, canonicalCwd);
				const firstSegment = relCwd.split(/[\\/]/)[0];
				if (firstSegment) {
					const sandboxRoot = path.join(tmpRoot, firstSegment);
					if (isInside(sandboxRoot)) {
						// Sibling of <cwd> inside the same tmpdir sandbox (e.g. <root>/outside vs <root>/project).
						continue;
					}
				}
			}
			return { allowed: true, resolvedPath, matchedRoot: tmpRoot };
		}
	}

	return {
		allowed: false,
		resolvedPath,
		reason: `Path "${resolvedPath}" is outside the project working directory "${canonicalCwd}". Use "${workspacesDir(options.cwd)}" for side workspaces or "/tmp" for temporary files.`,
	};
}

/**
 * If `targetPath` resolves inside `<cwd>/.pi/workspaces/<name>`, returns `<name>`
 * (excluding metadata files starting with `.` or `policy.json`). `literal` takes `targetPath`
 * as written, as `resolveLiteralPath` does.
 */
export function extractWorkspaceNameFromPath(targetPath: string, cwd: string, literal = false): string | undefined {
	const wsRoot = workspacesDir(cwd);
	const resolved = literal ? resolveLiteralPath(targetPath, cwd) : resolveCanonicalPath(targetPath, cwd);
	const rel = path.relative(wsRoot, resolved);
	if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${path.sep}`) || rel.startsWith("../") || path.isAbsolute(rel)) {
		return undefined;
	}
	const firstSegment = rel.split(/[\\/]/)[0];
	if (!firstSegment || firstSegment.startsWith(".") || firstSegment === "policy.json") {
		return undefined;
	}
	return firstSegment;
}

const LOCAL_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Write redirections; `>&` onto a descriptor (`2>&1`, `>&-`) only duplicates or closes one. */
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);

/** Bash pseudo-devices and standard streams, which are not files on disk. */
const SHELL_PSEUDO_DEVICE = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+|tcp\/.*|udp\/.*)$/;

/** Whether `part` is `$HOME` or `${HOME}`; an operator, prefix, or index (`${HOME:-x}`) makes it another expansion. */
function isHomeExpansion(part: WordPart): boolean {
	if (part.type === "SimpleExpansion") return part.text === "$HOME";
	return part.type === "ParameterExpansion" && part.parameter === "HOME" && !part.operation && !part.prefix && !part.index;
}

/** The text bash makes of one piece of a word or of an unquoted heredoc body. */
function partValue(part: WordPart): string {
	switch (part.type) {
		case "Literal":
		case "Glob":
		case "SingleQuoted":
		case "AnsiCQuoted":
			return part.value;
		case "DoubleQuoted":
		case "LocaleString":
			return part.parts.map(partValue).join("");
		default:
			return isHomeExpansion(part) ? os.homedir() : part.text;
	}
}

/**
 * bash drops a backslash-newline before it reads a word, except inside single quotes, so
 * `$HO\<newline>ME` is `$HOME`. Returns `word` parsed again without them. Inside `$'...'` bash keeps
 * both characters, which the parser reads only when the pair is spelled `\\<newline>`.
 */
function joinContinuedLines(word: Word): Word {
	if (!word.text.includes("\\\n")) return word;
	const respell = (text: string, continued: string): string =>
		text.replace(/\\([\s\S])/g, (pair, next: string) => (next === "\n" ? continued : pair));
	const join = (part: WordPart): string =>
		part.type === "SingleQuoted" ? part.text : respell(part.text, part.type === "AnsiCQuoted" ? "\\\\\n" : "");
	const source = word.parts ? word.parts.map(join).join("") : respell(word.text, "");
	const command = parse(`: ${source}`).commands[0]?.command;
	const joined = command?.type === "Command" && command.args.length === 1 ? command.args[0] : undefined;
	return joined?.type === "Word" ? joined : word;
}

/**
 * The string bash passes to a command for `source`. Quoted and escaped text is literal, quote characters
 * inside it included, and nothing is trimmed. `$HOME` and `${HOME}` become the home directory, bare or in
 * double quotes. So does a `~` that starts the word, or follows `NAME=` at its start (`of=~/x`), when
 * nothing quotes it and `/` or the end of the word comes next. Every other expansion keeps its source
 * text: `$VAR`, `${HOME:-x}`, `$(...)`, `~user`, `~+`, globs, and brace lists.
 */
function bashWordValue(source: Word): string {
	const word = joinContinuedLines(source);
	const value = word.parts ? word.parts.map(partValue).join("") : word.value;
	// Matched on the source, where a quote or backslash would show: the text up to the `~` is the same in `value`.
	const tilde = /^(?:[A-Za-z_][A-Za-z0-9_]*=)?~(?=\/|$)/.exec(word.text);
	return tilde ? value.slice(0, tilde[0].length - 1) + os.homedir() + value.slice(tilde[0].length) : value;
}

/**
 * A heredoc body as bash passes it on. Unless the delimiter is quoted, bash expands the body first:
 * `$HOME` and `${HOME}` become the home directory whatever quotes surround them, and `\$` becomes `$`.
 */
function hereDocText(node: HereDoc): string {
	const { text, parts } = node.body;
	if (node.delimiter?.quoted) return text;
	return parts ? parts.map(partValue).join("") : text.replace(/\\([$`\\\n])/g, (_pair, next: string) => (next === "\n" ? "" : next));
}

/**
 * Resolves `word`, a bash word as `bashWordValue` reads it, against `effectiveCwd` as `resolveLiteralPath`
 * does. Both are final: the directory is one the walk has already resolved, so it is not read as a shell
 * word again, and after `cd '$HOME'` it stays the directory named `$HOME`.
 */
function resolveBashWord(word: string, effectiveCwd: string): string {
	return resolveSymlinks(path.resolve(effectiveCwd, word), new Set<string>());
}

const ENV_VALUE_SHORT = new Set(["u", "C", "S", "P", "a"]);
const ENV_VALUE_LONG = new Set(["--unset", "--chdir", "--split-string", "--argv0"]);
const SUDO_VALUE_SHORT = new Set(["u", "g", "C", "D", "h", "p", "r", "t", "T", "U", "R", "a", "c"]);
const SUDO_VALUE_LONG = new Set([
	"--user",
	"--group",
	"--close-from",
	"--chdir",
	"--host",
	"--prompt",
	"--role",
	"--type",
	"--command-timeout",
	"--other-user",
	"--chroot",
	"--auth-type",
	"--login-class",
]);
const NICE_VALUE_SHORT = new Set(["n"]);
const NICE_VALUE_LONG = new Set(["--adjustment"]);
const TIMEOUT_VALUE_SHORT = new Set(["k", "s"]);
const TIMEOUT_VALUE_LONG = new Set(["--kill-after", "--signal"]);
const COMMAND_QUERY_SHORT = new Set(["v", "V"]);

interface WrapperOptionConfig {
	valueShort: ReadonlySet<string>;
	valueLong: ReadonlySet<string>;
	chdirShort?: string;
	chdirLong?: string;
	allowBareDash?: boolean;
	splitStringShort?: string;
	splitStringLong?: string;
	stopOnShort?: ReadonlySet<string>;
	skipLeadingPositional?: boolean;
}

function splitEnvString(value: string): string[] {
	try {
		const parsed = parse(`: ${value}`);
		const first = parsed.commands[0]?.command;
		if (parsed.commands.length === 1 && first?.type === "Command") {
			return first.args
				.filter((arg): arg is Word => arg.type === "Word")
				.map((word) => bashWordValue(word));
		}
	} catch {
		// Unparseable -S payload: ignore it rather than breaking inspection of following words.
	}
	return [];
}

function consumeWrapperOptions(
	tokens: string[],
	startIdx: number,
	config: WrapperOptionConfig,
	baseCwd: string,
): { idx: number; effectiveCwd: string; aborted?: boolean } {
	let idx = startIdx;
	let effectiveCwd = baseCwd;
	let usedSplitString = false;

	while (idx < tokens.length) {
		const token = tokens[idx]!;
		if (token === "--") {
			idx++;
			break;
		}
		if (token === "-") {
			if (config.allowBareDash) {
				idx++;
				continue;
			}
			break;
		}
		if (!token.startsWith("-")) {
			break;
		}
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq >= 0) {
				const name = token.slice(0, eq);
				const value = token.slice(eq + 1);
				if (config.chdirLong && name === config.chdirLong && value) {
					effectiveCwd = resolveBashWord(value, effectiveCwd);
				}
				idx++;
				if (config.splitStringLong && name === config.splitStringLong && value && !usedSplitString) {
					usedSplitString = true;
					const extra = splitEnvString(value);
					if (extra.length > 0) tokens.splice(idx, 0, ...extra);
				}
				continue;
			}
			if (config.valueLong.has(token)) {
				const value = tokens[idx + 1];
				idx += value !== undefined ? 2 : 1;
				if (config.chdirLong && token === config.chdirLong && value) {
					effectiveCwd = resolveBashWord(value, effectiveCwd);
				}
				if (config.splitStringLong && token === config.splitStringLong && value && !usedSplitString) {
					usedSplitString = true;
					const extra = splitEnvString(value);
					if (extra.length > 0) tokens.splice(idx, 0, ...extra);
				}
				continue;
			}
			idx++;
			continue;
		}

		// Short option cluster (`-i`, `-u FOO`, `-iu FOO`, `-C/outside`).
		if (config.stopOnShort) {
			for (let j = 1; j < token.length; j++) {
				if (config.stopOnShort.has(token[j]!)) {
					return { idx: startIdx - 1, effectiveCwd: baseCwd, aborted: true };
				}
			}
		}
		let consumedValue = false;
		for (let j = 1; j < token.length; j++) {
			const ch = token[j]!;
			if (config.valueShort.has(ch)) {
				const attached = token.slice(j + 1);
				let value: string | undefined;
				if (attached.length > 0) {
					value = attached;
					idx++;
				} else {
					value = tokens[idx + 1];
					idx += value !== undefined ? 2 : 1;
				}
				if (config.chdirShort && ch === config.chdirShort && value) {
					effectiveCwd = resolveBashWord(value, effectiveCwd);
				}
				if (config.splitStringShort && ch === config.splitStringShort && value && !usedSplitString) {
					usedSplitString = true;
					const extra = splitEnvString(value);
					if (extra.length > 0) tokens.splice(idx, 0, ...extra);
				}
				consumedValue = true;
				break;
			}
		}
		if (!consumedValue) {
			idx++;
		}
	}

	if (config.skipLeadingPositional && idx < tokens.length) {
		idx++;
	}

	return { idx, effectiveCwd };
}

/**
 * Words of a simple command past leading `KEY=VALUE` assignments and `env`/`sudo`/`command`/`nohup`/`nice`/`timeout`
 * wrappers (with their option flags), plus the effective working directory after any `env -C`/`--chdir` or
 * `sudo -D`/`--chdir`.
 */
function unwrapCommand(command: Command, baseCwd: string): { words: string[]; effectiveCwd: string } {
	const tokens = [command.name, ...command.args]
		.filter((arg): arg is Word => arg?.type === "Word")
		.map((word) => bashWordValue(word));
	let idx = 0;
	let effectiveCwd = baseCwd;
	while (idx < tokens.length) {
		const word = tokens[idx]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			idx++;
			continue;
		}
		const base = path.basename(word);
		if (base === "env") {
			const next = consumeWrapperOptions(
				tokens,
				idx + 1,
				{
					valueShort: ENV_VALUE_SHORT,
					valueLong: ENV_VALUE_LONG,
					chdirShort: "C",
					chdirLong: "--chdir",
					allowBareDash: true,
					splitStringShort: "S",
					splitStringLong: "--split-string",
				},
				effectiveCwd,
			);
			idx = next.idx;
			effectiveCwd = next.effectiveCwd;
			continue;
		}
		if (base === "sudo") {
			const next = consumeWrapperOptions(
				tokens,
				idx + 1,
				{
					valueShort: SUDO_VALUE_SHORT,
					valueLong: SUDO_VALUE_LONG,
					chdirShort: "D",
					chdirLong: "--chdir",
				},
				effectiveCwd,
			);
			idx = next.idx;
			effectiveCwd = next.effectiveCwd;
			continue;
		}
		if (word === "command") {
			const next = consumeWrapperOptions(
				tokens,
				idx + 1,
				{
					valueShort: new Set(),
					valueLong: new Set(),
					stopOnShort: COMMAND_QUERY_SHORT,
				},
				effectiveCwd,
			);
			if (next.aborted) break;
			idx = next.idx;
			continue;
		}
		if (base === "nohup") {
			const next = consumeWrapperOptions(
				tokens,
				idx + 1,
				{ valueShort: new Set(), valueLong: new Set() },
				effectiveCwd,
			);
			idx = next.idx;
			continue;
		}
		if (base === "nice") {
			const next = consumeWrapperOptions(
				tokens,
				idx + 1,
				{ valueShort: NICE_VALUE_SHORT, valueLong: NICE_VALUE_LONG },
				effectiveCwd,
			);
			idx = next.idx;
			continue;
		}
		if (base === "timeout") {
			const next = consumeWrapperOptions(
				tokens,
				idx + 1,
				{
					valueShort: TIMEOUT_VALUE_SHORT,
					valueLong: TIMEOUT_VALUE_LONG,
					skipLeadingPositional: true,
				},
				effectiveCwd,
			);
			idx = next.idx;
			continue;
		}
		break;
	}
	return { words: tokens.slice(idx), effectiveCwd };
}

function isLocalShell(node: SyntaxNode, baseCwd: string): boolean {
	if (node.type !== "Command") return false;
	const verb = unwrapCommand(node, baseCwd).words[0];
	return verb !== undefined && LOCAL_SHELLS.has(path.basename(verb));
}

const MUTATING_VERBS = new Set([
	"mkdir",
	"touch",
	"rm",
	"rmdir",
	"cp",
	"mv",
	"ln",
	"install",
	"tee",
	"dd",
	"tar",
	"unzip",
	"npm",
	"pnpm",
	"yarn",
	"cargo",
]);

function extractGitTargets(args: string[], baseCwd: string): string[] {
	let gitCwd = baseCwd;
	let idx = 0;
	while (idx < args.length) {
		const arg = args[idx]!;
		if (arg === "-C" && args[idx + 1]) {
			gitCwd = resolveBashWord(args[idx + 1]!, gitCwd);
			idx += 2;
			continue;
		}
		if (arg.startsWith("-C") && arg.length > 2) {
			gitCwd = resolveBashWord(arg.slice(2), gitCwd);
			idx++;
			continue;
		}
		if (arg.startsWith("-")) {
			idx++;
			continue;
		}
		break;
	}

	const subcommand = args[idx];
	if (!subcommand) return [];
	const rest = args.slice(idx + 1);

	if (subcommand === "clone") {
		const positionals: string[] = [];
		const flagsWithValue = new Set(["-b", "--branch", "-o", "--origin", "--depth", "--reference", "--separate-git-dir", "-c", "--config", "--upload-pack", "--template", "--jobs", "-j", "--filter"]);
		for (let i = 0; i < rest.length; i++) {
			const token = rest[i]!;
			if (flagsWithValue.has(token)) {
				i++;
				continue;
			}
			if (token.startsWith("-")) continue;
			positionals.push(token);
		}
		if (positionals.length >= 2) {
			return [resolveBashWord(positionals[1]!, gitCwd)];
		}
		if (positionals.length === 1) {
			const repoName = path.basename(positionals[0]!.replace(/\/+$/, ""), ".git") || "repo";
			return [resolveBashWord(repoName, gitCwd)];
		}
		return [gitCwd];
	}

	if (subcommand === "init") {
		const positionals: string[] = [];
		const flagsWithValue = new Set(["-b", "--initial-branch", "--template", "--separate-git-dir", "--object-format", "--ref-format"]);
		for (let i = 0; i < rest.length; i++) {
			const token = rest[i]!;
			if (flagsWithValue.has(token)) {
				i++;
				continue;
			}
			if (token.startsWith("-")) continue;
			positionals.push(token);
		}
		return [positionals[0] ? resolveBashWord(positionals[0], gitCwd) : gitCwd];
	}

	if (subcommand === "worktree" && rest[0] === "add") {
		const wtArgs = rest.slice(1);
		const positionals: string[] = [];
		const flagsWithValue = new Set(["-b", "-B", "--reason"]);
		for (let i = 0; i < wtArgs.length; i++) {
			const token = wtArgs[i]!;
			if (flagsWithValue.has(token)) {
				i++;
				continue;
			}
			if (token.startsWith("-")) continue;
			positionals.push(token);
		}
		if (positionals[0]) {
			return [resolveBashWord(positionals[0], gitCwd)];
		}
	}

	return [];
}

/** Returns the value of the last `--name value` / `--name=value` option among `names`. */
function optionValue(args: string[], names: string[]): string | undefined {
	let value: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		for (const name of names) {
			if (arg === name && args[i + 1]) {
				value = args[i + 1];
			} else if (name.startsWith("--") && arg.startsWith(`${name}=`)) {
				value = arg.slice(name.length + 1);
			}
		}
	}
	return value;
}

const CP_LN_MV_OTHER_VALUE_SHORT = new Set(["S"]);
const INSTALL_OTHER_VALUE_SHORT = new Set(["B", "f", "g", "h", "l", "m", "M", "N", "o", "S", "T"]);

function extractTargetDirectoryOption(
	args: string[],
	index: number,
	otherValueShort: ReadonlySet<string>,
): { targetDir: string | undefined; nextIdx: number } | undefined {
	const arg = args[index]!;
	if (arg === "-t" || arg === "--target-directory") {
		const value = args[index + 1];
		return { targetDir: value, nextIdx: value !== undefined ? index + 1 : index };
	}
	if (arg.startsWith("--target-directory=")) {
		return { targetDir: arg.slice("--target-directory=".length), nextIdx: index };
	}
	if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
		for (let j = 1; j < arg.length; j++) {
			const ch = arg[j]!;
			if (ch === "t") {
				const attached = arg.slice(j + 1);
				if (attached.length > 0) {
					return { targetDir: attached, nextIdx: index };
				}
				const value = args[index + 1];
				return { targetDir: value, nextIdx: value !== undefined ? index + 1 : index };
			}
			if (otherValueShort.has(ch)) {
				break;
			}
		}
	}
	return undefined;
}

const TAR_OTHER_VALUE_SHORT = new Set(["b", "H", "I", "K", "L", "N", "T", "V", "X"]);

/** Archive written by `tar -c/-r/-u`, or the `-C`/`--directory` extraction directories otherwise. */
function extractTarTargets(args: string[], effectiveCwd: string): string[] {
	let archive: string | undefined;
	const directories: string[] = [];
	let tarCwd = effectiveCwd;
	let writesArchive = false;
	const pushDir = (dir: string | undefined) => {
		if (!dir) return;
		tarCwd = resolveBashWord(dir, tarCwd);
		directories.push(tarCwd);
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") break;
		if (arg === "-C" || arg === "--directory") {
			pushDir(args[i + 1]);
			if (args[i + 1] !== undefined) i++;
			continue;
		}
		if (arg === "-f" || arg === "--file") {
			archive = args[i + 1];
			if (args[i + 1] !== undefined) i++;
			continue;
		}
		if (arg.startsWith("--directory=")) {
			pushDir(arg.slice("--directory=".length));
			continue;
		}
		if (arg.startsWith("--file=")) {
			archive = arg.slice("--file=".length);
			continue;
		}
		if (arg === "--create" || arg === "--append" || arg === "--update") {
			writesArchive = true;
			continue;
		}
		if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
			for (let j = 1; j < arg.length; j++) {
				const ch = arg[j]!;
				if (!/[A-Za-z]/.test(ch)) break;
				if (ch === "C") {
					const attached = arg.slice(j + 1);
					if (attached.length > 0) {
						pushDir(attached);
					} else if (args[i + 1] !== undefined) {
						pushDir(args[i + 1]);
						i++;
					}
					break;
				}
				if (ch === "f") {
					const attached = arg.slice(j + 1);
					if (attached.length > 0) {
						archive = attached;
					} else if (args[i + 1] !== undefined) {
						archive = args[i + 1];
						i++;
					}
					break;
				}
				if (TAR_OTHER_VALUE_SHORT.has(ch)) break;
				if (ch === "c" || ch === "r" || ch === "u") writesArchive = true;
			}
			continue;
		}
		// Traditional bundled first argument without leading `-` (`czf out.tgz`, `xf in.tar`).
		if (i === 0 && /^[A-Za-z]+$/.test(arg)) {
			if (/[cru]/.test(arg)) writesArchive = true;
			if (arg.endsWith("f") && args[i + 1]) {
				archive = args[i + 1];
				i++;
			}
		}
	}
	if (writesArchive) {
		return archive && archive !== "-" ? [resolveBashWord(archive, effectiveCwd)] : [];
	}
	return directories;
}

interface BashWalkVisitor {
	/** A simple command's words and the directory it runs in; its own `cd` or `pushd` has not applied yet. */
	command(words: string[], effectiveCwd: string): void;
	/** The target word of a write redirection onto a file, and the directory it opens in. */
	writeRedirect(target: string, effectiveCwd: string): void;
}

/**
 * Walks the simple commands and write redirections of a shell command, following `cd` and `pushd`.
 * A heredoc body is data unless a local shell reads it (`bash <<EOF`, `cat <<EOF | sh`).
 */
function walkBashCommands(command: string, canonicalCwd: string, visitor: BashWalkVisitor): void {
	let effectiveCwd = canonicalCwd;
	let shellReadsStdin = false;
	let shellStdinCwd = canonicalCwd;

	const visit = (node: SyntaxNode): void => {
		switch (node.type) {
			case "Subshell":
			case "CommandExpansion":
			case "ProcessSubstitution":
			case "ArithmeticCommandExpansion": {
				// Subshells keep their `cd` to themselves.
				const saved = effectiveCwd;
				forEachChild(node, visit);
				effectiveCwd = saved;
				return;
			}
			case "Pipeline": {
				// Every stage runs in its own subshell; a local shell in any stage reads the heredocs.
				const saved = { cwd: effectiveCwd, shellReadsStdin, shellStdinCwd };
				const localShellStage = node.commands.find((stage) => isLocalShell(stage, effectiveCwd));
				if (localShellStage) {
					shellReadsStdin = true;
					shellStdinCwd = unwrapCommand(localShellStage as Command, effectiveCwd).effectiveCwd;
				}
				for (const stage of node.commands) {
					effectiveCwd = saved.cwd;
					visit(stage);
				}
				effectiveCwd = saved.cwd;
				shellReadsStdin = saved.shellReadsStdin;
				shellStdinCwd = saved.shellStdinCwd;
				return;
			}
			case "Redirected": {
				// Redirections of a compound command open before its body runs.
				const before = effectiveCwd;
				visit(node.command);
				const after = effectiveCwd;
				effectiveCwd = before;
				for (const redirect of node.redirects) visit(redirect);
				effectiveCwd = after;
				return;
			}
			case "Redirect": {
				const target = node.target && bashWordValue(node.target);
				if (!target || !WRITE_REDIRECTS.has(node.operator) || SHELL_PSEUDO_DEVICE.test(target)) return;
				if (node.operator === ">&" && /^(?:\d+|-)$/.test(target)) return;
				visitor.writeRedirect(target, effectiveCwd);
				return;
			}
			case "HereDoc":
			case "HereString": {
				// Expansions in an unquoted body run in this shell; the body itself is a script only for a local shell.
				forEachChild(node, visit);
				const script = node.type === "HereDoc" ? hereDocText(node) : node.target && bashWordValue(node.target);
				if (shellReadsStdin && script) {
					const saved = effectiveCwd;
					effectiveCwd = shellStdinCwd;
					visit(parse(script));
					effectiveCwd = saved;
				}
				return;
			}
			case "Command": {
				const unwrapped = unwrapCommand(node, effectiveCwd);
				const saved = { shellReadsStdin, shellStdinCwd };
				if (unwrapped.words[0] !== undefined && LOCAL_SHELLS.has(path.basename(unwrapped.words[0]))) {
					shellReadsStdin = true;
					shellStdinCwd = unwrapped.effectiveCwd;
				}
				forEachChild(node, visit);
				shellReadsStdin = saved.shellReadsStdin;
				shellStdinCwd = saved.shellStdinCwd;
				const [verb, ...args] = unwrapped.words;
				if (!verb) return;
				visitor.command(unwrapped.words, unwrapped.effectiveCwd);
				if (verb === "cd" || verb === "pushd") {
					// `cd` alone goes home.
					const dest = args.find((a) => !a.startsWith("-")) ?? os.homedir();
					if (dest !== "-") {
						effectiveCwd = resolveBashWord(dest, unwrapped.effectiveCwd);
					}
				}
				return;
			}
			default:
				forEachChild(node, visit);
		}
	};

	visit(parse(command));
}

/** A resolved write target of a shell command; `deletes` marks a target only a deleting verb (`rm`, `rmdir`) names. */
export interface BashWriteTarget {
	path: string;
	deletes: boolean;
}

/** Result of inspecting a shell command in a single parse and walk. */
export interface BashCommandInspection {
	writeTargets: BashWriteTarget[];
	namedStateFile?: string;
}

/** Verbs that only delete what they name. */
const DELETING_VERBS = new Set(["rm", "rmdir"]);

function createBashWriteTargetCollector(canonicalCwd: string): {
	visitor: BashWalkVisitor;
	results: () => BashWriteTarget[];
} {
	const targets: string[] = [];
	const written = new Set<string>();
	let deleting = false;
	const push = (target: string) => {
		targets.push(target);
		if (!deleting) written.add(target);
	};

	const inspectCommand = (words: string[], effectiveCwd: string): void => {
		const rawVerb = words[0];
		const verb = rawVerb ? path.basename(rawVerb) : "";
		deleting = DELETING_VERBS.has(verb);
		inspectWords(verb, words.slice(1), effectiveCwd);
		deleting = false;
	};

	const inspectWords = (verb: string, args: string[], effectiveCwd: string): void => {
		if (!verb || verb === "cd" || verb === "pushd") return;

		if (verb === "git") {
			const gitTargets = extractGitTargets(args, effectiveCwd);
			for (const target of gitTargets) push(target);
			return;
		}

		if (verb === "mkdir" || verb === "touch" || verb === "rm" || verb === "rmdir" || verb === "tee") {
			const flagsWithValue = new Set(["-m", "--mode"]);
			const positionals: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if (arg === "--") {
					positionals.push(...args.slice(i + 1));
					break;
				}
				if (flagsWithValue.has(arg)) {
					i++;
					continue;
				}
				if (arg.startsWith("-")) continue;
				positionals.push(arg);
			}
			for (const p of positionals) {
				push(resolveBashWord(p, effectiveCwd));
			}
			if (positionals.length === 0 && effectiveCwd !== canonicalCwd) {
				push(effectiveCwd);
			}
			return;
		}

		if (verb === "cp" || verb === "ln" || verb === "install") {
			const targetDirs: string[] = [];
			const positionals: string[] = [];
			const otherValueShort = verb === "install" ? INSTALL_OTHER_VALUE_SHORT : CP_LN_MV_OTHER_VALUE_SHORT;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if (arg === "--") {
					positionals.push(...args.slice(i + 1));
					break;
				}
				const parsed = extractTargetDirectoryOption(args, i, otherValueShort);
				if (parsed) {
					if (parsed.targetDir) targetDirs.push(parsed.targetDir);
					i = parsed.nextIdx;
					continue;
				}
				if (arg.startsWith("-")) continue;
				positionals.push(arg);
			}
			if (targetDirs.length > 0) {
				for (const targetDir of targetDirs) {
					push(resolveBashWord(targetDir, effectiveCwd));
				}
			} else if (positionals.length >= 2) {
				push(resolveBashWord(positionals[positionals.length - 1]!, effectiveCwd));
			} else if (effectiveCwd !== canonicalCwd) {
				push(effectiveCwd);
			}
			return;
		}

		if (verb === "mv") {
			const targetDirs: string[] = [];
			const positionals: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if (arg === "--") {
					positionals.push(...args.slice(i + 1));
					break;
				}
				const parsed = extractTargetDirectoryOption(args, i, CP_LN_MV_OTHER_VALUE_SHORT);
				if (parsed) {
					if (parsed.targetDir) targetDirs.push(parsed.targetDir);
					i = parsed.nextIdx;
					continue;
				}
				if (arg.startsWith("-")) continue;
				positionals.push(arg);
			}
			for (const p of positionals) {
				push(resolveBashWord(p, effectiveCwd));
			}
			for (const targetDir of targetDirs) {
				push(resolveBashWord(targetDir, effectiveCwd));
			}
			if (positionals.length === 0 && targetDirs.length === 0 && effectiveCwd !== canonicalCwd) {
				push(effectiveCwd);
			}
			return;
		}

		if (verb === "cargo" && (args[0] === "new" || args[0] === "init")) {
			const positionals = args.slice(1).filter((arg) => !arg.startsWith("-"));
			if (positionals[0]) {
				push(resolveBashWord(positionals[0], effectiveCwd));
			} else {
				push(effectiveCwd);
			}
			return;
		}

		if (verb === "tar") {
			const tarTargets = extractTarTargets(args, effectiveCwd);
			if (tarTargets.length > 0) {
				for (const target of tarTargets) push(target);
				return;
			}
		}

		const explicitTarget =
			verb === "dd" ? args.find((arg) => arg.startsWith("of="))?.slice("of=".length)
			: verb === "unzip" ? optionValue(args, ["-d"]) ?? args.find((arg) => /^-d./.test(arg))?.slice(2)
			: verb === "npm" || verb === "pnpm" || verb === "yarn" ? optionValue(args, ["--prefix", "-C", "--dir", "--cwd"])
			: undefined;
		if (explicitTarget) {
			push(resolveBashWord(explicitTarget, effectiveCwd));
			return;
		}

		if (MUTATING_VERBS.has(verb) && effectiveCwd !== canonicalCwd) {
			push(effectiveCwd);
		}
	};

	return {
		visitor: {
			command: inspectCommand,
			writeRedirect: (target, effectiveCwd) => {
				push(resolveBashWord(target, effectiveCwd));
			},
		},
		results: () => [...new Set(targets)].map((target) => ({ path: target, deletes: !written.has(target) })),
	};
}

/** Verbs that only read the files they name. */
const READ_ONLY_VERBS = new Set(["cat", "head", "tail", "wc", "ls", "stat", "test", "[", "diff", "cmp", "jq", "grep"]);

/**
 * The paths a word can name: itself and, past its first `=`, an option's value (`--file=PATH`, `of=PATH`).
 * bash expands a `~` there only after a variable name, but the program may expand it itself
 * (`--out=~/x`), so that value also counts with a leading `~` read as the home directory.
 */
function wordPathForms(word: string): string[] {
	const eq = word.indexOf("=");
	const forms = eq < 0 ? [word] : [word, word.slice(eq + 1)];
	const value = forms[1];
	if (value === "~" || value?.startsWith("~/")) forms.push(os.homedir() + value.slice(1));
	return forms.filter((form) => form !== "");
}

function createBashStateFileFinder(stateFiles: readonly string[]): {
	visitor: BashWalkVisitor;
	result: () => string | undefined;
} {
	const states = stateFiles.map((file) => ({
		file,
		resolved: resolveCanonicalPath(file).toLowerCase(),
		dir: resolveCanonicalPath(path.dirname(file)).toLowerCase(),
		name: path.basename(file).toLowerCase(),
	}));
	let named: string | undefined;

	return {
		visitor: {
			command: (words, effectiveCwd) => {
				if (named || states.length === 0 || READ_ONLY_VERBS.has(words[0]!)) return;
				const resolved = words.map((word) =>
					wordPathForms(word).map((form) => resolveBashWord(form, effectiveCwd).toLowerCase()),
				);
				named = states.find(
					(state) =>
						resolved.some((forms) => forms.includes(state.resolved)) ||
						resolved.some(
							(forms, index) =>
								forms.includes(state.dir) &&
								words.some((other, otherIndex) => otherIndex !== index && path.basename(other).toLowerCase() === state.name),
						),
				)?.file;
			},
			writeRedirect: () => {},
		},
		result: () => named,
	};
}

/**
 * Parses and walks `command` once to collect both tagged write targets and any managed state file named
 * by a non-read-only command.
 */
export function inspectBashCommand(
	command: string,
	cwd: string,
	projectCwd?: string,
	stateFiles: readonly string[] = [],
): BashCommandInspection {
	const startCwd = resolveCanonicalPath(cwd);
	const canonicalCwd = projectCwd !== undefined && projectCwd !== cwd ? resolveCanonicalPath(projectCwd) : startCwd;
	const collector = createBashWriteTargetCollector(canonicalCwd);
	const finder = stateFiles.length > 0 ? createBashStateFileFinder(stateFiles) : undefined;

	walkBashCommands(command, startCwd, {
		command: (words, effectiveCwd) => {
			collector.visitor.command(words, effectiveCwd);
			finder?.visitor.command(words, effectiveCwd);
		},
		writeRedirect: (target, effectiveCwd) => {
			collector.visitor.writeRedirect(target, effectiveCwd);
		},
	});

	return {
		writeTargets: collector.results(),
		namedStateFile: finder?.result(),
	};
}

/**
 * Extracts all resolved filesystem write/creation target paths from a shell command.
 * Commands for other machines (`ssh host mkdir /x`) and heredoc bodies are data unless a
 * local shell reads them (`bash <<EOF`, `cat <<EOF | sh`).
 */
export function extractBashWriteTargets(command: string, cwd: string, projectCwd?: string): string[] {
	return [...new Set(extractTaggedBashWriteTargets(command, cwd, projectCwd).map((target) => target.path))];
}

/**
 * The targets of `extractBashWriteTargets`, each tagged with whether it is only deleted. A path both deleted and
 * written in one command (`rm -rf d; mkdir d`) is tagged as written.
 */
export function extractTaggedBashWriteTargets(command: string, cwd: string, projectCwd?: string): BashWriteTarget[] {
	return inspectBashCommand(command, cwd, projectCwd).writeTargets;
}

/**
 * Returns the first of `stateFiles` that a simple command of `command` names, whatever that command is,
 * unless its verb only reads: one of its words resolves to the file, or one resolves to the file's
 * directory while another word's last path segment is the file's name (`cp /tmp/policy.json .pi/workspaces/`).
 * Words resolve as write targets do, and letter case is ignored.
 */
export function findBashNamedStateFile(command: string, cwd: string, stateFiles: string[]): string | undefined {
	const finder = createBashStateFileFinder(stateFiles);
	walkBashCommands(command, resolveCanonicalPath(cwd), finder.visitor);
	return finder.result();
}

/**
 * Inspects a shell command string for write/creation operations targeting paths outside
 * `<cwd>` and `/tmp`. When `baseCwd` is provided, relative paths in `command` resolve against
 * `baseCwd` while access policy is still evaluated against `cwd`.
 */
export function extractBashExternalWriteTargets(command: string, cwd: string, baseCwd?: string): string[] {
	const writeTargets = extractBashWriteTargets(command, baseCwd ?? cwd, cwd);
	const external: string[] = [];
	for (const targetPath of writeTargets) {
		const check = evaluatePathAccess({ targetPath, cwd, literal: true });
		if (!check.allowed) {
			external.push(check.resolvedPath);
		}
	}
	return [...new Set(external)];
}

const AGENT_BROWSER_GLOBAL_VALUE_FLAGS = new Set([
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
	"--session-name",
	"--executable-path",
	"--extensions",
	"--args",
	"--proxy-bypass",
	"--state",
	"--download-path",
]);

const AGENT_BROWSER_SCREENSHOT_VALUE_FLAGS = new Set([
	"--selector",
	"-S",
	"--format",
	"--quality",
	"-q",
	"--clip",
]);

const AGENT_BROWSER_PDF_VALUE_FLAGS = new Set([
	"--format",
	"--margin",
	"--scale",
	"--header-template",
	"--footer-template",
	"--width",
	"--height",
	"--page-ranges",
]);

const AGENT_BROWSER_WRITE_VALUE_FLAGS = new Set(["--profile", "--download-path"]);

function extractEqualsFlagValue(token: string, flagNames: ReadonlySet<string>): string | undefined {
	const eq = token.indexOf("=");
	if (eq <= 0) return undefined;
	if (!flagNames.has(token.slice(0, eq))) return undefined;
	return token.slice(eq + 1);
}

function scanAgentBrowserRest(
	tokens: readonly string[],
	valueFlags: ReadonlySet<string>,
	afterDoubleDash: boolean,
): { positionals: string[]; flagWriteTargets: string[] } {
	if (afterDoubleDash) {
		return { positionals: [...tokens], flagWriteTargets: [] };
	}
	const positionals: string[] = [];
	const flagWriteTargets: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--") {
			positionals.push(...tokens.slice(i + 1));
			break;
		}
		const eqVal = extractEqualsFlagValue(token, AGENT_BROWSER_WRITE_VALUE_FLAGS);
		if (eqVal !== undefined) {
			if (eqVal.length > 0) flagWriteTargets.push(eqVal);
			continue;
		}
		if (AGENT_BROWSER_WRITE_VALUE_FLAGS.has(token)) {
			const next = tokens[i + 1];
			if (typeof next === "string" && next.length > 0) flagWriteTargets.push(next);
			i++;
			continue;
		}
		if (AGENT_BROWSER_GLOBAL_VALUE_FLAGS.has(token) || valueFlags.has(token)) {
			i++;
			continue;
		}
		if (token.startsWith("-")) {
			continue;
		}
		positionals.push(token);
	}
	return { positionals, flagWriteTargets };
}

/**
 * Extracts resolved file-writing target paths from an `agent_browser` CLI `argv` array
 * relative to `cwd` (without importing the `agent-browser` extension).
 */
export function extractAgentBrowserWriteTargets(argv: readonly string[], cwd: string): string[] {
	const rawTargets: string[] = [];
	let subcommand: string | undefined;
	let subcommandIndex = -1;
	let afterDoubleDash = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (token === "--") {
			afterDoubleDash = true;
			if (i + 1 < argv.length) {
				subcommand = argv[i + 1];
				subcommandIndex = i + 1;
			}
			break;
		}
		const eqVal = extractEqualsFlagValue(token, AGENT_BROWSER_WRITE_VALUE_FLAGS);
		if (eqVal !== undefined) {
			if (eqVal.length > 0) rawTargets.push(eqVal);
			continue;
		}
		if (AGENT_BROWSER_WRITE_VALUE_FLAGS.has(token)) {
			const next = argv[i + 1];
			if (typeof next === "string" && next.length > 0) rawTargets.push(next);
			i++;
			continue;
		}
		if (AGENT_BROWSER_GLOBAL_VALUE_FLAGS.has(token)) {
			i++;
			continue;
		}
		if (token.startsWith("-")) {
			continue;
		}
		subcommand = token;
		subcommandIndex = i;
		break;
	}

	if (subcommand) {
		const rest = argv.slice(subcommandIndex + 1);
		const valueFlags =
			subcommand === "screenshot"
				? AGENT_BROWSER_SCREENSHOT_VALUE_FLAGS
				: subcommand === "pdf"
					? AGENT_BROWSER_PDF_VALUE_FLAGS
					: new Set<string>();
		const { positionals, flagWriteTargets } = scanAgentBrowserRest(rest, valueFlags, afterDoubleDash);
		rawTargets.push(...flagWriteTargets);

		if (subcommand === "screenshot") {
			if (positionals[0]) rawTargets.push(positionals[0]);
		} else if (subcommand === "pdf") {
			if (positionals[0]) rawTargets.push(positionals[0]);
		} else if (subcommand === "trace") {
			if ((positionals[0] === "start" || positionals[0] === "stop") && positionals[1]) {
				rawTargets.push(positionals[1]);
			}
		} else if (subcommand === "state") {
			if (positionals[0] === "save" && positionals[1]) {
				rawTargets.push(positionals[1]);
			}
		} else if (subcommand === "download") {
			if (positionals.length >= 2) {
				rawTargets.push(positionals[1]!);
			} else if (positionals.length === 1) {
				rawTargets.push(positionals[0]!);
			}
		} else if (subcommand === "record") {
			if (positionals[0] === "start" && positionals[1]) {
				rawTargets.push(positionals[1]);
			}
		}
	}

	return [...new Set(rawTargets.map((target) => resolveLiteralPath(target, cwd)))];
}

/**
 * Extracts external paths (outside `projectCwd` and `/tmp`) from an `agent_browser` call's
 * optional `cwd` and file-writing `argv` targets.
 */
export function extractAgentBrowserExternalTargets(
	argv: readonly string[],
	projectCwd: string,
	rawCwd?: string,
): string[] {
	const hasCwd = typeof rawCwd === "string" && rawCwd.length > 0;
	const targetCwd = hasCwd ? resolveLiteralPath(rawCwd, projectCwd) : projectCwd;
	const external: string[] = [];
	if (hasCwd) {
		const cwdCheck = evaluatePathAccess({ targetPath: rawCwd, cwd: projectCwd, literal: true });
		if (!cwdCheck.allowed) {
			external.push(cwdCheck.resolvedPath);
		}
	}
	for (const writeTarget of extractAgentBrowserWriteTargets(argv, targetCwd)) {
		const check = evaluatePathAccess({ targetPath: writeTarget, cwd: projectCwd, literal: true });
		if (!check.allowed) {
			external.push(check.resolvedPath);
		}
	}
	return [...new Set(external)];
}

const AGENT_DESKTOP_GLOBAL_VALUE_FLAGS = new Set([
	"--session",
	"--agent-id",
	"--trace",
	"--wait-for",
	"-w",
	"--wait-for-gone",
	"--wait-timeout",
	"--screenshot",
]);

const AGENT_DESKTOP_WRITE_VALUE_FLAGS = new Set(["--screenshot", "--trace"]);

const AGENT_DESKTOP_SCREENSHOT_VALUE_FLAGS = new Set([
	"--app",
	"--window-id",
	"--screen",
	"--format",
	"--quality",
]);

const AGENT_DESKTOP_TRACE_VALUE_FLAGS = new Set(["--out", "--limit"]);

/**
 * Normalizes an `agent_desktop` tool's optional `cwd` argument the same way `agent-desktop` does:
 * trims whitespace, ignores empty strings and `"none"`, and strips one leading `@`.
 */
export function normalizeAgentDesktopCwd(rawCwd?: string): string | undefined {
	if (typeof rawCwd !== "string") return undefined;
	const trimmed = rawCwd.trim();
	if (trimmed.length === 0 || trimmed.toLowerCase() === "none") return undefined;
	const stripped = trimmed.replace(/^@/, "").trim();
	if (stripped.length === 0 || stripped.toLowerCase() === "none") return undefined;
	return stripped;
}

/**
 * Extracts resolved file-writing target paths from an `agent_desktop` CLI `argv` array
 * relative to `cwd` (without importing the `agent-desktop` extension).
 *
 * Read-only calls (such as `snapshot`, `list-windows`, `get`, `status`, `click` without
 * `--screenshot`/`--trace`, or `screenshot` without an explicit output path, which writes to a
 * cleaned-up temp file under `os.tmpdir()`) return an empty array.
 */
export function extractAgentDesktopWriteTargets(argv: readonly string[], cwd: string): string[] {
	const cleaned = argv.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0);
	const rawTargets: string[] = [];
	let subcommand: string | undefined;
	let subcommandIndex = -1;
	let afterDoubleDash = false;
	let hasHelpOrVersion = false;

	for (let i = 0; i < cleaned.length; i++) {
		const token = cleaned[i]!;
		if (token === "--") {
			afterDoubleDash = true;
			if (i + 1 < cleaned.length) {
				subcommand = cleaned[i + 1];
				subcommandIndex = i + 1;
			}
			break;
		}
		if (token === "--help" || token === "-h" || token === "--version" || token === "-V") {
			hasHelpOrVersion = true;
			continue;
		}
		const eqVal = extractEqualsFlagValue(token, AGENT_DESKTOP_WRITE_VALUE_FLAGS);
		if (eqVal !== undefined) {
			if (eqVal.length > 0) rawTargets.push(eqVal);
			continue;
		}
		if (AGENT_DESKTOP_WRITE_VALUE_FLAGS.has(token)) {
			const next = cleaned[i + 1];
			if (typeof next === "string" && next.length > 0) rawTargets.push(next);
			i++;
			continue;
		}
		if (AGENT_DESKTOP_GLOBAL_VALUE_FLAGS.has(token)) {
			i++;
			continue;
		}
		if (token.startsWith("-")) {
			continue;
		}
		subcommand = token;
		subcommandIndex = i;
		break;
	}

	if (subcommand && !hasHelpOrVersion) {
		const rest = cleaned.slice(subcommandIndex + 1);
		const valueFlags =
			subcommand === "screenshot"
				? AGENT_DESKTOP_SCREENSHOT_VALUE_FLAGS
				: subcommand === "trace"
					? AGENT_DESKTOP_TRACE_VALUE_FLAGS
					: new Set<string>();
		const positionals: string[] = [];
		let traceOutPath: string | undefined;
		let restHasHelp = false;

		if (afterDoubleDash) {
			positionals.push(...rest);
		} else {
			for (let i = 0; i < rest.length; i++) {
				const token = rest[i]!;
				if (token === "--") {
					positionals.push(...rest.slice(i + 1));
					break;
				}
				if (token === "--help" || token === "-h") {
					restHasHelp = true;
					continue;
				}
				const eqWrite = extractEqualsFlagValue(token, AGENT_DESKTOP_WRITE_VALUE_FLAGS);
				if (eqWrite !== undefined) {
					if (eqWrite.length > 0) rawTargets.push(eqWrite);
					continue;
				}
				if (AGENT_DESKTOP_WRITE_VALUE_FLAGS.has(token)) {
					const next = rest[i + 1];
					if (typeof next === "string" && next.length > 0) rawTargets.push(next);
					i++;
					continue;
				}
				if (subcommand === "trace") {
					if (token === "--out") {
						const next = rest[i + 1];
						if (typeof next === "string" && next.length > 0) traceOutPath = next;
						i++;
						continue;
					}
					if (token.startsWith("--out=")) {
						const val = token.slice("--out=".length);
						if (val.length > 0) traceOutPath = val;
						continue;
					}
				}
				if (AGENT_DESKTOP_GLOBAL_VALUE_FLAGS.has(token) || valueFlags.has(token)) {
					i++;
					continue;
				}
				if (token.startsWith("-")) {
					continue;
				}
				positionals.push(token);
			}
		}

		if (subcommand === "screenshot" && !restHasHelp) {
			if (positionals[0]) rawTargets.push(positionals[0]);
		} else if (subcommand === "trace" && positionals[0] === "export" && !restHasHelp) {
			if (traceOutPath) {
				rawTargets.push(traceOutPath);
			} else {
				// `trace export` without `--out` writes `trace-<session>.html` in `cwd`.
				rawTargets.push(".");
			}
		}
	}

	return [...new Set(rawTargets.map((target) => resolveLiteralPath(target, cwd)))];
}

/**
 * Extracts external file-writing targets (outside `projectCwd` and `/tmp`) from an
 * `agent_desktop` call's optional `cwd` and file-writing `argv` options. Read-only calls
 * produce no write targets even when an external `cwd` is supplied.
 */
export function extractAgentDesktopExternalTargets(
	argv: readonly string[],
	projectCwd: string,
	rawCwd?: string,
): string[] {
	const normalizedCwd = normalizeAgentDesktopCwd(rawCwd);
	const targetCwd = normalizedCwd ? resolveLiteralPath(normalizedCwd, projectCwd) : projectCwd;
	const external: string[] = [];
	for (const writeTarget of extractAgentDesktopWriteTargets(argv, targetCwd)) {
		const check = evaluatePathAccess({ targetPath: writeTarget, cwd: projectCwd, literal: true });
		if (!check.allowed) {
			external.push(check.resolvedPath);
		}
	}
	return [...new Set(external)];
}
