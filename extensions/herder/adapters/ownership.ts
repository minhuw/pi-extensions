import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
	processIdentity?: string;
	resetCleanupRequired?: true;
}

export interface AdapterOwnership {
	descriptor: number;
	runtimeIdentity: fs.Stats;
	lockPath: string;
	record: AdapterOwnershipRecord;
}

export interface AdapterOwnershipOptions {
	isProcessAlive?: (pid: number) => boolean;
	pid?: number;
	processIdentity?: (pid: number) => string;
}

export function adapterProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
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

function assertNoForceCleanupEvidence(retained: string): void {
	// Any retained pathname is unsafe, even without a matching primary inode; never follow or adopt it.
	try { fs.lstatSync(retained); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	throw new Error(`Herder force cleanup retained ownership evidence; manual child-process cleanup required: ${retained}`);
}

function ensureRuntimeDirectory(planDirectory: string): string {
	assertNoForceCleanupEvidence(`${path.resolve(planDirectory)}.cleanup-required`);
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
	assertNoForceCleanupEvidence(`${adapterOwnershipLockPath(planDirectory)}.cleanup-required`);
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
		|| (record.resetCleanupRequired !== undefined && record.resetCleanupRequired !== true)
		|| (record.processIdentity !== undefined && (typeof record.processIdentity !== "string" || record.processIdentity.length < 1 || record.processIdentity.length > 512))
		|| typeof record.runId !== "string" || record.runId.length < 1 || record.runId.length > 512
		|| typeof record.piSessionId !== "string" || record.piSessionId.length < 1 || record.piSessionId.length > 512) {
		throw new Error(`Herder Pi ownership lock is malformed; refusing to replace it: ${lockPath}`);
	}
	return record as AdapterOwnershipRecord;
}

function inspectExisting(lockPath: string): { descriptor: number; stat: fs.Stats; record: AdapterOwnershipRecord } {
	assertNoForceCleanupEvidence(`${lockPath}.cleanup-required`);
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
		descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		const opened = fs.fstatSync(descriptor);
		if (!opened.isFile() || !sameIdentity(opened, named) || opened.size < 1 || opened.size > MAX_LOCK_BYTES) {
			throw new Error(`Herder Pi ownership lock is malformed; refusing to replace it: ${lockPath}`);
		}
		const record = parseRecord(fs.readFileSync(descriptor, "utf8"), lockPath);
		if (opened.nlink !== 1 && !record.resetCleanupRequired) {
			throw new Error(`Herder Pi ownership has retained cleanup links; manual child-process cleanup required: ${lockPath}`);
		}
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

/** Read bounded regular-file evidence without creating runtime or SQLite state. */
export function readAdapterOwnershipEvidence(planDirectory: string): { stat: fs.Stats; record: AdapterOwnershipRecord } | undefined {
	const runtime = readAdapterRuntimeIdentity(planDirectory);
	if (!runtime) return undefined;
	const lockPath = adapterOwnershipLockPath(planDirectory);
	let existing: ReturnType<typeof inspectExisting> | undefined;
	try {
		try { existing = inspectExisting(lockPath); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const currentRuntime = readAdapterRuntimeIdentity(planDirectory);
		if (!currentRuntime || !sameIdentity(runtime, currentRuntime)) {
			throw new Error("Herder recovery runtime was removed or replaced; refusing recovery");
		}
		if (!existing) return undefined;
		const named = fs.lstatSync(lockPath);
		const current = fs.fstatSync(existing.descriptor);
		const previous = existing.stat;
		// A descriptor can retain stale bytes after replacement or in-place invalidation.
		if (named.isSymbolicLink() || !named.isFile() || !sameIdentity(previous, named)
			|| (["size", "mtimeMs", "ctimeMs", "nlink"] as const).some(key =>
				previous[key] !== current[key] || current[key] !== named[key])) {
			throw new Error("Herder ownership evidence changed while reading; refusing recovery");
		}
		return { stat: current, record: existing.record };
	} finally { if (existing) fs.closeSync(existing.descriptor); }
}

/** Recovery is bound to this runtime, never merely to a reusable directory name. */
export function readAdapterRuntimeIdentity(planDirectory: string): fs.Stats | undefined {
	assertNoForceCleanupEvidence(`${path.resolve(planDirectory)}.cleanup-required`);
	let runtime: fs.Stats;
	try { runtime = fs.lstatSync(path.dirname(adapterOwnershipLockPath(planDirectory))); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	if (runtime.isSymbolicLink() || !runtime.isDirectory()) throw new Error("Herder Pi runtime directory is unsafe");
	assertNoForceCleanupEvidence(`${adapterOwnershipLockPath(planDirectory)}.cleanup-required`);
	return runtime;
}

export function assertAdapterRecoveryEvidence(planDirectory: string, identity: fs.Stats | undefined): void {
	if (readAdapterOwnershipEvidence(planDirectory)?.record.resetCleanupRequired) {
		throw new Error("Herder ownership requires manual child-process cleanup; refusing recovery");
	}
	const runtime = readAdapterRuntimeIdentity(planDirectory);
	if (!identity || !runtime || !sameIdentity(identity, runtime)) throw new Error("Herder recovery runtime was removed or replaced; refusing recovery");
}

function createOwnershipLock(lockPath: string, record: AdapterOwnershipRecord): AdapterOwnership {
	assertNoForceCleanupEvidence(`${lockPath}.cleanup-required`);
	const runtimeIdentity = fs.lstatSync(path.dirname(lockPath));
	const descriptor = fs.openSync(lockPath, "wx", 0o600);
	try {
		fs.fchmodSync(descriptor, 0o600);
		fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
		fs.fsyncSync(descriptor);
		return { descriptor, runtimeIdentity, lockPath, record };
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
		const probed = withExecutionTransaction(database, () => {
			try { return inspectExisting(lockPath); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		});
		if (!probed) return;
		try {
			// Probes can publish a cleanup marker; never invoke them under the writer lock.
			const alive = isProcessAlive(probed.record.pid);
			withExecutionTransaction(database, () => {
				let existing: ReturnType<typeof inspectExisting>;
				try { existing = inspectExisting(lockPath); }
				catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				try {
					if (!sameIdentity(probed.stat, existing.stat)
						|| (["pid", "runId", "piSessionId", "processIdentity"] as const).some(key => probed.record[key] !== existing.record[key])) return;
					if (alive) {
						throw new Error(`Herder run ${existing.record.runId} is already owned by live Pi pid ${existing.record.pid} (session ${existing.record.piSessionId}); refusing to attach.`);
					}
					if (existing.record.resetCleanupRequired) {
						throw new Error(`Herder Pi reset requires manual child-process cleanup before removing the ownership lock; ownership evidence retained: ${lockPath}`);
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
		} finally { fs.closeSync(probed.descriptor); }
	} finally { database.close(); }
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
		processIdentity: (options.processIdentity ?? adapterProcessIdentity)(options.pid ?? process.pid),
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

export function releaseAdapterOwnership(ownership: AdapterOwnership, strict = false): void {
	if (strict) {
		try {
			assertAdapterOwnership(ownership, path.dirname(path.dirname(ownership.lockPath)));
			fs.unlinkSync(ownership.lockPath);
		} finally { fs.closeSync(ownership.descriptor); }
		return;
	}
	try {
		const opened = fs.fstatSync(ownership.descriptor);
		const named = fs.lstatSync(ownership.lockPath);
		if (named.isFile() && !named.isSymbolicLink() && sameIdentity(opened, named)) {
			try { fs.unlinkSync(ownership.lockPath); } catch {}
		}
	} catch {}
	try { fs.closeSync(ownership.descriptor); } catch {}
}

/** Native birth identity, never a command-name heuristic. Failure is deliberately fatal. */
export function adapterProcessIdentity(pid: number): string {
	if (process.platform === "linux") {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (!ticks || !/^\d+$/.test(ticks)) throw new Error("Cannot read Pi process start ticks");
		return `linux:${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
	}
	if (process.platform === "darwin") {
		const birth = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8", timeout: 2_000, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C" },
		}).trim();
		if (!birth) throw new Error("Cannot read Pi process birth identity");
		return `darwin:${birth}`;
	}
	throw new Error("Safe Pi process identity is unsupported on this platform; exit the owning Pi once.");
}

export function assertAdapterOwnership(ownership: AdapterOwnership, planDirectory: string): void {
	const runtime = fs.lstatSync(path.dirname(ownership.lockPath));
	if (runtime.isSymbolicLink() || !runtime.isDirectory() || !sameIdentity(ownership.runtimeIdentity, runtime)) {
		throw new Error("Herder Pi runtime directory was replaced; refusing reset/signals");
	}
	const opened = fs.fstatSync(ownership.descriptor);
	const named = fs.lstatSync(ownership.lockPath);
	if (ownership.lockPath !== adapterOwnershipLockPath(planDirectory)
		|| !opened.isFile() || named.isSymbolicLink() || !named.isFile() || !sameIdentity(opened, named)) {
		throw new Error("Herder Pi ownership lock was replaced; refusing reset");
	}
}

/** Invalidate the exact claim durably before any cleanup can begin. */
export function markAdapterOwnershipCleanupRequired(ownership: AdapterOwnership): void {
	// Also inhibit asynchronous local release if persistence itself fails.
	ownership.record = { ...ownership.record, resetCleanupRequired: true };
	const planDirectory = path.dirname(path.dirname(ownership.lockPath));
	assertAdapterOwnership(ownership, planDirectory);
	const database = openExecutionDatabase(planDirectory, { create: true });
	try {
		withExecutionTransaction(database, () => {
			const descriptor = fs.openSync(ownership.lockPath, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
			try {
				assertAdapterOwnership({ ...ownership, descriptor }, planDirectory);
				if (!sameIdentity(fs.fstatSync(descriptor), fs.fstatSync(ownership.descriptor))) {
					throw new Error("Herder Pi ownership lock was replaced; refusing reset/signals");
				}
				const stat = fs.fstatSync(descriptor);
				if (stat.size < 1 || stat.size > MAX_LOCK_BYTES) throw new Error("Herder Pi ownership lock is malformed; refusing cleanup");
				// Use the persisted identity: startup run binding intentionally changes only memory.
				const record = parseRecord(fs.readFileSync(descriptor, "utf8"), ownership.lockPath);
				if (!record.resetCleanupRequired) {
					const text = `${JSON.stringify({ ...record, resetCleanupRequired: true })}\n`;
					if (Buffer.byteLength(text) > MAX_LOCK_BYTES) throw new Error("Herder Pi cleanup-required lock exceeds size limit; refusing reset/signals");
					// Persist invalidation first: interrupted writes cannot leave a valid unmarked claim.
					fs.ftruncateSync(descriptor, 0);
					fs.fsyncSync(descriptor);
					if (fs.writeSync(descriptor, text, 0, "utf8") !== Buffer.byteLength(text)) {
						throw new Error("Herder Pi cleanup-required lock write was incomplete; refusing cleanup");
					}
				}
				fs.fsyncSync(descriptor);
				assertAdapterOwnership(ownership, planDirectory);
				assertAdapterOwnership({ ...ownership, descriptor }, planDirectory);
			} finally { fs.closeSync(descriptor); }
		});
	} finally { database.close(); }
}

export interface AdapterResetOptions extends AdapterOwnershipOptions {
	ownership?: AdapterOwnership;
	confirm: (title: string, message: string) => Promise<boolean>;
	quiesce: () => Promise<void>;
	signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	wait?: (milliseconds: number) => Promise<void>;
	waitAttempts?: number;
}

/** Confirmation precedes all lifecycle changes; retain an exclusive inode through the drain/reset. */
export async function withAdapterResetOwnership<T>(
	planDirectory: string, piSessionId: string, options: AdapterResetOptions,
	reset: (ownership: AdapterOwnership) => Promise<T>,
): Promise<T | undefined> {
	const runtime = ensureRuntimeDirectory(planDirectory);
	const runtimeIdentity = fs.lstatSync(runtime);
	const verifyRuntime = () => {
		const named = fs.lstatSync(runtime);
		if (named.isSymbolicLink() || !named.isDirectory() || !sameIdentity(runtimeIdentity, named)) {
			throw new Error("Herder Pi runtime directory was replaced; refusing reset/signals");
		}
	};
	const alive = options.isProcessAlive ?? adapterProcessAlive;
	const identity = options.processIdentity ?? adapterProcessIdentity;
	const signal = options.signal ?? ((pid, value) => { process.kill(pid, value); });
	const wait = options.wait ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
	let held = options.ownership;
	if (held) assertAdapterOwnership(held, planDirectory);
	else {
		let existing: ReturnType<typeof inspectExisting> | undefined;
		try { existing = inspectExisting(adapterOwnershipLockPath(planDirectory)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (existing) {
			try {
				const record = existing.record;
				if (alive(record.pid)) {
					if (record.pid === process.pid || record.pid === options.pid) throw new Error("This Pi owns the lock in another adapter; exit the owning Pi once before reset.");
					const verify = () => {
						verifyRuntime();
						assertAdapterOwnership({ ...existing!, runtimeIdentity, lockPath: adapterOwnershipLockPath(planDirectory) }, planDirectory);
						if (!record.processIdentity) throw new Error("Legacy live Pi ownership has no process identity; exit the owning Pi once, then retry reset.");
						if (identity(record.pid) !== record.processIdentity) throw new Error("Pi PID identity mismatch; refusing to signal. Exit the owning Pi once and retry.");
					};
					verify();
					if (!await options.confirm("Terminate foreign Pi?", `PID ${record.pid}, session ${record.piSessionId}: the ENTIRE foreign Pi exits, affecting other work in that Pi. Terminate it and reset?`)) return undefined;
					verify();
					markAdapterOwnershipCleanupRequired({ ...existing, runtimeIdentity, lockPath: adapterOwnershipLockPath(planDirectory) });
					for (const value of ["SIGTERM", "SIGKILL"] as const) {
						if (!alive(record.pid)) break;
						verify(); // Best effort: Node cannot make identity inspection and kill atomic.
						signal(record.pid, value);
						for (let attempt = 0; attempt < (options.waitAttempts ?? 50) && alive(record.pid); attempt++) {
							if (identity(record.pid) !== record.processIdentity) throw new Error("Pi PID identity changed while waiting; refusing reset");
							await wait(100);
						}
					}
					if (alive(record.pid)) throw new Error("Timed out waiting for foreign Pi exit; refusing reset");
					verifyRuntime();
					// Exit alone (especially KILL) says nothing about detached shell cleanup.
					if (fs.existsSync(adapterOwnershipLockPath(planDirectory))) {
						throw new Error("Foreign Pi exited without releasing its cleanup lock; manual child-process cleanup required before reset. Ownership evidence preserved.");
					}
				}
				verifyRuntime();
				// Do not reap a replacement claim, even if its PID appears dead.
				try { assertAdapterOwnership({ ...existing, runtimeIdentity, lockPath: adapterOwnershipLockPath(planDirectory) }, planDirectory); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			} finally { fs.closeSync(existing.descriptor); }
		}
		await waitForAdapterOwnershipRetirement(planDirectory);
		verifyRuntime();
		held = acquireAdapterOwnership(planDirectory, "pending-reset", piSessionId, options);
	}
	let drained = false;
	try {
		verifyRuntime();
		markAdapterOwnershipCleanupRequired(held);
		await options.quiesce();
		verifyRuntime();
		drained = true;
		assertAdapterOwnership(held, planDirectory);
		return await reset(held);
	} finally {
		// A replaced lock is never removed and is not reported as reset success.
		if (drained) { verifyRuntime(); releaseAdapterOwnership(held, true); }
	}
}
