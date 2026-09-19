import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { invokeHerderTool } from "../../../src/application/tools.ts";
import { stopService } from "../../../src/client/index.ts";
import { initPlanDir } from "../../../src/core/plans.ts";
import { getExecutionReport } from "../../../src/core/plan-report.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import type { ManagerReply } from "../../../src/shared/protocol.ts";
import { initFixtureRepo } from "../../support/fixture-repo.ts";
import { fixturePlan } from "../../support/plan-v2.ts";

test("application forwards explicit YOLO, reports it, and cannot change it through resume", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-yolo-application-"));
	const { repo, originalHead } = initFixtureRepo(root, { name: "YOLO test", email: "test@example.invalid", files: { "src/value.mjs": "export const value = 1;\n" } });
	const directory = path.join(repo, "herder-plans");
	initPlanDir(directory);
	fs.writeFileSync(path.join(directory, "README.md"), "# Plans\n\n## Execution order & status\n\n| Plan | Title | Priority | Effort | Depends on | Status |\n|---|---|---|---|---|---|\n| [001](001-value.md) | Value | P1 | S | — | TODO |\n\n## Dependency notes\n\nNone.\n\n## Considered and rejected\n\nNone.\n");
	fs.writeFileSync(path.join(directory, "001-value.md"), fixturePlan({ head: originalHead }));
	const args = { repositoryRoot: repo, planDirectory: directory, profile: "eclipse", maxParallel: 1 };
	try {
		const { reply } = await invokeHerderTool("herder_run", { ...args, operation: "fire", yolo: true }) as { reply: ManagerReply };
		assert.equal(reply.yolo, true);
		assert.equal(reply.actions[0]?.role, "plan-implementer");
		assert.equal(getExecutionReport(directory).execution?.reviewMode, "yolo");
		assert.equal(getExecutionReport(directory).lifecycle.complete, false);
		await assert.rejects(invokeHerderTool("herder_run", { ...args, operation: "resume", yolo: false }), /yolo|review mode/i);
		const store = new RunStore(directory, { readOnly: true });
		try { assert.equal(store.getRun()?.yolo, true); } finally { store.close(); }
	} finally {
		await stopService(directory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});
