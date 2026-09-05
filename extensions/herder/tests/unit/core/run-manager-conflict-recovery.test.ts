import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureService, requestManagerOperation, stopService } from "../../../src/client/index.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { buildGraph, initPlanDir } from "../../../src/core/plans.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { GitDriver, git } from "../../../src/daemon/git-driver.ts";
import { RunStore, type StoredPlan } from "../../../src/daemon/run-store.ts";

type JsonRecord = Record<string, unknown>;
type Fixture = {
	repo: string;
	planDirectory: string;
	baseCommit: string;
};
type ConflictRun = {
	service: Awaited<ReturnType<typeof ensureService>>;
	fixture: Fixture;
	plan2Worktree: string;
	recoveryAction: JsonRecord;
};
type DispatchRun = {
	service: Awaited<ReturnType<typeof ensureService>>;
	fixture: Fixture;
	action: JsonRecord;
};
type PlanState = {
	plan: StoredPlan;
	branchHead: string;
	checkpointHead: string;
	worktreeHead: string;
	worktreeStatus: string;
	conflicts: string;
	index: string;
	lease: string | null;
};

function record(value: unknown): JsonRecord {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as JsonRecord;
}

function actions(reply: JsonRecord): JsonRecord[] {
	return (reply.actions as unknown[]).map(record);
}

function findAction(reply: JsonRecord, planId: string, role: string): JsonRecord {
	const found = actions(reply).find((action) => action.planId === planId && action.role === role);
	assert.ok(found, `missing ${role} action for ${planId}`);
	return found;
}

async function managerRequest(
	service: Awaited<ReturnType<typeof ensureService>>,
	kind: import("../../../src/shared/protocol.ts").ManagerOperationKind,
	input: JsonRecord,
): Promise<JsonRecord> {
	const response = record(await requestManagerOperation(service, kind, input));
	return record(response.reply);
}

function planText(id: string, title: string, value: number, baseCommit: string): string {
	return `# Plan ${id}: ${title}

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`${baseCommit.slice(0, 8)}\`, 2026-08-10
- **Kind**: behavioral
- **Parent objective**: Prove that independent reviewed patches preserve exact conflict evidence during recovery.

## Outcome and acceptance

This fixture starts with disjoint declarations, then simulates a newly discovered shared companion accepted by independent review so integration exercises a real restack conflict.

| ID | Required behavior | Proof |
|---|---|---|
| A1 | the shared fixture exports ${value}. | V1 |

## Boundaries

**Write paths**
- \`src/value.mjs\`

**Out of scope**:
- Package metadata, dependencies, and plan control files.

Preserve consistency between coupled fixture exports if that coupling is discovered during implementation. A directly necessary companion requires explicit independent review acceptance; this fixture simulates discovery, not permission to edit arbitrary paths.

- **Modified symbols**: \`value\` in \`src/value.mjs\`.
- **Direct contracts**: the module export remains named \`value\`.
- **Expected unchanged behavior**: module format and repository metadata remain unchanged.
- **Expected diff**: one source line.

## Starting conditions

**Observed baseline**

- \`src/value.mjs\` exports the number one.
- The plan changes that one tracked line to a distinct value.

**Required starting state**

The stated fixture assumptions and direct interfaces still hold. Run the T1 probe before edits; report unavailable prerequisites without treating them as code defects.

**Expected dependency changes**

Dependencies: none.

## Implementation route

### Step 1: Change the shared fixture line

Change the exported value to ${value} without changing the module interface.

Suggested route above implements A1; V1 is its acceptance proof. Binding decisions: retain the declared boundaries and direct interfaces.

## Verification

| ID | Phase | Criteria | Toolchain | Command | Expected |
|---|---|---|---|---|---|
| V1 | acceptance | A1 | T1 | \`npm run test:herder -- extensions/herder/tests/unit/core/run-manager-conflict-recovery.test.ts\` | exit 0; named fixture assertions preserve the documented lifecycle and safety behavior |

| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
|---|---|---|---|---|---|
| T1 | npm project scripts | . | Node >=22.19; repository locked dependencies installed | \`node --version\` | \`package.json\`; \`package-lock.json\` |

- Keep the fixture change limited to \`src/value.mjs\`.
- Use the real Git worktree and rebase flow rather than mocking integration.

## Escalation and handoff

- **Provides**: one focused change to the shared fixture line.
- **Safe intermediate state**: the patch remains isolated to the declared source path.

Stop if the module interface or declared path must change, or if the real conflict cannot be created deterministically.

Environment or invocation failure: report the exact manager, command, cwd, error, and missing prerequisite; do not guess a substitute. Missing product authority requires a decision.

Deferred work: Keep the two independent fixture patches deliberately small and conflicting.
`;
}

function writeFixture(root: string): Fixture {
	const { repo, originalHead: baseCommit } = initFixtureRepo(root, {
		name: "Conflict Recovery Test",
		email: "conflict-recovery@example.invalid",
		files: {
			"package.json": `${JSON.stringify({ name: "conflict-recovery-fixture", private: true, type: "module" }, null, 2)}\n`,
			"src/value.mjs": "export const value = 1\n",
			"src/other.mjs": "export const value = 1\n",
		},
	});

	const planDirectory = path.join(repo, "herder-plans");
	initPlanDir(planDirectory);
	fs.writeFileSync(path.join(planDirectory, "README.md"), `# Conflict recovery plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-set-value-two.md) | Set the value to two | P1 | S | — | TODO |
| [002](002-set-value-three.md) | Set the value to three | P1 | S | — | TODO |

## Dependency notes

The plans are intentionally independent so both patches start from the same base.

## Considered and rejected

None.
`);
	fs.writeFileSync(path.join(planDirectory, "001-set-value-two.md"), planText("001", "Set the value to two", 2, baseCommit));
	fs.writeFileSync(path.join(planDirectory, "002-set-value-three.md"), planText("002", "Set the value to three", 3, baseCommit).replaceAll("src/value.mjs", "src/other.mjs"));
	const graph = buildGraph(planDirectory);
	assert.equal(graph.shapeReady, true);
	assert.deepEqual(graph.overlaps, []);
	assert.deepEqual(graph.plans.map((plan) => plan.inScopePaths), [["src/value.mjs"], ["src/other.mjs"]]);
	return { repo, planDirectory, baseCommit };
}

function commitValue(worktree: string, value: number, message: string, discoveredCompanion = false): string {
	if (discoveredCompanion) {
		// Simulate coupling discovered after independent dispatch: the second owned
		// export must stay consistent with a shared companion. Review below must
		// explicitly accept that companion before the real Git restack conflicts.
		fs.writeFileSync(path.join(worktree, "src/other.mjs"), `export const value = ${value}\n`);
		git(worktree, ["add", "src/other.mjs"]);
	}
	fs.writeFileSync(path.join(worktree, "src/value.mjs"), `export const value = ${value}\n`);
	git(worktree, ["add", "src/value.mjs"]);
	git(worktree, ["commit", "-q", "-m", message]);
	const head = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
	assert.equal(git(worktree, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim(), "");
	return head;
}

function readPlanState(fixture: Fixture, planId: string): PlanState {
	const store = new RunStore(fixture.planDirectory);
	try {
		const run = store.getRun();
		assert.ok(run);
		const plan = store.getPlan(run.runId, planId);
		assert.ok(plan);
		const branch = plan.branch;
		const checkpointRef = plan.rebase?.checkpointRef;
		return {
			plan,
			branchHead: git(fixture.repo, ["rev-parse", `refs/heads/${branch}`]).stdout.trim(),
			checkpointHead: checkpointRef
				? git(fixture.repo, ["rev-parse", checkpointRef]).stdout.trim()
				: "",
			worktreeHead: git(plan.worktree, ["rev-parse", "HEAD"]).stdout.trim(),
			worktreeStatus: git(plan.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.trim(),
			conflicts: git(plan.worktree, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim(),
			index: git(plan.worktree, ["ls-files", "--stage"]).stdout.trim(),
			lease: worktreeLease(fixture.repo, plan.worktree),
		};
	} finally {
		store.close();
	}
}

function worktreeLease(repo: string, worktree: string): string | null {
	const block = git(repo, ["worktree", "list", "--porcelain"]).stdout
		.split(/\n\n+/)
		.find((candidate) => candidate.split(/\r?\n/)[0] === `worktree ${worktree}`);
	if (!block) throw new Error(`missing worktree record for ${worktree}`);
	const locked = block.split(/\r?\n/).find((line) => line === "locked" || line.startsWith("locked "));
	return locked ? locked.slice("locked".length).trim() : null;
}

function implementerEnvelope(commit: string, note: string, discoveredCompanion = false): string {
	return `STATUS: COMPLETE
COMMITS: ${commit}
ADDRESSED: none
CHECKS: focused fixture check — passed
FILES CHANGED: ${discoveredCompanion ? "src/other.mjs, src/value.mjs" : "src/value.mjs"}
DISCOVERED_PATHS: ${discoveredCompanion ? "src/value.mjs — necessity=keep the discovered shared export consistent with src/other.mjs; plan_link=A1" : "none"}
NOTES: ${note}
USAGE: input_tokens=10; cached_input_tokens=2; output_tokens=8; reasoning_tokens=3; source=test-host`;
}

const reviewerEnvelope = "VERDICT: APPROVE\nFINDINGS: none\nFIX_GUIDANCE: none\nDISCOVERED_PATHS: none\nSCOPE: PASS\nCHECKS: focused fixture check — passed\nRATIONALE: the frozen patch is exact and focused\nUSAGE: input_tokens=10; cached_input_tokens=2; output_tokens=8; reasoning_tokens=3; source=test-host";
const companionReviewerEnvelope = reviewerEnvelope.replace("DISCOVERED_PATHS: none", "DISCOVERED_PATHS: src/value.mjs — JUSTIFIED — A1 requires consistency with the newly discovered shared fixture export; no public interface change");


async function reachPreservedConflict(fixture: Fixture, prefix: string): Promise<ConflictRun> {
	const service = await ensureService(fixture.planDirectory);
	const started = await managerRequest(service, "start", {
		mode: "fire",
		repositoryRoot: fixture.repo,
		planDirectory: fixture.planDirectory,
		profile: "eclipse",
		maxParallel: 2,
		dashboardUrl: service.dashboardUrl,
	});
	assert.equal(started.status, "running");
	const initial = actions(started);
	assert.deepEqual(initial.map((action) => [action.planId, action.role]), [
		["001", "plan-implementer"],
		["002", "plan-implementer"],
	]);
	const firstImplementer = findAction(started, "001", "plan-implementer");
	const secondImplementer = findAction(started, "002", "plan-implementer");
	await managerRequest(service, "event", {
		eventId: `${prefix}-dispatch-initial`,
		kind: "dispatch_results",
		dispatchResults: [
			{ actionId: firstImplementer.actionId, accepted: true, hostHandle: `${prefix}-implementer-001` },
			{ actionId: secondImplementer.actionId, accepted: true, hostHandle: `${prefix}-implementer-002` },
		],
	});

	const firstHead = commitValue(String(firstImplementer.worktree), 2, "test: set shared value to two");
	const secondHead = commitValue(String(secondImplementer.worktree), 3, "test: set shared value to three", true);
	let reply = await managerRequest(service, "event", {
		eventId: `${prefix}-terminal-implementer-001`,
		kind: "terminals",
		terminals: [{
			actionId: firstImplementer.actionId,
			hostHandle: `${prefix}-implementer-001`,
			response: implementerEnvelope(firstHead, "prepared the first independent patch"),
		}],
	});
	const firstReviewer = findAction(reply, "001", "plan-reviewer");
	assert.equal(firstReviewer.round, 1);
	await managerRequest(service, "event", {
		eventId: `${prefix}-dispatch-reviewer-001`,
		kind: "dispatch_results",
		dispatchResults: [{ actionId: firstReviewer.actionId, accepted: true, hostHandle: `${prefix}-reviewer-001` }],
	});
	reply = await managerRequest(service, "event", {
		eventId: `${prefix}-terminal-reviewer-001`,
		kind: "terminals",
		terminals: [{
			actionId: firstReviewer.actionId,
			hostHandle: `${prefix}-reviewer-001`,
			response: reviewerEnvelope,
		}],
	});
	assert.equal(git(fixture.repo, ["rev-parse", "refs/heads/herder/herder-plans/integration"]).stdout.trim(), firstHead);
	assert.equal(actions(reply).some((action) => action.planId === "002"), false, "the second Implementer remains active until its terminal event");

	reply = await managerRequest(service, "event", {
		eventId: `${prefix}-terminal-implementer-002`,
		kind: "terminals",
		terminals: [{
			actionId: secondImplementer.actionId,
			hostHandle: `${prefix}-implementer-002`,
			response: implementerEnvelope(secondHead, "prepared the conflicting independent patch", true),
		}],
	});
	const secondReviewer = findAction(reply, "002", "plan-reviewer");
	await managerRequest(service, "event", {
		eventId: `${prefix}-dispatch-reviewer-002`,
		kind: "dispatch_results",
		dispatchResults: [{ actionId: secondReviewer.actionId, accepted: true, hostHandle: `${prefix}-reviewer-002` }],
	});
	reply = await managerRequest(service, "event", {
		eventId: `${prefix}-terminal-reviewer-002`,
		kind: "terminals",
		terminals: [{
			actionId: secondReviewer.actionId,
			hostHandle: `${prefix}-reviewer-002`,
			response: companionReviewerEnvelope,
		}],
	});
	const recoveryAction = findAction(reply, "002", "plan-implementer");
	const state = readPlanState(fixture, "002");
	assert.equal(state.plan.phase, "IMPLEMENTING");
	assert.equal(state.plan.round, 2);
	assert.equal(recoveryAction.workerMode, "GUIDED_REPAIR");
	assert.equal(recoveryAction.round, 2);
	assert.equal(recoveryAction.assignmentSha256, state.plan.assignmentSha256);
	assert.ok(state.plan.rebase);
	assert.equal(state.plan.rebase.checkpoint, secondHead);
	assert.equal(state.plan.rebase.onto, firstHead);
	assert.equal(state.branchHead, secondHead, "the reviewed plan branch remains at its checkpoint");
	assert.equal(state.checkpointHead, secondHead);
	assert.equal(state.worktreeHead, state.plan.rebase.detachedHead);
	assert.equal(state.conflicts, "src/value.mjs");
	assert.match(state.worktreeStatus, /UU src\/value\.mjs/);
	assert.match(String(state.plan.rebase.rebaseStateSha256), /^[0-9a-f]{64}$/);
	assert.match(String(recoveryAction.prompt), /ACTIVE_REBASE: exact preserved conflicted rebase verified by the Run Manager/);
	assert.match(String(recoveryAction.prompt), new RegExp(`REBASE_ONTO: ${firstHead}`));
	assert.match(String(recoveryAction.prompt), /Do not attach HEAD, move refs, abort, reset, clean, recreate the worktree, or rematerialize the assignment/);
	assert.match(String(recoveryAction.prompt), /Resolve only the existing conflicts, stage the resolution, and complete it with git rebase --continue/);
	assert.equal(state.lease, recoveryAction.leaseReason);
	return { service, fixture, plan2Worktree: String(secondImplementer.worktree), recoveryAction };
}

async function rejectRecoveryForCapacity(run: ConflictRun, prefix: string): Promise<PlanState> {
	const before = readPlanState(run.fixture, "002");
	const reply = await managerRequest(run.service, "event", {
		eventId: `${prefix}-reject-recovery-capacity`,
		kind: "dispatch_results",
		dispatchResults: [{
			actionId: run.recoveryAction.actionId,
			accepted: false,
			error: "host concurrency limit reached",
		}],
	});
	assert.equal(reply.status, "paused");
	assert.equal(actions(reply).length, 0);
	const after = readPlanState(run.fixture, "002");
	assert.equal(after.plan.phase, "READY_IMPLEMENTER");
	assert.equal(after.plan.round, 2);
	assert.deepEqual(after.plan.rebase, before.plan.rebase, "capacity retry preserves sealed rebase evidence");
	assert.equal(after.branchHead, before.branchHead);
	assert.equal(after.checkpointHead, before.checkpointHead);
	assert.equal(after.worktreeHead, before.worktreeHead);
	assert.equal(after.worktreeStatus, before.worktreeStatus);
	assert.equal(after.conflicts, before.conflicts);
	assert.equal(after.index, before.index);
	assert.equal(after.lease, null);
	return after;
}

function cleanup(fixture: Fixture): void {
	fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
}

async function reachDispatchAction(fixture: Fixture, prefix: string): Promise<DispatchRun> {
	const service = await ensureService(fixture.planDirectory);
	const started = await managerRequest(service, "start", {
		mode: "fire",
		repositoryRoot: fixture.repo,
		planDirectory: fixture.planDirectory,
		profile: "eclipse",
		maxParallel: 1,
		dashboardUrl: service.dashboardUrl,
	});
	assert.equal(started.status, "running", prefix);
	return { service, fixture, action: findAction(started, "001", "plan-implementer") };
}

test("retryable dispatch rejection resets the plan and resumes scheduling", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-dispatch-rejection-test-"));
	const fixture = writeFixture(root);
	let service: Awaited<ReturnType<typeof ensureService>> | null = null;
	try {
		const run = await reachDispatchAction(fixture, "dispatch-rejection");
		service = run.service;
		const reply = await managerRequest(service, "event", {
			eventId: "dispatch-rejection-retryable",
			kind: "dispatch_results",
			dispatchResults: [{
				actionId: run.action.actionId,
				accepted: false,
				error: "npm trusted store unavailable",
			}],
		});
		assert.equal(reply.status, "paused");
		assert.equal(actions(reply).length, 0);

		const store = new RunStore(fixture.planDirectory);
		try {
			const currentRun = store.getRun();
			assert.ok(currentRun);
			const cancelled = store.getAction(String(run.action.actionId));
			assert.ok(cancelled);
			assert.equal(cancelled.state, "cancelled");
			assert.deepEqual(cancelled.result, { error: "npm trusted store unavailable" });
			const plan = store.getPlan(currentRun.runId, "001");
			assert.ok(plan);
			assert.equal(plan.phase, "READY_IMPLEMENTER");
			assert.equal(currentRun.status, "paused");
			assert.match(String(currentRun.terminalDetail), /Dispatch rejected for .*npm trusted store unavailable/);
		} finally {
			store.close();
		}
		assert.equal(readPlanState(fixture, "001").lease, null);

		const resumed = await managerRequest(service, "start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		});
		assert.equal(resumed.status, "running");
		const replacement = findAction(resumed, "001", "plan-implementer");
		assert.notEqual(replacement.actionId, run.action.actionId);
		assert.equal(replacement.round, 1);
		assert.equal(replacement.workerMode, "INITIAL");
		const afterResume = readPlanState(fixture, "001");
		assert.equal(afterResume.plan.phase, "IMPLEMENTING");
		assert.equal(afterResume.lease, replacement.leaseReason);
	} finally {
		if (service) await stopService(fixture.planDirectory).catch(() => {});
		cleanup(fixture);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("dispatch rejection survives release failure and preserves a re-owned lease", { timeout: 30_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-dispatch-release-failure-test-"));
	const fixture = writeFixture(root);
	let service: Awaited<ReturnType<typeof ensureService>> | null = null;
	let manager: HerderRunManager | null = null;
	let alternateLease: string | null = null;
	let run: DispatchRun | null = null;
	try {
		run = await reachDispatchAction(fixture, "dispatch-release-failure");
		assert.ok(run);
		service = run.service;
		await stopService(fixture.planDirectory);
		service = null;

		manager = new HerderRunManager(fixture.planDirectory);
		const internals = manager as unknown as { terminalSideEffectsDirty: boolean };
		internals.terminalSideEffectsDirty = false;
		const originalRelease = GitDriver.prototype.release;
		let failRelease = true;
		GitDriver.prototype.release = function (this: GitDriver, worktree: string, expectedReason: string): void {
			if (failRelease) {
				failRelease = false;
				throw new Error("injected release failure");
			}
			originalRelease.call(this, worktree, expectedReason);
		} as typeof GitDriver.prototype.release;
		try {
			const rejected = await manager.event({
				eventId: "dispatch-release-failure-rejected",
				kind: "dispatch_results",
				dispatchResults: [{
					actionId: String(run.action.actionId),
					accepted: false,
					error: "npm trusted store unavailable",
				}],
			});
			assert.equal(rejected.status, "paused");
			const cancelled = manager.store.getAction(String(run.action.actionId));
			assert.ok(cancelled);
			assert.equal(cancelled.state, "cancelled");
			assert.equal(manager.store.getPlan((manager.store.getRun()!).runId, "001")?.phase, "READY_IMPLEMENTER");
			assert.equal(worktreeLease(fixture.repo, String(run.action.worktree)), cancelled.leaseReason);
			assert.equal(internals.terminalSideEffectsDirty, true);

			const resumed = await manager.resume({
				mode: "resume",
				repositoryRoot: fixture.repo,
				planDirectory: fixture.planDirectory,
				profile: "eclipse",
			});
			assert.equal(resumed.status, "running");
			assert.equal(internals.terminalSideEffectsDirty, false);
			const currentRun = manager.store.getRun()!;
			const replacement = manager.store.getActions(currentRun.runId, ["proposed"])
				.find((action) => action.planId === "001" && action.role === "plan-implementer");
			assert.ok(replacement);
			assert.notEqual(replacement.actionId, cancelled.actionId);
			assert.equal(worktreeLease(fixture.repo, String(run.action.worktree)), replacement.leaseReason);
		} finally {
			GitDriver.prototype.release = originalRelease;
		}

		manager.close();
		manager = null;
		const worktree = String(run.action.worktree);
		git(fixture.repo, ["worktree", "unlock", worktree]);
		alternateLease = "test-reowned-lease";
		git(fixture.repo, ["worktree", "lock", "--reason", alternateLease, worktree]);
		const restarted = new HerderRunManager(fixture.planDirectory);
		try {
			const audited = await restarted.auditScheduler();
			assert.ok(audited);
			assert.equal(worktreeLease(fixture.repo, worktree), alternateLease);
		} finally {
			restarted.close();
		}
	} finally {
		if (alternateLease) {
			try {
				const worktree = String(run?.action.worktree);
				if (worktreeLease(fixture.repo, worktree) === alternateLease) git(fixture.repo, ["worktree", "unlock", worktree]);
			} catch {}
		}
		manager?.close();
		if (service) await stopService(fixture.planDirectory).catch(() => {});
		cleanup(fixture);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("preserved integration conflict retries and completes guided rebase recovery", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-conflict-recovery-test-"));
	const fixture = writeFixture(root);
	let service: Awaited<ReturnType<typeof ensureService>> | null = null;
	try {
		const run = await reachPreservedConflict(fixture, "recovery-success");
		service = run.service;
		const preservedState = await rejectRecoveryForCapacity(run, "recovery-success");

		const resumed = await managerRequest(service, "start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		});
		assert.equal(resumed.status, "running");
		const replacement = findAction(resumed, "002", "plan-implementer");
		assert.equal(replacement.workerMode, "GUIDED_REPAIR");
		assert.equal(replacement.round, 2);
		assert.notEqual(replacement.actionId, run.recoveryAction.actionId);
		assert.match(String(replacement.prompt), /ACTIVE_REBASE: exact preserved conflicted rebase verified by the Run Manager/);
		assert.match(String(replacement.prompt), /Resolve only the existing conflicts, stage the resolution, and complete it with git rebase --continue/);
		const replacementState = readPlanState(fixture, "002");
		assert.deepEqual(replacementState.plan.rebase, preservedState.plan.rebase, "replacement preserves the sealed durable rebase evidence");
		assert.equal(replacementState.branchHead, replacementState.plan.rebase?.checkpoint);
		assert.equal(replacementState.checkpointHead, replacementState.plan.rebase?.checkpoint);

		await managerRequest(service, "event", {
			eventId: "recovery-success-dispatch-replacement",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: replacement.actionId, accepted: true, hostHandle: "recovery-success-replacement" }],
		});
		fs.writeFileSync(path.join(run.plan2Worktree, "src/value.mjs"), "export const value = 3\n");
		git(run.plan2Worktree, ["add", "src/value.mjs"]);
		const continued = git(run.plan2Worktree, ["-c", "core.editor=true", "rebase", "--continue"]);
		assert.equal(continued.status, 0, continued.stderr);
		assert.equal(git(run.plan2Worktree, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim(), "");
		const rebasedHead = git(run.plan2Worktree, ["rev-parse", "HEAD"]).stdout.trim();
		assert.notEqual(rebasedHead, replacementState.plan.rebase?.checkpoint);
		assert.equal(git(fixture.repo, ["rev-parse", "refs/heads/herder/herder-plans/002"]).stdout.trim(), rebasedHead);

		let reply = await managerRequest(service, "event", {
			eventId: "recovery-success-terminal-replacement",
			kind: "terminals",
			terminals: [{
				actionId: replacement.actionId,
				hostHandle: "recovery-success-replacement",
				response: implementerEnvelope(rebasedHead, "resolved only the preserved conflict and continued the rebase", true),
			}],
		});
		const verificationReviewer = findAction(reply, "002", "plan-reviewer");
		assert.equal(verificationReviewer.round, 2);
		assert.equal(verificationReviewer.workerMode, "VERIFICATION");
		await managerRequest(service, "event", {
			eventId: "recovery-success-dispatch-verification-reviewer",
			kind: "dispatch_results",
			dispatchResults: [{ actionId: verificationReviewer.actionId, accepted: true, hostHandle: "recovery-success-verification-reviewer" }],
		});
		reply = await managerRequest(service, "event", {
			eventId: "recovery-success-terminal-verification-reviewer",
			kind: "terminals",
			terminals: [{
				actionId: verificationReviewer.actionId,
				hostHandle: "recovery-success-verification-reviewer",
				response: companionReviewerEnvelope,
			}],
		});
		const finalState = readPlanState(fixture, "002");
		assert.equal(finalState.plan.phase, "DONE");
		assert.equal(finalState.plan.rebase, null, "successful integration clears active rebase evidence");
		assert.equal(git(fixture.repo, ["rev-parse", "refs/heads/herder/herder-plans/integration"]).stdout.trim(), rebasedHead);
		assert.equal(git(fixture.repo, ["rev-parse", "refs/heads/herder/herder-plans/002"]).stdout.trim(), rebasedHead);
		assert.equal(git(fixture.repo, ["show", "herder/herder-plans/integration:src/value.mjs"]).stdout, "export const value = 3\n");
		assert.equal(reply.status, "paused", "the completed plan set now waits for final verification");
	} finally {
		if (service) await stopService(fixture.planDirectory).catch(() => {});
		cleanup(fixture);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("altered preserved rebase is rejected before replacement dispatch", { timeout: 60_000 }, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-manager-conflict-tamper-test-"));
	const fixture = writeFixture(root);
	let service: Awaited<ReturnType<typeof ensureService>> | null = null;
	try {
		const run = await reachPreservedConflict(fixture, "recovery-tamper");
		service = run.service;
		const beforeCapacity = await rejectRecoveryForCapacity(run, "recovery-tamper");
		fs.writeFileSync(path.join(run.plan2Worktree, "src/value.mjs"), "export const value = 99\n");
		await assert.rejects(() => managerRequest(service!, "start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
		}), /Active rebase state changed|active rebase state mismatch/);
		const after = readPlanState(fixture, "002");
		assert.deepEqual(after.plan.rebase, beforeCapacity.plan.rebase, "tampering cannot replace the sealed evidence");
		assert.equal(after.plan.phase, "READY_IMPLEMENTER");
		assert.equal(after.branchHead, beforeCapacity.branchHead, "the reviewed plan branch remains at its checkpoint");
		assert.equal(after.checkpointHead, beforeCapacity.checkpointHead);
		assert.equal(after.worktreeHead, beforeCapacity.worktreeHead);
		assert.equal(after.conflicts, beforeCapacity.conflicts);
		assert.equal(worktreeLease(fixture.repo, run.plan2Worktree), null, "failed replacement dispatch releases its temporary lease");
		const store = new RunStore(fixture.planDirectory);
		try {
			const currentRun = store.getRun();
			assert.ok(currentRun);
			assert.equal(currentRun.status, "paused", "tampered recovery remains paused instead of being retried by scheduler audits");
			const replacementAttempts = store.getActions(currentRun.runId).filter((action) => action.planId === "002" && action.round === 2 && action.role === "plan-implementer");
			assert.equal(replacementAttempts.length, 1, "tampered evidence is rejected before a replacement action is recorded");
			assert.equal(replacementAttempts[0]?.state, "cancelled");
		} finally {
			store.close();
		}
	} finally {
		if (service) await stopService(fixture.planDirectory).catch(() => {});
		cleanup(fixture);
		fs.rmSync(root, { recursive: true, force: true });
	}
});
