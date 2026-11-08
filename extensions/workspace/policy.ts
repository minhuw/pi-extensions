import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ProjectPolicy {
	allowedPaths: string[];
	defaultTtlMs: number;
}

export interface PathAccessOptions {
	targetPath: string;
	cwd: string;
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
 * Resolves `targetPath` to a canonical absolute path, expanding `~` / `$HOME` and
 * resolving symlinks via the deepest existing ancestor on disk so symlinks inside
 * `<cwd>` pointing outside `<cwd>` (and `/tmp` -> `/private/tmp` on macOS) are caught.
 */
export function resolveCanonicalPath(targetPath: string, baseCwd?: string, seen = new Set<string>()): string {
	const expanded = expandHomeTokens(targetPath);
	const base = baseCwd !== undefined ? resolveCanonicalPath(baseCwd, undefined, seen) : process.cwd();
	const absPath = path.resolve(base, expanded);

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
					const resolvedTarget = resolveCanonicalPath(linkTarget, path.dirname(current), seen);
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

export function isSubpath(parentPath: string, candidatePath: string): boolean {
	const parent = resolveCanonicalPath(parentPath);
	const candidate = resolveCanonicalPath(candidatePath);
	if (candidate === parent) return true;
	const rel = path.relative(parent, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !rel.startsWith("../") && !path.isAbsolute(rel);
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

function isRelativeParentTraversal(rawTarget: string): boolean {
	const expanded = expandHomeTokens(rawTarget);
	return !path.isAbsolute(expanded) && (expanded === ".." || expanded.startsWith("../") || expanded.startsWith("..\\"));
}

export function evaluatePathAccess(options: PathAccessOptions): PathAccessEvaluation {
	const canonicalCwd = resolveCanonicalPath(options.cwd);
	const resolvedPath = resolveCanonicalPath(options.targetPath, canonicalCwd);

	if (resolvedPath === "/dev/null") {
		return { allowed: true, resolvedPath, matchedRoot: "/dev/null" };
	}

	// 1. Always allow paths inside <cwd> (including <cwd>/.pi/workspaces).
	if (isSubpath(canonicalCwd, resolvedPath)) {
		return { allowed: true, resolvedPath, matchedRoot: canonicalCwd };
	}

	// 2. Always allow git common dir of <cwd> when <cwd> is a git repo/worktree.
	for (const gitDir of resolveGitCommonDirs(canonicalCwd)) {
		if (isSubpath(gitDir, resolvedPath)) {
			return { allowed: true, resolvedPath, matchedRoot: gitDir };
		}
	}

	// 3. Always allow sessionAllowed, projectAllowed, and extraAllowed roots.
	for (const group of [options.sessionAllowed, options.projectAllowed, options.extraAllowed]) {
		if (!group) continue;
		for (const allowedEntry of group) {
			const canonicalAllowed = resolveCanonicalPath(allowedEntry, canonicalCwd);
			if (isSubpath(canonicalAllowed, resolvedPath)) {
				return { allowed: true, resolvedPath, matchedRoot: canonicalAllowed };
			}
		}
	}

	// 4. Allow /tmp and os.tmpdir() unless the path is a sibling of <cwd> inside a test sandbox under tmpdir
	// or a relative "../" traversal escaping <cwd>.
	if (!isRelativeParentTraversal(options.targetPath)) {
		const tmpRoots = new Set<string>([
			resolveCanonicalPath(os.tmpdir()),
			resolveCanonicalPath("/tmp"),
		]);
		for (const tmpRoot of tmpRoots) {
			if (!isSubpath(tmpRoot, resolvedPath)) continue;
			if (isSubpath(tmpRoot, canonicalCwd)) {
				const relCwd = path.relative(tmpRoot, canonicalCwd);
				const firstSegment = relCwd.split(/[\\/]/)[0];
				if (firstSegment) {
					const sandboxRoot = path.join(tmpRoot, firstSegment);
					if (isSubpath(sandboxRoot, resolvedPath)) {
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
 * (excluding metadata files starting with `.` or `policy.json`).
 */
export function extractWorkspaceNameFromPath(targetPath: string, cwd: string): string | undefined {
	const wsRoot = workspacesDir(cwd);
	const resolved = resolveCanonicalPath(targetPath, cwd);
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

function splitShellStatements(command: string): string[] {
	const statements: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			current += ch;
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ";" || ch === "\n") {
			if (current.trim()) statements.push(current.trim());
			current = "";
			continue;
		}
		if ((ch === "&" && command[i + 1] === "&") || (ch === "|" && command[i + 1] === "|")) {
			if (current.trim()) statements.push(current.trim());
			current = "";
			i++;
			continue;
		}
		if (ch === "|" && command[i - 1] !== ">") {
			if (current.trim()) statements.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) statements.push(current.trim());
	return statements;
}

function tokenizeStatement(statement: string): string[] {
	const stripped = statement.replace(/^[(\s]+|[)\s]+$/g, "");
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;

	const pushCurrent = () => {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	};

	for (let i = 0; i < stripped.length; i++) {
		const ch = stripped[i]!;
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			pushCurrent();
			continue;
		}
		if (ch === ">" || ((ch === "1" || ch === "2" || ch === "&") && current === "" && stripped[i + 1] === ">")) {
			pushCurrent();
			let op = ch;
			if (ch !== ">") {
				i++;
				op += ">";
			}
			if (stripped[i + 1] === ">") {
				i++;
				op += ">";
			}
			tokens.push(op);
			continue;
		}
		current += ch;
	}
	pushCurrent();
	return tokens;
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
			gitCwd = resolveCanonicalPath(args[idx + 1]!, gitCwd);
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
			return [resolveCanonicalPath(positionals[1]!, gitCwd)];
		}
		if (positionals.length === 1) {
			const repoName = path.basename(positionals[0]!.replace(/\/+$/, ""), ".git") || "repo";
			return [resolveCanonicalPath(repoName, gitCwd)];
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
		return [positionals[0] ? resolveCanonicalPath(positionals[0], gitCwd) : gitCwd];
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
			return [resolveCanonicalPath(positionals[0], gitCwd)];
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

/**
 * Extracts all resolved filesystem write/creation target paths from a shell command.
 */
export function extractBashWriteTargets(command: string, cwd: string): string[] {
	const canonicalCwd = resolveCanonicalPath(cwd);
	let effectiveCwd = canonicalCwd;
	const targets: string[] = [];

	for (const statement of splitShellStatements(command)) {
		const rawTokens = tokenizeStatement(statement);
		if (rawTokens.length === 0) continue;

		// Extract output redirections (>, >>, 1>, 2>, &>) first.
		const cmdTokens: string[] = [];
		let hadRedirection = false;
		for (let i = 0; i < rawTokens.length; i++) {
			const tok = rawTokens[i]!;
			if (/^(?:1|2|&)?>>?$/.test(tok)) {
				const target = rawTokens[i + 1];
				if (target && !target.startsWith("&") && target !== "/dev/null") {
					targets.push(resolveCanonicalPath(target, effectiveCwd));
					hadRedirection = true;
				}
				i++;
				continue;
			}
			const inlineRedir = /^(?:1|2|&)?>>?(.+)$/.exec(tok);
			if (inlineRedir?.[1]) {
				const target = inlineRedir[1];
				if (!target.startsWith("&") && target !== "/dev/null") {
					targets.push(resolveCanonicalPath(target, effectiveCwd));
					hadRedirection = true;
				}
				continue;
			}
			cmdTokens.push(tok);
		}

		// Strip leading env assignments (KEY=VALUE) and command wrappers (sudo, env, command).
		let idx = 0;
		while (idx < cmdTokens.length) {
			const tok = cmdTokens[idx]!;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok) || tok === "sudo" || tok === "env" || tok === "command") {
				idx++;
				continue;
			}
			break;
		}

		const verb = cmdTokens[idx];
		const args = cmdTokens.slice(idx + 1);
		if (!verb) {
			if (hadRedirection && effectiveCwd !== canonicalCwd) {
				targets.push(effectiveCwd);
			}
			continue;
		}

		if (verb === "cd" || verb === "pushd") {
			const dest = args.find((a) => !a.startsWith("-")) ?? "~";
			if (dest !== "-") {
				effectiveCwd = resolveCanonicalPath(dest, effectiveCwd);
			}
			continue;
		}

		if (verb === "git") {
			const gitTargets = extractGitTargets(args, effectiveCwd);
			targets.push(...gitTargets);
			continue;
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
				targets.push(resolveCanonicalPath(p, effectiveCwd));
			}
			if (positionals.length === 0 && effectiveCwd !== canonicalCwd) {
				targets.push(effectiveCwd);
			}
			continue;
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
				targets.push(resolveCanonicalPath(targetDir, effectiveCwd));
			} else if (positionals.length >= 2) {
				targets.push(resolveCanonicalPath(positionals[positionals.length - 1]!, effectiveCwd));
			} else if (effectiveCwd !== canonicalCwd) {
				targets.push(effectiveCwd);
			}
			continue;
		}

		if (verb === "mv") {
			const positionals = args.filter((arg) => !arg.startsWith("-"));
			for (const p of positionals) {
				targets.push(resolveCanonicalPath(p, effectiveCwd));
			}
			if (positionals.length === 0 && effectiveCwd !== canonicalCwd) {
				targets.push(effectiveCwd);
			}
			continue;
		}

		if (verb === "cargo" && (args[0] === "new" || args[0] === "init")) {
			const positionals = args.slice(1).filter((arg) => !arg.startsWith("-"));
			if (positionals[0]) {
				targets.push(resolveCanonicalPath(positionals[0], effectiveCwd));
			} else {
				targets.push(effectiveCwd);
			}
			continue;
		}

		const explicitTarget =
			verb === "dd" ? args.find((arg) => arg.startsWith("of="))?.slice("of=".length)
			: verb === "tar" ? extractTarTarget(args)
			: verb === "unzip" ? optionValue(args, ["-d"]) ?? args.find((arg) => /^-d./.test(arg))?.slice(2)
			: verb === "npm" || verb === "pnpm" || verb === "yarn" ? optionValue(args, ["--prefix", "-C", "--dir", "--cwd"])
			: undefined;
		if (explicitTarget) {
			targets.push(resolveCanonicalPath(explicitTarget, effectiveCwd));
			continue;
		}

		if (MUTATING_VERBS.has(verb) && effectiveCwd !== canonicalCwd) {
			targets.push(effectiveCwd);
		}
	}

	return [...new Set(targets)];
}

/**
 * Inspects a shell command string for write/creation operations targeting paths outside
 * `<cwd>` and `/tmp`.
 */
export function extractBashExternalWriteTargets(command: string, cwd: string): string[] {
	const writeTargets = extractBashWriteTargets(command, cwd);
	const external: string[] = [];
	for (const targetPath of writeTargets) {
		const check = evaluatePathAccess({ targetPath, cwd });
		if (!check.allowed) {
			external.push(check.resolvedPath);
		}
	}
	return [...new Set(external)];
}
