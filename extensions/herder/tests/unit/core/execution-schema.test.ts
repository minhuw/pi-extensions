import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXECUTION_SCHEMA_VERSION, openExecutionDatabase } from "../../../src/daemon/execution-store.ts";

test("execution schema migrates existing runs to persistent plan edit reservations", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-execution-schema-"));
	try {
		const current = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((current.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), EXECUTION_SCHEMA_VERSION);
		current.exec("DROP TABLE manager_plan_edits; PRAGMA user_version = 6;");
		current.close();

		const migrated = openExecutionDatabase(planDirectory, { create: true });
		assert.equal(Number((migrated.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version), 7);
		assert.equal(
			String((migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_plan_edits'").get() as Record<string, unknown>).name),
			"manager_plan_edits",
		);
		migrated.close();
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});
