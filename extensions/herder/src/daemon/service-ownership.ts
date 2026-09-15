import { nativeProcessAlive, nativeProcessIdentity } from "../shared/process-identity.ts";
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

/** Only ESRCH establishes death; uncertain probes never authorize reclamation. */
export function serviceProcessAlive(pid: number): boolean {
	try { return nativeProcessAlive(pid); }
	catch { return true; }
}

function ownerLockPath(planDirectory: string): string {
	return path.join(path.resolve(planDirectory), ".herder", "service-owner.lock");
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

interface ServiceMetadata {
	version: 1;
	processIdentity: string;
	planDirectory: string;
}

// Ambiguous evidence is never permission to unlink. O_NONBLOCK also prevents a
// replaced FIFO from blocking between lstat and open; O_NOFOLLOW rejects links.
function lockOwner(lockPath: string, service: boolean): { pid: number; instanceId?: string; identity: fs.Stats; metadata?: ServiceMetadata } | null {
	let descriptor: number | undefined;
	try {
		const named = fs.lstatSync(lockPath);
		if (!fs.constants.O_NOFOLLOW || !named.isFile()) return null;
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
		const match = (service ? /^([1-9]\d*) ([^\s]+)\n(?:([^\n]+)\n)?$/ : /^([1-9]\d*)\n$/).exec(text);
		if (!match || match[0] !== text) return null;
		let metadata: ServiceMetadata | undefined;
		if (match[3] !== undefined) {
			metadata = JSON.parse(match[3]);
			if (!metadata || metadata.version !== 1
				|| typeof metadata.processIdentity !== "string" || !metadata.processIdentity.length || metadata.processIdentity.length > 512
				|| typeof metadata.planDirectory !== "string" || !path.isAbsolute(metadata.planDirectory)) return null;
		}
		const pid = Number(match[1]);
		return Number.isSafeInteger(pid) && pid <= 2147483647 ? { pid, instanceId: match[2], identity: opened, metadata } : null;
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
	const alive = (owner: NonNullable<ReturnType<typeof lockOwner>>) => serviceProcessAlive(owner.pid);
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
	readRuntimeIdentity(planDirectory);
	if (!instanceId || /\s/.test(instanceId) || instanceId.length > 512) throw new Error("Invalid service ownership instance ID");
	const metadata: ServiceMetadata = {
		version: 1, processIdentity: nativeProcessIdentity(process.pid), planDirectory: fs.realpathSync(planDirectory),
	};
	const payload = `${process.pid} ${instanceId}\n${JSON.stringify(metadata)}\n`;
	if (Buffer.byteLength(payload) > 4096) throw new Error("Service ownership evidence exceeds size limit");
	return acquireLock(lockPath, payload, true)!;
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

function readRuntimeIdentity(planDirectory: string): fs.Stats {
	const runtime = fs.lstatSync(path.dirname(ownerLockPath(planDirectory)));
	if (!runtime.isDirectory() || runtime.isSymbolicLink()) throw new Error("Unsafe service runtime; refusing signals");
	return runtime;
}

/** Capture lock evidence for a registered service. Caller must recheck SQLite before each signal.
 * Best effort: Node cannot make native birth inspection and the subsequent signal atomic.
 */
export function captureServiceTermination(planDirectory: string, service: { pid: number; instanceId: string }): () => void {
	const resolved = path.resolve(planDirectory);
	const canonical = fs.realpathSync(resolved);
	const runtime = readRuntimeIdentity(resolved);
	const lockPath = ownerLockPath(resolved);
	const expected = { pid: service.pid, instanceId: service.instanceId };
	let captured: fs.Stats | undefined;
	const refuse = () => { throw new Error("Service termination identity evidence changed or unavailable; refusing signals. Safely shut down the owning service externally before retrying"); };
	const assertRuntime = () => {
		if (fs.realpathSync(resolved) !== canonical || !sameFile(runtime, readRuntimeIdentity(resolved))) refuse();
	};
	const verify = () => {
		assertRuntime();
		const owner = lockOwner(lockPath, true);
		if (!owner || owner.pid !== expected.pid || owner.instanceId !== expected.instanceId
			|| !owner.metadata || owner.metadata.planDirectory !== canonical || owner.identity.nlink !== 1) return refuse();
		if (captured && !sameEvidence(captured, owner.identity)) refuse();
		if (nativeProcessIdentity(expected.pid) !== owner.metadata.processIdentity) refuse();
		assertRuntime();
		const named = fs.lstatSync(lockPath);
		if (!named.isFile() || !sameEvidence(owner.identity, named)) refuse();
		captured ??= owner.identity;
	};
	verify();
	return verify;
}

function sameEvidence(left: fs.Stats, right: fs.Stats): boolean {
	return sameFile(left, right) && (["size", "mtimeMs", "ctimeMs", "nlink"] as const).every(key => left[key] === right[key]);
}
