import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import test from "node:test";
import { startHerderService } from "../../../src/daemon/service.ts";
import { planFixture } from "../../support/plan-fixture.ts";
import { serviceOwnershipLockPath } from "../../../src/daemon/service-ownership.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";

async function occupiedPort(): Promise<{ server: net.Server; port: number }> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not receive a TCP port");
	return { server, port: address.port };
}

async function closeNetServer(server: net.Server): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForSocketClose(socket: net.Socket): Promise<void> {
	if (socket.destroyed) return;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error("active service connection did not close"));
		}, 2_000);
		socket.once("close", () => {
			clearTimeout(timer);
			resolve();
		});
		socket.once("error", () => {});
	});
}

function installActiveConnectionProbe(active: { socket?: net.Socket }): () => void {
	const originalCreateServer = http.createServer;
	http.createServer = ((requestListener?: http.RequestListener) => {
		const server = originalCreateServer(requestListener);
		const originalListen = server.listen.bind(server);
		const invokeListen = (args: unknown[]): net.Server =>
			(originalListen as unknown as (...parameters: unknown[]) => net.Server)(...args);
		server.listen = ((...args: unknown[]) => {
			const callback = args.at(-1);
			if (typeof callback !== "function") return invokeListen(args);
			const wrappedArgs = [...args];
			wrappedArgs[wrappedArgs.length - 1] = () => {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("probe server did not receive a TCP port");
				const socket = net.connect(address.port, "127.0.0.1");
				active.socket = socket;
				socket.once("connect", () => callback());
			};
			return invokeListen(wrappedArgs);
		}) as unknown as typeof server.listen;
		return server;
	}) as typeof http.createServer;
	return () => { http.createServer = originalCreateServer; };
}

test("listen failure releases ownership and startup resources", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-service-lifecycle-" });
	const occupied = await occupiedPort();
	try {
		await assert.rejects(
			() => startHerderService({ planDirectory, dashboardPort: occupied.port }),
			/EADDRINUSE/,
		);
		assert.equal(existsSync(serviceOwnershipLockPath(planDirectory)), false);

		const service = await startHerderService({ planDirectory, dashboardPort: 0 });
		try {
			assert.ok(service.port > 0);
		} finally {
			await service.close();
		}
	} finally {
		await closeNetServer(occupied.server);
		rmSync(root, { recursive: true, force: true });
	}
});

test("close removes per-service signal listeners", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-service-lifecycle-" });
	const beforeSigint = process.listenerCount("SIGINT");
	const beforeSigterm = process.listenerCount("SIGTERM");
	let service: Awaited<ReturnType<typeof startHerderService>> | undefined;
	try {
		service = await startHerderService({ planDirectory, dashboardPort: 0 });
		assert.equal(process.listenerCount("SIGINT"), beforeSigint + 1);
		assert.equal(process.listenerCount("SIGTERM"), beforeSigterm + 1);
		await service.close();
		assert.equal(process.listenerCount("SIGINT"), beforeSigint);
		assert.equal(process.listenerCount("SIGTERM"), beforeSigterm);
	} finally {
		if (service) await service.close().catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed snapshot startup closes active connections before releasing ownership", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-service-lifecycle-" });
	const active: { socket?: net.Socket } = {};
	const restoreServerProbe = installActiveConnectionProbe(active);
	const originalPutSnapshot = RunStore.prototype.putSnapshot;
	RunStore.prototype.putSnapshot = (_reply: Parameters<RunStore["putSnapshot"]>[0]): void => {
		throw new Error("forced active snapshot failure");
	};
	try {
		await assert.rejects(
			() => startHerderService({ planDirectory, dashboardPort: 0 }),
			/forced active snapshot failure/,
		);
		const socket = active.socket;
		assert.ok(socket);
		await waitForSocketClose(socket);
		assert.equal(existsSync(serviceOwnershipLockPath(planDirectory)), false);
	} finally {
		restoreServerProbe();
		RunStore.prototype.putSnapshot = originalPutSnapshot;
		active.socket?.destroy();
		rmSync(root, { recursive: true, force: true });
	}
});

test("initial snapshot failure closes the listening server and releases ownership", async () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-service-lifecycle-" });
	const originalPutSnapshot = RunStore.prototype.putSnapshot;
	RunStore.prototype.putSnapshot = (_reply: Parameters<RunStore["putSnapshot"]>[0]): void => {
		throw new Error("forced initial snapshot failure");
	};
	try {
		await assert.rejects(
			() => startHerderService({ planDirectory, dashboardPort: 0 }),
			/forced initial snapshot failure/,
		);
	} finally {
		RunStore.prototype.putSnapshot = originalPutSnapshot;
	}
	try {
		assert.equal(existsSync(serviceOwnershipLockPath(planDirectory)), false);
		const service = await startHerderService({ planDirectory, dashboardPort: 0 });
		await service.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scrub failure closes the constructor-owned database", () => {
	const { root, planDirectory } = planFixture({ prefix: "herder-service-lifecycle-" });
	type StoreInternals = { scrubPersistedIntegrationRepairReplies: (this: RunStore) => void };
	const storeInternals = RunStore.prototype as unknown as StoreInternals;
	const originalScrub = storeInternals.scrubPersistedIntegrationRepairReplies;
	const originalClose = DatabaseSync.prototype.close;
	const closedHandles: DatabaseSync[] = [];
	let openedHandle: DatabaseSync | undefined;
	const scrubError = new Error("forced scrub failure");
	storeInternals.scrubPersistedIntegrationRepairReplies = function(this: RunStore): void {
		openedHandle = this.database;
		throw scrubError;
	};
	DatabaseSync.prototype.close = function(this: DatabaseSync): void {
		closedHandles.push(this);
		originalClose.call(this);
	};
	try {
		assert.throws(
			() => new RunStore(planDirectory),
			(error: unknown) => {
				assert.equal(error, scrubError);
				return true;
			},
		);
		assert.equal(closedHandles.length, 1);
		assert.equal(closedHandles[0], openedHandle);
	} finally {
		storeInternals.scrubPersistedIntegrationRepairReplies = originalScrub;
		DatabaseSync.prototype.close = originalClose;
		rmSync(root, { recursive: true, force: true });
	}
});
