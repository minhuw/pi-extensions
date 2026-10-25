import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { LOCK_STALE_MS } from "../config.ts";
import { siblingPath, syncDir, writeFileSynced } from "./files.ts";

export interface LockInfo { pid: number; host: string; startedAt: string; heartbeatAt: string; sessionId: string }
export interface RunLock { readonly info: LockInfo; heartbeat(): void; release(): void }
/**
 * Points between judging the lock file and acting on it: before a stale lock is moved aside, before our lock is created
 * after that, before a replace moves our lock aside, before the replacement is linked in, before a release.
 */
export type LockHookPoint = "takeover" | "create" | "replace" | "install" | "release";
export type LockHook = (point: LockHookPoint) => void;
/** `hook` is a test seam for simulating a competitor between steps. */
export interface LockOptions { now?: () => Date; staleMs?: number; hook?: LockHook }

function parseLock(text: string): LockInfo | null {
	try {
		const value = JSON.parse(text) as Partial<LockInfo> | null;
		if (value && typeof value.pid === "number" && typeof value.host === "string" && typeof value.startedAt === "string"
			&& typeof value.heartbeatAt === "string" && typeof value.sessionId === "string") return value as LockInfo;
	} catch {}
	return null;
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

function readRaw(path: string): { text: string; info: LockInfo | null; mtimeMs: number } | undefined {
	try {
		const text = readFileSync(path, "utf8");
		return { text, info: parseLock(text), mtimeMs: statSync(path).mtimeMs };
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

/** The lock's holder, or null when there is no lock or it is unreadable. */
export function readLock(path: string): LockInfo | null { return readRaw(path)?.info ?? null; }

export function isStale(info: LockInfo, now: Date, staleMs = LOCK_STALE_MS): boolean {
	return !(now.getTime() - Date.parse(info.heartbeatAt) <= staleMs);
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const owns = (current: LockInfo | null, info: LockInfo) => current?.sessionId === info.sessionId && current.startedAt === info.startedAt
	&& current.pid === info.pid && current.host === info.host;
const serialize = (info: LockInfo) => `${JSON.stringify(info)}\n`;

/** Creates the lock file exclusively; false when one already exists. */
function create(path: string, info: LockInfo): boolean {
	try {
		writeFileSynced(path, serialize(info), "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	syncDir(dirname(path));
	return true;
}

/** Puts a lock moved aside by mistake back, unless a newer lock was created meanwhile. */
function restore(aside: string, path: string): void {
	try {
		linkSync(aside, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	rmSync(aside, { force: true });
	syncDir(dirname(path));
}

/**
 * Removes the lock only if its content `matches`. The rename is the atomic step: of several sessions removing the
 * same lock, exactly one moves it aside, and whoever moved a different lock puts it back.
 */
function removeIf(path: string, matches: (text: string | undefined) => boolean): boolean {
	const aside = siblingPath(path, "aside");
	try {
		renameSync(path, aside);
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
	if (!matches(readText(aside))) {
		restore(aside, path);
		return false;
	}
	rmSync(aside, { force: true });
	syncDir(dirname(path));
	return true;
}

/**
 * Replaces the lock with `next` if it still holds `expected`; false when a competitor changed or took it. Renaming over
 * the lock could clobber one a competitor created after our check, so ours is moved aside and the new one linked in:
 * a competitor can only create its lock while none exists, and then our link fails instead of overwriting it.
 */
function replace(path: string, expected: string, next: LockInfo, hook?: LockHook): boolean {
	const temp = siblingPath(path, "tmp");
	const aside = siblingPath(path, "aside");
	writeFileSynced(temp, serialize(next), "wx");
	try {
		hook?.("replace");
		try {
			renameSync(path, aside);
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
		if (readText(aside) !== expected) {
			restore(aside, path);
			return false;
		}
		hook?.("install");
		try {
			linkSync(temp, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			restore(aside, path);
			throw error;
		}
		return true;
	} finally {
		rmSync(temp, { force: true });
		rmSync(aside, { force: true });
		syncDir(dirname(path));
	}
}

/**
 * Takes the lock, refreshes this process's own lock for the session, or takes over a stale one (heartbeat older than
 * `staleMs`, or a holder on this host whose process is gone); throws naming the holder when another live process owns it,
 * including another process resuming the same session.
 */
export function acquireLock(path: string, sessionId: string, options: LockOptions = {}): RunLock {
	const now = options.now ?? (() => new Date());
	const staleMs = options.staleMs ?? LOCK_STALE_MS;
	const hook = options.hook;
	const host = hostname();
	const make = (startedAt?: string): LockInfo => {
		const at = now().toISOString();
		return { pid: process.pid, host, startedAt: startedAt ?? at, heartbeatAt: at, sessionId };
	};
	mkdirSync(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 5; attempt++) {
		const info = make();
		if (create(path, info)) return handle(path, info, now, hook);
		const current = readRaw(path);
		if (!current) continue; // released between our create and read
		const holder = current.info;
		if (holder?.sessionId === sessionId && holder.pid === process.pid && holder.host === host) {
			const refreshed = make(holder.startedAt);
			if (replace(path, current.text, refreshed, hook)) return handle(path, refreshed, now, hook);
			continue;
		}
		if (holder ? !isStale(holder, now(), staleMs) && !(holder.host === host && !pidAlive(holder.pid)) : now().getTime() - current.mtimeMs <= staleMs) {
			const age = holder ? Math.round((now().getTime() - Date.parse(holder.heartbeatAt)) / 1000) : 0;
			throw new Error(holder
				? `run is locked by session ${holder.sessionId} (pid ${holder.pid} on ${holder.host}, heartbeat ${age}s ago)`
				: `run lock ${path} is being written by another session`);
		}
		hook?.("takeover");
		if (!removeIf(path, (text) => text === current.text)) continue; // another session took it over first
		hook?.("create");
		if (create(path, info)) return handle(path, info, now, hook);
	}
	throw new Error(`could not acquire run lock ${path}`);
}

function lost(path: string): Error {
	const current = readLock(path);
	return new Error(`run lock lost${current ? ` to session ${current.sessionId} (pid ${current.pid} on ${current.host})` : ""}`);
}

function handle(path: string, initial: LockInfo, now: () => Date, hook?: LockHook): RunLock {
	let info = initial;
	return {
		get info() { return info; },
		heartbeat() {
			const text = readText(path);
			if (text === undefined || !owns(parseLock(text), info)) throw lost(path);
			const next = { ...info, heartbeatAt: now().toISOString() };
			if (!replace(path, text, next, hook)) throw lost(path);
			info = next;
		},
		release() {
			if (!owns(readLock(path), info)) return;
			hook?.("release");
			removeIf(path, (text) => text !== undefined && owns(parseLock(text), info));
		},
	};
}
