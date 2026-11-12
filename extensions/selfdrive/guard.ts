// selfdrive's guard: while any standing grant exists in this process, refuse the tool calls that would deliver a Herder
// run, edit the user's checkout, push or publish, or need privileges, another machine, or system settings. It runs in
// every session of the process (subagent and Herder children load this extension in-process too). It is a heuristic that
// prevents accidents, not a sandbox: a determined command can get past it.
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { forEachChild, parse, type Command, type SyntaxNode, type Word } from "unbash";
import { grants, type StandingApproval } from "./grants.ts";

const BLOCKED = "Blocked by self-driving mode:";
export const reasons = {
	deliver: `${BLOCKED} delivery waits for your user; record the run as proposed (selfdrive_task with its Herder run id).`,
	checkout: (what: string) =>
		`${BLOCKED} ${what} would change your user's checkout. Make the change through a Herder run or in a worktree under .pi/workspaces/.`,
	remote: (what: string) =>
		`${BLOCKED} ${what} leaves this machine, and that waits for your user. Leave the work in a verified Herder run and record it as proposed.`,
	system: (what: string) =>
		`${BLOCKED} ${what} needs privileges or another machine, or changes system settings. Record what is needed as a question for your user (selfdrive_task with needs).`,
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
	if (toolName === "write" || toolName === "edit") {
		const raw = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
		const target = raw?.trim() ? resolveToolPath(raw, cwd) : undefined;
		return target && insideCheckout(target, toplevels) ? reasons.checkout(`${toolName} ${target}`) : undefined;
	}
	if (toolName === "bash" && typeof args.command === "string" && args.command.trim()) return bashBlockReason(args.command, cwd, toplevels);
	if (toolName === "process_start" && typeof args.command === "string" && args.command.trim()) {
		// The process runs in `cwd` relative to the session's, resolved the way the processes extension resolves it.
		const dir = typeof args.cwd === "string" ? resolve(cwd, args.cwd.replace(/^@/, "")) : cwd;
		return bashBlockReason(args.command, dir, toplevels);
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
export function resolveToolPath(raw: string, cwd: string): string | undefined {
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

/**
 * True when the canonical `path` is in a grant's checkout: inside its top level, but not under its `.git/` (Herder's
 * worktrees live there) or `.pi/` (workspaces), and not in another git worktree checked out inside it.
 */
export function insideCheckout(path: string, toplevels: string[]): boolean {
	return toplevels.some((toplevel) => {
		const rel = within(toplevel, path);
		if (rel === undefined) return false;
		const first = rel.split(sep)[0];
		return first !== ".git" && first !== ".pi" && !inLinkedWorktree(toplevel, path);
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
export function bashBlockReason(command: string, cwd: string, toplevels: string[]): string | undefined {
	const found: string[] = [];
	const inCheckout = (path: string): boolean => insideCheckout(path, toplevels);
	const at = (dir: string, word: string): string => canonical(resolve(dir, expandHome(word)));
	let effectiveCwd = canonical(cwd);
	let shellReadsStdin = false;

	const writes = (what: string, targets: string[], dir: string): void => {
		const hit = targets.map((target) => at(dir, target)).find(inCheckout);
		if (hit) found.push(reasons.checkout(`${what} ${hit}`));
	};

	const inspect = (all: string[], depth: number): void => {
		let words = all;
		let dir = effectiveCwd;
		// Wrappers that run the rest of the line as a command.
		for (;;) {
			const verb = words[0] === undefined ? undefined : basename(words[0]);
			if (verb === undefined) return;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
			else if (verb === "env") {
				let i = 1;
				for (; i < words.length; i++) {
					const word = words[i]!;
					if (word === "-C" || word === "--chdir") dir = at(dir, words[++i] ?? ".");
					else if (word.startsWith("--chdir=")) dir = at(dir, word.slice("--chdir=".length));
					else if (word === "-u" || word === "--unset" || word === "-S") i++;
					else if (!word.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) break;
				}
				words = words.slice(i);
			} else if (verb === "command" || verb === "builtin" || verb === "exec" || verb === "nohup" || verb === "time") {
				words = words.slice(1);
				while (words[0]?.startsWith("-")) words = words.slice(1);
			} else if (verb === "nice" || verb === "timeout" || verb === "xargs" || verb === "stdbuf") {
				const withValue = verb === "nice" ? ["-n"] : verb === "timeout" ? ["-s", "-k", "--signal", "--kill-after"] : verb === "xargs" ? ["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"] : ["-i", "-o", "-e"];
				let i = 1;
				while (i < words.length && words[i]!.startsWith("-")) i += withValue.includes(words[i]!) ? 2 : 1;
				if (verb === "timeout") i++;
				words = words.slice(i);
			} else break;
		}
		const verb = basename(words[0]!);
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
			if (script && depth < 8) run(script, depth + 1);
			return;
		}

		if (verb === "cd" || verb === "pushd") {
			const dest = args.find((arg) => !arg.startsWith("-")) ?? "~";
			if (dest !== "-") effectiveCwd = at(effectiveCwd, dest);
			return;
		}

		if (verb === "git") {
			let gitDir = dir;
			let i = 0;
			for (; i < args.length; i++) {
				const arg = args[i]!;
				if (arg === "-C" || arg === "--work-tree") gitDir = at(gitDir, args[++i] ?? ".");
				else if (arg.startsWith("--work-tree=")) gitDir = at(gitDir, arg.slice("--work-tree=".length));
				else if (GIT_OPTIONS_WITH_VALUE.has(arg)) i++;
				else if (!arg.startsWith("-")) break;
			}
			const sub = args[i];
			const rest = args.slice(i + 1);
			if (sub === "push" || sub === "send-email") return void found.push(reasons.remote(`git ${sub}`));
			if (sub !== undefined && mutatingGit(sub, rest) && inCheckout(gitDir)) found.push(reasons.checkout(`git ${sub} in ${gitDir}`));
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
			const start = args.findIndex((arg) => arg.startsWith("-") || arg === "(" || arg === "!");
			const roots = (start < 0 ? args : args.slice(0, start));
			const root = roots[0] ?? ".";
			if (args.includes("-delete")) writes("find -delete", roots.length > 0 ? roots : ["."], dir);
			for (let i = 0; i < args.length; i++) {
				if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]!)) continue;
				const end = args.findIndex((arg, k) => k > i && (arg === ";" || arg === "+"));
				inspect(args.slice(i + 1, end < 0 ? undefined : end).map((arg) => (arg === "{}" ? root : arg)), depth);
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

	const run = (script: string, depth: number): void => {
		const savedCwd = effectiveCwd;
		const savedStdin = shellReadsStdin;
		shellReadsStdin = false;
		try {
			visit(parse(script), depth);
		} catch {
			// unbash reports syntax errors in the tree rather than throwing; keep what was found.
		}
		effectiveCwd = savedCwd;
		shellReadsStdin = savedStdin;
	};

	const visit = (node: SyntaxNode, depth: number): void => {
		const children = (): void => forEachChild(node, (child) => visit(child, depth));
		switch (node.type) {
			case "Subshell":
			case "CommandExpansion":
			case "ProcessSubstitution":
			case "ArithmeticCommandExpansion": {
				// They keep their `cd` to themselves.
				const saved = effectiveCwd;
				children();
				effectiveCwd = saved;
				return;
			}
			case "Pipeline": {
				// Every stage runs in its own subshell; a local shell in any stage reads the heredocs as a script.
				const saved = { cwd: effectiveCwd, shellReadsStdin };
				shellReadsStdin ||= node.commands.some(isLocalShell);
				for (const stage of node.commands) {
					effectiveCwd = saved.cwd;
					visit(stage, depth);
				}
				effectiveCwd = saved.cwd;
				shellReadsStdin = saved.shellReadsStdin;
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
				if (shellReadsStdin && script && depth < 8) run(script, depth + 1);
				return;
			}
			case "Command": {
				const saved = shellReadsStdin;
				shellReadsStdin ||= isLocalShell(node);
				children();
				shellReadsStdin = saved;
				inspect(commandWords(node), depth);
				return;
			}
			default:
				children();
		}
	};

	run(command, 0);
	return found[0];
}

function commandWords(command: Command): string[] {
	return [command.name, ...command.args].filter((arg): arg is Word => arg?.type === "Word").map((word) => word.value);
}

function isLocalShell(node: SyntaxNode): boolean {
	if (node.type !== "Command") return false;
	const words = commandWords(node).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && word !== "sudo" && word !== "env" && word !== "command" && word !== "exec");
	return words[0] !== undefined && LOCAL_SHELLS.has(basename(words[0]));
}

function mutatingGit(sub: string, rest: string[]): boolean {
	if (sub === "branch") {
		return rest.some((arg) => ["--delete", "--move", "--force", "--copy"].includes(arg) || (/^-[A-Za-z]+$/.test(arg) && /[dDmMfcC]/.test(arg)));
	}
	if (sub === "worktree") return rest[0] === "remove" || rest[0] === "move";
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
		} else if (arg.startsWith("--") || arg === "-") continue;
		else if (arg.startsWith("-")) {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k]!;
				if (letter === "i") {
					inPlace = true;
					// BSD sed takes the backup suffix as the next word (`sed -i '' …`).
					if (verb === "sed" && arg === "-i" && (args[i + 1] === "" || args[i + 1]?.startsWith("."))) i++;
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
		case "mv":
		case "tee":
			return positionals(args);
		case "mkdir":
			return positionals(args, new Set(["-m", "--mode"]));
		case "touch":
			return positionals(args, new Set(["-d", "-t", "-r", "--date", "--reference"]));
		case "truncate":
			return positionals(args, new Set(["-s", "--size", "-r", "--reference"]));
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
