import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { git } from "../../../src/daemon/git-driver.ts";
import { attentionResolutionFromRequest } from "../../../adapters/attention.ts";
import { integrationRepairCapabilityToken, sha256, stableJson, type ManagerAction, type ManagerAttentionRequest, type ManagerReply, type VerificationManifest } from "../../../src/shared/protocol.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";

function planText(id: string, head: string): string {
	return `# Plan ${id}: Update value ${id}

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit \`${head}\`, 2026-08-20
- **Kind**: behavioral
- **Parent objective**: Exercise bounded runtime failure routing.

## Outcome and acceptance
Change the fixture value to two without changing its interface.
| ID | Required behavior | Proof |
|---|---|---|
| A1 | Value ${id} exports two | V1 |

## Boundaries
**Write paths**
- \`value-${id}.mjs\`
**Out of scope**
Dependencies and other modules. Preserve the named export interface.

## Starting conditions
**Observed baseline**
value-${id}.mjs exports one at ${head}.
**Required starting state**
The named export exists.
**Expected dependency changes**
None.
Dependencies: none.

## Implementation route
Change the exported literal in value-${id}.mjs for A1; check V1.

## Verification
| ID | Phase | Criteria | Toolchain | Command | Expected |
|---|---|---|---|---|---|
| V1 | acceptance | A1 | T1 | \`node --input-type=module -e 'import {value} from "./value-${id}.mjs"; if(value !== 2) process.exit(1)'\` | exit 0; value equals two |

| ID | Owner | Cwd | Prerequisites | Probe | Evidence |
|---|---|---|---|---|---|
| T1 | npm project scripts | . | Node >=22.19 installed | \`node --version\` | \`package.json\` |

## Escalation and handoff
Stop for missing toolchain prerequisites with exact command/cwd/error evidence. Ask for missing requirement authority. Provide the named value export to downstream callers; no deferred work. Preserve the worktree while blocked.
`;
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
const checks = "CHECKS: manager=npm project scripts; command=npm test; cwd=/repo; error=missing locked dependency; prerequisite=operator prepares locked environment";
function blocked(role: ManagerAction["role"], kind = "ENVIRONMENT") {
	const detail = "Locked dependencies are absent; operator must prepare the declared environment";
	return [role === "plan-implementer" ? `STATUS: STOPPED\nSTOPPED BECAUSE: ${detail}`
		: role === "plan-reviewer" ? `VERDICT: BLOCK\nSCOPE: PASS\nFINDINGS: none\nRATIONALE: ${detail}`
			: `DECISION: BLOCKED\nAUTHORIZED_BLOCKERS: none\nREPAIR_CONTRACTS: none\nRATIONALE: ${detail}`,
		`BLOCKER_KIND: ${kind}`, checks].join("\n");
}
function retry(f: Fixture, request: ManagerAttentionRequest, eventId = `retry:${request.requestId}`) {
	return f.manager.event({ eventId, kind: "attention", attention: {
		...attentionResolutionFromRequest(request), action: "retry", rationale: "Operator confirmed the declared prerequisite was prepared.",
	} });
}
function runtime(f: Fixture, id = "001") { return f.manager.store.getPlan(f.manager.store.getRun()!.runId, id)!; }
const revise = "VERDICT: REVISE\nSCOPE: PASS\nFINDINGS: [P1][BLOCKING] incorrect value\nFIX_GUIDANCE: fix the value\nRATIONALE: bounded code defect\nCHECKS: value assertion failed";
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
		assert.equal(f.manager.store.getApproval(a.runId, a.planId, a.generation), null);
	} finally { f.close(); }
});

for (const kind of ["ENVIRONMENT", "INVOCATION"]) test(`${kind} needs explicit request-bound retry, survives replay/restart, and retains INITIAL mode`, { timeout: 30_000 }, async () => {
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
		await assert.rejects(f.manager.event({ eventId: "bad-answer", kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "answer", answer: "continue" } }), /explicit retry or cancel/);
		await assert.rejects(f.manager.event({ eventId: "bad-accept", kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "accept", answer: "waive", rationale: "waive", confirmed: true } }), /cannot approve or waive/);
		await assert.rejects(f.manager.event({ eventId: "bad-hash", kind: "attention", attention: { ...attentionResolutionFromRequest(request), requestSha256: "0".repeat(64), action: "retry" } }), /hash does not match/);
		const next = action(await retry(f, request));
		assert.equal(next.round, a.round);
		assert.equal(next.workerMode, a.workerMode);
		assert.equal(next.assignmentSha256, a.assignmentSha256);
		assert.equal(next.worktree, a.worktree);
		f.restart();
		assert.equal(action(await retry(f, request)).actionId, next.actionId);
		await assert.rejects(f.manager.event({ eventId: "divergent-retry", kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "cancel" } }), /different resolution/);
		assert.equal(f.manager.store.getAttention(request.requestId)?.state, "resolved");
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

for (const role of ["plan-reviewer", "plan-judge"] as const) test(`${role} environment retry preserves frozen evidence and original review mode`, { timeout: 45_000 }, async () => {
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
		const next = action(await retry(f, reply.attention!));
		assert.equal(next.role, role);
		assert.equal(next.round, a.round);
		assert.equal(next.workerMode, a.workerMode);
		assert.match(next.prompt, /WORKER_SELF_REPORT: ENVIRONMENT/);
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


test("round-three environment retry retains RESCUE without inventing round four", { timeout: 30_000 }, async () => {
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
		const next = action(await retry(f, reply.attention!));
		assert.equal(next.round, 3);
		assert.equal(next.workerMode, "RESCUE");
		assert.equal(next.model, a.model);
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


test("requirement decision resumes INITIAL without inventing guided code-repair authority", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const a = action(f.reply);
		await dispatch(f, a);
		const request = (await terminal(f, a, blocked(a.role, "REQUIREMENT"))).attention!;
		f.restart();
		const next = action(await f.manager.event({ eventId: "requirement-answer", kind: "attention", attention: { ...attentionResolutionFromRequest(request), action: "answer", answer: "Keep the original value export requirement; do not expand scope." } }));
		assert.equal(next.round, 1);
		assert.equal(next.workerMode, "INITIAL");
		assert.equal(next.assignmentSha256, a.assignmentSha256);
		assert.equal(f.manager.store.getApproval(a.runId, a.planId, a.generation), null);
	} finally { f.close(); }
});

test("requirement non-review preserves first discovery; old environment resolutions cannot override later review evidence", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		let a = await reviewer(f);
		await dispatch(f, a);
		const environmentRequest = (await terminal(f, a, blocked(a.role))).attention!;
		a = action(await retry(f, environmentRequest));
		assert.equal(a.workerMode, "DISCOVERY");
		await dispatch(f, a);
		const requirementRequest = (await terminal(f, a, blocked(a.role, "REQUIREMENT"))).attention!;
		assert.equal(runtime(f).reviewPass, 0);
		assert.equal(requirementRequest.kind, "plan_recovery");
		// A completed review supersedes historical environment attention. This unit
		// seeds the ready continuation because ordinary recovery starts a generation.
		const plan = runtime(f);
		f.manager.store.resolveAttention(requirementRequest.requestId);
		f.manager.store.putPlan({ ...plan, reviewPass: 1, phase: "READY_REVIEWER" });
		f.manager.store.updateRun({ status: "running" });
		const next = action(await f.manager.auditScheduler());
		assert.equal(next.workerMode, "VERIFICATION");
		assert.equal(next.round, a.round);
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


test("manager resume also reuses an environment successor interrupted after verification started", { timeout: 30_000 }, async (t) => {
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
		assert.equal(action(await resume(f)).workerMode, "FINAL_AUDIT");
		assert.equal(f.manager.store.getVerificationByRequestId(sealed.successorRequestId!)?.state, "passed");
		assert.equal(f.manager.store.getIntegrationRepairAudits(sealed.repairId).filter((audit) => audit.action === "environment-retry").length, 1);
	} finally { f.close(); }
});
