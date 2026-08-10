import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureService, stopService } from "../../../src/client/index.ts";
import {
	executionDatabasePath,
	executionRotationMarkerPath,
	openExecutionDatabase,
} from "../../../src/daemon/execution-store.ts";
import { git } from "../../../src/daemon/git-driver.ts";
import { RunStore } from "../../../src/daemon/run-store.ts";

const POSIX = process.platform !== "win32";

function planRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-runtime-safety-"));
	git(root, ["init", "-q"]);
	git(root, ["config", "user.name", "Herder Runtime Safety Test"]);
	git(root, ["config", "user.email", "herder-runtime-safety@example.invalid"]);
	const planDirectory = path.join(root, "herder-plans");
	fs.mkdirSync(planDirectory, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(planDirectory, "README.md"), `# Herder Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|

## Dependency notes

None.

## Considered and rejected

None.
`);
	git(root, ["add", "."]);
	git(root, ["commit", "-q", "-m", "test: runtime file safety fixture"]);
	return root;
}

function mode(candidate: string): number {
	return fs.statSync(candidate).mode & 0o777;
}

function planDirectory(root: string): string {
	return path.join(root, "herder-plans");
}

test("broadened execution storage rotates one active daemon for concurrent callers", { skip: !POSIX }, async () => {
	const root = planRoot();
	const directory = planDirectory(root);
	try {
		const initial = await ensureService(directory);
		fs.chmodSync(executionDatabasePath(directory), 0o644);

		const replacements = await Promise.all([
			ensureService(directory),
			ensureService(directory),
			ensureService(directory),
		]);
		assert.ok(replacements.every((service) => service.instanceId === replacements[0]!.instanceId));
		assert.notEqual(replacements[0]!.instanceId, initial.instanceId);
		assert.equal(mode(executionDatabasePath(directory)), 0o600);
		assert.equal(fs.existsSync(path.join(directory, ".herder", "rotation-required")), false);
	} finally {
		await stopService(directory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a first reservation fsync failure leaves exposed storage for crash-safe retry", { skip: !POSIX }, async () => {
	const root = planRoot();
	const directory = planDirectory(root);
	const markerPath = executionRotationMarkerPath(directory);
	const originalFsync = fs.fsyncSync;
	try {
		const initial = await ensureService(directory);
		fs.chmodSync(executionDatabasePath(directory), 0o644);
		let fsyncAttempts = 0;
		fs.fsyncSync = ((descriptor: number) => {
			fsyncAttempts += 1;
			if (fsyncAttempts === 1) {
				const error = new Error("no space left on device") as NodeJS.ErrnoException;
				error.code = "ENOSPC";
				throw error;
			}
			return originalFsync(descriptor);
		}) as typeof fs.fsyncSync;
		await assert.rejects(() => ensureService(directory), /no space left on device/i);
		fs.fsyncSync = originalFsync;
		assert.equal(fsyncAttempts, 1);
		assert.equal(fs.existsSync(markerPath), true);
		assert.equal(mode(markerPath), 0o600);
		assert.equal(mode(executionDatabasePath(directory)), 0o644);

		// Model crash rollback of the reservation directory entry: the exposed
		// database mode must independently force a fresh durable epoch on retry.
		fs.unlinkSync(markerPath);
		const replacement = await ensureService(directory);
		assert.notEqual(replacement.instanceId, initial.instanceId);
		assert.equal(mode(executionDatabasePath(directory)), 0o600);
		assert.equal(fs.existsSync(markerPath), false);
	} finally {
		fs.fsyncSync = originalFsync;
		await stopService(directory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a marker-temp failure leaves durable pending exposure state for retry", { skip: !POSIX }, async () => {
	const root = planRoot();
	const directory = planDirectory(root);
	const databasePath = executionDatabasePath(directory);
	const markerPath = executionRotationMarkerPath(directory);
	const originalOpen = fs.openSync;
	try {
		const initial = await ensureService(directory);
		fs.chmodSync(databasePath, 0o644);
		fs.openSync = ((candidate, flags, mode) => {
			if (String(candidate).includes("rotation-required.") && String(candidate).endsWith(".tmp")) {
				const error = new Error("no space left on device") as NodeJS.ErrnoException;
				error.code = "ENOSPC";
				throw error;
			}
			return originalOpen(candidate, flags, mode);
		}) as typeof fs.openSync;
		await assert.rejects(() => ensureService(directory), /no space left on device/i);
		fs.openSync = originalOpen;

		assert.equal(fs.existsSync(markerPath), true);
		assert.equal(mode(databasePath), 0o600);
		const replacement = await ensureService(directory);
		assert.notEqual(replacement.instanceId, initial.instanceId);
		assert.equal(mode(databasePath), 0o600);
		assert.equal(fs.existsSync(markerPath), false);
	} finally {
		fs.openSync = originalOpen;
		await stopService(directory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("publication during the final absence probe requires a later healthy instance", { skip: !POSIX }, async () => {
	const root = planRoot();
	const directory = planDirectory(root);
	const databasePath = executionDatabasePath(directory);
	const markerPath = executionRotationMarkerPath(fs.realpathSync(directory));
	const originalFetch = globalThis.fetch;
	const originalLstat = fs.lstatSync;
	const originalUnlink = fs.unlinkSync;
	const mutableFs = fs as unknown as { lstatSync: typeof fs.lstatSync };
	let afterClearUnlink = false;
	let markerAbsentObservations = 0;
	let repairing = false;
	let exposedInstanceId: string | null = null;
	try {
		const initial = await ensureService(directory);
		fs.chmodSync(databasePath, 0o644);
		openExecutionDatabase(directory, { create: true })!.close();
		globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
			const response = await originalFetch(input, init);
			if (!exposedInstanceId && String(input).includes("/health") && response.ok) {
				const body = await response.clone().json() as { instanceId?: unknown };
				const instanceId = String(body.instanceId ?? "");
				if (instanceId && instanceId !== initial.instanceId) exposedInstanceId = instanceId;
			}
			return response;
		};
		fs.unlinkSync = ((candidate: fs.PathLike) => {
			const result = originalUnlink(candidate);
			if (String(candidate).endsWith(".clear")) afterClearUnlink = true;
			return result;
		}) as typeof fs.unlinkSync;
		mutableFs.lstatSync = ((candidate: fs.PathLike) => {
			try {
				return originalLstat(candidate);
			} catch (error) {
				if (!repairing && afterClearUnlink && String(candidate) === markerPath
					&& (error as NodeJS.ErrnoException).code === "ENOENT") {
					markerAbsentObservations += 1;
					if (markerAbsentObservations === 3) {
						repairing = true;
						try {
							fs.chmodSync(databasePath, 0o644);
							openExecutionDatabase(directory, { create: true })!.close();
						} finally {
							repairing = false;
						}
					}
				}
				throw error;
			}
		}) as typeof fs.lstatSync;

		const returned = await ensureService(directory);
		assert.ok(markerAbsentObservations >= 3);
		assert.ok(exposedInstanceId);
		assert.notEqual(returned.instanceId, exposedInstanceId);
		assert.equal(fs.existsSync(markerPath), false);
	} finally {
		globalThis.fetch = originalFetch;
		mutableFs.lstatSync = originalLstat;
		fs.unlinkSync = originalUnlink;
		await stopService(directory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a health failure after replacement exposure requires another healthy instance", { skip: !POSIX }, async () => {
	const root = planRoot();
	const directory = planDirectory(root);
	const initial = await ensureService(directory);
	await stopService(directory);
	const originalFetch = globalThis.fetch;
	let exposedInstanceId: string | null = null;
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const response = await originalFetch(input, init);
		if (!exposedInstanceId && String(input).includes("/health") && response.ok) {
			const body = await response.clone().json() as { instanceId?: unknown };
			const instanceId = String(body.instanceId ?? "");
			if (instanceId && instanceId !== initial.instanceId) {
				exposedInstanceId = instanceId;
				fs.chmodSync(executionDatabasePath(directory), 0o644);
				openExecutionDatabase(directory, { create: true })!.close();
				throw new Error("injected health transport failure after exposure");
			}
		}
		return response;
	};
	try {
		const returned = await ensureService(directory, { unresponsiveGraceMs: 0 });
		assert.ok(exposedInstanceId);
		assert.notEqual(returned.instanceId, exposedInstanceId);
		assert.equal(fs.existsSync(executionRotationMarkerPath(directory)), false);
	} finally {
		globalThis.fetch = originalFetch;
		await stopService(directory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a repeated exposure during pending rotation requires a later instance", { skip: !POSIX }, async () => {
	const root = planRoot();
	const directory = planDirectory(root);
	const initial = await ensureService(directory);
	fs.chmodSync(executionDatabasePath(directory), 0o644);
	openExecutionDatabase(directory, { create: true })!.close();
	const originalFetch = globalThis.fetch;
	let exposedInstanceId: string | null = null;
	globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const response = await originalFetch(input, init);
		if (!exposedInstanceId && String(input).includes("/health") && response.ok) {
			const body = await response.clone().json() as { instanceId?: unknown };
			const instanceId = String(body.instanceId ?? "");
			if (instanceId && instanceId !== initial.instanceId) {
				exposedInstanceId = instanceId;
				fs.chmodSync(executionDatabasePath(directory), 0o644);
				openExecutionDatabase(directory, { create: true })!.close();
			}
		}
		return response;
	};
	try {
		const returned = await ensureService(directory);
		assert.ok(exposedInstanceId);
		assert.notEqual(returned.instanceId, exposedInstanceId);
		assert.equal(fs.existsSync(executionRotationMarkerPath(directory)), false);
	} finally {
		globalThis.fetch = originalFetch;
		await stopService(directory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a service log symlink is rejected without changing its target or registering a daemon", { skip: !POSIX }, async () => {
	const root = planRoot();
	const directory = planDirectory(root);
	const runtimeDirectory = path.join(directory, ".herder");
	const target = path.join(root, "outside-service.log");
	const logPath = path.join(runtimeDirectory, "service.log");
	fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
	fs.writeFileSync(target, "target must remain unchanged\n");
	fs.symlinkSync(target, logPath);
	try {
		await assert.rejects(() => ensureService(directory), /regular file|safe service log opening/i);
		assert.equal(fs.readFileSync(target, "utf8"), "target must remain unchanged\n");
		assert.equal(fs.lstatSync(logPath).isSymbolicLink(), true);
		const store = new RunStore(directory, { readOnly: true });
		try { assert.equal(store.getService(), null); }
		finally { store.close(); }
		assert.equal(fs.existsSync(path.join(runtimeDirectory, "service-start.lock")), false);
	} finally {
		await stopService(directory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a broad regular service log is repaired before daemon startup", { skip: !POSIX }, async () => {
	const root = planRoot();
	const directory = planDirectory(root);
	const logPath = path.join(directory, ".herder", "service.log");
	try {
		const initial = await ensureService(directory);
		await stopService(directory);
		assert.equal(fs.lstatSync(logPath).isFile(), true);
		fs.chmodSync(logPath, 0o664);

		const restarted = await ensureService(directory);
		assert.notEqual(restarted.instanceId, initial.instanceId);
		assert.equal(fs.lstatSync(logPath).isSymbolicLink(), false);
		assert.equal(mode(logPath), 0o600);
	} finally {
		await stopService(directory).catch(() => {});
		fs.rmSync(root, { recursive: true, force: true });
	}
});
