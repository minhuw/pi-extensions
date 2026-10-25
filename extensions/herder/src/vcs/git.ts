import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { HERDER_DIR, MIN_GIT_VERSION, REF_ROOT } from "../config.ts";
import type { Vcs } from "../types.ts";

/** A git command failed; the message includes git's stderr. */
export class GitError extends Error {
	readonly args: string[];
	readonly status: number | null;
	readonly stderr: string;
	constructor(args: string[], status: number | null, stderr: string) {
		super(`git ${args.join(" ")} failed (${status === null ? "not run" : `exit ${status}`})${stderr ? `: ${stderr}` : ""}`);
		this.name = "GitError";
		this.args = args;
		this.status = status;
		this.stderr = stderr;
	}
}

/** A conditional `updateRef` found the ref somewhere other than `expected` (`null`: the ref must not exist). */
export class RefConflictError extends Error {
	readonly ref: string;
	readonly expected: string | null;
	readonly actual: string | null;
	constructor(ref: string, expected: string | null, actual: string | null) {
		super(`ref ${ref} is at ${actual ?? "(missing)"}, expected ${expected ?? "(missing)"}`);
		this.name = "RefConflictError";
		this.ref = ref;
		this.expected = expected;
		this.actual = actual;
	}
}

// Inherited repository-location variables (e.g. when Pi runs inside a git hook) would redirect every command.
const LOCATION_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"];
const MAX_BUFFER = 1 << 30;
// githooks(5) events. Hooks defined in configuration (git >= 2.54) ignore core.hooksPath; `hook.<event>.enabled=false`
// (git >= 2.55) silences them per event, and older git ignores the unknown keys.
const HOOK_EVENTS = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "post-index-change"];
// Herder's own operations never run the user's hooks (including reference-transaction on ref updates).
const NO_HOOKS = ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", ...HOOK_EVENTS.flatMap((event) => ["-c", `hook.${event}.enabled=false`])];
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// Patch and stat output independent of the user's diff configuration.
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--find-renames", "--submodule=short"];
const FALLBACK_IDENTITY = { name: "Herder", email: "herder@localhost" };

function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
	for (const name of LOCATION_VARS) delete env[name];
	return env;
}

interface Output { status: number | null; stdout: Buffer; stderr: string }
interface RunOptions { input?: string | Buffer; env?: NodeJS.ProcessEnv; ok?: number[]; hooks?: boolean }

/**
 * Git 2.54 can disable configured hooks only by name, so this lists them for the command's own cwd (conditional
 * includes may differ per worktree). Passed through GIT_CONFIG_* because `-c` cannot carry a name containing `=`.
 */
function disableNamedHooks(cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (!gitVersion?.startsWith("2.54.")) return env;
	const found = spawnSync("git", ["config", "-z", "--name-only", "--get-regexp", "^hook\\..+\\.command$"], { cwd, env, maxBuffer: MAX_BUFFER });
	if (found.error || (found.status !== 0 && found.status !== 1)) throw new GitError(["config", "--get-regexp", "hook"], found.status, found.stderr?.toString("utf8").trim() ?? "");
	const names = found.stdout.toString("utf8").split("\0").filter(Boolean).map((key) => key.slice("hook.".length, -".command".length));
	if (names.length === 0) return env;
	const result = { ...env };
	let count = Number(env.GIT_CONFIG_COUNT ?? 0);
	for (const name of names) {
		result[`GIT_CONFIG_KEY_${count}`] = `hook.${name}.enabled`;
		result[`GIT_CONFIG_VALUE_${count++}`] = "false";
	}
	result.GIT_CONFIG_COUNT = String(count);
	return result;
}

function spawn(cwd: string, args: string[], options: RunOptions = {}): Output {
	const env = options.env ?? gitEnv();
	const result = spawnSync("git", options.hooks ? args : [...NO_HOOKS, ...args], { cwd, env: options.hooks ? env : disableNamedHooks(cwd, env), input: options.input ?? "", maxBuffer: MAX_BUFFER });
	if (result.error) throw new GitError(args, null, result.error.message);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString("utf8").trim() };
}

function run(cwd: string, args: string[], options: RunOptions = {}): Output {
	const output = spawn(cwd, args, options);
	if (output.status === null || !(options.ok ?? [0]).includes(output.status)) throw new GitError(args, output.status, output.stderr);
	return output;
}

const text = (cwd: string, args: string[], options?: RunOptions) => run(cwd, args, options).stdout.toString("utf8").trimEnd();
const lines = (value: string) => value.split("\n").filter(Boolean);

/** Parses `git --version` output and throws unless it is at least `MIN_GIT_VERSION`. */
export function checkGitVersion(output: string): string {
	const found = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
	if (!found) throw new Error(`Herder requires git >= ${MIN_GIT_VERSION}; cannot parse the version from ${JSON.stringify(output.trim())}`);
	const version = [found[1], found[2], found[3] ?? "0"].map(Number);
	const minimum = MIN_GIT_VERSION.split(".").map(Number);
	const order = version.map((part, index) => part - (minimum[index] ?? 0)).find((difference) => difference !== 0) ?? 0;
	if (order < 0) throw new Error(`Herder requires git >= ${MIN_GIT_VERSION} (for merge-tree --write-tree); found ${version.join(".")}`);
	return version.join(".");
}

let gitVersion: string | undefined;

/** Throws a clear error when git is missing or older than 2.38; checked once per process. */
export function requireGit(): string {
	if (gitVersion) return gitVersion;
	let output: string;
	try {
		output = text(tmpdir(), ["--version"]);
	} catch (error) {
		throw new Error(`Herder requires git >= ${MIN_GIT_VERSION}, but git could not be run: ${(error as Error).message}`, { cause: error });
	}
	return (gitVersion = checkGitVersion(output));
}

/** Real path of `path`, resolving symlinks in the longest existing prefix (the path itself may not exist). */
function canonical(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(canonical(parent), basename(absolute));
	}
}

const within = (path: string, parent: string) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** The user's identity when configured; otherwise Herder's, so commits never fail for lack of one. */
function commitEnv(cwd: string): NodeJS.ProcessEnv {
	const env = gitEnv();
	const configured = new Set(lines(text(cwd, ["config", "--get-regexp", "^(user|author|committer)\\.(name|email)$"], { ok: [0, 1] })).map((line) => line.split(" ")[0]!.toLowerCase()));
	for (const role of ["author", "committer"]) {
		for (const field of ["name", "email"] as const) {
			const variable = `GIT_${role.toUpperCase()}_${field.toUpperCase()}`;
			if (env[variable] || (field === "email" && env.EMAIL) || configured.has(`${role}.${field}`) || configured.has(`user.${field}`)) continue;
			env[variable] = FALLBACK_IDENTITY[field];
		}
	}
	return env;
}

/** Never signed: a pinentry prompt would block Pi. */
function createCommit(cwd: string, tree: string, parents: string[], message: string): string {
	const args = ["commit-tree", "--no-gpg-sign", ...parents.flatMap((parent) => ["-p", parent]), tree];
	return text(cwd, args, { input: message.endsWith("\n") ? message : `${message}\n`, env: commitEnv(cwd) });
}

/** Whether any line of `message` looks like a `Herder-*` trailer; no delivered commit may carry one. */
export const hasHerderTrailer = (message: string) => /^herder-[\w-]*\s*:/im.test(message);

/** Removes every Herder worktree and stale registration under `dir` (a run's `<common>/herder/worktrees/<runId>/`). */
export function removeWorktrees(vcs: Vcs, dir: string): void {
	vcs.removeWorktree(dir);
}

/** Opens the repository containing `cwd`; "the user's checkout" is that cwd's top level (a linked worktree's own). */
export function openVcs(cwd: string): Vcs {
	requireGit();
	let top: string;
	let common: string;
	try {
		top = realpathSync(text(cwd, ["rev-parse", "--show-toplevel"]));
		common = realpathSync(text(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
	} catch (error) {
		throw new Error(`Herder needs a git working tree: ${(error as Error).message}`, { cause: error });
	}
	const git = (args: string[], options?: RunOptions) => text(top, args, options);

	const resolveCommit = (rev: string) => {
		const found = spawn(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
		if (found.status !== 0) throw new Error(`not a commit: ${rev}`);
		return found.stdout.toString("utf8").trim();
	};
	const readRef = (ref: string) => {
		const found = run(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref], { ok: [0, 1] });
		return found.status === 0 ? found.stdout.toString("utf8").trim() : null;
	};
	const treeOf = (commit: string) => git(["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]);
	const worktrees = () => {
		const listed = run(top, ["worktree", "list", "--porcelain", "-z"]).stdout.toString("utf8").split("\0");
		return listed.filter((line) => line.startsWith("worktree ")).map((line) => canonical(line.slice("worktree ".length)));
	};
	const requireRef = (ref: string) => {
		if (!/^refs\/[^\s*?[\\]+$/.test(ref)) throw new Error(`refusing to touch ${JSON.stringify(ref)}: only full names under refs/ are allowed`);
	};
	const requireOid = (value: string) => {
		if (!OID.test(value)) throw new Error(`refusing ${JSON.stringify(value)}: not a full object id`);
	};
	const admin = join(common, "worktrees");
	/** `path` resolved; checked before any git or file system call so nothing outside Herder's worktrees is touched. */
	const requireHerderPath = (path: string) => {
		const root = canonical(join(common, HERDER_DIR, "worktrees"));
		const target = canonical(path);
		if (target === root || !within(target, root)) throw new Error(`refusing ${JSON.stringify(path)}: Herder only operates on worktrees inside ${root}`);
		return target;
	};
	/** The root of a registered Herder worktree, whose git dir is its own admin entry (not one an agent redirected). */
	const requireWorktree = (path: string) => {
		const dir = requireHerderPath(path);
		const [root, dirCommon, gitDir] = lines(text(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--absolute-git-dir"])).map(canonical);
		const entry = gitDir !== undefined && dirname(gitDir) === admin && existsSync(join(gitDir, "gitdir")) ? canonical(dirname(resolve(gitDir, readFileSync(join(gitDir, "gitdir"), "utf8").trim()))) : undefined;
		if (root !== dir || dirCommon !== common || entry !== dir) throw new Error(`${dir} is not a Herder worktree of ${top}`);
		return dir;
	};
	/** Registrations at or below `target`, read from the admin entries (`gitdir` names `<worktree>/.git`). */
	const registeredUnder = (target: string) => (existsSync(admin) ? readdirSync(admin) : []).flatMap((name) => {
		const gitdir = join(admin, name, "gitdir");
		if (!existsSync(gitdir)) return [];
		const worktree = canonical(dirname(resolve(admin, name, readFileSync(gitdir, "utf8").trim())));
		return within(worktree, target) ? [{ entry: join(admin, name), worktree }] : [];
	});

	return {
		commonDir: () => common,
		topLevel: () => top,
		head: () => git(["rev-parse", "--verify", "HEAD"]),
		currentBranch() {
			const found = run(top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: [0, 1] });
			return found.status === 0 ? found.stdout.toString("utf8").trim() : null;
		},
		isClean: (path) => text(path === undefined ? top : requireWorktree(path), ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]) === "",

		addWorktree(path, commit) {
			const target = requireHerderPath(path);
			const sha = resolveCommit(commit);
			mkdirSync(dirname(target), { recursive: true });
			git(["worktree", "add", "--detach", "--quiet", target, sha]);
		},
		/** Also removes every worktree below `path`, so a run's directory goes in one call. */
		removeWorktree(path) {
			const target = requireHerderPath(path);
			// Double force also removes locked worktrees; failures (half-created, missing) are handled below.
			for (const { worktree } of registeredUnder(target)) spawn(top, ["worktree", "remove", "--force", "--force", worktree]);
			rmSync(target, { recursive: true, force: true });
			// Still registered with the directory gone: drop only these admin entries; a global prune would also drop
			// the user's own stale registrations (e.g. a worktree on an unmounted drive).
			for (const { entry } of registeredUnder(target)) rmSync(entry, { recursive: true, force: true });
			if (worktrees().some((worktree) => within(worktree, target))) throw new Error(`could not unregister worktree ${target}`);
		},
		snapshot(path, message, base) {
			const dir = requireWorktree(path);
			text(dir, ["add", "-A"]);
			const tree = text(dir, ["write-tree"]);
			// With a base, only the final tree counts: commits the agent made itself are squashed and HEAD is ignored.
			const parent = base === undefined ? text(dir, ["rev-parse", "--verify", "HEAD"]) : resolveCommit(base);
			if (tree === treeOf(parent)) return null;
			const commit = createCommit(dir, tree, [parent], message);
			text(dir, ["update-ref", "--no-deref", "-m", "herder snapshot", "HEAD", commit, ...(base === undefined ? [parent] : [])]);
			return commit;
		},

		readRef,
		updateRef(ref, value, expectedOld) {
			requireRef(ref);
			requireOid(value);
			if (typeof expectedOld === "string") requireOid(expectedOld);
			const command = expectedOld === undefined ? `update ${ref} ${value}` : expectedOld === null ? `create ${ref} ${value}` : `update ${ref} ${value} ${expectedOld}`;
			const output = spawn(top, ["update-ref", "--stdin"], { input: `${command}\n` });
			if (output.status === 0) return;
			if (expectedOld !== undefined) {
				const actual = readRef(ref);
				if (expectedOld === null ? actual !== null : actual !== expectedOld) throw new RefConflictError(ref, expectedOld, actual);
			}
			throw new GitError(["update-ref", "--stdin", command], output.status, output.stderr);
		},
		deleteRefs(prefix) {
			const pattern = prefix.replace(/\/+$/, "");
			const segments = pattern.startsWith(`${REF_ROOT}/`) ? pattern.slice(REF_ROOT.length + 1).split("/") : [];
			if (segments.length === 0 || segments.some((segment) => !/^[^\s*?[\\]+$/.test(segment) || segment === "." || segment === "..")) {
				throw new Error(`refusing to delete ${JSON.stringify(prefix)}: only ${REF_ROOT}/<runId>[/...] prefixes are allowed`);
			}
			// A literal for-each-ref pattern matches the ref itself or refs below it at a slash boundary.
			const refs = lines(git(["for-each-ref", "--format=%(refname)", pattern]));
			if (refs.length > 0) git(["update-ref", "--stdin"], { input: refs.map((ref) => `delete ${ref}\n`).join("") });
		},

		resolve: resolveCommit,
		treeOf,
		parentsOf: (commit) => git(["rev-list", "--parents", "-n", "1", "--end-of-options", resolveCommit(commit)]).split(" ").slice(1),
		/**
		 * Trailers of the message's final paragraph, by git's rules (all `Key: value` lines, or at least 25% with one git
		 * recognises such as Signed-off-by). Keys are lowercased since git matches them case-insensitively; the last wins.
		 */
		trailers(commit) {
			const output = git(["-c", "trailer.separators=:", "log", "-1", "--no-show-signature", "--format=%(trailers:only,unfold,separator=%x1e,key_value_separator=%x1f)", resolveCommit(commit)]);
			const result: Record<string, string> = {};
			for (const trailer of output.split("\x1e")) {
				const at = trailer.indexOf("\x1f");
				if (at > 0) result[trailer.slice(0, at).toLowerCase()] = trailer.slice(at + 1);
			}
			return result;
		},
		message(commit) {
			const raw = run(top, ["cat-file", "commit", resolveCommit(commit)]).stdout;
			const at = raw.indexOf("\n\n");
			return at < 0 ? "" : raw.subarray(at + 2).toString("utf8");
		},

		mergeTree(ours, theirs, mergeBase) {
			let [left, right] = [resolveCommit(ours), resolveCommit(theirs)];
			if (mergeBase !== undefined) {
				// `--merge-base` needs git 2.40; two throwaway commits whose only parent is the base pin the merge base portably.
				const base = resolveCommit(mergeBase);
				left = createCommit(top, treeOf(left), [base], "herder merge side\n");
				right = createCommit(top, treeOf(right), [base], "herder merge side\n");
			}
			const output = run(top, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", left, right], { ok: [0, 1] });
			const [tree, ...paths] = output.stdout.toString("utf8").split("\0").filter(Boolean);
			if (!tree) throw new GitError(["merge-tree", left, right], output.status, "no tree in output");
			return { clean: output.status === 0, tree, conflicts: [...new Set(paths)] };
		},
		commitTree: (tree, parents, message) => createCommit(top, tree, parents, message),

		/** Oldest first (`--reverse --topo-order`), the order a replay applies them. */
		revList: (range) => lines(git(["rev-list", "--reverse", "--topo-order", "--end-of-options", range])),
		diffStat: (range) => git(["diff", ...DIFF_FLAGS, "--stat", "--end-of-options", range]),
		changedLines(range) {
			let total = 0;
			for (const line of lines(git(["diff", ...DIFF_FLAGS, "--numstat", "--end-of-options", range]))) {
				const [added, deleted] = line.split("\t");
				total += added === "-" ? 1 : Number(added) + Number(deleted);
			}
			return total;
		},

		fastForward(commit) {
			git(["merge", "--ff-only", "--no-autostash", "--quiet", resolveCommit(commit)], { hooks: true });
		},
		applyDiff(from, to) {
			const patch = run(top, ["diff", "--binary", ...DIFF_FLAGS, "--src-prefix=a/", "--dst-prefix=b/", resolveCommit(from), resolveCommit(to)]).stdout;
			if (patch.length > 0) git(["apply", "--whitespace=nowarn"], { input: patch });
		},
	};
}
