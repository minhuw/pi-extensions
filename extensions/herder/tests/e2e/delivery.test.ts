// create → approve → plan → launch → verify → deliver, through the real extension with a fake runner.
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readLock } from "../../src/run/lock.ts";
import { integrationRef } from "../../src/run/paths.ts";
import { FakeRunner } from "../support/fake-runner.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import {
	approve, checkout, expectCleanedUp, expectRuntimeViews, expectUntouched, GOAL, launchAndWait, openSession, PLAN, README, rules, SCRIPT, startRun,
	type Session, type Started,
} from "./support.ts";

const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup() {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	const runner = new FakeRunner(rules());
	const h = openSession(fixture, runner, cleanups);
	return { fixture, runner, h, before: checkout(fixture), base: fixture.head() };
}

/** Everything up to a `met` verification; returns the verified integration head. */
async function verified(h: Session, fixture: GitFixture, before: ReturnType<typeof checkout>): Promise<Started & { head: string }> {
	const started = await startRun(h, fixture);
	await approve(h, started);
	writeFileSync(started.planPath, PLAN);
	await launchAndWait(h);
	const outcome = await h.tool("herder_verify", {});
	expect(outcome.details).toMatchObject({ verdict: "met", verifierRan: true });
	expectUntouched(fixture, before);
	return { ...started, head: outcome.details.head as string };
}

const setStatusCalls = (h: Session) => (h.ctx.ui.setStatus as unknown as { mock: { calls: Array<[string, string | undefined]> } }).mock.calls.map(([, text]) => text);

describe("end to end: series delivery", () => {
	it("creates, approves, launches, verifies, and delivers one commit per task", async () => {
		const { fixture, runner, h, before, base } = setup();
		const started = await startRun(h, fixture);
		const { run, runId } = started;
		expect(started.prompt).toContain("approve_goal");
		expect(h.statuses.get("herder")).toBe("herder: drafting goal");
		expectUntouched(fixture, before);

		// The user declines first: nothing is journaled.
		writeFileSync(started.goalPath, GOAL);
		const journal = run.journal.read().length;
		h.confirm.mockResolvedValueOnce(false);
		await expect(h.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: false } });
		expect(run.journal.read()).toHaveLength(journal);
		expect(run.state().goal).toBeUndefined();

		await approve(h, started);
		expect(run.state().goal?.checks).toEqual([{ id: "greeting", command: "grep -q hello greeting.txt", timeoutMs: 60_000, integrate: true }]);
		writeFileSync(started.planPath, PLAN);
		expectUntouched(fixture, before);

		const validated = await h.tool("herder_workflow", { mode: "validate", script: SCRIPT });
		expect(validated.details).toMatchObject({ ok: true, agentCalls: 2, integrateCalls: 2 });
		const followUp = await launchAndWait(h);
		expect(followUp).toContain(`Herder launch 1 of run ${runId} completed.`);
		expect(followUp).toContain("Steps: 0 reused, 0 changed, 2 new.");
		expect(followUp).toContain('"result": "both tasks integrated"');
		expect(followUp).toContain('"t1-0"');
		expect(runner.calls.map((call) => call.prompt)).toEqual(["Create greeting.txt saying hello", "Document the greeting in README.md"]);
		expect(run.state().tasks.get("T1")?.status).toBe("integrated");
		expect(run.state().tasks.get("T2")?.status).toBe("integrated");
		const head = fixture.git("rev-parse", integrationRef(runId));
		expect(fixture.git("show", `${head}:greeting.txt`)).toBe("hello");
		expect(fixture.git("show", `${head}:README.md`)).toBe(README.trimEnd());
		expect(h.statuses.get("herder")).toBe("herder: ready · 2/2 tasks");
		expect(setStatusCalls(h)).toContain("herder: launch 1 · 0/2 tasks");
		expect(setStatusCalls(h).some((text) => text?.startsWith("herder: T1 "))).toBe(true);
		// Activity rows appeared for the running steps and ended empty.
		expect(h.snapshots.some((snapshot) => snapshot.activities.some((row: { id: string }) => row.id === "step:t1-0"))).toBe(true);
		expect(h.snapshots.some((snapshot) => snapshot.activities.some((row: { id: string }) => row.id === "step:t2-0"))).toBe(true);
		expect(h.snapshots.at(-1)).toEqual({ source: "herder", activities: [] });
		expectRuntimeViews(run);
		expect(run.state().status).not.toBe("delivered");
		expectUntouched(fixture, before);

		const verification = await h.tool("herder_verify", {});
		expect(verification.details).toMatchObject({ verdict: "met", head, verifierRan: true, criteria: [{ id: "AC-1", status: "met" }] });
		expect(runner.callsMatching("Verify the change")).toHaveLength(1);
		expect(runner.calls.at(-1)?.role).toBe("verifier");
		expect(h.statuses.get("herder")).toBe("herder: verified met · 2/2 tasks");
		expectRuntimeViews(run);
		expectUntouched(fixture, before);

		const delivered = await h.tool("herder_deliver", { mode: "series" });
		expect(delivered.details).toMatchObject({ status: "delivered", mode: "series", target: "main" });
		expect(h.confirm).toHaveBeenLastCalledWith(`Deliver Herder run ${runId}?`, expect.stringContaining("Document greeting"), expect.anything());
		expect(fixture.git("log", "--format=%s", `${base}..HEAD`).split("\n")).toEqual(["Document greeting", "Add greeting"]);
		expect(fixture.git("log", "--format=%B", `${base}..HEAD`)).not.toMatch(/herder-/i);
		expect(fixture.git("rev-parse", "HEAD^{tree}")).toBe(fixture.git("rev-parse", `${head}^{tree}`));
		expect(fixture.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(fixture.read("greeting.txt")).toBe("hello\n");
		expect(fixture.status()).toBe("");
		expectCleanedUp(fixture, run);
		expect(run.state().status).toBe("delivered");
		expect(run.state().finished).toMatchObject({ status: "delivered" });
		expect(readLock(run.paths.lock)).toBeNull();
		expect(h.statuses.has("herder")).toBe(false);
		expect(h.snapshots.at(-1)).toEqual({ source: "herder", activities: [] });
		expectRuntimeViews(run);
	});

	it("refuses a dirty checkout and writes nothing", async () => {
		const { fixture, h, before } = setup();
		const { run, head } = await verified(h, fixture, before);
		fixture.write("notes.txt", "the user's own work\n");
		const journal = run.journal.read().length;
		const outcome = await h.tool("herder_deliver", { mode: "series" });
		expect(outcome.details).toMatchObject({ status: "refused", reason: expect.stringContaining("uncommitted or untracked") });
		expect(h.confirm).toHaveBeenCalledTimes(1); // only the goal approval
		expect(fixture.status()).toBe("?? notes.txt");
		expect(checkout(fixture)).toEqual(before);
		expect(run.journal.read()).toHaveLength(journal);
		expect(run.state().status).not.toBe("delivered");
		expect(fixture.git("rev-parse", integrationRef(run.runId))).toBe(head);
	});

	it("refuses delivery in a non-interactive session", async () => {
		const { fixture, runner, h, before } = setup();
		const { run } = await verified(h, fixture, before);
		const print = openSession(fixture, runner, cleanups, { sessionId: "session-print", hasUI: false });
		const journal = run.journal.read().length;
		await expect(print.tool("herder_deliver", { mode: "series" })).rejects.toThrow(/interactive session/);
		await expect(print.tool("herder_run", { action: "approve_goal" })).rejects.toThrow();
		expect(print.confirm).not.toHaveBeenCalled();
		expect(run.journal.read()).toHaveLength(journal);
		expectUntouched(fixture, before);
	});

	it("refuses every run tool before the goal is approved", async () => {
		const { fixture, runner, h, before } = setup();
		const { run } = await startRun(h, fixture);
		const journal = run.journal.read().length;
		for (const [tool, params] of [
			["herder_workflow", { mode: "validate", script: SCRIPT }], ["herder_workflow", { mode: "run", script: SCRIPT }],
			["herder_step", { prompt: "Create greeting.txt saying hello" }], ["herder_integrate", { source: "HEAD", message: "x" }],
			["herder_check", {}], ["herder_verify", {}], ["herder_deliver", {}],
		] as const) await expect(h.tool(tool, params), tool).rejects.toThrow(/not approved yet/);
		expect(runner.calls).toEqual([]);
		expect(h.confirm).not.toHaveBeenCalled();
		expect(run.journal.read()).toHaveLength(journal);
		expectRuntimeViews(run);
		expectUntouched(fixture, before);
	});
});

describe("end to end: other delivery modes", () => {
	it("uncommitted applies the verified changes unstaged and leaves HEAD and the index alone", async () => {
		const { fixture, h, before } = setup();
		const { run, head } = await verified(h, fixture, before);
		const outcome = await h.tool("herder_deliver", { mode: "uncommitted" });
		expect(outcome.details).toMatchObject({ status: "delivered", mode: "uncommitted", target: fixture.dir });
		expect(fixture.head()).toBe(before.head);
		expect(checkout(fixture)).toEqual(before);
		expect(fixture.git("diff", "--cached", "--name-only")).toBe("");
		expect(fixture.status().split("\n").sort()).toEqual([" M README.md", "?? greeting.txt"]);
		expect(fixture.read("greeting.txt")).toBe("hello\n");
		expect(fixture.read("README.md")).toBe(README);
		// The working tree now holds exactly the verified tree.
		fixture.git("add", "-A");
		expect(fixture.git("write-tree")).toBe(fixture.git("rev-parse", `${head}^{tree}`));
		expect(run.state().status).toBe("delivered");
		expectCleanedUp(fixture, run);
		expect(h.statuses.has("herder")).toBe(false);
	});

	it("branch creates herder/<runId> at the verified tree and leaves the checkout alone", async () => {
		const { fixture, h, before, base } = setup();
		const { run, runId, head } = await verified(h, fixture, before);
		const outcome = await h.tool("herder_deliver", { mode: "branch" });
		expect(outcome.details).toMatchObject({ status: "delivered", mode: "branch", target: `herder/${runId}` });
		const tip = fixture.git("rev-parse", `refs/heads/herder/${runId}`);
		expect(fixture.git("rev-parse", `${tip}^{tree}`)).toBe(fixture.git("rev-parse", `${head}^{tree}`));
		expect(fixture.git("log", "--format=%s", `${base}..${tip}`).split("\n")).toEqual(["Document greeting", "Add greeting"]);
		expect(fixture.git("log", "--format=%B", `${base}..${tip}`)).not.toMatch(/herder-/i);
		expect(fixture.status()).toBe("");
		expect(fixture.head()).toBe(before.head);
		expect(fixture.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(fixture.git("for-each-ref", "--format=%(refname)", "refs/heads/")).toBe(`refs/heads/herder/${runId}\nrefs/heads/main`);
		expect(run.state().status).toBe("delivered");
		expectCleanedUp(fixture, run);
	});
});

describe("end to end: concurrent runs across sessions", () => {
	it("runs two sessions concurrently from the same base and replays the second series delivery onto the first", async () => {
		const fixture = createGitFixture();
		fixtures.push(fixture);
		const base = fixture.head();
		const before = checkout(fixture);

		const runnerA = new FakeRunner([
			{ match: "Create greeting.txt", files: { "greeting.txt": "hello\n" }, text: "created greeting.txt" },
		]);
		const runnerB = new FakeRunner([
			{ match: "Create farewell.txt", files: { "farewell.txt": "goodbye\n" }, text: "created farewell.txt" },
		]);
		const a = openSession(fixture, runnerA, cleanups, { sessionId: "session-a" });
		const b = openSession(fixture, runnerB, cleanups, { sessionId: "session-b" });

		const startedA = await startRun(a, fixture, "Greet the user");
		const startedB = await startRun(b, fixture, "Bid farewell");
		expect(startedB.runId).not.toBe(startedA.runId);

		await approve(a, startedA);
		writeFileSync(startedA.planPath, "- [ ] T1 (AC-1) Add greeting.txt\n");

		const farewellGoal = `# Goal: Bid farewell

## Intent
Readers of the project want a farewell message.

## Acceptance criteria
- AC-1: WHEN farewell.txt is read THE SYSTEM SHALL say goodbye. verify: check:farewell

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| farewell | grep -q goodbye farewell.txt | 1m | yes |
`;
		writeFileSync(startedB.goalPath, farewellGoal);
		await expect(b.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: true } });
		writeFileSync(startedB.planPath, "- [ ] T1 (AC-1) Add farewell.txt\n");

		const [stepA, stepB] = await Promise.all([
			a.tool("herder_step", { prompt: "Create greeting.txt", task: "T1", gate: "greeting" }),
			b.tool("herder_step", { prompt: "Create farewell.txt", task: "T1", gate: "farewell" }),
		]);
		expect(stepA.details.status).toBe("ok");
		expect(stepB.details.status).toBe("ok");

		const [intA, intB] = await Promise.all([
			a.tool("herder_integrate", { source: stepA.details.key, message: "Add greeting", task: "T1" }),
			b.tool("herder_integrate", { source: stepB.details.key, message: "Add farewell", task: "T1" }),
		]);
		expect(intA.details.status).toBe("integrated");
		expect(intB.details.status).toBe("integrated");

		const [verA, verB] = await Promise.all([
			a.tool("herder_verify", {}),
			b.tool("herder_verify", {}),
		]);
		expect(verA.details).toMatchObject({ verdict: "met" });
		expect(verB.details).toMatchObject({ verdict: "met" });
		expectUntouched(fixture, before);

		// Session A delivers first, advancing main from base.
		const deliveredA = await a.tool("herder_deliver", { mode: "series" });
		expect(deliveredA.details).toMatchObject({ status: "delivered", mode: "series", target: "main" });
		const tipA = fixture.head();
		expect(tipA).not.toBe(base);
		expect(fixture.read("greeting.txt")).toBe("hello\n");

		// Session B delivers second: replays onto tipA, re-runs B's check on the merged tree, and fast-forwards main.
		const deliveredB = await b.tool("herder_deliver", { mode: "series" });
		expect(deliveredB.details).toMatchObject({
			status: "delivered",
			mode: "series",
			target: "main",
			rebasedOnto: tipA,
			checks: [expect.objectContaining({ id: "farewell", passed: true })],
		});
		expect(startedB.run.journal.read().some((event) => event.t === "check.completed" && event.purpose === "deliver")).toBe(true);
		expect(fixture.git("log", "--format=%s", `${base}..HEAD`).split("\n")).toEqual(["Add farewell", "Add greeting"]);
		expect(fixture.read("greeting.txt")).toBe("hello\n");
		expect(fixture.read("farewell.txt")).toBe("goodbye\n");
		expect(fixture.status()).toBe("");
		expect(startedA.run.state().status).toBe("delivered");
		expect(startedB.run.state().status).toBe("delivered");
		expectCleanedUp(fixture, startedA.run);
		expectCleanedUp(fixture, startedB.run);
		expectRuntimeViews(startedA.run);
		expectRuntimeViews(startedB.run);
	});
});
