import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGit, GitError } from "../src/git.ts";
import type { Repo } from "../src/types.ts";

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

const git = createGit();
let t: TestRepo;
let repo: Repo;

beforeEach(async () => {
	t = createTestRepo();
	repo = (await git.open(t.dir)) as Repo;
});
afterEach(() => t.cleanup());

describe("open", () => {
	it("returns real paths for a repository with a commit, also from a subdirectory", async () => {
		expect(repo).toEqual({ topLevel: t.dir, commonDir: join(t.dir, ".git") });
		mkdirSync(join(t.dir, "sub", "deeper"), { recursive: true });
		expect(await git.open(join(t.dir, "sub", "deeper"))).toEqual(repo);
	});

	it("returns the linked worktree's top level and the shared common dir", async () => {
		const linked = join(t.scratch, "linked");
		t.git(t.dir, "worktree", "add", "-q", "-b", "dev", linked);
		expect(await git.open(linked)).toEqual({ topLevel: linked, commonDir: join(t.dir, ".git") });
		expect(await git.branch(linked)).toBe("dev");
	});

	it("is undefined without commits, outside git, and for a missing directory", async () => {
		const empty = join(t.scratch, "empty");
		mkdirSync(empty);
		t.git(empty, "init", "-q");
		expect(await git.open(empty)).toBeUndefined();
		const plain = join(t.scratch, "plain");
		mkdirSync(plain);
		expect(await git.open(plain)).toBeUndefined();
		expect(await git.open(join(t.scratch, "missing"))).toBeUndefined();
		expect(await git.open(join(t.dir, ".git"))).toBeUndefined();
	});

	it("ignores ambient GIT_* variables", async () => {
		const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE };
		process.env.GIT_DIR = join(t.scratch, "nowhere");
		process.env.GIT_WORK_TREE = t.scratch;
		try {
			expect(await git.open(t.dir)).toEqual(repo);
			expect(await git.branch(t.dir)).toBe("main");
		} finally {
			if (saved.dir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = saved.dir;
			if (saved.tree === undefined) delete process.env.GIT_WORK_TREE;
			else process.env.GIT_WORK_TREE = saved.tree;
		}
	});
});

describe("refs", () => {
	it("branch, revParse, branchExists", async () => {
		const head = t.git(t.dir, "rev-parse", "HEAD");
		expect(await git.branch(t.dir)).toBe("main");
		expect(await git.revParse(t.dir)).toBe(head);
		expect(await git.revParse(t.dir, "main")).toBe(head);
		expect(await git.branchExists(repo, "main")).toBe(true);
		expect(await git.branchExists(repo, "nope")).toBe(false);

		const error = await git.revParse(t.dir, "nope").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitError);
		expect((error as GitError).stderr).toMatch(/fatal/);
		expect((error as GitError).message).toContain((error as GitError).stderr);
		await expect(git.revParse(t.dir, "--all")).rejects.toThrow(/invalid ref/);

		t.git(t.dir, "checkout", "-q", "--detach");
		expect(await git.branch(t.dir)).toBeUndefined();
	});
});

describe("worktrees and branches", () => {
	it("adds and removes a worktree (forced, idempotent)", async () => {
		const base = await git.revParse(t.dir);
		const path = join(repo.commonDir, "superagent", "worktrees", "1-feature");
		await git.addWorktree(repo, path, "pi/1-feature", base);
		expect(existsSync(join(path, "README.md"))).toBe(true);
		expect(await git.branch(path)).toBe("pi/1-feature");
		expect(await git.revParse(path)).toBe(base);
		expect(await git.open(path)).toEqual({ topLevel: path, commonDir: repo.commonDir });
		await expect(git.addWorktree(repo, path, "pi/1-feature", base)).rejects.toThrow(GitError);

		writeFileSync(join(path, "untracked.txt"), "x");
		writeFileSync(join(path, "README.md"), "changed\n");
		await git.removeWorktree(repo, path);
		expect(existsSync(path)).toBe(false);
		expect(t.git(t.dir, "worktree", "list", "--porcelain")).not.toContain(path);
		await git.removeWorktree(repo, path);

		// A worktree directory deleted by hand is pruned without error.
		const other = join(t.scratch, "other");
		await git.addWorktree(repo, other, "other", base);
		rmSync(other, { recursive: true, force: true });
		await git.removeWorktree(repo, other);
		expect(t.git(t.dir, "worktree", "list", "--porcelain")).not.toContain(other);
	});

	it("deletes branches with -d, -D when forced, and ignores missing ones", async () => {
		const base = await git.revParse(t.dir);
		const path = join(t.scratch, "wt");
		await git.addWorktree(repo, path, "feature", base);
		t.commit(path, "feature work", { "a.txt": "a\n" });
		await git.removeWorktree(repo, path);
		await expect(git.deleteBranch(repo, "feature")).rejects.toThrow(/not fully merged/);
		expect(await git.branchExists(repo, "feature")).toBe(true);
		await git.deleteBranch(repo, "feature", true);
		expect(await git.branchExists(repo, "feature")).toBe(false);
		await git.deleteBranch(repo, "feature");

		t.git(t.dir, "branch", "merged");
		await git.deleteBranch(repo, "merged");
		expect(await git.branchExists(repo, "merged")).toBe(false);
	});

	it("isClean sees modified and untracked files", async () => {
		expect(await git.isClean(t.dir)).toBe(true);
		writeFileSync(join(t.dir, "README.md"), "changed\n");
		expect(await git.isClean(t.dir)).toBe(false);
		t.git(t.dir, "checkout", "--", "README.md");
		expect(await git.isClean(t.dir)).toBe(true);
		writeFileSync(join(t.dir, "new.txt"), "x");
		expect(await git.isClean(t.dir)).toBe(false);
	});
});

describe("comparisons", () => {
	it("aheadBehind, isAncestor, changedFiles", async () => {
		const base = await git.revParse(t.dir);
		const path = join(t.scratch, "wt");
		await git.addWorktree(repo, path, "feature", base);
		t.commit(path, "add a", { "a.txt": "a\n" });
		const tip = t.commit(path, "edit readme", { "README.md": "# feature\n" });
		const mainTip = t.commit(t.dir, "main moves", { "b.txt": "b\n" });

		expect(await git.aheadBehind(repo, "feature", "main")).toEqual({ ahead: 2, behind: 1 });
		expect(await git.aheadBehind(repo, "main", "feature")).toEqual({ ahead: 1, behind: 2 });
		expect(await git.aheadBehind(repo, "feature", base)).toEqual({ ahead: 2, behind: 0 });
		expect(await git.isAncestor(repo, base, "feature")).toBe(true);
		expect(await git.isAncestor(repo, base, tip)).toBe(true);
		expect(await git.isAncestor(repo, mainTip, "feature")).toBe(false);
		expect(await git.isAncestor(repo, "feature", "main")).toBe(false);
		await expect(git.isAncestor(repo, "nope", "main")).rejects.toThrow(GitError);
		// Only the branch's side, from the merge base.
		expect((await git.changedFiles(repo, "feature", "main")).sort()).toEqual(["A\ta.txt", "M\tREADME.md"].sort());
		expect(await git.changedFiles(repo, "main", "main")).toEqual([]);
	});
});

describe("rebase", () => {
	async function feature(files: Record<string, string>) {
		const base = await git.revParse(t.dir);
		const path = join(t.scratch, "wt");
		await git.addWorktree(repo, path, "feature", base);
		const tip = t.commit(path, "feature work", files);
		return { path, base, tip };
	}

	it("is a no-op when the branch already contains onto", async () => {
		const { path, base, tip } = await feature({ "a.txt": "a\n" });
		expect(await git.rebase(path, base)).toEqual({ ok: true, rebased: false });
		expect(await git.revParse(path)).toBe(tip);
	});

	it("rebases cleanly onto a moved target", async () => {
		const { path, tip } = await feature({ "a.txt": "a\n" });
		const mainTip = t.commit(t.dir, "main moves", { "b.txt": "b\n" });
		expect(await git.rebase(path, mainTip)).toEqual({ ok: true, rebased: true });
		expect(await git.revParse(path)).not.toBe(tip);
		expect(await git.isAncestor(repo, mainTip, "feature")).toBe(true);
		expect(await git.aheadBehind(repo, "feature", "main")).toEqual({ ahead: 1, behind: 0 });
		expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("a\n");
		expect(readFileSync(join(path, "b.txt"), "utf8")).toBe("b\n");
	});

	it("aborts on conflicts, lists the conflicted paths, and leaves the worktree clean", async () => {
		const { path, tip } = await feature({ "README.md": "# feature\n", "a.txt": "a\n", "shared.txt": "feature\n" });
		const mainTip = t.commit(t.dir, "main moves", { "README.md": "# main\n", "shared.txt": "main\n" });
		const outcome = await git.rebase(path, mainTip);
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && [...outcome.conflicts].sort()).toEqual(["README.md", "shared.txt"]);
		expect(await git.revParse(path)).toBe(tip);
		expect(await git.branch(path)).toBe("feature");
		expect(await git.isClean(path)).toBe(true);
		expect(existsSync(join(repo.commonDir, "worktrees", "wt", "rebase-merge"))).toBe(false);
		expect(existsSync(join(repo.commonDir, "worktrees", "wt", "rebase-apply"))).toBe(false);
		expect(readFileSync(join(path, "README.md"), "utf8")).toBe("# feature\n");
	});
});

describe("fastForward", () => {
	it("fast-forwards the checkout", async () => {
		const base = await git.revParse(t.dir);
		const path = join(t.scratch, "wt");
		await git.addWorktree(repo, path, "feature", base);
		const tip = t.commit(path, "feature work", { "a.txt": "a\n" });
		expect(await git.fastForward(t.dir, "feature")).toEqual({ ok: true });
		expect(await git.revParse(t.dir)).toBe(tip);
		expect(readFileSync(join(t.dir, "a.txt"), "utf8")).toBe("a\n");
	});

	it("returns git's message when uncommitted changes would be overwritten, and changes nothing", async () => {
		const base = await git.revParse(t.dir);
		const path = join(t.scratch, "wt");
		await git.addWorktree(repo, path, "feature", base);
		t.commit(path, "feature work", { "README.md": "# feature\n" });
		writeFileSync(join(t.dir, "README.md"), "# local edit\n");
		const outcome = await git.fastForward(t.dir, "feature");
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toMatch(/would be overwritten by merge/);
		expect(await git.revParse(t.dir)).toBe(base);
		expect(readFileSync(join(t.dir, "README.md"), "utf8")).toBe("# local edit\n");
	});

	it("refuses a diverged branch", async () => {
		const base = await git.revParse(t.dir);
		const path = join(t.scratch, "wt");
		await git.addWorktree(repo, path, "feature", base);
		t.commit(path, "feature work", { "a.txt": "a\n" });
		const mainTip = t.commit(t.dir, "main moves", { "b.txt": "b\n" });
		const outcome = await git.fastForward(t.dir, "feature");
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.error).toMatch(/fast-forward/i);
		expect(await git.revParse(t.dir)).toBe(mainTip);
	});
});
