import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { grantHostAttention } from "../../../src/core/run-revision.ts";
import { git } from "../../../src/daemon/git-driver.ts";
import { attentionResolutionFromRequest } from "../../../adapters/attention.ts";
import { integrationRepairCapabilityToken, sha256, stableJson, type ManagerAction, type ManagerAttentionRequest, type ManagerReply, type TerminalEvent, type VerificationManifest } from "../../../src/shared/protocol.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";

function planText(id: string, head: string): string {
	return fixturePlan({
		id,
		head,
		plannedAt: "2026-08-20",
		title: `Update value ${id}`,
		writePaths: [`value-${id}.mjs`],
		parentObjective: "Exercise bounded runtime failure routing.",
		acceptance: `Value ${id} exports two.`,
		implementation: `Change the exported literal in value-${id}.mjs for A1; check V1.`,
		verificationCommand: `node --input-type=module -e 'import {value} from "./value-${id}.mjs"; if(value !== 2) process.exit(1)'`,
		toolchainOwner: "npm project scripts",
		toolchainPrerequisites: "Node >=22.19 installed",
		toolchainEvidence: "`package.json`",
	});
}

async function fixture(count = 1, beforeStart?: (planDirectory: string) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-environment-"));
	const ids = Array.from({ length: count }, (_, i) => String(i + 1).padStart(3, "0"));
	const { repo, originalHead } = initFixtureRepo(root, {
		name: "Herder Environment Test", email: "environment@example.invalid",
		files: { "package.json": '{"private":true,"type":"module"}\n', ...Object.fromEntries(ids.map((id) => [`value-${id}.mjs`, "export const value = 1;\n"])) },
	});
	const planDirectory = path.join(repo, "herder-plans");
	initPlanDir(planDirectory);
	fs.writeFileSync(path.join(planDirectory, "README.md"), `# Herder Plans\n\n## Execution order & status\n\n| Plan | Title | Priority | Effort | Depends on | Status |\n|---|---|---|---|---|---|\n${ids.map((id) => `| [${id}](${id}-value.md) | Update value ${id} | P1 | S | — | TODO |`).join("\n")}\n\n## Dependency notes\n\nNone.\n\n## Considered and rejected\n\nNone.\n`);
	for (const id of ids) fs.writeFileSync(path.join(planDirectory, `${id}-value.md`), planText(id, originalHead));
	let manager = new HerderRunManager(planDirectory);
	try {
		beforeStart?.(planDirectory);
		const reply = await manager.start({ mode: "fire", repositoryRoot: repo, planDirectory, profile: "eclipse", maxParallel: 1 });
		return {
			get manager() { return manager; }, reply, repo, planDirectory,
			restart() { manager.close(); manager = new HerderRunManager(planDirectory); },
			close() { manager.close(); fs.rmSync(root, { recursive: true, force: true }); },
		};
	} catch (error) { manager.close(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function action(reply: ManagerReply, role?: ManagerAction["role"]): ManagerAction {
	const found = reply.actions.find((action) => !role || action.role === role);
	assert.ok(found, `expected ${role ?? "worker"}: ${reply.message}`);
	return found;
}
async function dispatch(f: Fixture, a: ManagerAction): Promise<void> {
	await f.manager.event({ eventId: `dispatch:${a.actionId}`, kind: "dispatch_results", dispatchResults: [{ actionId: a.actionId, accepted: true, hostHandle: a.actionId }] });
}
function terminal(f: Fixture, a: ManagerAction, response: string, eventId = `terminal:${a.actionId}`) {
	return f.manager.event({ eventId, kind: "terminals", terminals: [{ actionId: a.actionId, hostHandle: a.actionId, response }] });
}
async function implemented(f: Fixture, a: ManagerAction) {
	await dispatch(f, a);
	fs.writeFileSync(path.join(a.worktree, `value-${a.planId}.mjs`), `export const value = 2; // round ${a.round}\n`);
	git(a.worktree, ["add", "."]);
	git(a.worktree, ["commit", "-qm", `test: implement round ${a.round}`]);
	return terminal(f, a, "STATUS: COMPLETE\nCHECKS: fixture value inspected\nNOTES: complete");
}
const setup = "SETUP: manager=npm project scripts; command=npm ci; cwd=/repo; result=failed; error=declared cache unavailable; prerequisite=locked dependencies";
const checks = "CHECKS: command=npm test; cwd=/repo; result=not run because setup failed";
function blocked(role: ManagerAction["role"], kind = "ENVIRONMENT") {
	const detail = "Declared locked dependency restoration failed; operator action is required";
	return [role === "plan-implementer" ? `STATUS: STOPPED\nSTOPPED BECAUSE: ${detail}`
		: role === "plan-reviewer" ? `VERDICT: BLOCK\nSCOPE: PASS\nFINDINGS: none\nRATIONALE: ${detail}`
			: `DECISION: BLOCKED\nAUTHORIZED_BLOCKERS: none\nREPAIR_CONTRACTS: none\nRATIONALE: ${detail}`,
		`BLOCKER_KIND: ${kind}`, setup, checks].join("\n");
}
function retry(f: Fixture, request: ManagerAttentionRequest, eventId = `retry:${request.requestId}`) {
	const attention = { ...attentionResolutionFromRequest(request), action: "retry", rationale: "Operator confirmed the declared prerequisite was prepared." };
	grantHostAttention(f.manager.store.getRun()!, attention);
	return f.manager.event({ eventId, kind: "attention", attention });
}
function runtime(f: Fixture, id = "001") { return f.manager.store.getPlan(f.manager.store.getRun()!.runId, id)!; }
const finding = "[value][P1][BLOCKING][PLAN_REQUIREMENT] incorrect value; obligation=A1; evidence=value assertion failed; violation=export is not the required two";
const revise = `VERDICT: REVISE\nSCOPE: PASS\nFINDINGS: ${finding}\nFIX_GUIDANCE: [value] fix the value\nRATIONALE: bounded code defect\nCHECKS: value assertion failed`;
const approve = "VERDICT: APPROVE\nSCOPE: PASS\nFINDINGS: none\nCHECKS: inspected value\nRATIONALE: accepted";

async function reviewer(f: Fixture) { return action(await implemented(f, action(f.reply)), "plan-reviewer"); }
async function judge(f: Fixture) {
	let review = await reviewer(f);
	await dispatch(f, review);
	const implementation = action(await terminal(f, review, revise), "plan-implementer");
	review = action(await implemented(f, implementation), "plan-reviewer");
	await dispatch(f, review);
	return action(await terminal(f, review, revise), "plan-judge");
}
async function finalRequest(f: Fixture) {
	const review = await reviewer(f);
	await dispatch(f, review);
	const ready = await terminal(f, review, approve);
	const request = ready.verificationRequest!;
	assert.ok(request);
	return request;
}
async function finalReviewer(f: Fixture) {
	const request = await finalRequest(f);
	const reply = await f.manager.verification({
		...request, rationale: "Source-preserving final fixture check", gates: [{ gateId: "final", label: "final", cwd: ".", argv: [process.execPath, "-e", "process.exit(0)"], rationale: "Bound final audit to a successful exact-tree manager gate" }],
	});
	const audit = action(reply, "plan-reviewer");
	assert.equal(audit.planId, "RUN");
	return audit;
}

function budgetTerminal(f: Fixture, a: ManagerAction, eventId = `budget:${a.actionId}`, overrides: Partial<TerminalEvent> = {}) {
	return f.manager.event({ eventId, kind: "terminals", terminals: [{
		actionId: a.actionId, hostHandle: a.actionId, interrupted: true, failureKind: "review_budget_exhausted",
		response: `${approve}\nUSAGE: input_tokens=999; output_tokens=999; source=partial-worker`,
		error: "Host reviewer wall-clock budget expired", usage: {
			inputTokens: 12, outputTokens: 3, source: "test-host", durationMs: 60_000,
			nested: [{ type: "reviewer", model: a.model, effort: a.effort, count: 4, inputTokens: 8, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 1 }],
		}, ...overrides,
	}] });
}

async function budgetReviewer(f: Fixture, stage: "discovery" | "verification" | "rescue" | "final") {
	if (stage === "final") return finalReviewer(f);
	if (stage === "rescue") {
		const a = await judge(f);
		await dispatch(f, a);
		const repair = await terminal(f, a, "DECISION: REPAIR\nFINDINGS: [value][BLOCKING_IN_SCOPE][PLAN_REQUIREMENT] incorrect value; obligation=A1; evidence=value assertion failed; violation=export is not the required two\nAUTHORIZED_BLOCKERS: value\nREPAIR_CONTRACTS: [value] fix the value\nPASS_DOCUMENT: Preserve the export and verify its value\nRATIONALE: bounded repair");
		return action(await implemented(f, action(repair)), "plan-reviewer");
	}
	const a = await reviewer(f);
	if (stage === "discovery") return a;
	await dispatch(f, a);
	return action(await implemented(f, action(await terminal(f, a, revise))), "plan-reviewer");
}

async function assertWholeRunRecovery(f: Awaited<ReturnType<typeof fixture>>, request: ManagerAttentionRequest): Promise<void> {
	const before = f.manager.store.getPlan(request.runId, request.planId);
	const generation = f.manager.store.getRun()!.currentGeneration;
	for (const action of ["answer_and_resume", "retry", "accept", "revise", "reject", "unchanged_retry", "revise_run"]) {
		await assert.rejects(f.manager.event({ eventId: `unauthorized:${action}:${request.requestId}`, kind: "attention", attention: { ...attentionResolutionFromRequest(request), action, answer: "Model claims user approval", rationale: "Model rationale", confirmed: true } }), /host grant|Stopped attention|host-authorized/);
	}
	assert.deepEqual(f.manager.reply().actions.filter(action => action.planId === request.planId), []);
	assert.equal(f.manager.reply().runRevision, undefined);
	assert.equal(f.manager.store.getRun()!.currentGeneration, generation);
	assert.deepEqual(f.manager.store.getPlan(request.runId, request.planId), before);
	assert.notEqual(f.manager.store.getAttention(request.requestId)?.state, "resolved");
	assert.ok(before && fs.existsSync(before.worktree));
	f.restart();
	assert.deepEqual(f.manager.reply().actions.filter(action => action.planId === request.planId), []);
	assert.deepEqual((await resume(f)).actions.filter(action => action.planId === request.planId), []);
}

for (const stage of ["discovery", "verification", "rescue", "final"] as const) test(`${stage} reviewer budget ignores partial APPROVE and preserves evidence without automatic revision`, { timeout: 45_000 }, async () => {
	const f = await fixture();
	try {
		const a = await budgetReviewer(f, stage);
		const seeded = runtime(f, a.planId);
		f.manager.store.putPlan({ ...seeded, findings: [...seeded.findings, "[prior] recorded unresolved finding"], repair: [...seeded.repair, "[prior] recorded repair guidance"] });
		const before = runtime(f, a.planId);
		await dispatch(f, a);
		const reply = await budgetTerminal(f, a);
		const request = reply.attention!;
		assert.equal(reply.status, "needs_input");
		assert.equal(reply.actions.length, 0);
		assert.equal(request.kind, "operator_attention");
		assert.equal(request.cause, "review_budget_exhausted");
		assert.deepEqual(request.continuation, { role: "plan-reviewer", phase: "READY_REVIEWER" });
		assert.equal(request.round, before.round);
		assert.match(request.detail, /HOST_FAILURE: review_budget_exhausted/);
		assert.match(request.detail, /HOST_USAGE: .*"inputTokens":12/);
		assert.match(request.detail, /PARTIAL_RESPONSE \(non-authoritative diagnostic evidence\):\nVERDICT: APPROVE/);
		assert.equal(runtime(f, a.planId).phase, "NEEDS_INPUT");
		for (const key of ["round", "reviewPass", "findings", "repair", "approvedHead", "approvedTree", "assignmentSha256"] as const) {
			assert.deepEqual(runtime(f, a.planId)[key], before[key], key);
		}
		assert.equal(f.manager.store.getApproval(a.runId, a.planId, a.generation), null);
		assert.equal(f.manager.store.getReigniteRequest(a.runId, a.generation), null);
		const record = f.manager.store.getAction(a.actionId)!.result as { workerResult: unknown; outcome: string; terminal: TerminalEvent; usage: TerminalEvent["usage"] };
		assert.equal(record.workerResult, null);
		assert.equal(record.outcome, "INTERRUPTED");
		assert.equal(record.terminal.failureKind, "review_budget_exhausted");
		assert.equal(record.terminal.interrupted, true);
		assert.match(record.terminal.response!, /^VERDICT: APPROVE/);
		assert.equal(record.terminal.error, "Host reviewer wall-clock budget expired");
		assert.equal(record.usage?.inputTokens, 12);
		assert.equal(record.usage?.nested?.[0]?.count, 4);
		assert.equal(record.usage?.durationMs, 60_000);
		const attempts = f.manager.store.countActions(a.runId);
		f.restart();
		assert.deepEqual(f.manager.reply().attention, request);
		await budgetTerminal(f, a);
		await budgetTerminal(f, a, "new-budget-delivery");
		const resumed = await resume(f);
		assert.equal(resumed.actions.length, 0);
		assert.notEqual(resumed.status, "complete");
		assert.equal(f.manager.store.countActions(a.runId), attempts);
		assert.equal(f.manager.store.getAttentionRequests(a.runId).length, 1);
		assert.equal(f.manager.store.getTerminalActionsMissingUsage(a.runId).length, 0);
		const usageCount = f.manager.store.database.prepare("SELECT COUNT(*) AS count FROM attempts WHERE attempt_id = ?").get(a.attemptId) as { count: number };
		assert.equal(usageCount.count, 1);
		await assert.rejects(f.manager.event({ eventId: "legacy-budget-answer", kind: "user_input", attentionRequestId: request.requestId, userInput: "retry" }), /request-bound explicit retry or cancel/);
		if (stage !== "final") { await assertWholeRunRecovery(f, request); return; }
		for (const decision of ["accept", "revise"] as const) {
			await assert.rejects(f.manager.event({ eventId: `invalid-budget-${decision}`, kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: decision, answer: "continue", rationale: "continue", confirmed: true } }), /Stopped attention/);
		}
		await assert.rejects(f.manager.event({ eventId: "wrong-budget-hash", kind: "attention", attention: { ...attentionResolutionFromRequest(request), requestSha256: "0".repeat(64), action: "retry" } }), /hash does not match/);
		await assert.rejects(f.manager.event({ eventId: "unconfirmed-budget-retry", kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "retry" } }), /host grant/);
		const next = action(await retry(f, request));
		assert.equal(next.role, a.role);
		assert.equal(next.workerMode, a.workerMode);
		assert.equal(next.round, a.round);
		assert.equal(next.assignmentSha256, a.assignmentSha256);
		assert.equal(next.worktree, a.worktree);
		assert.notEqual(next.actionId, a.actionId);
		assert.equal(runtime(f, a.planId).reviewPass, before.reviewPass);
		assert.deepEqual(runtime(f, a.planId).findings, before.findings);
		assert.deepEqual(runtime(f, a.planId).repair.slice(0, before.repair.length), before.repair);
		f.restart();
		assert.equal(action(await retry(f, request)).actionId, next.actionId);
		await assert.rejects(f.manager.event({ eventId: "divergent-budget-resolution", kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "cancel" } }), /different resolution/);
		if (stage === "final") {
			assert.equal(next.workerMode, "FINAL_AUDIT");
			await dispatch(f, next);
			assert.equal((await terminal(f, next, approve)).status, "complete");
		}
	} finally { f.close(); }
});

for (const stage of ["discovery", "final"] as const) test(`${stage} reviewer budget cancellation survives restart and resume without cleanup or Reignite`, { timeout: 45_000 }, async () => {
	const f = await fixture();
	try {
		const a = await budgetReviewer(f, stage);
		await dispatch(f, a);
		const before = runtime(f, a.planId);
		const request = (await budgetTerminal(f, a)).attention!;
		if (stage !== "final") { await assertWholeRunRecovery(f, request); return; }
		const cancel = () => f.manager.event({ eventId: "cancel-budget", kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "cancel", rationale: "Stop the incomplete review" } });
		assert.equal((await cancel()).actions.length, 0);
		f.restart();
		assert.equal((await cancel()).actions.length, 0);
		const reply = await resume(f);
		assert.notEqual(reply.status, "complete");
		assert.equal(reply.actions.length, 0);
		assert.equal(runtime(f, a.planId).phase, "BLOCKED");
		assert.equal(runtime(f, a.planId).approvedTree, before.approvedTree);
		assert.equal(runtime(f, a.planId).reviewPass, before.reviewPass);
		assert.ok(fs.existsSync(a.worktree));
		assert.equal(f.manager.store.getReigniteRequest(a.runId, a.generation), null);
		assert.notEqual(f.manager.store.getAttention(request.requestId)?.state, "resolved", "cancellation preserves later explicit host recovery");
	} finally { f.close(); }
});

test("late interrupted work preserves evidence without reopening a stopped run", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = action(f.reply);
		await dispatch(f, a);
		fs.writeFileSync(path.join(a.worktree, "value-001.mjs"), "export const value = 99; // unfinished patch\n");
		f.manager.stop();
		const reply = await f.manager.event({ eventId: "late-stopped-transport", kind: "terminals", terminals: [{ actionId: a.actionId, hostHandle: a.actionId, interrupted: true, error: "WebSocket failed" }] });
		assert.equal(reply.status, "stopped");
		assert.deepEqual(reply.actions, []);
		assert.match(fs.readFileSync(path.join(a.worktree, "value-001.mjs"), "utf8"), /unfinished patch/);
		assert.equal(f.manager.store.countActions(a.runId), 1);
		f.restart();
		assert.equal(f.manager.reply().status, "stopped");
	} finally { f.close(); }
});

for (const stop of ["user", "budget"] as const) test(`a stale proposed dispatch cannot start after persisted ${stop} stop`, { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = action(f.reply);
		if (stop === "user") f.manager.stop();
		else {
			const budget = f.manager.store.getBudget(a.runId)!;
			for (let index = budget.used; index < budget.limit; index++) f.manager.store.reserveBudget({ runId: a.runId, generation: a.generation, reservationId: `test-spend:${index}`, kind: "repair", payloadSha256: sha256(String(index)) });
			assert.throws(() => f.manager.store.reserveBudget({ runId: a.runId, generation: a.generation, reservationId: "one-too-many", kind: "repair", payloadSha256: sha256("exhausted") }), /budget exhausted/);
		}
		f.restart();
		assert.deepEqual(f.manager.reply().actions, []);
		await assert.rejects(dispatch(f, a), /stopped or paused/);
		assert.equal(f.manager.store.getAction(a.actionId)?.state, "proposed");
		assert.ok(fs.existsSync(a.worktree));
		if (stop === "budget") {
			assert.deepEqual((await resume(f)).actions, []);
			assert.equal(f.manager.reply().executionBudget?.remaining, 0);
		}
	} finally { f.close(); }
});

test("review-budget terminal retains full partial diagnostics while attention display stays bounded", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = await reviewer(f);
		await dispatch(f, a);
		const response = `${approve}\n${"unfinished inspection evidence; ".repeat(800)}diagnostic tail`;
		const reply = await budgetTerminal(f, a, "large-budget-diagnostic", { response });
		const record = f.manager.store.getAction(a.actionId)!.result as { workerResult: unknown; terminal: TerminalEvent };
		assert.equal(record.workerResult, null);
		assert.equal(record.terminal.response, response);
		assert.ok(reply.attention!.detail.length <= 16_384);
		assert.match(reply.attention!.detail, /TRUNCATED/);
		assert.equal(reply.actions.length, 0);
		assert.equal(reply.status, "needs_input");
	} finally { f.close(); }
});

test("reviewer budget attention frees capacity for an unrelated plan", { timeout: 30_000 }, async () => {
	const f = await fixture(2);
	try {
		const a = await reviewer(f);
		await dispatch(f, a);
		const reply = await budgetTerminal(f, a);
		assert.equal(reply.attention?.cause, "review_budget_exhausted");
		assert.equal(action(reply).planId, "002");
		assert.equal(action(reply).role, "plan-implementer");
		assert.equal(runtime(f).phase, "NEEDS_INPUT");
	} finally { f.close(); }
});

test("budget terminal validates host reason and interruption flag and rejects nonreviewer roles", { timeout: 45_000 }, async () => {
	const f = await fixture();
	try {
		const a = action(f.reply);
		await dispatch(f, a);
		for (const overrides of [{ failureKind: "timeout" }, { failureKind: null }, { interrupted: false }, { interrupted: undefined }]) {
			await assert.rejects(budgetTerminal(f, a, "invalid-budget", overrides as Partial<TerminalEvent>), /failureKind must be review_budget_exhausted with interrupted: true/);
		}
		await assert.rejects(budgetTerminal(f, a), /only valid for plan-reviewer/);
		assert.equal(f.manager.store.getAction(a.actionId)?.state, "dispatched");
		const j = await judge(f);
		await dispatch(f, j);
		await assert.rejects(budgetTerminal(f, j), /only valid for plan-reviewer/);
		assert.equal(f.manager.store.getAction(j.actionId)?.state, "dispatched");
		assert.equal(f.manager.store.getAttentionRequests(a.runId).length, 0);
	} finally { f.close(); }
});

test("review budget cannot mask a changed assignment, dirty worktree, or changed frozen head/tree", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = await reviewer(f);
		await dispatch(f, a);
		const mode = fs.statSync(a.assignmentPath).mode;
		fs.chmodSync(a.assignmentPath, 0o600);
		await assert.rejects(budgetTerminal(f, a), /assignment|writ|mode/i);
		fs.chmodSync(a.assignmentPath, mode);
		fs.writeFileSync(path.join(a.worktree, "value-001.mjs"), "export const value = 99;\n");
		await assert.rejects(budgetTerminal(f, a), /mutated frozen plan/);
		git(a.worktree, ["add", "."]);
		git(a.worktree, ["commit", "-qm", "test: forbidden reviewer mutation"]);
		await assert.rejects(budgetTerminal(f, a), /mutated frozen plan/);
		assert.equal(f.manager.store.getAction(a.actionId)?.state, "dispatched");
		assert.equal(f.manager.store.getAttentionRequests(a.runId).length, 0);
	} finally { f.close(); }
});

test("environment block preserves dirty implementation, findings and round while unrelated work continues", { timeout: 30_000 }, async () => {
	const f = await fixture(2);
	try {
		const a = action(f.reply);
		await dispatch(f, a);
		fs.writeFileSync(path.join(a.worktree, "value-001.mjs"), "export const value = 17; // incomplete\n");
		f.manager.store.putPlan({ ...runtime(f), findings: ["prior finding"], repair: ["prior guidance"] });
		const reply = await terminal(f, a, blocked(a.role));
		assert.equal(reply.status, "needs_input");
		assert.equal(action(reply).planId, "002", "unrelated work uses the freed slot");
		assert.equal(runtime(f).round, 1);
		assert.equal(runtime(f).phase, "NEEDS_INPUT");
		assert.deepEqual(runtime(f).findings, ["prior finding"]);
		assert.equal(runtime(f).repair[0], "prior guidance");
		assert.match(fs.readFileSync(path.join(a.worktree, "value-001.mjs"), "utf8"), /incomplete/);
		assert.equal(reply.attention?.cause, "verification_environment");
		assert.equal(reply.attention?.kind, "operator_attention");
		assert.match(reply.attention?.detail ?? "", /SETUP \(worker preparation evidence, not check evidence\):/);
		assert.match(reply.attention?.detail ?? "", /command=npm ci/);
		assert.match(reply.attention?.detail ?? "", /CHECKS \(worker evidence, not authoritative verification\):/);
		assert.equal(f.manager.store.getApproval(a.runId, a.planId, a.generation), null);
	} finally { f.close(); }
});

for (const kind of ["ENVIRONMENT", "INVOCATION"]) test(`${kind} stays blocked without automatic revision across host restart`, { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = action(f.reply);
		await dispatch(f, a);
		const response = blocked(a.role, kind);
		const reply = await terminal(f, a, response);
		const request = reply.attention!;
		assert.equal(reply.actions.length, 0);
		f.restart();
		assert.deepEqual(f.manager.reply().attention, request);
		await terminal(f, a, response);
		assert.equal(f.manager.store.getAttentionRequests(a.runId).length, 1);
		await assert.rejects(f.manager.event({ eventId: "bad-hash", kind: "attention", attention: { ...attentionResolutionFromRequest(request), requestSha256: "0".repeat(64), action: "revise_run" } }), /hash does not match/);
		await assertWholeRunRecovery(f, request);
	} finally { f.close(); }
});

test("ordinary code failure still consumes a substantive round", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = action(f.reply);
		await dispatch(f, a);
		const next = action(await terminal(f, a, "STATUS: FAILED\nSTOPPED BECAUSE: test assertion failed\nCHECKS: value expected 2 got 1"));
		assert.equal(next.round, 2);
		assert.equal(next.workerMode, "GUIDED_REPAIR");
		assert.equal(f.manager.store.getAttentionRequests(a.runId).length, 0);
	} finally { f.close(); }
});

for (const role of ["plan-reviewer", "plan-judge"] as const) test(`${role} environment escalation preserves frozen evidence and rejects unapproved revision`, { timeout: 45_000 }, async () => {
	const f = await fixture();
	try {
		const a = role === "plan-reviewer" ? await reviewer(f) : await judge(f);
		const before = runtime(f);
		await dispatch(f, a);
		const reply = await terminal(f, a, blocked(role));
		assert.equal(runtime(f).reviewPass, before.reviewPass);
		assert.equal(runtime(f).round, before.round);
		assert.deepEqual(runtime(f).findings, before.findings);
		assert.equal(runtime(f).approvedTree, before.approvedTree);
		assert.equal(reply.actions.length, 0);
		assert.equal(f.manager.store.getApproval(a.runId, a.planId, a.generation), null);
		f.restart();
		await assertWholeRunRecovery(f, reply.attention!);
	} finally { f.close(); }
});

for (const role of ["plan-reviewer", "plan-judge"] as const) test(`${role} frozen mutation is rejected before environment or malformed report routing`, { timeout: 45_000 }, async () => {
	const f = await fixture();
	try {
		const a = role === "plan-reviewer" ? await reviewer(f) : await judge(f);
		await dispatch(f, a);
		fs.writeFileSync(path.join(a.worktree, "value-001.mjs"), "export const value = 99;\n");
		for (const response of [blocked(role), "malformed response"]) await assert.rejects(terminal(f, a, response), /mutated frozen plan/);
		assert.equal(f.manager.store.getAction(a.actionId)?.state, "dispatched");
		assert.equal(f.manager.store.getAttentionRequests(a.runId).length, 0);
	} finally { f.close(); }
});

test("final RUN environment block neither completes nor reignites; explicit retry resumes FINAL_AUDIT", { timeout: 45_000 }, async () => {
	const f = await fixture();
	try {
		const a = await finalReviewer(f);
		await dispatch(f, a);
		const reply = await terminal(f, a, blocked(a.role));
		assert.equal(reply.status, "needs_input");
		assert.equal(reply.actions.length, 0);
		assert.equal(reply.attention?.planId, "RUN");
		assert.equal(runtime(f, "RUN").reviewPass, 0);
		assert.equal(f.manager.store.getReigniteRequest(a.runId, a.generation), null);
		f.restart();
		const next = action(await retry(f, reply.attention!));
		assert.equal(next.workerMode, "FINAL_AUDIT");
		assert.equal(next.round, 1);
		await dispatch(f, next);
		assert.equal((await terminal(f, next, approve)).status, "complete");
	} finally { f.close(); }
});

for (const stage of ["implementer", "reviewer", "judge", "final"] as const) test(`REQUIREMENT ${stage} routes existing decision/recovery without inferred completion`, { timeout: 45_000 }, async () => {
	const f = await fixture();
	try {
		const a = stage === "implementer" ? action(f.reply) : stage === "reviewer" ? await reviewer(f) : stage === "judge" ? await judge(f) : await finalReviewer(f);
		await dispatch(f, a);
		const reply = await terminal(f, a, blocked(a.role, "REQUIREMENT"));
		assert.equal(reply.attention?.kind, stage === "implementer" || stage === "final" ? "user_decision" : "plan_recovery");
		assert.equal(runtime(f, a.planId).round, a.round);
		assert.notEqual(reply.status, "complete");
		assert.equal(f.manager.store.getApproval(a.runId, a.planId, a.generation), null);
		assert.equal(f.manager.store.getReigniteRequest(a.runId, a.generation), null);
	} finally { f.close(); }
});


test("round-three environment escalation stays blocked without revision or round four", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		let a = action(f.reply);
		for (let round = 1; round < 3; round += 1) {
			await dispatch(f, a);
			a = action(await terminal(f, a, "STATUS: FAILED\nSTOPPED BECAUSE: actual assertion failed"));
		}
		assert.equal(a.round, 3);
		assert.equal(a.workerMode, "RESCUE");
		await dispatch(f, a);
		const reply = await terminal(f, a, blocked(a.role));
		assert.equal(reply.attention?.round, 3);
		assert.equal(runtime(f).round, 3);
		assert.equal(reply.actions.length, 0);
		await assertWholeRunRecovery(f, reply.attention!);
	} finally { f.close(); }
});

for (const kind of ["ENVIRONMENT", "REQUIREMENT"]) test(`final ${kind} cancellation preserves the frozen tree and stays paused across resume`, { timeout: 45_000 }, async () => {
	const f = await fixture();
	try {
		const a = await finalReviewer(f);
		await dispatch(f, a);
		const before = runtime(f, "RUN").approvedTree;
		const request = (await terminal(f, a, blocked(a.role, kind))).attention!;
		const reply = await f.manager.event({ eventId: "cancel-final", kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "cancel", rationale: "Operator stopped the audit" } });
		assert.equal(reply.status, "paused");
		assert.equal(reply.actions.length, 0);
		assert.equal(runtime(f, "RUN").phase, "BLOCKED");
		assert.equal(runtime(f, "RUN").approvedTree, before);
		assert.equal(f.manager.store.getReigniteRequest(a.runId, a.generation), null);
		f.restart();
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const resumed = await resume(f);
			assert.equal(resumed.status, "paused");
			assert.equal(resumed.actions.length, 0);
			assert.match(resumed.message, /cancelled/);
			assert.equal(runtime(f, "RUN").approvedTree, before);
			assert.equal(runtime(f, "RUN").phase, "BLOCKED");
		}
	} finally { f.close(); }
});


test("round-two requirement review requests recovery instead of adjudication or inferred repair", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		let a = await reviewer(f);
		await dispatch(f, a);
		const implementer = action(await terminal(f, a, revise));
		a = action(await implemented(f, implementer), "plan-reviewer");
		await dispatch(f, a);
		const reply = await terminal(f, a, blocked(a.role, "REQUIREMENT"));
		assert.equal(reply.attention?.kind, "plan_recovery");
		assert.equal(reply.attention?.cause, "reviewer_blocked");
		assert.equal(reply.attention?.round, 2);
		assert.equal(runtime(f).reviewPass, 1, "requirement non-review does not increment the completed review count");
		assert.equal(reply.actions.length, 0);
	} finally { f.close(); }
});


for (const final of [false, true]) test(`explicit requirement clarification resumes the recorded phase (final=${final})`, { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = final ? await finalReviewer(f) : action(f.reply);
		await dispatch(f, a);
		const request = (await terminal(f, a, blocked(a.role, "REQUIREMENT"))).attention!;
		f.restart();
		if (!final) { await assertWholeRunRecovery(f, request); return; }
		const attention = { ...attentionResolutionFromRequest(request), action: "answer_and_resume", answer: "Keep the original value export requirement; do not expand scope." };
		grantHostAttention(f.manager.store.getRun()!, attention);
		const next = action(await f.manager.event({ eventId: "requirement-answer", kind: "attention", attention }));
		assert.equal(next.round, 1);
		assert.equal(next.workerMode, final ? "FINAL_AUDIT" : "INITIAL");
		assert.equal(next.role, a.role);
		assert.equal(next.planId, a.planId);
		assert.equal(next.assignmentSha256, a.assignmentSha256);
		assert.equal(f.manager.store.getApproval(a.runId, a.planId, a.generation), null);
	} finally { f.close(); }
});

test("environment non-review preserves first discovery and cannot retry without host authorization", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		let a = await reviewer(f);
		await dispatch(f, a);
		const environmentRequest = (await terminal(f, a, blocked(a.role))).attention!;
		assert.equal(runtime(f).reviewPass, 0);
		await assertWholeRunRecovery(f, environmentRequest);
	} finally { f.close(); }
});

test("shape admission reports bounded actionable overlap evidence", async () => {
	await assert.rejects(fixture(2, (directory) => {
		const file = path.join(directory, "002-value.md");
		fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("value-002", "value-001"));
	}), (error: Error) => {
		assert.match(error.message, /not shape-ready.*unordered overlapping in-scope paths: value-001\.mjs/);
		assert.ok(error.message.length < 4_200);
		return true;
	});
});


function resume(f: Fixture) {
	return f.manager.resume({ mode: "resume", repositoryRoot: f.repo, planDirectory: f.planDirectory });
}

async function classifiedEnvironmentFailure(f: Fixture) {
	const request = await finalRequest(f);
	// An external prerequisite visible through explicit argv, never inherited HOME/credentials.
	const prerequisite = path.join(path.dirname(f.repo), "prepared-environment");
	const failed = await f.manager.verification({
		...request, rationale: "Check the externally prepared fixture toolchain, then integrated behavior", gates: [
			{ gateId: "prepared", label: "declared environment", cwd: ".", argv: [process.execPath, "-e", "if (!require('node:fs').existsSync(process.argv[1])) process.exit(127)", prerequisite], rationale: "Requires the operator-prepared external environment" },
			{ gateId: "value", label: "integrated value", cwd: ".", argv: [process.execPath, "-e", "if (!require('node:fs').readFileSync('value-001.mjs','utf8').includes('= 2')) process.exit(1)"], rationale: "Checks the integrated export without mutating the tree" },
		],
	});
	assert.equal(failed.status, "failed");
	const repair = failed.integrationRepair!;
	const paused = await f.manager.integrationRepair({ operation: "begin", requestId: repair.requestId,
		requestSha256: repair.requestSha256, capabilityToken: integrationRepairCapabilityToken(repair.requestId), ownerSessionId: "environment-owner",
		classification: "environment", rationale: `Node fixture prerequisite is absent at ${prerequisite}; operator must prepare it externally.` });
	assert.equal(paused.status, "paused");
	return { request, prerequisite, repair: paused.integrationRepair! };
}

test("explicit manager resume runs unchanged gates after external preparation and preserves budgets", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const { request, prerequisite, repair } = await classifiedEnvironmentFailure(f);
		fs.writeFileSync(prerequisite, "prepared externally");
		f.restart();
		const resumed = await resume(f);
		assert.equal(action(resumed).workerMode, "FINAL_AUDIT");
		const successor = f.manager.store.getVerification(request.runId, request.generation)!;
		assert.notEqual(successor.request.requestId, request.requestId);
		assert.equal(successor.request.predecessorRequestId, request.requestId);
		assert.equal(successor.state, "passed");
		assert.equal(successor.request.integrationHead, request.integrationHead);
		assert.equal(successor.request.integrationTree, request.integrationTree);
		assert.deepEqual(successor.manifest?.gates, repair.canonicalGates);
		assert.equal((successor.result as { gates: unknown[] }).gates.length, 2, "manager executed the complete ordered program");
		const durable = f.manager.store.getIntegrationRepair(repair.repairId!)!;
		assert.equal(durable.acceptedCodeRounds, repair.acceptedCodeRounds);
		assert.equal(durable.transientRetryUsed, repair.transientRetryUsed);
		assert.equal(durable.round, repair.round);
		assert.equal(f.manager.store.getIntegrationRepairEpisodes(durable.repairId)[0]?.classification, "environment");
		await resume(f);
		assert.equal(f.manager.store.getVerification(request.runId, request.generation)?.request.requestId, successor.request.requestId);
		assert.equal(f.manager.store.getIntegrationRepairAudits(durable.repairId).filter((audit) => audit.action === "environment-retry").length, 1);
	} finally { f.close(); }
});

test("manager environment resume survives a crash between successor persistence and gate execution", { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		const { request, prerequisite, repair } = await classifiedEnvironmentFailure(f);
		fs.writeFileSync(prerequisite, "prepared externally");
		f.manager.store.submitOperation("environment-resume-crash", "start", { mode: "resume", repositoryRoot: f.repo, planDirectory: f.planDirectory });
		assert.equal(f.manager.store.claimNextOperation()?.state, "running");
		const executor = t.mock.method(f.manager, "verification", async () => { throw new Error("crash before gate execution"); });
		await assert.rejects(resume(f), /crash before gate execution/);
		const sealed = f.manager.store.getIntegrationRepair(repair.repairId!)!;
		assert.equal(sealed.state, "verifying");
		assert.equal(f.manager.store.getVerificationByRequestId(sealed.successorRequestId!)?.state, "awaiting_manifest");
		executor.mock.restore();
		f.restart();
		f.manager.store.recoverRunningOperations();
		assert.equal(f.manager.store.getOperation("environment-resume-crash")?.state, "accepted");
		assert.equal(action(await resume(f)).workerMode, "FINAL_AUDIT");
		assert.equal(f.manager.store.getVerification(request.runId, request.generation)?.request.requestId, sealed.successorRequestId);
		assert.deepEqual(f.manager.store.getVerificationByRequestId(sealed.successorRequestId!)?.manifest, sealed.successorManifest);
		assert.equal(f.manager.store.getIntegrationRepairAudits(sealed.repairId).filter((audit) => audit.action === "environment-retry").length, 1);
	} finally { f.close(); }
});

test("manager environment resume failure stays unclassified until another explicit classification", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const { request, repair } = await classifiedEnvironmentFailure(f);
		assert.equal((await resume(f)).status, "failed");
		const successor = f.manager.store.getVerification(request.runId, request.generation)!;
		assert.equal(successor.state, "failed");
		assert.notEqual(successor.request.requestId, request.requestId);
		f.restart();
		assert.equal((await resume(f)).status, "failed");
		assert.equal(f.manager.store.getVerification(request.runId, request.generation)?.request.requestId, successor.request.requestId);
		const episodes = f.manager.store.getIntegrationRepairEpisodes(repair.repairId!);
		assert.equal(episodes.length, 2);
		assert.equal(episodes[0]?.classification, "environment");
		assert.equal(episodes[1]?.classification, null);
		assert.equal(f.manager.store.getPlan(request.runId, "RUN"), null);
	} finally { f.close(); }
});

test("manager environment resume rejects changed profile or graph before gate execution", { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		const { repair } = await classifiedEnvironmentFailure(f);
		const executor = t.mock.method(f.manager, "verification", async () => { throw new Error("must not execute"); });
		await assert.rejects(f.manager.resume({ mode: "resume", repositoryRoot: f.repo, planDirectory: f.planDirectory, profile: "universe" }), /immutable binding/);
		fs.appendFileSync(path.join(f.planDirectory, "001-value.md"), "\nChanged requirement invalidates the immutable assignment.\n");
		await assert.rejects(resume(f), /graph changed|not shape-ready/);
		assert.equal(executor.mock.callCount(), 0);
		assert.equal(f.manager.store.getIntegrationRepair(repair.repairId!)?.successorRequestId, null);
	} finally { f.close(); }
});


test("manager resume preserves an ambiguous started environment verification without replay",  { timeout: 30_000 }, async (t) => {
	const f = await fixture();
	try {
		const { prerequisite, repair } = await classifiedEnvironmentFailure(f);
		fs.writeFileSync(prerequisite, "prepared externally");
		const executor = t.mock.method(f.manager, "verification", async (manifest: VerificationManifest) => {
			// Model the process dying after startVerification's durable write.
			f.manager.store.startVerification(manifest.requestId, manifest, sha256(stableJson(manifest)));
			f.manager.store.updateRun({ status: "running" });
			throw new Error("crash with running successor");
		});
		await assert.rejects(resume(f), /crash with running successor/);
		const sealed = f.manager.store.getIntegrationRepair(repair.repairId!)!;
		assert.equal(f.manager.store.getVerificationByRequestId(sealed.successorRequestId!)?.state, "running");
		executor.mock.restore();
		f.restart();
		const paused = await resume(f);
		assert.deepEqual(paused.actions, []);
		assert.equal(paused.status, "paused");
		assert.match(paused.message, /ambiguous/);
		assert.equal(f.manager.store.getVerificationByRequestId(sealed.successorRequestId!)?.state, "running");
		assert.equal(f.manager.store.getIntegrationRepairAudits(sealed.repairId).filter((audit) => audit.action === "environment-retry").length, 1);
	} finally { f.close(); }
});

for (const final of [false, true]) test(`record-only requirement answer stays blocked across scheduling and reopen/resume (final=${final})`, { timeout: 45_000 }, async () => {
	const f = await fixture(final ? 1 : 2);
	try {
		const a = final ? await finalReviewer(f) : action(f.reply);
		await dispatch(f, a);
		const request = (await terminal(f, a, blocked(a.role, "REQUIREMENT"))).attention!;
		assert.equal(request.kind, "user_decision");
		if (!final) { await assertWholeRunRecovery(f, request); return; }
		const answer = "  Fix the upstream requirement first; revise dependencies before continuing.\nDo not expand this worker's scope.  ";
		const resolution = { ...attentionResolutionFromRequest(request), action: "answer", answer };
		const reply = await f.manager.event({ eventId: "record-only", kind: "attention", attention: resolution });
		assert.match(reply.message, /BLOCKED.*manual intervention/);
		assert.equal(runtime(f, a.planId).phase, "BLOCKED");
		assert.equal(reply.actions.some((candidate) => candidate.planId === a.planId), false);
		assert.notEqual(f.manager.store.getAttention(request.requestId)?.state, "resolved", "a recorded answer does not consume later host recovery authority");
		assert.equal(f.manager.store.readEvent(`manager-attention-note:${request.requestId}:${sha256(stableJson(resolution))}`)?.payloadSha256, sha256(stableJson(resolution)));
		assert.ok(runtime(f, a.planId).repair.some(line => line.includes(`ATTENTION_ANSWER [${request.requestId}]:`) && line.includes(answer.trim())));
		const count = f.manager.store.countActions(a.runId, { planId: a.planId });
		if (!final) {
			const sibling = action(reply);
			assert.equal(sibling.planId, "002");
			const review = action(await implemented(f, sibling), "plan-reviewer");
			await dispatch(f, review);
			await terminal(f, review, approve);
			assert.equal(runtime(f, "002").phase, "DONE", "unrelated work integrates despite the recorded blocker");
		}
		f.restart();
		for (let attempt = 0; attempt < 2; attempt += 1) {
			for (const resumed of [await f.manager.auditScheduler(), await resume(f), await f.manager.event({ eventId: "record-only", kind: "attention", attention: resolution })]) {
				assert.equal(resumed.actions.some((candidate) => candidate.planId === a.planId), false);
				assert.match(resumed.message, /manual intervention/);
				if (final) assert.equal(resumed.status, "paused");
			}
			assert.equal(runtime(f, a.planId).phase, "BLOCKED");
			assert.equal(f.manager.store.countActions(a.runId, { planId: a.planId }), count);
			assert.equal(f.manager.store.readEvent(`manager-attention-note:${request.requestId}:${sha256(stableJson(resolution))}`)?.payloadSha256, sha256(stableJson(resolution)));
		}
		await assert.rejects(f.manager.event({ eventId: "late-resume", kind: "attention", attention: { ...resolution, action: "answer_and_resume" } }), /host grant/);
	} finally { f.close(); }
});

test("user decisions reject legacy prose, retry, and missing answers without consuming the request", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = action(f.reply);
		await dispatch(f, a);
		const request = (await terminal(f, a, blocked(a.role, "REQUIREMENT"))).attention!;
		await assert.rejects(f.manager.event({ eventId: "legacy", kind: "user_input", attentionRequestId: request.requestId, userInput: "Proceed now" }), /Legacy user_input.*request-bound/);
		for (const action of ["answer", "answer_and_resume", "retry", "invented_action"]) {
			for (const answer of [undefined, "", "   ", 7]) {
				await assert.rejects(f.manager.event({ eventId: `bad:${action}:${answer}`, kind: "attention", attention: { ...attentionResolutionFromRequest(request), action, answer } as never }));
			}
		}
		await assert.rejects(retry(f, request), /Stopped attention/);
		assert.equal(runtime(f).phase, "NEEDS_INPUT");
		assert.equal(f.manager.store.getAttention(request.requestId)?.state, "awaiting_input");
		assert.equal(f.manager.store.countActions(a.runId, { planId: a.planId }), 1);
	} finally { f.close(); }
});

for (const recovery of [false, true]) test(`answer_and_resume rejects wrong attention kind (recovery=${recovery})`, { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = recovery ? await reviewer(f) : action(f.reply);
		await dispatch(f, a);
		const request = (await terminal(f, a, blocked(a.role, recovery ? "REQUIREMENT" : "ENVIRONMENT"))).attention!;
		assert.equal(request.kind, recovery ? "plan_recovery" : "operator_attention");
		await assert.rejects(f.manager.event({ eventId: "wrong-kind", kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "answer_and_resume", answer: "Within scope clarification" } }), /Stopped attention/);
		assert.notEqual(f.manager.store.getAttention(request.requestId)?.state, "resolved");
	} finally { f.close(); }
});
