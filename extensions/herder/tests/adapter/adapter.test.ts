import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import herderExtension from "../../index.ts";
import { parseCommand, UsageError } from "../../src/adapter/commands.ts";
import { FOLLOW_UP_TYPE } from "../../src/adapter/session.ts";
import { ACTIVITY_REQUEST_EVENT, FOLLOWUP_RESULT_LIMIT, LOCK_STALE_MS, MAX_CLARIFYING_QUESTIONS, STATUS_KEY } from "../../src/config.ts";
import { readLock } from "../../src/run/lock.ts";
import { activeRun, listRuns, openRun } from "../../src/run/store.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";
import { harness, VALID_GOAL } from "./harness.ts";

const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function setup(options: Parameters<typeof harness>[0] extends infer O ? Partial<O> : never = {}) {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	const h = harness({ cwd: fixture.dir, ...options });
	cleanups.push(h.shutdown);
	return { fixture, h };
}

async function started(options: Parameters<typeof setup>[0] = {}) {
	const { fixture, h } = setup(options);
	await h.command("add a greeting to the CLI");
	const runId = activeRun(fixture.commonDir)!;
	expect(runId).toBeTruthy();
	return { fixture, h, runId, run: openRun(fixture.commonDir, runId) };
}

async function approved(options: Parameters<typeof setup>[0] = {}) {
	const context = await started(options);
	writeFileSync(context.run.paths.goal, VALID_GOAL);
	await context.h.tool("herder_run", { action: "approve_goal" });
	expect(context.run.state().goal).toBeDefined();
	return context;
}

const props = (tool: any) => Object.keys(tool.parameters.properties).sort();

describe("registration", () => {
	it("registers the commands and every tool with the documented parameters", () => {
		const { h } = setup();
		expect([...h.commands.keys()]).toEqual(["herder", "herder-improve", "herder-simplify"]);
		expect([...h.tools.keys()].sort()).toEqual(["herder_check", "herder_deliver", "herder_integrate", "herder_pick_findings", "herder_run", "herder_step", "herder_verify", "herder_workflow"]);
		const tool = (name: string) => h.tools.get(name);
		expect(props(tool("herder_run"))).toEqual(["action", "answer", "goal", "question", "runId"]);
		expect(tool("herder_run").parameters.required).toEqual(["action"]);
		expect(tool("herder_run").parameters.properties.action.anyOf.map((item: any) => item.const)).toEqual(["start", "status", "approve_goal", "record_decision"]);
		expect(props(tool("herder_workflow"))).toEqual(["args", "mode", "resume", "script", "scriptPath"]);
		expect(tool("herder_workflow").parameters.properties.mode.anyOf.map((item: any) => item.const)).toEqual(["validate", "run", "stop"]);
		expect(props(tool("herder_step"))).toEqual(["base", "effort", "fresh", "gate", "id", "label", "phase", "prompt", "role", "schema", "stallMs", "task", "timeoutMs", "write"]);
		expect(tool("herder_step").parameters.required).toEqual(["prompt"]);
		expect(props(tool("herder_integrate"))).toEqual(["checks", "message", "source", "task"]);
		expect(tool("herder_integrate").parameters.required.sort()).toEqual(["message", "source"]);
		expect(props(tool("herder_check"))).toEqual(["checks", "commit"]);
		expect(props(tool("herder_verify"))).toEqual([]);
		expect(props(tool("herder_deliver"))).toEqual(["curate", "mode"]);
		expect(props(tool("herder_pick_findings"))).toEqual(["findings", "title"]);
		for (const item of h.tools.values()) expect(item.description.length).toBeLessThan(400);
	});

	it("loads the real extension without touching git, timers, or the runtime", () => {
		const registered: string[] = [];
		const pi = { on() {}, registerCommand: (name: string) => registered.push(`/${name}`), registerTool: (tool: { name: string }) => registered.push(tool.name), events: { on() { return () => {}; }, emit() {} } };
		expect(() => herderExtension(pi as never)).not.toThrow();
		expect(registered).toEqual(expect.arrayContaining(["/herder", "/herder-improve", "/herder-simplify"]));
		expect(registered).toHaveLength(11);
	});
});

describe("command parsing", () => {
	it("treats an exact first-word subcommand as the subcommand and anything else as goal text", () => {
		expect(parseCommand("")).toEqual({ action: "help" });
		expect(parseCommand("status")).toEqual({ action: "status", runId: undefined });
		expect(parseCommand("resume 20260101-000000-abcd")).toEqual({ action: "resume", runId: "20260101-000000-abcd" });
		expect(parseCommand("deliver --curate squash")).toEqual({ action: "deliver", mode: "squash", curate: true });
		expect(parseCommand("deliver")).toEqual({ action: "deliver", mode: "series", curate: false });
		expect(parseCommand("clean")).toEqual({ action: "clean" });
		expect(parseCommand("clean --finished")).toEqual({ action: "clean" });
		expect(parseCommand("statusbar shows the wrong branch")).toEqual({ action: "start", goal: "statusbar shows the wrong branch" });
		expect(parseCommand("-- status page shows stale data")).toEqual({ action: "start", goal: "status page shows stale data" });
		expect(parseCommand("fix the\nlogin flow")).toEqual({ action: "start", goal: "fix the\nlogin flow" });
	});

	it.each(["status page is broken", "deliver fast", "deliver series branch", "deliver --curate --curate", "abort a b", "clean --all", "--fast goal", "--", "help me"])("rejects %s with usage", (args) => {
		expect(() => parseCommand(args)).toThrow(UsageError);
		expect(() => parseCommand(args)).toThrow(/Usage:/);
	});
});

describe("/herder", () => {
	it("creates a run with a goal draft, locks it, and primes the model", async () => {
		const { fixture, h, runId, run } = await started();
		expect(readFileSync(run.paths.goal, "utf8")).toMatch(/^# Goal: add a greeting to the CLI/);
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-a#[0-9a-f]{8}$/);
		expect(h.runtime().calls).toEqual([["start"]]);
		expect(h.sent).toHaveLength(1);
		const prompt = h.sent[0].content as string;
		expect(prompt).toContain(runId);
		for (const path of [run.paths.goal, run.paths.plan, run.paths.notes]) expect(prompt).toContain(path);
		expect(prompt).toContain(`at most ${MAX_CLARIFYING_QUESTIONS} clarifying questions`);
		expect(prompt).toContain("recommended answer");
		expect(prompt).toContain('herder_run { action: "approve_goal" }');
		expect(prompt).toContain("# Herder");
		expect(prompt).not.toMatch(/^name: herder$/m);
		expect(h.statuses.get(STATUS_KEY)).toBe("herder: drafting goal");
		expect(fixture.status()).toBe("");
	});

	it("refuses while another run is unfinished", async () => {
		const { fixture, h, runId } = await started();
		await h.command("something else");
		expect(h.lastNotice()).toMatchObject({ level: "error" });
		expect(h.lastNotice()!.text).toContain(`/herder resume ${runId}`);
		expect(h.lastNotice()!.text).toContain(`/herder abort ${runId}`);
		expect(listRuns(fixture.commonDir)).toEqual([runId]);
	});

	it("marks the run failed when the runtime cannot start it", async () => {
		const { fixture, h } = setup({ options: { createRuntime: () => { throw new Error("not wired yet"); } } });
		await h.command("a goal");
		expect(h.lastNotice()).toEqual({ text: "not wired yet", level: "error" });
		expect(activeRun(fixture.commonDir)).toBeNull();
		const [runId] = listRuns(fixture.commonDir);
		expect(openRun(fixture.commonDir, runId!).state().status).toBe("failed");
		expect(readLock(openRun(fixture.commonDir, runId!).paths.lock)).toBeNull();
	});

	it("reports usage for unknown subcommand arguments", async () => {
		const { h } = setup();
		await h.command("deliver now");
		expect(h.lastNotice()!.text).toContain("Usage:");
		expect(h.sent).toHaveLength(0);
	});
});

describe("herder_run", () => {
	it("returns goal problems without journaling", async () => {
		const { h, run } = await started();
		const result = await h.tool("herder_run", { action: "approve_goal" });
		expect(result.details.approved).toBe(false);
		expect(result.details.problems.length).toBeGreaterThan(0);
		expect(h.confirm).not.toHaveBeenCalled();
		expect(run.state().goal).toBeUndefined();
	});

	it("journals goal.approved only after a yes", async () => {
		const { h, run } = await started();
		writeFileSync(run.paths.goal, VALID_GOAL);
		h.confirm.mockResolvedValueOnce(false);
		const declined = await h.tool("herder_run", { action: "approve_goal" });
		expect(declined.details.approved).toBe(false);
		expect(run.journal.read().filter((event) => event.t === "goal.approved")).toHaveLength(0);
		const accepted = await h.tool("herder_run", { action: "approve_goal" });
		expect(accepted.details.approved).toBe(true);
		expect(h.confirm).toHaveBeenCalledTimes(2);
		expect(h.confirm.mock.calls[1]![0]).toContain("Add a greeting");
		expect(h.confirm.mock.calls[1]![1]).toContain("| unit | true | 1m | yes |");
		const events = run.journal.read().filter((event) => event.t === "goal.approved");
		expect(events).toEqual([expect.objectContaining({ approvedBy: "user", sha256: expect.stringMatching(/^[0-9a-f]{64}$/), checks: [{ id: "unit", command: "true", timeoutMs: 60_000, integrate: true }] })]);
		expect(h.statuses.get(STATUS_KEY)).toBe("herder: ready");
		await expect(h.tool("herder_run", { action: "approve_goal" })).resolves.toMatchObject({ details: { approved: true } });
		expect(h.confirm).toHaveBeenCalledTimes(2);
		writeFileSync(run.paths.goal, `${VALID_GOAL}\n## Notes\nchanged\n`);
		await expect(h.tool("herder_run", { action: "approve_goal" })).rejects.toThrow(/frozen/);
	});

	it("refuses approval non-interactively", async () => {
		const { h, run } = await started({ hasUI: false });
		writeFileSync(run.paths.goal, VALID_GOAL);
		await expect(h.tool("herder_run", { action: "approve_goal" })).rejects.toThrow(/interactive/);
		expect(h.confirm).not.toHaveBeenCalled();
		expect(run.state().goal).toBeUndefined();
	});

	it("records decisions and reports status", async () => {
		const { h, run, runId } = await started();
		await h.tool("herder_run", { action: "record_decision", question: "Which locale?", answer: "en-US" });
		expect(run.state().decisions).toEqual([expect.objectContaining({ question: "Which locale?", answer: "en-US" })]);
		await expect(h.tool("herder_run", { action: "record_decision", question: "q" })).rejects.toThrow(/question and an answer/);
		const status = await h.tool("herder_run", { action: "status" });
		expect(status.content[0].text).toContain(`Herder run ${runId}`);
		expect(status.content[0].text).toContain("Lock: this session");
		expect(status.details).toMatchObject({ runId, status: "drafting", goalApproved: false });
	});
});

describe("approved-goal guard", () => {
	it.each([
		["herder_workflow", { mode: "validate", script: "return 1" }],
		["herder_workflow", { mode: "run", script: "return 1" }],
		["herder_step", { prompt: "do it" }],
		["herder_integrate", { source: "abc", message: "m" }],
		["herder_check", {}],
		["herder_verify", {}],
		["herder_deliver", {}],
	])("%s refuses without an approved goal", async (name, params) => {
		const { h } = await started();
		await expect(h.tool(name, params)).rejects.toThrow(/not approved yet/);
		expect(h.runtime().calls).toEqual([["start"]]);
	});

	it("tools refuse without any run", async () => {
		const { h } = setup();
		await expect(h.tool("herder_step", { prompt: "x" })).rejects.toThrow(/No active Herder run/);
		await expect(h.tool("herder_run", { action: "status" })).resolves.toMatchObject({ content: [{ text: "No Herder runs in this repository." }] });
	});
});

describe("direct tools", () => {
	it("runs a step, integrates it by step key, and validates check ids", async () => {
		const { h, run } = await approved();
		h.runtime().stepActivity = { key: "step-0", label: "implement", task: "T1", phase: "implement" };
		const step = await h.tool("herder_step", { prompt: "implement", task: "T1", gate: "unit", label: "implement" });
		expect(step.details.status).toBe("ok");
		expect(h.runtime().calls[1]).toEqual(["step", "implement", { task: "T1", gate: "unit", label: "implement" }]);
		await expect(h.tool("herder_step", { prompt: "x", gate: ["nope"] })).rejects.toThrow(/Unknown check id/);
		run.journal.append({ t: "step.completed", key: "impl-0", fingerprint: "f", status: "ok", commit: "e".repeat(40) });
		await h.tool("herder_integrate", { source: "impl-0", message: "Add greeting", task: "T1" });
		expect(h.runtime().calls.at(-1)).toEqual(["integrate", "e".repeat(40), { message: "Add greeting", task: "T1" }]);
		run.journal.append({ t: "step.completed", key: "ro-0", fingerprint: "f", status: "no_changes" });
		await expect(h.tool("herder_integrate", { source: "ro-0", message: "m" })).rejects.toThrow(/no commit/);
		await h.tool("herder_check", { checks: ["unit"] });
		expect(h.runtime().calls.at(-1)).toEqual(["check", { checks: ["unit"] }]);
		await expect(h.tool("herder_verify", {})).resolves.toMatchObject({ details: { verdict: "met" } });
	});

	it("validates scripts with role names and goal checks", async () => {
		const { h } = await approved();
		const good = await h.tool("herder_workflow", { mode: "validate", script: 'const r = await agent("x", { role: "reviewer", gate: "unit" }); return r.status;' });
		expect(good.details.ok).toBe(true);
		const bad = await h.tool("herder_workflow", { mode: "validate", script: 'await agent("x", { role: "ghost", gate: "nope" });' });
		expect(bad.details.ok).toBe(false);
		expect(bad.content[0].text).toMatch(/ghost/);
		await expect(h.tool("herder_workflow", { mode: "validate" })).rejects.toThrow(/exactly one/);
	});

	it("delivers only interactively, after confirmation, and then releases the run", async () => {
		const { h, run } = await approved();
		h.confirm.mockResolvedValueOnce(false);
		await expect(h.tool("herder_deliver", {})).resolves.toMatchObject({ details: { status: "cancelled" } });
		expect(readLock(run.paths.lock)).not.toBeNull();
		const delivered = await h.tool("herder_deliver", { mode: "branch" });
		expect(delivered.details).toMatchObject({ status: "delivered", mode: "branch" });
		expect(readLock(run.paths.lock)).toBeNull();
		expect(h.statuses.has(STATUS_KEY)).toBe(false);
	});

	it("refuses delivery non-interactively", async () => {
		const context = await started({ hasUI: false });
		await expect(context.h.tool("herder_deliver", {})).rejects.toThrow(/interactive/);
	});
});

describe("background launches", () => {
	it("returns at once and sends exactly one follow-up when the launch settles", async () => {
		const { h, run } = await approved();
		const result = await h.tool("herder_workflow", { mode: "run", script: "return 1", args: { n: 1 } });
		expect(result.details.launch).toBe(1);
		expect(h.statuses.get(STATUS_KEY)).toBe("herder: launch 1");
		await expect(h.tool("herder_workflow", { mode: "run", script: "return 2" })).rejects.toThrow(/still running/);
		await expect(h.tool("herder_step", { prompt: "x" })).rejects.toThrow(/waits until launch 1 settles/);
		const before = h.sent.length;
		const value = "x".repeat(FOLLOWUP_RESULT_LIMIT + 100);
		h.runtime().launches[0]!.settle({ value, reused: 2, changed: 1, new: 3, resultRef: `outputs/${"a".repeat(64)}.txt` });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const followUps = h.sent.slice(before);
		expect(followUps).toHaveLength(1);
		expect(followUps[0].customType).toBe(FOLLOW_UP_TYPE);
		const text = followUps[0].content as string;
		expect(text).toContain("launch 1");
		expect(text).toContain("completed");
		expect(text).toContain("2 reused, 1 changed, 3 new");
		expect(text).toContain(join(run.paths.dir, "outputs", `${"a".repeat(64)}.txt`));
		expect(text).toContain("x".repeat(FOLLOWUP_RESULT_LIMIT));
		expect(text).not.toContain("x".repeat(FOLLOWUP_RESULT_LIMIT + 1));
		expect(h.pi.sendMessage).toHaveBeenLastCalledWith(expect.anything(), { triggerTurn: true, deliverAs: "followUp" });
		expect(h.statuses.get(STATUS_KEY)).toBe("herder: ready");
		const second = await h.tool("herder_workflow", { mode: "run", script: "return 2", resume: 1 });
		expect(second.details.launch).toBe(2);
		expect(h.runtime().launches[1]!.request).toEqual({ source: "return 2", args: undefined, resume: 1 });
	});

	it("reports a failed launch and its error", async () => {
		const { h } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "throw 1" });
		h.runtime().launches[0]!.settle({ status: "failed", error: "boom" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const text = h.sent.at(-1).content as string;
		expect(text).toContain("failed");
		expect(text).toContain("Error: boom");
		expect(text).toContain("resume: 1");
	});

	it("reports a stop in the tool result and sends no follow-up", async () => {
		const { h } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const before = h.sent.length;
		const stopped = await h.tool("herder_workflow", { mode: "stop" });
		expect(stopped.details).toMatchObject({ launch: 1, status: "stopped" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.sent).toHaveLength(before);
		await expect(h.tool("herder_workflow", { mode: "stop" })).rejects.toThrow(/No launch/);
	});

	it("stops a launch after goal.md changed", async () => {
		const { h, run } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		writeFileSync(run.paths.goal, `${VALID_GOAL}\nmore\n`);
		await expect(h.tool("herder_workflow", { mode: "stop" })).resolves.toMatchObject({ details: { launch: 1, status: "stopped" } });
		await expect(h.tool("herder_workflow", { mode: "validate", script: "return 1" })).rejects.toThrow(/changed after approval/);
	});

	it("rejects resuming a launch that does not exist", async () => {
		const { h } = await approved();
		await expect(h.tool("herder_workflow", { mode: "run", script: "return 1", resume: 4 })).rejects.toThrow(/does not exist/);
	});
});

describe("activity and shutdown", () => {
	it("publishes running steps, replays on request, and clears everything on shutdown", async () => {
		const { h, run } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const runtime = h.runtime();
		runtime.env.onActivity({ key: "impl-0", label: "implement greeting", task: "T2", phase: "integrate", state: "running" });
		expect(h.snapshots.at(-1)).toEqual({ source: "herder", activities: [{ id: "step:impl-0", label: "Herder T2 · implement greeting" }] });
		expect(h.statuses.get(STATUS_KEY)).toBe("herder: T2 integrate");
		writeFileSync(run.paths.plan, "- [ ] T1 (AC-1) one\n- [ ] T2 (AC-1) two\n");
		runtime.env.onProgress();
		expect(h.statuses.get(STATUS_KEY)).toBe("herder: T2 integrate · 0/2 tasks");
		const count = h.snapshots.length;
		h.events.emit(ACTIVITY_REQUEST_EVENT, {});
		expect(h.snapshots).toHaveLength(count + 1);
		expect(h.snapshots.at(-1).activities).toHaveLength(1);
		const before = h.sent.length;
		await h.shutdown();
		expect(runtime.launches[0]!.stopped).toBe("session shutdown");
		expect(h.sent).toHaveLength(before);
		expect(h.snapshots.at(-1)).toEqual({ source: "herder", activities: [] });
		expect(h.statuses.has(STATUS_KEY)).toBe(false);
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
		expect(readLock(run.paths.lock)).toBeNull();
		await h.shutdown();
		expect(h.snapshots.at(-1)).toEqual({ source: "herder", activities: [] });
	});
});

describe("locks across sessions", () => {
	it("a second session takes over only a stale lock", async () => {
		let now = Date.parse("2026-10-25T10:00:00Z");
		const clock = { now: () => new Date(now) };
		const { fixture, h: a, runId, run } = await started({ options: { lock: clock } });
		const b = harness({ cwd: fixture.dir, sessionId: "session-b", options: { lock: clock } });
		cleanups.push(b.shutdown);
		await b.command("resume");
		expect(b.lastNotice()).toMatchObject({ level: "error" });
		expect(b.lastNotice()!.text).toMatch(/in use: run is locked by session session-a/);
		await expect(b.tool("herder_run", { action: "record_decision", question: "q", answer: "a" })).rejects.toThrow(/in use/);
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-a#[0-9a-f]{8}$/);
		now += LOCK_STALE_MS - 1_000;
		await b.command(`resume ${runId}`);
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-a#[0-9a-f]{8}$/);
		now += 2_000;
		await b.command(`resume ${runId}`);
		expect(b.lastNotice()).toEqual({ text: `Resumed Herder run ${runId}.`, level: "info" });
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-b#[0-9a-f]{8}$/);
		expect(b.sent.at(-1).content).toContain(`continue Herder run ${runId}`);
		await a.tool("herder_run", { action: "status" });
		expect((await a.tool("herder_run", { action: "status" })).content[0].text).toContain("Lock: session session-b");
		await a.shutdown();
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-b#[0-9a-f]{8}$/);
	});

	it("the heartbeat refreshes the lock and stops when the session shuts down", async () => {
		let now = Date.parse("2026-10-25T10:00:00Z");
		const { h, run } = await started({ options: { lock: { now: () => new Date(now) }, heartbeatMs: 20 } });
		now += 60_000;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(readLock(run.paths.lock)?.heartbeatAt).toBe(new Date(now).toISOString());
		await h.shutdown();
		expect(readLock(run.paths.lock)).toBeNull();
	});
});

describe("resume, abort, clean", () => {
	it("resume names the launch that did not complete", async () => {
		const { fixture, h, runId, run } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "return 1", args: { tasks: ["T1"] } });
		await h.shutdown();
		const b = harness({ cwd: fixture.dir, sessionId: "session-b" });
		cleanups.push(b.shutdown);
		await b.command("resume");
		const prompt = b.sent.at(-1).content as string;
		expect(prompt).toContain(`Launch 1 stopped`);
		expect(prompt).toContain(`scriptPath: "${join(run.paths.scripts, "1.js")}"`);
		expect(prompt).toContain('args: {"tasks":["T1"]}');
		expect(prompt).toContain("resume: 1");
		expect(prompt).toContain(VALID_GOAL.split("\n")[0]);
		expect(prompt).toContain(`## progress.md (${run.paths.progress})`);
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-b#[0-9a-f]{8}$/);
		expect(runId).toBe(activeRun(fixture.commonDir));
	});

	it("resume fails with nothing to resume", async () => {
		const { h } = setup();
		await h.command("resume");
		expect(h.lastNotice()!.text).toMatch(/^nothing to resume/);
		await h.command("resume 20200101-000000-abcd");
		expect(h.lastNotice()!.text).toMatch(/^nothing to resume/);
	});

	it("abort stops the launch, abandons through the runtime, and clean deletes only finished runs", async () => {
		const { fixture, h, runId, run } = await approved();
		await h.command(`clean ${runId}`);
		expect(h.lastNotice()!.text).toMatch(/unfinished/);
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const runtime = h.runtime();
		await h.command("abort");
		expect(runtime.launches[0]!.stopped).toBe("run aborted");
		expect(runtime.calls.at(-1)).toEqual(["abandon", "aborted by the user"]);
		expect(run.state().status).toBe("abandoned");
		expect(readLock(run.paths.lock)).toBeNull();
		expect(h.statuses.has(STATUS_KEY)).toBe(false);
		await h.command("abort");
		expect(h.lastNotice()!.text).toMatch(/No unfinished Herder run/);
		await h.command("clean");
		expect(h.lastNotice()!.text).toContain(runId);
		expect(existsSync(run.paths.dir)).toBe(false);
		expect(fixture.git("for-each-ref", "refs/herder")).toBe("");
	});

	it("/herder status describes the latest run", async () => {
		const { h, runId } = await started();
		await h.command("status");
		expect(h.lastNotice()!.text).toContain(`Herder run ${runId}: add a greeting to the CLI`);
		expect(h.lastNotice()!.text).toContain("goal not approved");
	});
});

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const otherLock = (now = new Date()) => `${JSON.stringify({ pid: process.pid + 1, host: "elsewhere", startedAt: now.toISOString(), heartbeatAt: now.toISOString(), sessionId: "session-z#00000000" })}\n`;

describe("run ownership", () => {
	it("shutdown keeps the lock while a launch has not settled, and a reloaded instance cannot take it meanwhile", async () => {
		const { fixture, h, runId, run } = await approved({ options: { stopWaitMs: 20 } });
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const runtime = h.runtime();
		runtime.holdOnStop = true;
		await h.shutdown();
		expect(runtime.launches[0]!.stopped).toBe("session shutdown");
		expect(readLock(run.paths.lock)?.sessionId).toMatch(/^session-a#/);
		const reloaded = harness({ cwd: fixture.dir, sessionId: "session-a" });
		cleanups.push(reloaded.shutdown);
		await reloaded.command(`resume ${runId}`);
		expect(reloaded.lastNotice()).toMatchObject({ level: "error" });
		expect(reloaded.lastNotice()!.text).toMatch(/in use/);
		runtime.launches[0]!.settle({ status: "stopped" });
		await tick();
		expect(readLock(run.paths.lock)).toBeNull();
		await reloaded.command(`resume ${runId}`);
		expect(reloaded.lastNotice()).toEqual({ text: `Resumed Herder run ${runId}.`, level: "info" });
		expect(readLock(run.paths.lock)?.sessionId).toBe(reloaded.herder.lockId(reloaded.herder.session(reloaded.ctx)));
	});

	it("a lost lock stops the launch and tells the model once, naming the holder", async () => {
		const { h, run } = await approved({ options: { heartbeatMs: 15 } });
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		const before = h.sent.length;
		writeFileSync(run.paths.lock, otherLock());
		await tick(60);
		expect(h.runtime().launches[0]!.stopped).toBe("run lock lost");
		const messages = h.sent.slice(before);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ customType: FOLLOW_UP_TYPE, details: { launch: 1, status: "stopped" } });
		expect(messages[0].content).toContain("lost the run lock");
		expect(messages[0].content).toContain("session-z#00000000");
		expect(h.lastNotice()).toMatchObject({ level: "warning" });
		expect(h.runtime().env.signal.aborted).toBe(true);
		expect(readLock(run.paths.lock)?.sessionId).toBe("session-z#00000000");
		await expect(h.tool("herder_step", { prompt: "x" })).rejects.toThrow(/in use/);
	});

	it("tools notice a lost lock before acting", async () => {
		const { h, run } = await approved();
		writeFileSync(run.paths.lock, otherLock());
		await expect(h.tool("herder_step", { prompt: "x" })).rejects.toThrow(/lost run .*session-z/);
		expect(h.runtime().calls.filter(([name]) => name === "step")).toHaveLength(0);
		expect(readLock(run.paths.lock)?.sessionId).toBe("session-z#00000000");
	});

	it("an explicit runId of a finished run does not take its lock", async () => {
		const { h, runId, run } = await approved();
		await h.command("abort");
		await expect(h.tool("herder_run", { action: "record_decision", runId, question: "q", answer: "a" })).rejects.toThrow(/abandoned/);
		expect(readLock(run.paths.lock)).toBeNull();
	});

	it("tools refuse when goal.md changed after approval", async () => {
		const { h, run } = await approved();
		writeFileSync(run.paths.goal, `${VALID_GOAL}\nmore\n`);
		await expect(h.tool("herder_step", { prompt: "x" })).rejects.toThrow(/changed after approval/);
		await expect(h.tool("herder_verify", {})).rejects.toThrow(/changed after approval/);
	});
});

describe("tracked tool calls", () => {
	it("passes a signal that follows both the tool call and the run", async () => {
		const { h } = await approved();
		const controller = new AbortController();
		let release!: () => void;
		h.runtime().stepGate = new Promise<void>((resolve) => { release = resolve; });
		const step = h.tool("herder_step", { prompt: "x" }, controller.signal);
		await tick();
		controller.abort();
		await expect(step).resolves.toMatchObject({ details: { status: "stopped" } });
		expect(h.runtime().env.signal.aborted).toBe(false);
		release();
	});

	it("delivery and clean refuse while a step runs; abort cancels it and waits", async () => {
		const { h, run } = await approved();
		const runtime = h.runtime();
		runtime.stepGate = new Promise(() => {});
		const step = h.tool("herder_step", { prompt: "x" });
		await tick();
		await expect(h.tool("herder_deliver", {})).rejects.toThrow(/running Herder tool call/);
		await expect(h.tool("herder_verify", {})).rejects.toThrow(/running Herder tool call/);
		await h.command("abort");
		await expect(step).resolves.toMatchObject({ details: { status: "stopped" } });
		const names = runtime.calls.map(([name]) => name);
		expect(names.indexOf("step settled")).toBeLessThan(names.indexOf("abandon"));
		expect(run.state().status).toBe("abandoned");
		expect(readLock(run.paths.lock)).toBeNull();
	});

	it("shutdown cancels a running step and releases the lock once it settles", async () => {
		const { h, run } = await approved();
		const runtime = h.runtime();
		runtime.stepGate = new Promise(() => {});
		const step = h.tool("herder_step", { prompt: "x" });
		await tick();
		await h.shutdown();
		await expect(step).resolves.toMatchObject({ details: { status: "stopped" } });
		expect(readLock(run.paths.lock)).toBeNull();
	});

	it("a launch that finishes starting after shutdown is stopped", async () => {
		const { h, run } = await approved();
		const runtime = h.runtime();
		let release!: () => void;
		runtime.launchGate = new Promise<void>((resolve) => { release = resolve; });
		const launch = h.tool("herder_workflow", { mode: "run", script: "return 1" });
		await tick();
		const shutdown = h.shutdown();
		release();
		await shutdown;
		await expect(launch).rejects.toThrow(/stopped/);
		expect(runtime.launches[0]!.stopped).toBe("the session closed");
		expect(readLock(run.paths.lock)).toBeNull();
	});

	it("passes a signal following the tool call to the approval dialog", async () => {
		const { h, run } = await started();
		writeFileSync(run.paths.goal, VALID_GOAL);
		const controller = new AbortController();
		await h.tool("herder_run", { action: "approve_goal" }, controller.signal);
		const signal = h.confirm.mock.calls[0]![2]!.signal!;
		expect(signal.aborted).toBe(false);
		controller.abort();
		expect(signal.aborted).toBe(true);
	});

	it("a launch and checks wait while a delivery is confirming", async () => {
		const { h, run } = await approved();
		let answer!: (yes: boolean) => void;
		h.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
		const delivery = h.command("deliver");
		await tick();
		await expect(h.tool("herder_workflow", { mode: "run", script: "return 1" })).rejects.toThrow(/waits until the running Herder tool call finishes/);
		await expect(h.tool("herder_check", {})).rejects.toThrow(/waits until the running Herder tool call finishes/);
		answer(true);
		await delivery;
		expect(h.lastNotice()).toMatchObject({ level: "info" });
		expect(h.runtime().calls.map(([name]) => name)).not.toContain("launch");
		expect(h.runtime().calls.map(([name]) => name)).not.toContain("check");
		expect(run.state().status).toBe("delivered");
	});

	it("checks run alongside a launch; a launch waits for a running tool call", async () => {
		const { h } = await approved();
		await h.tool("herder_workflow", { mode: "run", script: "return 1" });
		await expect(h.tool("herder_check", {})).resolves.toMatchObject({ details: { checks: [] } });
		h.runtime().launches[0]!.settle();
		await tick();
		h.runtime().stepGate = new Promise(() => {});
		const step = h.tool("herder_step", { prompt: "x" });
		await tick();
		await expect(h.tool("herder_workflow", { mode: "run", script: "return 2" })).rejects.toThrow(/waits until the running Herder tool call finishes/);
		expect(h.runtime().launches).toHaveLength(1);
		await h.command("abort");
		await expect(step).resolves.toMatchObject({ details: { status: "stopped" } });
	});

	it("an abort during the approval dialog wins over a late yes", async () => {
		const { h, run } = await started();
		writeFileSync(run.paths.goal, VALID_GOAL);
		let answer!: (yes: boolean) => void;
		h.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
		const approval = h.tool("herder_run", { action: "approve_goal" });
		await tick();
		const abort = h.command("abort");
		await tick();
		answer(true);
		await abort;
		await expect(approval).rejects.toThrow(/being stopped/);
		expect(h.lastNotice()).toMatchObject({ level: "info" });
		expect(run.journal.read().filter((event) => event.t === "goal.approved")).toHaveLength(0);
		expect(run.state().status).toBe("abandoned");
		expect(readLock(run.paths.lock)).toBeNull();
	});
});
