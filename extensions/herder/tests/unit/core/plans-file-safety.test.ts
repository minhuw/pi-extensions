import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	buildGraph,
	getShapeReport,
	initPlanDir,
	projectStatuses,
	setTracking,
	snapshotPlan,
} from "../../../src/core/plans.ts";

const sentinel = "README_EXTERNAL_SENTINEL";

function git(root: string, ...args: string[]): void {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

function fixture(name: string): { root: string; repo: string; planDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `herder-plans-file-safety-${name}-`));
	const repo = path.join(root, "repo");
	const planDir = path.join(repo, "herder-plans");
	fs.mkdirSync(planDir, { recursive: true });
	git(repo, "init", "-q");
	fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-safe.md) | Safe fixture | P1 | S | — | TODO |

## Dependency notes

None.

## Considered and rejected

None.
`);
	fs.writeFileSync(path.join(planDir, "001-safe.md"), `# Plan 001: Safe fixture

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-08-10
- **Kind**: behavioral
- **Parent objective**: Exercise safe plan metadata handling.

## Why this matters

The fixture keeps metadata local.

## Current state

The fixture is ready for the test.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

**In scope**:
- \`src/example.ts\`

**Out of scope**:
- Other files.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.

## Steps

### Step 1: Test

Run the test.

## Test plan

Run the test.

## Done criteria

- [ ] The test passes.

## STOP conditions

Stop if the fixture changes.

## Maintenance notes

Keep the fixture small.
`);
	return { root, repo, planDir };
}

function expectUnsafe(action: () => unknown, pathPart: string): void {
	assert.throws(action, (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, new RegExp(`${pathPart}.*regular|regular.*${pathPart}`, "i"));
		assert.doesNotMatch(error.message, new RegExp(sentinel));
		return true;
	});
}

function temporaryFiles(planDir: string): string[] {
	return fs.readdirSync(planDir).filter((name) => name.includes(".herder-tmp-"));
}

test("plan index symlinks are rejected by graph, report, snapshot, and validation entry points", () => {
	const fixtureRoot = fixture("readme");
	const external = path.join(fixtureRoot.root, "external.md");
	const readme = path.join(fixtureRoot.planDir, "README.md");
	try {
		fs.writeFileSync(external, sentinel);
		fs.rmSync(readme);
		fs.symlinkSync(external, readme);

		const entryPoints: Array<[string, () => unknown]> = [
			["graph", () => buildGraph(fixtureRoot.planDir)],
			["report", () => getShapeReport(fixtureRoot.planDir)],
			["snapshot", () => snapshotPlan(fixtureRoot.planDir, "001")],
			["validation", () => projectStatuses(fixtureRoot.planDir, [])],
		];
		for (const [name, action] of entryPoints) {
			expectUnsafe(action, "README\\.md");
			assert.equal(fs.readFileSync(external, "utf8"), sentinel, `${name} touched the external target`);
		}
	} finally {
		fs.rmSync(fixtureRoot.root, { recursive: true, force: true });
	}
});

test("runtime ignore tracking rejects symlinks without touching external targets", () => {
	const fixtureRoot = fixture("ignore-symlink");
	const external = path.join(fixtureRoot.root, "external.gitignore");
	const ignore = path.join(fixtureRoot.planDir, ".gitignore");
	try {
		fs.writeFileSync(external, "EXTERNAL_IGNORE_SENTINEL\n");
		fs.symlinkSync(external, ignore);

		expectUnsafe(() => initPlanDir(fixtureRoot.planDir, { track: true }), "\\.gitignore");
		expectUnsafe(() => setTracking(fixtureRoot.planDir, true), "\\.gitignore");
		assert.equal(fs.readFileSync(external, "utf8"), "EXTERNAL_IGNORE_SENTINEL\n");
		assert.equal(fs.lstatSync(ignore).isSymbolicLink(), true);
		assert.deepEqual(temporaryFiles(fixtureRoot.planDir), []);
	} finally {
		fs.rmSync(fixtureRoot.root, { recursive: true, force: true });
	}
});

test("runtime ignore updates preserve regular content and mode and remain idempotent", () => {
	const fixtureRoot = fixture("ignore-regular");
	const ignore = path.join(fixtureRoot.planDir, ".gitignore");
	const existing = "# keep this rule\n*.tmp\n";
	try {
		fs.writeFileSync(ignore, existing);
		fs.chmodSync(ignore, 0o640);

		const initialized = initPlanDir(fixtureRoot.planDir, { track: true });
		assert.equal(initialized.runtimeIgnoreChanged, true);
		assert.equal(fs.readFileSync(ignore, "utf8"), `${existing}.herder/\n`);
		assert.equal(fs.statSync(ignore).mode & 0o7777, 0o640);

		const afterFirst = fs.readFileSync(ignore);
		const afterFirstMode = fs.statSync(ignore).mode & 0o7777;
		assert.equal(setTracking(fixtureRoot.planDir, true).runtimeIgnoreChanged, false);
		assert.equal(initPlanDir(fixtureRoot.planDir, { track: true }).runtimeIgnoreChanged, false);
		assert.deepEqual(fs.readFileSync(ignore), afterFirst);
		assert.equal(fs.statSync(ignore).mode & 0o7777, afterFirstMode);
		assert.deepEqual(temporaryFiles(fixtureRoot.planDir), []);
	} finally {
		fs.rmSync(fixtureRoot.root, { recursive: true, force: true });
	}
});
