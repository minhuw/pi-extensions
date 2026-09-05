import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { submitHerderEvent } from "../../../src/application/tools.ts";
import { ensureService, requestManagerOperation, stopService } from "../../../src/client/index.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { DEFAULT_PROFILE_CATALOG, loadPiProfileCatalog } from "../../../src/core/profile-registry.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { GitDriver, git } from "../../../src/daemon/git-driver.ts";
import { sha256, stableJson, type AttentionResolutionInput } from "../../../src/shared/protocol.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";

type JsonRecord = Record<string, unknown>;
type Service = Awaited<ReturnType<typeof ensureService>>;
type Fixture = { repo: string; planDirectory: string; originalHead: string };

type ReviewerEnvelope = {
	verdict: "APPROVE" | "REVISE" | "BLOCK";
	findings?: string[];
	fixGuidance?: string[];
	scope?: "PASS" | "FAIL";
	rationale?: string;
};

type JudgeEnvelope = {
	decision: "DONE" | "REPAIR" | "NEEDS_INPUT" | "BLOCKED";
	findings?: string[];
	authorizedBlockers?: string[];
	repairContracts?: string[];
	question?: string;
	rationale?: string;
	passDocument?: string;
};

const FIXTURE_PLAN = (originalHead: string) => `# Plan 001: Update the fixture value

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`${originalHead.slice(0, 8)}\`, 2026-08-10
- **Kind**: behavioral
- **Parent objective**: Prove the deterministic Reviewer and Judge transitions through public manager events.

## Why this matters

The fixture gives the manager a real repository and a small patch that can be carried through every review round.

## Current state

- \`src/value.mjs\` exports the number one.
- The Implementer commits one focused value change per round.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Tests | \`npm test\` | exits 0 |

## Dependency contract

- **Consumes**: none.
- **Provides**: a deterministic fixture patch for manager transition characterization.
- **Safe intermediate state**: every round remains a clean committed worktree.

## Scope

**In scope** (declared write paths):
- \`src/value.mjs\`

**Out of scope**:
- Package metadata and manager implementation.

## Git workflow

- Branch: use the exact branch/worktree assigned by Herder Fire; never create or switch branches.
- Create one focused conventional commit per Implementer round.
- Do not push or open a pull request.

## Steps

### Step 1: Update the exported value

Change the exported numeric value while preserving the module interface.

**Verify**: \`npm test\` → exits 0.

## Test plan

- Drive manager \`start()\` and \`event()\` endpoints only.
- Assert durable phase, round, action, approval, and run status contracts.

## Review map

- **Outcome**: accepted Reviewer and Judge results persist the documented next state.
- **Modified symbols**: the fixture value only.
- **Direct contracts**: public manager events and RunStore records.
- **Proof**: focused manager transition tests.

## Done criteria

- [ ] Every accepted transition is characterized through public events.

## STOP conditions

Stop if a transition cannot be reached through public manager events.

## Maintenance notes

Keep assertions on durable state rather than incidental prose.
`;

function payload(value: unknown): JsonRecord {
	assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
	return value as JsonRecord;
}

function records(value: unknown): JsonRecord[] {
	assert.ok(Array.isArray(value));
	return value.map(payload);
}

function writeFixture(root: string): Fixture {
	const { repo, originalHead } = initFixtureRepo(root, {
		name: "Herder Transition Test",
		email: "herder-transition@example.invalid",
		files: {
			"package.json": `${JSON.stringify({ name: "herder-transition-fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
			"src/value.mjs": "export const value = 1\n",
			"test/value.test.mjs": `import assert from "node:assert/strict"\nimport test from "node:test"\nimport { value } from "../src/value.mjs"\ntest("value", () => assert.ok(Number.isInteger(value)))\n`,
		},
	});

	const planDirectory = path.join(repo, "herder-plans");
	initPlanDir(planDirectory);
	fs.writeFileSync(path.join(planDirectory, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| [001](001-update-value.md) | Update the fixture value | P1 | S | — | TODO |

## Dependency notes

None.

## Considered and rejected

None.
`);
	fs.writeFileSync(path.join(planDirectory, "001-update-value.md"), FIXTURE_PLAN(originalHead));
	return { repo, planDirectory, originalHead };
}

async function withFixture<T>(prefix: string, callback: (service: Service, fixture: Fixture) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `herder-review-judge-${prefix}-`));
	const fixture = writeFixture(root);
	let service: Service | undefined;
	try {
		service = await ensureService(fixture.planDirectory);
		return await callback(service, fixture);
	} finally {
		await stopService(fixture.planDirectory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(`${fixture.repo}-herder-worktrees`, { recursive: true, force: true });
	}
}

function action(reply: JsonRecord, role?: string): JsonRecord {
	const candidates = records(reply.actions);
	const match = role ? candidates.find((candidate) => candidate.role === role) : candidates[0];
	assert.ok(match, `expected a proposed ${role ?? "worker"} action`);
	return match;
}

function eventId(prefix: string, kind: string, candidate: JsonRecord): string {
	return `${prefix}-${kind}-${String(candidate.attemptId).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function startRun(service: Service, fixture: Fixture, prefix: string): Promise<JsonRecord> {
	const response = payload(await requestManagerOperation(service, "start", {
		mode: "fire",
		repositoryRoot: fixture.repo,
		planDirectory: fixture.planDirectory,
		profile: "eclipse",
		maxParallel: 1,
		dashboardUrl: service.dashboardUrl,
	}));
	const reply = payload(response.reply);
	assert.equal(reply.status, "running");
	assert.equal(action(reply, "plan-implementer").workerMode, "INITIAL", prefix);
	return reply;
}

async function dispatch(service: Service, candidate: JsonRecord, prefix: string): Promise<void> {
	const response = payload(await requestManagerOperation(service, "event", {
		eventId: eventId(prefix, "dispatch", candidate),
		kind: "dispatch_results",
		dispatchResults: [{
			actionId: candidate.actionId,
			accepted: true,
			hostHandle: `${prefix}-${candidate.attemptId}-host`,
		}],
	}));
	assert.equal(payload(response.reply).active instanceof Array, true);
}

function implementerResponse(commit: string, discoveredPaths: string[] = []): string {
	return [
		"STATUS: COMPLETE",
		`COMMITS: ${commit}`,
		"CHECKS: fixture test — passed",
		"FILES CHANGED: src/value.mjs",
		`DISCOVERED_PATHS: ${discoveredPaths.length ? discoveredPaths.join("\n") : "none"}`,
		"NOTES: committed the round-specific fixture value",
		"USAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test-host",
	].join("\n");
}

async function terminal(service: Service, candidate: JsonRecord, prefix: string, responseText: string): Promise<JsonRecord> {
	const response = payload(await requestManagerOperation(service, "event", {
		eventId: eventId(prefix, "terminal", candidate),
		kind: "terminals",
		terminals: [{
			actionId: candidate.actionId,
			hostHandle: `${prefix}-${candidate.attemptId}-host`,
			response: responseText,
		}],
	}));
	return payload(response.reply);
}

async function finishImplementer(service: Service, candidate: JsonRecord, prefix: string, discoveredPaths: string[] = []): Promise<JsonRecord> {
	await dispatch(service, candidate, prefix);
	const round = Number(candidate.round);
	const worktree = String(candidate.worktree);
	fs.writeFileSync(path.join(worktree, "src/value.mjs"), `export const value = ${round + 1}\n`);
	git(worktree, ["add", "src/value.mjs"]);
	git(worktree, ["commit", "-q", "-m", `test: commit transition round ${round}`]);
	const commit = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
	return terminal(service, candidate, prefix, implementerResponse(commit, discoveredPaths));
}

function failedImplementerResponse(reason: string): string {
	return [
		"STATUS: FAILED",
		"COMMITS: none",
		"CHECKS: none",
		"FILES CHANGED: none",
		"DISCOVERED_PATHS: none",
		`NOTES: ${reason}`,
		"USAGE: input_tokens=1; cached_input_tokens=0; output_tokens=1; reasoning_tokens=0; source=test-host",
	].join("\n");
}

function reviewerResponse(result: ReviewerEnvelope): string {
	return [
		`VERDICT: ${result.verdict}`,
		`FINDINGS: ${result.findings?.length ? result.findings.join("\n") : "none"}`,
		`FIX_GUIDANCE: ${result.fixGuidance?.length ? result.fixGuidance.join("\n") : "none"}`,
		"DISCOVERED_PATHS: none",
		`SCOPE: ${result.scope ?? "PASS"}`,
		"CHECKS: fixture test — passed",
		`RATIONALE: ${result.rationale ?? "transition envelope is intentionally characterized"}`,
		"USAGE: input_tokens=2; cached_input_tokens=0; output_tokens=2; reasoning_tokens=0; source=test-host",
	].join("\n");
}

async function finishReviewer(service: Service, candidate: JsonRecord, prefix: string, result: ReviewerEnvelope): Promise<JsonRecord> {
	await dispatch(service, candidate, prefix);
	return terminal(service, candidate, prefix, reviewerResponse(result));
}

function judgeResponse(result: JudgeEnvelope): string {
	return [
		`DECISION: ${result.decision}`,
		`FINDINGS: ${result.findings?.length ? result.findings.join("\n") : "none"}`,
		`AUTHORIZED_BLOCKERS: ${result.authorizedBlockers?.length ? result.authorizedBlockers.join("\n") : "none"}`,
		`REPAIR_CONTRACTS: ${result.repairContracts?.length ? result.repairContracts.join("\n") : "none"}`,
		...(result.decision === "REPAIR" ? [`PASS_DOCUMENT: ${result.passDocument ?? "Repair the recorded blocker and rerun the fixture test; original assignment remains authoritative."}`] : []),
		"DISCOVERED_PATHS: none",
		"LEAKS: none",
		...(result.question ? [`QUESTION: ${result.question}`] : []),
		"CHECKS: fixture test — passed",
		`RATIONALE: ${result.rationale ?? "transition envelope is intentionally characterized"}`,
		"USAGE: input_tokens=3; cached_input_tokens=0; output_tokens=3; reasoning_tokens=0; source=test-host",
	].join("\n");
}

async function finishJudge(service: Service, candidate: JsonRecord, prefix: string, result: JudgeEnvelope): Promise<JsonRecord> {
	await dispatch(service, candidate, prefix);
	return terminal(service, candidate, prefix, judgeResponse(result));
}

function blocker(round: number): ReviewerEnvelope {
	return {
		verdict: "REVISE",
		findings: [`[BLOCKING][P1] reviewer-blocker-round-${round}`],
		fixGuidance: [`Fix reviewer blocker in round ${round}`],
	};
}

async function reachJudge(service: Service, fixture: Fixture, prefix: string): Promise<{ reply: JsonRecord; judge: JsonRecord; reviewer: JsonRecord }> {
	let reply = await startRun(service, fixture, prefix);
	let implementer = action(reply, "plan-implementer");
	let reviewer!: JsonRecord;
	for (let round = 1; round <= 2; round += 1) {
		assert.equal(Number(implementer.round), round);
		reply = await finishImplementer(service, implementer, prefix);
		reviewer = action(reply, "plan-reviewer");
		assert.equal(Number(reviewer.round), round);
		reply = await finishReviewer(service, reviewer, prefix, blocker(round));
		if (round < 2) {
			implementer = action(reply, "plan-implementer");
			assert.equal(Number(implementer.round), round + 1);
			assert.equal(implementer.workerMode, "GUIDED_REPAIR");
		} else {
			const judge = action(reply, "plan-judge");
			assert.equal(Number(judge.round), 2);
			assert.equal(judge.workerMode, "ADJUDICATE");
			return { reply, judge, reviewer };
		}
	}
	throw new Error("round-2 Judge was not scheduled");
}

function inspectPlan(fixture: Fixture): { store: RunStore; run: ReturnType<RunStore["getRun"]>; plan: NonNullable<ReturnType<RunStore["getPlan"]>> } {
	const store = new RunStore(fixture.planDirectory);
	const run = store.getRun();
	assert.ok(run);
	const plan = store.getPlan(run.runId, "001");
	assert.ok(plan);
	return { store, run, plan };
}

function assertNoApproval(store: RunStore, runId: string): void {
	assert.equal(store.getApproval(runId, "001", 1), null);
}

test("Reviewer APPROVE integrates; nonapproval never silently normalizes to approval", { timeout: 30_000 }, async () => {
	await withFixture("review-approve", async (service, fixture) => {
		let reply = await startRun(service, fixture, "direct-approval");
		const implementer = action(reply, "plan-implementer");
		reply = await finishImplementer(service, implementer, "direct-approval");
		const reviewer = action(reply, "plan-reviewer");
		reply = await finishReviewer(service, reviewer, "direct-approval", {
			verdict: "APPROVE",
			findings: [],
			fixGuidance: [],
		});
		assert.equal(reply.status, "paused");

		const { store, run, plan } = inspectPlan(fixture);
		try {
			assert.equal(plan.phase, "DONE");
			assert.equal(plan.round, 1);
			const approval = store.getApproval(run!.runId, "001", 1);
			assert.ok(approval);
			assert.equal(approval.decisionRole, "plan-reviewer");
			assert.equal(approval.reviewerActionId, reviewer.actionId);
			assert.equal(approval.decisionActionId, reviewer.actionId);
			assert.equal(store.getActions(run!.runId, ["proposed", "dispatched"]).length, 0);
		} finally {
			store.close();
		}
	});

	await withFixture("review-normalize", async (service, fixture) => {
		let reply = await startRun(service, fixture, "normalized-revise");
		const implementer = action(reply, "plan-implementer");
		reply = await finishImplementer(service, implementer, "normalized-revise");
		const reviewer = action(reply, "plan-reviewer");
		reply = await finishReviewer(service, reviewer, "normalized-revise", {
			verdict: "REVISE",
			findings: [],
			fixGuidance: [],
			scope: "PASS",
		});
		assert.equal(reply.status, "running");
		assert.equal(action(reply, "plan-implementer").round, 2);

		const { store, run, plan } = inspectPlan(fixture);
		try {
			assert.equal(plan.phase, "IMPLEMENTING");
			const approval = store.getApproval(run!.runId, "001", 1);
			assert.equal(approval, null, "REVISE must retain its nonapproval meaning");
			const storedReviewer = store.getAction(String(reviewer.actionId));
			assert.equal(payload(payload(storedReviewer!.result).workerResult).verdict, "REVISE", "raw Reviewer evidence remains REVISE");
			assert.equal(store.getActions(run!.runId, ["proposed", "dispatched"]).length, 1);
		} finally {
			store.close();
		}
	});
});

test("blocking Reviewer outcomes repair directly, block early, or escalate to a Judge", { timeout: 45_000 }, async () => {
	await withFixture("review-rounds", async (service, fixture) => {
		let reply = await startRun(service, fixture, "direct-repair");
		let implementer = action(reply, "plan-implementer");
		reply = await finishImplementer(service, implementer, "direct-repair");
		let reviewer = action(reply, "plan-reviewer");
		reply = await finishReviewer(service, reviewer, "direct-repair", blocker(1));
		let next = action(reply, "plan-implementer");
		assert.equal(next.round, 2);
		assert.equal(next.workerMode, "GUIDED_REPAIR");
		let inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "IMPLEMENTING");
			assert.equal(inspected.plan.round, 2);
			assert.deepEqual(inspected.plan.repair, ["Fix reviewer blocker in round 1"]);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally {
			inspected.store.close();
		}

		reply = await finishImplementer(service, next, "direct-repair");
		reviewer = action(reply, "plan-reviewer");
		reply = await finishReviewer(service, reviewer, "direct-repair", blocker(2));
		next = action(reply, "plan-judge");
		assert.equal(next.round, 2);
		assert.equal(next.workerMode, "ADJUDICATE");
		inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "JUDGING");
			assert.equal(inspected.plan.round, 2);
			assert.deepEqual(inspected.plan.repair, ["Fix reviewer blocker in round 2"]);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally {
			inspected.store.close();
		}
	});

	await withFixture("review-block", async (service, fixture) => {
		const blockedRationale = "Fresh review children exhausted their budgets.\nIndependent validation | could not complete.";
		const projectedDetail = "Fresh review children exhausted their budgets. Independent validation ; could not complete.";
		let reply = await startRun(service, fixture, "early-block");
		const implementer = action(reply, "plan-implementer");
		reply = await finishImplementer(service, implementer, "early-block");
		const reviewer = action(reply, "plan-reviewer");
		reply = await finishReviewer(service, reviewer, "early-block", {
			verdict: "BLOCK",
			findings: [],
			fixGuidance: [],
			rationale: blockedRationale,
		});
		assert.equal(reply.status, "failed");
		assert.equal(records(reply.actions).length, 0);
		const attention = payload(reply.attention);
		assert.equal(attention.kind, "plan_recovery");
		assert.equal(attention.cause, "reviewer_blocked");
		assert.deepEqual(payload(attention.continuation), { role: "plan-reviewer", phase: "READY_REVIEWER" });
		let inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.run!.status, "failed");
			assert.equal(inspected.plan.phase, "BLOCKED");
			assert.equal(inspected.plan.round, 1);
			assert.deepEqual(inspected.plan.repair, [blockedRationale]);
			assert.equal(inspected.store.getAttentionRequests(inspected.run!.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "reviewer_blocked").length, 1);
			assertNoApproval(inspected.store, inspected.run!.runId);
			inspected.store.putPlan({ ...inspected.plan, repair: [] });
		} finally {
			inspected.store.close();
		}
		const readme = path.join(fixture.planDirectory, "README.md");
		assert.match(fs.readFileSync(readme, "utf8"), new RegExp(`BLOCKED — ${projectedDetail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace(`BLOCKED — ${projectedDetail}`, "IN PROGRESS"));

		const resumedResponse = payload(await requestManagerOperation(service, "start", {
			mode: "resume",
			repositoryRoot: fixture.repo,
			planDirectory: fixture.planDirectory,
			profile: "eclipse",
			maxParallel: 1,
			dashboardUrl: service.dashboardUrl,
		}));
		assert.equal(payload(resumedResponse.reply).status, "failed");
		assert.match(fs.readFileSync(readme, "utf8"), new RegExp(`BLOCKED — ${projectedDetail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		inspected = inspectPlan(fixture);
		try {
			assert.deepEqual(inspected.plan.repair, [], "legacy empty repair evidence remains recoverable from the attention request");
		} finally {
			inspected.store.close();
		}
	});

	await withFixture("review-judge", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "review-judge");
		assert.equal(state.reply.status, "running");
		assert.equal(state.reply.actions instanceof Array, true);
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "JUDGING");
			assert.equal(inspected.plan.round, 2);
			assert.deepEqual(inspected.plan.repair, ["Fix reviewer blocker in round 2"]);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally {
			inspected.store.close();
		}
	});
});

test("exhausted Implementer failure creates one plan-recovery attention request", { timeout: 60_000 }, async () => {
	await withFixture("implementer-exhausted", async (service, fixture) => {
		let reply = await startRun(service, fixture, "implementer-exhausted");
		for (let round = 1; round <= 3; round += 1) {
			const implementer = action(reply, "plan-implementer");
			assert.equal(implementer.round, round);
			await dispatch(service, implementer, "implementer-exhausted");
			reply = await terminal(service, implementer, "implementer-exhausted", failedImplementerResponse(`round ${round} implementation failed`));
			if (round < 3) {
				assert.equal(reply.status, "running");
				assert.equal(action(reply, "plan-implementer").round, round + 1);
			}
		}
		assert.equal(reply.status, "failed");
		assert.equal(records(reply.actions).length, 0);
		const attention = payload(reply.attention);
		assert.equal(attention.kind, "plan_recovery");
		assert.equal(attention.cause, "implementer_exhausted");
		assert.deepEqual(payload(attention.continuation), { role: "plan-implementer", phase: "READY_IMPLEMENTER" });
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "BLOCKED");
			assert.equal(inspected.plan.round, 3);
			assert.equal(inspected.store.getAttentionRequests(inspected.run!.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "implementer_exhausted").length, 1);
		} finally {
			inspected.store.close();
		}
	});
});

test("exhausted integration conflict creates one Implementer recovery request", { timeout: 45_000 }, async () => {
	await withFixture("integration-conflict-exhausted", async (service, fixture) => {
		let reply = await startRun(service, fixture, "integration-conflict-exhausted");
		const implementer = action(reply, "plan-implementer");
		reply = await finishImplementer(service, implementer, "integration-conflict-exhausted");
		const reviewer = action(reply, "plan-reviewer");
		await dispatch(service, reviewer, "integration-conflict-exhausted");
		await stopService(fixture.planDirectory);

		const manager = new HerderRunManager(fixture.planDirectory);
		const originalIntegrate = GitDriver.prototype.integrate;
		try {
			const run = manager.store.getRun()!;
			const plan = manager.store.getPlan(run.runId, "001")!;
			manager.store.putPlan({ ...plan, round: 3 });
			manager.store.database.prepare("UPDATE manager_actions SET round_number = 3 WHERE action_id = ?").run(String(reviewer.actionId));
			GitDriver.prototype.integrate = (() => ({ status: "conflict" })) as typeof GitDriver.prototype.integrate;
			const exhausted = await manager.event({
				eventId: "integration-conflict-exhausted-terminal",
				kind: "terminals",
				terminals: [{
					actionId: String(reviewer.actionId),
					hostHandle: "integration-conflict-exhausted-" + String(reviewer.attemptId) + "-host",
					response: reviewerResponse({ verdict: "APPROVE", findings: [], fixGuidance: [] }),
				}],
			});
			assert.equal(exhausted.status, "failed");
			assert.equal(exhausted.actions.length, 0);
			const attention = payload(exhausted.attention);
			assert.equal(attention.kind, "plan_recovery");
			assert.equal(attention.cause, "integration_conflict_exhausted");
			assert.deepEqual(payload(attention.continuation), { role: "plan-implementer", phase: "READY_IMPLEMENTER" });
			assert.equal(manager.store.getPlan(run.runId, "001")?.phase, "BLOCKED");
			assert.equal(manager.store.getAttentionRequests(run.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "integration_conflict_exhausted").length, 1);
		} finally {
			GitDriver.prototype.integrate = originalIntegrate;
			manager.close();
		}
	});
});

test("Judge DONE creates exact Reviewer/Judge approval evidence and integrates", { timeout: 45_000 }, async () => {
	await withFixture("judge-done", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "judge-done");
		const reply = await finishJudge(service, state.judge, "judge-done", {
			decision: "DONE",
			findings: [],
			authorizedBlockers: [],
			repairContracts: [],
		});
		assert.equal(reply.status, "paused");
		assert.equal(records(reply.actions).length, 0, "Judge approval must not schedule another review round");

		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "DONE");
			assert.equal(inspected.plan.round, 2);
			const approval = inspected.store.getApproval(inspected.run!.runId, "001", 1);
			assert.ok(approval);
			assert.equal(approval.decisionRole, "plan-judge");
			assert.equal(approval.reviewerActionId, state.reviewer.actionId);
			assert.equal(approval.decisionActionId, state.judge.actionId);
			assert.notEqual(approval.reviewResultSha256, approval.decisionResultSha256);
			assert.equal(inspected.store.getAction(approval.reviewerActionId)?.role, "plan-reviewer");
			assert.equal(inspected.store.getAction(approval.decisionActionId)?.role, "plan-judge");
			assert.equal(inspected.store.getAction(approval.reviewerActionId)?.state, "terminal");
			assert.equal(inspected.store.getAction(approval.decisionActionId)?.state, "terminal");
			assert.equal(inspected.store.getActions(inspected.run!.runId).some((candidate) => candidate.round > 3), false, "Judge DONE must not create round 4 or later actions");
		} finally {
			inspected.store.close();
		}
	});
});

test("Judge REPAIR supplies immutable PASS_DOCUMENT to round-3 RESCUE after restart", { timeout: 45_000 }, async (t) => {
	await withFixture("judge-repair", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "judge-repair");
		await dispatch(service, state.judge, "judge-repair");
		await stopService(fixture.planDirectory);
		const changedCatalog = loadPiProfileCatalog();
		const changedProfile = changedCatalog.profiles.find((candidate) => candidate.name === "eclipse")!;
		changedProfile.roles["plan-implementer"] = { model: "catalog-edit", effort: "low" };
		const originalRead = fs.readFileSync;
		const catalogRead = t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) =>
			args[0] === DEFAULT_PROFILE_CATALOG ? JSON.stringify(changedCatalog) : originalRead(...args)) as typeof fs.readFileSync);
		let manager = new HerderRunManager(fixture.planDirectory);
		let reply: JsonRecord;
		try {
			reply = payload(await manager.event({
				eventId: eventId("judge-repair", "terminal", state.judge),
				kind: "terminals",
				terminals: [{
					actionId: String(state.judge.actionId),
					hostHandle: `judge-repair-${state.judge.attemptId}-host`,
					response: judgeResponse({
						decision: "REPAIR",
						findings: ["[BLOCKING][P1] adjudicated blocker"],
						authorizedBlockers: ["reviewer-blocker-round-3"],
						repairContracts: ["Implement the adjudicated repair contract exactly"],
					}),
				}],
			}));
			manager.close();
			manager = new HerderRunManager(fixture.planDirectory);
			assert.deepEqual(manager.reply().actions, reply.actions, "proposed actions must survive another restart");
		} finally {
			manager.close();
			catalogRead.mock.restore();
		}
		service = await ensureService(fixture.planDirectory);
		assert.equal(reply.status, "running");
		const implementer = action(reply, "plan-implementer");
		assert.equal(implementer.round, 3);
		assert.equal(implementer.workerMode, "RESCUE");
		assert.equal(implementer.agentType, "herder.plan-implementer");
		assert.equal(implementer.model, "gpt-5.6-luna");
		assert.equal(implementer.effort, "max");
		assert.equal(implementer.serviceTier, "fast");

		assert.match(String(implementer.prompt), /PASS_DOCUMENT_ACTION_ID:/);
		assert.match(String(implementer.prompt), new RegExp(String(state.judge.actionId)));
		assert.match(String(implementer.prompt), /fixture test — passed/);
		assert.ok(String(implementer.prompt).includes(`PASS_DOCUMENT_SHA256: ${sha256("Repair the recorded blocker and rerun the fixture test; original assignment remains authoritative.")}`));
		assert.match(String(implementer.prompt), /sole scope authority/);
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "IMPLEMENTING");
			assert.equal(inspected.plan.round, 3);
			assert.deepEqual(inspected.plan.repair, ["Implement the adjudicated repair contract exactly"]);
			assertNoApproval(inspected.store, inspected.run!.runId);
			assert.equal(implementer.model, inspected.store.getActions(inspected.run!.runId).find((a) => a.role === "plan-implementer")!.model);
		} finally {
			inspected.store.close();
		}
		reply = await finishImplementer(service, implementer, "judge-repair");
		const reviewer = action(reply, "plan-reviewer");
		assert.equal(reviewer.round, 3);
		assert.equal(reviewer.model, "gpt-5.6-sol");
		assert.equal(reviewer.effort, "xhigh");
		assert.match(String(reviewer.prompt), /PASS_DOCUMENT_ACTION_ID:/);
		assert.match(String(reviewer.prompt), /Repair the recorded blocker/);
		reply = await finishReviewer(service, reviewer, "judge-repair", { verdict: "APPROVE" });
		assert.equal(reply.status, "paused");
		const done = inspectPlan(fixture);
		try { assert.equal(done.plan.phase, "DONE"); assert.equal(done.plan.round, 3); }
		finally { done.store.close(); }
	});
});

test("Judge NEEDS_INPUT pauses and user input reschedules the same Judge round", { timeout: 45_000 }, async () => {
	await withFixture("judge-input", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "judge-input");
		const question = "Which approved repair boundary | should the Judge apply?";
		const paused = await finishJudge(service, state.judge, "judge-input", {
			decision: "NEEDS_INPUT",
			findings: ["[BLOCKING][P1] adjudication needs a product decision"],
			authorizedBlockers: [],
			repairContracts: [],
			question,
		});
		assert.equal(paused.status, "needs_input");
		assert.equal(records(paused.actions).length, 0);
		const attention = payload(paused.attention);
		assert.equal(attention.kind, "user_decision");
		assert.equal(attention.cause, "judge_needs_input");
		assert.deepEqual(payload(attention.continuation), { role: "plan-judge", phase: "READY_JUDGE" });
		assert.equal(attention.question, question);
		assert.match(fs.readFileSync(path.join(fixture.planDirectory, "README.md"), "utf8"), /\| TODO \|/);
		assert.doesNotMatch(fs.readFileSync(path.join(fixture.planDirectory, "README.md"), "utf8"), /BLOCKED — Which approved repair boundary/);
		const before = inspectPlan(fixture);
		try {
			assert.equal(before.run!.status, "needs_input");
			assert.equal(before.plan.phase, "NEEDS_INPUT");
			assert.deepEqual(before.plan.repair, [question]);
			assertNoApproval(before.store, before.run!.runId);
		} finally {
			before.store.close();
		}

		const publicSubmission = payload(await submitHerderEvent({
			planDirectory: fixture.planDirectory,
			kind: "user_input",
			attentionRequestId: attention.requestId,
			userInput: "Use only the declared repair contract.",
		}));
		const resumed = payload(publicSubmission.reply);
		const publicReplay = payload(await submitHerderEvent({
			planDirectory: fixture.planDirectory,
			kind: "user_input",
			attentionRequestId: attention.requestId,
			userInput: "Use only the declared repair contract.",
		}));
		assert.equal(payload(publicReplay.reply).status, "running", "a public replay must remain bound to the resolved request");
		assert.equal(resumed.status, "running");
		assert.equal(resumed.attention, undefined);
		const judge = action(resumed, "plan-judge");
		assert.equal(judge.round, 2);
		assert.equal(judge.workerMode, "ADJUDICATE");

		const after = inspectPlan(fixture);
		try {
			assert.equal(after.run!.status, "running");
			assert.equal(after.plan.phase, "JUDGING");
			assert.equal(after.plan.round, 2);
			assert.equal(after.plan.repair.length, 2);
			assert.equal(after.plan.repair[0], question);
			assert.match(after.plan.repair[1]!, /^USER_INPUT \[attention:[0-9a-f]{64}\]: Use only the declared repair contract\.$/);
			assertNoApproval(after.store, after.run!.runId);
		} finally {
			after.store.close();
		}
	});
});

test("Judge BLOCKED ends the run without approval", { timeout: 45_000 }, async () => {
	await withFixture("judge-block", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "judge-block");
		const reply = await finishJudge(service, state.judge, "judge-block", {
			decision: "BLOCKED",
			findings: ["[BLOCKING][P1] Judge explicitly blocked the plan"],
			authorizedBlockers: [],
			repairContracts: [],
		});
		assert.equal(reply.status, "failed");
		assert.equal(records(reply.actions).length, 0);
		const attention = payload(reply.attention);
		assert.equal(attention.kind, "plan_recovery");
		assert.equal(attention.cause, "judge_blocked");
		assert.deepEqual(payload(attention.continuation), { role: "plan-judge", phase: "READY_JUDGE" });

		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.run!.status, "failed");
			assert.equal(inspected.plan.phase, "BLOCKED");
			assert.equal(inspected.plan.round, 2);
			assert.deepEqual(inspected.plan.repair, ["transition envelope is intentionally characterized"]);
			assert.equal(inspected.store.getAttentionRequests(inspected.run!.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "judge_blocked").length, 1);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally {
			inspected.store.close();
		}
	});
});

async function exhaustReview(service: Service, fixture: Fixture, prefix: string): Promise<{ reply: JsonRecord; reviewer: JsonRecord; judge: JsonRecord }> {
	const state = await reachJudge(service, fixture, prefix);
	let reply = await finishJudge(service, state.judge, prefix, {
		decision: "REPAIR", findings: ["[BLOCKING][P1] remaining impact: incorrect value"],
		repairContracts: ["Fix the incorrect value"], authorizedBlockers: ["incorrect value"],
		passDocument: "Required: retain integer API, fix incorrect value, run node --test. No waived checks.",
	});
	const implementer = action(reply, "plan-implementer");
	assert.equal(implementer.round, 3);
	assert.equal(implementer.workerMode, "RESCUE");
	reply = await finishImplementer(service, implementer, prefix);
	const reviewer = action(reply, "plan-reviewer");
	await dispatch(service, reviewer, prefix);
	reply = await terminal(service, reviewer, prefix, reviewerResponse({
		verdict: "REVISE", findings: ["[BLOCKING][P1] remaining impact: incorrect value"],
		fixGuidance: ["Fix the incorrect value"], rationale: "The rescue did not satisfy the recorded requirement",
	}).replace("CHECKS: fixture test — passed", "CHECKS: node --test — failed: incorrect value"));
	return { reply, reviewer, judge: state.judge };
}

function resolutionFor(reply: JsonRecord, action: "accept" | "stop" | "revise" | "unchanged_retry"): AttentionResolutionInput {
	const request = payload(reply.attention);
	return {
		schemaVersion: 1, requestId: String(request.requestId), requestSha256: String(request.requestSha256),
		capabilityToken: String(request.capabilityToken), runId: String(request.runId), planId: String(request.planId),
		generation: Number(request.generation), round: Number(request.round), action,
		git: payload(request.recovery) as unknown as AttentionResolutionInput["git"],
		rationale: "Operator chose the exact recorded patch and retained its evidence",
		...(action === "accept" ? { confirmed: true, answer: "Accept the incorrect-value gap and failed node --test check" } : {}),
	};
}

async function resolve(service: Service, resolution: AttentionResolutionInput, eventId: string): Promise<JsonRecord> {
	return payload(payload(await requestManagerOperation(service, "event", { eventId, kind: "attention", attention: resolution })).reply);
}

test("round-3 Reviewer nonapproval exhausts without Judge or round 4 and includes finishing failed evidence", { timeout: 60_000 }, async () => {
	await withFixture("rescue-limit", async (service, fixture) => {
		const state = await exhaustReview(service, fixture, "rescue-limit");
		assert.equal(state.reply.status, "failed");
		assert.equal(records(state.reply.actions).length, 0);
		const request = payload(state.reply.attention);
		assert.equal(request.kind, "plan_recovery");
		assert.equal(request.cause, "round_limit");
		const detail = String(request.detail);
		assert.ok(detail.length <= 16_384);
		for (const text of [String(state.reviewer.actionId), String(state.judge.actionId), "PASS_DOCUMENT", "failed: incorrect value", "fixture test — passed", "EXACT_IDENTITY", "RECOMMENDATION", "remaining impact"]) assert.ok(detail.includes(text), text);
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "BLOCKED");
			assert.equal(inspected.plan.round, 3);
			assert.equal(inspected.store.getActions(inspected.run!.runId).filter((a) => a.role === "plan-judge").length, 1);
			assert.ok(inspected.store.getActions(inspected.run!.runId).every((a) => a.round <= 3));
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally { inspected.store.close(); }
		await assert.rejects(resolve(service, resolutionFor(state.reply, "unchanged_retry"), "no-retry"), /Exhausted round-3/);
	});
});

test("confirmed human acceptance integrates the exact reviewed tree with genuine failed-review proof", { timeout: 60_000 }, async () => {
	await withFixture("human-accept", async (service, fixture) => {
		const state = await exhaustReview(service, fixture, "human-accept");
		const resolution = { ...resolutionFor(state.reply, "accept"), action: " ACCEPT " };
		const reply = await resolve(service, resolution, "accept-exact-tree");
		assert.equal(reply.status, "paused");
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "DONE");
			assert.deepEqual(inspected.plan.findings, ["[BLOCKING][P1] remaining impact: incorrect value"]);
			const approval = inspected.store.getApproval(inspected.run!.runId, "001", 1)!;
			assert.equal(approval.decisionRole, "user");
			assert.equal(approval.reviewerActionId, state.reviewer.actionId);
			assert.equal(approval.decisionActionId, state.reviewer.actionId);
			assert.deepEqual(approval.userAcceptance, resolution);
			assert.equal(approval.decisionResultSha256, sha256(stableJson(resolution)));
			const workerResult = payload(inspected.store.getAction(approval.reviewerActionId)!.result).workerResult;
			assert.equal(approval.reviewResultSha256, sha256(stableJson(workerResult)));
			assert.match(stableJson(workerResult), /failed: incorrect value/);
			assert.equal(inspected.store.getAttention(resolution.requestId)?.state, "resolved");
		} finally { inspected.store.close(); }
		await assert.rejects(resolve(service, { ...resolution, answer: "different gaps" }, "accept-replay-changed"), /different resolution/);
		const request = payload(reply.verificationRequest);
		const verified = payload(payload(await requestManagerOperation(service, "verification", {
			schemaVersion: 1, requestId: request.requestId, requestSha256: request.requestSha256,
			runId: request.runId, generation: request.generation, graphSha256: request.graphSha256,
			runAssignmentSha256: request.runAssignmentSha256, integrationHead: request.integrationHead, integrationTree: request.integrationTree,
			rationale: "Run the unchanged final verification gate independently of human exceptions",
			gates: [{ gateId: "final-fixture", label: "fixture tests", cwd: ".", argv: ["npm", "test"], rationale: "Checks the integrated fixture" }],
		})).reply);
		const audit = action(verified, "plan-reviewer");
		assert.equal(audit.planId, "RUN");
		for (const text of ["RECORDED_HUMAN_EXCEPTIONS", resolution.answer!, "APPROVAL_PROOF_SHA256", "REVIEWER_ACTION_ID", "not PASS evidence"]) assert.ok(String(audit.prompt).includes(text), text);
		const completed = await finishReviewer(service, audit, "human-final-audit", {
			verdict: "BLOCK", findings: ["[PATCH_REGRESSION][P1] acknowledged incorrect-value gap"],
		});
		assert.equal(completed.status, "complete", "human acceptance does not change the informational final audit or REIGNITE behavior");

	});
});

test("human accept fails closed for stale, dirty, unconfirmed, changed-graph or missing-reviewer evidence; stop preserves artifacts", { timeout: 60_000 }, async () => {
	await withFixture("accept-guards", async (service, fixture) => {
		const state = await exhaustReview(service, fixture, "accept-guards");
		const resolution = resolutionFor(state.reply, "accept");
		await assert.rejects(resolve(service, { ...resolution, confirmed: false }, "accept-unconfirmed"), /confirm/i);
		await assert.rejects(resolve(service, { ...resolution, requestSha256: "0".repeat(64) }, "accept-stale"), /hash/);
		await assert.rejects(resolve(service, { ...resolution, capabilityToken: "0".repeat(64) }, "accept-capability"), /capability/);
		await assert.rejects(resolve(service, { ...resolution, git: { ...resolution.git!, worktreeHead: "0".repeat(40) } }, "accept-head"), /Git identity/);
		const worktree = String(state.reviewer.worktree);
		const file = path.join(worktree, "src/value.mjs");
		const original = fs.readFileSync(file, "utf8");
		fs.writeFileSync(file, "dirty unreviewed change\n");
		await assert.rejects(resolve(service, resolution, "accept-dirty"), /clean worktree/);
		fs.writeFileSync(file, original);
		const planFile = path.join(fixture.planDirectory, "001-update-value.md");
		const source = fs.readFileSync(planFile, "utf8");
		fs.writeFileSync(planFile, source.replace("Change the exported numeric value", "Change the exported numeric value to a different requirement"));
		await assert.rejects(resolve(service, resolution, "accept-graph"), /graph-equivalent/);
		fs.writeFileSync(planFile, source);
		await stopService(fixture.planDirectory);
		const manager = new HerderRunManager(fixture.planDirectory);
		try {
			const reviewer = manager.store.getAction(String(state.reviewer.actionId))!;
			manager.store.database.prepare("UPDATE manager_actions SET result_json = '{}' WHERE action_id = ?").run(reviewer.actionId);
			await assert.rejects(manager.event({ eventId: "accept-missing-reviewer", kind: "attention", attention: resolution }), /Reviewer evidence/);
			manager.store.database.prepare("UPDATE manager_actions SET result_json = ? WHERE action_id = ?").run(JSON.stringify(reviewer.result), reviewer.actionId);
			const stopped = resolutionFor(state.reply, "stop");
			const retained = path.join(worktree, "retained-untracked.txt");
			fs.writeFileSync(retained, "operator scratch remains intact\n");
			const head = git(worktree, ["rev-parse", "HEAD"]).stdout;
			const reply = await manager.event({ eventId: "stop-preserve", kind: "attention", attention: stopped });
			assert.equal(reply.status, "failed");
			assert.equal(manager.store.getPlan(stopped.runId, "001")?.phase, "BLOCKED");
			assert.equal(manager.store.getAttention(stopped.requestId)?.state, "resolved");
			assert.equal(fs.readFileSync(file, "utf8"), original);
			assert.equal(fs.readFileSync(retained, "utf8"), "operator scratch remains intact\n");
			assert.equal(git(worktree, ["rev-parse", "HEAD"]).stdout, head);
			assert.ok(fs.existsSync(String(state.reviewer.assignmentPath)));
			assertNoApproval(manager.store, stopped.runId);
			await assert.rejects(manager.event({ eventId: "stop-replayed-different", kind: "attention", attention: { ...stopped, rationale: "different" } }), /different resolution/);
		} finally { manager.close(); }
	});
});


test("mutated transport uses the three-round budget and rescue without a Judge document retains operational evidence", { timeout: 30_000 }, async () => {
	await withFixture("transport-rescue", async (service, fixture) => {
		let reply = await startRun(service, fixture, "transport-rescue");
		let implementer = action(reply, "plan-implementer");
		await dispatch(service, implementer, "transport-rescue");
		reply = await terminal(service, implementer, "transport-rescue", failedImplementerResponse("round-one operational failure"));
		for (const round of [2, 3]) {
			implementer = action(reply, "plan-implementer");
			assert.equal(implementer.round, round);
			if (round === 3) {
				assert.equal(implementer.workerMode, "RESCUE");
				assert.match(String(implementer.prompt), /no recorded round-2 Judge REPAIR document/);
				assert.match(String(implementer.prompt), /round-one operational failure/);
				assert.match(String(implementer.prompt), /interrupted operational round 2/);
			}
			await dispatch(service, implementer, "transport-rescue");
			fs.writeFileSync(path.join(String(implementer.worktree), "src/value.mjs"), `export const value = ${round}\n`);
			reply = payload(payload(await requestManagerOperation(service, "event", {
				eventId: `transport-failure-${round}`, kind: "terminals", terminals: [{
					actionId: implementer.actionId, interrupted: true, error: `interrupted operational round ${round}`,
				}],
			})).reply);
		}
		assert.equal(reply.status, "needs_input");
		const request = payload(reply.attention);
		assert.equal(request.kind, "operator_attention");
		assert.equal(request.cause, "transport_exhausted");
		assert.match(String(request.detail), /EXHAUSTION_DECISION_DOSSIER/);
		assert.match(String(request.detail), /interrupted operational round 3/);
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.round, 3);
			assert.ok(inspected.store.getActions(inspected.run!.runId).every((a) => a.round <= 3 && a.role !== "plan-judge"));
		} finally { inspected.store.close(); }
	});
});

test("exhaustion keeps siblings schedulable, acceptance unlocks dependencies with scoped exceptions, and stop preserves the attention queue", { timeout: 60_000 }, async () => {
	await withFixture("accept-scheduling", async (service, fixture) => {
		const readme = path.join(fixture.planDirectory, "README.md");
		fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("\n\n## Dependency notes", ["",
			"| [002](002-independent.md) | Independent | P1 | S | — | TODO |",
			"| [003](003-dependent.md) | Dependent | P1 | S | 001 | TODO |", "", "## Dependency notes",
		].join("\n")));
		fs.writeFileSync(path.join(fixture.planDirectory, "002-independent.md"), FIXTURE_PLAN(fixture.originalHead).replace("# Plan 001:", "# Plan 002:").replaceAll("src/value.mjs", "src/independent.mjs"));
		fs.writeFileSync(path.join(fixture.planDirectory, "003-dependent.md"), FIXTURE_PLAN(fixture.originalHead).replace("# Plan 001:", "# Plan 003:").replace("**Depends on**: none", "**Depends on**: 001").replaceAll("src/value.mjs", "src/dependent.mjs"));
		const state = await exhaustReview(service, fixture, "accept-scheduling");
		const sibling = action(state.reply, "plan-implementer");
		assert.equal(sibling.planId, "002");
		assert.equal(records(state.reply.actions).some((a) => a.planId === "003"), false);
		await dispatch(service, sibling, "sibling");
		const siblingWorktree = String(sibling.worktree);
		fs.writeFileSync(path.join(siblingWorktree, "src/independent.mjs"), "export const independent = 1\n");
		git(siblingWorktree, ["add", "src/independent.mjs"]);
		git(siblingWorktree, ["commit", "-qm", "test: independent patch"]);
		let reply = await terminal(service, sibling, "sibling", implementerResponse(git(siblingWorktree, ["rev-parse", "HEAD"]).stdout.trim()).replaceAll("src/value.mjs", "src/independent.mjs"));
		reply = await finishReviewer(service, action(reply, "plan-reviewer"), "sibling", { verdict: "BLOCK", rationale: "Independent operator decision" });
		const acceptance = resolutionFor(state.reply, "accept");
		reply = await resolve(service, acceptance, "accept-unlocks-dependent");
		const dependent = action(reply, "plan-implementer");
		assert.equal(dependent.planId, "003");
		assert.match(String(dependent.prompt), /RECORDED_HUMAN_EXCEPTIONS/);
		assert.ok(String(dependent.prompt).includes(acceptance.answer!));
		assert.equal(payload(reply.attention).planId, "002", "next unresolved request remains queued");
		const stopped = resolutionFor(reply, "stop");
		reply = await resolve(service, stopped, "stop-independent");
		assert.equal(reply.status, "running");
		assert.equal(fs.readFileSync(path.join(siblingWorktree, "src/independent.mjs"), "utf8"), "export const independent = 1\n");
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.store.getPlan(inspected.run!.runId, "002")?.phase, "BLOCKED");
			assert.equal(inspected.store.getPlan(inspected.run!.runId, "003")?.phase, "IMPLEMENTING");
			assert.equal(inspected.store.getAttentionRequests(inspected.run!.runId, { unresolvedOnly: true }).length, 0);
		} finally { inspected.store.close(); }
	});
});


for (const decision of ["accept", "stop"] as const) {
	test(`queued generation-one ${decision} survives an unrelated target revision to global generation two`, { timeout: 60_000 }, async () => {
		await withFixture(`queued-${decision}`, async (service, fixture) => {
			const readme = path.join(fixture.planDirectory, "README.md");
			fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("\n\n## Dependency notes", "\n| [002](002-independent.md) | Independent | P1 | S | — | TODO |\n\n## Dependency notes"));
			fs.writeFileSync(path.join(fixture.planDirectory, "002-independent.md"), FIXTURE_PLAN(fixture.originalHead).replace("# Plan 001:", "# Plan 002:"));
			const first = await exhaustReview(service, fixture, `queued-${decision}-first`);
			let reply = first.reply;
			const prefix = `queued-${decision}-second`;
			for (const round of [1, 2, 3]) {
				const implementer = action(reply, "plan-implementer");
				assert.equal(implementer.planId, "002");
				assert.equal(implementer.round, round);
				reply = await finishImplementer(service, implementer, prefix);
				reply = await finishReviewer(service, action(reply, "plan-reviewer"), prefix, blocker(round));
				if (round === 2) reply = await finishJudge(service, action(reply, "plan-judge"), prefix, { decision: "REPAIR", authorizedBlockers: ["recorded blocker"], repairContracts: ["Fix the recorded blocker"] });
			}
			assert.equal(payload(reply.attention).planId, "001");
			const sourcePath = path.join(fixture.planDirectory, "001-update-value.md");
			fs.writeFileSync(sourcePath, fs.readFileSync(sourcePath, "utf8").replace("Change the exported numeric value", "Change the exported numeric value while also preserving integer compatibility"));
			reply = await resolve(service, resolutionFor(reply, "revise"), `queued-${decision}-revise-first`);
			assert.equal(payload(reply.attention).planId, "002");
			assert.equal(payload(reply.attention).generation, 1);
			const resolution = resolutionFor(reply, decision);
			await assert.rejects(resolve(service, { ...resolution, git: { ...resolution.git!, worktreeHead: "0".repeat(40) } }, `queued-${decision}-stale`), /Git identity/);
			reply = await resolve(service, resolution, `queued-${decision}-resolve-second`);
			const inspected = inspectPlan(fixture);
			try {
				assert.equal(inspected.run!.currentGeneration, 2);
				assert.equal(inspected.store.getPlan(inspected.run!.runId, "002")?.generation, 1);
				assert.equal(inspected.store.getPlan(inspected.run!.runId, "002")?.phase, decision === "accept" ? "DONE" : "BLOCKED");
				assert.equal(inspected.store.getAttention(resolution.requestId)?.state, "resolved");
				assert.equal(inspected.plan.generation, 2);
				assert.equal(inspected.plan.phase, "IMPLEMENTING");
			} finally { inspected.store.close(); }
		});
	});
}
