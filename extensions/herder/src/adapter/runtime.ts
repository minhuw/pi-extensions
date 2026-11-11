// The adapter's view of the Herder runtime: one instance per held run, so the Pi layer stays testable with a fake.
import { readFileSync } from "node:fs";
import { loadRoles } from "../agents/roles.ts";
import { parseGoal } from "../artifacts/goal.ts";
import { runChecks } from "../checks/runner.ts";
import { LIMITS } from "../config.ts";
import { cleanupRun, deliver, type DeliveryOutcome, type DeliveryRequest } from "../deliver/deliver.ts";
import { createIntegrator } from "../integrate/integrate.ts";
import { baseRef, integrationRef, worktreePath } from "../run/paths.ts";
import type { RunStore } from "../run/store.ts";
import { createStepExecutor, type StepActivity, type StepDeps } from "../steps/executor.ts";
import { launchScript, type LaunchHandle, type LaunchOutcome, type LaunchRequest } from "../steps/launch.ts";
import type { AgentOptions, AgentRunner, CheckResult, Faults, IntegrateOptions, IntegrateResult, Limits, RoleDefinition, StepResult, Vcs } from "../types.ts";
import { verifyRun, type VerifyOutcome } from "../verify/verify.ts";
import { planTasks } from "./status.ts";

export type { DeliveryOutcome, DeliveryRequest, LaunchHandle, LaunchOutcome, LaunchRequest, StepActivity, VerifyOutcome };

/** What only the adapter knows. `runner` is built on first use from the main session's model runtime. */
export interface RuntimeEnv {
	cwd: string; sessionId: string; vcs: Vcs; run: RunStore;
	runner: () => AgentRunner;
	/** Aborts on `/herder abort`, session shutdown, and a lost run lock. */
	signal: AbortSignal;
	onActivity: (activity: StepActivity) => void;
	/** Called after the runtime journals something, so the footer can refresh. */
	onProgress: () => void;
}

export interface CheckRequest { checks?: string[]; commit?: string }

export interface HerderRuntime {
	/** Role names available to `agent()`. */
	roles(): string[];
	/** The roles among them that cannot write. */
	readOnlyRoles(): string[];
	/** Pins `refs/herder/<runId>/base` and `integration` at the run's base commit. */
	start(): void;
	/** One direct `agent()` step; `base` defaults to the real integration head. */
	step(prompt: string, opts: AgentOptions, signal?: AbortSignal): Promise<StepResult>;
	/** `source` is a commit-ish; the adapter resolves step keys to their commits. */
	integrate(source: string, opts: IntegrateOptions, signal?: AbortSignal): Promise<IntegrateResult>;
	/** Runs the named checks (default: all) at `commit` (default: the integration head). */
	check(request: CheckRequest, signal?: AbortSignal): Promise<CheckResult[]>;
	verify(signal?: AbortSignal): Promise<VerifyOutcome>;
	/** `confirm` shows the delivery summary to the user; nothing reaches the checkout without a yes. */
	deliver(request: DeliveryRequest, confirm: (summary: string) => Promise<boolean>, signal?: AbortSignal): Promise<DeliveryOutcome>;
	/** Stores the script as `scripts/<n>.js`, journals `script.launched`, and runs it in the background. */
	launch(request: LaunchRequest): LaunchHandle | Promise<LaunchHandle>;
	/** Journals `run.finished abandoned` and removes the run's refs and worktrees; returns a warning if that removal failed. */
	abandon(reason: string): string | void | Promise<string | void>;
}

export type RuntimeFactory = (env: RuntimeEnv) => HerderRuntime;

/** Test seams; production uses the defaults. */
export interface RuntimeOptions {
	roles?: () => ReadonlyMap<string, RoleDefinition>;
	limits?: Limits; faults?: Faults;
	sleep?: StepDeps["sleep"];
}

export const CHECK_SLOT = "check";

export function createRuntimeFactory(options: RuntimeOptions = {}): RuntimeFactory {
	return (env) => {
		const { run, vcs } = env;
		const runId = run.runId;
		// Roles and goal values are read per call: the runtime exists before the goal is approved, and role files may change.
		const roles = () => options.roles?.() ?? loadRoles();
		const goal = () => {
			const state = run.state();
			if (!state.goal) throw new Error(`The goal of Herder run ${runId} is not approved yet.`);
			let parsed: ReturnType<typeof parseGoal> | undefined;
			try { parsed = parseGoal(readFileSync(run.paths.goal, "utf8")); } catch {}
			return { checks: state.goal.checks, title: parsed?.title ?? state.title ?? "", maxAgents: Math.min(LIMITS.agentsPerRun, parsed?.budget.maxAgents ?? Infinity) };
		};
		const progress = () => {
			try { run.renderProgress(planTasks(run)); } catch {}
			env.onProgress();
		};
		const combine = (signal?: AbortSignal) => (signal ? AbortSignal.any([env.signal, signal]) : env.signal);
		const stepDeps = (signal: AbortSignal): StepDeps => {
			const { checks, maxAgents } = goal();
			return {
				runId, store: run, vcs, runner: env.runner(), roles: roles(), checks, maxAgents, signal,
				limits: options.limits, faults: options.faults, sleep: options.sleep, onProgress: progress, onActivity: env.onActivity,
			};
		};
		const integrator = (signal: AbortSignal) => createIntegrator({ runId, store: run, vcs, checks: goal().checks, faults: options.faults, signal, onProgress: progress });
		const integrationHead = () => {
			const head = vcs.readRef(integrationRef(runId));
			if (!head) throw new Error(`Herder run ${runId} has no integration ref.`);
			return head;
		};

		return {
			roles: () => [...roles().keys()],
			readOnlyRoles: () => [...roles()].filter(([, role]) => !role.write).map(([name]) => name),
			start() {
				const base = run.state().base;
				if (!base) throw new Error(`Herder run ${runId} has no base commit.`);
				vcs.updateRef(baseRef(runId), base, null);
				vcs.updateRef(integrationRef(runId), base, null);
			},
			step: (prompt, opts, signal) => createStepExecutor(stepDeps(combine(signal))).run(prompt, opts),
			integrate: (source, opts, signal) => integrator(combine(signal)).integrate(source, opts),
			async check(request, signal) {
				const all = goal().checks;
				const specs = request.checks ? request.checks.map((id) => {
					const spec = all.find((check) => check.id === id);
					if (!spec) throw new Error(`Unknown check id ${id}.`);
					return spec;
				}) : all;
				const commit = request.commit ? vcs.resolve(request.commit) : integrationHead();
				if (!specs.length) return [];
				const path = worktreePath(vcs.commonDir(), runId, CHECK_SLOT);
				vcs.removeWorktree(path);
				try {
					vcs.addWorktree(path, commit);
					const results = await runChecks(specs, { cwd: path, commit, outputs: run.outputs, signal: combine(signal) });
					for (const r of results) run.journal.append({ t: "check.completed", checkId: r.id, commit, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, logRef: r.logRef, tail: r.tail, purpose: "manual" });
					progress();
					return results;
				} finally {
					// The next check removes a leftover worktree first; the journaled results matter more.
					try { vcs.removeWorktree(path); } catch {}
				}
			},
			verify(signal) {
				const { checks } = goal();
				return verifyRun({ runId, store: run, vcs, runner: env.runner(), roles: roles(), checks, limits: options.limits, signal: combine(signal), onProgress: progress });
			},
			deliver(request, confirm, signal) {
				const { checks, title } = goal();
				return deliver({ runId, store: run, vcs, runner: env.runner(), roles: roles(), checks, title, faults: options.faults, signal: combine(signal), onProgress: progress, confirm }, request);
			},
			// The launch cancels its own steps and integrations when it stops or settles.
			launch: (request) => launchScript({ ...stepDeps(env.signal), integrator: integrator(env.signal) }, request),
			abandon(reason) {
				run.journal.append({ t: "run.finished", status: "abandoned", reason });
				try {
					cleanupRun(vcs, vcs.commonDir(), runId);
				} catch (error) {
					return `cleanup failed (refs/herder/${runId}/ or the run's worktrees may remain): ${error instanceof Error ? error.message : String(error)}`;
				} finally {
					progress();
				}
			},
		};
	};
}

export const createRuntime: RuntimeFactory = createRuntimeFactory();
