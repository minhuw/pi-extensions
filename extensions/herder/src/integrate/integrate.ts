// Serial integration onto the run's hidden integration ref (§11).
import { runChecks } from "../checks/runner.ts";
import { findIntegration } from "../journal/fold.ts";
import { integrationKey } from "../journal/keys.ts";
import { integrationRef, worktreePath } from "../run/paths.ts";
import type { RunStore } from "../run/store.ts";
import { type CheckResult, type CheckSpec, type Faults, INTEGRATE_OPTION_KEYS, type IntegrateOptions, type IntegrateResult, type JournalInput, noFaults, type StepResult, type Vcs } from "../types.ts";
import { hasHerderTrailer } from "../vcs/git.ts";

export interface IntegrateDeps { runId: string; store: RunStore; vcs: Vcs; checks: readonly CheckSpec[]; faults?: Faults; signal?: AbortSignal; onProgress?: () => void }
/** `from`: a launch's logical head (it keys replayed integrations); default: the real integration head. */
export interface IntegrateContext { from?: string }
export interface Integrator { integrate(source: StepResult | string, opts: IntegrateOptions, ctx?: IntegrateContext): Promise<IntegrateResult>; head(): string }

export const INTEGRATION_SLOT = "integration";

/** One queue per run directory, shared by every integrator in the process; the run lock covers other processes. */
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const result = (queues.get(key) ?? Promise.resolve()).then(fn);
	const tail = result.catch(() => {});
	queues.set(key, tail);
	void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
	return result;
}

function validateOptions(opts: IntegrateOptions): void {
	if (opts === null || typeof opts !== "object") throw new Error("integrate: options must be an object with a message");
	const unknown = Object.keys(opts).filter((key) => !(INTEGRATE_OPTION_KEYS as readonly string[]).includes(key));
	if (unknown.length) throw new Error(`integrate: unknown option${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`);
	if (typeof opts.message !== "string" || !opts.message.trim()) throw new Error("integrate: message must be a non-empty string");
	if (hasHerderTrailer(opts.message)) throw new Error("integrate: message must not contain Herder-* trailers; integration commits are delivered as they are");
	if (opts.task !== undefined && typeof opts.task !== "string") throw new Error("integrate: task must be a string");
	if (opts.checks !== undefined && (!Array.isArray(opts.checks) || opts.checks.some((id) => typeof id !== "string"))) throw new Error("integrate: checks must be a list of check ids");
}

export function selectChecks(checks: readonly CheckSpec[], ids: readonly string[] | undefined): CheckSpec[] {
	if (ids === undefined) return checks.filter((check) => check.integrate);
	return ids.map((id) => {
		const spec = checks.find((check) => check.id === id);
		if (!spec) throw new Error(`integrate: unknown check ${JSON.stringify(id)}; known checks: ${checks.map((check) => check.id).join(", ") || "none"}`);
		return spec;
	});
}

const sameMessage = (a: string, b: string) => a.trimEnd() === b.trimEnd();

export function createIntegrator(deps: IntegrateDeps): Integrator {
	const { runId, store, vcs } = deps;
	const faults = deps.faults ?? noFaults;
	const ref = integrationRef(runId);
	const realHead = () => {
		const head = vcs.readRef(ref);
		if (head === null) throw new Error(`run ${runId} has no integration ref ${ref}`);
		return head;
	};
	const append = (event: JournalInput) => { store.journal.append(event); deps.onProgress?.(); };

	async function runIntegrationChecks(specs: readonly CheckSpec[], commit: string, key: string): Promise<CheckResult[]> {
		if (!specs.length) return [];
		const path = worktreePath(vcs.commonDir(), runId, INTEGRATION_SLOT);
		vcs.removeWorktree(path);
		try {
			vcs.addWorktree(path, commit);
			const results = await runChecks(specs, { cwd: path, commit, outputs: store.outputs, signal: deps.signal });
			for (const r of results) append({ t: "check.completed", checkId: r.id, commit, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, logRef: r.logRef, tail: r.tail, purpose: "integrate", key });
			return results;
		} finally {
			vcs.removeWorktree(path);
		}
	}

	async function integrateLocked(source: string, opts: IntegrateOptions, specs: CheckSpec[], logicalFrom: string): Promise<IntegrateResult> {
		const { message, task } = opts;
		const key = integrationKey(logicalFrom, source, message);
		const recorded = findIntegration(store.state(), key);
		if (recorded) return { status: "integrated", head: recorded.head, checks: recorded.checks };

		// Crash after the ref advanced but before the journal: the head is the integration this call would make.
		const current = realHead();
		const parents = vcs.parentsOf(current);
		if (parents.length === 1 && parents[0] === logicalFrom && sameMessage(vcs.message(current), message)) {
			const expected = vcs.mergeTree(logicalFrom, source);
			const tree = vcs.treeOf(current);
			if (expected.clean && expected.tree === tree) {
				append({ t: "integrate.completed", key, from: logicalFrom, source, head: current, tree, message, task, checks: [] });
				return { status: "integrated", head: current, checks: [] };
			}
		}

		// Live: always onto the real head, so the line never rewinds.
		const from = current;
		const merged = vcs.mergeTree(from, source);
		if (!merged.clean) {
			append({ t: "integrate.failed", key, from, source, reason: "conflict", conflicts: merged.conflicts, message, task });
			return { status: "conflict", conflicts: merged.conflicts };
		}
		if (merged.tree === vcs.treeOf(from)) {
			append({ t: "integrate.completed", key, from, source, head: from, tree: merged.tree, message, task, checks: [] });
			return { status: "integrated", head: from, checks: [] };
		}
		const commit = vcs.commitTree(merged.tree, [from], message);
		faults.hit("after-merge-commit", key);
		const checks = await runIntegrationChecks(specs, commit, key);
		if (checks.some((check) => !check.passed)) {
			append({ t: "integrate.failed", key, from, source, reason: "checks_failed", checks, message, task });
			return { status: "checks_failed", checks };
		}
		faults.hit("before-ref-advance", key);
		vcs.updateRef(ref, commit, from);
		faults.hit("after-ref-advance", key);
		append({ t: "integrate.completed", key, from, source, head: commit, tree: merged.tree, message, task, checks });
		return { status: "integrated", head: commit, checks };
	}

	return {
		head: realHead,
		async integrate(source, opts, ctx = {}) {
			validateOptions(opts);
			const specs = selectChecks(deps.checks, opts.checks);
			let commit: string;
			if (typeof source === "string") commit = vcs.resolve(source);
			else if (source === null || typeof source !== "object") throw new Error("integrate: source must be a step result or a commit");
			else if (source.status === "failed" || source.status === "stopped") throw new Error(`integrate: step ${source.key} ${source.status}; only completed steps can be integrated`);
			else if (source.commit !== undefined) commit = vcs.resolve(source.commit);
			else if (source.status === "no_changes") return { status: "integrated", head: ctx.from ?? realHead() };
			else throw new Error(`integrate: step ${source.key} has no commit (read-only steps cannot be integrated)`);
			return serialize(store.paths.dir, () => integrateLocked(commit, opts, specs, ctx.from ?? realHead()));
		},
	};
}
