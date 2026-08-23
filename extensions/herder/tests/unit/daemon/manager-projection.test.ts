import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executionDatabasePath, openExecutionDatabase } from "../../../src/daemon/execution-store.ts";
import { readManagerState } from "../../../src/daemon/run-store.ts";
import { attentionRequestSha256, sha256 } from "../../../src/shared/protocol.ts";

const NOW = "2026-08-13T00:00:00.000Z";
const LATER = "2026-08-13T00:01:00.000Z";
const RUN_ID = "run-projection";
const PROFILE_SHA256 = "a".repeat(64);
const GRAPH_SHA256 = "b".repeat(64);
const ASSIGNMENT_SHA256 = "c".repeat(64);
const SNAPSHOT_SHA256 = "d".repeat(64);
const REQUEST_SHA256 = "e".repeat(64);
const COMMIT = "f".repeat(40);
const TREE = "1".repeat(40);

function withPlanDirectory<T>(prefix: string, callback: (planDirectory: string) => T): T {
	const planDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return callback(planDirectory);
	} finally {
		fs.rmSync(planDirectory, { recursive: true, force: true });
	}
}

function seedRun(database: NonNullable<ReturnType<typeof openExecutionDatabase>>, runId = RUN_ID): void {
	database.prepare(`
		INSERT INTO manager_runs (
			run_id, repository_root, plan_directory, plan_name, host, profile_name, profile_sha256,
			max_parallel, current_generation, graph_sha256, status, checkout_state_token, base_commit,
			integration_branch, integration_worktree, dashboard_url, terminal_detail, created_at, updated_at
		) VALUES (?, '/repo', '/repo/herder-plans', 'herder-plans', 'pi', 'eclipse', ?, 2, 1, ?, 'running', 'checkout-token', ?, ?, ?, ?, ?, ?, ?)
	`).run(
		runId,
		PROFILE_SHA256,
		GRAPH_SHA256,
		COMMIT,
		"herder/herder-plans/integration",
		"/repo/.herder/integration",
		"http://127.0.0.1:43123/",
		"still running",
		NOW,
		LATER,
	);
}

function seedPopulatedRun(database: NonNullable<ReturnType<typeof openExecutionDatabase>>): void {
	seedRun(database);
	database.prepare(`
		INSERT INTO manager_generations (
			run_id, generation, graph_sha256, parent_generation, run_assignment_path,
			run_assignment_sha256, run_snapshot_sha256, created_at
		) VALUES (?, 1, ?, NULL, ?, ?, ?, ?)
	`).run(RUN_ID, GRAPH_SHA256, "/repo/herder-plans/.herder/assignment.json", ASSIGNMENT_SHA256, SNAPSHOT_SHA256, NOW);
	database.prepare(`
		INSERT INTO manager_plans (
			run_id, plan_id, generation, round_number, phase, branch, worktree,
			assignment_path, assignment_sha256, snapshot_sha256, generation_base, review_pass,
			findings_json, repair_json, gate_json, approved_base, approved_head, approved_tree,
			rebase_json, updated_at
		) VALUES (?, '001', 1, 2, 'REVIEWING', 'herder/herder-plans/001', '/repo/.herder/worktrees/001',
			'/repo/herder-plans/.herder/assignment.json', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		RUN_ID,
		ASSIGNMENT_SHA256,
		SNAPSHOT_SHA256,
		COMMIT,
		JSON.stringify(["finding-1"]),
		JSON.stringify(["repair-1"]),
		JSON.stringify([{ gateId: "gate-1" }]),
		COMMIT,
		"0".repeat(40),
		TREE,
		JSON.stringify({ checkpointRef: "refs/checkpoint", checkpoint: COMMIT, onto: "2".repeat(40), detachedHead: "3".repeat(40) }),
		LATER,
	);
	database.prepare(`
		INSERT INTO manager_actions (
			action_id, run_id, plan_id, generation, round_number, role, attempt_id, state,
			agent_type, model, effort, service_tier, worker_mode, task_name, lease_reason,
			host_handle, result_json, created_at, updated_at
		) VALUES ('action-1', ?, '001', 1, 2, 'plan-reviewer', 'attempt-1', 'terminal',
			'worker', 'gpt-5.6-luna', 'max', 'fast', 'INITIAL', 'review plan', 'review requested',
			'host-1', ?, ?, ?)
	`).run(RUN_ID, JSON.stringify({ status: "approved" }), NOW, LATER);
	database.prepare(`
		INSERT INTO manager_plan_specs (
			run_id, graph_generation, plan_id, plan_fingerprint, fingerprint_version, ordinal,
			title, priority, effort, kind, dependencies_json, initial_status, initial_status_detail,
			gate_commands_json, plan_file, assignment_json
		) VALUES (?, 1, '001', ?, 2, 0, 'Projection plan', 'P1', 'M', 'behavioral', ?, 'TODO',
			'waiting', ?, '001-projection.md', ?)
	`).run(
		RUN_ID,
		"4".repeat(64),
		JSON.stringify(["002"]),
		JSON.stringify(["npm test"]),
		JSON.stringify({ id: "001" }),
	);
	database.prepare(`
		INSERT INTO manager_plan_edits (
			run_id, plan_id, edit_token, state, base_graph_sha256, base_plan_fingerprint,
			proposed_graph_sha256, proposed_plan_fingerprint, created_at, updated_at
		) VALUES (?, '001', 'edit-token', 'barrier', ?, ?, ?, ?, ?, ?)
	`).run(RUN_ID, GRAPH_SHA256, "5".repeat(64), "6".repeat(64), "7".repeat(64), NOW, LATER);
	database.prepare(`
		INSERT INTO manager_approvals (
			run_id, plan_id, generation, round_number, reviewer_action_id, decision_action_id,
			decision_role, assignment_sha256, approved_base, approved_head, approved_tree,
			review_result_sha256, decision_result_sha256, proof_sha256, created_at
		) VALUES (?, '001', 1, 2, 'action-1', 'action-1', 'plan-reviewer', ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		RUN_ID,
		ASSIGNMENT_SHA256,
		COMMIT,
		"8".repeat(40),
		TREE,
		"9".repeat(64),
		"a".repeat(64),
		"b".repeat(64),
		NOW,
	);
	database.prepare(`
		INSERT INTO manager_service (singleton, instance_id, pid, port, auth_token, dashboard_url, started_at)
		VALUES (1, 'service-1', ?, 43123, 'secret', 'http://127.0.0.1:43123/', ?)
	`).run(process.pid, NOW);
	database.prepare(`
		INSERT INTO manager_verifications (
			request_id, run_id, generation, graph_sha256, run_assignment_path, run_assignment_sha256,
			integration_branch, integration_worktree, integration_head, integration_tree,
			request_sha256, state, manifest_json, manifest_sha256, result_json, terminal_detail,
			created_at, updated_at
		) VALUES ('verification-1', ?, 1, ?, '/repo/herder-plans/.herder/assignment.json', ?,
			'herder/herder-plans/integration', '/repo/.herder/integration', ?, ?, ?, 'passed', NULL, NULL, NULL, 'verified', ?, ?)
	`).run(RUN_ID, GRAPH_SHA256, ASSIGNMENT_SHA256, COMMIT, TREE, REQUEST_SHA256, NOW, LATER);
}

function seedRepair(database: NonNullable<ReturnType<typeof openExecutionDatabase>>, runId = RUN_ID): void {
	const gates = [{ gateId: "npm-test", label: "Fixture tests", cwd: ".", argv: ["npm", "test"], rationale: "Run the fixture tests." }];
	database.prepare(`
		INSERT INTO manager_integration_repairs (
			repair_id, run_id, generation, request_id, request_sha256, owner_session_id,
			capability_digest, classification, state, round_number, max_rounds, parent_commit,
			current_commit, current_tree, superseded_commits_json, canonical_gates_json,
			canonical_gates_sha256, effective_gates_json, successor_request_id, successor_request_sha256,
			successor_manifest_json, successor_manifest_sha256, operation_id, operation_payload_sha256,
			detail, accepted_code_rounds, current_episode_id, begin_ref_snapshot_json,
			begin_ref_snapshot_sha256, created_at, updated_at
		) VALUES ('repair-1', ?, 1, 'repair-request-1', ?, 'session-1', 'capability', 'transient',
			'active', 2, 3, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'retrying', 2,
			'episode-1', ?, ?, ?, ?)
	`).run(
		runId,
		REQUEST_SHA256,
		COMMIT,
		"0".repeat(40),
		TREE,
		JSON.stringify(["old-commit"]),
		JSON.stringify(gates),
		sha256(JSON.stringify(gates)),
		JSON.stringify(gates),
		JSON.stringify({ branch: "main" }),
		"c".repeat(64),
		NOW,
		LATER,
	);
	database.prepare(`
		INSERT INTO manager_integration_repair_episodes (
			episode_id, repair_id, request_id, request_sha256, integration_head, integration_tree,
			canonical_gates_json, canonical_gates_sha256, classification, state, operation_id,
			operation_payload_sha256, transient_used, transient_use_evidence_sha256, created_at,
			updated_at, closed_at
		) VALUES ('episode-1', 'repair-1', 'repair-request-1', ?, ?, ?, ?, ?, 'transient', 'active',
			NULL, NULL, 1, 'transient-evidence', ?, ?, NULL)
	`).run(REQUEST_SHA256, COMMIT, TREE, JSON.stringify(gates), sha256(JSON.stringify(gates)), NOW, LATER);
}

function repairProjectionDefaults(): Record<string, unknown> {
	return {
		repairId: "repair-1",
		generation: 1,
		requestId: "repair-request-1",
		requestSha256: REQUEST_SHA256,
		ownerSessionId: "session-1",
		classification: "transient",
		episodeId: "episode-1",
		episodeState: "active",
		episodeRequestSha256: REQUEST_SHA256,
		episodeIntegrationHead: COMMIT,
		episodeIntegrationTree: TREE,
		episodeCanonicalGatesSha256: sha256(JSON.stringify([{ gateId: "npm-test", label: "Fixture tests", cwd: ".", argv: ["npm", "test"], rationale: "Run the fixture tests." }])),
		acceptedCodeRounds: 2,
		transientRetryUsed: true,
		state: "active",
		round: 2,
		parentCommit: COMMIT,
		currentCommit: "0".repeat(40),
		currentTree: TREE,
		supersededCommits: ["old-commit"],
		beginRefSnapshot: { branch: "main" },
		beginRefSnapshotSha256: "c".repeat(64),
		canonicalGates: [{ gateId: "npm-test", label: "Fixture tests", cwd: ".", argv: ["npm", "test"], rationale: "Run the fixture tests." }],
		canonicalGatesSha256: sha256(JSON.stringify([{ gateId: "npm-test", label: "Fixture tests", cwd: ".", argv: ["npm", "test"], rationale: "Run the fixture tests." }])),
		effectiveGates: [{ gateId: "npm-test", label: "Fixture tests", cwd: ".", argv: ["npm", "test"], rationale: "Run the fixture tests." }],
		successorRequestId: null,
		successorRequestSha256: null,
		successorManifest: null,
		successorManifestSha256: null,
		detail: "retrying",
		createdAt: NOW,
		updatedAt: LATER,
	};
}

test("manager projection is empty when the execution database is missing", () => {
	withPlanDirectory("herder-manager-projection-empty-", (planDirectory) => {
		assert.deepEqual(readManagerState(planDirectory), {
			run: null,
			specs: [],
			plans: [],
			actions: [],
			generations: [],
			approvals: [],
			edit: null,
			verification: null,
			integrationRepair: null,
			attention: null,
			service: null,
		});
	});
});

test("manager projection preserves populated manager domains", () => {
	withPlanDirectory("herder-manager-projection-populated-", (planDirectory) => {
		const database = openExecutionDatabase(planDirectory, { create: true });
		seedPopulatedRun(database);
		database.close();

		assert.deepEqual(readManagerState(planDirectory), {
			run: {
			runId: RUN_ID,
			planName: "herder-plans",
			host: "pi",
			profile: "eclipse",
			profileSha256: PROFILE_SHA256,
			maxParallel: 2,
			currentGeneration: 1,
			graphSha256: GRAPH_SHA256,
			status: "running",
			integrationBranch: "herder/herder-plans/integration",
			integrationWorktree: "/repo/.herder/integration",
			dashboardUrl: "http://127.0.0.1:43123/",
			terminalDetail: "still running",
			createdAt: NOW,
			updatedAt: LATER,
		},
			specs: [{
			graphGeneration: 1,
			planId: "001",
			planFingerprint: "4".repeat(64),
			ordinal: 0,
			title: "Projection plan",
			priority: "P1",
			effort: "M",
			kind: "behavioral",
			dependencies: ["002"],
			initialStatus: "TODO",
			initialStatusDetail: "waiting",
			gateCommands: ["npm test"],
			planFile: "001-projection.md",
		}],
			plans: [{
			planId: "001",
			generation: 1,
			round: 2,
			phase: "REVIEWING",
			branch: "herder/herder-plans/001",
			worktree: "/repo/.herder/worktrees/001",
			reviewPass: 1,
			findings: ["finding-1"],
			repair: ["repair-1"],
			gates: [{ gateId: "gate-1" }],
			rebase: { checkpointRef: "refs/checkpoint", checkpoint: COMMIT, onto: "2".repeat(40), detachedHead: "3".repeat(40) },
			updatedAt: LATER,
		}],
			actions: [{
				actionId: "action-1",
				planId: "001",
				generation: 1,
				round: 2,
				role: "plan-reviewer",
				attemptId: "attempt-1",
				state: "terminal",
				agentType: "worker",
				model: "gpt-5.6-luna",
				effort: "max",
				serviceTier: "fast",
				workerMode: "INITIAL",
				taskName: "review plan",
				hostHandle: "host-1",
				createdAt: NOW,
				updatedAt: LATER,
			}],
			generations: [{
				generation: 1,
				graphSha256: GRAPH_SHA256,
				parentGeneration: null,
				runAssignmentPath: "/repo/herder-plans/.herder/assignment.json",
				runAssignmentSha256: ASSIGNMENT_SHA256,
				runSnapshotSha256: SNAPSHOT_SHA256,
				createdAt: NOW,
			}],
			approvals: [{
				planId: "001",
				generation: 1,
				round: 2,
				reviewerActionId: "action-1",
				decisionActionId: "action-1",
				decisionRole: "plan-reviewer",
				assignmentSha256: ASSIGNMENT_SHA256,
				approvedBase: COMMIT,
				approvedHead: "8".repeat(40),
				approvedTree: TREE,
				reviewResultSha256: "9".repeat(64),
				decisionResultSha256: "a".repeat(64),
				proofSha256: "b".repeat(64),
				createdAt: NOW,
			}],
			edit: {
				planId: "001",
				state: "barrier",
				baseGraphSha256: GRAPH_SHA256,
				createdAt: NOW,
				updatedAt: LATER,
			},
			verification: {
				requestId: "verification-1",
				generation: 1,
				state: "passed",
				terminalDetail: "verified",
				updatedAt: LATER,
			},
			integrationRepair: null,
			attention: null,
			service: {
				instanceId: "service-1",
				pid: process.pid,
				port: 43123,
				dashboardUrl: "http://127.0.0.1:43123/",
				startedAt: NOW,
			},
		});
	});
});

test("manager projection validates and preserves attention requests", () => {
	withPlanDirectory("herder-manager-projection-attention-", (planDirectory) => {
		const database = openExecutionDatabase(planDirectory, { create: true });
		seedRun(database);
		const detail = "The judge needs an operator decision.";
		const request = {
			requestId: "attention-1",
			runId: RUN_ID,
			planId: "001",
			generation: 1,
			round: 2,
			actionId: null,
			kind: "operator_attention" as const,
			state: "awaiting_input" as const,
			cause: "judge_needs_input" as const,
			detail,
			detailSha256: sha256(detail),
			continuation: { role: "plan-judge" as const, phase: "JUDGING" as const },
			question: "Which behavior is correct?",
			recommendedAction: "Choose the supported behavior.",
		};
		const requestSha256 = attentionRequestSha256(request);
		database.prepare(`
			INSERT INTO manager_attention_requests (
				request_id, run_id, plan_id, generation, round_number, action_id, request_sha256,
				kind, state, cause, detail, detail_sha256, continuation_role, continuation_phase,
				question, recommended_action, recovery_json, created_at, updated_at, resolved_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
		`).run(
			request.requestId, request.runId, request.planId, request.generation, request.round,
			request.actionId, requestSha256, request.kind, request.state, request.cause,
			request.detail, request.detailSha256, request.continuation.role, request.continuation.phase,
			request.question, request.recommendedAction, NOW, LATER,
		);
		database.close();

		assert.deepEqual(readManagerState(planDirectory).attention, {
			schemaVersion: 1,
			requestId: "attention-1",
			runId: RUN_ID,
			planId: "001",
			generation: 1,
			round: 2,
			actionId: null,
			requestSha256,
			kind: "operator_attention",
			state: "awaiting_input",
			cause: "judge_needs_input",
			detail,
			detailSha256: sha256(detail),
			continuation: { role: "plan-judge", phase: "JUDGING" },
			question: "Which behavior is correct?",
			recommendedAction: "Choose the supported behavior.",
			createdAt: NOW,
			updatedAt: LATER,
		});
	});
});

test("manager projection includes repair episode and transient retry state", () => {
	withPlanDirectory("herder-manager-projection-repair-", (planDirectory) => {
		const database = openExecutionDatabase(planDirectory, { create: true });
		seedRun(database);
		seedRepair(database);
		database.close();

		const projection = readManagerState(planDirectory);
		assert.deepEqual(projection.integrationRepair, repairProjectionDefaults());
	});
});

test("schema 18 manager projection tolerates missing optional repair columns and tables", () => {
	withPlanDirectory("herder-manager-projection-optional-", (planDirectory) => {
		const seeded = openExecutionDatabase(planDirectory, { create: true });
		seedRun(seeded);
		seedRepair(seeded);
		seeded.close();

		const database = new DatabaseSync(executionDatabasePath(planDirectory));
		database.exec(`
			DROP TABLE manager_integration_repair_audits;
			DROP TABLE manager_integration_repair_episodes;
			DROP TABLE manager_verifications;
			DROP TABLE manager_attention_requests;
			DROP INDEX manager_integration_repairs_run_request;
			DROP INDEX manager_integration_repairs_run_state;
			CREATE TABLE manager_integration_repairs_reduced (
				repair_id TEXT PRIMARY KEY NOT NULL,
				run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
				generation INTEGER NOT NULL CHECK (generation > 0),
				request_id TEXT NOT NULL,
				request_sha256 TEXT NOT NULL,
				owner_session_id TEXT NOT NULL,
				capability_digest TEXT NOT NULL,
				classification TEXT,
				state TEXT NOT NULL CHECK (state IN ('available', 'active', 'committing', 'committed', 'verifying', 'passed', 'failed', 'cancelled', 'paused', 'interrupted')),
				round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 3),
				max_rounds INTEGER NOT NULL DEFAULT 3 CHECK (max_rounds = 3),
				parent_commit TEXT NOT NULL,
				current_commit TEXT,
				current_tree TEXT,
				superseded_commits_json TEXT NOT NULL DEFAULT '[]',
				canonical_gates_json TEXT NOT NULL,
				canonical_gates_sha256 TEXT NOT NULL,
				effective_gates_json TEXT NOT NULL,
				successor_request_id TEXT,
				successor_request_sha256 TEXT,
				successor_manifest_json TEXT,
				successor_manifest_sha256 TEXT,
				operation_id TEXT,
				operation_payload_sha256 TEXT,
				detail TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			INSERT INTO manager_integration_repairs_reduced (
				repair_id, run_id, generation, request_id, request_sha256, owner_session_id,
				capability_digest, classification, state, round_number, max_rounds, parent_commit,
				current_commit, current_tree, superseded_commits_json, canonical_gates_json,
				canonical_gates_sha256, effective_gates_json, successor_request_id, successor_request_sha256,
				successor_manifest_json, successor_manifest_sha256, operation_id, operation_payload_sha256,
				detail, created_at, updated_at
			) SELECT
				repair_id, run_id, generation, request_id, request_sha256, owner_session_id,
				capability_digest, classification, state, round_number, max_rounds, parent_commit,
				current_commit, current_tree, superseded_commits_json, canonical_gates_json,
				canonical_gates_sha256, effective_gates_json, successor_request_id, successor_request_sha256,
				successor_manifest_json, successor_manifest_sha256, operation_id, operation_payload_sha256,
				detail, created_at, updated_at
			FROM manager_integration_repairs;
			DROP TABLE manager_integration_repairs;
			ALTER TABLE manager_integration_repairs_reduced RENAME TO manager_integration_repairs;
			CREATE UNIQUE INDEX manager_integration_repairs_run_request ON manager_integration_repairs(run_id, request_id);
			CREATE INDEX manager_integration_repairs_run_state ON manager_integration_repairs(run_id, state, generation, round_number);
			PRAGMA user_version = 18;
		`);
		database.close();

		const projection = readManagerState(planDirectory);
		assert.deepEqual(projection.integrationRepair, {
			repairId: "repair-1",
			generation: 1,
			requestId: "repair-request-1",
			requestSha256: REQUEST_SHA256,
			ownerSessionId: "session-1",
			classification: "transient",
			episodeId: undefined,
			episodeState: undefined,
			episodeRequestSha256: undefined,
			episodeIntegrationHead: undefined,
			episodeIntegrationTree: undefined,
			episodeCanonicalGatesSha256: undefined,
			acceptedCodeRounds: 0,
			transientRetryUsed: false,
			state: "active",
			round: 2,
			parentCommit: COMMIT,
			currentCommit: "0".repeat(40),
			currentTree: TREE,
			supersededCommits: ["old-commit"],
			beginRefSnapshot: null,
			beginRefSnapshotSha256: null,
			canonicalGates: [{ gateId: "npm-test", label: "Fixture tests", cwd: ".", argv: ["npm", "test"], rationale: "Run the fixture tests." }],
			canonicalGatesSha256: sha256(JSON.stringify([{ gateId: "npm-test", label: "Fixture tests", cwd: ".", argv: ["npm", "test"], rationale: "Run the fixture tests." }])),
			effectiveGates: [{ gateId: "npm-test", label: "Fixture tests", cwd: ".", argv: ["npm", "test"], rationale: "Run the fixture tests." }],
			successorRequestId: null,
			successorRequestSha256: null,
			successorManifest: null,
			successorManifestSha256: null,
			detail: "retrying",
			createdAt: NOW,
			updatedAt: LATER,
		});
		const versionCheck = new DatabaseSync(executionDatabasePath(planDirectory), { readOnly: true });
		try {
			const version = versionCheck.prepare("PRAGMA user_version").get() as { user_version: number };
			assert.equal(Number(version.user_version), 18);
		} finally {
			versionCheck.close();
		}
	});
});
