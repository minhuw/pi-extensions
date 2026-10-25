import { describe, expect, it } from "vitest";
import { GoalError, goalDraft, hashGoal, parseDuration, parseGoal } from "../../src/artifacts/goal.ts";
import { DEFAULT_CHECK_TIMEOUT_MS } from "../../src/config.ts";

const EXAMPLE = `# Goal: Add a --json flag to the status command

## Intent
Scripts need machine-readable status output.

## Acceptance criteria
- AC-1: WHEN the user runs \`status --json\` THE SYSTEM SHALL print one JSON object. verify: check:unit-tests
- AC-2: The help text is clear. verify: judge — rubric: "The --help output documents --json in one sentence"

## Checks
| id | command | timeout | integrate |
| --- | --- | --- | --- |
| unit-tests | npm test | 10m | yes |
| typecheck | npm run typecheck | 5m | yes |

## Constraints
- Must not change the default text output

## Out of scope
- Other commands

## Budget
max_agents: 40
max_fix_attempts: 3
`;

const problemsOf = (text: string): string[] => {
	try { parseGoal(text); } catch (error) {
		expect(error).toBeInstanceOf(GoalError);
		return (error as GoalError).problems;
	}
	throw new Error("expected parseGoal to throw");
};

const withCriteria = (criteria: string, checks = "| unit-tests | npm test | 10m | yes |") =>
	`# Goal: t\n\n## Acceptance criteria\n${criteria}\n\n## Checks\n| id | command | timeout | integrate |\n| --- | --- | --- | --- |\n${checks}\n`;

describe("parseGoal", () => {
	it("parses the documented example", () => {
		expect(parseGoal(EXAMPLE)).toEqual({
			title: "Add a --json flag to the status command",
			intent: "Scripts need machine-readable status output.",
			criteria: [
				{ id: "AC-1", text: "WHEN the user runs `status --json` THE SYSTEM SHALL print one JSON object.", verify: { kind: "check", checks: ["unit-tests"] } },
				{ id: "AC-2", text: "The help text is clear.", verify: { kind: "judge", rubric: "The --help output documents --json in one sentence" } },
			],
			checks: [
				{ id: "unit-tests", command: "npm test", timeoutMs: 600_000, integrate: true },
				{ id: "typecheck", command: "npm run typecheck", timeoutMs: 300_000, integrate: true },
			],
			constraints: ["Must not change the default text output"],
			outOfScope: ["Other commands"],
			budget: { maxAgents: 40, maxFixAttempts: 3 },
		});
	});

	it("tolerates formatting variants a model plausibly writes", () => {
		const goal = parseGoal([
			"# goal:   Variants  ", "", "<!-- guidance -->", "## INTENT", "", "Line one.", "Line two.", "",
			"## Acceptance Criteria", "", "* [ ] **AC-1:** first. verify: check:a, check:b", "",
			"- [x] AC-2 second - verify: judge - rubric: 'single quoted'", "- AC-3: third", "  continues here. Verify: `check:b`.",
			"1. AC-4: fourth. verify: judge — rubric: “curly”.",
			"", "## Checks", "| ID | Command | Timeout | Integrate? |", "|:--|:--|--:|:-:|",
			"| `a` | `grep -c x \\| wc -l` | 1h30m | true |", "| b | echo \\\\n ok |  | No |", "| c | true | 30s | |",
			"## Constraints", "- one", "  wrapped", "- two", "## Out-of-scope", "- nothing", "## Notes", "- AC-9: ignored. verify: check:zzz",
			"## Budget", "- max-fix-attempts: 2",
		].join("\r\n"));
		expect(goal.title).toBe("Variants");
		expect(goal.intent).toBe("Line one.\nLine two.");
		expect(goal.criteria).toEqual([
			{ id: "AC-1", text: "first.", verify: { kind: "check", checks: ["a", "b"] } },
			{ id: "AC-2", text: "second", verify: { kind: "judge", rubric: "single quoted" } },
			{ id: "AC-3", text: "third continues here.", verify: { kind: "check", checks: ["b"] } },
			{ id: "AC-4", text: "fourth.", verify: { kind: "judge", rubric: "curly" } },
		]);
		expect(goal.checks).toEqual([
			{ id: "a", command: "grep -c x | wc -l", timeoutMs: 90 * 60_000, integrate: true },
			{ id: "b", command: "echo \\\\n ok", timeoutMs: DEFAULT_CHECK_TIMEOUT_MS, integrate: false },
			{ id: "c", command: "true", timeoutMs: 30_000, integrate: false },
		]);
		expect(goal.constraints).toEqual(["one wrapped", "two"]);
		expect(goal.outOfScope).toEqual(["nothing"]);
		expect(goal.budget).toEqual({ maxFixAttempts: 2 });
	});

	it("rejects a missing or empty title", () => {
		expect(problemsOf(withCriteria("- AC-1: x. verify: check:unit-tests").replace("# Goal: t", "# Something"))).toEqual(["missing title: the first heading must be `# Goal: <one line>`"]);
		expect(problemsOf(withCriteria("- AC-1: x. verify: check:unit-tests").replace("# Goal: t", "# Goal:"))).toEqual(["line 1: the `# Goal:` title is empty"]);
	});

	it("requires at least one criterion", () => {
		expect(problemsOf("# Goal: t\n")).toEqual(["no acceptance criteria: add `- AC-1: <criterion>. verify: check:<id>` lines under `## Acceptance criteria`"]);
		expect(problemsOf(withCriteria("<!-- - AC-1: x. verify: check:unit-tests -->"))).toHaveLength(1);
	});

	it("rejects malformed criteria with the line and id", () => {
		expect(problemsOf(withCriteria("- no id. verify: check:unit-tests"))).toEqual(["line 4: a criterion must start with an id such as `AC-1:`"]);
		expect(problemsOf(withCriteria("- AC-1: x"))).toEqual(["line 4: AC-1 has no `verify:`; end it with `verify: check:<id>` or `verify: judge — rubric: \"…\"`"]);
		expect(problemsOf(withCriteria("- AC-1: x. verify: check:unit-tests\n- AC-1: y. verify: check:unit-tests"))).toEqual(["line 5: duplicate criterion id AC-1 (first on line 4)"]);
		expect(problemsOf(withCriteria("- AC-1: x. verify: tests pass"))).toEqual(["line 4: AC-1: `verify:` must be `check:<id>[, check:<id>]` or `judge — rubric: \"…\"`, got \"tests pass\""]);
		expect(problemsOf(withCriteria("- AC-1: x. verify: judge"))).toEqual(["line 4: AC-1: a judge criterion needs a non-empty rubric: `verify: judge — rubric: \"<binary statement>\"`"]);
		expect(problemsOf(withCriteria("- AC-1: x. verify: judge — rubric: \"\""))).toHaveLength(1);
	});

	it("rejects references to undeclared checks", () => {
		expect(problemsOf(withCriteria("- AC-1: x. verify: check:unit-tests, check:lint"))).toEqual(["line 4: AC-1 references unknown check \"lint\" (declared: unit-tests)"]);
		expect(problemsOf(withCriteria("- AC-1: x. verify: check:lint", ""))).toEqual(["line 4: AC-1 references unknown check \"lint\" (declared: none)"]);
	});

	it("rejects invalid check rows", () => {
		const ok = "- AC-1: x. verify: check:unit-tests";
		expect(problemsOf(withCriteria(ok, "| unit-tests | npm test | 10m | yes |\n| unit-tests | npm t | 1m | no |"))).toEqual(["line 10: duplicate check id \"unit-tests\" (first on line 9)"]);
		expect(problemsOf(withCriteria(ok, "| unit-tests | npm test | 10m | yes |\n| Unit_Tests | npm t | 1m | no |"))).toEqual(["line 10: check id \"Unit_Tests\" must match /^[a-z0-9][a-z0-9-]*$/ (lowercase letters, digits, hyphens)"]);
		expect(problemsOf(withCriteria(ok, "| unit-tests | npm test | ten minutes | yes |"))).toEqual(["line 9: check unit-tests: invalid timeout \"ten minutes\"; use a duration such as 30s, 10m, 1h, or 1h30m"]);
		expect(problemsOf(withCriteria(ok, "| unit-tests | npm test | 0s | yes |"))).toEqual(["line 9: check unit-tests: invalid timeout \"0s\"; use a duration such as 30s, 10m, 1h, or 1h30m"]);
		expect(problemsOf(withCriteria(ok, "| unit-tests |  | 10m | yes |"))).toEqual(["line 9: check unit-tests has an empty command"]);
		expect(problemsOf(withCriteria(ok, "| unit-tests | npm test | 10m | maybe |"))).toEqual(["line 9: check unit-tests: integrate must be yes or no, got \"maybe\""]);
		expect(problemsOf("# Goal: t\n## Acceptance criteria\n- AC-1: x. verify: check:a\n## Checks\n| name | cmd |\n| --- | --- |\n| a | true |\n")).toEqual([
			"line 5: the Checks table header must include `id` and `command` columns (expected `| id | command | timeout | integrate |`)",
			"line 3: AC-1 references unknown check \"a\" (declared: none)",
		]);
	});

	it("rejects non-positive budget numbers", () => {
		const base = withCriteria("- AC-1: x. verify: check:unit-tests");
		expect(problemsOf(`${base}\n## Budget\nmax_agents: 0\nmax_fix_attempts: two\n`)).toEqual([
			"line 12: budget max_agents must be a positive integer, got \"0\"",
			"line 13: budget max_fix_attempts must be a positive integer, got \"two\"",
		]);
	});

	it("ignores headings, criteria, and table rows inside code fences", () => {
		const goal = parseGoal([
			"# Goal: t", "## Intent", "Run:", "```sh", "# not a heading", "```",
			"## Acceptance criteria", "- AC-1: a. verify: check:unit-tests", "```sh", "# comment", "- AC-9: fenced. verify: check:nope", "```",
			"- AC-2: b. verify: check:unit-tests", "  ````md", "  ```", "  ## Checks", "  ~~~", "  ```` trailing", "  `````", "- AC-3: c. verify: check:unit-tests",
			"## Checks", "| id | command | timeout | integrate |", "| --- | --- | --- | --- |", "| unit-tests | npm test | 10m | yes |",
			"~~~", "| fake | rm -rf / | | |", "~~~", "## Constraints", "- keep this", "  ```", "  - not an item", "  ```", "## Budget", "```", "max_agent: 1", "```",
		].join("\n"));
		expect(goal.intent).toBe("Run:\n```sh\n# not a heading\n```");
		expect(goal.criteria.map((criterion) => criterion.id)).toEqual(["AC-1", "AC-2", "AC-3"]);
		expect(goal.checks.map((check) => check.id)).toEqual(["unit-tests"]);
		expect(goal.constraints).toEqual(["keep this\n  ```\n  - not an item\n  ```"]);
		expect(goal.budget).toEqual({});
	});

	it("rejects an unclosed code fence", () => {
		expect(problemsOf(`${withCriteria("- AC-1: x. verify: check:unit-tests")}\n~~~~\n~~~\n`)).toEqual(["line 11: code fence `~~~~` is never closed"]);
	});

	it("rejects a repeated section, naming both lines", () => {
		const base = withCriteria("- AC-1: x. verify: check:unit-tests");
		expect(problemsOf(`${base}## Checks\n| id | command |\n| --- | --- |\n| lint | npm run lint |\n`)).toEqual(["line 10: duplicate `## Checks` section (first on line 6); merge them into one"]);
		expect(problemsOf(`${base}### Criteria\n- AC-2: y. verify: check:unit-tests\n`)).toEqual(["line 10: duplicate `### Criteria` section (first on line 3); merge them into one"]);
		for (const heading of ["Intent", "Constraints", "Out of scope", "Budget"]) {
			expect(problemsOf(`${base}## ${heading}\n## ${heading}\n`)).toEqual([`line 11: duplicate \`## ${heading}\` section (first on line 10); merge them into one`]);
		}
	});

	it("rejects a second table in Checks and never turns a header row into a check", () => {
		const ok = "- AC-1: x. verify: check:unit-tests";
		const second = "| unit-tests | npm test | 10m | yes |\n\n| id | command | timeout | integrate |\n| --- | --- | --- | --- |\n| lint | npm run lint | | |";
		expect(problemsOf(withCriteria(ok, second))).toEqual(["line 11: second table header in Checks (the table starts on line 7); keep every check in one table"]);
		expect(problemsOf(withCriteria(ok, "| unit-tests | npm test | 10m | yes |\n| ID | Command | Timeout | Integrate |"))).toEqual(["line 10: second table header in Checks (the table starts on line 7); keep every check in one table"]);
	});

	it("splits on the last `verify:` so the criterion text may contain it", () => {
		expect(parseGoal(withCriteria("- AC-1: the CLI prints `verify: ok` when done. verify: check:unit-tests")).criteria).toEqual([
			{ id: "AC-1", text: "the CLI prints `verify: ok` when done.", verify: { kind: "check", checks: ["unit-tests"] } },
		]);
	});

	it("normalizes criterion ids without leading zeros", () => {
		expect(parseGoal(withCriteria("- AC-007: x. verify: check:unit-tests")).criteria[0].id).toBe("AC-7");
		expect(problemsOf(withCriteria("- AC-01: x. verify: check:unit-tests\n- AC-1: y. verify: check:unit-tests"))).toEqual(["line 5: duplicate criterion id AC-1 (first on line 4)"]);
	});

	it("ignores a leading UTF-8 BOM", () => {
		expect(parseGoal(`\uFEFF${EXAMPLE}`)).toEqual(parseGoal(EXAMPLE));
	});

	it("rejects unknown budget keys and lines that are not key: value", () => {
		const base = withCriteria("- AC-1: x. verify: check:unit-tests");
		expect(problemsOf(`${base}\n## Budget\nmax_agent: 40\nplenty\n`)).toEqual([
			"line 12: unknown budget key \"max_agent\"; allowed keys: max_agents, max_fix_attempts",
			"line 13: budget lines must be `<key>: <positive integer>`, got \"plenty\"; allowed keys: max_agents, max_fix_attempts",
		]);
	});

	it("reports every problem at once", () => {
		const problems = problemsOf("## Acceptance criteria\n- AC-1: x\n- AC-2: y. verify: check:nope\n## Checks\n| id | command | timeout | integrate |\n|---|---|---|---|\n| -bad | x | 1d | yes |\n## Budget\nmax_agents: -1\n");
		expect(problems).toHaveLength(6);
		expect(problems[0]).toMatch(/^missing title/);
	});
});

describe("parseDuration", () => {
	it("accepts seconds, minutes, hours, and compounds", () => {
		expect(parseDuration("30s")).toBe(30_000);
		expect(parseDuration("10m")).toBe(600_000);
		expect(parseDuration("1h")).toBe(3_600_000);
		expect(parseDuration(" 1H 30m 5s ")).toBe(5_405_000);
	});

	it("rejects anything else", () => {
		for (const bad of ["", "10", "1d", "1.5m", "0m", "m", "30m1h", "10 minutes"]) expect(() => parseDuration(bad), bad).toThrow(/invalid timeout/);
	});
});

describe("hashGoal", () => {
	const base = "# Goal: x\n\n## Intent\nwhy\n";

	it("is sha256 hex", () => {
		expect(hashGoal(base)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("ignores trailing whitespace, CRLF, and trailing blank lines", () => {
		for (const variant of ["# Goal: x  \n\t\n## Intent \nwhy", "# Goal: x\r\n\r\n## Intent\r\nwhy\r\n", `${base}\n\n  \n`]) expect(hashGoal(variant)).toBe(hashGoal(base));
	});

	it("ignores a leading UTF-8 BOM", () => {
		expect(hashGoal(`\uFEFF${base}`)).toBe(hashGoal(base));
	});

	it("changes on any other byte change", () => {
		for (const variant of [" # Goal: x\n\n## Intent\nwhy\n", "# Goal: x\n\n\n## Intent\nwhy\n", "# Goal: x\n\n## Intent\nWhy\n", "# Goal:  x\n\n## Intent\nwhy\n", "\n# Goal: x\n\n## Intent\nwhy\n"]) expect(hashGoal(variant)).not.toBe(hashGoal(base));
	});
});

describe("goalDraft", () => {
	it("fills in the title, keeps the sections, and does not validate until completed", () => {
		const draft = goalDraft("Add a --json flag\n");
		expect(draft.startsWith("# Goal: Add a --json flag\n")).toBe(true);
		for (const heading of ["## Intent", "## Acceptance criteria", "## Checks", "## Constraints", "## Out of scope", "## Budget"]) expect(draft).toContain(`\n${heading}\n`);
		expect(draft).toMatch(/WHEN .* THE SYSTEM SHALL/);
		expect(problemsOf(draft)).toEqual([expect.stringMatching(/^no acceptance criteria/)]);
	});

	it("validates once a criterion and its check are added", () => {
		const goal = parseGoal(goalDraft("t")
			.replace("## Acceptance criteria\n", "## Acceptance criteria\n- AC-1: WHEN x THE SYSTEM SHALL y. verify: check:unit-tests\n")
			.replace("| --- | --- | --- | --- |\n", "| --- | --- | --- | --- |\n| unit-tests | npm test | 10m | yes |\n"));
		expect(goal.criteria.map((c) => c.id)).toEqual(["AC-1"]);
		expect(goal.checks.map((c) => c.id)).toEqual(["unit-tests"]);
	});
});
