import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runCleanupCommand } from "../../adapters/cleanup-command.ts";
import {
	applyHerderCleanup,
	previewHerderCleanup,
	type CleanupApplicationDependencies,
	type CleanupApplicationRequest,
} from "../../src/application/tools.ts";
import { initPlanDir } from "../../src/core/plans.ts";
import type { CleanupInput, CleanupResult } from "../../src/daemon/git/cleanup-run.ts";
import { RunStore } from "../../src/daemon/run-store.ts";
import { buildCompletionProofPayload, writeCompletionProof } from "../../src/daemon/git/completion-proof.ts";

function command(repo: string, args: string[], allowFailure = false): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
	return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function git(repo: string, ...args: string[]): string {
	return command(repo, args).stdout.trim();
}

function planFile(): string {
	return `# Plan 001: Completed fixture cleanup

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`abc1234\`, 2026-08-10

## Why this matters

The fixture exercises confirmed cleanup.

## Current state

The completed branch is safe to remove.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Test | \`true\` | exits 0 |

## Scope

- **In scope**: fixture branch
- **Out of scope**: user checkout and integration branch

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Create one focused conventional commit.

## Steps

### Step 1: Complete fixture

Run the fixture.

## Test plan

Run the fixture test.

## Done criteria

- [ ] The completed branch is integrated.

## STOP conditions

Stop if the user checkout or integration worktree would be removed.

## Maintenance notes

Keep the fixture small.
`;
}

function mockedCleanupResult(input: CleanupInput): CleanupResult {
	const planName = path.basename(input.planDir);
	const plan = input.plan ?? null;
	return {
		repoRoot: input.repo,
		planDir: input.planDir,
		planName,
		integrationBranch: `herder/${planName}/integration`,
		integrationHead: "head",
		plan,
		dryRun: input.dryRun,
		includeFailed: input.includeFailed,
		finalize: input.finalize,
		handoffTarget: input.handoffTarget ?? null,
		actions: plan ? [{ plan, branch: `herder/${planName}/${plan}`, mode: input.includeFailed ? "failed-evidence" : "completed-plan" }] : [],
		removed: !input.dryRun && plan ? [{ plan }] : [],
		skipped: [],
		finalization: { requested: false, eligible: false, blockers: [], refsPlanned: [], refsRemoved: [] },
		handoff: { requested: false, targetBranch: null, targetHead: null, eligible: false, blockers: [], integrationWorktree: null, removed: false },
		preserved: { integrationBranch: `herder/${planName}/integration`, integrationWorktree: null, coordinationRefs: `refs/plan-herder/${planName}/`, logs: true },
	};
}

function setup(): { root: string; repo: string; planDir: string; integration: string; completed: string; planBranch: string; initial: string; completedHead: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-cleanup-command-"));
	const repo = path.join(root, "repo");
	const worktrees = path.join(root, "worktrees");
	fs.mkdirSync(repo);
	fs.mkdirSync(worktrees);
	command(repo, ["init", "-q", "-b", "main"]);
	command(repo, ["config", "user.name", "Cleanup command test"]);
	command(repo, ["config", "user.email", "cleanup-command@example.invalid"]);
	fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
	command(repo, ["add", "base.txt"]);
	command(repo, ["commit", "-q", "-m", "test: cleanup command base"]);
	const initial = git(repo, "rev-parse", "HEAD");
	const planDir = path.join(repo, "herder-plans");
	initPlanDir(planDir, { track: true });
	fs.writeFileSync(path.join(planDir, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-completed-fixture-cleanup.md) | Completed fixture cleanup | P1 | S | — | DONE |

## Dependency notes

None.

## Considered and rejected

None.
`);
	fs.writeFileSync(path.join(planDir, "001-completed-fixture-cleanup.md"), planFile());
	command(repo, ["add", "herder-plans/README.md", "herder-plans/001-completed-fixture-cleanup.md"]);
	command(repo, ["commit", "-q", "-m", "test: add completed cleanup plan"]);
	const planName = path.basename(planDir);
	const integrationBranch = `herder/${planName}/integration`;
	const planBranch = `herder/${planName}/001`;
	const integration = path.join(worktrees, "integration");
	const completed = path.join(worktrees, "001");
	command(repo, ["worktree", "add", "-q", "-b", integrationBranch, integration, initial]);
	command(repo, ["worktree", "add", "-q", "-b", planBranch, completed, integrationBranch]);
	fs.writeFileSync(path.join(completed, "completed.txt"), "completed\n");
	command(completed, ["add", "completed.txt"]);
	command(completed, ["commit", "-q", "-m", "feat: complete cleanup fixture"]);
	const completedHead = git(completed, "rev-parse", "HEAD");
	command(integration, ["merge", "-q", "--ff-only", planBranch]);
	command(repo, ["update-ref", `refs/plan-herder/${planName}/base`, initial, ""]);
	const completionRef = `refs/plan-herder/${planName}/completed/001`;
	const proof = buildCompletionProofPayload({
		runId: "cleanup-command-run",
		planId: "001",
		generation: 1,
		round: 1,
		reviewerActionId: "reviewer-001",
		decisionActionId: "reviewer-001",
		decisionRole: "plan-reviewer",
		assignmentSha256: "a".repeat(64),
		approvedBase: initial,
		approvedHead: completedHead,
		approvedTree: git(completed, "rev-parse", "HEAD^{tree}"),
		reviewResultSha256: "b".repeat(64),
		decisionResultSha256: "b".repeat(64),
		integratedHead: completedHead,
	});
	writeCompletionProof(repo, completionRef, proof, `herder-${planName}-001-generation-1`);
	const store = new RunStore(planDir);
	store.createRun({
		runId: "cleanup-command-run",
		repositoryRoot: fs.realpathSync(repo),
		planDirectory: fs.realpathSync(planDir),
		planName,
		host: "pi",
		profileName: "eclipse",
		profileSha256: "c".repeat(64),
		maxParallel: 1,
		currentGeneration: 1,
		graphSha256: "d".repeat(64),
		status: "complete",
		checkoutStateToken: "checkout-token",
		baseCommit: initial,
		integrationBranch,
		integrationWorktree: fs.realpathSync(integration),
	});
	store.close();
	return { root, repo, planDir, integration, completed, planBranch, initial, completedHead };
}

test("status changes after the matched fresh preview abort before cleanup mutation", async () => {
	const fixture = setup();
	try {
		const request: CleanupApplicationRequest = {
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDir,
		};
		let dryRunCalls = 0;
		let applyCalls = 0;
		const dependencies: CleanupApplicationDependencies = {
			readStatus: () => "complete",
			withExclusion: async (_planDirectory, callback) => callback(),
			cleanupRunner: async (input) => {
				if (input.dryRun) {
					dryRunCalls += 1;
					const result = mockedCleanupResult(input);
					if (dryRunCalls === 2) {
						const readme = path.join(fixture.planDir, "README.md");
						fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("| DONE |", "| BLOCKED: status changed |"));
					}
					return result;
				}
				applyCalls += 1;
				return mockedCleanupResult(input);
			},
		};
		const expected = await previewHerderCleanup(request, dependencies);
		assert.deepEqual(expected.selectedPlanIds, ["001"]);
		assert.deepEqual(expected.failedPlanIds, []);
		await assert.rejects(
			() => applyHerderCleanup(request, expected, dependencies),
			/status or selection changed after confirmation/,
		);
		assert.equal(dryRunCalls, 2);
		assert.equal(applyCalls, 0);
		assert.notEqual(git(fixture.repo, "branch", "--list", fixture.planBranch), "");
		assert.equal(fs.existsSync(fixture.completed), true);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("confirmed cleanup removes only the eligible completed plan and records bounded evidence", async () => {
	const fixture = setup();
	try {
		const entries: unknown[] = [];
		const result = await runCleanupCommand("", {
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDir,
			confirm: async () => true,
			appendEntry: (entry) => entries.push(entry),
		});
		assert.equal(result.cancelled, false);
		assert.equal(result.applied?.executed, true);
		assert.deepEqual(result.applied?.outcomes.flatMap((outcome) => outcome.result.removed.map((item) => item.plan)), ["001"]);
		assert.equal(git(fixture.repo, "branch", "--list", fixture.planBranch), "");
		assert.equal(fs.existsSync(fixture.completed), false);
		assert.notEqual(git(fixture.repo, "branch", "--list", "herder/herder-plans/integration"), "");
		assert.equal(fs.existsSync(fixture.repo), true);
		assert.equal(entries.length, 1);
		const entry = entries[0] as Record<string, unknown>;
		assert.deepEqual(entry.removed, ["001"]);
		assert.equal(Object.hasOwn(entry, "paths"), false);
		assert.equal(Object.hasOwn(entry, "hashes"), false);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});
