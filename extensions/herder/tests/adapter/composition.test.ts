// The real runtime composition driven through the adapter's command and tools, with a fake agent runner.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECK_SLOT, createRuntimeFactory } from "../../src/adapter/runtime.ts";
import { FOLLOW_UP_TYPE } from "../../src/adapter/session.ts";
import { loadRoles } from "../../src/agents/roles.ts";
import { readLock } from "../../src/run/lock.ts";
import { refPrefix } from "../../src/run/paths.ts";
import { activeRun, openRun } from "../../src/run/store.ts";
import type { Vcs } from "../../src/types.ts";
import { FakeRunner } from "../support/fake-runner.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import { harness } from "./harness.ts";

const GOAL = `# Goal: Create done.txt

## Intent
The project needs a done marker.

## Acceptance criteria
- AC-1: WHEN the work is finished THE SYSTEM SHALL have a done.txt file. verify: check:done

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| done | test -f done.txt | 1m | yes |
`;

const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** `wrap` replaces the runtime's view of git, to inject failures. */
async function approvedRun(wrap: (vcs: Vcs) => Vcs = (vcs) => vcs) {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	const runner = new FakeRunner([{ match: "create done.txt", files: { "done.txt": "done\n" }, text: "created done.txt" }]);
	const factory = createRuntimeFactory({ roles: () => loadRoles({ overrideDir: join(tmpdir(), "herder-no-role-overrides") }) });
	const createRuntime: typeof factory = (env) => factory({ ...env, vcs: wrap(env.vcs) });
	const h = harness({ cwd: fixture.dir, options: { createRuntime, runner: () => runner } });
	cleanups.push(h.shutdown);
	const base = fixture.head();
	await h.command("create done.txt");
	const runId = activeRun(fixture.commonDir)!;
	const run = openRun(fixture.commonDir, runId);
	expect(fixture.git("rev-parse", `${refPrefix(runId)}/base`, `${refPrefix(runId)}/integration`)).toBe(`${base}\n${base}`);
	writeFileSync(run.paths.goal, GOAL);
	writeFileSync(run.paths.plan, "- [ ] T1 (AC-1) create done.txt\n");
	await expect(h.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: true } });
	return { fixture, h, runner, runId, run, base };
}

const refsOf = (fixture: GitFixture, runId: string) => fixture.git("for-each-ref", "--format=%(refname)", `${refPrefix(runId)}/`);

describe("real runtime through the adapter", () => {
	it("steps, integrates, checks, verifies, and delivers a series", async () => {
		const { fixture, h, runner, runId, run, base } = await approvedRun();
		const step = await h.tool("herder_step", { prompt: "create done.txt", task: "T1", gate: "done", label: "create" });
		expect(step.details).toMatchObject({ status: "ok", reused: false, checks: [{ id: "done", passed: true }] });
		expect(runner.calls).toHaveLength(1);

		const integrated = await h.tool("herder_integrate", { source: step.details.key, message: "Add done marker", task: "T1" });
		expect(integrated.details).toMatchObject({ status: "integrated", checks: [{ id: "done", passed: true }] });
		const head = integrated.details.head as string;
		expect(fixture.git("rev-parse", `${refPrefix(runId)}/integration`)).toBe(head);
		expect(h.statuses.get("herder")).toBe("herder: ready · 1/1 tasks");
		expect(readFileSync(run.paths.progress, "utf8")).toContain("T1");

		const checked = await h.tool("herder_check", {});
		expect(checked.details.checks).toEqual([expect.objectContaining({ id: "done", passed: true, commit: head })]);
		expect(run.journal.read().filter((event) => event.t === "check.completed" && event.purpose === "manual")).toHaveLength(1);
		await expect(h.tool("herder_check", { commit: base })).resolves.toMatchObject({ details: { checks: [{ id: "done", passed: false }] } });
		expect(existsSync(join(run.paths.worktrees, "check"))).toBe(false);

		const verified = await h.tool("herder_verify", {});
		expect(verified.details).toMatchObject({ verdict: "met", head, verifierRan: false });

		const delivered = await h.tool("herder_deliver", { mode: "series" });
		expect(delivered.details).toMatchObject({ status: "delivered", mode: "series", target: "main" });
		expect(h.confirm).toHaveBeenLastCalledWith(`Deliver Herder run ${runId}?`, expect.stringContaining("Add done marker"), expect.objectContaining({ signal: expect.any(AbortSignal) }));
		expect(fixture.git("rev-list", `${base}..HEAD`).split("\n")).toHaveLength(1);
		expect(fixture.git("rev-parse", "HEAD^{tree}")).toBe(fixture.git("rev-parse", `${head}^{tree}`));
		expect(fixture.git("log", "-1", "--format=%B")).toBe("Add done marker");
		expect(fixture.git("log", "--format=%B", `${base}..HEAD`)).not.toMatch(/herder-/i);
		expect(fixture.read("done.txt")).toBe("done\n");
		expect(fixture.status()).toBe("");
		expect(refsOf(fixture, runId)).toBe("");
		expect(run.state().status).toBe("delivered");
		expect(readLock(run.paths.lock)).toBeNull();
		expect(h.statuses.has("herder")).toBe(false);
	});

	it("runs a workflow script in the background and reports it in one follow-up", async () => {
		const { fixture, h, runner, runId, run } = await approvedRun();
		const script = 'const step = await agent("create done.txt", { task: "T1", gate: "done" });\nif (step.status !== "ok") return step.status;\nconst result = await integrate(step, { message: "Add done marker", task: "T1" });\nreturn result.status;';
		const validated = await h.tool("herder_workflow", { mode: "validate", script });
		expect(validated.details.ok).toBe(true);
		const started = await h.tool("herder_workflow", { mode: "run", script });
		expect(started.details.launch).toBe(1);
		for (let i = 0; i < 200 && !h.sent.some((message) => message.customType === FOLLOW_UP_TYPE); i++) await new Promise((resolve) => setTimeout(resolve, 25));
		const followUps = h.sent.filter((message) => message.customType === FOLLOW_UP_TYPE);
		expect(followUps).toHaveLength(1);
		expect(followUps[0].content).toContain(`Herder launch 1 of run ${runId} completed.`);
		expect(followUps[0].content).toContain("0 reused, 0 changed, 1 new");
		expect(followUps[0].content).toContain("integrated");
		expect(runner.calls).toHaveLength(1);
		expect(run.state().launches.get(1)?.settled?.status).toBe("completed");
		expect(fixture.git("show", `${refPrefix(runId)}/integration:done.txt`)).toBe("done");
		expect(h.statuses.get("herder")).toBe("herder: ready · 1/1 tasks");
		expect(fixture.status()).toBe("");
	});

	it("abort journals the run abandoned and removes its refs", async () => {
		const { fixture, h, runId, run } = await approvedRun();
		await h.tool("herder_step", { prompt: "create done.txt" });
		expect(refsOf(fixture, runId)).not.toBe("");
		await h.command("abort");
		expect(run.state().status).toBe("abandoned");
		expect(refsOf(fixture, runId)).toBe("");
		expect(fixture.status()).toBe("");
	});

	it("abort reports a cleanup failure as a warning and still releases the run", async () => {
		let fail = false;
		const { h, runId, run } = await approvedRun((vcs) => ({ ...vcs, deleteRefs: (prefix) => { if (fail) throw new Error("refs are busy"); vcs.deleteRefs(prefix); } }));
		fail = true;
		await h.command("abort");
		expect(h.lastNotice()).toMatchObject({ level: "warning" });
		expect(h.lastNotice()!.text).toContain(`Abandoned Herder run ${runId}`);
		expect(h.lastNotice()!.text).toContain("refs are busy");
		expect(run.state().status).toBe("abandoned");
		expect(readLock(run.paths.lock)).toBeNull();
		expect(h.statuses.has("herder")).toBe(false);
	});

	it("returns journaled check results when removing the check worktree fails", async () => {
		let added = false;
		const { h, run } = await approvedRun((vcs) => ({
			...vcs,
			addWorktree: (path, commit) => { vcs.addWorktree(path, commit); added = true; },
			removeWorktree: (path) => { if (added && path.endsWith(CHECK_SLOT)) throw new Error("worktree is busy"); vcs.removeWorktree(path); },
		}));
		await expect(h.tool("herder_check", {})).resolves.toMatchObject({ details: { checks: [{ id: "done", passed: false }] } });
		expect(run.journal.read().filter((event) => event.t === "check.completed" && event.purpose === "manual")).toHaveLength(1);
	});
});
