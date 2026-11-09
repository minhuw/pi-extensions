import type { CreateAgentSessionOptions, ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { credentialsRegistry, type PikaCredentials } from "../../credentials.ts";
import type { RepositoryInfo } from "../../repository.ts";
import { MemoryServerError } from "../client.ts";
import type { Category, Scope, ScopeKind } from "../format.ts";
import { type LeaseServer, send } from "./server.ts";

export type DreamMode = "auto" | "manual";
export type Outcome = "completed" | "aborted" | "failed";
/**
 * Why a dream ended: `stopped` by the user, user activity, logout, or a lost lease; at a turn, token, or time
 * `limit`; `failed` because its model or session failed; or `finished` by the child.
 */
export type Ending = "stopped" | "limit" | "failed" | "finished";

/** A dream lease as the server returns it. */
export interface Lease {
	id: string; scope: Scope; mode: DreamMode; deviceId: string; sessionId: string | null;
	grantedAt: string; expiresAt: string; releasedAt: string | null; outcome: Outcome | null;
}
/** A session the lease gives the dream, with the entries it has not consolidated yet. */
export interface DreamSession { id: string; title: string | null; project: string | null; fromSeq: number; toSeq: number; lastAt: string }
/** `POST memory/dream/lease`. */
export interface Grant { lease: Lease; sessions: DreamSession[] }

export interface Source { sessionId: string; seq: number }
export type Change =
	| { op: "save"; id?: string; expectedRevision: number; scope: ScopeKind; category: Category; title: string; hook: string; body: string; reason?: string; sources: Source[] }
	| { op: "forget"; id: string; expectedRevision: number; reason?: string; sources?: Source[] };
export interface Batch {
	id: string; leaseId: string; scope: Scope; mode: DreamMode; at: string; deviceId: string; sessionId: string | null; dreamSessionId: string | null;
	summary: string | null; sessions: string[]; changes: { noteId: string; revision: number; action: "save" | "forget"; title: string; created: boolean }[]; revertedAt: string | null;
}
/** The body of `POST memory/dream/{leaseId}/commit`; the server writes a lease's commit with one `commitId` at most once. */
export interface CommitBody { commitId: string; dreamSessionId?: string; summary?: string; sessions: string[]; changes: Change[] }
/** A successful `POST memory/dream/{leaseId}/commit`. */
export interface CommitAnswer { batch: Batch; index: string; indexBytes: number; indexLines: number }
/** A commit sent without a definite answer, so the server may have written it; a retry resends `body` as it is. */
export interface PendingCommit { body: CommitBody }

/** The token counts of one answer, or of several summed. */
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
/**
 * What an answer costs against a dream's token budget: input, output, and cache writes in full, and cache reads at a
 * tenth, about their price. Every call re-reads the whole cached context, so a plain sum would grow with the square
 * of the calls and stop a dream after a handful of them.
 */
export const budgetTokens = (usage: Usage): number => usage.input + usage.output + usage.cacheWrite + Math.ceil(usage.cacheRead / 10);
/** The context an answer was given: its input and cache tokens. */
export const contextTokens = (usage: Usage): number => usage.input + usage.cacheRead + usage.cacheWrite;

/** A dream's caps and timers; tests shorten them. */
export const dreamLimits = {
	/** At this many turns the child is told to wrap up. */
	wrapUpTurns: 40,
	/** A turn past this many is aborted; the answer of the last turn may still finish the dream. */
	abortTurns: 43,
	/** Past this many budget tokens (`budgetTokens`, summed over the child's answers) the child is aborted. */
	maxTokens: 300_000,
	/** When one answer's context (`contextTokens`) passes this many tokens, the child is told to wrap up. */
	wrapUpContext: 120_000,
	/** After this long the child is aborted. */
	maxMs: 10 * 60_000,
	/** At this share of `maxTokens` and of `maxMs` the child is told to wrap up. */
	wrapUpShare: 0.7,
	/** How often the lease is renewed; the server keeps it 15 minutes. */
	renewMs: 5 * 60_000,
	/** How long the child's `session_shutdown` handlers may run before it is disposed anyway. */
	shutdownMs: 3_000,
};

export const MAX_CHANGES = 50;
export const MAX_SOURCES = 20;
export const WRAP_UP = "This dream is close to one of its limits (turns, tokens, context, or time): wrap up now. Commit what you have with dream_commit, naming the sessions you finished, and finish with a short summary; changes still staged when the dream ends are discarded.";

/** What a dream needs of its child session; `spawnDreamChild` makes the real one. */
export interface DreamChild {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	/** `<provider>/<model id>`. */
	readonly model: string;
	/** Calls `listener` for every turn's start and end and every assistant answer's token usage. */
	subscribe(listener: (event: ChildEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	/** How the last answer ended. */
	lastStop(): { stopReason?: string; errorMessage?: string };
	/** Emits `session_shutdown` to the child's extensions, bounded, then disposes it. */
	shutdown(): Promise<void>;
}
/**
 * A turn's end says whether its answer called tools, so the child goes on, and whether the answer failed (an error,
 * which Pi may retry, or an abort): a failed answer is no turn of work.
 */
export type ChildEvent = { type: "turn_start" } | { type: "turn_end"; toolCalls: boolean; failed?: boolean } | { type: "usage"; usage: Usage };

export interface SpawnOptions {
	cwd: string;
	agentDir: string;
	parentSessionId: string;
	parentSessionFile?: string;
	/** Whether the child is kept on disk; a session that is not (`--no-session`) gets a child in memory. */
	persist: boolean;
	model: NonNullable<CreateAgentSessionOptions["model"]>;
	thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	modelRuntime?: ModelRuntime;
	customTools: ToolDefinition[];
}

export interface DreamUi {
	setStatus(text: string | undefined): void;
	notify(text: string, type: "info" | "warning" | "error"): void;
}

export interface DreamRunOptions {
	/** The memory instance that started it; its session's input preempts it. */
	owner: object;
	mode: DreamMode;
	grant: Grant;
	/** The server and token that granted the lease, which every lease request goes to. */
	server: LeaseServer;
	cwd: string;
	repository: RepositoryInfo;
	parentSessionId: string;
	parentSessionFile?: string;
	agentDir: string;
	/** The memory index when the dream started, or null when it could not be read. */
	index: string | null;
	model: SpawnOptions["model"];
	/** Why the model is not `memory.dreamModel`, when it is not. */
	modelNote?: string;
	thinkingLevel?: SpawnOptions["thinkingLevel"];
	modelRuntime?: ModelRuntime;
	ui?: DreamUi;
	spawn(options: SpawnOptions): Promise<DreamChild>;
	/** The dream's tools, given the run they act for. */
	tools(run: DreamRun): ToolDefinition[];
	kickoff(run: DreamRun): string;
	onEnd(run: DreamRun): void;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : word.endsWith("ch") ? "es" : "s"}`;

/** Why a dream granted with `server` must stop, if pika's credentials no longer match it: logged out, switched, or excluded. */
export function credentialsChange(current: PikaCredentials | undefined, server: LeaseServer, cwd: string): string | undefined {
	if (!current) return "pika logged out";
	if (current.url !== server.url || current.token !== server.token) return "pika's server or token changed";
	if (current.isExcluded(cwd)) return `pika's exclude list now covers ${cwd}`;
	return undefined;
}

/**
 * How a dream's end is released: `aborted` when it was stopped, or hit a cap after writing a batch; `failed` when its
 * model or session failed, it hit a cap before writing one, or it finished with a failed commit and none written;
 * `completed` when it finished with no failed commit left (one failed commit after a written batch is `aborted`).
 */
export function outcomeOf(ending: Ending, wrote: boolean, failing: boolean): Outcome {
	if (ending === "stopped") return "aborted";
	if (ending === "failed") return "failed";
	if (ending === "limit" || failing) return wrote ? "aborted" : "failed";
	return "completed";
}

/**
 * One dream: a child session working under a lease. It ends exactly once, when the child finishes, a cap is hit, the
 * lease is lost, pika's credentials change, or it is stopped. The child is aborted at once; a commit in flight is not,
 * and the end waits for its answer. Then every end discards what is still staged, releases the lease without waiting
 * for the server, clears the footer status, and shuts the child down.
 */
export class DreamRun {
	readonly startedAt = new Date().toISOString();
	readonly lease: Lease;
	readonly sessions: DreamSession[];
	turns = 0;
	/** Budget tokens so far (`budgetTokens`). */
	tokens = 0;
	/** The token counts of the child's answers, summed. */
	readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	/** The latest answer's context (`contextTokens`). */
	context = 0;
	staged: Change[] = [];
	readonly batches: Batch[] = [];
	/** Staged changes thrown away by failed commits and at the end. */
	discarded = 0;
	/** The commit whose outcome is unknown, if any; its changes are the first staged ones until it is resolved. */
	pending?: PendingCommit;
	/** Commits that failed or got no definite answer since the last batch was written. */
	failedCommits = 0;
	/** The changes of a commit whose outcome was still unknown at the end: maybe written, so never counted as discarded. */
	uncertain = 0;
	ended = false;
	ending?: Ending;
	/** Set once the dream has ended, after any commit in flight got its answer. */
	outcome?: Outcome;
	reason?: string;
	endedAt?: string;
	child?: DreamChild;
	/** Settles once the child is shut down; never rejects. */
	done: Promise<void> = Promise.resolve();
	/** Settles once the release got its answer, or failed; never rejects. */
	released?: Promise<void>;
	private steered = false;
	private wrapUpDue = false;
	private inFlight = 0;
	private settled?: () => void;
	private spawned?: Promise<DreamChild | undefined>;
	private unsubscribe?: () => void;
	private readonly cleanups: (() => void)[] = [];

	constructor(readonly options: DreamRunOptions) {
		this.lease = options.grant.lease;
		this.sessions = options.grant.sessions;
	}

	get owner(): object { return this.options.owner; }
	get mode(): DreamMode { return this.options.mode; }
	get notesChanged(): number { return this.batches.reduce((sum, batch) => sum + batch.changes.length, 0); }
	/** Whether a commit request is in flight. */
	get committing(): boolean { return this.inFlight > 0; }

	/** Starts the child and its first prompt; resolves once the prompt is sent, or the dream ended before. */
	async start(): Promise<void> {
		if (this.ended) return;
		this.status("dreaming…");
		this.watchCredentials();
		const { maxMs } = dreamLimits;
		this.timer(setTimeout(() => this.stop("limit", `reached its ${Math.round(maxMs / 60_000)}-minute limit`), maxMs));
		this.timer(setTimeout(() => this.wrapUp(), maxMs * dreamLimits.wrapUpShare));
		this.timer(setInterval(() => { void this.renew(); }, dreamLimits.renewMs));
		const { options } = this;
		this.spawned = options.spawn({
			cwd: options.cwd, agentDir: options.agentDir, parentSessionId: options.parentSessionId,
			...(options.parentSessionFile ? { parentSessionFile: options.parentSessionFile } : {}), persist: Boolean(options.parentSessionFile),
			model: options.model, ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
			...(options.modelRuntime ? { modelRuntime: options.modelRuntime } : {}),
			customTools: options.tools(this),
		}).then((child) => child, (error: unknown) => {
			this.stop("failed", `could not start its session: ${errorText(error)}`);
			return undefined;
		});
		const child = await this.spawned;
		// `abort()` before a run starts does nothing, so a dream stopped meanwhile must not prompt.
		if (!child || this.ended) return;
		this.child = child;
		this.unsubscribe = child.subscribe((event) => this.observe(event));
		const kickoff = options.kickoff(this);
		void child.prompt(kickoff).then(() => {
			const { stopReason, errorMessage } = child.lastStop();
			if (stopReason === "error") this.stop("failed", `its model failed: ${errorMessage ?? "provider error"}`);
			else if (stopReason === "aborted") this.stop("stopped", "its session was aborted");
			else this.stop("finished", "finished");
		}, (error: unknown) => this.stop("failed", errorText(error)));
	}

	/** Ends the dream; later calls do nothing. Never waits for the server, though the end itself waits for a commit in flight. */
	stop(ending: Ending, reason: string): void {
		if (this.ended) return;
		this.ended = true;
		this.ending = ending;
		this.reason = reason;
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		const aborted = this.abortChild();
		if (!this.inFlight) {
			this.finish();
			this.done = this.shutdown(aborted);
			return;
		}
		this.done = new Promise<void>((resolve) => { this.settled = resolve; }).then(() => {
			this.finish();
			return this.shutdown(aborted);
		});
	}

	/** Marks a commit request in flight until the returned function is called; the dream's end waits for it. */
	beginCommit(): () => void {
		this.inFlight++;
		let open = true;
		return () => {
			if (!open) return;
			open = false;
			if (--this.inFlight === 0) this.settled?.();
		};
	}

	/** Stages a change for the next commit; returns its 1-based position. */
	stage(change: Change): number {
		this.staged.push(change);
		return this.staged.length;
	}

	/** Takes every staged change, for a commit. */
	takeStaged(): Change[] {
		return this.staged.splice(0);
	}

	/** Puts changes a commit took back in front, in order, before any staged while it ran. */
	restage(changes: Change[]): void {
		this.staged = [...changes, ...this.staged];
	}

	/** Counts changes a failed commit threw away. */
	dropped(count: number): void { this.discarded += count; }

	/** Counts a commit that failed or got no definite answer. */
	commitFailed(): void { this.failedCommits++; }

	committed(batch: Batch): void {
		this.batches.push(batch);
		this.failedCommits = 0;
	}

	/** A line for `/memory status`. */
	describe(): string {
		const where = this.lease.scope?.label ? ` of ${this.lease.scope.label}` : "";
		const pending = this.pending ? this.pending.body.changes.length : 0;
		const head = this.outcome
			? `Last dream${where} (${this.mode}): ${this.outcome} at ${this.endedAt}, ${this.reason}.`
			: this.ended
				? `Dream${where} (${this.mode}) stopping, ${this.reason}: waiting for its commit's answer.`
				: `Dreaming${where} (${this.mode}) since ${this.startedAt}: ${plural(this.sessions.length, "session")}, ${this.turns} of ${dreamLimits.abortTurns} turns, ${this.tokens} of ${dreamLimits.maxTokens} budget tokens, ${plural(this.staged.length, "change")} staged${pending ? ` (${pending} from a commit whose outcome is unknown)` : ""}.`;
		const { input, output, cacheRead, cacheWrite } = this.usage;
		const lines = [
			head,
			`  ${plural(this.batches.length, "batch")} committed, ${plural(this.notesChanged, "note")} changed${this.discarded ? `, ${plural(this.discarded, "uncommitted change")} discarded` : ""}${this.outcome && this.pending ? `, and the outcome of a commit of ${plural(this.uncertain, "change")} is unknown` : ""}.`,
			`  Tokens: ${input} input, ${output} output, ${cacheRead} cache read, ${cacheWrite} cache write; budget tokens count cache reads at a tenth; the latest context had ${this.context}.`,
			`  Lease ${this.lease.id}${this.child ? `, session ${this.child.sessionId} on ${this.child.model}` : ""}.`,
		];
		return lines.join("\n");
	}

	/** The end proper: once no commit is in flight. */
	private finish(): void {
		this.endedAt = new Date().toISOString();
		this.uncertain = this.pending ? this.pending.body.changes.length : 0;
		this.discarded += this.staged.length - this.uncertain;
		this.staged = [];
		if (this.ending === "finished" && this.failedCommits) this.reason = this.pending ? "finished with a commit whose outcome is unknown" : "finished after a failed commit";
		const outcome = this.outcome = outcomeOf(this.ending ?? "stopped", this.batches.length > 0, this.failedCommits > 0);
		this.released = send(this.options.server, "POST", `memory/dream/${encodeURIComponent(this.lease.id)}/release`, { body: { outcome } })
			.then(() => {}, () => { /* the lease expires */ });
		this.status(undefined);
		this.notify();
		try { this.options.onEnd(this); } catch { /* the controller's own */ }
	}

	private observe(event: ChildEvent): void {
		if (this.ended) return;
		if (event.type === "turn_start") {
			if (this.turns >= dreamLimits.abortTurns) this.stop("limit", `reached its ${dreamLimits.abortTurns}-turn limit`);
		} else if (event.type === "usage") {
			const { usage } = event;
			this.usage.input += usage.input;
			this.usage.output += usage.output;
			this.usage.cacheRead += usage.cacheRead;
			this.usage.cacheWrite += usage.cacheWrite;
			this.tokens += budgetTokens(usage);
			this.context = contextTokens(usage);
			if (this.tokens > dreamLimits.maxTokens) this.stop("limit", `used more than ${dreamLimits.maxTokens} budget tokens`);
			else if (this.tokens >= dreamLimits.maxTokens * dreamLimits.wrapUpShare || this.context > dreamLimits.wrapUpContext) this.wrapUpDue = true;
		} else if (!event.failed) {
			this.turns++;
			// A final answer ends the dream, even on the last turn; the turn after it, if any, is stopped at its start.
			if (!event.toolCalls) return;
			if (this.turns >= dreamLimits.abortTurns) this.stop("limit", `reached its ${dreamLimits.abortTurns}-turn limit`);
			else if (this.wrapUpDue || this.turns >= dreamLimits.wrapUpTurns) this.wrapUp();
		}
	}

	/** Tells the child once to commit and finish, now if it runs, else at its next turn that calls tools. */
	private wrapUp(): void {
		if (this.ended || this.steered) return;
		if (!this.child) { this.wrapUpDue = true; return; }
		this.steered = true;
		void this.child.steer(WRAP_UP).catch(() => {});
	}

	private abortChild(): Promise<void> {
		return (this.spawned ?? Promise.resolve(undefined)).then(async (child) => {
			if (!child) return;
			this.unsubscribe?.();
			try { await child.abort(); } catch { /* shut down anyway */ }
		});
	}

	private async shutdown(aborted: Promise<void>): Promise<void> {
		await aborted;
		const child = await this.spawned;
		try { await child?.shutdown(); } catch { /* disposed anyway */ }
	}

	private watchCredentials(): void {
		const registry = credentialsRegistry();
		const listener = () => {
			const why = credentialsChange(registry.current, this.options.server, this.options.cwd);
			if (why) this.stop("stopped", why);
		};
		registry.listeners.add(listener);
		this.cleanups.push(() => { registry.listeners.delete(listener); });
	}

	private timer(timer: ReturnType<typeof setTimeout>): void {
		timer.unref?.();
		this.cleanups.push(() => clearTimeout(timer));
	}

	private async renew(): Promise<void> {
		if (this.ended) return;
		try {
			const answer = await send<{ lease?: Lease }>(this.options.server, "POST", `memory/dream/${encodeURIComponent(this.lease.id)}/renew`, { body: {} });
			if (answer.lease?.expiresAt) this.lease.expiresAt = answer.lease.expiresAt;
		} catch (error) {
			if (error instanceof MemoryServerError && error.status === 409) this.stop("stopped", "lost its lease");
			// Other failures try again at the next renewal, well before the lease expires.
		}
	}

	private status(text: string | undefined): void {
		try { this.options.ui?.setStatus(text); } catch { /* a closed UI */ }
	}

	private notify(): void {
		const counts = `${plural(this.batches.length, "batch")} committed, ${plural(this.notesChanged, "note")} changed`;
		const dropped = this.discarded ? `; discarded ${plural(this.discarded, "uncommitted change")}` : "";
		const unknown = this.pending ? `; the outcome of a commit of ${plural(this.uncertain, "change")} is unknown, so the server may have written it` : "";
		const text = this.outcome === "completed"
			? `pika memory: the dream finished: ${counts}${dropped}.`
			: `pika memory: the dream ${this.outcome === "failed" ? "failed" : "stopped"}, ${this.reason}: ${counts}${dropped}${unknown}.`;
		try { this.options.ui?.notify(text, this.outcome === "failed" ? "warning" : "info"); } catch { /* a closed UI */ }
	}
}
