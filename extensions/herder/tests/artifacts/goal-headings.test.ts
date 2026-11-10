import { describe, expect, it } from "vitest";
import { type Goal, GoalError, parseGoal } from "../../src/artifacts/goal.ts";

// Line numbers in the cases count from this array: `## Intent` is line 3, `## Budget` line 20.
const VALID = [
	"# Goal: t", "",
	"## Intent", "Why.", "",
	"## Acceptance criteria", "- AC-1: x. verify: check:unit", "",
	"## Checks", "| id | command | timeout | integrate |", "| --- | --- | --- | --- |", "| unit | npm test | 10m | yes |", "",
	"## Constraints", "- keep the output", "",
	"## Out of scope", "- other commands", "",
	"## Budget", "max_agents: 40",
];
const PARSED: Goal = {
	title: "t",
	intent: "Why.",
	criteria: [{ id: "AC-1", text: "x.", verify: { kind: "check", checks: ["unit"] } }],
	checks: [{ id: "unit", command: "npm test", timeoutMs: 600_000, integrate: true }],
	constraints: ["keep the output"],
	outOfScope: ["other commands"],
	budget: { maxAgents: 40 },
};

const rename = (from: string, to: string) => VALID.map((line) => (line === from ? to : line)).join("\n");
const insert = (after: number, ...lines: string[]) => [...VALID.slice(0, after), ...lines, ...VALID.slice(after)].join("\n");
const unknown = (n: number, heading: string) =>
	`line ${n}: unknown heading \`${heading}\`; the only headings are the \`# Goal:\` title and the sections intent, acceptance criteria, criteria, checks, constraints, out of scope, budget`;

const problemsOf = (text: string): string[] => {
	try { parseGoal(text); } catch (error) {
		expect(error).toBeInstanceOf(GoalError);
		return (error as GoalError).problems;
	}
	throw new Error("expected parseGoal to throw");
};

describe("parseGoal headings", () => {
	it("parses the base goal", () => {
		expect(parseGoal(VALID.join("\n"))).toEqual(PARSED);
	});

	it.each<{ name: string; text: string; problems: string[] }>([
		{ name: "an unknown `##` section", text: insert(21, "", "## Notes", "- remember this"), problems: [unknown(23, "## Notes")] },
		{ name: "an unknown `#` heading", text: insert(5, "# Background", "Long ago.", ""), problems: [unknown(6, "# Background")] },
		{ name: "an unknown `######` heading", text: insert(4, "###### Fine print ######"), problems: [unknown(5, "###### Fine print ######")] },
		{ name: "a heading before the title", text: ["## Preface", ...VALID].join("\n"), problems: [unknown(1, "## Preface")] },
		{ name: "`## Constraint`", text: rename("## Constraints", "## Constraint"), problems: [unknown(14, "## Constraint")] },
		{ name: "`## Budgets`", text: rename("## Budget", "## Budgets"), problems: [unknown(20, "## Budgets")] },
		// The table under the misspelled heading is not read, so the criterion's check is unknown too.
		{ name: "`## Check`", text: rename("## Checks", "## Check"), problems: [unknown(9, "## Check"), "line 7: AC-1 references unknown check \"unit\" (declared: none)"] },
		{ name: "a `###` sub-heading inside a section", text: insert(15, "### Details", "- and the exit code"), problems: [unknown(16, "### Details")] },
		{ name: "a second `# Goal:` line", text: insert(21, "", "# Goal: another"), problems: [unknown(23, "# Goal: another")] },
		{ name: "a CRLF file", text: rename("## Budget", "## Budgets").replace(/\n/g, "\r\n"), problems: [unknown(20, "## Budgets")] },
	])("refuses $name", ({ text, problems }) => {
		expect(problemsOf(text)).toEqual(problems);
	});

	it("reports every unknown heading together with the other problems", () => {
		const text = insert(15, "### Details").replace("## Intent", "## Summary").replace("max_agents: 40", "max_agents: 0\n\n## Notes\n## Budget");
		expect(problemsOf(text)).toEqual([
			unknown(3, "## Summary"),
			unknown(16, "### Details"),
			unknown(24, "## Notes"),
			"line 25: duplicate `## Budget` section (first on line 21); merge them into one",
			"line 22: budget max_agents must be a positive integer, got \"0\"",
		]);
	});

	it.each<[string, string]>([
		["## Intent", "# intent"], ["## Intent", "## INTENT"], ["## Intent", "###### Intent:"], ["## Intent", "## Intent ##"], ["## Intent", "##\tIntent"],
		["## Acceptance criteria", "## Acceptance Criteria"], ["## Acceptance criteria", "## acceptance-criteria"], ["## Acceptance criteria", "## Acceptance_Criteria:"],
		["## Acceptance criteria", "## Acceptance   criteria #"], ["## Acceptance criteria", "## Criteria"], ["## Acceptance criteria", "### CRITERIA:"],
		["## Checks", "# Checks"], ["## Checks", "## CHECKS:"], ["## Checks", "#### checks ####"],
		["## Constraints", "## constraints"], ["## Constraints", "### Constraints:"], ["## Constraints", "## Constraints #"],
		["## Out of scope", "## Out-of-scope"], ["## Out of scope", "## out_of_scope"], ["## Out of scope", "## Out Of Scope:"], ["## Out of scope", "## OUT OF SCOPE ##"],
		["## Budget", "## budget"], ["## Budget", "## BUDGET:"], ["## Budget", "###### Budget #"],
		["# Goal: t", "# goal: t"], ["# Goal: t", "# GOAL \u2014 t"], ["# Goal: t", "#  Goal - t"], ["# Goal: t", "# Goal:t"],
	])("still reads `%s` written as `%s`", (heading, variant) => {
		expect(parseGoal(rename(heading, variant))).toEqual(PARSED);
	});

	it.each<[string, string[]]>([
		["a backtick fence", ["```md", "## Notes", "### Details", "# Goal: fenced", "```"]],
		["a tilde fence", ["~~~", "## Constraint", "~~~"]],
		["an indented fence", ["  ````", "  ```", "## Budgets", "  ````"]],
	])("ignores headings inside %s", (_name, fence) => {
		expect(parseGoal(insert(4, ...fence))).toEqual({ ...PARSED, intent: ["Why.", ...fence].join("\n") });
	});

	it.each<[string, string[]]>([
		["an HTML comment", ["<!--", "## Notes", "### Details", "# Goal: commented", "-->"]],
		["an HTML comment that ends on a heading line", ["<!-- guidance", "## Check -->"]],
	])("ignores headings inside %s", (_name, comment) => {
		expect(parseGoal(insert(4, ...comment))).toEqual(PARSED);
	});
});
