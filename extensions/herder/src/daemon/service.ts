import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createDashboardHandler } from "../dashboard/herder-dashboard.ts";
import {
	acquireServiceOwnership,
	releaseServiceOwnership,
	serviceOwnershipIsCurrent,
	type FileIdentity,
	type ServiceOwnership,
} from "./service-ownership.ts";
import {
	MANAGER_OPERATION_KINDS,
	MANAGER_PROTOCOL_VERSION,
	integrationRepairCapabilityDigest,
	integrationRepairCapabilityToken,
	type ManagerOperationKind,
	type StoredManagerOperationKind,
	type ManagerOperationReceipt,
	type ManagerReply,
} from "../shared/protocol.ts";
import { EXECUTION_SCHEMA_VERSION, executionDatabasePath, openExecutionDatabase } from "./execution-store.ts";
import type { ManagerWorkerResult } from "./manager-worker.ts";
import { RunStore, type StoredManagerOperation } from "./run-store.ts";

const LOOPBACK = "127.0.0.1";
const MAX_BODY = 4 * 1024 * 1024;
const MAX_PENDING_OPERATIONS = 32;
const DEFAULT_TERMINAL_IDLE_MS = 30_000;
const DEFAULT_RUNTIME_IDENTITY_CHECK_MS = 1_500;
const TERMINAL_RUN_STATUSES = new Set(["complete", "failed", "stopped"]);
const DIRECT_CONTROL_PATHS = new Set(["/health", "/v1/status", "/v1/operation", "/shutdown"]);
const LEGACY_BLOCKING_PATHS = new Set(["/v1/start", "/v1/event", "/v1/edit", "/v1/stop"]);

function parseArguments(argv: string[]): { planDirectory: string; dashboardPort: number; terminalIdleMs: number; runtimeIdentityCheckMs: number } {
	let planDirectory = "herder-plans";
	let dashboardPort = 0;
	let terminalIdleMs = DEFAULT_TERMINAL_IDLE_MS;
	let runtimeIdentityCheckMs = DEFAULT_RUNTIME_IDENTITY_CHECK_MS;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!;
		if (!["--plan-dir", "--dashboard-port", "--terminal-idle-ms", "--runtime-identity-check-ms"].includes(argument)) throw new Error(`Unknown service argument: ${argument}`);
		const value = argv[++index];
		if (!value) throw new Error(`${argument} requires a value`);
		if (argument === "--plan-dir") planDirectory = value;
		else if (argument === "--dashboard-port") dashboardPort = Number(value);
		else if (argument === "--terminal-idle-ms") terminalIdleMs = Number(value);
		else runtimeIdentityCheckMs = Number(value);
	}
	if (!Number.isSafeInteger(dashboardPort) || dashboardPort < 0 || dashboardPort > 65535) throw new Error("--dashboard-port must be 0 through 65535");
	if (!Number.isSafeInteger(terminalIdleMs) || terminalIdleMs < 0) throw new Error("--terminal-idle-ms must be a non-negative integer");
	if (!Number.isSafeInteger(runtimeIdentityCheckMs) || runtimeIdentityCheckMs < 1) throw new Error("--runtime-identity-check-ms must be a positive integer");
	return { planDirectory: path.resolve(planDirectory), dashboardPort, terminalIdleMs, runtimeIdentityCheckMs };
}

function sameFileIdentity(expected: FileIdentity, current: fs.Stats): boolean {
	return expected.dev === current.dev && expected.ino === current.ino;
}

function captureRegularFileIdentity(candidate: string, label: string): FileIdentity {
	const stat = fs.lstatSync(candidate);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file: ${candidate}`);
	return { dev: stat.dev, ino: stat.ino };
}

function runtimeDatabaseIdentityIsCurrent(candidate: string, expected: FileIdentity): boolean {
	try {
		const stat = fs.lstatSync(candidate);
		return stat.isFile() && !stat.isSymbolicLink() && sameFileIdentity(expected, stat);
	} catch {
		return false;
	}
}

function statusReplyFromSnapshot(
	snapshot: ManagerReply,
	liveStatus: string | undefined,
	liveDetail: string | null | undefined,
	operations: ManagerOperationReceipt[],
): ManagerReply {
	const status = (liveStatus ?? snapshot.status) as ManagerReply["status"];
	const diverged = liveStatus !== undefined && liveStatus !== snapshot.status;
	const { reigniteRequest, operations: _snapshotOperations, ...rest } = snapshot;
	return {
		...rest,
		status,
		...(diverged && liveDetail ? { message: liveDetail } : {}),
		...(status === "complete" && reigniteRequest ? { reigniteRequest } : {}),
		...(operations.length > 0 ? { operations } : {}),
	};
}

function send(response: http.ServerResponse, status: number, value: unknown): void {
	if (response.destroyed || response.writableEnded) return;
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
	response.writeHead(status, {
		"Cache-Control": "no-store",
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": bytes.length,
		"X-Content-Type-Options": "nosniff",
	});
	response.end(bytes);
}


async function readBody(request: http.IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += bytes.length;
		if (length > MAX_BODY) throw new Error("Request body is too large");
		chunks.push(bytes);
	}
	return length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * The manager keeps synchronous Git and SQLite semantics on one worker thread.
 * HTTP never waits on this worker: durable operations are accepted into SQLite,
 * processed here in sequence, and observed through short polling requests.
 */
class ManagerExecutor {
	private readonly planDirectory: string;
	private worker: Worker | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

	constructor(planDirectory: string) {
		this.planDirectory = planDirectory;
	}

	private attach(worker: Worker): void {
		worker.on("message", (reply: ManagerWorkerResult) => {
			const entry = this.pending.get(reply.id);
			if (!entry) return;
			this.pending.delete(reply.id);
			if (reply.ok) entry.resolve(reply.result);
			else entry.reject(new Error(reply.error || "Herder manager call failed"));
		});
		const crash = (error: Error) => {
			if (this.worker === worker) this.worker = undefined;
			for (const entry of this.pending.values()) entry.reject(error);
			this.pending.clear();
		};
		worker.once("error", (error: unknown) => crash(error instanceof Error ? error : new Error(String(error))));
		worker.once("exit", (code) => { if (code !== 0) crash(new Error(`Herder manager worker exited with code ${code}`)); });
	}

	async call(method: "reply" | "start" | "event" | "edit" | "stop" | "verification" | "reignite" | "integration_repair" | "auditScheduler" | "dashboardState", input?: unknown): Promise<unknown> {
		if (!this.worker) {
			const worker = new Worker(new URL("./manager-worker.ts", import.meta.url), { workerData: { planDirectory: this.planDirectory } });
			this.attach(worker);
			this.worker = worker;
		}
		const worker = this.worker;
		const id = this.nextId++;
		return await new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ id, method, input });
		});
	}

	async close(): Promise<void> {
		const worker = this.worker;
		this.worker = undefined;
		if (!worker) return;
		worker.removeAllListeners("error");
		worker.removeAllListeners("exit");
		for (const entry of this.pending.values()) entry.reject(new Error("Herder service is shutting down"));
		this.pending.clear();
		await worker.terminate();
	}
}

function operationReply(kind: ManagerOperationKind, result: unknown): ManagerReply | null {
	if (kind === "edit") {
		const reply = result && typeof result === "object" && !Array.isArray(result) ? (result as { reply?: unknown }).reply : undefined;
		return reply && typeof reply === "object" && !Array.isArray(reply) ? reply as ManagerReply : null;
	}
	return result && typeof result === "object" && !Array.isArray(result) ? result as ManagerReply : null;
}

export async function startHerderService(input: { planDirectory: string; dashboardPort?: number; terminalIdleMs?: number; runtimeIdentityCheckMs?: number }) {
	const planDirectory = fs.realpathSync(input.planDirectory);
	const terminalIdleMs = input.terminalIdleMs ?? DEFAULT_TERMINAL_IDLE_MS;
	const runtimeIdentityCheckMs = input.runtimeIdentityCheckMs ?? DEFAULT_RUNTIME_IDENTITY_CHECK_MS;
	if (!Number.isSafeInteger(terminalIdleMs) || terminalIdleMs < 0) throw new Error("terminalIdleMs must be a non-negative integer");
	if (!Number.isSafeInteger(runtimeIdentityCheckMs) || runtimeIdentityCheckMs < 1) throw new Error("runtimeIdentityCheckMs must be a positive integer");
	const instanceId = randomUUID();
	const ownership: ServiceOwnership = acquireServiceOwnership(planDirectory, instanceId);
	let executionDatabaseIdentity: FileIdentity;
	try {
		openExecutionDatabase(planDirectory, { create: true })!.close();
		executionDatabaseIdentity = captureRegularFileIdentity(executionDatabasePath(planDirectory), "Execution database");
	} catch (error) {
		releaseServiceOwnership(ownership);
		throw error;
	}
	const authToken = randomBytes(32).toString("base64url");
	let dashboardUrl = "";
	let auditTimer: NodeJS.Timeout | undefined;
	let terminalIdleTimer: NodeJS.Timeout | undefined;
	let runtimeIdentityTimer: NodeJS.Timeout | undefined;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	let closeService: () => Promise<void> = async () => {};
	let backgroundQueue = Promise.resolve();
	let drainScheduled = false;
	const executor = new ManagerExecutor(planDirectory);
	const store = new RunStore(planDirectory);
	store.recoverRunningOperations();
	let dashboardRevision: number | null = null;
	const updateDashboardRevision = (reply: ManagerReply): void => {
		const snapshot = store.getSnapshotEnvelope();
		dashboardRevision = reply.runId && snapshot ? snapshot.revision : null;
	};
	const dashboard = createDashboardHandler({
		planDir: planDirectory,
		revisionProvider: () => dashboardRevision,
		stateBodyProvider: async () => await executor.call("dashboardState") as string,
	});

	const enqueueBackground = <T>(task: () => Promise<T>): Promise<T> => {
		const next = backgroundQueue.then(task, task);
		backgroundQueue = next.then(() => undefined, () => undefined);
		return next;
	};

	const clearTerminalIdleShutdown = (): void => {
		if (terminalIdleTimer) clearTimeout(terminalIdleTimer);
		terminalIdleTimer = undefined;
	};

	const scheduleTerminalIdleShutdown = (): void => {
		clearTerminalIdleShutdown();
		if (closing) return;
		const run = store.getRun();
		if (!run || !TERMINAL_RUN_STATUSES.has(run.status) || store.countPendingOperations() !== 0) return;
		terminalIdleTimer = setTimeout(() => {
			terminalIdleTimer = undefined;
			const current = store.getRun();
			if (!closing && current && TERMINAL_RUN_STATUSES.has(current.status) && store.countPendingOperations() === 0) void closeService();
		}, terminalIdleMs);
		terminalIdleTimer.unref();
	};

	const executeOperation = async (operation: StoredManagerOperation): Promise<void> => {
		try {
			const recoveredPayload = operation.kind === "start" && operation.attemptCount > 1 && store.getRun()
				&& operation.payload && typeof operation.payload === "object" && !Array.isArray(operation.payload)
				&& (operation.payload as { mode?: unknown }).mode === "fire"
				? { ...(operation.payload as Record<string, unknown>), mode: "resume" }
				: operation.payload;
			let payload = operation.kind === "start" && recoveredPayload && typeof recoveredPayload === "object" && !Array.isArray(recoveredPayload)
				? { ...(recoveredPayload as Record<string, unknown>), dashboardUrl }
				: recoveredPayload;
			if ((operation.kind === "integration_repair" || operation.kind === "repair") && payload && typeof payload === "object" && !Array.isArray(payload)) {
				const repairPayload = payload as Record<string, unknown>;
				if (!repairPayload.capabilityToken && typeof repairPayload.requestId === "string") {
					const capabilityToken = integrationRepairCapabilityToken(repairPayload.requestId);
					if (repairPayload.capabilityTokenSha256 !== integrationRepairCapabilityDigest(capabilityToken)) throw new Error("Integration repair capability digest is missing or invalid");
					payload = { ...repairPayload, capabilityToken };
				}
			}
			if (operation.kind === "verification" && payload && typeof payload === "object" && !Array.isArray(payload)) {
				const verificationPayload = payload as Record<string, unknown>;
				const stored = typeof verificationPayload.requestId === "string" ? store.getVerificationByRequestId(verificationPayload.requestId) : null;
				if (stored?.request.repairId && stored.state === "running" && stored.manifest) payload = stored.manifest;
			}
			const runtimeKind = operation.kind === "repair" ? "integration_repair" : operation.kind;
			const result = await executor.call(runtimeKind, payload);
			const reply = operationReply(runtimeKind, result);
			store.transaction(() => {
				store.completeOperation(operation.operationId, result);
				if (reply) store.putSnapshot(reply);
			});
			if (reply) updateDashboardRevision(reply);
			scheduleTerminalIdleShutdown();
		} catch (error) {
			store.failOperation(operation.operationId, error instanceof Error ? error.message : String(error));
			scheduleTerminalIdleShutdown();
		}
	};

	const drainOperations = async (): Promise<void> => {
		while (!closing) {
			const operation = store.claimNextOperation();
			if (!operation) return;
			await executeOperation(operation);
		}
	};

	const scheduleDrain = (): void => {
		if (closing || drainScheduled) return;
		drainScheduled = true;
		void enqueueBackground(async () => {
			try { await drainOperations(); }
			finally {
				drainScheduled = false;
				if (!closing && store.countPendingOperations() > 0) scheduleDrain();
			}
		});
	};

	const server = http.createServer((request, response) => {
		let url: URL;
		try { url = new URL(request.url || "/", `http://${LOOPBACK}`); }
		catch { send(response, 400, { ok: false, error: "invalid-url" }); return; }
		if (!DIRECT_CONTROL_PATHS.has(url.pathname) && !LEGACY_BLOCKING_PATHS.has(url.pathname)) {
			dashboard.handle(request, response);
			return;
		}
		if (request.headers.authorization !== `Bearer ${authToken}`) {
			send(response, 401, { ok: false, error: "unauthorized" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/health") {
			send(response, 200, {
				ok: true,
				instanceId,
				pid: process.pid,
				runtimeExecutable: process.execPath,
				planDirectory,
				dashboardUrl,
				managerProtocolVersion: MANAGER_PROTOCOL_VERSION,
				executionSchemaVersion: EXECUTION_SCHEMA_VERSION,
				capabilities: ["durable-operations", "snapshot-status", "main-session-verification", "main-session-reignite", "attention-resolution", "transactional-integration-repair"],
			});
			return;
		}
		if (request.method === "GET" && url.pathname === "/v1/status") {
			const snapshot = store.getSnapshotEnvelope();
			const operations = store.pendingOperationReceipts();
			const live = store.getRun();
			send(response, snapshot ? 200 : 503, snapshot ? {
				ok: true,
				reply: statusReplyFromSnapshot(snapshot.reply, live?.status, live?.terminalDetail, operations),
				snapshot: { revision: snapshot.revision, updatedAt: snapshot.updatedAt },
				operations,
			} : { ok: false, error: "manager-snapshot-unavailable" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/v1/operation") {
			const operationId = url.searchParams.get("id") || "";
			const operation = operationId ? store.operationReceipt(operationId) : null;
			send(response, operation ? 200 : 404, operation ? { ok: true, operation } : { ok: false, error: "operation-not-found" });
			return;
		}
		if (request.method === "POST" && url.pathname === "/v1/operation") {
			void readBody(request).then((body) => {
				const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
				const operationId = String(record.operationId || "");
				const kind = String(record.kind || "") as StoredManagerOperationKind;
				const existing = operationId ? store.getOperation(operationId) : null;
				if (!existing && !MANAGER_OPERATION_KINDS.includes(kind as ManagerOperationKind)) throw new Error(`Unknown manager operation kind: ${kind}`);
				if (!existing && store.countPendingOperations() >= MAX_PENDING_OPERATIONS) {
					send(response, 429, { ok: false, error: "operation-queue-full" });
					return;
				}
				const operation = existing
					? store.replayOperation(operationId, kind, record.input ?? {})
					: store.submitOperation(operationId, kind as ManagerOperationKind, record.input ?? {});
				clearTerminalIdleShutdown();
				send(response, 202, { ok: true, operation });
				scheduleDrain();
			}).catch((error) => send(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }));
			return;
		}
		if (request.method === "POST" && url.pathname === "/shutdown") {
			void readBody(request).then(() => {
				send(response, 200, { ok: true, instanceId });
				setImmediate(() => void closeService());
			}).catch((error) => send(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }));
			return;
		}
		if (LEGACY_BLOCKING_PATHS.has(url.pathname)) {
			send(response, 410, { ok: false, error: "blocking-control-endpoint-removed; submit /v1/operation and poll /v1/operation?id=..." });
			return;
		}
		send(response, 405, { ok: false, error: "method-not-allowed" });
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(input.dashboardPort ?? 0, LOOPBACK, () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Herder service did not receive a TCP port");
	dashboardUrl = `http://${LOOPBACK}:${address.port}/`;
	const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
	try {
		const now = new Date().toISOString();
		if (store.getRun()) store.updateRun({ dashboardUrl });
		const initialReply = await executor.call("reply") as ManagerReply;
		store.transaction(() => {
			store.putSnapshot(initialReply);
			// Publish service ownership only after the status snapshot is ready, so a
			// client cannot discover the new daemon and read the previous daemon's URL.
			store.putService({ instanceId, pid: process.pid, port: address.port, authToken, dashboardUrl, startedAt: now });
		});
		updateDashboardRevision(initialReply);
	} catch (error) {
		store.close();
		releaseServiceOwnership(ownership);
		await close();
		throw error;
	}

	const scheduleAudit = () => {
		if (closing) return;
		auditTimer = setTimeout(() => {
			void enqueueBackground(async () => {
				if (closing || store.countPendingOperations() > 0) return;
				try {
					const reply = await executor.call("auditScheduler") as ManagerReply | null;
					if (reply) {
						store.putSnapshot(reply);
						updateDashboardRevision(reply);
					}
				} catch (error) {
					process.stderr.write(`herder-service scheduler audit: ${error instanceof Error ? error.message : String(error)}\n`);
				}
			}).finally(scheduleAudit);
		}, 1500);
		auditTimer.unref();
	};
	const scheduleRuntimeIdentityWatchdog = (): void => {
		if (closing) return;
		runtimeIdentityTimer = setTimeout(() => {
			runtimeIdentityTimer = undefined;
			if (!closing && (!serviceOwnershipIsCurrent(ownership) || !runtimeDatabaseIdentityIsCurrent(executionDatabasePath(planDirectory), executionDatabaseIdentity))) {
				void closeService();
				return;
			}
			scheduleRuntimeIdentityWatchdog();
		}, runtimeIdentityCheckMs);
		runtimeIdentityTimer.unref();
	};

	closeService = async () => {
		if (closePromise) return closePromise;
		closePromise = (async () => {
			if (closing) return;
			closing = true;
			if (auditTimer) clearTimeout(auditTimer);
			if (terminalIdleTimer) clearTimeout(terminalIdleTimer);
			if (runtimeIdentityTimer) clearTimeout(runtimeIdentityTimer);
			auditTimer = undefined;
			terminalIdleTimer = undefined;
			runtimeIdentityTimer = undefined;
			await close();
			await backgroundQueue.catch(() => {});
			await executor.close();
			store.close();
			releaseServiceOwnership(ownership);
		})();
		return closePromise;
	};
	scheduleDrain();
	scheduleAudit();
	scheduleRuntimeIdentityWatchdog();
	scheduleTerminalIdleShutdown();
	process.once("SIGINT", () => void closeService());
	process.once("SIGTERM", () => void closeService());
	return { instanceId, port: address.port, dashboardUrl, server, close: closeService };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	startHerderService(parseArguments(process.argv.slice(2))).catch((error) => {
		process.stderr.write(`herder-service: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
