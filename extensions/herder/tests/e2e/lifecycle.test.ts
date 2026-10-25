// Stop and resume in a new session, run lock ownership across sessions, abort, and clean.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCK_STALE_MS } from "../../src/config.ts";
import { readLock } from "../../src/run/lock.ts";
import { integrationRef } from "../../src/run/paths.ts";
import { activeRun, listRuns } from "../../src/run/store.ts";
import { FakeRunner } from "../support/fake-runner.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import {
	approve, checkout, deferred, expectCleanedUp, expectRuntimeViews, expectUntouched, followUps, launchAndWait, openSession, PLAN, refsOf, rules, SCRIPT,
	startRun, until, worktrees, type Session,
} from "./support.ts";

const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

/** An approved, planned run whose launch 1 has integrated T1 and holds the T2 writer in flight. */
async function heldLaunch() {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	const before = checkout(fixture);
	const hold = deferred();
	const runner = new FakeRunner(rules(hold.promise));
	const a = openSession(fixture, runner, cleanups, { sessionId: "session-a" });
	const started = await startRun(a, fixture);
	await approve(a, started);
	writeFileSync(started.planPath, PLAN);
	await a.tool("herder_workflow", { mode: "run", script: SCRIPT, args: { attempt: 1 } });
	await until(() => runner.callsMatching("Document the greeting").length === 1, "the T2 writer to start");
	expect(started.run.state().tasks.get("T1")?.status).toBe("integrated");
	expect(a.statuses.get("herder")).toBe("herder: T2 implement · 1/2 tasks");
	expectUntouched(fixture, before);
	return { fixture, before, hold, runner, a, ...started };
}

/** In `session`, the main model resumes `runId` and relaunches the launch the resume prompt names. */
async function relaunch(session: Session, runId: string, scriptPath: string) {
	await session.command(`resume ${runId}`);
	const prompt = session.sent.at(-1).content as string;
	expect(prompt).toContain(`/herder resume: continue Herder run ${runId}`);
	expect(prompt).toContain("Launch 1 stopped.");
	expect(prompt).toContain(`herder_workflow { mode: "run", scriptPath: "${scriptPath}", args: {"attempt":1}, resume: 1 }`);
	expect(prompt).toContain("T1"); // progress.md with the task table
	return launchAndWait(session, { scriptPath, args: { attempt: 1 }, resume: 1 });
}

describe("end to end: resume in a new session", () => {
	it("stops a launch, refuses a second session while the lock is live, and resumes there after release", async () => {
		const { fixture, before, runner, a, run, runId } = await heldLaunch();
		const t1Head = fixture.git("rev-parse", integrationRef(runId));
		const stopped = await a.tool("herder_workflow", { mode: "stop" });
		expect(stopped.details).toMatchObject({ launch: 1, status: "stopped", reused: 0, new: 2 });
		expect(followUps(a)).toEqual([]); // the stop reported the outcome itself
		expect(run.state().launches.get(1)?.settled?.status).toBe("stopped");
		expect(fixture.git("rev-parse", integrationRef(runId))).toBe(t1Head);
		expect(a.snapshots.at(-1)).toEqual({ source: "herder", activities: [] });
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-a#/);
		expectRuntimeViews(run);
		expectUntouched(fixture, before);

		// A new Pi session: a new adapter instance with its own runner, on the same repository.
		const runnerB = new FakeRunner(rules());
		const b = openSession(fixture, runnerB, cleanups, { sessionId: "session-b" });
		await b.command(`resume ${runId}`);
		expect(b.lastNotice()).toMatchObject({ level: "error", text: expect.stringContaining(`Herder run ${runId} is in use`) });
		await expect(b.tool("herder_verify", {})).rejects.toThrow(/is in use/);
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-a#/);

		await a.shutdown();
		expect(readLock(run.paths.lock)).toBeNull();
		const followUp = await relaunch(b, runId, join(run.paths.scripts, "1.js"));
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-b#/);
		expect(followUp).toContain(`Herder launch 2 of run ${runId} completed.`);
		expect(followUp).toContain("Steps: 1 reused, 0 changed, 1 new.");
		expect(runnerB.callsMatching("Create greeting.txt")).toEqual([]);
		expect(runnerB.callsMatching("Document the greeting")).toHaveLength(1);
		expect(runner.callsMatching("Create greeting.txt")).toHaveLength(1);
		expect(run.state().launches.get(2)?.launched).toMatchObject({ resumes: 1, head: run.state().base });
		// T1 was integrated once: the integration line has exactly one commit per task.
		const head = fixture.git("rev-parse", integrationRef(runId));
		expect(fixture.git("log", "--format=%s", `${run.state().base}..${head}`).split("\n")).toEqual(["Document greeting", "Add greeting"]);
		expect(fixture.git("rev-parse", `${head}^`)).toBe(t1Head);
		expectRuntimeViews(run);
		expectUntouched(fixture, before);

		await expect(b.tool("herder_verify", {})).resolves.toMatchObject({ details: { verdict: "met", head } });
		await expect(b.tool("herder_deliver", {})).resolves.toMatchObject({ details: { status: "delivered", mode: "series" } });
		expect(fixture.git("log", "--format=%s", `${before.head}..HEAD`).split("\n")).toEqual(["Document greeting", "Add greeting"]);
		expect(fixture.git("rev-parse", "HEAD^{tree}")).toBe(fixture.git("rev-parse", `${head}^{tree}`));
		expect(fixture.status()).toBe("");
		expectCleanedUp(fixture, run);
		expect(run.state().status).toBe("delivered");
		expect(b.statuses.has("herder")).toBe(false);
	});

	it("resumes after the first session shut down mid-launch", async () => {
		const { fixture, before, a, run, runId } = await heldLaunch();
		await a.shutdown();
		expect(followUps(a)).toEqual([]);
		expect(a.statuses.has("herder")).toBe(false);
		expect(a.snapshots.at(-1)).toEqual({ source: "herder", activities: [] });
		expect(readLock(run.paths.lock)).toBeNull();
		expect(run.state().launches.get(1)?.settled?.status).toBe("stopped");
		// The unfinished run keeps its refs for the resume; the held step's worktree is gone.
		expect(refsOf(fixture, runId)).toContain("/integration");
		expect(worktrees(fixture)).toEqual([`worktree ${fixture.dir}`]);
		expectUntouched(fixture, before);

		const runnerB = new FakeRunner(rules());
		const b = openSession(fixture, runnerB, cleanups, { sessionId: "session-b" });
		const followUp = await relaunch(b, runId, join(run.paths.scripts, "1.js"));
		expect(followUp).toContain("Steps: 1 reused, 0 changed, 1 new.");
		expect(runnerB.callsMatching("Create greeting.txt")).toEqual([]);
		await expect(b.tool("herder_verify", {})).resolves.toMatchObject({ details: { verdict: "met" } });
		await expect(b.tool("herder_deliver", { mode: "series" })).resolves.toMatchObject({ details: { status: "delivered" } });
		expect(fixture.git("log", "--format=%s", `${before.head}..HEAD`).split("\n")).toEqual(["Document greeting", "Add greeting"]);
		expectCleanedUp(fixture, run);
	});

	it("takes over a lock only once its heartbeat is stale", async () => {
		const fixture = createGitFixture();
		fixtures.push(fixture);
		const before = checkout(fixture);
		const runner = new FakeRunner(rules());
		const a = openSession(fixture, runner, cleanups, { sessionId: "session-a" });
		const started = await startRun(a, fixture);
		await approve(a, started);
		const { run, runId } = started;

		const b = openSession(fixture, runner, cleanups, { sessionId: "session-b" });
		await b.command(`resume ${runId}`);
		expect(b.lastNotice()).toMatchObject({ level: "error", text: expect.stringContaining("is in use") });
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-a#/);

		const later = new Date(Date.now() + LOCK_STALE_MS + 60_000);
		const c = openSession(fixture, runner, cleanups, { sessionId: "session-c", lock: { now: () => later } });
		await c.command(`resume ${runId}`);
		expect(c.lastNotice()).toMatchObject({ level: "info", text: `Resumed Herder run ${runId}.` });
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-c#/);
		// The first session notices on its next call and stops touching the run.
		await expect(a.tool("herder_check", {})).rejects.toThrow(/lost run/);
		expect(a.statuses.has("herder")).toBe(false);
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-c#/);
		expectUntouched(fixture, before);
	});
});

describe("end to end: abort and clean", () => {
	it("aborts a held launch, cleans the run, and starts a new one", async () => {
		const { fixture, before, a, run, runId } = await heldLaunch();
		await a.command("abort");
		expect(a.lastNotice()).toMatchObject({ level: "info", text: `Abandoned Herder run ${runId}.` });
		expect(run.state().status).toBe("abandoned");
		expect(run.state().finished).toMatchObject({ status: "abandoned", reason: "aborted by the user" });
		expect(run.state().launches.get(1)?.settled?.status).toBe("stopped");
		expect(followUps(a)).toEqual([]);
		expect(refsOf(fixture, runId)).toBe("");
		expectCleanedUp(fixture, run);
		expect(readLock(run.paths.lock)).toBeNull();
		expect(a.statuses.has("herder")).toBe(false);
		expect(a.snapshots.at(-1)).toEqual({ source: "herder", activities: [] });
		expect(activeRun(fixture.commonDir)).toBeNull();
		expectRuntimeViews(run);
		expectUntouched(fixture, before);

		await a.command(`clean ${runId}`);
		expect(a.lastNotice()).toMatchObject({ text: `Deleted 1 Herder run(s): ${runId}.` });
		expect(existsSync(run.paths.dir)).toBe(false);

		// A second run, abandoned before its goal was approved, goes with --finished.
		const second = await startRun(a, fixture, "Second goal");
		expect(second.runId).not.toBe(runId);
		await a.command(`abort ${second.runId}`);
		expect(second.run.state().status).toBe("abandoned");
		await a.command("clean --finished");
		expect(a.lastNotice()).toMatchObject({ text: `Deleted 1 Herder run(s): ${second.runId}.` });
		expect(listRuns(fixture.commonDir)).toEqual([]);
		expectUntouched(fixture, before);

		const third = await startRun(a, fixture, "Third goal");
		expect(listRuns(fixture.commonDir)).toEqual([third.runId]);
		expect(third.run.state().status).toBe("drafting");
		expect(a.statuses.get("herder")).toBe("herder: drafting goal");
		expectUntouched(fixture, before);
	});
});
