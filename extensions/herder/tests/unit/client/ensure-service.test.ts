import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
	ensureService,
	requestManagerOperation,
	requestService,
	executeManagerOperation,
	stopService,
	pollManagerOperation,
	submitManagerOperation,
	submitManagerOperationReliable,
	waitManagerOperation,
	waitManagerOperationReliable,
} from "../../../src/client/index.ts";
import { planFixture } from "../../support/plan-fixture.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { MANAGER_PROTOCOL_VERSION } from "../../../src/shared/protocol.ts";

function fakeServiceProcess(script: string): { pid: number; kill: () => void } {
	const child = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
	child.unref();
	if (!child.pid) throw new Error("failed to spawn fake service");
	return { pid: child.pid, kill: () => { try { process.kill(child.pid!, "SIGKILL"); } catch {} } };
}

function registerService(planDirectory: string, pid: number, port = 1, authToken = "stale"): void {
	const store = new RunStore(planDirectory);
	try {
		store.putService({
			instanceId: "stale-instance",
			pid,
			port,
			authToken,
			dashboardUrl: "http://127.0.0.1:1/",
			startedAt: new Date().toISOString(),
		});
	} finally { store.close(); }
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function oldProtocolServiceProcess(): Promise<{ pid: number; port: number; authToken: string; kill: () => void }> {
	const authToken = "stale";
	const child = spawn(process.execPath, ["-e", `const http = require("node:http"); const server = http.createServer((req, res) => { if (req.url !== "/health" || req.headers.authorization !== "Bearer ${authToken}") { res.writeHead(401); return res.end(); } res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, instanceId: "stale-instance", pid: process.pid, runtimeExecutable: process.execPath, managerProtocolVersion: ${MANAGER_PROTOCOL_VERSION - 1}, executionSchemaVersion: 17, capabilities: ["durable-operations"] })); }); server.listen(0, "127.0.0.1", () => console.log(server.address().port)); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
	if (!child.pid || !child.stdout) throw new Error("failed to spawn old protocol service");
	const port = await new Promise<number>((resolve, reject) => {
		let output = "";
		const onData = (chunk: Buffer): void => {
			output += chunk.toString();
			const value = Number(output.trim());
			if (Number.isInteger(value) && value > 0) { child.stdout!.off("data", onData); resolve(value); }
		};
		child.stdout.on("data", onData);
		child.once("error", reject);
	});
	return { pid: child.pid, port, authToken, kill: () => { try { process.kill(child.pid!, "SIGKILL"); } catch {} } };
}

test("detached daemon startup does not invoke Orca host integration", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
	const command = path.join(root, "fake-orca.cjs");
	const calls = path.join(root, "orca-calls.log");
	writeFileSync(command, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");\n`);
	chmodSync(command, 0o755);
	const previousOwned = process.env.ORCA_PI_STATUS_OWNED;
	const previousCommand = process.env.ORCA_CLI_COMMAND;
	process.env.ORCA_PI_STATUS_OWNED = "test-owned";
	process.env.ORCA_CLI_COMMAND = command;
	try {
		await ensureService(planDirectory);
		assert.equal(existsSync(calls), false, "daemon startup opened an Orca tab");
	} finally {
		if (previousOwned === undefined) delete process.env.ORCA_PI_STATUS_OWNED;
		else process.env.ORCA_PI_STATUS_OWNED = previousOwned;
		if (previousCommand === undefined) delete process.env.ORCA_CLI_COMMAND;
		else process.env.ORCA_CLI_COMMAND = previousCommand;
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureService reuses one daemon for concurrent callers", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
	try {
		const [first, second] = await Promise.all([ensureService(planDirectory), ensureService(planDirectory)]);
		assert.equal(second.instanceId, first.instanceId);
		assert.equal(second.pid, first.pid);
		const health = await requestService(first, "/health");
		assert.equal(health.dashboardUrl, first.dashboardUrl);
		assert.equal(Object.hasOwn(health, "forwardedUrl"), false);
	} finally {
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("stable scheduler audits preserve snapshots while health stays responsive", { timeout: 10_000 }, async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
	try {
		const service = await ensureService(planDirectory);
		const beforeStore = new RunStore(planDirectory);
		const before = beforeStore.getSnapshotEnvelope();
		beforeStore.close();
		assert.ok(before);

		const deadline = Date.now() + 4_000;
		let healthChecks = 0;
		while (Date.now() < deadline) {
			const health = await requestService(service, "/health");
			assert.equal(health.ok, true);
			assert.equal(health.runtimeExecutable, process.execPath);
			healthChecks += 1;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		assert.ok(healthChecks >= 2, "health was not sampled across the audit interval");

		const afterStore = new RunStore(planDirectory);
		const after = afterStore.getSnapshotEnvelope();
		afterStore.close();
		assert.ok(after);
		assert.equal(after.revision, before.revision);
		assert.deepEqual(after.reply, before.reply);
	} finally {
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("manager controls use immediate durable submission and polling", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
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

test("reliable submission and wait recovery preserve operation identity without wait-only resubmission", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
	const originalFetch = globalThis.fetch;
	let failSubmit = true;
	let failPoll = true;
	let operationPosts = 0;
	globalThis.fetch = async (input, init) => {
		const pathname = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		if (pathname === "/v1/operation" && method === "POST") {
			operationPosts += 1;
			if (failSubmit) {
				failSubmit = false;
				throw new Error("fetch failed");
			}
		}
		if (pathname === "/v1/operation" && method === "GET" && failPoll) {
			failPoll = false;
			throw new Error("fetch failed");
		}
		return originalFetch(input, init);
	};
	try {
		const receipt = await submitManagerOperationReliable(planDirectory, "stop", {}, "reliable-submit-test");
		assert.equal(receipt.operationId, "reliable-submit-test");
		assert.equal(operationPosts, 2, "submission should retry the same durable operation");
		const result = await waitManagerOperationReliable(planDirectory, receipt.operationId) as Record<string, unknown>;
		assert.equal(result.status, "idle");
		assert.equal(operationPosts, 2, "wait-only recovery must not resubmit the operation");
	} finally {
		globalThis.fetch = originalFetch;
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});
test("execute recovery replays an accepted operation with the same identity", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
	const originalFetch = globalThis.fetch;
	let loseReceipt = true;
	let operationPosts = 0;
	globalThis.fetch = async (input, init) => {
		const pathname = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		if (pathname === "/v1/operation" && method === "POST") {
			operationPosts += 1;
			const response = await originalFetch(input, init);
			if (loseReceipt) {
				loseReceipt = false;
				throw new Error("fetch failed after durable acceptance");
			}
			return response;
		}
		return originalFetch(input, init);
	};
	try {
		const result = await executeManagerOperation(planDirectory, "stop", {}, "execute-replay-test") as Record<string, unknown>;
		assert.equal(result.status, "idle");
		assert.equal(operationPosts, 2, "execution should replay the same operation after losing its receipt");
	} finally {
		globalThis.fetch = originalFetch;
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("execute and wait-only surface durable terminal failures without reconnecting", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
	const originalFetch = globalThis.fetch;
	let operationPosts = 0;
	let operationGets = 0;
	let healthRequests = 0;
	const operationId = "terminal-failure-test";
	try {
		await ensureService(planDirectory);
		globalThis.fetch = async (input, init) => {
			const pathname = new URL(String(input)).pathname;
			const method = init?.method ?? "GET";
			if (pathname === "/health" && method === "GET") healthRequests += 1;
			if (pathname === "/v1/operation" && method === "POST") operationPosts += 1;
			if (pathname === "/v1/operation" && method === "GET") operationGets += 1;
			return originalFetch(input, init);
		};

		await assert.rejects(
			() => executeManagerOperation(planDirectory, "event", {
				eventId: "terminal-failure-event",
				kind: "dispatch_results",
				dispatchResults: [],
			}, operationId),
			{ message: "No deterministic Herder run exists" },
		);
		assert.equal(operationPosts, 1, "terminal failure must not trigger a replay submission");
		// The daemon may reach terminal failure before the first poll; scheduling
		// must not determine how many nonterminal receipts this test observes.
		const executePolls = operationGets;
		assert.ok(executePolls >= 1, "execute should poll the durable operation until terminal failure");
		assert.equal(healthRequests, 1, "terminal failure must not trigger service reacquisition");

		await assert.rejects(
			() => waitManagerOperationReliable(planDirectory, operationId),
			{ message: "No deterministic Herder run exists" },
		);
		assert.equal(operationPosts, 1, "wait-only terminal failure must not resubmit");
		assert.equal(operationGets, executePolls + 1, "wait-only terminal failure should poll once");
		assert.equal(healthRequests, 2, "wait-only terminal failure must not retry service reacquisition");
	} finally {
		globalThis.fetch = originalFetch;
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("typed manager facade preserves envelopes, supplied IDs, and failures", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
	try {
		const service = await ensureService(planDirectory);
		const stopped = await requestManagerOperation(service, "stop", {}, "facade-supplied-stop");
		assert.equal(stopped.ok, true);
		assert.equal((stopped.reply as Record<string, unknown>).status, "idle");
		assert.equal((await pollManagerOperation(service, "facade-supplied-stop")).operationId, "facade-supplied-stop");

		const event = { eventId: "facade-invalid-event", kind: "dispatch_results", dispatchResults: [] };
		await assert.rejects(() => requestManagerOperation(service, "event", event), /.+/);
		await assert.rejects(() => requestManagerOperation(service, "event", event), /.+/);
		await assert.rejects(
			() => requestManagerOperation(service, "event", { ...event, dispatchResults: [{ actionId: "different" }] }),
			/replayed with different payload/,
		);
	} finally {
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy blocking control paths remain authenticated HTTP tombstones", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
	try {
		const service = await ensureService(planDirectory);
		for (const pathname of ["/v1/start", "/v1/event", "/v1/edit", "/v1/stop"]) {
			const response = await fetch(`http://127.0.0.1:${service.port}${pathname}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${service.authToken}`,
				"Content-Type": "application/json",
			},
			body: "{}",
			});
			assert.equal(response.status, 410, pathname);
			const body = await response.json() as { error?: string };
			assert.match(body.error ?? "", /blocking-control-endpoint-removed/);
			assert.match(body.error ?? "", /submit \/v1\/operation and poll \/v1\/operation\?id=/);
		}
	} finally {
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});
test("ensureService replaces a prior-protocol daemon", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
	const old = await oldProtocolServiceProcess();
	try {
		registerService(planDirectory, old.pid, old.port, old.authToken);
		const service = await ensureService(planDirectory, { unresponsiveGraceMs: 1_000 });
		assert.notEqual(service.pid, old.pid);
		assert.ok(alive(service.pid));
		assert.equal((await requestService(service, "/health")).managerProtocolVersion, MANAGER_PROTOCOL_VERSION);
	} finally {
		old.kill();
		await stopService(planDirectory).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("ensureService replaces a stale registration whose pid is dead", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
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
	const { root, planDirectory } = planFixture({ prefix: "herder-ensure-service-" });
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
