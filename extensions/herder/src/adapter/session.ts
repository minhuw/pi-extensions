import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiAgentRunner, modelRuntimeOf } from "../agents/session.ts";
import { hashGoal } from "../artifacts/goal.ts";
import { killAllChecks } from "../checks/runner.ts";
import { ACTIVITY_EVENT, ACTIVITY_REQUEST_EVENT, LOCK_HEARTBEAT_MS, LOCK_STALE_MS, RUN_EVENT, RUN_EVENT_DEBOUNCE_MS, STATUS_KEY } from "../config.ts";
import { acquireLock, type LockOptions, type RunLock } from "../run/lock.ts";
import { activeRun, listRuns, openRun, type RunStore } from "../run/store.ts";
import type { AgentRunner, Vcs } from "../types.ts";
import { openVcs } from "../vcs/git.ts";
import { ActivityBoard } from "./activity.ts";
import { BackgroundLaunch, followUpText } from "./background.ts";
import { confirmLong } from "./confirm.ts";
import { StepAgents } from "./external-agents.ts";
import type { RunState } from "../journal/fold.ts";
import type { DeliveryOutcome, DeliveryRequest, HerderRuntime, LaunchRequest, RuntimeFactory } from "./runtime.ts";
import { isFinished, planTasks, statusText } from "./status.ts";

export const FOLLOW_UP_TYPE = "herder:launch";

export interface HerderOptions {
	createRuntime: RuntimeFactory;
	/** The step runner; default: Pi agent sessions on the main session's model runtime (tests inject a fake). */
	runner?: (ctx: ExtensionContext, run: RunStore) => AgentRunner;
	/** Lock clock and staleness (tests inject time). */
	lock?: LockOptions;
	heartbeatMs?: number;
	/** How long a stop waits for the launch (or a tool call) to settle before reporting "stopping". */
	stopWaitMs?: number;
	/** How long `herder:run` waits after a journal append to coalesce further appends. */
	runEventDelayMs?: number;
}

/** The `herder:run` payload; `repo` is the basename of the repository's top-level directory. */
export interface RunAnnouncement { runId: string; runDir: string; journalPath: string; goalPath: string; planPath: string; repo: string; title: string }

/**
 * A run this session holds the lock for. `controller` aborts all of its work (abort, shutdown, lost lock); `ops` are the
 * direct tool calls in flight, `exclusive` those of them no check may run beside (verification, delivery, approval);
 * `closing` refuses new work once an abort or shutdown began.
 */
export interface Held {
	runId: string; run: RunStore; lock: RunLock; vcs: Vcs;
	controller: AbortController; ops: Set<Promise<unknown>>; exclusive: Set<Promise<unknown>>; closing?: boolean;
	runtime?: HerderRuntime; runner?: AgentRunner;
	launch?: BackgroundLaunch; launching?: boolean;
	/** Stops announcing journal appends, first sending one that is still pending. */
	unannounce?: () => void;
}

export interface Session {
	id: string; ctx: ExtensionContext; closed: boolean;
	vcs?: { cwd: string; vcs: Vcs };
	held?: Held;
	timer?: ReturnType<typeof setInterval>;
	status?: string;
	/** The session's steps in the external-agent registry. */
	agents?: StepAgents;
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The folded state of a run whose goal is approved, unchanged on disk, and not finished. */
export function requireApproved(held: Held): RunState {
	const state = held.run.state();
	if (isFinished(state)) throw new Error(`Herder run ${held.runId} is ${state.status}.`);
	if (!state.goal) throw new Error(`The goal of Herder run ${held.runId} is not approved yet. Complete goal.md (${held.run.paths.goal}) and call herder_run { action: "approve_goal" } first.`);
	let text = "";
	try { text = readFileSync(held.run.paths.goal, "utf8"); } catch {}
	if (hashGoal(text) !== state.goal.sha256) throw new Error(`goal.md (${held.run.paths.goal}) changed after approval. Restore the approved text; a different goal needs a new run.`);
	return state;
}

/** Basename of the repository's top level; that of the journaled path when git cannot answer. */
function repoName(vcs: Vcs, run: RunStore): string {
	try { return basename(vcs.topLevel()); } catch { return basename(run.state().repo ?? ""); }
}

export const busy = (held: Held) => Boolean(held.launch || held.launching || held.ops.size);

export function requireIdle(held: Held, what: string): void {
	if (held.launch || held.launching) throw new Error(`${what} waits until launch ${held.launch?.launch ?? "(starting)"} settles: wait for its follow-up message or stop it with herder_workflow { mode: "stop" }.`);
	if (held.ops.size) throw new Error(`${what} waits until the running Herder tool call finishes.`);
}

/** Whether `promise` settles within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => { timer = setTimeout(resolve, ms, false); timer.unref?.(); });
	try {
		return await Promise.race([promise.then(() => true, () => true), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Per-session run ownership. Nothing starts at construction: locks, timers, and git are touched on first use. */
export class Herder {
	readonly pi: ExtensionAPI;
	readonly options: HerderOptions;
	readonly board: ActivityBoard;
	/** Part of the lock's session id: a reloaded extension in the same process and Pi session is a different owner. */
	readonly nonce = randomBytes(4).toString("hex");
	readonly #sessions = new Map<string, Session>();
	#warned = false;

	constructor(pi: ExtensionAPI, options: HerderOptions) {
		this.pi = pi;
		this.options = options;
		this.board = new ActivityBoard((snapshot) => pi.events.emit(ACTIVITY_EVENT, snapshot));
		pi.events.on(ACTIVITY_REQUEST_EVENT, () => this.board.publish(true));
	}

	get stopWaitMs(): number { return this.options.stopWaitMs ?? 10_000; }
	now(): Date { return this.options.lock?.now?.() ?? new Date(); }

	session(ctx: ExtensionContext): Session {
		const id = ctx.sessionManager.getSessionId();
		let s = this.#sessions.get(id);
		if (!s || s.closed) this.#sessions.set(id, s = { id, ctx, closed: false });
		s.ctx = ctx;
		return s;
	}

	lockId(s: Session): string { return `${s.id}#${this.nonce}`; }

	vcs(s: Session): Vcs {
		if (s.vcs?.cwd !== s.ctx.cwd) s.vcs = { cwd: s.ctx.cwd, vcs: openVcs(s.ctx.cwd) };
		return s.vcs.vcs;
	}

	/** Locks `runId` for this session (taking over only a stale lock) and makes it the session's run. */
	/** Locks the unfinished run `runId` for this session (taking over only a stale lock) and makes it the session's run. */
	hold(s: Session, runId: string, run?: RunStore): Held {
		if (s.held?.runId === runId) return this.#check(s, s.held);
		if (s.held && busy(s.held)) throw new Error(`Run ${s.held.runId} still has a launch or tool call running; stop it first.`);
		const vcs = this.vcs(s);
		run ??= openRun(vcs.commonDir(), runId);
		const state = run.state();
		if (isFinished(state)) throw new Error(`Herder run ${runId} is ${state.status}.`);
		let lock: RunLock;
		try {
			lock = acquireLock(run.paths.lock, this.lockId(s), this.options.lock);
		} catch (error) {
			throw new Error(`Herder run ${runId} is in use: ${message(error)}. Another session can take it over once that heartbeat is older than ${LOCK_STALE_MS / 60_000} minutes.`, { cause: error });
		}
		if (s.held) this.release(s);
		s.held = { runId, run, lock, vcs, controller: new AbortController(), ops: new Set(), exclusive: new Set() };
		s.held.unannounce = this.#announce(s.held);
		this.#heartbeat(s);
		this.refresh(s);
		return s.held;
	}

	/** Confirms the lock is still ours; a lost lock stops the run's work here. */
	#check(s: Session, held: Held): Held {
		try {
			held.lock.heartbeat();
		} catch (error) {
			this.#lost(s, held, error);
			throw new Error(`Herder lost run ${held.runId}: ${message(error)}`, { cause: error });
		}
		return held;
	}

	/** The session's run: the one it holds, else the repository's unfinished run (locked on first use). */
	current(s: Session): Held {
		if (s.held && !isFinished(s.held.run.state())) return this.#check(s, s.held);
		if (s.held && !busy(s.held)) this.release(s);
		const runId = activeRun(this.vcs(s).commonDir());
		if (!runId) throw new Error("No active Herder run in this repository. The user starts one with /herder <goal> or continues one with /herder resume <runId>.");
		return this.hold(s, runId);
	}

	/** A run to describe, without locking: `runId`, else the held run, else the active or latest run. */
	peek(s: Session, runId?: string): RunStore | undefined {
		if (!runId && s.held) return s.held.run;
		const commonDir = this.vcs(s).commonDir();
		const id = runId ?? activeRun(commonDir) ?? listRuns(commonDir).at(-1);
		return id ? openRun(commonDir, id) : undefined;
	}

	runtime(s: Session, held: Held): HerderRuntime {
		return held.runtime ??= this.options.createRuntime({
			cwd: s.ctx.cwd, sessionId: s.id, vcs: held.vcs, run: held.run, signal: held.controller.signal,
			runner: () => held.runner ??= this.#runner(s, held.run),
			onActivity: (activity) => {
				if (s.closed) return;
				this.board.update(activity);
				// A stopping run's steps still report until they see the abort; their entries are already gone.
				if (!held.closing && s.held === held) (s.agents ??= new StepAgents()).update(activity, { ownerSessionId: s.id, runId: held.runId, launch: held.launch?.launch });
				this.refresh(s);
			},
			onProgress: () => this.refresh(s),
		});
	}

	#runner(s: Session, run: RunStore): AgentRunner {
		if (this.options.runner) return this.options.runner(s.ctx, run);
		const modelRuntime = modelRuntimeOf(s.ctx.modelRegistry);
		if (!modelRuntime && !this.#warned) {
			this.#warned = true;
			s.ctx.ui.notify("Herder could not reach this session's model runtime; steps use one built from the agent directory, whose models and logins may differ.", "warning");
		}
		const parentSessionFile = s.ctx.sessionManager.getSessionFile();
		return createPiAgentRunner({
			modelRuntime, inheritModel: () => s.ctx.model, inheritThinking: () => this.pi.getThinkingLevel(), outputs: run.outputs,
			sessions: {
				dir: run.paths.sessions, runId: run.runId, repo: repoName(this.vcs(s), run), parentSessionId: s.id,
				...(parentSessionFile !== undefined && { parentSessionFile }),
			},
		});
	}

	/** Emits `herder:run` now and after journal appends (debounced); returns the function that stops it. */
	#announce(held: Held): () => void {
		let payload: RunAnnouncement | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const emit = () => {
			clearTimeout(timer);
			timer = undefined;
			try {
				const { paths } = held.run;
				payload ??= {
					runId: held.runId, runDir: paths.dir, journalPath: paths.journal, goalPath: paths.goal, planPath: paths.plan,
					repo: repoName(held.vcs, held.run), title: held.run.state().title ?? "",
				};
				this.pi.events.emit(RUN_EVENT, payload);
			} catch {}
		};
		emit();
		const off = held.run.journal.onAppend(() => {
			if (timer) return;
			timer = setTimeout(emit, this.options.runEventDelayMs ?? RUN_EVENT_DEBOUNCE_MS);
			timer.unref?.();
		});
		return () => {
			off();
			if (timer) emit();
		};
	}

	/**
	 * Runs a direct tool call as tracked work of `held`: abort waits for it, delivery and clean refuse meanwhile, and
	 * abort, shutdown, or a lost lock cancel it through the signal, which also follows the tool call's own. An
	 * `exclusive` op also keeps checks out.
	 */
	op<T>(held: Held, signal: AbortSignal | undefined, fn: (signal: AbortSignal) => T | Promise<T>, exclusive = false): Promise<T> {
		if (held.closing) return Promise.reject(new Error(`Herder run ${held.runId} is being stopped.`));
		const combined = signal ? AbortSignal.any([held.controller.signal, signal]) : held.controller.signal;
		const promise = (async () => fn(combined))();
		held.ops.add(promise);
		if (exclusive) held.exclusive.add(promise);
		const forget = () => { held.ops.delete(promise); held.exclusive.delete(promise); };
		promise.then(forget, forget);
		return promise;
	}

	/** Starts a background launch; its outcome reaches the main session as one follow-up message. */
	async launch(s: Session, held: Held, request: LaunchRequest): Promise<number> {
		if (held.launch || held.launching) throw new Error(`Launch ${held.launch?.launch ?? "(starting)"} is still running. Wait for its follow-up message or stop it with herder_workflow { mode: "stop" }.`);
		if (held.ops.size) throw new Error("A launch waits until the running Herder tool call finishes.");
		held.launching = true;
		try {
			const handle = await this.op(held, undefined, async () => {
				const handle = await this.runtime(s, held).launch(request);
				if (s.closed || held.closing || s.held !== held) {
					try { handle.stop("the session closed"); } catch {}
					await handle.done.catch(() => {});
					throw new Error(`Launch ${handle.launch} was stopped: the session closed or gave up run ${held.runId} while it started.`);
				}
				return handle;
			});
			const launch: BackgroundLaunch = new BackgroundLaunch(handle, (outcome, silenced) => {
				if (held.launch === launch) held.launch = undefined;
				this.board.clear();
				this.refresh(s);
				if (silenced || s.closed) return;
				this.pi.sendMessage({ customType: FOLLOW_UP_TYPE, display: true, content: followUpText(outcome, { runId: held.runId, dir: held.run.paths.dir }), details: { runId: held.runId, ...outcome } }, { triggerTurn: true, deliverAs: "followUp" });
			});
			held.launch = launch;
			this.refresh(s);
			return handle.launch;
		} finally {
			held.launching = false;
		}
	}

	refresh(s: Session): void {
		if (s.closed) return;
		const held = s.held;
		let text: string | undefined;
		try {
			text = held && statusText({ state: held.run.state(), tasks: planTasks(held.run), running: this.board.running(), launch: held.launch?.launch });
		} catch {
			text = held && `herder: ${held.runId}`;
		}
		if (text === s.status) return;
		s.status = text;
		s.ctx.ui.setStatus(STATUS_KEY, text);
	}

	/** Gives up the session's run: clears the footer and releases the lock. The caller stops any launch first. */
	release(s: Session): void {
		const held = s.held;
		if (s.timer) clearInterval(s.timer);
		s.timer = undefined;
		s.held = undefined;
		this.refresh(s);
		held?.unannounce?.();
		try { held?.lock.release(); } catch {}
	}

	#heartbeat(s: Session): void {
		if (s.timer) clearInterval(s.timer);
		s.timer = setInterval(() => {
			const held = s.held;
			if (!held || s.closed) return;
			try {
				held.lock.heartbeat();
			} catch (error) {
				this.#lost(s, held, error);
			}
		}, this.options.heartbeatMs ?? LOCK_HEARTBEAT_MS);
		s.timer.unref?.();
	}

	/** Another session owns the run now: stop everything without touching its lock, and tell a model waiting on a launch. */
	#lost(s: Session, held: Held, error: unknown): void {
		if (s.held !== held) return;
		s.held = undefined;
		if (s.timer) clearInterval(s.timer);
		s.timer = undefined;
		held.closing = true;
		held.controller.abort(new Error("run lock lost"));
		const launch = held.launch;
		void launch?.stop("run lock lost", 0, "always");
		this.board.clear();
		s.agents?.clear();
		this.refresh(s);
		if (s.closed) return;
		s.ctx.ui.notify(`Herder lost run ${held.runId}: ${message(error)}`, "warning");
		if (launch) {
			this.pi.sendMessage({
				customType: FOLLOW_UP_TYPE, display: true,
				content: `Herder launch ${launch.launch} of run ${held.runId} was stopped because this session lost the run lock (${message(error)}). Do not wait for another follow-up. Tell the user; the run continues in the session that holds it, or here with /herder resume ${held.runId} once that lock is stale.`,
				details: { runId: held.runId, launch: launch.launch, status: "stopped", error: message(error) },
			}, { triggerTurn: true, deliverAs: "followUp" });
		}
	}

	/** §12 delivery after the user's confirmation; a delivered run releases its lock. */
	async deliver(s: Session, held: Held, request: DeliveryRequest, signal?: AbortSignal): Promise<DeliveryOutcome> {
		if (!s.ctx.hasUI) throw new Error("Delivery needs an interactive session (TUI or RPC) so the user can confirm it.");
		requireApproved(held);
		requireIdle(held, "Delivery");
		const ctx = s.ctx;
		try {
			return await this.op(held, signal, (combined) => this.runtime(s, held).deliver(request, async (summary) => (await confirmLong(ctx, `Deliver Herder run ${held.runId}?`, summary, combined)) === true, combined), true);
		} finally {
			this.settle(s, held);
		}
	}

	/**
	 * Stops the run's launch, journals `run.finished abandoned` through the runtime, and releases the lock. Returns the
	 * run id and a warning when the run's refs or worktrees could not be removed.
	 */
	async abort(s: Session, runId?: string): Promise<{ runId: string; warning?: string }> {
		const commonDir = this.vcs(s).commonDir();
		const id = runId ?? s.held?.runId ?? activeRun(commonDir);
		if (!id) throw new Error("No unfinished Herder run to abort.");
		const run = s.held?.runId === id ? s.held.run : openRun(commonDir, id);
		const state = run.state();
		if (isFinished(state)) throw new Error(`Herder run ${id} is already ${state.status}.`);
		const held = this.hold(s, id, run);
		// Abort cancels the run's work and waits for it rather than refusing: the user wants it stopped.
		held.closing = true;
		held.controller.abort(new Error("run aborted"));
		if (held.launch && !(await held.launch.stop("run aborted", this.stopWaitMs, "always"))) {
			throw new Error(`Launch ${held.launch.launch} is still stopping; run /herder abort again in a moment.`);
		}
		if (held.ops.size && !(await within(Promise.allSettled([...held.ops]), this.stopWaitMs))) {
			throw new Error(`A Herder tool call of run ${id} is still stopping; run /herder abort again in a moment.`);
		}
		try {
			const warning = await this.runtime(s, held).abandon("aborted by the user");
			return warning ? { runId: id, warning } : { runId: id };
		} finally {
			this.board.clear();
			s.agents?.clear();
			if (s.held === held) this.release(s);
		}
	}

	/** Releases a run that has finished (delivered, abandoned, failed); otherwise refreshes the footer. */
	settle(s: Session, held: Held): void {
		if (s.held === held && !held.launch && !held.launching && isFinished(held.run.state())) {
			this.board.clear();
			this.release(s);
		} else this.refresh(s);
	}

	/**
	 * Stops the launch and tool calls, kills checks, and clears footer and activity. The lock is released once all work
	 * settled: Pi keeps the process alive across reload, new, resume, and fork, so unsettled work could still journal.
	 * Until then the lock stays (going stale without heartbeats). Safe to call twice.
	 */
	async shutdown(ctx: ExtensionContext): Promise<void> {
		const id = ctx.sessionManager.getSessionId();
		const s = this.#sessions.get(id);
		this.#sessions.delete(id);
		const held = s?.held;
		if (s) {
			s.closed = true;
			if (s.timer) clearInterval(s.timer);
			s.timer = undefined;
		}
		if (held) {
			held.closing = true;
			held.controller.abort(new Error("session shutdown"));
		}
		killAllChecks();
		if (held?.launch) try { await held.launch.stop("session shutdown", 0, "always"); } catch {}
		const work = held ? Promise.allSettled([...held.ops, ...(held.launch ? [held.launch.settled] : [])]) : undefined;
		const settled = !work || await within(work, this.stopWaitMs);
		try { ctx.ui.setStatus(STATUS_KEY, undefined); } catch {}
		this.board.clear(true);
		s?.agents?.clear();
		if (s) s.held = undefined;
		const release = () => {
			held?.unannounce?.();
			try { held?.lock.release(); } catch {}
		};
		if (settled) release();
		else void work!.finally(release);
	}
}
