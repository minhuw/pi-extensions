import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Criterion, hashGoal, parseGoal } from "../../src/artifacts/goal.ts";
import { checkSchema } from "../../src/agents/structured.ts";
import { integrationRef, worktreePath } from "../../src/run/paths.ts";
import { createRun, type RunStore } from "../../src/run/store.ts";
import type { CheckResult, Limits, RoleDefinition, Vcs, VerifyCompletedEvent } from "../../src/types.ts";
import { openVcs } from "../../src/vcs/git.ts";
import { computeVerdict, VERIFIER_SCHEMA, verifierNeeded, verifyRun, type VerifyDeps } from "../../src/verify/verify.ts";
import { FakeRunner, fakeRole, type FakeRule } from "../support/fake-runner.ts";
import { type GitFixture, withGitFixture } from "../support/git-fixture.ts";

const RUN_ID = "20260101-000000-abcd";
const LIMITS: Limits = { concurrentAgents: 2, concurrentWriters: 1, agentsPerLaunch: 10, agentsPerRun: 10, itemsPerCall: 10, timeoutMs: 5_000, stallMs: 5_000, retryBackoffMs: [], stallRestarts: 0 };
const ROLES: ReadonlyMap<string, RoleDefinition> = new Map([["verifier", fakeRole("verifier")]]);

const goalText = (criteria: string[], checks: string[]) => `# Goal: Add the feature

## Intent
Users want the feature.

## Acceptance criteria
${criteria.join("\n")}

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
${checks.join("\n")}
`;
const CHECK_ONLY = goalText(
	["- AC-1: WHEN the feature file exists THE SYSTEM SHALL contain ok. verify: check:has-ok"],
	["| has-ok | grep -q ok feature.txt | 30s | yes |"],
);
const WITH_JUDGE = goalText(
	["- AC-1: WHEN the feature file exists THE SYSTEM SHALL contain ok. verify: check:has-ok", "- AC-2: THE SYSTEM SHALL keep the README friendly to new users. verify: judge — rubric: \"README greets the reader\""],
	["| has-ok | grep -q ok feature.txt | 30s | yes |"],
);

interface Setup { fx: GitFixture; vcs: Vcs; run: RunStore; base: string; integrate(files: Record<string, string>, task?: string): string; deps(runner: FakeRunner, extra?: Partial<VerifyDeps>): VerifyDeps }

function setup(fx: GitFixture, goal: string, plan = ""): Setup {
	const vcs = openVcs(fx.dir);
	const base = fx.head();
	const run = createRun(fx.commonDir, { title: "Add the feature", base, repo: fx.dir, goal, runId: RUN_ID });
	writeFileSync(run.paths.plan, plan);
	run.journal.append({ t: "goal.approved", sha256: hashGoal(goal), checks: parseGoal(goal).checks, approvedBy: "user" });
	let head = base, n = 0;
	return {
		fx, vcs, run, base,
		// A task's squashed commit on the integration line, built in a Herder worktree so the checkout stays untouched.
		integrate(files, task) {
			const path = worktreePath(fx.commonDir, RUN_ID, `task-${++n}`);
			vcs.addWorktree(path, head);
			for (const [file, content] of Object.entries(files)) writeFileSync(`${path}/${file}`, content);
			const commit = vcs.snapshot(path, `task ${n}`)!;
			vcs.removeWorktree(path);
			vcs.updateRef(integrationRef(RUN_ID), commit, n === 1 ? null : head);
			run.journal.append({ t: "integrate.completed", key: `k${n}`, from: head, source: commit, head: commit, tree: vcs.treeOf(commit), message: `task ${n}`, ...(task ? { task } : {}), checks: [] });
			return head = commit;
		},
		deps: (runner, extra) => ({ runId: RUN_ID, store: run, vcs, runner, roles: ROLES, checks: parseGoal(goal).checks, limits: LIMITS, ...extra }),
	};
}

const verifierSays = (data: FakeRule["data"], extra: Partial<FakeRule> = {}) => new FakeRunner([{ match: "Verify the change", role: "verifier", data, ...extra }]);
const report = (criteria: [string, string][], more: { gaps?: unknown[]; blocked?: unknown[] } = {}) => ({
	criteria: criteria.map(([id, status]) => ({ id, status, evidence: `${id} looked at` })), gaps: more.gaps ?? [], blocked: more.blocked ?? [],
});
const lastVerify = (run: RunStore) => run.journal.read().filter((event): event is VerifyCompletedEvent => event.t === "verify.completed").at(-1);

/** Invariant 2: the checkout is untouched and no Herder worktree is left registered. */
function expectCheckoutUntouched(s: Setup) {
	expect(s.fx.status()).toBe("");
	expect(s.fx.head()).toBe(s.base);
	expect(s.fx.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
	expect(existsSync(worktreePath(s.fx.commonDir, RUN_ID, "verify"))).toBe(false);
}

describe("verifyRun", () => {
	it("skips the verifier for a single small task with only check-based criteria", () => withGitFixture(async (fx) => {
		const s = setup(fx, CHECK_ONLY, "# Plan\n\n- [ ] T1 (AC-1) Add the feature\n");
		const head = s.integrate({ "feature.txt": "ok\n" }, "T1");
		const runner = new FakeRunner();
		let progressed = 0;
		const outcome = await verifyRun(s.deps(runner, { onProgress: () => progressed++ }));
		expect(runner.calls).toHaveLength(0);
		expect(outcome).toMatchObject({ verdict: "met", head, verifierRan: false, gaps: [], convergence: 1, criteria: [{ id: "AC-1", status: "met" }] });
		expect(outcome.checks).toMatchObject([{ id: "has-ok", commit: head, exitCode: 0, passed: true }]);
		const events = s.run.journal.read();
		expect(events.filter((event) => event.t === "check.completed")).toMatchObject([{ checkId: "has-ok", commit: head, exitCode: 0, purpose: "verify" }]);
		expect(lastVerify(s.run)).toMatchObject({ head, verdict: "met", verifierRan: false, checks: outcome.checks, criteria: outcome.criteria, gaps: [] });
		expect(s.run.state().verification?.verdict).toBe("met");
		expect(readFileSync(s.run.paths.plan, "utf8")).toBe("# Plan\n\n- [ ] T1 (AC-1) Add the feature\n\n## Convergence 1\n\n- No gaps.\n");
		expect(progressed).toBe(1);
		expectCheckoutUntouched(s);
	}));

	it("forces not_met for a failing check even if the verifier says met", () => withGitFixture(async (fx) => {
		const s = setup(fx, CHECK_ONLY);
		s.integrate({ "feature.txt": "nope\n" }, "T1");
		const head = s.integrate({ "other.txt": "x\n" }, "T2");
		const runner = verifierSays(report([["AC-1", "met"]]));
		const outcome = await verifyRun(s.deps(runner));
		expect(runner.calls).toHaveLength(1);
		expect(outcome).toMatchObject({ verdict: "not_met", head, verifierRan: true, criteria: [{ id: "AC-1", status: "not_met" }] });
		expect(outcome.checks[0]).toMatchObject({ id: "has-ok", passed: false, exitCode: 1 });
		expect(outcome.gaps).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "missing", criteria: ["AC-1"], text: expect.stringContaining("check has-ok failed (exit 1)") }),
		]));
		expect(outcome.reason).toContain("failed checks: has-ok");
		expect(lastVerify(s.run)).toMatchObject({ verdict: "not_met", verifierRan: true });
		expectCheckoutUntouched(s);
	}));

	it("counts cant_tell and criteria the verifier left out as not met", () => withGitFixture(async (fx) => {
		const s = setup(fx, WITH_JUDGE);
		s.integrate({ "feature.txt": "ok\n" }, "T1");
		const cantTell = await verifyRun(s.deps(verifierSays(report([["AC-1", "met"], ["AC-2", "cant_tell"]]))));
		expect(cantTell).toMatchObject({ verdict: "not_met", criteria: [{ id: "AC-1", status: "met" }, { id: "AC-2", status: "cant_tell" }] });
		expect(cantTell.gaps).toEqual([expect.objectContaining({ kind: "partial", criteria: ["AC-2"] })]);
		const omitted = await verifyRun(s.deps(verifierSays(report([["AC-1", "met"]]))));
		expect(omitted).toMatchObject({ verdict: "not_met", criteria: [{ id: "AC-1", status: "met" }, { id: "AC-2", status: "cant_tell" }] });
		const met = await verifyRun(s.deps(verifierSays(report([["AC-1", "met"], ["AC-2", "met"]]))));
		expect(met).toMatchObject({ verdict: "met", verifierRan: true, convergence: 3 });
	}));

	it("appends gaps to plan.md as new convergence sections without editing existing bytes", () => withGitFixture(async (fx) => {
		const plan = "# Plan\r\n\r\n- [x] T1 (AC-1) Add the feature\r\n- [ ] T2 (AC-2) Polish the README\r\nNotes without a newline";
		const s = setup(fx, WITH_JUDGE, plan);
		s.integrate({ "feature.txt": "ok\n" }, "T1");
		const gaps = [{ kind: "unrequested", criteria: [], text: "edited\nother.txt\n## Heading injection" }, { kind: "missing", criteria: ["AC-2"], text: "README has no greeting" }];
		const first = await verifyRun(s.deps(verifierSays(report([["AC-1", "met"], ["AC-2", "not_met"]], { gaps }))));
		const after = readFileSync(s.run.paths.plan, "utf8");
		expect(after.startsWith(plan)).toBe(true);
		expect(first.convergence).toBe(1);
		expect(after.slice(plan.length)).toBe([
			"", "", "## Convergence 1", "",
			"- unrequested: edited other.txt ## Heading injection",
			"- missing (AC-2): README has no greeting",
			"- missing (AC-2): not_met: AC-2 looked at", "",
		].join("\r\n"));
		await verifyRun(s.deps(verifierSays(report([["AC-1", "met"]]))));
		const again = readFileSync(s.run.paths.plan, "utf8");
		expect(again.startsWith(after)).toBe(true);
		expect(again.slice(after.length)).toContain("## Convergence 2");
		expect(lastVerify(s.run)?.gaps).toEqual([expect.objectContaining({ kind: "partial", criteria: ["AC-2"] })]);
	}));

	it("refuses an unapproved goal and a goal.md changed after approval", () => withGitFixture(async (fx) => {
		const vcs = openVcs(fx.dir);
		const unapproved = createRun(fx.commonDir, { title: "x", base: fx.head(), repo: fx.dir, goal: CHECK_ONLY, runId: "20260101-000000-0001" });
		const runner = new FakeRunner();
		await expect(verifyRun({ runId: unapproved.runId, store: unapproved, vcs, runner, roles: ROLES, checks: [] })).rejects.toThrow(/not approved/);
		const s = setup(fx, CHECK_ONLY);
		s.integrate({ "feature.txt": "ok\n" }, "T1");
		writeFileSync(s.run.paths.goal, CHECK_ONLY.replace("contain ok", "contain anything"));
		const journaled = s.run.journal.read().length;
		await expect(verifyRun(s.deps(runner))).rejects.toThrow(/goal\.md changed after approval/);
		expect(s.run.journal.read()).toHaveLength(journaled);
		expect(readFileSync(s.run.paths.plan, "utf8")).toBe("");
		// Trailing whitespace and a BOM do not count as a change.
		writeFileSync(s.run.paths.goal, `\uFEFF${CHECK_ONLY.replace("## Intent", "## Intent  ")}\n\n`);
		expect((await verifyRun(s.deps(runner))).verdict).toBe("met");
		expect(runner.calls).toHaveLength(0);
		expectCheckoutUntouched(s);
	}));

	it("reports blocked only when the quote is verbatim criterion text", () => withGitFixture(async (fx) => {
		const s = setup(fx, WITH_JUDGE);
		s.integrate({ "feature.txt": "ok\n" }, "T1");
		const claim = (quote: string) => report([["AC-1", "met"], ["AC-2", "not_met"]], { blocked: [{ id: "AC-2", quote, reason: "the README is generated" }] });
		const verbatim = await verifyRun(s.deps(verifierSays(claim("keep the README friendly"))));
		expect(verbatim.verdict).toBe("blocked");
		expect(verbatim.reason).toContain("AC-2 cannot be satisfied as written");
		expect(verbatim.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "contradicts", criteria: ["AC-2"] })]));
		for (const quote of ["keep the readme friendly", "make the README friendly", "  "]) {
			expect((await verifyRun(s.deps(verifierSays(claim(quote))))).verdict).toBe("not_met");
		}
		// A quote attached to the wrong criterion does not count either.
		const wrongId = report([["AC-1", "met"], ["AC-2", "not_met"]], { blocked: [{ id: "AC-1", quote: "keep the README friendly", reason: "r" }] });
		expect((await verifyRun(s.deps(verifierSays(wrongId)))).verdict).toBe("not_met");
	}));

	it("fails closed when the verifier errors or returns invalid output", () => withGitFixture(async (fx) => {
		const s = setup(fx, WITH_JUDGE);
		s.integrate({ "feature.txt": "ok\n" }, "T1");
		const allMet = report([["AC-1", "met"], ["AC-2", "met"]]);
		const cases: [FakeRunner, RegExp][] = [
			[verifierSays(allMet, { fail: "transient", message: "connection reset" }), /verifier failed: connection reset/],
			[verifierSays(undefined), /no structured result/],
			[verifierSays({ ...allMet, criteria: [{ id: "AC-1", status: "probably", evidence: "" }, { id: "AC-2", status: "met", evidence: "" }] }), /invalid verifier result/],
			[verifierSays({ criteria: allMet.criteria }), /invalid verifier result/],
		];
		for (const [runner, reason] of cases) {
			const outcome = await verifyRun(s.deps(runner));
			expect(outcome).toMatchObject({ verdict: "not_met", verifierRan: true });
			expect(outcome.reason).toMatch(reason);
			expect(outcome.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "missing", criteria: ["AC-1", "AC-2"], text: expect.stringMatching(/^verifier failed/) })]));
			expect(outcome.criteria).toMatchObject([{ id: "AC-1", status: "met" }, { id: "AC-2", status: "cant_tell" }]);
			expect(lastVerify(s.run)).toMatchObject({ verdict: "not_met", verifierRan: true });
		}
		const missingRole = await verifyRun(s.deps(verifierSays(allMet), { roles: new Map() }));
		expect(missingRole).toMatchObject({ verdict: "not_met", reason: expect.stringContaining("verifier role is not defined") });
		expectCheckoutUntouched(s);
	}));

	it("runs the verifier for a judge criterion, in a read-only worktree at head, with the evidence in the prompt", () => withGitFixture(async (fx) => {
		const s = setup(fx, WITH_JUDGE, "- [x] T1 (AC-1, AC-2) Everything is done, trust me\n");
		const head = s.integrate({ "feature.txt": "ok\n" }, "T1");
		let seen: { head: string; feature: string } | undefined;
		const runner = verifierSays(report([["AC-1", "met"], ["AC-2", "met"]]), {
			edit: (cwd) => { seen = { head: s.vcs.worktreeHead(cwd), feature: readFileSync(`${cwd}/feature.txt`, "utf8") }; },
		});
		await verifyRun(s.deps(runner));
		expect(seen).toEqual({ head, feature: "ok\n" });
		const [call] = runner.calls;
		expect(call).toMatchObject({ role: "verifier", cwd: worktreePath(fx.commonDir, RUN_ID, "verify"), schema: VERIFIER_SCHEMA });
		expect(checkSchema(call!.schema)).toEqual([]);
		for (const part of [WITH_JUDGE.trim(), "### has-ok: passed", "Command: `grep -q ok feature.txt`", "Exit code: 0", "feature.txt | 1 +", `git diff --name-only ${s.base} ${head}`, "Everything is done, trust me", "claims, not evidence", "AC-1, AC-2", "verbatim"]) {
			expect(call!.prompt).toContain(part);
		}
		expectCheckoutUntouched(s);
	}));

	it("runs the verifier for a diff over 200 changed lines and for more than one integrated task", () => withGitFixture(async (fx) => {
		const big = setup(fx, CHECK_ONLY);
		big.integrate({ "feature.txt": `ok\n${"line\n".repeat(200)}` }, "T1");
		const bigRunner = verifierSays(report([["AC-1", "met"]]));
		expect(await verifyRun(big.deps(bigRunner))).toMatchObject({ verdict: "met", verifierRan: true });
		expect(bigRunner.calls).toHaveLength(1);
	}));

	it("treats several integrations of one task as one task", () => withGitFixture(async (fx) => {
		const s = setup(fx, CHECK_ONLY);
		s.integrate({ "feature.txt": "ok\n" }, "T1");
		s.integrate({ "feature.txt": "ok again\n" }, "T1");
		const runner = new FakeRunner();
		expect(await verifyRun(s.deps(runner))).toMatchObject({ verdict: "met", verifierRan: false });
		s.integrate({ "other.txt": "x\n" }, "T2");
		const second = verifierSays(report([["AC-1", "met"]]));
		expect(await verifyRun(s.deps(second))).toMatchObject({ verdict: "met", verifierRan: true });
		expect(second.calls).toHaveLength(1);
	}));

	it("removes the verify worktree and journals nothing when stopped", () => withGitFixture(async (fx) => {
		const s = setup(fx, WITH_JUDGE);
		s.integrate({ "feature.txt": "ok\n" }, "T1");
		const controller = new AbortController();
		const runner = new FakeRunner([{ match: () => { setTimeout(() => controller.abort(new Error("stopped")), 10); return true; }, hang: true }]);
		await expect(verifyRun(s.deps(runner, { signal: controller.signal }))).rejects.toThrow();
		expect(lastVerify(s.run)).toBeUndefined();
		expect(readFileSync(s.run.paths.plan, "utf8")).toBe("");
		expectCheckoutUntouched(s);
	}));

	it("propagates a stop during the checks without journaling a verdict", () => withGitFixture(async (fx) => {
		const goal = goalText(["- AC-1: THE SYSTEM SHALL finish. verify: check:slow"], ["| slow | sleep 30 | 60s | yes |"]);
		const s = setup(fx, goal);
		s.integrate({ "feature.txt": "ok\n" }, "T1");
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("stopped")), 50);
		const runner = new FakeRunner();
		await expect(verifyRun(s.deps(runner, { signal: controller.signal }))).rejects.toThrow("stopped");
		expect(runner.calls).toHaveLength(0);
		expect(lastVerify(s.run)).toBeUndefined();
		expect(readFileSync(s.run.paths.plan, "utf8")).toBe("");
		expectCheckoutUntouched(s);
	}));
});

describe("verifierNeeded", () => {
	const checkOnly: Criterion[] = [{ id: "AC-1", text: "t", verify: { kind: "check", checks: ["c"] } }];
	const judge: Criterion[] = [...checkOnly, { id: "AC-2", text: "t", verify: { kind: "judge", rubric: "r" } }];
	it("applies the §12 trigger rule", () => {
		expect(verifierNeeded({ integrations: [], changedLines: 0, criteria: checkOnly })).toBe(false);
		expect(verifierNeeded({ integrations: [{ task: "T1" }, { task: "T1" }], changedLines: 200, criteria: checkOnly })).toBe(false);
		expect(verifierNeeded({ integrations: [{}], changedLines: 200, criteria: checkOnly })).toBe(false);
		expect(verifierNeeded({ integrations: [{ task: "T1" }], changedLines: 201, criteria: checkOnly })).toBe(true);
		expect(verifierNeeded({ integrations: [{ task: "T1" }, { task: "T2" }], changedLines: 1, criteria: checkOnly })).toBe(true);
		expect(verifierNeeded({ integrations: [{}, {}], changedLines: 1, criteria: checkOnly })).toBe(true);
		expect(verifierNeeded({ integrations: [{ task: "T1" }, {}], changedLines: 1, criteria: checkOnly })).toBe(true);
		expect(verifierNeeded({ integrations: [], changedLines: 0, criteria: judge })).toBe(true);
	});
});

describe("computeVerdict", () => {
	const check = (id: string, passed: boolean): CheckResult => ({ id, commit: "c".repeat(40), exitCode: passed ? 0 : 2, timedOut: false, durationMs: 1, tail: "", logRef: "outputs/x.txt", passed });
	const criteria: Criterion[] = [
		{ id: "AC-1", text: "a", verify: { kind: "check", checks: ["a", "b"] } },
		{ id: "AC-2", text: "b", verify: { kind: "check", checks: ["c"] } },
	];
	it("decides check-verified criteria from their checks when the verifier did not run", () => {
		expect(computeVerdict({ criteria, checks: [check("a", true), check("b", true), check("c", true)], verifier: undefined })).toMatchObject({ verdict: "met", gaps: [] });
		const result = computeVerdict({ criteria, checks: [check("a", true), check("b", false), check("c", true)], verifier: undefined });
		expect(result).toMatchObject({ verdict: "not_met", criteria: [{ id: "AC-1", status: "not_met", evidence: "check a passed; check b failed (exit 2)" }, { id: "AC-2", status: "met" }] });
		expect(result.gaps).toMatchObject([{ kind: "missing", criteria: ["AC-1"] }, { kind: "missing", criteria: ["AC-1"], text: expect.stringContaining("check b failed") }]);
	});
	it("treats a check that did not run as failed, and any failing check as not met overall", () => {
		expect(computeVerdict({ criteria, checks: [check("a", true), check("c", true)], verifier: undefined }).criteria[0]).toMatchObject({ status: "not_met", evidence: "check a passed; check b did not run" });
		const stray = computeVerdict({ criteria, checks: [check("a", true), check("b", true), check("c", true), check("lint", false)], verifier: undefined });
		expect(stray.verdict).toBe("not_met");
		expect(stray.gaps).toMatchObject([{ kind: "missing", criteria: [], text: expect.stringContaining("check lint failed") }]);
	});
	it("lets the verifier downgrade a check-verified criterion but never upgrade a failing one", () => {
		const checks = [check("a", true), check("b", true), check("c", false)];
		const result = computeVerdict({ criteria, checks, verifier: { criteria: [{ id: "AC-1", status: "not_met", evidence: "wrong file" }, { id: "AC-2", status: "met", evidence: "fine" }], gaps: [], blocked: [] } });
		expect(result.criteria.map((entry) => entry.status)).toEqual(["not_met", "not_met"]);
	});
	describe("blocked claims", () => {
		const judged: Criterion[] = [
			{ id: "AC-1", text: "WHEN tests run THE SYSTEM SHALL pass them all", verify: { kind: "check", checks: ["test"] } },
			{ id: "AC-2", text: "THE SYSTEM SHALL keep the README friendly", verify: { kind: "judge", rubric: "r" } },
			{ id: "AC-3", text: "Be fast", verify: { kind: "judge", rubric: "r" } },
		];
		const verdict = (checks: CheckResult[], statuses: [string, string][], blocked: { id: string; quote: string }[]) => computeVerdict({
			criteria: judged, checks,
			verifier: { criteria: statuses.map(([id, status]) => ({ id, status: status as "met", evidence: "e" })), gaps: [], blocked: blocked.map((claim) => ({ ...claim, reason: "impossible" })) },
		});
		const allMet: [string, string][] = [["AC-1", "met"], ["AC-2", "met"], ["AC-3", "met"]];
		it("never lets a claim override a failing check", () => {
			expect(verdict([check("test", false)], allMet, [{ id: "AC-1", quote: "THE SYSTEM SHALL pass them all" }]).verdict).toBe("not_met");
			expect(verdict([check("test", false)], [["AC-1", "met"], ["AC-2", "not_met"], ["AC-3", "met"]], [{ id: "AC-2", quote: "keep the README friendly" }]).verdict).toBe("not_met");
		});
		it("needs a valid claim on every unmet criterion", () => {
			const result = verdict([check("test", true)], [["AC-1", "met"], ["AC-2", "not_met"], ["AC-3", "not_met"]], [{ id: "AC-2", quote: "keep the README friendly" }]);
			expect(result.verdict).toBe("not_met");
			expect(result.reason).toContain("AC-3");
		});
		it("ignores a quote shorter than three words unless it is the whole criterion", () => {
			for (const quote of ["README", "README friendly", " the README "]) {
				expect(verdict([check("test", true)], [["AC-1", "met"], ["AC-2", "not_met"], ["AC-3", "met"]], [{ id: "AC-2", quote }]).verdict).toBe("not_met");
			}
			expect(verdict([check("test", true)], [["AC-1", "met"], ["AC-2", "met"], ["AC-3", "not_met"]], [{ id: "AC-3", quote: "fast" }]).verdict).toBe("not_met");
			expect(verdict([check("test", true)], [["AC-1", "met"], ["AC-2", "met"], ["AC-3", "not_met"]], [{ id: "AC-3", quote: "Be fast" }]).verdict).toBe("blocked");
		});
		it("blocks when every check passed and every unmet criterion has a substantial verbatim claim", () => {
			const result = verdict([check("test", true)], [["AC-1", "met"], ["AC-2", "not_met"], ["AC-3", "met"]], [{ id: "AC-2", quote: "keep the README" }]);
			expect(result).toMatchObject({ verdict: "blocked", reason: "AC-2 cannot be satisfied as written: impossible" });
			expect(verdict([check("test", true)], [["AC-1", "met"], ["AC-2", "not_met"], ["AC-3", "not_met"]], [{ id: "AC-2", quote: "keep the README" }, { id: "AC-3", quote: "Be fast" }]).verdict).toBe("blocked");
		});
	});
});
