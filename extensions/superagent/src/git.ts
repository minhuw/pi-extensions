// Git operations of superagent: execFile (no shell), no ambient GIT_* variables, GIT_TERMINAL_PROMPT=0, and timeouts.
import { type ExecFileException, execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { FastForwardOutcome, Git, RebaseOutcome, Repo } from "./types.ts";

export const GIT_TIMEOUT_MS = 15_000;
/** For worktree add, rebase, and merge. */
export const GIT_LONG_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** A git command failed; the message includes git's stderr. */
export class GitError extends Error {
	readonly args: string[];
	/** Exit code; null when git did not exit normally (timeout, signal, spawn failure). */
	readonly exitCode: number | null;
	readonly stderr: string;
	constructor(args: string[], exitCode: number | null, stderr: string, detail?: string) {
		super(`git ${args.join(" ")} failed (${detail ?? `exit ${exitCode}`})${stderr ? `: ${stderr}` : ""}`);
		this.name = "GitError";
		this.args = args;
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

/** The process environment without any GIT_* variable (they would redirect or reconfigure git), and no prompts. */
export function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface RunOptions {
	timeout?: number;
	/** Nonzero exit codes that are answers rather than failures. */
	ok?: number[];
}

function run(cwd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
	const timeout = options.timeout ?? GIT_TIMEOUT_MS;
	return new Promise((resolvePromise, reject) => {
		execFile(
			"git",
			args,
			{ cwd, env: { ...gitEnv(), LC_ALL: "C" }, timeout, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER, encoding: "utf8" },
			(error: ExecFileException | null, stdout: string, stderr: string) => {
				const err = stderr.trim();
				if (!error) return resolvePromise({ code: 0, stdout, stderr: err });
				if (typeof error.code === "number") {
					if (options.ok?.includes(error.code)) return resolvePromise({ code: error.code, stdout, stderr: err });
					return reject(new GitError(args, error.code, err));
				}
				if (error.killed) return reject(new GitError(args, null, err, `timed out after ${timeout / 1000} s`));
				if (error.signal) return reject(new GitError(args, null, err, `killed by ${error.signal}`));
				reject(new GitError(args, null, err, error.message));
			},
		);
	});
}

/** Refs and paths come from superagent itself, but one starting with `-` would be read as an option. */
function arg(value: string, what: string): string {
	if (!value || value.startsWith("-")) throw new Error(`superagent: invalid ${what} ${JSON.stringify(value)}`);
	return value;
}

const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

async function isAncestorIn(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
	const result = await run(cwd, ["merge-base", "--is-ancestor", arg(ancestor, "commit"), arg(descendant, "commit")], { ok: [1] });
	return result.code === 0;
}

async function rebaseInProgress(worktree: string): Promise<boolean> {
	const result = await run(worktree, ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"]);
	return lines(result.stdout).some((path) => existsSync(resolve(worktree, path)));
}

function samePath(a: string, b: string): boolean {
	const real = (path: string) => {
		try {
			return realpathSync(path);
		} catch {
			return resolve(path);
		}
	};
	return resolve(a) === resolve(b) || real(a) === real(b);
}

async function isRegisteredWorktree(repo: Repo, path: string): Promise<boolean> {
	const result = await run(repo.topLevel, ["worktree", "list", "--porcelain"]);
	return lines(result.stdout).some((line) => line.startsWith("worktree ") && samePath(line.slice("worktree ".length), path));
}

export function createGit(): Git {
	const branchExists = async (repo: Repo, branch: string): Promise<boolean> => {
		const result = await run(repo.topLevel, ["show-ref", "--verify", "--quiet", `refs/heads/${arg(branch, "branch")}`], { ok: [1] });
		return result.code === 0;
	};

	return {
		async open(cwd: string): Promise<Repo | undefined> {
			let out: RunResult;
			try {
				out = await run(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
				await run(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
			} catch {
				return undefined;
			}
			const [topLevel, commonDir] = lines(out.stdout);
			if (!topLevel || !commonDir) return undefined;
			try {
				return { topLevel: realpathSync(topLevel), commonDir: realpathSync(commonDir) };
			} catch {
				return undefined;
			}
		},

		async branch(cwd: string): Promise<string | undefined> {
			const result = await run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: [1] });
			const name = result.stdout.trim();
			return result.code === 0 && name ? name : undefined;
		},

		async revParse(cwd: string, ref = "HEAD"): Promise<string> {
			const result = await run(cwd, ["rev-parse", "--verify", `${arg(ref, "ref")}^{commit}`]);
			return result.stdout.trim();
		},

		branchExists,

		async addWorktree(repo: Repo, path: string, branch: string, base: string): Promise<void> {
			await run(repo.topLevel, ["worktree", "add", "-b", arg(branch, "branch"), arg(path, "path"), arg(base, "commit")], {
				timeout: GIT_LONG_TIMEOUT_MS,
			});
		},

		async removeWorktree(repo: Repo, path: string): Promise<void> {
			// Never the main checkout (a shared ticket's "worktree").
			if (samePath(path, repo.topLevel)) throw new Error(`superagent: refusing to remove the main checkout ${path}`);
			try {
				await run(repo.topLevel, ["worktree", "remove", "--force", "--force", arg(path, "path")], { timeout: GIT_LONG_TIMEOUT_MS });
			} catch (error) {
				// Already gone (or its directory deleted by hand): pruning drops the registration.
				await run(repo.topLevel, ["worktree", "prune"]);
				if (await isRegisteredWorktree(repo, path)) throw error;
			}
			await run(repo.topLevel, ["worktree", "prune"]);
		},

		async deleteBranch(repo: Repo, branch: string, force = false): Promise<void> {
			if (!(await branchExists(repo, branch))) return;
			const current = await run(repo.topLevel, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: [1] });
			if (current.code === 0 && current.stdout.trim() === branch) throw new Error(`superagent: refusing to delete ${branch}, the main checkout's branch`);
			await run(repo.topLevel, ["branch", force ? "-D" : "-d", branch]);
		},

		async isClean(cwd: string): Promise<boolean> {
			const result = await run(cwd, ["status", "--porcelain"]);
			return result.stdout.trim() === "";
		},

		async status(cwd: string): Promise<string[]> {
			const result = await run(cwd, ["-c", "core.quotePath=false", "status", "--porcelain"]);
			return lines(result.stdout);
		},

		async aheadBehind(repo: Repo, branch: string, target: string): Promise<{ ahead: number; behind: number }> {
			const result = await run(repo.topLevel, ["rev-list", "--left-right", "--count", `${arg(branch, "branch")}...${arg(target, "target")}`]);
			const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
			if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
				throw new GitError(["rev-list", "--left-right", "--count", `${branch}...${target}`], 0, `unexpected output ${JSON.stringify(result.stdout)}`);
			}
			return { ahead: ahead as number, behind: behind as number };
		},

		isAncestor(repo: Repo, ancestor: string, descendant: string): Promise<boolean> {
			return isAncestorIn(repo.topLevel, ancestor, descendant);
		},

		async changedFiles(repo: Repo, branch: string, target: string): Promise<string[]> {
			const result = await run(repo.topLevel, [
				"-c",
				"core.quotePath=false",
				"diff",
				"--name-status",
				"--no-color",
				"--no-ext-diff",
				"--no-textconv",
				`${arg(target, "target")}...${arg(branch, "branch")}`,
			]);
			return lines(result.stdout);
		},

		async rebase(worktree: string, onto: string): Promise<RebaseOutcome> {
			if (await isAncestorIn(worktree, onto, "HEAD")) return { ok: true, rebased: false };
			try {
				await run(worktree, ["rebase", "--no-autostash", arg(onto, "commit")], { timeout: GIT_LONG_TIMEOUT_MS });
				return { ok: true, rebased: true };
			} catch (error) {
				if (!(await rebaseInProgress(worktree))) throw error;
				const unmerged = await run(worktree, ["diff", "--name-only", "--diff-filter=U"]);
				const conflicts = [...new Set(lines(unmerged.stdout))];
				await run(worktree, ["rebase", "--abort"], { timeout: GIT_LONG_TIMEOUT_MS });
				if (conflicts.length === 0) throw error;
				return { ok: false, conflicts };
			}
		},

		async fastForward(cwd: string, branch: string): Promise<FastForwardOutcome> {
			try {
				await run(cwd, ["merge", "--ff-only", arg(branch, "branch")], { timeout: GIT_LONG_TIMEOUT_MS });
				return { ok: true };
			} catch (error) {
				if (error instanceof GitError) return { ok: false, error: error.stderr || error.message };
				throw error;
			}
		},
	};
}
