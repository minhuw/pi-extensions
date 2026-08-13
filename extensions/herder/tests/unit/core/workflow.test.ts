import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGraph } from "../../../src/core/plans.ts";
import { readPlanLifecycle } from "../../../src/core/workflow.ts";
import { RunStore, type StoredPlan, type StoredPlanSpec } from "../../../src/daemon/run-store.ts";

function planBody(id: string, title: string): string {
	return `# Plan ${id}: ${title}

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-08-13
- **Kind**: behavioral
- **Parent objective**: Exercise the lifecycle overlay

## Why this matters

Fixture intent.

## Current state

Fixture state.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exit 0 |

## Scope

**In scope** (declared write paths):
- \`src/${id}.mjs\`

**Out of scope**:
- Every other fixture file.

## Dependency contract

Consumes nothing and provides one passing fixture.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.

## Steps

### Step 1: Test

Run the fixture.

## Test plan

Run the fixture test.

## Review map

- Outcome: the fixture command passes.
- Modified symbols: the scoped fixture file only.
- Proof: \`true\`.
- Expected unchanged behavior: every other fixture remains unchanged.
- Expected diff: the scoped fixture path.

## Done criteria

- [ ] \`true\` exits 0.

## STOP conditions

Stop if the fixture changed.

## Maintenance notes

Keep the fixture small.
`;
}

function writePlanDir(root: string, status = "TODO"): string {
	const planDir = path.join(root, "herder-plans");
	fs.mkdirSync(planDir, { recursive: true });
	fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-first.md) | First | P1 | S | — | ${status} |
`);
	fs.writeFileSync(path.join(planDir, "001-first.md"), planBody("001", "First"));
	return planDir;
}

function createRun(store: RunStore, planDir: string): string {
	store.createRun({
		runId: "run-1",
		repositoryRoot: planDir,
		planDirectory: planDir,
		planName: "herder-plans",
		host: "pi",
		profileName: "eclipse",
		profileSha256: "p".repeat(64),
		maxParallel: 1,
		currentGeneration: 1,
		graphSha256: "g".repeat(64),
		status: "running",
		checkoutStateToken: "checkout",
		baseCommit: "b".repeat(40),
		integrationBranch: "herder/herder-plans/integration",
		integrationWorktree: path.join(planDir, "integration"),
	});
	return "run-1";
}

function spec(runId: string, initialStatus: StoredPlanSpec["initialStatus"] = "TODO"): StoredPlanSpec {
	return {
		runId,
		graphGeneration: 1,
		planId: "001",
		planFingerprint: "f".repeat(64),
		fingerprintVersion: 2,
		ordinal: 0,
		title: "First",
		priority: "P1",
		effort: "S",
		kind: "behavioral",
		dependencies: [],
		initialStatus,
		initialStatusDetail: initialStatus === "BLOCKED" ? "waiting on a decision" : "",
		gateCommands: [],
		planFile: "001-first.md",
		assignment: {
			snapshotSha256: "s".repeat(64),
			snapshotInputs: [],
			plan: {
				id: "001",
				title: "First",
				kind: "behavioral",
				parentObjective: "Exercise the lifecycle overlay",
				dependencies: [],
				inScopePaths: ["src/001.mjs"],
			},
			planText: planBody("001", "First"),
		},
	};
}

function runtime(runId: string, phase: StoredPlan["phase"]): Omit<StoredPlan, "updatedAt"> {
	return {
		runId,
		planId: "001",
		generation: 1,
		round: 1,
		phase,
		branch: "herder/herder-plans/001",
		worktree: "/tmp/worktree/001",
		assignmentPath: "/tmp/assignment.json",
		assignmentSha256: "a".repeat(64),
		snapshotSha256: "s".repeat(64),
		generationBase: "c".repeat(40),
		reviewPass: 0,
		findings: [],
		repair: [],
		gates: [],
		approvedBase: null,
		approvedHead: null,
		approvedTree: null,
		rebase: null,
	};
}

test("readPlanLifecycle falls back to README when no run exists", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-lifecycle-norun-"));
	try {
		const planDir = writePlanDir(root, "BLOCKED — previous attempt stopped");
		const lifecycle = readPlanLifecycle(planDir);
		assert.equal(lifecycle.get("001"), "BLOCKED");
		assert.equal(buildGraph(planDir).plans[0]?.status, "BLOCKED");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("readPlanLifecycle maps FINAL_APPROVED to DONE while README stays TODO", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-lifecycle-approved-"));
	try {
		const planDir = writePlanDir(root, "TODO");
		const store = new RunStore(planDir);
		try {
			const runId = createRun(store, planDir);
			store.putPlanSpecs([spec(runId, "TODO")]);
			store.putPlan(runtime(runId, "FINAL_APPROVED"));
		} finally {
			store.close();
		}
		assert.equal(readPlanLifecycle(planDir).get("001"), "DONE");
		assert.equal(buildGraph(planDir).plans[0]?.status, "TODO");
		assert.match(fs.readFileSync(path.join(planDir, "README.md"), "utf8"), /\| TODO \|/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("readPlanLifecycle maps NEEDS_INPUT to BLOCKED", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-lifecycle-input-"));
	try {
		const planDir = writePlanDir(root, "TODO");
		const store = new RunStore(planDir);
		try {
			const runId = createRun(store, planDir);
			store.putPlanSpecs([spec(runId, "TODO")]);
			store.putPlan(runtime(runId, "NEEDS_INPUT"));
		} finally {
			store.close();
		}
		assert.equal(readPlanLifecycle(planDir).get("001"), "BLOCKED");
		assert.equal(buildGraph(planDir).plans[0]?.status, "TODO");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("readPlanLifecycle uses initialStatus when runtime is missing", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-lifecycle-initial-"));
	try {
		const planDir = writePlanDir(root, "TODO");
		const store = new RunStore(planDir);
		try {
			const runId = createRun(store, planDir);
			store.putPlanSpecs([spec(runId, "DONE")]);
		} finally {
			store.close();
		}
		assert.equal(readPlanLifecycle(planDir).get("001"), "DONE");
		assert.equal(buildGraph(planDir).plans[0]?.status, "TODO");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
