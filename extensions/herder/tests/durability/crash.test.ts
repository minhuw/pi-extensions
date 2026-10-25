import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { baseRef, integrationRef, stepRef } from "../../src/run/paths.ts";
import { createRun, type RunStore } from "../../src/run/store.ts";
import type { LaunchOutcome } from "../../src/steps/launch.ts";
import type { JournalEvent, JournalEventType, Vcs } from "../../src/types.ts";
import { openVcs } from "../../src/vcs/git.ts";
import { isolateGitConfig } from "../integrate/support.ts";
import { FakeRunner } from "../support/fake-runner.ts";
import { withGitFixture, type GitFixture } from "../support/git-fixture.ts";
import {
	CHECKS, CRASH_EXIT, describeFault, FaultError, INTEGRATION_POINTS, launch, MESSAGES, rig, rules, RUN_ID, STEP_POINTS, stepKey, taskOf, TASKS,
	type Fault, type Task,
} from "./support.ts";

isolateGitConfig();

const CHILD = resolve(import.meta.dirname, "child.ts");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

interface Env { fixture: GitFixture; vcs: Vcs; store: RunStore; base: string }

/** A fresh repository with an approved run whose base and integration refs sit at HEAD. */
function withEnv<T>(fn: (env: Env) => Promise<T>): Promise<T> {
	return withGitFixture(async (fixture) => {
		const vcs = openVcs(fixture.dir);
		const base = fixture.head();
		const store = createRun(vcs.commonDir(), { title: "durability", base, repo: fixture.dir, runId: RUN_ID });
		store.journal.append({ t: "goal.approved", sha256: "0".repeat(64), checks: CHECKS, approvedBy: "user" });
		vcs.updateRef(baseRef(RUN_ID), base, null);
		vcs.updateRef(integrationRef(RUN_ID), base, null);
		return fn({ fixture, vcs, store, base });
	});
}

const head = (env: Env) => env.vcs.readRef(integrationRef(RUN_ID))!;
// Oldest first.
const line = (env: Env) => env.vcs.revList(`${env.base}..${head(env)}`);
const events = <T extends JournalEventType>(env: Env, t: T) => env.store.journal.read().filter((event): event is Extract<JournalEvent, { t: T }> => event.t === t);
const tasks = (runner: FakeRunner) => runner.calls.map((call) => taskOf(call.prompt));

interface Baseline { tree: string; messages: string[]; calls: string[] }
let baseline: Baseline;

beforeAll(async () => {
	baseline = await withEnv(async (env) => {
		const { faults, runner } = rig(undefined, () => {});
		const outcome = await launch(env.fixture.dir, runner, faults);
		expect(outcome).toMatchObject({ launch: 1, status: "completed", new: 2, reused: 0 });
		return { tree: env.vcs.treeOf(head(env)), messages: line(env).map((commit) => env.vcs.message(commit).trimEnd()), calls: tasks(runner) };
	});
	expect(baseline.messages).toEqual(MESSAGES);
	expect(baseline.calls).toEqual(["T1", "T2"]);
});

const LOST: ReadonlySet<string> = new Set(["before-worktree", "after-agent", "after-commit"]);

/**
 * Agents the resume must run: a step whose crash left no durable result (no ref, no journal entry) and a T2 that a
 * crash in T1 left unfinished. Every other step is reused or adopted.
 */
function rerun(fault: Fault): Task[] {
	if (!("task" in fault)) return [];
	if (fault.task === "T1") return LOST.has(fault.point) ? ["T1", "T2"] : ["T2"];
	return LOST.has(fault.point) ? ["T2"] : [];
}

/** Agents the throwing crash run starts: T2 is already waiting on T1 when T1 crashes. */
function crashCalls(fault: Fault): Task[] {
	if (!("task" in fault)) return ["T1", "T2"];
	if (fault.point === "before-worktree") return fault.task === "T1" ? ["T2"] : ["T1"];
	return ["T1", "T2"];
}

const CASES: Fault[] = [
	...STEP_POINTS.flatMap((point) => TASKS.map((task) => ({ point, task }))),
	...INTEGRATION_POINTS.flatMap((point) => ([1, 2] as const).map((nth) => ({ point, nth }))),
];

/** Crashes launch 1 in this process by throwing a FaultError at the planned point. */
async function crashByThrow(env: Env, fault: Fault): Promise<void> {
	const hits: string[] = [];
	const { faults, runner } = rig(fault, (point, key) => {
		hits.push(`${point}:${key}`);
		throw new FaultError(point, key);
	});
	const outcome = await launch(env.fixture.dir, runner, faults);
	expect(hits).toHaveLength(1);
	expect(outcome).toMatchObject({ launch: 1, status: "failed", error: expect.stringContaining("injected crash") });
	expect(tasks(runner).sort()).toEqual(crashCalls(fault));
	expect(events(env, "script.settled")).toMatchObject([{ launch: 1, status: "failed" }]);
}

/** Crashes launch 1 in a child process that exits at the planned point, so no cleanup runs. */
function crashByExit(env: Env, fault: Fault): void {
	const dir = mkdtempSync(join(tmpdir(), "herder-durability-"));
	try {
		const report = join(dir, "report.json");
		const child = spawnSync(process.execPath, [CHILD, env.fixture.dir, JSON.stringify(fault), report], { env: GIT_ENV, encoding: "utf8", timeout: 30_000 });
		expect(child.stderr).toBe("");
		expect(child.status).toBe(CRASH_EXIT);
		const { point, calls } = JSON.parse(readFileSync(report, "utf8")) as { point: string; calls: string[] };
		expect(point).toBe(fault.point);
		// The crashed step's agent ran unless the crash came before it.
		// Which other agent started before the exit depends on scheduling; none starts twice.
		expect(new Set(calls).size).toBe(calls.length);
		if ("task" in fault) expect(calls.includes(fault.task)).toBe(fault.point !== "before-worktree");
		else expect(calls.sort()).toEqual(["T1", "T2"]);
		expect(events(env, "script.settled")).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Relaunches launch 1 with a fresh runtime and no faults. */
async function resume(env: Env): Promise<{ outcome: LaunchOutcome; calls: string[] }> {
	const runner = new FakeRunner(rules());
	const outcome = await launch(env.fixture.dir, runner, { hit() {} }, 1);
	return { outcome, calls: tasks(runner) };
}

/** No worktree is left. */
function assertNoWorktrees(env: Env) {
	const dir = env.store.paths.worktrees;
	expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	expect(env.fixture.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
}

/** §16 invariants 3, 5, 6, and 7 after the resume, plus the baseline's tree and a clean checkout. */
function assertRecovered(env: Env, outcome: LaunchOutcome, calls: string[], rerunTasks: Task[]) {
	const final = head(env);
	expect(outcome).toMatchObject({ launch: 2, status: "completed", value: { head: final, integrated: ["T1", "T2"], failed: [] } });
	expect(outcome).toMatchObject({ reused: 2 - rerunTasks.length, changed: 0, new: rerunTasks.length });
	expect(events(env, "script.launched").at(-1)).toMatchObject({ launch: 2, resumes: 1 });

	// Invariant 6: completed steps are not re-executed and nothing is applied twice.
	expect(calls.sort()).toEqual(rerunTasks);
	const completed = events(env, "step.completed");
	for (const task of TASKS) {
		const records = completed.filter((event) => event.key === stepKey(task));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ status: "ok", ref: stepRef(RUN_ID, stepKey(task)) });
		expect(env.vcs.readRef(stepRef(RUN_ID, stepKey(task)))).toBe(records[0]!.commit);
	}
	for (const event of events(env, "step.failed")) expect(event.errorClass).toBe("stopped");
	expect(events(env, "integrate.failed")).toEqual([]);
	const commits = line(env);
	expect(commits.map((commit) => env.vcs.message(commit).trimEnd())).toEqual(baseline.messages);
	expect(env.vcs.treeOf(final)).toBe(baseline.tree);
	const integrations = events(env, "integrate.completed");
	const heads = new Map<string, Set<string>>();
	for (const event of integrations) heads.set(event.key, (heads.get(event.key) ?? new Set()).add(event.head));
	for (const set of heads.values()) expect(set.size).toBe(1);

	// Invariant 3: every commit on the line was journaled as integrated with passing checks, in a linear chain.
	const integrateChecks = CHECKS.filter((check) => check.integrate).map((check) => check.id);
	for (const [index, commit] of commits.entries()) {
		expect(env.vcs.parentsOf(commit)).toEqual([index === 0 ? env.base : commits[index - 1]]);
		const record = integrations.find((event) => event.head === commit);
		expect(record, `integrate.completed for ${commit}`).toBeDefined();
		// An adopted integration records no checks of its own; the crashed process journaled them before advancing the ref.
		const passed = record!.checks.length > 0
			? record!.checks.filter((check) => check.passed).map((check) => check.id)
			: events(env, "check.completed").filter((event) => event.purpose === "integrate" && event.commit === commit && event.exitCode === 0).map((event) => event.checkId);
		expect([...new Set(passed)].sort()).toEqual(integrateChecks);
		expect(record!.checks.every((check) => check.passed)).toBe(true);
	}

	// Invariant 5: no Herder trailers on the integration line.
	for (const commit of commits) expect(env.vcs.message(commit)).not.toMatch(/^herder-/im);

	// Invariant 7: every journal line is complete JSON.
	const raw = readFileSync(env.store.paths.journal, "utf8");
	expect(raw.endsWith("\n")).toBe(true);
	for (const text of raw.slice(0, -1).split("\n")) expect(() => JSON.parse(text)).not.toThrow();

	// No worktree is left and the user's checkout is untouched.
	assertNoWorktrees(env);
	expect(env.fixture.status()).toBe("");
	expect(env.fixture.head()).toBe(env.base);
}

describe.each(CASES)("crash at $point", (fault) => {
	it(`throw: ${describeFault(fault)} — the launch fails and a fresh runtime resumes it`, () => withEnv(async (env) => {
		await crashByThrow(env, fault);
		const { outcome, calls } = await resume(env);
		assertRecovered(env, outcome, calls, rerun(fault));
	}));

	it(`exit: ${describeFault(fault)} — the process dies and a fresh runtime resumes it`, () => withEnv(async (env) => {
		crashByExit(env, fault);
		const { outcome, calls } = await resume(env);
		assertRecovered(env, outcome, calls, rerun(fault));
	}));
});

describe("torn journal tail", () => {
	it("resumes past a torn final line and does not glue it to the next event", () => withEnv(async (env) => {
		const fault: Fault = { point: "after-agent", task: "T2" };
		crashByExit(env, fault);
		const torn = `{"v":1,"t":"step.completed","key":"${stepKey("T2")}","fingerp`;
		appendFileSync(env.store.paths.journal, torn);
		const { outcome, calls } = await resume(env);
		assertRecovered(env, outcome, calls, rerun(fault));
		expect(readFileSync(env.store.paths.journal, "utf8")).not.toContain(torn);
	}));
});
