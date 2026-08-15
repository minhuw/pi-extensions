import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeIntegrationRepairGates } from "../../../src/core/verification.ts";
import { EXECUTION_SCHEMA_VERSION, openExecutionDatabase } from "../../../src/daemon/execution-store.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { integrationRepairCapabilityDigest, integrationRepairCapabilityToken, sha256, stableJson, type VerificationGate } from "../../../src/shared/protocol.ts";

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
		const codeSuccessor = insertVerification(codeRequest1);
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
		setLegacySuccessor.run(codeRequest1.requestId, codeRequest1.requestSha256, JSON.stringify(codeSuccessor.manifest), codeSuccessor.manifestSha256, codeRepairId);
		setLegacySuccessor.run(transientRequest1.requestId, transientRequest1.requestSha256, JSON.stringify(transientSuccessor.manifest), transientSuccessor.manifestSha256, transientRepairId);
		const insertAudit = store.database.prepare(`
			INSERT INTO manager_integration_repair_audits (repair_id, operation_id, action, payload_sha256, evidence_json, created_at, episode_id)
			VALUES (?, ?, ?, ?, ?, ?, NULL)
		`);
		for (const [repairId, request, classification, headValue, treeValue] of [
			[codeRepairId, codeRequest0, "code_defect", codeHead, codeTree],
			[transientRepairId, transientRequest0, "transient", head, tree],
		] as const) {
			insertAudit.run(repairId, `${repairId}-begin`, "begin", "1".repeat(64), JSON.stringify({ operation: "begin", requestId: request.requestId, requestSha256: request.requestSha256, classification }), now);
			insertAudit.run(repairId, `${repairId}-finish`, "finish-intent", "2".repeat(64), JSON.stringify({ operation: "finish", requestId: request.requestId, requestSha256: request.requestSha256 }), now);
			insertAudit.run(repairId, `${repairId}-finish`, "commit", "2".repeat(64), JSON.stringify({ head: headValue, tree: treeValue, parent: head, supersededCommits: [] }), now);
			insertAudit.run(repairId, `${repairId}-finish`, "successor", "2".repeat(64), JSON.stringify({ requestId: `${request.requestId.slice(0, -2)}r1` }), now);
		}
		store.database.exec("DELETE FROM manager_integration_repair_episodes; PRAGMA user_version = 14;");
		store.close();

		const migrated = new RunStore(planDirectory);
		try {
			const migratedCode = migrated.getIntegrationRepair(codeRepair.repairId)!;
			assert.equal(migratedCode.requestId, codeRequest1.requestId);
			assert.equal(migratedCode.classification, null);
			assert.equal(migratedCode.acceptedCodeRounds, 1);
			const codeEpisodes = migrated.getIntegrationRepairEpisodes(codeRepair.repairId);
			assert.equal(codeEpisodes.length, 2);
			assert.equal(codeEpisodes[0]!.classification, "code_defect");
			assert.equal(codeEpisodes[0]!.closedAt !== null, true);
			assert.equal(codeEpisodes[1]!.requestId, codeRequest1.requestId);
			assert.equal(codeEpisodes[1]!.classification, null);

			const migratedTransient = migrated.getIntegrationRepair(transientRepair.repairId)!;
			assert.equal(migratedTransient.requestId, transientRequest1.requestId);
			assert.equal(migratedTransient.transientRetryUsed, true);
			assert.equal(migratedTransient.acceptedCodeRounds, 0);
			const transientEpisodes = migrated.getIntegrationRepairEpisodes(transientRepair.repairId);
			assert.equal(transientEpisodes[0]!.transientUsed, true);
			assert.equal(transientEpisodes[1]!.classification, null);
			const auditEpisodes = migrated.getIntegrationRepairAudits(codeRepair.repairId).map((audit) => audit.episodeId);
			assert.equal(auditEpisodes.every((episodeId) => episodeId === codeEpisodes[0]!.episodeId), true);
		} finally {
			migrated.close();
		}
		const repeated = new RunStore(planDirectory);
		try {
			assert.equal(repeated.getIntegrationRepairEpisodes(codeRepairId).length, 2);
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
