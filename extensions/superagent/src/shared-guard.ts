// The guards of shared-workspace ticket sessions (src/hook.ts): git state commands in `bash`, the `write` guard, and
// `Agent` worktree isolation; see DESIGN.md "Shared workspace". A best-effort heuristic over the command string, not a
// sandbox: `bash` can still change files and git state in ways it does not recognise.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** git subcommands that change the index, HEAD, branches, tags, the stash, worktrees, or remotes. */
export const BLOCKED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"add", "commit", "checkout", "switch", "restore", "reset", "stash", "clean", "rebase", "merge", "cherry-pick", "revert",
	"am", "pull", "push", "rm", "mv", "worktree", "branch", "tag",
]);

/** git's global options that take a separate value (`-C <dir>`, `-c k=v`, ...). */
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--list-cmds", "--attr-source"]);
/** Commands that run their arguments as another command. */
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nohup", "nice", "xargs", "builtin", "stdbuf", "timeout"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Splits a command line into simple commands (on `;`, `&`, `|`, newlines, parentheses, `$(`, backticks) of words. */
export function shellCommands(command: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	const endWord = () => { if (inWord) words.push(word); word = ""; inWord = false; };
	const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (char === "\\") { word += command[index + 1] ?? ""; inWord = true; index++; continue; }
		if (char === "'") {
			const close = command.indexOf("'", index + 1);
			const end = close === -1 ? command.length : close;
			word += command.slice(index + 1, end);
			inWord = true;
			index = end;
			continue;
		}
		if (char === "\"") {
			let index2 = index + 1;
			for (; index2 < command.length && command[index2] !== "\""; index2++) {
				if (command[index2] === "\\" && index2 + 1 < command.length) { word += command[index2 + 1]; index2++; } else word += command[index2];
			}
			inWord = true;
			index = index2;
			continue;
		}
		if (char === "$" && command[index + 1] === "(") { endCommand(); index++; continue; }
		if (";&|\n()`{}".includes(char)) { endCommand(); continue; }
		if (/\s/.test(char)) { endWord(); continue; }
		word += char;
		inWord = true;
	}
	endCommand();
	return commands;
}

const isGit = (word: string) => word === "git" || word.endsWith("/git");

/** The subcommand and its arguments of a git invocation `args` (after `git`), skipping global options. */
function gitSubcommand(args: readonly string[]): { sub?: string; rest: string[] } {
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		if (GLOBAL_WITH_VALUE.has(arg)) { index += 2; continue; }
		if (arg.startsWith("-")) { index++; continue; }
		return { sub: arg, rest: args.slice(index + 1) };
	}
	return { rest: [] };
}

const LISTING_FLAGS = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--color", "--no-color", "--column", "--no-column", "-i", "--ignore-case", "--omit-empty", "-q", "--quiet"]);
const LISTING_WITH_VALUE = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);

/** `git branch`/`git tag` arguments that only list: no positional names unless after `--list`/`-l`. */
function listingOnly(sub: "branch" | "tag", args: readonly string[]): boolean {
	let listing = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--list" || arg === "-l") { listing = true; continue; }
		if (LISTING_FLAGS.has(arg)) continue;
		if (sub === "tag" && /^-n\d*$/.test(arg)) continue;
		if (LISTING_WITH_VALUE.has(arg)) { index++; continue; }
		if ([...LISTING_WITH_VALUE].some((flag) => arg.startsWith(`${flag}=`)) || arg.startsWith("--color=") || arg.startsWith("--column=")) continue;
		if (!arg.startsWith("-") && listing) continue;
		return false;
	}
	return true;
}

/** The git state commands a command line runs, as `git <sub>`; empty when it runs none (as far as the parse sees). */
export function blockedGitCommands(command: string, depth = 0): string[] {
	const found: string[] = [];
	for (const words of shellCommands(command)) {
		let index = 0;
		// Leading variable assignments and wrappers (`FOO=1 sudo git ...`).
		while (index < words.length) {
			const word = words[index]!;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { index++; continue; }
			if (WRAPPERS.has(word)) { index++; while (index < words.length && (words[index]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!) || /^\d+[smhd]?$/.test(words[index]!))) index++; continue; }
			break;
		}
		const head = words[index];
		if (head === undefined) continue;
		if (SHELLS.has(head.split("/").at(-1)!) && depth < 3) {
			const flag = words.indexOf("-c", index + 1);
			if (flag !== -1 && words[flag + 1] !== undefined) found.push(...blockedGitCommands(words[flag + 1]!, depth + 1));
			continue;
		}
		if (!isGit(head)) continue;
		const { sub, rest } = gitSubcommand(words.slice(index + 1));
		if (!sub || !BLOCKED_GIT_SUBCOMMANDS.has(sub)) continue;
		if ((sub === "branch" || sub === "tag") && listingOnly(sub, rest)) continue;
		if (sub === "worktree" && rest[0] === "list") continue;
		found.push(`git ${sub}`);
	}
	return found;
}

export const gitBlockReason = (commands: readonly string[]) =>
	`${[...new Set(commands)].join(", ")} is blocked in a shared-workspace ticket: the working tree is shared with other tickets and the user, so your changes must stay uncommitted and git state (index, HEAD, branches, tags, stash, worktrees, remotes) must not change. Read-only git such as \`git status\`, \`git diff\`, and \`git log\` works.`;

export const writeBlockReason = (path: string) =>
	`write to ${path} is blocked: the file changed since you last read it, or you never read it; another ticket or the user may have edited it. Read it again and use \`edit\`.`;

export const AGENT_ISOLATION_BLOCK_REASON =
	"Agent with isolation \"worktree\" is not available in a shared-workspace ticket: delegates work in the shared working tree too. Run it without isolation.";

export const overlapNote = (ticketId: number, path: string) => `Note: ticket #${ticketId} also changed ${path}; make sure you are not undoing its change.`;

/** A tool's `path` argument as an absolute path, as Pi's file tools resolve it (`@` prefix, `~`). */
export function toolPath(path: string, cwd: string): string {
	let value = path.startsWith("@") ? path.slice(1) : path;
	if (value === "~") value = homedir();
	else if (value.startsWith("~/")) value = resolve(homedir(), value.slice(2));
	return canonical(resolve(cwd, value));
}

/** The real path, or (for a file not created yet) its parent's real path joined with its name. */
export function canonical(path: string): string {
	try { return realpathSync(path); } catch {}
	try { return join(realpathSync(dirname(path)), basename(path)); } catch {}
	return path;
}

/** `absolute` relative to `root`, or undefined when it is outside. */
export function repoRelative(root: string, absolute: string): string | undefined {
	const rel = relative(root, absolute);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split("\\").join("/");
}
