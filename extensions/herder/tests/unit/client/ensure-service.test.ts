import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	ensureService,
	requestService,
	stopService,
	submitManagerOperation,
	waitManagerOperation,
} from "../../../src/client/index.ts";
import { git } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";

function planRoot(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-ensure-service-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.name", "Herder Client Test"]);
	git(root, ["config", "user.email", "herder-client@example.invalid"]);
	const planDirectory = path.join(root, "herder-plans");
	mkdirSync(planDirectory, { recursive: true });
	writeFileSync(path.join(planDirectory, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|

## Dependency notes

None.

## Considered and rejected

None.
`);
	git(root, ["add", "."]);
	git(root, ["commit", "-q", "-m", "test: client fixture"]);
	return root;
}

function fakeServiceProcess(script: string): { pid: number; kill: () => void } {
	const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
	child.unref();
	if (!child.pid) throw new Error("failed to spawn fake service");
	return { pid: child.pid, kill: () => { try { process.kill(child.pid!, "SIGKILL"); } catch {} } };
}

function registerService(planDirectory: string, pid: number): void {
	const store = new RunStore(planDirectory);
	try {
		store.putService({
			instanceId: "stale-instance",
			pid,
			port: 1,
			authToken: "stale",
			dashboardUrl: "http://127.0.0.1:1/",
			forwardedUrl: null,
			startedAt: new Date().toISOString(),
		});
	} finally { store.close(); }
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

test("ensureService reuses one daemon for concurrent callers", async () => {
	const root = planRoot();
	const planDirectory = path.join(root, "herder-plans");
	try {
		const [first, second] = await Promise.all([ensureService(planDirectory), ensureService(planDirectory)]);
		assert.equal(second.instanceId, first.instanceId);
		assert.equal(second.pid, first.pid);
	} finally {
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("manager controls use immediate durable submission and polling", async () => {
	const root = planRoot();
	const planDirectory = path.join(root, "herder-plans");
	try {
		const service = await ensureService(planDirectory);
		const started = Date.now();
		const receipt = await submitManagerOperation(service, "stop", {}, "client-operation-test");
		assert.ok(Date.now() - started < 1_000, "operation submission waited for manager execution");
		assert.equal(receipt.operationId, "client-operation-test");
		assert.ok(["accepted", "running", "succeeded"].includes(receipt.state));
		assert.equal((await requestService(service, "/health")).ok, true);
		const result = await waitManagerOperation(service, receipt.operationId) as Record<string, unknown>;
		assert.equal(result.status, "idle");
		const replay = await submitManagerOperation(service, "stop", {}, receipt.operationId);
		assert.equal(replay.state, "succeeded");
		await assert.rejects(() => submitManagerOperation(service, "stop", { changed: true }, receipt.operationId), /replayed with different payload/);
	} finally {
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureService replaces a stale registration whose pid is dead", async () => {
	const root = planRoot();
	const planDirectory = path.join(root, "herder-plans");
	try {
		registerService(planDirectory, 999_999_999);
		const service = await ensureService(planDirectory, { unresponsiveGraceMs: 1_000 });
		assert.notEqual(service.pid, 999_999_999);
		assert.ok(alive(service.pid));
	} finally {
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureService waits for a live owner and replaces it only after the grace period", async () => {
	const root = planRoot();
	const planDirectory = path.join(root, "herder-plans");
	const script = path.join(root, "herder-stub-service.js");
	writeFileSync(script, "setInterval(() => {}, 1000);\n");
	const stub = fakeServiceProcess(script);
	try {
		registerService(planDirectory, stub.pid);
		const started = Date.now();
		const service = await ensureService(planDirectory, { unresponsiveGraceMs: 1_500 });
		// The stub owned the registration but never served; herder must not spawn a
		// duplicate beside it. It waits through the grace period, terminates the
		// wedged owner, and only then starts the real daemon.
		assert.ok(Date.now() - started >= 1_000, "returned before the grace period elapsed");
		assert.notEqual(service.pid, stub.pid);
		assert.ok(alive(service.pid));
		assert.ok(!alive(stub.pid), "wedged owner was not terminated");
	} finally {
		stub.kill();
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});
