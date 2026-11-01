// Shared contracts of the superagent extension; DESIGN.md is their specification.

export const CHILD_SESSION_HOOKS = "pi-extensions.child-session-hooks";
export const SESSION_LINK_TYPE = "pi-extensions.session-link";
/** The process-global registry of live superagent instances' tickets (src/hook.ts). */
export const SUPERAGENT_REGISTRY = "pi-extensions.superagent";
export const MODE_ENTRY = "superagent-mode";
export const REPORT_MESSAGE = "superagent-report";
export const TICKETS_MESSAGE = "superagent-tickets";
/** Footer status key and board widget key. */
export const STATUS_KEY = "superagent";
export const WIDGET_KEY = "superagent";
export const REPORT_TOOL = "ticket_report";
/** The Subagents agent type of ticket agents. */
export const TICKET_AGENT_TYPE = "ticket";
/** The session-link data key carrying `{ ticketId, branch, title }`. */
export const LINK_KEY = "superagent";
/** The Subagents RPC protocol version superagent needs. */
export const SUBAGENTS_PROTOCOL = 3;
/** Characters of a worker's last assistant text kept on its ticket. */
export const LAST_TEXT_CHARS = 2_000;
export const LOCK_HEARTBEAT_MS = 30_000;
export const LOCK_STALE_MS = 120_000;

export type TicketState =
	| "queued" | "working" | "waiting" | "question" | "ready" | "blocked" | "failed" | "interrupted" | "merged" | "closed";
export const FINAL_STATES: ReadonlySet<TicketState> = new Set(["merged", "closed"]);
/** States in which a ticket waits for the user. */
export const ATTENTION_STATES: ReadonlySet<TicketState> = new Set(["question", "ready", "blocked", "failed", "waiting", "interrupted"]);

export type ReportState = "progress" | "ready" | "blocked" | "failed" | "dropped";

export interface TicketReport {
	state: ReportState;
	summary: string;
	question?: string;
	/** The checks the worker ran, in its words. */
	tests?: string;
	at: number;
}

export interface Ticket {
	version: 1;
	id: number;
	slug: string;
	title: string;
	/** What the router passed, verbatim. */
	request: string;
	/** The whole user message the ticket came from, verbatim; may equal `request`. */
	source: string;
	/** Routing facts from the router, at most 30 words. */
	note?: string;
	createdAt: number;
	updatedAt: number;
	/** The main session that created the ticket. */
	createdBy: string;
	/** The main session that receives its reports: the creator, or the session that last resumed it. */
	owner: string;
	/** Commit the worktree started from. */
	base: string;
	/** The main checkout's branch at creation; undefined on a detached HEAD. */
	target?: string;
	branch: string;
	/** Absolute path. */
	worktree: string;
	/** The ticket agent's persisted session file, once it exists. */
	sessionFile?: string;
	/** The ticket agent's Subagents id (of this or an earlier process), once spawned. */
	agentId?: string;
	/** `provider/id` the worker runs with, once started. */
	model?: string;
	state: TicketState;
	/** Pending question for the user. */
	question?: string;
	report?: TicketReport;
	/** The worker's last assistant text, cut to LAST_TEXT_CHARS. */
	lastText?: string;
	/** Failure or refusal detail for `failed`/`interrupted`. */
	error?: string;
	/** A merge waits for the worker's rebase. */
	mergeRequested?: boolean;
	/** Merge as soon as the ticket reports ready. */
	mergeWhenReady?: boolean;
	/** Tickets that must be merged before this one starts. */
	after?: number[];
	mergedAt?: number;
	mergedInto?: string;
	closedReason?: string;
	/** Messages for a `queued` ticket, delivered with its first prompt. */
	pending?: string[];
}

export interface NewTicket {
	title: string;
	request: string;
	source: string;
	note?: string;
	createdBy: string;
	base: string;
	target?: string;
}

export type TicketEvent = { at: number; type: string } & Record<string, unknown>;

export interface LockOwner { pid: number; sessionId: string }

/** `<git-common-dir>/superagent/`; see DESIGN.md "Tickets". Implemented in src/store.ts. */
export interface TicketStore {
	readonly root: string;
	/** Allocates the id, slug, branch name, and worktree path; writes ticket.json (state `queued`) and a `created` event. Creates no worktree. */
	create(init: NewTicket, owner: string): Ticket;
	get(id: number): Ticket | undefined;
	/** Every ticket, by id ascending; unreadable ones are skipped. */
	list(): Ticket[];
	/** Applies `patch` (undefined values delete fields), bumps `updatedAt`, writes atomically, and appends `event` when given. Throws for an unknown id. */
	update(id: number, patch: Partial<Ticket>, event?: Omit<TicketEvent, "at">): Ticket;
	events(id: number): TicketEvent[];
	/** Directory for session files (unused since ticket agents run on Subagents, which persists their sessions). */
	readonly sessionsDir: string;
	/** Takes the lock when free or stale; false when another live owner holds it. Taking it again as the same owner refreshes it. */
	acquire(id: number, owner: LockOwner): boolean;
	refresh(id: number, owner: LockOwner): void;
	release(id: number, owner: LockOwner): void;
	/** The live (not stale) holder, if any. */
	holder(id: number): LockOwner | undefined;
}

/** The repository superagent runs in. Implemented in src/git.ts. */
export interface Repo {
	/** Top level of the checkout the main session runs in (the merge target's checkout). */
	topLevel: string;
	/** Absolute, real path of git's common dir. */
	commonDir: string;
}

export type RebaseOutcome = { ok: true; rebased: boolean } | { ok: false; conflicts: string[] };
export type FastForwardOutcome = { ok: true } | { ok: false; error: string };

/** Git operations; every call uses execFile (no shell), GIT_TERMINAL_PROMPT=0, and a timeout. Implemented in src/git.ts. */
export interface Git {
	/** The repository holding `cwd` with at least one commit, else undefined. */
	open(cwd: string): Promise<Repo | undefined>;
	/** Current branch of a checkout; undefined on a detached HEAD. */
	branch(cwd: string): Promise<string | undefined>;
	/** Full sha of `ref` (default HEAD) in `cwd`. */
	revParse(cwd: string, ref?: string): Promise<string>;
	branchExists(repo: Repo, branch: string): Promise<boolean>;
	/** `git worktree add -b <branch> <path> <base>`. */
	addWorktree(repo: Repo, path: string, branch: string, base: string): Promise<void>;
	/** Removes the worktree (forced) and prunes; no error when it is already gone. */
	removeWorktree(repo: Repo, path: string): Promise<void>;
	/** `git branch -d`, or `-D` when `force`; no error when it does not exist. */
	deleteBranch(repo: Repo, branch: string, force?: boolean): Promise<void>;
	/** True when `git status --porcelain` in the checkout is empty. */
	isClean(cwd: string): Promise<boolean>;
	/** Commits on `branch` not on `target`, and the reverse. */
	aheadBehind(repo: Repo, branch: string, target: string): Promise<{ ahead: number; behind: number }>;
	isAncestor(repo: Repo, ancestor: string, descendant: string): Promise<boolean>;
	/** Files changed between the merge base of `target` and `branch`, and `branch`: `git diff --name-status`. */
	changedFiles(repo: Repo, branch: string, target: string): Promise<string[]>;
	/** Rebases the worktree's branch onto `onto`; on conflict, aborts the rebase and lists the conflicted paths. */
	rebase(worktree: string, onto: string): Promise<RebaseOutcome>;
	/** `git merge --ff-only <branch>` in the checkout `cwd`. */
	fastForward(cwd: string, branch: string): Promise<FastForwardOutcome>;
}

export type WorkerEvent =
	| { type: "session"; ticketId: number; sessionFile?: string; model?: string; agentId?: string }
	| { type: "report"; ticketId: number; report: TicketReport }
	/** A run (one `prompt()` and everything steered into it) settled. */
	| { type: "run_end"; ticketId: number; text: string; toolCalls: number; reported?: ReportState; error?: string; aborted?: boolean };

export interface WorkerStart {
	ticket: Ticket;
	/** First prompt text of this run (the request block, a recovery note, or a message). */
	prompt: string;
	/** Reopen `ticket.sessionFile` instead of creating a new session. */
	resume: boolean;
	/** The `ticket_create` tool call that created the ticket, for the session link (first start only). */
	parentToolCallId?: string;
}

/** Runs ticket agents; implemented over Subagents' RPC in src/subagents-host.ts. One live agent per ticket at most. */
export interface WorkerHost {
	/** Spawns (or reopens from `ticket.sessionFile`) the ticket's agent with `prompt`; resolves once the run has started. */
	start(start: WorkerStart): Promise<void>;
	/** Delivers text to a live agent: steered into its run, a resumed run, or (its record gone) a reopened session. */
	send(ticketId: number, text: string): Promise<"steered" | "prompted" | "reopened">;
	/** This host knows the ticket's agent (running or idle). */
	isLive(ticketId: number): boolean;
	isRunning(ticketId: number): boolean;
	/** Stops a running run and forgets the agent; its run end is not reported. */
	stop(ticketId: number): Promise<void>;
	disposeAll(): Promise<void>;
}

export type MergeOutcome =
	| { kind: "merged"; into: string; commits: number }
	| { kind: "handed-to-worker"; reason: string }
	| { kind: "refused"; reason: string };

/** What the merge needs from the rest of superagent; implemented by the dispatcher. */
export interface MergeDeps {
	store: TicketStore;
	git: Git;
	repo: Repo;
	isRunning(ticketId: number): boolean;
	/** Sends text to the ticket's worker (starting or reopening it as needed). */
	send(ticketId: number, text: string): Promise<void>;
	/** Disposes the ticket's worker session, if live. */
	stop(ticketId: number): Promise<void>;
}

export type React = "attention" | "none";

export interface DispatchSettings {
	enabled: boolean;
	maxWorkers: number;
	routerTools: string[];
	/** Subagents types the router may run with `Agent`. */
	routerAgents: string[];
	/** `attention`: reports that need the user start a main-session turn; `none`: no report does. */
	react: React;
}
