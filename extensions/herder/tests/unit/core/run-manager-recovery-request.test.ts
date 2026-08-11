import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { attentionRequestSha256, sha256, type AttentionRequestInput } from "../../../src/shared/protocol.ts";

function insertRun(store: RunStore, planDirectory: string): void {
	store.database.prepare(`
		INSERT INTO manager_runs (
			run_id, repository_root, plan_directory, plan_name, host,
			profile_name, profile_sha256, max_parallel, current_generation, graph_sha256,
			status, checkout_state_token, base_commit, integration_branch,
			integration_worktree, dashboard_url, terminal_detail, created_at, updated_at
		) VALUES (?, ?, ?, ?, 'pi', ?, ?, 2, 1, ?, 'running', ?, ?, ?, ?, NULL, NULL, ?, ?)
	`).run(
		"run-1", planDirectory, planDirectory, "plans", "eclipse", "p".repeat(64), "g".repeat(64),
		"checkout", "b".repeat(40), "herder/plans/integration", path.join(planDirectory, "integration"),
		"2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z",
	);
}

function recoveryRequest(planId: string, requestId: string, detail = "The target plan is blocked"): AttentionRequestInput {
	const request = {
		schemaVersion: 1,
		requestId,
		runId: "run-1",
		planId,
		generation: 1,
		round: 2,
		actionId: `${requestId}:action`,
		kind: "plan_recovery",
		state: "pending",
		cause: "reviewer_blocked",
		detail,
		detailSha256: sha256(detail),
		continuation: { role: "plan-reviewer", phase: "READY_REVIEWER" },
		recommendedAction: "Review the target plan",
		recovery: {
			planFingerprint: "f".repeat(64),
			fingerprintVersion: 2,
			planFile: `${planId}-plan.md`,
			inScopePaths: ["src/value.mjs"],
			assignmentPath: "/tmp/assignment.json",
			assignmentSha256: "a".repeat(64),
			snapshotSha256: "b".repeat(64),
			generationBase: "c".repeat(40),
			branch: `herder/plans/${planId}`,
			worktree: `/tmp/worktree/${planId}`,
			worktreeHead: "d".repeat(40),
			worktreeTree: "e".repeat(40),
			changedPaths: ["src/value.mjs"],
		},
		createdAt: "2026-08-11T00:00:00.000Z",
		updatedAt: "2026-08-11T00:00:00.000Z",
	} as AttentionRequestInput;
	return { ...request, requestSha256: attentionRequestSha256(request) } as AttentionRequestInput;
}

test("attention CRUD preserves immutable evidence, deduplicates unresolved causes, and orders by plan", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-attention-store-"));
	const store = new RunStore(planDirectory);
	try {
		insertRun(store, planDirectory);
		const first = store.putAttention(recoveryRequest("002", "attention-002"));
		assert.match(first.requestSha256, /^[0-9a-f]{64}$/);
		const earlier = store.putAttention(recoveryRequest("001", "attention-001"));
		assert.equal(store.getNextAttention("run-1")?.requestId, earlier.requestId);
		assert.equal(store.getAttentionRequests("run-1", { unresolvedOnly: true }).length, 2);

		const replay = store.putAttention(recoveryRequest("001", "attention-replayed", "A different duplicate detail"));
		assert.equal(replay.requestId, earlier.requestId, "one unresolved request is retained for a cause generation");
		assert.equal(store.getAttention("attention-002")?.detail, first.detail);

		store.resolveAttention(earlier.requestId);
		assert.equal(store.getNextAttention("run-1")?.requestId, first.requestId);
		const replacement = store.putAttention(recoveryRequest("001", "attention-001-replacement"));
		assert.equal(store.getAttention(replacement.requestId)?.state, "pending");
		assert.equal(store.getAttentionRequests("run-1").length, 3, "resolved history is retained");

		assert.throws(() => store.putAttention({ ...recoveryRequest("003", "bad"), detailSha256: "0".repeat(64) }), /detail hash/);
		assert.throws(() => store.putAttention({ ...recoveryRequest("003", "bad-hash"), requestSha256: "0".repeat(64) }), /request hash/);
	} finally {
		store.close();
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});
