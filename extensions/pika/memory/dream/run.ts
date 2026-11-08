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

/** A dream's caps and timers; tests shorten them. */
export const dreamLimits = {
	/** At this many turns the child is told to wrap up. */
	wrapUpTurns: 40,
	/** At this many turns the child is aborted. */
	abortTurns: 43,
	/** Past this many tokens (input, output, and cache, summed over the child's answers) the child is aborted. */
	maxTokens: 300_000,
	/** After this long the child is aborted. */
	maxMs: 10 * 60_000,
	/** How often the lease is renewed; the server keeps it 15 minutes. */
	renewMs: 5 * 60_000,
	/** How long the child's `session_shutdown` handlers may run before it is disposed anyway. */
	shutdownMs: 3_000,
};

export const MAX_CHANGES = 50;
export const MAX_SOURCES = 20;
export const WRAP_UP = "This dream is close to its turn limit: wrap up now. Commit what you have with dream_commit and finish; changes still staged when the dream ends are discarded.";

/** What a dream needs of its child session; `spawnDreamChild` makes the real one. */
export interface DreamChild {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	/** `<provider>/<model id>`. */
	readonly model: string;
	/** Calls `listener` for every turn's end and every assistant answer's token usage. */
	subscribe(listener: (event: ChildEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	/** How the last answer ended. */
	lastStop(): { stopReason?: string; errorMessage?: string };
	/** Emits `session_shutdown` to the child's extensions, bounded, then disposes it. */
	shutdown(): Promise<void>;
}
export type ChildEvent = { type: "turn_end" } | { type: "usage"; tokens: number };

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
	tokens = 0;
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
		const renewTimer = setInterval(() => { void this.renew(); }, dreamLimits.renewMs);
		maxTimer.unref?.();
		renewTimer.unref?.();
		this.timers.push(maxTimer, renewTimer);
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
			: `Dreaming${where} (${this.mode}) since ${this.startedAt}: ${plural(this.sessions.length, "session")}, ${this.turns} of ${dreamLimits.abortTurns} turns, ${this.tokens} of ${dreamLimits.maxTokens} tokens, ${plural(this.staged.length, "change")} staged.`;
		const lines = [head, `  ${plural(this.batches.length, "batch")} committed, ${plural(this.notesChanged, "note")} changed${this.discarded ? `, ${plural(this.discarded, "uncommitted change")} discarded` : ""}.`];
		lines.push(`  Lease ${this.lease.id}${this.child ? `, session ${this.child.sessionId} on ${this.child.model}` : ""}.`);
		return lines.join("\n");
	}

	private discard(): void {
		this.discarded += this.staged.length;
		this.staged = [];
	}

	private observe(event: ChildEvent): void {
		if (this.ended) return;
		if (event.type === "turn_end") {
			this.turns++;
			if (this.turns >= dreamLimits.abortTurns) this.stop("aborted", `reached its ${dreamLimits.abortTurns}-turn limit`);
			else if (!this.steered && this.turns >= dreamLimits.wrapUpTurns) {
				this.steered = true;
				void this.child?.steer(WRAP_UP).catch(() => {});
			}
		} else {
			this.tokens += event.tokens;
			if (this.tokens > dreamLimits.maxTokens) this.stop("aborted", `used more than ${dreamLimits.maxTokens} tokens`);
		}
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
