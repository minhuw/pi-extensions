// Standing approval (the selfdrive registry contract) and parked runs: verified runs that wait for the user's delivery.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STANDING_APPROVAL_KEY, STANDING_NOTE, standingGrant, standingRegistry, type StandingApproval } from "../../src/adapter/standing.ts";
import { isParked } from "../../src/adapter/status.ts";
import { STATUS_KEY } from "../../src/config.ts";
import { readLock } from "../../src/run/lock.ts";
import { listRuns, openRun, type RunStore } from "../../src/run/store.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import { harness, VALID_GOAL } from "./harness.ts";

const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	standingRegistry().grants.clear();
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function repo() {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	return fixture;
}

function session(fixture: GitFixture, options: Partial<Parameters<typeof harness>[0]> = {}) {
	const h = harness({ cwd: fixture.dir, ...options });
	cleanups.push(h.shutdown);
	return h;
}

const AUTHORIZATION = "The user lets this session implement and verify Herder runs in this repository while away; delivery waits for their return.";

function grant(fixture: GitFixture, overrides: Partial<StandingApproval> = {}): StandingApproval {
	const value: StandingApproval = { id: "selfdrive-1", commonDir: fixture.commonDir, toplevel: fixture.dir, text: AUTHORIZATION, since: new Date(Date.now() - 60_000).toISOString(), ...overrides };
	standingRegistry().grants.set(value.id, value);
	return value;
}

async function start(h: ReturnType<typeof session>, fixture: GitFixture, goal = "add a greeting to the CLI") {
	const result = await h.tool("herder_run", { action: "start", goal });
	const runId = result.details.runId as string;
	return { runId, run: openRun(fixture.commonDir, runId), prompt: result.content[0].text as string };
}

/** Verified `met` at the run's current integration head, as `herder_verify` journals it. */
function park(run: RunStore): void {
	run.journal.append({ t: "verify.completed", head: run.state().integrationHead!, checks: [], verdict: "met", criteria: [], verifierRan: false });
}

/** The run id besides `first`: ids created within one second do not sort by creation. */
const other = (fixture: GitFixture, first: string) => listRuns(fixture.commonDir).find((id) => id !== first)!;

const goalEvents = (run: RunStore) => run.journal.read().filter((event) => event.t === "goal.approved");

const FINDINGS = [
	{ id: "1", title: "Delete the unused parser", summary: "No callers.", recommended: true },
	{ id: "2", title: "Merge the retry helpers", summary: "Two copies." },
	{ id: "3", title: "Drop the legacy flag", summary: "Only the parser reads it.", dependsOn: ["2"], recommended: true },
	{ id: "4", title: "Inline the wrapper", summary: "Forwards every call." },
];

describe("the standing-approval registry", () => {
	it("is created on first read and matches a repository by the realpath of its git common dir", () => {
		const fixture = repo();
		delete (globalThis as Record<symbol, unknown>)[STANDING_APPROVAL_KEY];
		expect(standingGrant(fixture.commonDir)).toBeUndefined();
		expect((globalThis as Record<symbol, unknown>)[STANDING_APPROVAL_KEY]).toEqual({ grants: new Map() });
		const links = mkdtempSync(join(tmpdir(), "herder-standing-"));
		cleanups.push(() => rmSync(links, { recursive: true, force: true }));
		symlinkSync(fixture.dir, join(links, "checkout"));
		const value = grant(fixture, { commonDir: join(links, "checkout", ".git") });
		expect(standingGrant(fixture.commonDir)).toBe(value);
		expect(standingGrant(repo().commonDir)).toBeUndefined();
		// Malformed entries are ignored.
		standingRegistry().grants.set("bad", { id: "bad", commonDir: fixture.commonDir } as StandingApproval);
		standingRegistry().grants.delete(value.id);
		expect(standingGrant(fixture.commonDir)).toBeUndefined();
	});
});

describe("approve_goal under a standing authorization", () => {
	it("approves without a UI or a dialog, journaling the authorization, and still validates goal.md", async () => {
		const fixture = repo();
		const value = grant(fixture);
		const h = session(fixture, { hasUI: false });
		const { run, prompt } = await start(h, fixture);
		expect(prompt).toContain(STANDING_NOTE);
		const invalid = await h.tool("herder_run", { action: "approve_goal" });
		expect(invalid.details).toMatchObject({ approved: false, problems: expect.any(Array) });
		expect(goalEvents(run)).toHaveLength(0);
		writeFileSync(run.paths.goal, VALID_GOAL);
		const result = await h.tool("herder_run", { action: "approve_goal" });
		expect(result.details).toMatchObject({ approved: true, approvedBy: "standing", grant: value.id });
		expect(result.content[0].text).toContain("standing authorization (self-driving mode)");
		expect(result.content[0].text).toContain("Delivery still waits for the user");
		expect(h.confirm).not.toHaveBeenCalled();
		expect(goalEvents(run)).toEqual([expect.objectContaining({ approvedBy: "standing", authorization: AUTHORIZATION, grant: value.id, checks: [{ id: "unit", command: "true", timeoutMs: 60_000, integrate: true }] })]);
		expect(h.statuses.get(STATUS_KEY)).toBe("herder: ready");
		// Every other check stays: an approved goal is frozen.
		await expect(h.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: true } });
		writeFileSync(run.paths.goal, `${VALID_GOAL}\nchanged\n`);
		await expect(h.tool("herder_run", { action: "approve_goal" })).rejects.toThrow(/frozen/);
		expect(goalEvents(run)).toHaveLength(1);
	});

	it("skips the dialog in an interactive session too", async () => {
		const fixture = repo();
		grant(fixture);
		const h = session(fixture);
		const { run } = await start(h, fixture);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await expect(h.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: true, approvedBy: "standing" } });
		expect(h.confirm).not.toHaveBeenCalled();
	});

	it("ignores a grant for another repository", async () => {
		const fixture = repo();
		grant(repo());
		const headless = session(fixture, { hasUI: false });
		const first = await start(headless, fixture);
		expect(first.prompt).not.toContain(STANDING_NOTE);
		writeFileSync(first.run.paths.goal, VALID_GOAL);
		await expect(headless.tool("herder_run", { action: "approve_goal" })).rejects.toThrow(/interactive/);
		await expect(headless.tool("herder_pick_findings", { title: "Simplify", findings: FINDINGS })).rejects.toThrow(/interactive session/);
		await expect(headless.tool("herder_run", { action: "abort" })).rejects.toThrow(/interactive/);
		expect(goalEvents(first.run)).toHaveLength(0);
		const interactive = session(fixture, { sessionId: "session-b" });
		await headless.shutdown();
		await interactive.command(`resume ${first.runId}`);
		await interactive.tool("herder_run", { action: "approve_goal" });
		expect(interactive.confirm).toHaveBeenCalledTimes(1);
		expect(goalEvents(first.run)).toEqual([expect.objectContaining({ approvedBy: "user" })]);
		expect(goalEvents(first.run)[0]).not.toHaveProperty("grant");
	});
});

describe("herder_pick_findings under a standing authorization", () => {
	it("returns the recommended findings and their dependencies without asking", async () => {
		const fixture = repo();
		const value = grant(fixture);
		const h = session(fixture, { hasUI: false });
		const result = await h.tool("herder_pick_findings", { title: "Simplify · standard", findings: FINDINGS });
		expect(result.details).toEqual({ selected: ["1", "2", "3"], cancelled: false, via: "standing", grant: value.id });
		expect(result.content[0].text).toBe("The user's standing authorization (self-driving mode) took the recommended findings and their dependencies, without asking. Selected 3 of 4: #1, #2, #3.");
		await expect(h.tool("herder_pick_findings", { title: "x", findings: [FINDINGS[0], FINDINGS[0]] })).rejects.toThrow(/Duplicate finding id/);
		// It needs no run.
		expect(listRuns(fixture.commonDir)).toEqual([]);
	});
});

describe("abort under a standing authorization", () => {
	it("abandons a standing-approved run without a confirmation", async () => {
		const fixture = repo();
		const value = grant(fixture);
		const h = session(fixture, { hasUI: false });
		const { runId, run } = await start(h, fixture);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await h.tool("herder_run", { action: "approve_goal" });
		const runtime = h.runtime();
		const result = await h.tool("herder_run", { action: "abort" });
		expect(result.details).toEqual({ runId, aborted: true, grant: value.id });
		expect(result.content[0].text).toContain("under the user's standing authorization");
		expect(h.confirm).not.toHaveBeenCalled();
		expect(runtime.calls.at(-1)).toEqual(["abandon", `aborted under the user's standing authorization (grant ${value.id})`]);
		expect(run.state().status).toBe("abandoned");
		expect(readLock(run.paths.lock)).toBeNull();
	});

	it("abandons a user-approved run created after the grant without a confirmation", async () => {
		const fixture = repo();
		const h = session(fixture);
		const { runId, run } = await start(h, fixture);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await h.tool("herder_run", { action: "approve_goal" });
		expect(h.confirm).toHaveBeenCalledTimes(1);
		grant(fixture, { since: new Date(Date.parse(run.journal.read()[0]!.at)).toISOString() });
		await expect(h.tool("herder_run", { action: "abort" })).resolves.toMatchObject({ details: { runId, aborted: true } });
		expect(h.confirm).toHaveBeenCalledTimes(1);
		expect(run.state().status).toBe("abandoned");
	});

	it("refuses an older user-approved run at once instead of waiting for the away user, with or without a UI", async () => {
		const fixture = repo();
		const h = session(fixture);
		const { runId, run } = await start(h, fixture);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await h.tool("herder_run", { action: "approve_goal" });
		expect(h.confirm).toHaveBeenCalledTimes(1);
		grant(fixture, { since: new Date(Date.now() + 60_000).toISOString() });
		await expect(h.tool("herder_run", { action: "abort" })).rejects.toThrow(`Herder run ${runId} predates the user's standing authorization (self-driving mode) and its goal was not approved under it, so abandoning it needs the user, who is away: leave the run as it is; they can abort it with /herder abort ${runId}.`);
		expect(h.confirm).toHaveBeenCalledTimes(1);
		expect(run.state().status).toBe("approved");
		await h.shutdown();
		const headless = session(fixture, { hasUI: false, sessionId: "session-b" });
		await expect(headless.tool("herder_run", { action: "abort" })).rejects.toThrow(/predates the user's standing authorization/);
		expect(headless.confirm).not.toHaveBeenCalled();
		expect(run.state().status).toBe("approved");
		// The user's own /herder abort is unaffected.
		await headless.command(`abort ${runId}`);
		expect(run.state().status).toBe("abandoned");
	});
});

describe("herder_deliver under a standing authorization", () => {
	it("refuses at once instead of opening the delivery dialog; /herder deliver still asks the user", async () => {
		const fixture = repo();
		const h = session(fixture);
		const { runId, run } = await start(h, fixture);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await h.tool("herder_run", { action: "approve_goal" });
		park(run);
		const value = grant(fixture);
		const refusal = `herder_deliver is refused under the user's standing authorization (self-driving mode, grant ${value.id}): the user is away and delivery waits for them. Leave the verified run parked and report it; they deliver it with /herder deliver <runId> when they return.`;
		await expect(h.tool("herder_deliver", {})).rejects.toThrow(refusal);
		await expect(h.tool("herder_deliver", { runId, mode: "branch" })).rejects.toThrow(refusal);
		const headless = session(fixture, { hasUI: false, sessionId: "session-b" });
		await expect(headless.tool("herder_deliver", { runId })).rejects.toThrow(refusal);
		expect(h.confirm).toHaveBeenCalledTimes(1);
		expect(h.runtime().calls.some(([name]) => name === "deliver")).toBe(false);
		expect(isParked(run.state())).toBe(true);
		// The user typed this, so they are there to confirm it.
		await h.command(`deliver ${runId}`);
		expect(h.confirm).toHaveBeenCalledTimes(2);
		expect(run.state().status).toBe("delivered");
	});
});

describe("prompts under a standing authorization", () => {
	it("tell the model to ask the user nothing and to leave the verified run parked", async () => {
		const fixture = repo();
		grant(fixture);
		const h = session(fixture);
		await h.command("add a greeting to the CLI");
		const started = h.sent.at(-1).content as string;
		expect(started).toContain(STANDING_NOTE);
		expect(started).toContain("1. Read the relevant code. Ask the user nothing: they are away.");
		expect(started).toContain("The standing authorization approves the goal without asking");
		expect(started).not.toContain("clarifying questions, only ones");
		expect(started).not.toContain("The user confirms the goal");
		const runId = listRuns(fixture.commonDir).at(-1)!;
		await h.command(`resume ${runId}`);
		const drafting = h.sent.at(-1).content as string;
		expect(drafting).toContain("The goal is not approved yet: ask the user nothing (they are away)");
		expect(drafting).not.toContain("finish clarifying");
		const run = openRun(fixture.commonDir, runId);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await h.tool("herder_run", { action: "approve_goal" });
		await h.command(`resume ${runId}`);
		const approved = h.sent.at(-1).content as string;
		expect(approved).toContain("then herder_verify; leave the verified run parked for the user (never call herder_deliver).");
		expect(approved).not.toContain("herder_verify and herder_deliver");
		await h.command("abort");
		await h.commands.get("herder-simplify").handler("--lang", h.ctx);
		const audit = h.sent.at(-1).content as string;
		expect(audit).toContain(STANDING_NOTE);
		expect(audit).toContain("--lang was given without a language and the user is away: use the user's conversation language");
		expect(audit).not.toContain("ask the user which language");
	});

	it("keep the clarifying questions without a grant", async () => {
		const fixture = repo();
		const h = session(fixture);
		await h.command("add a greeting to the CLI");
		const started = h.sent.at(-1).content as string;
		expect(started).not.toContain(STANDING_NOTE);
		expect(started).toContain("clarifying questions, only ones");
		expect(started).toContain("The user confirms the goal");
	});
});

describe("parked runs", () => {
	async function parkedRun(options: Partial<Parameters<typeof harness>[0]> = {}) {
		const fixture = repo();
		const h = session(fixture, options);
		await h.command("add a greeting to the CLI");
		const runId = listRuns(fixture.commonDir).at(-1)!;
		const run = openRun(fixture.commonDir, runId);
		writeFileSync(run.paths.goal, VALID_GOAL);
		await h.tool("herder_run", { action: "approve_goal" });
		park(run);
		expect(isParked(run.state())).toBe(true);
		return { fixture, h, runId, run };
	}

	it("a parked run lets a new run start, and the session releases the parked run it held", async () => {
		const { fixture, h, runId: first, run } = await parkedRun();
		expect(readLock(run.paths.lock)?.sessionId).toBe(h.herder.lockId(h.herder.session(h.ctx)));
		// With only a parked run unfinished, an audit may start.
		await h.commands.get("herder-improve").handler("", h.ctx);
		expect(h.lastNotice()).toEqual({ level: "info", text: "Started the read-only /herder-improve audit." });
		await h.command("second goal");
		expect(h.lastNotice()).toMatchObject({ level: "info", text: expect.stringContaining("Started Herder run") });
		const second = other(fixture, first);
		expect(second).not.toBe(first);
		expect(readLock(run.paths.lock)).toBeNull();
		expect(readLock(openRun(fixture.commonDir, second).paths.lock)?.sessionId).toBe(h.herder.lockId(h.herder.session(h.ctx)));
		expect(run.state().status).toBe("approved");
		expect(isParked(run.state())).toBe(true);
		expect(h.statuses.get(STATUS_KEY)).toBe("herder: drafting goal");
		// The audits are not blocked by a parked run either, only by the unfinished second one.
		await h.commands.get("herder-simplify").handler("", h.ctx);
		expect(h.lastNotice()).toMatchObject({ level: "error", text: expect.stringContaining(`/herder resume ${second}`) });
		// Resuming hands the held run back and forth; a parked one is released, not finished.
		await h.command(`resume ${first}`);
		expect(readLock(openRun(fixture.commonDir, second).paths.lock)).toBeNull();
		await h.command(`resume ${second}`);
		expect(h.lastNotice()).toEqual({ text: `Resumed Herder run ${second}.`, level: "info" });
		expect(readLock(run.paths.lock)).toBeNull();
		expect(isParked(run.state())).toBe(true);
	});

	it("an unfinished run that is not parked still blocks new runs and audits", async () => {
		const { fixture, h, runId, run } = await parkedRun();
		// The head moved since verification.
		run.journal.append({ t: "integrate.completed", key: "k", from: run.state().integrationHead!, source: "s", head: "d".repeat(40), tree: "t", message: "m", task: "T1", checks: [] });
		expect(isParked(run.state())).toBe(false);
		await h.command("second goal");
		expect(h.lastNotice()).toMatchObject({ level: "error" });
		expect(h.lastNotice()!.text).toBe(`Herder run ${runId} is unfinished. Continue it with /herder resume ${runId}, or abandon it with /herder abort ${runId}.`);
		await expect(h.tool("herder_run", { action: "start", goal: "another goal" })).rejects.toThrow(`/herder resume ${runId}`);
		await h.commands.get("herder-improve").handler("", h.ctx);
		expect(h.lastNotice()).toMatchObject({ level: "error", text: expect.stringContaining(`/herder abort ${runId}`) });
		expect(listRuns(fixture.commonDir)).toEqual([runId]);
		// A delivery that started is not parked either.
		park(run);
		expect(isParked(run.state())).toBe(true);
		run.journal.append({ t: "delivery.started", mode: "series", target: "main", tip: "d".repeat(40), onto: "e".repeat(40), commits: [] });
		expect(isParked(run.state())).toBe(false);
		await h.command("second goal");
		expect(h.lastNotice()).toMatchObject({ level: "error" });
	});

	it("tools and commands refuse to pick one of several unfinished runs, listing them; an id resolves it", async () => {
		const { fixture, h, runId: first } = await parkedRun();
		await h.command("fix the login flow");
		const second = other(fixture, first);
		await h.shutdown();
		const b = session(fixture, { sessionId: "session-b" });
		const listed = (text: string) => {
			expect(text).toContain("2 Herder runs are unfinished");
			expect(text).toContain(`${first} add a greeting to the CLI — parked (verified met, waiting for delivery)`);
			expect(text).toContain(`${second} fix the login flow — not parked (drafting)`);
			expect(text).toContain("/herder deliver <runId>");
		};
		for (const [name, params] of [["herder_step", { prompt: "x" }], ["herder_integrate", { source: "a", message: "m" }], ["herder_verify", {}], ["herder_check", {}], ["herder_deliver", {}], ["herder_run", { action: "record_decision", question: "q", answer: "a" }]] as const) {
			const error = await b.tool(name, params).then(() => undefined, (caught: Error) => caught);
			expect(error, name).toBeInstanceOf(Error);
			listed(error!.message);
		}
		for (const command of ["deliver", "resume", "abort"]) {
			await b.command(command);
			expect(b.lastNotice()).toMatchObject({ level: "error" });
			listed(b.lastNotice()!.text);
		}
		expect(readLock(openRun(fixture.commonDir, first).paths.lock)).toBeNull();
		expect(readLock(openRun(fixture.commonDir, second).paths.lock)).toBeNull();
		await b.command(`resume ${second}`);
		expect(b.lastNotice()).toEqual({ text: `Resumed Herder run ${second}.`, level: "info" });
		// Held, the run is the one meant.
		await expect(b.tool("herder_run", { action: "record_decision", question: "q", answer: "a" })).resolves.toMatchObject({ details: { runId: second } });
	});

	it("/herder deliver <runId> takes that run and delivers it; another live session's run is refused", async () => {
		const { fixture, h, runId: first, run } = await parkedRun();
		await h.command("fix the login flow");
		const second = other(fixture, first);
		const b = session(fixture, { sessionId: "session-b" });
		await b.command(`deliver ${second}`);
		expect(b.lastNotice()).toMatchObject({ level: "error", text: expect.stringMatching(/in use: run is locked by session session-a/) });
		await h.command(`deliver ${first} branch`);
		expect(h.lastNotice()).toMatchObject({ level: "info" });
		expect(h.confirm).toHaveBeenCalledTimes(2);
		expect(h.runtime().calls.at(-1)).toEqual(["deliver", { mode: "branch", curate: false }]);
		expect(run.state().status).toBe("delivered");
		expect(readLock(run.paths.lock)).toBeNull();
		// The session gave up its other run to deliver; it is the only unfinished one now, so it is meant again.
		expect(readLock(openRun(fixture.commonDir, second).paths.lock)).toBeNull();
		await expect(h.tool("herder_run", { action: "record_decision", question: "q", answer: "a" })).resolves.toMatchObject({ details: { runId: second } });
	});

	it("herder_deliver { runId } delivers a parked run the session does not hold", async () => {
		const { fixture, h, runId: first, run } = await parkedRun();
		await h.command("fix the login flow");
		const delivered = await h.tool("herder_deliver", { runId: first, mode: "squash", curate: true });
		expect(delivered.details).toMatchObject({ status: "delivered", mode: "squash" });
		expect(h.runtime().calls.at(-1)).toEqual(["deliver", { mode: "squash", curate: true }]);
		expect(run.state().status).toBe("delivered");
		await expect(h.tool("herder_deliver", { runId: first })).rejects.toThrow(/delivered/);
		expect(listRuns(fixture.commonDir)).toHaveLength(2);
	});

	it("status lists every parked run with its verified head and how to deliver it", async () => {
		const { fixture, h, runId: first, run } = await parkedRun();
		await h.command("status");
		expect(h.lastNotice()!.text).toContain("Parked runs (verified, waiting for delivery): 1");
		await h.command("fix the login flow");
		const second = other(fixture, first);
		const head = run.state().verification!.head;
		await h.command("status");
		const text = h.lastNotice()!.text;
		expect(text).toContain(`Herder run ${second}: fix the login flow`);
		expect(text).toContain(`  ${first} add a greeting to the CLI — verified met at ${head.slice(0, 12)}; deliver with /herder deliver ${first}`);
		expect(text).not.toContain(`  ${second} fix`);
		const tool = await h.tool("herder_run", { action: "status" });
		expect(tool.content[0].text).toBe(text);
		expect(tool.details).toMatchObject({ runId: second, parked: [{ runId: first, title: "add a greeting to the CLI", head }] });
		await h.command(`deliver ${first}`);
		await h.command("status");
		expect(h.lastNotice()!.text).not.toContain("Parked runs");
	});
});
