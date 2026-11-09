import type { CreateAgentSessionOptions, ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RepositoryInfo } from "../../repository.ts";
import { MemoryServerError, request } from "../client.ts";
import type { Category, Scope, ScopeKind } from "../format.ts";

export type DreamMode = "auto" | "manual";
export type Outcome = "completed" | "aborted" | "failed";

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
/** A successful `POST memory/dream/{leaseId}/commit`. */
export interface CommitAnswer { batch: Batch; index: string; indexBytes: number; indexLines: number }

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

/**
 * One dream: a child session working under a lease. It ends exactly once, when the child finishes, a cap is hit, the
 * lease is lost, or it is stopped; every end discards what is still staged, releases the lease without waiting for the
 * server, clears the footer status, and shuts the child down.
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
	ended = false;
	outcome?: Outcome;
	reason?: string;
	endedAt?: string;
	child?: DreamChild;
	/** Settles once the child is shut down; never rejects. */
	done: Promise<void> = Promise.resolve();
	private steered = false;
	private wrapUpDue = false;
	private spawned?: Promise<DreamChild | undefined>;
	private unsubscribe?: () => void;
	private readonly timers: ReturnType<typeof setTimeout>[] = [];

	constructor(readonly options: DreamRunOptions) {
		this.lease = options.grant.lease;
		this.sessions = options.grant.sessions;
	}

	get owner(): object { return this.options.owner; }
	get mode(): DreamMode { return this.options.mode; }
	get notesChanged(): number { return this.batches.reduce((sum, batch) => sum + batch.changes.length, 0); }

	/** Starts the child and its first prompt; resolves once the prompt is sent, or the dream ended before. */
	async start(): Promise<void> {
		this.status("dreaming…");
		const maxMs = dreamLimits.maxMs;
		const maxTimer = setTimeout(() => this.stop("aborted", `reached its ${Math.round(maxMs / 60_000)}-minute limit`), maxMs);
		// Early enough that the child can still commit what it has.
		const wrapUpTimer = setTimeout(() => this.wrapUp(), maxMs * dreamLimits.wrapUpShare);
		const renewTimer = setInterval(() => { void this.renew(); }, dreamLimits.renewMs);
		for (const timer of [maxTimer, wrapUpTimer, renewTimer]) timer.unref?.();
		this.timers.push(maxTimer, wrapUpTimer, renewTimer);
		const { options } = this;
		this.spawned = options.spawn({
			cwd: options.cwd, agentDir: options.agentDir, parentSessionId: options.parentSessionId,
			...(options.parentSessionFile ? { parentSessionFile: options.parentSessionFile } : {}),
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
			else if (stopReason === "aborted") this.stop("aborted", "its session was aborted");
			else this.stop("completed", "finished");
		}, (error: unknown) => this.stop("failed", errorText(error)));
	}

	/** Ends the dream; later calls do nothing. Never waits for the server. */
	stop(outcome: Outcome, reason: string): void {
		if (this.ended) return;
		this.ended = true;
		this.outcome = outcome;
		this.reason = reason;
		this.endedAt = new Date().toISOString();
		for (const timer of this.timers) clearTimeout(timer);
		this.discard();
		const { cwd } = this.options;
		void request(cwd, "POST", `memory/dream/${encodeURIComponent(this.lease.id)}/release`, { body: { outcome } }).catch(() => { /* the lease expires */ });
		this.status(undefined);
		this.notify();
		try { this.options.onEnd(this); } catch { /* the controller's own */ }
		this.done = this.teardown();
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

	/** Counts changes a failed commit threw away. */
	dropped(count: number): void { this.discarded += count; }

	committed(batch: Batch): void { this.batches.push(batch); }

	/** A line for `/memory status`. */
	describe(): string {
		const where = this.lease.scope?.label ? ` of ${this.lease.scope.label}` : "";
		const head = this.ended
			? `Last dream${where} (${this.mode}): ${this.outcome} at ${this.endedAt}, ${this.reason}.`
			: `Dreaming${where} (${this.mode}) since ${this.startedAt}: ${plural(this.sessions.length, "session")}, ${this.turns} of ${dreamLimits.abortTurns} turns, ${this.tokens} of ${dreamLimits.maxTokens} budget tokens, ${plural(this.staged.length, "change")} staged.`;
		const { input, output, cacheRead, cacheWrite } = this.usage;
		const lines = [
			head,
			`  ${plural(this.batches.length, "batch")} committed, ${plural(this.notesChanged, "note")} changed${this.discarded ? `, ${plural(this.discarded, "uncommitted change")} discarded` : ""}.`,
			`  Tokens: ${input} input, ${output} output, ${cacheRead} cache read, ${cacheWrite} cache write; budget tokens count cache reads at a tenth; the latest context had ${this.context}.`,
			`  Lease ${this.lease.id}${this.child ? `, session ${this.child.sessionId} on ${this.child.model}` : ""}.`,
		];
		return lines.join("\n");
	}

	private discard(): void {
		this.discarded += this.staged.length;
		this.staged = [];
	}

	private observe(event: ChildEvent): void {
		if (this.ended) return;
		if (event.type === "turn_start") {
			if (this.turns >= dreamLimits.abortTurns) this.stop("aborted", `reached its ${dreamLimits.abortTurns}-turn limit`);
		} else if (event.type === "usage") {
			const { usage } = event;
			this.usage.input += usage.input;
			this.usage.output += usage.output;
			this.usage.cacheRead += usage.cacheRead;
			this.usage.cacheWrite += usage.cacheWrite;
			this.tokens += budgetTokens(usage);
			this.context = contextTokens(usage);
			if (this.tokens > dreamLimits.maxTokens) this.stop("aborted", `used more than ${dreamLimits.maxTokens} budget tokens`);
			else if (this.tokens >= dreamLimits.maxTokens * dreamLimits.wrapUpShare || this.context > dreamLimits.wrapUpContext) this.wrapUpDue = true;
		} else if (!event.failed) {
			this.turns++;
			// A final answer ends the dream, even on the last turn; the turn after it, if any, is stopped at its start.
			if (!event.toolCalls) return;
			if (this.turns >= dreamLimits.abortTurns) this.stop("aborted", `reached its ${dreamLimits.abortTurns}-turn limit`);
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

	private async renew(): Promise<void> {
		if (this.ended) return;
		try {
			const answer = await request<{ lease?: Lease }>(this.options.cwd, "POST", `memory/dream/${encodeURIComponent(this.lease.id)}/renew`, { body: {} });
			if (answer.lease?.expiresAt) this.lease.expiresAt = answer.lease.expiresAt;
		} catch (error) {
			if (error instanceof MemoryServerError && error.status === 409) this.stop("aborted", "lost its lease");
			// Other failures try again at the next renewal, well before the lease expires.
		}
	}

	private status(text: string | undefined): void {
		try { this.options.ui?.setStatus(text); } catch { /* a closed UI */ }
	}

	private notify(): void {
		const counts = `${plural(this.batches.length, "batch")} committed, ${plural(this.notesChanged, "note")} changed`;
		const dropped = this.discarded ? `; discarded ${plural(this.discarded, "uncommitted change")}` : "";
		const text = this.outcome === "completed"
			? `pika memory: the dream finished: ${counts}${dropped}.`
			: `pika memory: the dream ${this.outcome === "failed" ? "failed" : "stopped"}, ${this.reason}: ${counts}${dropped}.`;
		try { this.options.ui?.notify(text, this.outcome === "failed" ? "warning" : "info"); } catch { /* a closed UI */ }
	}

	private async teardown(): Promise<void> {
		const child = await this.spawned;
		if (!child) return;
		this.unsubscribe?.();
		try { await child.abort(); } catch { /* shut down anyway */ }
		try { await child.shutdown(); } catch { /* disposed anyway */ }
	}
}
