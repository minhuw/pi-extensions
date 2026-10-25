import { describe, expect, it } from "vitest";
import { BUILTIN_ROLES } from "../../src/config.ts";
import { validateScript } from "../../src/workflow/validate.ts";
import { CHECKS, ROLE_NAMES, template } from "./support.ts";
import type { TemplateName } from "./support.ts";

const validate = (name: TemplateName, args: unknown) => validateScript(template(name), { roles: ROLE_NAMES, checks: CHECKS, args });
const errors = (report: Awaited<ReturnType<typeof validate>>) => report.problems.filter(problem => problem.severity === "error").map(problem => problem.message);

const sequentialArgs = { task: "T1", prompt: "Add the config parser.\nAC-1: …", gate: ["unit-tests", "typecheck"], review: true, maxAttempts: 3, message: "feat(config): add the parser", checks: ["unit-tests"] };
const task = (id: string, owns: string[], extra: object = {}) => ({ id, prompt: `Implement ${id}.`, owns, gate: "unit-tests", message: `feat(${id}): implement`, ...extra });
const disjointArgs = { tasks: [task("T1", ["src/a/**", "tests/a/**"]), task("T2", ["src/b/**"]), task("T3", ["src/c.ts", "docs/c.md"], { checks: ["typecheck"] })], maxAttempts: 2 };
const exploreArgs = { task: "T4", prompt: "Make the cache faster.", variants: 3, approaches: ["an LRU map", "a sorted array", "a trie"], gate: "unit-tests", criteria: "fastest correct", judge: "explorer", message: "perf(cache): faster lookups", checks: ["unit-tests", "typecheck"] };

describe("templates validate against the real runtime", () => {
	it("sees the built-in roles", () => {
		expect([...ROLE_NAMES].sort()).toEqual([...BUILTIN_ROLES].sort());
	});

	it.each([
		["sequential with review", "sequential", sequentialArgs, 2, 1],
		["sequential without review", "sequential", { task: "T1", prompt: "Fix the bug.", gate: "unit-tests", message: "fix: the bug" }, 1, 1],
		["disjoint with three tasks", "disjoint", disjointArgs, 3, 3],
		["explore with three variants and a judge", "explore", exploreArgs, 4, 1],
		["explore with one variant (no judge)", "explore", { ...exploreArgs, variants: 1, approaches: undefined }, 1, 1],
	] as const)("%s", async (_label, name, args, agentCalls, integrateCalls) => {
		const report = await validate(name, args);
		expect(report).toMatchObject({ ok: true, problems: [], agentCalls, integrateCalls });
	});

	describe("bad args fail clearly", () => {
		it.each([
			["sequential", { task: "T1", gate: "unit-tests" }, /args\.prompt is required/],
			["explore", { task: "T1", variants: 2 }, /args\.prompt is required/],
			["explore", { ...exploreArgs, variants: 0 }, /args\.variants must be a positive integer/],
			["sequential", { ...sequentialArgs, maxAttempts: -1 }, /args\.maxAttempts must be a non-negative integer/],
			["disjoint", {}, /args\.tasks must be a non-empty array/],
			["disjoint", { tasks: [] }, /args\.tasks must be a non-empty array/],
			["disjoint", { tasks: [{ id: "T1", prompt: "x", message: "m" }] }, /task T1: owns must be a non-empty array of paths/],
			["disjoint", { tasks: [{ id: "T1", owns: ["src/**"] }] }, /task T1: prompt must be a non-empty string/],
			["disjoint", { tasks: [{ prompt: "x", owns: ["src/**"] }] }, /every task needs a string id/],
			["disjoint", { tasks: [task("T1", ["src/a/**"]), task("T1", ["src/b/**"])] }, /duplicate task id "T1"/],
			["disjoint", { ...disjointArgs, maxAttempts: 1.5 }, /args\.maxAttempts must be a non-negative integer/],
			["disjoint", { tasks: [task("T1", ["src/a/../b/**"])] }, /task T1: owns path "src\/a\/\.\.\/b\/\*\*" contains "\.\."/],
			["disjoint", { tasks: [task("T1", ["src/a/**"]), task("T2", ["../repo/src/a/x.ts"])] }, /task T2: owns path .* contains "\.\."/],
		] as const)("%s %j", async (name, args, message) => {
			const report = await validate(name, args);
			expect(report.ok).toBe(false);
			expect(errors(report)).toEqual([expect.stringMatching(message)]);
			expect(report.agentCalls).toBe(0);
		});

		it.each([
			[["src/a/**"], ["src/a/b.ts"]],
			[["src/a"], ["./src/a/deep/x.ts"]],
			[["src/*.ts"], ["src/b/**"]],
			[["**"], ["docs/x.md"]],
			[["src/a.ts"], ["src/a.ts"]],
			[["lib/"], ["lib/x.js"]],
		])("rejects overlapping ownership %j / %j", async (first, second) => {
			const report = await validate("disjoint", { tasks: [task("T1", first), task("T2", second)] });
			expect(report.ok).toBe(false);
			expect(errors(report)).toEqual([expect.stringMatching(/tasks T1 and T2 own overlapping paths/)]);
			expect(report.agentCalls).toBe(0);
		});

		it("accepts sibling paths that only share a name prefix", async () => {
			const report = await validate("disjoint", { tasks: [task("T1", ["src/a.ts", "src/ab/**"]), task("T2", ["src/a.tsx", "src/abc/**", "src/a"])] });
			expect(errors(report)).toEqual([]);
		});

		it("reports an unknown gate id in each template", async () => {
			for (const [name, args] of [
				["sequential", { ...sequentialArgs, gate: ["unit-tests", "lint"] }],
				["disjoint", { tasks: [task("T1", ["src/a/**"], { gate: "lint" })] }],
				["explore", { ...exploreArgs, gate: "lint" }],
			] as const) {
				const report = await validate(name, args);
				expect(report.ok, name).toBe(false);
				expect(errors(report), name).toEqual([expect.stringMatching(/^agent\(\) opts\.gate names unknown check "lint"\. Known checks: unit-tests, typecheck\.$/)]);
			}
		});

		it("reports unknown integration checks", async () => {
			const report = await validate("sequential", { ...sequentialArgs, checks: ["e2e"] });
			expect(errors(report)).toEqual([expect.stringMatching(/^integrate\(\) opts\.checks names unknown check "e2e"/)]);
		});

		it("reports an unknown judge role in explore", async () => {
			const report = await validate("explore", { ...exploreArgs, judge: "oracle" });
			expect(report.ok).toBe(false);
			expect(errors(report)).toEqual([expect.stringMatching(/^agent\(\) role "oracle" is not a known role\. Known roles: /)]);
		});

		it("reports a non-string gate as an invalid option", async () => {
			const report = await validate("sequential", { ...sequentialArgs, gate: 3 });
			expect(report.ok).toBe(false);
			expect(errors(report).join("\n")).toMatch(/gate/);
		});
	});
});
