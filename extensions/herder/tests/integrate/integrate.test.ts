import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createIntegrator } from "../../src/integrate/integrate.ts";
import { integrationRef, runPaths } from "../../src/run/paths.ts";
import { openRun } from "../../src/run/store.ts";
import type { FaultPoint, Faults, StepResult } from "../../src/types.ts";
import { hasHerderTrailer } from "../../src/vcs/git.ts";
import { withGitFixture } from "../support/git-fixture.ts";
import { check, events, isolateGitConfig, type Run, setupRun, show, stepCommit } from "./support.ts";

isolateGitConfig();

const step = (commit: string, key = "s-0"): StepResult => ({ status: "ok", key, commit, reused: false });
const integrator = (run: Run, faults?: Faults) => createIntegrator({ runId: run.runId, store: run.store, vcs: run.vcs, checks: run.checks, faults });
const head = (run: Run) => run.vcs.readRef(integrationRef(run.runId))!;
const worktreesGone = (run: Run) => !existsSync(runPaths(run.fixture.commonDir, run.runId).worktrees) || run.fixture.git("worktree", "list").split("\n").length === 1;

class Crash extends Error {}
const crashAt = (point: FaultPoint): Faults => ({ hit(at) { if (at === point) throw new Crash(point); } });

describe("integrate", () => {
	it("advances the head with one trailer-free commit on the old head and journals it", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [check("has-a", "test -f a.txt")]);
		const before = fixture.status();
		const source = stepCommit(run, run.base, { "a.txt": "a\n" });
		const result = await integrator(run).integrate(step(source), { message: "feat: add a", task: "T1" });
		expect(result.status).toBe("integrated");
		expect(result.checks?.map((c) => [c.id, c.passed])).toEqual([["has-a", true]]);
		const commit = head(run);
		expect(result.head).toBe(commit);
		expect(run.vcs.parentsOf(commit)).toEqual([run.base]);
		expect(run.vcs.message(commit)).toBe("feat: add a\n");
		expect(hasHerderTrailer(run.vcs.message(commit))).toBe(false);
		expect(show(run, commit, "a.txt")).toBe("a");
		const [completed] = events(run.store, "integrate.completed");
		expect(completed).toMatchObject({ from: run.base, source, head: commit, tree: run.vcs.treeOf(commit), message: "feat: add a", task: "T1" });
		expect(events(run.store, "check.completed")).toMatchObject([{ checkId: "has-a", commit, purpose: "integrate", key: completed!.key }]);
		expect(run.store.state().integrationHead).toBe(commit);
		expect(worktreesGone(run)).toBe(true);
		expect(fixture.status()).toBe(before);
	}));

	it("returns a conflict as a value and leaves the head unchanged", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture);
		const integ = integrator(run);
		const first = stepCommit(run, run.base, { "README.md": "one\n" });
		const second = stepCommit(run, run.base, { "README.md": "two\n" });
		expect((await integ.integrate(step(first), { message: "first" })).status).toBe("integrated");
		const at = head(run);
		const result = await integ.integrate(step(second), { message: "second" });
		expect(result).toEqual({ status: "conflict", conflicts: ["README.md"] });
		expect(head(run)).toBe(at);
		expect(events(run.store, "integrate.failed")).toMatchObject([{ reason: "conflict", conflicts: ["README.md"], from: at, source: second }]);
	}));

	it("returns failing checks as a value and never advances the ref (invariant 3)", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [check("no-bad", "test ! -f bad.txt"), check("manual", "false", false)]);
		const source = stepCommit(run, run.base, { "bad.txt": "x\n" });
		const result = await integrator(run).integrate(step(source), { message: "bad" });
		expect(result.status).toBe("checks_failed");
		expect(result.checks?.map((c) => [c.id, c.passed])).toEqual([["no-bad", false]]);
		expect(head(run)).toBe(run.base);
		expect(events(run.store, "integrate.failed")).toMatchObject([{ reason: "checks_failed" }]);
		expect(events(run.store, "integrate.completed")).toEqual([]);
		expect(worktreesGone(run)).toBe(true);
	}));

	it("runs only the named checks and rejects unknown ids and invalid options", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [check("fails", "false"), check("manual", "true", false)]);
		const source = stepCommit(run, run.base, { "a.txt": "a\n" });
		const integ = integrator(run);
		await expect(integ.integrate(step(source), { message: "x", checks: ["nope"] })).rejects.toThrow(/unknown check "nope"/);
		await expect(integ.integrate(step(source), { message: "" })).rejects.toThrow(/message/);
		await expect(integ.integrate(step(source), { message: "x", extra: 1 } as never)).rejects.toThrow(/unknown option/);
		await expect(integ.integrate(step(source), { message: "feat: x\n\nHerder-Step: s-0" })).rejects.toThrow(/trailer/);
		await expect(integ.integrate({ status: "failed", key: "s-0", reused: false }, { message: "x" })).rejects.toThrow(/failed/);
		const result = await integ.integrate(step(source), { message: "x", checks: ["manual"] });
		expect(result.checks?.map((c) => c.id)).toEqual(["manual"]);
		expect(result.status).toBe("integrated");
	}));

	it("treats a no_changes step as integrated without journaling", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture);
		const result = await integrator(run).integrate({ status: "no_changes", key: "s-0", reused: false }, { message: "x" });
		expect(result).toEqual({ status: "integrated", head: run.base });
		expect(events(run.store, "integrate.completed")).toEqual([]);
	}));

	it("accepts a commit-ish source", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture);
		const source = stepCommit(run, run.base, { "a.txt": "a\n" });
		run.vcs.updateRef(`refs/herder/${run.runId}/steps/s-0`, source);
		const result = await integrator(run).integrate(`refs/herder/${run.runId}/steps/s-0`, { message: "x" });
		expect(events(run.store, "integrate.completed")[0]?.source).toBe(source);
		expect(result.head).toBe(head(run));
	}));

	it("replays a journaled integration as a no-op, also from a fresh integrator and a later head", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [check("ok", "true")]);
		const a = stepCommit(run, run.base, { "a.txt": "a\n" });
		const b = stepCommit(run, run.base, { "b.txt": "b\n" });
		const first = await integrator(run).integrate(step(a), { message: "a" });
		const second = await integrator(run).integrate(step(b), { message: "b" });
		const tip = head(run);
		const store = openRun(fixture.commonDir, run.runId);
		const fresh = createIntegrator({ runId: run.runId, store, vcs: run.vcs, checks: run.checks });
		// A replayed launch passes its logical head: it gets its own records back.
		expect(await fresh.integrate(step(a), { message: "a" }, { from: run.base })).toEqual(first);
		expect(await fresh.integrate(step(b), { message: "b" }, { from: first.head })).toEqual(second);
		expect(head(run)).toBe(tip);
		expect(events(run.store, "integrate.completed")).toHaveLength(2);
		expect(events(run.store, "check.completed")).toHaveLength(2);
		expect(run.vcs.revList(`${run.base}..${tip}`)).toHaveLength(2);
	}));

	it("journals an already-integrated source (same tree) without a new commit", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [check("ok", "true")]);
		const a = stepCommit(run, run.base, { "a.txt": "a\n" });
		const integ = integrator(run);
		await integ.integrate(step(a), { message: "a" });
		const at = head(run);
		const again = await integ.integrate(step(a), { message: "a again" });
		expect(again).toEqual({ status: "integrated", head: at, checks: [] });
		expect(head(run)).toBe(at);
		expect(events(run.store, "integrate.completed").at(-1)).toMatchObject({ from: at, head: at, message: "a again" });
	}));

	it("serializes concurrent integrations across integrator instances", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture, [check("slow", "sleep 0.2")]);
		const sources = ["a", "b", "c"].map((name) => stepCommit(run, run.base, { [`${name}.txt`]: `${name}\n` }));
		const results = await Promise.all(sources.map((source, i) => integrator(run).integrate(step(source, `s${i}-0`), { message: `m${i}` })));
		expect(results.map((r) => r.status)).toEqual(["integrated", "integrated", "integrated"]);
		const line = run.vcs.revList(`${run.base}..${head(run)}`);
		expect(line).toHaveLength(3);
		for (const commit of line) expect(run.vcs.parentsOf(commit)).toHaveLength(1);
		for (const name of ["a", "b", "c"]) expect(show(run, head(run), `${name}.txt`)).toBe(name);
	}));

	it("fails on a compare-and-swap conflict instead of overwriting a moved ref", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture);
		const a = stepCommit(run, run.base, { "a.txt": "a\n" });
		const other = stepCommit(run, run.base, { "o.txt": "o\n" });
		const sneaky: Faults = { hit(point) { if (point === "before-ref-advance") run.vcs.updateRef(integrationRef(run.runId), other); } };
		await expect(integrator(run, sneaky).integrate(step(a), { message: "a" })).rejects.toThrow(/expected/);
		expect(head(run)).toBe(other);
		expect(events(run.store, "integrate.completed")).toEqual([]);
	}));

	it("does not adopt an advanced head whose message differs", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture);
		const a = stepCommit(run, run.base, { "a.txt": "a\n" });
		await expect(integrator(run, crashAt("after-ref-advance")).integrate(step(a), { message: "a" })).rejects.toBeInstanceOf(Crash);
		const crashed = head(run);
		const result = await integrator(run).integrate(step(a), { message: "a, reworded" }, { from: run.base });
		// Not adopted: the crashed commit stays as the parent, and the source is already integrated on top of it.
		expect(result).toEqual({ status: "integrated", head: crashed, checks: [] });
		expect(events(run.store, "integrate.completed")).toMatchObject([{ from: crashed, head: crashed, message: "a, reworded" }]);
	}));

	it("releases the mutex after a rejected integration", () => withGitFixture(async (fixture) => {
		const run = setupRun(fixture);
		const a = stepCommit(run, run.base, { "a.txt": "a\n" });
		const b = stepCommit(run, run.base, { "b.txt": "b\n" });
		await expect(integrator(run, crashAt("after-merge-commit")).integrate(step(a), { message: "a" })).rejects.toBeInstanceOf(Crash);
		const later = await integrator(run).integrate(step(b, "s-1"), { message: "b" });
		expect(later.status).toBe("integrated");
		expect(head(run)).toBe(later.head);
	}));

	describe("every fault point leaves a resumable state", () => {
		for (const point of ["after-merge-commit", "before-ref-advance", "after-ref-advance"] as const) {
			it(point, () => withGitFixture(async (fixture) => {
				const run = setupRun(fixture, [check("ok", "true")]);
				const a = stepCommit(run, run.base, { "a.txt": "a\n" });
				const b = stepCommit(run, run.base, { "b.txt": "b\n" });
				const first = await integrator(run).integrate(step(a), { message: "a" });
				await expect(integrator(run, crashAt(point)).integrate(step(b), { message: "b" }, { from: first.head })).rejects.toBeInstanceOf(Crash);
				expect(worktreesGone(run)).toBe(true);
				const crashed = head(run);
				const checksBefore = events(run.store, "check.completed").length;
				const store = openRun(fixture.commonDir, run.runId);
				const fresh = createIntegrator({ runId: run.runId, store, vcs: run.vcs, checks: run.checks });
				expect(await fresh.integrate(step(a), { message: "a" }, { from: run.base })).toEqual(first);
				const resumed = await fresh.integrate(step(b), { message: "b" }, { from: first.head });
				expect(resumed.status).toBe("integrated");
				expect(resumed.head).toBe(head(run));
				const line = run.vcs.revList(`${run.base}..${head(run)}`);
				expect(line).toHaveLength(2);
				expect(run.vcs.parentsOf(line[1]!)).toEqual([first.head]);
				expect(show(run, head(run), "b.txt")).toBe("b");
				expect(events(store, "integrate.completed")).toHaveLength(2);
				const completed = events(store, "integrate.completed")[1]!;
				expect(completed).toMatchObject({ from: first.head, head: resumed.head, message: "b" });
				if (point === "after-ref-advance") {
					// Adopted: the crashed commit, no rerun of its checks (the no-op path would record head === from).
					expect(resumed).toEqual({ status: "integrated", head: crashed, checks: [] });
					expect(events(store, "check.completed")).toHaveLength(checksBefore);
				} else expect(resumed.checks?.map((c) => c.id)).toEqual(["ok"]);
				// Replaying once more is a no-op.
				expect(await fresh.integrate(step(b), { message: "b" }, { from: first.head })).toEqual(resumed);
				expect(events(store, "integrate.completed")).toHaveLength(2);
			}));
		}
	});

	describe("cancellation", () => {
		const nothingJournaled = (run: Run) => expect([...events(run.store, "integrate.completed"), ...events(run.store, "integrate.failed")]).toEqual([]);

		it("stops the checks and keeps the head when the call's signal aborts", () => withGitFixture(async (fixture) => {
			const run = setupRun(fixture, [check("slow", "sleep 20")]);
			const controller = new AbortController();
			const started = Date.now();
			const pending = integrator(run).integrate(step(stepCommit(run, run.base, { "a.txt": "a\n" })), { message: "a" }, { signal: controller.signal });
			setTimeout(() => controller.abort("launch settled"), 200);
			await expect(pending).rejects.toBe("launch settled");
			expect(Date.now() - started).toBeLessThan(10_000);
			expect(head(run)).toBe(run.base);
			nothingJournaled(run);
			expect(worktreesGone(run)).toBe(true);
		}));

		it("does nothing for a call aborted while it waits behind another integration", () => withGitFixture(async (fixture) => {
			const run = setupRun(fixture, [check("brief", "sleep 1")]);
			const controller = new AbortController();
			const first = integrator(run).integrate(step(stepCommit(run, run.base, { "a.txt": "a\n" })), { message: "a" });
			const second = integrator(run).integrate(step(stepCommit(run, run.base, { "b.txt": "b\n" }), "s-1"), { message: "b" }, { signal: controller.signal });
			controller.abort("stopped");
			await expect(second).rejects.toBe("stopped");
			const done = await first;
			expect(done.status).toBe("integrated");
			expect(head(run)).toBe(done.head);
			expect(events(run.store, "integrate.completed")).toHaveLength(1);
		}));

		it("still follows the integrator's own signal when the call has one", () => withGitFixture(async (fixture) => {
			const run = setupRun(fixture, [check("slow", "sleep 20")]);
			const own = new AbortController();
			const pending = createIntegrator({ runId: run.runId, store: run.store, vcs: run.vcs, checks: run.checks, signal: own.signal })
				.integrate(step(stepCommit(run, run.base, { "a.txt": "a\n" })), { message: "a" }, { signal: new AbortController().signal });
			setTimeout(() => own.abort("session shutdown"), 200);
			await expect(pending).rejects.toBe("session shutdown");
			expect(head(run)).toBe(run.base);
			nothingJournaled(run);
		}));
	});
});
