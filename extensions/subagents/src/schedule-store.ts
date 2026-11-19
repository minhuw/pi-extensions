/**
 * schedule-store.ts — File-backed store for scheduled subagents.
 *
 * Session-scoped: each pi session owns its own schedules at
 * `<cwd>/.pi/subagent-schedules/<sessionId>.json`. `/new` starts a fresh
 * empty store; `/resume` reloads.
 *
 * Concurrency model lifted from pi-chonky-tasks/src/task-store.ts: every
 * mutation acquires a PID-based exclusion lock, re-reads the latest state
 * from disk, applies the change, atomic-writes via temp+rename, releases.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ScheduledSubagent, ScheduleStoreData } from "./types.js";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_MAX_WAIT_MS = 1_500;
const DEFAULT_LOCK_RETRY_DELAY_MS = 5;
const MAX_LOCK_RETRY_DELAY_MS = 25;
const INVALID_LOCK_MAX_WAIT_MS = 50;
const MAX_STALE_RECOVERY_ATTEMPTS = 100;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export interface ScheduleLockOptions {
  /** Lock age in ms after which even a live-PID lock is treated as stale (default: 30_000). */
  staleMs?: number;
  /** Maximum time in ms to wait on a live foreign lock before throwing (default: 1_500). */
  maxWaitMs?: number;
  /** Base backoff delay in ms between retries (default: 5). */
  retryDelayMs?: number;
}

interface ParsedScheduleLock {
  pid: number;
  token?: string;
  ts?: number;
}

const activeLockTokens = new Set<string>();

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockContent(raw: string): ParsedScheduleLock | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const pid = Number.parseInt(trimmed, 10);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown; token?: unknown; ts?: unknown };
    if (!parsed || typeof parsed !== "object") return null;
    const pid = parsed.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    const token = typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : undefined;
    const ts = typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : undefined;
    return {
      pid,
      ...(token !== undefined ? { token } : {}),
      ...(ts !== undefined ? { ts } : {}),
    };
  } catch {
    return null;
  }
}

function readLockSnapshot(lockPath: string): { raw: string; mtimeMs: number } | undefined {
  let fd: number;
  try {
    fd = openSync(lockPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const st = fstatSync(fd);
    const raw = readFileSync(fd, "utf8");
    return { raw, mtimeMs: st.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function isLockStale(
  parsed: ParsedScheduleLock | null,
  mtimeMs: number,
  staleMs: number,
  nowMs: number,
): boolean {
  if (!parsed) {
    return nowMs - mtimeMs >= staleMs;
  }
  if (parsed.token && activeLockTokens.has(parsed.token)) {
    return false;
  }
  if (parsed.pid === process.pid) {
    return true;
  }
  if (!isProcessRunning(parsed.pid)) {
    return true;
  }
  const lockTs = parsed.ts ?? mtimeMs;
  return nowMs - lockTs >= staleMs;
}

function createLockExclusive(lockPath: string, token: string): void {
  const payload = JSON.stringify({ pid: process.pid, token, ts: Date.now() });
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  try {
    writeFileSync(fd, payload, "utf8");
  } catch (error) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
    throw error;
  }
  closeSync(fd);
}

function tryRecoverStaleLock(lockPath: string, staleMs: number): boolean {
  const claimPath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockPath, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Another contender already claimed or released the lock.
      return true;
    }
    throw error;
  }

  // Verify the claimed file is actually stale before deleting it.
  // Deleting claimPath never unlinks a fresh lock created at lockPath after our rename.
  try {
    const snapshot = readLockSnapshot(claimPath);
    if (!snapshot) return true;
    const parsed = parseLockContent(snapshot.raw);
    if (isLockStale(parsed, snapshot.mtimeMs, staleMs, Date.now())) {
      try {
        unlinkSync(claimPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return true;
    }
    // Claimed file turned out to be a fresh live lock that replaced lockPath right before our rename.
    // Restore it without clobbering any newer lock created at lockPath.
    try {
      linkSync(claimPath, lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        try {
          renameSync(claimPath, lockPath);
          return false;
        } catch {
          // Best-effort restore failed; clean up claimPath below.
        }
      }
    }
    try { unlinkSync(claimPath); } catch { /* ignore */ }
    return false;
  } catch (error) {
    try { unlinkSync(claimPath); } catch { /* ignore */ }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export function acquireLock(lockPath: string, options?: ScheduleLockOptions): string {
  const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS;
  const baseDelayMs = Math.max(1, options?.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS);
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  const invalidDeadline = startedAt + Math.min(maxWaitMs, INVALID_LOCK_MAX_WAIT_MS);
  const token = randomUUID();
  let attempt = 0;
  let recoveryAttempts = 0;

  while (true) {
    try {
      createLockExclusive(lockPath, token);
      activeLockTokens.add(token);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    let snapshot: { raw: string; mtimeMs: number } | undefined;
    try {
      snapshot = readLockSnapshot(lockPath);
    } catch {
      // unreadable lock: never unlink or rename what we can't prove stale
      throw new Error(`Schedule store lock is unreadable: ${lockPath}`);
    }
    if (!snapshot) {
      continue;
    }

    const parsed = parseLockContent(snapshot.raw);
    if (isLockStale(parsed, snapshot.mtimeMs, staleMs, Date.now()) && recoveryAttempts < MAX_STALE_RECOVERY_ATTEMPTS) {
      recoveryAttempts += 1;
      if (tryRecoverStaleLock(lockPath, staleMs)) {
        continue;
      }
    }

    if (!parsed) {
      // empty/garbage content may be the brief create-write race window, not staleness
      const invalidRemaining = invalidDeadline - Date.now();
      if (invalidRemaining <= 0) {
        throw new Error(`Schedule store lock has no valid PID: ${lockPath}`);
      }
      sleepSync(Math.min(invalidRemaining, baseDelayMs));
      attempt += 1;
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Schedule store is locked by live process ${parsed.pid}: ${lockPath}`);
    }

    const backoff = Math.min(MAX_LOCK_RETRY_DELAY_MS, baseDelayMs * Math.min(5, attempt + 1));
    const jitter = Math.floor(Math.random() * baseDelayMs);
    sleepSync(Math.min(remaining, backoff + jitter));
    attempt += 1;
  }
}

export function releaseLock(lockPath: string, token: string): void {
  activeLockTokens.delete(token);
  try {
    const snapshot = readLockSnapshot(lockPath);
    if (!snapshot) return;
    const parsed = parseLockContent(snapshot.raw);
    if (parsed && parsed.token === token && parsed.pid === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    /* ignore */
  }
}

/** Resolve the storage path for a session-scoped store. */
export function resolveStorePath(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", "subagent-schedules", `${sessionId}.json`);
}

export class ScheduleStore {
  private filePath: string;
  private lockPath: string;
  private jobs = new Map<string, ScheduledSubagent>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  /** Create the backing directory lazily — only when we're about to persist. */
  private ensureDir(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** Load from disk into the in-memory cache. Silent on parse errors. */
  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data: ScheduleStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.jobs.clear();
      for (const j of data.jobs ?? []) this.jobs.set(j.id, j);
    } catch { /* corrupt — start fresh, next save rewrites */ }
  }

  /** Atomic write via unique temp file + rename (POSIX-atomic). */
  private save(): void {
    const data: ScheduleStoreData = { version: 1, jobs: [...this.jobs.values()] };
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, this.filePath);
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /** Acquire lock → reload → mutate → save → release. */
  private withLock<T>(fn: () => T): T {
    this.ensureDir();
    const token = acquireLock(this.lockPath);
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath, token);
    }
  }

  /** Read-only — returns a snapshot of the in-memory cache. */
  list(): ScheduledSubagent[] {
    return [...this.jobs.values()];
  }

  /** Read-only check — uses the cache. */
  hasName(name: string, exceptId?: string): boolean {
    for (const j of this.jobs.values()) {
      if (j.id !== exceptId && j.name === name) return true;
    }
    return false;
  }

  get(id: string): ScheduledSubagent | undefined {
    return this.jobs.get(id);
  }

  add(job: ScheduledSubagent): void {
    this.withLock(() => {
      this.jobs.set(job.id, job);
    });
  }

  update(id: string, patch: Partial<ScheduledSubagent>): ScheduledSubagent | undefined {
    // No-op fast path — an unknown id changes nothing, so don't lock or touch
    // disk (which would otherwise lazily create the backing directory).
    if (!this.jobs.has(id)) return undefined;
    return this.withLock(() => {
      const existing = this.jobs.get(id);
      if (!existing) return undefined;
      const updated = { ...existing, ...patch };
      this.jobs.set(id, updated);
      return updated;
    });
  }

  remove(id: string): boolean {
    // No-op fast path — see update().
    if (!this.jobs.has(id)) return false;
    return this.withLock(() => this.jobs.delete(id));
  }

  /** Delete the backing file (used when no jobs remain, optional cleanup). */
  deleteFileIfEmpty(): void {
    if (this.jobs.size === 0 && existsSync(this.filePath)) {
      try { unlinkSync(this.filePath); } catch { /* ignore */ }
    }
  }
}
