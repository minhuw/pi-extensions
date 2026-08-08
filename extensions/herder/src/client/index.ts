import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { openExecutionDatabase } from "../daemon/execution-store.ts";
import { RunStore, type StoredService } from "../daemon/run-store.ts";

const CLIENT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ENTRY = path.resolve(CLIENT_ROOT, "../daemon/service.ts");

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function requestService(service: StoredService, pathname: string, input?: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
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

export async function healthyService(planDirectory: string): Promise<StoredService | null> {
	let store: RunStore;
	try { store = new RunStore(planDirectory, { readOnly: true }); }
	catch { return null; }
	const service = store.getService();
	store.close();
	if (!service) return null;
	try {
		const health = await requestService(service, "/health", undefined, 750);
		return health.instanceId === service.instanceId && Number(health.pid) === service.pid ? service : null;
	} catch {
		return null;
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function acquireStartLock(lockPath: string): number | null {
	try {
		const descriptor = fs.openSync(lockPath, "wx", 0o600);
		fs.writeFileSync(descriptor, `${process.pid}\n`);
		return descriptor;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let owner = 0;
		try { owner = Number(fs.readFileSync(lockPath, "utf8").trim()); } catch {}
		if (owner > 0 && processAlive(owner)) return null;
		try { fs.unlinkSync(lockPath); } catch {}
		return acquireStartLock(lockPath);
	}
}

export async function ensureService(planDirectoryInput: string, options: { dashboardPort?: number } = {}): Promise<StoredService> {
	const planDirectory = fs.realpathSync(path.resolve(planDirectoryInput));
	const readme = path.join(planDirectory, "README.md");
	if (!fs.existsSync(readme) || fs.lstatSync(readme).isSymbolicLink() || !fs.statSync(readme).isFile()) {
		throw new Error(`Herder plan index is missing or unsafe: ${readme}`);
	}
	openExecutionDatabase(planDirectory, { create: true })!.close();
	const existing = await healthyService(planDirectory);
	if (existing) return existing;
	const runtimeDirectory = path.join(planDirectory, ".herder");
	fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
	const lockPath = path.join(runtimeDirectory, "service-start.lock");
	const lock = acquireStartLock(lockPath);
	if (lock !== null) {
		try {
			const rechecked = await healthyService(planDirectory);
			if (rechecked) return rechecked;
			const logPath = path.join(runtimeDirectory, "service.log");
			const log = fs.openSync(logPath, "a", 0o600);
			const child = spawn(process.execPath, [
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
			fs.closeSync(log);
			for (let attempt = 0; attempt < 80; attempt += 1) {
				const service = await healthyService(planDirectory);
				if (service) return service;
				await delay(100);
			}
		} finally {
			fs.closeSync(lock);
			try { fs.unlinkSync(lockPath); } catch {}
		}
	}
	for (let attempt = 0; attempt < 80; attempt += 1) {
		const service = await healthyService(planDirectory);
		if (service) return service;
		await delay(100);
	}
	const logPath = path.join(planDirectory, ".herder", "service.log");
	let detail = "";
	try { detail = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).slice(-4).join(" "); } catch {}
	throw new Error(`Herder service did not become healthy${detail ? `: ${detail}` : ""}`);
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
