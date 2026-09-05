import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { integrationRepairRequest, recordIntegrationRepairVerificationOutcome, runIntegrationRepair, resumeEnvironmentVerification } from "../../../src/core/integration-repair.ts";
import { createVerificationRequest, normalizeVerificationManifest } from "../../../src/core/verification.ts";
import { GitDriver, git } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { integrationRepairCapabilityToken, sha256, stableJson, type VerificationManifest, type ManagerReply } from "../../../src/shared/protocol.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";

async function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-environment-"));
	const { repo, originalHead } = initFixtureRepo(root, { name: "Environment Repair Test", email: "environment-repair@example.invalid", files: { "value.txt": "untouched\n" } });
	const planDirectory = path.join(repo, "herder-plans");
	fs.mkdirSync(planDirectory, { recursive: true });
	const driver = new GitDriver({ repoRoot: repo, planDirectory, planName: "environment-test", helperRoot: path.resolve(import.meta.dirname, "../../../src/daemon/git") });
	fs.mkdirSync(driver.worktreeRoot, { recursive: true });
	git(repo, ["worktree", "add", "-qb", driver.integrationBranch, driver.integrationWorktree, "HEAD"]);
	let store = new RunStore(planDirectory);
	const token = await driver.captureCheckout();
	store.createRun({ runId: "run-env", repositoryRoot: repo, planDirectory, planName: "environment-test", host: "pi", profileName: "eclipse", profileSha256: "a".repeat(64), maxParallel: 1, currentGeneration: 1, graphSha256: "b".repeat(64), status: "running", checkoutStateToken: token, baseCommit: originalHead, integrationBranch: driver.integrationBranch, integrationWorktree: driver.integrationWorktree, dashboardUrl: null });
	const assignmentPath = path.join(planDirectory, "assignment.json");
	fs.writeFileSync(assignmentPath, "immutable assignment");
	const assignmentSha256 = sha256("immutable assignment");
	store.putGeneration({ runId: "run-env", generation: 1, graphSha256: "b".repeat(64), parentGeneration: null, runAssignmentPath: assignmentPath, runAssignmentSha256: assignmentSha256, runSnapshotSha256: "d".repeat(64) });
	const request = createVerificationRequest({ requestId: "verify-env", runId: "run-env", generation: 1, graphSha256: "b".repeat(64), runAssignmentPath: path.join(planDirectory, "assignment.json"), runAssignmentSha256: assignmentSha256, integrationBranch: driver.integrationBranch, integrationWorktree: driver.integrationWorktree, integrationHead: originalHead, integrationTree: driver.worktreeTree(driver.integrationWorktree), requestedAt: new Date().toISOString() });
	const { manifest, manifestSha256 } = normalizeVerificationManifest(request, { ...request, rationale: "Check declared project environment", gates: [{ gateId: "uv", label: "uv project check", cwd: ".", argv: ["uv", "run", "pytest"], rationale: "Canonical declared invocation" }] });
	const result = { passed: false, gates: [{ gateId: "uv", cwd: driver.integrationWorktree, argv: ["uv", "run", "pytest"], outcome: "command_failed", exitCode: 127, error: "declared dependency is missing", signal: null, timedOut: false }] };
	store.putVerificationRequest(request);
	store.startVerification(request.requestId, manifest, manifestSha256);
	store.finishVerification(request.requestId, "failed", result, "uv run pytest: locked dependency absent");
	recordIntegrationRepairVerificationOutcome(store, request.requestId, "failed", "uv run pytest: locked dependency absent");
	store.updateRun({ status: "failed" });
	let verificationCalls = 0;
	let verifier: (manifest: VerificationManifest) => Promise<ManagerReply> = async () => { throw new Error("decision-only classification cannot execute verification"); };
	const deps = () => ({ store, driver: () => driver, reply: () => ({ status: store.getRun()!.status, integrationRepair: integrationRepairRequest(store.getVerificationByRequestId(request.requestId)!, store.getIntegrationRepairForRequest(request.requestId)) }) as ManagerReply, verification: async (manifest: VerificationManifest) => { verificationCalls += 1; return verifier(manifest); }, updateRun: (input: Parameters<RunStore["updateRun"]>[0]) => { store.updateRun(input); } });
	return {
		get store() { return store; }, get verificationCalls() { return verificationCalls; }, request, result, driver,
		begin: { operation: "begin" as const, operationId: "begin-env", requestId: request.requestId, requestSha256: request.requestSha256, capabilityToken: integrationRepairCapabilityToken(request.requestId), ownerSessionId: "main", classification: "environment", rationale: "manager=uv; argv=uv run pytest; cwd=.; dependency missing; operator must prepare the declared locked environment" },
		resume() { return resumeEnvironmentVerification(deps(), request.requestId); },
		setVerifier(value: typeof verifier) { verifier = value; },
		invoke(input: Parameters<typeof runIntegrationRepair>[1]) { return runIntegrationRepair(deps(), input); },
		restart() { store.close(); store = new RunStore(planDirectory); },
		close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); },
	};
}

function treeIdentity(f: Awaited<ReturnType<typeof fixture>>) {
	return { refs: f.driver.readIntegrationRepairNamespace(), head: f.driver.worktreeHead(f.driver.integrationWorktree), tree: f.driver.worktreeTree(f.driver.integrationWorktree), status: f.driver.worktreeStatus(f.driver.integrationWorktree) };
}

test("environment final repair is a durable nonmutating decision, with no successor or code round", { timeout: 20_000 }, async () => {
	const f = await fixture();
	try {
		const before = treeIdentity(f);
		await assert.rejects(f.invoke({ ...f.begin, rationale: "" }), /requires a rationale or detail/);
		assert.equal(f.store.getIntegrationRepairForRequest(f.request.requestId)?.classification, null);
		const reply = await f.invoke(f.begin);
		assert.equal(reply.status, "paused");
		assert.equal(reply.integrationRepair?.classification, "environment");
		assert.equal(reply.integrationRepair?.state, "paused");
		assert.equal(reply.integrationRepair?.round, 1);
		assert.equal(reply.integrationRepair?.acceptedCodeRounds, 0);
		assert.deepEqual(reply.integrationRepair?.verificationResult, f.result);
		assert.deepEqual(treeIdentity(f), before);
		assert.equal(reply.integrationRepair?.successorRequestId, undefined);
		f.restart();
		const replay = await f.invoke(f.begin);
		assert.deepEqual(replay, reply);
		const repair = f.store.getIntegrationRepairForRequest(f.request.requestId)!;
		assert.equal(f.store.getIntegrationRepairEpisodes(repair.repairId).length, 1);
		assert.equal(f.store.getIntegrationRepairEpisodes(repair.repairId)[0]?.classification, "environment");
		assert.equal(f.store.getIntegrationRepairAudits(repair.repairId).length, 1);
		await assert.rejects(f.invoke({ ...f.begin, classification: "code_defect" }), /classification cannot change/);
		await assert.rejects(f.invoke({ ...f.begin, operation: "finish", operationId: "finish-env", observedCommit: before.head, allowedPaths: ["value.txt"] }), /finish requires a new begin/);
		assert.equal(f.verificationCalls, 0);
		assert.deepEqual(treeIdentity(f), before);
		assert.equal(f.store.getPlan(f.request.runId, "RUN"), null);
		assert.equal(f.store.getReigniteRequest(f.request.runId, f.request.generation), null);
	} finally { f.close(); }
});

test("wrong invocation remains manifest_error, not environment or edit authority", { timeout: 20_000 }, async () => {
	const f = await fixture();
	try {
		const before = treeIdentity(f);
		const reply = await f.invoke({ ...f.begin, classification: "manifest_error", rationale: "The manifest used pytest without the declared uv run environment" });
		assert.equal(reply.integrationRepair?.classification, "manifest_error");
		assert.equal(reply.integrationRepair?.state, "active");
		assert.equal(reply.integrationRepair?.acceptedCodeRounds, 0);
		assert.deepEqual(treeIdentity(f), before);
		assert.equal(f.verificationCalls, 0);
	} finally { f.close(); }
});

function repairBudget(f: Awaited<ReturnType<typeof fixture>>) {
	const repair = f.store.getIntegrationRepairForRequest(f.request.requestId)!;
	return { round: repair.round, code: repair.acceptedCodeRounds, transient: repair.transientRetryUsed, superseded: repair.supersededCommits };
}

test("environment resume seals one atomic successor before execution and replays it after restart", { timeout: 20_000 }, async () => {
	const f = await fixture();
	try {
		await f.invoke(f.begin);
		const initial = f.store.getIntegrationRepairForRequest(f.request.requestId)!;
		// Exercise preservation even when earlier recovery has consumed both budgets.
		f.store.updateIntegrationRepair(initial.repairId, { acceptedCodeRounds: 2, round: 2 });
		f.store.markIntegrationRepairEpisodeTransientUsed(initial.repairId, initial.episodeId!, sha256("prior transient evidence"));
		const before = repairBudget(f);
		const beforeTree = treeIdentity(f);
		const manifests: VerificationManifest[] = [];
		f.setVerifier(async (manifest) => { manifests.push(manifest); throw new Error("simulated crash after atomic persistence, before gate execution"); });
		await assert.rejects(f.resume(), /simulated crash/);
		const sealed = f.store.getIntegrationRepair(initial.repairId)!;
		assert.equal(sealed.state, "verifying");
		assert.equal(sealed.classification, "environment");
		assert.equal(sealed.operationId, `environment-retry:${f.request.requestId}`);
		assert.equal(f.store.getVerificationByRequestId(sealed.successorRequestId!)?.state, "awaiting_manifest");
		assert.deepEqual(repairBudget(f), before);
		f.restart();
		f.setVerifier(async (manifest) => {
			manifests.push(manifest);
			f.store.startVerification(manifest.requestId, manifest, sha256(stableJson(manifest)));
			f.store.finishVerification(manifest.requestId, "passed", { passed: true }, null);
			recordIntegrationRepairVerificationOutcome(f.store, manifest.requestId, "passed", null);
			return { status: "running" } as ManagerReply;
		});
		await f.resume();
		assert.equal(manifests.length, 2);
		assert.deepEqual(manifests[0], manifests[1], "restart executes the already-authorized manifest");
		assert.deepEqual(manifests[1]!.gates, initial.effectiveGates);
		assert.deepEqual(repairBudget(f), before);
		assert.deepEqual(treeIdentity(f), beforeTree);
		assert.equal(f.store.getIntegrationRepairAudits(initial.repairId).filter((audit) => audit.action === "environment-retry").length, 1);
		assert.equal(f.store.getIntegrationRepairEpisodes(initial.repairId)[0]?.classification, "environment");
		await assert.rejects(f.resume(), /requires a recorded classified failure/);
		assert.equal(f.verificationCalls, 2, "no further execution after the successor passed");
	} finally { f.close(); }
});

test("environment successor failure opens an unclassified episode without retrying or charging budgets", { timeout: 20_000 }, async () => {
	const f = await fixture();
	try {
		await f.invoke(f.begin);
		const initial = f.store.getIntegrationRepairForRequest(f.request.requestId)!;
		const before = repairBudget(f);
		f.setVerifier(async (manifest) => {
			f.store.startVerification(manifest.requestId, manifest, sha256(stableJson(manifest)));
			f.store.finishVerification(manifest.requestId, "failed", { passed: false }, "prerequisite still missing");
			recordIntegrationRepairVerificationOutcome(f.store, manifest.requestId, "failed", "prerequisite still missing");
			return { status: "failed" } as ManagerReply;
		});
		await f.resume();
		const episodes = f.store.getIntegrationRepairEpisodes(initial.repairId);
		assert.equal(episodes.length, 2);
		assert.equal(episodes[0]?.classification, "environment");
		assert.equal(episodes[1]?.classification, null);
		assert.deepEqual(repairBudget(f), before);
		await assert.rejects(f.resume(), /requires a recorded classified failure/);
		assert.equal(f.verificationCalls, 1);
	} finally { f.close(); }
});

for (const mutation of ["dirty", "head", "detached", "tree", "namespace", "missing_snapshot", "gates", "assignment", "graph"] as const) test(`environment resume rejects stale ${mutation} before authorizing a successor`, { timeout: 20_000 }, async () => {
	const f = await fixture();
	try {
		await f.invoke(f.begin);
		const repair = f.store.getIntegrationRepairForRequest(f.request.requestId)!;
		const before = repairBudget(f);
		if (mutation === "dirty" || mutation === "head") {
			fs.writeFileSync(path.join(f.driver.integrationWorktree, "value.txt"), "changed\n");
			if (mutation === "head") { git(f.driver.integrationWorktree, ["add", "."]); git(f.driver.integrationWorktree, ["commit", "-qm", "test: foreign mutation"]); }
		} else if (mutation === "detached") git(f.driver.integrationWorktree, ["checkout", "--detach", "HEAD"]);
		else if (mutation === "tree") f.store.updateIntegrationRepair(repair.repairId, { currentTree: "f".repeat(40) });
		else if (mutation === "namespace") git(f.driver.repoRoot, ["update-ref", "refs/plan-herder/environment-test/foreign", f.request.integrationHead]);
		else if (mutation === "missing_snapshot") f.store.database.prepare("UPDATE manager_integration_repairs SET begin_ref_snapshot_json = NULL, begin_ref_snapshot_sha256 = NULL").run();
		else if (mutation === "gates") f.store.updateIntegrationRepair(repair.repairId, { effectiveGates: [] });
		else if (mutation === "assignment") fs.writeFileSync(f.request.runAssignmentPath, "mutated assignment");
		else f.store.updateRun({ graphSha256: "f".repeat(64) });
		const rejectedTree = treeIdentity(f);
		await assert.rejects(f.resume(), /must be clean|changed|symbolic-ref|namespace evidence is unavailable|exact canonical gate/);
		assert.equal(f.store.getIntegrationRepair(repair.repairId)?.successorRequestId, null);
		assert.equal(f.verificationCalls, 0);
		assert.deepEqual(treeIdentity(f), rejectedTree, "rejection itself never repairs or mutates the frozen tree");
		assert.deepEqual(repairBudget(f), before);
	} finally { f.close(); }
});

test("environment successor transaction rolls back entirely if audit persistence fails", { timeout: 20_000 }, async (t) => {
	const f = await fixture();
	try {
		await f.invoke(f.begin);
		const initial = f.store.getIntegrationRepairForRequest(f.request.requestId)!;
		const journal = t.mock.method(f.store, "recordIntegrationRepairAudit", () => { throw new Error("simulated audit failure"); });
		await assert.rejects(f.resume(), /simulated audit failure/);
		assert.deepEqual(f.store.getIntegrationRepair(initial.repairId), initial);
		assert.equal(f.store.getVerification(f.request.runId, f.request.generation)?.request.requestId, f.request.requestId);
		assert.equal(f.store.getIntegrationRepairAudits(initial.repairId).length, 1);
		assert.equal(f.verificationCalls, 0);
		journal.mock.restore();
		// The retry is still available because no authorization committed.
		await assert.rejects(f.resume(), /decision-only classification cannot execute verification/);
		assert.equal(f.store.getIntegrationRepair(initial.repairId)?.state, "verifying");
	} finally { f.close(); }
});

for (const missing of ["manifest", "audit", "operation"] as const) test(`environment replay fails closed with missing ${missing} evidence`, { timeout: 20_000 }, async () => {
	const f = await fixture();
	try {
		await f.invoke(f.begin);
		await assert.rejects(f.resume(), /decision-only classification cannot execute verification/);
		const sealed = f.store.getIntegrationRepairForRequest(f.request.requestId)!;
		if (missing === "manifest") f.store.updateIntegrationRepair(sealed.repairId, { successorManifest: null });
		else if (missing === "operation") f.store.updateIntegrationRepair(sealed.repairId, { operationId: null });
		else f.store.database.prepare("DELETE FROM manager_integration_repair_audits WHERE action = 'environment-retry'").run();
		f.restart();
		await assert.rejects(f.resume(), /durable integration repair successor|does not match its operator authorization/);
		assert.equal(f.store.getIntegrationRepair(sealed.repairId)?.successorRequestId, sealed.successorRequestId);
		assert.equal(f.verificationCalls, 1, "missing replay evidence does not rebuild or execute a successor");
	} finally { f.close(); }
});
