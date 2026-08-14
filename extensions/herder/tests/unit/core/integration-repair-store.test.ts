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
