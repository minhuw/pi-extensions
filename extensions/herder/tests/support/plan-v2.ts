/** Explicit dependency guarantees for deterministic fixture graphs. */
export function fixtureDependencies(dependencies: string): string {
	if (dependencies === "none") return "Dependencies: none.";
	return [
		"| Plan | Consumes |",
		"|---|---|",
		...dependencies.split(/\s*,\s*/).map((id) => `| ${id} | Plan ${id}'s reviewed fixture transition is integrated before this target starts. |`),
	].join("\n");
}

export interface FixturePlanOptions {
	id?: string;
	title?: string;
	head?: string;
	plannedAt?: string;
	dependencies?: string;
	parentObjective?: string;
	writePaths?: string[];
	startingCondition?: string;
	acceptance?: string;
	acceptanceRows?: Array<{ id: string; requiredBehavior: string; proof: string }>;
	implementation?: string;
	verificationCommand?: string;
	verificationRows?: Array<{ id: string; criteria: string; command: string; expected: string }>;
	toolchainOwner?: string;
	toolchainPrerequisites?: string;
	toolchainEvidence?: string;
}

/** Small valid plan for manager/adapter setup; scenario-specific facts stay explicit at call sites. */
export function fixturePlan(options: FixturePlanOptions = {}): string {
	const {
		id = "001",
		title = "Update the fixture value",
		head = "abc1234",
		plannedAt = "2026-08-10",
		dependencies = "none",
		parentObjective = "Exercise the deterministic manager fixture.",
		writePaths = ["src/value.mjs"],
		startingCondition = "The stated fixture assumptions and direct interfaces still hold.",
		acceptance = "The manager preserves the fixture's declared behavior.",
		acceptanceRows = [{ id: "A1", requiredBehavior: acceptance, proof: "V1" }],
		implementation = "Keep the fixture bounded to the declared write paths.",
		verificationCommand = "node --version",
		verificationRows = [{ id: "V1", criteria: "A1", command: verificationCommand, expected: "exit 0; the focused fixture assertion passes" }],
		toolchainOwner = "npm project scripts",
		toolchainPrerequisites = "Node >=22.19; repository locked dependencies installed",
		toolchainEvidence = "`package.json`; `package-lock.json`",
	} = options;
	const dependencyText = fixtureDependencies(dependencies);
	const escapedPaths = writePaths.map((value) => `- \`${value}\``).join("\n");
	return `# Plan ${id}: ${title}

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: ${dependencies}
- **Category**: tests
- **Planned at**: commit \`${head}\`, ${plannedAt}
- **Kind**: behavioral
- **Parent objective**: ${parentObjective}

## Outcome and acceptance

${acceptance}

| ID | Required behavior | Proof |
|---|---|---|
${acceptanceRows.map(({ id, requiredBehavior, proof }) => `| ${id} | ${requiredBehavior} | ${proof} |`).join("\n")}

## Boundaries

**Write paths**
${escapedPaths}

**Out of scope**:
- Manager state, plan graph files, and undeclared fixture paths.

## Starting conditions

**Observed baseline**

- ${startingCondition}

**Required starting state**

${startingCondition}

**Expected dependency changes**

${dependencyText}

## Implementation route

### Step 1: Keep the fixture bounded

${implementation}

## Verification

| ID | Phase | Criteria | Toolchain | Command | Expected |
|---|---|---|---|---|---|
${verificationRows.map(({ id, criteria, command, expected }) => `| ${id} | acceptance | ${criteria} | T1 | \`${command}\` | ${expected} |`).join("\n")}

| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
|---|---|---|---|---|---|
| T1 | ${toolchainOwner} | . | ${toolchainPrerequisites} | \`node --version\` | ${toolchainEvidence} |

## Escalation and handoff

- **Provides**: the bounded fixture behavior described above.
- **Safe intermediate state**: only declared paths change.

Stop if the stated fixture assumptions or direct interfaces no longer hold.

Environment or invocation failure: report the exact command, cwd, error, and missing prerequisite; do not guess a substitute.
`;
}
