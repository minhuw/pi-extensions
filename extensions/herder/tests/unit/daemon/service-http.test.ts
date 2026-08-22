import assert from "node:assert/strict";
import { realpathSync, rmSync } from "node:fs";
import test from "node:test";
import { RunStore } from "../../../src/daemon/run-store.ts";
import { startHerderService } from "../../../src/daemon/service.ts";
import { planFixture } from "../../support/plan-fixture.ts";

type ServiceHandle = Awaited<ReturnType<typeof startHerderService>>;

interface Harness {
	root: string;
	planDirectory: string;
	service: ServiceHandle;
	authToken: string;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
	const { root, planDirectory: fixturePlanDirectory } = planFixture({ prefix: "herder-service-http-" });
	const planDirectory = realpathSync(fixturePlanDirectory);
	let service: ServiceHandle | undefined;
	try {
		service = await startHerderService({ planDirectory, dashboardPort: 0, terminalIdleMs: 60_000 });
		const store = new RunStore(planDirectory);
		const storedService = store.getService();
		store.close();
		if (!storedService) throw new Error("service registration was not persisted");
		await run({ root, planDirectory, service, authToken: storedService.authToken });
	} finally {
		await service?.close().catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
}

interface HttpResult {
	status: number;
	body: unknown;
}

async function request(
	harness: Harness,
	pathname: string,
	init: RequestInit = {},
	authorization: string | null = `Bearer ${harness.authToken}`,
): Promise<HttpResult> {
	const headers = new Headers(init.headers);
	if (authorization === null) headers.delete("authorization");
	else headers.set("authorization", authorization);
	const response = await fetch(`http://127.0.0.1:${harness.service.port}${pathname}`, { ...init, headers });
	const text = await response.text();
	let body: unknown;
	try { body = JSON.parse(text); } catch { body = text; }
	return { status: response.status, body };
}

function jsonRequest(body: unknown, method = "POST"): RequestInit {
	return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function bodyRecord(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

function assertError(result: HttpResult, status: number, error: string): void {
	assert.equal(result.status, status);
	const body = bodyRecord(result.body);
	assert.equal(body.ok, false);
	assert.equal(body.error, error);
}

test("control routes require the bearer token", async () => {
	await withHarness(async (harness) => {
		for (const [pathname, authorization] of [
			["/health", null],
			["/v1/status", "Bearer wrong-token"],
			["/v1/operation?id=missing", null],
		] as const) {
			assertError(await request(harness, pathname, {}, authorization), 401, "unauthorized");
		}

		const healthResult = await request(harness, "/health");
		assert.equal(healthResult.status, 200);
		const health = bodyRecord(healthResult.body);
		assert.equal(health.ok, true);
	});
});

test("status returns the initial manager snapshot", async () => {
	await withHarness(async (harness) => {
		const result = await request(harness, "/v1/status");
		assert.equal(result.status, 200);
		const body = bodyRecord(result.body);
		assert.equal(body.ok, true);
		const reply = bodyRecord(body.reply);
		assert.equal(reply.status, "idle");
		assert.equal(reply.planDirectory, harness.planDirectory);
		const snapshot = bodyRecord(body.snapshot);
		assert.equal(snapshot.revision, 1);
		assert.equal(typeof snapshot.updatedAt, "string");
		assert.deepEqual(body.operations, []);
	});
});

test("operation lookup reports missing and unknown operation IDs", async () => {
	await withHarness(async (harness) => {
		assertError(await request(harness, "/v1/operation"), 404, "operation-not-found");
		assertError(await request(harness, "/v1/operation?id=unknown-operation"), 404, "operation-not-found");
	});
});

test("unknown operation kinds are rejected at the HTTP boundary", async () => {
	await withHarness(async (harness) => {
		const result = await request(harness, "/v1/operation", jsonRequest({ operationId: "unknown-kind", kind: "unknown", input: {} }));
		assertError(result, 400, "Unknown manager operation kind: unknown");
	});
});

test("idempotent operation replay preserves receipt identity", async () => {
	await withHarness(async (harness) => {
		const payload = { operationId: "replay-operation", kind: "stop", input: {} };
		const firstResult = await request(harness, "/v1/operation", jsonRequest(payload));
		assert.equal(firstResult.status, 202);
		const first = bodyRecord(firstResult.body);
		assert.equal(first.ok, true);
		const firstReceipt = bodyRecord(first.operation);
		const replayResult = await request(harness, "/v1/operation", jsonRequest(payload));
		assert.equal(replayResult.status, 202);
		const replay = bodyRecord(replayResult.body);
		assert.equal(replay.ok, true);
		const replayReceipt = bodyRecord(replay.operation);
		for (const key of ["protocolVersion", "operationId", "kind", "payloadSha256", "pollPath"]) {
			assert.deepEqual(replayReceipt[key], firstReceipt[key], `receipt identity changed for ${key}`);
		}
		assert.equal(firstReceipt.operationId, payload.operationId);
		assert.equal(firstReceipt.kind, payload.kind);
		assert.equal(typeof firstReceipt.payloadSha256, "string");
	});
});

test("operation bodies enforce the size limit and JSON syntax", async () => {
	await withHarness(async (harness) => {
		const oversized = await request(harness, "/v1/operation", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "x".repeat(4 * 1024 * 1024 + 1),
		});
		assertError(oversized, 400, "Request body is too large");

		const invalid = await request(harness, "/v1/operation", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});
		const invalidBody = bodyRecord(invalid.body);
		assert.equal(invalid.status, 400);
		assert.equal(invalidBody.ok, false);
		assert.equal(typeof invalidBody.error, "string");
	});
});

test("legacy control POSTs return the removal tombstone", async () => {
	await withHarness(async (harness) => {
		for (const pathname of ["/v1/start", "/v1/event", "/v1/edit", "/v1/stop"]) {
			const result = await request(harness, pathname, jsonRequest({}));
			assertError(result, 410, "blocking-control-endpoint-removed; submit /v1/operation and poll /v1/operation?id=...");
		}
	});
});

test("unsupported control methods return method-not-allowed", async () => {
	await withHarness(async (harness) => {
		const result = await request(harness, "/v1/status", { method: "POST" });
		assertError(result, 405, "method-not-allowed");
	});
});

test("the operation queue rejects the request after 32 pending items", async () => {
	await withHarness(async (harness) => {
		await new Promise<void>((resolve) => setImmediate(resolve));
		const store = new RunStore(harness.planDirectory);
		try {
			for (let index = 0; index < 32; index += 1) store.submitOperation(`queue-saturation-${index}`, "stop", {});
			assert.equal(store.countPendingOperations(), 32);
		} finally {
			store.close();
		}

		const result = await request(harness, "/v1/operation", jsonRequest({ operationId: "queue-overflow", kind: "stop", input: {} }));
		assertError(result, 429, "operation-queue-full");
	});
});
