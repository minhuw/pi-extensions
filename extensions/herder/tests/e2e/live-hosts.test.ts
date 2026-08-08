import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stopService } from "../../src/client/index.ts";
import { readManagerState } from "../../src/daemon/execution-store.ts";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureScript = path.join(extensionRoot, "tests/e2e/support/live-manager-fixture.ts");
const extensionEntry = path.join(extensionRoot, "adapters/pi/index.ts");
const providerExtension = process.env.HERDER_PI_PROVIDER_EXTENSION
	|| path.join(os.homedir(), ".pi/agent/npm/node_modules/@router-for-me/pi-cliproxyapi-provider/extensions/index.ts");
const enabled = process.env.HERDER_LIVE_E2E === "1";
const keep = process.env.HERDER_KEEP_E2E === "1";
const timeout = Number(process.env.HERDER_E2E_TIMEOUT_MS || 30 * 60_000);

function liveEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env, HERDER_LIVE_E2E_CHILD: "1" };
	delete environment.NODE_TEST_CONTEXT;
	return environment;
}

async function invokePi(repository: string, planDirectory: string, logFile: string): Promise<void> {
	writeFileSync(logFile, "");
	const child = spawn(process.env.HERDER_PI_BIN || "pi", [
		"--mode", "rpc", "--provider", "cliproxyapi", "--model", "kimi-k3", "--thinking", "max", "--approve",
		"--no-extensions", "--extension", providerExtension, "--extension", extensionEntry,
	], { cwd: repository, env: liveEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
	child.stdout.on("data", (chunk) => appendFileSync(logFile, chunk));
	child.stderr.on("data", (chunk) => appendFileSync(logFile, chunk));
	child.stdin.write(`${JSON.stringify({
		id: "herder-fire",
		type: "prompt",
		message: "/herder-fire herder-plans --profile poorman --max-parallel 1",
	})}\n`);
	const deadline = Date.now() + timeout;
	try {
		while (Date.now() < deadline) {
			if (child.exitCode !== null) throw new Error(`Pi RPC exited ${child.exitCode} before the run completed`);
			const manager = readManagerState(planDirectory);
			if (manager.run?.status === "complete") return;
			if (manager.run && ["paused", "needs_input", "failed", "stopped"].includes(manager.run.status)) {
				throw new Error(`Pi manager entered ${manager.run.status}: ${manager.run.terminalDetail || "no detail"}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error(`Pi RPC timed out after ${timeout}ms`);
	} finally {
		child.stdin.end();
		await Promise.race([
			new Promise<void>((resolve) => child.once("exit", () => resolve())),
			new Promise<void>((resolve) => setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 5_000)),
		]);
	}
}

test("live Pi/Poorman run", { skip: !enabled, timeout: timeout + 60_000 }, async () => {
	const workspace = mkdtempSync(path.join(os.tmpdir(), "herder-pi-live-"));
	const logFile = path.join(workspace, "pi.log");
	let passed = false;
	try {
		execFileSync(process.execPath, [fixtureScript, "create", workspace], { cwd: extensionRoot, stdio: "pipe" });
		const fixture = JSON.parse(readFileSync(path.join(workspace, "fixture.json"), "utf8"));
		await invokePi(fixture.repository, fixture.planDirectory, logFile);
		execFileSync(process.execPath, [fixtureScript, "verify", workspace, "--host", "pi", "--profile", "poorman"], {
			cwd: extensionRoot,
			stdio: "pipe",
			timeout: 60_000,
		});
		await stopService(fixture.planDirectory).catch(() => {});
		passed = true;
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\nfixture retained at ${workspace}`);
	} finally {
		const fixturePath = path.join(workspace, "fixture.json");
		if (exists(fixturePath)) {
			const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
			await stopService(fixture.planDirectory).catch(() => {});
		}
		if (passed && !keep) rmSync(workspace, { recursive: true, force: true });
	}
});

function exists(file: string): boolean {
	try { readFileSync(file); return true; } catch { return false; }
}
