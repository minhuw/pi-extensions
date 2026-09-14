import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withServiceExclusion, ensureService, stopService } from "../../../src/client/index.ts";
import { openExecutionDatabase } from "../../../src/daemon/execution-store.ts";
import { startHerderService } from "../../../src/daemon/service.ts";
import { serviceProcessAlive, serviceOwnershipLockPath } from "../../../src/daemon/service-ownership.ts";

function planDirectory(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "herder-cleanup-quiescence-"));
	const planDir = path.join(root, "herder-plans");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(path.join(planDir, "README.md"), "# Herder Plans\n");
	openExecutionDatabase(planDir, { create: true }).close();
	return planDir;
}

test("cleanup exclusion holds startup and daemon ownership through the callback", async () => {
	const planDir = planDirectory();
	try {
		let ownerSeen = false;
		const value = await withServiceExclusion(planDir, () => {
			ownerSeen = existsSync(serviceOwnershipLockPath(planDir));
			const owner = readFileSync(serviceOwnershipLockPath(planDir), "utf8");
			assert.match(owner, /^\d+ cleanup-/);
			return "quiesced";
		});
		assert.equal(value, "quiesced");
		assert.equal(ownerSeen, true);
		assert.equal(existsSync(serviceOwnershipLockPath(planDir)), false);
		assert.equal(existsSync(path.join(planDir, ".herder", "service-start.lock")), false);
	} finally {
		rmSync(path.dirname(planDir), { recursive: true, force: true });
	}
});

for (const fails of [false, true]) {
	test(`cleanup competitors cannot enter during a ${fails ? "failing" : "successful"} callback`, async () => {
		const planDir = planDirectory();
		try {
			let entered = false;
			const operation = withServiceExclusion(planDir, async () => {
				await assert.rejects(
					withServiceExclusion(planDir, () => { entered = true; }),
					/startup is already in progress/,
				);
				assert.equal(entered, false);
				assert.equal(existsSync(serviceOwnershipLockPath(planDir)), true);
				assert.equal(existsSync(path.join(planDir, ".herder", "service-start.lock")), true);
				if (fails) throw new Error("callback failure");
			});
			if (fails) await assert.rejects(operation, /callback failure/);
			else await operation;
			assert.equal(existsSync(serviceOwnershipLockPath(planDir)), false);
			assert.equal(existsSync(path.join(planDir, ".herder", "service-start.lock")), false);
			await withServiceExclusion(planDir, () => { entered = true; });
			assert.equal(entered, true);
		} finally {
			rmSync(path.dirname(planDir), { recursive: true, force: true });
		}
	});
}

test("cleanup exclusion releases safely when deep cleanup deletes the plan directory", async () => {
	const planDir = planDirectory();
	const root = path.dirname(planDir);
	await withServiceExclusion(planDir, () => {
		rmSync(planDir, { recursive: true, force: true });
	});
	assert.equal(existsSync(planDir), false);
	rmSync(root, { recursive: true, force: true });
});

test("cleanup rejects a healthy nonterminal service owner without calling the callback", async () => {
	const planDir = planDirectory();
	try {
		await ensureService(planDir);
		let called = false;
		await assert.rejects(
			() => withServiceExclusion(planDir, () => { called = true; }),
			/terminal run|active/,
		);
		assert.equal(called, false);
	} finally {
		await stopService(planDir).catch(() => {});
		rmSync(path.dirname(planDir), { recursive: true, force: true });
	}
});

test("force exclusion stops a healthy nonterminal service and then runs the callback", async () => {
	const planDir = planDirectory();
	try {
		await ensureService(planDir);
		let called = false;
		await withServiceExclusion(planDir, () => { called = true; }, { purpose: "force" });
		assert.equal(called, true);
	} finally {
		await stopService(planDir).catch(() => {});
		rmSync(path.dirname(planDir), { recursive: true, force: true });
	}
});

for (const purpose of ["cleanup", "reset", "force", "revision"] as const) {
	for (const fails of [false, true]) {
		test(`${purpose}: neutral process holds exclusion through ${fails ? "failure" : "success"}`, { timeout: 15_000 }, async () => {
			const planDir = planDirectory();
			// Pass paths via the environment so argv cannot accidentally satisfy daemon classification.
			const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
const { withServiceExclusion } = await import(process.env.CLIENT_MODULE);
const { once } = await import('node:events');
try {
  await withServiceExclusion(process.env.PLAN_DIR, async () => {
    console.log('held');
    await once(process.stdin, 'data');
    if (process.env.FAILS === 'true') throw new Error('callback failure');
  }, { purpose: process.env.PURPOSE });
  console.log('success');
} catch (error) { console.log(error.message); }
process.stdin.destroy();
`], { env: { ...process.env, CLIENT_MODULE: new URL("../../../src/client/index.ts", import.meta.url).href,
				PLAN_DIR: planDir, PURPOSE: purpose, FAILS: String(fails) }, stdio: ["pipe", "pipe", "pipe"] });
			const exited = once(child, "exit");
			let stderr = "";
			child.stderr.on("data", (chunk) => { stderr += chunk; });
			const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
			let service: Awaited<ReturnType<typeof startHerderService>> | undefined;
			try {
				assert.equal((await lines.next()).value, "held", stderr);
				assert.equal(serviceProcessAlive(child.pid!), false);
				const lockPath = serviceOwnershipLockPath(planDir);
				const payload = readFileSync(lockPath, "utf8");
				await assert.rejects(async () => { service = await startHerderService({ planDirectory: planDir }); }, /already held by pid/);
				assert.equal(readFileSync(lockPath, "utf8"), payload);
				await assert.rejects(withServiceExclusion(planDir, () => assert.fail("competitor entered")), /startup is already in progress/);
				child.stdin.write("release");
				assert.equal((await lines.next()).value, fails ? "callback failure" : "success", stderr);
				await exited;
				assert.equal(existsSync(lockPath), false);
				assert.equal(existsSync(path.join(planDir, ".herder", "service-start.lock")), false);
				service = await startHerderService({ planDirectory: planDir });
			} finally {
				await service?.close();
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await exited;
				rmSync(path.dirname(planDir), { recursive: true, force: true });
			}
		});
	}
}
