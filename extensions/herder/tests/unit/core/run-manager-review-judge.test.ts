import { fixtureDependencies } from "../../support/plan-v2.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attentionResolutionFromRequest } from "../../../adapters/attention.ts";
import type { ManagerAttentionRequest } from "../../../src/shared/protocol.ts";
import { submitHerderEvent } from "../../../src/application/tools.ts";
import { ensureService, requestManagerOperation, stopService } from "../../../src/client/index.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { DEFAULT_PROFILE_CATALOG, loadPiProfileCatalog } from "../../../src/core/profile-registry.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { GitDriver, git } from "../../../src/daemon/git-driver.ts";
import { sha256, stableJson, type AttentionResolutionInput } from "../../../src/shared/protocol.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { fixturePlan } from "../../support/plan-v2.ts";

type JsonRecord = Record<string, unknown>;
type Service = Awaited<ReturnType<typeof ensureService>>;
type Fixture = { repo: string; planDirectory: string; originalHead: string };

type ReviewerEnvelope = {
	verdict: "APPROVE" | "REVISE" | "BLOCK";
	blockerKind?: "SAFETY" | "REQUIREMENT";
	findings?: string[];
	fixGuidance?: string[];
	scope?: "PASS" | "FAIL";
	rationale?: string;
};

type JudgeEnvelope = {
	blockerKind?: "SAFETY" | "REQUIREMENT";
	decision: "DONE" | "REPAIR" | "NEEDS_INPUT" | "BLOCKED";
	findings?: string[];
	authorizedBlockers?: string[];
	repairContracts?: string[];
	question?: string;
	rationale?: string;
	passDocument?: string;
};

const FIXTURE_PLAN = (originalHead: string) => fixturePlan({
	head: originalHead.slice(0, 8),
	plannedAt: "2026-08-10",
	parentObjective: "Prove the deterministic Reviewer and Judge transitions through public manager events.",
	acceptance: "Accepted Reviewer and Judge results persist the documented next state.",
	implementation: "Change the exported numeric value while preserving the module interface.",
	verificationCommand: "npm run test:herder -- extensions/herder/tests/unit/core/run-manager-review-judge.test.ts",
});

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
			"src/independent.mjs": "export const value = 1\n",
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

async function startRun(service: Service, fixture: Fixture, prefix: string, profile = "eclipse", maxParallel = 1): Promise<JsonRecord> {
	const response = payload(await requestManagerOperation(service, "start", {
		mode: "fire",
		repositoryRoot: fixture.repo,
		planDirectory: fixture.planDirectory,
		profile,
		maxParallel,
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
	const sourcePath = candidate.planId === "002" ? "src/independent.mjs" : "src/value.mjs";
	fs.writeFileSync(path.join(worktree, sourcePath), `export const value = ${round + 1}\n`);
	git(worktree, ["add", sourcePath]);
	git(worktree, ["commit", "-q", "-m", `test: commit transition round ${round}`]);
	const commit = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
	return terminal(service, candidate, prefix, implementerResponse(commit, discoveredPaths).replaceAll("src/value.mjs", sourcePath));
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
		...(result.blockerKind ? [`BLOCKER_KIND: ${result.blockerKind}`] : []),
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
		...(result.blockerKind ? [`BLOCKER_KIND: ${result.blockerKind}`] : []),
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

const FAILURE_FIELDS = "obligation=A1; evidence=src/value.mjs:1 exports an incorrect fixture value; violation=the incorrect value fails the approved fixture transition acceptance";
const REMAINING_FINDING = `[F001][P1][BLOCKING][PLAN_REQUIREMENT] remaining impact: incorrect value; ${FAILURE_FIELDS}`;
const JUDGE_FINDING = `[F001][BLOCKING_IN_SCOPE][PLAN_REQUIREMENT] retain; ${FAILURE_FIELDS}`;

function blocker(round: number): ReviewerEnvelope {
	return {
		verdict: "REVISE",
		findings: [`[F001][P1][BLOCKING][PLAN_REQUIREMENT] reviewer-blocker-round-${round}; ${FAILURE_FIELDS}`],
		fixGuidance: [`Fix reviewer blocker in round ${round}`],
	};
}

async function reachJudge(service: Service, fixture: Fixture, prefix: string, profile = "eclipse", started?: JsonRecord): Promise<{ reply: JsonRecord; judge: JsonRecord; reviewer: JsonRecord }> {
	let reply = started ?? await startRun(service, fixture, prefix, profile);
	let implementer = action(reply, "plan-implementer");
	let reviewer!: JsonRecord;
	for (let round = 1; round <= 2; round += 1) {
		assert.equal(Number(implementer.round), round);
		if (profile === "universe") {
			assert.equal(implementer.model, "gpt-6-astra");
			assert.equal(implementer.effort, "medium");
			assert.equal(implementer.serviceTier, undefined);
			assert.deepEqual(implementer.searcherBinding, { model: "gpt-6-sol", effort: "xhigh" });
		}
		reply = await finishImplementer(service, implementer, prefix);
		reviewer = action(reply, "plan-reviewer");
		assert.equal(Number(reviewer.round), round);
		if (profile === "universe") {
			assert.equal(reviewer.model, "gpt-6-sol");
			assert.equal(reviewer.effort, "xhigh");
			assert.equal(reviewer.serviceTier, undefined);
			assert.deepEqual(reviewer.searcherBinding, implementer.searcherBinding);
		}
		reply = await finishReviewer(service, reviewer, prefix, blocker(round));
		if (round < 2) {
			reply = await finishJudge(service, action(reply, "plan-judge"), prefix, { decision: "REPAIR", findings: [JUDGE_FINDING], authorizedBlockers: ["F001"], repairContracts: ["[F001] Fix the incorrect value"] });
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

test("Reviewer APPROVE awaits Judge DONE; nonapproval never silently normalizes to approval", { timeout: 30_000 }, async () => {
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
		const judge = action(reply, "plan-judge");
		const pending = inspectPlan(fixture);
		try { assert.equal(pending.plan.phase, "JUDGING"); assertNoApproval(pending.store, pending.run!.runId); }
		finally { pending.store.close(); }
		reply = await finishJudge(service, judge, "direct-approval", { decision: "DONE" });
		assert.equal(reply.status, "paused");

		const { store, run, plan } = inspectPlan(fixture);
		try {
			assert.equal(plan.phase, "DONE");
			assert.equal(plan.round, 1);
			const approval = store.getApproval(run!.runId, "001", 1);
			assert.ok(approval);
			assert.equal(approval.decisionRole, "plan-judge");
			assert.equal(approval.reviewerActionId, reviewer.actionId);
			assert.equal(approval.decisionActionId, judge.actionId);
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
		assert.equal(action(reply, "plan-judge").round, 1);
		reply = await finishJudge(service, action(reply, "plan-judge"), "normalized-revise", {
			decision: "NEEDS_INPUT", question: "Review is incomplete; which required check remains?",
		});
		assert.equal(reply.status, "needs_input");
		assert.deepEqual(reply.actions, []);
		assert.equal(payload(reply.attention).cause, "judge_needs_input");

		const { store, run, plan } = inspectPlan(fixture);
		try {
			assert.equal(plan.phase, "NEEDS_INPUT");
			assert.equal(plan.round, 1, "invalid findings must not consume a repair round");
			const approval = store.getApproval(run!.runId, "001", 1);
			assert.equal(approval, null, "REVISE must retain its nonapproval meaning");
			const storedReviewer = store.getAction(String(reviewer.actionId));
			assert.equal(payload(payload(storedReviewer!.result).workerResult).verdict, "REVISE", "accepted Reviewer evidence remains available");
			assert.equal(store.getActions(run!.runId, ["proposed", "dispatched"]).length, 0);
		} finally {
			store.close();
		}
	});
});

test("blocking Reviewer outcomes await Judge repair or blocking decisions in every round", { timeout: 45_000 }, async () => {
	await withFixture("review-rounds", async (service, fixture) => {
		let reply = await startRun(service, fixture, "direct-repair");
		let implementer = action(reply, "plan-implementer");
		reply = await finishImplementer(service, implementer, "direct-repair");
		let reviewer = action(reply, "plan-reviewer");
		reply = await finishReviewer(service, reviewer, "direct-repair", blocker(1));
		const firstJudge = action(reply, "plan-judge");
		assert.equal(firstJudge.round, 1);
		reply = await finishJudge(service, firstJudge, "direct-repair", {
			decision: "REPAIR", findings: [JUDGE_FINDING], authorizedBlockers: ["F001"],
			repairContracts: ["[F001] Fix reviewer blocker in round 1"],
		});
		let next = action(reply, "plan-implementer");
		assert.equal(next.round, 2);
		assert.equal(next.workerMode, "GUIDED_REPAIR");
		let inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "IMPLEMENTING");
			assert.equal(inspected.plan.round, 2);
			assert.deepEqual(inspected.plan.repair, ["[F001] Fix reviewer blocker in round 1"]);
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
			assert.deepEqual(inspected.plan.repair, [], "Reviewer guidance is not authorized repair");
			assert.deepEqual(inspected.plan.findings, blocker(2).findings);
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
		reply = await finishJudge(service, action(reply, "plan-judge"), "early-block", {
			decision: "BLOCKED", rationale: blockedRationale,
		});
		assert.equal(reply.status, "failed");
		assert.equal(records(reply.actions).length, 0);
		const attention = payload(reply.attention);
		assert.equal(attention.kind, "plan_recovery");
		assert.equal(attention.cause, "judge_blocked");
		assert.deepEqual(payload(attention.continuation), { role: "plan-judge", phase: "READY_JUDGE" });
		let inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.run!.status, "failed");
			assert.equal(inspected.plan.phase, "BLOCKED");
			assert.equal(inspected.plan.round, 1);
			assert.deepEqual(inspected.plan.repair, [blockedRationale]);
			assert.equal(inspected.store.getAttentionRequests(inspected.run!.runId, { unresolvedOnly: true }).filter((candidate) => candidate.cause === "judge_blocked").length, 1);
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
			assert.deepEqual(inspected.plan.repair, [], "Reviewer guidance is not authorized repair");
			assert.deepEqual(inspected.plan.findings, blocker(2).findings);
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
		reply = await finishReviewer(service, action(reply, "plan-reviewer"), "integration-conflict-exhausted", { verdict: "APPROVE" });
		const reviewer = action(reply, "plan-judge");
		await dispatch(service, reviewer, "integration-conflict-exhausted");
		await stopService(fixture.planDirectory);

		const manager = new HerderRunManager(fixture.planDirectory);
		const originalIntegrate = GitDriver.prototype.integrate;
		try {
			const run = manager.store.getRun()!;
			const plan = manager.store.getPlan(run.runId, "001")!;
			manager.store.putPlan({ ...plan, round: 3 });
			manager.store.database.prepare("UPDATE manager_actions SET round_number = 3 WHERE plan_id = '001'").run();
			GitDriver.prototype.integrate = (() => ({ status: "conflict" })) as typeof GitDriver.prototype.integrate;
			const exhausted = await manager.event({
				eventId: "integration-conflict-exhausted-terminal",
				kind: "terminals",
				terminals: [{
					actionId: String(reviewer.actionId),
					hostHandle: "integration-conflict-exhausted-" + String(reviewer.attemptId) + "-host",
					response: judgeResponse({ decision: "DONE" }),
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
			findings: ["[F001][REJECTED][INVALID] fixture evidence does not establish the claimed defect"],
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

for (const profile of ["eclipse", "universe"]) test(`${profile}: Judge REPAIR supplies immutable bindings and PASS_DOCUMENT to round-3 RESCUE after restart`, { timeout: 45_000 }, async (t) => {
	await withFixture("judge-repair", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "judge-repair", profile);
		if (profile === "universe") {
			assert.equal(state.judge.model, "gpt-6-astra");
			assert.equal(state.judge.effort, "xhigh");
			assert.equal(state.judge.serviceTier, undefined);
			assert.deepEqual(state.judge.searcherBinding, { model: "gpt-6-sol", effort: "xhigh" });
		}
		await dispatch(service, state.judge, "judge-repair");
		await stopService(fixture.planDirectory);
		const changedCatalog = loadPiProfileCatalog();
		const changedProfile = changedCatalog.profiles.find((candidate) => candidate.name === profile)!;
		changedProfile.rescue = { model: "catalog-edit", effort: "low" };
		changedProfile.searcher = { model: "catalog-edit", effort: "low" };
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
						findings: [JUDGE_FINDING],
						authorizedBlockers: ["F001"],
						repairContracts: ["[F001] Implement the adjudicated repair contract exactly"],
					}),
				}],
			}));
			manager.close();
			manager = new HerderRunManager(fixture.planDirectory);
			assert.deepEqual(manager.reply().actions, reply.actions, "proposed action bindings must survive another restart");
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
		assert.equal(implementer.model, profile === "universe" ? "gpt-6-astra" : "gpt-6-luna");
		assert.equal(implementer.effort, profile === "universe" ? "xhigh" : "max");
		assert.equal(implementer.serviceTier, profile === "universe" ? undefined : "fast");
		assert.deepEqual(implementer.searcherBinding, profile === "universe" ? { model: "gpt-6-sol", effort: "xhigh" } : undefined);

		assert.match(String(implementer.prompt), /PASS_DOCUMENT_ACTION_ID:/);
		assert.match(String(implementer.prompt), new RegExp(String(state.judge.actionId)));
		assert.match(String(implementer.prompt), /fixture test — passed/);
		assert.ok(String(implementer.prompt).includes(`PASS_DOCUMENT_SHA256: ${sha256("Repair the recorded blocker and rerun the fixture test; original assignment remains authoritative.")}`));
		assert.match(String(implementer.prompt), /sole scope authority/);
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "IMPLEMENTING");
			assert.equal(inspected.plan.round, 3);
			assert.deepEqual(inspected.plan.repair, ["[F001] Implement the adjudicated repair contract exactly"]);
			assertNoApproval(inspected.store, inspected.run!.runId);
			assert.equal(implementer.model, inspected.store.getActions(inspected.run!.runId).find((a) => a.role === "plan-implementer")!.model);
		} finally {
			inspected.store.close();
		}
		reply = await finishImplementer(service, implementer, "judge-repair");
		const reviewer = action(reply, "plan-reviewer");
		assert.equal(reviewer.round, 3);
		assert.equal(reviewer.model, "gpt-6-sol");
		assert.equal(reviewer.effort, "xhigh");
		assert.deepEqual(reviewer.searcherBinding, implementer.searcherBinding);
		assert.match(String(reviewer.prompt), /PASS_DOCUMENT_ACTION_ID:/);
		assert.match(String(reviewer.prompt), /Repair the recorded blocker/);
		reply = await finishReviewer(service, reviewer, "judge-repair", { verdict: "APPROVE" });
		assert.equal(action(reply, "plan-judge").round, 3);
		reply = await finishJudge(service, action(reply, "plan-judge"), "judge-repair", {
			decision: "DONE", findings: ["[F001][REJECTED][INVALID] repair resolved the prior incorrect value"],
		});
		assert.equal(reply.status, "paused");
		const done = inspectPlan(fixture);
		try { assert.equal(done.plan.phase, "DONE"); assert.equal(done.plan.round, 3); }
		finally { done.store.close(); }
	});
});

test("Judge NEEDS_INPUT preserves a quiet decision without revision or automatic Judge replay", { timeout: 45_000 }, async () => {
	await withFixture("judge-input", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "judge-input");
		const question = "Which approved repair boundary | should the Judge apply?";
		const paused = await finishJudge(service, state.judge, "judge-input", {
			decision: "NEEDS_INPUT",
			findings: ["[F001][NONBLOCKING_IN_SCOPE][NEEDS_INPUT] adjudication needs a product decision"],
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

		const submission = {
			planDirectory: fixture.planDirectory,
			kind: "attention",
			attention: { ...attentionResolutionFromRequest(attention as unknown as ManagerAttentionRequest),
				action: "answer_and_resume", answer: "Use only the declared repair contract." },
		};
		await assert.rejects(submitHerderEvent(submission), /host grant/);
		await assert.rejects(submitHerderEvent({ ...submission, attention: { ...submission.attention, action: "revise_run" } }), /host grant/);
		const after = inspectPlan(fixture);
		try {
			assert.equal(after.plan.phase, "NEEDS_INPUT");
			assert.deepEqual(after.plan.repair, [question]);
			assertNoApproval(after.store, after.run!.runId);
		} finally { after.store.close(); }

	});
});

test("Judge BLOCKED ends the run without approval", { timeout: 45_000 }, async () => {
	await withFixture("judge-block", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "judge-block");
		const reply = await finishJudge(service, state.judge, "judge-block", {
			decision: "BLOCKED",
			findings: [JUDGE_FINDING],
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

async function exhaustReview(service: Service, fixture: Fixture, prefix: string, started?: JsonRecord): Promise<{ reply: JsonRecord; reviewer: JsonRecord; judge: JsonRecord }> {
	const state = await reachJudge(service, fixture, prefix, "eclipse", started);
	let reply = await finishJudge(service, state.judge, prefix, {
		decision: "REPAIR", findings: [JUDGE_FINDING],
		repairContracts: ["[F001] Fix the incorrect value"], authorizedBlockers: ["F001"],
		passDocument: "Required: retain integer API, fix incorrect value, run node --test. No waived checks.",
	});
	const implementer = action(reply, "plan-implementer");
	assert.equal(implementer.round, 3);
	assert.equal(implementer.workerMode, "RESCUE");
	reply = await finishImplementer(service, implementer, prefix);
	const reviewer = action(reply, "plan-reviewer");
	await dispatch(service, reviewer, prefix);
	reply = await terminal(service, reviewer, prefix, reviewerResponse({
		verdict: "REVISE", findings: [REMAINING_FINDING],
		fixGuidance: ["Fix the incorrect value"], rationale: "The rescue did not satisfy the recorded requirement",
	}).replace("CHECKS: fixture test — passed", "CHECKS: node --test — failed: incorrect value"));
	const judge = action(reply, "plan-judge");
	assert.equal(judge.round, 3);
	reply = await finishJudge(service, judge, prefix, {
		decision: "REPAIR", findings: [JUDGE_FINDING], authorizedBlockers: ["F001"],
		repairContracts: ["[F001] Fix the incorrect value"],
		rationale: "remaining impact: incorrect value; round-three repair is still required",
	});
	return { reply, reviewer, judge };
}

function resolutionFor(reply: JsonRecord, action: "accept" | "stop" | "revise" | "unchanged_retry" | "revise_run"): AttentionResolutionInput {
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

test("round-3 Judge REPAIR exhausts without round 4 and includes finishing failed evidence", { timeout: 60_000 }, async () => {
	await withFixture("rescue-limit", async (service, fixture) => {
		const state = await exhaustReview(service, fixture, "rescue-limit");
		assert.equal(state.reply.status, "paused");
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
			assert.equal(inspected.store.getActions(inspected.run!.runId).filter((a) => a.role === "plan-judge").length, 3);
			assert.ok(inspected.store.getActions(inspected.run!.runId).every((a) => a.round <= 3));
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally { inspected.store.close(); }
		await assert.rejects(resolve(service, resolutionFor(state.reply, "unchanged_retry"), "no-retry"), /Stopped attention/);
	});
});

test("exhausted plan cannot be accepted or revised by a model, but can stop preserving evidence", { timeout: 60_000 }, async () => {
	await withFixture("retired-acceptance", async (service, fixture) => {
		const state = await exhaustReview(service, fixture, "retired-acceptance");
		const resolution = resolutionFor(state.reply, "accept");
		await assert.rejects(resolve(service, { ...resolution, requestSha256: "0".repeat(64) }, "stale"), /hash/);
		await assert.rejects(resolve(service, { ...resolution, capabilityToken: "0".repeat(64) }, "foreign"), /capability/);
		for (const action of ["accept", "revise", "unchanged_retry"] as const) {
			await assert.rejects(resolve(service, resolutionFor(state.reply, action), `retired-${action}`), action === "accept" ? /host grant/ : /Stopped attention/);
		}
		const worktree = String(state.reviewer.worktree);
		const head = git(worktree, ["rev-parse", "HEAD"]).stdout;
		await assert.rejects(resolve(service, resolutionFor(state.reply, "revise_run"), "whole-run-proposal"), /host grant/);
		const stopped = await resolve(service, resolutionFor(state.reply, "stop"), "preserve-work");
		assert.deepEqual(stopped.actions, []);
		assert.equal(stopped.status, "paused");
		assert.equal(stopped.runRevision, undefined);
		assert.equal(git(worktree, ["rev-parse", "HEAD"]).stdout, head);
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.phase, "BLOCKED");
			assert.equal(inspected.plan.round, 3);
			assert.deepEqual(inspected.plan.findings, [JUDGE_FINDING]);
			assertNoApproval(inspected.store, inspected.run!.runId);
			assert.notEqual(inspected.store.getAttention(resolution.requestId)?.state, "resolved");
		} finally { inspected.store.close(); }
	});
});

test("mutated transport pauses immediately without consuming a new product round or invoking Judge", { timeout: 30_000 }, async () => {
	await withFixture("transport-rescue", async (service, fixture) => {
		let reply = await startRun(service, fixture, "transport-rescue");
		let implementer = action(reply, "plan-implementer");
		await dispatch(service, implementer, "transport-rescue");
		reply = await terminal(service, implementer, "transport-rescue", failedImplementerResponse("round-one operational failure"));
		implementer = action(reply, "plan-implementer");
		assert.equal(implementer.round, 2);
		await dispatch(service, implementer, "transport-rescue");
		const file = path.join(String(implementer.worktree), "src/value.mjs");
		fs.writeFileSync(file, "export const value = 2; // unfinished\n");
		reply = payload(payload(await requestManagerOperation(service, "event", {
			eventId: "transport-failure-2", kind: "terminals", terminals: [{ actionId: implementer.actionId, interrupted: true, error: "WebSocket interrupted operational round 2" }],
		})).reply);
		assert.equal(reply.status, "needs_input");
		assert.deepEqual(reply.actions, []);
		const request = payload(reply.attention);
		assert.equal(request.kind, "operator_attention");
		assert.equal(request.cause, "transport_exhausted");
		assert.match(String(request.detail), /WebSocket interrupted operational round 2/);
		assert.match(fs.readFileSync(file, "utf8"), /unfinished/);
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.round, 2);
			assert.equal(inspected.store.countActions(inspected.run!.runId), 2);
			assert.ok(inspected.store.getActions(inspected.run!.runId).every((a) => a.role !== "plan-judge"));
		} finally { inspected.store.close(); }
	});
});

test("exhaustion preserves independent sibling evidence and never unlocks blocked dependencies", { timeout: 60_000 }, async () => {
	await withFixture("accept-scheduling", async (service, fixture) => {
		const readme = path.join(fixture.planDirectory, "README.md");
		fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replace("\n\n## Dependency notes", ["",
			"| [002](002-independent.md) | Independent | P1 | S | — | TODO |",
			"| [003](003-dependent.md) | Dependent | P1 | S | 001 | TODO |", "", "## Dependency notes",
		].join("\n")));
		fs.writeFileSync(path.join(fixture.planDirectory, "002-independent.md"), FIXTURE_PLAN(fixture.originalHead).replace("# Plan 001:", "# Plan 002:").replaceAll("src/value.mjs", "src/independent.mjs"));
		fs.writeFileSync(path.join(fixture.planDirectory, "003-dependent.md"), FIXTURE_PLAN(fixture.originalHead).replace("# Plan 001:", "# Plan 003:").replace("**Depends on**: none", "**Depends on**: 001").replace("Dependencies: none.", fixtureDependencies("001")).replaceAll("src/value.mjs", "src/dependent.mjs"));
		const started = await startRun(service, fixture, "accept-scheduling", "eclipse", 2);
		const sibling = records(started.actions).find(candidate => candidate.planId === "002");
		assert.ok(sibling);
		assert.equal(sibling.role, "plan-implementer");
		assert.equal(records(started.actions).some((a) => a.planId === "003"), false);
		await dispatch(service, sibling, "sibling");
		const siblingWorktree = String(sibling.worktree);
		fs.writeFileSync(path.join(siblingWorktree, "src/independent.mjs"), "export const independent = 1\n");
		git(siblingWorktree, ["add", "src/independent.mjs"]);
		git(siblingWorktree, ["commit", "-qm", "test: independent patch"]);
		let reply = await terminal(service, sibling, "sibling", implementerResponse(git(siblingWorktree, ["rev-parse", "HEAD"]).stdout.trim()).replaceAll("src/value.mjs", "src/independent.mjs"));
		reply = await finishReviewer(service, action(reply, "plan-reviewer"), "sibling", { verdict: "BLOCK", rationale: "Independent operator decision" });
		reply = await finishJudge(service, action(reply, "plan-judge"), "sibling", { decision: "BLOCKED", rationale: "Independent operator decision" });
		const before = inspectPlan(fixture);
		const siblingActions = before.store.getActions(before.run!.runId).filter(candidate => candidate.planId === "002");
		before.store.close();
		const state = await exhaustReview(service, fixture, "accept-scheduling", reply);
		reply = state.reply;
		assert.equal(reply.status, "paused", "round exhaustion pauses scheduling without discarding sibling evidence");
		await assert.rejects(resolve(service, resolutionFor(state.reply, "accept"), "retired-unlock"), /host grant/);
		await assert.rejects(resolve(service, resolutionFor(state.reply, "revise_run"), "whole-run-barrier"), /host grant/);
		assert.deepEqual(reply.actions, []);
		assert.equal(reply.runRevision, undefined);
		assert.equal(fs.readFileSync(path.join(siblingWorktree, "src/independent.mjs"), "utf8"), "export const independent = 1\n");
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.store.getPlan(inspected.run!.runId, "002")?.phase, "BLOCKED");
			assert.deepEqual(inspected.store.getActions(inspected.run!.runId).filter(candidate => candidate.planId === "002"), siblingActions);
			assert.equal(inspected.store.getPlan(inspected.run!.runId, "003"), null);
			assertNoApproval(inspected.store, inspected.run!.runId);
			assert.equal(inspected.store.getAttentionRequests(inspected.run!.runId, { unresolvedOnly: true }).length, 2);
		} finally { inspected.store.close(); }
	});
});

test("malformed obligations and incidental FOLLOWUP cannot authorize repair", { timeout: 60_000 }, async () => {
	const scenarios: Array<{ name: string; result: ReviewerEnvelope; approved?: boolean }> = [
		{ name: "unknown-id", result: { ...blocker(1), findings: [REMAINING_FINDING.replace("obligation=A1", "obligation=A99")] } },
		{ name: "missing-evidence", result: { ...blocker(1), findings: [REMAINING_FINDING.replace(/; evidence=[^;]+/, "")] } },
		{ name: "missing-cause", result: { ...blocker(1), findings: [REMAINING_FINDING.replace(/; violation=[^;]+/, "")] } },
		{ name: "followup-revise", result: { verdict: "REVISE", findings: ["[NEW][P2][ADVISORY][FOLLOWUP] incidental formatting"] } },
		{ name: "approve-scope-fail", result: { verdict: "APPROVE", scope: "FAIL" } },
		{ name: "approve-with-blocker", result: { ...blocker(1), verdict: "APPROVE" } },
		{ name: "followup-approve", result: { verdict: "APPROVE", findings: ["[NEW][P2][ADVISORY][FOLLOWUP] incidental formatting"] }, approved: true },
	];
	for (const scenario of scenarios) await withFixture(scenario.name, async (service, fixture) => {
		let reply = await startRun(service, fixture, scenario.name);
		reply = await finishImplementer(service, action(reply, "plan-implementer"), scenario.name);
		const reviewer = action(reply, "plan-reviewer");
		reply = await finishReviewer(service, reviewer, scenario.name, scenario.result);
		if (["unknown-id", "followup-revise", "followup-approve"].includes(scenario.name)) {
			assert.equal(action(reply, "plan-judge").round, 1);
			reply = await finishJudge(service, action(reply, "plan-judge"), scenario.name, {
				decision: scenario.approved ? "DONE" : "NEEDS_INPUT",
				findings: scenario.name === "unknown-id"
					? ["[F001][REJECTED][INVALID] obligation A99 is not authorized"]
					: [`[F-${sha256(String(reviewer.actionId))}-1][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] incidental formatting is not required`],
				question: scenario.approved ? undefined : "Review does not establish authorized repair; complete the required review.",
			});
		}
		assert.deepEqual(reply.actions, []);
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.round, 1);
			if (scenario.approved) {
				assert.equal(reply.status, "paused");
				assert.equal(inspected.plan.phase, "DONE");
				assert.ok(inspected.store.getApproval(inspected.run!.runId, "001", 1));
			} else {
				assert.equal(reply.status, "needs_input");
				assert.equal(payload(reply.attention).cause, ["unknown-id", "followup-revise"].includes(scenario.name) ? "judge_needs_input" : "worker_protocol_error");
				assertNoApproval(inspected.store, inspected.run!.runId);
			}
		} finally { inspected.store.close(); }
	});
});

test("Judge cannot authorize an invented obligation over validated reviewer evidence", { timeout: 30_000 }, async () => {
	await withFixture("judge-invented", async (service, fixture) => {
		const state = await reachJudge(service, fixture, "judge-invented");
		const reply = await finishJudge(service, state.judge, "judge-invented", {
			decision: "REPAIR",
			findings: [JUDGE_FINDING.replace("obligation=A1", "obligation=A99")],
			authorizedBlockers: ["F001"], repairContracts: ["[F001] invented scope"],
		});
		assert.equal(reply.status, "needs_input");
		assert.deepEqual(reply.actions, []);
		assert.equal(payload(reply.attention).cause, "worker_protocol_error");
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.round, 2);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally { inspected.store.close(); }
	});
});

test("safety discovery pauses for a decision rather than code repair", { timeout: 30_000 }, async () => {
	await withFixture("safety", async (service, fixture) => {
		let reply = await startRun(service, fixture, "safety");
		reply = await finishImplementer(service, action(reply, "plan-implementer"), "safety");
		reply = await finishReviewer(service, action(reply, "plan-reviewer"), "safety", {
			verdict: "BLOCK", blockerKind: "SAFETY",
			rationale: "The required reproduction would delete customer data; operator must select a safe isolated environment.",
		});
		const judge = action(reply, "plan-judge");
		assert.equal(judge.round, 1);
		reply = await finishJudge(service, judge, "safety", {
			decision: "BLOCKED", blockerKind: "SAFETY",
			rationale: "The required reproduction would delete customer data; operator must select a safe isolated environment.",
		});
		assert.equal(reply.status, "paused");
		assert.deepEqual(reply.actions, []);
		assert.equal(payload(reply.attention).kind, "user_decision");
		const inspected = inspectPlan(fixture);
		try {
			assert.equal(inspected.plan.round, 1);
			assertNoApproval(inspected.store, inspected.run!.runId);
		} finally { inspected.store.close(); }
	});
});

test("mandatory Judge: approval and unrelated safety defect require round-one adjudication", { timeout: 60_000 }, async () => {
	for (const safety of [false, true]) await withFixture(`mandatory-${safety}`, async (service, fixture) => {
		const prefix = `mandatory-${safety}`;
		let reply = await startRun(service, fixture, prefix);
		reply = await finishImplementer(service, action(reply, "plan-implementer"), prefix);
		const reviewer = action(reply, "plan-reviewer");
		reply = await finishReviewer(service, reviewer, prefix, safety ? {
			verdict: "BLOCK", blockerKind: "SAFETY", findings: ["[F900][P1][BLOCKING][PLAN_REQUIREMENT] preexisting issue; obligation=unknown; evidence=legacy unsafe feature outside this patch; violation=unrelated behavior"],
		} : { verdict: "APPROVE" });
		const judge = action(reply, "plan-judge");
		assert.equal(judge.round, 1);
		const before = inspectPlan(fixture);
		try { assertNoApproval(before.store, before.run!.runId); } finally { before.store.close(); }
		reply = await finishJudge(service, judge, prefix, { decision: "DONE", findings: safety ? ["[F900][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] preexisting and unrelated to the original contract"] : [] });
		const after = inspectPlan(fixture);
		try {
			assert.equal(after.plan.phase, "DONE");
			assert.equal(after.store.getApproval(after.run!.runId, "001", 1)?.decisionRole, "plan-judge");
			assert.equal(after.store.getBudget(after.run!.runId)?.limit, 21);
		} finally { after.store.close(); }
		assert.equal(records(reply.roundProgress)[0]?.outcome, "DONE");
	});
});

test("mandatory Judge: bounded repair guidance, summary, exclusions and round-three stop", { timeout: 60_000 }, async () => {
	await withFixture("mandatory-bounds", async (service, fixture) => {
		let reply = await startRun(service, fixture, "bounded");
		for (let round = 1; round <= 3; round++) {
			const implementer = action(reply, "plan-implementer");
			assert.equal(implementer.round, round);
			if (round > 1) {
				assert.match(String(implementer.prompt), /PREVIOUS_ROUND_SUMMARY:/);
				assert.match(String(implementer.prompt), /CUMULATIVE_EXCLUDED_FINDINGS:.*F900/);
				const inspected = inspectPlan(fixture);
				try { assert.deepEqual(inspected.plan.repair, ["[F001] Judge authorized fix only"]); } finally { inspected.store.close(); }
			}
			reply = await finishImplementer(service, implementer, "bounded");
			reply = await finishReviewer(service, action(reply, "plan-reviewer"), "bounded", { ...blocker(round), findings: [REMAINING_FINDING, "[F900][P2][ADVISORY][FOLLOWUP] unrelated issue"] });
			reply = await finishJudge(service, action(reply, "plan-judge"), "bounded", { decision: "REPAIR", findings: [JUDGE_FINDING, "[F900][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] not caused by this patch"], authorizedBlockers: ["F001"], repairContracts: ["[F001] Judge authorized fix only"] });
		}
		assert.deepEqual(reply.actions, []);
		assert.equal(payload(reply.attention).cause, "round_limit");
		const inspected = inspectPlan(fixture);
		try { assert.equal(inspected.plan.phase, "BLOCKED"); assert.equal(inspected.plan.round, 3); assertNoApproval(inspected.store, inspected.run!.runId); }
		finally { inspected.store.close(); }
	});
});

test("NEW Reviewer identities persist into Judge prompts, replay and approval hashes", { timeout: 30_000 }, async () => {
	await withFixture("new-identities", async (service, fixture) => {
		const prefix = "new-identities";
		let reply = await startRun(service, fixture, prefix);
		reply = await finishImplementer(service, action(reply, "plan-implementer"), prefix);
		const reviewer = action(reply, "plan-reviewer");
		const envelope: ReviewerEnvelope = { verdict: "APPROVE", findings: ["[NEW][P2][ADVISORY][FOLLOWUP] incidental formatting"], fixGuidance: ["[NEW] optional formatting"] };
		reply = await finishReviewer(service, reviewer, prefix, envelope);
		const id = `F-${sha256(String(reviewer.actionId))}-1`;
		const judge = action(reply, "plan-judge");
		let inspected = inspectPlan(fixture);
		let hash: string;
		let stored: unknown;
		try {
			stored = inspected.store.getAction(String(reviewer.actionId))!.result;
			const result = payload(payload(stored).workerResult);
			assert.deepEqual(result.findings, [`[${id}][P2][ADVISORY][FOLLOWUP] incidental formatting`]);
			assert.deepEqual(result.fixGuidance, [`[${id}] optional formatting`]);
			hash = sha256(stableJson(result));
			assert.ok(String(judge.prompt).includes(id));
			assert.ok(String(judge.prompt).includes(`WORKER_RESULT_SHA256: ${hash}`));
		} finally { inspected.store.close(); }
		const replay = await terminal(service, reviewer, prefix, reviewerResponse(envelope));
		assert.deepEqual(replay.actions, reply.actions);
		reply = await finishJudge(service, judge, prefix, { decision: "DONE", findings: [`[${id}][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] unrelated formatting`] });
		inspected = inspectPlan(fixture);
		try {
			assert.deepEqual(inspected.store.getAction(String(reviewer.actionId))!.result, stored);
			assert.equal(inspected.store.getApproval(inspected.run!.runId, "001", 1)?.reviewResultSha256, hash!);
			assert.deepEqual(records(reply.roundProgress)[0]?.notIntendedToFix, [`[${id}][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] unrelated formatting`]);
		} finally { inspected.store.close(); }
	});
});

test("excluded NEW advisory cannot authorize repeated repair but changed introduced regression reopens", { timeout: 60_000 }, async () => {
	for (const variant of ["advisory", "unchanged", "introduced"] as const) await withFixture(`new-${variant}`, async (service, fixture) => {
		let reply = await startRun(service, fixture, variant);
		reply = await finishImplementer(service, action(reply, "plan-implementer"), variant);
		const reviewer = action(reply, "plan-reviewer");
		const oldFields = "obligation=A1; evidence=src/value.mjs:1 baseline returns zero for special input; violation=special input does not return an integer";
		const advisory = `[NEW][P2][ADVISORY][FOLLOWUP] preexisting special input; ${oldFields}`;
		reply = await finishReviewer(service, reviewer, variant, { verdict: "REVISE", findings: [REMAINING_FINDING, advisory] });
		const id = `F-${sha256(String(reviewer.actionId))}-2`;
		const exclusion = `[${id}][DEFERRED_OUT_OF_SCOPE][FOLLOWUP] preexisting special input`;
		reply = await finishJudge(service, action(reply, "plan-judge"), variant, {
			decision: "REPAIR", findings: [JUDGE_FINDING, exclusion], authorizedBlockers: ["F001"], repairContracts: ["[F001] Fix assigned value"],
		});
		assert.deepEqual(records(reply.roundProgress)[0]?.notIntendedToFix, [exclusion]);
		reply = await finishImplementer(service, action(reply, "plan-implementer"), variant);
		const fields = variant === "introduced" ? oldFields.replace("baseline returns zero", "repair commit now throws") : oldFields;
		const candidate = variant === "advisory" ? advisory : `[${variant === "introduced" ? id : "NEW"}][P1][BLOCKING][PATCH_REGRESSION] special input; ${fields}`;
		reply = await finishReviewer(service, action(reply, "plan-reviewer"), variant, { verdict: "REVISE", findings: [candidate] });
		assert.ok(String(action(reply, "plan-judge").prompt).includes(id));
		reply = await finishJudge(service, action(reply, "plan-judge"), variant, {
			decision: "REPAIR", findings: [`[${id}][BLOCKING_IN_SCOPE][PATCH_REGRESSION] confirmed; ${fields}; regression_rationale=repair introduced a throwing path`],
			authorizedBlockers: [id], repairContracts: [`[${id}] restore special input behavior`],
		});
		if (variant === "introduced") {
			assert.equal(action(reply, "plan-implementer").round, 3);
			assert.deepEqual(records(reply.roundProgress).at(-1)?.notIntendedToFix, []);
		} else {
			assert.deepEqual(reply.actions, []);
			assert.equal(payload(reply.attention).cause, "worker_protocol_error");
			assert.deepEqual(records(reply.roundProgress).at(-1)?.notIntendedToFix, [exclusion]);
		}
	});
});
