import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createDashboardHandler } from "../dashboard/herder-dashboard.ts";
import { enableDashboardHostAccess } from "../dashboard/dashboard-host.ts";
import { openExecutionDatabase } from "./execution-store.ts";
import type { ManagerWorkerResult } from "./manager-worker.ts";
import { RunStore } from "./run-store.ts";

const LOOPBACK = "127.0.0.1";
const MAX_BODY = 4 * 1024 * 1024;
const CONTROL_PATHS = new Set(["/health", "/v1/status", "/v1/start", "/v1/event", "/v1/edit", "/v1/stop", "/shutdown"]);

function parseArguments(argv: string[]): { planDirectory: string; dashboardPort: number } {
	let planDirectory = "herder-plans";
	let dashboardPort = 0;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]!;
		if (!["--plan-dir", "--dashboard-port"].includes(argument)) throw new Error(`Unknown service argument: ${argument}`);
		const value = argv[++index];
		if (!value) throw new Error(`${argument} requires a value`);
		if (argument === "--plan-dir") planDirectory = value;
		else dashboardPort = Number(value);
	}
	if (!Number.isSafeInteger(dashboardPort) || dashboardPort < 0 || dashboardPort > 65535) throw new Error("--dashboard-port must be 0 through 65535");
	return { planDirectory: path.resolve(planDirectory), dashboardPort };
}

function send(response: http.ServerResponse, status: number, value: unknown): void {
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
 * Runs the deterministic manager core on a worker thread so blocking Git and
 * SQLite work never starves this process's event loop. Calls are serialized by
 * the service queue, so at most one call is in flight; a crashed worker is
 * replaced lazily on the next call (run state lives in SQLite by design).
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

	async call(method: "reply" | "start" | "event" | "edit" | "stop" | "auditScheduler", input?: unknown): Promise<unknown> {
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

export async function startHerderService(input: { planDirectory: string; dashboardPort?: number }) {
	const planDirectory = fs.realpathSync(input.planDirectory);
	openExecutionDatabase(planDirectory, { create: true })!.close();
	const instanceId = randomUUID();
	const authToken = randomBytes(32).toString("base64url");
	const dashboard = createDashboardHandler({ planDir: planDirectory });
	let dashboardUrl = "";
	let forwardedUrl: string | null = null;
	let queue = Promise.resolve();
	let auditTimer: NodeJS.Timeout | undefined;
	let closeService: () => Promise<void> = async () => {};
	const executor = new ManagerExecutor(planDirectory);

	const server = http.createServer((request, response) => {
		let url: URL;
		try { url = new URL(request.url || "/", `http://${LOOPBACK}`); }
		catch { send(response, 400, { ok: false, error: "invalid-url" }); return; }
		if (!CONTROL_PATHS.has(url.pathname)) {
			dashboard.handle(request, response);
			return;
		}
		if (request.headers.authorization !== `Bearer ${authToken}`) {
			send(response, 401, { ok: false, error: "unauthorized" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/health") {
			send(response, 200, { ok: true, instanceId, pid: process.pid, planDirectory, dashboardUrl, forwardedUrl });
			return;
		}
		const execute = async () => {
			try {
				if (request.method === "GET" && url.pathname === "/v1/status") send(response, 200, { ok: true, reply: await executor.call("reply") });
				else if (request.method !== "POST") send(response, 405, { ok: false, error: "method-not-allowed" });
				else if (url.pathname === "/v1/start") {
					const body = await readBody(request) as Record<string, unknown>;
					send(response, 200, { ok: true, reply: await executor.call("start", { ...body, planDirectory, dashboardUrl: forwardedUrl || dashboardUrl }) });
				} else if (url.pathname === "/v1/event") {
					const body = await readBody(request) as Record<string, unknown>;
					send(response, 200, { ok: true, reply: await executor.call("event", body) });
				} else if (url.pathname === "/v1/edit") {
					const body = await readBody(request) as Record<string, unknown>;
					send(response, 200, { ok: true, ...(await executor.call("edit", body) as Record<string, unknown>) });
				} else if (url.pathname === "/v1/stop") {
					await readBody(request);
					send(response, 200, { ok: true, reply: await executor.call("stop") });
				} else if (url.pathname === "/shutdown") {
					await readBody(request);
					send(response, 200, { ok: true, instanceId });
					setImmediate(() => void closeService());
				} else send(response, 404, { ok: false, error: "not-found" });
			} catch (error) {
				send(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		};
		queue = queue.then(execute, execute);
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
		try {
			const access = await enableDashboardHostAccess({ url: dashboardUrl, allowHost: dashboard.allowHost });
			forwardedUrl = typeof access.forwardedUrl === "string" ? access.forwardedUrl : null;
		} catch {}

		const now = new Date().toISOString();
		const store = new RunStore(planDirectory);
		try {
			store.transaction(() => {
				store.putService({ instanceId, pid: process.pid, port: address.port, authToken, dashboardUrl, forwardedUrl, startedAt: now });
				if (store.getRun()) store.updateRun({ dashboardUrl: forwardedUrl || dashboardUrl });
			});
		} finally { store.close(); }
	} catch (error) {
		await close();
		throw error;
	}

	auditTimer = setInterval(() => {
		const audit = async () => {
			try { await executor.call("auditScheduler"); }
			catch (error) { process.stderr.write(`herder-service scheduler audit: ${error instanceof Error ? error.message : String(error)}\n`); }
		};
		queue = queue.then(audit, audit);
	}, 1500);
	auditTimer.unref();

	closeService = async () => {
		if (auditTimer) clearInterval(auditTimer);
		await close();
		await executor.close();
	};
	process.once("SIGINT", () => void closeService());
	process.once("SIGTERM", () => void closeService());
	return { instanceId, port: address.port, dashboardUrl, forwardedUrl, server, close: closeService };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	startHerderService(parseArguments(process.argv.slice(2))).catch((error) => {
		process.stderr.write(`herder-service: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
