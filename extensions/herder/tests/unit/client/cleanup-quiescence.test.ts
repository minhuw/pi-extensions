import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withServiceExclusion, ensureService, stopService } from "../../../src/client/index.ts";
import { openExecutionDatabase } from "../../../src/daemon/execution-store.ts";
import { serviceOwnershipLockPath } from "../../../src/daemon/service-ownership.ts";

function planDirectory(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-cleanup-quiescence-"));
	const planDir = path.join(root, "herder-plans");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(path.join(planDir, "README.md"), "# Herder Plans\n");
	openExecutionDatabase(planDir, { create: true }).close();
	return planDir;
}

test("cleanup exclusion holds startup and daemon ownership through the callback", async () => {
	const planDir = planDirectory();
	try {
		let ownerSeen = false;
		const value = await withServiceExclusion(planDir, () => {
			ownerSeen = existsSync(serviceOwnershipLockPath(planDir));
			const owner = readFileSync(serviceOwnershipLockPath(planDir), "utf8");
			assert.match(owner, /^\d+ cleanup-/);
			return "quiesced";
		});
		assert.equal(value, "quiesced");
		assert.equal(ownerSeen, true);
		assert.equal(existsSync(serviceOwnershipLockPath(planDir)), false);
		assert.equal(existsSync(path.join(planDir, ".herder", "service-start.lock")), false);
	} finally {
		rmSync(path.dirname(planDir), { recursive: true, force: true });
	}
});

test("cleanup exclusion releases safely when deep cleanup deletes the plan directory", async () => {
	const planDir = planDirectory();
	const root = path.dirname(planDir);
	await withServiceExclusion(planDir, () => {
		rmSync(planDir, { recursive: true, force: true });
	});
	assert.equal(existsSync(planDir), false);
	rmSync(root, { recursive: true, force: true });
});

test("cleanup rejects a healthy nonterminal service owner without calling the callback", async () => {
	const planDir = planDirectory();
	try {
		await ensureService(planDir);
		let called = false;
		await assert.rejects(
			() => withServiceExclusion(planDir, () => { called = true; }),
			/terminal run|active/,
		);
		assert.equal(called, false);
	} finally {
		await stopService(planDir).catch(() => {});
		rmSync(path.dirname(planDir), { recursive: true, force: true });
	}
});
