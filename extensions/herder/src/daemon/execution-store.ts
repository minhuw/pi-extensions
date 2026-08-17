import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import path from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { INTEGRATION_REPAIR_CLASSIFICATIONS, integrationRepairEpisodeId, sha256, stableJson, validateAttentionRequest } from "../shared/protocol.ts"

const require = createRequire(import.meta.url)
type Database = DatabaseSync
type SqlRow = Record<string, any>

export interface NestedUsageRecord {
  type: string
  model: string
  effort: string
  serviceTier?: string
  count: number
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  durationMs?: number
}

export interface UsageRecordInput {
  attempt?: unknown; plan?: unknown; role?: unknown; model?: unknown; effort?: unknown; outcome?: unknown
  inputTokens?: unknown; cachedInputTokens?: unknown; outputTokens?: unknown; reasoningTokens?: unknown
  source?: unknown; round?: unknown; generation?: unknown; harness?: unknown; serviceTier?: unknown
  startedAt?: unknown; finishedAt?: unknown; durationMs?: unknown; nested?: unknown; nestedUsage?: unknown
}

export interface UsageRecord {
  attempt: string; plan: string; role: string; model: string; effort: string; outcome: string
  inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null
  source: string; round: number | null; generation: string | null; harness: string | null; serviceTier: string | null
  startedAt: string | null; finishedAt: string | null; durationMs: number | null; recordedAt?: string
  nestedUsage: NestedUsageRecord[]
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
export const EXECUTION_ROTATION_MARKER_RELATIVE = ".herder/rotation-required"
export const EXECUTION_SCHEMA_VERSION = 18

const PRIVATE_RUNTIME_DIRECTORY_MODE = 0o700
const PRIVATE_RUNTIME_FILE_MODE = 0o600
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0
const ROTATION_EPOCH_LOCK_NAME = "rotation-epoch.lock"
const ROTATION_EPOCH_LOCK_TIMEOUT_MS = 30_000
const ROTATION_EPOCH_LOCK_STALE_MS = 60_000
const ROTATION_EPOCH_LOCKS = new Map<string, { descriptor: number; depth: number; token: string }>()
const ROTATION_PUBLICATION_EPOCHS = new Map<string, number>()
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4))

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
  "nestedUsage",
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

export function executionRotationMarkerPath(planDir: string): string {
  return path.join(path.resolve(planDir), EXECUTION_ROTATION_MARKER_RELATIVE)
}

function lstatIfPresent(candidate: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function ownerOnlyMode(stat: fs.Stats): boolean {
  return (stat.mode & 0o077) === 0
}

function canonicalPrivateMode(stat: fs.Stats, expected: number): boolean {
  return process.platform === "win32" || (stat.mode & 0o7777) === expected
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertDirectory(candidate: string, stat: fs.Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory: ${candidate}`)
}

function assertRegularFile(candidate: string, stat: fs.Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular file: ${candidate}`)
}

function assertOwnerOnly(candidate: string, stat: fs.Stats, label: string): void {
  if (!ownerOnlyMode(stat)) fail(`${label} must be owner-only: ${candidate}`)
}

function validateRotationMarker(markerPath: string, { readOnly = false }: { readOnly?: boolean } = {}): fs.Stats | null {
  const marker = lstatIfPresent(markerPath)
  if (!marker) return null
  assertRegularFile(markerPath, marker, "Execution rotation marker")
  if (readOnly) assertOwnerOnly(markerPath, marker, "Execution rotation marker")
  return marker
}

function syncDirectory(directoryPath: string): void {
  const directoryFlag = fs.constants.O_DIRECTORY
  const noFollowFlag = fs.constants.O_NOFOLLOW
  if (!directoryFlag || !noFollowFlag || typeof fs.fsyncSync !== "function") {
    fail(`Durable rotation marker directory sync is unavailable: ${directoryPath}`)
  }
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY | directoryFlag | noFollowFlag)
    const identity = fs.fstatSync(descriptor)
    if (!identity.isDirectory()) fail(`Rotation marker parent must be a real directory: ${directoryPath}`)
    fs.fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function markerIdentity(markerPath: string, marker: fs.Stats): string {
  const contents = fs.readFileSync(markerPath)
  const current = lstatIfPresent(markerPath)
  if (!current || !sameFileIdentity(marker, current)) {
    fail(`Execution rotation marker changed while it was being inspected: ${markerPath}`)
  }
  assertRegularFile(markerPath, current, "Execution rotation marker")
  return `${current.dev}:${current.ino}:${contents.toString("base64")}`
}

function canonicalPath(candidate: string): string {
  try { return fs.realpathSync.native(candidate) }
  catch { return path.resolve(candidate) }
}

function rotationEpochLockPath(planDir: string): string {
  // The runtime directory is intentionally writable while it is being repaired.
  // Keep the synchronization epoch in the already-private plan namespace so an
  // exposed .herder entry cannot unlink or replace the authority lock.
  return path.join(canonicalPath(planDir), `.${ROTATION_EPOCH_LOCK_NAME}`)
}

function rotationEpochKeyFromMarker(markerPath: string): string {
  return canonicalPath(path.dirname(markerPath))
}

function noteRotationPublication(markerPath: string): void {
  const key = rotationEpochKeyFromMarker(markerPath)
  ROTATION_PUBLICATION_EPOCHS.set(key, (ROTATION_PUBLICATION_EPOCHS.get(key) ?? 0) + 1)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function waitForRotationEpochLock(): void {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, 10)
}

function restoreQuarantinedLock(lockPath: string, quarantinePath: string): void {
  try {
    fs.linkSync(quarantinePath, lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  fs.unlinkSync(quarantinePath)
}

function removeStaleRotationEpochLock(lockPath: string, observed: fs.Stats): void {
  const quarantinePath = `${lockPath}.${randomUUID()}.stale`
  let quarantinePresent = false
  try {
    try {
      fs.renameSync(lockPath, quarantinePath)
      quarantinePresent = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    const quarantined = lstatIfPresent(quarantinePath)
    if (!quarantined) return
    if (!sameFileIdentity(observed, quarantined)) {
      restoreQuarantinedLock(lockPath, quarantinePath)
      quarantinePresent = false
      return
    }
    fs.unlinkSync(quarantinePath)
    quarantinePresent = false
  } finally {
    if (quarantinePresent) {
      try { restoreQuarantinedLock(lockPath, quarantinePath) } catch {}
    }
  }
}

function acquireRotationEpochLock(planDir: string): { descriptor: number; lockPath: string; token: string } {
  const lockPath = rotationEpochLockPath(planDir)
  const deadline = Date.now() + ROTATION_EPOCH_LOCK_TIMEOUT_MS
  for (;;) {
    const token = randomUUID()
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG,
        PRIVATE_RUNTIME_FILE_MODE,
      )
      fs.fchmodSync(descriptor, PRIVATE_RUNTIME_FILE_MODE)
      fs.writeFileSync(descriptor, `${process.pid}:${token}\n`)
      const opened = fs.fstatSync(descriptor)
      const named = fs.lstatSync(lockPath)
      assertRegularFile(lockPath, named, "Execution rotation epoch lock")
      assertOwnerOnly(lockPath, named, "Execution rotation epoch lock")
      if (!sameFileIdentity(opened, named)) fail(`Execution rotation epoch lock changed while it was acquired: ${lockPath}`)
      return { descriptor, lockPath, token }
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          const opened = fs.fstatSync(descriptor)
          const named = lstatIfPresent(lockPath)
          if (named && sameFileIdentity(opened, named)) fs.unlinkSync(lockPath)
        } catch {}
        try { fs.closeSync(descriptor) } catch {}
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }

    const observed = lstatIfPresent(lockPath)
    if (!observed) continue
    assertRegularFile(lockPath, observed, "Execution rotation epoch lock")
    assertOwnerOnly(lockPath, observed, "Execution rotation epoch lock")
    let owner = 0
    try { owner = Number(fs.readFileSync(lockPath, "utf8").split(":", 1)[0]) } catch {}
    if ((owner > 0 && !processAlive(owner)) || (!owner && Date.now() - observed.mtimeMs >= ROTATION_EPOCH_LOCK_STALE_MS)) {
      removeStaleRotationEpochLock(lockPath, observed)
      continue
    }
    if (Date.now() >= deadline) fail(`Timed out waiting for execution rotation epoch lock: ${lockPath}`)
    waitForRotationEpochLock()
  }
}

function releaseRotationEpochLock(lockPath: string, descriptor: number, token: string): void {
  try {
    const opened = fs.fstatSync(descriptor)
    const named = lstatIfPresent(lockPath)
    if (!named || !sameFileIdentity(opened, named)) fail(`Execution rotation epoch lock changed while it was held: ${lockPath}`)
    if (fs.readFileSync(lockPath, "utf8") !== `${process.pid}:${token}\n`) {
      fail(`Execution rotation epoch lock ownership changed while it was held: ${lockPath}`)
    }
    fs.unlinkSync(lockPath)
  } finally {
    fs.closeSync(descriptor)
  }
}

function releaseRotationEpochEntry(lockPath: string, token: string): void {
  const held = ROTATION_EPOCH_LOCKS.get(lockPath)
  if (!held || held.token !== token) fail(`Execution rotation epoch lock is not held by this process: ${lockPath}`)
  held.depth -= 1
  if (held.depth > 0) return
  ROTATION_EPOCH_LOCKS.delete(lockPath)
  releaseRotationEpochLock(lockPath, held.descriptor, held.token)
}

/**
 * Hold the same cross-process epoch used by writable exposure repair while an
 * authority handoff performs asynchronous health and replacement checks.
 */
export function acquireExecutionRotationEpoch(planDir: string): () => void {
  const lockPath = rotationEpochLockPath(planDir)
  const held = ROTATION_EPOCH_LOCKS.get(lockPath)
  if (held) {
    held.depth += 1
    let released = false
    return () => {
      if (released) return
      released = true
      releaseRotationEpochEntry(lockPath, held.token)
    }
  }
  const acquired = acquireRotationEpochLock(planDir)
  ROTATION_EPOCH_LOCKS.set(lockPath, { descriptor: acquired.descriptor, depth: 1, token: acquired.token })
  let released = false
  return () => {
    if (released) return
    released = true
    releaseRotationEpochEntry(lockPath, acquired.token)
  }
}

function withRotationEpochLock<T>(planDir: string, callback: () => T): T {
  const release = acquireExecutionRotationEpoch(planDir)
  try {
    return callback()
  } finally {
    release()
  }
}

interface RotationPublicationState { currentEpochDurable: boolean }

class RotationEpochRequired extends Error {}

function createRotationMarker(markerPath: string, publication: RotationPublicationState): void {
  const token = randomUUID()
  const temporaryPath = `${markerPath}.${token}.tmp`
  let descriptor: number | undefined
  let temporaryPresent = false
  try {
    // Reserve the public marker path before opening the replacement temporary
    // file. If temporary creation fails, the empty owner-only reservation still
    // records the pending rotation epoch for a retry.
    let marker = lstatIfPresent(markerPath)
    if (!marker) {
      try {
        descriptor = fs.openSync(
          markerPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG,
          PRIVATE_RUNTIME_FILE_MODE,
        )
        noteRotationPublication(markerPath)
        fs.fchmodSync(descriptor, PRIVATE_RUNTIME_FILE_MODE)
        fs.fsyncSync(descriptor)
        fs.closeSync(descriptor)
        descriptor = undefined
        syncDirectory(path.dirname(markerPath))
        publication.currentEpochDurable = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      marker = lstatIfPresent(markerPath)
    }
    if (!marker) fail(`Execution rotation marker disappeared during repair: ${markerPath}`)
    assertRegularFile(markerPath, marker, "Execution rotation marker")
    marker = enforcePrivateMode(markerPath, marker, PRIVATE_RUNTIME_FILE_MODE, "Execution rotation marker", false)

    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG,
      PRIVATE_RUNTIME_FILE_MODE,
    )
    temporaryPresent = true
    fs.fchmodSync(descriptor, PRIVATE_RUNTIME_FILE_MODE)
    const written = fs.writeSync(descriptor, token, 0, "utf8")
    if (written !== Buffer.byteLength(token)) fail(`Execution rotation marker could not be written: ${markerPath}`)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    // Once rename begins, only its parent-directory sync proves that the fresh
    // epoch (rather than a prior durable reservation) survives a crash.
    publication.currentEpochDurable = false
    fs.renameSync(temporaryPath, markerPath)
    temporaryPresent = false
    noteRotationPublication(markerPath)
    syncDirectory(path.dirname(markerPath))
    publication.currentEpochDurable = true
    marker = lstatIfPresent(markerPath)
    if (!marker) fail(`Execution rotation marker disappeared during repair: ${markerPath}`)
    assertRegularFile(markerPath, marker, "Execution rotation marker")
    assertOwnerOnly(markerPath, marker, "Execution rotation marker")
    if (fs.readFileSync(markerPath, "utf8") !== token) {
      fail(`Execution rotation marker changed during repair: ${markerPath}`)
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (temporaryPresent) {
      try { fs.unlinkSync(temporaryPath) } catch {}
    }
  }
}

export function hasExecutionRotationMarker(planDir: string): boolean {
  return validateRotationMarker(executionRotationMarkerPath(planDir)) !== null
}

export function executionRotationMarkerIdentity(planDir: string): string | null {
  const markerPath = executionRotationMarkerPath(planDir)
  const marker = validateRotationMarker(markerPath)
  return marker ? markerIdentity(markerPath, marker) : null
}

export function executionAuthorityHandoffReady(planDir: string): boolean {
  const markerPath = executionRotationMarkerPath(planDir)
  const epochKey = rotationEpochKeyFromMarker(markerPath)
  return withRotationEpochLock(planDir, () => {
    const observedEpoch = ROTATION_PUBLICATION_EPOCHS.get(epochKey) ?? 0
    openExecutionDatabase(planDir, { create: true })!.close()
    const marker = executionRotationMarkerIdentity(planDir)
    return marker === null && (ROTATION_PUBLICATION_EPOCHS.get(epochKey) ?? 0) === observedEpoch
  })
}

function retainQuarantinedMarker(markerPath: string, quarantinePath: string): void {
  try {
    // A hard link restores the proven inode without replacing a fresh marker
    // that was published while the quarantine was in flight.
    fs.linkSync(quarantinePath, markerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  try {
    fs.unlinkSync(quarantinePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export function clearExecutionRotationMarker(planDir: string, expectedIdentity?: string): boolean {
  const markerPath = executionRotationMarkerPath(planDir)
  if (!lstatIfPresent(markerPath)) return expectedIdentity === undefined
  return withRotationEpochLock(planDir, () => {
    const marker = validateRotationMarker(markerPath)
  if (!marker) return expectedIdentity === undefined
  const observedIdentity = markerIdentity(markerPath, marker)
  if (expectedIdentity !== undefined && observedIdentity !== expectedIdentity) return false
  assertOwnerOnly(markerPath, marker, "Execution rotation marker")

  // Rename the entry out of the public pathname before deleting it. If a
  // publisher wins the rename race, its fresh inode is quarantined, detected,
  // and restored without ever unlinking the replacement at markerPath.
  const quarantinePath = `${markerPath}.${randomUUID()}.clear`
  let quarantinePresent = false
  try {
    try {
      fs.renameSync(markerPath, quarantinePath)
      quarantinePresent = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
    const quarantined = lstatIfPresent(quarantinePath)
    if (!quarantined) return false
    const quarantinedIdentity = markerIdentity(quarantinePath, quarantined)
    if (quarantinedIdentity !== observedIdentity) {
      retainQuarantinedMarker(markerPath, quarantinePath)
      quarantinePresent = false
      syncDirectory(path.dirname(markerPath))
      return false
    }
    try {
      fs.unlinkSync(quarantinePath)
      quarantinePresent = false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        quarantinePresent = false
        return false
      }
      throw error
    }
    syncDirectory(path.dirname(markerPath))
    return executionRotationMarkerIdentity(planDir) === null
    } finally {
      if (quarantinePresent) {
        try { retainQuarantinedMarker(markerPath, quarantinePath) } catch {}
      }
    }
  })
}

function createDatabaseFile(databasePath: string): void {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(
      databasePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW_FLAG,
      PRIVATE_RUNTIME_FILE_MODE,
    )
    fs.fchmodSync(descriptor, PRIVATE_RUNTIME_FILE_MODE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function enforcePrivateMode(
  candidate: string,
  expected: fs.Stats,
  mode: number,
  label: string,
  directory: boolean,
): fs.Stats {
  const directoryFlag = fs.constants.O_DIRECTORY
  const descriptorSafe = NOFOLLOW_FLAG !== 0 && (!directory || directoryFlag !== undefined) && typeof fs.fchmodSync === "function"
  if (descriptorSafe) {
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | NOFOLLOW_FLAG | (directory ? directoryFlag! : 0))
      const opened = fs.fstatSync(descriptor)
      if (directory) assertDirectory(candidate, opened, label)
      else assertRegularFile(candidate, opened, label)
      if (!sameFileIdentity(expected, opened)) fail(`${label} changed during permission repair: ${candidate}`)
      fs.fchmodSync(descriptor, mode)
      const repaired = fs.fstatSync(descriptor)
      if ((repaired.mode & 0o777) !== mode) fail(`${label} mode could not be repaired: ${candidate}`)
      const named = lstatIfPresent(candidate)
      if (!named || !sameFileIdentity(repaired, named)) fail(`${label} changed during permission repair: ${candidate}`)
      if (directory) assertDirectory(candidate, named, label)
      else assertRegularFile(candidate, named, label)
      return repaired
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }
  if (process.platform !== "win32") fail(`Safe ${label.toLowerCase()} permission repair is unavailable: ${candidate}`)
  fs.chmodSync(candidate, mode)
  const repaired = lstatIfPresent(candidate)
  if (!repaired || !sameFileIdentity(expected, repaired)) fail(`${label} changed during permission repair: ${candidate}`)
  if (directory) assertDirectory(candidate, repaired, label)
  else assertRegularFile(candidate, repaired, label)
  if ((repaired.mode & 0o777) !== mode) fail(`${label} mode could not be repaired: ${candidate}`)
  return repaired
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

const SCHEMA_9_TABLES = `
  CREATE TABLE IF NOT EXISTS manager_operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('start', 'event', 'edit', 'stop', 'verification', 'reignite')),
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

  CREATE TABLE IF NOT EXISTS manager_attention_requests (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 6),
    action_id TEXT,
    request_sha256 TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('plan_recovery', 'user_decision', 'operator_attention')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'awaiting_input', 'editing', 'resolved')),
    cause TEXT NOT NULL,
    detail TEXT NOT NULL,
    detail_sha256 TEXT NOT NULL,
    continuation_role TEXT NOT NULL,
    continuation_phase TEXT NOT NULL,
    question TEXT,
    recommended_action TEXT,
    recovery_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS manager_attention_requests_run_state
    ON manager_attention_requests(run_id, state, plan_id, sequence);
  CREATE UNIQUE INDEX IF NOT EXISTS manager_attention_requests_unresolved_identity
    ON manager_attention_requests(run_id, plan_id, generation, cause)
    WHERE state <> 'resolved';
`

const SCHEMA_11_TABLES = `
  CREATE TABLE IF NOT EXISTS manager_reignite_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK (generation > 0),
    request_sha256 TEXT NOT NULL UNIQUE,
    source_plan_directory TEXT NOT NULL,
    graph_sha256 TEXT NOT NULL,
    integration_head TEXT NOT NULL,
    integration_tree TEXT NOT NULL,
    integration_branch TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('APPROVE', 'REVISE', 'BLOCK')),
    scope TEXT NOT NULL CHECK (scope IN ('PASS', 'FAIL')),
    findings_json TEXT NOT NULL,
    fix_guidance_json TEXT NOT NULL,
    rationale TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'skipped', 'written', 'failed')),
    allocated_plan_directory TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS manager_reignite_requests_run_generation
    ON manager_reignite_requests(run_id, generation);
`

const SCHEMA_13_TABLES = `
  CREATE TABLE IF NOT EXISTS manager_integration_repairs (
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
  CREATE UNIQUE INDEX IF NOT EXISTS manager_integration_repairs_run_request
    ON manager_integration_repairs(run_id, request_id);
  CREATE INDEX IF NOT EXISTS manager_integration_repairs_run_state
    ON manager_integration_repairs(run_id, state, generation, round_number);

  CREATE TABLE IF NOT EXISTS manager_integration_repair_audits (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    repair_id TEXT NOT NULL REFERENCES manager_integration_repairs(repair_id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(repair_id, operation_id, action)
  );
  CREATE INDEX IF NOT EXISTS manager_integration_repair_audits_repair
    ON manager_integration_repair_audits(repair_id, audit_id);
`

const SCHEMA_15_TABLES = `
  CREATE TABLE IF NOT EXISTS manager_integration_repair_episodes (
    episode_id TEXT PRIMARY KEY NOT NULL,
    repair_id TEXT NOT NULL REFERENCES manager_integration_repairs(repair_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    integration_head TEXT NOT NULL,
    integration_tree TEXT NOT NULL,
    canonical_gates_json TEXT NOT NULL,
    canonical_gates_sha256 TEXT NOT NULL,
    classification TEXT,
    state TEXT NOT NULL CHECK (state IN ('available', 'active', 'committing', 'committed', 'verifying', 'passed', 'failed', 'cancelled', 'paused', 'interrupted')),
    operation_id TEXT,
    operation_payload_sha256 TEXT,
    transient_used INTEGER NOT NULL DEFAULT 0 CHECK (transient_used IN (0, 1)),
    transient_use_evidence_sha256 TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE(repair_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS manager_integration_repair_episodes_repair
    ON manager_integration_repair_episodes(repair_id, created_at, episode_id);
  CREATE INDEX IF NOT EXISTS manager_integration_repair_episodes_evidence
    ON manager_integration_repair_episodes(repair_id, integration_head, integration_tree, canonical_gates_sha256, transient_used);
`

const INTEGRATION_REPAIR_STATES = new Set(["available", "active", "committing", "committed", "verifying", "passed", "failed", "cancelled", "paused", "interrupted"])
const INTEGRATION_REPAIR_CLASSIFICATION_SET = new Set<string>(INTEGRATION_REPAIR_CLASSIFICATIONS)
const MIGRATION_CANONICAL_GATE_FIELDS = new Set(["gateId", "label", "cwd", "argv", "timeoutMs", "rationale"])

function hasExactMigrationCanonicalGateFields(gate: SqlRow): boolean {
  const fields = Object.keys(gate)
  return fields.length === MIGRATION_CANONICAL_GATE_FIELDS.size
    && fields.every((field) => MIGRATION_CANONICAL_GATE_FIELDS.has(field))
}

type MigrationEpisodeEvidence = {
  requestId: string
  requestSha256: string
  integrationHead: string
  integrationTree: string
  canonicalGates: unknown[]
  canonicalGatesSha256: string
  repairId: string
}

type FailedSuccessorEvidence = MigrationEpisodeEvidence & {
  predecessorRequestId: string
}

type SelectedFailedSuccessorProjection = MigrationEpisodeEvidence & {
  episodeId: string
  classification: string
  state: string
  operationId: string
  operationPayloadSha256: string
}

type FailedSuccessorEpisodeValidation =
  | { kind: "unselected"; evidence: MigrationEpisodeEvidence; state: "failed" | "paused" }
  | { kind: "selected"; projection: SelectedFailedSuccessorProjection }
  | { kind: "invalid"; reason: string }

function parseMigrationRecord(value: unknown): SqlRow {
  if (typeof value !== "string" || value.length === 0) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SqlRow : {}
  } catch {
    return {}
  }
}

function parseMigrationArray(value: unknown): unknown[] | null {
  if (typeof value !== "string" || value.length === 0) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function migrationText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value)
}

function migrationSourcesAgree(values: unknown[], { requireAll = true } = {}): string | null {
  const normalized = values.map(migrationText)
  if (requireAll && normalized.some((value) => value === "")) return null
  const present = normalized.filter((value) => value !== "")
  if (present.length === 0 || present.some((value) => value !== present[0])) return null
  return present[0]!
}

/**
 * Read only durable successor evidence. A projection may use this result only
 * when every persisted identity source agrees; no source is repaired here.
 */
function migrationSuccessorEvidence(row: SqlRow, verification: SqlRow | undefined, requestIdOverride?: string): FailedSuccessorEvidence | null {
  if (!verification) return null
  const verificationState = migrationText(verification.state)
  if (!new Set(["awaiting_manifest", "running", "passed", "failed"]).has(verificationState)) return null

  const explicitRequestId = migrationText(row.successor_request_id)
  const persistedManifestJson = migrationText(row.successor_manifest_json)
  const persistedManifestSha256 = migrationText(row.successor_manifest_sha256)
  const hasPersistedManifest = persistedManifestJson !== ""
  const hasPersistedManifestSha256 = persistedManifestSha256 !== ""
  if (hasPersistedManifest !== hasPersistedManifestSha256) return null
  const persistedSuccessorManifest = parseMigrationRecord(persistedManifestJson)
  const requiredManifestFields = [
    "requestId", "requestSha256", "runId", "graphSha256", "runAssignmentSha256",
    "integrationHead", "integrationTree", "rationale", "repairId", "predecessorRequestId",
  ]
  const validGate = (value: unknown, canonical = false): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const gate = value as SqlRow
    if (canonical && !hasExactMigrationCanonicalGateFields(gate)) return false
    const normalizedCwd = typeof gate.cwd === "string" ? path.normalize(gate.cwd) : ""
    return typeof gate.gateId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(gate.gateId)
      && gate.gateId.length <= 80
      && (!canonical || gate.gateId === gate.gateId.trim())
      && typeof gate.label === "string" && gate.label.length > 0 && gate.label.length <= 160 && !/[\0\r\n]/.test(gate.label)
      && (!canonical || gate.label === gate.label.trim())
      && typeof gate.cwd === "string" && gate.cwd.length > 0 && gate.cwd.length <= 1024 && !path.isAbsolute(gate.cwd)
      && normalizedCwd !== ".." && !normalizedCwd.startsWith(`..${path.sep}`) && !/[\0\r\n]/.test(gate.cwd)
      && (!canonical || normalizedCwd === gate.cwd && gate.cwd === gate.cwd.trim())
      && Array.isArray(gate.argv) && gate.argv.length > 0 && gate.argv.length <= 64
      && gate.argv.every((argument: unknown) => typeof argument === "string" && argument.length > 0 && argument.length <= 8192 && !/[\0\r\n]/.test(argument))
      && (canonical
        ? typeof gate.timeoutMs === "number" && Number.isSafeInteger(gate.timeoutMs) && gate.timeoutMs >= 1000 && gate.timeoutMs <= 2 * 60 * 60 * 1000
        : gate.timeoutMs === undefined || (typeof gate.timeoutMs === "number" && Number.isSafeInteger(gate.timeoutMs) && gate.timeoutMs >= 1000 && gate.timeoutMs <= 2 * 60 * 60 * 1000))
      && typeof gate.rationale === "string" && gate.rationale.length > 0 && gate.rationale.length <= 4096 && !/\0/.test(gate.rationale)
      && (!canonical || gate.rationale === gate.rationale.trim())
  }
  const validManifest = (manifest: SqlRow, canonical = false): boolean => {
    if (manifest.schemaVersion !== 1
      || !Array.isArray(manifest.gates) || manifest.gates.length > 32
      || !manifest.gates.every((gate: unknown) => validGate(gate, canonical))
      || requiredManifestFields.some((field) => typeof manifest[field] !== "string" || String(manifest[field]).length === 0)
      || ["requestSha256", "graphSha256", "runAssignmentSha256", "integrationHead", "integrationTree"]
        .some((field) => !/^[0-9a-f]{40,64}$/i.test(String(manifest[field])))
      || typeof manifest.generation !== "number"
      || !Number.isSafeInteger(manifest.generation)
      || manifest.generation < 1
      || (manifest.repairRound !== undefined
        && (typeof manifest.repairRound !== "number" || !Number.isSafeInteger(manifest.repairRound) || manifest.repairRound < 1 || manifest.repairRound > 3))) return false
    const gateIds = new Set<string>()
    for (const gate of manifest.gates as SqlRow[]) {
      if (gateIds.has(gate.gateId)) return false
      gateIds.add(gate.gateId)
    }
    if (!canonical) return true

    const allowedManifestFields = new Set([
      "schemaVersion", "requestId", "requestSha256", "runId", "generation", "graphSha256", "runAssignmentSha256",
      "integrationHead", "integrationTree", "rationale", "gates", "predecessorRequestId", "repairId", "repairRound", "selector",
    ])
    if (Object.keys(manifest).some((field) => !allowedManifestFields.has(field))) return false
    if (typeof manifest.rationale !== "string" || manifest.rationale.length === 0 || manifest.rationale.length > 16_384
      || /\0/.test(manifest.rationale) || manifest.rationale !== manifest.rationale.trim()) return false
    const matchesOptionalString = (field: string, durableValue: unknown): boolean => {
      const durable = migrationText(durableValue)
      const present = Object.prototype.hasOwnProperty.call(manifest, field)
      return durable ? present && typeof manifest[field] === "string" && manifest[field] === durable : !present
    }
    if (manifest.requestId !== migrationText(verification.request_id)
      || manifest.requestSha256 !== migrationText(verification.request_sha256)
      || manifest.runId !== migrationText(verification.run_id)
      || manifest.generation !== Number(verification.generation)
      || manifest.graphSha256 !== migrationText(verification.graph_sha256)
      || manifest.runAssignmentSha256 !== migrationText(verification.run_assignment_sha256)
      || manifest.integrationHead !== migrationText(verification.integration_head)
      || manifest.integrationTree !== migrationText(verification.integration_tree)
      || !matchesOptionalString("predecessorRequestId", verification.predecessor_request_id)
      || !matchesOptionalString("repairId", verification.repair_id)) return false
    const durableRepairRound = verification.repair_round === null || verification.repair_round === undefined ? undefined : Number(verification.repair_round)
    if (durableRepairRound === undefined) {
      if (Object.prototype.hasOwnProperty.call(manifest, "repairRound")) return false
    } else if (manifest.repairRound !== durableRepairRound) return false
    if (Object.prototype.hasOwnProperty.call(manifest, "selector")) {
      const selector = manifest.selector
      if (!selector || typeof selector !== "object" || Array.isArray(selector)) return false
      const selectorLimits: Record<string, number> = { model: 256, thinkingLevel: 32, sessionId: 200 }
      const selectorFields = Object.keys(selector)
      if (selectorFields.length === 0 || selectorFields.some((field) => !Object.prototype.hasOwnProperty.call(selectorLimits, field))) return false
      if (selectorFields.some((field) => {
        const value = selector[field]
        return typeof value !== "string" || value.length === 0 || value.length > selectorLimits[field]!
          || value !== value.trim() || /[\0\r\n]/.test(value)
      })) return false
    }
    return true
  }
  // Older schema rows can infer a failed successor from the selected episode without
  // having the later durable repair-manifest columns. Every new or in-flight cut
  // still requires the repair row's canonical successor evidence.
  const legacyInferredSuccessor = verificationState === "failed" && !explicitRequestId && !hasPersistedManifest
  const requiresPersistedManifest = !legacyInferredSuccessor
  if (requiresPersistedManifest && (!hasPersistedManifest || !validManifest(persistedSuccessorManifest, true)
    || sha256(stableJson(persistedSuccessorManifest)) !== persistedManifestSha256)) return null

  const verificationManifestJson = verification.manifest_json
  const verificationManifestSha256 = migrationText(verification.manifest_sha256)
  let verificationManifest: SqlRow = {}
  if (verificationState === "awaiting_manifest") {
    if (!hasPersistedManifest
      || verificationManifestJson !== null && verificationManifestJson !== undefined
      || verification.manifest_sha256 !== null && verification.manifest_sha256 !== undefined) return null
  } else {
    if (typeof verificationManifestJson !== "string" || verificationManifestJson.length === 0 || !verificationManifestSha256) return null
    verificationManifest = parseMigrationRecord(verificationManifestJson)
    if (!validManifest(verificationManifest, true)
      || sha256(stableJson(verificationManifest)) !== verificationManifestSha256
      || hasPersistedManifest && (verificationManifestSha256 !== persistedManifestSha256
        || stableJson(verificationManifest) !== stableJson(persistedSuccessorManifest))) return null
  }

  const requestId = requestIdOverride || explicitRequestId
  if (!requestId || (explicitRequestId && explicitRequestId !== requestId)
    || migrationText(verification.request_id) !== requestId
    || hasPersistedManifest && migrationText(persistedSuccessorManifest.requestId) !== requestId) return null

  const successorHash = migrationText(row.successor_request_sha256)
  if (hasPersistedManifest && (!explicitRequestId || !successorHash)) return null
  if (explicitRequestId && !successorHash) return null
  const inferredRepairRequestId = !explicitRequestId && migrationText(row.request_id) === requestId ? requestId : ""
  const requestSha256Sources = [
    verification.request_sha256,
    ...(verificationState === "awaiting_manifest" ? [] : [verificationManifest.requestSha256]),
    ...(hasPersistedManifest ? [persistedSuccessorManifest.requestSha256] : []),
    ...(successorHash ? [successorHash] : inferredRepairRequestId ? [row.request_sha256] : []),
  ]
  const requestSha256 = migrationSourcesAgree(requestSha256Sources)
  if (!requestSha256 || !/^[0-9a-f]{40,64}$/i.test(requestSha256)) return null

  const generation = Number(row.generation)
  if (!Number.isSafeInteger(generation) || generation < 1
    || Number(verification.generation) !== generation
    || verificationState !== "awaiting_manifest" && Number(verificationManifest.generation) !== generation
    || hasPersistedManifest && Number(persistedSuccessorManifest.generation) !== generation) return null
  const runId = migrationSourcesAgree([
    row.run_id,
    verification.run_id,
    ...(verificationState === "awaiting_manifest" ? [] : [verificationManifest.runId]),
    ...(hasPersistedManifest ? [persistedSuccessorManifest.runId] : []),
  ])
  if (!runId) return null

  const graphSha256 = migrationSourcesAgree([
    verification.graph_sha256,
    ...(verificationState === "awaiting_manifest" ? [] : [verificationManifest.graphSha256]),
    ...(hasPersistedManifest ? [persistedSuccessorManifest.graphSha256] : []),
  ])
  const runAssignmentSha256 = migrationSourcesAgree([
    verification.run_assignment_sha256,
    ...(verificationState === "awaiting_manifest" ? [] : [verificationManifest.runAssignmentSha256]),
    ...(hasPersistedManifest ? [persistedSuccessorManifest.runAssignmentSha256] : []),
  ])
  if (!graphSha256 || !runAssignmentSha256
    || !/^[0-9a-f]{40,64}$/i.test(graphSha256)
    || !/^[0-9a-f]{40,64}$/i.test(runAssignmentSha256)) return null

  const integrationHead = migrationSourcesAgree([
    verification.integration_head,
    ...(verificationState === "awaiting_manifest" ? [] : [verificationManifest.integrationHead]),
    ...(hasPersistedManifest ? [persistedSuccessorManifest.integrationHead] : []),
  ])
  const integrationTree = migrationSourcesAgree([
    verification.integration_tree,
    ...(verificationState === "awaiting_manifest" ? [] : [verificationManifest.integrationTree]),
    ...(hasPersistedManifest ? [persistedSuccessorManifest.integrationTree] : []),
  ])
  if (!integrationHead || !integrationTree
    || !/^[0-9a-f]{40,64}$/i.test(integrationHead)
    || !/^[0-9a-f]{40,64}$/i.test(integrationTree)) return null
  const currentCommit = migrationText(row.current_commit)
  const currentTree = migrationText(row.current_tree)
  const hasCurrentCommit = currentCommit !== ""
  const hasCurrentTree = currentTree !== ""
  if (verificationState === "awaiting_manifest" && hasPersistedManifest
    && (hasCurrentCommit !== hasCurrentTree || !hasCurrentCommit || currentCommit !== integrationHead || currentTree !== integrationTree)) return null
  if (hasCurrentCommit && hasCurrentTree && (currentCommit !== integrationHead || currentTree !== integrationTree)) return null

  const canonicalManifest = hasPersistedManifest ? persistedSuccessorManifest : verificationManifest
  const canonicalGates = Array.isArray(canonicalManifest.gates) ? canonicalManifest.gates : null
  if (!canonicalGates) return null
  const effectiveGates = parseMigrationArray(row.effective_gates_json)
  if (!effectiveGates || stableJson(effectiveGates) !== stableJson(canonicalGates)) return null

  const repairId = migrationSourcesAgree([
    row.repair_id,
    verification.repair_id,
    ...(verificationState === "awaiting_manifest" ? [] : [verificationManifest.repairId]),
    ...(hasPersistedManifest ? [persistedSuccessorManifest.repairId] : []),
  ])
  const predecessorRequestId = migrationSourcesAgree([
    verification.predecessor_request_id,
    ...(verificationState === "awaiting_manifest" ? [] : [verificationManifest.predecessorRequestId]),
    ...(hasPersistedManifest ? [persistedSuccessorManifest.predecessorRequestId] : []),
  ])
  if (!repairId || !predecessorRequestId) return null

  return {
    requestId,
    requestSha256,
    integrationHead,
    integrationTree,
    canonicalGates,
    canonicalGatesSha256: sha256(stableJson(canonicalGates)),
    repairId,
    predecessorRequestId,
  }
}

/** Read the exact canonical evidence for a failed predecessor verification. */
function migrationCanonicalVerificationEvidence(verification: SqlRow | undefined): MigrationEpisodeEvidence | null {
  if (!verification || migrationText(verification.state) !== "failed") return null
  const manifestJson = verification.manifest_json
  const manifestSha256 = migrationText(verification.manifest_sha256)
  if (typeof manifestJson !== "string" || manifestJson.length === 0 || !manifestSha256) return null
  const manifest = parseMigrationRecord(manifestJson)
  const requiredFields = [
    "requestId", "requestSha256", "runId", "graphSha256", "runAssignmentSha256",
    "integrationHead", "integrationTree", "rationale",
  ]
  if (manifest.schemaVersion !== 1
    || requiredFields.some((field) => typeof manifest[field] !== "string" || String(manifest[field]).length === 0)
    || !Array.isArray(manifest.gates) || manifest.gates.length > 32
    || typeof manifest.generation !== "number" || !Number.isSafeInteger(manifest.generation) || manifest.generation < 1
    || (manifest.repairRound !== undefined
      && (typeof manifest.repairRound !== "number" || !Number.isSafeInteger(manifest.repairRound) || manifest.repairRound < 1 || manifest.repairRound > 3))
    || sha256(stableJson(manifest)) !== manifestSha256) return null

  const allowedManifestFields = new Set([
    "schemaVersion", "requestId", "requestSha256", "runId", "generation", "graphSha256", "runAssignmentSha256",
    "integrationHead", "integrationTree", "rationale", "gates", "predecessorRequestId", "repairId", "repairRound", "selector",
  ])
  if (Object.keys(manifest).some((field) => !allowedManifestFields.has(field))) return null
  if (!/^[0-9a-f]{40,64}$/i.test(String(manifest.requestSha256))
    || !/^[0-9a-f]{40,64}$/i.test(String(manifest.graphSha256))
    || !/^[0-9a-f]{40,64}$/i.test(String(manifest.runAssignmentSha256))
    || !/^[0-9a-f]{40,64}$/i.test(String(manifest.integrationHead))
    || !/^[0-9a-f]{40,64}$/i.test(String(manifest.integrationTree))
    || typeof manifest.rationale !== "string" || manifest.rationale.length === 0 || manifest.rationale.length > 16_384
    || /\0/.test(manifest.rationale) || manifest.rationale !== manifest.rationale.trim()) return null

  const gateIds = new Set<string>()
  for (const value of manifest.gates as unknown[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const gate = value as SqlRow
    if (!hasExactMigrationCanonicalGateFields(gate)) return null
    const normalizedCwd = typeof gate.cwd === "string" ? path.normalize(gate.cwd) : ""
    if (typeof gate.gateId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(gate.gateId)
      || gate.gateId.length > 80 || gate.gateId !== gate.gateId.trim()
      || gateIds.has(gate.gateId)
      || typeof gate.label !== "string" || gate.label.length === 0 || gate.label.length > 160
      || /[\0\r\n]/.test(gate.label) || gate.label !== gate.label.trim()
      || typeof gate.cwd !== "string" || gate.cwd.length === 0 || gate.cwd.length > 1_024
      || path.isAbsolute(gate.cwd) || normalizedCwd !== gate.cwd || gate.cwd !== gate.cwd.trim()
      || normalizedCwd === ".." || normalizedCwd.startsWith(`..${path.sep}`) || /[\0\r\n]/.test(gate.cwd)
      || !Array.isArray(gate.argv) || gate.argv.length === 0 || gate.argv.length > 64
      || !gate.argv.every((argument: unknown) => typeof argument === "string" && argument.length > 0 && argument.length <= 8_192 && !/[\0\r\n]/.test(argument))
      || typeof gate.timeoutMs !== "number" || !Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs < 1_000 || gate.timeoutMs > 2 * 60 * 60 * 1_000
      || typeof gate.rationale !== "string" || gate.rationale.length === 0 || gate.rationale.length > 4_096
      || /\0/.test(gate.rationale) || gate.rationale !== gate.rationale.trim()) return null
    gateIds.add(gate.gateId)
  }

  const matchesOptionalString = (field: string, durableValue: unknown): boolean => {
    const durable = migrationText(durableValue)
    const present = Object.prototype.hasOwnProperty.call(manifest, field)
    return durable ? present && typeof manifest[field] === "string" && manifest[field] === durable : !present
  }
  if (manifest.requestId !== migrationText(verification.request_id)
    || manifest.requestSha256 !== migrationText(verification.request_sha256)
    || manifest.runId !== migrationText(verification.run_id)
    || manifest.generation !== Number(verification.generation)
    || manifest.graphSha256 !== migrationText(verification.graph_sha256)
    || manifest.runAssignmentSha256 !== migrationText(verification.run_assignment_sha256)
    || manifest.integrationHead !== migrationText(verification.integration_head)
    || manifest.integrationTree !== migrationText(verification.integration_tree)
    || !matchesOptionalString("predecessorRequestId", verification.predecessor_request_id)
    || !matchesOptionalString("repairId", verification.repair_id)) return null
  const durableRepairRound = verification.repair_round === null || verification.repair_round === undefined ? undefined : Number(verification.repair_round)
  if (durableRepairRound === undefined) {
    if (Object.prototype.hasOwnProperty.call(manifest, "repairRound")) return null
  } else if (manifest.repairRound !== durableRepairRound) return null
  if (Object.prototype.hasOwnProperty.call(manifest, "selector")) {
    const selector = manifest.selector
    if (!selector || typeof selector !== "object" || Array.isArray(selector)) return null
    const selectorLimits: Record<string, number> = { model: 256, thinkingLevel: 32, sessionId: 200 }
    const selectorFields = Object.keys(selector)
    if (selectorFields.length === 0 || selectorFields.some((field) => !Object.prototype.hasOwnProperty.call(selectorLimits, field))) return null
    if (selectorFields.some((field) => {
      const value = (selector as SqlRow)[field]
      return typeof value !== "string" || value.length === 0 || value.length > selectorLimits[field]!
        || value !== value.trim() || /[\0\r\n]/.test(value)
    })) return null
  }
  return {
    requestId: migrationText(verification.request_id),
    requestSha256: migrationText(verification.request_sha256),
    integrationHead: migrationText(verification.integration_head),
    integrationTree: migrationText(verification.integration_tree),
    canonicalGates: manifest.gates,
    canonicalGatesSha256: sha256(stableJson(manifest.gates)),
    repairId: migrationText(verification.repair_id),
  }
}

function migrationOperationEvidence(row: SqlRow): { operationId: string; operationPayloadSha256: string } | null {
  const operationId = migrationText(row.operation_id)
  const operationPayloadSha256 = migrationText(row.operation_payload_sha256)
  if ((operationId === "") !== (operationPayloadSha256 === "")) return null
  return { operationId, operationPayloadSha256 }
}

function validateFailedSuccessorEpisode(
  episode: SqlRow | undefined,
  repairId: string,
  evidence: MigrationEpisodeEvidence,
): FailedSuccessorEpisodeValidation {
  if (!episode) return { kind: "invalid", reason: "the selected current episode is missing" }
  if (migrationText(episode.repair_id) !== repairId) return { kind: "invalid", reason: "the selected current episode belongs to another repair" }
  if (migrationText(episode.request_id) !== evidence.requestId) return { kind: "invalid", reason: "the selected current episode request does not match the successor" }
  if (migrationText(episode.request_sha256) !== evidence.requestSha256
    || migrationText(episode.integration_head) !== evidence.integrationHead
    || migrationText(episode.integration_tree) !== evidence.integrationTree) {
    return { kind: "invalid", reason: "the selected current episode evidence does not match the successor" }
  }
  const episodeGates = parseMigrationArray(episode.canonical_gates_json)
  if (!episodeGates || migrationText(episode.canonical_gates_sha256) !== sha256(stableJson(episodeGates))
    || stableJson(episodeGates) !== stableJson(evidence.canonicalGates)) {
    return { kind: "invalid", reason: "the selected current episode gate evidence does not match the successor" }
  }
  const episodeId = integrationRepairEpisodeId({
    requestId: evidence.requestId,
    requestSha256: evidence.requestSha256,
    integrationHead: evidence.integrationHead,
    integrationTree: evidence.integrationTree,
    canonicalGates: evidence.canonicalGates as never[],
  })
  if (migrationText(episode.episode_id) !== episodeId) return { kind: "invalid", reason: "the selected current episode ID is not canonical" }
  if (migrationText(episode.closed_at)) return { kind: "invalid", reason: "the selected current episode is closed" }

  const classification = migrationText(episode.classification)
  const state = migrationText(episode.state)
  const operation = migrationOperationEvidence(episode)
  if (!operation) return { kind: "invalid", reason: "the selected current episode has incomplete projection evidence" }
  const { operationId, operationPayloadSha256 } = operation
  if (!classification && (state === "failed" || state === "paused") && !operationId && !operationPayloadSha256) {
    return { kind: "unselected", evidence, state }
  }
  if (!classification || !INTEGRATION_REPAIR_CLASSIFICATION_SET.has(classification)
    || !INTEGRATION_REPAIR_STATES.has(state) || !operationId || !operationPayloadSha256) {
    return { kind: "invalid", reason: "the selected current episode has incomplete projection evidence" }
  }
  return {
    kind: "selected",
    projection: {
      ...evidence,
      episodeId,
      classification,
      state,
      operationId,
      operationPayloadSha256,
    },
  }
}

function validateAwaitingSuccessorPredecessorEpisode(
  database: Database,
  row: SqlRow,
  successorEvidence: FailedSuccessorEvidence,
  currentEpisode: SqlRow | undefined,
): FailedSuccessorEpisodeValidation {
  const predecessorVerification = database.prepare("SELECT * FROM manager_verifications WHERE request_id = ?")
    .get(successorEvidence.predecessorRequestId) as SqlRow | undefined
  if (!predecessorVerification || migrationText(predecessorVerification.state) !== "failed") {
    return { kind: "invalid", reason: "the successor predecessor verification is missing or not failed" }
  }
  if (migrationText(predecessorVerification.run_id) !== migrationText(row.run_id)
    || Number(predecessorVerification.generation) !== Number(row.generation)) {
    return { kind: "invalid", reason: "the successor predecessor verification is outside the run generation" }
  }
  const predecessorRepairId = migrationText(predecessorVerification.repair_id)
  if (predecessorRepairId && predecessorRepairId !== successorEvidence.repairId) {
    return { kind: "invalid", reason: "the successor predecessor verification belongs to another repair" }
  }
  const predecessorEvidence = migrationCanonicalVerificationEvidence(predecessorVerification)
  if (!predecessorEvidence) {
    return { kind: "invalid", reason: "the successor predecessor verification evidence is not canonical" }
  }
  if (predecessorEvidence.requestId !== successorEvidence.predecessorRequestId
    || migrationText(row.request_id) !== successorEvidence.predecessorRequestId
    || migrationText(row.request_sha256) !== predecessorEvidence.requestSha256) {
    return { kind: "invalid", reason: "the awaiting repair projection does not identify the persisted predecessor" }
  }
  const episodeEvidence: MigrationEpisodeEvidence = {
    ...predecessorEvidence,
    repairId: successorEvidence.repairId,
  }
  return validateFailedSuccessorEpisode(currentEpisode, successorEvidence.repairId, episodeEvidence)
}

function migrationSuccessorHasPredecessor(database: Database, row: SqlRow, evidence: FailedSuccessorEvidence): boolean {
  if (evidence.predecessorRequestId === evidence.requestId) return false
  const predecessorVerification = database.prepare("SELECT run_id, generation, state, repair_id FROM manager_verifications WHERE request_id = ?").get(evidence.predecessorRequestId) as SqlRow | undefined
  if (!predecessorVerification || migrationText(predecessorVerification.state) !== "failed"
    || migrationText(predecessorVerification.run_id) !== migrationText(row.run_id)
    || Number(predecessorVerification.generation) !== Number(row.generation)) return false
  const predecessorRepairId = migrationText(predecessorVerification.repair_id)
  if (predecessorRepairId && predecessorRepairId !== evidence.repairId) return false
  if (migrationText(row.request_id) === evidence.predecessorRequestId) return true
  if (database.prepare("SELECT 1 FROM manager_integration_repair_episodes WHERE repair_id = ? AND request_id = ? LIMIT 1").get(evidence.repairId, evidence.predecessorRequestId)) return true
  const audits = database.prepare("SELECT evidence_json FROM manager_integration_repair_audits WHERE repair_id = ?").all(evidence.repairId) as SqlRow[]
  return audits.some((audit) => migrationText(parseMigrationRecord(audit.evidence_json).requestId) === evidence.predecessorRequestId)
}

/** Preflight all successor pointers before schema-16/17 projection mutation; legacy schema-14/15 replay may defer exact awaiting-episode checks until reconstruction completes. */
function validateFailedSuccessorMigration(
  database: Database,
  allowPredecessorEpisode = false,
  deferAwaitingPredecessorEpisode = false,
): void {
  const repairRows = database.prepare("SELECT * FROM manager_integration_repairs ORDER BY repair_id").all() as SqlRow[]
  const verificationRows = new Map<string, SqlRow | undefined>()
  const verification = database.prepare(`
    SELECT request_id, run_id, generation, graph_sha256, run_assignment_sha256, request_sha256, integration_head, integration_tree,
      predecessor_request_id, repair_id, repair_round, state, manifest_json, manifest_sha256
    FROM manager_verifications WHERE request_id = ?
  `)
  const episodeSelect = database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?")
  const getVerification = (requestId: string): SqlRow | undefined => {
    if (!verificationRows.has(requestId)) verificationRows.set(requestId, verification.get(requestId) as SqlRow | undefined)
    return verificationRows.get(requestId)
  }

  for (const row of repairRows) {
    const repairId = migrationText(row.repair_id)
    const explicitRequestId = migrationText(row.successor_request_id)
    const currentEpisodeId = migrationText(row.current_episode_id)
    const currentEpisode = currentEpisodeId ? episodeSelect.get(currentEpisodeId) as SqlRow | undefined : undefined
    if (currentEpisodeId && !currentEpisode) fail(`Cannot migrate integration repair ${repairId}: selected current episode is missing`)
    if (currentEpisode && migrationText(currentEpisode.repair_id) !== repairId) {
      fail(`Cannot migrate integration repair ${repairId}: selected current episode belongs to another repair`)
    }

    const currentRequestId = currentEpisode ? migrationText(currentEpisode.request_id) : ""
    const currentVerification = currentRequestId ? getVerification(currentRequestId) : undefined
    const inferredRequestId = !explicitRequestId && currentVerification
      && migrationText(currentVerification.repair_id) === repairId
      && migrationText(currentVerification.predecessor_request_id)
      ? currentRequestId
      : ""
    if (!explicitRequestId && currentEpisode && currentRequestId !== migrationText(row.request_id) && !inferredRequestId) {
      fail(`Cannot migrate integration repair ${repairId}: selected current episode has no valid successor lineage`)
    }
    const successorRequestId = explicitRequestId || inferredRequestId
    if (!successorRequestId) continue

    const successorVerification = getVerification(successorRequestId)
    if (!successorVerification) fail(`Cannot migrate integration repair ${repairId}: successor verification is missing`)
    const successorEvidence = migrationSuccessorEvidence(row, successorVerification, successorRequestId)
    if (!successorEvidence) fail(`Cannot migrate integration repair ${repairId}: successor evidence is inconsistent`)
    if (!migrationSuccessorHasPredecessor(database, row, successorEvidence)) {
      fail(`Cannot migrate integration repair ${repairId}: successor verification predecessor is outside the repair lineage`)
    }
    if (migrationText(successorVerification.state) === "awaiting_manifest") {
      const repairState = migrationText(row.state)
      if (repairState !== "committed" && repairState !== "verifying") {
        fail(`Cannot migrate integration repair ${repairId}: awaiting successor has an unrecoverable repair state`)
      }
      if (!deferAwaitingPredecessorEpisode) {
        const predecessorSelection = validateAwaitingSuccessorPredecessorEpisode(database, row, successorEvidence, currentEpisode)
        if (predecessorSelection.kind === "invalid") {
          fail(`Cannot migrate integration repair ${repairId}: ${predecessorSelection.reason}`)
        }
        if (predecessorSelection.kind !== "selected") {
          fail(`Cannot migrate integration repair ${repairId}: awaiting successor predecessor episode is not selected`)
        }
        const selected = predecessorSelection.projection
        const rowClassification = row.classification === null || row.classification === undefined ? null : String(row.classification)
        const rowState = row.state === null || row.state === undefined ? null : String(row.state)
        const rowOperation = migrationOperationEvidence(row)
        if (rowClassification !== selected.classification || rowState !== selected.state
          || !rowOperation || !rowOperation.operationId || !rowOperation.operationPayloadSha256) {
          fail(`Cannot migrate integration repair ${repairId}: awaiting successor current projection is inconsistent with its predecessor episode`)
        }
      }
    }
    if (migrationText(successorVerification.state) !== "failed") continue

    if (!currentEpisodeId) {
      fail(`Cannot migrate integration repair ${repairId}: failed successor has no current episode`)
    }
    const predecessorEpisode = allowPredecessorEpisode && currentEpisode
      && migrationText(currentEpisode.request_id) === migrationText(row.request_id)
      && migrationText(row.request_id) !== successorRequestId
    const selection = predecessorEpisode
      ? { kind: "unselected", evidence: successorEvidence, state: "failed" } as const
      : validateFailedSuccessorEpisode(currentEpisode, repairId, successorEvidence)
    if (selection.kind === "invalid") {
      fail(`Cannot migrate integration repair ${repairId}: ${selection.reason}`)
    }
  }
}

function applySchema15(database: Database): void {
  const repairColumns = database.prepare("PRAGMA table_info(manager_integration_repairs)").all() as Array<{ name: string }>
  if (!repairColumns.some((column) => column.name === "accepted_code_rounds")) {
    database.exec("ALTER TABLE manager_integration_repairs ADD COLUMN accepted_code_rounds INTEGER NOT NULL DEFAULT 0 CHECK (accepted_code_rounds BETWEEN 0 AND 3);")
  }
  if (!repairColumns.some((column) => column.name === "current_episode_id")) {
    database.exec("ALTER TABLE manager_integration_repairs ADD COLUMN current_episode_id TEXT;")
  }
  const auditColumns = database.prepare("PRAGMA table_info(manager_integration_repair_audits)").all() as Array<{ name: string }>
  if (!auditColumns.some((column) => column.name === "episode_id")) {
    database.exec("ALTER TABLE manager_integration_repair_audits ADD COLUMN episode_id TEXT;")
  }
  database.exec(SCHEMA_15_TABLES)

  const rows = database.prepare(`
    SELECT r.*, v.integration_head AS verification_head, v.integration_tree AS verification_tree, v.manifest_json AS verification_manifest_json
    FROM manager_integration_repairs r
    LEFT JOIN manager_verifications v ON v.request_id = r.request_id
  `).all() as SqlRow[]
  const insert = database.prepare(`
    INSERT OR IGNORE INTO manager_integration_repair_episodes (
      episode_id, repair_id, request_id, request_sha256, integration_head, integration_tree,
      canonical_gates_json, canonical_gates_sha256, classification, state,
      operation_id, operation_payload_sha256, transient_used, transient_use_evidence_sha256,
      created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL)
  `)
  const updateCurrent = database.prepare("UPDATE manager_integration_repairs SET current_episode_id = ? WHERE repair_id = ?")
  const updateAudits = database.prepare("UPDATE manager_integration_repair_audits SET episode_id = ? WHERE repair_id = ? AND episode_id IS NULL")
  for (const row of rows) {
    const currentEpisodeId = row.current_episode_id === null || row.current_episode_id === undefined ? "" : String(row.current_episode_id)
    if (currentEpisodeId) {
      updateAudits.run(currentEpisodeId, String(row.repair_id))
      continue
    }
    const requestId = String(row.request_id)
    const requestSha256 = String(row.request_sha256)
    const integrationHead = String(row.verification_head || row.parent_commit)
    const integrationTree = String(row.verification_tree || row.current_tree || row.parent_commit)
    const rowCanonicalGatesJson = String(row.canonical_gates_json || "[]")
    let rowCanonicalGates: unknown = []
    try { rowCanonicalGates = JSON.parse(rowCanonicalGatesJson) } catch { rowCanonicalGates = [] }
    // A schema-14 row may seed a provisional episode from mutable repair gates.
    // Prefer the durable current verification manifest so audit replay starts with canonical evidence.
    const verificationManifest = parseMigrationRecord(row.verification_manifest_json)
    const canonicalGates = Array.isArray(verificationManifest.gates)
      ? verificationManifest.gates
      : Array.isArray(rowCanonicalGates) ? rowCanonicalGates : []
    const canonicalGatesJson = JSON.stringify(canonicalGates)
    const canonicalGatesSha256 = Array.isArray(verificationManifest.gates)
      ? sha256(stableJson(canonicalGates))
      : String(row.canonical_gates_sha256)
    const episodeId = integrationRepairEpisodeId({
      requestId,
      requestSha256,
      integrationHead,
      integrationTree,
      canonicalGates: Array.isArray(canonicalGates) ? canonicalGates as never[] : [],
    })
    const now = String(row.updated_at || row.created_at || new Date().toISOString())
    insert.run(
      episodeId,
      String(row.repair_id),
      requestId,
      requestSha256,
      integrationHead,
      integrationTree,
      canonicalGatesJson,
      canonicalGatesSha256,
      row.classification === null || row.classification === undefined ? null : String(row.classification),
      String(row.state),
      row.operation_id === null || row.operation_id === undefined ? null : String(row.operation_id),
      row.operation_payload_sha256 === null || row.operation_payload_sha256 === undefined ? null : String(row.operation_payload_sha256),
      now,
      now,
    )
    updateCurrent.run(episodeId, String(row.repair_id))
    updateAudits.run(episodeId, String(row.repair_id))
  }
  database.exec("PRAGMA user_version = 15;")
}

/** Repair the first episode migration without changing immutable audit evidence. */
function applySchema16(database: Database): void {
  validateFailedSuccessorMigration(database, true, true)
  const repairRows = database.prepare("SELECT * FROM manager_integration_repairs ORDER BY repair_id").all() as SqlRow[]
  const verificationRows = new Map<string, SqlRow>()
  const verification = database.prepare(`
    SELECT request_id, run_id, generation, graph_sha256, run_assignment_sha256, request_sha256, integration_head, integration_tree,
      predecessor_request_id, repair_id, repair_round, state, manifest_json, manifest_sha256, terminal_detail
    FROM manager_verifications WHERE request_id = ?
  `)
  const audits = database.prepare(`
    SELECT audit_id, operation_id, action, payload_sha256, evidence_json, episode_id
    FROM manager_integration_repair_audits WHERE repair_id = ? ORDER BY audit_id
  `)
  const episodeSelect = database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?")
  const episodeInsert = database.prepare(`
    INSERT OR IGNORE INTO manager_integration_repair_episodes (
      episode_id, repair_id, request_id, request_sha256, integration_head, integration_tree,
      canonical_gates_json, canonical_gates_sha256, classification, state,
      operation_id, operation_payload_sha256, transient_used, transient_use_evidence_sha256,
      created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL)
  `)
  const episodeClose = database.prepare(`
    UPDATE manager_integration_repair_episodes
    SET state = ?, updated_at = ?, closed_at = COALESCE(closed_at, ?)
    WHERE episode_id = ?
  `)
  const episodeUse = database.prepare(`
    UPDATE manager_integration_repair_episodes
    SET transient_used = 1,
        transient_use_evidence_sha256 = COALESCE(transient_use_evidence_sha256, ?),
        updated_at = ?
    WHERE episode_id = ?
  `)
  const auditEpisode = database.prepare("UPDATE manager_integration_repair_audits SET episode_id = ? WHERE audit_id = ?")
  const repairUpdate = database.prepare(`
    UPDATE manager_integration_repairs
    SET accepted_code_rounds = ?, current_episode_id = ?, request_id = ?, request_sha256 = ?,
        classification = ?, state = ?, operation_id = ?, operation_payload_sha256 = ?, updated_at = ?
    WHERE repair_id = ?
  `)
  const now = new Date().toISOString()
  const validStates = new Set(["available", "active", "committing", "committed", "verifying", "passed", "failed", "cancelled", "paused", "interrupted"])
  const parseRecord = (value: unknown): SqlRow => {
    if (typeof value !== "string" || value.length === 0) return {}
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SqlRow : {}
    } catch {
      return {}
    }
  }
  const parseGates = (value: unknown, fallback: unknown[] = []): unknown[] => {
    if (typeof value !== "string" || value.length === 0) return fallback
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : fallback
    } catch {
      return fallback
    }
  }
  const stateForVerification = (value: unknown, fallback: string): string => {
    if (value === "passed") return "passed"
    if (value === "failed") return "failed"
    if (value === "awaiting_manifest" || value === "running") return "verifying"
    return validStates.has(fallback) ? fallback : "failed"
  }
  const getVerification = (requestId: string): SqlRow | undefined => {
    if (!verificationRows.has(requestId)) verificationRows.set(requestId, verification.get(requestId) as SqlRow | undefined ?? {})
    const row = verificationRows.get(requestId)
    return row && Object.keys(row).length > 0 ? row : undefined
  }
  const evidenceFor = (requestId: string, fallback: {
    requestSha256: string;
    integrationHead: string;
    integrationTree: string;
    canonicalGates: unknown[];
    state: string;
  }): {
    requestId: string;
    requestSha256: string;
    integrationHead: string;
    integrationTree: string;
    canonicalGates: unknown[];
    canonicalGatesSha256: string;
    state: string;
  } => {
    const stored = getVerification(requestId)
    const manifest = stored ? parseRecord(stored.manifest_json) : {}
    const canonicalGates = Array.isArray(manifest.gates) ? manifest.gates : fallback.canonicalGates
    const requestSha256 = stored?.request_sha256 === undefined ? fallback.requestSha256 : String(stored.request_sha256)
    const integrationHead = stored?.integration_head === undefined ? fallback.integrationHead : String(stored.integration_head)
    const integrationTree = stored?.integration_tree === undefined ? fallback.integrationTree : String(stored.integration_tree)
    return {
      requestId,
      requestSha256,
      integrationHead,
      integrationTree,
      canonicalGates,
      canonicalGatesSha256: sha256(stableJson(canonicalGates)),
      state: stateForVerification(stored?.state, fallback.state),
    }
  }

  for (const row of repairRows) {
    const repairId = String(row.repair_id)
    const baseRequestId = String(row.request_id)
    const baseGates = parseGates(row.canonical_gates_json)
    const baseStoredVerification = getVerification(baseRequestId)
    const baseEvidence = evidenceFor(baseRequestId, {
      requestSha256: String(row.request_sha256),
      integrationHead: baseStoredVerification?.integration_head === undefined ? String(row.parent_commit) : String(baseStoredVerification.integration_head),
      integrationTree: baseStoredVerification?.integration_tree === undefined ? String(row.current_tree || row.parent_commit) : String(baseStoredVerification.integration_tree),
      canonicalGates: baseGates,
      state: String(row.state),
    })
    const episodeByRequest = new Map<string, string>()
    const episodeEvidence = new Map<string, typeof baseEvidence>()
    const ensureEpisode = (evidence: typeof baseEvidence, classification: string | null, state: string, operationId: string | null, operationPayloadSha256: string | null): string => {
      const episodeId = integrationRepairEpisodeId({
        requestId: evidence.requestId,
        requestSha256: evidence.requestSha256,
        integrationHead: evidence.integrationHead,
        integrationTree: evidence.integrationTree,
        canonicalGates: evidence.canonicalGates as never[],
      })
      const existing = episodeSelect.get(episodeId) as SqlRow | undefined
      if (!existing) {
        episodeInsert.run(
          episodeId, repairId, evidence.requestId, evidence.requestSha256, evidence.integrationHead, evidence.integrationTree,
          JSON.stringify(evidence.canonicalGates), evidence.canonicalGatesSha256, classification,
          validStates.has(state) ? state : "failed", operationId, operationPayloadSha256, now, now,
        )
      }
      episodeByRequest.set(evidence.requestId, episodeId)
      episodeEvidence.set(episodeId, evidence)
      return episodeId
    }

    const baseEpisodeId = ensureEpisode(
      baseEvidence,
      row.classification === null || row.classification === undefined ? null : String(row.classification),
      String(row.state),
      row.operation_id === null || row.operation_id === undefined ? null : String(row.operation_id),
      row.operation_payload_sha256 === null || row.operation_payload_sha256 === undefined ? null : String(row.operation_payload_sha256),
    )
    const explicitSuccessorRequestId = row.successor_request_id === null || row.successor_request_id === undefined ? "" : String(row.successor_request_id)
    const selectedCurrentEpisodeId = row.current_episode_id === null || row.current_episode_id === undefined ? "" : String(row.current_episode_id)
    const selectedCurrentEpisode = selectedCurrentEpisodeId ? episodeSelect.get(selectedCurrentEpisodeId) as SqlRow | undefined : undefined
    const selectedCurrentVerification = selectedCurrentEpisode ? getVerification(String(selectedCurrentEpisode.request_id)) : undefined
    const inferredSuccessorRequestId = !explicitSuccessorRequestId && selectedCurrentVerification
      && selectedCurrentVerification.state === "failed"
      && String(selectedCurrentVerification.repair_id || "") === repairId
      && String(selectedCurrentVerification.predecessor_request_id || "") !== ""
      ? String(selectedCurrentEpisode!.request_id)
      : ""
    const successorRequestId = explicitSuccessorRequestId || inferredSuccessorRequestId
    const successorStoredVerification = successorRequestId ? getVerification(successorRequestId) : undefined
    const baseIsFailedSuccessor = baseRequestId === successorRequestId && successorStoredVerification?.state === "failed"
    const auditRows = audits.all(repairId) as SqlRow[]
    const firstBeginAudit = auditRows.find((audit) => String(audit.action) === "begin")
    const firstAuditedRequestId = firstBeginAudit ? migrationText(parseRecord(firstBeginAudit.evidence_json).requestId) : ""
    const baseRequestAppearsInAudits = auditRows.some((audit) => String(audit.action) === "begin"
      && migrationText(parseRecord(audit.evidence_json).requestId) === baseRequestId)
    let activeEpisodeId = baseEpisodeId
    let activeClassification = row.classification === null || row.classification === undefined ? null : String(row.classification)
    let codeRounds = 0
    let ambiguousCodeEvidence = false
    const transientEpisodeIds = new Set<string>()

    for (const audit of auditRows) {
      const evidence = parseRecord(audit.evidence_json)
      if (String(audit.action) === "begin") {
        const previousEpisodeId = activeEpisodeId
        const requestId = typeof evidence.requestId === "string" && evidence.requestId.length > 0 ? evidence.requestId : baseRequestId
        const requestSha256 = typeof evidence.requestSha256 === "string" && /^[0-9a-f]{64}$/i.test(evidence.requestSha256)
          ? evidence.requestSha256
          : requestId === baseRequestId ? baseEvidence.requestSha256 : ""
        const historicalEvidence = evidenceFor(requestId, {
          requestSha256: requestSha256 || baseEvidence.requestSha256,
          integrationHead: baseEvidence.integrationHead,
          integrationTree: baseEvidence.integrationTree,
          canonicalGates: baseEvidence.canonicalGates,
          state: String(row.state),
        })
        const classification = typeof evidence.classification === "string" && evidence.classification.length > 0 ? evidence.classification : activeClassification
        activeClassification = classification
        activeEpisodeId = episodeByRequest.get(requestId) ?? ensureEpisode(
          historicalEvidence,
          classification,
          String(row.state),
          String(audit.operation_id),
          String(audit.payload_sha256),
        )
        const preserveBaseEpisode = previousEpisodeId === baseEpisodeId
          && firstAuditedRequestId !== baseRequestId && baseRequestAppearsInAudits && requestId !== baseRequestId
        if (activeEpisodeId !== previousEpisodeId
          && !(baseIsFailedSuccessor && previousEpisodeId === baseEpisodeId)
          && !preserveBaseEpisode) episodeClose.run("failed", now, now, previousEpisodeId)
      }
      if (String(audit.action) === "commit") {
        if (activeClassification === "code_defect") codeRounds += 1
        else if (activeClassification !== "transient" && activeClassification !== "manifest_error"
          && activeClassification !== "design_ambiguity" && activeClassification !== "scope_ambiguity"
          && activeClassification !== "credential" && activeClassification !== "product_ambiguity") ambiguousCodeEvidence = true
        if (activeClassification === "transient") transientEpisodeIds.add(activeEpisodeId)
      }
    }

    let currentEpisodeId = activeEpisodeId
    let currentRequestId = baseRequestId
    let currentRequestSha256 = baseEvidence.requestSha256
    let currentClassification: string | null = row.classification === null || row.classification === undefined ? null : String(row.classification)
    let currentState = validStates.has(String(row.state)) ? String(row.state) : "failed"
    let failedSuccessorProjection: SelectedFailedSuccessorProjection | null = null
    let failedSuccessorState: "failed" | "paused" = "failed"

    if (successorRequestId && successorStoredVerification) {
      if (activeClassification === "transient" || row.classification === "transient") transientEpisodeIds.add(episodeByRequest.get(baseRequestId) ?? baseEpisodeId)
      const durableSuccessorEvidence = migrationSuccessorEvidence(row, successorStoredVerification, successorRequestId)
      if (!durableSuccessorEvidence) fail(`Cannot migrate integration repair ${repairId}: successor evidence is inconsistent`)
      const successorEvidence = {
        ...durableSuccessorEvidence,
        state: stateForVerification(successorStoredVerification.state, String(row.state)),
      }
      // A new unclassified episode is opened only after the successor has
      // durably failed. An in-flight successor still belongs to its
      // predecessor episode until verification records its outcome.
      if (successorStoredVerification.state === "failed") {
        const predecessorEpisode = selectedCurrentEpisode
          && migrationText(selectedCurrentEpisode.request_id) === baseRequestId
          && baseRequestId !== successorRequestId
        const selection = selectedCurrentEpisodeId && !predecessorEpisode
          ? validateFailedSuccessorEpisode(selectedCurrentEpisode, repairId, durableSuccessorEvidence)
          : { kind: "unselected", evidence: durableSuccessorEvidence, state: "failed" } as const
        if (selection.kind === "invalid") fail(`Cannot migrate integration repair ${repairId}: ${selection.reason}`)
        failedSuccessorProjection = selection.kind === "selected" ? selection.projection : null
        if (selection.kind === "unselected") failedSuccessorState = selection.state
        const successorEpisodeId = ensureEpisode(successorEvidence, null, "failed", null, null)
        episodeByRequest.set(successorRequestId, successorEpisodeId)
        episodeEvidence.set(successorEpisodeId, successorEvidence)
        if (currentEpisodeId !== successorEpisodeId) episodeClose.run("failed", now, now, currentEpisodeId)
        activeEpisodeId = successorEpisodeId
        currentEpisodeId = successorEpisodeId
        currentRequestId = successorEvidence.requestId
        currentRequestSha256 = successorEvidence.requestSha256
        currentClassification = failedSuccessorProjection?.classification ?? null
        currentState = failedSuccessorProjection?.state ?? "failed"
      } else if (successorStoredVerification.state === "passed") {
        currentState = "passed"
      } else {
        currentState = "verifying"
      }
    }

    if (ambiguousCodeEvidence || (codeRounds === 0 && row.current_commit !== null && row.current_commit !== undefined && auditRows.length === 0)) codeRounds = 3
    const existingCodeRounds = Number(row.accepted_code_rounds ?? 0)
    const acceptedCodeRounds = Math.min(3, Math.max(existingCodeRounds, codeRounds))
    for (const episodeId of transientEpisodeIds) {
      const evidence = episodeEvidence.get(episodeId) ?? (() => {
        const existing = episodeSelect.get(episodeId) as SqlRow | undefined
        if (!existing) return undefined
        return {
          requestId: String(existing.request_id),
          requestSha256: String(existing.request_sha256),
          integrationHead: String(existing.integration_head),
          integrationTree: String(existing.integration_tree),
          canonicalGates: parseGates(String(existing.canonical_gates_json)),
          canonicalGatesSha256: String(existing.canonical_gates_sha256),
          state: String(existing.state),
        }
      })()
      if (evidence) {
        const transientEvidenceSha256 = sha256(stableJson({
          integrationHead: evidence.integrationHead,
          integrationTree: evidence.integrationTree,
          canonicalGatesSha256: evidence.canonicalGatesSha256,
        }))
        episodeUse.run(transientEvidenceSha256, now, episodeId)
      }
    }

    // Bind audits to the episode that was active when each operation happened.
    activeEpisodeId = episodeByRequest.get(baseRequestId) ?? baseEpisodeId
    for (const audit of auditRows) {
      const evidence = parseRecord(audit.evidence_json)
      if (String(audit.action) === "begin") {
        const requestId = typeof evidence.requestId === "string" ? evidence.requestId : baseRequestId
        activeEpisodeId = episodeByRequest.get(requestId) ?? activeEpisodeId
      }
      if (String(audit.episode_id || "") !== activeEpisodeId) auditEpisode.run(activeEpisodeId, audit.audit_id)
    }

    // Audit replay has rebuilt the selected episode; bind the mutable projection to it before strict validation.
    const reconstructedCurrentEpisode = episodeSelect.get(currentEpisodeId) as SqlRow | undefined
    if (!reconstructedCurrentEpisode) fail(`Cannot migrate integration repair ${repairId}: reconstructed current episode is missing`)
    currentRequestId = migrationText(reconstructedCurrentEpisode.request_id)
    currentRequestSha256 = migrationText(reconstructedCurrentEpisode.request_sha256)
    currentClassification = reconstructedCurrentEpisode.classification === null || reconstructedCurrentEpisode.classification === undefined
      ? null
      : String(reconstructedCurrentEpisode.classification)

    const failedSuccessor = successorRequestId.length > 0 && successorStoredVerification?.state === "failed"
    repairUpdate.run(
      acceptedCodeRounds,
      currentEpisodeId,
      currentRequestId,
      currentRequestSha256,
      failedSuccessorProjection?.classification ?? currentClassification,
      failedSuccessorProjection?.state ?? (failedSuccessor ? failedSuccessorState : currentState),
      failedSuccessorProjection?.operationId ?? (failedSuccessor ? null : row.operation_id === null || row.operation_id === undefined ? null : String(row.operation_id)),
      failedSuccessorProjection?.operationPayloadSha256 ?? (failedSuccessor ? null : row.operation_payload_sha256 === null || row.operation_payload_sha256 === undefined ? null : String(row.operation_payload_sha256)),
      now,
      repairId,
    )
  }
  // The canonical episodes now exist, so enforce the exact awaiting predecessor contract.
  validateFailedSuccessorMigration(database, true)
  database.exec("PRAGMA user_version = 16;")
}

function applySchema18(database: Database): void {
  const unsupported = database.prepare("SELECT 1 FROM manager_attention_requests WHERE state = 'delegated' LIMIT 1").get()
  if (unsupported) fail("Unsupported persisted attention state 'delegated'; operator intervention or a fresh run database is required")

  database.exec("CREATE TEMP TABLE schema18_attention_sequence AS SELECT seq FROM sqlite_sequence WHERE name = 'manager_attention_requests' LIMIT 1")
  database.exec(`
    CREATE TABLE manager_attention_requests_v18 (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES manager_runs(run_id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 6),
      action_id TEXT,
      request_sha256 TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('plan_recovery', 'user_decision', 'operator_attention')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'awaiting_input', 'editing', 'resolved')),
      cause TEXT NOT NULL,
      detail TEXT NOT NULL,
      detail_sha256 TEXT NOT NULL,
      continuation_role TEXT NOT NULL,
      continuation_phase TEXT NOT NULL,
      question TEXT,
      recommended_action TEXT,
      recovery_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    INSERT INTO manager_attention_requests_v18 (
      sequence, request_id, run_id, plan_id, generation, round_number, action_id, request_sha256,
      kind, state, cause, detail, detail_sha256, continuation_role, continuation_phase, question,
      recommended_action, recovery_json, created_at, updated_at, resolved_at
    ) SELECT
      sequence, request_id, run_id, plan_id, generation, round_number, action_id, request_sha256,
      kind, state, cause, detail, detail_sha256, continuation_role, continuation_phase, question,
      recommended_action, recovery_json, created_at, updated_at, resolved_at
    FROM manager_attention_requests;
    DROP TABLE manager_attention_requests;
    ALTER TABLE manager_attention_requests_v18 RENAME TO manager_attention_requests;
    CREATE INDEX manager_attention_requests_run_state
      ON manager_attention_requests(run_id, state, plan_id, sequence);
    CREATE UNIQUE INDEX manager_attention_requests_unresolved_identity
      ON manager_attention_requests(run_id, plan_id, generation, cause)
      WHERE state <> 'resolved';
    DELETE FROM sqlite_sequence WHERE name = 'manager_attention_requests';
    INSERT INTO sqlite_sequence (name, seq)
      SELECT 'manager_attention_requests', seq FROM schema18_attention_sequence;
    DROP TABLE schema18_attention_sequence;
  `)
  database.exec("PRAGMA user_version = 18;")
}

/** Repair schema-16 rows whose selected failed-successor episode survived but whose mutable projection did not. */
function applySchema17(database: Database): void {
  validateFailedSuccessorMigration(database)
  const repairRows = database.prepare("SELECT * FROM manager_integration_repairs ORDER BY repair_id").all() as SqlRow[]
  const verificationRows = new Map<string, SqlRow | undefined>()
  const verification = database.prepare(`
    SELECT request_id, run_id, generation, graph_sha256, run_assignment_sha256, request_sha256, integration_head, integration_tree,
      predecessor_request_id, repair_id, repair_round, state, manifest_json, manifest_sha256
    FROM manager_verifications WHERE request_id = ?
  `)
  const getVerification = (requestId: string): SqlRow | undefined => {
    if (!verificationRows.has(requestId)) verificationRows.set(requestId, verification.get(requestId) as SqlRow | undefined)
    return verificationRows.get(requestId)
  }
  const episodeSelect = database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?")
  const repairUpdate = database.prepare(`
    UPDATE manager_integration_repairs
    SET request_id = ?, request_sha256 = ?, classification = ?, state = ?, operation_id = ?, operation_payload_sha256 = ?, updated_at = ?
    WHERE repair_id = ?
  `)
  for (const row of repairRows) {
    const repairId = migrationText(row.repair_id)
    const explicitSuccessorRequestId = migrationText(row.successor_request_id)
    const currentEpisodeId = migrationText(row.current_episode_id)
    const currentEpisode = currentEpisodeId ? episodeSelect.get(currentEpisodeId) as SqlRow | undefined : undefined
    const currentVerification = currentEpisode ? getVerification(migrationText(currentEpisode.request_id)) : undefined
    const inferredSuccessorRequestId = !explicitSuccessorRequestId && currentEpisode && currentVerification
      && migrationText(currentVerification.repair_id) === repairId
      && migrationText(currentVerification.predecessor_request_id)
      ? migrationText(currentEpisode.request_id)
      : ""
    const successorRequestId = explicitSuccessorRequestId || inferredSuccessorRequestId
    if (!successorRequestId) continue
    const verificationRow = getVerification(successorRequestId)
    if (!verificationRow) fail(`Cannot migrate integration repair ${repairId}: successor verification is missing`)
    if (migrationText(verificationRow.state) !== "failed") continue
    const successorEvidence = migrationSuccessorEvidence(row, verificationRow, successorRequestId)
    if (!successorEvidence) fail(`Cannot migrate integration repair ${repairId}: successor evidence is inconsistent`)
    const selection = validateFailedSuccessorEpisode(currentEpisode, repairId, successorEvidence)
    if (selection.kind === "invalid") fail(`Cannot migrate integration repair ${repairId}: ${selection.reason}`)
    const projection = selection.kind === "selected" ? selection.projection : null
    const fallbackState = selection.kind === "unselected" ? selection.state : "failed"
    const rowClassification = row.classification === null || row.classification === undefined ? null : String(row.classification)
    const rowState = row.state === null || row.state === undefined ? null : String(row.state)
    const rowOperationId = row.operation_id === null || row.operation_id === undefined ? null : String(row.operation_id)
    const rowOperationPayloadSha256 = row.operation_payload_sha256 === null || row.operation_payload_sha256 === undefined ? null : String(row.operation_payload_sha256)
    if (!projection) {
      if (rowClassification !== null || rowState !== fallbackState || rowOperationId !== null || rowOperationPayloadSha256 !== null
        || String(row.request_id) !== successorEvidence.requestId || String(row.request_sha256).toLowerCase() !== successorEvidence.requestSha256.toLowerCase()) {
        repairUpdate.run(successorEvidence.requestId, successorEvidence.requestSha256, null, fallbackState, null, null, new Date().toISOString(), repairId)
      }
      continue
    }
    if (String(row.request_id) === projection.requestId && String(row.request_sha256).toLowerCase() === projection.requestSha256.toLowerCase()
      && rowClassification === projection.classification && rowState === projection.state
      && rowOperationId === projection.operationId && rowOperationPayloadSha256 === projection.operationPayloadSha256) continue
    repairUpdate.run(
      projection.requestId,
      projection.requestSha256,
      projection.classification,
      projection.state,
      projection.operationId,
      projection.operationPayloadSha256,
      new Date().toISOString(),
      repairId,
    )
  }
  database.exec("PRAGMA user_version = 17;")
}

function ensureLegacyFingerprintVersion(database: Database): void {
  const columns = database.prepare("PRAGMA table_info(manager_plan_specs)").all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === "fingerprint_version")) {
    database.exec("ALTER TABLE manager_plan_specs ADD COLUMN fingerprint_version INTEGER NOT NULL DEFAULT 1 CHECK (fingerprint_version IN (1, 2));")
  }
}

function applySchema10(database: Database): void {
  const columns = database.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === "nested_usage_json")) {
    database.exec("ALTER TABLE attempts ADD COLUMN nested_usage_json TEXT;")
  }
  database.exec("PRAGMA user_version = 10;")
}

function applySchema11(database: Database): void {
  database.exec(SCHEMA_11_TABLES)
  database.exec("PRAGMA user_version = 11;")
}

function applySchema12(database: Database): void {
  const columns = database.prepare("PRAGMA table_info(manager_reignite_requests)").all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === "allocated_plan_directory")) {
    database.exec("ALTER TABLE manager_reignite_requests ADD COLUMN allocated_plan_directory TEXT;")
  }
  if (!columns.some((column) => column.name === "detail")) {
    database.exec("ALTER TABLE manager_reignite_requests ADD COLUMN detail TEXT;")
  }
  const operationsSql = String((database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'manager_operations'").get() as { sql?: string } | undefined)?.sql || "")
  if (operationsSql && !operationsSql.includes("'reignite'")) {
    database.exec(`
      CREATE TABLE manager_operations_v12 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('start', 'event', 'edit', 'stop', 'verification', 'reignite')),
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
      INSERT INTO manager_operations_v12 (
        sequence, operation_id, kind, payload_json, payload_sha256, state, attempt_count,
        result_json, error, accepted_at, started_at, finished_at, updated_at
      ) SELECT
        sequence, operation_id, kind, payload_json, payload_sha256, state, attempt_count,
        result_json, error, accepted_at, started_at, finished_at, updated_at
      FROM manager_operations;
      DROP TABLE manager_operations;
      ALTER TABLE manager_operations_v12 RENAME TO manager_operations;
      CREATE INDEX IF NOT EXISTS manager_operations_state_sequence ON manager_operations(state, sequence);
    `)
  }
  database.exec("PRAGMA user_version = 12;")
}

function applySchema13(database: Database): void {
  database.exec(SCHEMA_13_TABLES)
  const verificationColumns = database.prepare("PRAGMA table_info(manager_verifications)").all() as Array<{ name: string }>
  const addVerificationColumn = (name: string, definition: string): void => {
    if (!verificationColumns.some((column) => column.name === name)) database.exec(`ALTER TABLE manager_verifications ADD COLUMN ${name} ${definition};`)
  }
  addVerificationColumn("predecessor_request_id", "TEXT")
  addVerificationColumn("repair_id", "TEXT")
  addVerificationColumn("repair_round", "INTEGER")

  const operationsSql = String((database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'manager_operations'").get() as { sql?: string } | undefined)?.sql || "")
  if (operationsSql && (!operationsSql.includes("'integration_repair'") || !operationsSql.includes("'repair'"))) {
    database.exec(`
      CREATE TABLE manager_operations_v13 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('start', 'event', 'edit', 'stop', 'verification', 'reignite', 'integration_repair', 'repair')),
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
      INSERT INTO manager_operations_v13 (
        sequence, operation_id, kind, payload_json, payload_sha256, state, attempt_count,
        result_json, error, accepted_at, started_at, finished_at, updated_at
      ) SELECT
        sequence, operation_id, kind, payload_json, payload_sha256, state, attempt_count,
        result_json, error, accepted_at, started_at, finished_at, updated_at
      FROM manager_operations;
      DROP TABLE manager_operations;
      ALTER TABLE manager_operations_v13 RENAME TO manager_operations;
      CREATE INDEX IF NOT EXISTS manager_operations_state_sequence ON manager_operations(state, sequence);
    `)
  }
  database.exec("PRAGMA user_version = 13;")
}

function applySchema14(database: Database): void {
  const columns = database.prepare("PRAGMA table_info(manager_integration_repairs)").all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === "begin_ref_snapshot_json")) {
    database.exec("ALTER TABLE manager_integration_repairs ADD COLUMN begin_ref_snapshot_json TEXT;")
  }
  if (!columns.some((column) => column.name === "begin_ref_snapshot_sha256")) {
    database.exec("ALTER TABLE manager_integration_repairs ADD COLUMN begin_ref_snapshot_sha256 TEXT;")
  }
  database.exec("PRAGMA user_version = 14;")
}

function withSchemaMigrationTransaction(database: Database, migration: () => void): void {
  database.exec("BEGIN IMMEDIATE")
  try {
    migration()
    database.exec("COMMIT")
  } catch (error) {
    try { database.exec("ROLLBACK") } catch {}
    throw error
  }
}

function initializeSchema(database: Database, { allowInitialize = true }: { allowInitialize?: boolean } = {}): void {
  const row = database.prepare("PRAGMA user_version").get() as SqlRow
  const version = Number(row.user_version)
  if (version === EXECUTION_SCHEMA_VERSION) return
  if ((version === 16 || version === 15 || version === 14 || version === 13) && !allowInitialize) return
  if (version === 6 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
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
        ${SCHEMA_9_TABLES}
      `)
      applySchema10(database)
      applySchema11(database)
      applySchema12(database)
      applySchema13(database)
      applySchema14(database)
      applySchema15(database)
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
      return
    })
  }
  if (version === 7 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      ensureLegacyFingerprintVersion(database)
      database.exec(SCHEMA_9_TABLES)
      applySchema10(database)
      applySchema11(database)
      applySchema12(database)
      applySchema13(database)
      applySchema14(database)
      applySchema15(database)
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
      return
    })
  }
  if (version === 8 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      database.exec(SCHEMA_9_TABLES)
      applySchema10(database)
      applySchema11(database)
      applySchema12(database)
      applySchema13(database)
      applySchema14(database)
      applySchema15(database)
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
      return
    })
  }
  if (version === 9 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      applySchema10(database)
      applySchema11(database)
      applySchema12(database)
      applySchema13(database)
      applySchema14(database)
      applySchema15(database)
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
      return
    })
  }
  if (version === 10 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      applySchema11(database)
      applySchema12(database)
      applySchema13(database)
      applySchema14(database)
      applySchema15(database)
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
      return
    })
  }
  if (version === 11 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      applySchema12(database)
      applySchema13(database)
      applySchema14(database)
      applySchema15(database)
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
      return
    })
  }
  if (version === 12 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      applySchema13(database)
      applySchema14(database)
      applySchema15(database)
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
      return
    })
  }
  if (version === 13 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      applySchema14(database)
      applySchema15(database)
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
    })
  }
  if (version === 14 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      applySchema15(database)
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
    })
  }
  if (version === 15 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      applySchema16(database)
      applySchema17(database)
      applySchema18(database)
    })
  }
  if (version === 16 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      applySchema17(database)
      applySchema18(database)
    })
  }
  if (version === 17 && allowInitialize) {
    return withSchemaMigrationTransaction(database, () => {
      applySchema18(database)
    })
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
        nested_usage_json TEXT,
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
      ${SCHEMA_9_TABLES}
      ${SCHEMA_11_TABLES}
  `)
  applySchema12(database)
  applySchema13(database)
  applySchema14(database)
  applySchema15(database)
  applySchema16(database)
  applySchema17(database)
  applySchema18(database)
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
  let databaseStat = lstatIfPresent(databasePath)
  if (!databaseStat && !create) return null
  if (!databaseStat && readOnly) return null

  let runtimeStat = lstatIfPresent(runtimeDirectory)
  if (!runtimeStat) {
    // A query-only open must never create or repair runtime state. A database
    // cannot normally outlive its parent directory, but keep this explicit for
    // callers that point at a damaged or concurrently changing tree.
    if (readOnly) return null
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: PRIVATE_RUNTIME_DIRECTORY_MODE })
    runtimeStat = lstatIfPresent(runtimeDirectory)
  }
  if (!runtimeStat) fail(`Execution runtime path could not be created: ${runtimeDirectory}`)
  assertDirectory(runtimeDirectory, runtimeStat, "Execution runtime path")

  const markerPath = executionRotationMarkerPath(planDir)
  let markerStat = validateRotationMarker(markerPath, { readOnly })
  if (!databaseStat && readOnly) return null
  if (!databaseStat && !create) return null

  if (!readOnly) {
    const initialRuntimeStat = runtimeStat
    const initialDatabaseStat = databaseStat
    const initialRuntimeExposed = !ownerOnlyMode(initialRuntimeStat)
    const initialDatabaseExposed = initialDatabaseStat ? !ownerOnlyMode(initialDatabaseStat) : false
    const initialRuntimeMode = initialRuntimeStat.mode & 0o7777
    const publication: RotationPublicationState = { currentEpochDurable: false }
    let runtimeRollback: { expected: fs.Stats; mode: number } | undefined

    const repair = (epochHeld: boolean): void => {
      try {
        const currentRuntime = lstatIfPresent(runtimeDirectory)
        if (!currentRuntime) fail(`Execution runtime path disappeared during repair: ${runtimeDirectory}`)
        assertDirectory(runtimeDirectory, currentRuntime, "Execution runtime path")
        if (!sameFileIdentity(initialRuntimeStat, currentRuntime)) {
          fail(`Execution runtime path changed during repair: ${runtimeDirectory}`)
        }

        const runtimeExposed = !ownerOnlyMode(currentRuntime)
        const runtimeNeedsRepair = !canonicalPrivateMode(currentRuntime, PRIVATE_RUNTIME_DIRECTORY_MODE)
        if (!epochHeld && (initialRuntimeExposed || initialDatabaseExposed || runtimeExposed)) {
          throw new RotationEpochRequired()
        }
        if (runtimeExposed || runtimeNeedsRepair) {
          runtimeRollback = { expected: currentRuntime, mode: currentRuntime.mode & 0o7777 }
          runtimeStat = enforcePrivateMode(runtimeDirectory, currentRuntime, PRIVATE_RUNTIME_DIRECTORY_MODE, "Execution runtime path", true)
        } else {
          runtimeStat = currentRuntime
        }

        let currentDatabase = lstatIfPresent(databasePath)
        if (!currentDatabase) {
          if (initialDatabaseStat) fail(`Execution database disappeared during repair: ${databasePath}`)
          createDatabaseFile(databasePath)
          currentDatabase = lstatIfPresent(databasePath)
        }
        if (!currentDatabase) fail(`Execution database could not be created: ${databasePath}`)
        assertRegularFile(databasePath, currentDatabase, "Execution database path")

        let databaseReplaced = Boolean(initialDatabaseStat && !sameFileIdentity(initialDatabaseStat, currentDatabase))
        let databaseExposed = !ownerOnlyMode(currentDatabase)
        let rotationRequired = initialRuntimeExposed || initialDatabaseExposed || runtimeExposed || databaseExposed || databaseReplaced

        // The database is re-statted after the parent is secured. A pathname
        // replacement is a fresh authority exposure, even when its replacement
        // happens to start with private permissions.
        if (rotationRequired) {
          if (!epochHeld) throw new RotationEpochRequired()
          createRotationMarker(markerPath, publication)
          markerStat = lstatIfPresent(markerPath)
          if (!markerStat) fail(`Execution rotation marker disappeared during repair: ${markerPath}`)
        }

        const revalidatedDatabase = lstatIfPresent(databasePath)
        if (!revalidatedDatabase) fail(`Execution database disappeared during repair: ${databasePath}`)
        assertRegularFile(databasePath, revalidatedDatabase, "Execution database path")
        databaseReplaced = databaseReplaced || !sameFileIdentity(currentDatabase, revalidatedDatabase)
        databaseExposed = !ownerOnlyMode(revalidatedDatabase)
        if ((databaseReplaced || databaseExposed) && !rotationRequired) {
          if (!epochHeld) throw new RotationEpochRequired()
          createRotationMarker(markerPath, publication)
          markerStat = lstatIfPresent(markerPath)
          if (!markerStat) fail(`Execution rotation marker disappeared during repair: ${markerPath}`)
          rotationRequired = true
        }

        if (databaseExposed || !canonicalPrivateMode(revalidatedDatabase, PRIVATE_RUNTIME_FILE_MODE)) {
          databaseStat = enforcePrivateMode(databasePath, revalidatedDatabase, PRIVATE_RUNTIME_FILE_MODE, "Execution database path", false)
        } else {
          databaseStat = revalidatedDatabase
        }

        if (!rotationRequired && markerStat) {
          markerStat = enforcePrivateMode(markerPath, markerStat, PRIVATE_RUNTIME_FILE_MODE, "Execution rotation marker", false)
        }
      } catch (error) {
        // Pathname visibility is not durability. Once a reservation or fresh
        // marker directory entry is durable, the current database inode may be
        // repaired even if the richer marker publication cannot finish.
        if (publication.currentEpochDurable && (initialDatabaseExposed || initialRuntimeExposed)) {
          try {
            const currentDatabase = lstatIfPresent(databasePath)
            if (currentDatabase) {
              assertRegularFile(databasePath, currentDatabase, "Execution database path")
              databaseStat = enforcePrivateMode(databasePath, currentDatabase, PRIVATE_RUNTIME_FILE_MODE, "Execution database path", false)
            }
          } catch {}
        }
        if (!publication.currentEpochDurable) {
          const rollback = runtimeRollback ?? (initialRuntimeExposed
            ? { expected: initialRuntimeStat, mode: initialRuntimeMode }
            : undefined)
          if (rollback) {
            try { enforcePrivateMode(runtimeDirectory, rollback.expected, rollback.mode, "Execution runtime path", true) } catch {}
          }
        }
        throw error
      }
    }
    const requiresEpoch = initialRuntimeExposed
      || initialDatabaseExposed
      || !canonicalPrivateMode(initialRuntimeStat, PRIVATE_RUNTIME_DIRECTORY_MODE)
      || Boolean(initialDatabaseStat && !canonicalPrivateMode(initialDatabaseStat, PRIVATE_RUNTIME_FILE_MODE))
    if (requiresEpoch) {
      withRotationEpochLock(planDir, () => repair(true))
    } else {
      try {
        repair(false)
      } catch (error) {
        if (!(error instanceof RotationEpochRequired)) throw error
        // Initial private modes are only a snapshot. If revalidation discovers
        // exposure or inode replacement, restart the untouched fast path under
        // the same cross-process epoch used by authority handoff.
        withRotationEpochLock(planDir, () => repair(true))
      }
    }
  } else {
    assertDirectory(runtimeDirectory, runtimeStat, "Execution runtime path")
    if (!canonicalPrivateMode(runtimeStat, PRIVATE_RUNTIME_DIRECTORY_MODE)) {
      fail(`Execution runtime path must be owner-only with mode 0700 for read-only access: ${runtimeDirectory}`)
    }
    if (!databaseStat) return null
    assertRegularFile(databasePath, databaseStat, "Execution database path")
    if (!canonicalPrivateMode(databaseStat, PRIVATE_RUNTIME_FILE_MODE)) {
      fail(`Execution database path must be owner-only with mode 0600 for read-only access: ${databasePath}`)
    }
  }

  if (!databaseStat) fail(`Execution database could not be created: ${databasePath}`)
  const expectedDatabase = databaseStat
  const { DatabaseSync } = sqliteApi()
  const database = new DatabaseSync(databasePath, { readOnly })
  try {
    const identity = fs.lstatSync(databasePath)
    assertRegularFile(databasePath, identity, "Execution database path")
    if (!sameFileIdentity(expectedDatabase, identity)) {
      fail(`Execution database changed while it was being opened: ${databasePath}`)
    }
    configureDatabase(database, { readOnly })
    initializeSchema(database, { allowInitialize: !readOnly })
    const currentIdentity = fs.lstatSync(databasePath)
    assertRegularFile(databasePath, currentIdentity, "Execution database path")
    if (!sameFileIdentity(expectedDatabase, currentIdentity)) {
      fail(`Execution database changed while it was being opened: ${databasePath}`)
    }
    const lastCheck = HEALTHY_DATABASES.get(databasePath)
    if (!lastCheck
      || lastCheck.dev !== currentIdentity.dev
      || lastCheck.ino !== currentIdentity.ino
      || Date.now() - lastCheck.checkedAt >= HEALTH_CHECK_INTERVAL_MS) {
      assertHealthy(database, databasePath)
      if (HEALTHY_DATABASES.size >= 256) HEALTHY_DATABASES.delete(HEALTHY_DATABASES.keys().next().value!)
      HEALTHY_DATABASES.set(databasePath, { dev: currentIdentity.dev, ino: currentIdentity.ino, checkedAt: Date.now() })
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

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

function nestedSliceKey(slice: NestedUsageRecord): string {
  return [slice.type, slice.model, slice.effort, slice.serviceTier ?? ""].join("\0")
}

function normalizeNestedUsageRecords(value: unknown): NestedUsageRecord[] {
  if (value === undefined || value === null || value === "") return []
  let parsed = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) } catch (error) {
      fail(`Nested usage JSON is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!Array.isArray(parsed)) fail("Nested usage must be an array")
  const slices = parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`Nested usage slice ${index} must be an object`)
    const record = item as Record<string, unknown>
    const unknownFields = Object.keys(record).filter((field) => ![
      "type", "model", "effort", "serviceTier", "service_tier", "count",
      "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "durationMs",
    ].includes(field))
    if (unknownFields.length) fail(`Nested usage slice ${index} has unknown fields: ${unknownFields.join(", ")}`)
    const count = optionalCount(record.count, `Nested usage slice ${index} count`)
    if (count === null || count < 1) fail(`Nested usage slice ${index} has an invalid count`)
    const slice: NestedUsageRecord = {
      type: requiredText(record.type, `Nested usage slice ${index} type`),
      model: requiredText(record.model, `Nested usage slice ${index} model`),
      effort: requiredText(record.effort, `Nested usage slice ${index} effort`),
      count,
      inputTokens: optionalCount(record.inputTokens, `Nested usage slice ${index} input tokens`),
      cachedInputTokens: optionalCount(record.cachedInputTokens, `Nested usage slice ${index} cached input tokens`),
      outputTokens: optionalCount(record.outputTokens, `Nested usage slice ${index} output tokens`),
      reasoningTokens: optionalCount(record.reasoningTokens, `Nested usage slice ${index} reasoning tokens`),
    }
    const serviceTier = optionalText(record.serviceTier ?? record.service_tier, `Nested usage slice ${index} service tier`)
    if (serviceTier) slice.serviceTier = serviceTier
    const durationMs = optionalCount(record.durationMs, `Nested usage slice ${index} duration milliseconds`)
    if (durationMs !== null) slice.durationMs = durationMs
    return slice
  })
  return slices.sort((left, right) => nestedSliceKey(left).localeCompare(nestedSliceKey(right), undefined, { numeric: true }))
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
    nestedUsage: normalizeNestedUsageRecords(input.nestedUsage ?? input.nested),
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
    nestedUsage: normalizeNestedUsageRecords(row.nested_usage_json),
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
  const database = openExecutionDatabase(planDir, { create: true })
  let recorded = false
  try {
    withExecutionTransaction(database, () => {
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
  const database = openExecutionDatabase(planDir, { readOnly: true })
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
  const database = openExecutionDatabase(planDir, { readOnly: true })
  if (!database) return { run: null, specs: [], plans: [], actions: [], generations: [], approvals: [], edit: null, verification: null, integrationRepair: null, attention: null, service: null }
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_runs'").get()
    if (!table) return { run: null, specs: [], plans: [], actions: [], generations: [], approvals: [], edit: null, verification: null, integrationRepair: null, attention: null, service: null }
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
    const repairTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_integration_repairs'").get()
    const repairColumns = repairTable
      ? new Set((database.prepare("PRAGMA table_info(manager_integration_repairs)").all() as Array<{ name: string }>).map((column) => column.name))
      : new Set<string>()
    const beginRefSnapshotColumn = repairColumns.has("begin_ref_snapshot_json") ? "begin_ref_snapshot_json" : "NULL AS begin_ref_snapshot_json"
    const beginRefSnapshotSha256Column = repairColumns.has("begin_ref_snapshot_sha256") ? "begin_ref_snapshot_sha256" : "NULL AS begin_ref_snapshot_sha256"
    const acceptedCodeRoundsColumn = repairColumns.has("accepted_code_rounds") ? "accepted_code_rounds" : "0 AS accepted_code_rounds"
    const currentEpisodeIdColumn = repairColumns.has("current_episode_id") ? "current_episode_id" : "NULL AS current_episode_id"
    const episodeTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_integration_repair_episodes'").get()
    const integrationRepair = run && repairTable ? database.prepare(`
      SELECT repair_id, generation, request_id, request_sha256, owner_session_id, classification, state,
        round_number, parent_commit, current_commit, current_tree, superseded_commits_json,
        ${acceptedCodeRoundsColumn}, ${currentEpisodeIdColumn},
        ${beginRefSnapshotColumn}, ${beginRefSnapshotSha256Column},
        canonical_gates_json, canonical_gates_sha256, effective_gates_json, successor_request_id,
        successor_request_sha256, successor_manifest_json, successor_manifest_sha256, detail, created_at, updated_at
      FROM manager_integration_repairs
      WHERE run_id = ? AND generation = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(run.run_id, run.current_generation) as SqlRow | undefined : undefined
    const currentEpisode = integrationRepair && episodeTable && integrationRepair.current_episode_id
      ? database.prepare("SELECT * FROM manager_integration_repair_episodes WHERE episode_id = ?").get(integrationRepair.current_episode_id) as SqlRow | undefined
      : undefined
    const currentEpisodeForRequest = integrationRepair && currentEpisode && currentEpisode.request_id === integrationRepair.request_id ? currentEpisode : undefined
    const transientRetryUsed = integrationRepair && currentEpisodeForRequest && episodeTable
      ? Boolean(database.prepare(`
          SELECT 1 FROM manager_integration_repair_episodes
          WHERE repair_id = ? AND transient_used = 1 AND integration_head = ? AND integration_tree = ? AND canonical_gates_sha256 = ?
          LIMIT 1
        `).get(integrationRepair.repair_id, currentEpisodeForRequest.integration_head, currentEpisodeForRequest.integration_tree, currentEpisodeForRequest.canonical_gates_sha256))
      : false
    const attentionTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'manager_attention_requests'").get()
    const attention = run && attentionTable ? database.prepare(`
      SELECT sequence, request_id, plan_id, generation, round_number, action_id, request_sha256,
        kind, state, cause, detail, detail_sha256, continuation_role,
        continuation_phase, question, recommended_action, recovery_json,
        created_at, updated_at, resolved_at
      FROM manager_attention_requests
      WHERE run_id = ? AND state <> 'resolved'
      ORDER BY plan_id COLLATE BINARY, sequence
      LIMIT 1
    `).get(run.run_id) as SqlRow | undefined : undefined
    let projectedAttention: Record<string, unknown> | null = null
    if (attention) {
      projectedAttention = {
        schemaVersion: 1,
        requestId: attention.request_id,
        runId: run!.run_id,
        planId: attention.plan_id,
        generation: attention.generation,
        round: attention.round_number,
        actionId: attention.action_id,
        requestSha256: attention.request_sha256,
        kind: attention.kind,
        state: attention.state,
        cause: attention.cause,
        detail: attention.detail,
        detailSha256: attention.detail_sha256,
        continuation: { role: attention.continuation_role, phase: attention.continuation_phase },
        ...(attention.question === null ? {} : { question: attention.question }),
        ...(attention.recommended_action === null ? {} : { recommendedAction: attention.recommended_action }),
        ...(attention.recovery_json === null ? {} : { recovery: parseJsonColumn<unknown>(attention.recovery_json, null) }),
        createdAt: attention.created_at,
        updatedAt: attention.updated_at,
        ...(attention.resolved_at === null ? {} : { resolvedAt: attention.resolved_at }),
      }
      validateAttentionRequest(projectedAttention)
    }
    const service = database.prepare(`
      SELECT instance_id, pid, port, dashboard_url, started_at
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
      integrationRepair: integrationRepair ? {
        repairId: integrationRepair.repair_id,
        generation: integrationRepair.generation,
        requestId: integrationRepair.request_id,
        requestSha256: integrationRepair.request_sha256,
        ownerSessionId: integrationRepair.owner_session_id || undefined,
        classification: integrationRepair.classification,
        episodeId: currentEpisodeForRequest?.episode_id ?? undefined,
        episodeState: currentEpisodeForRequest ? (currentEpisodeForRequest.classification ? currentEpisodeForRequest.state : "unclassified") : undefined,
        episodeRequestSha256: currentEpisodeForRequest?.request_sha256,
        episodeIntegrationHead: currentEpisodeForRequest?.integration_head,
        episodeIntegrationTree: currentEpisodeForRequest?.integration_tree,
        episodeCanonicalGatesSha256: currentEpisodeForRequest?.canonical_gates_sha256,
        acceptedCodeRounds: Number(integrationRepair.accepted_code_rounds ?? 0),
        transientRetryUsed,
        state: integrationRepair.state,
        round: integrationRepair.round_number,
        parentCommit: integrationRepair.parent_commit,
        currentCommit: integrationRepair.current_commit,
        currentTree: integrationRepair.current_tree,
        supersededCommits: parseJsonColumn(integrationRepair.superseded_commits_json, []),
        beginRefSnapshot: parseJsonColumn(integrationRepair.begin_ref_snapshot_json, null),
        beginRefSnapshotSha256: integrationRepair.begin_ref_snapshot_sha256,
        canonicalGates: parseJsonColumn(integrationRepair.canonical_gates_json, []),
        canonicalGatesSha256: integrationRepair.canonical_gates_sha256,
        effectiveGates: parseJsonColumn(integrationRepair.effective_gates_json, []),
        successorRequestId: integrationRepair.successor_request_id,
        successorRequestSha256: integrationRepair.successor_request_sha256,
        successorManifest: parseJsonColumn(integrationRepair.successor_manifest_json, null),
        successorManifestSha256: integrationRepair.successor_manifest_sha256,
        detail: integrationRepair.detail,
        createdAt: integrationRepair.created_at,
        updatedAt: integrationRepair.updated_at,
      } : null,
      attention: projectedAttention,
      service: service ? {
        instanceId: service.instance_id,
        pid: service.pid,
        port: service.port,
        dashboardUrl: service.dashboard_url,
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
      started_at, finished_at, duration_ms, nested_usage_json, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    record.nestedUsage.length ? JSON.stringify(record.nestedUsage) : null,
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

export function initializeExecutionStore(planDir: string) {
  const database = openExecutionDatabase(planDir, { create: true })
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
  return withExecutionTransaction(database, () => insertUsageRecordInDatabase(database, input))
}

export function recordUsageRecord(planDir: string, input: UsageRecordInput) {
  const database = openExecutionDatabase(planDir, { create: true })
  try {
    const stored = recordUsageRecordInDatabase(database, input)
    return { ...stored, records: readDatabaseRecords(database), database: executionDatabasePath(planDir) }
  } finally {
    database.close()
  }
}

export function readUsageState(planDir: string) {
  const databaseExists = fs.existsSync(executionDatabasePath(planDir))
  const database = openExecutionDatabase(planDir, { readOnly: true })
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

function addKnownTokens(group: { tokenAttempts: number; knownTokens: number }, inputTokens: number | null, outputTokens: number | null): void {
  if (inputTokens === null || outputTokens === null) return
  group.tokenAttempts += 1
  group.knownTokens += inputTokens + outputTokens
}

function summarizeByModel(records: UsageRecord[]) {
  const groups = new Map<string, { attempts: number; tokenAttempts: number; knownTokens: number }>()
  const take = (key: string) => {
    const group = groups.get(key) ?? { attempts: 0, tokenAttempts: 0, knownTokens: 0 }
    groups.set(key, group)
    return group
  }
  for (const record of records) {
    const parent = take(`${record.model} / ${record.effort}`)
    parent.attempts += 1
    addKnownTokens(parent, record.inputTokens, record.outputTokens)
    for (const slice of record.nestedUsage) {
      const child = take(`${slice.model} / ${slice.effort}`)
      child.attempts += slice.count
      addKnownTokens(child, slice.inputTokens, slice.outputTokens)
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([key, summary]) => ({ key, ...summary }))
}

function summarizeRecords(records: UsageRecord[], keyFor: (record: UsageRecord) => string) {
  const groups = new Map<string, { attempts: number; tokenAttempts: number; knownTokens: number }>()
  for (const record of records) {
    const key = keyFor(record)
    const group = groups.get(key) ?? { attempts: 0, tokenAttempts: 0, knownTokens: 0 }
    group.attempts += 1
    addKnownTokens(group, record.inputTokens, record.outputTokens)
    for (const slice of record.nestedUsage) addKnownTokens(group, slice.inputTokens, slice.outputTokens)
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
    byModel: summarizeByModel(records),
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
    for (const slice of record.nestedUsage) {
      inputTokens += slice.inputTokens ?? 0
      cachedInputTokens += slice.cachedInputTokens ?? 0
      outputTokens += slice.outputTokens ?? 0
      reasoningTokens += slice.reasoningTokens ?? 0
    }
    if (record.inputTokens !== null && record.outputTokens !== null) {
      tokenAttempts += 1
      reportedInputOutput += record.inputTokens + record.outputTokens
      for (const slice of record.nestedUsage) {
        if (slice.inputTokens !== null && slice.outputTokens !== null) reportedInputOutput += slice.inputTokens + slice.outputTokens
      }
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
    byModel: summarizeByModel(selected),
    byHarness: summarizeRecords(selected, (record) => record.harness ?? "unknown"),
    byGeneration: summarizeRecords(selected, (record) => record.generation ?? "unknown"),
    byServiceTier: summarizeRecords(selected, (record) => record.serviceTier ?? "unknown"),
    records: selected,
  }
}
