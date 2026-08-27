import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { submitHerderEvent } from "../../../src/application/tools.ts";
import { ensureService, requestManagerOperation, stopService } from "../../../src/client/index.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { GitDriver, git, runCommand } from "../../../src/daemon/git-driver.ts";
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
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo, { recursive: true });
	runCommand("git", ["init", "-q", repo]);
	git(repo, ["config", "user.name", "Herder Transition Test"]);
	git(repo, ["config", "user.email", "herder-transition@example.invalid"]);
	fs.mkdirSync(path.join(repo, "src"));
	fs.mkdirSync(path.join(repo, "test"));
	fs.writeFileSync(
		path.join(repo, "package.json"),
		`${JSON.stringify({ name: "herder-transition-fixture", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
	);
	fs.writeFileSync(path.join(repo, "src/value.mjs"), "export const value = 1\n");
	fs.writeFileSync(path.join(repo, "test/value.test.mjs"), `import assert from "node:assert/strict"\nimport test from "node:test"\nimport { value } from "../src/value.mjs"\ntest("value", () => assert.ok(Number.isInteger(value)))\n`);
	git(repo, ["add", "."]);
	git(repo, ["commit", "-q", "-m", "test: add transition fixture"]);
	const originalHead = git(repo, ["rev-parse", "HEAD"]).stdout.trim();

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
	for (let round = 1; round <= 3; round += 1) {
		assert.equal(Number(implementer.round), round);
		reply = await finishImplementer(service, implementer, prefix);
		reviewer = action(reply, "plan-reviewer");
		assert.equal(Number(reviewer.round), round);
		reply = await finishReviewer(service, reviewer, prefix, blocker(round));
		if (round < 3) {
			implementer = action(reply, "plan-implementer");
			assert.equal(Number(implementer.round), round + 1);
			assert.equal(implementer.workerMode, "GUIDED_REPAIR");
		} else {
			const judge = action(reply, "plan-judge");
			assert.equal(Number(judge.round), 3);
			assert.equal(judge.workerMode, "ADJUDICATE");
			return { reply, judge, reviewer };
		}
	}
	throw new Error("round-3 Judge was not scheduled");
}

async function reachJudgeRound(
	service: Service,
	fixture: Fixture,
	prefix: string,
	targetRound: number,
): Promise<{ reply: JsonRecord; judge: JsonRecord; reviewer: JsonRecord }> {
	let state = await reachJudge(service, fixture, prefix);
	for (let round = 3; round < targetRound; round += 1) {
		const contract = `Judge repair contract for round ${round}`;
		state.reply = await finishJudge(service, state.judge, prefix, {
			decision: "REPAIR",
			findings: [`[BLOCKING][P1] judge-blocker-round-${round}`],
			authorizedBlockers: [`reviewer-blocker-round-${round}`],
			repairContracts: [contract],
		});
		const implementer = action(state.reply, "plan-implementer");
		assert.equal(Number(implementer.round), round + 1);
		assert.equal(implementer.workerMode, "GUIDED_REPAIR");
		state.reply = await finishImplementer(service, implementer, prefix);
		state.reviewer = action(state.reply, "plan-reviewer");
		assert.equal(Number(state.reviewer.round), round + 1);
		state.reply = await finishReviewer(service, state.reviewer, prefix, blocker(round + 1));
		state.judge = action(state.reply, "plan-judge");
		assert.equal(Number(state.judge.round), round + 1);
		assert.equal(state.judge.workerMode, "ADJUDICATE");
	}
	return state;
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

test("Reviewer APPROVE and non-blocking REVISE both integrate with direct approval evidence", { timeout: 30_000 }, async () => {
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
		assert.equal(reply.status, "paused");

		const { store, run, plan } = inspectPlan(fixture);
		try {
			assert.equal(plan.phase, "DONE");
			const approval = store.getApproval(run!.runId, "001", 1);
			assert.ok(approval, "non-blocking REVISE must normalize to approval");
			assert.equal(approval.decisionRole, "plan-reviewer");
			assert.equal(approval.reviewerActionId, reviewer.actionId);
			const storedReviewer = store.getAction(String(reviewer.actionId));
			assert.equal(payload(payload(storedReviewer!.result).workerResult).verdict, "REVISE", "raw Reviewer evidence remains REVISE");
			assert.equal(store.getActions(run!.runId, ["proposed", "dispatched"]).length, 0);
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
		next = action(reply, "plan-implementer");
		assert.equal(next.round, 3);
		assert.equal(next.workerMode, "GUIDED_REPAIR");
		inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "IMPLEMENTING");
			assert.equal(inspected.plan.round, 3);
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
			assert.equal(inspected.plan.round, 3);
			assert.deepEqual(inspected.plan.repair, ["Fix reviewer blocker in round 3"]);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally {
			inspected.store.close();
		}
	});
});

test("exhausted Implementer failure creates one plan-recovery attention request", { timeout: 60_000 }, async () => {
	await withFixture("implementer-exhausted", async (service, fixture) => {
		let reply = await startRun(service, fixture, "implementer-exhausted");
		for (let round = 1; round <= 6; round += 1) {
			const implementer = action(reply, "plan-implementer");
			assert.equal(implementer.round, round);
			await dispatch(service, implementer, "implementer-exhausted");
			reply = await terminal(service, implementer, "implementer-exhausted", failedImplementerResponse(`round ${round} implementation failed`));
			if (round < 6) {
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
			assert.equal(inspected.plan.round, 6);
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
			manager.store.putPlan({ ...plan, round: 6 });
			manager.store.database.prepare("UPDATE manager_actions SET round_number = 6 WHERE action_id = ?").run(String(reviewer.actionId));
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
			assert.equal(inspected.plan.round, 3);
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

test("Judge REPAIR advances to the next guided Implementer without approval", { timeout: 45_000 }, async () => {
	await withFixture("judge-repair", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "judge-repair");
		const reply = await finishJudge(service, state.judge, "judge-repair", {
			decision: "REPAIR",
			findings: ["[BLOCKING][P1] adjudicated blocker"],
			authorizedBlockers: ["reviewer-blocker-round-3"],
			repairContracts: ["Implement the adjudicated repair contract exactly"],
		});
		assert.equal(reply.status, "running");
		const implementer = action(reply, "plan-implementer");
		assert.equal(implementer.round, 4);
		assert.equal(implementer.workerMode, "GUIDED_REPAIR");

		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "IMPLEMENTING");
			assert.equal(inspected.plan.round, 4);
			assert.deepEqual(inspected.plan.repair, ["Implement the adjudicated repair contract exactly"]);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally {
			inspected.store.close();
		}
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
		assert.equal(judge.round, 3);
		assert.equal(judge.workerMode, "ADJUDICATE");

		const after = inspectPlan(fixture);
		try {
			assert.equal(after.run!.status, "running");
			assert.equal(after.plan.phase, "JUDGING");
			assert.equal(after.plan.round, 3);
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
			assert.equal(inspected.plan.round, 3);
			assert.deepEqual(inspected.plan.repair, ["transition envelope is intentionally characterized"]);
			assert.equal(inspected.store.getAttentionRequests(inspected.run!.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "judge_blocked").length, 1);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally {
			inspected.store.close();
		}
	});
});

test("round-6 Judge REPAIR is blocked by the round limit and never schedules round 7", { timeout: 90_000 }, async () => {
	await withFixture("judge-round-limit", async (service, fixture) => {
		const state = await reachJudgeRound(service, fixture, "judge-round-limit", 6);
		assert.equal(state.judge.round, 6);
		const reply = await finishJudge(service, state.judge, "judge-round-limit", {
			decision: "REPAIR",
			findings: ["[BLOCKING][P1] final-round adjudicated blocker"],
			authorizedBlockers: ["reviewer-blocker-round-6"],
			repairContracts: ["A round-seven repair is not permitted"],
		});
		assert.equal(reply.status, "failed");
		assert.equal(records(reply.actions).length, 0);
		const attention = payload(reply.attention);
		assert.equal(attention.kind, "plan_recovery");
		assert.equal(attention.cause, "round_limit");
		assert.deepEqual(payload(attention.continuation), { role: "plan-judge", phase: "READY_JUDGE" });

		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.run!.status, "failed");
			assert.equal(inspected.plan.phase, "BLOCKED");
			assert.equal(inspected.plan.round, 6);
			assert.deepEqual(inspected.plan.repair, ["transition envelope is intentionally characterized"]);
			assert.equal(inspected.store.getActions(inspected.run!.runId).some((candidate) => candidate.round > 6), false);
			assert.equal(inspected.store.getActions(inspected.run!.runId, ["proposed", "dispatched"]).length, 0);
			assert.equal(inspected.store.getAttentionRequests(inspected.run!.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "round_limit").length, 1);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally {
			inspected.store.close();
		}
	});
});
