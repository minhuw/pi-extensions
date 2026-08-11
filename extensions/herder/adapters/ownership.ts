import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { openExecutionDatabase, withExecutionTransaction } from "../src/daemon/execution-store.ts";

const LOCK_NAME = "pi-session-owner.lock";
const MAX_LOCK_BYTES = 4_096;
const RETIREMENT_REGISTRY = Symbol.for("pi-extensions.herder.adapter-ownership-retirements.v1");

type RetirementRegistry = Map<string, Promise<void>>;

function retirementRegistry(): RetirementRegistry {
	const shared = globalThis as unknown as Record<symbol, unknown>;
	const existing = shared[RETIREMENT_REGISTRY];
	if (existing instanceof Map) return existing as RetirementRegistry;
	const created: RetirementRegistry = new Map();
	shared[RETIREMENT_REGISTRY] = created;
	return created;
}

export interface AdapterOwnershipRecord {
	version: 1;
	pid: number;
	runId: string;
	piSessionId: string;
}

export interface AdapterOwnership {
	descriptor: number;
	lockPath: string;
	record: AdapterOwnershipRecord;
}

export interface AdapterOwnershipOptions {
	isProcessAlive?: (pid: number) => boolean;
	pid?: number;
}

export function adapterProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function adapterOwnershipLockPath(planDirectory: string): string {
	return path.join(path.resolve(planDirectory), ".herder", LOCK_NAME);
}

export function registerAdapterOwnershipRetirement(ownership: AdapterOwnership, drain: Promise<unknown>): void {
	const registry = retirementRegistry();
	const lockPath = ownership.lockPath;
	const previous = registry.get(lockPath) ?? Promise.resolve();
	const settled = previous.catch(() => {}).then(async () => {
		await drain;
	}).catch(() => {});
	registry.set(lockPath, settled);
	void settled.then(() => {
		if (registry.get(lockPath) === settled) registry.delete(lockPath);
	});
}

export async function waitForAdapterOwnershipRetirement(planDirectory: string): Promise<void> {
	const pending = retirementRegistry().get(adapterOwnershipLockPath(planDirectory));
	if (pending) await pending;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function ensureRuntimeDirectory(planDirectory: string): string {
	const runtimeDirectory = path.join(path.resolve(planDirectory), ".herder");
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(runtimeDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try { fs.mkdirSync(runtimeDirectory, { mode: 0o700 }); }
		catch (mkdirError) {
			if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
		}
		stat = fs.lstatSync(runtimeDirectory);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`Herder Pi ownership runtime path is unsafe: ${runtimeDirectory}`);
	}
	return runtimeDirectory;
}

function parseRecord(text: string, lockPath: string): AdapterOwnershipRecord {
	let value: unknown;
	try { value = JSON.parse(text); }
	catch { throw new Error(`Herder Pi ownership lock is malformed; refusing to replace it: ${lockPath}`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Herder Pi ownership lock is malformed; refusing to replace it: ${lockPath}`);
	}
	const record = value as Partial<AdapterOwnershipRecord>;
	if (record.version !== 1
		|| !Number.isSafeInteger(record.pid) || Number(record.pid) < 1
		|| typeof record.runId !== "string" || record.runId.length < 1 || record.runId.length > 512
		|| typeof record.piSessionId !== "string" || record.piSessionId.length < 1 || record.piSessionId.length > 512) {
		throw new Error(`Herder Pi ownership lock is malformed; refusing to replace it: ${lockPath}`);
	}
	return record as AdapterOwnershipRecord;
}

function inspectExisting(lockPath: string): { descriptor: number; stat: fs.Stats; record: AdapterOwnershipRecord } {
	if (!fs.constants.O_NOFOLLOW) throw new Error(`Safe Herder Pi ownership locking is unavailable: ${lockPath}`);
	let named: fs.Stats;
	try { named = fs.lstatSync(lockPath); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
		throw new Error(`Herder Pi ownership lock cannot be inspected safely: ${lockPath}`);
	}
	if (named.isSymbolicLink() || !named.isFile()) {
		throw new Error(`Herder Pi ownership lock is not a regular file; refusing to replace it: ${lockPath}`);
	}
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const opened = fs.fstatSync(descriptor);
		if (!opened.isFile() || !sameIdentity(opened, named) || opened.size < 1 || opened.size > MAX_LOCK_BYTES) {
			throw new Error(`Herder Pi ownership lock is malformed; refusing to replace it: ${lockPath}`);
		}
		const record = parseRecord(fs.readFileSync(descriptor, "utf8"), lockPath);
		return { descriptor, stat: opened, record };
	} catch (error) {
		if (descriptor !== undefined) {
			try { fs.closeSync(descriptor); } catch {}
		}
		if ((error as NodeJS.ErrnoException).code === "ELOOP") {
			throw new Error(`Herder Pi ownership lock is a symlink; refusing to replace it: ${lockPath}`);
		}
		throw error;
	}
}

function createOwnershipLock(lockPath: string, record: AdapterOwnershipRecord): AdapterOwnership {
	const descriptor = fs.openSync(lockPath, "wx", 0o600);
	try {
		fs.fchmodSync(descriptor, 0o600);
		fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
		fs.fsyncSync(descriptor);
		return { descriptor, lockPath, record };
	} catch (error) {
		try {
			const opened = fs.fstatSync(descriptor);
			const named = fs.lstatSync(lockPath);
			if (sameIdentity(opened, named)) fs.unlinkSync(lockPath);
		} catch {}
		try { fs.closeSync(descriptor); } catch {}
		throw error;
	}
}

function reapStaleOwnership(
	planDirectory: string,
	lockPath: string,
	isProcessAlive: (pid: number) => boolean,
): void {
	const database = openExecutionDatabase(planDirectory, { create: true });
	try {
		withExecutionTransaction(database, () => {
			let existing: ReturnType<typeof inspectExisting>;
			try { existing = inspectExisting(lockPath); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
			try {
				if (isProcessAlive(existing.record.pid)) {
					throw new Error(`Herder run ${existing.record.runId} is already owned by live Pi pid ${existing.record.pid} (session ${existing.record.piSessionId}); refusing to attach.`);
				}
				let named: fs.Stats;
				try { named = fs.lstatSync(lockPath); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				if (named.isSymbolicLink() || !named.isFile()) {
					throw new Error(`Herder Pi ownership lock changed to an unsafe file; refusing to replace it: ${lockPath}`);
				}
				if (!sameIdentity(existing.stat, named)) return;
				fs.unlinkSync(lockPath);
			} finally {
				try { fs.closeSync(existing.descriptor); } catch {}
			}
		});
	} finally {
		database.close();
	}
}

export function acquireAdapterOwnership(
	planDirectory: string,
	runId: string,
	piSessionId: string,
	options: AdapterOwnershipOptions = {},
): AdapterOwnership {
	if (!runId || runId.length > 512) throw new Error("Herder Pi ownership requires a bounded run ID.");
	if (!piSessionId || piSessionId.length > 512) throw new Error("Herder Pi ownership requires a bounded Pi session ID.");
	const resolvedPlanDirectory = path.resolve(planDirectory);
	const lockPath = path.join(ensureRuntimeDirectory(resolvedPlanDirectory), LOCK_NAME);
	const record: AdapterOwnershipRecord = {
		version: 1,
		pid: options.pid ?? process.pid,
		runId,
		piSessionId,
	};
	const isProcessAlive = options.isProcessAlive ?? adapterProcessAlive;

	for (let attempt = 0; attempt < 16; attempt += 1) {
		try { return createOwnershipLock(lockPath, record); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		reapStaleOwnership(resolvedPlanDirectory, lockPath, isProcessAlive);
	}
	throw new Error(`Herder Pi ownership changed repeatedly; refusing to attach: ${lockPath}`);
}

/** Bind a pending startup claim to its manager run without rewriting the live lock inode. */
export function bindAdapterOwnershipRun(ownership: AdapterOwnership, runId: string): void {
	if (!runId || runId.length > 512) throw new Error("Herder Pi ownership requires a bounded run ID.");
	ownership.record = { ...ownership.record, runId };
}

export function releaseAdapterOwnership(ownership: AdapterOwnership): void {
	try {
		const opened = fs.fstatSync(ownership.descriptor);
		const named = fs.lstatSync(ownership.lockPath);
		if (named.isFile() && !named.isSymbolicLink() && sameIdentity(opened, named)) {
			try { fs.unlinkSync(ownership.lockPath); } catch {}
		}
	} catch {}
	try { fs.closeSync(ownership.descriptor); } catch {}
}
