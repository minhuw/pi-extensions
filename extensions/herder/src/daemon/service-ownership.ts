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

export function processAlive(pid: number): boolean {
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

function startLockOwner(lockPath: string): number {
	try { return Number(fs.readFileSync(lockPath, "utf8").trim().split(/\s+/)[0]); }
	catch { return 0; }
}

export function acquireStartExclusion(lockPath: string): StartExclusion | null {
	try {
		const descriptor = fs.openSync(lockPath, "wx", 0o600);
		fs.writeFileSync(descriptor, `${process.pid}\n`);
		return { descriptor, lockPath };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const owner = startLockOwner(lockPath);
		if (owner > 0 && processAlive(owner)) return null;
		try { fs.unlinkSync(lockPath); } catch {}
		return acquireStartExclusion(lockPath);
	}
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
	try {
		const descriptor = fs.openSync(lockPath, "wx", 0o600);
		fs.writeFileSync(descriptor, `${process.pid} ${instanceId}\n`);
		return { descriptor, lockPath };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const owner = startLockOwner(lockPath);
		if (owner > 0 && serviceProcessAlive(owner)) throw new Error(`Herder service ownership is already held by pid ${owner}`);
		try { fs.unlinkSync(lockPath); } catch {}
		return acquireServiceOwnership(planDirectory, instanceId);
	}
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
