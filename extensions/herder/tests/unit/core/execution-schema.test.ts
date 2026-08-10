import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	clearExecutionRotationMarker,
	EXECUTION_SCHEMA_VERSION,
	executionAuthorityHandoffReady,
	executionDatabasePath,
	executionRotationMarkerIdentity,
	executionRotationMarkerPath,
	openExecutionDatabase,
} from "../../../src/daemon/execution-store.ts";

function tableNames(database: ReturnType<typeof openExecutionDatabase> & {}) {
	return new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
}

test("execution schema migrates version 6 through durable operations and verification", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-"));
	try {
		const current = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((current.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		current.exec("DROP TABLE manager_plan_edits; PRAGMA user_version = 6;");
		current.close();

		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), 8);
		const tables = tableNames(migrated);
		for (const name of ["manager_plan_edits", "manager_operations", "manager_snapshots", "manager_verifications"]) assert.ok(tables.has(name), name);
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
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), 8);
		const tables = tableNames(migrated);
		for (const name of ["manager_operations", "manager_snapshots", "manager_verifications"]) assert.ok(tables.has(name), name);
		migrated.close();
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
		const lockPath = path.join(runtimeDirectory, "rotation-epoch.lock");
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
