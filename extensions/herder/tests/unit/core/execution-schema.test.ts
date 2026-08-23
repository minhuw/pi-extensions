import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createReigniteRequest } from "../../../src/core/verification.ts";
import {
	clearExecutionRotationMarker,
	EXECUTION_SCHEMA_VERSION,
	executionAuthorityHandoffReady,
	executionDatabasePath,
	executionReport,
	readUsageState,
	recordUsageRecord,
	executionRotationMarkerIdentity,
	executionRotationMarkerPath,
	openExecutionDatabase,
} from "../../../src/daemon/execution-store.ts";
import { readManagerState } from "../../../src/daemon/run-store.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";

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

test("unsupported pre-18 execution schemas fail closed without mutation", () => {
	for (const version of [6, 13, 17]) {
		const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `herder-execution-schema-unsupported-${version}-`));
		try {
			const seeded = openExecutionDatabase(planDirectory, { create: true });
			seeded.exec(`PRAGMA user_version = ${version};`);
			seeded.close();

			const unsupported = new RegExp(`Execution database schema ${version} is unsupported; Herder ${EXECUTION_SCHEMA_VERSION} requires a fresh run database`);
			const readVersion = () => {
				const database = new DatabaseSync(executionDatabasePath(planDirectory), { readOnly: true });
				try {
					return Number((database.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version);
				} finally {
					database.close();
				}
			};

			assert.throws(() => openExecutionDatabase(planDirectory, { create: true }), unsupported);
			assert.equal(readVersion(), version);
			assert.throws(() => openExecutionDatabase(planDirectory, { create: false, readOnly: true }), unsupported);
			assert.equal(readVersion(), version);
		} finally {
			fs.rmSync(planDirectory, { recursive: true, force: true });
		}
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
