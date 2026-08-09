import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"

const require = createRequire(import.meta.url)
type Database = DatabaseSync
type SqlRow = Record<string, any>

export interface UsageRecordInput {
  attempt?: unknown; plan?: unknown; role?: unknown; model?: unknown; effort?: unknown; outcome?: unknown
  inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown; reasoningTokens?: unknown
  source?: unknown; round?: unknown; generation?: unknown; harness?: unknown; serviceTier?: unknown
  startedAt?: unknown; finishedAt?: unknown; durationMs?: unknown
}

export interface UsageRecord {
  attempt: string; plan: string; role: string; model: string; effort: string; outcome: string
  inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null
  source: string; round: number | null; generation: string | null; harness: string | null; serviceTier: string | null
  startedAt: string | null; finishedAt: string | null; durationMs: number | null; recordedAt?: string
}

export interface RunRoleBinding { agent_type: string; model: string; effort: string; service_tier?: string }
export interface RunConfigurationInput { profile?: unknown; profileSha256?: unknown; host?: unknown; roles?: unknown }
export interface RunConfiguration {
  profile: string
  profileSha256: string
  host: "pi"
  roles: Record<string, RunRoleBinding>
  recordedAt?: string
}

export const EXECUTION_DATABASE_RELATIVE = ".herder/execution.sqlite3"
export const EXECUTION_SCHEMA_VERSION = 8

// Integrity checks scan the database. Running one for every short-lived reader
// (the dashboard polls every two seconds) turns an O(1) open into O(database).
// Check each file identity at startup and periodically thereafter instead.
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000
const HEALTHY_DATABASES = new Map<string, { dev: number; ino: number; checkedAt: number }>()

const IDENTITY_FIELDS = [
  "attempt",
  "plan",
  "role",
  "model",
  "effort",
  "outcome",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "source",
  "round",
  "generation",
  "harness",
  "serviceTier",
  "startedAt",
  "finishedAt",
  "durationMs",
]

function fail(message: string): never {
  throw new Error(message)
}

function sqliteApi(): typeof import("node:sqlite") {
  try {
    return require("node:sqlite")
  } catch {
    fail("SQLite execution accounting requires a Node.js runtime with the built-in node:sqlite module")
  }
}

export function executionDatabasePath(planDir: string): string {
  return path.join(path.resolve(planDir), EXECUTION_DATABASE_RELATIVE)
}

function configureDatabase(database: Database, { readOnly = false }: { readOnly?: boolean } = {}): void {
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA busy_timeout = 5000")
  if (readOnly) {
    database.exec("PRAGMA query_only = ON")
    return
  }
  database.exec("PRAGMA journal_mode = DELETE")
  database.exec("PRAGMA synchronous = FULL")
}

const SCHEMA_8_TABLES = `
  CREATE TABLE IF NOT EXISTS manager_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('start', 'event', 'edit', 'stop', 'verification')),
    payload_json TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('accepted', 'running', 'succeeded', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    result_json TEXT,
    error TEXT,
    accepted_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS manager_operations_state_sequence ON manager_operations(state, sequence);

  CREATE TABLE IF NOT EXISTS manager_snapshots (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision > 0),
    reply_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS manager_verifications (
    request_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK (generation > 0),
    graph_sha256 TEXT NOT NULL,
    run_assignment_path TEXT NOT NULL,
    run_assignment_sha256 TEXT NOT NULL,
    integration_branch TEXT NOT NULL,
    integration_worktree TEXT NOT NULL,
    integration_head TEXT NOT NULL,
    integration_tree TEXT NOT NULL,
    request_sha256 TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('awaiting_manifest', 'running', 'passed', 'failed')),
    manifest_json TEXT,
    manifest_sha256 TEXT,
    result_json TEXT,
    terminal_detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS manager_verifications_run_generation ON manager_verifications(run_id, generation, created_at);
`

function ensureLegacyFingerprintVersion(database: Database): void {
  const columns = database.prepare("PRAGMA table_info(manager_plan_specs)").all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === "fingerprint_version")) {
    database.exec("ALTER TABLE manager_plan_specs ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 1 CHECK (fingerprint_version IN (1, 2));")
  }
}

function initializeSchema(database: Database, { allowInitialize = true }: { allowInitialize?: boolean } = {}): void {
  const row = database.prepare("PRAGMA user_version").get() as SqlRow
  const version = Number(row.user_version)
  if (version === EXECUTION_SCHEMA_VERSION) return
  if (version === 6 && allowInitialize) {
    ensureLegacyFingerprintVersion(database)
    database.exec(`
      CREATE TABLE manager_plan_edits (
        run_id TEXT PRIMARY KEY NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        edit_token TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'barrier')),
        base_graph_sha256 TEXT NOT NULL,
        base_plan_fingerprint TEXT NOT NULL,
        proposed_graph_sha256 TEXT,
        proposed_plan_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ${SCHEMA_8_TABLES}
      PRAGMA user_version = 8;
    `)
    return
  }
  if (version === 7 && allowInitialize) {
    ensureLegacyFingerprintVersion(database)
    database.exec(`${SCHEMA_8_TABLES}\nPRAGMA user_version = 8;`)
    return
  }
  if (version !== 0) fail(`Execution database schema ${version} is unsupported; Herder ${EXECUTION_SCHEMA_VERSION} requires a fresh run database`)
  if (!allowInitialize) fail("Execution database has no initialized schema")
  database.exec(`
      CREATE TABLE attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        outcome TEXT NOT NULL,
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        cached_input_tokens INTEGER CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        source TEXT NOT NULL,
        round_number INTEGER CHECK (round_number IS NULL OR round_number BETWEEN 1 AND 6),
        generation TEXT,
        harness TEXT,
        service_tier TEXT,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX attempts_plan_id ON attempts(plan_id);

      CREATE TABLE run_configuration (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        profile_name TEXT NOT NULL,
        profile_sha256 TEXT NOT NULL,
        host TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE manager_runs (
        run_id TEXT PRIMARY KEY NOT NULL,
        repository_root TEXT NOT NULL,
        plan_directory TEXT NOT NULL,
        plan_name TEXT NOT NULL,
        host TEXT NOT NULL CHECK (host = 'pi'),
        profile_name TEXT NOT NULL,
        profile_sha256 TEXT NOT NULL,
        max_parallel INTEGER NOT NULL CHECK (max_parallel > 0),
        current_generation INTEGER NOT NULL CHECK (current_generation > 0),
        graph_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('initializing', 'running', 'paused', 'needs_input', 'complete', 'failed', 'stopped')),
        checkout_state_token TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        integration_branch TEXT NOT NULL,
        integration_worktree TEXT NOT NULL,
        dashboard_url TEXT,
        terminal_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX manager_runs_plan_directory ON manager_runs(plan_directory);

      CREATE TABLE manager_generations (
        run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation > 0),
        graph_sha256 TEXT NOT NULL,
        parent_generation INTEGER,
        run_assignment_path TEXT NOT NULL,
        run_assignment_sha256 TEXT NOT NULL,
        run_snapshot_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, generation)
      );

      CREATE TABLE manager_plans (
        run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 6),
        phase TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree TEXT NOT NULL,
        assignment_path TEXT NOT NULL,
        assignment_sha256 TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        generation_base TEXT NOT NULL,
        review_pass INTEGER NOT NULL DEFAULT 0 CHECK (review_pass >= 0),
        findings_json TEXT NOT NULL DEFAULT '[]',
        repair_json TEXT NOT NULL DEFAULT '[]',
        gate_json TEXT NOT NULL DEFAULT '[]',
        approved_base TEXT,
        approved_head TEXT,
        approved_tree TEXT,
        rebase_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, plan_id)
      );
      CREATE INDEX manager_plans_phase ON manager_plans(run_id, phase, plan_id);

      CREATE TABLE manager_events (
        event_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX manager_events_run ON manager_events(run_id, created_at, event_id);

      CREATE TABLE manager_actions (
        action_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 6),
        role TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('proposed', 'dispatched', 'terminal', 'cancelled')),
        agent_type TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        service_tier TEXT,
        worker_mode TEXT NOT NULL,
        task_name TEXT NOT NULL,
        lease_reason TEXT NOT NULL,
        host_handle TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX manager_actions_run_state ON manager_actions(run_id, state, plan_id);

      CREATE TABLE manager_service (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        instance_id TEXT NOT NULL,
        pid INTEGER NOT NULL CHECK (pid > 0),
        port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        auth_token TEXT NOT NULL,
        dashboard_url TEXT NOT NULL,
        forwarded_url TEXT,
        started_at TEXT NOT NULL
      );

      CREATE TABLE manager_plan_specs (
        run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
        graph_generation INTEGER NOT NULL CHECK (graph_generation > 0),
        plan_id TEXT NOT NULL,
        plan_fingerprint TEXT NOT NULL,
        fingerprint_version INTEGER NOT NULL DEFAULT 2 CHECK (fingerprint_version IN (1, 2)),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        title TEXT NOT NULL,
        priority TEXT NOT NULL,
        effort TEXT NOT NULL,
        kind TEXT NOT NULL,
        dependencies_json TEXT NOT NULL,
        initial_status TEXT NOT NULL CHECK (initial_status IN ('TODO', 'DONE', 'BLOCKED', 'REJECTED')),
        initial_status_detail TEXT NOT NULL,
        gate_commands_json TEXT NOT NULL,
        plan_file TEXT NOT NULL,
        assignment_json TEXT NOT NULL,
        PRIMARY KEY (run_id, graph_generation, plan_id)
      );
      CREATE UNIQUE INDEX manager_plan_specs_ordinal ON manager_plan_specs(run_id, graph_generation, ordinal);

      CREATE TABLE manager_plan_edits (
        run_id TEXT PRIMARY KEY NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        edit_token TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'barrier')),
        base_graph_sha256 TEXT NOT NULL,
        base_plan_fingerprint TEXT NOT NULL,
        proposed_graph_sha256 TEXT,
        proposed_plan_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE manager_approvals (
        run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 6),
        reviewer_action_id TEXT NOT NULL REFERENCES manager_actions(action_id),
        decision_action_id TEXT NOT NULL REFERENCES manager_actions(action_id),
        decision_role TEXT NOT NULL CHECK (decision_role IN ('plan-reviewer', 'plan-judge')),
        assignment_sha256 TEXT NOT NULL,
        approved_base TEXT NOT NULL,
        approved_head TEXT NOT NULL,
        approved_tree TEXT NOT NULL,
        review_result_sha256 TEXT NOT NULL,
        decision_result_sha256 TEXT NOT NULL,
        proof_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, plan_id, generation)
      );
      CREATE UNIQUE INDEX manager_approvals_proof ON manager_approvals(proof_sha256);
      ${SCHEMA_8_TABLES}
      PRAGMA user_version = 8;
  `)
}

function assertHealthy(database: Database, databasePath: string): void {
  const row = database.prepare("PRAGMA quick_check").get() as SqlRow
  const result = String(Object.values(row)[0] ?? "")
  if (result !== "ok") fail(`Execution database failed quick_check at ${databasePath}: ${result || "unknown error"}`)
}

export function openExecutionDatabase(planDir: string, options: { create: true; readOnly?: boolean }): Database
export function openExecutionDatabase(planDir: string, options?: { create?: false; readOnly?: boolean }): Database | null
export function openExecutionDatabase(planDir: string, { create = false, readOnly = false }: { create?: boolean; readOnly?: boolean } = {}): Database | null {
  const databasePath = executionDatabasePath(planDir)
  const runtimeDirectory = path.dirname(databasePath)
  const existed = fs.existsSync(databasePath)
  if (!existed && !create) return null
  if (!existed && readOnly) return null
  if (fs.existsSync(runtimeDirectory)) {
    const runtimeStat = fs.lstatSync(runtimeDirectory)
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
      fail(`Execution runtime path must be a real directory: ${runtimeDirectory}`)
    }
  } else {
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  }
  if (existed) {
    const databaseStat = fs.lstatSync(databasePath)
    if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
      fail(`Execution database path must be a regular file: ${databasePath}`)
    }
  }
  const { DatabaseSync } = sqliteApi()
  const database = new DatabaseSync(databasePath, { readOnly })
  try {
    configureDatabase(database, { readOnly })
    initializeSchema(database, { allowInitialize: !readOnly })
    const identity = fs.statSync(databasePath)
    const lastCheck = HEALTHY_DATABASES.get(databasePath)
    if (!lastCheck
      || lastCheck.dev !== identity.dev
      || lastCheck.ino !== identity.ino
      || Date.now() - lastCheck.checkedAt >= HEALTH_CHECK_INTERVAL_MS) {
      assertHealthy(database, databasePath)
      if (HEALTHY_DATABASES.size >= 256) HEALTHY_DATABASES.delete(HEALTHY_DATABASES.keys().next().value!)
      HEALTHY_DATABASES.set(databasePath, { dev: identity.dev, ino: identity.ino, checkedAt: Date.now() })
    }
    if (!existed) {
      fs.chmodSync(runtimeDirectory, 0o700)
      fs.chmodSync(databasePath, 0o600)
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

const openDatabase = openExecutionDatabase

function requiredText(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim()
  if (!normalized) fail(`${label} cannot be empty`)
  if (/[\0\r\n|]/.test(normalized)) fail(`${label} must be one line and cannot contain a table separator`)
  return normalized
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null
  return requiredText(value, label)
}

function optionalCount(value: unknown, label: string): number | null {
  const normalized = String(value ?? "unknown").trim().toLowerCase()
  if (normalized === "unknown" || normalized === "") return null
  if (!/^\d+$/.test(normalized)) fail(`${label} must be a non-negative integer or "unknown"`)
  const count = Number.parseInt(normalized, 10)
  if (!Number.isSafeInteger(count)) fail(`${label} is too large`)
  return count
}

function optionalRound(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const round = optionalCount(value, "Round")
  if (round === null || round < 1 || round > 6) fail("Round must be an integer from 1 through 6")
  return round
}

function optionalTimestamp(value: unknown, label: string): string | null {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const text = requiredText(value, label)
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds)) fail(`${label} must be an ISO-8601 timestamp`)
  return new Date(milliseconds).toISOString()
}

export function normalizeUsageRecord(input: UsageRecordInput = {}): UsageRecord {
  const record: UsageRecord = {
    attempt: requiredText(input.attempt, "Attempt"),
    plan: requiredText(input.plan, "Plan"),
    role: requiredText(input.role, "Role"),
    model: requiredText(input.model, "Model"),
    effort: requiredText(input.effort, "Effort"),
    outcome: requiredText(input.outcome, "Outcome"),
    inputTokens: optionalCount(input.inputTokens, "Input tokens"),
    cachedInputTokens: optionalCount(input.cachedInputTokens, "Cached input tokens"),
    outputTokens: optionalCount(input.outputTokens, "Output tokens"),
    reasoningTokens: optionalCount(input.reasoningTokens, "Reasoning tokens"),
    source: requiredText(input.source ?? "unknown", "Source"),
    round: optionalRound(input.round),
    generation: optionalText(input.generation, "Generation"),
    harness: optionalText(input.harness, "Harness"),
    serviceTier: optionalText(input.serviceTier, "Service tier"),
    startedAt: optionalTimestamp(input.startedAt, "Started at"),
    finishedAt: optionalTimestamp(input.finishedAt, "Finished at"),
    durationMs: optionalCount(input.durationMs, "Duration milliseconds"),
  }
  if (record.source.toLowerCase() === "unknown"
    && [record.inputTokens, record.cachedInputTokens, record.outputTokens, record.reasoningTokens].some((value) => value !== null)) {
    fail(`Usage attempt ${record.attempt} has numeric usage but an unknown source`)
  }
  if (record.startedAt && record.finishedAt && Date.parse(record.finishedAt) < Date.parse(record.startedAt)) {
    fail(`Usage attempt ${record.attempt} finishes before it starts`)
  }
  return record
}

function rowToRecord(row: SqlRow): UsageRecord {
  return {
    attempt: row.attempt_id,
    plan: row.plan_id,
    role: row.role,
    model: row.model,
    effort: row.effort,
    outcome: row.outcome,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    source: row.source,
    round: row.round_number,
    generation: row.generation,
    harness: row.harness,
    serviceTier: row.service_tier,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    recordedAt: row.recorded_at,
  }
}

function comparable(record: UsageRecord): Record<string, unknown> {
  return Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, record[field as keyof UsageRecord] ?? null]))
}

function sameRecord(left: UsageRecord, right: UsageRecord): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right))
}

function readDatabaseRecords(database: Database): UsageRecord[] {
  return (database.prepare("SELECT * FROM attempts ORDER BY rowid").all() as SqlRow[]).map(rowToRecord)
}

function normalizeRunConfiguration(input: RunConfigurationInput = {}): RunConfiguration {
  const profile = requiredText(input.profile, "Profile")
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile)) fail("Profile must be a lowercase profile name")
  const profileSha256 = requiredText(input.profileSha256, "Profile SHA-256").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(profileSha256)) fail("Profile SHA-256 must contain 64 hexadecimal characters")
  const host = requiredText(input.host, "Host")
  if (host !== "pi") fail("Host must be pi")
  let roles: unknown
  try {
    roles = typeof input.roles === "string" ? JSON.parse(input.roles) : input.roles
  } catch (error) {
    fail(`Roles JSON is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) fail("Roles must be a JSON object")
  const roleRecords = roles as Record<string, unknown>
  const normalizedRoles: Record<string, RunRoleBinding> = {}
  for (const role of ["plan-implementer", "plan-reviewer", "plan-judge"]) {
    const mapping = roleRecords[role] as Record<string, unknown> | undefined
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) fail(`Missing run role ${role}`)
    const unknownFields = Object.keys(mapping).filter((field) => !["agent_type", "model", "effort", "service_tier"].includes(field))
    if (unknownFields.length > 0) fail(`Run role ${role} contains unknown fields: ${unknownFields.join(", ")}`)
    normalizedRoles[role] = {
      agent_type: requiredText(mapping.agent_type, `${role} agent type`),
      model: requiredText(mapping.model, `${role} model`),
      effort: requiredText(mapping.effort, `${role} effort`),
      ...(mapping.service_tier ? { service_tier: requiredText(mapping.service_tier, `${role} service tier`) } : {}),
    }
  }
  if (Object.keys(roleRecords).some((role) => !Object.hasOwn(normalizedRoles, role))) fail("Run roles contain an unknown role")
  return { profile, profileSha256, host: host as RunConfiguration["host"], roles: normalizedRoles }
}

function rowToRunConfiguration(row: SqlRow | undefined): RunConfiguration | null {
  if (!row) return null
  return {
    profile: row.profile_name,
    profileSha256: row.profile_sha256,
    host: row.host,
    roles: JSON.parse(row.roles_json),
    recordedAt: row.recorded_at,
  }
}

function readDatabaseRunConfiguration(database: Database): RunConfiguration | null {
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_configuration'").get()
  if (!table) return null
  return rowToRunConfiguration(database.prepare("SELECT * FROM run_configuration WHERE singleton = 1").get())
}

function databaseSchemaVersion(database: Database): number {
  return Number((database.prepare("PRAGMA user_version").get() as SqlRow).user_version)
}

export function recordRunConfiguration(planDir: string, input: RunConfigurationInput) {
  const configuration = normalizeRunConfiguration(input)
  const database = openDatabase(planDir, { create: true })
  let recorded = false
  try {
    withTransaction(database, () => {
      const existing = readDatabaseRunConfiguration(database)
      if (existing) {
        const comparableExisting = { profile: existing.profile, profileSha256: existing.profileSha256, host: existing.host, roles: existing.roles }
        if (JSON.stringify(comparableExisting) !== JSON.stringify(configuration)) {
          fail(`Run profile is already bound to ${existing.profile} (${existing.profileSha256}) on ${existing.host}`)
        }
        return
      }
      database.prepare(`
        INSERT INTO run_configuration (singleton, profile_name, profile_sha256, host, roles_json, recorded_at)
        VALUES (1, ?, ?, ?, ?, ?)
      `).run(configuration.profile, configuration.profileSha256, configuration.host, JSON.stringify(configuration.roles), new Date().toISOString())
      recorded = true
    })
    return { recorded, configuration: readDatabaseRunConfiguration(database), database: executionDatabasePath(planDir) }
  } finally {
    database.close()
  }
}

export function readRunConfiguration(planDir: string) {
  const database = openDatabase(planDir, { readOnly: true })
  if (!database) return { database: executionDatabasePath(planDir), schemaVersion: null, configuration: null }
  try {
    return { database: executionDatabasePath(planDir), schemaVersion: databaseSchemaVersion(database), configuration: readDatabaseRunConfiguration(database) }
  } finally {
    database.close()
  }
}

function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(String(value)) as T } catch { return fallback }
}

export function readManagerState(planDir: string) {
  const database = openDatabase(planDir, { readOnly: true })
  if (!database) return { run: null, specs: [], plans: [], actions: [], generations: [], approvals: [], edit: null, verification: null, service: null }
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_runs'").get()
    if (!table) return { run: null, specs: [], plans: [], actions: [], generations: [], approvals: [], edit: null, verification: null, service: null }
    const run = (database.prepare(`
      SELECT run_id, plan_name, host, profile_name, profile_sha256, max_parallel,
        current_generation, graph_sha256, status, integration_branch,
        integration_worktree, dashboard_url, terminal_detail, created_at, updated_at
      FROM manager_runs ORDER BY created_at DESC LIMIT 1
    `).get() as SqlRow | undefined) ?? null
    const plans = run ? database.prepare(`
      SELECT plan_id, generation, round_number, phase, branch, worktree,
        review_pass, findings_json, repair_json, gate_json, rebase_json, updated_at
      FROM manager_plans WHERE run_id = ? ORDER BY plan_id
    `).all(run.run_id) as SqlRow[] : []
    const specs = run ? database.prepare(`
      SELECT graph_generation, plan_id, plan_fingerprint, ordinal, title, priority,
        effort, kind, dependencies_json, initial_status, initial_status_detail,
        gate_commands_json, plan_file
      FROM manager_plan_specs
      WHERE run_id = ? AND graph_generation = ?
      ORDER BY ordinal, plan_id
    `).all(run.run_id, run.current_generation) as SqlRow[] : []
    const actions = run ? database.prepare(`
      SELECT action_id, plan_id, generation, round_number, role, attempt_id,
        state, agent_type, model, effort, service_tier, worker_mode, task_name,
        host_handle, created_at, updated_at
      FROM manager_actions WHERE run_id = ? ORDER BY created_at, action_id
    `).all(run.run_id) as SqlRow[] : []
    const generations = run ? database.prepare("SELECT * FROM manager_generations WHERE run_id = ? ORDER BY generation").all(run.run_id) as SqlRow[] : []
    const approvals = run ? database.prepare("SELECT * FROM manager_approvals WHERE run_id = ? ORDER BY plan_id, generation").all(run.run_id) as SqlRow[] : []
    const edit = run ? database.prepare("SELECT * FROM manager_plan_edits WHERE run_id = ?").get(run.run_id) as SqlRow | undefined : undefined
    const verificationTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_verifications'").get()
    const verification = run && verificationTable ? database.prepare(`
      SELECT request_id, generation, state, terminal_detail, updated_at
      FROM manager_verifications
      WHERE run_id = ? AND generation = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(run.run_id, run.current_generation) as SqlRow | undefined : undefined
    const service = database.prepare(`
      SELECT instance_id, pid, port, dashboard_url, forwarded_url, started_at
      FROM manager_service WHERE singleton = 1
    `).get() as SqlRow | undefined ?? null
    return {
      run: run ? {
        runId: run.run_id,
        planName: run.plan_name,
        host: run.host,
        profile: run.profile_name,
        profileSha256: run.profile_sha256,
        maxParallel: run.max_parallel,
        currentGeneration: run.current_generation,
        graphSha256: run.graph_sha256,
        status: run.status,
        integrationBranch: run.integration_branch,
        integrationWorktree: run.integration_worktree,
        dashboardUrl: run.dashboard_url,
        terminalDetail: run.terminal_detail,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      } : null,
      specs: specs.map((spec) => ({
        graphGeneration: spec.graph_generation,
        planId: spec.plan_id,
        planFingerprint: spec.plan_fingerprint,
        ordinal: spec.ordinal,
        title: spec.title,
        priority: spec.priority,
        effort: spec.effort,
        kind: spec.kind,
        dependencies: parseJsonColumn(spec.dependencies_json, []),
        initialStatus: spec.initial_status,
        initialStatusDetail: spec.initial_status_detail,
        gateCommands: parseJsonColumn(spec.gate_commands_json, []),
        planFile: spec.plan_file,
      })),
      plans: plans.map((plan) => ({
        planId: plan.plan_id,
        generation: plan.generation,
        round: plan.round_number,
        phase: plan.phase,
        branch: plan.branch,
        worktree: plan.worktree,
        reviewPass: plan.review_pass,
        findings: parseJsonColumn(plan.findings_json, []),
        repair: parseJsonColumn(plan.repair_json, []),
        gates: parseJsonColumn(plan.gate_json, []),
        rebase: parseJsonColumn(plan.rebase_json, null),
        updatedAt: plan.updated_at,
      })),
      actions: actions.map((action) => ({
        actionId: action.action_id,
        planId: action.plan_id,
        generation: action.generation,
        round: action.round_number,
        role: action.role,
        attemptId: action.attempt_id,
        state: action.state,
        agentType: action.agent_type,
        model: action.model,
        effort: action.effort,
        serviceTier: action.service_tier,
        workerMode: action.worker_mode,
        taskName: action.task_name,
        hostHandle: action.host_handle,
        createdAt: action.created_at,
        updatedAt: action.updated_at,
      })),
      generations: generations.map((generation) => ({
        generation: generation.generation,
        graphSha256: generation.graph_sha256,
        parentGeneration: generation.parent_generation,
        runAssignmentPath: generation.run_assignment_path,
        runAssignmentSha256: generation.run_assignment_sha256,
        runSnapshotSha256: generation.run_snapshot_sha256,
        createdAt: generation.created_at,
      })),
      approvals: approvals.map((approval) => ({
        planId: approval.plan_id,
        generation: approval.generation,
        round: approval.round_number,
        reviewerActionId: approval.reviewer_action_id,
        decisionActionId: approval.decision_action_id,
        decisionRole: approval.decision_role,
        assignmentSha256: approval.assignment_sha256,
        approvedBase: approval.approved_base,
        approvedHead: approval.approved_head,
        approvedTree: approval.approved_tree,
        reviewResultSha256: approval.review_result_sha256,
        decisionResultSha256: approval.decision_result_sha256,
        proofSha256: approval.proof_sha256,
        createdAt: approval.created_at,
      })),
      edit: edit ? {
        planId: edit.plan_id,
        state: edit.state,
        baseGraphSha256: edit.base_graph_sha256,
        createdAt: edit.created_at,
        updatedAt: edit.updated_at,
      } : null,
      verification: verification ? {
        requestId: verification.request_id,
        generation: verification.generation,
        state: verification.state,
        terminalDetail: verification.terminal_detail,
        updatedAt: verification.updated_at,
      } : null,
      service: service ? {
        instanceId: service.instance_id,
        pid: service.pid,
        port: service.port,
        dashboardUrl: service.dashboard_url,
        forwardedUrl: service.forwarded_url,
        startedAt: service.started_at,
      } : null,
    }
  } finally {
    database.close()
  }
}

function insertRecord(database: Database, record: UsageRecord): boolean {
  const existing = database.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(record.attempt) as SqlRow | undefined
  if (existing) {
    if (!sameRecord(rowToRecord(existing), record)) {
      fail(`Usage attempt ${record.attempt} is already recorded with different values`)
    }
    return false
  }
  database.prepare(`
    INSERT INTO attempts (
      attempt_id, plan_id, role, model, effort, outcome,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, source,
      round_number, generation, harness, service_tier,
      started_at, finished_at, duration_ms, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.attempt,
    record.plan,
    record.role,
    record.model,
    record.effort,
    record.outcome,
    record.inputTokens,
    record.cachedInputTokens,
    record.outputTokens,
    record.reasoningTokens,
    record.source,
    record.round,
    record.generation,
    record.harness,
    record.serviceTier,
    record.startedAt,
    record.finishedAt,
    record.durationMs,
    new Date().toISOString(),
  )
  return true
}

export function withExecutionTransaction<T>(database: Database, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE")
  try {
    const result = operation()
    database.exec("COMMIT")
    return result
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

const withTransaction = withExecutionTransaction

export function initializeExecutionStore(planDir: string) {
  const database = openDatabase(planDir, { create: true })
  try {
    return { database: executionDatabasePath(planDir), schemaVersion: databaseSchemaVersion(database) }
  } finally {
    database.close()
  }
}

export function insertUsageRecordInDatabase(database: DatabaseSync, input: UsageRecordInput) {
  const record = normalizeUsageRecord(input)
  const recorded = insertRecord(database, record)
  return { recorded, record }
}

export function recordUsageRecordInDatabase(database: DatabaseSync, input: UsageRecordInput) {
  return withTransaction(database, () => insertUsageRecordInDatabase(database, input))
}

export function recordUsageRecord(planDir: string, input: UsageRecordInput) {
  const database = openDatabase(planDir, { create: true })
  try {
    const stored = recordUsageRecordInDatabase(database, input)
    return { ...stored, records: readDatabaseRecords(database), database: executionDatabasePath(planDir) }
  } finally {
    database.close()
  }
}

export function readUsageState(planDir: string) {
  const databaseExists = fs.existsSync(executionDatabasePath(planDir))
  const database = openDatabase(planDir, { readOnly: true })
  let records: UsageRecord[] = []
  let runConfiguration: RunConfiguration | null = null
  let schemaVersion: number | null = null
  try {
    if (database) {
      records = readDatabaseRecords(database)
      runConfiguration = readDatabaseRunConfiguration(database)
      schemaVersion = databaseSchemaVersion(database)
    }
  } finally {
    database?.close()
  }
  return {
    database: executionDatabasePath(planDir),
    databaseExists,
    storage: databaseExists ? "sqlite" : "uninitialized",
    schemaVersion,
    runConfiguration,
    records,
  }
}

function summarizeRecords(records: UsageRecord[], keyFor: (record: UsageRecord) => string) {
  const groups = new Map<string, { attempts: number; tokenAttempts: number; knownTokens: number }>()
  for (const record of records) {
    const key = keyFor(record)
    const group = groups.get(key) ?? { attempts: 0, tokenAttempts: 0, knownTokens: 0 }
    group.attempts += 1
    if (record.inputTokens !== null && record.outputTokens !== null) {
      group.tokenAttempts += 1
      group.knownTokens += record.inputTokens + record.outputTokens
    }
    groups.set(key, group)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([key, summary]) => ({ key, ...summary }))
}

export function usageReport(records: UsageRecord[]) {
  return {
    attempts: records.length,
    byPlan: summarizeRecords(records, (record) => record.plan),
    byRole: summarizeRecords(records, (record) => record.role),
    byModel: summarizeRecords(records, (record) => `${record.model} / ${record.effort}`),
    records,
  }
}

function timestampRange(records: UsageRecord[]) {
  let startedAt: string | null = null
  let finishedAt: string | null = null
  for (const record of records) {
    if (record.startedAt && (startedAt === null || record.startedAt < startedAt)) startedAt = record.startedAt
    if (record.finishedAt && (finishedAt === null || record.finishedAt > finishedAt)) finishedAt = record.finishedAt
  }
  return {
    startedAt,
    finishedAt,
    wallClockMs: startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
  }
}

export function executionReport(records: UsageRecord[], selector = "RUN") {
  const selected = selector === "RUN" ? records : records.filter((record) => record.plan === selector)
  const roundSet = new Set<number>()
  let interruptions = 0
  let tokenAttempts = 0
  let durationAttempts = 0
  let attemptDurationMs = 0
  let inputTokens = 0
  let cachedInputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let reportedInputOutput = 0
  for (const record of selected) {
    if (record.round !== null) roundSet.add(record.round)
    if (record.outcome.toUpperCase() === "INTERRUPTED") interruptions += 1
    inputTokens += record.inputTokens ?? 0
    cachedInputTokens += record.cachedInputTokens ?? 0
    outputTokens += record.outputTokens ?? 0
    reasoningTokens += record.reasoningTokens ?? 0
    if (record.inputTokens !== null && record.outputTokens !== null) {
      tokenAttempts += 1
      reportedInputOutput += record.inputTokens + record.outputTokens
    }
    if (record.durationMs !== null) {
      durationAttempts += 1
      attemptDurationMs += record.durationMs
    }
  }
  const rounds = [...roundSet].sort((a, b) => a - b)
  return {
    plan: selector,
    attempts: selected.length,
    rounds,
    interruptions,
    tokenCoverage: {
      reported: tokenAttempts,
      total: selected.length,
    },
    tokens: {
      input: inputTokens,
      cachedInput: cachedInputTokens,
      output: outputTokens,
      reasoning: reasoningTokens,
      reportedInputOutput,
    },
    timing: {
      ...timestampRange(selected),
      attemptDurationMs: durationAttempts > 0 ? attemptDurationMs : null,
      durationCoverage: { reported: durationAttempts, total: selected.length },
    },
    byPlan: summarizeRecords(selected, (record) => record.plan),
    byRole: summarizeRecords(selected, (record) => record.role),
    byOutcome: summarizeRecords(selected, (record) => record.outcome),
    byModel: summarizeRecords(selected, (record) => `${record.model} / ${record.effort}`),
    byHarness: summarizeRecords(selected, (record) => record.harness ?? "unknown"),
    byGeneration: summarizeRecords(selected, (record) => record.generation ?? "unknown"),
    byServiceTier: summarizeRecords(selected, (record) => record.serviceTier ?? "unknown"),
    records: selected,
  }
}
