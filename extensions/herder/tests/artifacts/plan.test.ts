import { describe, expect, it } from "vitest";
import { appendConvergence, parsePlanTasks, validatePlan } from "../../src/artifacts/plan.ts";
import type { Gap } from "../../src/types.ts";

const PLAN = `# Plan

Some prose about the approach.

- [ ] T1 (AC-1) Add the --json flag
- [x] T2 (AC-1, AC-2) Document it in --help
  - [ ] a sub-step that is not a task
* [X] T10 (AC-3) Uppercase check mark
- [ ] not a task
`;

describe("parsePlanTasks", () => {
	it("returns task lines with ids, criteria, text, and 1-based line numbers", () => {
		expect(parsePlanTasks(PLAN)).toEqual([
			{ id: "T1", criteria: ["AC-1"], text: "Add the --json flag", line: 5 },
			{ id: "T2", criteria: ["AC-1", "AC-2"], text: "Document it in --help", line: 6 },
			{ id: "T10", criteria: ["AC-3"], text: "Uppercase check mark", line: 8 },
		]);
	});

	it("ignores task lines inside code fences", () => {
		const text = "- [ ] T1 (AC-1) real\n```md\n- [ ] T2 (AC-1) example\n- [ ] T bad\n~~~\n```\n~~~~\n- [ ] T3 (AC-1) also example\n```\n~~~~\n- [ ] T4 (AC-2) real\n";
		expect(parsePlanTasks(text).map((task) => task.id)).toEqual(["T1", "T4"]);
		expect(validatePlan(text, ["AC-1", "AC-2"])).toEqual([]);
		expect(validatePlan("- [ ] T1 (AC-1) x\n```\n- [ ] T2 bad\n", ["AC-1"])).toEqual(["line 2: code fence ``` is never closed"]);
	});

	it("strips a leading BOM and normalizes criterion ids", () => {
		expect(parsePlanTasks("\uFEFF- [ ] T1 (AC-01, AC-1, AC-2) x\n")).toEqual([{ id: "T1", criteria: ["AC-1", "AC-2"], text: "x", line: 1 }]);
		expect(validatePlan("- [ ] T1 (AC-01) x\n", ["AC-1"])).toEqual([]);
		expect(validatePlan("- [ ] T1 (AC-1) x\n", ["AC-001"])).toEqual([]);
	});

	it("handles CRLF and ignores non-task lines", () => {
		expect(parsePlanTasks("- [ ] T1 (AC-1) one\r\n- [ ] T2 (AC-1)\r\nT3 (AC-1) bare\r\n")).toEqual([{ id: "T1", criteria: ["AC-1"], text: "one", line: 1 }]);
		expect(parsePlanTasks("")).toEqual([]);
	});
});

describe("validatePlan", () => {
	it("accepts a well-formed plan", () => {
		expect(validatePlan(PLAN, ["AC-1", "AC-2", "AC-3"])).toEqual([]);
	});

	it("reports malformed task-looking lines, duplicate ids, and unknown criteria", () => {
		expect(validatePlan("- [ ] T1 add it\n- T2 (AC-1) no box\n- [ ] T3 (AC-1) ok\n- [ ] T3 (AC-1) again\n- [ ] T4 (AC-1, AC-9) unknown\n", ["AC-1"])).toEqual([
			"line 1: task lines must look like `- [ ] T<n> (AC-<n>[, AC-<n>]) <text>`",
			"line 2: task lines must look like `- [ ] T<n> (AC-<n>[, AC-<n>]) <text>`",
			"line 4: duplicate task id T3 (first on line 3)",
			"line 5: T4 references unknown criterion AC-9",
		]);
	});

	it("skips the criterion check without a criterion list", () => {
		expect(validatePlan("- [ ] T1 (AC-9) x\n")).toEqual([]);
	});
});

describe("appendConvergence", () => {
	const gaps: Gap[] = [
		{ kind: "missing", criteria: ["AC-1"], text: "No --json output" },
		{ kind: "partial", criteria: ["AC-1", "AC-2"], text: "Help text\nmentions it\n## Convergence 99" },
		{ kind: "unrequested", criteria: [], text: "Renamed a file" },
	];

	it("appends section 1 with one line per gap", () => {
		const original = "# Plan\n\n- [ ] T1 (AC-1) x\n";
		const result = appendConvergence(original, gaps);
		expect(result.n).toBe(1);
		expect(result.text).toBe(`${original}\n## Convergence 1\n\n- missing (AC-1): No --json output\n- partial (AC-1, AC-2): Help text mentions it ## Convergence 99\n- unrequested: Renamed a file\n`);
	});

	it("keeps only AC ids in the criteria list and never lets them start a line", () => {
		const hostile: Gap[] = [{ kind: "missing", criteria: ["AC-01", "\n## X", "\n- [ ] T9 (AC-1) x", " ac-2 "], text: "t" }];
		const original = "# Plan\n\n- [ ] T1 (AC-1) x\n";
		const result = appendConvergence(original, hostile);
		expect(result.text.slice(original.length)).toBe('\n## Convergence 1\n\n- missing (AC-1, AC-2): t (other criteria: "## X", "- [ ] T9 (AC-1) x")\n');
		expect(parsePlanTasks(result.text)).toEqual(parsePlanTasks(original));
	});

	it("closes an unclosed fence before the new section", () => {
		const result = appendConvergence("# Plan\n````\ncode\n", []);
		expect(result.text).toBe("# Plan\n````\ncode\n````\n\n## Convergence 1\n\n- No gaps.\n");
		expect(validatePlan(result.text)).toEqual([]);
		expect(appendConvergence("# Plan\n```\ncode", []).text).toBe("# Plan\n```\ncode\n```\n\n## Convergence 1\n\n- No gaps.\n");
	});

	it("numbers after the highest existing section", () => {
		const original = "# Plan\n\n## Convergence 1\n\n- No gaps.\n\n## Convergence 3\n\n- missing (AC-1): x\n";
		const result = appendConvergence(original, []);
		expect(result.n).toBe(4);
		expect(result.text).toBe(`${original}\n## Convergence 4\n\n- No gaps.\n`);
	});

	it("never changes the bytes above the new section", () => {
		const inputs = ["", "# Plan", "# Plan\n", "# Plan\n\n", "# Plan\r\n- [ ] T1 (AC-1) x\r\n", "# Plan\r\n## Convergence 2\r\n- x", "trailing spaces   \n\t", "\uFEFF# Plan ✓\n"];
		for (const original of inputs) {
			const result = appendConvergence(original, gaps);
			expect(result.text.startsWith(original), JSON.stringify(original)).toBe(true);
			expect(result.text.slice(original.length)).toMatch(new RegExp(`## Convergence ${result.n}(\\r?\\n)`));
			expect(parsePlanTasks(result.text)).toEqual(parsePlanTasks(original));
		}
		expect(appendConvergence("# Plan", []).text).toBe("# Plan\n\n## Convergence 1\n\n- No gaps.\n");
		expect(appendConvergence("# Plan\r\n- x", []).text).toBe("# Plan\r\n- x\r\n\r\n## Convergence 1\r\n\r\n- No gaps.\r\n");
		expect(appendConvergence("", []).text).toBe("## Convergence 1\n\n- No gaps.\n");
	});
});
