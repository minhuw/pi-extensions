// A gate_failed step keeps its commit so that a fix can build on it; neither integrate() nor herder_integrate takes it.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeFactory } from "../../src/adapter/runtime.ts";
import type { HerderOptions } from "../../src/adapter/session.ts";
import { loadRoles } from "../../src/agents/roles.ts";
import { createIntegrator } from "../../src/integrate/integrate.ts";
import { integrationRef, refPrefix, stepRef } from "../../src/run/paths.ts";
import { activeRun, openRun, type RunStore } from "../../src/run/store.ts";
import { createStepExecutor } from "../../src/steps/executor.ts";
import { launchScript } from "../../src/steps/launch.ts";
import { harness } from "../adapter/harness.ts";
import { FakeRunner, fakeRole, type FakeRule } from "../support/fake-runner.ts";
import { createGitFixture, type GitFixture, withGitFixture } from "../support/git-fixture.ts";
import { check, events, isolateGitConfig, type Run, setupRun, show, stepCommit } from "./support.ts";

isolateGitConfig();

// A per-task gate: not an integration check, so nothing but the step's status keeps its failure off the line.
const GATE = check("fixed", "grep -q fixed out.txt", false);
const RULES: FakeRule[] = [
	{ match: "fix out.txt", files: { "out.txt": "fixed\n" } },
	{ match: "write out.txt", files: { "out.txt": "broken\n", "impl.txt": "impl\n" } },
	{ match: "write it right", files: { "out.txt": "fixed\n" } },
	{ match: "write other.txt", files: { "other.txt": "other\n" } },
	{ match: "change nothing" },
];
const ROLES = new Map([["worker", fakeRole()]]);

const stepDeps = (run: Run, runner = new FakeRunner(RULES)) => ({ runId: run.runId, store: run.store, vcs: run.vcs, runner, roles: ROLES, checks: run.checks });
const integrator = (run: Run) => createIntegrator({ runId: run.runId, store: run.store, vcs: run.vcs, checks: run.checks });
const head = (run: Run) => run.vcs.readRef(integrationRef(run.runId))!;

/** What a refusal must leave alone: the integration head, the run's refs, and the journaled integrations. */
function integrationState(fixture: GitFixture, store: RunStore) {
	return {
		head: fixture.git("rev-parse", integrationRef(store.runId)),
		folded: store.state().integrationHead,
		refs: fixture.git("for-each-ref", "--format=%(refname) %(objectname)", `${refPrefix(store.runId)}/`),
		journaled: store.journal.read().filter((event) => event.t === "integrate.completed" || event.t === "integrate.failed"),
	};
}

describe("integrate() and a gate_failed step", () => {
	it("refuses the step result and its recorded commit, naming the step and its status, and moves nothing", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [GATE]);
		const failed = await createStepExecutor(stepDeps(run)).run("write out.txt", { id: "impl", gate: "fixed" });
		expect(failed).toMatchObject({ status: "gate_failed", key: "impl-0", commit: run.vcs.readRef(stepRef(run.runId, "impl-0")) });
		const before = integrationState(fixture, run.store);
		const integ = integrator(run);
		const refusal = /step impl-0 gate_failed/;
		await expect(integ.integrate(failed, { message: "feat: out" })).rejects.toThrow(refusal);
		// By commit, however it is named: the full SHA, an abbreviation, and the step's ref.
		for (const source of [failed.commit!, failed.commit!.slice(0, 12), stepRef(run.runId, "impl-0")]) {
			await expect(integ.integrate(source, { message: "feat: out" }), source).rejects.toThrow(refusal);
		}
		expect(integrationState(fixture, run.store)).toEqual(before);
		expect(before).toMatchObject({ head: run.base, folded: run.base, journaled: [] });
	}));

	it("integrates an ok fix built on the gate-failed commit", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [GATE]);
		const executor = createStepExecutor(stepDeps(run));
		const failed = await executor.run("write out.txt", { id: "impl", gate: "fixed" });
		const fix = await executor.run("fix out.txt", { id: "fix", base: failed.commit, gate: "fixed" });
		expect(fix.status).toBe("ok");
		expect(run.vcs.parentsOf(fix.commit!)).toEqual([failed.commit]);
		const result = await integrator(run).integrate(fix, { message: "feat: out" });
		expect(result).toMatchObject({ status: "integrated", head: head(run) });
		expect(run.vcs.parentsOf(head(run))).toEqual([run.base]);
		expect(show(run, head(run), "out.txt")).toBe("fixed");
		expect(show(run, head(run), "impl.txt")).toBe("impl");
		expect(events(run.store, "integrate.completed")).toMatchObject([{ source: fix.commit, head: head(run) }]);
	}));

	it("still integrates an ok step, an ok step's commit, and a commit of no step, and returns the head for no_changes", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [GATE]);
		const executor = createStepExecutor(stepDeps(run));
		const integ = integrator(run);
		// A gate_failed step elsewhere in the run changes nothing for the others.
		expect((await executor.run("write out.txt", { id: "impl", gate: "fixed" })).status).toBe("gate_failed");

		const right = await executor.run("write it right", { id: "right", gate: "fixed" });
		expect(right.status).toBe("ok");
		expect(await integ.integrate(right, { message: "by result" })).toMatchObject({ status: "integrated", head: head(run) });
		expect(show(run, head(run), "out.txt")).toBe("fixed");

		const other = await executor.run("write other.txt", { id: "other" });
		expect(other.status).toBe("ok");
		expect(await integ.integrate(other.commit!, { message: "by commit" })).toMatchObject({ status: "integrated", head: head(run) });
		expect(show(run, head(run), "other.txt")).toBe("other");

		const loose = stepCommit(run, head(run), { "loose.txt": "loose\n" });
		expect(await integ.integrate(loose, { message: "no step" })).toMatchObject({ status: "integrated", head: head(run) });
		expect(show(run, head(run), "loose.txt")).toBe("loose");
		expect(run.vcs.revList(`${run.base}..${head(run)}`)).toHaveLength(3);

		const idle = await executor.run("change nothing", { id: "idle" });
		expect(idle.status).toBe("no_changes");
		const at = head(run);
		expect(await integ.integrate(idle, { message: "nothing" })).toEqual({ status: "integrated", head: at });
		expect(head(run)).toBe(at);
		expect(events(run.store, "integrate.completed")).toHaveLength(3);
	}));
});

describe("integrate() in a workflow script", () => {
	const SCRIPT = `
const impl = await agent("write out.txt", { id: "impl", gate: "fixed" });
if (args.integrate === "result") return await integrate(impl, { message: "feat: out" });
if (args.integrate === "commit") return await integrate(impl.commit, { message: "feat: out" });
const fix = await agent("fix out.txt", { id: "fix", base: impl.commit, gate: "fixed" });
const result = await integrate(fix, { message: "feat: out" });
return [impl.status, fix.status, result.status];
`;

	it("fails the launch on a gate_failed step result or its commit, and integrates the ok fix built on it", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [GATE]);
		const runner = new FakeRunner(RULES);
		const launch = (args: unknown) => launchScript({ ...stepDeps(run, runner), integrator: integrator(run) }, { source: SCRIPT, args }).done;
		for (const form of ["result", "commit"]) {
			const outcome = await launch({ integrate: form });
			expect(outcome, form).toMatchObject({ status: "failed", error: expect.stringMatching(/step impl-0 gate_failed/) });
			expect(integrationState(fixture, run.store), form).toMatchObject({ head: run.base, folded: run.base, journaled: [] });
		}
		expect(run.store.state().steps.get("impl-0")).toMatchObject({ status: "gate_failed", completed: { commit: expect.any(String) } });

		const outcome = await launch({});
		expect(outcome).toMatchObject({ status: "completed", value: ["gate_failed", "ok", "integrated"] });
		expect(runner.callsMatching("write out.txt")).toHaveLength(1);
		expect(run.vcs.parentsOf(head(run))).toEqual([run.base]);
		expect(show(run, head(run), "out.txt")).toBe("fixed");
		expect(show(run, head(run), "impl.txt")).toBe("impl");
	}));
});

describe("herder_integrate and a gate_failed step", () => {
	const GOAL = `# Goal: Write out.txt

## Intent
The project needs a fixed out.txt.

## Acceptance criteria
- AC-1: WHEN the work is finished THE SYSTEM SHALL have a fixed out.txt. verify: check:fixed

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| fixed | grep -q fixed out.txt | 1m | no |
`;

	const fixtures: GitFixture[] = [];
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	/** A run with an approved goal, on the harness's fake runtime unless `options` names another. */
	async function approvedRun(options: Partial<HerderOptions> = {}) {
		const fixture = createGitFixture();
		fixtures.push(fixture);
		const h = harness({ cwd: fixture.dir, options });
		cleanups.push(h.shutdown);
		await h.command("write out.txt");
		const run = openRun(fixture.commonDir, activeRun(fixture.commonDir)!);
		writeFileSync(run.paths.goal, GOAL);
		await expect(h.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: true } });
		return { fixture, h, run };
	}

	it("refuses a gate_failed step key before the runtime sees it", async () => {
		const { h, run } = await approvedRun();
		run.journal.append({ t: "step.completed", key: "impl-0", fingerprint: "f", status: "gate_failed", commit: "e".repeat(40) });
		run.journal.append({ t: "step.completed", key: "fix-0", fingerprint: "f", status: "ok", commit: "f".repeat(40) });
		await expect(h.tool("herder_integrate", { source: "impl-0", message: "feat: out" })).rejects.toThrow(/impl-0.*gate_failed/);
		expect(h.runtime().calls.filter(([name]) => name === "integrate")).toEqual([]);
		await h.tool("herder_integrate", { source: "fix-0", message: "feat: out" });
		expect(h.runtime().calls.at(-1)).toEqual(["integrate", "f".repeat(40), { message: "feat: out" }]);
	});

	it("refuses the step key and the recorded commit on the real runtime, then integrates the ok fix by key", async () => {
		const runner = new FakeRunner(RULES);
		const createRuntime = createRuntimeFactory({ roles: () => loadRoles({ overrideDir: join(tmpdir(), "herder-no-role-overrides") }) });
		const { fixture, h, run } = await approvedRun({ createRuntime, runner: () => runner });
		const base = fixture.head();
		const failed = (await h.tool("herder_step", { prompt: "write out.txt", id: "impl", gate: "fixed" })).details;
		expect(failed).toMatchObject({ status: "gate_failed", key: "impl-0", commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
		const before = integrationState(fixture, run);
		for (const source of [failed.key, failed.commit, failed.commit.slice(0, 12)]) {
			await expect(h.tool("herder_integrate", { source, message: "feat: out" }), source).rejects.toThrow(/impl-0.*gate_failed/);
		}
		expect(integrationState(fixture, run)).toEqual(before);
		expect(before).toMatchObject({ head: base, folded: base, journaled: [] });

		const fix = (await h.tool("herder_step", { prompt: "fix out.txt", id: "fix", base: failed.commit, gate: "fixed" })).details;
		expect(fix).toMatchObject({ status: "ok", key: "fix-0" });
		const integrated = (await h.tool("herder_integrate", { source: fix.key, message: "feat: out" })).details;
		expect(integrated.status).toBe("integrated");
		expect(fixture.git("rev-parse", integrationRef(run.runId))).toBe(integrated.head);
		expect(fixture.git("rev-list", `${base}..${integrated.head}`).split("\n")).toHaveLength(1);
		expect(fixture.git("show", `${integrated.head}:out.txt`)).toBe("fixed");
		expect(fixture.git("show", `${integrated.head}:impl.txt`)).toBe("impl");
	});
});
