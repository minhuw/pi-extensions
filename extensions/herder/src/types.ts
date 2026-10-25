// The only contract shared between Herder packages. Change it through the main session.

export type ErrorClass = "transient" | "rate_limit" | "usage_limit" | "stall" | "timeout" | "auth" | "invalid_output" | "fatal";

/** Thrown by `AgentRunner.run`; the step executor branches on `errorClass`. `transcriptRef` keeps failed attempts debuggable. */
export class AgentError extends Error {
	readonly errorClass: ErrorClass;
	readonly transcriptRef?: string;
	constructor(errorClass: ErrorClass, message: string, options?: ErrorOptions & { transcriptRef?: string }) {
		super(message, options);
		this.name = "AgentError";
		this.errorClass = errorClass;
		if (options?.transcriptRef) this.transcriptRef = options.transcriptRef;
	}
}

export interface CheckSpec { id: string; command: string; timeoutMs: number; integrate: boolean }
export interface CheckResult { id: string; commit: string; exitCode: number | null; timedOut: boolean; durationMs: number; tail: string; logRef: string; passed: boolean }
export interface RoleDefinition { name: string; description: string; write: boolean; tools: string[]; model: string; thinking: string; prompt: string; sha256: string }

/** `effort` overrides the role's thinking level for one step (`agent()`'s `effort` option). */
export interface AgentRunRequest { role: RoleDefinition; prompt: string; cwd: string; schema?: object; signal: AbortSignal; timeoutMs: number; stallMs: number; onEvent?: (kind: string) => void; effort?: string }
export interface AgentRunResult { text: string; data?: unknown; usage?: Usage; transcriptRef?: string }
/** Throws `AgentError` with an `ErrorClass`. Enforces `timeoutMs` and `stallMs` itself; rejects once `signal` aborts. */
export interface AgentRunner { run(request: AgentRunRequest): Promise<AgentRunResult> }
export interface Usage { input: number; output: number; cost?: number }

/**
 * Git behind a small interface. `head`, `isClean()`, `currentBranch`, `fastForward`, and `applyDiff` act on the user's
 * checkout; everything else touches only objects, refs, and the worktree paths passed in.
 */
export interface Vcs {
	commonDir(): string; topLevel(): string; head(): string; currentBranch(): string | null;
	/** Without `path`, the user's checkout; with it, that worktree. */
	isClean(path?: string): boolean;
	addWorktree(path: string, commit: string): void; removeWorktree(path: string): void;
	/** HEAD commit of a Herder worktree (e.g. the tip a curator committed on its detached HEAD). */
	worktreeHead(path: string): string;
	/**
	 * Commits the worktree's complete state (all changes, including commits the agent made itself) as one commit whose
	 * parent is `base` (default: the worktree's HEAD); null when the resulting tree equals the parent's tree.
	 */
	snapshot(path: string, message: string, base?: string): string | null;
	readRef(ref: string): string | null;
	/** `expectedOld`: undefined = unconditional, null = the ref must not exist, a SHA = compare-and-swap. */
	updateRef(ref: string, value: string, expectedOld?: string | null): void;
	deleteRefs(prefix: string): void;
	/** Full commit SHA for a commit-ish; throws when it does not name a commit. */
	resolve(rev: string): string;
	treeOf(commit: string): string; parentsOf(commit: string): string[]; trailers(commit: string): Record<string, string>;
	/** Full commit message. */
	message(commit: string): string;
	/** `mergeBase` overrides the computed merge base (used to replay one commit onto a new parent). */
	mergeTree(ours: string, theirs: string, mergeBase?: string): { clean: boolean; tree: string; conflicts: string[] };
	commitTree(tree: string, parents: string[], message: string): string;
	revList(range: string): string[]; diffStat(range: string): string;
	/** Added plus deleted lines in `range` (binary files count as one line each). */
	changedLines(range: string): number;
	/** `git merge --ff-only <commit>` in the user's checkout. Delivery only. */
	fastForward(commit: string): void;
	/** Applies `git diff --binary <from> <to>` to the user's working tree, unstaged. Delivery only. */
	applyDiff(from: string, to: string): void;
}

export type FaultPoint = "before-worktree" | "after-agent" | "after-commit" | "after-ref" | "after-journal" | "after-merge-commit" | "before-ref-advance" | "after-ref-advance";
export interface Faults { hit(point: FaultPoint, key: string): void } // production: no-op; tests: throw or exit
export const noFaults: Faults = { hit() {} };

/** Content-addressed run outputs. `put` returns a ref of the form `outputs/<sha256>.txt`, relative to the run directory. */
export interface OutputStore { put(content: string | Uint8Array): string; read(ref: string): string }

/** Runtime caps (§7). Defaults live in `config.ts`; tests may shrink the timings. */
export interface Limits {
	concurrentAgents: number; concurrentWriters: number;
	agentsPerLaunch: number; agentsPerRun: number; itemsPerCall: number;
	timeoutMs: number; stallMs: number;
	retryBackoffMs: number[];  // one entry per transient/rate-limit retry
	stallRestarts: number;
}

// Script API (§7)

export interface AgentOptions {
	id?: string; label?: string; phase?: string; task?: string;
	role?: string;            // agent definition name; default "worker"
	write?: boolean;          // default from role definition
	base?: string;            // commit-ish; default: the launch's current integration head
	schema?: object;          // JSON Schema; result.data is the validated object
	gate?: string | string[]; // check ids from goal.md, run in the step's worktree after the agent
	fresh?: boolean; timeoutMs?: number; stallMs?: number; effort?: string;
}
export const AGENT_OPTION_KEYS = ["id", "label", "phase", "task", "role", "write", "base", "schema", "gate", "fresh", "timeoutMs", "stallMs", "effort"] as const satisfies readonly (keyof AgentOptions)[];
export interface IntegrateOptions { message: string; task?: string; checks?: string[] }
export const INTEGRATE_OPTION_KEYS = ["message", "task", "checks"] as const satisfies readonly (keyof IntegrateOptions)[];

export type StepStatus = "ok" | "no_changes" | "gate_failed" | "failed" | "stopped";
export interface StepResult {
	status: StepStatus;
	key: string; text?: string; data?: unknown;
	commit?: string;               // writing steps: the step's commit
	checks?: CheckResult[];        // gate results; a failing gate makes status "gate_failed"
	error?: { class: ErrorClass; message: string };
	reused: boolean;
}
export interface IntegrateResult {
	status: "integrated" | "conflict" | "checks_failed";
	head?: string; conflicts?: string[]; checks?: CheckResult[];
}

/**
 * Host side of the script globals. The sandbox forwards each call here after enforcing its own caps. Rejecting
 * `agent` or `integrate` is a fatal runtime error (cap breach, invalid options) that surfaces at the script's call
 * site; every domain outcome is a resolved value.
 */
export interface WorkflowBridge {
	agent(prompt: string, opts: AgentOptions): Promise<StepResult>;
	integrate(source: StepResult | string, opts: IntegrateOptions): Promise<IntegrateResult>;
	log(message: string): void;
	phase(title: string): void;
}

// Journal (§5)

export type StepCompletedStatus = "ok" | "no_changes" | "gate_failed";
export type LaunchStatus = "completed" | "failed" | "stopped";
export type CriterionStatus = "met" | "not_met" | "cant_tell";
export type Verdict = "met" | "not_met" | "blocked";
export type DeliveryMode = "series" | "branch" | "squash" | "uncommitted";
export type RunStatus = "delivered" | "abandoned" | "failed";
export type CheckPurpose = "gate" | "integrate" | "verify" | "deliver" | "manual";
export interface CriterionResult { id: string; status: CriterionStatus; evidence: string }
export interface Gap { kind: "missing" | "partial" | "contradicts" | "unrequested"; criteria: string[]; text: string }

interface EventBase { v: 1; at: string }
export interface RunStartedEvent extends EventBase { t: "run.started"; runId: string; title: string; base: string; runtime: string; repo: string }
export interface GoalApprovedEvent extends EventBase { t: "goal.approved"; sha256: string; checks: CheckSpec[]; approvedBy: "user" }
export interface PlanUpdatedEvent extends EventBase { t: "plan.updated"; sha256: string }
/** `head` is the integration head the launch starts from; `resumes` names the launch it replays (§6, deviation). */
export interface ScriptLaunchedEvent extends EventBase { t: "script.launched"; launch: number; scriptSha256: string; args: unknown; head: string; resumes?: number }
export interface ScriptSettledEvent extends EventBase { t: "script.settled"; launch: number; status: LaunchStatus; reused: number; changed: number; new: number; resultRef?: string; error?: string }
export interface StepStartedEvent extends EventBase { t: "step.started"; key: string; id: string; occurrence: number; fingerprint: string; attempt: number; role: string; write: boolean; base: string; task?: string; launch?: number; label?: string; phase?: string }
export interface StepCompletedEvent extends EventBase { t: "step.completed"; key: string; fingerprint: string; status: StepCompletedStatus; text?: string; textRef?: string; data?: unknown; commit?: string; ref?: string; checks?: CheckResult[]; usage?: Usage; warning?: string }
export interface StepFailedEvent extends EventBase { t: "step.failed"; key: string; fingerprint: string; attempt: number; errorClass: ErrorClass | "stopped"; message: string; final: boolean }
/** `commit` replaces the spec's second `at` field, which would collide with the event timestamp (deviation). */
export interface CheckCompletedEvent extends EventBase { t: "check.completed"; checkId: string; commit: string; exitCode: number | null; timedOut: boolean; durationMs: number; logRef: string; tail: string; purpose?: CheckPurpose; key?: string }
export interface IntegrateCompletedEvent extends EventBase { t: "integrate.completed"; key: string; from: string; source: string; head: string; tree: string; message: string; task?: string; checks: CheckResult[] }
export interface IntegrateFailedEvent extends EventBase { t: "integrate.failed"; key: string; from: string; source: string; reason: "conflict" | "checks_failed" | "error"; conflicts?: string[]; checks?: CheckResult[]; message?: string; task?: string; error?: string }
export interface VerifyCompletedEvent extends EventBase { t: "verify.completed"; head: string; checks: CheckResult[]; verdict: Verdict; criteria: CriterionResult[]; verifierRan: boolean; gaps?: Gap[] }
export interface DecisionRecordedEvent extends EventBase { t: "decision.recorded"; question: string; answer: string }
/** `rebasedOnto` records a replay onto a moved branch; `checks` are the checks rerun at the delivered tip. */
export interface DeliveryCompletedEvent extends EventBase { t: "delivery.completed"; mode: DeliveryMode; target: string; tip: string; commits: string[]; rebasedOnto?: string; checks?: CheckResult[]; curated?: boolean }
export interface RunFinishedEvent extends EventBase { t: "run.finished"; status: RunStatus; reason: string }

export type JournalEvent =
	| RunStartedEvent | GoalApprovedEvent | PlanUpdatedEvent | ScriptLaunchedEvent | ScriptSettledEvent
	| StepStartedEvent | StepCompletedEvent | StepFailedEvent | CheckCompletedEvent
	| IntegrateCompletedEvent | IntegrateFailedEvent | VerifyCompletedEvent
	| DecisionRecordedEvent | DeliveryCompletedEvent | RunFinishedEvent;
export type JournalEventType = JournalEvent["t"];
export type EventOf<T extends JournalEventType> = Extract<JournalEvent, { t: T }>;
/** An event as callers write it; the journal adds `v` and `at`. */
export type JournalInput<E extends JournalEvent = JournalEvent> = E extends JournalEvent ? Omit<E, "v" | "at"> : never;
