import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HerderRunManager } from "../../../src/core/run-manager.ts";
import { RunStore, type StoredPlan } from "../../../src/daemon/run-store.ts";
import {
	ATTENTION_PATH_LIMIT,
	attentionRequestSha256,
	sha256,
	stableJson,
	type AttentionCause,
	type AttentionContinuation,
	type AttentionRequestInput,
} from "../../../src/shared/protocol.ts";

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

function inputPlan(runId: string, planId: string): Omit<StoredPlan, "updatedAt"> {
	return {
		runId,
		planId,
		generation: 1,
		round: 2,
		phase: "NEEDS_INPUT",
		branch: `herder/plans/${planId}`,
		worktree: `/tmp/worktree/${planId}`,
		assignmentPath: "/tmp/assignment.json",
		assignmentSha256: "a".repeat(64),
		snapshotSha256: "b".repeat(64),
		generationBase: "c".repeat(40),
		reviewPass: 0,
		findings: [],
		repair: [],
		gates: [],
		approvedBase: null,
		approvedHead: null,
		approvedTree: null,
		rebase: null,
	};
}

function userDecisionRequest(planId: string, requestId: string, detail = "The Judge needs a decision"): AttentionRequestInput {
	const request = {
		schemaVersion: 1,
		requestId,
		runId: "run-1",
		planId,
		generation: 1,
		round: 2,
		actionId: `${requestId}:action`,
		kind: "user_decision",
		state: "awaiting_input",
		cause: "judge_needs_input",
		detail,
		detailSha256: sha256(detail),
		continuation: { role: "plan-judge", phase: "READY_JUDGE" },
		question: "Which recorded decision should the Judge use?",
		recommendedAction: "Answer the Judge question.",
		createdAt: "2026-08-11T00:00:00.000Z",
		updatedAt: "2026-08-11T00:00:00.000Z",
	} as AttentionRequestInput;
	return { ...request, requestSha256: attentionRequestSha256(request) } as AttentionRequestInput;
}

function applyUserInput(manager: HerderRunManager, value: string, eventId: string, attentionRequestId?: string): void {
	(manager as unknown as { applyUserInput: (value: string, eventId: string, attentionRequestId?: string) => void })
		.applyUserInput(value, eventId, attentionRequestId);
}

function recoveryRequest(
	planId: string,
	requestId: string,
	detail = "The target plan is blocked",
	cause: AttentionCause = "reviewer_blocked",
	continuation: AttentionContinuation = { role: "plan-reviewer", phase: "READY_REVIEWER" },
): AttentionRequestInput {
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
		cause,
		detail,
		detailSha256: sha256(detail),
		continuation,
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

test("resolution replay hashes the action that committed after an earlier defer", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-attention-resolution-hash-"));
	const store = new RunStore(planDirectory);
	try {
		const defer = {
			eventId: "attention-defer",
			kind: "attention",
			attention: { requestId: "request-1", action: "defer" },
		};
		const answer = {
			eventId: "attention-answer",
			kind: "attention",
			attention: { requestId: "request-1", action: "answer", answer: "Use the recorded evidence." },
		};
		store.submitOperation("operation-defer", "event", defer);
		store.submitOperation("operation-answer", "event", answer);
		assert.equal(store.claimNextOperation()?.operationId, "operation-defer");
		store.completeOperation("operation-defer", {});
		assert.equal(store.claimNextOperation()?.operationId, "operation-answer");
		store.completeOperation("operation-answer", {});
		assert.equal(store.getAttentionResolutionHash("request-1"), sha256(stableJson(answer.attention)));
	} finally {
		store.close();
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

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
		const conflict = store.putAttention(recoveryRequest(
			"003",
			"attention-conflict",
			"Integration conflict recovery is exhausted",
			"integration_conflict_exhausted",
			{ role: "plan-implementer", phase: "READY_IMPLEMENTER" },
		));
		assert.equal(conflict.kind, "plan_recovery");
		assert.equal(conflict.cause, "integration_conflict_exhausted");
		assert.deepEqual(conflict.continuation, { role: "plan-implementer", phase: "READY_IMPLEMENTER" });
		assert.equal(store.getAttentionRequests("run-1", { unresolvedOnly: true }).filter((candidate) => candidate.cause === "integration_conflict_exhausted").length, 1);

		const replay = store.putAttention(recoveryRequest("001", "attention-replayed", "A different duplicate detail"));
		assert.equal(replay.requestId, earlier.requestId, "one unresolved request is retained for a cause generation");
		assert.equal(store.getAttention("attention-002")?.detail, first.detail);

		store.resolveAttention(earlier.requestId);
		assert.equal(store.getNextAttention("run-1")?.requestId, first.requestId);
		const replacement = store.putAttention(recoveryRequest("001", "attention-001-replacement"));
		assert.equal(store.getAttention(replacement.requestId)?.state, "pending");
		assert.equal(store.getAttentionRequests("run-1").length, 4, "resolved history is retained");

		assert.throws(() => store.putAttention({ ...recoveryRequest("003", "bad"), detailSha256: "0".repeat(64) }), /detail hash/);
		assert.throws(() => store.putAttention({ ...recoveryRequest("003", "bad-hash"), requestSha256: "0".repeat(64) }), /request hash/);
	} finally {
		store.close();
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("oversized recovery path evidence persists as a bounded hashed dossier", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-attention-path-evidence-"));
	const store = new RunStore(planDirectory);
	try {
		insertRun(store, planDirectory);
		const base = recoveryRequest("001", "attention-oversized") as Extract<AttentionRequestInput, { kind: "plan_recovery" }>;
		const completeInScopePaths = Array.from({ length: ATTENTION_PATH_LIMIT + 1 }, (_, index) => `src/path-${index}.mjs`);
		const completeChangedPaths = Array.from({ length: ATTENTION_PATH_LIMIT + 1 }, (_, index) => `test/path-${index}.mjs`);
		const recovery = {
			...base.recovery,
			inScopePaths: completeInScopePaths.slice(0, ATTENTION_PATH_LIMIT),
			inScopePathCount: completeInScopePaths.length,
			inScopePathsSha256: sha256(stableJson(completeInScopePaths)),
			changedPaths: completeChangedPaths.slice(0, ATTENTION_PATH_LIMIT),
			changedPathCount: completeChangedPaths.length,
			changedPathsSha256: sha256(stableJson(completeChangedPaths)),
		};
		const body = { ...base, recovery } as AttentionRequestInput;
		const stored = store.putAttention({ ...body, requestSha256: attentionRequestSha256(body) } as AttentionRequestInput);
		if (stored.kind !== "plan_recovery") throw new Error("expected a plan-recovery request");
		assert.equal(stored.recovery.inScopePaths.length, ATTENTION_PATH_LIMIT);
		assert.equal(stored.recovery?.inScopePathCount, completeInScopePaths.length);
		assert.equal(stored.recovery?.changedPaths.length, ATTENTION_PATH_LIMIT);
		assert.equal(stored.recovery?.changedPathCount, completeChangedPaths.length);
		assert.equal(stored.recovery?.inScopePathsSha256, sha256(stableJson(completeInScopePaths)));
		assert.equal(stored.recovery?.changedPathsSha256, sha256(stableJson(completeChangedPaths)));
	} finally {
		store.close();
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("input routing skips record-only recovery dossiers and preserves public answer compatibility", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-attention-input-"));
	const store = new RunStore(planDirectory);
	try {
		insertRun(store, planDirectory);
		store.updateRun({ status: "needs_input", terminalDetail: "A Judge needs input" });
		store.putPlan(inputPlan("run-1", "002"));
		const recovery = store.putAttention(recoveryRequest("001", "attention-recovery"));
		const decision = store.putAttention(userDecisionRequest("002", "attention-decision"));
		assert.equal(store.getNextAttention("run-1")?.requestId, recovery.requestId);
		assert.equal(store.getNextInputAttention("run-1")?.requestId, decision.requestId);

		const manager = new HerderRunManager(planDirectory);
		try {
			assert.throws(() => applyUserInput(manager, "not a recovery answer", "recovery-answer", recovery.requestId), /does not accept user input/);
			applyUserInput(manager, "Use the recorded decision", "decision-answer", decision.requestId);
			assert.equal(manager.store.getPlan("run-1", "002")?.phase, "READY_JUDGE");
			assert.equal(manager.store.getAttention(decision.requestId)?.state, "resolved");
			assert.equal(manager.store.getAttention(recovery.requestId)?.state, "pending");
			assert.equal(manager.store.getRun()?.status, "running");
		} finally {
			manager.close();
		}
	} finally {
		store.close();
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("missing attention IDs are rejected before any request can be selected", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-attention-compat-"));
	const store = new RunStore(planDirectory);
	try {
		insertRun(store, planDirectory);
		store.updateRun({ status: "needs_input", terminalDetail: "A Judge needs input" });
		store.putPlan(inputPlan("run-1", "001"));
		const decision = store.putAttention(userDecisionRequest("001", "attention-compat"));
		const manager = new HerderRunManager(planDirectory);
		try {
			assert.throws(() => applyUserInput(manager, "Answer without a binding", "compat-answer"), /requires an attention request ID/);
			assert.equal(manager.store.getAttention(decision.requestId)?.state, "awaiting_input");
			assert.deepEqual(manager.store.getPlan("run-1", "001")?.repair, []);
		} finally {
			manager.close();
		}
	} finally {
		store.close();
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("unbound answers with different text cannot advance either attention request", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-attention-unbound-replay-"));
	const store = new RunStore(planDirectory);
	try {
		insertRun(store, planDirectory);
		store.updateRun({ status: "needs_input", terminalDetail: "Two Judges need input" });
		store.putPlan(inputPlan("run-1", "001"));
		store.putPlan(inputPlan("run-1", "002"));
		const first = store.putAttention(userDecisionRequest("001", "attention-unbound-first"));
		const second = store.putAttention(userDecisionRequest("002", "attention-unbound-second"));
		const manager = new HerderRunManager(planDirectory);
		try {
			assert.throws(() => applyUserInput(manager, "Answer request one", "fresh-event-a"), /requires an attention request ID/);
			assert.throws(() => applyUserInput(manager, "Answer request two", "fresh-event-b"), /requires an attention request ID/);
			assert.equal(manager.store.getAttention(first.requestId)?.state, "awaiting_input");
			assert.equal(manager.store.getAttention(second.requestId)?.state, "awaiting_input");
			assert.deepEqual(manager.store.getPlan("run-1", "001")?.repair, []);
			assert.deepEqual(manager.store.getPlan("run-1", "002")?.repair, []);
		} finally {
			manager.close();
		}
	} finally {
		store.close();
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});

test("a committed answer replays idempotently after a later request becomes current", () => {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herder-attention-replay-"));
	const store = new RunStore(planDirectory);
	try {
		insertRun(store, planDirectory);
		store.updateRun({ status: "needs_input", terminalDetail: "Two Judges need input" });
		store.putPlan(inputPlan("run-1", "001"));
		store.putPlan(inputPlan("run-1", "002"));
		const first = store.putAttention(userDecisionRequest("001", "attention-first"));
		const second = store.putAttention(userDecisionRequest("002", "attention-second"));
		const manager = new HerderRunManager(planDirectory);
		try {
			applyUserInput(manager, "Answer request one", "answer-one", first.requestId);
			assert.equal(manager.store.getAttention(first.requestId)?.state, "resolved");
			assert.equal(manager.store.getAttention(second.requestId)?.state, "awaiting_input");
			assert.equal(manager.store.getRun()?.status, "needs_input");
		} finally {
			manager.close();
		}

		// The first transaction is durable, but its event journal write is absent;
		// a replacement service must accept the identical event without routing it
		// against the now-current second request.
		const replacement = new HerderRunManager(planDirectory);
		try {
			applyUserInput(replacement, "Answer request one", "answer-one", first.requestId);
			assert.deepEqual(replacement.store.getPlan("run-1", "001")?.repair, ["USER_INPUT [answer-one]: Answer request one"]);
			assert.equal(replacement.store.getPlan("run-1", "002")?.phase, "NEEDS_INPUT");
			assert.equal(replacement.store.getAttention(second.requestId)?.state, "awaiting_input");
		} finally {
			replacement.close();
		}
	} finally {
		store.close();
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
});
