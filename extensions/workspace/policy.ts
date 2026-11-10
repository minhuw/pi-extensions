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
function containsPath(parent: string, candidate: string): boolean {
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
			? [...new Set(raw.allowedPaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => resolveCanonicalPath(item, cwd)))]
			: [];
		const defaultTtlMs = typeof raw?.defaultTtlMs === "number" && Number.isFinite(raw.defaultTtlMs) && raw.defaultTtlMs >= 0
			? raw.defaultTtlMs
			: 0;
		return { allowedPaths, defaultTtlMs };
	} catch {
		return { allowedPaths: [], defaultTtlMs: 0 };
	}
}

export async function allowProjectPath(cwd: string, targetPath: string): Promise<string> {
	const canonical = resolveCanonicalPath(targetPath, cwd);
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
	// A literal path is already canonical, and `isSubpath` would read it as a shell word again.
	const isInside = (root: string): boolean =>
		options.literal ? containsPath(resolveCanonicalPath(root), resolvedPath) : isSubpath(root, resolvedPath);

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
			const canonicalAllowed = resolveCanonicalPath(allowedEntry, canonicalCwd);
			if (isInside(canonicalAllowed)) {
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
			if (isSubpath(tmpRoot, canonicalCwd)) {
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

/** Words of a simple command, past leading `KEY=VALUE` assignments and `sudo`/`env`/`command` wrappers. */
function commandWords(command: Command): string[] {
	const words = [command.name, ...command.args]
		.filter((arg): arg is Word => arg?.type === "Word")
		.map((word) => bashWordValue(word));
	let idx = 0;
	while (idx < words.length) {
		const word = words[idx]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "sudo" || word === "env" || word === "command") {
			idx++;
			continue;
		}
		break;
	}
	return words.slice(idx);
}

function isLocalShell(node: SyntaxNode): boolean {
	if (node.type !== "Command") return false;
	const verb = commandWords(node)[0];
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

/** Archive written by `tar -c/-r/-u`, or the `-C` extraction directory otherwise. */
function extractTarTarget(args: string[]): string | undefined {
	let archive: string | undefined;
	let directory: string | undefined;
	let writesArchive = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "-C" || arg === "--directory" || arg === "-f" || arg === "--file") {
			if (arg === "-C" || arg === "--directory") directory = args[i + 1];
			else archive = args[i + 1];
			i++;
			continue;
		}
		if (arg.startsWith("--directory=")) {
			directory = arg.slice("--directory=".length);
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
		// Bundled short options (`-czf out.tgz`), or traditional bundled first argument (`czf out.tgz`).
		const letters = arg.startsWith("-") && !arg.startsWith("--") ? arg.slice(1) : i === 0 ? arg : "";
		if (!/^[A-Za-z]+$/.test(letters)) continue;
		if (/[cru]/.test(letters)) writesArchive = true;
		if (letters.endsWith("f") && args[i + 1]) {
			archive = args[i + 1];
			i++;
		}
	}
	if (writesArchive) return archive && archive !== "-" ? archive : undefined;
	return directory;
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
				const saved = { cwd: effectiveCwd, shellReadsStdin };
				shellReadsStdin ||= node.commands.some(isLocalShell);
				for (const stage of node.commands) {
					effectiveCwd = saved.cwd;
					visit(stage);
				}
				effectiveCwd = saved.cwd;
				shellReadsStdin = saved.shellReadsStdin;
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
					visit(parse(script));
					effectiveCwd = saved;
				}
				return;
			}
			case "Command": {
				const saved = shellReadsStdin;
				shellReadsStdin ||= isLocalShell(node);
				forEachChild(node, visit);
				shellReadsStdin = saved;
				const words = commandWords(node);
				const [verb, ...args] = words;
				if (!verb) return;
				visitor.command(words, effectiveCwd);
				if (verb === "cd" || verb === "pushd") {
					// `cd` alone goes home.
					const dest = args.find((a) => !a.startsWith("-")) ?? os.homedir();
					if (dest !== "-") {
						effectiveCwd = resolveBashWord(dest, effectiveCwd);
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

/**
 * Extracts all resolved filesystem write/creation target paths from a shell command.
 * Commands for other machines (`ssh host mkdir /x`) and heredoc bodies are data unless a
 * local shell reads them (`bash <<EOF`, `cat <<EOF | sh`).
 */
export function extractBashWriteTargets(command: string, cwd: string): string[] {
	const canonicalCwd = resolveCanonicalPath(cwd);
	const targets: string[] = [];

	const inspectCommand = ([verb, ...args]: string[], effectiveCwd: string): void => {
		if (!verb || verb === "cd" || verb === "pushd") return;

		if (verb === "git") {
			const gitTargets = extractGitTargets(args, effectiveCwd);
			targets.push(...gitTargets);
			return;
		}

		if (verb === "mkdir" || verb === "touch" || verb === "rm" || verb === "rmdir" || verb === "tee") {
			const flagsWithValue = new Set(["-m", "--mode"]);
			const positionals: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if (flagsWithValue.has(arg)) {
					i++;
					continue;
				}
				if (arg.startsWith("-")) continue;
				positionals.push(arg);
			}
			for (const p of positionals) {
				targets.push(resolveBashWord(p, effectiveCwd));
			}
			if (positionals.length === 0 && effectiveCwd !== canonicalCwd) {
				targets.push(effectiveCwd);
			}
			return;
		}

		if (verb === "cp" || verb === "ln" || verb === "install") {
			let targetDir: string | undefined;
			const positionals: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if ((arg === "-t" || arg === "--target-directory") && args[i + 1]) {
					targetDir = args[i + 1]!;
					i++;
					continue;
				}
				if (arg.startsWith("--target-directory=")) {
					targetDir = arg.slice("--target-directory=".length);
					continue;
				}
				if (arg.startsWith("-")) continue;
				positionals.push(arg);
			}
			if (targetDir) {
				targets.push(resolveBashWord(targetDir, effectiveCwd));
			} else if (positionals.length >= 2) {
				targets.push(resolveBashWord(positionals[positionals.length - 1]!, effectiveCwd));
			} else if (effectiveCwd !== canonicalCwd) {
				targets.push(effectiveCwd);
			}
			return;
		}

		if (verb === "mv") {
			const positionals = args.filter((arg) => !arg.startsWith("-"));
			for (const p of positionals) {
				targets.push(resolveBashWord(p, effectiveCwd));
			}
			if (positionals.length === 0 && effectiveCwd !== canonicalCwd) {
				targets.push(effectiveCwd);
			}
			return;
		}

		if (verb === "cargo" && (args[0] === "new" || args[0] === "init")) {
			const positionals = args.slice(1).filter((arg) => !arg.startsWith("-"));
			if (positionals[0]) {
				targets.push(resolveBashWord(positionals[0], effectiveCwd));
			} else {
				targets.push(effectiveCwd);
			}
			return;
		}

		const explicitTarget =
			verb === "dd" ? args.find((arg) => arg.startsWith("of="))?.slice("of=".length)
			: verb === "tar" ? extractTarTarget(args)
			: verb === "unzip" ? optionValue(args, ["-d"]) ?? args.find((arg) => /^-d./.test(arg))?.slice(2)
			: verb === "npm" || verb === "pnpm" || verb === "yarn" ? optionValue(args, ["--prefix", "-C", "--dir", "--cwd"])
			: undefined;
		if (explicitTarget) {
			targets.push(resolveBashWord(explicitTarget, effectiveCwd));
			return;
		}

		if (MUTATING_VERBS.has(verb) && effectiveCwd !== canonicalCwd) {
			targets.push(effectiveCwd);
		}
	};

	walkBashCommands(command, canonicalCwd, {
		command: inspectCommand,
		writeRedirect: (target, effectiveCwd) => {
			targets.push(resolveBashWord(target, effectiveCwd));
		},
	});
	return [...new Set(targets)];
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

/**
 * Returns the first of `stateFiles` that a simple command of `command` names, whatever that command is,
 * unless its verb only reads: one of its words resolves to the file, or one resolves to the file's
 * directory while another word's last path segment is the file's name (`cp /tmp/policy.json .pi/workspaces/`).
 * Words resolve as write targets do, and letter case is ignored.
 */
export function findBashNamedStateFile(command: string, cwd: string, stateFiles: string[]): string | undefined {
	const states = stateFiles.map((file) => ({
		file,
		resolved: resolveCanonicalPath(file).toLowerCase(),
		dir: resolveCanonicalPath(path.dirname(file)).toLowerCase(),
		name: path.basename(file).toLowerCase(),
	}));
	let named: string | undefined;

	walkBashCommands(command, resolveCanonicalPath(cwd), {
		command: (words, effectiveCwd) => {
			if (named || READ_ONLY_VERBS.has(words[0]!)) return;
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
	});
	return named;
}

/**
 * Inspects a shell command string for write/creation operations targeting paths outside
 * `<cwd>` and `/tmp`.
 */
export function extractBashExternalWriteTargets(command: string, cwd: string): string[] {
	const writeTargets = extractBashWriteTargets(command, cwd);
	const external: string[] = [];
	for (const targetPath of writeTargets) {
		const check = evaluatePathAccess({ targetPath, cwd, literal: true });
		if (!check.allowed) {
			external.push(check.resolvedPath);
		}
	}
	return [...new Set(external)];
}
