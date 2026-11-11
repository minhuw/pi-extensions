import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { externalAgents } from "../../src/adapter/external-agents.ts";
import { createRuntimeFactory } from "../../src/adapter/runtime.ts";
import { loadRoles } from "../../src/agents/roles.ts";
import { STATUS_KEY } from "../../src/config.ts";
import { activeRun, openRun } from "../../src/run/store.ts";
import { FakeRunner } from "../support/fake-runner.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import { deferred, until } from "../steps/harness.ts";
import { harness, VALID_GOAL } from "./harness.ts";

const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function approved(real = false, slowCheck = false) {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	const runner = new FakeRunner([{ match: "make change", files: { "change.txt": "changed\n" } }]);
	const createRuntime = createRuntimeFactory({ roles: () => loadRoles({ overrideDir: join(tmpdir(), "herder-no-overrides") }) });
	const h = harness({ cwd: fixture.dir, ...(real && { options: { createRuntime, runner: () => runner } }) });
	cleanups.push(h.shutdown);
	await h.command("make change");
	const run = openRun(fixture.commonDir, activeRun(fixture.commonDir)!);
	const flag = join(fixture.dir, "check-release");
	const command = `while [ ! -f '${flag}' ]; do sleep 0.05; done`;
	writeFileSync(run.paths.goal, slowCheck ? VALID_GOAL.replace("| unit | true |", `| unit | ${command} |`) : VALID_GOAL);
	writeFileSync(run.paths.plan, "- [ ] T1 (AC-1) first\n- [ ] T2 (AC-1) second\n- [ ] T3 (AC-1) third\n");
	await h.tool("herder_run", { action: "approve_goal" });
	return { h, run, fixture, runner, flag };
}
const status = (h: ReturnType<typeof harness>) => h.statuses.get(STATUS_KEY) ?? "";

describe("live Herder status", () => {
	it("reports awaiting goal and abort confirmations", async () => {
		const fixture = createGitFixture();
		fixtures.push(fixture);
		const h = harness({ cwd: fixture.dir });
		cleanups.push(h.shutdown);
		await h.command("make change");
		const run = openRun(fixture.commonDir, activeRun(fixture.commonDir)!);
		writeFileSync(run.paths.goal, VALID_GOAL);
		const goalAnswer = deferred<boolean>();
		h.confirm.mockImplementationOnce(() => goalAnswer.promise);
		const goal = h.tool("herder_run", { action: "approve_goal" });
		await until(() => status(h).includes("awaiting goal approval"));
		goalAnswer.resolve(true);
		await goal;
		const abortAnswer = deferred<boolean>();
		h.confirm.mockImplementationOnce(() => abortAnswer.promise);
		const abort = h.tool("herder_run", { action: "abort" });
		await until(() => status(h).includes("awaiting abort confirmation"));
		abortAnswer.resolve(false);
		await abort;
	});
	it.each(["check", "launch"])("keeps the other work visible when the %s finishes first", async (first) => {
		const { h } = await approved();
		const runtime = h.runtime();
		const gate = deferred();
		vi.spyOn(runtime, "check").mockImplementation(async (_request, _signal, report) => { report?.("checking unit"); await gate.promise; return []; });
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const progress = runtime.launchProgress!;
		progress.phase("T2: fix");
		progress.activity({ key: "a", task: "T1", label: "worker one", phase: "T1: implement", phaseIsGlobal: true, state: "running" });
		progress.activity({ key: "b", task: "T2", label: "worker two", phase: "T2: fix", phaseIsGlobal: true, state: "running" });
		progress.activity({ key: "c", task: "T3", label: "worker three", phase: "T2: fix", phaseIsGlobal: true, state: "running" });
		const check = h.tool("herder_check", {});
		await until(() => status(h).includes("checking unit"));
		expect(status(h)).toContain("T1 implement worker one");
		expect(status(h)).toContain("T2 fix worker two");
		expect(status(h)).toContain("3 steps");
		expect(status(h)).toContain("phase: T2: fix");
		expect(status(h)).toMatch(/ · 0\/3 tasks$/);
		if (first === "check") {
			gate.resolve();
			await check;
			expect(status(h)).toContain("T1 implement worker one");
			expect(status(h)).not.toContain("checking unit");
			runtime.launches[0]!.settle();
		} else {
			runtime.launches[0]!.settle();
			await until(() => !status(h).includes("worker one"));
			expect(status(h)).toContain("checking unit");
			gate.resolve();
			await check;
		}
		await until(() => status(h) === "herder: ready · 0/3 tasks");
	});

	it("keeps a log through a following phase and prioritizes checks, step count, and gate", async () => {
		const { h } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const runtime = h.runtime();
		const progress = runtime.launchProgress!;
		progress.log("latest\nmessage");
		progress.phase("next phase");
		progress.activity({ key: "a", task: "T1", label: "a very long step description that would hide a gate", phase: "a lengthy phase description", stage: "gate unit", state: "running" });
		progress.activity({ key: "b", task: "T2", label: "another very long step description", state: "running" });
		const gate = deferred();
		vi.spyOn(runtime, "check").mockImplementation(async (_request, _signal, report) => { report?.("checking unit"); await gate.promise; return []; });
		const check = h.tool("herder_check", {});
		await until(() => status(h).includes("checking unit"));
		expect(status(h)).toMatch(/^herder: checking unit · 2 steps · T1 gate unit · log: latest message/);
		expect(status(h)).toContain("log: latest message");
		expect(status(h)).toContain("phase: next phase");
		expect(status(h)).toMatch(/ · 0\/3 tasks$/);
		gate.resolve();
		await check;
		runtime.launches[0]!.settle();
		await until(() => status(h) === "herder: ready · 0/3 tasks");
	});

	it("accepts early phase/log callbacks, sanitizes them, and ignores late callbacks after stop and a later launch", async () => {
		const { h } = await approved();
		const runtime = h.runtime();
		const gate = deferred();
		runtime.launchGate = gate.promise;
		runtime.onLaunching = (progress) => { progress.phase(`T1: prepare\n\x1b[31m${"p".repeat(100)}`); progress.log(`hello\r\n\x07${"x".repeat(100)}`); };
		const starting = h.tool("herder_workflow", { mode: "run", script: "return 1" });
		await until(() => status(h).includes("log:"));
		expect(status(h)).toContain("starting launch");
		expect(status(h)).toContain("phase: T1: prepare");
		expect(status(h)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(status(h).length).toBeLessThan(160);
		const old = runtime.launchProgress!;
		gate.resolve();
		await starting;
		runtime.holdOnStop = true;
		const stopping = h.tool("herder_workflow", { mode: "stop" });
		await until(() => status(h).includes("stopping launch"));
		old.phase("stale phase"); old.log("stale log");
		old.activity({ key: "late", label: "late step", state: "running" });
		expect(status(h)).not.toMatch(/stale|late/);
		runtime.launches[0]!.settle({ status: "stopped" });
		await stopping;
		await h.tool("herder_workflow", { mode: "run", script: "return 2" });
		const before = status(h);
		old.phase("stale again"); old.log("stale again"); old.integrate("T9").update("stale integration");
		expect(status(h)).toBe(before);
	});

	it("settles external agents when a stopped launch reports their completion", async () => {
		const { h, run } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const runtime = h.runtime();
		runtime.holdOnStop = true;
		const progress = runtime.launchProgress!;
		progress.activity({ key: "a", task: "T1", label: "worker", state: "running", attempt: 1, startedAt: 100, session: {} });
		const agent = externalAgents().agents.get(`herder:${run.runId}:a:1@100`)!;
		expect(agent.status).toBe("running");
		const stop = h.tool("herder_workflow", { mode: "stop" });
		await until(() => status(h).includes("stopping launch"));
		progress.activity({ key: "a", label: "worker", state: "settled", status: "stopped" });
		expect(externalAgents().agents.get(agent.id)?.status).toBe("stopped");
		expect(status(h)).not.toContain("worker");
		runtime.launches[0]!.settle({ status: "stopped" });
		await stop;
	});

	it.each(["completed", "failed"] as const)("ignores callbacks after a launch has %s", async (outcome) => {
		const { h } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const runtime = h.runtime();
		const progress = runtime.launchProgress!;
		progress.phase("working");
		runtime.launches[0]!.settle({ status: outcome });
		await until(() => status(h) === "herder: ready · 0/3 tasks");
		progress.phase("late"); progress.log("late");
		progress.integrate("T9").update("late");
		expect(status(h)).toBe("herder: ready · 0/3 tasks");
	});

	it("clears direct verification on failure and cancellation, and reports delivery confirmation", async () => {
		const { h } = await approved();
		const runtime = h.runtime();
		const pending = deferred();
		vi.spyOn(runtime, "verify").mockImplementation(async (signal, report) => {
			report?.("verifying · verifier");
			await pending.promise;
			throw new Error(signal?.aborted ? "cancelled" : "verification failed");
		});
		const controller = new AbortController();
		const verification = h.tool("herder_verify", {}, controller.signal);
		await until(() => status(h).includes("verifying · verifier"));
		controller.abort(); pending.resolve();
		await expect(verification).rejects.toThrow("cancelled");
		expect(status(h)).toBe("herder: ready · 0/3 tasks");
		vi.spyOn(runtime, "integrate").mockRejectedValueOnce(new Error("integration failed"));
		await expect(h.tool("herder_integrate", { source: "abc", message: "change", task: "T1" })).rejects.toThrow("integration failed");
		expect(status(h)).toBe("herder: ready · 0/3 tasks");
		const confirmation = deferred<boolean>();
		h.confirm.mockImplementationOnce(() => confirmation.promise);
		const delivery = h.tool("herder_deliver", {});
		await until(() => status(h).includes("awaiting delivery confirmation"));
		confirmation.resolve(false);
		await expect(delivery).resolves.toMatchObject({ details: { status: "cancelled" } });
		expect(status(h)).toBe("herder: ready · 0/3 tasks");
	});

	it.each(["shutdown", "lost lock"])("ignores launch callbacks after %s", async (event) => {
		const { h, run } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const progress = h.runtime().launchProgress!;
		progress.phase("in progress");
		if (event === "shutdown") await h.shutdown();
		else {
			const now = new Date().toISOString();
			writeFileSync(run.paths.lock, JSON.stringify({ pid: process.pid + 1, host: "elsewhere", startedAt: now, heartbeatAt: now, sessionId: "session-z#00000000" }));
			await expect(h.tool("herder_step", { prompt: "x" })).rejects.toThrow(/lost run/);
		}
		progress.phase("stale"); progress.log("stale");
		progress.activity({ key: "late", label: "late", state: "running" });
		expect(h.statuses.has(STATUS_KEY)).toBe(false);
	});

	it("reports a real verification check until cancellation", async () => {
		const { h } = await approved(true, true);
		const controller = new AbortController();
		const verification = h.tool("herder_verify", {}, controller.signal);
		await until(() => status(h).includes("verifying · check unit"));
		controller.abort(new Error("verification cancelled"));
		await expect(verification).rejects.toThrow("verification cancelled");
		expect(status(h)).toBe("herder: ready · 0/3 tasks");
	});

	it("uses real workflow callbacks to show integration checks and the integrated task count", async () => {
		const { h, flag } = await approved(true, true);
		const before = h.sent.length;
		const script = 'phase("T1: integrate"); log("waiting for tests"); const s = await agent("make change", { task: "T1", label: "implement" }); return await integrate(s, { task: "T1", message: "add change" });';
		await h.tool("herder_workflow", { mode: "run", script });
		await until(() => status(h).includes("integrating · check unit"));
		expect(status(h)).toContain("phase: T1: integrate");
		expect(status(h)).toContain("log: waiting for tests");
		expect(status(h)).toMatch(/ · 0\/3 tasks$/);
		expect(h.sent.length).toBe(before);
		writeFileSync(flag, "go");
		await until(() => status(h) === "herder: ready · 1/3 tasks");
		expect(h.sent.length).toBe(before + 1);
	});

	it("runs concurrent manual checks independently while a workflow advances the integration head", async () => {
		const { h, run, flag } = await approved(true, true);
		const base = run.state().integrationHead!;
		await h.tool("herder_workflow", { mode: "run", script: 'const s = await agent("make change", { task: "T1" }); return await integrate(s, { task: "T1", message: "add change", checks: [] });' });
		const a = h.tool("herder_check", {});
		const b = h.tool("herder_check", {});
		await until(() => existsSync(join(run.paths.worktrees, "check")) && existsSync(join(run.paths.worktrees, "check-1")));
		await until(() => run.state().integrationHead !== base);
		expect(status(h)).toContain("checking unit");
		expect(status(h)).toContain("1/3 tasks");
		writeFileSync(flag, "go");
		const [first, second] = await Promise.all([a, b]);
		expect(first.details.checks[0]).toMatchObject({ passed: true, commit: base });
		expect(second.details.checks[0]).toMatchObject({ passed: true, commit: base });
		await until(() => status(h) === "herder: ready · 1/3 tasks");
	});
});
