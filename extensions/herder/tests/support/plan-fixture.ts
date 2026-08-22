import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "../../src/daemon/git-driver.ts";

const README = `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|

## Dependency notes

None.

## Considered and rejected

None.
`;

export interface PlanFixtureOptions {
	prefix: string;
	planDirectoryMode?: number;
}

export interface PlanFixture {
	root: string;
	planDirectory: string;
}

export function planFixture({ prefix, planDirectoryMode }: PlanFixtureOptions): PlanFixture {
	const root = mkdtempSync(path.join(os.tmpdir(), prefix));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.name", "Herder Plan Fixture Test"]);
	git(root, ["config", "user.email", "herder-plan-fixture@example.invalid"]);
	const planDirectory = path.join(root, "herder-plans");
	if (planDirectoryMode === undefined) mkdirSync(planDirectory, { recursive: true });
	else mkdirSync(planDirectory, { recursive: true, mode: planDirectoryMode });
	writeFileSync(path.join(planDirectory, "README.md"), README);
	git(root, ["add", "."]);
	git(root, ["commit", "-q", "-m", "test: committed plan fixture"]);
	return { root, planDirectory };
}
