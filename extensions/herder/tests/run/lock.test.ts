import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCK_STALE_MS } from "../../src/config.ts";
import { acquireLock, isStale, type LockHook, type LockInfo, readLock } from "../../src/run/lock.ts";

const dirs: string[] = [];
const lockPath = () => {
	const dir = mkdtempSync(join(tmpdir(), "herder-lock-"));
	dirs.push(dir);
	return join(dir, "lock");
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const t0 = Date.UTC(2026, 0, 1);
const clock = (offsetMs: number) => () => new Date(t0 + offsetMs);
const foreign = (path: string, info: Partial<LockInfo> = {}) => writeFileSync(path, JSON.stringify({
	pid: process.pid, host: hostname(), startedAt: new Date(t0).toISOString(), heartbeatAt: new Date(t0).toISOString(), sessionId: "other", ...info,
}));

describe("run lock", () => {
	it("acquires, heartbeats, and releases idempotently", () => {
		const path = lockPath();
		const lock = acquireLock(path, "s1", { now: clock(0) });
		expect(readLock(path)).toEqual({ pid: process.pid, host: hostname(), startedAt: new Date(t0).toISOString(), heartbeatAt: new Date(t0).toISOString(), sessionId: "s1" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(lock.info);
		const later = acquireLock(path, "s1", { now: clock(5_000) });
		expect(later.info).toMatchObject({ startedAt: new Date(t0).toISOString(), heartbeatAt: new Date(t0 + 5_000).toISOString() });
		later.heartbeat();
		lock.heartbeat(); // same session and startedAt: still ours
		lock.release();
		expect(existsSync(path)).toBe(false);
		lock.release();
		later.release();
	});

	it("refuses a fresh foreign lock and names the holder", () => {
		const path = lockPath();
		foreign(path);
		expect(() => acquireLock(path, "s1", { now: clock(LOCK_STALE_MS) })).toThrow(new RegExp(`locked by session other \\(pid ${process.pid} on .+, heartbeat 120s ago\\)`));
		expect(readLock(path)?.sessionId).toBe("other");
	});

	it("takes over a stale lock", () => {
		const path = lockPath();
		foreign(path);
		const lock = acquireLock(path, "s1", { now: clock(LOCK_STALE_MS + 1) });
		expect(readLock(path)).toEqual(lock.info);
		expect(lock.info.sessionId).toBe("s1");
		expect(isStale(lock.info, new Date(t0 + LOCK_STALE_MS + 1))).toBe(false);
	});

	it("treats a lock from a dead process on this host as stale", () => {
		const path = lockPath();
		foreign(path, { pid: 2 ** 22 + 12345 });
		expect(acquireLock(path, "s1", { now: clock(0) }).info.sessionId).toBe("s1");
		foreign(path, { pid: 2 ** 22 + 12345, host: "elsewhere" });
		expect(() => acquireLock(path, "s2", { now: clock(0) })).toThrow(/locked by session other/);
	});

	it("handles an unreadable lock by its age", () => {
		const path = lockPath();
		writeFileSync(path, "");
		expect(() => acquireLock(path, "s1", { now: () => new Date() })).toThrow(/being written/);
		expect(acquireLock(path, "s1", { now: () => new Date(Date.now() + LOCK_STALE_MS + 60_000) }).info.sessionId).toBe("s1");
	});

	it("detects lost ownership on heartbeat and does not release a foreign lock", () => {
		const path = lockPath();
		const lock = acquireLock(path, "s1", { now: clock(0) });
		const thief = acquireLock(path, "s2", { now: clock(LOCK_STALE_MS + 1), staleMs: LOCK_STALE_MS });
		expect(() => lock.heartbeat()).toThrow(/run lock lost to session s2/);
		lock.release();
		expect(readLock(path)?.sessionId).toBe("s2");
		thief.release();
		expect(() => lock.heartbeat()).toThrow(/run lock lost$/);
	});

	it("shares a lock with the same session only inside the same process", () => {
		const path = lockPath();
		foreign(path, { sessionId: "s1", pid: process.ppid });
		expect(() => acquireLock(path, "s1", { now: clock(0) })).toThrow(new RegExp(`locked by session s1 \\(pid ${process.ppid} `));
		foreign(path, { sessionId: "s1", host: "elsewhere" });
		expect(() => acquireLock(path, "s1", { now: clock(0) })).toThrow(/locked by session s1 \(pid \d+ on elsewhere/);
		foreign(path, { sessionId: "s1", pid: 2 ** 22 + 12345 });
		const lock = acquireLock(path, "s1", { now: clock(1_000) });
		expect(lock.info).toMatchObject({ pid: process.pid, startedAt: new Date(t0 + 1_000).toISOString() });
		foreign(path, { sessionId: "s1", pid: process.ppid });
		expect(acquireLock(path, "s1", { now: clock(LOCK_STALE_MS + 1) }).info.pid).toBe(process.pid);
	});

	it("lets only one of two sessions take over the same stale lock", () => {
		const path = lockPath();
		foreign(path);
		let second: ReturnType<typeof acquireLock> | undefined;
		const hook: LockHook = (point) => { if (point === "takeover" && !second) second = acquireLock(path, "s2", { now: clock(LOCK_STALE_MS + 1) }); };
		expect(() => acquireLock(path, "s1", { now: clock(LOCK_STALE_MS + 1), hook })).toThrow(/locked by session s2/);
		expect(readLock(path)).toEqual(second!.info);
		second!.heartbeat();
		expect(readdirSync(dirname(path))).toEqual(["lock"]);
	});

	it("loses a takeover to a session that creates the lock after the stale one is moved aside", () => {
		const path = lockPath();
		foreign(path);
		let second: ReturnType<typeof acquireLock> | undefined;
		const hook: LockHook = (point) => { if (point === "create" && !second) second = acquireLock(path, "s2", { now: clock(LOCK_STALE_MS + 1) }); };
		expect(() => acquireLock(path, "s1", { now: clock(LOCK_STALE_MS + 1), hook })).toThrow(/locked by session s2/);
		expect(second!.info.startedAt).toBe(new Date(t0 + LOCK_STALE_MS + 1).toISOString());
		expect(readLock(path)).toEqual(second!.info);
		expect(readdirSync(dirname(path))).toEqual(["lock"]);
	});

	it("does not overwrite a competitor's lock on heartbeat", () => {
		const path = lockPath();
		let steal = false;
		const lock = acquireLock(path, "s1", { now: clock(0), hook: (point) => { if (point === "replace" && steal) foreign(path, { sessionId: "s2" }); } });
		steal = true;
		expect(() => lock.heartbeat()).toThrow(/run lock lost to session s2/);
		expect(readLock(path)?.sessionId).toBe("s2");
		expect(readdirSync(dirname(path))).toEqual(["lock"]);
	});

	it("does not overwrite a lock a competitor creates while ours is moved aside on heartbeat", () => {
		const path = lockPath();
		let steal = false;
		const lock = acquireLock(path, "s1", { now: clock(0), hook: (point) => { if (point === "install" && steal) foreign(path, { sessionId: "s2" }); } });
		steal = true;
		expect(() => lock.heartbeat()).toThrow(/run lock lost to session s2/);
		expect(readLock(path)?.sessionId).toBe("s2");
		expect(readdirSync(dirname(path))).toEqual(["lock"]);
	});

	it("does not release a lock taken over between its check and the release", () => {
		const path = lockPath();
		const lock = acquireLock(path, "s1", { now: clock(0), hook: (point) => { if (point === "release") foreign(path, { sessionId: "s2" }); } });
		lock.release();
		expect(readLock(path)?.sessionId).toBe("s2");
		expect(readdirSync(dirname(path))).toEqual(["lock"]);
	});

	it("judges staleness from the heartbeat", () => {
		const info: LockInfo = { pid: 1, host: "h", startedAt: "x", heartbeatAt: new Date(t0).toISOString(), sessionId: "s" };
		expect(isStale(info, new Date(t0 + LOCK_STALE_MS))).toBe(false);
		expect(isStale(info, new Date(t0 + LOCK_STALE_MS + 1))).toBe(true);
		expect(isStale({ ...info, heartbeatAt: "garbage" }, new Date(t0))).toBe(true);
		expect(isStale(info, new Date(t0 + 10), 5)).toBe(true);
	});
});
