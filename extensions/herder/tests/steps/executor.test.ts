import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INLINE_TEXT_LIMIT } from "../../src/config.ts";
import { Occurrences, stepId, stepKey } from "../../src/journal/keys.ts";
import { stepRef, worktreePath } from "../../src/run/paths.ts";
import { AgentError } from "../../src/types.ts";
import type { AgentRunRequest, FaultPoint, StepCompletedEvent, StepFailedEvent } from "../../src/types.ts";
import { CHECKS, deferred, until, withRun } from "./harness.ts";

const FEATURE = { match: "add the feature", files: { "feature.txt": "feature\n" }, text: "added" };
const crashAt = (point: FaultPoint) => ({ hit(at: FaultPoint) { if (at === point) throw new Error(`crash at ${at}`); } });
const completions = (events: { t: string }[]) => events.filter((event): event is StepCompletedEvent => event.t === "step.completed");
const failures = (events: { t: string }[]) => events.filter((event): event is StepFailedEvent => event.t === "step.failed");

describe("writing steps", () => {
	it("commits onto the base, pins the step ref, journals, and removes the worktree", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		const result = await h.executor().run("add the feature");
		expect(result).toMatchObject({ status: "ok", text: "added", reused: false });
		expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(h.vcs.readRef(stepRef(h.store.runId, result.key))).toBe(result.commit);
		expect(h.vcs.parentsOf(result.commit!)).toEqual([h.head]);
		expect(h.vcs.trailers(result.commit!)).toMatchObject({ "herder-step": result.key });
		expect(h.fixture.git("show", `${result.commit}:feature.txt`)).toBe("feature");
		expect(h.types()).toEqual(["run.started", "step.started", "step.completed"]);
		const [started] = h.events().filter((event) => event.t === "step.started");
		expect(started).toMatchObject({ key: result.key, occurrence: 0, attempt: 1, role: "worker", write: true, base: h.head });
		expect(completions(h.events())[0]).toMatchObject({ status: "ok", commit: result.commit, ref: stepRef(h.store.runId, result.key), text: "added" });
		expect(h.runner.calls[0]!.cwd).toContain(join(h.store.paths.worktrees, `step-${result.key}`));
		h.assertClean();
	}));

	it("reuses a completed step from a fresh executor without calling the runner", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		const first = await h.executor().run("add the feature");
		const again = await h.executor({ store: h.reopen() }).run("add the feature");
		expect(again).toEqual({ ...first, reused: true });
		expect(h.runner.calls).toHaveLength(1);
		h.assertClean();
	}));

	it("reruns a completed step whose ref no longer points at its commit", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		const first = await h.executor().run("add the feature");
		h.vcs.deleteRefs(stepRef(h.store.runId, first.key));
		const again = await h.executor().run("add the feature");
		expect(again.reused).toBe(false);
		expect(h.runner.calls).toHaveLength(2);
		expect(h.vcs.readRef(stepRef(h.store.runId, first.key))).toBe(again.commit);
	}));

	it("records no_changes without a commit or ref", () => withRun(async (h) => {
		h.runner.add({ match: "look around", text: "nothing to do" });
		const result = await h.executor().run("look around");
		expect(result).toMatchObject({ status: "no_changes", text: "nothing to do" });
		expect(result.commit).toBeUndefined();
		expect(h.vcs.readRef(stepRef(h.store.runId, result.key))).toBeNull();
		h.assertClean();
	}));

	it("squashes commits the agent made itself onto the base", () => withRun(async (h) => {
		h.runner.add({
			match: "commit it",
			edit(cwd) {
				writeFileSync(join(cwd, "one.txt"), "1\n");
				execFileSync("git", ["add", "-A"], { cwd });
				execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "agent commit"], { cwd });
				writeFileSync(join(cwd, "two.txt"), "2\n");
			},
		});
		const result = await h.executor().run("commit it");
		expect(result.status).toBe("ok");
		expect(h.vcs.parentsOf(result.commit!)).toEqual([h.head]);
		expect(h.fixture.git("ls-tree", "--name-only", result.commit!).split("\n").sort()).toEqual(["README.md", "one.txt", "two.txt"]);
		h.assertClean();
	}));

	it("stores long text in outputs and reads it back on reuse", () => withRun(async (h) => {
		const long = "x".repeat(INLINE_TEXT_LIMIT + 1);
		h.runner.add({ match: "talk a lot", text: long });
		const first = await h.executor().run("talk a lot", { role: "explorer" });
		expect(first.text).toBe(long);
		const event = completions(h.events())[0]!;
		expect(event.text).toBeUndefined();
		expect(h.store.outputs.read(event.textRef!)).toBe(long);
		expect((await h.executor().run("talk a lot", { role: "explorer" })).text).toBe(long);
	}));
});

describe("read-only steps", () => {
	it("records a warning and discards changes", () => withRun(async (h) => {
		h.runner.add({ match: "review", files: { "oops.txt": "x" }, text: "lgtm", data: { verdict: "ok" } });
		const result = await h.executor().run("review", { role: "reviewer", schema: { type: "object" } });
		expect(result).toMatchObject({ status: "ok", text: "lgtm", data: { verdict: "ok" } });
		expect(result.commit).toBeUndefined();
		expect(result.warning).toMatch(/discarded/);
		expect(completions(h.events())[0]!.warning).toMatch(/discarded/);
		expect(h.runner.calls[0]!.schema).toEqual({ type: "object" });
		expect(await h.executor().run("review", { role: "reviewer", schema: { type: "object" } })).toEqual({ ...result, reused: true });
		h.assertClean();
	}));

	it("passes a read-only copy of a writing role for write: false", () => withRun(async (h) => {
		let seen: AgentRunRequest | undefined;
		h.runner.add({ match: "inspect", edit(_cwd, request) { seen = request; } });
		const result = await h.executor().run("inspect", { write: false });
		expect(seen!.role).toMatchObject({ name: "worker", write: false, sha256: h.roles.get("worker")!.sha256 });
		expect(result.status).toBe("ok");
		expect(h.events().find((event) => event.t === "step.started")).toMatchObject({ write: false });
	}));
});

describe("gates", () => {
	it("passes gates run in the step's worktree and journals them", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		const result = await h.executor().run("add the feature", { gate: "has-feature" });
		expect(result.status).toBe("ok");
		expect(result.checks).toMatchObject([{ id: "has-feature", passed: true, commit: result.commit }]);
		expect(h.events().find((event) => event.t === "check.completed")).toMatchObject({ checkId: "has-feature", purpose: "gate", key: result.key, commit: result.commit });
		h.assertClean();
	}));

	it("records gate_failed with the commit and ref, and reuses it", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		const result = await h.executor().run("add the feature", { gate: ["has-feature", "always-fails"] });
		expect(result.status).toBe("gate_failed");
		expect(result.checks!.map((check) => check.passed)).toEqual([true, false]);
		expect(result.checks![1]!.tail).toContain("boom");
		expect(h.vcs.readRef(stepRef(h.store.runId, result.key))).toBe(result.commit);
		const again = await h.executor().run("add the feature", { gate: ["has-feature", "always-fails"] });
		expect(again).toEqual({ ...result, reused: true });
		expect(h.runner.calls).toHaveLength(1);
		h.assertClean();
	}));

	it("changes the fingerprint with the gates", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		await h.executor().run("add the feature");
		await h.executor().run("add the feature", { gate: "has-feature" });
		expect(h.runner.calls).toHaveLength(2);
	}));
});

describe("failures", () => {
	it("retries a transient failure in a fresh worktree from the same base", () => withRun(async (h) => {
		h.runner.add({ match: "add the feature", files: { "junk.txt": "partial" }, fail: "transient", times: 1 }, FEATURE);
		const result = await h.executor().run("add the feature");
		expect(result.status).toBe("ok");
		expect(h.fixture.git("ls-tree", "--name-only", result.commit!)).not.toContain("junk.txt");
		expect(h.types().slice(1)).toEqual(["step.started", "step.failed", "step.started", "step.completed"]);
		expect(failures(h.events())[0]).toMatchObject({ attempt: 1, errorClass: "transient", final: false });
		expect(h.events().filter((event) => event.t === "step.started").map((event) => (event as { attempt: number }).attempt)).toEqual([1, 2]);
		expect(h.sleeps).toEqual([5]);
		expect(h.store.state().liveAgentStarts).toBe(1);
		h.assertClean();
	}));

	it("gives up after one retry per backoff entry and never reuses the failure", () => withRun(async (h) => {
		h.runner.add({ match: "flaky", fail: "rate_limit", message: "slow down" });
		const result = await h.executor().run("flaky");
		expect(result).toMatchObject({ status: "failed", error: { class: "rate_limit", message: "slow down" }, reused: false });
		expect(failures(h.events()).map((event) => event.final)).toEqual([false, false, true]);
		expect(h.sleeps).toEqual([5, 5]);
		await h.executor().run("flaky");
		expect(h.runner.calls).toHaveLength(6);
		h.assertClean();
	}));

	it("restarts a stall up to stallRestarts times", () => withRun(async (h) => {
		h.runner.add({ match: "stuck", fail: "stall" });
		const result = await h.executor().run("stuck");
		expect(result.error?.class).toBe("stall");
		expect(h.runner.calls).toHaveLength(2);
		expect(h.sleeps).toEqual([]);
	}));

	it.each(["timeout", "auth", "invalid_output", "fatal"] as const)("treats %s as final", (errorClass) => withRun(async (h) => {
		h.runner.add({ match: "bad", fail: errorClass });
		const result = await h.executor().run("bad");
		expect(result).toMatchObject({ status: "failed", error: { class: errorClass } });
		expect(h.runner.calls).toHaveLength(1);
		expect(failures(h.events())).toMatchObject([{ errorClass, final: true, attempt: 1 }]);
		h.assertClean();
	}));

	it("classifies an unexpected error as fatal", () => withRun(async (h) => {
		h.runner.add({ match: "explode", edit() { throw new Error("kaboom"); } });
		expect(await h.executor().run("explode")).toMatchObject({ status: "failed", error: { class: "fatal", message: "kaboom" } });
		h.assertClean();
	}));

	it("stops starting agents in a launch after a usage limit", () => withRun(async (h) => {
		h.runner.add({ match: "first", fail: "usage_limit" }, { match: "second" }, { match: "third" });
		const executor = h.executor();
		const ctx = { launch: 1, occurrences: new Occurrences() };
		expect((await executor.run("first", {}, ctx)).error?.class).toBe("usage_limit");
		expect(await executor.run("second", {}, ctx)).toMatchObject({ status: "failed", error: { class: "usage_limit" } });
		expect(h.runner.calls).toHaveLength(1);
		expect((await executor.run("third", {}, { launch: 2, occurrences: new Occurrences() })).status).toBe("no_changes");
	}));

	it("settles a stopped step as stopped and removes its worktree", () => withRun(async (h) => {
		h.runner.add({ match: "forever", hang: true });
		const controller = new AbortController();
		const pending = h.executor({ signal: controller.signal }).run("forever");
		while (h.runner.calls.length === 0) await new Promise((done) => setTimeout(done, 5));
		controller.abort("user stop");
		expect(await pending).toMatchObject({ status: "stopped", reused: false });
		expect(failures(h.events())).toMatchObject([{ errorClass: "stopped", final: true }]);
		await h.executor().run("forever", {}, { signal: AbortSignal.abort() });
		expect(h.runner.calls).toHaveLength(1);
		h.assertClean();
	}));
});

describe("failures, continued", () => {
	it("journals the attempt's transcript on completion and failure", () => withRun(async (h) => {
		let call = 0;
		const runner = { async run() {
			if (++call === 1) throw new AgentError("fatal", "bad", { transcriptRef: "outputs/failed.txt" });
			return { text: "fine", transcriptRef: "outputs/done.txt" };
		} };
		const executor = h.executor({ runner });
		expect((await executor.run("look", { role: "explorer" })).status).toBe("failed");
		expect(failures(h.events())).toMatchObject([{ message: "bad", transcriptRef: "outputs/failed.txt" }]);
		expect((await executor.run("look", { role: "explorer" })).text).toBe("fine");
		expect(completions(h.events())).toMatchObject([{ transcriptRef: "outputs/done.txt" }]);
	}));

	it("does not retry a step after a sibling hits a usage limit in the launch", () => withRun(async (h) => {
		const limited = deferred();
		h.runner.add({ match: "flaky", fail: "transient", times: 1 }, { match: "flaky" }, { match: "limited", fail: "usage_limit" });
		const executor = h.executor({ sleep: () => limited.promise });
		const ctx = { launch: 1, occurrences: new Occurrences() };
		const flaky = executor.run("flaky", {}, ctx);
		expect((await executor.run("limited", {}, ctx)).error?.class).toBe("usage_limit");
		limited.resolve();
		expect(await flaky).toMatchObject({ status: "failed", error: { class: "usage_limit" } });
		expect(h.runner.callsMatching("flaky")).toHaveLength(1);
		const key = (await flaky).key;
		expect(failures(h.events()).filter((event) => event.key === key)).toMatchObject([
			{ attempt: 1, errorClass: "transient", final: false }, { attempt: 2, errorClass: "usage_limit", final: true },
		]);
	}));

	it("journals a stop during backoff once, as the next attempt", () => withRun(async (h) => {
		const controller = new AbortController();
		h.runner.add({ match: "flaky", fail: "transient" });
		const sleep = (_ms: number, signal?: AbortSignal) => {
			controller.abort("user stop");
			return Promise.reject(signal?.reason);
		};
		expect((await h.executor({ signal: controller.signal, sleep }).run("flaky")).status).toBe("stopped");
		expect(failures(h.events())).toMatchObject([{ attempt: 1, errorClass: "transient", final: false }, { attempt: 2, errorClass: "stopped", final: true }]);
		expect(h.runner.calls).toHaveLength(1);
	}));
});

describe("caps and options", () => {
	it("throws when the per-run agent cap is reached, but still reuses", () => withRun(async (h) => {
		h.runner.add(FEATURE, { match: "more" });
		await h.executor({ maxAgents: 1 }).run("add the feature");
		await expect(h.executor({ maxAgents: 1 }).run("more")).rejects.toThrow(/agent cap/);
		expect((await h.executor({ maxAgents: 1 }).run("add the feature")).reused).toBe(true);
		expect(h.runner.calls).toHaveLength(1);
	}));

	it("does not overshoot the per-run cap with concurrent calls", () => withRun(async (h) => {
		const gate = deferred();
		h.runner.add({ match: "job", role: "explorer", waitFor: gate.promise });
		const executor = h.executor({ maxAgents: 2 });
		const runs = ["job 1", "job 2", "job 3"].map((prompt) => executor.run(prompt, { role: "explorer" }));
		await until(() => h.runner.calls.length === 2);
		gate.resolve();
		const settled = await Promise.allSettled(runs);
		expect(settled.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
		expect(h.store.state().liveAgentStarts).toBe(2);
		expect(h.runner.calls).toHaveLength(2);
	}));

	it("rejects unknown roles and gates and write: true on a read-only role", () => withRun(async (h) => {
		const executor = h.executor();
		await expect(executor.run("x", { role: "nobody" })).rejects.toThrow(/unknown role/);
		await expect(executor.run("x", { gate: "nope" })).rejects.toThrow(/unknown gate/);
		await expect(executor.run("x", { role: "reviewer", write: true })).rejects.toThrow(/read-only/);
		expect(h.runner.calls).toHaveLength(0);
	}));

	it("rejects an explicit id reused with different inputs in one launch", () => withRun(async (h) => {
		h.runner.add({ match: "v" });
		const executor = h.executor();
		const ctx = { launch: 1, occurrences: new Occurrences() };
		await executor.run("v1", { id: "same", role: "explorer" }, ctx);
		await expect(executor.run("v2", { id: "same", role: "explorer" }, ctx)).rejects.toThrow(/already used/);
		const twice = await executor.run("v1", { id: "same", role: "explorer" }, ctx);
		expect(twice.key).toBe("same-1");
	}));

	it("rejects an implicit id reused with different gates in one launch", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		const executor = h.executor();
		const ctx = { launch: 1, occurrences: new Occurrences() };
		await executor.run("add the feature", {}, ctx);
		await expect(executor.run("add the feature", { gate: "has-feature" }, ctx)).rejects.toThrow(/implicit ids derive from the role and prompt.*explicit id/);
		expect(h.runner.calls).toHaveLength(1);
	}));

	it("rejects an implicit id reused with a different base in one launch", () => withRun(async (h) => {
		const other = h.fixture.commit("second", { "other.txt": "o\n" });
		h.fixture.git("reset", "-q", "--hard", h.head);
		h.runner.add(FEATURE);
		const executor = h.executor();
		const ctx = { launch: 1, occurrences: new Occurrences() };
		const running = executor.run("add the feature", {}, ctx);
		await expect(executor.run("add the feature", { base: other }, ctx)).rejects.toThrow(/implicit ids derive from the role and prompt/);
		expect((await running).status).toBe("ok");
		expect(h.runner.calls).toHaveLength(1);
	}));

	it("bypasses the cache with fresh: true", () => withRun(async (h) => {
		h.runner.add({ match: "sample", text: (_request, call) => `sample ${call}` });
		const executor = h.executor();
		await executor.run("sample", { role: "explorer" });
		const again = await executor.run("sample", { role: "explorer", fresh: true });
		expect(again).toMatchObject({ text: "sample 2", reused: false });
	}));

	it("uses the context's base and resolves an explicit base", () => withRun(async (h) => {
		const other = h.fixture.commit("second", { "other.txt": "o\n" });
		h.fixture.git("reset", "-q", "--hard", h.head);
		h.runner.add(FEATURE);
		const executor = h.executor();
		const fromCtx = await executor.run("add the feature", {}, { base: () => other });
		expect(h.vcs.parentsOf(fromCtx.commit!)).toEqual([other]);
		const explicit = await executor.run("add the feature", { base: other.slice(0, 12) });
		expect(explicit.reused).toBe(true);
	}));
});

describe("coalescing", () => {
	it("shares one in-flight call with the same key and fingerprint", () => withRun(async (h) => {
		const gate = deferred();
		h.runner.add({ ...FEATURE, waitFor: gate.promise });
		const executor = h.executor();
		const first = executor.run("add the feature");
		const second = executor.run("add the feature");
		await expect(executor.run("other", { id: stepId("agent", "worker", "add the feature") })).rejects.toThrow(/already running/);
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(b).toBe(a);
		expect(h.runner.calls).toHaveLength(1);
		h.assertClean();
	}));
});

describe("crash recovery", () => {
	it("adopts a pinned ref whose completion was never journaled", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		await expect(h.executor({ faults: crashAt("after-ref") }).run("add the feature", { gate: "has-feature" })).rejects.toThrow("crash at after-ref");
		expect(completions(h.events())).toHaveLength(0);
		h.assertClean();
		const adopted = await h.executor({ store: h.reopen() }).run("add the feature", { gate: "has-feature" });
		expect(adopted).toMatchObject({ status: "ok", text: "added", reused: true });
		expect(adopted.checks).toMatchObject([{ id: "has-feature", passed: true, commit: adopted.commit }]);
		expect(h.runner.calls).toHaveLength(1);
		expect((await h.executor().run("add the feature", { gate: "has-feature" })).reused).toBe(true);
		h.assertClean();
	}));

	it("adopts with the agent's reply after a stop during a slow gate", () => withRun(async (h) => {
		const dir = mkdtempSync(join(tmpdir(), "herder-gate-"));
		try {
			const started = join(dir, "started"), release = join(dir, "release");
			const checks = [...CHECKS, { id: "slow", command: `if [ ! -f ${release} ]; then touch ${started}; sleep 30; fi; test -f feature.txt`, timeoutMs: 60_000, integrate: false }];
			h.runner.add({ ...FEATURE, data: { files: 1 }, usage: { input: 3, output: 4 } });
			const controller = new AbortController();
			const opts = { gate: "slow", schema: { type: "object" } };
			const pending = h.executor({ checks, signal: controller.signal }).run("add the feature", opts);
			await until(() => existsSync(started));
			controller.abort("user stop");
			expect((await pending).status).toBe("stopped");
			writeFileSync(release, "");
			const adopted = await h.executor({ checks, store: h.reopen() }).run("add the feature", opts);
			expect(adopted).toMatchObject({ status: "ok", text: "added", data: { files: 1 }, reused: true });
			expect(adopted.checks).toMatchObject([{ id: "slow", passed: true }]);
			expect(completions(h.events())).toMatchObject([{ text: "added", data: { files: 1 }, usage: { input: 3, output: 4 } }]);
			expect(h.runner.calls).toHaveLength(1);
			h.assertClean();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}));

	it("removes a leftover slot worktree when reusing a journaled step", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		const first = await h.executor().run("add the feature");
		// A process that died at after-journal leaves the slot behind.
		h.vcs.addWorktree(worktreePath(h.vcs.commonDir(), h.store.runId, `step-${first.key}`), first.commit!);
		const again = await h.executor({ store: h.reopen() }).run("add the feature");
		expect(again).toEqual({ ...first, reused: true });
		h.assertClean();
	}));

	it("removes a leftover slot worktree when adopting a pinned ref", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		await expect(h.executor({ faults: crashAt("after-ref") }).run("add the feature")).rejects.toThrow("crash at after-ref");
		const key = stepKey(stepId("agent", "worker", "add the feature"), 0);
		h.vcs.addWorktree(worktreePath(h.vcs.commonDir(), h.store.runId, `step-${key}`), h.vcs.readRef(stepRef(h.store.runId, key))!);
		const adopted = await h.executor({ store: h.reopen() }).run("add the feature");
		expect(adopted).toMatchObject({ status: "ok", reused: true });
		expect(h.runner.calls).toHaveLength(1);
		h.assertClean();
	}));

	it("reruns a step with a schema instead of adopting it when its reply is unreadable", () => withRun(async (h) => {
		h.runner.add({ ...FEATURE, data: { files: 1 } });
		await expect(h.executor({ faults: crashAt("after-ref") }).run("add the feature", { schema: { type: "object" } })).rejects.toThrow("crash at after-ref");
		const ref = h.vcs.trailers(h.vcs.readRef(stepRef(h.store.runId, stepKey(stepId("agent", "worker", "add the feature"), 0)))!)["herder-reply"]!;
		rmSync(join(h.store.paths.dir, ref));
		const result = await h.executor().run("add the feature", { schema: { type: "object" } });
		expect(result).toMatchObject({ status: "ok", data: { files: 1 }, reused: false });
		expect(h.runner.calls).toHaveLength(2);
		h.assertClean();
	}));

	it("refuses to adopt a ref whose commit is not on the step's base", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		await expect(h.executor({ faults: crashAt("after-ref") }).run("add the feature")).rejects.toThrow("crash at after-ref");
		const ref = stepRef(h.store.runId, stepKey(stepId("agent", "worker", "add the feature"), 0));
		const pinned = h.vcs.readRef(ref)!;
		const other = h.fixture.commit("second", { "other.txt": "o\n" });
		h.fixture.git("reset", "-q", "--hard", h.head);
		h.vcs.updateRef(ref, h.vcs.commitTree(h.vcs.treeOf(pinned), [other], h.vcs.message(pinned)));
		const result = await h.executor().run("add the feature");
		expect(result.reused).toBe(false);
		expect(h.vcs.parentsOf(result.commit!)).toEqual([h.head]);
		expect(h.runner.calls).toHaveLength(2);
	}));

	it("discards a stale ref with another fingerprint and runs live", () => withRun(async (h) => {
		h.runner.add(FEATURE);
		const first = await h.executor().run("add the feature", { id: "task" });
		const changed = await h.executor().run("add the feature", { id: "task", gate: "has-feature" });
		expect(changed.key).toBe(first.key);
		expect(changed.reused).toBe(false);
		expect(h.vcs.readRef(stepRef(h.store.runId, changed.key))).toBe(changed.commit);
		expect(h.runner.calls).toHaveLength(2);
	}));

	it.each([
		["before-worktree", 1], ["after-agent", 2], ["after-commit", 2], ["after-ref", 1], ["after-journal", 1],
	] as const)("resumes after a crash at %s", (point, runnerCalls) => withRun(async (h) => {
		h.runner.add(FEATURE);
		await expect(h.executor({ faults: crashAt(point) }).run("add the feature")).rejects.toThrow(`crash at ${point}`);
		expect(failures(h.events())).toHaveLength(0);
		h.assertClean();
		const resumed = await h.executor({ store: h.reopen() }).run("add the feature");
		expect(resumed.status).toBe("ok");
		expect(h.fixture.git("show", `${resumed.commit}:feature.txt`)).toBe("feature");
		expect(h.vcs.readRef(stepRef(h.store.runId, resumed.key))).toBe(resumed.commit);
		expect(h.runner.calls).toHaveLength(runnerCalls);
		expect(completions(h.events())).toHaveLength(1);
		h.assertClean();
	}));
});
