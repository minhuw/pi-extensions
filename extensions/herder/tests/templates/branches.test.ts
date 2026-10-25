import { describe, expect, it } from "vitest";
import { check, runTemplate, ScriptedBridge, sha } from "./support.ts";
import type { TemplateName } from "./support.ts";

const failing = (tail: string) => ({ status: "gate_failed" as const, checks: [check("unit-tests", false, tail)] });
const passing = { status: "ok" as const, checks: [check("unit-tests", true)] };

/** Runs a template, requires it to complete with a JSON value and no id misuse, and returns that value. */
async function run(name: TemplateName, args: unknown, bridge: ScriptedBridge) {
	const outcome = await runTemplate(name, args, bridge);
	expect(bridge.violations).toEqual([]);
	expect(outcome.error).toBeUndefined();
	expect(outcome.status).toBe("completed");
	expect(JSON.parse(JSON.stringify(outcome.value))).toEqual(outcome.value);
	for (const call of bridge.agents) expect(call.opts.id, call.prompt.slice(0, 40)).toMatch(/^[a-z]+-[A-Za-z0-9-]+$/);
	return outcome.value as Record<string, unknown>;
}

describe("sequential.js", () => {
	const args = { task: "T1", prompt: "Add the parser.", gate: "unit-tests", message: "feat: parser" };

	it("fixes one failed gate and integrates the fix", async () => {
		const bridge = new ScriptedBridge({ "impl-T1": failing("FAIL parser.test.ts:12:3 expected 1"), "fix-T1-1": passing });
		const value = await run("sequential", args, bridge);
		expect(bridge.ids()).toEqual(["impl-T1", "fix-T1-1"]);
		const fix = bridge.call("fix-T1-1");
		expect(fix.opts).toMatchObject({ base: sha("impl-T1"), gate: "unit-tests", task: "T1" });
		expect(fix.prompt).toContain("FAIL parser.test.ts:12:3 expected 1");
		expect(bridge.integrations).toHaveLength(1);
		expect(bridge.integrations[0]!.source).toMatchObject({ key: "fix-T1-1-0", commit: sha("fix-T1-1") });
		expect(bridge.integrations[0]!.opts).toEqual({ message: "feat: parser", task: "T1" });
		expect(value).toEqual({ task: "T1", status: "integrated", attempts: 1, head: bridge.head });
	});

	it("stops when the same gate fails with the same normalized output twice", async () => {
		const bridge = new ScriptedBridge({
			"impl-T1": failing("FAIL parser.test.ts:12:3 expected 1 (12ms) at 2026-10-25T10:00:00Z in 1a2b3c4d5e"),
			"fix-T1-1": failing("FAIL parser.test.ts:12:3 expected 1 (31ms) at 2026-10-25T10:04:12Z in 9f8e7d6c5b"),
		});
		const value = await run("sequential", args, bridge);
		expect(bridge.ids()).toEqual(["impl-T1", "fix-T1-1"]);
		expect(bridge.integrations).toEqual([]);
		expect(value).toMatchObject({ status: "gate_failed", attempts: 1, failures: ["unit-tests"], note: expect.stringMatching(/same output twice/) });
	});

	it("keeps fixing distinct failures up to the cap, then reports without integrating", async () => {
		const bridge = new ScriptedBridge({ "impl-T1": failing("FAIL a.test.ts:1:1"), "fix-T1-1": failing("FAIL a.test.ts:2:1"), "fix-T1-2": failing("FAIL a.test.ts:3:1") });
		const value = await run("sequential", { ...args, maxAttempts: 2 }, bridge);
		expect(bridge.ids()).toEqual(["impl-T1", "fix-T1-1", "fix-T1-2"]);
		expect(bridge.call("fix-T1-2").opts.base).toBe(sha("fix-T1-1"));
		expect(bridge.integrations).toEqual([]);
		expect(value).toMatchObject({ status: "gate_failed", attempts: 2, failures: ["unit-tests"] });
	});

	it("does not integrate when the review step fails", async () => {
		const bridge = new ScriptedBridge({ "impl-T1": passing, "review-T1": { status: "failed", error: { class: "invalid_output", message: "no structured output" } } });
		const value = await run("sequential", { ...args, review: true }, bridge);
		const review = bridge.call("review-T1");
		expect(review.opts).toMatchObject({ role: "reviewer", base: sha("impl-T1"), schema: expect.objectContaining({ type: "object" }) });
		expect(review.result.commit).toBeUndefined();
		expect(bridge.integrations).toEqual([]);
		expect(value).toMatchObject({ status: "review_failed", attempts: 0, error: { class: "invalid_output" } });
	});

	it("fixes blocking review findings once and integrates without a second review", async () => {
		const finding = { severity: "high", file: "src/parser.ts", line: 4, issue: "drops the last line", evidence: "loop bound is length - 1" };
		const bridge = new ScriptedBridge({ "impl-T1": passing, "review-T1": { status: "ok", data: { findings: [finding, { ...finding, severity: "low", issue: "naming" }] } }, "fix-T1-1": passing });
		const value = await run("sequential", { ...args, review: true }, bridge);
		expect(bridge.ids()).toEqual(["impl-T1", "review-T1", "fix-T1-1"]);
		expect(bridge.call("fix-T1-1").prompt).toContain("drops the last line");
		expect(bridge.call("fix-T1-1").prompt).not.toContain("naming");
		expect(bridge.integrations.map(call => (call.source as { key: string }).key)).toEqual(["fix-T1-1-0"]);
		expect(value).toMatchObject({ status: "integrated", attempts: 1 });
	});
});

describe("disjoint.js", () => {
	const task = (id: string) => ({ id, prompt: `Implement ${id}.`, owns: [`src/${id.toLowerCase()}/**`], gate: "unit-tests", message: `feat(${id}): implement` });
	const args = { tasks: [task("T1"), task("T2"), task("T3")] };

	it("integrates three disjoint tasks serially in task order", async () => {
		const bridge = new ScriptedBridge({ "impl-T1": passing, "impl-T2": passing, "impl-T3": passing });
		const value = await run("disjoint", args, bridge);
		expect([...bridge.ids()].sort()).toEqual(["impl-T1", "impl-T2", "impl-T3"]);
		expect(bridge.call("impl-T2").prompt).toContain("edit only these paths: src/t2/**");
		expect(bridge.integrations.map(call => [(call.source as { key: string }).key, call.opts.message, call.opts.task])).toEqual([
			["impl-T1-0", "feat(T1): implement", "T1"], ["impl-T2-0", "feat(T2): implement", "T2"], ["impl-T3-0", "feat(T3): implement", "T3"],
		]);
		expect(value).toEqual({ head: bridge.head, integrated: ["T1", "T2", "T3"], failed: [] });
	});

	it("resolves one conflict from the current head and integrates the resolver's commit", async () => {
		const bridge = new ScriptedBridge(
			{ "impl-T1": passing, "impl-T2": passing, "impl-T3": passing, "resolve-T2": { status: "ok", text: "Kept both sides.", checks: [check("unit-tests", true)] } },
			[{}, { status: "conflict", conflicts: ["src/shared/index.ts"] }],
		);
		const value = await run("disjoint", args, bridge);
		const headAfterT1 = bridge.integrations[0]!.result.head;
		const resolver = bridge.call("resolve-T2");
		expect(resolver.opts).toMatchObject({ role: "resolver", base: headAfterT1, task: "T2", gate: "unit-tests" });
		expect(resolver.prompt).toContain("- src/shared/index.ts");
		expect(resolver.prompt).toContain(sha("impl-T2"));
		expect(bridge.integrations.map(call => (call.source as { key: string }).key)).toEqual(["impl-T1-0", "impl-T2-0", "resolve-T2-0", "impl-T3-0"]);
		expect(bridge.integrations[2]!.source).toMatchObject({ commit: sha("resolve-T2") });
		expect(bridge.integrations[2]!.from).toBe(headAfterT1);
		expect(value).toEqual({ head: bridge.head, integrated: ["T1", "T2", "T3"], failed: [] });
	});

	it("reports a resolver that changes nothing and integrates nothing for that task", async () => {
		const bridge = new ScriptedBridge(
			{ "impl-T1": passing, "impl-T2": passing, "impl-T3": passing, "resolve-T2": { status: "no_changes", text: "Both sides rewrite the same function; I cannot keep both." } },
			[{}, { status: "conflict", conflicts: ["src/shared/index.ts"] }],
		);
		const value = await run("disjoint", args, bridge);
		expect(bridge.integrations.map(call => (call.source as { key: string }).key)).toEqual(["impl-T1-0", "impl-T2-0", "impl-T3-0"]);
		expect(value).toEqual({
			head: bridge.head, integrated: ["T1", "T3"],
			failed: [{ task: "T2", status: "conflict", conflicts: ["src/shared/index.ts"], resolver: "no_changes", note: "Both sides rewrite the same function; I cannot keep both." }],
		});
	});

	it("fixes a failed gate inside the task's pipeline before integrating", async () => {
		const bridge = new ScriptedBridge({ "impl-T1": passing, "impl-T2": failing("FAIL b.test.ts:1:1"), "fix-T2-1": passing, "impl-T3": passing });
		const value = await run("disjoint", args, bridge);
		expect(bridge.call("fix-T2-1").opts).toMatchObject({ base: sha("impl-T2"), task: "T2" });
		expect(bridge.integrations.map(call => (call.source as { key: string }).key)).toEqual(["impl-T1-0", "fix-T2-1-0", "impl-T3-0"]);
		expect(value).toMatchObject({ integrated: ["T1", "T2", "T3"], failed: [] });
	});
});

describe("explore.js", () => {
	const args = { task: "T4", prompt: "Make the cache faster.", variants: 3, gate: "unit-tests", message: "perf: cache" };

	it("judges only gate-passing variants and integrates exactly the winner", async () => {
		const bridge = new ScriptedBridge({
			"variant-T4-1": failing("FAIL cache.test.ts:9:1"), "variant-T4-2": passing, "variant-T4-3": passing,
			"judge-T4": { status: "ok", data: { winner: 3, rationale: "smaller diff" } },
		});
		const value = await run("explore", args, bridge);
		const judge = bridge.call("judge-T4");
		expect(judge.opts.role).toBe("reviewer");
		expect(judge.result.commit).toBeUndefined();
		expect(judge.prompt).toContain(sha("variant-T4-2"));
		expect(judge.prompt).toContain(sha("variant-T4-3"));
		expect(judge.prompt).not.toContain(sha("variant-T4-1"));
		expect(judge.opts.schema).toMatchObject({ properties: { winner: { enum: [2, 3] } } });
		expect(bridge.integrations).toHaveLength(1);
		expect(bridge.integrations[0]!.source).toMatchObject({ key: "variant-T4-3-0" });
		expect(value).toMatchObject({ task: "T4", status: "integrated", winner: 3, head: bridge.head, rationale: "smaller diff" });
		expect(value.candidates).toEqual([{ variant: 1, status: "gate_failed" }, { variant: 2, status: "ok" }, { variant: 3, status: "ok" }]);
	});

	it("integrates the only passing variant without a judge", async () => {
		const bridge = new ScriptedBridge({ "variant-T4-1": failing("x"), "variant-T4-2": { status: "failed", error: { class: "timeout", message: "t" } }, "variant-T4-3": passing });
		const value = await run("explore", args, bridge);
		expect(bridge.ids()).not.toContain("judge-T4");
		expect(bridge.integrations.map(call => (call.source as { key: string }).key)).toEqual(["variant-T4-3-0"]);
		expect(value).toMatchObject({ status: "integrated", winner: 3 });
	});

	it("integrates nothing when no variant passes", async () => {
		const bridge = new ScriptedBridge({ "variant-T4-1": failing("a"), "variant-T4-2": failing("b"), "variant-T4-3": { status: "no_changes" } });
		const value = await run("explore", args, bridge);
		expect(bridge.integrations).toEqual([]);
		expect(value).toEqual({ task: "T4", status: "no_candidate", candidates: [{ variant: 1, status: "gate_failed" }, { variant: 2, status: "gate_failed" }, { variant: 3, status: "no_changes" }] });
	});

	it("keeps the first candidate when the judge fails, still integrating exactly one", async () => {
		const bridge = new ScriptedBridge({ "variant-T4-1": passing, "variant-T4-2": passing, "variant-T4-3": passing, "judge-T4": { status: "failed", error: { class: "invalid_output", message: "x" } } });
		const value = await run("explore", { ...args, approaches: ["a", "b", "c"] }, bridge);
		expect(bridge.call("variant-T4-2").prompt).toContain("Approach for this attempt: b");
		expect(bridge.integrations.map(call => (call.source as { key: string }).key)).toEqual(["variant-T4-1-0"]);
		expect(value).toMatchObject({ status: "integrated", winner: 1 });
	});
});

describe("the fake bridge enforces step identity", () => {
	it("rejects an explicit id reused with a different prompt", async () => {
		const bridge = new ScriptedBridge({ "impl-T1": passing });
		const outcome = await runTemplate("disjoint", { tasks: [{ id: "T1", prompt: "a", owns: ["a/**"] }] }, bridge);
		expect(outcome.status).toBe("completed");
		await bridge.agent("other prompt", { id: "impl-T1" }).catch(() => undefined);
		expect(bridge.violations).toEqual(["id impl-T1 reused with a different call"]);
	});
});
