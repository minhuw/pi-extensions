// selfdrive's guard: while any standing grant exists in this process, refuse the tool calls that would deliver a Herder
// run, edit the user's checkout, push or publish, or need privileges, another machine, or system settings. It runs in
// every session of the process (subagent and Herder children load this extension in-process too). It is a heuristic that
// prevents accidents, not a sandbox: a determined command can get past it.
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { forEachChild, parse, type Assignment, type Command, type SyntaxNode } from "unbash";
import { grants, type StandingApproval } from "./grants.ts";

/** Runtime seams for tests. */
export const guardRuntime = { parse };

const BLOCKED = "Blocked by self-driving mode:";
export const reasons = {
	deliver: `${BLOCKED} delivery waits for your user; record the run as proposed (selfdrive_task with its Herder run id).`,
	checkout: (what: string) =>
		`${BLOCKED} ${what} would change your user's checkout. Make the change through a Herder run or in a worktree under .pi/workspaces/.`,
	remote: (what: string) =>
		`${BLOCKED} ${what} leaves this machine, and that waits for your user. Leave the work in a verified Herder run and record it as proposed.`,
	system: (what: string) =>
		`${BLOCKED} ${what} needs privileges or another machine, or changes system settings. Record what is needed as a question for your user (selfdrive_task with needs).`,
	analysis: `${BLOCKED} could not safely parse shell command under selfdrive standing approval.`,
	nesting: `${BLOCKED} shell command exceeds maximum inspection nesting depth under selfdrive standing approval.`,
};

/** Registers the `tool_call` guard that holds while any standing grant exists in this process. */
export function registerGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		const active = grants();
		if (active.length === 0) return undefined;
		const reason = blockReason(event.toolName, event.input, ctx.cwd, ctx.sessionManager?.getSessionId?.(), active);
		return reason ? { block: true, reason } : undefined;
	});
}

/** Why the guard refuses this tool call while `active` grants exist, or undefined when it may run. */
export function blockReason(toolName: string, input: unknown, cwd: string, sessionId: string | undefined, active: StandingApproval[]): string | undefined {
	const args = (input ?? {}) as Record<string, unknown>;
	if (toolName === "herder_deliver") return active.some((grant) => grant.id === sessionId) ? reasons.deliver : undefined;
	const toplevels = [...new Set(active.map((grant) => canonical(grant.toplevel)))];
	const commonDirs = [...new Set(active.map((grant) => canonical(grant.commonDir)))];
	if (toolName === "write" || toolName === "edit") {
		const raw = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
		const target = raw?.trim() ? resolveToolPath(raw, cwd) : undefined;
		return target && insideCheckout(target, toplevels, commonDirs) ? reasons.checkout(`${toolName} ${target}`) : undefined;
	}
	if (toolName === "bash" && typeof args.command === "string" && args.command.trim()) return bashBlockReason(args.command, cwd, toplevels, commonDirs);
	if (toolName === "process_start" && typeof args.command === "string" && args.command.trim()) {
		// The process runs in `cwd` relative to the session's, resolved the way the processes extension resolves it.
		const dir = typeof args.cwd === "string" ? resolve(cwd, args.cwd.replace(/^@/, "")) : cwd;
		return bashBlockReason(args.command, dir, toplevels, commonDirs);
	}
	if (toolName === "agent_browser") {
		const argv = Array.isArray(args.argv) ? args.argv.filter((arg): arg is string => typeof arg === "string") : [];
		if (argv.length === 0) return undefined;
		const rawCwd = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
		const dir = rawCwd ? canonical(resolve(canonical(cwd), rawCwd)) : canonical(cwd);
		const hit = extractAgentBrowserWriteTargets(argv, dir).find((target) => insideCheckout(target, toplevels, commonDirs));
		return hit ? reasons.checkout(`agent_browser ${hit}`) : undefined;
	}
	if (toolName === "agent_desktop") {
		const argv = Array.isArray(args.argv) ? args.argv.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0) : [];
		if (argv.length === 0) return undefined;
		const rawCwd = normalizeAgentDesktopCwd(args.cwd);
		const dir = rawCwd ? canonical(resolve(canonical(cwd), rawCwd)) : canonical(cwd);
		const hit = extractAgentDesktopWriteTargets(argv, dir).find((target) => insideCheckout(target, toplevels, commonDirs));
		return hit ? reasons.checkout(`agent_desktop ${hit}`) : undefined;
	}
	return undefined;
}

// ---- Paths ----

/**
 * The canonical form of an absolute or `cwd`-relative path: the deepest existing ancestor's real path (true case on
 * case-insensitive file systems) followed by the missing rest, following a dangling symlink to where a write would land.
 */
export function canonical(path: string, seen = new Set<string>()): string {
	const absolute = resolve(path);
	const trailing: string[] = [];
	let current = absolute;
	for (;;) {
		try {
			const real = realpathSync.native(current);
			return trailing.length > 0 ? join(real, ...trailing) : real;
		} catch {
			try {
				if (lstatSync(current).isSymbolicLink() && !seen.has(current)) {
					seen.add(current);
					const target = canonical(resolve(dirname(current), readlinkSync(current)), seen);
					return trailing.length > 0 ? join(target, ...trailing) : target;
				}
			} catch {
				// Missing: try the parent.
			}
		}
		const parent = dirname(current);
		if (parent === current) return absolute;
		trailing.unshift(basename(current));
		current = parent;
	}
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * A `write`/`edit` path resolved the way Pi's file tools resolve it (Unicode spaces become spaces, one leading `@` is
 * dropped, `~` is expanded, a `file://` URL becomes its path), then canonicalized. Undefined when Pi could not resolve it.
 */
function resolveToolPath(raw: string, cwd: string): string | undefined {
	let path = raw.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (/^file:\/\//.test(path)) {
		try {
			path = fileURLToPath(path);
		} catch {
			return undefined;
		}
	}
	return canonical(resolve(canonical(cwd), path));
}

const within = (parent: string, child: string): string | undefined => {
	const rel = relative(parent, child);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel;
};

function inWorktreeCheckout(path: string, toplevels: string[]): boolean {
	return toplevels.some((toplevel) => {
		const rel = within(toplevel, path);
		if (rel === undefined) return false;
		const [first, second] = rel.split(sep);
		if (first === ".git") return false;
		if (first === ".pi" && second === "workspaces") return false;
		return !inLinkedWorktree(toplevel, path);
	});
}

/**
 * True when the canonical `path` is in a grant's checkout or its protected `.git/` internals: inside its top level
 * (outside `.pi/workspaces/` and linked worktrees) or inside a protected git dir (outside `.git/herder/{worktrees,runs}`
 * and `.git/worktrees`).
 */
export function insideCheckout(path: string, toplevels: string[], commonDirs: string[] = []): boolean {
	const canonicalToplevels = [...new Set(toplevels.map((dir) => canonical(dir)))];
	return inWorktreeCheckout(path, canonicalToplevels) || inProtectedGitDir(path, protectedGitDirsOf(canonicalToplevels, commonDirs));
}

function readGitDirPointer(dotGit: string, baseDir: string): string | undefined {
	try {
		if (!statSync(dotGit).isFile()) return undefined;
		const target = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
		return target ? canonical(resolve(baseDir, target)) : undefined;
	} catch {
		return undefined;
	}
}

function readCommonDirPointer(gitDir: string): string | undefined {
	try {
		const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
		return common ? canonical(resolve(gitDir, common)) : undefined;
	} catch {
		return undefined;
	}
}

function protectedGitDirsOf(toplevels: string[], commonDirs: string[]): string[] {
	const dirs = new Set<string>(commonDirs.map((dir) => canonical(dir)));
	for (const toplevel of toplevels) {
		const canonicalTop = canonical(toplevel);
		const dotGit = join(canonicalTop, ".git");
		dirs.add(canonical(dotGit));
		const target = readGitDirPointer(dotGit, canonicalTop);
		if (target) {
			dirs.add(target);
			const common = readCommonDirPointer(target);
			if (common) dirs.add(common);
		}
	}
	return [...dirs];
}

function gitCommonDirOf(dir: string): string | undefined {
	const start = canonical(dir);
	const fromWorktreeGitDir = readCommonDirPointer(start);
	if (fromWorktreeGitDir) return fromWorktreeGitDir;
	for (let cur = start; ; cur = dirname(cur)) {
		const dotGit = join(cur, ".git");
		try {
			const stat = statSync(dotGit);
			if (stat.isDirectory()) return canonical(dotGit);
			if (stat.isFile()) {
				const gitDir = readGitDirPointer(dotGit, cur);
				if (!gitDir) return undefined;
				return readCommonDirPointer(gitDir) ?? gitDir;
			}
		} catch {
			// No `.git` at this level.
		}
		const parent = dirname(cur);
		if (parent === cur) return undefined;
	}
}

function inProtectedGitDir(path: string, gitDirs: string[]): boolean {
	return gitDirs.some((gitDir) => {
		const rel = within(gitDir, path);
		if (rel === undefined) return false;
		if (rel === "") return true;
		const parts = rel.split(sep);
		// Allow Herder's worktrees/runs under `<common-dir>/herder/{worktrees,runs}/...`
		// and linked worktree gitdirs under `<common-dir>/worktrees/<name>`.
		if (parts[0] === "herder" && (parts[1] === "worktrees" || parts[1] === "runs") && parts.length >= 3) return false;
		if (parts[0] === "worktrees" && parts.length >= 2) return false;
		return true;
	});
}

/** True when the nearest directory between `path` and `toplevel` (exclusive) holding a `.git` is a linked worktree. */
function inLinkedWorktree(toplevel: string, path: string): boolean {
	for (let dir = path; dir !== toplevel && within(toplevel, dir); dir = dirname(dir)) {
		const dotGit = join(dir, ".git");
		let isFile: boolean;
		try {
			isFile = lstatSync(dotGit).isFile();
		} catch {
			continue;
		}
		// A nested repository (a `.git` directory) or a submodule (`gitdir: …/modules/…`) is part of the checkout.
		if (!isFile) return false;
		try {
			// A linked worktree's `.git` file names `<common dir>/worktrees/<name>`.
			const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
			return gitdir !== undefined && basename(dirname(resolve(dir, gitdir))) === "worktrees";
		} catch {
			return false;
		}
	}
	return false;
}

// ---- Bash ----

const MAX_NESTING_DEPTH = 8;
const LOCAL_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);
const PSEUDO_DEVICE = /^\/dev\/(?:null|stdin|stdout|stderr|tty|fd\/\d+|tcp\/.*|udp\/.*)$/;
const PRIVILEGE = new Set(["sudo", "doas", "su", "pkexec"]);
const SYSTEM = new Set(["ssh", "scp", "sftp", "systemctl", "launchctl", "shutdown", "reboot", "halt", "poweroff", "pmset", "crontab", "mount", "umount", "wrmsr", "nvram"]);
const MUTATING_GIT = new Set([
	"add", "commit", "merge", "rebase", "reset", "checkout", "switch", "restore", "stash", "cherry-pick", "revert", "am", "apply",
	"tag", "update-ref", "clean", "rm", "mv", "pull",
]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
const DANGEROUS_GIT_CONFIG_KEY = /^(?:alias|core|include|includeif)\./i;
const DANGEROUS_GIT_CONFIG_SECTION = /^(?:alias|core|include|includeif)(?:\.|$)/i;
const GIT_CONFIG_OPTIONS_WITH_VALUE = new Set(["-f", "--file", "--blob", "--type", "--default", "--value", "--comment"]);
const GIT_CONFIG_READ_FLAGS = new Set(["--list", "-l", "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool"]);
const GIT_CONFIG_WRITE_FLAGS = new Set(["--add", "--replace-all", "--unset", "--unset-all"]);
const GIT_CONFIG_SECTION_FLAGS = new Set(["--remove-section", "--rename-section"]);
const PACKAGE_INSTALLS: Record<string, Set<string>> = {
	npm: new Set(["install", "i", "in", "add", "ci", "clean-install", "ic", "install-clean", "isntall", "remove", "rm", "r", "un", "uninstall", "unlink", "update", "up", "upgrade", "dedupe", "prune", "link", "ln"]),
	pnpm: new Set(["install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "prune", "link", "unlink"]),
	yarn: new Set(["install", "add", "remove", "upgrade", "up", "link", "unlink"]),
};
const PACKAGE_DIR_OPTIONS = ["--prefix", "-C", "--dir", "--cwd"];
/** Mutating `gh <group> <subcommand>`; a group mapped to `except` mutates with every subcommand but those. */
const GH_MUTATING: Record<string, Set<string> | { except: Set<string> }> = {
	pr: new Set(["create", "merge", "close", "comment", "edit", "review", "ready", "reopen", "lock", "unlock", "update-branch"]),
	issue: new Set(["create", "close", "comment", "edit", "reopen", "delete", "lock", "unlock", "pin", "unpin", "transfer", "develop"]),
	release: { except: new Set(["list", "view", "download"]) },
	repo: new Set(["create", "delete", "edit", "rename", "archive", "unarchive", "fork", "sync"]),
	workflow: new Set(["run", "enable", "disable"]),
	run: new Set(["rerun", "cancel", "delete"]),
	gist: new Set(["create", "edit", "delete", "rename"]),
	secret: new Set(["set", "delete"]),
	variable: new Set(["set", "delete"]),
	label: new Set(["create", "edit", "delete", "clone"]),
};

const expandHome = (word: string): string => {
	const home = homedir();
	const tilde = word === "~" ? home : word.startsWith("~/") ? join(home, word.slice(2)) : word;
	return tilde.replace(/\$\{HOME\}|\$HOME(?=$|\/)/g, home);
};

const resolveFrom = (dir: string, word: string): string => canonical(resolve(dir, expandHome(word)));

const positionals = (args: string[], withValue: Set<string> = new Set()): string[] => {
	const out: string[] = [];
	let options = true;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (options && arg === "--") options = false;
		else if (options && withValue.has(arg)) i++;
		else if (!(options && arg.startsWith("-") && arg !== "-")) out.push(arg);
	}
	return out;
};

/** The value of the last `name value` / `name=value` (or attached short `-Xvalue`) option among `names`. */
const optionValue = (args: string[], names: string[]): string | undefined => {
	let value: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		for (const name of names) {
			if (arg === name && i + 1 < args.length) value = args[i + 1];
			else if (name.startsWith("--") && arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1);
			else if (/^-[A-Za-z]$/.test(name) && arg.startsWith(name) && arg.length > 2) value = arg.slice(2);
		}
	}
	return value;
};

/**
 * Why the guard refuses a `bash` command, or undefined. A heuristic over the parsed command: always `git push`,
 * mutating `gh`, publishing, privileges, other machines, and system settings; and, in a grant's checkout (see
 * `insideCheckout`; the directory is the cwd as changed by `cd` and `git -C`), mutating git and package installs, and
 * file writes (`sed -i`, `perl -i`, redirections, `tee`, `rm`, `mv`, `cp`, `truncate`, …) whose targets are inside it.
 */
export function bashBlockReason(command: string, cwd: string, toplevels: string[], commonDirs: string[] = []): string | undefined {
	const found: string[] = [];
	const canonicalToplevels = [...new Set(toplevels.map((dir) => canonical(dir)))];
	const protectedGitDirs = protectedGitDirsOf(canonicalToplevels, commonDirs);
	const inCheckout = (path: string): boolean => inWorktreeCheckout(path, canonicalToplevels) || inProtectedGitDir(path, protectedGitDirs);
	const at = resolveFrom;
	let effectiveCwd = canonical(cwd);
	let shellReadsStdin = false;
	let stdinEnv: Map<string, string> | undefined;
	let stdinCwd: string | undefined;
	let shellVars = new Map<string, string>();
	let exportedEnv = new Map<string, string>();

	const writes = (what: string, targets: string[], dir: string): void => {
		const hit = targets.map((target) => at(dir, target)).find(inCheckout);
		if (hit) found.push(reasons.checkout(`${what} ${hit}`));
	};

	const findExecDirTargets = (root: string, dir: string): Array<{ execDir: string; placeholder: string }> => {
		const resolvedRoot = at(dir, root);
		if (isExistingFile(resolvedRoot)) {
			return [{ execDir: dirname(resolvedRoot), placeholder: `./${basename(resolvedRoot)}` }];
		}
		const dirs: string[] = [resolvedRoot];
		const seen = new Set<string>(dirs);
		const addDir = (candidate: string): void => {
			if (!seen.has(candidate)) {
				seen.add(candidate);
				dirs.push(candidate);
			}
		};
		for (const protectedDir of [...canonicalToplevels, ...protectedGitDirs]) {
			if (within(resolvedRoot, protectedDir) !== undefined) addDir(protectedDir);
		}
		for (const candidate of [...dirs]) {
			if (inCheckout(candidate)) addDir(join(candidate, "_"));
		}
		return dirs.map((execDir) => ({ execDir, placeholder: "." }));
	};

	const inspect = (all: string[], depth: number, prefixAssignments?: Map<string, string>, baseDir: string = effectiveCwd): void => {
		const cmdEnv = new Map<string, string>(exportedEnv);
		if (prefixAssignments) {
			for (const [name, value] of prefixAssignments) cmdEnv.set(name, value);
		}
		// Wrappers that run the rest of the line as a command.
		const unwrapped = unwrapCommandWrappers(all, cmdEnv, baseDir, depth, { unwrapXargs: true });
		if (!unwrapped.ok) return void found.push(unwrapped.reason);
		const words = unwrapped.words;
		if (words[0] === undefined) return;
		const dir = unwrapped.dir;
		depth = unwrapped.depth;
		const verb = basename(words[0]);
		const args = words.slice(1);

		if (PRIVILEGE.has(verb) || SYSTEM.has(verb)) return void found.push(reasons.system(verb));
		if (verb === "sysctl" && args.some((arg) => arg === "-w" || /^-\w*w/.test(arg) || (!arg.startsWith("-") && arg.includes("=")))) return void found.push(reasons.system("sysctl -w"));
		if (verb === "rsync") {
			const paths = positionals(args, new Set(["-e", "--rsh", "-f", "--filter", "--exclude", "--include", "-T", "--temp-dir"]));
			if (paths.some((path) => /^[^/]+:/.test(path))) return void found.push(reasons.system("rsync to another machine"));
			return paths.length >= 2 ? writes("rsync into", [paths.at(-1)!], dir) : undefined;
		}

		if (LOCAL_SHELLS.has(verb) || verb === "eval") {
			const script = verb === "eval" ? args.join(" ") : (() => {
				const flag = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
				return flag >= 0 ? args.slice(flag + 1).find((arg) => !arg.startsWith("-")) : undefined;
			})();
			if (script) run(script, depth + 1, cmdEnv, dir);
			return;
		}

		if (verb === "export" || ((verb === "declare" || verb === "typeset") && args.some((arg) => /^-[A-Za-z]*x[A-Za-z]*$/.test(arg)))) {
			const unexport = verb === "export" && args.some((arg) => /^-[A-Za-z]*n[A-Za-z]*$/.test(arg));
			let options = true;
			for (const arg of args) {
				if (options && arg === "--") {
					options = false;
					continue;
				}
				if (options && arg.startsWith("-")) continue;
				const eq = arg.indexOf("=");
				if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.slice(0, eq))) {
					const name = arg.slice(0, eq);
					const val = arg.slice(eq + 1);
					shellVars.set(name, val);
					if (unexport) exportedEnv.delete(name);
					else exportedEnv.set(name, val);
				} else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
					if (unexport) exportedEnv.delete(arg);
					else if (shellVars.has(arg)) exportedEnv.set(arg, shellVars.get(arg)!);
				}
			}
			return;
		}
		if (verb === "unset") {
			let options = true;
			for (const arg of args) {
				if (options && arg === "--") {
					options = false;
					continue;
				}
				if (options && arg.startsWith("-")) continue;
				shellVars.delete(arg);
				exportedEnv.delete(arg);
			}
			return;
		}

		if (verb === "cd" || verb === "pushd") {
			const dest = args.find((arg) => !arg.startsWith("-")) ?? "~";
			if (dest !== "-") effectiveCwd = at(effectiveCwd, dest);
			return;
		}

		if (verb === "git") {
			let gitCwd = dir;
			let gitDirOpt = cmdEnv.get("GIT_DIR");
			let workTreeOpt = cmdEnv.get("GIT_WORK_TREE");
			let i = 0;
			for (; i < args.length; i++) {
				const arg = args[i]!;
				if (arg === "-C") gitCwd = at(gitCwd, args[++i] ?? ".");
				else if (arg.startsWith("-C") && arg.length > 2) gitCwd = at(gitCwd, arg.slice(2));
				else if (arg === "--work-tree") workTreeOpt = args[++i];
				else if (arg.startsWith("--work-tree=")) workTreeOpt = arg.slice("--work-tree=".length);
				else if (arg === "--git-dir") gitDirOpt = args[++i];
				else if (arg.startsWith("--git-dir=")) gitDirOpt = arg.slice("--git-dir=".length);
				else if (arg === "-c") {
					const key = args[++i]?.split("=")[0];
					if (key && DANGEROUS_GIT_CONFIG_KEY.test(key)) return void found.push(reasons.system(`git -c ${key}`));
				} else if (arg.startsWith("-c") && arg.length > 2) {
					const key = arg.slice(2).split("=")[0];
					if (key && DANGEROUS_GIT_CONFIG_KEY.test(key)) return void found.push(reasons.system(`git -c ${key}`));
				} else if (arg === "--config-env") {
					const key = args[++i]?.split("=")[0];
					if (key && DANGEROUS_GIT_CONFIG_KEY.test(key)) return void found.push(reasons.system(`git --config-env ${key}`));
				} else if (arg.startsWith("--config-env=")) {
					const key = arg.slice("--config-env=".length).split("=")[0];
					if (key && DANGEROUS_GIT_CONFIG_KEY.test(key)) return void found.push(reasons.system(`git --config-env ${key}`));
				} else if (GIT_OPTIONS_WITH_VALUE.has(arg)) i++;
				else if (!arg.startsWith("-")) break;
			}
			const sub = args[i];
			const rest = args.slice(i + 1);
			if (sub === "config") {
				const parsed = parseGitConfig(rest);
				const key = dangerousGitConfig(parsed);
				if (key) return void found.push(reasons.system(`git config ${key}`));
				const mutation = gitConfigMutation(parsed);
				if (mutation) {
					const explicitFile = mutation.file ?? (mutation.scope === undefined ? cmdEnv.get("GIT_CONFIG") : undefined);
					if (explicitFile !== undefined) {
						const target = at(gitCwd, explicitFile);
						if (inCheckout(target)) return void found.push(reasons.checkout(`git config ${target}`));
					} else if (mutation.scope !== "global" && mutation.scope !== "system") {
						const targets: string[] = [];
						const resolvedGitDir = gitDirOpt !== undefined ? at(gitCwd, gitDirOpt) : undefined;
						if (resolvedGitDir !== undefined) {
							targets.push(resolvedGitDir);
							if (mutation.scope !== "worktree") {
								const common = gitCommonDirOf(resolvedGitDir);
								if (common) targets.push(common);
							}
						} else {
							targets.push(gitCwd);
							if (mutation.scope !== "worktree") {
								const common = gitCommonDirOf(gitCwd);
								if (common) targets.push(common);
							}
						}
						const hit = targets.find(inCheckout);
						if (hit) return void found.push(reasons.checkout(`git config in ${hit}`));
					}
				}
				return;
			}
			if (sub === "push" || sub === "send-email") return void found.push(reasons.remote(`git ${sub}`));
			if (sub !== undefined && mutatingGit(sub, rest)) {
				const resolvedGitDir = gitDirOpt !== undefined ? at(gitCwd, gitDirOpt) : undefined;
				const resolvedWorkTree = workTreeOpt !== undefined ? at(gitCwd, workTreeOpt) : undefined;
				const targets: string[] = [];
				if (resolvedGitDir !== undefined) targets.push(resolvedGitDir);
				if (resolvedWorkTree !== undefined) targets.push(resolvedWorkTree);
				if (resolvedGitDir === undefined || resolvedWorkTree === undefined) targets.push(gitCwd);
				if (sub === "remote") {
					const common = gitCommonDirOf(resolvedGitDir ?? gitCwd);
					if (common) targets.push(common);
				}
				const hit = targets.find(inCheckout);
				if (hit) found.push(reasons.checkout(`git ${sub} in ${hit}`));
			}
			return;
		}

		if (verb === "gh") return void ghReason(args, dir, inCheckout, found);

		if (verb === "npm" || verb === "pnpm" || verb === "yarn") {
			const words = positionals(args, new Set([...PACKAGE_DIR_OPTIONS, "--workspace", "-w", "--filter", "--registry", "--tag", "--otp"]));
			const sub = words[0] === "npm" && verb === "yarn" ? `npm ${words[1]}` : words[0];
			if (sub === "publish" || sub === "unpublish" || sub === "npm publish") return void found.push(reasons.remote(`${verb} ${sub}`));
			const global = args.some((arg) => arg === "-g" || arg === "--global" || arg === "--location=global") || words[0] === "global";
			const installs = !global && (sub === undefined ? verb === "yarn" : PACKAGE_INSTALLS[verb]!.has(sub));
			const target = optionValue(args, PACKAGE_DIR_OPTIONS);
			const where = target ? at(dir, target) : dir;
			if (installs && inCheckout(where)) found.push(reasons.checkout(`${verb} ${sub ?? "install"} in ${where}`));
			return;
		}
		if (verb === "cargo") {
			const sub = positionals(args, new Set(["-Z", "--config", "-C"]))[0];
			if (sub === "publish" || sub === "yank" || sub === "owner") found.push(reasons.remote(`cargo ${sub}`));
			return;
		}
		if ((verb === "docker" || verb === "podman") && (positionals(args).slice(0, 2).includes("push") || args.includes("--push"))) return void found.push(reasons.remote(`${verb} push`));

		if (verb === "sed" || verb === "perl") {
			const edit = inPlaceEdit(verb, args);
			if (edit) writes(`${verb} -i`, edit.length > 0 ? edit : ["."], dir);
			return;
		}
		if (verb === "find") {
			const roots = findRoots(args);
			if (args.includes("-delete")) writes("find -delete", roots, dir);
			for (let i = 0; i < args.length; i++) {
				const action = args[i]!;
				if (!["-exec", "-execdir", "-ok", "-okdir"].includes(action)) continue;
				const isExecDir = action === "-execdir" || action === "-okdir";
				const end = args.findIndex((arg, k) => k > i && (arg === ";" || arg === "+"));
				const template = args.slice(i + 1, end < 0 ? undefined : end);
				for (const root of roots) {
					if (isExecDir) {
						for (const { execDir, placeholder } of findExecDirTargets(root, dir)) {
							inspect(
								template.map((arg) => (arg === "{}" ? placeholder : arg.includes("{}") ? arg.replaceAll("{}", placeholder) : arg)),
								depth,
								cmdEnv,
								execDir,
							);
						}
					} else {
						const embedded = isExistingFile(at(dir, root)) ? root : join(root, "_");
						inspect(
							template.map((arg) => (arg === "{}" ? root : arg.includes("{}") ? arg.replaceAll("{}", embedded) : arg)),
							depth,
							cmdEnv,
							dir,
						);
					}
				}
				if (end < 0) break;
				i = end;
			}
			return;
		}
		if (verb === "patch") {
			const target = optionValue(args, ["-d", "--directory"]);
			const where = target ? at(dir, target) : dir;
			if (!args.includes("--dry-run") && inCheckout(where)) found.push(reasons.checkout(`patch in ${where}`));
			return;
		}
		const targets = fileTargets(verb, args);
		if (targets) writes(verb, targets.length > 0 ? targets : ["."], dir);
	};

	const run = (script: string, depth: number, nextEnv?: Map<string, string>, nextCwd?: string): void => {
		if (depth > MAX_NESTING_DEPTH) {
			found.push(reasons.nesting);
			return;
		}
		const savedCwd = effectiveCwd;
		const savedStdin = shellReadsStdin;
		const savedStdinEnv = stdinEnv;
		const savedStdinCwd = stdinCwd;
		const savedShellVars = new Map(shellVars);
		const savedExported = new Map(exportedEnv);
		if (nextCwd !== undefined) effectiveCwd = nextCwd;
		if (nextEnv) {
			shellVars = new Map(nextEnv);
			exportedEnv = new Map(nextEnv);
		}
		shellReadsStdin = false;
		stdinEnv = undefined;
		stdinCwd = undefined;
		try {
			visit(guardRuntime.parse(script), depth);
		} catch {
			found.push(reasons.analysis);
		}
		effectiveCwd = savedCwd;
		shellReadsStdin = savedStdin;
		stdinEnv = savedStdinEnv;
		stdinCwd = savedStdinCwd;
		shellVars = savedShellVars;
		exportedEnv = savedExported;
	};

	const visit = (node: SyntaxNode, depth: number): void => {
		const children = (): void => forEachChild(node, (child) => visit(child, depth));
		switch (node.type) {
			case "Script": {
				children();
				if (node.errors && node.errors.length > 0) found.push(reasons.analysis);
				return;
			}
			case "Subshell":
			case "CommandExpansion":
			case "ProcessSubstitution":
			case "ArithmeticCommandExpansion": {
				// They keep their `cd` and env changes to themselves.
				const savedCwd = effectiveCwd;
				const savedVars = new Map(shellVars);
				const savedExported = new Map(exportedEnv);
				children();
				effectiveCwd = savedCwd;
				shellVars = savedVars;
				exportedEnv = savedExported;
				return;
			}
			case "Pipeline": {
				// Every stage runs in its own subshell; a local shell in any stage reads the heredocs as a script.
				const saved = {
					cwd: effectiveCwd,
					shellReadsStdin,
					stdinEnv,
					stdinCwd,
					shellVars: new Map(shellVars),
					exportedEnv: new Map(exportedEnv),
				};
				for (const stage of node.commands) {
					const stageShell = shellCommandContext(stage, saved.exportedEnv, saved.cwd, depth);
					if (stageShell) {
						shellReadsStdin = true;
						stdinEnv = stageShell.env;
						stdinCwd = stageShell.cwd;
						break;
					}
				}
				for (const stage of node.commands) {
					effectiveCwd = saved.cwd;
					shellVars = new Map(saved.shellVars);
					exportedEnv = new Map(saved.exportedEnv);
					visit(stage, depth);
				}
				effectiveCwd = saved.cwd;
				shellReadsStdin = saved.shellReadsStdin;
				stdinEnv = saved.stdinEnv;
				stdinCwd = saved.stdinCwd;
				shellVars = saved.shellVars;
				exportedEnv = saved.exportedEnv;
				return;
			}
			case "Redirected": {
				// A compound command's redirections open before its body runs.
				const before = effectiveCwd;
				visit(node.command, depth);
				const after = effectiveCwd;
				effectiveCwd = before;
				for (const redirect of node.redirects) visit(redirect, depth);
				effectiveCwd = after;
				return;
			}
			case "Redirect": {
				const target = node.target?.value;
				if (!target || !WRITE_REDIRECTS.has(node.operator) || PSEUDO_DEVICE.test(target)) return;
				if (node.operator === ">&" && /^(?:\d+|-)$/.test(target)) return;
				writes(`a redirection to`, [target], effectiveCwd);
				return;
			}
			case "HereDoc":
			case "HereString": {
				children();
				const script = node.type === "HereDoc" ? node.body.text : node.target?.value;
				if (shellReadsStdin && script) run(script, depth + 1, stdinEnv, stdinCwd);
				return;
			}
			case "Command": {
				const savedStdin = shellReadsStdin;
				const savedStdinEnv = stdinEnv;
				const savedStdinCwd = stdinCwd;
				const stageShell = shellCommandContext(node, exportedEnv, effectiveCwd, depth);
				if (stageShell) {
					shellReadsStdin = true;
					stdinEnv = stageShell.env;
					stdinCwd = stageShell.cwd;
				}
				children();
				shellReadsStdin = savedStdin;
				stdinEnv = savedStdinEnv;
				stdinCwd = savedStdinCwd;
				const prefix = prefixEnv(node);
				if (node.name === undefined) {
					for (const [name, value] of prefix) {
						shellVars.set(name, value);
						if (exportedEnv.has(name)) exportedEnv.set(name, value);
					}
					return;
				}
				inspect(commandWords(node), depth, prefix);
				return;
			}
			default:
				children();
		}
	};

	run(command, 0);
	return found[0];
}

function assignmentValue(assignment: Assignment): string {
	return assignment.value.type === "Word" ? assignment.value.value : "";
}

function prefixEnv(command: Command): Map<string, string> {
	const env = new Map<string, string>();
	for (const item of command.prefix) {
		if (item.type === "Assignment") env.set(item.name, assignmentValue(item));
	}
	return env;
}

function commandWords(command: Command): string[] {
	const out: string[] = [];
	if (command.name?.type === "Word") out.push(command.name.value);
	for (const arg of command.args) {
		if (arg.type === "Word") out.push(arg.value);
		else if (arg.type === "Assignment") out.push(`${arg.name}=${assignmentValue(arg)}`);
	}
	return out;
}

const ENV_SIMPLE_ESCAPES: Record<string, string> = {
	"\\": "\\",
	'"': '"',
	"'": "'",
	t: "\t",
	n: "\n",
	r: "\r",
	f: "\f",
	v: "\v",
	$: "$",
	"#": "#",
	" ": " ",
	"\t": "\t",
};

/**
 * Splits an `env -S` / `--split-string` argument into tokens following GNU/BSD `env -S` quoting, escape, and
 * `${VARNAME}` expansion rules. Returns undefined on malformed or unterminated syntax so callers fail closed.
 */
function splitEnvString(input: string, env: Map<string, string>): string[] | undefined {
	const tokens: string[] = [];
	let current = "";
	let inToken = false;
	let quote: "'" | '"' | null = null;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (quote === "'") {
			if (ch === "'") {
				quote = null;
			} else if (ch === "\\") {
				if (i + 1 >= input.length) return undefined;
				const next = input[i + 1]!;
				if (next === "'" || next === "\\") {
					current += next;
					i++;
				} else {
					current += ch;
				}
			} else {
				current += ch;
			}
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = null;
			} else if (ch === "\\") {
				if (i + 1 >= input.length) return undefined;
				const next = input[++i]!;
				if (next === "_") current += " ";
				else if (Object.hasOwn(ENV_SIMPLE_ESCAPES, next)) current += ENV_SIMPLE_ESCAPES[next]!;
				else return undefined;
			} else if (ch === "$") {
				if (input[i + 1] !== "{") return undefined;
				const close = input.indexOf("}", i + 2);
				if (close < 0) return undefined;
				const name = input.slice(i + 2, close);
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
				current += env.has(name) ? env.get(name)! : `\${${name}}`;
				i = close;
			} else {
				current += ch;
			}
			continue;
		}
		if (/\s/.test(ch)) {
			if (inToken) {
				tokens.push(current);
				current = "";
				inToken = false;
			}
		} else if (ch === "#" && !inToken) {
			break;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inToken = true;
		} else if (ch === "\\") {
			if (i + 1 >= input.length) return undefined;
			const next = input[++i]!;
			if (next === "c") break;
			if (next === "_") {
				if (inToken) {
					tokens.push(current);
					current = "";
					inToken = false;
				}
			} else if (Object.hasOwn(ENV_SIMPLE_ESCAPES, next)) {
				current += ENV_SIMPLE_ESCAPES[next]!;
				inToken = true;
			} else {
				return undefined;
			}
		} else if (ch === "$") {
			if (input[i + 1] !== "{") return undefined;
			const close = input.indexOf("}", i + 2);
			if (close < 0) return undefined;
			const name = input.slice(i + 2, close);
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
			const value = env.has(name) ? env.get(name)! : `\${${name}}`;
			if (value.length > 0) {
				current += value;
				inToken = true;
			}
			i = close;
		} else {
			current += ch;
			inToken = true;
		}
	}

	if (quote !== null) return undefined;
	if (inToken) tokens.push(current);
	return tokens;
}

type UnwrapEnvResult = { ok: true; words: string[]; depth: number; chdir?: string } | { ok: false; reason: string };

/** Unwraps `env` options, `-S`/`--split-string` expansions (spliced with trailing args), and `NAME=VALUE` assignments. */
function unwrapEnv(allWords: string[], cmdEnv: Map<string, string>, depth: number): UnwrapEnvResult {
	let words = allWords.slice(1);
	let options = true;
	let currentDepth = depth;
	let chdir: string | undefined;
	// In GNU/BSD `env`, `-i` clears the utility's environment after option parsing while `-u` removes immediately.
	const lookupEnv = new Map(cmdEnv);

	for (let i = 0; i < words.length; i++) {
		const word = words[i]!;
		if (options) {
			if (word === "--") {
				options = false;
				continue;
			}
			if (word === "-" || word === "--ignore-environment") {
				cmdEnv.clear();
				continue;
			}
			if (word === "--chdir") {
				if (i + 1 >= words.length) return { ok: false, reason: reasons.analysis };
				chdir = words[++i]!;
				continue;
			}
			if (word.startsWith("--chdir=")) {
				chdir = word.slice("--chdir=".length);
				continue;
			}
			if (word === "--unset") {
				if (i + 1 >= words.length) return { ok: false, reason: reasons.analysis };
				const name = words[++i]!;
				cmdEnv.delete(name);
				lookupEnv.delete(name);
				continue;
			}
			if (word.startsWith("--unset=")) {
				const name = word.slice("--unset=".length);
				cmdEnv.delete(name);
				lookupEnv.delete(name);
				continue;
			}
			if (word === "--argv0") {
				if (i + 1 >= words.length) return { ok: false, reason: reasons.analysis };
				i++;
				continue;
			}
			if (word.startsWith("--argv0=")) {
				continue;
			}
			if (word === "--split-string" || word.startsWith("--split-string=")) {
				let raw: string;
				if (word === "--split-string") {
					if (i + 1 >= words.length) return { ok: false, reason: reasons.analysis };
					raw = words[++i]!;
				} else {
					raw = word.slice("--split-string=".length);
				}
				if (currentDepth + 1 > MAX_NESTING_DEPTH) return { ok: false, reason: reasons.nesting };
				const splitTokens = splitEnvString(raw, lookupEnv);
				if (splitTokens === undefined) return { ok: false, reason: reasons.analysis };
				currentDepth++;
				words = [...splitTokens, ...words.slice(i + 1)];
				i = -1;
				continue;
			}
			if (
				word === "--null"
				|| word === "--debug"
				|| word === "--list-signal-handling"
				|| word === "--help"
				|| word === "--version"
				|| word === "--block-signal"
				|| word.startsWith("--block-signal=")
				|| word === "--default-signal"
				|| word.startsWith("--default-signal=")
				|| word === "--ignore-signal"
				|| word.startsWith("--ignore-signal=")
			) {
				continue;
			}
			if (word.startsWith("--")) {
				return { ok: false, reason: reasons.analysis };
			}
			if (word.startsWith("-") && word.length > 1) {
				for (let k = 1; k < word.length; k++) {
					const flag = word[k]!;
					if (flag === "i") {
						cmdEnv.clear();
					} else if (flag === "0" || flag === "v") {
						continue;
					} else if (flag === "C") {
						const val = k + 1 < word.length ? word.slice(k + 1) : words[++i];
						if (val === undefined) return { ok: false, reason: reasons.analysis };
						chdir = val;
						break;
					} else if (flag === "u") {
						const val = k + 1 < word.length ? word.slice(k + 1) : words[++i];
						if (val === undefined) return { ok: false, reason: reasons.analysis };
						cmdEnv.delete(val);
						lookupEnv.delete(val);
						break;
					} else if (flag === "P" || flag === "a") {
						const val = k + 1 < word.length ? word.slice(k + 1) : words[++i];
						if (val === undefined) return { ok: false, reason: reasons.analysis };
						break;
					} else if (flag === "S") {
						const raw = k + 1 < word.length ? word.slice(k + 1) : words[++i];
						if (raw === undefined) return { ok: false, reason: reasons.analysis };
						if (currentDepth + 1 > MAX_NESTING_DEPTH) return { ok: false, reason: reasons.nesting };
						const splitTokens = splitEnvString(raw, lookupEnv);
						if (splitTokens === undefined) return { ok: false, reason: reasons.analysis };
						currentDepth++;
						words = [...splitTokens, ...words.slice(i + 1)];
						i = -1;
						break;
					} else {
						return { ok: false, reason: reasons.analysis };
					}
				}
				continue;
			}
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			options = false;
			const eq = word.indexOf("=");
			cmdEnv.set(word.slice(0, eq), word.slice(eq + 1));
			continue;
		}
		return { ok: true, words: words.slice(i), depth: currentDepth, chdir };
	}

	return { ok: true, words: [], depth: currentDepth, chdir };
}

type UnwrapExecResult = { ok: true; words: string[] } | { ok: false; reason: string };

/** Unwraps `exec` options (`-c`, `-l`, `-a <argv0>` / `-a<argv0>`, `--`), failing closed on malformed options. */
function unwrapExec(allWords: string[], cmdEnv: Map<string, string>): UnwrapExecResult {
	let i = 1;
	for (; i < allWords.length; i++) {
		const word = allWords[i]!;
		if (word === "--") {
			i++;
			break;
		}
		if (!word.startsWith("-") || word === "-") break;
		if (word.startsWith("--")) return { ok: false, reason: reasons.analysis };
		for (let k = 1; k < word.length; k++) {
			const flag = word[k]!;
			if (flag === "c") {
				cmdEnv.clear();
			} else if (flag === "l") {
				continue;
			} else if (flag === "a") {
				if (k + 1 < word.length) break;
				if (i + 1 >= allWords.length) return { ok: false, reason: reasons.analysis };
				i++;
				break;
			} else {
				return { ok: false, reason: reasons.analysis };
			}
		}
	}
	return { ok: true, words: allWords.slice(i) };
}

type UnwrapCommandWrappersResult = { ok: true; words: string[]; dir: string; depth: number } | { ok: false; reason: string };

function unwrapCommandWrappers(
	initialWords: string[],
	env: Map<string, string>,
	initialDir: string,
	initialDepth: number,
	options: { unwrapXargs?: boolean; unwrapSudo?: boolean } = {},
): UnwrapCommandWrappersResult {
	let words = initialWords;
	let dir = initialDir;
	let depth = initialDepth;
	for (;;) {
		const verb = words[0] === undefined ? undefined : basename(words[0]);
		if (verb === undefined) break;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
			const eq = words[0]!.indexOf("=");
			env.set(words[0]!.slice(0, eq), words[0]!.slice(eq + 1));
			words = words.slice(1);
		} else if (verb === "env") {
			const unwrapped = unwrapEnv(words, env, depth);
			if (!unwrapped.ok) return unwrapped;
			if (unwrapped.chdir !== undefined) dir = resolveFrom(dir, unwrapped.chdir);
			words = unwrapped.words;
			depth = unwrapped.depth;
		} else if (verb === "exec") {
			const unwrapped = unwrapExec(words, env);
			if (!unwrapped.ok) return unwrapped;
			words = unwrapped.words;
		} else if (verb === "command" || verb === "builtin" || verb === "nohup" || verb === "time") {
			words = words.slice(1);
			while (words[0]?.startsWith("-")) {
				const opt = words[0];
				words = words.slice(1);
				if (opt === "--") break;
			}
		} else if (verb === "nice" || verb === "timeout" || verb === "stdbuf" || (options.unwrapXargs && verb === "xargs")) {
			const withValue =
				verb === "nice"
					? ["-n"]
					: verb === "timeout"
						? ["-s", "-k", "--signal", "--kill-after"]
						: verb === "xargs"
							? ["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"]
							: ["-i", "-o", "-e"];
			let i = 1;
			while (i < words.length && words[i]!.startsWith("-")) i += withValue.includes(words[i]!) ? 2 : 1;
			if (verb === "timeout") i++;
			words = words.slice(i);
		} else if (options.unwrapSudo && verb === "sudo") {
			words = words.slice(1);
		} else {
			break;
		}
	}
	return { ok: true, words, dir, depth };
}

function shellCommandContext(
	node: SyntaxNode,
	baseEnv: Map<string, string>,
	baseCwd: string,
	initialDepth = 0,
): { env: Map<string, string>; cwd: string } | undefined {
	if (node.type !== "Command") return undefined;
	const env = new Map(baseEnv);
	for (const [name, value] of prefixEnv(node)) env.set(name, value);
	const unwrapped = unwrapCommandWrappers(commandWords(node), env, baseCwd, initialDepth, { unwrapSudo: true });
	if (!unwrapped.ok) return undefined;
	const first = unwrapped.words[0];
	return first !== undefined && LOCAL_SHELLS.has(basename(first)) ? { env, cwd: unwrapped.dir } : undefined;
}

function isExistingFile(path: string): boolean {
	try {
		return !statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function findRoots(args: string[]): string[] {
	const roots: string[] = [];
	let i = 0;
	while (i < args.length) {
		const arg = args[i]!;
		if (arg === "--") {
			i++;
			break;
		}
		if (arg === "-D") {
			i += 2;
			continue;
		}
		if (arg === "-f" && i + 1 < args.length) {
			roots.push(args[i + 1]!);
			i += 2;
			continue;
		}
		if (/^-[HLPEXdsx]+$/.test(arg) || /^-O\d+$/.test(arg)) {
			i++;
			continue;
		}
		break;
	}
	for (; i < args.length; i++) {
		const arg = args[i]!;
		if (arg.startsWith("-") || arg === "(" || arg === "!") break;
		roots.push(arg);
	}
	return roots.length > 0 ? roots : ["."];
}

type ParsedGitConfig = {
	readOnly: boolean;
	writeFlag: boolean;
	editFlag: boolean;
	sectionFlag: boolean;
	file?: string;
	scope?: "global" | "system" | "local" | "worktree";
	pos: string[];
};

function parseGitConfig(rest: string[]): ParsedGitConfig {
	let readOnly = false;
	let writeFlag = false;
	let editFlag = false;
	let sectionFlag = false;
	let file: string | undefined;
	let scope: "global" | "system" | "local" | "worktree" | undefined;
	const pos: string[] = [];
	let options = true;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		if (options && arg === "--") {
			options = false;
			continue;
		}
		if (options && arg.startsWith("-") && arg !== "-") {
			if (arg === "-f" || arg === "--file") file = rest[++i];
			else if (arg.startsWith("--file=")) file = arg.slice("--file=".length);
			else if (arg.startsWith("-f") && arg.length > 2) file = arg.slice(2);
			else if (arg === "--global") scope = "global";
			else if (arg === "--system") scope = "system";
			else if (arg === "--local") scope = "local";
			else if (arg === "--worktree") scope = "worktree";
			else if (arg === "-e" || arg === "--edit") editFlag = true;
			else if (GIT_CONFIG_READ_FLAGS.has(arg)) readOnly = true;
			else if (GIT_CONFIG_WRITE_FLAGS.has(arg)) writeFlag = true;
			else if (GIT_CONFIG_SECTION_FLAGS.has(arg)) sectionFlag = true;
			else if (GIT_CONFIG_OPTIONS_WITH_VALUE.has(arg)) i++;
			else if (/^-[A-Za-z]+$/.test(arg)) {
				if (arg.includes("e")) editFlag = true;
				if (arg.includes("l")) readOnly = true;
			}
			continue;
		}
		pos.push(arg);
	}
	return { readOnly, writeFlag, editFlag, sectionFlag, file, scope, pos };
}

function dangerousGitConfig(parsed: ParsedGitConfig): string | undefined {
	const { readOnly, writeFlag, sectionFlag, pos } = parsed;
	if (pos.length === 0) return undefined;

	const first = pos[0]!;
	if (!readOnly && !writeFlag && !sectionFlag) {
		if (first === "list" || first === "get") return undefined;
		if (first === "set" || first === "unset") {
			const key = pos[1];
			return key && DANGEROUS_GIT_CONFIG_KEY.test(key) ? key : undefined;
		}
		if (first === "remove-section" || first === "rename-section") {
			return pos.slice(1).find((section) => DANGEROUS_GIT_CONFIG_SECTION.test(section));
		}
	}

	if (readOnly && !writeFlag && !sectionFlag) return undefined;
	if (sectionFlag) return pos.find((section) => DANGEROUS_GIT_CONFIG_SECTION.test(section));
	const key = pos[0]!;
	if ((writeFlag || pos.length >= 2) && DANGEROUS_GIT_CONFIG_KEY.test(key)) return key;
	return undefined;
}

function gitConfigMutation(parsed: ParsedGitConfig): { file?: string; scope?: "global" | "system" | "local" | "worktree" } | undefined {
	const { readOnly, writeFlag, editFlag, sectionFlag, file, scope, pos } = parsed;
	if (writeFlag || editFlag || sectionFlag) return { file, scope };
	if (readOnly || pos.length === 0) return undefined;
	const first = pos[0]!;
	if (first === "list" || first === "get") return undefined;
	if (first === "set" || first === "unset" || first === "remove-section" || first === "rename-section" || first === "edit") {
		return { file, scope };
	}
	return pos.length >= 2 ? { file, scope } : undefined;
}

function mutatingGit(sub: string, rest: string[]): boolean {
	if (sub === "branch") {
		return rest.some((arg) => ["--delete", "--move", "--force", "--copy"].includes(arg) || (/^-[A-Za-z]+$/.test(arg) && /[dDmMfcC]/.test(arg)));
	}
	if (sub === "worktree") return rest[0] === "remove" || rest[0] === "move";
	if (sub === "symbolic-ref") return rest.includes("-d") || rest.includes("--delete") || positionals(rest, new Set(["-m"])).length >= 2;
	if (sub === "remote") return ["add", "rename", "remove", "rm", "set-head", "set-branches", "set-url", "prune"].includes(rest[0] ?? "");
	if (!MUTATING_GIT.has(sub)) return false;
	if (sub === "stash") return rest[0] !== "list" && rest[0] !== "show";
	if (sub === "tag") {
		const filters = ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"];
		const listing = rest.some((arg) => filters.includes(arg.split("=")[0]!)) || positionals(rest).length === 0;
		return !listing || rest.some((arg) => ["-d", "--delete", "-a", "-s", "-f", "-m", "-F"].includes(arg));
	}
	if (sub === "apply") return !rest.includes("--check") && !rest.includes("--stat") && !rest.includes("--numstat") && !rest.includes("--summary");
	if (sub === "clean" || sub === "add") return !rest.some((arg) => arg === "-n" || arg === "--dry-run" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("n")));
	return true;
}

function ghReason(args: string[], dir: string, inCheckout: (path: string) => boolean, found: string[]): void {
	const words = positionals(args, new Set(["-R", "--repo", "--hostname", "-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "-b", "--body", "--title", "-B", "--base", "-l", "--label", "-a", "--assignee"]));
	const [group, sub] = words;
	if (group === undefined) return;
	if (group === "api") return void (ghApiMutates(args) && found.push(reasons.remote("gh api with a mutating request")));
	if (group === "pr" && sub === "checkout" && inCheckout(dir)) return void found.push(reasons.checkout(`gh pr checkout in ${dir}`));
	const rule = GH_MUTATING[group];
	if (rule === undefined || sub === undefined) return;
	const mutates = rule instanceof Set ? rule.has(sub) : !rule.except.has(sub);
	if (mutates) found.push(reasons.remote(`gh ${group} ${sub}`));
}

/** `gh api` sends a non-GET request: an explicit method other than GET/HEAD, or fields/input (which make it POST), unless it is a GraphQL query. */
function ghApiMutates(args: string[]): boolean {
	const method = optionValue(args, ["-X", "--method"]);
	if (method !== undefined) return !["GET", "HEAD"].includes(method.toUpperCase());
	const fields: string[] = [];
	let input = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (["-f", "-F", "--field", "--raw-field"].includes(arg)) fields.push(args[++i] ?? "");
		else if (/^--(?:raw-)?field=/.test(arg)) fields.push(arg.slice(arg.indexOf("=") + 1));
		else if (/^-[fF]./.test(arg)) fields.push(arg.slice(2));
		else if (arg === "--input" || arg.startsWith("--input=")) input = true;
	}
	if (!input && fields.length === 0) return false;
	const endpoint = positionals(args, new Set(["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache"]))[1];
	return input || endpoint !== "graphql" || fields.some((field) => /\bmutation\b/.test(field));
}

function isSedBackupSuffix(next: string | undefined, hasMoreArgs: boolean): boolean {
	if (next === undefined) return false;
	if (next === "") return true;
	if (!hasMoreArgs) return false;
	if (!next.startsWith(".") || next === "." || next === "..") return false;
	return !next.includes("/") && !next.includes("\\");
}

/** The files `sed -i` / `perl -i` edit in place (empty: unknown, such as names read from stdin), or undefined without `-i`. */
function inPlaceEdit(verb: "sed" | "perl", args: string[]): string[] | undefined {
	let inPlace = false;
	let inlineScript = false;
	const files: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--") {
			files.push(...args.slice(i + 1));
			break;
		}
		if (verb === "sed" && (arg === "--in-place" || arg.startsWith("--in-place="))) inPlace = true;
		else if (verb === "sed" && (arg === "--expression" || arg === "--file")) {
			inlineScript = true;
			i++;
		} else if (verb === "sed" && (arg.startsWith("--expression=") || arg.startsWith("--file="))) {
			inlineScript = true;
		} else if (verb === "sed" && arg === "--line-length") {
			i++;
		} else if (arg.startsWith("--") || arg === "-") continue;
		else if (arg.startsWith("-")) {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k]!;
				if (letter === "i") {
					inPlace = true;
					// BSD sed takes the backup suffix as the next word (`sed -i '' …`, `sed -Ei .bak …`).
					if (verb === "sed" && k === arg.length - 1 && isSedBackupSuffix(args[i + 1], i + 2 < args.length)) i++;
					break;
				}
				if (letter === "e" || letter === "E" && verb === "perl" || verb === "sed" && letter === "f") {
					inlineScript = true;
					if (k === arg.length - 1) i++;
					break;
				}
				if (verb === "sed" && letter === "l" || verb === "perl" && "MmIdDxC".includes(letter)) {
					if (k === arg.length - 1 && verb === "sed") i++;
					break;
				}
			}
		} else files.push(arg);
	}
	if (!inPlace) return undefined;
	return inlineScript ? files : files.slice(1);
}

/** The paths a file-writing command writes or removes (empty: unknown, the current directory), or undefined for other commands. */
function fileTargets(verb: string, args: string[]): string[] | undefined {
	switch (verb) {
		case "rm":
		case "rmdir":
		case "unlink":
		case "tee":
			return positionals(args);
		case "mv": {
			const directory = optionValue(args, ["-t", "--target-directory"]);
			const paths = positionals(args, new Set(["-t", "--target-directory", "-S", "--suffix"]));
			return directory ? [...paths, directory] : paths;
		}
		case "mkdir":
			return positionals(args, new Set(["-m", "--mode"]));
		case "touch":
			return positionals(args, new Set(["-d", "-t", "-r", "--date", "--reference"]));
		case "truncate":
			return positionals(args, new Set(["-s", "--size", "-r", "--reference"]));
		case "chmod": {
			let hasReference = false;
			let sawMode = false;
			let options = true;
			const targets: string[] = [];
			for (let i = 0; i < args.length; i++) {
				const arg = args[i]!;
				if (options && arg === "--") {
					options = false;
					continue;
				}
				if (options && arg === "--reference") {
					hasReference = true;
					i++;
					continue;
				}
				if (options && arg.startsWith("--reference=")) {
					hasReference = true;
					continue;
				}
				if (options && arg.startsWith("--")) continue;
				if (options && arg.startsWith("-") && arg.length > 1) {
					if (!hasReference && !sawMode && /^-[rwxXstugo]+(?:,[augo]*[+-=][rwxXstugo]*)*$/.test(arg)) {
						sawMode = true;
						options = false;
					}
					continue;
				}
				if (!hasReference && !sawMode) {
					sawMode = true;
					continue;
				}
				targets.push(arg);
			}
			return targets;
		}
		case "cp":
		case "ln":
		case "install": {
			const directory = optionValue(args, ["-t", "--target-directory"]);
			if (directory) return [directory];
			const paths = positionals(args, new Set(["-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]));
			return paths.length >= 2 ? [paths.at(-1)!] : [];
		}
		case "dd": {
			const output = args.find((arg) => arg.startsWith("of="));
			return output ? [output.slice(3)] : undefined;
		}
		default:
			return undefined;
	}
}

// ---- Direct CLI automation tools (agent_browser, agent_desktop) ----

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
	"--output",
	"-o",
	"--out",
]);

const AGENT_BROWSER_WRITE_VALUE_FLAGS = new Set(["--profile", "--download-path", "--output", "-o", "--out"]);

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

const AGENT_DESKTOP_GLOBAL_VALUE_FLAGS = new Set([
	"--session",
	"-s",
	"--agent-id",
	"--trace",
	"--wait-for",
	"-w",
	"--wait-for-gone",
	"--wait-timeout",
	"--screenshot",
	"--output",
	"-o",
	"--out",
]);

const AGENT_DESKTOP_WRITE_VALUE_FLAGS = new Set(["--screenshot", "--trace", "--output", "-o", "--out"]);
const AGENT_DESKTOP_TRACE_OUT_FLAGS = new Set(["--out", "--output", "-o"]);

const AGENT_DESKTOP_SCREENSHOT_VALUE_FLAGS = new Set([
	"--app",
	"--window-id",
	"--screen",
	"--format",
	"--quality",
	"-q",
	"--region",
]);

const AGENT_DESKTOP_TRACE_VALUE_FLAGS = new Set(["--out", "--output", "-o", "--limit"]);

function extractEqualsFlagValue(token: string, flagNames: ReadonlySet<string>): string | undefined {
	const eq = token.indexOf("=");
	if (eq <= 0) return undefined;
	if (!flagNames.has(token.slice(0, eq))) return undefined;
	return token.slice(eq + 1);
}

function normalizeAgentDesktopCwd(rawCwd: unknown): string | undefined {
	if (typeof rawCwd !== "string") return undefined;
	const trimmed = rawCwd.trim();
	if (trimmed.length === 0 || trimmed.toLowerCase() === "none") return undefined;
	const stripped = trimmed.replace(/^@/, "").trim();
	if (stripped.length === 0 || stripped.toLowerCase() === "none") return undefined;
	return stripped;
}

type CliWriteArgvSpec = {
	globalValueFlags: ReadonlySet<string>;
	writeValueFlags: ReadonlySet<string>;
	subcommandValueFlags: Readonly<Record<string, ReadonlySet<string>>>;
	extraCaptureFlags?: Readonly<Record<string, ReadonlySet<string>>>;
};

type ScannedCliWriteArgv = {
	subcommand?: string;
	positionals: string[];
	rawTargets: string[];
	captured?: string;
	hasHelpOrVersion: boolean;
};

function scanCliWriteArgv(tokens: readonly string[], spec: CliWriteArgvSpec): ScannedCliWriteArgv {
	const rawTargets: string[] = [];
	let subcommand: string | undefined;
	let subcommandIndex = -1;
	let afterDoubleDash = false;
	let hasHelpOrVersion = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--") {
			afterDoubleDash = true;
			if (i + 1 < tokens.length) {
				subcommand = tokens[i + 1];
				subcommandIndex = i + 1;
			}
			break;
		}
		if (token === "--help" || token === "-h" || token === "--version" || token === "-V") {
			hasHelpOrVersion = true;
			continue;
		}
		const eqVal = extractEqualsFlagValue(token, spec.writeValueFlags);
		if (eqVal !== undefined) {
			if (eqVal.length > 0) rawTargets.push(eqVal);
			continue;
		}
		if (spec.writeValueFlags.has(token)) {
			const next = tokens[i + 1];
			if (typeof next === "string" && next.length > 0) rawTargets.push(next);
			i++;
			continue;
		}
		if (spec.globalValueFlags.has(token)) {
			i++;
			continue;
		}
		if (token.startsWith("-")) continue;
		subcommand = token;
		subcommandIndex = i;
		break;
	}

	const positionals: string[] = [];
	let captured: string | undefined;

	if (subcommand && !hasHelpOrVersion) {
		const rest = tokens.slice(subcommandIndex + 1);
		const valueFlags = Object.hasOwn(spec.subcommandValueFlags, subcommand)
			? spec.subcommandValueFlags[subcommand]!
			: undefined;
		const extraFlags = spec.extraCaptureFlags && Object.hasOwn(spec.extraCaptureFlags, subcommand)
			? spec.extraCaptureFlags[subcommand]!
			: undefined;

		if (afterDoubleDash) {
			positionals.push(...rest);
		} else {
			for (let i = 0; i < rest.length; i++) {
				const token = rest[i]!;
				if (token === "--") {
					positionals.push(...rest.slice(i + 1));
					break;
				}
				if (token === "--help" || token === "-h" || token === "--version" || token === "-V") {
					hasHelpOrVersion = true;
					continue;
				}
				if (extraFlags) {
					const eqExtra = extractEqualsFlagValue(token, extraFlags);
					if (eqExtra !== undefined) {
						if (eqExtra.length > 0) captured = eqExtra;
						continue;
					}
					if (extraFlags.has(token)) {
						const next = rest[i + 1];
						if (typeof next === "string" && next.length > 0) captured = next;
						i++;
						continue;
					}
				}
				const eqWrite = extractEqualsFlagValue(token, spec.writeValueFlags);
				if (eqWrite !== undefined) {
					if (eqWrite.length > 0) rawTargets.push(eqWrite);
					continue;
				}
				if (spec.writeValueFlags.has(token)) {
					const next = rest[i + 1];
					if (typeof next === "string" && next.length > 0) rawTargets.push(next);
					i++;
					continue;
				}
				if (spec.globalValueFlags.has(token) || valueFlags?.has(token)) {
					i++;
					continue;
				}
				if (token.startsWith("-")) continue;
				positionals.push(token);
			}
		}
	}

	return { subcommand, positionals, rawTargets, captured, hasHelpOrVersion };
}

/**
 * Extracts canonical file-writing target paths from an `agent_browser` CLI `argv` array relative to `cwd`.
 * Self-contained: never imports from `extensions/workspace/` or `extensions/agent-browser/`.
 */
function extractAgentBrowserWriteTargets(argv: readonly string[], cwd: string): string[] {
	const baseCwd = canonical(cwd);
	const { subcommand, positionals, rawTargets, hasHelpOrVersion } = scanCliWriteArgv(argv, {
		globalValueFlags: AGENT_BROWSER_GLOBAL_VALUE_FLAGS,
		writeValueFlags: AGENT_BROWSER_WRITE_VALUE_FLAGS,
		subcommandValueFlags: {
			screenshot: AGENT_BROWSER_SCREENSHOT_VALUE_FLAGS,
			pdf: AGENT_BROWSER_PDF_VALUE_FLAGS,
		},
	});

	if (subcommand && !hasHelpOrVersion) {
		if (subcommand === "screenshot" || subcommand === "pdf") {
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
			if ((positionals[0] === "start" || positionals[0] === "restart") && positionals[1]) {
				rawTargets.push(positionals[1]);
			}
		}
	}

	return [...new Set(rawTargets.map((target) => canonical(resolve(baseCwd, target))))];
}

/**
 * Extracts canonical file-writing target paths from an `agent_desktop` CLI `argv` array relative to `cwd`.
 * Read-only subcommands and non-file-writing GUI mutations (including `headed: true`) return an empty array.
 * Self-contained: never imports from `extensions/workspace/` or `extensions/agent-desktop/`.
 */
function extractAgentDesktopWriteTargets(argv: readonly string[], cwd: string): string[] {
	const baseCwd = canonical(cwd);
	const cleaned = argv.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0);
	const { subcommand, positionals, rawTargets, captured, hasHelpOrVersion } = scanCliWriteArgv(cleaned, {
		globalValueFlags: AGENT_DESKTOP_GLOBAL_VALUE_FLAGS,
		writeValueFlags: AGENT_DESKTOP_WRITE_VALUE_FLAGS,
		subcommandValueFlags: {
			screenshot: AGENT_DESKTOP_SCREENSHOT_VALUE_FLAGS,
			trace: AGENT_DESKTOP_TRACE_VALUE_FLAGS,
		},
		extraCaptureFlags: {
			trace: AGENT_DESKTOP_TRACE_OUT_FLAGS,
		},
	});

	if (subcommand && !hasHelpOrVersion) {
		if (subcommand === "screenshot") {
			if (positionals[0]) rawTargets.push(positionals[0]);
		} else if (subcommand === "trace" && positionals[0] === "export") {
			if (captured) {
				rawTargets.push(captured);
			} else {
				// `trace export` without `--out` writes `trace-<session>.html` in `cwd`.
				rawTargets.push(".");
			}
		}
	}

	return [...new Set(rawTargets.map((target) => canonical(resolve(baseCwd, target))))];
}
