import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TRAILER_FINGERPRINT, TRAILER_STEP } from "../../src/config.ts";
import type { Vcs } from "../../src/types.ts";
import { checkGitVersion, hasHerderTrailer, openVcs, RefConflictError, removeWorktrees, requireGit } from "../../src/vcs/git.ts";
import { type GitFixture, withGitFixture } from "../support/git-fixture.ts";

// The Vcs inherits process.env; isolate it from the developer's global and system git configuration.
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
	for (const [name, value] of [["GIT_CONFIG_GLOBAL", saved.global], ["GIT_CONFIG_NOSYSTEM", saved.nosystem]] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

const herderRoot = (fixture: GitFixture) => join(fixture.commonDir, "herder", "worktrees");
const slot = (fixture: GitFixture, name = "s1", runId = "20260101-000000-abcd") => join(herderRoot(fixture), runId, name);

/** HEAD, branch, and index bytes of the user's checkout; compare before and after, then expect `status()` empty. */
function checkout(fixture: GitFixture) {
	fixture.status(); // let git refresh the index first so later comparisons see only real writes
	return { head: fixture.head(), branch: fixture.git("symbolic-ref", "-q", "HEAD"), index: createHash("sha256").update(readFileSync(join(fixture.commonDir, "index"))).digest("hex") };
}

/** Runs `fn` against a fresh repository (after `setup`) and asserts the user's checkout was left untouched. */
function untouched(fn: (fixture: GitFixture, vcs: Vcs) => void, files?: Record<string, string>, setup?: (fixture: GitFixture) => void) {
	return withGitFixture((fixture) => {
		setup?.(fixture);
		const vcs = openVcs(fixture.dir);
		const before = checkout(fixture);
		fn(fixture, vcs);
		const indexAfter = createHash("sha256").update(readFileSync(join(fixture.commonDir, "index"))).digest("hex");
		expect({ ...checkout(fixture), index: indexAfter }).toEqual(before);
		expect(fixture.status()).toBe("");
	}, files);
}

const worktreeList = (fixture: GitFixture) => fixture.git("worktree", "list", "--porcelain");

/** Runs `fn` with a fresh repository that also has a user's linked worktree (branch `side`) outside it. */
function withLinked(fn: (fixture: GitFixture, linked: string) => void, files?: Record<string, string>) {
	return withGitFixture((fixture) => {
		const parent = realpathSync(mkdtempSync(join(tmpdir(), "herder-linked-")));
		try {
			fixture.git("worktree", "add", "-q", "-b", "side", join(parent, "wt"));
			fn(fixture, join(parent, "wt"));
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	}, files);
}

describe("git version", () => {
	it("accepts 2.38 and later and rejects older versions clearly", () => {
		expect(checkGitVersion("git version 2.38.0")).toBe("2.38.0");
		expect(checkGitVersion("git version 2.39.3 (Apple Git-146)")).toBe("2.39.3");
		expect(checkGitVersion("git version 3.0")).toBe("3.0.0");
		expect(checkGitVersion("git version 2.41.0.windows.1")).toBe("2.41.0");
		expect(() => checkGitVersion("git version 2.37.9")).toThrow(/Herder requires git >= 2\.38\.0.*found 2\.37\.9/);
		expect(() => checkGitVersion("garbage")).toThrow(/Herder requires git >= 2\.38\.0/);
		expect(requireGit()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("openVcs", () => {
	it("binds to the repository top level and the real common dir from a subdirectory", () =>
		untouched((fixture) => {
			const vcs = openVcs(join(fixture.dir, "src"));
			expect(vcs.topLevel()).toBe(fixture.dir);
			expect(vcs.commonDir()).toBe(realpathSync(fixture.commonDir));
			expect(vcs.head()).toBe(fixture.head());
			expect(vcs.currentBranch()).toBe("main");
		}, { "src/a.txt": "a\n" }));

	it("uses a linked worktree's own top level and the shared common dir", () =>
		withGitFixture((fixture) => {
			const linked = realpathSync(mkdtempSync(join(tmpdir(), "herder-linked-")));
			try {
				fixture.git("worktree", "add", "-q", "-b", "side", join(linked, "wt"));
				const vcs = openVcs(join(linked, "wt"));
				expect(vcs.topLevel()).toBe(join(linked, "wt"));
				expect(vcs.commonDir()).toBe(fixture.commonDir);
				expect(vcs.currentBranch()).toBe("side");
			} finally {
				rmSync(linked, { recursive: true, force: true });
			}
		}));

	it("reports a detached HEAD as no branch", () =>
		withGitFixture((fixture) => {
			fixture.git("checkout", "-q", "--detach");
			expect(openVcs(fixture.dir).currentBranch()).toBeNull();
		}));

	it("fails outside a repository", () => {
		const dir = mkdtempSync(join(tmpdir(), "herder-norepo-"));
		try {
			process.env.GIT_CEILING_DIRECTORIES = tmpdir();
			expect(() => openVcs(dir)).toThrow(/Herder needs a git working tree/);
		} finally {
			delete process.env.GIT_CEILING_DIRECTORIES;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("isClean", () => {
	it("counts modified and untracked files as dirty but not ignored ones", () =>
		withGitFixture((fixture) => {
			const vcs = openVcs(fixture.dir);
			expect(vcs.isClean()).toBe(true);
			fixture.write("ignored.log", "x\n");
			expect(vcs.isClean()).toBe(true);
			fixture.write("new.txt", "x\n");
			expect(vcs.isClean()).toBe(false);
			rmSync(join(fixture.dir, "new.txt"));
			fixture.write("README.md", "changed\n");
			expect(vcs.isClean()).toBe(false);
		}, { "README.md": "# r\n", ".gitignore": "*.log\n" }));

	it("checks a given worktree without looking at the checkout", () =>
		untouched((fixture, vcs) => {
			const path = slot(fixture);
			vcs.addWorktree(path, fixture.head());
			expect(vcs.isClean(path)).toBe(true);
			writeFileSync(join(path, "nested.txt"), "x\n");
			expect(vcs.isClean(path)).toBe(false);
			vcs.removeWorktree(path);
		}));
});

describe("worktreeHead", () => {
	it("reads a Herder worktree's HEAD, including commits made inside it, and refuses other paths", () =>
		untouched((fixture, vcs) => {
			const path = slot(fixture);
			vcs.addWorktree(path, fixture.head());
			expect(vcs.worktreeHead(path)).toBe(fixture.head());
			writeFileSync(join(path, "curated.txt"), "x\n");
			const commit = vcs.snapshot(path, "curated\n");
			expect(vcs.worktreeHead(path)).toBe(commit);
			expect(() => vcs.worktreeHead(fixture.dir)).toThrow(/refusing/);
			vcs.removeWorktree(path);
		}));
});

describe("worktrees", () => {
	it("adds a detached worktree under <common>/herder/worktrees/<runId>/<slot>", () =>
		untouched((fixture, vcs) => {
			const first = fixture.git("rev-parse", "HEAD~1");
			const path = slot(fixture);
			vcs.addWorktree(path, first);
			expect(existsSync(join(path, "README.md"))).toBe(true);
			expect(existsSync(join(path, "b.txt"))).toBe(false);
			expect(openVcs(path).head()).toBe(first);
			expect(openVcs(path).currentBranch()).toBeNull();
			expect(openVcs(path).commonDir()).toBe(vcs.commonDir());
			expect(worktreeList(fixture)).toContain(path);
			vcs.removeWorktree(path);
		}, undefined, (fixture) => fixture.commit("second", { "b.txt": "b\n" })));

	it("refuses to create a worktree inside the user's checkout", () =>
		untouched((fixture, vcs) => {
			expect(() => vcs.addWorktree(join(fixture.dir, "wt"), fixture.head())).toThrow(/only operates on worktrees inside/);
			expect(existsSync(join(fixture.dir, "wt"))).toBe(false);
		}));

	it("removes registered worktrees completely and idempotently", () =>
		untouched((fixture, vcs) => {
			const path = slot(fixture);
			vcs.addWorktree(path, fixture.head());
			writeFileSync(join(path, "dirty.txt"), "x\n");
			vcs.removeWorktree(path);
			expect(existsSync(path)).toBe(false);
			expect(worktreeList(fixture)).not.toContain(path);
			expect(fixture.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
			vcs.removeWorktree(path);
			vcs.removeWorktree(slot(fixture, "never-created"));
		}));

	it("removes half-created, already deleted, and locked worktrees", () =>
		untouched((fixture, vcs) => {
			const half = slot(fixture, "half");
			mkdirSync(half, { recursive: true });
			writeFileSync(join(half, "partial.txt"), "x\n");
			vcs.removeWorktree(half);
			expect(existsSync(half)).toBe(false);

			const deleted = slot(fixture, "deleted");
			vcs.addWorktree(deleted, fixture.head());
			rmSync(deleted, { recursive: true, force: true });
			vcs.removeWorktree(deleted);
			expect(worktreeList(fixture)).not.toContain(deleted);

			const locked = slot(fixture, "locked");
			vcs.addWorktree(locked, fixture.head());
			fixture.git("worktree", "lock", locked);
			vcs.removeWorktree(locked);
			expect(existsSync(locked)).toBe(false);
			expect(worktreeList(fixture)).not.toContain(locked);

			const lockedGone = slot(fixture, "locked-gone");
			vcs.addWorktree(lockedGone, fixture.head());
			fixture.git("worktree", "lock", lockedGone);
			rmSync(lockedGone, { recursive: true, force: true });
			vcs.removeWorktree(lockedGone);
			expect(worktreeList(fixture)).not.toContain(lockedGone);
			expect(fixture.git("worktree", "list").split("\n")).toHaveLength(1);

			vcs.addWorktree(locked, fixture.head()); // the slot is reusable
			vcs.removeWorktree(locked);
		}));

	it("refuses to remove the user's checkout or the repository", () =>
		untouched((fixture, vcs) => {
			expect(() => vcs.removeWorktree(fixture.dir)).toThrow(/refusing/);
			expect(() => vcs.removeWorktree(fixture.commonDir)).toThrow(/refusing/);
			expect(() => vcs.removeWorktree(join(fixture.dir, ".."))).toThrow(/refusing/);
		}));

	it("keeps the user's own stale worktree registrations", () =>
		withLinked((fixture, linked) => {
			rmSync(linked, { recursive: true, force: true }); // e.g. on an unmounted drive
			const vcs = openVcs(fixture.dir);
			const live = slot(fixture, "live");
			const gone = slot(fixture, "gone");
			vcs.addWorktree(live, fixture.head());
			vcs.addWorktree(gone, fixture.head());
			rmSync(gone, { recursive: true, force: true });
			vcs.removeWorktree(live);
			vcs.removeWorktree(gone);
			removeWorktrees(vcs, join(herderRoot(fixture), "20260101-000000-abcd"));
			expect(worktreeList(fixture)).toContain(`worktree ${linked}`);
			expect(worktreeList(fixture)).not.toContain(live);
			expect(worktreeList(fixture)).not.toContain(gone);
		}));

	it("removes every worktree and stale registration under a run directory", () =>
		untouched((fixture, vcs) => {
			const run = join(herderRoot(fixture), "20260101-000000-abcd");
			const [live, gone, locked, half] = ["live", "gone", "locked", "half"].map((name) => slot(fixture, name));
			const other = slot(fixture, "s1", "20260101-000000-ffff");
			for (const path of [live!, gone!, locked!, other]) vcs.addWorktree(path, fixture.head());
			writeFileSync(join(live!, "dirty.txt"), "x\n");
			rmSync(gone!, { recursive: true, force: true });
			fixture.git("worktree", "lock", locked!);
			mkdirSync(half!, { recursive: true });
			removeWorktrees(vcs, run);
			expect(existsSync(run)).toBe(false);
			expect(worktreeList(fixture).match(/^worktree /gm)).toHaveLength(2);
			expect(worktreeList(fixture)).toContain(other);
			removeWorktrees(vcs, run);
			expect(() => removeWorktrees(vcs, herderRoot(fixture))).toThrow(/only operates on worktrees inside/);
			expect(existsSync(other)).toBe(true);
			vcs.removeWorktree(other);
		}));

	it("does not run the user's hooks", () =>
		withGitFixture((fixture) => {
			const hooks = join(fixture.commonDir, "test-hooks");
			mkdirSync(hooks);
			for (const hook of ["post-checkout", "pre-commit", "commit-msg", "post-commit", "reference-transaction"]) writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch "${hooks}/ran-${hook}"\nexit 1\n`, { mode: 0o755 });
			fixture.git("config", "core.hooksPath", hooks);
			const vcs = openVcs(fixture.dir);
			const path = slot(fixture);
			vcs.addWorktree(path, fixture.head());
			writeFileSync(join(path, "x.txt"), "x\n");
			expect(vcs.snapshot(path, "herder step a-0\n")).toMatch(/^[0-9a-f]{40}$/);
			vcs.removeWorktree(path);
			expect(existsSync(join(hooks, "ran-post-checkout"))).toBe(false);
			expect(existsSync(join(hooks, "ran-pre-commit"))).toBe(false);
		}));

	it("does not run hooks defined in configuration, except when fast-forwarding", (context) =>
		withGitFixture((fixture) => {
			const log = join(fixture.commonDir, "spy.log");
			fixture.git("config", "hook.spy.command", `echo ran >> '${log}'`);
			for (const event of ["post-checkout", "reference-transaction", "post-index-change", "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "post-merge", "post-rewrite"]) fixture.git("config", "--add", "hook.spy.event", event);
			fixture.git("update-ref", "refs/spy-probe", "HEAD");
			if (!existsSync(log)) context.skip(); // this git predates hooks in configuration
			fixture.git("update-ref", "-d", "refs/spy-probe");
			rmSync(log);
			const vcs = openVcs(fixture.dir);
			const base = fixture.head();
			const path = slot(fixture);
			vcs.addWorktree(path, base);
			expect(vcs.isClean(path)).toBe(true);
			writeFileSync(join(path, "x.txt"), "x\n");
			const first = vcs.snapshot(path, "one\n")!;
			writeFileSync(join(path, "y.txt"), "y\n");
			const second = vcs.snapshot(path, "two\n", base)!;
			vcs.updateRef("refs/herder/run/integration", first, null);
			vcs.updateRef("refs/herder/run/integration", second, first);
			vcs.mergeTree(first, second, base);
			vcs.commitTree(vcs.treeOf(second), [base], "c\n");
			vcs.deleteRefs("refs/herder/run");
			vcs.removeWorktree(path);
			vcs.applyDiff(base, second);
			expect(existsSync(log)).toBe(false);
			for (const file of ["x.txt", "y.txt"]) rmSync(join(fixture.dir, file));
			vcs.fastForward(second);
			expect(existsSync(log)).toBe(true);
		}));
});

describe("worktree allowlist", () => {
	/** Paths outside `<common>/herder/worktrees/` (or that are its root) that every worktree method must refuse. */
	function outside(fixture: GitFixture, linked: string) {
		const root = herderRoot(fixture);
		mkdirSync(join(root, "run"), { recursive: true });
		symlinkSync(join(fixture.dir, "src"), join(root, "run", "link"));
		return [join(fixture.dir, "src"), linked, "", `${root}/run/../../../..`, `${root}/run/../..`, join(root, "run", "link"), join(root, "run", "link", "deeper"), root, `${root}/`, fixture.dir, fixture.commonDir, join(fixture.commonDir, "herder")];
	}

	it("refuses every other path before running git or touching files", () =>
		withLinked((fixture, linked) => {
			writeFileSync(join(linked, "untracked.txt"), "x\n");
			fixture.write("src/new.txt", "x\n");
			const vcs = openVcs(fixture.dir);
			const before = { head: fixture.head(), index: readFileSync(join(fixture.commonDir, "index")), linkedHead: fixture.git("-C", linked, "rev-parse", "HEAD") };
			// "" resolves against the cwd; point it into the fixture so a regression cannot reach the real cwd.
			vi.spyOn(process, "cwd").mockReturnValue(join(fixture.dir, "src"));
			try {
				for (const path of outside(fixture, linked)) {
					for (const call of [() => vcs.removeWorktree(path), () => vcs.snapshot(path, "x\n"), () => vcs.snapshot(path, "x\n", before.head), () => vcs.isClean(path), () => vcs.addWorktree(path, before.head)]) {
						expect(call, JSON.stringify(path)).toThrow(/only operates on worktrees inside/);
					}
				}
			} finally {
				vi.restoreAllMocks();
			}
			expect(fixture.read("src/a.txt")).toBe("a\n");
			expect(fixture.read("src/new.txt")).toBe("x\n");
			expect(fixture.head()).toBe(before.head);
			expect(readFileSync(join(fixture.commonDir, "index")).equals(before.index)).toBe(true);
			expect(readFileSync(join(linked, "untracked.txt"), "utf8")).toBe("x\n");
			expect(fixture.git("-C", linked, "symbolic-ref", "HEAD")).toBe("refs/heads/side");
			expect(fixture.git("-C", linked, "rev-parse", "HEAD")).toBe(before.linkedHead);
			expect(fixture.git("-C", linked, "status", "--porcelain")).toBe("?? untracked.txt");
			expect(worktreeList(fixture)).toContain(`worktree ${linked}`);
		}, { "README.md": "# r\n", "src/a.txt": "a\n" }));

	it("refuses a Herder worktree whose .git file points at another git dir", () =>
		untouched((fixture, vcs) => {
			const path = slot(fixture);
			vcs.addWorktree(path, fixture.head());
			writeFileSync(join(path, "x.txt"), "x\n");
			writeFileSync(join(path, ".git"), `gitdir: ${fixture.commonDir}\n`);
			expect(() => vcs.snapshot(path, "x\n")).toThrow(/not a Herder worktree/);
			expect(() => vcs.isClean(path)).toThrow(/not a Herder worktree/);
			vcs.removeWorktree(path);
			expect(existsSync(path)).toBe(false);
		}));
});

describe("snapshot", () => {
	it("returns null when nothing changed and commits every change otherwise", () =>
		untouched((fixture, vcs) => {
			const base = fixture.head();
			const path = slot(fixture);
			vcs.addWorktree(path, base);
			expect(vcs.snapshot(path, "nothing\n")).toBeNull();
			writeFileSync(join(path, "new.txt"), "new\n");
			writeFileSync(join(path, "build.log"), "ignored\n");
			rmSync(join(path, "old.txt"));
			mkdirSync(join(path, "deep", "er"), { recursive: true });
			writeFileSync(join(path, "deep", "er", "file.txt"), "deep\n");
			const message = `herder step a-0\n\n${TRAILER_STEP}: a-0\n${TRAILER_FINGERPRINT}: f00d\n`;
			const commit = vcs.snapshot(path, message);
			expect(commit).toMatch(/^[0-9a-f]{40}$/);
			expect(vcs.parentsOf(commit!)).toEqual([base]);
			expect(vcs.message(commit!)).toBe(message);
			expect(vcs.trailers(commit!)).toEqual({ [TRAILER_STEP.toLowerCase()]: "a-0", [TRAILER_FINGERPRINT.toLowerCase()]: "f00d" });
			expect(fixture.git("ls-tree", "-r", "--name-only", commit!).split("\n")).toEqual([".gitignore", "README.md", "deep/er/file.txt", "new.txt"]);
			expect(openVcs(path).head()).toBe(commit);
			expect(vcs.isClean(path)).toBe(true);
			expect(vcs.snapshot(path, "again\n")).toBeNull();
			writeFileSync(join(path, "new.txt"), "newer\n");
			expect(vcs.parentsOf(vcs.snapshot(path, "second\n")!)).toEqual([commit]);
			vcs.removeWorktree(path);
		}, { "README.md": "# r\n", "old.txt": "old\n", ".gitignore": "*.log\n" }));

	it("refuses the user's checkout, a subdirectory of a Herder worktree, and a plain directory", () =>
		untouched((fixture, vcs) => {
			expect(() => vcs.snapshot(fixture.dir, "x")).toThrow(/only operates on worktrees inside/);
			const path = slot(fixture);
			vcs.addWorktree(path, fixture.head());
			writeFileSync(join(path, "src", "b.txt"), "b\n");
			expect(() => vcs.snapshot(join(path, "src"), "x")).toThrow(/not a Herder worktree/);
			mkdirSync(slot(fixture, "plain"));
			expect(() => vcs.snapshot(slot(fixture, "plain"), "x")).toThrow();
			expect(openVcs(path).head()).toBe(fixture.head());
			vcs.removeWorktree(join(herderRoot(fixture), "20260101-000000-abcd"));
		}, { "src/a.txt": "a\n" }));

	it("with a base, squashes the agent's own commits and changes into one commit on the base", () =>
		untouched((fixture, vcs) => {
			const base = fixture.head();
			const path = slot(fixture);
			vcs.addWorktree(path, base);
			const agent = (...args: string[]) => fixture.git("-C", path, ...args);
			writeFileSync(join(path, "a.txt"), "a\n");
			agent("add", "a.txt");
			agent("commit", "-q", "-m", "agent one");
			agent("checkout", "-q", "-b", "agent-branch");
			writeFileSync(join(path, "b.txt"), "b\n");
			agent("add", "b.txt");
			agent("commit", "-q", "-m", "agent two");
			const agentTip = agent("rev-parse", "HEAD");
			writeFileSync(join(path, "c.txt"), "c\n");
			writeFileSync(join(path, "README.md"), "changed\n");
			writeFileSync(join(path, "x.log"), "ignored\n");
			const commit = vcs.snapshot(path, "herder step a-0\n", base.slice(0, 12))!;
			expect(commit).toMatch(/^[0-9a-f]{40}$/);
			expect(vcs.parentsOf(commit)).toEqual([base]);
			expect(vcs.message(commit)).toBe("herder step a-0\n");
			expect(fixture.git("ls-tree", "-r", "--name-only", commit).split("\n")).toEqual([".gitignore", "README.md", "a.txt", "b.txt", "c.txt"]);
			expect(fixture.git("show", `${commit}:README.md`)).toBe("changed");
			expect(openVcs(path).head()).toBe(commit);
			expect(openVcs(path).currentBranch()).toBeNull();
			expect(fixture.git("rev-parse", "refs/heads/agent-branch")).toBe(agentTip);
			expect(vcs.snapshot(path, "same\n", commit)).toBeNull();
			vcs.removeWorktree(path);
			fixture.git("branch", "-q", "-D", "agent-branch");
		}, { "README.md": "# r\n", ".gitignore": "*.log\n" }));

	it("with a base, counts committed-only work and returns null when the agent's commits net out", () =>
		untouched((fixture, vcs) => {
			const base = fixture.head();
			const path = slot(fixture);
			vcs.addWorktree(path, base);
			writeFileSync(join(path, "a.txt"), "a\n");
			fixture.git("-C", path, "add", "a.txt");
			fixture.git("-C", path, "commit", "-q", "-m", "agent");
			const agentCommit = fixture.git("-C", path, "rev-parse", "HEAD");
			const commit = vcs.snapshot(path, "step\n", base)!;
			expect(vcs.parentsOf(commit)).toEqual([base]);
			expect(vcs.treeOf(commit)).toBe(vcs.treeOf(agentCommit));
			rmSync(join(path, "a.txt"));
			fixture.git("-C", path, "commit", "-q", "-am", "agent reverts");
			expect(vcs.snapshot(path, "step\n", base)).toBeNull();
			vcs.removeWorktree(path);
		}));

	it("falls back to Herder's identity when none is configured", () =>
		withGitFixture((fixture) => {
			fixture.git("config", "--unset", "user.name");
			fixture.git("config", "--unset", "user.email");
			const saved = { ...process.env };
			for (const name of ["EMAIL", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete process.env[name];
			try {
				const vcs = openVcs(fixture.dir);
				const path = slot(fixture);
				vcs.addWorktree(path, fixture.head());
				writeFileSync(join(path, "x.txt"), "x\n");
				const commit = vcs.snapshot(path, "internal\n")!;
				expect(fixture.git("log", "-1", "--format=%an <%ae>|%cn <%ce>", commit)).toBe("Herder <herder@localhost>|Herder <herder@localhost>");
				vcs.removeWorktree(path);
			} finally {
				process.env = saved;
			}
		}));
});

describe("refs", () => {
	it("reads, creates, compares-and-swaps, and updates unconditionally", () =>
		untouched((fixture, vcs) => {
			const a = fixture.head();
			const b = vcs.commitTree(vcs.treeOf(a), [a], "b\n");
			const c = vcs.commitTree(vcs.treeOf(a), [b], "c\n");
			const ref = "refs/herder/run/integration";
			expect(vcs.readRef(ref)).toBeNull();
			vcs.updateRef(ref, a, null);
			expect(vcs.readRef(ref)).toBe(a);
			expect(() => vcs.updateRef(ref, b, null)).toThrow(RefConflictError);
			vcs.updateRef(ref, b, a);
			expect(vcs.readRef(ref)).toBe(b);
			let error: unknown;
			try {
				vcs.updateRef(ref, c, a);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(RefConflictError);
			expect(error).toMatchObject({ ref, expected: a, actual: b });
			expect(vcs.readRef(ref)).toBe(b);
			vcs.updateRef(ref, c);
			expect(vcs.readRef(ref)).toBe(c);
			vcs.updateRef("refs/herder/run/missing", a);
			expect(vcs.readRef("refs/herder/run/missing")).toBe(a);
			expect(() => vcs.updateRef("refs/herder/run/never", b, a)).toThrow(RefConflictError);
			expect(() => vcs.updateRef("HEAD", b)).toThrow(/only full names under refs/);
			expect(() => vcs.updateRef("main", b)).toThrow(/only full names under refs/);
		}));

	it("rejects values and expected old values that are not full object ids", () =>
		untouched((fixture, vcs) => {
			const head = fixture.head();
			const ref = "refs/herder/run/x";
			for (const bad of [`${head}\ndelete refs/heads/main`, `${head} ${head}`, head.slice(0, 12), head.toUpperCase(), `${head}0`, "HEAD", "main", ""]) {
				expect(() => vcs.updateRef(ref, bad), JSON.stringify(bad)).toThrow(/not a full object id/);
				expect(() => vcs.updateRef(ref, head, bad), JSON.stringify(bad)).toThrow(/not a full object id/);
			}
			expect(() => vcs.updateRef(`${ref}\ndelete refs/heads/main`, head)).toThrow(/only full names under refs/);
			expect(vcs.readRef("refs/heads/main")).toBe(head);
			expect(vcs.readRef(ref)).toBeNull();
			vcs.updateRef("refs/heads/herder/20260101-000000-abcd", head, null); // branch delivery
			expect(vcs.readRef("refs/heads/herder/20260101-000000-abcd")).toBe(head);
		}));

	it("deletes every ref under a prefix and nothing else", () =>
		untouched((fixture, vcs) => {
			const head = fixture.head();
			for (const ref of ["refs/herder/run1/base", "refs/herder/run1/integration", "refs/herder/run1/steps/a-0", "refs/herder/run10/base", "refs/herder/run2/base"]) vcs.updateRef(ref, head, null);
			vcs.deleteRefs("refs/herder/run1");
			expect(fixture.git("for-each-ref", "--format=%(refname)", "refs/herder").split("\n")).toEqual(["refs/herder/run10/base", "refs/herder/run2/base"]);
			vcs.deleteRefs("refs/herder/run1/");
			vcs.deleteRefs("refs/herder/run2/");
			expect(vcs.readRef("refs/herder/run2/base")).toBeNull();
			expect(vcs.readRef("refs/herder/run10/base")).toBe(head);
			for (const prefix of ["refs/herder/*", "herder", "refs/herder/", "refs/herder", "refs/herder//", "refs/heads", "refs/heads/", "refs/", "", "refs/herder//run10", "refs/herder/run 10", "refs/herder/./run10", "refs/herder/../heads", "refs/herder/run1?", "refs/herder/run1\\x"]) {
				expect(() => vcs.deleteRefs(prefix), JSON.stringify(prefix)).toThrow(/only refs\/herder\/<runId>/);
			}
			expect(vcs.readRef("refs/herder/run10/base")).toBe(head);
			expect(vcs.readRef("refs/heads/main")).toBe(head);
		}));
});

describe("objects", () => {
	it("resolves commits, trees, parents, messages, and trailers", () =>
		untouched((fixture, vcs) => {
			const a = fixture.head();
			fixture.git("tag", "v1");
			expect(vcs.resolve("HEAD")).toBe(a);
			expect(vcs.resolve("v1")).toBe(a);
			expect(vcs.resolve(a.slice(0, 10))).toBe(a);
			expect(() => vcs.resolve("nope")).toThrow(/not a commit: nope/);
			expect(() => vcs.resolve(vcs.treeOf(a))).toThrow(/not a commit/);
			expect(() => vcs.resolve("--all")).toThrow(/not a commit/);
			expect(vcs.treeOf(a)).toBe(fixture.git("rev-parse", "HEAD^{tree}"));
			expect(vcs.parentsOf(a)).toEqual([]);
			const b = vcs.commitTree(vcs.treeOf(a), [a], "b\n");
			const merge = vcs.commitTree(vcs.treeOf(a), [a, b], "Subject line\n\nBody  with  spaces\n\n\n  indented\n\nSigned-off-by: Someone <s@example.test>\nHerder-Step: x-1\n");
			expect(vcs.parentsOf(merge)).toEqual([a, b]);
			expect(vcs.message(merge)).toBe("Subject line\n\nBody  with  spaces\n\n\n  indented\n\nSigned-off-by: Someone <s@example.test>\nHerder-Step: x-1\n");
			expect(vcs.trailers(merge)).toEqual({ "signed-off-by": "Someone <s@example.test>", "herder-step": "x-1" });
			expect(vcs.trailers(b)).toEqual({});
			expect(vcs.message(vcs.commitTree(vcs.treeOf(a), [], "no newline"))).toBe("no newline\n");
			expect(fixture.git("log", "-1", "--format=%an <%ae>", merge)).toBe("Herder Test <herder@example.test>");
		}));

	it("reads lowercased trailer keys from the final trailer block only", () =>
		untouched((fixture, vcs) => {
			const a = fixture.head();
			const commit = vcs.commitTree(vcs.treeOf(a), [a], "Subject\n\nHerder-Step: in-the-body\nprose that is not a trailer\n\nherder-STEP: x-1\nHERDER-Fingerprint: f00d\n");
			expect(vcs.trailers(commit)).toEqual({ "herder-step": "x-1", "herder-fingerprint": "f00d" });
			expect(vcs.trailers(commit)[TRAILER_FINGERPRINT.toLowerCase()]).toBe("f00d");
			// The user's trailer.separators does not change what counts as a trailer.
			fixture.git("config", "trailer.separators", ":#");
			expect(vcs.trailers(vcs.commitTree(vcs.treeOf(a), [a], "Subject\n\nHerder-Step# x-1\n"))).toEqual({});
		}));

	it("detects Herder trailer lines anywhere in a message", () => {
		expect(hasHerderTrailer("fix: x\n\nHerder-Step: a-0\n")).toBe(true);
		expect(hasHerderTrailer("fix\n\nherder-fingerprint : f\nmore prose\n")).toBe(true);
		expect(hasHerderTrailer("fix\n\nHERDER-STEP:x")).toBe(true);
		expect(hasHerderTrailer("Herder-:x")).toBe(true);
		expect(hasHerderTrailer("fix: mention Herder-Step: inline\n")).toBe(false);
		expect(hasHerderTrailer("feat(herder): add it\n\nHerder: the tool\nherder-step is a word\n")).toBe(false);
	});

	it("never signs commits", () =>
		untouched((fixture, vcs) => {
			const marker = join(fixture.commonDir, "signed");
			const program = join(fixture.commonDir, "fake-gpg");
			writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
			fixture.git("config", "commit.gpgSign", "true");
			fixture.git("config", "gpg.program", program);
			const a = fixture.head();
			const commit = vcs.commitTree(vcs.treeOf(a), [a], "x\n");
			const path = slot(fixture);
			vcs.addWorktree(path, a);
			writeFileSync(join(path, "x.txt"), "x\n");
			const snapshot = vcs.snapshot(path, "s\n", a)!;
			vcs.removeWorktree(path);
			expect(fixture.git("cat-file", "commit", commit)).not.toContain("gpgsig");
			expect(fixture.git("cat-file", "commit", snapshot)).not.toContain("gpgsig");
			expect(existsSync(marker)).toBe(false);
		}));

	it("lists revisions oldest first and summarises diffs", () =>
		untouched((fixture, vcs) => {
			const base = fixture.head();
			const path = slot(fixture);
			vcs.addWorktree(path, base);
			writeFileSync(join(path, "a.txt"), "1\n2\n3\n");
			const first = vcs.snapshot(path, "one\n")!;
			writeFileSync(join(path, "a.txt"), "1\nTWO\n3\n");
			writeFileSync(join(path, "bin.dat"), Buffer.from([0, 1, 2, 0, 255]));
			const second = vcs.snapshot(path, "two\n")!;
			vcs.removeWorktree(path);
			expect(vcs.revList(`${base}..${second}`)).toEqual([first, second]);
			expect(vcs.revList(`${second}..${second}`)).toEqual([]);
			expect(vcs.diffStat(`${base}..${second}`)).toMatch(/a\.txt +\| +3 \+\+\+\n bin\.dat +\| Bin 0 -> 5 bytes\n 2 files changed, 3 insertions\(\+\)$/);
			expect(vcs.changedLines(`${base}..${first}`)).toBe(3);
			expect(vcs.changedLines(`${first}..${second}`)).toBe(3); // 1 added + 1 deleted + 1 binary
			expect(vcs.changedLines(`${second}..${second}`)).toBe(0);
		}));
});

describe("mergeTree", () => {
	function sides(fixture: GitFixture, vcs: Vcs, ours: Record<string, string>, theirs: Record<string, string>) {
		const base = fixture.head();
		const commitWith = (files: Record<string, string>, name: string) => {
			const path = slot(fixture, name);
			vcs.addWorktree(path, base);
			for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
			const commit = vcs.snapshot(path, `${name}\n`)!;
			vcs.removeWorktree(path);
			return commit;
		};
		return { base, ours: commitWith(ours, "ours"), theirs: commitWith(theirs, "theirs") };
	}
	const files = { "f.txt": "a\nb\nc\nd\ne\n", "g.txt": "g\n", "h.txt": "h\n" };

	it("reports a clean merge with its tree", () =>
		untouched((fixture, vcs) => {
			const { ours, theirs } = sides(fixture, vcs, { "f.txt": "A\nb\nc\nd\ne\n", "new.txt": "n\n" }, { "f.txt": "a\nb\nc\nd\nE\n" });
			const result = vcs.mergeTree(ours, theirs);
			expect(result).toMatchObject({ clean: true, conflicts: [] });
			expect(fixture.git("show", `${result.tree}:f.txt`)).toBe("A\nb\nc\nd\nE");
			expect(fixture.git("show", `${result.tree}:new.txt`)).toBe("n");
		}, files));

	it("reports conflicted paths once each", () =>
		untouched((fixture, vcs) => {
			const { ours, theirs } = sides(fixture, vcs, { "f.txt": "X\nb\nc\nd\nX\n", "g.txt": "ours\n", "h.txt": "fine\n" }, { "f.txt": "Y\nb\nc\nd\nY\n", "g.txt": "theirs\n" });
			const result = vcs.mergeTree(ours, theirs);
			expect(result.clean).toBe(false);
			expect(result.tree).toMatch(/^[0-9a-f]{40}$/);
			expect(result.conflicts).toEqual(["f.txt", "g.txt"]);
		}, files));

	it("throws on a fatal merge-tree error", () =>
		untouched((fixture, vcs) => {
			const unrelated = vcs.commitTree(vcs.treeOf(fixture.head()), [], "orphan\n");
			expect(() => vcs.mergeTree(fixture.head(), unrelated)).toThrow(/merge-tree/);
			expect(() => vcs.mergeTree("nope", fixture.head())).toThrow(/not a commit/);
		}));

	it("replays one commit onto a new parent with an explicit merge base", () =>
		untouched((fixture, vcs) => {
			// `ours` is the new parent; replaying `theirs` (parent base) must apply only theirs's own change.
			const { base, ours, theirs } = sides(fixture, vcs, { "g.txt": "moved on\n" }, { "f.txt": "a\nb\nC\nd\ne\n" });
			const onTop = vcs.commitTree(vcs.treeOf(theirs), [theirs], "later\n");
			const replay = vcs.mergeTree(ours, theirs, base);
			expect(replay.clean).toBe(true);
			expect(fixture.git("show", `${replay.tree}:g.txt`)).toBe("moved on");
			expect(fixture.git("show", `${replay.tree}:f.txt`)).toBe("a\nb\nC\nd\ne");
			// Replaying `onTop` (no changes of its own relative to `theirs`) onto `ours` with base `theirs`: ours's tree minus nothing.
			const empty = vcs.mergeTree(ours, onTop, theirs);
			expect(empty.clean).toBe(true);
			expect(fixture.git("show", `${empty.tree}:f.txt`)).toBe("a\nb\nc\nd\ne");
		}, files));

	it("reports a conflicting replay", () =>
		untouched((fixture, vcs) => {
			const { base, ours, theirs } = sides(fixture, vcs, { "f.txt": "a\nb\nOURS\nd\ne\n" }, { "f.txt": "a\nb\nTHEIRS\nd\ne\n" });
			expect(vcs.mergeTree(ours, theirs, base)).toMatchObject({ clean: false, conflicts: ["f.txt"] });
		}, files));
});

describe("delivery", () => {
	it("fast-forwards the user's branch and refuses a non-fast-forward", () =>
		withGitFixture((fixture) => {
			const vcs = openVcs(fixture.dir);
			const base = fixture.head();
			const path = slot(fixture);
			vcs.addWorktree(path, base);
			writeFileSync(join(path, "a.txt"), "a\n");
			const tip = vcs.snapshot(path, "tip\n")!;
			vcs.removeWorktree(path);
			vcs.fastForward(tip);
			expect(fixture.head()).toBe(tip);
			expect(vcs.currentBranch()).toBe("main");
			expect(fixture.read("a.txt")).toBe("a\n");
			expect(fixture.status()).toBe("");
			const sibling = vcs.commitTree(vcs.treeOf(base), [base], "sibling\n");
			expect(() => vcs.fastForward(sibling)).toThrow(/merge --ff-only/);
			expect(fixture.head()).toBe(tip);
		}));

	it("applies new, deleted, renamed, modified, and binary changes unstaged", () =>
		withGitFixture((fixture) => {
			const vcs = openVcs(fixture.dir);
			const base = fixture.head();
			const path = slot(fixture);
			vcs.addWorktree(path, base);
			writeFileSync(join(path, "new.txt"), "new\n");
			rmSync(join(path, "gone.txt"));
			rmSync(join(path, "rename-me.txt"));
			writeFileSync(join(path, "renamed.txt"), "a long enough line to be detected as a rename\nsecond line\n");
			writeFileSync(join(path, "edit.txt"), "edited\n");
			writeFileSync(join(path, "image.bin"), Buffer.from([0, 159, 146, 150, 0, 1, 2]));
			const tip = vcs.snapshot(path, "tip\n")!;
			vcs.removeWorktree(path);
			const indexBefore = readFileSync(join(fixture.commonDir, "index"));
			vcs.applyDiff(base, tip);
			expect(fixture.head()).toBe(base);
			expect(readFileSync(join(fixture.commonDir, "index")).equals(indexBefore)).toBe(true);
			expect(fixture.git("diff", "--cached", "--name-only")).toBe("");
			expect(fixture.read("new.txt")).toBe("new\n");
			expect(fixture.read("renamed.txt")).toBe("a long enough line to be detected as a rename\nsecond line\n");
			expect(fixture.read("edit.txt")).toBe("edited\n");
			expect(existsSync(join(fixture.dir, "gone.txt"))).toBe(false);
			expect(existsSync(join(fixture.dir, "rename-me.txt"))).toBe(false);
			expect(readFileSync(join(fixture.dir, "image.bin")).equals(Buffer.from([0, 159, 146, 150, 0, 1, 2]))).toBe(true);
			// The working tree now holds exactly the tip's tree.
			fixture.git("add", "-A");
			expect(fixture.git("write-tree")).toBe(vcs.treeOf(tip));
		}, { "README.md": "# r\n", "gone.txt": "gone\n", "rename-me.txt": "a long enough line to be detected as a rename\nsecond line\n", "edit.txt": "edit\n", "image.bin": "\0old\0" }));
});
