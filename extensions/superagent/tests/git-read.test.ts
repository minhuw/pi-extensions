import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitReadArgs, runGitRead } from "../src/git-read.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// --- fixture: a real repository in a scratch directory, git isolated from the developer's configuration ---
const ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
Object.assign(ENV, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
const IDENTITY = ["-c", "user.name=Superagent Test", "-c", "user.email=superagent@example.test", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

interface TestRepo {
	scratch: string;
	dir: string;
	git(cwd: string, ...args: string[]): string;
	write(cwd: string, files: Record<string, string>): void;
	commit(cwd: string, message: string, files?: Record<string, string>): string;
	cleanup(): void;
}

function createTestRepo(): TestRepo {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "superagent-git-")));
	const dir = join(scratch, "repo");
	mkdirSync(dir);
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", [...IDENTITY, ...args], { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
	const write = (cwd: string, files: Record<string, string>) => {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(cwd, path)), { recursive: true });
			writeFileSync(join(cwd, path), content);
		}
	};
	const commit = (cwd: string, message: string, files: Record<string, string> = {}) => {
		write(cwd, files);
		git(cwd, "add", "-A");
		git(cwd, "commit", "-q", "--allow-empty", "-m", message);
		return git(cwd, "rev-parse", "HEAD");
	};
	try {
		git(dir, "init", "-q");
		// createGit does not use the isolated env, so pin what its commands need in the repository's own config.
		for (const [key, value] of [["user.name", "Superagent Test"], ["user.email", "superagent@example.test"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"], ["rebase.autoStash", "false"]]) {
			git(dir, "config", key as string, value as string);
		}
		commit(dir, "initial", { "README.md": "# fixture\n" });
	} catch (error) {
		rmSync(scratch, { recursive: true, force: true });
		throw error;
	}
	return { scratch, dir, git, write, commit, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}
// --- end fixture ---
const accepted: Array<[string[], string[]]> = [
	[["status"], ["--no-pager", "status"]],
	[["status", "--porcelain"], ["--no-pager", "status", "--porcelain"]],
	[["diff", "--stat", "HEAD~1"], ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--stat", "HEAD~1"]],
	[["diff", "--cached"], ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--cached"]],
	[["log", "--oneline", "-5"], ["--no-pager", "log", "--no-ext-diff", "--no-textconv", "--oneline", "-5"]],
	[["show", "HEAD:README.md"], ["--no-pager", "show", "--no-ext-diff", "--no-textconv", "HEAD:README.md"]],
	[["blame", "README.md"], ["--no-pager", "blame", "README.md"]],
	[["shortlog", "-sn", "HEAD"], ["--no-pager", "shortlog", "-sn", "HEAD"]],
	[["rev-parse", "HEAD"], ["--no-pager", "rev-parse", "HEAD"]],
	[["ls-files"], ["--no-pager", "ls-files"]],
	[["grep", "-n", "fixture"], ["--no-pager", "grep", "-n", "fixture"]],
	[["describe", "--always"], ["--no-pager", "describe", "--always"]],
	[["merge-base", "main", "HEAD"], ["--no-pager", "merge-base", "main", "HEAD"]],
	[["worktree", "list"], ["--no-pager", "worktree", "list"]],
	[["worktree", "list", "--porcelain"], ["--no-pager", "worktree", "list", "--porcelain"]],
	[["branch"], ["--no-pager", "branch"]],
	[["branch", "-a", "-vv"], ["--no-pager", "branch", "-a", "-vv"]],
	[["branch", "-r"], ["--no-pager", "branch", "-r"]],
	[["branch", "--list", "pi/*"], ["--no-pager", "branch", "--list", "pi/*"]],
	[["branch", "-l", "pi/*", "feat*"], ["--no-pager", "branch", "-l", "pi/*", "feat*"]],
	[["branch", "--contains", "HEAD"], ["--no-pager", "branch", "--contains", "HEAD"]],
	[["branch", "--merged"], ["--no-pager", "branch", "--merged"]],
	[["branch", "--no-merged", "main"], ["--no-pager", "branch", "--no-merged", "main"]],
	[["branch", "--sort=-committerdate", "--format=%(refname:short)"], ["--no-pager", "branch", "--sort=-committerdate", "--format=%(refname:short)"]],
	[["branch", "--show-current"], ["--no-pager", "branch", "--show-current"]],
	[["tag"], ["--no-pager", "tag"]],
	[["tag", "--list", "v1.*"], ["--no-pager", "tag", "--list", "v1.*"]],
	[["tag", "--points-at", "HEAD"], ["--no-pager", "tag", "--points-at", "HEAD"]],
	[["tag", "-n3", "-l"], ["--no-pager", "tag", "-n3", "-l"]],
];

const refused: Array<[string[], RegExp]> = [
	[[], /subcommand/],
	[["commit", "-m", "x"], /git commit is not allowed/],
	[["push"], /git push is not allowed/],
	[["checkout", "main"], /not allowed/],
	[["reset", "--hard"], /not allowed/],
	[["config", "user.name"], /not allowed/],
	[["--git-dir=/tmp", "status"], /--git-dir/],
	[["-C", "/tmp", "status"], /starting with -C/],
	[["-c", "core.pager=sh", "log"], /starting with -c/],
	[["log", "-c"], /starting with -c/],
	[["diff", "--output=/tmp/x"], /--output/],
	[["log", "--output", "/tmp/x"], /--output/],
	[["show", "--exec=sh"], /--exec/],
	[["status", "--config-env=x=y"], /--config/],
	[["status", "--work-tree=/tmp"], /--work-tree/],
	[["diff", "--ext-diff"], /--ext-diff is not allowed/],
	[["log", "--textconv", "-p"], /--textconv is not allowed/],
	[["grep", "-Ovim", "x"], /-Ovim is not allowed/],
	[["grep", "--open-files-in-pager=sh", "x"], /not allowed/],
	[["worktree", "add", "../x"], /Only git worktree list/],
	[["worktree", "remove", "x"], /Only git worktree list/],
	[["worktree", "prune"], /Only git worktree list/],
	[["worktree"], /Only git worktree list/],
	[["worktree", "list", "--expire=now"], /not allowed/],
	[["branch", "new-branch"], /only listing is allowed/],
	[["branch", "new-branch", "HEAD"], /only listing is allowed/],
	[["branch", "-d", "pi/1-x"], /-d is not a listing option/],
	[["branch", "-D", "pi/1-x"], /-D is not a listing option/],
	[["branch", "-m", "a", "b"], /-m is not a listing option/],
	[["branch", "-M", "b"], /not a listing option/],
	[["branch", "-c", "a", "b"], /starting with -c/],
	[["branch", "--copy", "a", "b"], /not a listing option/],
	[["branch", "-f", "main", "HEAD"], /not a listing option/],
	[["branch", "--set-upstream-to=origin/main"], /not a listing option/],
	[["branch", "-u", "origin/main"], /not a listing option/],
	[["branch", "--unset-upstream"], /not a listing option/],
	[["branch", "--edit-description"], /not a listing option/],
	[["branch", "--delete", "x"], /not a listing option/],
	[["branch", "--", "x"], /not a listing option/],
	[["branch", "x", "--list"], /only listing is allowed/],
	[["branch", "--sort"], /needs a value/],
	[["tag", "v1"], /only listing is allowed/],
	[["tag", "-a", "v1", "-m", "x"], /not a listing option/],
	[["tag", "-d", "v1"], /not a listing option/],
	[["tag", "-f", "v1"], /not a listing option/],
	[["tag", "-s", "v1"], /not a listing option/],
];

describe("checkGitReadArgs", () => {
	it.each(accepted)("accepts %j", (args, argv) => {
		expect(checkGitReadArgs(args)).toEqual({ ok: true, args: argv });
	});

	it.each(refused)("refuses %j", (args, reason) => {
		const result = checkGitReadArgs(args);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toMatch(reason);
	});

	it("refuses non-string arguments", () => {
		expect(checkGitReadArgs(["status", 3 as unknown as string]).ok).toBe(false);
		expect(checkGitReadArgs("status" as unknown as string[]).ok).toBe(false);
		expect(checkGitReadArgs(["status", "a\0b"]).ok).toBe(false);
	});
});

describe("runGitRead", () => {
	let t: TestRepo;
	beforeEach(() => {
		t = createTestRepo();
	});
	afterEach(() => t.cleanup());

	it("runs git in the checkout and returns its output", async () => {
		t.commit(t.dir, "second commit", { "a.txt": "alpha\n" });
		const log = await runGitRead(t.dir, ["log", "--format=%s"]);
		expect(log).toEqual({ output: "second commit\ninitial\n", exitCode: 0, truncated: false });
		const grep = await runGitRead(t.dir, ["grep", "-n", "alpha"]);
		expect(grep.output).toBe("a.txt:1:alpha\n");
		const branches = await runGitRead(t.dir, ["branch", "--list", "ma*"]);
		expect(branches.output).toBe("* main\n");
		const worktrees = await runGitRead(t.dir, ["worktree", "list", "--porcelain"]);
		expect(worktrees.output).toContain(`worktree ${t.dir}\n`);
	});

	it("includes stderr and the exit code of a failing command", async () => {
		const result = await runGitRead(t.dir, ["show", "does-not-exist"]);
		expect(result.exitCode).toBe(128);
		expect(result.output).toMatch(/fatal: .*does-not-exist/);
		expect(result.truncated).toBe(false);
	});

	it("does not run external diff drivers or textconv filters", async () => {
		const marker = join(t.scratch, "ran");
		t.git(t.dir, "config", "diff.evil.textconv", `sh -c 'touch ${marker}; cat "$1"' -`);
		t.git(t.dir, "config", "diff.external", `sh -c 'touch ${marker}'`);
		t.commit(t.dir, "attrs", { ".gitattributes": "*.txt diff=evil\n", "x.txt": "one\n" });
		t.commit(t.dir, "change", { "x.txt": "two\n" });
		const result = await runGitRead(t.dir, ["log", "-p", "-1"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("+two");
		expect((await runGitRead(t.dir, ["diff", "HEAD~1"])).output).toContain("+two");
		expect((await runGitRead(t.dir, ["show", "HEAD"])).output).toContain("+two");
		expect(existsSync(marker)).toBe(false);
	});

	it("cuts output at 50 KB with a note", async () => {
		t.commit(t.dir, "big", { "big.txt": `${"0123456789abcdef\n".repeat(20_000)}` });
		const result = await runGitRead(t.dir, ["show", "HEAD:big.txt"]);
		expect(result.truncated).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.output.startsWith("0123456789abcdef\n")).toBe(true);
		expect(result.output.endsWith("\n[output truncated at 50 KB]")).toBe(true);
		expect(Buffer.byteLength(result.output)).toBeLessThan(50 * 1024 + 100);
	});

	it("rejects a refused command without running git", async () => {
		await expect(runGitRead(t.dir, ["commit", "-m", "x"])).rejects.toThrow(/git commit is not allowed/);
		await expect(runGitRead(t.dir, ["branch", "created"])).rejects.toThrow(/only listing/);
		expect(t.git(t.dir, "branch", "--list", "created")).toBe("");
	});
});
