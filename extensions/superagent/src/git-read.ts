// The `git_read` policy of DESIGN.md "Tools in superagent mode": read-only git in the main checkout.
import { spawn } from "node:child_process";
import { gitEnv } from "./git.ts";

export const GIT_READ_SUBCOMMANDS: readonly string[] = [
	"status", "diff", "log", "show", "blame", "shortlog", "branch", "tag", "rev-parse", "ls-files", "grep", "describe", "merge-base", "worktree",
];
export const GIT_READ_MAX_BYTES = 50 * 1024;
export const GIT_READ_TIMEOUT_MS = 15_000;

const SUBCOMMANDS = new Set(GIT_READ_SUBCOMMANDS);
const DIFF_LIKE = new Set(["diff", "show", "log"]);
const NO_EXTERNAL = ["--no-ext-diff", "--no-textconv"];
const REFUSED_PREFIXES = ["--output", "--exec", "-c", "--config", "--git-dir", "--work-tree", "-C"];
const WORKTREE_LIST_OPTIONS = new Set(["--porcelain", "-z", "-v", "--verbose"]);
/** Listing flags without a value. */
const LIST_FLAGS: Record<"branch" | "tag", ReadonlySet<string>> = {
	branch: new Set(["--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "-i", "--ignore-case", "--no-color"]),
	tag: new Set(["--list", "-l", "-n", "-i", "--ignore-case", "--no-color"]),
};
/** Listing options that take a value, as `--opt=value` or `--opt value`. */
const LIST_VALUE_OPTIONS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"]);

export type GitReadCheck = { ok: true; args: string[] } | { ok: false; reason: string };

const refuse = (reason: string): GitReadCheck => ({ ok: false, reason });

function checkListing(sub: "branch" | "tag", rest: string[]): string | undefined {
	let listing = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] as string;
		if (arg === "--list" || arg === "-l") listing = true;
		if (LIST_FLAGS[sub].has(arg)) continue;
		if (sub === "tag" && /^-n[0-9]+$/.test(arg)) continue;
		const eq = arg.indexOf("=");
		const name = eq > 0 ? arg.slice(0, eq) : arg;
		if (LIST_VALUE_OPTIONS.has(name)) {
			if (eq > 0) continue;
			const value = rest[i + 1];
			if (value === undefined || value.startsWith("-")) {
				if (name === "--sort" || name === "--format" || name === "--points-at") return `git ${sub} ${name} needs a value.`;
				continue;
			}
			i++;
			continue;
		}
		if (arg.startsWith("-")) return `git ${sub} ${arg} is not a listing option; only listing is allowed.`;
		if (!listing) return `git ${sub} ${arg} would create or change a ${sub}; only listing is allowed (use --list <pattern>).`;
	}
	return undefined;
}

/** Checks `args` (without `git`) against the policy and returns the argv to run, starting with `--no-pager`. */
export function checkGitReadArgs(args: string[]): GitReadCheck {
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return refuse("args must be an array of strings.");
	if (args.length === 0) return refuse('Give a git subcommand, for example ["status"].');
	for (const arg of args) {
		if (arg.includes("\0")) return refuse("Arguments must not contain NUL characters.");
		const prefix = REFUSED_PREFIXES.find((p) => arg.startsWith(p));
		if (prefix) return refuse(`The argument ${JSON.stringify(arg)} is refused: arguments starting with ${prefix} are not allowed.`);
	}
	const [sub, ...rest] = args as [string, ...string[]];
	if (!SUBCOMMANDS.has(sub)) {
		return refuse(`git ${sub} is not allowed; use one of ${GIT_READ_SUBCOMMANDS.filter((s) => s !== "worktree").join(", ")}, or worktree list.`);
	}
	if (sub === "worktree") {
		if (rest[0] !== "list") return refuse("Only git worktree list is allowed.");
		const bad = rest.slice(1).find((arg) => !WORKTREE_LIST_OPTIONS.has(arg));
		if (bad !== undefined) return refuse(`git worktree list ${bad} is not allowed.`);
		return { ok: true, args: ["--no-pager", ...args] };
	}
	if (sub === "branch" || sub === "tag") {
		const reason = checkListing(sub, rest);
		if (reason) return refuse(reason);
	}
	if (DIFF_LIKE.has(sub)) {
		const bad = rest.find((arg) => arg === "--ext-diff" || arg === "--textconv");
		if (bad) return refuse(`git ${sub} ${bad} is not allowed.`);
	}
	if (sub === "grep") {
		// -O / --open-files-in-pager runs a program.
		const bad = rest.find((arg) => arg.startsWith("-O") || arg.startsWith("--open-files-in-pager"));
		if (bad) return refuse(`git grep ${bad} is not allowed.`);
	}
	return { ok: true, args: ["--no-pager", sub, ...(DIFF_LIKE.has(sub) ? NO_EXTERNAL : []), ...rest] };
}

/**
 * Runs an allowed git command in `cwd`: stdout and stderr together, cut to 50 KB with a note, 15 s timeout.
 * Throws with the policy's reason for a refused command.
 */
export function runGitRead(cwd: string, args: string[]): Promise<{ output: string; exitCode: number; truncated: boolean }> {
	const checked = checkGitReadArgs(args);
	if (!checked.ok) return Promise.reject(new Error(checked.reason));
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;
		const child = spawn("git", checked.args, {
			cwd,
			env: { ...gitEnv(), GIT_OPTIONAL_LOCKS: "0" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const take = (chunk: Buffer) => {
			if (truncated) return;
			const room = GIT_READ_MAX_BYTES - size;
			if (chunk.length > room) {
				chunks.push(chunk.subarray(0, room));
				size = GIT_READ_MAX_BYTES;
				truncated = true;
				child.kill("SIGKILL");
				return;
			}
			chunks.push(chunk);
			size += chunk.length;
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, GIT_READ_TIMEOUT_MS);
		const finish = (exitCode: number, extra?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			let output = Buffer.concat(chunks).toString("utf8");
			if (truncated) output += `\n[output truncated at ${GIT_READ_MAX_BYTES / 1024} KB]`;
			if (timedOut) output += `\n[git timed out after ${GIT_READ_TIMEOUT_MS / 1000} s]`;
			if (extra) output += `${output ? "\n" : ""}${extra}`;
			resolve({ output, exitCode, truncated });
		};
		child.on("error", (error) => finish(-1, `git could not run: ${error.message}`));
		child.on("close", (code) => {
			if (code !== null) return finish(code);
			// Killed: by the output cap (not a failure), or by the timeout.
			finish(truncated && !timedOut ? 0 : 124);
		});
	});
}
