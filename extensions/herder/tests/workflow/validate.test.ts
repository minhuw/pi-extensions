import { describe, expect, it } from "vitest";
import { minimalValue, schemaProblems, validateScript } from "../../src/workflow/validate.ts";

const context = { roles: ["worker", "reviewer"], readOnlyRoles: ["reviewer"], checks: ["unit", "typecheck"] };

describe("validateScript", () => {
	it("accepts a valid script and counts the calls it reached", async () => {
		const report = await validateScript(`
			phase("Implement");
			const step = await agent("implement", { gate: "unit", schema: { type: "object", properties: { verdict: { enum: ["pass", "fail"] }, notes: { type: "array", items: { type: "string" } } }, required: ["verdict"] } });
			if (step.data.verdict !== "pass") throw new Error("unexpected " + step.data.verdict);
			const review = await agent("review", { role: "reviewer", write: false });
			const merged = await integrate(step, { message: "feat: x", checks: ["typecheck"] });
			return { merged: merged.status, review: review.status, notes: step.data.notes.length, commit: step.commit };
		`, context);
		expect(report).toMatchObject({ ok: true, problems: [], agentCalls: 2, integrateCalls: 1 });
		expect(report.note).toMatch(/only the path/);
	});

	it("reports syntax errors with the author's line and column without running", async () => {
		const report = await validateScript(`const a = 1;\nlog("never");\nconst b = ;`, context);
		expect(report.ok).toBe(false);
		expect(report.agentCalls).toBe(0);
		expect(report.problems).toEqual([{ message: expect.stringMatching(/^SyntaxError: Unexpected token/), line: 3, column: 11, severity: "error" }]);
	});

	it("collects option problems per call with their lines and keeps going", async () => {
		const report = await validateScript([
			`const a = await agent("one", { role: "nobody", gate: ["unit", "lint"] });`,
			`const b = await agent("two", { model: "x", timeoutMs: "5" });`,
			`const c = await agent("three", { schema: { type: "list" } });`,
			`await integrate(a, { message: "m", checks: ["e2e"], extra: 1 });`,
			`for (const n of [1, 2]) await agent("loop", { role: "nobody" });`,
			`return [a.status, b.status, c.status];`,
		].join("\n"), context);
		expect(report.ok).toBe(false);
		expect(report.agentCalls).toBe(5);
		const lines = report.problems.map(problem => [problem.line, problem.message]);
		expect(lines).toEqual([
			[1, 'agent() role "nobody" is not a known role. Known roles: worker, reviewer.'],
			[1, 'agent() opts.gate names unknown check "lint". Known checks: unit, typecheck.'],
			[2, expect.stringMatching(/opts\.model is not a recognised option/)],
			[2, "agent() opts.timeoutMs must be a positive number."],
			[3, 'agent() opts.schema: schema must have type "object" at its root.'],
			[3, expect.stringMatching(/unknown type "list"/)],
			[4, expect.stringMatching(/opts\.extra is not a recognised option/)],
			[4, 'integrate() opts.checks names unknown check "e2e". Known checks: unit, typecheck.'],
			[5, 'agent() role "nobody" is not a known role. Known roles: worker, reviewer.'],
		]);
	});

	it("reports a runtime failure in the dry run with its line", async () => {
		const report = await validateScript(`await agent("x");\nundefinedThing();`, context);
		expect(report.ok).toBe(false);
		expect(report.problems).toEqual([{ message: expect.stringMatching(/dry run failed: undefinedThing is not defined/), line: 2, column: 1, severity: "error" }]);
	});

	it("reports invalid options the runtime throws on, without stopping", async () => {
		const report = await validateScript([
			`for (const p of ["a", "b"]) await agent(p, { id: "impl" });`,
			`await agent("same", { id: "again" }); await agent("same", { id: "again" });`,
			`await agent("lint");`,
			`await integrate("abc", { message: "m" });`,
			`await agent("lint");`,
			`await agent("look", { role: "reviewer", write: true });`,
			`await agent("x", { effort: "huge" });`,
			`return 1;`,
		].join("\n"), context);
		expect(report).toMatchObject({ ok: false, agentCalls: 8 });
		expect(report.problems.map(problem => [problem.line, problem.message])).toEqual([
			[1, expect.stringMatching(/^agent\(\) id "impl" is already used at line 1 by a call with different inputs/)],
			[5, expect.stringMatching(/same role and prompt as the call at line 3 but a different base/)],
			[6, 'agent() role "reviewer" is read-only; it cannot run with write: true.'],
			[7, expect.stringMatching(/opts\.effort must be one of off, minimal/)],
		]);
	});

	it("warns instead of failing when the script throws on synthetic results", async () => {
		const script = `const r = await agent("x", { schema: { type: "object", properties: { items: { type: "array" } } } });\nreturn r.data.items[0].name;`;
		const report = await validateScript(script, context);
		expect(report).toMatchObject({ ok: true, agentCalls: 1 });
		expect(report.problems).toEqual([{ message: expect.stringMatching(/threw after receiving synthetic results: Cannot read properties of undefined/), line: 2, column: expect.any(Number), severity: "warning" }]);
		expect((await validateScript(`throw new Error("bad args");`, context)).problems).toMatchObject([{ severity: "error", message: expect.stringMatching(/dry run failed: bad args/) }]);
		for (const read of ["Date.now()", "Math.random()"]) {
			const late = await validateScript(`await agent("x");\nreturn ${read};`, context);
			expect(late, read).toMatchObject({ ok: false, problems: [{ severity: "error", line: 2, message: expect.stringMatching(/is unavailable in Herder scripts/) }] });
		}
	});

	it("warns when integrate() runs beside a parallel() or pipeline() branch", async () => {
		const inside = await validateScript([
			`await parallel([async () => integrate(await agent("a", { id: "a" }), { message: "a" }), () => agent("b", { id: "b" })]);`,
			`await pipeline([1], async (n) => integrate(await agent("c" + n, { id: "c" + n }), { message: "c" }));`,
		].join("\n"), context);
		expect(inside.ok).toBe(true);
		expect(inside.problems.map(problem => [problem.severity, problem.line])).toEqual([["warning", 1], ["warning", 2]]);
		expect(inside.problems[0]!.message).toMatch(/integrate from the top level/);
		const after = await validateScript(`const [a] = await parallel([() => agent("a", { id: "a" })]);\nawait integrate(a, { message: "a" });`, context);
		expect(after).toMatchObject({ ok: true, problems: [] });
	});

	it("only warns about a reused id whose calls differ in an explicit base alone", async () => {
		const report = await validateScript(`await agent("x", { id: "x", base: args.head });\nawait agent("x", { id: "x" });`, { ...context, args: { head: "abc123" } });
		expect(report).toMatchObject({ ok: true, problems: [{ severity: "warning", line: 2, message: expect.stringMatching(/Only the base differs/) }] });
	});

	it("passes args to the dry run", async () => {
		const script = `return await parallel(args.tasks.map(task => () => agent("do " + task, { task })));`;
		expect(await validateScript(script, { ...context, args: { tasks: ["T1", "T2"] } })).toMatchObject({ ok: true, agentCalls: 2 });
		expect((await validateScript(script, context)).ok).toBe(false);
	});

	it("treats a dry run that runs out of time as a warning", async () => {
		const report = await validateScript(`await agent("x");\nwhile (true) {}`, { ...context, budgetMs: 200 });
		expect(report.ok).toBe(true);
		expect(report.problems).toEqual([{ message: expect.stringMatching(/did not finish within 200 ms/), severity: "warning" }]);
	});

	it("never calls a real bridge", async () => {
		// The dry run has no bridge parameter at all; a script that loops on results stops at the agent cap.
		const report = await validateScript(`while (true) await agent("again");`, { ...context, limits: { agentsPerLaunch: 5, agentsPerRun: 5, concurrentAgents: 1, concurrentWriters: 1, itemsPerCall: 10, timeoutMs: 1, stallMs: 1, retryBackoffMs: [], stallRestarts: 0 } });
		expect(report).toMatchObject({ ok: false, agentCalls: 5 });
		expect(report.problems[0]!.message).toMatch(/limit of 5 agents per launch/);
	});
});

describe("schema helpers", () => {
	it("flags structural problems", () => {
		expect(schemaProblems({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toEqual([]);
		expect(schemaProblems([])).toEqual(["schema must be a JSON Schema object."]);
		expect(schemaProblems({ type: "object", properties: [], required: "a" })).toEqual([
			"schema.properties must be an object.",
			"schema.required must be an array of property names.",
		]);
		expect(schemaProblems({ type: "object", properties: { a: { type: "array", items: { type: "strng" } } } })).toEqual([
			'schema.properties.a.items has unknown type "strng"; use one of object, array, string, number, integer, boolean, null.',
		]);
	});

	it("builds a minimal value", () => {
		expect(minimalValue({ type: "object", properties: { s: { type: "string" }, n: { type: "integer", minimum: 1 }, b: { type: "boolean" }, e: { enum: ["x", "y"] }, l: { type: "array", minItems: 1, items: { type: "number" } }, o: { type: "object", properties: { z: { type: ["null", "string"] } } } } }))
			.toEqual({ s: "", n: 1, b: false, e: "x", l: [0], o: { z: null } });
	});
});
