/**
 * schedule-store-lock.test.ts — Regression tests for ScheduleStore locking:
 *   - Unique owner tokens in exclusive lockfiles
 *   - Atomic rename-verified stale-lock recovery under contention
 *   - Owner-verified release (refuses to delete a replaced lock)
 *   - Concurrent cross-process mutations preserve all jobs without orphan locks
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, releaseLock, ScheduleStore } from "../src/schedule-store.js";
import type { ScheduledSubagent } from "../src/types.js";

const scheduleStoreModuleUrl = new URL("../src/schedule-store.ts", import.meta.url).href;

function makeJob(overrides: Partial<ScheduledSubagent> = {}): ScheduledSubagent {
  return {
    id: `job-${Math.random().toString(36).slice(2, 10)}`,
    name: "lock-test-job",
    description: "lock regression test",
    schedule: "5m",
    scheduleType: "interval",
    intervalMs: 5 * 60_000,
    subagent_type: "worker",
    prompt: "hello",
    enabled: true,
    createdAt: new Date().toISOString(),
    runCount: 0,
    ...overrides,
  };
}

function runChildScript(script: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
  });
}

describe("ScheduleStore lock hardening", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "schedule-store-lock-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes a unique owner token, pid, and timestamp and releases only its own lock", () => {
    const lockPath = join(tmp, "s.json.lock");
    const token1 = acquireLock(lockPath);
    try {
      const payload = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string; ts: number };
      expect(payload.pid).toBe(process.pid);
      expect(payload.token).toBe(token1);
      expect(typeof payload.ts).toBe("number");
      expect(Number.isFinite(payload.ts)).toBe(true);
    } finally {
      releaseLock(lockPath, token1);
    }
    expect(existsSync(lockPath)).toBe(false);

    const token2 = acquireLock(lockPath);
    try {
      expect(token2).not.toBe(token1);
    } finally {
      releaseLock(lockPath, token2);
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it("owner-verified release refuses to delete a lock replaced by another owner and never throws on missing locks", () => {
    const lockPath = join(tmp, "s.json.lock");
    const originalToken = acquireLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    // Simulate another owner replacing the lockfile with a different token.
    const replacedPayload = JSON.stringify({
      pid: process.ppid,
      token: "other-owner-token",
      ts: Date.now(),
    });
    writeFileSync(lockPath, replacedPayload, "utf8");

    // Releasing with the stale original token must NOT throw and must NOT delete the replacement lock.
    expect(() => releaseLock(lockPath, originalToken)).not.toThrow();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(replacedPayload);

    // Even when the replacement has the same PID, a mismatched token must still not be deleted.
    const samePidOtherToken = JSON.stringify({
      pid: process.pid,
      token: "different-same-pid-token",
      ts: Date.now(),
    });
    writeFileSync(lockPath, samePidOtherToken, "utf8");
    expect(() => releaseLock(lockPath, originalToken)).not.toThrow();
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(samePidOtherToken);

    // Releasing with the actual current token deletes the lock cleanly.
    expect(() => releaseLock(lockPath, "different-same-pid-token")).not.toThrow();
    expect(existsSync(lockPath)).toBe(false);

    // Releasing a lock that is already gone must never throw.
    expect(() => releaseLock(lockPath, "already-gone")).not.toThrow();
  });

  it("recovers aged live-PID locks and dead-PID locks via atomic rename without leaving stale claim files", () => {
    const file = join(tmp, "s.json");
    const lockPath = `${file}.lock`;

    // 1. Dead-PID JSON lock.
    const exited = spawnSync(process.execPath, ["-e", ""]);
    const deadPid = exited.pid!;
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: "dead-token", ts: Date.now() }), "utf8");

    const store = new ScheduleStore(file);
    store.add(makeJob({ id: "after-dead" }));
    expect(store.list().map((j) => j.id)).toEqual(["after-dead"]);
    expect(readdirSync(tmp)).toEqual(["s.json"]);

    // 2. Aged lock held by a live foreign process (past staleMs threshold).
    const holder = spawn("sleep", ["30"]);
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: holder.pid, token: "aged-live-token", ts: Date.now() - 60_000 }),
        "utf8",
      );
      const token = acquireLock(lockPath, { staleMs: 1_000, maxWaitMs: 500 });
      try {
        const current = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string };
        expect(current.pid).toBe(process.pid);
        expect(current.token).toBe(token);
      } finally {
        releaseLock(lockPath, token);
      }
      expect(readdirSync(tmp)).toEqual(["s.json"]);
    } finally {
      holder.kill();
    }
  });

  it("recovers a contended stale lock atomically across processes without deleting any freshly acquired lock", async () => {
    const file = join(tmp, "contended.json");
    const lockPath = `${file}.lock`;

    const exited = spawnSync(process.execPath, ["-e", ""]);
    const deadPid = exited.pid!;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: deadPid, token: "contended-stale", ts: Date.now() - 60_000 }),
      "utf8",
    );

    const workerScript = `
      const [filePath, workerIdx] = process.argv.slice(1);
      const { ScheduleStore } = await import(${JSON.stringify(scheduleStoreModuleUrl)});
      const store = new ScheduleStore(filePath);
      const idx = Number(workerIdx);
      for (let i = 0; i < 3; i += 1) {
        store.add({
          id: \`stale-w\${idx}-j\${i}\`,
          name: \`stale-w\${idx}-j\${i}\`,
          description: "contended stale recovery",
          schedule: "5m",
          scheduleType: "interval",
          intervalMs: 300000,
          subagent_type: "worker",
          prompt: "run",
          enabled: true,
          createdAt: new Date().toISOString(),
          runCount: 0,
        });
      }
    `;

    const workerCount = 6;
    const results = await Promise.all(
      Array.from({ length: workerCount }, (_, idx) => runChildScript(workerScript, [file, String(idx)])),
    );
    for (const res of results) {
      expect(res.code, res.stderr).toBe(0);
    }

    const fresh = new ScheduleStore(file);
    const ids = fresh.list().map((j) => j.id).sort();
    const expectedIds: string[] = [];
    for (let idx = 0; idx < workerCount; idx += 1) {
      for (let i = 0; i < 3; i += 1) {
        expectedIds.push(`stale-w${idx}-j${i}`);
      }
    }
    expect(ids).toEqual(expectedIds.sort());

    // No orphan lock, stale-claim, or temp files remain.
    expect(readdirSync(tmp)).toEqual(["contended.json"]);
  });

  it("preserves all jobs and updates across concurrent cross-process ScheduleStore mutations without orphan lock files", async () => {
    const file = join(tmp, "concurrent.json");

    const workerScript = `
      const [filePath, workerIdx] = process.argv.slice(1);
      const { ScheduleStore } = await import(${JSON.stringify(scheduleStoreModuleUrl)});
      const store = new ScheduleStore(filePath);
      const idx = Number(workerIdx);
      for (let i = 0; i < 3; i += 1) {
        const id = \`w\${idx}-j\${i}\`;
        store.add({
          id,
          name: id,
          description: "concurrent add",
          schedule: "5m",
          scheduleType: "interval",
          intervalMs: 300000,
          subagent_type: "worker",
          prompt: "run",
          enabled: true,
          createdAt: new Date().toISOString(),
          runCount: 0,
        });
      }
      store.update(\`w\${idx}-j0\`, { runCount: idx + 1, lastStatus: "success" });
    `;

    const workerCount = 6;
    const results = await Promise.all(
      Array.from({ length: workerCount }, (_, idx) => runChildScript(workerScript, [file, String(idx)])),
    );
    for (const res of results) {
      expect(res.code, res.stderr).toBe(0);
    }

    const fresh = new ScheduleStore(file);
    const byId = new Map(fresh.list().map((job) => [job.id, job]));
    expect(byId.size).toBe(workerCount * 3);
    for (let idx = 0; idx < workerCount; idx += 1) {
      for (let i = 0; i < 3; i += 1) {
        expect(byId.has(`w${idx}-j${i}`), `w${idx}-j${i}`).toBe(true);
      }
      expect(byId.get(`w${idx}-j0`)).toMatchObject({
        runCount: idx + 1,
        lastStatus: "success",
      });
    }

    expect(readdirSync(tmp)).toEqual(["concurrent.json"]);
  });
});
