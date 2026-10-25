import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acceptCuration } from "../../src/deliver/curate.ts";
import { cleanupRun, curatedRef, deliver, type DeliverDeps, type DeliveryRequest } from "../../src/deliver/deliver.ts";
import { createIntegrator } from "../../src/integrate/integrate.ts";
import { integrationRef, runPaths, worktreePath } from "../../src/run/paths.ts";
import { openRun } from "../../src/run/store.ts";
import type { RoleDefinition, Vcs } from "../../src/types.ts";
import { hasHerderTrailer } from "../../src/vcs/git.ts";
import { FakeRunner, type FakeRule, fakeRole } from "../support/fake-runner.ts";
import { type GitFixture, withGitFixture } from "../support/git-fixture.ts";
import { check, events, isolateGitConfig, type Run, setupRun, stepCommit } from "../integrate/support.ts";

isolateGitConfig();

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const OLD = "a line long enough\nfor rename detection\nto find it\n";
const roles: ReadonlyMap<string, RoleDefinition> = new Map([["curator", fakeRole("curator")]]);

/** A verified run with two integrated tasks (a.txt, b.txt) whose head is the verified head. */
async function verifiedRun(fixture: GitFixture, checks = [check("ok", "true")], message = (name: string) => `feat: add ${name}`): Promise<Run & { head: string }> {
	const run = setupRun(fixture, checks);
	const integ = createIntegrator({ runId: run.runId, store: run.store, vcs: run.vcs, checks });
	for (const name of ["a", "b"]) {
		const source = stepCommit(run, run.vcs.readRef(integrationRef(run.runId))!, { [`${name}.txt`]: `${name}\n` });
		expect((await integ.integrate(source, { message: message(name), task: `T-${name}` })).status).toBe("integrated");
	}
	const head = run.vcs.readRef(integrationRef(run.runId))!;
	run.store.journal.append({ t: "verify.completed", head, checks: [], verdict: "met", criteria: [], verifierRan: false });
	return { ...run, head };
}

/** Integrates the changes `edit` makes in a Herder worktree on the base, as one task, and verifies the head. */
async function verifiedEdit(fixture: GitFixture, edit: (dir: string) => void): Promise<Run & { head: string }> {
	const run = setupRun(fixture);
	const path = worktreePath(fixture.commonDir, run.runId, "edit");
	run.vcs.addWorktree(path, run.base);
	edit(path);
	const source = run.vcs.snapshot(path, "edit", run.base)!;
	run.vcs.removeWorktree(path);
	const result = await createIntegrator({ runId: run.runId, store: run.store, vcs: run.vcs, checks: [] }).integrate(source, { message: "feat: edit" });
	run.store.journal.append({ t: "verify.completed", head: result.head!, checks: [], verdict: "met", criteria: [], verifierRan: false });
	return { ...run, head: result.head! };
}

class Crash extends Error {}
/** The real Vcs whose delivery write `method` crashes right after writing (or, with `before`, instead of it). */
function crashing(vcs: Vcs, method: "fastForward" | "applyDiff" | "updateRef", before = false): Vcs {
	const real = vcs[method] as (...args: unknown[]) => void;
	return { ...vcs, [method](...args: unknown[]) {
		if (method === "updateRef" && !String(args[0]).startsWith("refs/heads/")) return real(...args);
		if (!before) real(...args);
		throw new Crash(method);
	} };
}
/** The run as a new process would see it after a crash. */
const reopened = (run: Run): Run => ({ ...run, store: openRun(run.fixture.commonDir, run.runId) });

interface Options { runner?: FakeRunner; confirm?: (summary: string) => boolean | Promise<boolean>; vcs?: Vcs; signal?: AbortSignal }
function deps(run: Run, options: Options = {}) {
	const summaries: string[] = [];
	const value: DeliverDeps = {
		runId: run.runId, store: run.store, vcs: options.vcs ?? run.vcs, signal: options.signal, runner: options.runner ?? new FakeRunner(), roles, checks: run.checks, title: "Add a and b",
		async confirm(summary) { summaries.push(summary); return options.confirm ? options.confirm(summary) : true; },
	};
	return { deps: value, summaries };
}
const run_ = (run: Run, request: DeliveryRequest, options?: Options) => {
	const d = deps(run, options);
	return deliver(d.deps, request).then((outcome) => ({ outcome, summaries: d.summaries }));
};

/** HEAD, branch, branch list, index bytes, and status of the user's checkout (invariant 1). */
function checkout(fixture: GitFixture) {
	const status = fixture.status();
	return {
		status, head: fixture.head(), branch: fixture.git("symbolic-ref", "-q", "--short", "HEAD"),
		branches: fixture.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
		index: createHash("sha256").update(readFileSync(join(fixture.commonDir, "index"))).digest("hex"),
	};
}

function expectCleanedUp(run: Run) {
	expect(run.fixture.git("for-each-ref", `refs/herder/${run.runId}`)).toBe("");
	expect(existsSync(runPaths(run.fixture.commonDir, run.runId).worktrees)).toBe(false);
	expect(run.fixture.git("worktree", "list").split("\n")).toHaveLength(1);
	expect(existsSync(run.store.paths.journal)).toBe(true);
}

const noTrailers = (run: Run, commits: string[]) => { for (const commit of commits) expect(hasHerderTrailer(run.vcs.message(commit))).toBe(false); };

/** A curator that rewrites the series as one commit with the head's tree, optionally changing it afterwards. */
function curator(options: { message?: string; extra?: Record<string, string>; merge?: boolean; fail?: boolean } = {}): FakeRule {
	return {
		match: "Curate", role: "curator",
		...(options.fail ? { fail: "fatal" as const } : {}),
		edit(cwd, request) {
			const head = /Head \(reproduce this tree exactly\): ([0-9a-f]+)/.exec(request.prompt)![1]!;
			gitIn(cwd, "restore", `--source=${head}`, "--staged", "--worktree", ".");
			for (const [file, content] of Object.entries(options.extra ?? {})) writeFileSync(join(cwd, file), content);
			gitIn(cwd, "add", "-A");
			gitIn(cwd, "commit", "-q", "-m", options.message ?? "feat: add a and b");
			if (options.merge) {
				const side = gitIn(cwd, "commit-tree", "-p", "HEAD~1", "-m", "side", gitIn(cwd, "rev-parse", "HEAD~1^{tree}"));
				gitIn(cwd, "merge", "-q", "--no-ff", "-m", "merge", side);
			}
		},
	};
}

describe("deliver", () => {
	it("series: fast-forwards one trailer-free commit per task with the verified tree, then journals and cleans up", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		const before = checkout(fixture);
		let during: ReturnType<typeof checkout> | undefined;
		const { outcome, summaries } = await run_(run, { mode: "series" }, { confirm: () => { during = checkout(fixture); return true; } });
		expect(during).toEqual(before); // untouched until confirmation (invariant 1)
		expect(outcome).toMatchObject({ status: "delivered", mode: "series", target: "main", tip: run.head, curated: false });
		expect(summaries[0]).toMatch(/series to main/);
		expect(summaries[0]).toMatch(/feat: add a[\s\S]*feat: add b/);
		expect(fixture.head()).toBe(run.head);
		expect(fixture.git("symbolic-ref", "--short", "HEAD")).toBe("main");
		const delivered = run.vcs.revList(`${run.base}..HEAD`);
		expect(delivered).toHaveLength(2);
		expect(delivered.map((c) => run.vcs.message(c).trim())).toEqual(["feat: add a", "feat: add b"]);
		expect(run.vcs.treeOf("HEAD")).toBe(run.vcs.treeOf(run.head)); // invariant 4
		noTrailers(run, delivered); // invariant 5
		expect(fixture.status()).toBe("");
		expect(events(run.store, "delivery.completed")).toMatchObject([{ mode: "series", target: "main", tip: run.head, commits: delivered, curated: false }]);
		expect(events(run.store, "delivery.completed")[0]?.rebasedOnto).toBeUndefined();
		expect(events(run.store, "run.finished")).toMatchObject([{ status: "delivered" }]);
		expect(run.store.state().status).toBe("delivered");
		expectCleanedUp(run);
	}));

	it("writes nothing when the user declines", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		const before = checkout(fixture);
		const { outcome } = await run_(run, { mode: "series" }, { confirm: () => false });
		expect(outcome.status).toBe("cancelled");
		expect(checkout(fixture)).toEqual(before);
		expect(events(run.store, "delivery.completed")).toEqual([]);
		expect(run.vcs.readRef(integrationRef(run.runId))).toBe(run.head);
		expect(run.store.state().finished).toBeUndefined();
	}));

	it("refuses a dirty checkout, a detached HEAD, and a checkout that changed during confirmation", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		fixture.write("scratch.txt", "x\n");
		let before = checkout(fixture);
		for (const mode of ["series", "squash", "uncommitted"] as const) {
			const { outcome } = await run_(run, { mode });
			expect(outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/uncommitted or untracked/) });
		}
		expect(checkout(fixture)).toEqual(before);
		fixture.git("clean", "-fq");

		fixture.git("checkout", "-q", "--detach");
		const detached = await run_(run, { mode: "series" });
		expect(detached.outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/detached HEAD/) });
		fixture.git("checkout", "-q", "main");

		before = checkout(fixture);
		const switched = await run_(run, { mode: "series" }, { confirm: () => { fixture.git("checkout", "-q", "-b", "other"); return true; } });
		expect(switched.outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/switched from main to other/) });
		expect(fixture.head()).toBe(run.base);
		fixture.git("checkout", "-q", "main");

		const dirtied = await run_(run, { mode: "series" }, { confirm: () => { fixture.write("late.txt", "x\n"); return true; } });
		expect(dirtied.outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/uncommitted/) });
		expect(fixture.head()).toBe(run.base);
		expect(events(run.store, "delivery.completed")).toEqual([]);
	}));

	it("refuses without a met verification at the current head", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture);
		const source = stepCommit(run, run.base, { "a.txt": "a\n" });
		const integ = createIntegrator({ runId: run.runId, store: run.store, vcs: run.vcs, checks: [] });
		const first = await integ.integrate(source, { message: "a" });
		expect((await run_(run, { mode: "series" })).outcome.reason).toMatch(/not been verified/);
		run.store.journal.append({ t: "verify.completed", head: first.head!, checks: [], verdict: "not_met", criteria: [], verifierRan: true });
		expect((await run_(run, { mode: "series" })).outcome.reason).toMatch(/verdict is not_met/);
		run.store.journal.append({ t: "verify.completed", head: first.head!, checks: [], verdict: "met", criteria: [], verifierRan: true });
		await integ.integrate(stepCommit(run, first.head!, { "b.txt": "b\n" }), { message: "b" });
		expect((await run_(run, { mode: "series" })).outcome.reason).toMatch(/verify again/);
		expect(fixture.head()).toBe(run.base);
	}));

	it("replays onto a moved branch, reruns every check, and records the rebase", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture, [check("ok", "true"), check("has-user", "test -f user.txt", false)]);
		const moved = fixture.commit("user work", { "user.txt": "u\n" });
		const { outcome, summaries } = await run_(run, { mode: "series" });
		expect(outcome).toMatchObject({ status: "delivered", rebasedOnto: moved });
		expect(summaries[0]).toMatch(/replayed onto/);
		const delivered = run.vcs.revList(`${moved}..HEAD`);
		expect(delivered).toHaveLength(2);
		expect(run.vcs.parentsOf(delivered[0]!)).toEqual([moved]);
		expect(delivered.map((c) => run.vcs.message(c).trim())).toEqual(["feat: add a", "feat: add b"]);
		noTrailers(run, delivered);
		for (const file of ["a.txt", "b.txt", "user.txt"]) expect(existsSync(join(fixture.dir, file))).toBe(true);
		const tip = fixture.head();
		const deliverChecks = events(run.store, "check.completed").filter((e) => e.purpose === "deliver");
		expect(deliverChecks.map((e) => [e.checkId, e.commit, e.exitCode])).toEqual([["ok", tip, 0], ["has-user", tip, 0]]);
		expect(events(run.store, "delivery.completed")[0]).toMatchObject({ tip, rebasedOnto: moved, commits: delivered, checks: [{ id: "ok", passed: true }, { id: "has-user", passed: true }] });
		expectCleanedUp(run);
	}));

	it("refuses when checks fail at the replayed tip, without touching the checkout", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture, [check("no-user", "test ! -f user.txt")]);
		fixture.commit("user work", { "user.txt": "u\n" });
		const before = checkout(fixture);
		const { outcome, summaries } = await run_(run, { mode: "series" });
		expect(outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/checks failed.*no-user/) });
		expect(summaries).toEqual([]);
		expect(checkout(fixture)).toEqual(before);
		expect(existsSync(worktreePath(fixture.commonDir, run.runId, "deliver"))).toBe(false);
	}));

	it("stops and reports a replay conflict", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		fixture.commit("user work", { "a.txt": "theirs\n" });
		const before = checkout(fixture);
		const { outcome } = await run_(run, { mode: "series" });
		expect(outcome).toMatchObject({ status: "refused", conflicts: ["a.txt"], reason: expect.stringMatching(/mode "branch"/) });
		expect(checkout(fixture)).toEqual(before);
	}));

	it("branch: does not replay, so a conflicting branch checked out does not matter", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture, [check("ok", "true")]);
		fixture.git("checkout", "-q", "-b", "other");
		fixture.commit("user work", { "a.txt": "theirs\n" });
		const before = checkout(fixture);
		const { outcome, summaries } = await run_(run, { mode: "branch" });
		const commits = run.vcs.revList(`${run.base}..${run.head}`);
		expect(outcome).toMatchObject({ status: "delivered", target: `herder/${run.runId}`, tip: run.head, commits });
		expect(outcome.rebasedOnto).toBeUndefined();
		expect(summaries[0]).not.toMatch(/replayed/);
		expect(fixture.git("rev-parse", `refs/heads/herder/${run.runId}`)).toBe(run.head);
		expect(events(run.store, "check.completed").filter((e) => e.purpose === "deliver")).toEqual([]);
		expect(events(run.store, "delivery.completed")[0]).toMatchObject({ mode: "branch", tip: run.head, commits });
		expect({ ...checkout(fixture), branches: before.branches }).toEqual(before);
		expectCleanedUp(run);
	}));

	it("branch: creates herder/<runId> at the tip and leaves the checkout alone", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		fixture.write("dirty.txt", "mine\n"); // the branch mode does not need a clean checkout
		const before = checkout(fixture);
		const { outcome } = await run_(run, { mode: "branch" });
		expect(outcome).toMatchObject({ status: "delivered", target: `herder/${run.runId}`, tip: run.head });
		expect(fixture.git("rev-parse", `refs/heads/herder/${run.runId}`)).toBe(run.head);
		const after = checkout(fixture);
		expect({ ...after, branches: before.branches }).toEqual(before);
		expectCleanedUp(run);
	}));

	it("branch: refuses when the branch already exists", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		fixture.git("branch", `herder/${run.runId}`);
		expect((await run_(run, { mode: "branch" })).outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/already exists/) });
	}));

	it("squash: one commit titled after the goal with the verified tree", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		const { outcome } = await run_(run, { mode: "squash" });
		expect(outcome.status).toBe("delivered");
		expect(run.vcs.revList(`${run.base}..HEAD`)).toEqual([fixture.head()]);
		expect(run.vcs.message("HEAD")).toBe("Add a and b\n");
		expect(run.vcs.treeOf("HEAD")).toBe(run.vcs.treeOf(run.head));
		expect(events(run.store, "delivery.completed")[0]).toMatchObject({ mode: "squash", commits: [fixture.head()], tip: fixture.head() });
		expectCleanedUp(run);
	}));

	it("uncommitted: applies the changes unstaged without moving HEAD", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		const { outcome } = await run_(run, { mode: "uncommitted" });
		expect(outcome).toMatchObject({ status: "delivered", target: fixture.dir });
		expect(fixture.head()).toBe(run.base);
		expect(fixture.git("diff", "--cached", "--name-only")).toBe("");
		expect(fixture.status().split("\n").sort()).toEqual(["?? a.txt", "?? b.txt"]);
		expect(fixture.read("a.txt")).toBe("a\n");
		expectCleanedUp(run);
	}));

	it("refuses to deliver commits with Herder trailers (fail closed)", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture, []);
		// integrate() rejects such messages, so build the marked head directly.
		const marked = run.vcs.commitTree(run.vcs.treeOf(run.head), [run.base], "feat: add a and b\n\nHerder-Step: s-0\n");
		run.vcs.updateRef(integrationRef(run.runId), marked);
		run.store.journal.append({ t: "verify.completed", head: marked, checks: [], verdict: "met", criteria: [], verifierRan: false });
		const before = checkout(fixture);
		for (const mode of ["series", "branch"] as const) {
			const { outcome, summaries } = await run_(run, { mode });
			expect(outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(/Herder trailer/) });
			expect(summaries).toEqual([]);
		}
		expect(checkout(fixture)).toEqual(before);
	}));

	it("uncommitted: applies modifications, renames, binary files, mode changes, and deletions unstaged", () => withGitFixture(async (fixture) => {
		const run = await verifiedEdit(fixture, (dir) => {
			writeFileSync(join(dir, "keep.txt"), "kept, changed\n");
			gitIn(dir, "mv", "old.txt", "new.txt");
			writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 255, 0]));
			chmodSync(join(dir, "run.sh"), 0o755);
			gitIn(dir, "rm", "-q", "gone.txt");
		});
		const { outcome } = await run_(run, { mode: "uncommitted" });
		expect(outcome).toMatchObject({ status: "delivered", commits: [] });
		expect(fixture.head()).toBe(run.base);
		expect(fixture.git("diff", "--cached", "--name-only")).toBe("");
		expect(fixture.status().split("\n").sort()).toEqual([" D gone.txt", " D old.txt", " M keep.txt", " M run.sh", "?? bin.dat", "?? new.txt"]);
		expect(fixture.read("keep.txt")).toBe("kept, changed\n");
		expect(fixture.read("new.txt")).toBe(OLD);
		expect([...readFileSync(join(fixture.dir, "bin.dat"))]).toEqual([0, 1, 2, 255, 0]);
		expect(statSync(join(fixture.dir, "run.sh")).mode & 0o100).toBe(0o100);
		fixture.git("add", "-A");
		expect(fixture.git("write-tree")).toBe(run.vcs.treeOf(run.head));
		expectCleanedUp(run);
	}, { "README.md": "# fixture\n", "keep.txt": "keep\n", "old.txt": OLD, "gone.txt": "bye\n", "run.sh": "#!/bin/sh\necho hi\n" }));

	it("uncommitted: applies the replayed changes on a moved HEAD", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		const moved = fixture.commit("user work", { "user.txt": "u\n" });
		const { outcome } = await run_(run, { mode: "uncommitted" });
		expect(outcome).toMatchObject({ status: "delivered", rebasedOnto: moved });
		expect(fixture.head()).toBe(moved);
		expect(fixture.status().split("\n").sort()).toEqual(["?? a.txt", "?? b.txt"]);
		expect(fixture.read("user.txt")).toBe("u\n");
		expectCleanedUp(run);
	}));

	it("squash: creates no commit when the checkout already has the verified tree", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		const moved = fixture.commit("user did it", { "a.txt": "a\n", "b.txt": "b\n" });
		const { outcome } = await run_(run, { mode: "squash" });
		expect(outcome).toMatchObject({ status: "delivered", tip: moved, commits: [], rebasedOnto: moved });
		expect(fixture.head()).toBe(moved);
		expect(events(run.store, "delivery.completed")).toMatchObject([{ mode: "squash", tip: moved, commits: [] }]);
		expectCleanedUp(run);
	}));

	it("finishes a delivery journaled before a crash without writing again", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		fixture.git("merge", "--ff-only", "-q", run.head);
		const commits = run.vcs.revList(`${run.base}..${run.head}`);
		run.store.journal.append({ t: "delivery.completed", mode: "series", target: "main", tip: run.head, commits, curated: false });
		const before = checkout(fixture);
		const { outcome, summaries } = await run_(reopened(run), { mode: "squash" });
		expect(summaries).toEqual([]);
		expect(outcome).toMatchObject({ status: "delivered", mode: "series", tip: run.head, commits });
		expect(checkout(fixture)).toEqual(before);
		expect(events(run.store, "delivery.completed")).toHaveLength(1);
		expect(events(run.store, "run.finished")).toMatchObject([{ status: "delivered" }]);
		expectCleanedUp(run);
	}));

	it("reports a failed cleanup as a warning after a successful delivery and still finishes the run", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		const vcs: Vcs = { ...run.vcs, deleteRefs() { throw new Error("disk on fire"); } };
		const { outcome } = await run_(run, { mode: "series" }, { vcs });
		expect(outcome).toMatchObject({ status: "delivered", tip: run.head, warning: expect.stringMatching(/disk on fire/) });
		expect(fixture.head()).toBe(run.head);
		expect(events(run.store, "run.finished")).toMatchObject([{ status: "delivered" }]);
		expect(existsSync(runPaths(fixture.commonDir, run.runId).worktrees)).toBe(false); // the rest of the cleanup ran
	}));

	describe("a crash between the write and delivery.completed", () => {
		for (const [mode, method] of [["series", "fastForward"], ["squash", "fastForward"], ["uncommitted", "applyDiff"], ["branch", "updateRef"]] as const) {
			it(`${mode}: the retry records the written delivery without writing again`, () => withGitFixture(async (fixture) => {
				const run = await verifiedRun(fixture);
				await expect(run_(run, { mode }, { vcs: crashing(run.vcs, method) })).rejects.toBeInstanceOf(Crash);
				const [started] = events(run.store, "delivery.started");
				expect(started).toMatchObject({ mode, onto: run.base });
				expect(started!.commits).toHaveLength(mode === "uncommitted" ? 0 : mode === "squash" ? 1 : 2);
				expect(events(run.store, "delivery.completed")).toEqual([]);
				const written = checkout(fixture);
				const { outcome, summaries } = await run_(reopened(run), { mode });
				expect(summaries).toEqual([]);
				const tip = mode === "squash" ? fixture.head() : started!.tip;
				expect(outcome).toMatchObject({ status: "delivered", mode, target: started!.target, tip, commits: started!.commits });
				expect(checkout(fixture)).toEqual(written);
				expect(events(run.store, "delivery.completed")).toMatchObject([{ mode, target: started!.target, tip, commits: started!.commits }]);
				expect(events(run.store, "delivery.completed")[0]!.rebasedOnto).toBeUndefined();
				expect(events(run.store, "run.finished")).toMatchObject([{ status: "delivered" }]);
				expectCleanedUp(run);
			}));
		}

		it("series after a replay: the retry keeps the replay and its checks", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			const moved = fixture.commit("user work", { "user.txt": "u\n" });
			await expect(run_(run, { mode: "series" }, { vcs: crashing(run.vcs, "fastForward") })).rejects.toBeInstanceOf(Crash);
			const tip = fixture.head();
			const { outcome } = await run_(reopened(run), { mode: "series" });
			const commits = run.vcs.revList(`${moved}..${tip}`);
			expect(commits).toHaveLength(2);
			expect(outcome).toMatchObject({ status: "delivered", tip, commits, rebasedOnto: moved, checks: [{ id: "ok", commit: tip, passed: true }] });
			expect(events(run.store, "delivery.completed")).toMatchObject([{ tip, commits, rebasedOnto: moved, checks: [{ id: "ok", passed: true }] }]);
		}));

		it("delivers normally when the write did not happen", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			await expect(run_(run, { mode: "series" }, { vcs: crashing(run.vcs, "fastForward", true) })).rejects.toBeInstanceOf(Crash);
			expect(fixture.head()).toBe(run.base);
			const { outcome, summaries } = await run_(reopened(run), { mode: "series" });
			expect(summaries).toHaveLength(1);
			expect(outcome).toMatchObject({ status: "delivered", tip: run.head });
			expect(fixture.head()).toBe(run.head);
			expect(events(run.store, "delivery.completed")).toHaveLength(1);
		}));

		/** Retries `mode` and expects a refusal that neither asks nor touches the checkout nor journals a delivery. */
		async function expectRefused(run: Run & { head: string }, mode: DeliveryRequest["mode"], reason: RegExp) {
			const before = checkout(run.fixture);
			const { outcome, summaries } = await run_(reopened(run), { mode });
			expect(outcome).toMatchObject({ status: "refused", reason: expect.stringMatching(reason) });
			expect(summaries).toEqual([]);
			expect(checkout(run.fixture)).toEqual(before);
			expect(events(run.store, "delivery.completed")).toEqual([]);
			expect(run.vcs.readRef(integrationRef(run.runId))).toBe(run.head);
		}

		for (const mode of ["branch", "series"] as const) {
			it(`an unwritten series followed by user commits does not block a later ${mode} delivery`, () => withGitFixture(async (fixture) => {
				const run = await verifiedRun(fixture);
				await expect(run_(run, { mode: "series" }, { vcs: crashing(run.vcs, "fastForward", true) })).rejects.toBeInstanceOf(Crash);
				const user = fixture.commit("user work", { "user.txt": "u\n" });
				const { outcome, summaries } = await run_(reopened(run), { mode });
				expect(summaries).toHaveLength(1);
				expect(outcome).toMatchObject({ status: "delivered", mode, ...(mode === "series" ? { rebasedOnto: user } : { tip: run.head }) });
				if (mode === "series") expect(fixture.head()).toBe(outcome.tip);
				else expect(fixture.head()).toBe(user);
				expect(events(run.store, "delivery.completed")).toMatchObject([{ mode }]);
			}));
		}

		it("refuses a series retry when HEAD left the line through the HEAD it wrote onto", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			fixture.commit("user work", { "user.txt": "u\n" });
			await expect(run_(run, { mode: "series" }, { vcs: crashing(run.vcs, "fastForward", true) })).rejects.toBeInstanceOf(Crash);
			fixture.git("reset", "-q", "--hard", run.base);
			await expectRefused(run, "series", /interrupted/);
		}));

		it("squash: a written commit with user commits on top is recorded as delivered", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			await expect(run_(run, { mode: "squash" }, { vcs: crashing(run.vcs, "fastForward") })).rejects.toBeInstanceOf(Crash);
			const [started] = events(run.store, "delivery.started");
			fixture.commit("user work", { "user.txt": "u\n" });
			const { outcome, summaries } = await run_(reopened(run), { mode: "squash" });
			expect(summaries).toEqual([]);
			expect(outcome).toMatchObject({ status: "delivered", tip: started!.tip, commits: [started!.tip] });
			expect(events(run.store, "delivery.completed")).toMatchObject([{ tip: started!.tip, commits: [started!.tip] }]);
		}));

		it("squash: an unwritten commit followed by user commits delivers normally", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			await expect(run_(run, { mode: "squash" }, { vcs: crashing(run.vcs, "fastForward", true) })).rejects.toBeInstanceOf(Crash);
			const user = fixture.commit("user work", { "user.txt": "u\n" });
			const { outcome, summaries } = await run_(reopened(run), { mode: "squash" });
			expect(summaries).toHaveLength(1);
			expect(outcome).toMatchObject({ status: "delivered", rebasedOnto: user, tip: fixture.head() });
			expect(run.vcs.parentsOf(fixture.head())).toEqual([user]);
		}));

		it("squash: refuses when the branch holds a different commit with the delivered tree", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			await expect(run_(run, { mode: "squash" }, { vcs: crashing(run.vcs, "fastForward") })).rejects.toBeInstanceOf(Crash);
			fixture.git("commit", "-q", "--amend", "-m", "reworded");
			await expectRefused(run, "squash", /interrupted/);
		}));

		it("uncommitted: refuses an unwritten delivery when the checkout has other changes", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			await expect(run_(run, { mode: "uncommitted" }, { vcs: crashing(run.vcs, "applyDiff", true) })).rejects.toBeInstanceOf(Crash);
			fixture.write("a.txt", "something else\n");
			await expectRefused(run, "uncommitted", /other changes/);
		}));

		it("uncommitted: an unwritten delivery followed by user commits delivers normally on a clean checkout", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			await expect(run_(run, { mode: "uncommitted" }, { vcs: crashing(run.vcs, "applyDiff", true) })).rejects.toBeInstanceOf(Crash);
			const user = fixture.commit("user work", { "user.txt": "u\n" });
			const { outcome, summaries } = await run_(reopened(run), { mode: "uncommitted" });
			expect(summaries).toHaveLength(1);
			expect(outcome).toMatchObject({ status: "delivered", rebasedOnto: user });
			expect(fixture.read("a.txt")).toBe("a\n");
		}));

		it("uncommitted: refuses a moved HEAD with a dirty checkout", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			await expect(run_(run, { mode: "uncommitted" }, { vcs: crashing(run.vcs, "applyDiff", true) })).rejects.toBeInstanceOf(Crash);
			fixture.commit("user work", { "user.txt": "u\n" });
			fixture.write("user.txt", "v\n");
			await expectRefused(run, "uncommitted", /interrupted/);
		}));

		it("branch: refuses when the branch points elsewhere", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			await expect(run_(run, { mode: "branch" }, { vcs: crashing(run.vcs, "updateRef", true) })).rejects.toBeInstanceOf(Crash);
			fixture.git("branch", `herder/${run.runId}`, run.base);
			await expectRefused(run, "branch", /interrupted/);
		}));
	});

	describe("curation", () => {
		it("delivers an accepted curated series with the same tree", () => withGitFixture(async (fixture) => {
			const run = await verifiedRun(fixture);
			const runner = new FakeRunner([curator()]);
			let pinned: string | null = null;
			const { outcome, summaries } = await run_(run, { mode: "series", curate: true }, { runner, confirm: () => { pinned = run.vcs.readRef(curatedRef(run.runId)); return true; } });
			expect(pinned).toBe(fixture.head());
			expect(runner.calls).toHaveLength(1);
			expect(runner.calls[0]!.prompt).toMatch(/feat: add a[\s\S]*feat: add b/);
			expect(summaries[0]).toMatch(/curated series/);
			expect(outcome).toMatchObject({ status: "delivered", curated: true });
			const delivered = run.vcs.revList(`${run.base}..HEAD`);
			expect(delivered.map((c) => run.vcs.message(c).trim())).toEqual(["feat: add a and b"]);
			expect(run.vcs.treeOf("HEAD")).toBe(run.vcs.treeOf(run.head));
			expect(events(run.store, "delivery.completed")[0]).toMatchObject({ curated: true, commits: delivered });
			expectCleanedUp(run);
		}));

		for (const [name, rule, reason] of [
			["changes the tree", curator({ extra: { "extra.txt": "x\n" } }), /tree differs/],
			["leaves a Herder trailer", curator({ message: "feat: add a and b\n\nHerder-Step: s-0" }), /Herder trailer/],
			["creates a merge", curator({ merge: true }), /merge/],
			["fails", curator({ fail: true }), /curation failed/],
		] as const) {
			it(`keeps the original series when the curator ${name}`, () => withGitFixture(async (fixture) => {
				const run = await verifiedRun(fixture);
				const { outcome, summaries } = await run_(run, { mode: "series", curate: true }, { runner: new FakeRunner([rule]) });
				expect(outcome).toMatchObject({ status: "delivered", curated: false, curation: expect.stringMatching(reason) });
				expect(summaries[0]).toMatch(/Keeping the original series/);
				expect(fixture.head()).toBe(run.head);
				expect(run.vcs.revList(`${run.base}..HEAD`)).toHaveLength(2);
				noTrailers(run, run.vcs.revList(`${run.base}..HEAD`));
				expectCleanedUp(run);
			}));
		}
	});

	it("re-throws an abort during curation and removes the curator's worktree", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		const controller = new AbortController();
		const runner = new FakeRunner([{ match: "Curate", role: "curator", hang: true }]);
		const pending = run_(run, { mode: "series", curate: true }, { runner, signal: controller.signal });
		while (!runner.calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await expect(pending).rejects.toBeDefined();
		expect(existsSync(worktreePath(fixture.commonDir, run.runId, "curate"))).toBe(false);
		expect(run.vcs.readRef(curatedRef(run.runId))).toBeNull();
		expect(fixture.head()).toBe(run.base);
		expect(events(run.store, "delivery.started")).toEqual([]);
	}));

	it("acceptCuration checks tree, linearity, and trailers", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		const tree = run.vcs.treeOf(run.head);
		const one = run.vcs.commitTree(tree, [run.base], "feat: all");
		expect(acceptCuration(run.vcs, run.base, run.head, one)).toEqual({ ok: true });
		expect(acceptCuration(run.vcs, run.base, run.head, run.base).ok).toBe(false);
		const marked = run.vcs.commitTree(tree, [run.base], "feat: all\n\nHerder-Fingerprint: x");
		expect(acceptCuration(run.vcs, run.base, run.head, marked).reason).toMatch(/trailer/);
		const orphan = run.vcs.commitTree(tree, [], "orphan");
		expect(acceptCuration(run.vcs, run.base, run.head, orphan).reason).toMatch(/descend/);
		const changed = run.vcs.commitTree(run.vcs.treeOf(run.base), [run.base], "nothing");
		expect(acceptCuration(run.vcs, run.base, run.head, changed).reason).toMatch(/tree differs/);
	}));

	it("cleanupRun removes the run's refs and worktrees but keeps the run directory", () => withGitFixture(async (fixture) => {
		const run = await verifiedRun(fixture);
		run.vcs.updateRef(`refs/herder/${run.runId}/steps/s-0`, run.head);
		run.vcs.addWorktree(worktreePath(fixture.commonDir, run.runId, "s-0"), run.head);
		const unrelated = "refs/herder/20260101-000000-ffff/base";
		run.vcs.updateRef(unrelated, run.base);
		cleanupRun(run.vcs, fixture.commonDir, run.runId);
		expectCleanedUp(run);
		expect(run.vcs.readRef(unrelated)).toBe(run.base);
		expect(fixture.status()).toBe("");
	}));
});

