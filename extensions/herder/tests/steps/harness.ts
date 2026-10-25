import { existsSync, readdirSync } from "node:fs";
import { expect } from "vitest";
import { LIMITS } from "../../src/config.ts";
import { findIntegration } from "../../src/journal/fold.ts";
import { integrationKey } from "../../src/journal/keys.ts";
import { baseRef, integrationRef } from "../../src/run/paths.ts";
import { createRun, openRun, type RunStore } from "../../src/run/store.ts";
import { createStepExecutor, type StepDeps } from "../../src/steps/executor.ts";
import type { LaunchDeps } from "../../src/steps/launch.ts";
import type { CheckSpec, IntegrateOptions, IntegrateResult, JournalEvent, Limits, RoleDefinition, StepResult, Vcs } from "../../src/types.ts";
import { openVcs } from "../../src/vcs/git.ts";
import { FakeRunner, fakeRole } from "../support/fake-runner.ts";
import { withGitFixture, type GitFixture } from "../support/git-fixture.ts";

export const CHECKS: CheckSpec[] = [
	{ id: "has-feature", command: "test -f feature.txt", timeoutMs: 10_000, integrate: true },
	{ id: "always-fails", command: "echo boom; exit 1", timeoutMs: 10_000, integrate: false },
];
export const TEST_LIMITS: Limits = { ...LIMITS, concurrentAgents: 4, retryBackoffMs: [5, 5], stallRestarts: 1 };

export interface Harness {
	fixture: GitFixture; vcs: Vcs; store: RunStore; runner: FakeRunner; head: string;
	roles: Map<string, RoleDefinition>;
	sleeps: number[];
	deps(extra?: Partial<StepDeps>): StepDeps;
	launchDeps(extra?: Partial<LaunchDeps>): LaunchDeps;
	executor(extra?: Partial<StepDeps>): ReturnType<typeof createStepExecutor>;
	/** The same run reopened, as a fresh process would see it. */
	reopen(): RunStore;
	events(): JournalEvent[];
	types(): string[];
	/** No worktree is left under the run, and the checkout is untouched (invariant 2). */
	assertClean(): void;
}

export function withRun(fn: (h: Harness) => Promise<void>): Promise<void> {
	return withGitFixture(async (fixture) => {
		const vcs = openVcs(fixture.dir);
		const head = fixture.head();
		const store = createRun(vcs.commonDir(), { title: "test", base: head, repo: fixture.dir });
		vcs.updateRef(baseRef(store.runId), head, null);
		vcs.updateRef(integrationRef(store.runId), head, null);
		const roles = new Map(["worker", "reviewer", "explorer"].map((name) => [name, fakeRole(name)]));
		const runner = new FakeRunner();
		const sleeps: number[] = [];
		const h: Harness = {
			fixture, vcs, store, runner, head, roles, sleeps,
			deps: (extra = {}) => ({
				runId: store.runId, store, vcs, runner, roles, checks: CHECKS, limits: TEST_LIMITS,
				sleep: async (ms) => { sleeps.push(ms); }, ...extra,
			}),
			launchDeps: (extra = {}) => ({ ...h.deps(), integrator: fakeIntegrator(h.deps().store, vcs), ...extra }),
			executor: (extra) => createStepExecutor(h.deps(extra)),
			reopen: () => openRun(vcs.commonDir(), store.runId),
			events: () => store.journal.read(),
			types: () => store.journal.read().map((event) => event.t),
			assertClean() {
				const dir = store.paths.worktrees;
				expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
				expect(fixture.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
				expect(fixture.status()).toBe("");
				expect(fixture.head()).toBe(head);
			},
		};
		await fn(h);
	});
}

/**
 * A minimal stand-in for the integrator: reuses a journaled integration for (from, source, message), otherwise
 * merges into the real integration head and advances it.
 */
export function fakeIntegrator(store: RunStore, vcs: Vcs): LaunchDeps["integrator"] & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async integrate(source: StepResult | string, opts: IntegrateOptions, ctx?: { from?: string }): Promise<IntegrateResult> {
			const commit = typeof source === "string" ? source : source.commit;
			if (!commit) throw new Error("nothing to integrate");
			const ref = integrationRef(store.runId);
			const head = vcs.readRef(ref)!;
			const from = ctx?.from ?? head;
			const key = integrationKey(from, commit, opts.message);
			const done = findIntegration(store.state(), key);
			if (done) return { status: "integrated", head: done.head };
			calls.push(opts.message);
			const merged = vcs.mergeTree(head, commit);
			if (!merged.clean) return { status: "conflict", conflicts: merged.conflicts };
			const next = vcs.commitTree(merged.tree, [head], opts.message);
			vcs.updateRef(ref, next, head);
			store.journal.append({ t: "integrate.completed", key, from, source: commit, head: next, tree: merged.tree, message: opts.message, task: opts.task, checks: [] });
			return { status: "integrated", head: next };
		},
	};
}

export function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

export async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((done) => setTimeout(done, 5));
	}
}
