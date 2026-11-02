// Workspace modes against a real git repository with the real store, git, and dispatcher (the worker host is a fake):
// the mode file, the dirty-workspace refusal, shared tickets that never touch the main checkout's git state, and the
// pure helpers of shared mode (the git command parse, rendering).
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDispatcher, DirtyWorkspaceError, type Dispatcher, type NotifyKind } from "../src/dispatcher.ts";
import { createGit } from "../src/git.ts";
import { mergeTicket } from "../src/merge.ts";
import { boardLines, describeTicket, footerText, reportContent, reportDetails } from "../src/render.ts";
import { blockedGitCommands, gitBlockReason, overlapNote, repoRelative, shellCommands, writeBlockReason } from "../src/shared-guard.ts";
import { branchCandidates, openStore } from "../src/store.ts";
import type { Repo, Ticket, TicketState, WorkerEvent, WorkerHost, WorkerStart, WorkspaceMode } from "../src/types.ts";
import { requestPrompt, RECOVERY_NOTE, recoveryNote, SHARED_RECOVERY_NOTE, ticketSystemPrompt } from "../src/worker-prompt.ts";
import { openWorkspace, readWorkspaceRecord, WORKSPACE_FILE } from "../src/workspace.ts";
import { Workspace } from "./support/router-runtime.ts";

class Host implements WorkerHost {
	readonly starts: WorkerStart[] = [];
	readonly live = new Map<number, boolean>();
	constructor(readonly onEvent: (event: WorkerEvent) => void) {}
	async start(start: WorkerStart) { this.starts.push(start); this.live.set(start.ticket.id, true); }
	async send() { return "steered" as const; }
	isLive(id: number) { return this.live.has(id); }
	isRunning(id: number) { return this.live.get(id) ?? false; }
	async stop(id: number) { this.live.delete(id); }
	async disposeAll() { this.live.clear(); }
	end(id: number, reported?: "ready" | "dropped", summary = "ok") {
		if (reported) this.onEvent({ type: "report", ticketId: id, report: { state: reported, summary, at: 1 } });
		this.live.set(id, false);
		this.onEvent({ type: "run_end", ticketId: id, text: "done", toolCalls: 2, ...(reported ? { reported } : {}) });
	}
}

describe("workspace modes on a real repository", () => {
	let workspace: Workspace;
	let repo: Repo;
	const dispatchers: Dispatcher[] = [];
	beforeEach(async () => {
		workspace = await Workspace.create();
		repo = (await createGit().open(workspace.repo))!;
	});
	afterEach(async () => {
		for (const dispatcher of dispatchers.splice(0)) await dispatcher.shutdown();
		await workspace.cleanup();
	});

	function setup(fallback: WorkspaceMode = "worktree") {
		const store = openStore(repo.commonDir);
		const setting = openWorkspace(store.root, () => fallback);
		const notes: { id: number; kind: NotifyKind }[] = [];
		let host!: Host;
		const dispatcher = createDispatcher({
			store, git: createGit(), repo, mergeTicket, branchCandidates, requestPrompt, recoveryNote, workspace: setting,
			settings: { enabled: true, maxWorkers: 4, routerTools: [], routerAgents: [], react: "attention", workspace: fallback },
			sessionId: "s1", heartbeatMs: 60_000,
			createWorkerHost: (onEvent) => host = new Host(onEvent),
			notify: (ticket, kind) => notes.push({ id: ticket.id, kind }),
		});
		dispatchers.push(dispatcher);
		return { store, setting, dispatcher, notes, get host() { return host; } };
	}
	const create = (d: Dispatcher, title = "Fix it") => d.create({ title, request: "fix it", source: "fix it" });
	const worktrees = () => workspace.git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));
	const head = () => workspace.git("rev-parse", "HEAD").trim();
	const branches = () => workspace.git("branch", "--format=%(refname:short)").trim().split("\n");

	it("stores the mode in <git-common-dir>/superagent/workspace.json, else takes the setting", () => {
		const { store, setting } = setup("shared");
		expect(setting.mode()).toBe("shared");
		expect(setting.record()).toBeUndefined();
		const record = setting.set("worktree", "session-x");
		expect(record).toMatchObject({ mode: "worktree", changedBy: "session-x", changedAt: expect.any(Number) });
		const path = join(repo.commonDir, "superagent", WORKSPACE_FILE);
		expect(store.root).toBe(join(repo.commonDir, "superagent"));
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
		expect(setting.mode()).toBe("worktree");
		expect(readdirSync(store.root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		writeFileSync(path, "{ not json");
		expect(readWorkspaceRecord(store.root)).toBeUndefined();
		expect(setting.mode()).toBe("shared");
	});

	it("worktree mode refuses a dirty checkout (tracked or untracked changes) but not ignored files, allocating nothing", async () => {
		const t = setup();
		writeFileSync(join(workspace.repo, ".gitignore"), "build/\n");
		workspace.git("add", ".gitignore");
		workspace.git("commit", "-qm", "ignore build");
		writeFileSync(join(workspace.repo, "README.md"), "# changed\n");
		await expect(create(t.dispatcher)).rejects.toThrow(new DirtyWorkspaceError(
			"Ticket not created: the workspace has uncommitted changes (M README.md). In worktree mode tickets start from the last commit, so commit or stash these first, or switch with /superagent workspace shared."));
		workspace.git("checkout", "--", "README.md");
		writeFileSync(join(workspace.repo, "notes.txt"), "untracked\n");
		await expect(create(t.dispatcher)).rejects.toThrow("(?? notes.txt)");
		expect(t.store.list()).toEqual([]);
		expect(readdirSync(join(t.store.root, "tickets"))).toEqual([]);
		expect(worktrees()).toHaveLength(1);
		expect(branches()).toEqual(["main"]);
		workspace.git("clean", "-fq");
		// An ignored file alone is not a change.
		await import("node:fs/promises").then((fs) => fs.mkdir(join(workspace.repo, "build"))).then(() => writeFileSync(join(workspace.repo, "build", "out.js"), "x"));
		const ticket = await create(t.dispatcher);
		expect(ticket).toMatchObject({ id: 1, state: "working", branch: "pi/1-fix-it" });
		expect(worktrees()).toHaveLength(2);
	});

	it("shared mode runs in the main checkout on a dirty tree: no worktree, no branch, cwd the top level", async () => {
		const t = setup("shared");
		writeFileSync(join(workspace.repo, "README.md"), "# user's edit\n");
		const ticket = await create(t.dispatcher);
		expect(ticket).toMatchObject({ workspace: "shared", worktree: repo.topLevel, branch: "main", base: head(), state: "working" });
		expect(t.host.starts[0]!.ticket.worktree).toBe(repo.topLevel);
		expect(worktrees()).toHaveLength(1);
		expect(branches()).toEqual(["main"]);
		expect(existsSync(join(repo.commonDir, "superagent", "worktrees"))).toBe(false);
	});

	it("shared mode: close, dropped, and done keep the main checkout, its branch, and the user's uncommitted changes", async () => {
		const t = setup("shared");
		const before = head();
		writeFileSync(join(workspace.repo, "README.md"), "# user's edit\n");
		writeFileSync(join(workspace.repo, "untracked.txt"), "mine\n");
		const status = workspace.git("status", "--porcelain");
		await create(t.dispatcher, "One");
		await create(t.dispatcher, "Two");
		await create(t.dispatcher, "Three");
		expect(await t.dispatcher.close(1, "not needed")).toMatchObject({ state: "closed" });
		t.host.end(2, "dropped", "nothing to do");
		await t.dispatcher.idle();
		expect(t.store.get(2)).toMatchObject({ state: "closed", closedReason: "nothing to do: nothing to do" });
		t.host.end(3, "ready");
		await t.dispatcher.idle();
		expect(await t.dispatcher.merge(3)).toEqual({ kind: "done" });
		expect(t.store.get(3)!.state).toBe("done");
		expect(t.notes.map((note) => `${note.id}:${note.kind}`)).toEqual(["2:dropped", "3:ready", "3:done"]);
		// Everything as the user left it.
		expect(existsSync(repo.topLevel)).toBe(true);
		expect(head()).toBe(before);
		expect(branches()).toEqual(["main"]);
		expect(workspace.git("symbolic-ref", "--short", "HEAD").trim()).toBe("main");
		expect(workspace.git("status", "--porcelain")).toBe(status);
		expect(readFileSync(join(workspace.repo, "README.md"), "utf8")).toBe("# user's edit\n");
		expect(worktrees()).toHaveLength(1);
	});

	it("merge.ts refuses a shared ticket, and git refuses to remove the main checkout or delete its branch", async () => {
		const t = setup("shared");
		await create(t.dispatcher);
		const outcome = await mergeTicket({ store: t.store, git: createGit(), repo, isRunning: () => false, send: async () => {}, stop: async () => {} }, 1);
		expect(outcome).toEqual({ kind: "refused", reason: "Ticket #1 works in the shared working tree; there is no branch to merge. Mark it done instead." });
		await expect(createGit().removeWorktree(repo, repo.topLevel)).rejects.toThrow(/refusing to remove the main checkout/);
		await expect(createGit().deleteBranch(repo, "main", true)).rejects.toThrow(/refusing to delete main/);
		expect(branches()).toEqual(["main"]);
	});

	it("git status lists porcelain lines: tracked and untracked changes, not ignored files", async () => {
		writeFileSync(join(workspace.repo, ".gitignore"), "*.log\n");
		writeFileSync(join(workspace.repo, "debug.log"), "x");
		writeFileSync(join(workspace.repo, "README.md"), "changed");
		expect(await createGit().status(workspace.repo)).toEqual([" M README.md", "?? .gitignore"]);
	});
});

describe("shared-mode git command parse", () => {
	const blocked = ["add .", "commit -m x", "checkout main", "switch -c x", "restore a", "reset --hard", "stash", "stash list", "clean -fd", "rebase main",
		"merge x", "cherry-pick abc", "revert abc", "am p.patch", "pull", "push", "rm a", "mv a b", "worktree add ../x", "branch new", "branch -d x",
		"branch -m a b", "tag v1", "tag -d v1"];
	it.each(blocked)("blocks git %s", (args) => {
		const sub = args.split(" ")[0];
		expect(blockedGitCommands(`git ${args}`)).toEqual([`git ${sub}`]);
	});

	const allowed = ["git status", "git diff", "git diff --stat HEAD", "git log --oneline -5", "git show HEAD", "git branch", "git branch -a", "git branch --list 'pi/*'",
		"git branch -vv --sort=-committerdate", "git branch --show-current", "git branch --contains HEAD", "git tag", "git tag -l 'v*'", "git tag -n5",
		"git worktree list", "git rev-parse HEAD", "git blame README.md", "echo git commit", "grep -r 'git commit' .", "npm test"];
	it.each(allowed)("allows %s", (command) => {
		expect(blockedGitCommands(command)).toEqual([]);
	});

	it("skips global options and finds git in pipelines, substitutions, wrappers, and sh -c", () => {
		expect(blockedGitCommands("git -C /x -c user.name=a --no-pager commit -m x")).toEqual(["git commit"]);
		expect(blockedGitCommands("git --git-dir=.git --work-tree . add -A")).toEqual(["git add"]);
		expect(blockedGitCommands("npm test && git add -A && git commit -qm done")).toEqual(["git add", "git commit"]);
		expect(blockedGitCommands("echo $(git stash) | cat")).toEqual(["git stash"]);
		expect(blockedGitCommands("GIT_AUTHOR_NAME=x env FOO=1 /usr/bin/git push origin")).toEqual(["git push"]);
		expect(blockedGitCommands("bash -c 'cd sub; git checkout -- .'")).toEqual(["git checkout"]);
		expect(blockedGitCommands("(cd a && git reset)")).toEqual(["git reset"]);
		expect(blockedGitCommands("git status; git log")).toEqual([]);
		expect(shellCommands("a 'b c' \"d e\"; f")).toEqual([["a", "b c", "d e"], ["f"]]);
	});

	it("names the commands and why in its reasons", () => {
		expect(gitBlockReason(["git add", "git commit", "git add"])).toBe("git add, git commit is blocked in a shared-workspace ticket: the working tree is shared with other tickets and the user, so your changes must stay uncommitted and git state (index, HEAD, branches, tags, stash, worktrees, remotes) must not change. Read-only git such as `git status`, `git diff`, and `git log` works.");
		expect(writeBlockReason("src/a.ts")).toBe("write to src/a.ts is blocked: the file changed since you last read it, or you never read it; another ticket or the user may have edited it. Read it again and use `edit`.");
		expect(overlapNote(2, "src/a.ts")).toBe("Note: ticket #2 also changed src/a.ts; make sure you are not undoing its change.");
		expect(repoRelative("/r", "/r/src/a.ts")).toBe("src/a.ts");
		expect(repoRelative("/r", "/other/a.ts")).toBeUndefined();
		expect(repoRelative("/r", "/r")).toBeUndefined();
	});
});

describe("shared-mode rendering and prompts", () => {
	const ticket = (id: number, state: TicketState, extra: Partial<Ticket> = {}): Ticket => ({
		version: 1, id, slug: `t${id}`, title: `Ticket ${id}`, request: "r", source: "r", createdAt: 1, updatedAt: 1, createdBy: "s", owner: "s",
		base: "a".repeat(40), target: "main", branch: "main", worktree: "/repo", workspace: "shared", state, ...extra,
	});

	it("reports done without a turn's worth of text, and ready with the touched files instead of a branch diff", () => {
		expect(reportContent(reportDetails(ticket(3, "done", { report: { state: "ready", summary: "fixed", at: 1 } }), "done"))).toBe(
			"#3 done · Ticket 3\nSummary: fixed\nTicket #3 is done; its changes stay uncommitted in your working tree.");
		expect(reportContent(reportDetails(ticket(2, "ready", { report: { state: "ready", summary: "ok", at: 1 } }), "ready", { files: ["src/a.ts"] }))).toBe(
			"#2 ready · Ticket 2\nSummary: ok\nWorkspace: shared working tree (main)\nTouched (1):\n  src/a.ts");
	});

	it("describes a shared ticket with its touched files, and shows the mode in the footer and the board with overlaps", () => {
		const text = describeTicket({ ticket: ticket(1, "working", { touched: ["a.ts", "b.ts"] }), mine: true, live: true, running: true, files: ["a.ts", "b.ts"] });
		expect(text).toContain("Workspace: shared, in the main checkout /repo (branch main at creation)");
		expect(text).toContain("Touched: a.ts, b.ts");
		expect(text).not.toContain("Ahead of");
		expect(footerText("superagent", { working: 1, attention: 0, queued: 0, workspace: "shared" })).toBe("superagent: on · shared · 1 working");
		expect(boardLines([ticket(1, "working"), ticket(2, "ready")], undefined, { workspace: "shared", overlaps: [{ path: "a.ts", tickets: [1, 2] }] })).toEqual([
			"tickets · shared workspace", "ready: #2 Ticket 2", "working: #1 Ticket 1", "overlap: a.ts (#1, #2)",
		]);
		expect(boardLines([], undefined, { workspace: "shared" })).toEqual([]);
	});

	it("gives shared and worktree tickets their own prompt sections and recovery notes", () => {
		const shared = ticketSystemPrompt(ticket(1, "working"));
		expect(shared).toContain("You work directly in the user's working tree `/repo`");
		expect(shared).toContain("Leave all your changes uncommitted, and never change git state");
		expect(shared).toContain("Do not revert or \"fix\" changes you did not make. When a check fails in code you did not touch, say so in your report instead of fixing it.");
		expect(shared).toContain("must not use `isolation: \"worktree\"`");
		expect(shared).not.toContain("git commit`");
		const worktree = ticketSystemPrompt(ticket(1, "working", { workspace: undefined, branch: "pi/1-t1", worktree: "/wt/1" }));
		expect(worktree).toContain("in your own git worktree `/wt/1` on branch `pi/1-t1`");
		expect(worktree).toContain("commit on your branch with normal `git commit` (hooks on, never `--no-verify`)");
		expect(worktree).toContain("merge that branch into yours yourself");
		expect(recoveryNote({ workspace: "shared" })).toBe(SHARED_RECOVERY_NOTE);
		expect(recoveryNote({})).toBe(RECOVERY_NOTE);
	});
});
