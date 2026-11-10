// A run whose journal cannot be read is still a run: it blocks a new one, is reported where "no run" would be, and goes
// with `/herder clean <runId>`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeFactory } from "../../src/adapter/runtime.ts";
import { JOURNAL_SCHEMA_VERSION } from "../../src/config.ts";
import { baseRef, integrationRef, refPrefix, worktreePath } from "../../src/run/paths.ts";
import { createRun, listRuns, openRun, type RunStore } from "../../src/run/store.ts";
import { harness } from "../adapter/harness.ts";
import { createGitFixture, type GitFixture } from "../support/git-fixture.ts";

const fixtures: GitFixture[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function repository(): GitFixture {
	const fixture = createGitFixture();
	fixtures.push(fixture);
	return fixture;
}

/** A session on the real runtime, so that a run it starts owns its refs. */
function session(fixture: GitFixture, sessionId = "session-b") {
	const h = harness({ cwd: fixture.dir, sessionId, options: { createRuntime: createRuntimeFactory({ roles: () => new Map() }) } });
	cleanups.push(h.shutdown);
	return h;
}
type Session = ReturnType<typeof session>;

const STARTED = { level: "info", text: expect.stringMatching(/^Started Herder run \S+\.$/) };

/** `/herder <goal>` in `h`: an unfinished run with two journal lines that owns its refs and an integration worktree. */
async function start(h: Session, fixture: GitFixture): Promise<RunStore> {
	await h.command("first goal");
	expect(h.lastNotice()).toEqual(STARTED);
	const run = openRun(fixture.commonDir, h.sent.at(-1).details.runId);
	fixture.git("worktree", "add", "--detach", "--quiet", worktreePath(fixture.commonDir, run.runId, "integration"), fixture.head());
	run.journal.append({ t: "plan.updated", sha256: "p" });
	return run;
}

/** A run as an earlier session, gone since, left it. */
async function leftBehind(fixture: GitFixture): Promise<RunStore> {
	const h = session(fixture, "session-a");
	const run = await start(h, fixture);
	await h.shutdown();
	return run;
}

const rewrite = (run: RunStore, change: (journal: string) => string) => writeFileSync(run.paths.journal, change(readFileSync(run.paths.journal, "utf8")));
const refs = (fixture: GitFixture, run: RunStore) => fixture.git("for-each-ref", "--format=%(refname)", refPrefix(run.runId));
const worktrees = (fixture: GitFixture) => fixture.git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));

/** The run's id, its journal error, and what to do about either cause. */
function expectReported(text: string | undefined, run: RunStore, error: RegExp): void {
	expect(text).toContain(`Herder run ${run.runId} `);
	expect(text).toMatch(error);
	expect(text).toMatch(/update Herder/i);
	expect(text).toContain(`/herder clean ${run.runId}`);
}

const rejection = (call: Promise<unknown>) => call.then(() => undefined, (error: Error) => error.message);

describe.each([
	{
		kind: "corrupt before its last line", error: /journal\.jsonl is corrupt at line 2: invalid JSON/,
		damage: (journal: string) => journal.replace("\n", "\n{oops\n"),
	},
	{
		kind: "written by a newer Herder", error: /journal\.jsonl line 3 was written by a newer Herder version/,
		damage: (journal: string) => `${journal}${JSON.stringify({ v: JOURNAL_SCHEMA_VERSION + 1, t: "plan.updated", at: "2026-01-01T00:00:00.000Z", sha256: "q" })}\n`,
	},
])("a run whose journal is $kind", ({ error, damage }) => {
	async function unreadable() {
		const fixture = repository();
		const run = await leftBehind(fixture);
		rewrite(run, damage);
		expect(() => run.state()).toThrow(error);
		return { fixture, run, h: session(fixture) };
	}

	it("refuses to start a run, naming the run and the journal error, and creates no run", async () => {
		const { fixture, run, h } = await unreadable();
		await h.command("second goal");
		expect(h.lastNotice()!.level).toBe("error");
		expectReported(h.lastNotice()!.text, run, error);
		expectReported(await rejection(h.tool("herder_run", { action: "start", goal: "second goal" })), run, error);
		expect(listRuns(fixture.commonDir)).toEqual([run.runId]);
		expect(h.sent).toEqual([]);
	});

	it("is reported by resume without a run id", async () => {
		const { run, h } = await unreadable();
		await h.command("resume");
		expect(h.lastNotice()!.level).toBe("error");
		expectReported(h.lastNotice()!.text, run, error);
		expect(h.lastNotice()!.text).not.toMatch(/nothing to resume/);
		expect(h.sent).toEqual([]);
	});

	it("is reported by status, abort, and the tools instead of no run", async () => {
		const { run, h } = await unreadable();
		for (const command of ["status", "abort"]) {
			await h.command(command);
			expect(h.lastNotice()!.level, command).toBe("error");
			expectReported(h.lastNotice()!.text, run, error);
		}
		expectReported(await rejection(h.tool("herder_run", { action: "status" })), run, error);
		expectReported(await rejection(h.tool("herder_step", { prompt: "x" })), run, error);
		expect(existsSync(run.paths.dir)).toBe(true);
	});

	it("leaves a readable unfinished run next to it usable", async () => {
		const fixture = repository();
		const healthy = await leftBehind(fixture);
		const older = createRun(fixture.commonDir, { title: "Older goal", base: fixture.head(), repo: fixture.dir, runId: "20200101-000000-aaaa" });
		older.journal.append({ t: "plan.updated", sha256: "p" });
		rewrite(older, damage);
		expect(() => older.state()).toThrow(error);
		const h = session(fixture);
		await expect(h.tool("herder_run", { action: "record_decision", question: "q?", answer: "a" })).resolves.toMatchObject({ details: { runId: healthy.runId } });
		await h.command("resume");
		expect(h.lastNotice()).toEqual({ level: "info", text: `Resumed Herder run ${healthy.runId}.` });
		await h.command("second goal");
		expect(h.lastNotice()!.text).toContain(`Herder run ${healthy.runId} is unfinished`);
		await h.command(`clean ${healthy.runId}`);
		expect(h.lastNotice()!.text).toContain(`Herder run ${healthy.runId} is unfinished`);
		expect(listRuns(fixture.commonDir)).toEqual([older.runId, healthy.runId]);
	});

	it("is deleted by clean <runId> with its refs and worktrees, after which a run starts", async () => {
		const { fixture, run, h } = await unreadable();
		expect(refs(fixture, run).split("\n")).toEqual([baseRef(run.runId), integrationRef(run.runId)]);
		expect(worktrees(fixture)).toHaveLength(2);
		await h.command("clean --finished");
		expect(h.lastNotice()).toEqual({ level: "info", text: "No finished Herder runs to delete." });
		expect(existsSync(run.paths.dir)).toBe(true);
		await h.command(`clean ${run.runId}`);
		expect(h.lastNotice()).toEqual({ level: "info", text: `Deleted 1 Herder run(s): ${run.runId}.` });
		expect(refs(fixture, run)).toBe("");
		expect(worktrees(fixture)).toEqual([`worktree ${fixture.dir}`]);
		expect(existsSync(run.paths.worktrees)).toBe(false);
		expect(existsSync(run.paths.dir)).toBe(false);
		await h.command("second goal");
		expect(h.lastNotice()).toEqual(STARTED);
		expect(listRuns(fixture.commonDir)).toEqual([h.sent.at(-1).details.runId]);
	});

	it("is refused and cleaned in the session that still holds it", async () => {
		const fixture = repository();
		const h = session(fixture);
		const run = await start(h, fixture);
		rewrite(run, damage);
		await h.command("second goal");
		expect(h.lastNotice()!.level).toBe("error");
		expectReported(h.lastNotice()!.text, run, error);
		expect(listRuns(fixture.commonDir)).toEqual([run.runId]);
		await h.command(`clean ${run.runId}`);
		expect(h.lastNotice()).toEqual({ level: "info", text: `Deleted 1 Herder run(s): ${run.runId}.` });
		expect(refs(fixture, run)).toBe("");
		expect(worktrees(fixture)).toEqual([`worktree ${fixture.dir}`]);
		expect(existsSync(run.paths.dir)).toBe(false);
		await h.command("second goal");
		expect(h.lastNotice()).toEqual(STARTED);
	});
});

describe("a run whose last journal line is torn", () => {
	it.each([
		["cut short", '{"v":1,"t":"plan.upd'],
		["complete but unparsable", '{"v":1,"t":"plan.upd\n'],
	])("is still read as the unfinished run (%s)", async (_name, tail) => {
		const fixture = repository();
		const run = await leftBehind(fixture);
		rewrite(run, (journal) => `${journal}${tail}`);
		const h = session(fixture);
		await h.command("status");
		expect(h.lastNotice()).toMatchObject({ level: "info", text: expect.stringContaining(`Herder run ${run.runId}: first goal`) });
		await h.command("resume");
		expect(h.lastNotice()).toEqual({ level: "info", text: `Resumed Herder run ${run.runId}.` });
		await h.command("second goal");
		expect(h.lastNotice()!.text).toContain(`Herder run ${run.runId} is unfinished`);
		expect(listRuns(fixture.commonDir)).toEqual([run.runId]);
	});
});
