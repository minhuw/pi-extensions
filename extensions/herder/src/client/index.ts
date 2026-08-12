import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	acquireExecutionRotationEpoch,
	EXECUTION_SCHEMA_VERSION,
	clearExecutionRotationMarker,
	executionAuthorityHandoffReady,
	executionRotationMarkerIdentity,
	hasExecutionRotationMarker,
	openExecutionDatabase,
} from "../daemon/execution-store.ts";
import { RunStore, type StoredService } from "../daemon/run-store.ts";
import {
	acquireStartExclusion,
	acquireServiceOwnership,
	releaseServiceOwnership,
	releaseStartExclusion,
	serviceOwnershipLockPath,
	serviceProcessAlive,
	type ServiceOwnership,
	type StartExclusion,
} from "../daemon/service-ownership.ts";
import { resolveNodeExecutable } from "../shared/node-executable.ts";
import { MANAGER_PROTOCOL_VERSION, stableJson, sha256, type AttentionResolutionInput, type ManagerOperationKind, type ManagerOperationReceipt } from "../shared/protocol.ts";

const CLIENT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ENTRY = path.resolve(CLIENT_ROOT, "../daemon/service.ts");

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function rawRequest(service: StoredService, pathname: string, input?: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`http://127.0.0.1:${service.port}${pathname}`, {
			method: input === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${service.authToken}`,
				...(input === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(input === undefined ? {} : { body: JSON.stringify(input) }),
			signal: controller.signal,
		});
		const body = await response.json() as Record<string, unknown>;
		if (!response.ok || body.ok === false) throw new Error(String(body.error || `Herder service returned HTTP ${response.status}`));
		return body;
	} finally {
		clearTimeout(timer);
	}
}

export async function submitManagerOperation(
	service: StoredService,
	kind: ManagerOperationKind,
	input: unknown,
	operationId: string = randomUUID(),
): Promise<ManagerOperationReceipt> {
	const body = await rawRequest(service, "/v1/operation", { operationId, kind, input }, 10_000);
	const operation = body.operation;
	if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("Herder service returned no operation receipt");
	return operation as ManagerOperationReceipt;
}

export async function pollManagerOperation(service: StoredService, operationId: string): Promise<ManagerOperationReceipt> {
	const body = await rawRequest(service, `/v1/operation?id=${encodeURIComponent(operationId)}`, undefined, 10_000);
	const operation = body.operation;
	if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("Herder service returned no operation state");
	return operation as ManagerOperationReceipt;
}

export async function submitAttentionResolution(
	service: StoredService,
	resolution: AttentionResolutionInput,
	eventId: string = `attention:${sha256(stableJson(resolution))}`,
): Promise<ManagerOperationReceipt> {
	return submitManagerOperation(service, "event", {
		eventId,
		kind: "attention",
		attention: resolution,
	}, `event:${eventId}`);
}

export async function waitManagerOperation(service: StoredService, operationId: string): Promise<unknown> {
	for (;;) {
		const operation = await pollManagerOperation(service, operationId);
		if (operation.state === "succeeded") return operation.result;
		if (operation.state === "failed") throw new Error(operation.error || `Herder operation ${operationId} failed`);
		await delay(250);
	}
}

const OPERATION_PATHS: Record<string, ManagerOperationKind> = {
	"/v1/start": "start",
	"/v1/event": "event",
	"/v1/attention": "event",
	"/v1/edit": "edit",
	"/v1/stop": "stop",
	"/v1/verification": "verification",
};

export async function requestService(service: StoredService, pathname: string, input?: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
	const kind = OPERATION_PATHS[pathname];
	if (!kind) return rawRequest(service, pathname, input, timeoutMs);
	const attentionInput = pathname === "/v1/attention" ? {
		eventId: `attention:${sha256(stableJson(input ?? {}))}`,
		kind: "attention",
		attention: input,
	} : null;
	const operationInput = attentionInput ?? input ?? {};
	const eventId = kind === "event" && operationInput && typeof operationInput === "object" && !Array.isArray(operationInput)
		? String((operationInput as { eventId?: unknown }).eventId || "")
		: "";
	const operationId = eventId ? `event:${eventId}` : randomUUID();
	const operation = await submitManagerOperation(service, kind, operationInput, operationId);
	const result = operation.state === "succeeded" ? operation.result : await waitManagerOperation(service, operation.operationId);
	if (kind === "edit") return { ok: true, ...(result as Record<string, unknown>) };
	return { ok: true, reply: result };
}

const HEALTH_TIMEOUT_MS = 2_000;
const SERVICE_WAIT_INTERVAL_MS = 500;
const SERVICE_STARTUP_ATTEMPTS = 80;
const SERVICE_REPLACEMENT_ATTEMPTS = 150;
const DEFAULT_UNRESPONSIVE_GRACE_MS = 45_000;

function registeredService(planDirectory: string): StoredService | null {
	let store: RunStore;
	try { store = new RunStore(planDirectory, { readOnly: true }); }
	catch { return null; }
	const service = store.getService();
	store.close();
	return service;
}

async function incompatibleService(service: StoredService): Promise<boolean> {
	try {
		const health = await requestService(service, "/health", undefined, HEALTH_TIMEOUT_MS);
		return health.instanceId === service.instanceId && Number(health.pid) === service.pid
			&& (health.runtimeExecutable !== process.execPath
				|| Number(health.managerProtocolVersion) !== MANAGER_PROTOCOL_VERSION
				|| Number(health.executionSchemaVersion) !== EXECUTION_SCHEMA_VERSION
				|| !Array.isArray(health.capabilities)
				|| !health.capabilities.includes("durable-operations"));
	} catch { return false; }
}

export async function healthyService(planDirectory: string): Promise<StoredService | null> {
	const service = registeredService(planDirectory);
	if (!service) return null;
	try {
		const health = await requestService(service, "/health", undefined, HEALTH_TIMEOUT_MS);
		const compatible = health.instanceId === service.instanceId
			&& Number(health.pid) === service.pid
			&& health.runtimeExecutable === process.execPath
			&& Number(health.managerProtocolVersion) === MANAGER_PROTOCOL_VERSION
			&& Number(health.executionSchemaVersion) === EXECUTION_SCHEMA_VERSION
			&& Array.isArray(health.capabilities)
			&& health.capabilities.includes("durable-operations");
		if (!compatible) return null;
		return existingServiceLogIsSafe(path.join(path.resolve(planDirectory), ".herder", "service.log")) ? service : null;
	} catch {
		return null;
	}
}

async function healthyUnmarkedService(planDirectory: string): Promise<StoredService | null> {
	if (hasExecutionRotationMarker(planDirectory)) return null;
	const service = await healthyService(planDirectory);
	return service && !hasExecutionRotationMarker(planDirectory) ? service : null;
}

async function terminateServiceProcess(pid: number): Promise<void> {
	try { process.kill(pid, "SIGTERM"); } catch { return; }
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (!serviceProcessAlive(pid)) return;
		await delay(100);
	}
	try { process.kill(pid, "SIGKILL"); } catch {}
}

function ensureRuntimeDirectory(directoryPath: string): fs.Stats {
	let stat: fs.Stats | null;
	try { stat = fs.lstatSync(directoryPath); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try { fs.mkdirSync(directoryPath, { mode: 0o700 }); }
		catch (mkdirError) {
			if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
		}
		stat = fs.lstatSync(directoryPath);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Execution runtime path must be a real directory: ${directoryPath}`);
	return stat;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function privateServiceLogMode(stat: fs.Stats): boolean {
	return process.platform === "win32" || (stat.mode & 0o7777) === 0o600;
}

function existingServiceLogIsSafe(logPath: string): boolean {
	if (!fs.constants.O_NOFOLLOW) throw new Error(`Safe service log opening is unavailable: ${logPath}`);
	let descriptor: number | undefined;
	try {
		let named: fs.Stats;
		try { named = fs.lstatSync(logPath); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		if (named.isSymbolicLink() || !named.isFile()) return false;
		descriptor = fs.openSync(logPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const opened = fs.fstatSync(descriptor);
		if (opened.isSymbolicLink() || !opened.isFile() || !sameFileIdentity(opened, named)) return false;
		if (!privateServiceLogMode(opened)) fs.fchmodSync(descriptor, 0o600);
		const repaired = fs.fstatSync(descriptor);
		const verified = fs.lstatSync(logPath);
		return repaired.isFile()
			&& privateServiceLogMode(repaired)
			&& !verified.isSymbolicLink()
			&& verified.isFile()
			&& sameFileIdentity(repaired, verified);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ELOOP") return false;
		return false;
	} finally {
		if (descriptor !== undefined) {
			try { fs.closeSync(descriptor); } catch {}
		}
	}
}

function openServiceLog(logPath: string): number {
	if (!fs.constants.O_NOFOLLOW) throw new Error(`Safe service log opening is unavailable: ${logPath}`);
	let descriptor: number | undefined;
	try {
		const existing = (() => {
			try { return fs.lstatSync(logPath); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
		})();
		if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
			throw new Error(`Service log must be a regular file: ${logPath}`);
		}
		descriptor = fs.openSync(
			logPath,
			fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
			0o600,
		);
		const opened = fs.fstatSync(descriptor);
		if (!opened.isFile()) throw new Error(`Service log must be a regular file: ${logPath}`);
		const named = fs.lstatSync(logPath);
		if (named.isSymbolicLink() || !named.isFile() || !sameFileIdentity(opened, named)) {
			throw new Error(`Service log path changed while opening: ${logPath}`);
		}
		fs.fchmodSync(descriptor, 0o600);
		const repaired = fs.fstatSync(descriptor);
		const verified = fs.lstatSync(logPath);
		if (!repaired.isFile() || !privateServiceLogMode(repaired) || verified.isSymbolicLink() || !verified.isFile() || !sameFileIdentity(repaired, verified)) {
			throw new Error(`Service log is not a private regular file: ${logPath}`);
		}
		return descriptor;
	} catch (error) {
		if (descriptor !== undefined) {
			try { fs.closeSync(descriptor); } catch {}
		}
		throw error;
	}
}

function spawnServiceProcess(planDirectory: string, options: { dashboardPort?: number }, logPath: string): void {
	const log = openServiceLog(logPath);
	try {
		const child = spawn(resolveNodeExecutable(), [
			"--experimental-strip-types",
			SERVICE_ENTRY,
			"--plan-dir", planDirectory,
			"--dashboard-port", String(options.dashboardPort ?? 0),
		], {
			detached: true,
			stdio: ["ignore", log, log],
			env: process.env,
		});
		child.unref();
	} finally {
		fs.closeSync(log);
	}
}

export async function ensureService(planDirectoryInput: string, options: { dashboardPort?: number; unresponsiveGraceMs?: number } = {}): Promise<StoredService> {
	const planDirectory = fs.realpathSync(path.resolve(planDirectoryInput));
	const readme = path.join(planDirectory, "README.md");
	if (!fs.existsSync(readme) || fs.lstatSync(readme).isSymbolicLink() || !fs.statSync(readme).isFile()) {
		throw new Error(`Herder plan index is missing or unsafe: ${readme}`);
	}
	const runtimeDirectory = path.join(planDirectory, ".herder");
	ensureRuntimeDirectory(runtimeDirectory);
	const lockPath = path.join(runtimeDirectory, "service-start.lock");
	const logPath = path.join(runtimeDirectory, "service.log");
	const runWithStartLock = async (lock: StartExclusion): Promise<StoredService | null> => {
		let releaseRotationEpoch: (() => void) | undefined;
		try {
			// Keep the cross-process rotation epoch held through every asynchronous
			// health and handoff observation. Writable publishers use this same lock,
			// so a late marker cannot appear after the final absence observation.
			releaseRotationEpoch = acquireExecutionRotationEpoch(planDirectory);
			// All writable exposure repair happens under the existing start lock. A
			// concurrent caller therefore cannot publish a new rotation epoch between
			// the final health check and this caller's handoff.
			openExecutionDatabase(planDirectory, { create: true })!.close();
			let markerIdentity = executionRotationMarkerIdentity(planDirectory);
			let rotationRequired = markerIdentity !== null;
			const rechecked = rotationRequired ? null : await healthyUnmarkedService(planDirectory);
			if (rechecked) {
				if (executionAuthorityHandoffReady(planDirectory)) return rechecked;
				const settledMarker = executionRotationMarkerIdentity(planDirectory);
				if (settledMarker === null) throw new Error("Execution authority handoff changed without a rotation marker");
				markerIdentity = settledMarker;
				rotationRequired = true;
			}
			markerIdentity = executionRotationMarkerIdentity(planDirectory);
			rotationRequired = markerIdentity !== null;
			const registered = registeredService(planDirectory);
			const registeredLogSafe = registered ? existingServiceLogIsSafe(logPath) : true;
			const registeredLogPresent = registered ? (() => {
				try { fs.lstatSync(logPath); return true; }
				catch { return false; }
			})() : false;
			if (rotationRequired && registered && serviceProcessAlive(registered.pid)) {
				await terminateServiceProcess(registered.pid);
			} else if (registered && serviceProcessAlive(registered.pid)) {
				if (!registeredLogSafe && registeredLogPresent) {
					// Never reuse a daemon whose append target cannot be proven to be a
					// private regular file. The startup helper will refuse symlinks too.
					await terminateServiceProcess(registered.pid);
				} else if (await incompatibleService(registered)) {
					// An authenticated daemon that explicitly reports an obsolete protocol is
					// replaced immediately. An unresponsive owner still receives the grace period.
					await terminateServiceProcess(registered.pid);
				} else {
					// A live daemon already owns this plan directory. Never spawn a duplicate:
					// give a busy daemon time to answer, and replace it only if it stays wedged.
					const deadline = Date.now() + (options.unresponsiveGraceMs ?? DEFAULT_UNRESPONSIVE_GRACE_MS);
					while (Date.now() < deadline) {
						await delay(SERVICE_WAIT_INTERVAL_MS);
						if (executionRotationMarkerIdentity(planDirectory) !== null) {
							rotationRequired = true;
							break;
						}
						const service = await healthyUnmarkedService(planDirectory);
						if (service) {
							if (executionAuthorityHandoffReady(planDirectory)) return service;
							const settledMarker = executionRotationMarkerIdentity(planDirectory);
							if (settledMarker === null) throw new Error("Execution authority handoff changed without a rotation marker");
							rotationRequired = true;
							break;
						}
						if (executionRotationMarkerIdentity(planDirectory) !== null) {
							rotationRequired = true;
							break;
						}
						if (!serviceProcessAlive(registered.pid)) break;
					}
					if (rotationRequired || serviceProcessAlive(registered.pid)) await terminateServiceProcess(registered.pid);
				}
			}
			markerIdentity = executionRotationMarkerIdentity(planDirectory);
			rotationRequired = markerIdentity !== null;
			let previousInstanceId = rotationRequired ? registered?.instanceId : undefined;
			let replacementBaselinePending = rotationRequired && previousInstanceId === undefined;
			const observeMarker = (observed: string | null): void => {
				if (observed === markerIdentity) return;
				if (observed === null) {
					if (rotationRequired) throw new Error(`Execution rotation marker disappeared before authority rotation completed: ${path.join(runtimeDirectory, "rotation-required")}`);
					markerIdentity = null;
					return;
				}
				markerIdentity = observed;
				rotationRequired = true;
				previousInstanceId = undefined;
				replacementBaselinePending = true;
			};
			const waitForService = async (attempts: number, intervalMs: number): Promise<StoredService | "restart" | null> => {
				for (let attempt = 0; attempt < attempts; attempt += 1) {
					observeMarker(executionRotationMarkerIdentity(planDirectory));
					const service = await healthyService(planDirectory);
					observeMarker(executionRotationMarkerIdentity(planDirectory));
					if (service) {
						if (!rotationRequired) {
							if (executionAuthorityHandoffReady(planDirectory)) return service;
							const publishedMarker = executionRotationMarkerIdentity(planDirectory);
							if (publishedMarker === null) throw new Error("Execution authority handoff changed without a rotation marker");
							markerIdentity = publishedMarker;
							rotationRequired = true;
							previousInstanceId = service.instanceId;
							replacementBaselinePending = false;
							await terminateServiceProcess(service.pid);
							return "restart";
						}
						if (replacementBaselinePending || previousInstanceId === undefined || service.instanceId === previousInstanceId) {
							previousInstanceId = service.instanceId;
							replacementBaselinePending = false;
							await terminateServiceProcess(service.pid);
							return "restart";
						}
						const expectedMarker = markerIdentity;
						if (expectedMarker === null) throw new Error("Execution rotation marker disappeared before authority rotation completed");
						const cleared = clearExecutionRotationMarker(planDirectory, expectedMarker);
						const remainingMarker = executionRotationMarkerIdentity(planDirectory);
						if (cleared && remainingMarker === null) {
							// Marker publication and this handoff are serialized by the shared
							// epoch lock. The process-local epoch also detects a reentrant
							// publication that occurs inside the final absence observation.
							if (executionAuthorityHandoffReady(planDirectory)) {
								markerIdentity = null;
								rotationRequired = false;
								return service;
							}
							const settledMarker = executionRotationMarkerIdentity(planDirectory);
							if (settledMarker === null) throw new Error("Execution authority handoff changed without a rotation marker");
							markerIdentity = settledMarker;
							rotationRequired = true;
							previousInstanceId = service.instanceId;
							replacementBaselinePending = false;
							await terminateServiceProcess(service.pid);
							return "restart";
						}
						await terminateServiceProcess(service.pid);
						if (remainingMarker === null) {
							throw new Error("Execution rotation marker disappeared while authority rotation was being completed");
						}
						markerIdentity = remainingMarker;
						rotationRequired = true;
						previousInstanceId = service.instanceId;
						replacementBaselinePending = true;
						return "restart";
					}
					await delay(intervalMs);
				}
				return null;
			};
			for (;;) {
				spawnServiceProcess(planDirectory, options, logPath);
				let result = await waitForService(SERVICE_STARTUP_ATTEMPTS, 100);
				if (result === "restart") continue;
				if (result) return result;
				observeMarker(executionRotationMarkerIdentity(planDirectory));
				if (rotationRequired) {
					result = await waitForService(SERVICE_REPLACEMENT_ATTEMPTS, SERVICE_WAIT_INTERVAL_MS);
					if (result === "restart") continue;
					if (result) return result;
				}
				break;
			}
			return null;
		} finally {
			try { releaseRotationEpoch?.(); }
			finally {
				releaseStartExclusion(lock);
			}
		}
	};

	let launchAttempted = false;
	ensureRuntimeDirectory(runtimeDirectory);
	let lock = acquireStartExclusion(lockPath);
	if (lock !== null) {
		launchAttempted = true;
		const result = await runWithStartLock(lock);
		if (result) return result;
	}
	for (let attempt = 0; attempt < SERVICE_REPLACEMENT_ATTEMPTS; attempt += 1) {
		const service = await healthyUnmarkedService(planDirectory);
		if (service) return service;
		if (!launchAttempted) {
			ensureRuntimeDirectory(runtimeDirectory);
			lock = acquireStartExclusion(lockPath);
			if (lock !== null) {
				launchAttempted = true;
				const result = await runWithStartLock(lock);
				if (result) return result;
			}
		}
		await delay(SERVICE_WAIT_INTERVAL_MS);
	}
	let detail = "";
	try {
		const logStat = fs.lstatSync(logPath);
		if (!logStat.isSymbolicLink() && logStat.isFile()) {
			detail = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).slice(-4).join(" ");
		}
	} catch {}
	throw new Error(`Herder service did not become healthy${detail ? `: ${detail}` : ""}`);
}

const CLEANUP_TERMINAL_STATUSES = new Set(["complete", "failed", "stopped"]);
const CLEANUP_EXCLUSION_WAIT_MS = 5_000;

function ownerLockIsPresent(planDirectory: string): boolean {
	try { fs.lstatSync(serviceOwnershipLockPath(planDirectory)); return true; }
	catch { return false; }
}

async function waitForServiceShutdown(planDirectory: string, pid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (serviceProcessAlive(pid) || ownerLockIsPresent(planDirectory)) {
		if (Date.now() >= deadline) throw new Error("Cannot quiesce the Herder service before cleanup.");
		await delay(50);
	}
}

function managerReplyFromStatus(value: Record<string, unknown>): Record<string, unknown> {
	const reply = value.reply;
	if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error("Herder service returned no manager status.");
	return reply as Record<string, unknown>;
}

/**
 * Exclude daemon startup and hold the daemon-owner lock while a cleanup callback
 * performs its final preview and Git mutation. This path intentionally never
 * starts a replacement while cleanup owns the namespace, which would defeat
 * quiescence.
 */
export async function withServiceExclusion<T>(
	planDirectoryInput: string,
	callback: () => Promise<T> | T,
	options: { waitMs?: number } = {},
): Promise<T> {
	const planDirectory = fs.realpathSync(path.resolve(planDirectoryInput));
	const runtimeDirectory = path.join(planDirectory, ".herder");
	ensureRuntimeDirectory(runtimeDirectory);
	const startLock = acquireStartExclusion(path.join(runtimeDirectory, "service-start.lock"));
	if (!startLock) throw new Error("Herder service startup is already in progress; cleanup was not applied.");
	let ownership: ServiceOwnership | undefined;
	try {
		const registered = registeredService(planDirectory);
		if (registered && serviceProcessAlive(registered.pid)) {
			const service = await healthyService(planDirectory);
			if (!service) throw new Error("A live Herder service owner is unresponsive; cleanup was not applied.");
			let status: Record<string, unknown>;
			try { status = managerReplyFromStatus(await requestService(service, "/v1/status", undefined, HEALTH_TIMEOUT_MS)); }
			catch { throw new Error("A live Herder service owner is unresponsive; cleanup was not applied."); }
			const serviceStatus = String(status.status || "");
			if (!CLEANUP_TERMINAL_STATUSES.has(serviceStatus)) {
				throw new Error(`Herder service is ${serviceStatus || "active"}; cleanup requires a terminal run.`);
			}
			try { await requestService(service, "/shutdown", {}); }
			catch { throw new Error("A terminal Herder service could not be stopped; cleanup was not applied."); }
			await waitForServiceShutdown(planDirectory, registered.pid, options.waitMs ?? CLEANUP_EXCLUSION_WAIT_MS);
		}
		ownership = acquireServiceOwnership(planDirectory, `cleanup-${randomUUID()}`);
		return await callback();
	} finally {
		if (ownership) releaseServiceOwnership(ownership);
		releaseStartExclusion(startLock);
	}
}

export const withDaemonExclusion = withServiceExclusion;
export const withCleanupExclusion = withServiceExclusion;

function transportFailure(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
	return Boolean(cause && typeof cause.code === "string" && ["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(cause.code))
		|| /fetch failed|socket|operation-not-found|service did not become healthy/i.test(text)
		|| Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

export async function submitManagerOperationReliable(
	planDirectory: string,
	kind: ManagerOperationKind,
	input: unknown,
	operationId: string = randomUUID(),
): Promise<ManagerOperationReceipt> {
	let service = await ensureService(planDirectory);
	for (;;) {
		try { return await submitManagerOperation(service, kind, input, operationId); }
		catch (error) {
			if (!transportFailure(error)) throw error;
			service = await ensureService(planDirectory);
		}
	}
}

export async function executeManagerOperation(
	planDirectory: string,
	kind: ManagerOperationKind,
	input: unknown,
	operationId: string = randomUUID(),
): Promise<unknown> {
	let service = await ensureService(planDirectory);
	let submitted = false;
	for (;;) {
		try {
			if (!submitted) {
				const receipt = await submitManagerOperation(service, kind, input, operationId);
				submitted = true;
				if (receipt.state === "succeeded") return receipt.result;
				if (receipt.state === "failed") throw new Error(receipt.error || `Herder operation ${operationId} failed`);
			}
			return await waitManagerOperation(service, operationId);
		} catch (error) {
			if (!transportFailure(error)) throw error;
			service = await ensureService(planDirectory);
			submitted = false;
		}
	}
}

export async function stopService(planDirectory: string): Promise<void> {
	const service = await healthyService(planDirectory);
	if (!service) return;
	await requestService(service, "/shutdown", {});
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (!(await healthyService(planDirectory))) return;
		await delay(50);
	}
}
