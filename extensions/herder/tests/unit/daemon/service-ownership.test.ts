import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	acquireServiceOwnership,
	acquireStartExclusion,
	releaseServiceOwnership,
	releaseStartExclusion,
	serviceOwnershipLockPath,
	serviceProcessAlive,
} from "../../../src/daemon/service-ownership.ts";

async function spawnNodeHelper(marker?: string): Promise<{ child: ChildProcess; pid: number }> {
	// Keep the ordinary helper command line independent of this checkout path:
	// the service identity guard intentionally rejects command lines containing
	// "herder".
	const args = ["-e", "setInterval(() => {}, 1000)"];
	if (marker) args.push(marker);
	const child = spawn(process.execPath, args, { stdio: "ignore" });
	if (!child.pid) throw new Error("failed to spawn plain node helper");
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("spawn", resolve);
	});
	return { child, pid: child.pid };
}

async function spawnDeadOwner(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
	if (!child.pid) throw new Error("failed to spawn dead owner helper");
	const pid = child.pid;
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolve());
	});
	return pid;
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
	if (!child) return;
	await new Promise<void>((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once("exit", () => resolve());
		try { child.kill("SIGKILL"); } catch { resolve(); }
	});
}

function fixture(): { root: string; planDirectory: string; startLockPath: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-service-ownership-"));
	return {
		root,
		planDirectory: path.join(root, "plan"),
		startLockPath: path.join(root, "service-start.lock"),
	};
}

function writeStartLock(lockPath: string, pid: number): void {
	fs.writeFileSync(lockPath, `${pid}\n`, { mode: 0o600 });
}

function writeServiceLock(planDirectory: string, pid: number): string {
	const lockPath = serviceOwnershipLockPath(planDirectory);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(lockPath, `${pid} stale-instance\n`, { mode: 0o600 });
	return lockPath;
}

test("reclaims service ownership when a live unrelated process reuses the recorded PID", { timeout: 10_000 }, async () => {
	const paths = fixture();
	let helper: ChildProcess | undefined;
	try {
		const spawned = await spawnNodeHelper();
		helper = spawned.child;
		assert.equal(
			serviceProcessAlive(spawned.pid),
			false,
			"plain node helper was classified as a Herder process; the environment cannot exercise PID-reuse reclaim",
		);

		const serviceLockPath = writeServiceLock(paths.planDirectory, spawned.pid);
		const ownership = acquireServiceOwnership(paths.planDirectory, "replacement-instance");
		assert.equal(ownership.lockPath, serviceLockPath);
		releaseServiceOwnership(ownership);
	} finally {
		await stopProcess(helper);
		fs.rmSync(paths.root, { recursive: true, force: true });
	}
});

test("keeps start exclusion for a live unrelated process", { timeout: 10_000 }, async () => {
	const paths = fixture();
	let helper: ChildProcess | undefined;
	try {
		const spawned = await spawnNodeHelper();
		helper = spawned.child;

		writeStartLock(paths.startLockPath, spawned.pid);
		assert.equal(acquireStartExclusion(paths.startLockPath), null);
		assert.equal(fs.readFileSync(paths.startLockPath, "utf8"), `${spawned.pid}\n`);
	} finally {
		await stopProcess(helper);
		fs.rmSync(paths.root, { recursive: true, force: true });
	}
});

test("refuses locks held by a live Herder-like process", { timeout: 10_000 }, async () => {
	const paths = fixture();
	let helper: ChildProcess | undefined;
	try {
		let ownerPid = process.pid;
		if (!serviceProcessAlive(ownerPid)) {
			// Some node test runners omit the test path from the parent command
			// line. Use an explicit Herder marker rather than weakening the guard.
			const spawned = await spawnNodeHelper("herder-owner");
			helper = spawned.child;
			ownerPid = spawned.pid;
		}
		assert.equal(serviceProcessAlive(ownerPid), true, "could not construct a live Herder-like owner");

		writeStartLock(paths.startLockPath, ownerPid);
		assert.equal(acquireStartExclusion(paths.startLockPath), null);

		writeServiceLock(paths.planDirectory, ownerPid);
		assert.throws(
			() => acquireServiceOwnership(paths.planDirectory, "blocked-instance"),
			/already held by pid/,
		);
	} finally {
		await stopProcess(helper);
		fs.rmSync(paths.root, { recursive: true, force: true });
	}
});

test("reclaims locks held by a dead process", async () => {
	const paths = fixture();
	try {
		const deadPid = await spawnDeadOwner();

		writeStartLock(paths.startLockPath, deadPid);
		const exclusion = acquireStartExclusion(paths.startLockPath);
		assert.ok(exclusion);
		releaseStartExclusion(exclusion);

		const serviceLockPath = writeServiceLock(paths.planDirectory, deadPid);
		const ownership = acquireServiceOwnership(paths.planDirectory, "dead-instance-replacement");
		assert.equal(ownership.lockPath, serviceLockPath);
		releaseServiceOwnership(ownership);
	} finally {
		fs.rmSync(paths.root, { recursive: true, force: true });
	}
});
