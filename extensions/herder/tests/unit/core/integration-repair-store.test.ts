import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeIntegrationRepairGates } from "../../../src/core/verification.ts";
import { EXECUTION_SCHEMA_VERSION, openExecutionDatabase } from "../../../src/daemon/execution-store.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { MANAGER_PROTOCOL_VERSION, integrationRepairCapabilityDigest, integrationRepairCapabilityToken, sha256, stableJson, type VerificationGate, type VerificationManifest, type VerificationRequest } from "../../../src/shared/protocol.ts";

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

test("legacy repair operation identity remains replayable while fresh admission is canonical", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-legacy-operation-replay-"));
	try {
		repairInput(planDirectory);
		const payload = { operation: "begin", requestId: "verify-legacy", capabilityTokenSha256: "a".repeat(64) };
		const payloadJson = stableJson(payload);
		const payloadSha256 = sha256(stableJson({ kind: "repair", payload }));
		const repairStore = new RunStore(planDirectory);
		const legacyRepair = repairStore.putIntegrationRepair({
			repairId: "legacy-repair",
			runId: "repair-run",
			generation: 1,
			requestId: payload.requestId,
			requestSha256: "b".repeat(64),
			ownerSessionId: "legacy-session",
			capabilityDigest: "c".repeat(64),
			classification: "code_defect",
			state: "active",
			parentCommit: "d".repeat(40),
			canonicalGates: [gate],
			canonicalGatesSha256: sha256(stableJson([gate])),
		});
		const legacyAudit = repairStore.recordIntegrationRepairAudit(legacyRepair.repairId, "legacy-repair-operation", "begin", payloadSha256, {
			operation: "begin",
			requestId: payload.requestId,
			requestSha256: legacyRepair.requestSha256,
		});
		repairStore.close();
		const seed = openExecutionDatabase(planDirectory, { create: true })!;
		const acceptedAt = "2026-08-15T00:00:00.000Z";
		const updatedAt = "2026-08-15T00:01:00.000Z";
		seed.prepare(`
			INSERT INTO manager_operations (
				operation_id, kind, payload_json, payload_sha256, state, attempt_count,
				result_json, error, accepted_at, started_at, finished_at, updated_at
			) VALUES (?, 'repair', ?, ?, 'succeeded', 1, ?, NULL, ?, ?, ?, ?)
		`).run("legacy-repair-operation", payloadJson, payloadSha256, JSON.stringify({ legacy: true, payloadSha256 }), acceptedAt, acceptedAt, updatedAt, updatedAt);
		seed.close();

		const store = new RunStore(planDirectory);
		assert.equal(Number((store.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), EXECUTION_SCHEMA_VERSION);
		const first = store.replayOperation("legacy-repair-operation", "repair", payload);
		assert.equal(first.kind, "repair");
		assert.equal(first.protocolVersion, MANAGER_PROTOCOL_VERSION);
		assert.equal(first.state, "succeeded");
		assert.deepEqual(first.result, { legacy: true, payloadSha256 });
		const stored = store.database.prepare("SELECT kind, payload_json, payload_sha256, result_json, accepted_at, updated_at FROM manager_operations WHERE operation_id = ?").get("legacy-repair-operation") as Record<string, string>;
		const audits = store.getIntegrationRepairAudits(legacyRepair.repairId);
		assert.deepEqual(audits, [legacyAudit]);
		const replay = store.replayOperation("legacy-repair-operation", "repair", payload);
		assert.deepEqual(replay, first);
		assert.equal(stored.kind, "repair");
		assert.equal(stored.payload_json, payloadJson);
		assert.equal(stored.payload_sha256, first.payloadSha256);
		assert.equal(stored.result_json, JSON.stringify({ legacy: true, payloadSha256 }));
		assert.equal(stored.accepted_at, first.acceptedAt);
		assert.equal(stored.updated_at, first.updatedAt);
		assert.deepEqual(store.getIntegrationRepairAudits(legacyRepair.repairId), [legacyAudit]);
		assert.throws(() => store.submitOperation("legacy-repair-operation", "integration_repair", payload), /replayed with different payload/);
		assert.throws(() => Reflect.apply(store.submitOperation, store, ["new-legacy-repair-operation", "repair", payload]), /Unknown manager operation kind: repair/);
		assert.equal((store.database.prepare("SELECT COUNT(*) AS count FROM manager_operations").get() as { count: number }).count, 1);
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
		assert.equal((store.getSnapshotEnvelope()?.reply as never as { integrationRepair: { capabilityToken?: string } }).integrationRepair.capabilityToken, token);
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
