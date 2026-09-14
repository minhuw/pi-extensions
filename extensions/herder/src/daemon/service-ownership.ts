import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export interface ServiceOwnership {
	descriptor: number;
	lockPath: string;
}

export interface FileIdentity {
	dev: number;
	ino: number;
}

export interface StartExclusion {
	descriptor: number;
	lockPath: string;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Pid liveness plus a best-effort guard against pid reuse by an unrelated process. */
export function serviceProcessAlive(pid: number): boolean {
	if (!processAlive(pid)) return false;
	try {
		const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return command.includes("service.ts") || command.includes("herder");
	} catch {
		return true;
	}
}

function ownerLockPath(planDirectory: string): string {
	return path.join(path.resolve(planDirectory), ".herder", "service-owner.lock");
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

// Ambiguous evidence is never permission to unlink. O_NONBLOCK also prevents a
// replaced FIFO from blocking between lstat and open; O_NOFOLLOW rejects links.
function lockOwner(lockPath: string, service: boolean): { pid: number; instanceId?: string; identity: FileIdentity } | null {
	let descriptor: number | undefined;
	try {
		const named = fs.lstatSync(lockPath);
		if (!named.isFile()) return null;
		descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		const opened = fs.fstatSync(descriptor);
		if (!opened.isFile() || !sameFile(named, opened) || opened.size < 1 || opened.size > 4096) return null;
		const buffer = Buffer.alloc(opened.size + 1);
		const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
		const after = fs.fstatSync(descriptor);
		// A short read is ambiguous, not EOF evidence. Refuse growth or changes
		// during inspection too; no retry is needed for an unsafe snapshot.
		if (size !== opened.size || after.size !== opened.size
			|| after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) return null;
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
		const match = (service ? /^([1-9]\d*) ([^\s]+)\n$/ : /^([1-9]\d*)\n$/).exec(text);
		if (!match || match[0] !== text) return null;
		const pid = Number(match[1]);
		return Number.isSafeInteger(pid) && pid <= 2147483647 ? { pid, instanceId: match[2], identity: opened } : null;
	} catch {
		return null;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function createLock(lockPath: string, payload: string): ServiceOwnership | null {
	let descriptor: number;
	try { descriptor = fs.openSync(lockPath, "wx", 0o600); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
		throw error;
	}
	const lock = { descriptor, lockPath };
	try {
		fs.writeFileSync(descriptor, payload);
		if (!serviceOwnershipIsCurrent(lock)) throw new Error(`Lock replaced during publication: ${lockPath}`);
		return lock;
	} catch (error) {
		releaseServiceOwnership(lock);
		throw error;
	}
}

function acquireLock(lockPath: string, payload: string, service: boolean): ServiceOwnership | null {
	const guardPath = `${lockPath}.reclaim`;
	const guardError = () => new Error(`Cannot acquire ${lockPath}: reclamation guard ${guardPath} exists or is inaccessible. If abandoned, verify all service/startup/cleanup processes are quiescent and inspect the exact paths before manual removal; never reap by age.`);
	const refuse = (owner: ReturnType<typeof lockOwner>): null => {
		if (service) throw new Error(owner
			? `Herder service ownership is already held by pid ${owner.pid}`
			: `Cannot safely read service lock ${lockPath}; verify quiescence and inspect the exact lock before manual recovery.`);
		return null;
	};
	// Operation owners run in Pi/CLI hosts, whose argv need not identify a daemon.
	const alive = (owner: NonNullable<ReturnType<typeof lockOwner>>) =>
		service && !/^(cleanup|reset|force|revision)-/.test(owner.instanceId ?? "")
			? serviceProcessAlive(owner.pid) : processAlive(owner.pid);
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try { fs.lstatSync(guardPath); throw guardError(); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw guardError(); }
		const created = createLock(lockPath, payload);
		if (created) {
			// A reclaimer may have taken the guard after our initial check.
			try { fs.lstatSync(guardPath); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return created;
			}
			releaseServiceOwnership(created);
			throw guardError();
		}
		const owner = lockOwner(lockPath, service);
		if (!owner || alive(owner)) return refuse(owner);
		try { fs.mkdirSync(guardPath, { mode: 0o700 }); }
		catch { throw guardError(); }
		let replacement: ServiceOwnership | null = null;
		try {
			// Re-read inside cross-process exclusion, not the pre-guard snapshot.
			const current = lockOwner(lockPath, service);
			if (!current || alive(current)) return refuse(current);
			const named = fs.lstatSync(lockPath);
			if (!named.isFile() || !sameFile(current.identity, named)) continue;
			fs.unlinkSync(lockPath);
			replacement = createLock(lockPath, payload);
			if (replacement) return replacement;
		} finally {
			try { fs.rmdirSync(guardPath); }
			catch (error) {
				if (replacement) releaseServiceOwnership(replacement);
				throw error;
			}
		}
	}
	return refuse(null);
}

export function acquireStartExclusion(lockPath: string): StartExclusion | null {
	return acquireLock(lockPath, `${process.pid}\n`, false);
}

export function releaseStartExclusion(lock: StartExclusion): void {
	try {
		const opened = fs.fstatSync(lock.descriptor);
		const named = fs.lstatSync(lock.lockPath);
		if (opened.dev === named.dev && opened.ino === named.ino) {
			try { fs.unlinkSync(lock.lockPath); } catch {}
		}
	} catch {}
	try { fs.closeSync(lock.descriptor); } catch {}
}

export function acquireServiceOwnership(planDirectory: string, instanceId: string): ServiceOwnership {
	const lockPath = ownerLockPath(planDirectory);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	return acquireLock(lockPath, `${process.pid} ${instanceId}\n`, true)!;
}

export function serviceOwnershipIsCurrent(ownership: ServiceOwnership): boolean {
	try {
		const opened = fs.fstatSync(ownership.descriptor);
		const named = fs.lstatSync(ownership.lockPath);
		return opened.isFile() && named.isFile() && opened.dev === named.dev && opened.ino === named.ino;
	} catch {
		return false;
	}
}

export function releaseServiceOwnership(ownership: ServiceOwnership): void {
	if (serviceOwnershipIsCurrent(ownership)) {
		try { fs.unlinkSync(ownership.lockPath); } catch {}
	}
	try { fs.closeSync(ownership.descriptor); } catch {}
}

export function serviceOwnershipLockPath(planDirectory: string): string {
	return ownerLockPath(planDirectory);
}
