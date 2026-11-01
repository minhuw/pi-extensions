import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGit } from "../src/git.ts";
import { DIRTY_WORKTREE_PROMPT, mergeTicket, rebasePrompt } from "../src/merge.ts";
import { openStore } from "../src/store.ts";
import type { Git, MergeDeps, Repo, Ticket, TicketStore } from "../src/types.ts";

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
interface Harness {
	t: TestRepo;
	repo: Repo;
	store: TicketStore;
	git: Git;
	deps: MergeDeps;
	running: Set<number>;
	sent: Array<[number, string]>;
	stopped: number[];
}

const git = createGit();
const repos: TestRepo[] = [];
afterEach(() => {
	for (const t of repos.splice(0)) t.cleanup();
});

/** A repository and fake MergeDeps; `checkout` is the main checkout (default: the repository's top level). */
async function harness(setup?: (t: TestRepo) => string): Promise<Harness> {
	const t = createTestRepo();
	repos.push(t);
	const checkout = setup ? setup(t) : t.dir;
	const repo = (await git.open(checkout)) as Repo;
	const store = openStore(repo.commonDir);
	const running = new Set<number>();
	const sent: Array<[number, string]> = [];
	const stopped: number[] = [];
	const deps: MergeDeps = {
		store,
		git,
		repo,
		isRunning: (id) => running.has(id),
		send: async (id, text) => {
			sent.push([id, text]);
		},
		stop: async (id) => {
			stopped.push(id);
		},
	};
	return { t, repo, store, git, deps, running, sent, stopped };
}

/** A ready ticket with its worktree, and a commit of `files` on its branch unless null. */
async function readyTicket(h: Harness, title: string, files: Record<string, string> | null): Promise<Ticket> {
	const created = h.store.create(
		{ title, request: title, source: title, createdBy: "main", base: await git.revParse(h.repo.topLevel), target: await git.branch(h.repo.topLevel) },
		"main",
	);
	await git.addWorktree(h.repo, created.worktree, created.branch, created.base);
	if (files) h.t.commit(created.worktree, title, files);
	return h.store.update(created.id, { state: "ready", report: { state: "ready", summary: "done", at: Date.now() } }, { type: "report", state: "ready" });
}

const without = (ticket: Ticket | undefined, ...keys: string[]) => {
	const copy: Record<string, unknown> = { ...ticket };
	for (const key of ["updatedAt", ...keys]) delete copy[key];
	return copy;
};

describe("refusals", () => {
	it("refuses unknown and final tickets", async () => {
		const h = await harness();
		expect(await mergeTicket(h.deps, 9)).toEqual({ kind: "refused", reason: "Ticket #9 does not exist." });
		const ticket = await readyTicket(h, "work", { "a.txt": "a\n" });
		h.store.update(ticket.id, { state: "closed" });
		const outcome = await mergeTicket(h.deps, ticket.id);
		expect(outcome).toEqual({ kind: "refused", reason: expect.stringMatching(/already closed/) });
		expect(h.sent).toEqual([]);
	});

	it("refuses while the worker runs", async () => {
		const h = await harness();
		const ticket = await readyTicket(h, "work", { "a.txt": "a\n" });
		h.running.add(ticket.id);
		expect(await mergeTicket(h.deps, ticket.id)).toEqual({ kind: "refused", reason: expect.stringMatching(/still running/) });
		expect(h.stopped).toEqual([]);
		expect(await git.branchExists(h.repo, ticket.branch)).toBe(true);
	});

	it("refuses a dirty worktree and asks the worker to commit or discard", async () => {
		const h = await harness();
		const ticket = await readyTicket(h, "work", { "a.txt": "a\n" });
		writeFileSync(join(ticket.worktree, "leftover.txt"), "x");
		const outcome = await mergeTicket(h.deps, ticket.id);
		expect(outcome).toEqual({ kind: "refused", reason: expect.stringMatching(/uncommitted changes.*asked to commit or discard/) });
		expect(h.sent).toEqual([[ticket.id, DIRTY_WORKTREE_PROMPT]]);
		expect(h.store.get(ticket.id)?.state).toBe("ready");
	});

	it("refuses a branch without commits ahead of its base", async () => {
		const h = await harness();
		const ticket = await readyTicket(h, "nothing", null);
		expect(await mergeTicket(h.deps, ticket.id)).toEqual({ kind: "refused", reason: expect.stringMatching(/no commits ahead of its base/) });
	});

	it("refuses when the main checkout is on a detached HEAD", async () => {
		const h = await harness();
		const ticket = await readyTicket(h, "work", { "a.txt": "a\n" });
		h.t.git(h.t.dir, "checkout", "-q", "--detach");
		expect(await mergeTicket(h.deps, ticket.id)).toEqual({ kind: "refused", reason: expect.stringMatching(/detached HEAD/) });
		expect(await git.branchExists(h.repo, ticket.branch)).toBe(true);
	});

	it("refuses when the main checkout's changes block the fast-forward, leaving the ticket ready", async () => {
		const h = await harness();
		const ticket = await readyTicket(h, "edit readme", { "README.md": "# ticket\n" });
		const before = h.store.get(ticket.id);
		const mainTip = await git.revParse(h.t.dir);
		writeFileSync(join(h.t.dir, "README.md"), "# local edit\n");
		const outcome = await mergeTicket(h.deps, ticket.id);
		expect(outcome.kind).toBe("refused");
		expect(outcome.kind === "refused" && outcome.reason).toMatch(/^git refused to fast-forward main to pi\/1-edit-readme: .*would be overwritten by merge/);
		expect(outcome.kind === "refused" && outcome.reason).not.toContain("\n");
		expect(h.store.get(ticket.id)).toEqual(before);
		expect(await git.revParse(h.t.dir)).toBe(mainTip);
		expect(existsSync(ticket.worktree)).toBe(true);
		expect(await git.branchExists(h.repo, ticket.branch)).toBe(true);
		expect(h.stopped).toEqual([]);
		expect(readFileSync(join(h.t.dir, "README.md"), "utf8")).toBe("# local edit\n");
	});
});

describe("merging", () => {
	it("fast-forwards directly, then stops the worker, removes the worktree, deletes the branch, and records merged", async () => {
		const h = await harness();
		const ticket = await readyTicket(h, "add files", { "a.txt": "a\n" });
		h.t.commit(ticket.worktree, "second", { "b.txt": "b\n" });
		const tip = await git.revParse(ticket.worktree);
		h.store.update(ticket.id, { mergeRequested: true });

		expect(await mergeTicket(h.deps, ticket.id)).toEqual({ kind: "merged", into: "main", commits: 2 });
		expect(await git.revParse(h.t.dir)).toBe(tip);
		expect(await git.isClean(h.t.dir)).toBe(true);
		expect(h.stopped).toEqual([ticket.id]);
		expect(h.sent).toEqual([]);
		expect(existsSync(ticket.worktree)).toBe(false);
		expect(h.t.git(h.t.dir, "worktree", "list", "--porcelain")).not.toContain(ticket.worktree);
		expect(await git.branchExists(h.repo, ticket.branch)).toBe(false);

		const merged = h.store.get(ticket.id);
		expect(merged).toMatchObject({ state: "merged", mergedInto: "main", mergedAt: expect.any(Number) });
		expect(merged && "mergeRequested" in merged).toBe(false);
		expect(h.store.events(ticket.id).at(-1)).toMatchObject({ type: "merged", into: "main", commits: 2, branchDeleted: true });
		expect(h.store.events(ticket.id).some((e) => e.type === "rebased")).toBe(false);

		expect(await mergeTicket(h.deps, ticket.id)).toEqual({ kind: "refused", reason: expect.stringMatching(/already merged/) });
	});

	it("rebases onto a moved target, then fast-forwards", async () => {
		const h = await harness();
		const ticket = await readyTicket(h, "add a", { "a.txt": "a\n" });
		const mainTip = h.t.commit(h.t.dir, "main moves", { "b.txt": "b\n" });

		expect(await mergeTicket(h.deps, ticket.id)).toEqual({ kind: "merged", into: "main", commits: 1 });
		expect(await git.isAncestor(h.repo, mainTip, "main")).toBe(true);
		expect(h.t.git(h.t.dir, "rev-list", "--count", `${mainTip}..main`)).toBe("1");
		expect(readFileSync(join(h.t.dir, "a.txt"), "utf8")).toBe("a\n");
		expect(readFileSync(join(h.t.dir, "b.txt"), "utf8")).toBe("b\n");
		expect(await git.branchExists(h.repo, ticket.branch)).toBe(false);
		expect(h.store.events(ticket.id).map((e) => e.type)).toEqual(["created", "report", "rebased", "merged"]);
		expect(h.store.get(ticket.id)?.state).toBe("merged");
	});

	it("hands a conflicting rebase to the worker and leaves the ticket otherwise unchanged", async () => {
		const h = await harness();
		const ticket = await readyTicket(h, "edit readme", { "README.md": "# ticket\n" });
		const tip = await git.revParse(ticket.worktree);
		const mainTip = h.t.commit(h.t.dir, "main edits readme", { "README.md": "# main\n" });
		const before = h.store.get(ticket.id);

		const outcome = await mergeTicket(h.deps, ticket.id);
		expect(outcome).toEqual({ kind: "handed-to-worker", reason: expect.stringMatching(/conflicts with main in README\.md/) });
		expect(h.sent).toEqual([[ticket.id, rebasePrompt("main", mainTip)]]);
		expect(rebasePrompt("main", mainTip)).toBe(
			`Merge requested: your branch no longer applies on top of \`main\` (\`${mainTip}\`). Rebase onto \`${mainTip}\`, resolve the conflicts keeping both sides' intent, rerun the relevant checks, commit, and report ready. Do not modify \`main\` yourself.`,
		);
		const after = h.store.get(ticket.id);
		expect(after?.mergeRequested).toBe(true);
		expect(without(after, "mergeRequested")).toEqual(without(before));
		expect(h.store.events(ticket.id).at(-1)).toMatchObject({ type: "merge-handed-to-worker", target: "main", onto: mainTip, conflicts: ["README.md"] });
		expect(await git.revParse(ticket.worktree)).toBe(tip);
		expect(await git.isClean(ticket.worktree)).toBe(true);
		expect(await git.revParse(h.t.dir)).toBe(mainTip);
		expect(h.stopped).toEqual([]);
	});

	it("merges into a main checkout that is itself a linked worktree", async () => {
		const h = await harness((t) => {
			const linked = join(t.scratch, "dev-checkout");
			t.git(t.dir, "worktree", "add", "-q", "-b", "dev", linked);
			t.commit(linked, "dev work", { "dev.txt": "dev\n" });
			return linked;
		});
		const linked = join(h.t.scratch, "dev-checkout");
		expect(h.repo).toEqual({ topLevel: linked, commonDir: join(h.t.dir, ".git") });
		const mainBefore = h.t.git(h.t.dir, "rev-parse", "main");
		const ticket = await readyTicket(h, "on dev", { "a.txt": "a\n" });
		expect(ticket.target).toBe("dev");
		const tip = await git.revParse(ticket.worktree);

		expect(await mergeTicket(h.deps, ticket.id)).toEqual({ kind: "merged", into: "dev", commits: 1 });
		expect(await git.revParse(linked)).toBe(tip);
		expect(readFileSync(join(linked, "a.txt"), "utf8")).toBe("a\n");
		expect(h.t.git(h.t.dir, "rev-parse", "main")).toBe(mainBefore);
		expect(await git.isClean(h.t.dir)).toBe(true);
		expect(existsSync(ticket.worktree)).toBe(false);
		expect(await git.branchExists(h.repo, ticket.branch)).toBe(false);
		expect(h.store.get(ticket.id)).toMatchObject({ state: "merged", mergedInto: "dev" });
	});

	it("keeps the branch and says so when deleting it fails", async () => {
		const h = await harness();
		h.deps.git = { ...git, deleteBranch: async () => Promise.reject(new Error("cannot delete\nbranch")) };
		const ticket = await readyTicket(h, "work", { "a.txt": "a\n" });
		expect(await mergeTicket(h.deps, ticket.id)).toEqual({ kind: "merged", into: "main", commits: 1 });
		expect(await git.branchExists(h.repo, ticket.branch)).toBe(true);
		expect(h.store.events(ticket.id).at(-1)).toMatchObject({
			type: "merged",
			branchDeleted: false,
			note: `branch ${ticket.branch} was kept: cannot delete branch`,
		});
		expect(h.store.get(ticket.id)?.state).toBe("merged");
	});
});
