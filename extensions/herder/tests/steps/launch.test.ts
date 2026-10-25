import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createIntegrator } from "../../src/integrate/integrate.ts";
import { sha256Hex } from "../../src/journal/keys.ts";
import { integrationRef, worktreePath } from "../../src/run/paths.ts";
import { launchScript } from "../../src/steps/launch.ts";
import type { ScriptLaunchedEvent, ScriptSettledEvent, StepCompletedEvent } from "../../src/types.ts";
import { deferred, fakeIntegrator, TEST_LIMITS, until, withRun } from "./harness.ts";

const settledEvents = (events: { t: string }[]) => events.filter((event): event is ScriptSettledEvent => event.t === "script.settled");

const SEQUENTIAL = `
const a = await agent("write a.txt", { id: "a", task: "T1", gate: "has-feature" });
if (a.status !== "ok") return { failed: a.status };
const first = await integrate(a, { message: "add a", task: "T1" });
const b = await agent("write b.txt", { id: "b", task: "T2" });
const second = await integrate(b, { message: "add b", task: "T2" });
return { a: a.status, b: b.status, head: second.head };
`;

describe("launchScript", () => {
	it("runs a script, integrates on the logical head, and journals the launch", () => withRun(async (h) => {
		h.runner.add({ match: "write a.txt", files: { "a.txt": "a\n", "feature.txt": "f\n" } }, { match: "write b.txt", files: { "b.txt": "b\n" } });
		const deps = h.launchDeps();
		const handle = launchScript(deps, { source: SEQUENTIAL, args: { n: 1 } });
		expect(handle.launch).toBe(1);
		const outcome = await handle.done;
		expect(outcome).toMatchObject({ launch: 1, status: "completed", reused: 0, changed: 0, new: 2, value: { a: "ok", b: "ok" } });
		const head = h.vcs.readRef(integrationRef(h.store.runId))!;
		expect((outcome.value as { head: string }).head).toBe(head);
		expect(h.fixture.git("ls-tree", "--name-only", head).split("\n").sort()).toEqual(["README.md", "a.txt", "b.txt", "feature.txt"]);
		const starts = h.events().filter((event) => event.t === "step.started");
		expect(starts.map((event) => (event as { base: string }).base)).toEqual([h.head, h.vcs.parentsOf(head)[0]]);
		expect(starts[0]).toMatchObject({ launch: 1, task: "T1" });
		const launched = h.events().find((event): event is ScriptLaunchedEvent => event.t === "script.launched")!;
		expect(launched).toMatchObject({ launch: 1, head: h.head, args: { n: 1 }, scriptSha256: sha256Hex(SEQUENTIAL) });
		expect(settledEvents(h.events())).toMatchObject([{ launch: 1, status: "completed", new: 2 }]);
		expect(JSON.parse(h.store.outputs.read(outcome.resultRef!))).toEqual(outcome.value);
		h.assertClean();
	}));

	it("reuses every step when relaunching the same script from the same head", () => withRun(async (h) => {
		h.runner.add({ match: "write a.txt", files: { "a.txt": "a\n", "feature.txt": "f\n" } }, { match: "write b.txt", files: { "b.txt": "b\n" } });
		const integrator = fakeIntegrator(h.store, h.vcs);
		const first = await launchScript(h.launchDeps({ integrator }), { source: SEQUENTIAL }).done;
		const second = await launchScript(h.launchDeps({ integrator, store: h.reopen() }), { source: SEQUENTIAL, resume: 1 }).done;
		expect(second).toMatchObject({ launch: 2, status: "completed", reused: 2, changed: 0, new: 0, value: first.value });
		expect(h.runner.calls).toHaveLength(2);
		expect(integrator.calls).toEqual(["add a", "add b"]);
		expect(h.events().find((event): event is ScriptLaunchedEvent => event.t === "script.launched" && event.launch === 2)).toMatchObject({ head: h.head, resumes: 1 });
		h.assertClean();
	}));

	it("gives queued pipeline steps the head at call time, so a resume reuses them", () => withRun(async (h) => {
		// The delay lets the script's integrate() reach the host while the next queued agent runs, as with a real agent.
		h.runner.add({ match: /^write/, delayMs: 50, files: (request) => ({ [`${request.prompt.slice(6, 7)}.txt`]: "x\n" }) });
		const source = `return (await pipeline(["a", "b", "c"], (x) => agent("write " + x, { id: x }), (s, x) => integrate(s, { message: "add " + x }))).map((r) => r.status);`;
		const integrator = fakeIntegrator(h.store, h.vcs);
		const limits = { ...TEST_LIMITS, concurrentAgents: 1 };
		const first = await launchScript(h.launchDeps({ integrator, limits }), { source }).done;
		expect(first).toMatchObject({ status: "completed", new: 3, value: ["integrated", "integrated", "integrated"] });
		const second = await launchScript(h.launchDeps({ integrator, limits, store: h.reopen() }), { source, resume: 1 }).done;
		expect(second).toMatchObject({ status: "completed", reused: 3, changed: 0, new: 0, value: first.value });
		expect(h.runner.calls).toHaveLength(3);
		expect(integrator.calls).toEqual(["add a", "add b", "add c"]);
		h.assertClean();
	}));

	it("reruns only a changed step and the dependents whose prompts embed its output", () => withRun(async (h) => {
		h.runner.add({ match: /^(explore|summarize)/, text: (request) => `[${request.prompt}]` });
		const source = `
const [a, b] = await parallel([
	() => agent("explore A " + args.topic, { id: "a", role: "explorer" }),
	() => agent("explore B", { id: "b", role: "explorer" }),
]);
const c = await agent("summarize " + a.text, { id: "c", role: "explorer" });
const d = await agent("summarize " + b.text, { id: "d", role: "explorer" });
return [c.text, d.text];
`;
		await launchScript(h.launchDeps(), { source, args: { topic: "one" } }).done;
		const outcome = await launchScript(h.launchDeps(), { source, args: { topic: "two" } }).done;
		expect(outcome).toMatchObject({ status: "completed", reused: 2, changed: 2, new: 0, value: ["[summarize [explore A two]]", "[summarize [explore B]]"] });
		expect(h.runner.calls.map((call) => call.prompt).slice(4).sort()).toEqual(["explore A two", "summarize [explore A two]"]);
		h.assertClean();
	}));

	it("never reuses a runtime failure but reuses gate_failed", () => withRun(async (h) => {
		h.runner.add({ match: "flaky", fail: "transient" }, { match: "gated", files: { "x.txt": "x" } });
		const source = `
const flaky = await agent("flaky", { id: "flaky" });
const gated = await agent("gated", { id: "gated", gate: "always-fails" });
return [flaky.status, flaky.error && flaky.error.class, gated.status];
`;
		const first = await launchScript(h.launchDeps(), { source }).done;
		expect(first.value).toEqual(["failed", "transient", "gate_failed"]);
		expect(h.runner.callsMatching("flaky")).toHaveLength(3);
		const second = await launchScript(h.launchDeps(), { source, resume: 1 }).done;
		expect(second).toMatchObject({ value: first.value, reused: 1, new: 1 });
		expect(h.runner.callsMatching("flaky")).toHaveLength(6);
		expect(h.runner.callsMatching("gated")).toHaveLength(1);
		h.assertClean();
	}));

	it("journals parallel siblings as each settles", () => withRun(async (h) => {
		const slow = deferred();
		let fastJournaledFirst = false;
		h.runner.add({ match: "slow", waitFor: slow.promise, text: "slow" }, { match: "fast", text: "fast" });
		const source = `return await parallel([() => agent("slow", { role: "explorer" }), () => agent("fast", { role: "explorer" })]).then((results) => results.map((r) => r.text));`;
		const deps = h.launchDeps({
			onProgress() {
				const texts = h.events().filter((event): event is StepCompletedEvent => event.t === "step.completed").map((event) => event.text);
				if (texts.length === 1 && texts[0] === "fast") {
					fastJournaledFirst = true;
					slow.resolve();
				}
			},
		});
		const outcome = await launchScript(deps, { source }).done;
		expect(fastJournaledFirst).toBe(true);
		expect(outcome.value).toEqual(["slow", "fast"]);
		h.assertClean();
	}));

	it("stops the script and its in-flight agents", () => withRun(async (h) => {
		h.runner.add({ match: "forever", hang: true });
		const handle = launchScript(h.launchDeps(), { source: `await parallel([() => agent("forever 1"), () => agent("forever 2")]); return "unreachable";` });
		await until(() => h.runner.calls.length === 2);
		handle.stop("user stop");
		const outcome = await handle.done;
		expect(outcome).toMatchObject({ status: "stopped", error: "user stop" });
		expect(outcome.value).toBeUndefined();
		const failed = h.events().filter((event) => event.t === "step.failed");
		expect(failed).toMatchObject([{ errorClass: "stopped", final: true }, { errorClass: "stopped", final: true }]);
		expect(h.types().at(-1)).toBe("script.settled");
		h.assertClean();
	}));

	it("stops agents the script left running when it settles", () => withRun(async (h) => {
		h.runner.add({ match: "orphan", hang: true });
		const outcome = await launchScript(h.launchDeps(), { source: `agent("orphan"); await new Promise((done) => done()); return 1;` }).done;
		expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/never awaited/) });
		expect(h.types().slice(-2)).toEqual(["step.failed", "script.settled"]);
		expect(h.events().find((event) => event.t === "step.failed")).toMatchObject({ errorClass: "stopped", final: true });
		h.assertClean();
	}));

	it("stops an integration the script left running and keeps the head when the launch fails", () => withRun(async (h) => {
		h.runner.add({ match: "write a.txt", files: { "a.txt": "a\n" } });
		const checks = [{ id: "slow", command: "sleep 20", timeoutMs: 60_000, integrate: true }];
		const integrator = createIntegrator({ runId: h.store.runId, store: h.store, vcs: h.vcs, checks });
		const started = Date.now();
		const source = `const a = await agent("write a.txt", { id: "a" }); integrate(a, { message: "add a" }); return 1;`;
		const outcome = await launchScript(h.launchDeps({ integrator }), { source }).done;
		expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/never awaited/) });
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(h.vcs.readRef(integrationRef(h.store.runId))).toBe(h.head);
		expect(h.types()).not.toContain("integrate.completed");
		expect(h.types().at(-1)).toBe("script.settled");
		h.assertClean();
	}));

	it("stops an awaited integration's checks on stop and keeps the head", () => withRun(async (h) => {
		h.runner.add({ match: "write a.txt", files: { "a.txt": "a\n" } });
		const checks = [{ id: "slow", command: "sleep 20", timeoutMs: 60_000, integrate: true }];
		const integrator = createIntegrator({ runId: h.store.runId, store: h.store, vcs: h.vcs, checks });
		const source = `const a = await agent("write a.txt", { id: "a" }); return await integrate(a, { message: "add a" });`;
		const handle = launchScript(h.launchDeps({ integrator }), { source });
		await until(() => existsSync(worktreePath(h.vcs.commonDir(), h.store.runId, "integration")));
		handle.stop("user stop");
		const outcome = await handle.done;
		expect(outcome).toMatchObject({ status: "stopped", error: "user stop" });
		expect(h.vcs.readRef(integrationRef(h.store.runId))).toBe(h.head);
		expect(h.types()).not.toContain("integrate.completed");
		expect(h.types().at(-1)).toBe("script.settled");
		h.assertClean();
	}));

	it("fails the launch when a step call is invalid", () => withRun(async (h) => {
		const outcome = await launchScript(h.launchDeps(), { source: `await agent("x", { role: "nobody" });` }).done;
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toMatch(/unknown role/);
		expect(settledEvents(h.events())).toMatchObject([{ status: "failed" }]);
	}));

	it("journals plan.updated only when plan.md changed", () => withRun(async (h) => {
		writeFileSync(h.store.paths.plan, "- [ ] T1 (AC-1) do it\n");
		await launchScript(h.launchDeps(), { source: "return 1;" }).done;
		await launchScript(h.launchDeps(), { source: "return 2;" }).done;
		const plans = h.events().filter((event) => event.t === "plan.updated");
		expect(plans).toHaveLength(1);
		expect(h.events().find((event) => event.t === "script.launched" && event.launch === 2)).toBeDefined();
	}));

	it("removes leftover step worktrees when a launch starts and keeps other slots", () => withRun(async (h) => {
		h.runner.add({ match: "write a.txt", files: { "a.txt": "a\n", "feature.txt": "f\n" } }, { match: "write b.txt", files: { "b.txt": "b\n" } });
		const first = await launchScript(h.launchDeps(), { source: SEQUENTIAL }).done;
		const completed = h.events().filter((event): event is StepCompletedEvent => event.t === "step.completed");
		const slot = (name: string) => worktreePath(h.vcs.commonDir(), h.store.runId, name);
		// Leftovers of a process that died after journaling, plus a stale slot of a step this script no longer calls.
		for (const event of completed) h.vcs.addWorktree(slot(`step-${event.key}`), event.commit!);
		h.vcs.addWorktree(slot("step-gone"), h.head);
		h.vcs.addWorktree(slot("integration"), h.head);
		const second = await launchScript(h.launchDeps({ store: h.reopen() }), { source: "return 1;" }).done;
		expect(second).toMatchObject({ status: "completed", value: 1 });
		expect(first.status).toBe("completed");
		expect(existsSync(slot("integration"))).toBe(true);
		h.vcs.removeWorktree(slot("integration"));
		h.assertClean();
	}));

	it("rejects an unknown resume launch and a second concurrent launch", () => withRun(async (h) => {
		expect(() => launchScript(h.launchDeps(), { source: "return 1;", resume: 7 })).toThrow(/no such launch/);
		const gate = deferred();
		h.runner.add({ match: "wait", waitFor: gate.promise });
		const first = launchScript(h.launchDeps(), { source: `return (await agent("wait", { role: "explorer" })).status;` });
		expect(() => launchScript(h.launchDeps(), { source: "return 2;" })).toThrow(/in progress/);
		gate.resolve();
		expect((await first.done).value).toBe("ok");
		expect((await launchScript(h.launchDeps(), { source: "return 3;" }).done).value).toBe(3);
	}));
});
