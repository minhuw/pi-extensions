import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIntegrator } from "../../src/integrate/integrate.ts";
import { baseRef, integrationRef } from "../../src/run/paths.ts";
import { createRun, openRun, type RunStore } from "../../src/run/store.ts";
import { launchScript, type LaunchOutcome } from "../../src/steps/launch.ts";
import type { CheckSpec, ScriptSettledEvent, Vcs } from "../../src/types.ts";
import { openVcs } from "../../src/vcs/git.ts";
import { isolateGitConfig } from "../integrate/support.ts";
import type { AgentRunRequest } from "../../src/types.ts";
import { FakeRunner, type FakeRule } from "../support/fake-runner.ts";
import { withGitFixture, type GitFixture } from "../support/git-fixture.ts";
import { TEST_LIMITS } from "../steps/harness.ts";
import { ROLES, template, type TemplateName } from "./support.ts";

isolateGitConfig();

const gate = (id: string, command: string): CheckSpec => ({ id, command, timeoutMs: 20_000, integrate: true });

interface Env { fixture: GitFixture; vcs: Vcs; store: RunStore; base: string; runner: FakeRunner; launch(name: TemplateName, args: unknown, resume?: number): Promise<LaunchOutcome> }

/** A real run on a git fixture, driven by the real launch, executor, integrator, and built-in roles. */
function withEnv(checks: CheckSpec[], rules: FakeRule[], fn: (env: Env) => Promise<void>, files?: Record<string, string>) {
	return withGitFixture(async (fixture) => {
		const vcs = openVcs(fixture.dir);
		const base = fixture.head();
		const created = createRun(vcs.commonDir(), { title: "templates", base, repo: fixture.dir });
		created.journal.append({ t: "goal.approved", sha256: "0".repeat(64), checks, approvedBy: "user" });
		vcs.updateRef(baseRef(created.runId), base, null);
		vcs.updateRef(integrationRef(created.runId), base, null);
		const runner = new FakeRunner(rules);
		const env: Env = {
			fixture, vcs, base, runner, store: created,
			async launch(name, args, resume) {
				// Each launch reopens the run, as a fresh process would.
				const store = openRun(vcs.commonDir(), created.runId);
				const runId = created.runId;
				const integrator = createIntegrator({ runId, store, vcs, checks });
				const deps = { runId, store, vcs, runner, roles: ROLES, checks, limits: TEST_LIMITS, sleep: async () => {}, integrator };
				return launchScript(deps, { source: template(name), args, resume }).done;
			},
		};
		await fn(env);
	}, files);
}

const head = (env: Env) => env.vcs.readRef(integrationRef(env.store.runId))!;
const commitsAbove = (env: Env) => env.fixture.git("rev-list", "--reverse", `${env.base}..${head(env)}`).split("\n").filter(Boolean);
const show = (env: Env, file: string) => env.fixture.git("show", `${head(env)}:${file}`);

/** The integration line carries no Herder trailers, the checkout is untouched, and no worktree is left. */
function assertClean(env: Env) {
	expect(env.fixture.git("log", "--format=%B", `${env.base}..${head(env)}`)).not.toMatch(/Herder-/);
	expect(env.fixture.status()).toBe("");
	expect(env.fixture.head()).toBe(env.base);
	const dir = env.store.paths.worktrees;
	expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	expect(env.fixture.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
}

/** Relaunching launch 1 with `resume` reuses every step and integration: no agent runs and the head stays. */
async function assertReplay(env: Env, name: TemplateName, args: unknown, first: LaunchOutcome, steps: number) {
	const calls = env.runner.calls.length;
	const before = head(env);
	const second = await env.launch(name, args, 1);
	expect(second).toMatchObject({ launch: 2, status: "completed", reused: steps, changed: 0, new: 0, value: first.value });
	expect(env.runner.calls).toHaveLength(calls);
	expect(head(env)).toBe(before);
	const settled = env.store.journal.read().filter((event): event is ScriptSettledEvent => event.t === "script.settled");
	expect(settled.at(-1)).toMatchObject({ launch: 2, status: "completed", reused: steps, changed: 0, new: 0 });
	assertClean(env);
}

describe("sequential.js end to end", () => {
	const args = { task: "T1", prompt: "Write out.txt.", gate: "fixed", message: "feat: out" };
	const rules: FakeRule[] = [
		{ match: "These checks fail", files: { "out.txt": "fixed\n" } },
		{ match: "Write out.txt.", files: { "out.txt": "broken\n" } },
	];

	it("fixes one failed gate, integrates one commit, and replays without agents", () => withEnv([gate("fixed", "grep -q fixed out.txt")], rules, async (env) => {
		const first = await env.launch("sequential", args);
		expect(first).toMatchObject({ launch: 1, status: "completed", new: 2 });
		expect(first.value).toEqual({ task: "T1", status: "integrated", attempts: 1, head: head(env) });
		expect(env.runner.calls).toHaveLength(2);
		expect(env.runner.calls[1]!.prompt).toContain("### fixed (exit 1)");
		expect(commitsAbove(env)).toEqual([head(env)]);
		expect(env.fixture.git("log", "-1", "--format=%B", head(env))).toBe("feat: out");
		expect(show(env, "out.txt")).toBe("fixed");
		expect(env.fixture.git("ls-tree", "--name-only", head(env)).split("\n").sort()).toEqual(["README.md", "out.txt"]);
		assertClean(env);
		await assertReplay(env, "sequential", args, first, 2);
	}));
});

/** Does what the resolver prompt asks: runs its apply command with real git, then resolves the conflicted file. */
function resolve(cwd: string, request: AgentRunRequest) {
	const command = /`(git diff --binary [0-9a-f]{40}\^ [0-9a-f]{40} \| git apply --3way)`/.exec(request.prompt)![1]!;
	try { execFileSync("sh", ["-c", command], { cwd, stdio: "ignore" }); }
	catch {} // exits non-zero on the conflict it leaves behind
	expect(readFileSync(join(cwd, "shared.txt"), "utf8")).toMatch(/^<<<<<<< /m);
	writeFileSync(join(cwd, "shared.txt"), "value = T1 + T2\n");
}

describe("disjoint.js end to end", () => {
	const task = (id: string, owns: string) => ({ id, prompt: `Implement ${id}.`, owns: [`${owns}/**`], gate: "present", message: `feat(${id}): implement` });
	const args = { tasks: [task("T1", "a"), task("T2", "b"), task("T3", "c")] };

	it("integrates three disjoint tasks in task order and replays without agents", () => withEnv(
		[gate("present", "test -n \"$(ls a b c 2>/dev/null)\"")],
		["T1", "T2", "T3"].map((id, i) => ({ match: `Implement ${id}.`, files: { [`${"abc"[i]}/${id}.txt`]: `${id}\n` } })),
		async (env) => {
			const first = await env.launch("disjoint", args);
			expect(first.value).toEqual({ head: head(env), integrated: ["T1", "T2", "T3"], failed: [] });
			const commits = commitsAbove(env);
			expect(commits.map((commit) => env.fixture.git("log", "-1", "--format=%s", commit))).toEqual(["feat(T1): implement", "feat(T2): implement", "feat(T3): implement"]);
			expect(env.fixture.git("ls-tree", "-r", "--name-only", head(env)).split("\n").sort()).toEqual(["README.md", "a/T1.txt", "b/T2.txt", "c/T3.txt"]);
			assertClean(env);
			await assertReplay(env, "disjoint", args, first, 3);
		},
	));

	it("resolves an injected conflict with the resolver and integrates the combined content", () => withEnv(
		[gate("present", "test -f shared.txt")],
		[
			{ match: "Integrate task T2", role: "resolver", edit: resolve, text: "Kept both sides." },
			{ match: "Implement T1.", files: { "a/T1.txt": "T1\n", "shared.txt": "value = T1\n" } },
			{ match: "Implement T2.", files: { "b/T2.txt": "T2\n", "shared.txt": "value = T2\n" } },
			{ match: "Implement T3.", files: { "c/T3.txt": "T3\n" } },
		],
		async (env) => {
			const first = await env.launch("disjoint", args);
			expect(first.value).toEqual({ head: head(env), integrated: ["T1", "T2", "T3"], failed: [] });
			expect(env.runner.calls.filter((call) => call.role === "resolver").map((call) => call.prompt)).toEqual([expect.stringContaining("- shared.txt")]);
			const commits = commitsAbove(env);
			expect(commits.map((commit) => env.fixture.git("log", "-1", "--format=%s", commit))).toEqual(["feat(T1): implement", "feat(T2): implement", "feat(T3): implement"]);
			expect(show(env, "shared.txt")).toBe("value = T1 + T2");
			expect(env.fixture.git("ls-tree", "-r", "--name-only", head(env)).split("\n").sort()).toEqual(["README.md", "a/T1.txt", "b/T2.txt", "c/T3.txt", "shared.txt"]);
			const failed = env.store.journal.read().filter((event) => event.t === "integrate.failed");
			expect(failed).toMatchObject([{ reason: "conflict", conflicts: ["shared.txt"], task: "T2" }]);
			assertClean(env);
			await assertReplay(env, "disjoint", args, first, 4);
		},
		{ "README.md": "# fixture\n", "shared.txt": "value = 0\n" },
	));

	it("resolves a conflict after a fix iteration with the task's implementation and fix both applied", () => withEnv(
		[gate("present", "test -f shared.txt && ! grep -qs broken b/T2.txt")],
		[
			{ match: "Integrate task T2", role: "resolver", edit: resolve, text: "Kept both sides." },
			{ match: (request) => request.prompt.startsWith("Implement T2.") && request.prompt.includes("These checks fail"), files: { "b/T2.txt": "T2 fixed\n", "b/fix.txt": "fix\n" } },
			{ match: "Implement T1.", files: { "a/T1.txt": "T1\n", "shared.txt": "value = T1\n" } },
			{ match: "Implement T2.", files: { "b/T2.txt": "broken\n", "b/impl.txt": "impl\n", "shared.txt": "value = T2\n" } },
			{ match: "Implement T3.", files: { "c/T3.txt": "T3\n" } },
		],
		async (env) => {
			const first = await env.launch("disjoint", args);
			expect(first.value).toEqual({ head: head(env), integrated: ["T1", "T2", "T3"], failed: [] });
			expect(env.runner.calls.map((call) => call.prompt.split("\n")[0])).toContain("Implement T2.");
			expect(env.runner.calls.filter((call) => call.prompt.includes("These checks fail"))).toHaveLength(1);
			expect(show(env, "shared.txt")).toBe("value = T1 + T2");
			expect(show(env, "b/T2.txt")).toBe("T2 fixed");
			expect(show(env, "b/impl.txt")).toBe("impl");
			expect(show(env, "b/fix.txt")).toBe("fix");
			expect(env.fixture.git("ls-tree", "-r", "--name-only", head(env)).split("\n").sort()).toEqual(["README.md", "a/T1.txt", "b/T2.txt", "b/fix.txt", "b/impl.txt", "c/T3.txt", "shared.txt"]);
			expect(env.store.journal.read().filter((event) => event.t === "integrate.failed")).toMatchObject([{ reason: "conflict", conflicts: ["shared.txt"], task: "T2" }]);
			assertClean(env);
			await assertReplay(env, "disjoint", args, first, 5);
		},
		{ "README.md": "# fixture\n", "shared.txt": "value = 0\n" },
	));
});

describe("explore.js end to end", () => {
	const args = { task: "T4", prompt: "Write answer.txt.", variants: 3, approaches: ["one", "two", "three"], gate: "good", message: "feat: answer" };
	const rules: FakeRule[] = [
		{ match: "Approach for this attempt: one", files: { "answer.txt": "bad\n" } },
		{ match: "Approach for this attempt: two", files: { "answer.txt": "good two\n" } },
		{ match: "Approach for this attempt: three", files: { "answer.txt": "good three\n" } },
		{ match: "Pick the single best one", role: "reviewer", data: { winner: 3, rationale: "clearer" } },
	];

	it("judges the two passing variants, integrates exactly the winner, and replays without agents", () => withEnv([gate("good", "grep -q good answer.txt")], rules, async (env) => {
		const first = await env.launch("explore", args);
		expect(first.value).toEqual({
			task: "T4", status: "integrated", winner: 3, head: head(env), rationale: "clearer",
			candidates: [{ variant: 1, status: "gate_failed" }, { variant: 2, status: "ok" }, { variant: 3, status: "ok" }],
		});
		const judge = env.runner.calls.find((call) => call.role === "reviewer")!;
		expect(judge.schema).toMatchObject({ properties: { winner: { enum: [2, 3] } } });
		expect(commitsAbove(env)).toEqual([head(env)]);
		expect(show(env, "answer.txt")).toBe("good three");
		expect(env.store.journal.read().filter((event) => event.t === "integrate.completed")).toHaveLength(1);
		assertClean(env);
		await assertReplay(env, "explore", args, first, 4);
	}));
});
