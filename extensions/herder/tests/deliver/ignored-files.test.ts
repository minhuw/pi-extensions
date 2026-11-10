// `git merge` replaces a file the checkout ignores unless told not to; a delivery must leave such a file to the user.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliver, type DeliverDeps, type DeliveryOutcome } from "../../src/deliver/deliver.ts";
import { createIntegrator } from "../../src/integrate/integrate.ts";
import { integrationRef } from "../../src/run/paths.ts";
import { openRun } from "../../src/run/store.ts";
import type { DeliveryMode, Vcs } from "../../src/types.ts";
import { FakeRunner } from "../support/fake-runner.ts";
import { type GitFixture, withGitFixture } from "../support/git-fixture.ts";
import { events, isolateGitConfig, type Run, setupRun, stepCommit } from "../integrate/support.ts";

isolateGitConfig();

const MINE = "mine\n";
const THEIRS = "theirs\n";
// The checkout ignores local.cfg and cache/; the run drops both rules and tracks files there.
const FILES = { "README.md": "# fixture\n", ".gitignore": "local.cfg\ncache/\n" };

/** A verified run whose head tracks `files`, which the checkout's `.gitignore` still ignores. */
async function verifiedRun(fixture: GitFixture, files: Record<string, string> = { "local.cfg": THEIRS }): Promise<Run & { head: string }> {
	const run = setupRun(fixture);
	const source = stepCommit(run, run.base, { ".gitignore": "", ...files });
	const result = await createIntegrator({ runId: run.runId, store: run.store, vcs: run.vcs, checks: [] }).integrate(source, { message: "feat: track the local files" });
	run.store.journal.append({ t: "verify.completed", head: result.head!, checks: [], verdict: "met", criteria: [], verifierRan: false });
	return { ...run, head: result.head! };
}

/** The run as a new process would see it. */
const reopened = (run: Run): Run => ({ ...run, store: openRun(run.fixture.commonDir, run.runId) });

interface Options { vcs?: Vcs; confirm?: () => boolean }
async function attempt(run: Run, mode: DeliveryMode, options: Options = {}) {
	const summaries: string[] = [];
	const deps: DeliverDeps = {
		runId: run.runId, store: run.store, vcs: options.vcs ?? run.vcs, runner: new FakeRunner(), roles: new Map(), checks: run.checks, title: "Track the local files",
		async confirm(summary) { summaries.push(summary); return options.confirm ? options.confirm() : true; },
	};
	return { outcome: await deliver(deps, { mode }), summaries };
}

/** HEAD, branch, index bytes, and status of the user's checkout, and its `local.cfg`. */
function checkout(fixture: GitFixture) {
	const status = fixture.status();
	return {
		status, head: fixture.head(), branch: fixture.git("symbolic-ref", "-q", "--short", "HEAD"),
		index: createHash("sha256").update(readFileSync(join(fixture.commonDir, "index"))).digest("hex"),
		local: existsSync(join(fixture.dir, "local.cfg")) ? fixture.read("local.cfg") : null,
	};
}

const remove = (fixture: GitFixture, path = "local.cfg") => rmSync(join(fixture.dir, path), { recursive: true });

function expectDelivered(run: Run & { head: string }, outcome: DeliveryOutcome) {
	expect(outcome).toMatchObject({ status: "delivered", target: "main", tip: run.fixture.head() });
	expect(run.vcs.treeOf("HEAD")).toBe(run.vcs.treeOf(run.head));
	expect(run.fixture.read("local.cfg")).toBe(THEIRS);
	expect(run.fixture.status()).toBe("");
	expect(events(run.store, "delivery.completed")).toHaveLength(1);
	expect(events(run.store, "run.finished")).toMatchObject([{ status: "delivered" }]);
	expect(reopened(run).store.state().status).toBe("delivered");
}

describe("delivery over a file the checkout ignores", () => {
	for (const mode of ["series", "squash"] as const) {
		it(`${mode}: refuses naming the file, leaves it and HEAD alone, and delivers once it is out of the way`, () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			fixture.write("local.cfg", MINE);
			const before = checkout(fixture);
			expect(before).toMatchObject({ status: "!! local.cfg", head: run.base, local: MINE });

			// In the way from the start: refused before the user is asked.
			const first = await attempt(run, mode);
			expect(first.outcome).toMatchObject({ status: "refused", mode, reason: expect.stringMatching(/local\.cfg/) });
			expect(first.summaries).toEqual([]);
			expect(checkout(fixture)).toEqual(before);

			// Put in the way while the confirmation is open: refused after it.
			remove(fixture);
			const second = await attempt(run, mode, { confirm: () => { fixture.write("local.cfg", MINE); return true; } });
			expect(second.outcome).toMatchObject({ status: "refused", mode, reason: expect.stringMatching(/local\.cfg/) });
			expect(second.summaries).toHaveLength(1);
			expect(checkout(fixture)).toEqual(before);

			// Nothing was started, and the run is still deliverable.
			expect(events(run.store, "delivery.started")).toEqual([]);
			expect(run.store.state().finished).toBeUndefined();
			expect(run.vcs.readRef(integrationRef(run.runId))).toBe(run.head);
			remove(fixture);
			expectDelivered(run, (await attempt(run, mode)).outcome);
		}, FILES));

		it(`${mode}: the merge keeps a file that appears after the last look at the checkout, and the next delivery starts over`, () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			const before = checkout(fixture);
			const late: Vcs = { ...run.vcs, fastForward(commit) { fixture.write("local.cfg", MINE); run.vcs.fastForward(commit); } };
			const { outcome } = await attempt(run, mode, { vcs: late });
			expect(outcome).toMatchObject({ status: "refused", mode, reason: expect.stringMatching(/local\.cfg/) });
			expect(checkout(fixture)).toEqual({ ...before, status: "!! local.cfg", local: MINE });
			expect(events(run.store, "delivery.started")).toHaveLength(1);
			expect(events(run.store, "delivery.completed")).toEqual([]);
			expect(run.store.state().finished).toBeUndefined();

			// The interrupted delivery wrote nothing, so the next one starts over: refused while the file is there, then delivered.
			const again = await attempt(reopened(run), mode);
			expect(again.outcome).toMatchObject({ status: "refused", mode, reason: expect.stringMatching(/local\.cfg/) });
			expect(again.summaries).toEqual([]);
			expect(checkout(fixture)).toEqual({ ...before, status: "!! local.cfg", local: MINE });
			remove(fixture);
			const retry = await attempt(reopened(run), mode);
			expect(retry.summaries).toHaveLength(1);
			expectDelivered(run, retry.outcome);
		}, FILES));
	}

	it("series: refuses a file where the run tracks a directory", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture, { "local.cfg/inner.txt": THEIRS });
		fixture.write("local.cfg", MINE);
		const before = checkout(fixture);
		const { outcome, summaries } = await attempt(run, "series");
		expect(outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/local\.cfg/) });
		expect(outcome.reason).not.toMatch(/inner\.txt/);
		expect(summaries).toEqual([]);
		expect(checkout(fixture)).toEqual(before);
	}, FILES));

	it("series: names the first ten of many files inside an ignored directory and overwrites none", () => withGitFixture(async (fixture) => {
		const names = Array.from({ length: 12 }, (_, index) => `cache/${String(index).padStart(2, "0")}.txt`);
		const run = await verifiedRun(fixture, Object.fromEntries(names.map((name) => [name, THEIRS])));
		for (const name of names) fixture.write(name, MINE);
		fixture.write("cache/other.txt", MINE); // ignored as well, but no path of the run
		const { outcome, summaries } = await attempt(run, "series");
		expect(outcome.status).toBe("refused");
		for (const name of names.slice(0, 10)) expect(outcome.reason).toContain(name);
		for (const name of [...names.slice(10), "cache/other.txt"]) expect(outcome.reason).not.toContain(name);
		expect(outcome.reason).toMatch(/and 2 more/);
		expect(summaries).toEqual([]);
		for (const name of names) expect(fixture.read(name)).toBe(MINE);
		expect(fixture.head()).toBe(run.base);

		remove(fixture, "cache");
		expect((await attempt(run, "series")).outcome).toMatchObject({ status: "delivered", tip: run.head });
		expect(fixture.read(names[11]!)).toBe(THEIRS);
	}, FILES));

	// `git apply` creates no file over an existing one and applies nothing when one path fails, so this mode needs no guard.
	it("uncommitted: the apply fails naming the file and changes nothing, and a later delivery succeeds", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		fixture.write("local.cfg", MINE);
		const before = checkout(fixture);
		await expect(attempt(run, "uncommitted")).rejects.toThrow(/local\.cfg: already exists/);
		expect(checkout(fixture)).toEqual(before);
		expect(events(run.store, "delivery.completed")).toEqual([]);
		expect(run.store.state().finished).toBeUndefined();

		remove(fixture);
		const { outcome } = await attempt(reopened(run), "uncommitted");
		expect(outcome).toMatchObject({ status: "delivered", mode: "uncommitted", target: fixture.dir });
		expect(fixture.head()).toBe(run.base);
		expect(fixture.read("local.cfg")).toBe(THEIRS);
		expect(fixture.status().split("\n").sort()).toEqual([" M .gitignore", "?? local.cfg"]);
		expect(reopened(run).store.state().status).toBe("delivered");
	}, FILES));
});
