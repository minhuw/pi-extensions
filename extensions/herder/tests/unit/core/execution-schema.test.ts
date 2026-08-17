import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReigniteRequest } from "../../../src/core/verification.ts";
import {
	clearExecutionRotationMarker,
	EXECUTION_SCHEMA_VERSION,
	executionAuthorityHandoffReady,
	executionDatabasePath,
	executionReport,
	readManagerState,
	readUsageState,
	recordUsageRecord,
	executionRotationMarkerIdentity,
	executionRotationMarkerPath,
	openExecutionDatabase,
} from "../../../src/daemon/execution-store.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";

function tableNames(database: ReturnType<typeof openExecutionDatabase> & {}) {
	return new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
}

function seedManagerRun(
	database: NonNullable<ReturnType<typeof openExecutionDatabase>>,
	runId = "run-reignite",
): void {
	const now = "2026-08-13T00:00:00.000Z";
	database.prepare(`
		INSERT INTO manager_runs (
			run_id, repository_root, plan_directory, plan_name, host, profile_name, profile_sha256,
			max_parallel, current_generation, graph_sha256, status, checkout_state_token, base_commit,
			integration_branch, integration_worktree, dashboard_url, terminal_detail, created_at, updated_at
		) VALUES (?, '/repo', '/repo/herder-plans', 'herder-plans', 'pi', 'eclipse', ?, 1, 1, ?, 'complete', 'token', 'abc', 'herder/example/integration', '/repo/.herder-integration', NULL, NULL, ?, ?)
	`).run(runId, "a".repeat(64), "b".repeat(64), now, now);
}

test("legacy forwarded_url is ignored by service projections and cleared on write", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-service-"));
	try {
		const seeded = openExecutionDatabase(planDirectory, { create: true });
		seeded.prepare(`
			INSERT INTO manager_service (
				singleton, instance_id, pid, port, auth_token, dashboard_url, forwarded_url, started_at
			) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			"legacy-instance", process.pid, 43123, "legacy-token", "http://127.0.0.1:43123/",
			"https://legacy-forwarded.example.invalid/", "2026-08-10T00:00:00.000Z",
		);
		assert.equal(Number((seeded.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		seeded.close();

		const legacyStore = new RunStore(planDirectory);
		const service = legacyStore.getService();
		legacyStore.close();
		assert.ok(service);
		assert.equal(Object.hasOwn(service, "forwardedUrl"), false);
		assert.equal(service.dashboardUrl, "http://127.0.0.1:43123/");

		const projection = readManagerState(planDirectory).service;
		assert.ok(projection);
		assert.equal(Object.hasOwn(projection, "forwardedUrl"), false);
		assert.equal(projection.dashboardUrl, "http://127.0.0.1:43123/");

		const replacementStore = new RunStore(planDirectory);
		replacementStore.putService({ ...service, instanceId: "replacement-instance" });
		replacementStore.close();

		const written = openExecutionDatabase(planDirectory, { create: true });
		const row = written.prepare("SELECT forwarded_url FROM manager_service WHERE singleton = 1").get() as Record<string, unknown>;
		assert.equal(row.forwarded_url, null);
		assert.equal(Number((written.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		written.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("execution schema migrates version 6 through durable operations, verification, and attention", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-"));
	try {
		const current = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((current.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		current.exec("DROP TABLE manager_plan_edits; PRAGMA user_version = 6;");
		current.close();

		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		const tables = tableNames(migrated);
		for (const name of ["manager_plan_edits", "manager_operations", "manager_snapshots", "manager_verifications", "manager_attention_requests", "manager_reignite_requests"]) assert.ok(tables.has(name), name);
		migrated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("execution schema migrates version 7 without rebuilding existing run tables", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-v7-"));
	try {
		const current = openExecutionDatabase(planDirectory, { create: true });
		current.exec("DROP TABLE manager_verifications; DROP TABLE manager_snapshots; DROP TABLE manager_operations; PRAGMA user_version = 7;");
		current.close();
		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		const tables = tableNames(migrated);
		for (const name of ["manager_operations", "manager_snapshots", "manager_verifications", "manager_attention_requests", "manager_reignite_requests"]) assert.ok(tables.has(name), name);
		migrated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("execution schema migrates version 9 nested usage storage", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-v9-"));
	try {
		const current = openExecutionDatabase(planDirectory, { create: true });
		current.exec("ALTER TABLE attempts DROP COLUMN nested_usage_json; PRAGMA user_version = 9;");
		current.close();
		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		const columns = (migrated.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>).map((row) => row.name);
		assert.ok(columns.includes("nested_usage_json"));
		migrated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("execution schema migrates version 10 reignite storage and preserves verification rows", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-v10-"));
	try {
		const current = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((current.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		seedManagerRun(current);
		const now = "2026-08-13T00:00:00.000Z";
		current.prepare(`
			INSERT INTO manager_verifications (
				request_id, run_id, generation, graph_sha256, run_assignment_path, run_assignment_sha256,
				integration_branch, integration_worktree, integration_head, integration_tree, request_sha256,
				state, manifest_json, manifest_sha256, result_json, terminal_detail, created_at, updated_at
			) VALUES (?, 'run-reignite', 1, ?, '/repo/assignment.json', ?, 'herder/example/integration', '/repo/.herder-integration', ?, ?, ?, 'passed', NULL, NULL, NULL, NULL, ?, ?)
		`).run(
			"verify-1",
			"b".repeat(64),
			"c".repeat(64),
			"d".repeat(40),
			"e".repeat(40),
			"f".repeat(64),
			now,
			now,
		);
		current.exec("DROP TABLE manager_reignite_requests; PRAGMA user_version = 10;");
		current.close();

		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		assert.ok(tableNames(migrated).has("manager_reignite_requests"));
		const verification = migrated.prepare("SELECT request_id, state FROM manager_verifications WHERE request_id = 'verify-1'").get() as Record<string, unknown>;
		assert.equal(verification.request_id, "verify-1");
		assert.equal(verification.state, "passed");
		migrated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("execution schema migrates version 11 reignite allocation columns", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-v11-"));
	try {
		const current = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((current.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		current.exec(`
			CREATE TABLE manager_reignite_requests_v11 (
				request_id TEXT PRIMARY KEY NOT NULL,
				run_id TEXT NOT NULL,
				generation INTEGER NOT NULL,
				request_sha256 TEXT NOT NULL UNIQUE,
				source_plan_directory TEXT NOT NULL,
				graph_sha256 TEXT NOT NULL,
				integration_head TEXT NOT NULL,
				integration_tree TEXT NOT NULL,
				integration_branch TEXT NOT NULL,
				verdict TEXT NOT NULL,
				scope TEXT NOT NULL,
				findings_json TEXT NOT NULL,
				fix_guidance_json TEXT NOT NULL,
				rationale TEXT NOT NULL,
				state TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
		`);
		current.exec("DROP TABLE manager_reignite_requests;");
		current.exec("ALTER TABLE manager_reignite_requests_v11 RENAME TO manager_reignite_requests;");
		current.exec("PRAGMA user_version = 11;");
		current.close();

		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		const columns = (migrated.prepare("PRAGMA table_info(manager_reignite_requests)").all() as Array<{ name: string }>).map((row) => row.name);
		assert.ok(columns.includes("allocated_plan_directory"));
		assert.ok(columns.includes("detail"));
		migrated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("schema 17 attention rows migrate to schema 18 without losing evidence or sequence", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-v17-attention-"));
	try {
		const database = openExecutionDatabase(planDirectory, { create: true });
		seedManagerRun(database, "run-attention");
		const insert = database.prepare(`INSERT INTO manager_attention_requests (
			sequence, request_id, run_id, plan_id, generation, round_number, action_id, request_sha256,
			kind, state, cause, detail, detail_sha256, continuation_role, continuation_phase,
			question, recommended_action, recovery_json, created_at, updated_at, resolved_at
		) VALUES (?, ?, 'run-attention', ?, 1, 2, ?, ?, 'operator_attention', ?, 'reviewer_blocked', ?, ?, 'plan-reviewer', 'READY_REVIEWER', ?, ?, ?, ?, ?, ?)`);
		for (const [sequence, state] of [[3, "pending"], [8, "awaiting_input"], [14, "editing"], [21, "resolved"]] as const) {
			const detail = `detail-${sequence}`;
			insert.run(sequence, `attention-${sequence}`, `plan-${sequence}`, `action-${sequence}`, "a".repeat(64), state, detail, "b".repeat(64), `question-${sequence}`, `recommended-${sequence}`, `{"sequence":${sequence}}`, "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z", state === "resolved" ? "2026-08-13T00:00:01.000Z" : null);
		}
		database.exec("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'manager_attention_requests'; PRAGMA user_version = 17;");
		database.close();
		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), 18);
		assert.deepEqual(migrated.prepare("SELECT sequence, request_id, state, recovery_json FROM manager_attention_requests ORDER BY sequence").all().map((row: Record<string, unknown>) => ({ ...row })), [
			{ sequence: 3, request_id: "attention-3", state: "pending", recovery_json: '{"sequence":3}' },
			{ sequence: 8, request_id: "attention-8", state: "awaiting_input", recovery_json: '{"sequence":8}' },
			{ sequence: 14, request_id: "attention-14", state: "editing", recovery_json: '{"sequence":14}' },
			{ sequence: 21, request_id: "attention-21", state: "resolved", recovery_json: '{"sequence":21}' },
		]);
		const sql = String((migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'manager_attention_requests'").get() as Record<string, unknown>).sql);
		assert.ok(sql.includes("state IN ('pending', 'awaiting_input', 'editing', 'resolved')"));
		assert.equal((migrated.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name IN ('manager_attention_requests_run_state', 'manager_attention_requests_unresolved_identity')").get() as Record<string, unknown>).count, 2);
		const next = migrated.prepare(`INSERT INTO manager_attention_requests (request_id, run_id, plan_id, generation, round_number, request_sha256, kind, state, cause, detail, detail_sha256, continuation_role, continuation_phase, created_at, updated_at) VALUES ('attention-next', 'run-attention', 'plan-next', 1, 1, 'c', 'operator_attention', 'pending', 'transport_exhausted', 'd', 'e', 'plan-reviewer', 'READY_REVIEWER', 'now', 'now')`).run();
		assert.equal(next.lastInsertRowid, 101);
		migrated.close();
		const repeated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((repeated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), 18);
		repeated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("schema 17 delegated attention rows fail closed without mutation", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-v17-delegated-"));
	try {
		const database = openExecutionDatabase(planDirectory, { create: true });
		seedManagerRun(database, "run-delegated");
		database.exec(`
			DROP INDEX manager_attention_requests_run_state;
			DROP INDEX manager_attention_requests_unresolved_identity;
			ALTER TABLE manager_attention_requests RENAME TO manager_attention_requests_v17;
			CREATE TABLE manager_attention_requests (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				request_id TEXT NOT NULL UNIQUE,
				run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
				plan_id TEXT NOT NULL,
				generation INTEGER NOT NULL CHECK (generation > 0),
				round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 6),
				action_id TEXT,
				request_sha256 TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('plan_recovery', 'user_decision', 'operator_attention')),
				state TEXT NOT NULL CHECK (state IN ('pending', 'delegated', 'awaiting_input', 'editing', 'resolved')),
				cause TEXT NOT NULL,
				detail TEXT NOT NULL,
				detail_sha256 TEXT NOT NULL,
				continuation_role TEXT NOT NULL,
				continuation_phase TEXT NOT NULL,
				question TEXT,
				recommended_action TEXT,
				recovery_json TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				resolved_at TEXT
			);
			CREATE INDEX manager_attention_requests_run_state ON manager_attention_requests(run_id, state, plan_id, sequence);
			CREATE UNIQUE INDEX manager_attention_requests_unresolved_identity ON manager_attention_requests(run_id, plan_id, generation, cause) WHERE state <> 'resolved';
			DROP TABLE manager_attention_requests_v17;
		`);
		database.prepare(`INSERT INTO manager_attention_requests (sequence, request_id, run_id, plan_id, generation, round_number, request_sha256, kind, state, cause, detail, detail_sha256, continuation_role, continuation_phase, created_at, updated_at) VALUES (9, 'delegated-attention', 'run-delegated', 'plan-1', 1, 1, 'a', 'operator_attention', 'delegated', 'reviewer_blocked', 'detail', 'b', 'plan-reviewer', 'READY_REVIEWER', 'now', 'now')`).run();
		database.exec("PRAGMA user_version = 17;");
		const beforeSql = (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'manager_attention_requests'").get() as Record<string, unknown>).sql;
		database.close();
		assert.throws(() => openExecutionDatabase(planDirectory, { create: true }), /Unsupported persisted attention state 'delegated'/);
		assert.throws(() => openExecutionDatabase(planDirectory, { create: false, readOnly: true }), /Execution database schema 17 is unsupported/);
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});
test("execution schema migrates version 16 forward idempotently", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-v16-"));
	try {
		const current = openExecutionDatabase(planDirectory, { create: true });
		current.exec("CREATE TABLE migration_probe (value TEXT NOT NULL); INSERT INTO migration_probe VALUES ('preserved'); PRAGMA user_version = 16;");
		current.close();

		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		assert.deepEqual((migrated.prepare("SELECT value FROM migration_probe").all() as Array<{ value: string }>).map((row) => row.value), ["preserved"]);
		migrated.close();

		const repeated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((repeated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		repeated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("reignite requests are put-if-absent per run and generation", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-reignite-put-"));
	try {
		const seeded = openExecutionDatabase(planDirectory, { create: true });
		seedManagerRun(seeded);
		seeded.close();
		const store = new RunStore(planDirectory);
		try {
			const request = createReigniteRequest({
				requestId: "reignite-1",
				runId: "run-reignite",
				generation: 1,
				sourcePlanDirectory: "/repo/herder-plans",
				graphSha256: "b".repeat(64),
				integrationHead: "d".repeat(40),
				integrationTree: "e".repeat(40),
				integrationBranch: "herder/example/integration",
				verdict: "REVISE",
				scope: "PASS",
				findings: ["[fr-1][P1][BLOCKING][PLAN_REQUIREMENT] residual audit finding"],
				fixGuidance: ["Open a sibling follow-up plan set."],
				rationale: "Gates passed; residual work belongs in a new plan set.",
				createdAt: "2026-08-13T00:00:00.000Z",
				state: "pending",
			});
			assert.equal(store.putReigniteRequest(request).requestId, request.requestId);
			assert.equal(store.putReigniteRequest(request).requestSha256, request.requestSha256);
			const conflict = createReigniteRequest({
				requestId: "reignite-2",
				runId: request.runId,
				generation: request.generation,
				sourcePlanDirectory: request.sourcePlanDirectory,
				graphSha256: request.graphSha256,
				integrationHead: request.integrationHead,
				integrationTree: request.integrationTree,
				integrationBranch: request.integrationBranch,
				verdict: request.verdict,
				scope: request.scope,
				findings: ["[fr-2][P1][BLOCKING][PATCH_REGRESSION] different residual"],
				fixGuidance: request.fixGuidance,
				rationale: request.rationale,
				createdAt: "2026-08-13T00:00:01.000Z",
				state: request.state,
			});
			assert.notEqual(conflict.requestSha256, request.requestSha256);
			assert.throws(() => store.putReigniteRequest(conflict), /Reignite request changed for generation 1/);
			assert.equal(store.getReigniteRequest("run-reignite", 1)?.requestId, request.requestId);
		} finally {
			store.close();
		}
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("usage records persist nested model slices and report them separately", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-nested-usage-"));
	try {
		const stored = recordUsageRecord(planDirectory, {
			attempt: "attempt-nested",
			plan: "001",
			role: "plan-implementer",
			model: "gpt-5.6-sol",
			effort: "xhigh",
			outcome: "COMPLETE",
			inputTokens: 100,
			cachedInputTokens: 10,
			outputTokens: 20,
			reasoningTokens: 5,
			source: "herder pi worker session",
			round: 1,
			generation: "generation-1",
			harness: "pi",
			nested: [{
				type: "recon",
				model: "gpt-5.6-luna",
				effort: "max",
				serviceTier: "fast",
				count: 2,
				inputTokens: 40,
				cachedInputTokens: 4,
				outputTokens: 8,
				reasoningTokens: 2,
				durationMs: 1200,
			}],
		});
		assert.equal(stored.recorded, true);
		assert.equal(stored.record.inputTokens, 100);
		assert.deepEqual(stored.record.nestedUsage, [{
			type: "recon",
			model: "gpt-5.6-luna",
			effort: "max",
			serviceTier: "fast",
			count: 2,
			inputTokens: 40,
			cachedInputTokens: 4,
			outputTokens: 8,
			reasoningTokens: 2,
			durationMs: 1200,
		}]);
		const state = readUsageState(planDirectory);
		assert.deepEqual(state.records[0]?.nestedUsage, stored.record.nestedUsage);
		const report = executionReport(state.records);
		assert.equal(report.tokens.reportedInputOutput, 168);
		assert.deepEqual(report.byModel.map((row) => ({ key: row.key, knownTokens: row.knownTokens, attempts: row.attempts })), [
			{ key: "gpt-5.6-luna / max", knownTokens: 48, attempts: 2 },
			{ key: "gpt-5.6-sol / xhigh", knownTokens: 120, attempts: 1 },
		]);
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("execution schema migrates version 8 idempotently and creates attention storage", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-v8-"));
	try {
		const current = openExecutionDatabase(planDirectory, { create: true });
		current.exec("DROP TABLE manager_attention_requests; PRAGMA user_version = 8;");
		current.close();
		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		assert.ok(tableNames(migrated).has("manager_attention_requests"));
		migrated.close();
		const repeated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((repeated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		assert.ok(tableNames(repeated).has("manager_attention_requests"));
		repeated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("writable exposure is repaired and leaves a durable owner-only rotation marker", { skip: process.platform === "win32" }, () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-safety-"));
	try {
		const initial = openExecutionDatabase(planDirectory, { create: true });
		initial.exec("CREATE TABLE safety_probe (value TEXT NOT NULL); INSERT INTO safety_probe VALUES ('preserved');");
		assert.equal(Number((initial.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		initial.close();

		const runtimeDirectory = path.join(planDirectory, ".herder");
		const databasePath = executionDatabasePath(planDirectory);
		const markerPath = executionRotationMarkerPath(planDirectory);
		assert.equal(fs.existsSync(markerPath), false);
		fs.chmodSync(runtimeDirectory, 0o755);
		fs.chmodSync(databasePath, 0o664);

		const repaired = openExecutionDatabase(planDirectory, { create: true });
		assert.deepEqual((repaired.prepare("SELECT value FROM safety_probe").all() as Array<{ value: string }>).map((row) => row.value), ["preserved"]);
		assert.equal(Number((repaired.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		repaired.close();
		assert.equal(fs.statSync(runtimeDirectory).mode & 0o777, 0o700);
		assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
		const marker = fs.lstatSync(markerPath);
		assert.equal(marker.isFile(), true);
		assert.equal(marker.isSymbolicLink(), false);
		assert.equal(marker.mode & 0o777, 0o600);

		const markerContents = fs.readFileSync(markerPath);
		const repeated = openExecutionDatabase(planDirectory, { create: true });
		repeated.close();
		assert.deepEqual(fs.readFileSync(markerPath), markerContents);
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("authority handoff is locked out between runtime privacy repair and marker publication", { skip: process.platform === "win32" }, () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-epoch-gap-"));
	const originalFchmod = fs.fchmodSync;
	try {
		openExecutionDatabase(planDirectory, { create: true }).close();
		const runtimeDirectory = path.join(planDirectory, ".herder");
		const runtimeIdentity = fs.statSync(runtimeDirectory);
		const markerPath = executionRotationMarkerPath(planDirectory);
		const lockPath = path.join(planDirectory, ".rotation-epoch.lock");
		fs.chmodSync(runtimeDirectory, 0o755);
		let observedPrivacyRepair = false;
		fs.fchmodSync = ((descriptor: number, mode: number) => {
			originalFchmod(descriptor, mode);
			const opened = fs.fstatSync(descriptor);
			if (!observedPrivacyRepair
				&& mode === 0o700
				&& opened.isDirectory()
				&& opened.dev === runtimeIdentity.dev
				&& opened.ino === runtimeIdentity.ino) {
				observedPrivacyRepair = true;
				assert.equal(fs.existsSync(markerPath), false, "the interleaving point must precede marker publication");
				assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
				assert.match(fs.readFileSync(lockPath, "utf8"), new RegExp(`^${process.pid}:`));
			}
		}) as typeof fs.fchmodSync;
		openExecutionDatabase(planDirectory, { create: true }).close();
		fs.fchmodSync = originalFchmod;

		assert.equal(observedPrivacyRepair, true);
		assert.equal(fs.existsSync(markerPath), true);
		assert.equal(executionAuthorityHandoffReady(planDirectory), false);
	} finally {
		fs.fchmodSync = originalFchmod;
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("private database replacement publishes only inside the shared authority epoch", { skip: process.platform === "win32" }, () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-private-swap-"));
	const originalLstat = fs.lstatSync;
	const originalOpen = fs.openSync;
	const mutableFs = fs as unknown as { lstatSync: typeof fs.lstatSync };
	const templatePath = path.join(os.tmpdir(), `herder-execution-private-template-${process.pid}-${Date.now()}.sqlite3`);
	try {
		openExecutionDatabase(planDirectory, { create: true }).close();
		const databasePath = executionDatabasePath(planDirectory);
		const markerPath = executionRotationMarkerPath(planDirectory);
		const lockPath = path.join(planDirectory, ".rotation-epoch.lock");
		fs.copyFileSync(databasePath, templatePath);
		let databaseObservations = 0;
		let replaced = false;
		let markerPublishedInsideEpoch = false;
		mutableFs.lstatSync = ((candidate: fs.PathLike) => {
			if (String(candidate) === databasePath) {
				databaseObservations += 1;
				if (!replaced && databaseObservations === 2) {
					fs.unlinkSync(databasePath);
					fs.copyFileSync(templatePath, databasePath);
					fs.chmodSync(databasePath, 0o600);
					replaced = true;
				}
			}
			return originalLstat(candidate);
		}) as typeof fs.lstatSync;
		fs.openSync = ((candidate, flags, mode) => {
			if (String(candidate) === markerPath) {
				assert.equal(fs.existsSync(lockPath), true, "rotation marker publication escaped the shared epoch");
				markerPublishedInsideEpoch = true;
			}
			return originalOpen(candidate, flags, mode);
		}) as typeof fs.openSync;
		openExecutionDatabase(planDirectory, { create: true }).close();
		assert.equal(replaced, true);
		assert.equal(markerPublishedInsideEpoch, true);
		assert.equal(fs.existsSync(markerPath), true);
		assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600);
	} finally {
		mutableFs.lstatSync = originalLstat;
		fs.openSync = originalOpen;
		fs.rmSync(templatePath, { force: true });
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("marker creation secures its parent before a writable repair can unlink it", { skip: process.platform === "win32" }, () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-marker-race-"));
	try {
		const initial = openExecutionDatabase(planDirectory, { create: true });
		initial.close();
		const runtimeDirectory = path.join(planDirectory, ".herder");
		const markerPath = executionRotationMarkerPath(planDirectory);
		fs.chmodSync(runtimeDirectory, 0o777);
		const originalFsync = fs.fsyncSync;
		let removedWhileWritable = false;
		fs.fsyncSync = ((descriptor: number) => {
			originalFsync(descriptor);
			if (!removedWhileWritable && fs.existsSync(markerPath) && (fs.statSync(runtimeDirectory).mode & 0o777) === 0o777) {
				fs.unlinkSync(markerPath);
				removedWhileWritable = true;
			}
		}) as typeof fs.fsyncSync;
		try {
			const repaired = openExecutionDatabase(planDirectory, { create: true });
			repaired.close();
		} finally {
			fs.fsyncSync = originalFsync;
		}
		assert.equal(removedWhileWritable, false);
		assert.equal(fs.statSync(runtimeDirectory).mode & 0o777, 0o700);
		const marker = fs.lstatSync(markerPath);
		assert.equal(marker.isFile(), true);
		assert.equal(marker.isSymbolicLink(), false);
		assert.equal(marker.mode & 0o777, 0o600);
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("failed reservation fsync keeps storage exposed until durable rotation evidence exists", { skip: process.platform === "win32" }, () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-reservation-fsync-"));
	const originalFsync = fs.fsyncSync;
	try {
		openExecutionDatabase(planDirectory, { create: true }).close();
		const databasePath = executionDatabasePath(planDirectory);
		const markerPath = executionRotationMarkerPath(planDirectory);
		fs.chmodSync(databasePath, 0o644);
		let fsyncAttempts = 0;
		fs.fsyncSync = ((descriptor: number) => {
			fsyncAttempts += 1;
			if (fsyncAttempts === 1) {
				const error = new Error("reservation fsync failed") as NodeJS.ErrnoException;
				error.code = "ENOSPC";
				throw error;
			}
			return originalFsync(descriptor);
		}) as typeof fs.fsyncSync;
		assert.throws(() => openExecutionDatabase(planDirectory, { create: true }), /reservation fsync failed/);
		fs.fsyncSync = originalFsync;
		assert.equal(fsyncAttempts, 1);
		assert.equal(fs.statSync(databasePath).mode & 0o777, 0o644);
		assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600);

		// The visible reservation was never directory-synced, so model its loss.
		fs.unlinkSync(markerPath);
		openExecutionDatabase(planDirectory, { create: true }).close();
		assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
		assert.equal(fs.statSync(markerPath).mode & 0o777, 0o600);
	} finally {
		fs.fsyncSync = originalFsync;
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("identity-checked marker clearing preserves a concurrent fresh marker", { skip: process.platform === "win32" }, () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-marker-clear-"));
	try {
		openExecutionDatabase(planDirectory, { create: true }).close();
		const databasePath = executionDatabasePath(planDirectory);
		const markerPath = executionRotationMarkerPath(planDirectory);
		fs.chmodSync(databasePath, 0o644);
		openExecutionDatabase(planDirectory, { create: true }).close();
		const firstIdentity = executionRotationMarkerIdentity(planDirectory);
		assert.ok(firstIdentity);

		const originalRename = fs.renameSync;
		let published = false;
		fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
			if (!published && from === markerPath) {
				published = true;
				const temporaryPath = `${markerPath}.fresh.tmp`;
				fs.writeFileSync(temporaryPath, "fresh-marker");
				fs.chmodSync(temporaryPath, 0o600);
				originalRename(temporaryPath, markerPath);
			}
			return originalRename(from, to);
		}) as typeof fs.renameSync;
		try {
			assert.equal(clearExecutionRotationMarker(planDirectory, firstIdentity), false);
		} finally {
			fs.renameSync = originalRename;
		}

		const remainingIdentity = executionRotationMarkerIdentity(planDirectory);
		assert.ok(remainingIdentity);
		assert.notEqual(remainingIdentity, firstIdentity);
		assert.equal(fs.existsSync(markerPath), true);
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("writable opens canonicalize owner-only database modes without rotating authority", { skip: process.platform === "win32" }, () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-canonical-mode-"));
	try {
		openExecutionDatabase(planDirectory, { create: true }).close();
		const databasePath = executionDatabasePath(planDirectory);
		fs.chmodSync(databasePath, 0o700);
		openExecutionDatabase(planDirectory, { create: true }).close();
		assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
		assert.equal(fs.existsSync(executionRotationMarkerPath(planDirectory)), false);
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("read-only opens reject exposed runtime storage without changing it", { skip: process.platform === "win32" }, () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-read-only-"));
	try {
		const database = openExecutionDatabase(planDirectory, { create: true });
		database.close();
		const runtimeDirectory = path.join(planDirectory, ".herder");
		const databasePath = executionDatabasePath(planDirectory);

		fs.chmodSync(databasePath, 0o644);
		const exposedDatabase = fs.readFileSync(databasePath);
		assert.throws(() => openExecutionDatabase(planDirectory, { readOnly: true }), /owner-only/);
		assert.deepEqual(fs.readFileSync(databasePath), exposedDatabase);
		assert.equal(fs.statSync(databasePath).mode & 0o777, 0o644);

		fs.chmodSync(databasePath, 0o600);
		fs.chmodSync(runtimeDirectory, 0o755);
		const exposedRuntime = fs.readFileSync(databasePath);
		assert.throws(() => openExecutionDatabase(planDirectory, { readOnly: true }), /owner-only/);
		assert.deepEqual(fs.readFileSync(databasePath), exposedRuntime);
		assert.equal(fs.statSync(runtimeDirectory).mode & 0o777, 0o755);
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("database replacement during exposure repair is revalidated and privately repaired", { skip: process.platform === "win32" }, () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-database-swap-"));
	const originalFchmod = fs.fchmodSync;
	try {
		openExecutionDatabase(planDirectory, { create: true }).close();
		const runtimeDirectory = path.join(planDirectory, ".herder");
		const databasePath = executionDatabasePath(planDirectory);
		const templatePath = path.join(os.tmpdir(), `herder-execution-template-${process.pid}.sqlite3`);
		fs.copyFileSync(databasePath, templatePath);
		const runtimeIdentity = fs.statSync(runtimeDirectory);
		let swapped = false;
		fs.chmodSync(runtimeDirectory, 0o777);
		fs.fchmodSync = ((descriptor: number, mode: number) => {
			const opened = fs.fstatSync(descriptor);
			if (!swapped && mode === 0o700 && opened.isDirectory() && opened.dev === runtimeIdentity.dev && opened.ino === runtimeIdentity.ino) {
				swapped = true;
				fs.unlinkSync(databasePath);
				fs.copyFileSync(templatePath, databasePath);
				fs.chmodSync(databasePath, 0o666);
			}
			return originalFchmod(descriptor, mode);
		}) as typeof fs.fchmodSync;
		openExecutionDatabase(planDirectory, { create: true }).close();
		assert.equal(swapped, true);
		assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
		assert.equal(fs.existsSync(executionRotationMarkerPath(planDirectory)), true);
		fs.rmSync(templatePath, { force: true });
	} finally {
		fs.fchmodSync = originalFchmod;
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});
