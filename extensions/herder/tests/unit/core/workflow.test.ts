import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeHerderTool } from "../../../src/application/tools.ts";
import { buildGraph, projectLifecycle } from "../../../src/core/plans.ts";
import { readPlanLifecycle, readPlanLifecycleGraph, summarizeRun } from "../../../src/core/workflow.ts";
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

function writeTwoPlanDir(root: string): string {
	const planDir = path.join(root, "herder-plans");
	fs.mkdirSync(planDir, { recursive: true });
	fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| [001](001-first.md) | First | P1 | S | — | TODO |
| [002](002-second.md) | Second | P1 | S | 001 | TODO |
`);
	fs.writeFileSync(path.join(planDir, "001-first.md"), planBody("001", "First"));
	fs.writeFileSync(
		path.join(planDir, "002-second.md"),
		planBody("002", "Second").replace("- **Depends on**: none", "- **Depends on**: herder-plans/001-*.md"),
	);
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

function spec(
	runId: string,
	initialStatus: StoredPlanSpec["initialStatus"] = "TODO",
	planId = "001",
	dependencies: string[] = [],
): StoredPlanSpec {
	const title = planId === "001" ? "First" : "Second";
	return {
		runId,
		graphGeneration: 1,
		planId,
		planFingerprint: "f".repeat(64),
		fingerprintVersion: 2,
		ordinal: planId === "001" ? 0 : 1,
		title,
		priority: "P1",
		effort: "S",
		kind: "behavioral",
		dependencies,
		initialStatus,
		initialStatusDetail: initialStatus === "BLOCKED" ? "waiting on a decision" : "",
		gateCommands: [],
		planFile: `${planId}-${title.toLowerCase()}.md`,
		assignment: {
			snapshotSha256: "s".repeat(64),
			snapshotInputs: [],
			plan: {
				id: planId,
				title,
				kind: "behavioral",
				parentObjective: "Exercise the lifecycle overlay",
				dependencies,
				inScopePaths: [`src/${planId}.mjs`],
			},
			planText: planBody(planId, title),
		},
	};
}

function runtime(runId: string, phase: StoredPlan["phase"], planId = "001"): Omit<StoredPlan, "updatedAt"> {
	return {
		runId,
		planId,
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

test("projectLifecycle keeps normalized status projections in parity", () => {
	const cases = [
		{
			name: "ready and waiting with rejected dependency",
			records: [
				{ id: "001", dependencies: [], status: "TODO" as const },
				{ id: "002", dependencies: ["001"], status: "TODO" as const },
				{ id: "003", dependencies: [], status: "IN PROGRESS" as const },
				{ id: "004", dependencies: [], status: "BLOCKED" as const },
				{ id: "005", dependencies: [], status: "DONE" as const },
				{ id: "006", dependencies: [], status: "REJECTED" as const },
				{ id: "007", dependencies: ["006"], status: "TODO" as const },
			],
			expect: {
				ready: ["001"],
				inProgress: ["003"],
				blocked: ["004"],
				waiting: [
					{ id: "002", unsatisfied: ["001"], rejected: [] },
					{ id: "007", unsatisfied: ["006"], rejected: ["006"] },
				],
				counts: { total: 7, done: 1, rejected: 1, actionable: 5 },
				complete: false,
			},
		},
		{
			name: "empty input is complete",
			records: [],
			expect: {
				ready: [], inProgress: [], blocked: [], waiting: [],
				counts: { total: 0, done: 0, rejected: 0, actionable: 0 }, complete: true,
			},
		},
	];
	for (const testCase of cases) {
		assert.deepEqual(projectLifecycle(testCase.records), testCase.expect, testCase.name);
	}
});

test("summarizeRun maps shared lifecycle readiness back to specs", () => {
	const first = spec("run-1", "DONE", "001");
	const second = spec("run-1", "TODO", "002", ["001"]);
	const overview = summarizeRun([first, second], []);
	assert.deepEqual(overview.ready, [second]);
	assert.equal(overview.done, 1);
	assert.equal(overview.complete, false);
});
test("getPlanSpecs rejects persisted v1 fingerprint rows", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-lifecycle-v1-fingerprint-"));
	try {
		const planDir = writePlanDir(root, "TODO");
		const store = new RunStore(planDir);
		try {
			const runId = createRun(store, planDir);
			store.putPlanSpecs([spec(runId)]);
			store.database.prepare(`
				UPDATE manager_plan_specs
				SET fingerprint_version = 1
				WHERE run_id = ? AND graph_generation = 1 AND plan_id = ?
			`).run(runId, "001");
			assert.throws(() => store.getPlanSpecs(runId, 1), /fingerprint version/);
		} finally {
			store.close();
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

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

test("readPlanLifecycleGraph and herder_plan ready use the SQLite overlay", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-lifecycle-ready-"));
	try {
		const planDir = writeTwoPlanDir(root);
		const authored = buildGraph(planDir);
		assert.deepEqual(authored.ready, ["001"]);
		assert.deepEqual(authored.inProgress, []);
		assert.deepEqual(authored.waiting, [{ id: "002", unsatisfied: ["001"], rejected: [] }]);

		const store = new RunStore(planDir);
		try {
			const runId = createRun(store, planDir);
			store.putPlanSpecs([
				spec(runId, "TODO", "001"),
				spec(runId, "TODO", "002", ["001"]),
			]);
			store.putPlan(runtime(runId, "IMPLEMENTING", "001"));
		} finally {
			store.close();
		}

		const overlay = readPlanLifecycleGraph(planDir);
		assert.equal(overlay.plans.find((plan) => plan.id === "001")?.status, "IN PROGRESS");
		assert.equal(overlay.plans.find((plan) => plan.id === "002")?.status, "TODO");
		assert.deepEqual(overlay.ready, []);
		assert.deepEqual(overlay.inProgress, ["001"]);
		assert.deepEqual(overlay.blocked, []);
		assert.deepEqual(overlay.waiting, [{ id: "002", unsatisfied: ["001"], rejected: [] }]);
		assert.equal(overlay.complete, false);
		assert.match(fs.readFileSync(path.join(planDir, "README.md"), "utf8"), /\| TODO \|\n\| \[002\].*\| TODO \|/);

		const ready = await invokeHerderTool("herder_plan", { operation: "ready", planDirectory: planDir }) as {
			ready: string[];
			inProgress: string[];
			blocked: string[];
			waiting: Array<{ id: string; unsatisfied: string[]; rejected: string[] }>;
			complete: boolean;
		};
		assert.deepEqual(ready.ready, overlay.ready);
		assert.deepEqual(ready.inProgress, overlay.inProgress);
		assert.deepEqual(ready.blocked, overlay.blocked);
		assert.deepEqual(ready.waiting, overlay.waiting);
		assert.equal(ready.complete, overlay.complete);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("readPlanLifecycleGraph unblocks dependents from overlay DONE without rewriting README", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-lifecycle-ready-deps-"));
	try {
		const planDir = writeTwoPlanDir(root);
		const store = new RunStore(planDir);
		try {
			const runId = createRun(store, planDir);
			store.putPlanSpecs([
				spec(runId, "TODO", "001"),
				spec(runId, "TODO", "002", ["001"]),
			]);
			store.putPlan(runtime(runId, "FINAL_APPROVED", "001"));
		} finally {
			store.close();
		}

		const authored = buildGraph(planDir);
		assert.deepEqual(authored.ready, ["001"]);
		assert.deepEqual(authored.waiting.map((entry) => entry.id), ["002"]);

		const overlay = readPlanLifecycleGraph(planDir);
		assert.equal(overlay.plans.find((plan) => plan.id === "001")?.status, "DONE");
		assert.deepEqual(overlay.ready, ["002"]);
		assert.deepEqual(overlay.inProgress, []);
		assert.deepEqual(overlay.waiting, []);
		assert.match(fs.readFileSync(path.join(planDir, "README.md"), "utf8"), /\| TODO \|\n\| \[002\].*\| TODO \|/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
