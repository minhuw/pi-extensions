import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeIntegrationRepairGates } from "../../../src/core/verification.ts";
import { EXECUTION_SCHEMA_VERSION, openExecutionDatabase } from "../../../src/daemon/execution-store.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { integrationRepairCapabilityDigest, integrationRepairCapabilityToken, sha256, stableJson, type VerificationGate, type VerificationManifest, type VerificationRequest } from "../../../src/shared/protocol.ts";

function seedRun(database: NonNullable<ReturnType<typeof openExecutionDatabase>>, runId = "repair-run"): void {
	const now = "2026-08-13T00:00:00.000Z";
	database.prepare(`
		INSERT INTO manager_runs (
			run_id, repository_root, plan_directory, plan_name, host, profile_name, profile_sha256,
			max_parallel, current_generation, graph_sha256, status, checkout_state_token, base_commit,
			integration_branch, integration_worktree, dashboard_url, terminal_detail, created_at, updated_at
		) VALUES (?, '/repo', '/repo/herder-plans', 'herder-plans', 'pi', 'eclipse', ?, 1, 1, ?, 'failed', 'token', ?, 'herder/herder-plans/integration', '/repo/.herder-integration', NULL, NULL, ?, ?)
	`).run(runId, "a".repeat(64), "b".repeat(64), "c".repeat(40), now, now);
}

const gate: VerificationGate = {
	gateId: "unit",
	label: "unit gate",
	cwd: ".",
	argv: ["node", "-e", "process.exit(0)"],
	timeoutMs: 1_000,
	rationale: "retained evidence",
};

function repairInput(planDirectory: string) {
	const database = openExecutionDatabase(planDirectory, { create: true })!;
	seedRun(database);
	database.close();
}

function selectedSuccessorMigrationFixture(): { planDirectory: string; repairId: string; episodeId: string } {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-schema17-invalid-"));
	repairInput(planDirectory);
	const store = new RunStore(planDirectory);
	const now = "2026-08-15T00:00:00.000Z";
	const repairId = "schema17-invalid";
	const makeRequest = (requestId: string, requestSha256: string, integrationHead: string, integrationTree: string, predecessorRequestId?: string): VerificationRequest => ({
		schemaVersion: 1,
		requestId,
		requestSha256,
		runId: "repair-run",
		generation: 1,
		graphSha256: "a".repeat(64),
		runAssignmentPath: "/repo/run-assignment.json",
		runAssignmentSha256: "b".repeat(64),
		integrationBranch: "herder/repair/integration",
		integrationWorktree: "/repo/.herder-integration",
		integrationHead,
		integrationTree,
		requestedAt: now,
		...(predecessorRequestId ? { predecessorRequestId } : {}),
		repairId,
		repairRound: 1,
	});
	const makeManifest = (request: VerificationRequest): VerificationManifest => ({
		schemaVersion: 1,
		requestId: request.requestId,
		requestSha256: request.requestSha256,
		runId: request.runId,
		generation: request.generation,
		graphSha256: request.graphSha256,
		runAssignmentSha256: request.runAssignmentSha256,
		integrationHead: request.integrationHead,
		integrationTree: request.integrationTree,
		rationale: "invalid migration fixture",
		gates: [gate],
		...(request.predecessorRequestId ? { predecessorRequestId: request.predecessorRequestId } : {}),
		repairId,
		repairRound: 1,
	});
	const failVerification = (request: VerificationRequest): VerificationManifest => {
		const manifest = makeManifest(request);
		store.putVerificationRequest(request);
		store.startVerification(request.requestId, manifest, sha256(stableJson(manifest)));
		store.finishVerification(request.requestId, "failed", { passed: false }, "failed");
		return manifest;
	};
	const r0 = makeRequest("schema17-invalid-r0", "1".repeat(64), "c".repeat(40), "d".repeat(40));
	const r1 = makeRequest("schema17-invalid-r1", "3".repeat(64), "e".repeat(40), "f".repeat(40), r0.requestId);
	failVerification(r0);
	const r1Manifest = failVerification(r1);
	const operationId = "schema17-invalid-begin-r0";
	const operationPayloadSha256 = sha256(operationId);
	const repair = store.putIntegrationRepair({
		repairId,
		runId: "repair-run",
		generation: 1,
		requestId: r0.requestId,
		requestSha256: r0.requestSha256,
		ownerSessionId: "main-session",
		capabilityDigest: integrationRepairCapabilityDigest("2".repeat(64)),
		classification: "code_defect",
		state: "failed",
		parentCommit: r0.integrationHead,
		currentTree: r0.integrationTree,
		canonicalGates: [gate],
		canonicalGatesSha256: sha256(stableJson([gate])),
		operationId,
		operationPayloadSha256,
	});
	store.recordIntegrationRepairAudit(repair.repairId, operationId, "begin", operationPayloadSha256, {
		operation: "begin",
		requestId: r0.requestId,
		requestSha256: r0.requestSha256,
		classification: "code_defect",
	});
	store.updateIntegrationRepair(repair.repairId, {
		state: "failed",
		successorRequestId: r1.requestId,
		successorRequestSha256: r1.requestSha256,
		successorManifest: r1Manifest,
		successorManifestSha256: sha256(stableJson(r1Manifest)),
	});
	store.closeIntegrationRepairEpisode(repair.repairId, repair.episodeId!, "failed");
	const successor = store.openIntegrationRepairEpisode({
		repairId,
		requestId: r1.requestId,
		requestSha256: r1.requestSha256,
		integrationHead: r1.integrationHead,
		integrationTree: r1.integrationTree,
		canonicalGates: [gate],
		canonicalGatesSha256: sha256(stableJson([gate])),
		state: "failed",
		detail: "failed successor",
	});
	const selectedOperationId = "schema17-invalid-begin-r1";
	store.selectIntegrationRepairEpisode(repairId, {
		classification: "manifest_error",
		operationId: selectedOperationId,
		operationPayloadSha256: sha256(selectedOperationId),
		state: "active",
	});
	store.recordIntegrationRepairAudit(repairId, selectedOperationId, "begin", sha256(selectedOperationId), {
		operation: "begin",
		requestId: r1.requestId,
		requestSha256: r1.requestSha256,
		classification: "manifest_error",
	});
	store.close();
	return { planDirectory, repairId, episodeId: successor.episodeId! };
}

test("schema 12 reopens once into begin-bound repair schema and remains idempotent", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-schema-"));
	try {
		const initial = openExecutionDatabase(planDirectory, { create: true })!;
		seedRun(initial);
		initial.exec("PRAGMA user_version = 12;");
		initial.close();
		const migrated = openExecutionDatabase(planDirectory, { create: true })!;
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), EXECUTION_SCHEMA_VERSION);
		const repairColumns = new Set((migrated.prepare("PRAGMA table_info(manager_integration_repairs)").all() as Array<{ name: string }>).map((row) => row.name));
		assert.equal(repairColumns.has("begin_ref_snapshot_json"), true);
		assert.equal(repairColumns.has("begin_ref_snapshot_sha256"), true);
		const tables = new Set((migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
		assert.ok(tables.has("manager_integration_repairs"));
		assert.ok(tables.has("manager_integration_repair_audits"));
		assert.ok(tables.has("manager_integration_repair_episodes"));
		const episodeColumns = new Set((migrated.prepare("PRAGMA table_info(manager_integration_repair_episodes)").all() as Array<{ name: string }>).map((row) => row.name));
		assert.equal(episodeColumns.has("transient_used"), true);
		assert.equal(episodeColumns.has("canonical_gates_sha256"), true);
		assert.match(String((migrated.prepare("SELECT sql FROM sqlite_master WHERE name = 'manager_operations'").get() as { sql: string }).sql), /integration_repair/);
		migrated.close();
		const repeated = openExecutionDatabase(planDirectory, { create: true })!;
		assert.equal(Number((repeated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), EXECUTION_SCHEMA_VERSION);
		repeated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("repair rows and audits converge on identical replay and reject divergent evidence", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-store-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		const token = "d".repeat(64);
		const beginRefs = [{ ref: "refs/heads/herder/repair-test/integration", target: "c".repeat(40) }];
		const beginRefSnapshot = stableJson(beginRefs);
		const beginRefSnapshotSha256 = sha256(beginRefSnapshot);
		const row = store.putIntegrationRepair({
			repairId: "repair-1",
			runId: "repair-run",
			generation: 1,
			requestId: "verify-1",
			requestSha256: "e".repeat(64),
			ownerSessionId: "main-session",
			capabilityDigest: integrationRepairCapabilityDigest(token),
			classification: "code_defect",
			beginRefSnapshot,
			beginRefSnapshotSha256,
			parentCommit: "c".repeat(40),
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
		});
		assert.equal(row.beginRefSnapshot, beginRefSnapshot);
		assert.equal(row.beginRefSnapshotSha256, beginRefSnapshotSha256);
		assert.equal(store.putIntegrationRepair({
			repairId: row.repairId,
			runId: row.runId,
			generation: row.generation,
			requestId: row.requestId,
			requestSha256: row.requestSha256,
			ownerSessionId: row.ownerSessionId,
			capabilityDigest: row.capabilityDigest,
			classification: row.classification,
			parentCommit: row.parentCommit,
			canonicalGates: [gate],
			canonicalGatesSha256: row.canonicalGatesSha256,
		}).repairId, "repair-1");
		assert.throws(() => store.updateIntegrationRepair(row.repairId, {
			beginRefSnapshot: stableJson([{ ref: "refs/heads/herder/repair-test/integration", target: "d".repeat(40) }]),
			beginRefSnapshotSha256: sha256(stableJson([{ ref: "refs/heads/herder/repair-test/integration", target: "d".repeat(40) }])),
		}), /immutable/);
		const payloadHash = sha256("begin");
		assert.equal(store.recordIntegrationRepairAudit(row.repairId, "op-1", "begin", payloadHash, { z: 1, a: 2 }).auditId,
			store.recordIntegrationRepairAudit(row.repairId, "op-1", "begin", payloadHash, { a: 2, z: 1 }).auditId);
		assert.throws(() => store.recordIntegrationRepairAudit(row.repairId, "op-1", "begin", sha256("other"), { a: 2, z: 1 }), /different evidence/);
		const receipt = store.submitOperation("op-repair", "integration_repair", { operation: "begin", requestId: "verify-1", capabilityToken: token });
		assert.equal(receipt.state, "accepted");
		const operation = store.database.prepare("SELECT payload_json FROM manager_operations WHERE operation_id = 'op-repair'").get() as { payload_json: string };
		assert.equal(operation.payload_json.includes(token), false);
		assert.equal(operation.payload_json.includes(integrationRepairCapabilityDigest(token)), true);
		store.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("repair reply persistence stores only the capability digest and restores request-bound access", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-reply-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		const requestId = "verify-reply";
		const token = integrationRepairCapabilityToken(requestId);
		const reply = { integrationRepair: {
			requestId,
			capabilityToken: token,
			capabilityTokenSha256: integrationRepairCapabilityDigest(token),
		} };
		store.submitOperation("reply-operation", "integration_repair", { operation: "begin", requestId, capabilityToken: token });
		assert.equal(store.claimNextOperation()?.operationId, "reply-operation");
		const receipt = store.completeOperation("reply-operation", reply);
		const storedResult = store.database.prepare("SELECT result_json FROM manager_operations WHERE operation_id = 'reply-operation'").get() as { result_json: string };
		assert.equal(storedResult.result_json.includes(token), false);
		assert.equal(storedResult.result_json.includes(integrationRepairCapabilityDigest(token)), true);
		assert.equal((receipt.result as { integrationRepair: { capabilityToken?: string } }).integrationRepair.capabilityToken, token);
		const exposed = store.operationReceipt("reply-operation")!;
		assert.equal((exposed.result as { integrationRepair: { capabilityToken?: string } }).integrationRepair.capabilityToken, token);
		store.putSnapshot(reply as never);
		const storedSnapshot = store.database.prepare("SELECT reply_json FROM manager_snapshots WHERE singleton = 1").get() as { reply_json: string };
		assert.equal(storedSnapshot.reply_json.includes(token), false);
		assert.equal(storedSnapshot.reply_json.includes(integrationRepairCapabilityDigest(token)), true);
		assert.equal((store.getSnapshot() as never as { integrationRepair: { capabilityToken?: string } }).integrationRepair.capabilityToken, token);
		store.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("a claimed begin without a repair row is replayed after recovery", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-recovery-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		store.submitOperation("missing-row-begin", "integration_repair", { operation: "begin", requestId: "verify-1", capabilityToken: "d".repeat(64) });
		assert.equal(store.claimNextOperation()?.state, "running");
		store.recoverRunningOperations();
		assert.equal(store.getOperation("missing-row-begin")?.state, "accepted");
		store.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("verification recovery records one unclaimed initial repair episode", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-verification-recovery-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		const request: VerificationRequest = {
			schemaVersion: 1,
			requestId: "verification-recovery-initial",
			requestSha256: "e".repeat(64),
			runId: "repair-run",
			generation: 1,
			graphSha256: "a".repeat(64),
			runAssignmentPath: "/repo/run-assignment.json",
			runAssignmentSha256: "b".repeat(64),
			integrationBranch: "herder/repair/integration",
			integrationWorktree: "/repo/.herder-integration",
			integrationHead: "c".repeat(40),
			integrationTree: "d".repeat(40),
			requestedAt: "2026-08-15T00:00:00.000Z",
		};
		const manifest: VerificationManifest = {
			schemaVersion: 1,
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			runId: request.runId,
			generation: request.generation,
			graphSha256: request.graphSha256,
			runAssignmentSha256: request.runAssignmentSha256,
			integrationHead: request.integrationHead,
			integrationTree: request.integrationTree,
			rationale: "recovery fixture",
			gates: [gate],
		};
		store.putVerificationRequest(request);
		store.startVerification(request.requestId, manifest, sha256(stableJson(manifest)));
		store.database.prepare("UPDATE manager_runs SET status = 'running'").run();
		store.submitOperation("verification-recovery", "verification", { requestId: request.requestId });
		assert.equal(store.claimNextOperation()?.state, "running");

		store.recoverRunningOperations();

		assert.equal(store.getOperation("verification-recovery")?.state, "failed");
		assert.equal(store.getVerificationByRequestId(request.requestId)?.state, "failed");
		assert.equal(store.getRun()?.status, "failed");
		const repair = store.getIntegrationRepairForRequest(request.requestId);
		assert.ok(repair);
		assert.equal(repair.ownerSessionId, null);
		assert.equal(repair.capabilityDigest, null);
		assert.equal(repair.classification, null);
		assert.equal(repair.state, "failed");
		assert.equal(repair.episodeRequestId, request.requestId);
		assert.equal(repair.episodeRequestSha256, request.requestSha256);
		assert.equal(repair.episodeIntegrationHead, request.integrationHead);
		assert.equal(repair.episodeIntegrationTree, request.integrationTree);
		assert.equal(repair.episodeClassification, null);
		assert.equal(repair.episodeState, "failed");
		assert.deepEqual(repair.episodeCanonicalGates, [gate]);
		const episodes = store.getIntegrationRepairEpisodes(repair.repairId);
		assert.equal(episodes.length, 1);
		assert.equal(episodes[0]!.classification, null);
		assert.equal(episodes[0]!.closedAt, null);
		assert.equal(store.getIntegrationRepairAudits(repair.repairId).length, 0);

		store.recoverRunningOperations();
		assert.equal(store.getIntegrationRepairEpisodes(repair.repairId).length, 1);
		store.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("verification recovery preserves a durably passed initial verification", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-passed-verification-recovery-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		const request: VerificationRequest = {
			schemaVersion: 1,
			requestId: "verification-recovery-passed",
			requestSha256: "e".repeat(64),
			runId: "repair-run",
			generation: 1,
			graphSha256: "a".repeat(64),
			runAssignmentPath: "/repo/run-assignment.json",
			runAssignmentSha256: "b".repeat(64),
			integrationBranch: "herder/repair/integration",
			integrationWorktree: "/repo/.herder-integration",
			integrationHead: "c".repeat(40),
			integrationTree: "d".repeat(40),
			requestedAt: "2026-08-15T00:00:00.000Z",
		};
		const manifest: VerificationManifest = {
			schemaVersion: 1,
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			runId: request.runId,
			generation: request.generation,
			graphSha256: request.graphSha256,
			runAssignmentSha256: request.runAssignmentSha256,
			integrationHead: request.integrationHead,
			integrationTree: request.integrationTree,
			rationale: "passed recovery fixture",
			gates: [gate],
		};
		store.submitOperation("verification-recovery-passed", "verification", { requestId: request.requestId });
		assert.equal(store.claimNextOperation()?.state, "running");
		store.putVerificationRequest(request);
		store.startVerification(request.requestId, manifest, sha256(stableJson(manifest)));
		store.finishVerification(request.requestId, "passed", { passed: true }, null);
		// Legacy passed verifications may not retain a manifest, but their terminal
		// state is still sufficient to replay the in-flight operation safely.
		store.database.prepare("UPDATE manager_verifications SET manifest_json = NULL, manifest_sha256 = NULL WHERE request_id = ?").run(request.requestId);
		store.database.prepare("UPDATE manager_runs SET status = 'running'").run();

		store.recoverRunningOperations();

		assert.equal(store.getOperation("verification-recovery-passed")?.state, "accepted");
		assert.equal(store.getVerificationByRequestId(request.requestId)?.state, "passed");
		assert.equal(store.getRun()?.status, "running");
		assert.equal(store.getIntegrationRepairForRequest(request.requestId), null);
		store.recoverRunningOperations();
		assert.equal(store.getIntegrationRepairForRequest(request.requestId), null);
		store.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("repair gate programs retain an exact ordered prefix and append only recorded IDs", () => {
	const addition = { ...gate, gateId: "added", label: "added gate" };
	assert.deepEqual(normalizeIntegrationRepairGates({ classification: "code_defect", retainedGates: [gate], candidateGates: [gate, addition], recordedAdditions: [addition] }), [gate, addition]);
	assert.throws(() => normalizeIntegrationRepairGates({ classification: "code_defect", retainedGates: [gate], candidateGates: [addition, gate] }), /changed or was reordered/);
	assert.throws(() => normalizeIntegrationRepairGates({ classification: "code_defect", retainedGates: [gate], candidateGates: [gate, addition], recordedAdditions: [] }), /not the recorded append-only program/);
	assert.deepEqual(normalizeIntegrationRepairGates({ classification: "manifest_error", retainedGates: [gate], candidateGates: [addition] }), [addition]);
});

test("classification episodes retain immutable history and transient evidence across successors", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-episodes-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		const head = "c".repeat(40);
		const tree = "d".repeat(40);
		const first = store.putIntegrationRepair({
			repairId: "episode-lineage",
			runId: "repair-run",
			generation: 1,
			requestId: "verify-episode-1",
			requestSha256: "e".repeat(64),
			ownerSessionId: "main-session",
			capabilityDigest: integrationRepairCapabilityDigest("f".repeat(64)),
			classification: "transient",
			state: "active",
			parentCommit: head,
			currentTree: tree,
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
		});
		assert.ok(first.episodeId);
		assert.equal(store.getIntegrationRepairEpisodes(first.repairId).length, 1);
		store.recordIntegrationRepairAudit(first.repairId, "episode-begin-1", "begin", sha256("episode-begin-1"), { classification: "transient" });
		const evidence = sha256(stableJson({ integrationHead: head, integrationTree: tree, canonicalGatesSha256: sha256(stableJson([gate])) }));
		store.markIntegrationRepairEpisodeTransientUsed(first.repairId, first.episodeId!, evidence);
		store.closeIntegrationRepairEpisode(first.repairId, first.episodeId!, "failed");
		const second = store.openIntegrationRepairEpisode({
			repairId: first.repairId,
			requestId: "verify-episode-2",
			requestSha256: "a".repeat(64),
			integrationHead: head,
			integrationTree: tree,
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
			state: "failed",
		});
		assert.notEqual(second.episodeId, first.episodeId);
		assert.equal(second.classification, null);
		assert.equal(second.acceptedCodeRounds, 0);
		assert.equal(second.transientRetryUsed, true);
		assert.equal(store.getIntegrationRepairEpisodes(first.repairId)[0]!.classification, "transient");
		assert.equal(store.getIntegrationRepairEpisodes(first.repairId)[0]!.closedAt !== null, true);
		const selected = store.selectIntegrationRepairEpisode(first.repairId, {
			classification: "manifest_error",
			operationId: "episode-begin-2",
			operationPayloadSha256: sha256("episode-begin-2"),
			state: "active",
		});
		assert.equal(selected.classification, "manifest_error");
		assert.throws(() => store.selectIntegrationRepairEpisode(first.repairId, {
			classification: "code_defect",
			operationId: "episode-begin-3",
			operationPayloadSha256: sha256("episode-begin-3"),
			state: "active",
		}), /cannot change/);
		assert.equal(store.getIntegrationRepairAudits(first.repairId)[0]!.episodeId, first.episodeId);
		store.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("schema 14 migration preserves successor evidence, code rounds, and transient consumption", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-migration-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		const now = "2026-08-15T00:00:00.000Z";
		const graphSha256 = "a".repeat(64);
		const assignmentSha256 = "b".repeat(64);
		const branch = "herder/repair/integration";
		const worktree = "/repo/.herder-integration";
		const makeRequest = (requestId: string, requestSha256: string, head: string, tree: string, repairId: string, predecessorRequestId?: string) => ({
			schemaVersion: 1 as const,
			requestId,
			requestSha256,
			runId: "repair-run",
			generation: 1,
			graphSha256,
			runAssignmentPath: "/repo/run-assignment.json",
			runAssignmentSha256: assignmentSha256,
			integrationBranch: branch,
			integrationWorktree: worktree,
			integrationHead: head,
			integrationTree: tree,
			requestedAt: now,
			...(predecessorRequestId ? { predecessorRequestId } : {}),
			repairId,
			repairRound: 1,
		});
		const makeManifest = (request: ReturnType<typeof makeRequest>) => ({
			schemaVersion: 1 as const,
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			runId: request.runId,
			generation: request.generation,
			graphSha256: request.graphSha256,
			runAssignmentSha256: request.runAssignmentSha256,
			integrationHead: request.integrationHead,
			integrationTree: request.integrationTree,
			rationale: "migration fixture",
			gates: [gate],
			...(request.predecessorRequestId ? { predecessorRequestId: request.predecessorRequestId } : {}),
			repairId: request.repairId,
			repairRound: request.repairRound,
		});
		const insertVerification = (request: ReturnType<typeof makeRequest>) => {
			const manifest = makeManifest(request);
			store.putVerificationRequest(request);
			const manifestSha256 = sha256(stableJson(manifest));
			store.startVerification(request.requestId, manifest, manifestSha256);
			store.finishVerification(request.requestId, "failed", { passed: false }, "failed");
			return { manifest, manifestSha256 };
		};
		const head = "c".repeat(40);
		const tree = "d".repeat(40);
		const codeHead = "e".repeat(40);
		const codeTree = "f".repeat(40);
		const codeHead2 = "7".repeat(40);
		const codeTree2 = "8".repeat(40);
		const codeRepairId = "migration-code";
		const codeRequest0 = makeRequest("migration-code-r0", "1".repeat(64), head, tree, codeRepairId);
		insertVerification(codeRequest0);
		const codeRepair = store.putIntegrationRepair({
			repairId: codeRepairId,
			runId: "repair-run",
			generation: 1,
			requestId: codeRequest0.requestId,
			requestSha256: codeRequest0.requestSha256,
			ownerSessionId: "main-session",
			capabilityDigest: integrationRepairCapabilityDigest("2".repeat(64)),
			classification: "code_defect",
			state: "verifying",
			round: 3,
			parentCommit: head,
			currentTree: codeTree,
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
			effectiveGates: [gate],
		});
		const codeRequest1 = makeRequest("migration-code-r1", "3".repeat(64), codeHead, codeTree, codeRepairId, codeRequest0.requestId);
		insertVerification(codeRequest1);
		const codeRequest2 = makeRequest("migration-code-r2", "9".repeat(64), codeHead2, codeTree2, codeRepairId, codeRequest1.requestId);
		const codeSuccessor2 = insertVerification(codeRequest2);
		const transientRepairId = "migration-transient";
		const transientRequest0 = makeRequest("migration-transient-r0", "4".repeat(64), head, tree, transientRepairId);
		insertVerification(transientRequest0);
		const transientRepair = store.putIntegrationRepair({
			repairId: transientRepairId,
			runId: "repair-run",
			generation: 1,
			requestId: transientRequest0.requestId,
			requestSha256: transientRequest0.requestSha256,
			ownerSessionId: "main-session",
			capabilityDigest: integrationRepairCapabilityDigest("5".repeat(64)),
			classification: "transient",
			state: "verifying",
			parentCommit: head,
			currentTree: tree,
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
			effectiveGates: [gate],
		});
		const transientRequest1 = makeRequest("migration-transient-r1", "6".repeat(64), head, tree, transientRepairId, transientRequest0.requestId);
		const transientSuccessor = insertVerification(transientRequest1);
		const setLegacySuccessor = store.database.prepare(`
			UPDATE manager_integration_repairs SET state = 'verifying', successor_request_id = ?, successor_request_sha256 = ?,
				successor_manifest_json = ?, successor_manifest_sha256 = ?, current_episode_id = NULL, accepted_code_rounds = 0
			WHERE repair_id = ?
		`);
		setLegacySuccessor.run(codeRequest2.requestId, codeRequest2.requestSha256, JSON.stringify(codeSuccessor2.manifest), codeSuccessor2.manifestSha256, codeRepairId);
		setLegacySuccessor.run(transientRequest1.requestId, transientRequest1.requestSha256, JSON.stringify(transientSuccessor.manifest), transientSuccessor.manifestSha256, transientRepairId);
		const insertAudit = store.database.prepare(`
			INSERT INTO manager_integration_repair_audits (repair_id, operation_id, action, payload_sha256, evidence_json, created_at, episode_id)
			VALUES (?, ?, ?, ?, ?, ?, NULL)
		`);
		const insertRepairAudits = (repairId: string, request: ReturnType<typeof makeRequest>, classification: string, headValue: string, treeValue: string, successorRequestId: string, suffix: string) => {
			insertAudit.run(repairId, `${repairId}-begin-${suffix}`, "begin", "1".repeat(64), JSON.stringify({ operation: "begin", requestId: request.requestId, requestSha256: request.requestSha256, classification }), now);
			insertAudit.run(repairId, `${repairId}-finish-${suffix}`, "finish-intent", "2".repeat(64), JSON.stringify({ operation: "finish", requestId: request.requestId, requestSha256: request.requestSha256 }), now);
			insertAudit.run(repairId, `${repairId}-finish-${suffix}`, "commit", "2".repeat(64), JSON.stringify({ head: headValue, tree: treeValue, parent: head, supersededCommits: [] }), now);
			insertAudit.run(repairId, `${repairId}-finish-${suffix}`, "successor", "2".repeat(64), JSON.stringify({ requestId: successorRequestId }), now);
		};
		insertRepairAudits(codeRepairId, codeRequest0, "code_defect", codeHead, codeTree, codeRequest1.requestId, "r0");
		insertRepairAudits(codeRepairId, codeRequest1, "manifest_error", codeHead2, codeTree2, codeRequest2.requestId, "r1");
		insertRepairAudits(transientRepairId, transientRequest0, "transient", head, tree, transientRequest1.requestId, "r0");
		store.database.exec("DELETE FROM manager_integration_repair_episodes; PRAGMA user_version = 14;");
		store.close();

		const migrated = new RunStore(planDirectory);
		try {
			const migratedCode = migrated.getIntegrationRepair(codeRepair.repairId)!;
			assert.equal(migratedCode.requestId, codeRequest2.requestId);
			assert.equal(migratedCode.classification, null);
			assert.equal(migratedCode.acceptedCodeRounds, 1);
			const codeEpisodes = migrated.getIntegrationRepairEpisodes(codeRepair.repairId);
			assert.equal(codeEpisodes.length, 3);
			assert.equal(codeEpisodes[0]!.classification, "code_defect");
			assert.equal(codeEpisodes[0]!.closedAt !== null, true);
			assert.equal(codeEpisodes[1]!.requestId, codeRequest1.requestId);
			assert.equal(codeEpisodes[1]!.classification, "manifest_error");
			assert.equal(codeEpisodes[1]!.closedAt !== null, true);
			assert.equal(codeEpisodes[2]!.requestId, codeRequest2.requestId);
			assert.equal(codeEpisodes[2]!.classification, null);
			assert.equal(codeEpisodes[2]!.closedAt, null);
			const auditEpisodes = migrated.getIntegrationRepairAudits(codeRepair.repairId).map((audit) => audit.episodeId);
			assert.equal(auditEpisodes.slice(0, 4).every((episodeId) => episodeId === codeEpisodes[0]!.episodeId), true);
			assert.equal(auditEpisodes.slice(4).every((episodeId) => episodeId === codeEpisodes[1]!.episodeId), true);
			const migratedTransient = migrated.getIntegrationRepair(transientRepair.repairId)!;
			assert.equal(migratedTransient.requestId, transientRequest1.requestId);
			assert.equal(migratedTransient.transientRetryUsed, true);
			assert.equal(migratedTransient.acceptedCodeRounds, 0);
			const transientEpisodes = migrated.getIntegrationRepairEpisodes(transientRepair.repairId);
			assert.equal(transientEpisodes[0]!.transientUsed, true);
			assert.equal(transientEpisodes[1]!.classification, null);
		} finally {
			migrated.close();
		}
		const repeated = new RunStore(planDirectory);
		try {
			assert.equal(repeated.getIntegrationRepairEpisodes(codeRepairId).length, 3);
			assert.equal(repeated.getIntegrationRepairEpisodes(transientRepairId).length, 2);
			assert.equal(repeated.getIntegrationRepair(codeRepairId)!.acceptedCodeRounds, 1);
			assert.equal(repeated.getIntegrationRepair(transientRepairId)!.transientRetryUsed, true);
		} finally {
			repeated.close();
		}
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("schema 16 migration keeps a selected failed successor episode open", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-schema16-current-episode-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		const now = "2026-08-15T00:00:00.000Z";
		const makeRequest = (requestId: string, requestSha256: string, integrationHead: string, integrationTree: string, predecessorRequestId?: string): VerificationRequest => ({
			schemaVersion: 1,
			requestId,
			requestSha256,
			runId: "repair-run",
			generation: 1,
			graphSha256: "a".repeat(64),
			runAssignmentPath: "/repo/run-assignment.json",
			runAssignmentSha256: "b".repeat(64),
			integrationBranch: "herder/repair/integration",
			integrationWorktree: "/repo/.herder-integration",
			integrationHead,
			integrationTree,
			requestedAt: now,
			...(predecessorRequestId ? { predecessorRequestId } : {}),
			repairId: "schema16-repair",
			repairRound: 1,
		});
		const failVerification = (request: VerificationRequest): VerificationManifest => {
			const manifest: VerificationManifest = {
				schemaVersion: 1,
				requestId: request.requestId,
				requestSha256: request.requestSha256,
				runId: request.runId,
				generation: request.generation,
				graphSha256: request.graphSha256,
				runAssignmentSha256: request.runAssignmentSha256,
				integrationHead: request.integrationHead,
				integrationTree: request.integrationTree,
				rationale: "schema 16 recovery fixture",
				gates: [gate],
				...(request.predecessorRequestId ? { predecessorRequestId: request.predecessorRequestId } : {}),
				repairId: "schema16-repair",
				repairRound: 1,
			};
			store.putVerificationRequest(request);
			store.startVerification(request.requestId, manifest, sha256(stableJson(manifest)));
			store.finishVerification(request.requestId, "failed", { passed: false }, "failed");
			return manifest;
		};
		const r0 = makeRequest("schema16-r0", "1".repeat(64), "c".repeat(40), "d".repeat(40));
		failVerification(r0);
		const repair = store.putIntegrationRepair({
			repairId: "schema16-repair",
			runId: "repair-run",
			generation: 1,
			requestId: r0.requestId,
			requestSha256: r0.requestSha256,
			ownerSessionId: "main-session",
			capabilityDigest: integrationRepairCapabilityDigest("2".repeat(64)),
			classification: "code_defect",
			state: "failed",
			parentCommit: r0.integrationHead,
			currentTree: r0.integrationTree,
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
			operationId: "schema16-begin-r0",
			operationPayloadSha256: sha256("schema16-begin-r0"),
		});
		store.recordIntegrationRepairAudit(repair.repairId, "schema16-begin-r0", "begin", sha256("schema16-begin-r0"), {
			operation: "begin",
			requestId: r0.requestId,
			requestSha256: r0.requestSha256,
			classification: "code_defect",
		});
		const r1 = makeRequest("schema16-r1", "3".repeat(64), "e".repeat(40), "f".repeat(40), r0.requestId);
		const r1Manifest = failVerification(r1);
		store.updateIntegrationRepair(repair.repairId, {
			state: "failed",
			successorRequestId: r1.requestId,
			successorRequestSha256: r1.requestSha256,
			successorManifest: r1Manifest,
			successorManifestSha256: sha256(stableJson(r1Manifest)),
		});
		store.closeIntegrationRepairEpisode(repair.repairId, repair.episodeId!, "failed");
		store.openIntegrationRepairEpisode({
			repairId: repair.repairId,
			requestId: r1.requestId,
			requestSha256: r1.requestSha256,
			integrationHead: r1.integrationHead,
			integrationTree: r1.integrationTree,
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
			state: "failed",
			detail: "failed successor",
		});
		const before = store.getIntegrationRepair(repair.repairId)!;
		assert.equal(before.requestId, r1.requestId);
		assert.equal(store.getIntegrationRepairEpisode(before.episodeId!)?.closedAt, null);
		store.database.exec("PRAGMA user_version = 15;");
		store.close();

		const migrated = new RunStore(planDirectory);
		try {
			const current = migrated.getIntegrationRepair(repair.repairId)!;
			const episodes = migrated.getIntegrationRepairEpisodes(repair.repairId);
			assert.equal(current.requestId, r1.requestId);
			assert.equal(current.successorRequestId, r1.requestId);
			assert.equal(episodes.length, 2);
			assert.equal(episodes[0]!.requestId, r0.requestId);
			assert.equal(episodes[0]!.classification, "code_defect");
			assert.notEqual(episodes[0]!.closedAt, null);
			assert.equal(episodes[1]!.requestId, r1.requestId);
			assert.equal(episodes[1]!.classification, null);
			assert.equal(episodes[1]!.closedAt, null);
			const selected = migrated.selectIntegrationRepairEpisode(repair.repairId, {
				classification: "manifest_error",
				operationId: "schema16-begin-r1",
				operationPayloadSha256: sha256("schema16-begin-r1"),
				state: "active",
			});
			assert.equal(selected.episodeClassification, "manifest_error");
			assert.equal(selected.episodeState, "active");
			assert.equal(selected.episodeId, episodes[1]!.episodeId);
			assert.equal(migrated.getIntegrationRepairEpisode(selected.episodeId!)?.closedAt, null);
			assert.deepEqual(migrated.getIntegrationRepairAudits(repair.repairId).map((audit) => audit.episodeId), [episodes[0]!.episodeId]);
			migrated.database.exec("PRAGMA user_version = 15;");
		} finally {
			migrated.close();
		}

		const repeated = new RunStore(planDirectory);
		try {
			const repeatedEpisodes = repeated.getIntegrationRepairEpisodes(repair.repairId);
			assert.equal(repeatedEpisodes.length, 2);
			assert.equal(repeatedEpisodes[0]!.classification, "code_defect");
			assert.notEqual(repeatedEpisodes[0]!.closedAt, null);
			assert.equal(repeatedEpisodes[1]!.classification, "manifest_error");
			assert.equal(repeatedEpisodes[1]!.closedAt, null);
			assert.deepEqual(repeated.getIntegrationRepairAudits(repair.repairId).map((audit) => audit.episodeId), [repeatedEpisodes[0]!.episodeId]);
		} finally {
			repeated.close();
		}
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("schema migration preserves a preselected failed successor episode", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-schema17-selected-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		const now = "2026-08-15T00:00:00.000Z";
		const makeRequest = (requestId: string, requestSha256: string, integrationHead: string, integrationTree: string, predecessorRequestId?: string): VerificationRequest => ({
			schemaVersion: 1,
			requestId,
			requestSha256,
			runId: "repair-run",
			generation: 1,
			graphSha256: "a".repeat(64),
			runAssignmentPath: "/repo/run-assignment.json",
			runAssignmentSha256: "b".repeat(64),
			integrationBranch: "herder/repair/integration",
			integrationWorktree: "/repo/.herder-integration",
			integrationHead,
			integrationTree,
			requestedAt: now,
			...(predecessorRequestId ? { predecessorRequestId } : {}),
			repairId: "schema17-selected",
			repairRound: 1,
		});
		const makeManifest = (request: VerificationRequest): VerificationManifest => ({
			schemaVersion: 1,
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			runId: request.runId,
			generation: request.generation,
			graphSha256: request.graphSha256,
			runAssignmentSha256: request.runAssignmentSha256,
			integrationHead: request.integrationHead,
			integrationTree: request.integrationTree,
			rationale: "selected migration fixture",
			gates: [gate],
			...(request.predecessorRequestId ? { predecessorRequestId: request.predecessorRequestId } : {}),
			repairId: "schema17-selected",
			repairRound: 1,
		});
		const failVerification = (request: VerificationRequest): VerificationManifest => {
			const manifest = makeManifest(request);
			store.putVerificationRequest(request);
			store.startVerification(request.requestId, manifest, sha256(stableJson(manifest)));
			store.finishVerification(request.requestId, "failed", { passed: false }, "failed");
			return manifest;
		};
		const r0 = makeRequest("schema17-selected-r0", "1".repeat(64), "c".repeat(40), "d".repeat(40));
		const r1 = makeRequest("schema17-selected-r1", "3".repeat(64), "e".repeat(40), "f".repeat(40), r0.requestId);
		failVerification(r0);
		const r1Manifest = failVerification(r1);
		const operationId = "schema17-selected-begin-r0";
		const operationPayloadSha256 = sha256(operationId);
		const repair = store.putIntegrationRepair({
			repairId: "schema17-selected",
			runId: "repair-run",
			generation: 1,
			requestId: r0.requestId,
			requestSha256: r0.requestSha256,
			ownerSessionId: "main-session",
			capabilityDigest: integrationRepairCapabilityDigest("2".repeat(64)),
			classification: "code_defect",
			state: "failed",
			parentCommit: r0.integrationHead,
			currentTree: r0.integrationTree,
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
			operationId,
			operationPayloadSha256,
		});
		store.recordIntegrationRepairAudit(repair.repairId, operationId, "begin", operationPayloadSha256, {
			operation: "begin",
			requestId: r0.requestId,
			requestSha256: r0.requestSha256,
			classification: "code_defect",
		});
		store.updateIntegrationRepair(repair.repairId, {
			state: "failed",
			successorRequestId: r1.requestId,
			successorRequestSha256: r1.requestSha256,
			successorManifest: r1Manifest,
			successorManifestSha256: sha256(stableJson(r1Manifest)),
		});
		const successor = store.openIntegrationRepairEpisode({
			repairId: repair.repairId,
			requestId: r1.requestId,
			requestSha256: r1.requestSha256,
			integrationHead: r1.integrationHead,
			integrationTree: r1.integrationTree,
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
			state: "failed",
			detail: "failed successor",
		});
		const selectedOperationId = "schema17-selected-begin-r1";
		const selectedOperationPayloadSha256 = sha256(selectedOperationId);
		store.selectIntegrationRepairEpisode(repair.repairId, {
			classification: "manifest_error",
			operationId: selectedOperationId,
			operationPayloadSha256: selectedOperationPayloadSha256,
			state: "active",
		});
		store.recordIntegrationRepairAudit(repair.repairId, selectedOperationId, "begin", selectedOperationPayloadSha256, {
			operation: "begin",
			requestId: r1.requestId,
			requestSha256: r1.requestSha256,
			classification: "manifest_error",
		});
		const episodeBefore = store.database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?").get(successor.episodeId) as Record<string, unknown>;
		const auditsBefore = store.database.prepare("SELECT * FROM manager_integration_repair_audits WHERE repair_id = ? ORDER BY audit_id").all(repair.repairId) as Record<string, unknown>[];
		store.database.exec("PRAGMA user_version = 15;");
		store.close();

		const migrated = new RunStore(planDirectory);
		try {
			const current = migrated.getIntegrationRepair(repair.repairId)!;
			assert.equal(Number((migrated.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), EXECUTION_SCHEMA_VERSION);
			assert.equal(current.requestId, r1.requestId);
			assert.equal(current.requestSha256, r1.requestSha256);
			assert.equal(current.classification, "manifest_error");
			assert.equal(current.state, "active");
			assert.equal(current.operationId, selectedOperationId);
			assert.equal(current.operationPayloadSha256, selectedOperationPayloadSha256);
			assert.equal(current.episodeId, successor.episodeId);
			assert.equal(current.episodeClassification, "manifest_error");
			assert.equal(current.episodeState, "active");
			assert.equal(current.episodeOperationId, selectedOperationId);
			assert.equal(migrated.getIntegrationRepairEpisode(successor.episodeId!)!.closedAt, null);
			assert.deepEqual(migrated.database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?").get(successor.episodeId), episodeBefore);
			assert.deepEqual(migrated.database.prepare("SELECT * FROM manager_integration_repair_audits WHERE repair_id = ? ORDER BY audit_id").all(repair.repairId), auditsBefore);

			migrated.database.prepare("UPDATE manager_integration_repairs SET classification = NULL, state = 'failed', operation_id = NULL, operation_payload_sha256 = NULL WHERE repair_id = ?").run(repair.repairId);
			migrated.database.exec("PRAGMA user_version = 16;");
		} finally {
			migrated.close();
		}

		const repaired = new RunStore(planDirectory);
		try {
			const current = repaired.getIntegrationRepair(repair.repairId)!;
			assert.equal(current.classification, "manifest_error");
			assert.equal(current.state, "active");
			assert.equal(current.operationId, selectedOperationId);
			assert.equal(current.operationPayloadSha256, selectedOperationPayloadSha256);
			assert.equal(current.episodeId, successor.episodeId);
			assert.deepEqual(repaired.database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?").get(successor.episodeId), episodeBefore);
			assert.deepEqual(repaired.database.prepare("SELECT * FROM manager_integration_repair_audits WHERE repair_id = ? ORDER BY audit_id").all(repair.repairId), auditsBefore);
			repaired.database.exec("PRAGMA user_version = 16;");
		} finally {
			repaired.close();
		}

		const repeated = new RunStore(planDirectory);
		try {
			const current = repeated.getIntegrationRepair(repair.repairId)!;
			assert.equal(current.classification, "manifest_error");
			assert.equal(current.state, "active");
			assert.equal(current.operationId, selectedOperationId);
			assert.deepEqual(repeated.database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?").get(successor.episodeId), episodeBefore);
			assert.deepEqual(repeated.database.prepare("SELECT * FROM manager_integration_repair_audits WHERE repair_id = ? ORDER BY audit_id").all(repair.repairId), auditsBefore);
		} finally {
			repeated.close();
		}
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("schema 17 migration rejects invalid successor evidence before mutation", () => {
	const cases: Array<{ name: string; mutate: (database: NonNullable<ReturnType<typeof openExecutionDatabase>>, episodeId: string, repairId: string) => void }> = [
		{
			name: "missing current episode",
			mutate: (database) => database.prepare("UPDATE manager_integration_repairs SET current_episode_id = 'bad-episode-id' WHERE repair_id = ?").run("schema17-invalid"),
		},
		{
			name: "mismatched episode evidence",
			mutate: (database, episodeId) => database.prepare("UPDATE manager_integration_repair_episodes SET integration_tree = ? WHERE episode_id = ?").run("0".repeat(40), episodeId),
		},
		{
			name: "conflicting successor request hash",
			mutate: (database) => database.prepare("UPDATE manager_integration_repairs SET successor_request_sha256 = ? WHERE repair_id = ?").run("b".repeat(64), "schema17-invalid"),
		},
		{
			name: "successor repair lineage mismatch",
			mutate: (database) => { database.prepare("UPDATE manager_verifications SET repair_id = 'other-repair' WHERE request_id = 'schema17-invalid-r1'").run(); },
		},
	];
	for (const fixtureCase of cases) {
		const fixture = selectedSuccessorMigrationFixture();
		try {
			const database = openExecutionDatabase(fixture.planDirectory, { create: true })!;
			database.prepare("UPDATE manager_integration_repairs SET classification = NULL, state = 'failed', operation_id = NULL, operation_payload_sha256 = NULL WHERE repair_id = ?").run(fixture.repairId);
			fixtureCase.mutate(database, fixture.episodeId, fixture.repairId);
			const beforeRepair = database.prepare("SELECT * FROM manager_integration_repairs WHERE repair_id = ?").get(fixture.repairId);
			const beforeEpisodes = database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE repair_id = ? ORDER BY episode_id").all(fixture.repairId);
			const beforeAudits = database.prepare("SELECT * FROM manager_integration_repair_audits WHERE repair_id = ? ORDER BY audit_id").all(fixture.repairId);
			database.exec("PRAGMA user_version = 16;");
			database.close();

			assert.throws(() => new RunStore(fixture.planDirectory), /Cannot migrate integration repair/, fixtureCase.name);
			const unchanged = openExecutionDatabase(fixture.planDirectory, { readOnly: true })!;
			try {
				assert.equal(Number((unchanged.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 16);
				assert.deepEqual(unchanged.prepare("SELECT * FROM manager_integration_repairs WHERE repair_id = ?").get(fixture.repairId), beforeRepair, fixtureCase.name);
				assert.deepEqual(unchanged.prepare("SELECT * FROM manager_integration_repair_episodes WHERE repair_id = ? ORDER BY episode_id").all(fixture.repairId), beforeEpisodes, fixtureCase.name);
				assert.deepEqual(unchanged.prepare("SELECT * FROM manager_integration_repair_audits WHERE repair_id = ? ORDER BY audit_id").all(fixture.repairId), beforeAudits, fixtureCase.name);
			} finally {
				unchanged.close();
			}
		} finally {
			fs.rmSync(fixture.planDirectory, { recursive: true, force: true });
		}
	}
});

test("schema 14 migration retains the finish operation while a successor verifies", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-repair-migration-operation-"));
	try {
		repairInput(planDirectory);
		const store = new RunStore(planDirectory);
		const head = "c".repeat(40);
		const tree = "d".repeat(40);
		const successorHead = "e".repeat(40);
		const successorTree = "f".repeat(40);
		const repairId = "migration-inflight";
		const makeRequest = (requestId: string, requestSha256: string, integrationHead: string, integrationTree: string, predecessorRequestId?: string): VerificationRequest => ({
			schemaVersion: 1,
			requestId,
			requestSha256,
			runId: "repair-run",
			generation: 1,
			graphSha256: "a".repeat(64),
			runAssignmentPath: "/repo/run-assignment.json",
			runAssignmentSha256: "b".repeat(64),
			integrationBranch: "herder/repair/integration",
			integrationWorktree: "/repo/.herder-integration",
			integrationHead,
			integrationTree,
			requestedAt: "2026-08-15T00:00:00.000Z",
			...(predecessorRequestId ? { predecessorRequestId } : {}),
			repairId,
			repairRound: 1,
		});
		const makeManifest = (request: VerificationRequest): VerificationManifest => ({
			schemaVersion: 1,
			requestId: request.requestId,
			requestSha256: request.requestSha256,
			runId: request.runId,
			generation: request.generation,
			graphSha256: request.graphSha256,
			runAssignmentSha256: request.runAssignmentSha256,
			integrationHead: request.integrationHead,
			integrationTree: request.integrationTree,
			rationale: "in-flight migration fixture",
			gates: [gate],
			...(request.predecessorRequestId ? { predecessorRequestId: request.predecessorRequestId } : {}),
			repairId,
			repairRound: 1,
		});
		const initialRequest = makeRequest("migration-inflight-r0", "1".repeat(64), head, tree);
		const initialManifest = makeManifest(initialRequest);
		store.putVerificationRequest(initialRequest);
		store.startVerification(initialRequest.requestId, initialManifest, sha256(stableJson(initialManifest)));
		store.finishVerification(initialRequest.requestId, "failed", { passed: false }, "failed");
		const operationId = "migration-inflight-finish";
		const operationPayloadSha256 = sha256("migration-inflight-payload");
		store.putIntegrationRepair({
			repairId,
			runId: "repair-run",
			generation: 1,
			requestId: initialRequest.requestId,
			requestSha256: initialRequest.requestSha256,
			ownerSessionId: "main-session",
			capabilityDigest: integrationRepairCapabilityDigest("2".repeat(64)),
			classification: "code_defect",
			state: "verifying",
			parentCommit: head,
			currentTree: tree,
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
			operationId,
			operationPayloadSha256,
		});
		const successorRequest = makeRequest("migration-inflight-r1", "3".repeat(64), successorHead, successorTree, initialRequest.requestId);
		const successorManifest = makeManifest(successorRequest);
		store.putVerificationRequest(successorRequest);
		store.startVerification(successorRequest.requestId, successorManifest, sha256(stableJson(successorManifest)));
		const successorManifestSha256 = sha256(stableJson(successorManifest));
		store.database.prepare(`
			UPDATE manager_integration_repairs SET state = 'verifying', successor_request_id = ?, successor_request_sha256 = ?,
				successor_manifest_json = ?, successor_manifest_sha256 = ?, current_episode_id = NULL
			WHERE repair_id = ?
		`).run(successorRequest.requestId, successorRequest.requestSha256, JSON.stringify(successorManifest), successorManifestSha256, repairId);
		assert.equal(store.getIntegrationRepair(repairId)?.operationId, operationId);
		assert.equal(store.getVerificationByRequestId(successorRequest.requestId)?.state, "running");
		store.database.exec("DELETE FROM manager_integration_repair_episodes; PRAGMA user_version = 14;");
		store.close();

		const migrated = new RunStore(planDirectory);
		try {
			const repair = migrated.getIntegrationRepair(repairId)!;
			assert.equal(repair.operationId, operationId);
			assert.equal(repair.operationPayloadSha256, operationPayloadSha256);
			assert.equal(repair.state, "verifying");
			assert.equal(repair.requestId, initialRequest.requestId);
			const episodes = migrated.getIntegrationRepairEpisodes(repairId);
			assert.equal(episodes.length, 1);
			assert.equal(episodes[0]!.operationId, operationId);
			assert.equal(episodes[0]!.closedAt, null);
		} finally {
			migrated.close();
		}

		const repeated = new RunStore(planDirectory);
		try {
			const repair = repeated.getIntegrationRepair(repairId)!;
			assert.equal(repair.operationId, operationId);
			assert.equal(repair.operationPayloadSha256, operationPayloadSha256);
		} finally {
			repeated.close();
		}
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});
