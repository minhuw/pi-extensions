// The dispatcher's state machine against in-memory fakes of the types.ts interfaces (no git, no Pi sessions).
import { afterEach, describe, expect, it } from "vitest";
import { memoryWorkspace, type WorkspaceSetting } from "../src/workspace.ts";
import { createDispatcher, DirtyWorkspaceError, DispatchError, DIRTY_SWITCH_WARNING, dirtyWorkspaceText, NO_TOOL_ERROR, switchRefusal, type DispatcherDeps, type NotifyExtra, type NotifyKind } from "../src/dispatcher.ts";
import {
	LAST_TEXT_CHARS, LOCK_STALE_MS, type FastForwardOutcome, type Git, type LockOwner, type MergeDeps, type MergeOutcome, type NewTicket,
	type RebaseOutcome, type ReportState, type Repo, type Ticket, type TicketEvent, type TicketReport, type TicketStore, type WorkerEvent,
	type WorkerHost, type WorkerStart,
} from "../src/types.ts";

const REPO: Repo = { topLevel: "/repo", commonDir: "/repo/.git" };
const BASE = "b".repeat(40);
const RECOVERY = "RECOVERY NOTE";
const SESSION = "session-1";

class FakeStore implements TicketStore {
	readonly root = "/repo/.git/superagent";
	readonly sessionsDir = "/repo/.git/superagent/sessions";
	readonly tickets = new Map<number, Ticket>();
	readonly log = new Map<number, TicketEvent[]>();
	readonly locks = new Map<number, LockOwner & { heartbeat: number }>();
	readonly dead = new Set<number>();
	refreshes = 0;
	clock = 1_000;

	create(init: NewTicket, owner: string): Ticket {
		const id = this.tickets.size + 1;
		const slug = init.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "ticket";
		const ticket: Ticket = {
			version: 1, id, slug, title: init.title, request: init.request, source: init.source, ...(init.note ? { note: init.note } : {}),
			createdAt: this.clock, updatedAt: this.clock, createdBy: init.createdBy, owner, base: init.base, ...(init.target ? { target: init.target } : {}),
			...(init.workspace === "shared" ? { workspace: "shared" as const } : {}),
			branch: init.branch ?? `pi/${id}-${slug}`, worktree: init.worktree ?? `/repo/.git/superagent/worktrees/${id}-${slug}`, state: "queued",
		};
		this.tickets.set(id, ticket);
		this.log.set(id, [{ at: this.clock, type: "created" }]);
		return structuredClone(ticket);
	}
	get(id: number) { const ticket = this.tickets.get(id); return ticket && structuredClone(ticket); }
	list() { return [...this.tickets.values()].sort((a, b) => a.id - b.id).map((ticket) => structuredClone(ticket)); }
	update(id: number, patch: Partial<Ticket>, event?: Omit<TicketEvent, "at">): Ticket {
		const ticket = this.tickets.get(id);
		if (!ticket) throw new Error(`unknown ticket ${id}`);
		const next = { ...ticket, ...patch, updatedAt: ++this.clock } as Ticket & Record<string, unknown>;
		for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
		this.tickets.set(id, next);
		if (event) this.log.get(id)!.push({ at: this.clock, ...event } as TicketEvent);
		return structuredClone(next);
	}
	events(id: number) { return this.log.get(id) ?? []; }
	private live(id: number) {
		const lock = this.locks.get(id);
		if (!lock || this.dead.has(lock.pid) || this.clock - lock.heartbeat > LOCK_STALE_MS) return undefined;
		return lock;
	}
	acquire(id: number, owner: LockOwner): boolean {
		const lock = this.live(id);
		if (lock && (lock.pid !== owner.pid || lock.sessionId !== owner.sessionId)) return false;
		this.locks.set(id, { ...owner, heartbeat: this.clock });
		return true;
	}
	refresh(id: number, owner: LockOwner): void {
		const lock = this.locks.get(id);
		if (!lock || lock.pid !== owner.pid || lock.sessionId !== owner.sessionId) throw new Error("lock lost");
		this.refreshes++;
		lock.heartbeat = this.clock;
	}
	release(id: number, owner: LockOwner): void {
		const lock = this.locks.get(id);
		if (lock && lock.pid === owner.pid && lock.sessionId === owner.sessionId) this.locks.delete(id);
	}
	holder(id: number): LockOwner | undefined {
		const lock = this.live(id);
		return lock && { pid: lock.pid, sessionId: lock.sessionId };
	}
	types(id: number) { return this.events(id).map((event) => event.type); }
}

class FakeGit implements Git {
	readonly branches = new Set<string>(["main"]);
	readonly worktrees = new Set<string>();
	readonly removed: string[] = [];
	failWorktree = false;
	/** `git status --porcelain` of the main checkout. */
	dirty: string[] = [];
	/** Every call that changes git state, in order. */
	readonly mutations: string[] = [];
	async open() { return REPO; }
	async branch(cwd: string) { return cwd === REPO.topLevel ? "main" : undefined; }
	async revParse() { return BASE; }
	async branchExists(_repo: Repo, branch: string) { return this.branches.has(branch); }
	async addWorktree(_repo: Repo, path: string, branch: string, base: string) {
		this.mutations.push(`worktree add ${path}`);
		if (this.failWorktree) throw new Error("worktree add failed");
		expect(base).toBe(BASE);
		this.branches.add(branch);
		this.worktrees.add(path);
	}
	async removeWorktree(_repo: Repo, path: string) { this.mutations.push(`worktree remove ${path}`); this.worktrees.delete(path); this.removed.push(path); }
	async deleteBranch(_repo: Repo, branch: string) { this.mutations.push(`branch -d ${branch}`); this.branches.delete(branch); }
	async isClean() { return true; }
	async status() { return [...this.dirty]; }
	async aheadBehind() { return { ahead: 2, behind: 0 }; }
	async isAncestor() { return true; }
	async changedFiles() { return ["M\tsrc/a.ts", "A\tsrc/b.ts"]; }
	async rebase(): Promise<RebaseOutcome> { this.mutations.push("rebase"); return { ok: true, rebased: false }; }
	async fastForward(): Promise<FastForwardOutcome> { this.mutations.push("fast-forward"); return { ok: true }; }
}

class FakeHost implements WorkerHost {
	readonly starts: WorkerStart[] = [];
	readonly sends: { id: number; text: string; result: "steered" | "prompted" }[] = [];
	readonly stopped: number[] = [];
	readonly lives = new Map<number, { running: boolean }>();
	disposed = 0;
	failStart = false;
	constructor(readonly onEvent: (event: WorkerEvent) => void) {}
	async start(start: WorkerStart) {
		if (this.failStart) throw new Error("no model");
		this.starts.push(start);
		this.lives.set(start.ticket.id, { running: true });
		this.onEvent({ type: "session", ticketId: start.ticket.id, sessionFile: `/sessions/${start.ticket.id}.jsonl`, model: "faux/test" });
	}
	async send(id: number, text: string) {
		const live = this.lives.get(id);
		if (!live) throw new Error("not live");
		const result = live.running ? "steered" as const : "prompted" as const;
		live.running = true;
		this.sends.push({ id, text, result });
		return result;
	}
	isLive(id: number) { return this.lives.has(id); }
	isRunning(id: number) { return this.lives.get(id)?.running ?? false; }
	async stop(id: number) {
		this.stopped.push(id);
		const live = this.lives.get(id);
		this.lives.delete(id);
		if (live?.running) this.onEvent({ type: "run_end", ticketId: id, text: "", toolCalls: 1, aborted: true });
	}
	async disposeAll() { this.disposed++; for (const id of [...this.lives.keys()]) await this.stop(id); }
	report(id: number, state: ReportState, summary: string, extra: Partial<TicketReport> = {}) {
		this.onEvent({ type: "report", ticketId: id, report: { state, summary, at: 5, ...extra } });
	}
	end(id: number, run: Partial<Extract<WorkerEvent, { type: "run_end" }>> = {}) {
		const live = this.lives.get(id);
		if (live) live.running = false;
		this.onEvent({ type: "run_end", ticketId: id, text: "done", toolCalls: 3, ...run });
	}
}

interface Note { ticket: Ticket; kind: NotifyKind; extra?: NotifyExtra }

function setup(options: { workspace?: WorkspaceSetting; maxWorkers?: number; merge?: (deps: MergeDeps, id: number) => Promise<MergeOutcome>; pid?: number; sessionId?: string; store?: FakeStore; git?: FakeGit; heartbeatMs?: number; failStart?: boolean } = {}) {
	const store = options.store ?? new FakeStore();
	const git = options.git ?? new FakeGit();
	const notes: Note[] = [];
	const merges: number[] = [];
	let host: FakeHost | undefined;
	const deps: DispatcherDeps = {
		store, git, repo: REPO,
		createWorkerHost: (onEvent) => { host = new FakeHost(onEvent); host.failStart = options.failStart ?? false; return host; },
		mergeTicket: async (mergeDeps, id) => {
			merges.push(id);
			return options.merge ? options.merge(mergeDeps, id) : mergedBy(mergeDeps, id);
		},
		branchCandidates: function* (id, slug) { yield `pi/${id}-${slug}`; for (let n = 2; n < 10; n++) yield `pi/${id}-${slug}-${n}`; },
		requestPrompt: (ticket) => `REQUEST #${ticket.id}: ${ticket.request}`,
		recoveryNote: RECOVERY,
		...(options.workspace ? { workspace: options.workspace } : {}),
		settings: { enabled: true, maxWorkers: options.maxWorkers ?? 4, routerTools: [], routerAgents: [], react: "attention", workspace: "worktree" },
		sessionId: options.sessionId ?? SESSION, pid: options.pid ?? 100,
		heartbeatMs: options.heartbeatMs ?? 60_000,
		notify: (ticket, kind, extra) => notes.push({ ticket, kind, ...(extra ? { extra } : {}) }),
	};
	const dispatcher = createDispatcher(deps);
	dispatchers.push(dispatcher);
	return { dispatcher, store, git, notes, merges, get host() { return host!; }, kinds: () => notes.map((note) => `${note.ticket.id}:${note.kind}`) };
}

/** What merge.ts does on success. */
async function mergedBy(deps: MergeDeps, id: number): Promise<MergeOutcome> {
	if (deps.isRunning(id)) return { kind: "refused", reason: "running" };
	await deps.stop(id);
	const ticket = deps.store.get(id)!;
	await deps.git.removeWorktree(deps.repo, ticket.worktree);
	deps.store.update(id, { state: "merged", mergedAt: 9, mergedInto: "main", mergeRequested: undefined }, { type: "merged", into: "main" });
	return { kind: "merged", into: "main", commits: 2 };
}

const dispatchers: ReturnType<typeof createDispatcher>[] = [];
afterEach(async () => { for (const dispatcher of dispatchers.splice(0)) await dispatcher.shutdown(); });

const create = (d: ReturnType<typeof setup>["dispatcher"], title = "Fix login", request = "please fix the login bug") =>
	d.create({ title, request, source: `user said: ${request}` });

describe("create", () => {
	it("picks a free branch, adds the worktree from HEAD, takes the lock, and starts the worker", async () => {
		const t = setup();
		t.git.branches.add("pi/1-fix-login");
		const ticket = await create(t.dispatcher);
		expect(ticket).toMatchObject({ id: 1, state: "working", branch: "pi/1-fix-login-2", base: BASE, target: "main", owner: SESSION, source: "user said: please fix the login bug" });
		expect(t.git.worktrees.has(ticket.worktree)).toBe(true);
		expect(t.store.holder(1)).toEqual({ pid: 100, sessionId: SESSION });
		expect(t.host.starts).toEqual([expect.objectContaining({ prompt: "REQUEST #1: please fix the login bug", resume: false })]);
		expect(t.store.get(1)).toMatchObject({ sessionFile: "/sessions/1.jsonl", model: "faux/test" });
		expect(t.store.types(1)).toEqual(["created", "branch", "started", "session"]);
		expect(t.dispatcher.held()).toEqual([1]);
	});

	it("closes a ticket whose worktree cannot be created and refuses", async () => {
		const t = setup();
		t.git.failWorktree = true;
		await expect(create(t.dispatcher)).rejects.toThrow(/could not be set up: worktree add failed/);
		expect(t.store.get(1)).toMatchObject({ state: "closed", closedReason: "could not create the worktree: worktree add failed" });
		expect(t.store.holder(1)).toBeUndefined();
	});

	it("fails a ticket whose worker cannot start", async () => {
		const t = setup({ failStart: true });
		const ticket = await create(t.dispatcher);
		expect(ticket.state).toBe("failed");
		expect(ticket.error).toMatch(/could not start: no model/);
		expect(t.kinds()).toEqual(["1:failed"]);
	});
});

describe("queueing", () => {
	it("bounds running workers by maxWorkers and starts queued tickets in creation order", async () => {
		const t = setup({ maxWorkers: 1 });
		await create(t.dispatcher, "One");
		expect((await create(t.dispatcher, "Two")).state).toBe("queued");
		expect((await create(t.dispatcher, "Three")).state).toBe("queued");
		expect(t.dispatcher.summary()).toMatchObject({ working: 1, queued: 2 });
		t.host.report(1, "ready", "done");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.store.get(2)!.state).toBe("working");
		expect(t.store.get(3)!.state).toBe("queued");
		t.host.end(2);
		await t.dispatcher.idle();
		expect(t.store.get(3)!.state).toBe("working");
		expect(t.host.starts.map((start) => start.ticket.id)).toEqual([1, 2, 3]);
	});

	it("keeps messages for a queued ticket and delivers them with its first prompt", async () => {
		const t = setup({ maxWorkers: 1 });
		await create(t.dispatcher, "One");
		await create(t.dispatcher, "Two", "second job");
		expect(await t.dispatcher.send(2, "also update docs")).toMatchObject({ delivery: "queued" });
		expect(t.store.get(2)!.pending).toEqual(["also update docs"]);
		t.host.end(1);
		await t.dispatcher.idle();
		const start = t.host.starts.at(-1)!;
		expect(start.ticket.id).toBe(2);
		expect(start.prompt).toBe("REQUEST #2: second job\n\nMessage from the user:\n\nalso update docs");
		expect(t.store.get(2)!.pending).toBeUndefined();
	});
});

describe("follow-ups", () => {
	it("steers a running worker, prompts an idle one, and clears the question", async () => {
		const t = setup();
		await create(t.dispatcher);
		t.host.report(1, "progress", "halfway", { question: "Keep the old API?" });
		expect(t.store.get(1)).toMatchObject({ state: "question", question: "Keep the old API?" });
		expect(t.kinds()).toEqual(["1:question"]);
		expect(await t.dispatcher.send(1, "yes, keep it")).toMatchObject({ delivery: "steered" });
		expect(t.store.get(1)).toMatchObject({ state: "working" });
		expect(t.store.get(1)!.question).toBeUndefined();
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.store.get(1)!.state).toBe("waiting");
		expect(await t.dispatcher.send(1, "go on")).toMatchObject({ delivery: "prompted" });
		expect(t.dispatcher.isRunning(1)).toBe(true);
		expect(t.host.sends.map((send) => send.result)).toEqual(["steered", "prompted"]);
	});

	it("reopens an interrupted worker with the recovery note, and a stopped one without it", async () => {
		const store = new FakeStore();
		const first = setup({ store });
		await create(first.dispatcher, "One");
		await create(first.dispatcher, "Two");
		first.host.end(2);
		await first.dispatcher.idle();
		await first.dispatcher.shutdown();
		expect(store.get(1)!.state).toBe("interrupted");
		expect(store.get(2)!.state).toBe("waiting");
		const second = setup({ store, pid: 200 });
		second.dispatcher.startup();
		expect(await second.dispatcher.send(1, "continue please")).toMatchObject({ delivery: "reopened" });
		expect(second.host.starts.at(-1)).toMatchObject({ prompt: `${RECOVERY}\n\ncontinue please`, resume: true });
		expect(await second.dispatcher.send(2, "one more thing")).toMatchObject({ delivery: "reopened" });
		expect(second.host.starts.at(-1)).toMatchObject({ prompt: "one more thing", resume: true });
		expect(store.get(1)).toMatchObject({ state: "working", owner: SESSION });
	});

	it("refuses unknown and final tickets", async () => {
		const t = setup();
		await expect(t.dispatcher.send(7, "hi")).rejects.toThrow("Ticket #7 does not exist.");
		await create(t.dispatcher);
		await t.dispatcher.close(1, "not needed");
		await expect(t.dispatcher.send(1, "hi")).rejects.toThrow(/Ticket #1 is closed \(not needed\)/);
		await expect(t.dispatcher.send(1, "hi")).rejects.toBeInstanceOf(DispatchError);
	});

	it("refuses a ticket whose lock another live session holds, and takes over a stale one", async () => {
		const store = new FakeStore();
		const other = setup({ store, pid: 300, sessionId: "other" });
		await create(other.dispatcher);
		other.host.end(1);
		await other.dispatcher.idle();
		const mine = setup({ store, pid: 100 });
		await expect(mine.dispatcher.send(1, "hi")).rejects.toThrow(/run by another Pi session \(other, pid 300\)/);
		store.dead.add(300);
		expect(await mine.dispatcher.send(1, "hi")).toMatchObject({ delivery: "reopened" });
		expect(store.get(1)!.owner).toBe(SESSION);
		expect(store.holder(1)).toEqual({ pid: 100, sessionId: SESSION });
		expect(store.types(1)).toContain("owner");
	});
});

describe("run outcomes", () => {
	it("fails a run that ended with a provider error or was aborted", async () => {
		const t = setup();
		await create(t.dispatcher, "One");
		await create(t.dispatcher, "Two");
		t.host.end(1, { error: "rate limited" });
		t.host.end(2, { aborted: true });
		await t.dispatcher.idle();
		expect(t.store.get(1)).toMatchObject({ state: "failed", error: "rate limited" });
		expect(t.store.get(2)).toMatchObject({ state: "failed", error: "the run was aborted" });
		expect(t.kinds()).toEqual(["1:failed", "2:failed"]);
	});

	it("fails a first run that called no tool and keeps its text, but not a later run answering in text", async () => {
		const t = setup();
		await create(t.dispatcher);
		t.host.end(1, { toolCalls: 0, text: "I would edit the file." });
		await t.dispatcher.idle();
		expect(t.store.get(1)).toMatchObject({ state: "failed", error: NO_TOOL_ERROR, lastText: "I would edit the file." });
		expect(NO_TOOL_ERROR).toBe("the worker finished without calling any tool; the model may not have received its tool definitions. Retry with a message, or check the model route.");
		// A follow-up the worker answers in words alone is an answer, not a missing tool list.
		await t.dispatcher.send(1, "why that file?");
		t.host.end(1, { toolCalls: 0, text: "Because it owns the parser." });
		await t.dispatcher.idle();
		expect(t.store.get(1)).toMatchObject({ state: "waiting", lastText: "Because it owns the parser." });
	});

	it("keeps final report states and reports ready with the branch, commits ahead, and files", async () => {
		const t = setup();
		for (const title of ["A", "B", "C"]) await create(t.dispatcher, title);
		t.host.report(1, "ready", "fixed it", { tests: "npm test" });
		t.host.report(2, "blocked", "need access", { question: "Which token?" });
		t.host.report(3, "failed", "impossible");
		for (const id of [1, 2, 3]) t.host.end(id);
		await t.dispatcher.idle();
		expect(t.store.get(1)).toMatchObject({ state: "ready", report: { state: "ready", summary: "fixed it", tests: "npm test" } });
		expect(t.store.get(2)).toMatchObject({ state: "blocked", question: "Which token?" });
		expect(t.store.get(3)).toMatchObject({ state: "failed", error: "impossible" });
		expect(t.kinds().sort()).toEqual(["1:ready", "2:blocked", "3:failed"]);
		expect(t.notes.find((note) => note.kind === "ready")!.extra).toEqual({ target: "main", ahead: 2, files: ["M\tsrc/a.ts", "A\tsrc/b.ts"] });
	});

	it("keeps progress without a question silent", async () => {
		const t = setup();
		await create(t.dispatcher);
		t.host.report(1, "progress", "tests running");
		expect(t.store.get(1)).toMatchObject({ state: "working", report: { state: "progress" } });
		expect(t.notes).toEqual([]);
	});

	it("closes a dropped ticket with the reason once its run ends", async () => {
		const t = setup();
		const ticket = await create(t.dispatcher);
		t.host.report(1, "dropped", "already fixed on main");
		expect(t.store.get(1)!.state).toBe("working");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.store.get(1)).toMatchObject({ state: "closed", closedReason: "nothing to do: already fixed on main" });
		expect(t.git.removed).toEqual([ticket.worktree]);
		expect(t.git.branches.has(ticket.branch)).toBe(true);
		expect(t.store.holder(1)).toBeUndefined();
		expect(t.kinds()).toEqual(["1:dropped"]);
	});

	it("waits after a run without a final report, keeping the last text cut to LAST_TEXT_CHARS", async () => {
		const t = setup();
		await create(t.dispatcher);
		t.host.end(1, { text: "x".repeat(LAST_TEXT_CHARS + 50) });
		await t.dispatcher.idle();
		const ticket = t.store.get(1)!;
		expect(ticket.state).toBe("waiting");
		expect(ticket.lastText).toHaveLength(LAST_TEXT_CHARS);
		expect(t.kinds()).toEqual(["1:waiting"]);
	});

	it("keeps an open question when the run ends without a final report", async () => {
		const t = setup();
		await create(t.dispatcher);
		t.host.report(1, "progress", "partial", { question: "A or B?" });
		t.host.end(1, { text: "Waiting for your answer." });
		await t.dispatcher.idle();
		expect(t.store.get(1)).toMatchObject({ state: "question", question: "A or B?", lastText: "Waiting for your answer." });
		expect(t.kinds()).toEqual(["1:question"]);
	});
});

describe("merge", () => {
	it("merges, releases the lock, and reports", async () => {
		const t = setup();
		await create(t.dispatcher);
		t.host.report(1, "ready", "done");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(await t.dispatcher.merge(1)).toEqual({ kind: "merged", into: "main", commits: 2 });
		expect(t.store.get(1)).toMatchObject({ state: "merged", mergedInto: "main" });
		expect(t.store.holder(1)).toBeUndefined();
		expect(t.dispatcher.held()).toEqual([]);
		expect(t.host.isLive(1)).toBe(false);
		expect(t.kinds()).toEqual(["1:ready", "1:merged"]);
	});

	it("runs the merge again when the worker reports ready after a hand-off", async () => {
		let conflicts = true;
		const t = setup({
			merge: async (deps, id) => {
				if (!conflicts) return mergedBy(deps, id);
				conflicts = false;
				deps.store.update(id, { mergeRequested: true }, { type: "merge-handed-to-worker" });
				await deps.send(id, "Merge requested: rebase");
				return { kind: "handed-to-worker", reason: "conflicts in a.ts" };
			},
		});
		await create(t.dispatcher);
		t.host.report(1, "ready", "done");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(await t.dispatcher.merge(1)).toMatchObject({ kind: "handed-to-worker" });
		expect(t.store.get(1)).toMatchObject({ state: "working", mergeRequested: true });
		expect(t.host.sends.at(-1)).toMatchObject({ text: "Merge requested: rebase", result: "prompted" });
		t.host.report(1, "ready", "rebased");
		// No separate ready report: the merge's outcome is the report.
		expect(t.kinds()).toEqual(["1:ready", "1:merge-handed"]);
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.merges).toEqual([1, 1]);
		expect(t.store.get(1)!.state).toBe("merged");
		expect(t.kinds()).toEqual(["1:ready", "1:merge-handed", "1:merged"]);
	});

	it("reports a refused re-run and clears the request", async () => {
		let calls = 0;
		const t = setup({
			merge: async (deps, id) => {
				if (calls++ === 0) {
					deps.store.update(id, { mergeRequested: true });
					await deps.send(id, "rebase");
					return { kind: "handed-to-worker", reason: "conflicts" };
				}
				return { kind: "refused", reason: "git refused to fast-forward" };
			},
		});
		await create(t.dispatcher);
		t.host.end(1);
		await t.dispatcher.idle();
		await t.dispatcher.merge(1);
		t.host.report(1, "ready", "rebased");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.store.get(1)!.state).toBe("ready");
		expect(t.store.get(1)!.mergeRequested).toBeUndefined();
		expect(t.notes.at(-1)).toMatchObject({ kind: "merge-refused", extra: { reason: "git refused to fast-forward", ahead: 2 } });
	});
});

describe("close and resume", () => {
	it("stops the worker, removes the worktree, keeps the branch, and releases the lock", async () => {
		const t = setup();
		const ticket = await create(t.dispatcher);
		const closed = await t.dispatcher.close(1, "user changed their mind");
		expect(closed).toMatchObject({ state: "closed", closedReason: "user changed their mind" });
		expect(t.host.stopped).toEqual([1]);
		expect(t.git.worktrees.has(ticket.worktree)).toBe(false);
		expect(t.git.branches.has(ticket.branch)).toBe(true);
		expect(t.store.holder(1)).toBeUndefined();
		// The aborted run of a closed ticket is not an outcome.
		await t.dispatcher.idle();
		expect(t.store.get(1)!.state).toBe("closed");
		expect(t.notes).toEqual([]);
	});

	it("resumes an interrupted ticket with the recovery note and takes its reports", async () => {
		const store = new FakeStore();
		const first = setup({ store, sessionId: "old" });
		await create(first.dispatcher);
		await first.dispatcher.shutdown();
		const second = setup({ store, pid: 200 });
		expect(await second.dispatcher.resume(1)).toMatchObject({ action: "started" });
		expect(second.host.starts[0]).toMatchObject({ prompt: RECOVERY, resume: true });
		expect(store.get(1)).toMatchObject({ state: "working", owner: SESSION });
		expect((await second.dispatcher.resume(1)).action).toBe("live");
	});
});

describe("locks and restarts", () => {
	it("refreshes held locks on every heartbeat", async () => {
		const t = setup({ heartbeatMs: 10 });
		await create(t.dispatcher);
		const before = t.store.refreshes;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(t.store.refreshes).toBeGreaterThan(before + 1);
	});

	it("marks working and queued tickets without a live lock interrupted at startup", async () => {
		const store = new FakeStore();
		const first = setup({ store, pid: 300, sessionId: "other", maxWorkers: 1 });
		await create(first.dispatcher, "One");
		await create(first.dispatcher, "Two");
		await create(first.dispatcher, "Three");
		first.host.end(1);
		await first.dispatcher.idle();
		// #1 waits, #2 works, #3 is queued; pid 300 dies without a shutdown, except #3's lock is still live.
		store.dead.add(300);
		store.locks.set(3, { pid: 301, sessionId: "third", heartbeat: store.clock });
		const second = setup({ store });
		second.dispatcher.startup();
		expect(store.list().map((ticket) => ticket.state)).toEqual(["waiting", "interrupted", "queued"]);
		expect(store.types(2).at(-1)).toBe("interrupted");
	});

	it("disposes workers, interrupts its own running and queued tickets, and releases its locks at shutdown", async () => {
		const t = setup({ maxWorkers: 1 });
		await create(t.dispatcher, "One");
		await create(t.dispatcher, "Two");
		await t.dispatcher.shutdown();
		await t.dispatcher.shutdown();
		expect(t.host.disposed).toBe(1);
		expect(t.store.list().map((ticket) => ticket.state)).toEqual(["interrupted", "interrupted"]);
		expect([1, 2].map((id) => t.store.holder(id))).toEqual([undefined, undefined]);
		await expect(create(t.dispatcher)).rejects.toThrow(/shutting down/);
	});
});

describe("summary", () => {
	it("lists open tickets with question and branch, and counts working and waiting ones", async () => {
		const t = setup();
		await create(t.dispatcher, "One");
		await create(t.dispatcher, "Two");
		await create(t.dispatcher, "Three");
		t.host.report(2, "progress", "partial", { question: "A or B?" });
		t.host.report(3, "ready", "done");
		t.host.end(3);
		await t.dispatcher.idle();
		await t.dispatcher.close(1, "dup");
		const summary = t.dispatcher.summary();
		expect(summary.text).toBe("Workspace mode: worktree.\nOpen tickets:\n#2 [question] Two — branch pi/2-two\n  question: A or B?\n#3 [ready] Three — branch pi/3-three");
		expect(summary).toMatchObject({ working: 1, attention: 2, queued: 0 });
	});
});

describe("after and mergeWhenReady", () => {
	const after = (d: ReturnType<typeof setup>["dispatcher"], title: string, deps: number[], extra: { mergeWhenReady?: boolean } = {}) =>
		d.create({ title, request: title, source: title, after: deps, ...extra });

	it("passes the ticket_create tool call id to the first start only, and records the agent id", async () => {
		const t = setup();
		await t.dispatcher.create({ title: "Fix login", request: "fix", source: "fix", parentToolCallId: "call-1" });
		t.host.onEvent({ type: "session", ticketId: 1, agentId: "agent-9" });
		expect(t.host.starts[0]).toMatchObject({ parentToolCallId: "call-1", resume: false });
		expect(t.store.get(1)!.agentId).toBe("agent-9");
	});

	it("keeps a ticket queued until its after tickets are merged, then starts it", async () => {
		const t = setup();
		await create(t.dispatcher, "One");
		const second = await after(t.dispatcher, "Two", [1]);
		expect(second).toMatchObject({ state: "queued", after: [1] });
		expect(t.host.starts.map((start) => start.ticket.id)).toEqual([1]);
		expect(t.dispatcher.summary().text).toContain("#2 [queued] Two — branch pi/2-two, starts after #1 merges");
		t.host.report(1, "ready", "done");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.store.get(2)!.state).toBe("queued");
		await t.dispatcher.merge(1);
		await t.dispatcher.idle();
		expect(t.store.get(2)!.state).toBe("working");
		expect(t.host.starts.map((start) => start.ticket.id)).toEqual([1, 2]);
	});

	it("starts at once when every after ticket is already merged, and refuses unknown or closed ones", async () => {
		const t = setup();
		await create(t.dispatcher, "One");
		t.host.end(1);
		await t.dispatcher.idle();
		await t.dispatcher.merge(1);
		expect(await after(t.dispatcher, "Two", [1])).toMatchObject({ state: "working" });
		expect(t.store.get(2)!.after).toBeUndefined();
		await expect(after(t.dispatcher, "Three", [9])).rejects.toThrow("Ticket #9 (in after) does not exist.");
		await create(t.dispatcher, "Four");
		await t.dispatcher.close(3, "no");
		await expect(after(t.dispatcher, "Five", [3])).rejects.toThrow("Ticket #3 (in after) is closed; it will never be merged.");
	});

	it("fails a waiting ticket when a ticket it starts after is closed", async () => {
		const t = setup();
		await create(t.dispatcher, "One");
		await after(t.dispatcher, "Two", [1]);
		await t.dispatcher.close(1, "not needed");
		await t.dispatcher.idle();
		expect(t.store.get(2)).toMatchObject({ state: "failed", error: "ticket #1, which this ticket starts after, was closed (not needed), so it will never be merged. Send a message to start this ticket anyway, or close it." });
		expect(t.store.get(2)!.after).toBeUndefined();
		expect(t.kinds()).toEqual(["2:failed"]);
		// A message starts it anyway.
		expect((await t.dispatcher.send(2, "go ahead")).delivery).toBe("started");
	});

	it("merges a mergeWhenReady ticket once it reports ready and its run ends, without a ready report", async () => {
		const t = setup();
		await t.dispatcher.create({ title: "One", request: "x", source: "x", mergeWhenReady: true });
		expect(t.store.get(1)!.mergeWhenReady).toBe(true);
		t.host.report(1, "ready", "done");
		expect(t.kinds()).toEqual([]);
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.merges).toEqual([1]);
		expect(t.store.get(1)!.state).toBe("merged");
		expect(t.kinds()).toEqual(["1:merged"]);
	});

	it("reports a refused merge of a mergeWhenReady ticket", async () => {
		const t = setup({ merge: async () => ({ kind: "refused", reason: "the main checkout has uncommitted changes" }) });
		await t.dispatcher.create({ title: "One", request: "x", source: "x", mergeWhenReady: true });
		t.host.report(1, "ready", "done");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.store.get(1)!.state).toBe("ready");
		expect(t.notes.at(-1)).toMatchObject({ kind: "merge-refused", extra: { reason: "the main checkout has uncommitted changes" } });
	});

	it("ticket_merge whenReady: merges a ready idle ticket now, else marks it", async () => {
		const t = setup();
		await create(t.dispatcher, "One");
		const scheduled = await t.dispatcher.mergeWhenReady(1);
		expect(scheduled.outcome).toBeUndefined();
		expect(t.store.get(1)!.mergeWhenReady).toBe(true);
		expect(t.merges).toEqual([]);
		t.host.report(1, "ready", "done");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.store.get(1)!.state).toBe("merged");

		await create(t.dispatcher, "Two");
		t.host.report(2, "ready", "done");
		t.host.end(2);
		await t.dispatcher.idle();
		expect((await t.dispatcher.mergeWhenReady(2)).outcome).toEqual({ kind: "merged", into: "main", commits: 2 });
	});
});

describe("workspace mode", () => {
	it("worktree mode refuses a dirty main checkout before allocating anything", async () => {
		const t = setup();
		t.git.dirty = [" M src/a.ts", "?? notes.txt", " M b", " M c", " M d", " M e", " M f"];
		const error = await create(t.dispatcher).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(DirtyWorkspaceError);
		expect(error).toBeInstanceOf(DispatchError);
		expect((error as Error).message).toBe("Ticket not created: the workspace has uncommitted changes (M src/a.ts, ?? notes.txt, M b, M c, M d, and 2 more). In worktree mode tickets start from the last commit, so commit or stash these first, or switch with /superagent workspace shared.");
		expect(t.store.list()).toEqual([]);
		expect(t.git.mutations).toEqual([]);
		expect(t.git.branches).toEqual(new Set(["main"]));
		expect(t.dispatcher.held()).toEqual([]);
		expect(dirtyWorkspaceText(["?? x"])).toContain("(?? x)");
	});

	it("shared mode creates a ticket in the main checkout with no worktree or branch, the branch informational", async () => {
		const workspace = memoryWorkspace();
		workspace.set("shared", "someone");
		const t = setup({ workspace });
		t.git.dirty = [" M src/a.ts", "?? notes.txt"];
		const ticket = await create(t.dispatcher);
		expect(ticket).toMatchObject({ id: 1, state: "working", workspace: "shared", worktree: REPO.topLevel, branch: "main", base: BASE, target: "main" });
		expect(t.git.mutations).toEqual([]);
		expect(t.git.branches).toEqual(new Set(["main"]));
		expect(t.host.starts[0]!.ticket).toMatchObject({ worktree: REPO.topLevel, workspace: "shared" });
		expect(t.dispatcher.summary()).toMatchObject({ workspace: "shared" });
		expect(t.dispatcher.summary().text).toContain("Workspace mode: shared.");
		expect(t.dispatcher.summary().text).toContain("#1 [working] Fix login — shared working tree");
	});

	it("shared mode: merge marks a ticket done (refused while running), without any git operation, and reports done", async () => {
		const workspace = memoryWorkspace(() => "shared");
		const t = setup({ workspace });
		await create(t.dispatcher);
		expect(await t.dispatcher.merge(1)).toMatchObject({ kind: "refused", reason: expect.stringContaining("still running") });
		t.host.report(1, "ready", "done it");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.kinds()).toEqual(["1:ready"]);
		expect(await t.dispatcher.merge(1)).toEqual({ kind: "done" });
		expect(t.store.get(1)).toMatchObject({ state: "done" });
		expect(t.store.types(1)).toContain("done");
		expect(t.kinds()).toEqual(["1:ready", "1:done"]);
		expect(t.merges).toEqual([]);
		expect(t.git.mutations).toEqual([]);
		expect(t.store.holder(1)).toBeUndefined();
		await expect(t.dispatcher.send(1, "more")).rejects.toThrow("Ticket #1 is done; it takes no more work.");
	});

	it("shared mode: mergeWhenReady marks the ticket done once it reports ready, without a ready report", async () => {
		const t = setup({ workspace: memoryWorkspace(() => "shared") });
		await t.dispatcher.create({ title: "Fix", request: "fix", source: "fix", mergeWhenReady: true });
		t.host.report(1, "ready", "fixed");
		t.host.end(1);
		await t.dispatcher.idle();
		expect(t.store.get(1)!.state).toBe("done");
		expect(t.kinds()).toEqual(["1:done"]);
		expect(t.git.mutations).toEqual([]);
		// ticket_merge whenReady on a ready idle ticket: done at once.
		await create(t.dispatcher, "Two");
		t.host.report(2, "ready", "ok");
		t.host.end(2);
		await t.dispatcher.idle();
		expect(await t.dispatcher.mergeWhenReady(2)).toMatchObject({ outcome: { kind: "done" } });
	});

	it("after is satisfied by a done ticket", async () => {
		const t = setup({ workspace: memoryWorkspace(() => "shared") });
		await create(t.dispatcher, "One");
		const second = await t.dispatcher.create({ title: "Two", request: "two", source: "two", after: [1] });
		expect(second).toMatchObject({ state: "queued", after: [1] });
		t.host.report(1, "ready", "ok");
		t.host.end(1);
		await t.dispatcher.idle();
		await t.dispatcher.merge(1);
		await t.dispatcher.idle();
		expect(t.store.get(2)!.state).toBe("working");
		// A done ticket in `after` at creation is dropped from the list.
		expect((await t.dispatcher.create({ title: "Three", request: "three", source: "three", after: [1] })).after).toBeUndefined();
	});

	it("shared mode: close and dropped leave the main checkout and its branch alone", async () => {
		const t = setup({ workspace: memoryWorkspace(() => "shared") });
		await create(t.dispatcher, "One");
		await create(t.dispatcher, "Two");
		const closed = await t.dispatcher.close(1, "not needed");
		expect(closed).toMatchObject({ state: "closed", worktree: REPO.topLevel });
		t.host.report(2, "dropped", "already done");
		t.host.end(2);
		await t.dispatcher.idle();
		expect(t.store.get(2)).toMatchObject({ state: "closed", closedReason: "nothing to do: already done" });
		expect(t.git.mutations).toEqual([]);
		expect(t.git.removed).toEqual([]);
		expect(t.git.branches).toEqual(new Set(["main"]));
	});

	it("records touched files of shared tickets and names the other open shared tickets that touched them", async () => {
		const t = setup({ workspace: memoryWorkspace(() => "shared") });
		await create(t.dispatcher, "One");
		await create(t.dispatcher, "Two");
		expect(t.dispatcher.touch(1, "src/a.ts")).toEqual([]);
		expect(t.dispatcher.touch(1, "src/a.ts")).toEqual([]);
		expect(t.dispatcher.touch(2, "src/a.ts")).toEqual([1]);
		expect(t.dispatcher.touch(2, "src/b.ts")).toEqual([]);
		expect(t.store.get(1)!.touched).toEqual(["src/a.ts"]);
		expect(t.store.get(2)!.touched).toEqual(["src/a.ts", "src/b.ts"]);
		expect(t.store.types(1).filter((type) => type === "touched")).toHaveLength(1);
		expect(t.dispatcher.summary().overlaps).toEqual([{ path: "src/a.ts", tickets: [1, 2] }]);
		expect(t.dispatcher.summary().text).toContain("overlap: src/a.ts changed by #1, #2");
		const info = await t.dispatcher.inspect(2);
		expect(info.files).toEqual(["src/a.ts", "src/b.ts"]);
		expect(info.ahead).toBeUndefined();
		await t.dispatcher.close(1, "x");
		expect(t.dispatcher.touch(2, "src/a.ts")).toEqual([]);
		// A worktree ticket records nothing.
		const w = setup();
		await create(w.dispatcher);
		expect(w.dispatcher.touch(1, "x")).toEqual([]);
		expect(w.store.get(1)!.touched).toBeUndefined();
	});

	it("reports ready for a shared ticket with its touched files and no branch comparison", async () => {
		const t = setup({ workspace: memoryWorkspace(() => "shared") });
		await create(t.dispatcher);
		t.dispatcher.touch(1, "README.md");
		t.host.report(1, "ready", "ok");
		await t.dispatcher.idle();
		expect(t.notes.at(-1)).toMatchObject({ kind: "ready", extra: { files: ["README.md"] } });
		expect(t.notes.at(-1)!.extra!.ahead).toBeUndefined();
	});

	it("switches the mode only while no ticket is open, from any session, and warns on a dirty switch to worktree", async () => {
		const workspace = memoryWorkspace();
		const t = setup({ workspace });
		const other = setup({ workspace, store: t.store, git: t.git, sessionId: "session-2", pid: 200 });
		await create(t.dispatcher, "Open one");
		const refusal = switchRefusal([t.store.get(1)!]);
		expect(refusal).toBe("The workspace mode cannot be switched while tickets are open:\n#1 [working] Open one\nMerge or close them first (/merge N, /tickets close N).");
		await expect(other.dispatcher.setWorkspace("shared")).rejects.toThrow(refusal);
		await expect(t.dispatcher.setWorkspace("shared")).rejects.toThrow(refusal);
		expect(workspace.mode()).toBe("worktree");
		await t.dispatcher.close(1, "x");
		expect(await other.dispatcher.setWorkspace("shared")).toMatchObject({ previous: "worktree", changed: true, record: { mode: "shared", changedBy: "session-2" } });
		expect(t.dispatcher.workspace()).toBe("shared");
		t.git.dirty = [" M x"];
		expect(await t.dispatcher.setWorkspace("worktree")).toMatchObject({ changed: true, warning: DIRTY_SWITCH_WARNING });
		expect(DIRTY_SWITCH_WARNING).toBe("The main checkout has uncommitted changes: new tickets will be refused until they are committed or stashed.");
		await expect(create(t.dispatcher)).rejects.toBeInstanceOf(DirtyWorkspaceError);
	});
});
