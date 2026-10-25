// Runs a launch's script in the sandbox against the step executor and the integrator (§6, §7).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DEFAULT_ROLE, LIMITS } from "../config.ts";
import { Occurrences, sha256Hex } from "../journal/keys.ts";
import { integrationRef, worktreePath } from "../run/paths.ts";
import type { IntegrateOptions, IntegrateResult, LaunchStatus, StepResult, WorkflowBridge } from "../types.ts";
import { runScript } from "../workflow/sandbox.ts";
import { createStepExecutor, type LaunchStats, type StepDeps } from "./executor.ts";

export interface LaunchDeps extends StepDeps {
	integrator: { integrate(source: StepResult | string, opts: IntegrateOptions, ctx?: { from?: string }): Promise<IntegrateResult> };
	onLog?: (message: string) => void;
	onPhase?: (title: string) => void;
}
export interface LaunchRequest { source: string; args?: unknown; resume?: number }
export interface LaunchOutcome { launch: number; status: LaunchStatus; value?: unknown; error?: string; reused: number; changed: number; new: number; resultRef?: string }
export interface LaunchHandle { readonly launch: number; readonly done: Promise<LaunchOutcome>; stop(reason?: string): void }

interface Prepared { base: string; phase: string | undefined }

/** Run directories with a launch in progress in this process. */
const active = new Set<string>();

/** Throws synchronously for an unknown `resume` launch, a missing integration ref, or a launch already in progress. */
export function launchScript(deps: LaunchDeps, request: LaunchRequest): LaunchHandle {
	const { store, vcs, runId } = deps;
	const runDir = store.paths.dir;
	if (active.has(runDir)) throw new Error(`run ${runId} already has a script launch in progress; stop it first`);
	const state = store.state();
	let head: string;
	if (request.resume !== undefined) {
		const record = state.launches.get(request.resume);
		if (!record) throw new Error(`cannot resume launch ${request.resume}: run ${runId} has no such launch`);
		head = record.launched.head;
	} else {
		const current = vcs.readRef(integrationRef(runId));
		if (!current) throw new Error(`run ${runId} has no integration ref`);
		head = current;
	}
	active.add(runDir);
	let launch: number;
	try {
		// No step of this run is running when a launch starts, so any step slot is a crashed process's leftover.
		const slots = existsSync(store.paths.worktrees) ? readdirSync(store.paths.worktrees) : [];
		for (const slot of slots) {
			if (!slot.startsWith("step-")) continue;
			try { vcs.removeWorktree(worktreePath(vcs.commonDir(), runId, slot)); } catch {}
		}
		launch = store.writeScript(request.source).launch;
		if (existsSync(store.paths.plan)) {
			const sha256 = sha256Hex(readFileSync(store.paths.plan));
			if (sha256 !== state.planSha256) store.journal.append({ t: "plan.updated", sha256 });
		}
		store.journal.append({ t: "script.launched", launch, scriptSha256: sha256Hex(request.source), args: request.args, head, resumes: request.resume });
	} catch (error) {
		active.delete(runDir);
		throw error;
	}

	const controller = new AbortController();
	const stats: LaunchStats = { reused: 0, changed: 0, new: 0 };
	const occurrences = new Occurrences();
	const executor = createStepExecutor(deps);
	const pending = new Set<Promise<unknown>>();
	const track = <T>(promise: Promise<T>): Promise<T> => {
		pending.add(promise);
		const forget = () => pending.delete(promise);
		promise.then(forget, forget);
		return promise;
	};
	let logicalHead = head;
	let phase: string | undefined;
	const bridge: WorkflowBridge = {
		// The default base and phase are read when the call arrives: when a slot frees differs between a live run and a replay.
		prepare: (): Prepared => ({ base: logicalHead, phase }),
		agent(prompt, opts, prepared) {
			const at = (prepared as Prepared | undefined) ?? { base: logicalHead, phase };
			return track(executor.run(prompt, opts, { launch, occurrences, base: () => at.base, phase: () => at.phase, stats, signal: controller.signal }));
		},
		async integrate(source, opts) {
			const result = await track(deps.integrator.integrate(source, opts, { from: logicalHead }));
			if (result.status === "integrated" && result.head) logicalHead = result.head;
			return result;
		},
		log: (message) => deps.onLog?.(message),
		phase(title) {
			phase = title;
			deps.onPhase?.(title);
		},
	};
	const script = runScript({
		source: request.source, args: request.args, bridge, limits: deps.limits ?? LIMITS,
		writes: (role, write) => write ?? deps.roles.get(role ?? DEFAULT_ROLE)?.write ?? false,
	});
	const stop = (reason?: string) => {
		script.stop(reason);
		controller.abort(reason ?? "stopped");
	};
	const onAbort = () => stop("the run was stopped");
	if (deps.signal?.aborted) onAbort();
	else deps.signal?.addEventListener("abort", onAbort, { once: true });

	const done = (async (): Promise<LaunchOutcome> => {
		try {
			const outcome = await script.done;
			// Calls the script left running (not awaited, or siblings of a failure) settle as stopped before the launch does.
			controller.abort("the script settled");
			await Promise.allSettled([...pending]);
			const resultRef = outcome.value === undefined ? undefined : store.outputs.put(JSON.stringify(outcome.value));
			store.journal.append({ t: "script.settled", launch, status: outcome.status, ...stats, resultRef, error: outcome.error });
			try { deps.onProgress ? deps.onProgress() : store.renderProgress(); } catch {}
			const result: LaunchOutcome = { launch, status: outcome.status, ...stats };
			if (outcome.value !== undefined) result.value = outcome.value;
			if (resultRef !== undefined) result.resultRef = resultRef;
			if (outcome.error !== undefined) result.error = outcome.error;
			return result;
		} finally {
			deps.signal?.removeEventListener("abort", onAbort);
			active.delete(runDir);
		}
	})();
	return { launch, done, stop };
}
