// The crash rig shared by the suite and its child process; it must not import Vitest.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIMITS } from "../../src/config.ts";
import { createIntegrator } from "../../src/integrate/integrate.ts";
import { stepKey as keyOf } from "../../src/journal/keys.ts";
import { openRun } from "../../src/run/store.ts";
import { launchScript, type LaunchOutcome } from "../../src/steps/launch.ts";
import type { CheckSpec, FaultPoint, Faults, Limits } from "../../src/types.ts";
import { openVcs } from "../../src/vcs/git.ts";
import { FakeRunner, fakeRole, type FakeRule } from "../support/fake-runner.ts";

export const RUN_ID = "20260101-000000-cafe";
/** The child's exit status when it reached the planned fault. */
export const CRASH_EXIT = 86;
export const TASKS = ["T1", "T2"] as const;
export type Task = (typeof TASKS)[number];
export const STEP_POINTS = ["before-worktree", "after-agent", "after-commit", "after-ref", "after-journal"] as const satisfies readonly FaultPoint[];
export const INTEGRATION_POINTS = ["after-merge-commit", "before-ref-advance", "after-ref-advance"] as const satisfies readonly FaultPoint[];

export const CHECKS: CheckSpec[] = [
	{ id: "a-present", command: "test -f a/T1.txt", timeoutMs: 20_000, integrate: false },
	{ id: "b-present", command: "test -f b/T2.txt", timeoutMs: 20_000, integrate: false },
	{ id: "readme", command: "test -f README.md", timeoutMs: 20_000, integrate: true },
];
export const ARGS = {
	tasks: [
		{ id: "T1", prompt: "Implement T1.", owns: ["a/**"], gate: "a-present", message: "feat(T1): implement" },
		{ id: "T2", prompt: "Implement T2.", owns: ["b/**"], gate: "b-present", message: "feat(T2): implement" },
	],
};
export const MESSAGES = ARGS.tasks.map((task) => task.message);
export const stepKey = (task: Task) => keyOf(`impl-${task}`, 0);
export const SCRIPT = readFileSync(fileURLToPath(new URL("../../templates/disjoint.js", import.meta.url)), "utf8");
const ROLES = new Map([["worker", fakeRole("worker")]]);
const LIMITS_FAST: Limits = { ...LIMITS, concurrentAgents: 4, retryBackoffMs: [0, 0, 0] };

/** Where to crash: a step point names the step key it crashes in, an integration point the nth integration (1-based). */
export type Fault = { point: (typeof STEP_POINTS)[number]; task: Task } | { point: (typeof INTEGRATION_POINTS)[number]; nth: 1 | 2 };
export const describeFault = (fault: Fault) => `${fault.point} in ${"task" in fault ? stepKey(fault.task) : `integration ${fault.nth}`}`;

export class FaultError extends Error {
	constructor(point: FaultPoint, key: string) {
		super(`injected crash at ${point} (${key})`);
		this.name = "FaultError";
	}
}

/** The task an agent call belongs to. */
export const taskOf = (prompt: string) => /^Implement (T\d)\./.exec(prompt)?.[1] ?? "?";

/**
 * Faults that call `crash` at the planned hit, and a runner whose T2 agent waits until T1's step is journaled. The wait
 * makes a crash deterministic: T1 always completes before T2 can, and a crash in T1 always leaves T2 unfinished.
 */
export function rig(fault: Fault | undefined, crash: (point: FaultPoint, key: string) => void): { faults: Faults; runner: FakeRunner } {
	let release!: () => void;
	const t1Done = new Promise<void>((resolve) => { release = resolve; });
	const counts = new Map<FaultPoint, number>();
	const faults: Faults = {
		hit(point, key) {
			const n = (counts.get(point) ?? 0) + 1;
			counts.set(point, n);
			if (fault?.point === point && ("task" in fault ? stepKey(fault.task) === key : fault.nth === n)) crash(point, key);
			if (point === "after-journal" && key === stepKey("T1")) release();
		},
	};
	return { faults, runner: new FakeRunner(rules(t1Done)) };
}

export const rules = (t2After?: Promise<unknown>): FakeRule[] => [
	{ match: "Implement T1.", files: { "a/T1.txt": "T1\n" } },
	{ match: "Implement T2.", files: { "b/T2.txt": "T2\n" }, ...(t2After ? { waitFor: t2After } : {}) },
];

/** Launches the disjoint script over the run in `dir` with fresh Vcs, store, executor, and integrator, as a new process would. */
export function launch(dir: string, runner: FakeRunner, faults: Faults, resume?: number): Promise<LaunchOutcome> {
	const vcs = openVcs(dir);
	const store = openRun(vcs.commonDir(), RUN_ID);
	const integrator = createIntegrator({ runId: RUN_ID, store, vcs, checks: CHECKS, faults });
	const deps = { runId: RUN_ID, store, vcs, runner, roles: ROLES, checks: CHECKS, limits: LIMITS_FAST, faults, sleep: async () => {}, integrator };
	return launchScript(deps, { source: SCRIPT, args: ARGS, resume }).done;
}
