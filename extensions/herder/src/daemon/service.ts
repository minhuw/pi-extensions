import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createDashboardHandler } from "../dashboard/herder-dashboard.ts";
import { enableDashboardHostAccess } from "../dashboard/dashboard-host.ts";
import { openExecutionDatabase } from "./execution-store.ts";
import { HerderRunManager, type EventInput, type StartInput } from "../core/run-manager.ts";
import { RunStore } from "./run-store.ts";

const LOOPBACK = "127.0.0.1";
const MAX_BODY = 4 * 1024 * 1024;
const CONTROL_PATHS = new Set(["/health", "/v1/status", "/v1/start", "/v1/event", "/v1/stop", "/shutdown"]);

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
				const manager = new HerderRunManager(planDirectory);
				try {
					if (request.method === "GET" && url.pathname === "/v1/status") send(response, 200, { ok: true, reply: manager.reply() });
					else if (request.method !== "POST") send(response, 405, { ok: false, error: "method-not-allowed" });
					else if (url.pathname === "/v1/start") {
						const body = await readBody(request) as Record<string, unknown>;
						send(response, 200, { ok: true, reply: await manager.start({ ...(body as unknown as StartInput), planDirectory, dashboardUrl: forwardedUrl || dashboardUrl }) });
					} else if (url.pathname === "/v1/event") {
						const body = await readBody(request) as Record<string, unknown>;
						send(response, 200, { ok: true, reply: await manager.event(body as unknown as EventInput) });
					} else if (url.pathname === "/v1/stop") {
						await readBody(request);
						send(response, 200, { ok: true, reply: manager.stop() });
					} else if (url.pathname === "/shutdown") {
						await readBody(request);
						send(response, 200, { ok: true, instanceId });
						setImmediate(() => void closeService());
					} else send(response, 404, { ok: false, error: "not-found" });
				} finally { manager.close(); }
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
			const manager = new HerderRunManager(planDirectory);
			try { await manager.auditScheduler(); }
			catch (error) { process.stderr.write(`herder-service scheduler audit: ${error instanceof Error ? error.message : String(error)}\n`); }
			finally { manager.close(); }
		};
		queue = queue.then(audit, audit);
	}, 1500);
	auditTimer.unref();

	closeService = async () => {
		if (auditTimer) clearInterval(auditTimer);
		await close();
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
