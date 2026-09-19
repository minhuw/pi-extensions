import type { DatabaseSync } from "node:sqlite";

export class BudgetExhaustedError extends Error {
	readonly runId: string;
	constructor(runId: string, message: string) { super(message); this.runId = runId; }
}

/** No cascading foreign keys: revision/reset must not erase spent authority. */
export const BUDGET_SCHEMA = `
CREATE TABLE manager_budgets (
 run_id TEXT PRIMARY KEY, current_run_id TEXT NOT NULL UNIQUE,
 baseline_generation INTEGER NOT NULL, baseline_graph_sha256 TEXT NOT NULL, baseline_specs_json TEXT NOT NULL,
 current_generation INTEGER NOT NULL, current_graph_sha256 TEXT NOT NULL,
 execution_limit INTEGER NOT NULL CHECK(execution_limit >= 0), stop_reason TEXT
);
CREATE TABLE manager_task_budgets (
 run_id TEXT NOT NULL, plan_id TEXT NOT NULL, round_limit INTEGER NOT NULL CHECK(round_limit >= 0), recovery_limit INTEGER NOT NULL DEFAULT 1 CHECK(recovery_limit >= 0),
 PRIMARY KEY(run_id, plan_id)
);
CREATE TABLE manager_budget_ledger (
 run_id TEXT NOT NULL, reservation_id TEXT NOT NULL, kind TEXT NOT NULL, source_run_id TEXT NOT NULL,
 plan_id TEXT, generation INTEGER, round_number INTEGER, payload_sha256 TEXT NOT NULL,
 PRIMARY KEY(run_id, reservation_id)
);
CREATE TABLE manager_budget_grants (
 request_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL
);
`;

/** Schema 19 has no durable transport classification; never guess and auto-resume. */
export function migrateBudgets(database: DatabaseSync): void {
	database.exec(BUDGET_SCHEMA);
	const runs = database.prepare("SELECT * FROM manager_runs").all() as Array<Record<string, any>>;
	for (const run of runs) {
		const specs = database.prepare("SELECT * FROM manager_plan_specs WHERE run_id = ? AND graph_generation = ? ORDER BY ordinal, plan_id").all(run.run_id, run.current_generation) as Array<Record<string, any>>;
		const reason = "Budget migration requires explicit host authorization: historical transport/retry attribution is ambiguous; no automatic dispatch.";
		database.prepare("INSERT INTO manager_budgets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(run.run_id, run.run_id, run.current_generation, run.graph_sha256, JSON.stringify(specs), run.current_generation, run.graph_sha256, 8 * specs.length + 12, reason);
		for (const spec of specs) database.prepare("INSERT INTO manager_task_budgets VALUES (?, ?, 3, 1)").run(run.run_id, spec.plan_id);
		database.prepare(`INSERT INTO manager_budget_ledger SELECT run_id, 'action:' || action_id, 'action:' || role, run_id, plan_id, generation, round_number, action_id FROM manager_actions WHERE run_id = ?`).run(run.run_id);
		database.prepare(`INSERT INTO manager_budget_ledger SELECT run_id, 'verification:' || request_id, 'verification', run_id, NULL, generation, NULL, request_id FROM manager_verifications WHERE run_id = ? AND (state <> 'awaiting_manifest' OR manifest_sha256 IS NOT NULL)`).run(run.run_id);
		// Count every begin audit conservatively, including historical decision-only begins.
		database.prepare(`INSERT INTO manager_budget_ledger SELECT r.run_id, 'repair:' || a.operation_id, 'repair', r.run_id, NULL, r.generation, NULL, a.payload_sha256 FROM manager_integration_repair_audits a JOIN manager_integration_repairs r USING(repair_id) WHERE r.run_id = ? AND a.action = 'begin' GROUP BY a.operation_id`).run(run.run_id);
		// A selected episode lacking a begin audit is still spent authorization.
		database.prepare(`INSERT OR IGNORE INTO manager_budget_ledger SELECT r.run_id, 'repair-episode:' || e.episode_id, 'repair', r.run_id, NULL, r.generation, NULL, e.episode_id FROM manager_integration_repair_episodes e JOIN manager_integration_repairs r USING(repair_id) WHERE r.run_id = ? AND e.classification IS NOT NULL AND NOT EXISTS (SELECT 1 FROM manager_integration_repair_audits a WHERE a.episode_id = e.episode_id AND a.action = 'begin')`).run(run.run_id);
		database.prepare("UPDATE manager_runs SET status = 'paused', terminal_detail = ? WHERE run_id = ? AND status NOT IN ('complete', 'stopped')").run(reason, run.run_id);
	}
}
