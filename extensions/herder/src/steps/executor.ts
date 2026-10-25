// The host side of agent(): identity, cache, adoption, and the step transaction (§6, §8).
import { existsSync } from "node:fs";
import { runChecks } from "../checks/runner.ts";
import { INLINE_TEXT_LIMIT, LIMITS } from "../config.ts";
import { stepKey, type Occurrences } from "../journal/keys.ts";
import { integrationRef, stepRef, worktreePath } from "../run/paths.ts";
import type { RunStore } from "../run/store.ts";
import { AgentError, noFaults } from "../types.ts";
import type {
	AgentOptions, AgentRunner, AgentRunResult, CheckResult, CheckSpec, ErrorClass, FaultPoint, Faults, Limits, RoleDefinition,
	StepCompletedEvent, StepResult, Vcs,
} from "../types.ts";
import { lookupStep, resolveIdentity, stepMessage, TRAILER_REPLY, type StepIdentity } from "./cache.ts";

export interface StepActivity { key: string; label: string; phase?: string; task?: string; state: "running" | "settled" }

export interface StepDeps {
	runId: string; store: RunStore; vcs: Vcs; runner: AgentRunner;
	roles: ReadonlyMap<string, RoleDefinition>;
	/** The approved goal's checks; gate ids resolve here. */
	checks: readonly CheckSpec[];
	limits?: Limits; faults?: Faults;
	/** Per-run cap on live agent starts; the effective cap is also bounded by `limits.agentsPerRun`. */
	maxAgents?: number;
	signal?: AbortSignal;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Runs after each journaled settled event; default `store.renderProgress()`. */
	onProgress?: () => void;
	onActivity?: (activity: StepActivity) => void;
}

/** How a launch's calls were satisfied (§6 rule 5). */
export interface LaunchStats { reused: number; changed: number; new: number }

/** Supplied by the launch driver; direct tool calls pass none. */
export interface StepContext {
	launch?: number;
	occurrences?: Occurrences;
	/** Default base (the launch's logical head); otherwise the real integration head. */
	base?: () => string;
	/** Default `phase` for steps that set none (the script's current `phase()`). */
	phase?: () => string | undefined;
	stats?: LaunchStats;
	signal?: AbortSignal;
}

export interface StepExecutor { run(prompt: string, opts?: AgentOptions, ctx?: StepContext): Promise<StepResult> }

export const ADOPTED_TEXT = "Adopted from the step's commit after an interrupted run; the agent's reply was not recorded.";
const READ_ONLY_WARNING = "The read-only step changed files; the changes were discarded.";
const USAGE_LIMITED = "a usage limit was reached earlier in this launch; no new agents start";
const ACTIVITY_INTERVAL_MS = 1_000;

/** Wraps an exception thrown by `faults.hit`: a simulated crash propagates unchanged, never journaled or retried. */
class Crash {
	readonly error: unknown;
	constructor(error: unknown) { this.error = error; }
}

interface Failure { errorClass: ErrorClass | "stopped"; message: string; transcriptRef?: string }

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted) return reject(signal.reason);
	const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
	const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
	signal?.addEventListener("abort", onAbort, { once: true });
});

export function createStepExecutor(deps: StepDeps): StepExecutor {
	const { runId, store, vcs, runner } = deps;
	const limits = deps.limits ?? LIMITS;
	const faults = deps.faults ?? noFaults;
	const sleep = deps.sleep ?? defaultSleep;
	const cap = Math.min(deps.maxAgents ?? Infinity, limits.agentsPerRun);
	const inflight = new Map<string, { fingerprint: string; promise: Promise<StepResult> }>();
	const launchIds = new WeakMap<Occurrences, Map<string, string>>();
	const usageLimited = new Set<number>();

	const hit = (point: FaultPoint, key: string) => {
		try { faults.hit(point, key); } catch (error) { throw new Crash(error); }
	};
	// A broken progress view or activity sink must not turn a journaled outcome into a failure.
	const progress = () => {
		try { deps.onProgress ? deps.onProgress() : store.renderProgress(); } catch {}
	};
	const activity = (value: StepActivity) => {
		try { deps.onActivity?.(value); } catch {}
	};
	const removeWorktree = (path: string) => {
		try { vcs.removeWorktree(path); } catch {}
	};
	const integrationHead = () => {
		const head = vcs.readRef(integrationRef(runId));
		if (!head) throw new Error(`run ${runId} has no integration ref`);
		return head;
	};
	const runGates = async (gates: readonly CheckSpec[], path: string, commit: string, key: string, signal: AbortSignal) => {
		const results = await runChecks(gates, { cwd: path, commit, outputs: store.outputs, signal });
		for (const result of results) {
			const { id, exitCode, timedOut, durationMs, logRef, tail } = result;
			store.journal.append({ t: "check.completed", checkId: id, commit, exitCode, timedOut, durationMs, logRef, tail, purpose: "gate", key });
		}
		return results;
	};

	const storedText = (text: string) => text.length <= INLINE_TEXT_LIMIT ? { text } : { textRef: store.outputs.put(text) };
	/** The reply stored with a step commit; undefined when the commit names none or it cannot be read. */
	const readReply = (commit: string): AgentRunResult | undefined => {
		try {
			const ref = vcs.trailers(commit)[TRAILER_REPLY.toLowerCase()];
			const reply = ref ? JSON.parse(store.outputs.read(ref)) as AgentRunResult : undefined;
			return typeof reply?.text === "string" ? reply : undefined;
		} catch {
			return undefined;
		}
	};

	function fromCompletion(event: StepCompletedEvent, reused: boolean, text?: string): StepResult {
		const result: StepResult = { status: event.status, key: event.key, reused };
		const body = text ?? event.text ?? (event.textRef ? store.outputs.read(event.textRef) : undefined);
		if (body !== undefined) result.text = body;
		if (event.data !== undefined) result.data = event.data;
		if (event.commit !== undefined) result.commit = event.commit;
		if (event.checks !== undefined) result.checks = event.checks;
		if (event.warning !== undefined) result.warning = event.warning;
		return result;
	}

	async function adopt(key: string, identity: StepIdentity, commit: string, reply: AgentRunResult | undefined, signal: AbortSignal): Promise<StepResult> {
		let checks: CheckResult[] | undefined;
		if (identity.gates.length > 0) {
			const path = worktreePath(vcs.commonDir(), runId, `step-${key}`);
			removeWorktree(path);
			vcs.addWorktree(path, commit);
			try {
				checks = await runGates(identity.gates, path, commit, key, signal);
			} catch (error) {
				if (signal.aborted) return { status: "stopped", key, reused: false };
				throw error;
			} finally {
				removeWorktree(path);
			}
		}
		const status = checks?.some((check) => !check.passed) ? "gate_failed" : "ok";
		const text = reply?.text ?? ADOPTED_TEXT;
		const event = store.journal.append({
			t: "step.completed", key, fingerprint: identity.fingerprint, status, ...storedText(text), data: reply?.data, commit,
			ref: stepRef(runId, key), checks, usage: reply?.usage, transcriptRef: reply?.transcriptRef,
		});
		progress();
		return fromCompletion(event, true, text);
	}

	async function live(prompt: string, opts: AgentOptions, ctx: StepContext, identity: StepIdentity, key: string, occurrence: number, signal: AbortSignal): Promise<StepResult> {
		const { fingerprint, role, write, base, gates } = identity;
		const ref = stepRef(runId, key);
		const path = worktreePath(vcs.commonDir(), runId, `step-${key}`);
		const label = opts.label ?? key;
		const phase = opts.phase ?? ctx.phase?.();
		const failed = (attempt: number, failure: Failure, final: boolean) => {
			store.journal.append({ t: "step.failed", key, fingerprint, attempt, errorClass: failure.errorClass, message: failure.message, final, transcriptRef: failure.transcriptRef });
			progress();
		};
		/** `attempt` is the attempt that will not start; journaled only when an earlier attempt was. */
		const stopped = (attempt: number): StepResult => {
			if (attempt > 1) failed(attempt, { errorClass: "stopped", message: String(signal.reason ?? "stopped") }, true);
			return { status: "stopped", key, reused: false };
		};
		const classify = (error: unknown): Failure => {
			if (signal.aborted) return { errorClass: "stopped", message: error instanceof Error ? error.message : String(signal.reason ?? "stopped") };
			const message = error instanceof Error ? error.message : String(error);
			if (!(error instanceof AgentError)) return { errorClass: "fatal", message };
			return { errorClass: error.errorClass, message, transcriptRef: error.transcriptRef };
		};

		/** One attempt in a fresh worktree at `base`; resolves to the step's result or the attempt's failure. */
		async function attempt(number: number): Promise<StepResult | Failure> {
			removeWorktree(path);
			vcs.addWorktree(path, base);
			try {
				store.journal.append({
					t: "step.started", key, id: identity.id, occurrence, fingerprint, attempt: number, role: role.name, write, base,
					task: opts.task, launch: ctx.launch, label: opts.label, phase,
				});
				activity({ key, label, phase, task: opts.task, state: "running" });
				let last = 0;
				const onEvent = () => {
					const now = Date.now();
					if (now - last < ACTIVITY_INTERVAL_MS) return;
					last = now;
					activity({ key, label, phase, task: opts.task, state: "running" });
				};
				let reply: AgentRunResult;
				try {
					reply = await runner.run({
						role, prompt, cwd: path, schema: opts.schema, signal, onEvent, effort: opts.effort,
						timeoutMs: opts.timeoutMs ?? limits.timeoutMs, stallMs: opts.stallMs ?? limits.stallMs,
					});
				} catch (error) {
					return classify(error);
				}
				hit("after-agent", key);
				let commit: string | null = null;
				let warning: string | undefined;
				if (write) {
					const { text, data, usage, transcriptRef } = reply;
					const replyRef = store.outputs.put(JSON.stringify({ text, data, usage, transcriptRef }));
					commit = vcs.snapshot(path, stepMessage(key, fingerprint, replyRef), base);
					if (commit) {
						hit("after-commit", key);
						vcs.updateRef(ref, commit, null);
						hit("after-ref", key);
					}
				} else if (!vcs.isClean(path) || vcs.worktreeHead(path) !== base) {
					warning = READ_ONLY_WARNING;
					if (gates.length > 0) {
						removeWorktree(path);
						vcs.addWorktree(path, base);
					}
				}
				let checks: CheckResult[] | undefined;
				if (gates.length > 0) {
					try {
						checks = await runGates(gates, path, commit ?? base, key, signal);
					} catch (error) {
						if (error instanceof Crash) throw error;
						return classify(error);
					}
				}
				const status = checks?.some((check) => !check.passed) ? "gate_failed" : write && !commit ? "no_changes" : "ok";
				const event = store.journal.append({
					t: "step.completed", key, fingerprint, status, ...storedText(reply.text), data: reply.data, commit: commit ?? undefined,
					ref: commit ? ref : undefined, checks, usage: reply.usage, warning, transcriptRef: reply.transcriptRef,
				});
				progress();
				hit("after-journal", key);
				return fromCompletion(event, false, reply.text);
			} catch (error) {
				if (error instanceof Crash) throw error;
				return classify(error);
			} finally {
				removeWorktree(path);
			}
		}

		hit("before-worktree", key);
		let retries = 0, restarts = 0;
		for (let number = 1; ; number++) {
			if (signal.aborted) return stopped(number);
			if (number === 1 && store.state().liveAgentStarts >= cap) throw new Error(`agent cap reached: this run has started ${cap} agents`);
			if (number > 1 && ctx.launch !== undefined && usageLimited.has(ctx.launch)) {
				const failure = { errorClass: "usage_limit", message: USAGE_LIMITED } as const;
				failed(number, failure, true);
				return { status: "failed", key, error: { class: failure.errorClass, message: failure.message }, reused: false };
			}
			const outcome = await attempt(number);
			if (!("errorClass" in outcome)) return outcome;
			if (outcome.errorClass === "stopped") {
				failed(number, outcome, true);
				return { status: "stopped", key, reused: false };
			}
			const backoff = outcome.errorClass === "transient" || outcome.errorClass === "rate_limit" ? limits.retryBackoffMs[retries] : undefined;
			const restart = outcome.errorClass === "stall" && restarts < limits.stallRestarts;
			const final = backoff === undefined && !restart;
			failed(number, outcome, final);
			if (final) {
				if (outcome.errorClass === "usage_limit" && ctx.launch !== undefined) usageLimited.add(ctx.launch);
				return { status: "failed", key, error: { class: outcome.errorClass, message: outcome.message }, reused: false };
			}
			if (backoff !== undefined) {
				retries++;
				try { await sleep(backoff, signal); } catch { return stopped(number + 1); }
			} else restarts++;
		}
	}

	async function execute(prompt: string, opts: AgentOptions, ctx: StepContext, identity: StepIdentity, key: string, occurrence: number): Promise<StepResult> {
		const signals = [deps.signal, ctx.signal].filter((signal) => signal !== undefined);
		const signal = signals.length > 0 ? AbortSignal.any(signals) : new AbortController().signal;
		const ref = stepRef(runId, key);
		const found = lookupStep(store.state(), vcs, ref, key, identity, opts.fresh === true);
		const stats = ctx.stats;
		// A process that died after journaling (or committing) never ran the attempt's cleanup; drop its slot now.
		if (found.kind === "hit" || found.kind === "adopt") {
			const path = worktreePath(vcs.commonDir(), runId, `step-${key}`);
			if (existsSync(path)) removeWorktree(path);
		}
		if (found.kind === "hit") {
			if (stats) stats.reused++;
			return fromCompletion(found.completion, true);
		}
		const reply = found.kind === "adopt" ? readReply(found.commit) : undefined;
		// Without its reply, a schema step's adopted result would lack `data` and stay cached that way; rerun it instead.
		if (found.kind === "adopt" && (reply || opts.schema === undefined)) {
			if (stats) stats.reused++;
			return adopt(key, identity, found.commit, reply, signal);
		}
		if (stats) found.changed ? stats.changed++ : stats.new++;
		if (ctx.launch !== undefined && usageLimited.has(ctx.launch)) {
			return { status: "failed", key, error: { class: "usage_limit", message: USAGE_LIMITED }, reused: false };
		}
		if (signal.aborted) return { status: "stopped", key, reused: false };
		if (found.kind === "adopt" || found.staleRef) vcs.deleteRefs(ref);
		try {
			return await live(prompt, opts, ctx, identity, key, occurrence, signal);
		} finally {
			activity({ key, label: opts.label ?? key, phase: opts.phase ?? ctx.phase?.(), task: opts.task, state: "settled" });
		}
	}

	return {
		async run(prompt, opts = {}, ctx = {}) {
			const base = opts.base !== undefined ? vcs.resolve(opts.base) : ctx.base?.() ?? integrationHead();
			const identity = resolveIdentity(prompt, opts, deps.roles, deps.checks, base);
			if (ctx.occurrences) {
				let ids = launchIds.get(ctx.occurrences);
				if (!ids) launchIds.set(ctx.occurrences, ids = new Map());
				const seen = ids.get(identity.id);
				if (seen !== undefined && seen !== identity.fingerprint) {
					const which = identity.explicitId ? `step id ${JSON.stringify(identity.id)}` : `the implicit step id ${identity.id}`;
					throw new Error(`${which} is already used in this launch by a call with different inputs (base, gates, schema, or write mode); implicit ids derive from the role and prompt only, so give each distinct agent() call its own explicit id`);
				}
				ids.set(identity.id, identity.fingerprint);
			}
			const occurrence = ctx.occurrences?.next(identity.id, identity.fingerprint) ?? 0;
			const key = stepKey(identity.id, occurrence);
			const running = inflight.get(key);
			if (running) {
				if (running.fingerprint !== identity.fingerprint) throw new Error(`step ${key} is already running with different inputs`);
				if (ctx.stats) ctx.stats.reused++;
				return running.promise;
			}
			const promise = execute(prompt, opts, ctx, identity, key, occurrence).catch((error: unknown) => {
				throw error instanceof Crash ? error.error : error;
			}).finally(() => inflight.delete(key));
			inflight.set(key, { fingerprint: identity.fingerprint, promise });
			return promise;
		},
	};
}
