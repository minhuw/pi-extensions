import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXECUTION_SCHEMA_VERSION, openExecutionDatabase } from "../../../src/daemon/execution-store.ts";

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
