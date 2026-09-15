import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertAdapterRecoveryEvidence,
	readAdapterOwnershipEvidence,
	readAdapterRuntimeIdentity,
	markAdapterOwnershipCleanupRequired,
	acquireAdapterOwnership,
	adapterOwnershipLockPath,
	releaseAdapterOwnership,
} from "../../../adapters/ownership.ts";
import { openExecutionDatabase } from "../../../src/daemon/execution-store.ts";

const ownershipModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../adapters/ownership.ts");

function fixture(): { root: string; planDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-adapter-owner-"));
	const planDir = path.join(root, "herder-plans");
	fs.mkdirSync(planDir);
	return { root, planDir };
}

function writeOwner(planDir: string, value: unknown): string {
	const lockPath = adapterOwnershipLockPath(planDir);
	fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(lockPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	return lockPath;
}

test("live foreign Pi ownership refuses attachment", () => {
	const { root, planDir } = fixture();
	try {
		const lockPath = writeOwner(planDir, { version: 1, pid: 4242, runId: "run-live", piSessionId: "session-live" });
		assert.throws(
			() => acquireAdapterOwnership(planDir, "run-next", "session-next", { processIdentity: () => "fake-birth", pid: 5252, isProcessAlive: (pid) => pid === 4242 }),
			/already owned by live Pi pid 4242.*refusing to attach/,
		);
		assert.equal(fs.existsSync(lockPath), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("dead stale Pi ownership is reaped and atomically replaced", () => {
	const { root, planDir } = fixture();
	let ownership;
	try {
		writeOwner(planDir, { version: 1, pid: 4242, runId: "run-stale", piSessionId: "session-stale" });
		ownership = acquireAdapterOwnership(planDir, "run-next", "session-next", { processIdentity: () => "fake-birth", pid: 5252, isProcessAlive: () => false });
		assert.deepEqual(JSON.parse(fs.readFileSync(ownership.lockPath, "utf8")), {
			version: 1,
			pid: 5252,
			processIdentity: "fake-birth",
			runId: "run-next",
			piSessionId: "session-next",
		});
		assert.equal(fs.statSync(ownership.lockPath).mode & 0o777, 0o600);
	} finally {
		if (ownership) releaseAdapterOwnership(ownership);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("malformed and symlink ownership state fail closed", async (t) => {
	await t.test("malformed regular file", () => {
		const { root, planDir } = fixture();
		try {
			const lockPath = adapterOwnershipLockPath(planDir);
			fs.mkdirSync(path.dirname(lockPath), { mode: 0o700 });
			fs.writeFileSync(lockPath, "not-json\n", { mode: 0o600 });
			assert.throws(() => acquireAdapterOwnership(planDir, "run", "session", { isProcessAlive: () => false }), /malformed.*refusing to replace/);
			assert.equal(fs.readFileSync(lockPath, "utf8"), "not-json\n");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	await t.test("symlink", () => {
		const { root, planDir } = fixture();
		try {
			const target = path.join(root, "foreign-owner");
			fs.writeFileSync(target, "foreign\n");
			const lockPath = adapterOwnershipLockPath(planDir);
			fs.mkdirSync(path.dirname(lockPath), { mode: 0o700 });
			fs.symlinkSync(target, lockPath);
			assert.throws(() => acquireAdapterOwnership(planDir, "run", "session", { isProcessAlive: () => false }), /not a regular file|symlink/);
			assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true);
			assert.equal(fs.readFileSync(target, "utf8"), "foreign\n");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

test("release only unlinks the inode opened by this session", () => {
	const { root, planDir } = fixture();
	const ownership = acquireAdapterOwnership(planDir, "run-old", "session-old", { processIdentity: () => "fake-birth", pid: 111, isProcessAlive: () => false });
	try {
		fs.unlinkSync(ownership.lockPath);
		fs.writeFileSync(ownership.lockPath, `${JSON.stringify({ version: 1, pid: 222, runId: "run-new", piSessionId: "session-new" })}\n`, { mode: 0o600 });
		releaseAdapterOwnership(ownership);
		assert.equal(JSON.parse(fs.readFileSync(ownership.lockPath, "utf8")).runId, "run-new");
	} finally {
		try { fs.closeSync(ownership.descriptor); } catch {}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function childExit(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolve(code));
	});
}

test("concurrent processes cannot both replace one dead ownership inode", { timeout: 20_000 }, async () => {
	const { root, planDir } = fixture();
	try {
		openExecutionDatabase(planDir, { create: true }).close();
		writeOwner(planDir, { version: 1, pid: 2_147_483_647, runId: "run-dead", piSessionId: "session-dead" });
		const barrier = path.join(root, "start");
		const results = [path.join(root, "one.json"), path.join(root, "two.json")];
		const script = `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const { acquireAdapterOwnership, releaseAdapterOwnership } = await import(pathToFileURL(process.env.OWNERSHIP_MODULE).href);
while (!fs.existsSync(process.env.START_FILE)) await new Promise((resolve) => setTimeout(resolve, 2));
try {
  const ownership = acquireAdapterOwnership(process.env.PLAN_DIR, "run-" + process.env.CONTENDER, "session-" + process.env.CONTENDER);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const opened = fs.fstatSync(ownership.descriptor);
  const named = fs.lstatSync(ownership.lockPath);
  const held = opened.dev === named.dev && opened.ino === named.ino;
  fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({ acquired: true, held }) + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 150));
  releaseAdapterOwnership(ownership);
} catch (error) {
  fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify({ acquired: false, error: error instanceof Error ? error.message : String(error) }) + "\\n");
}
`;
		const children = results.map((resultFile, index) => spawn(process.execPath, [
			"--experimental-strip-types",
			"--input-type=module",
			"--eval",
			script,
		], {
			stdio: "ignore",
			env: {
				...process.env,
				OWNERSHIP_MODULE: ownershipModule,
				PLAN_DIR: planDir,
				START_FILE: barrier,
				RESULT_FILE: resultFile,
				CONTENDER: String(index + 1),
			},
		}));
		fs.writeFileSync(barrier, "go\n");
		assert.deepEqual(await Promise.all(children.map(childExit)), [0, 0]);
		const outcomes = results.map((resultFile) => JSON.parse(fs.readFileSync(resultFile, "utf8")) as { acquired: boolean; held?: boolean; error?: string });
		assert.equal(outcomes.filter((outcome) => outcome.acquired).length, 1);
		assert.equal(outcomes.find((outcome) => outcome.acquired)?.held, true);
		assert.equal(outcomes.filter((outcome) => !outcome.acquired && /already owned by live Pi pid/.test(outcome.error || "")).length, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("recovery evidence reads are non-creating and reject marked, malformed, replaced or deleted runtime", () => {
	const { root, planDir } = fixture();
	let held;
	try {
		assert.equal(readAdapterRuntimeIdentity(planDir), undefined);
		assert.equal(readAdapterOwnershipEvidence(planDir), undefined);
		assert.equal(fs.existsSync(path.join(planDir, ".herder")), false);
		held = acquireAdapterOwnership(planDir, "run", "session");
		const identity = readAdapterRuntimeIdentity(planDir);
		assertAdapterRecoveryEvidence(planDir, identity);
		const lock = fs.readFileSync(held.lockPath, "utf8");
		assert.equal(readAdapterOwnershipEvidence(planDir)!.record.runId, "run");
		assert.equal(fs.readFileSync(held.lockPath, "utf8"), lock);
		markAdapterOwnershipCleanupRequired(held);
		assert.throws(() => assertAdapterRecoveryEvidence(planDir, identity), /manual.*cleanup/);
		fs.writeFileSync(held.lockPath, "{}");
		assert.throws(() => readAdapterOwnershipEvidence(planDir), /malformed/);
		fs.renameSync(path.join(planDir, ".herder"), path.join(root, "old-runtime"));
		assert.throws(() => assertAdapterRecoveryEvidence(planDir, identity), /removed or replaced/);
		fs.mkdirSync(path.join(planDir, ".herder"));
		assert.throws(() => assertAdapterRecoveryEvidence(planDir, identity), /removed or replaced/);
	} finally {
		if (held) releaseAdapterOwnership(held);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const change of ["replacement", "mark", "runtime", "quarantine", "final-removal", "unchanged"] as const) {
	test(`read-only recovery revalidates ${change} evidence after descriptor read`, (t) => {
		const { root, planDir } = fixture();
		try {
			const record = { version: 1, pid: 2_147_483_647, runId: "dead", piSessionId: "departed" };
			const lockPath = writeOwner(planDir, record);
			const runtime = readAdapterRuntimeIdentity(planDir);
			const original = fs.readFileSync;
			let intercepted = false;
			let retained: string | undefined;
			const reader = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
				const bytes = original(...args);
				if (typeof args[0] === "number" && !intercepted) {
					intercepted = true;
					if (change === "replacement") {
						retained = `${lockPath}.old`;
						fs.renameSync(lockPath, retained);
						writeOwner(planDir, { ...record, resetCleanupRequired: true });
					} else if (change === "mark") {
						writeOwner(planDir, { ...record, resetCleanupRequired: true });
					} else if (change === "runtime") {
						retained = path.join(root, "old-runtime");
						fs.renameSync(path.dirname(lockPath), retained);
						writeOwner(planDir, record);
					} else if (change === "quarantine" || change === "final-removal") {
						retained = `${change === "quarantine" ? lockPath : planDir}.cleanup-required`;
						fs.linkSync(lockPath, retained);
					}
				}
				return bytes;
			});
			try {
				if (change === "unchanged") assertAdapterRecoveryEvidence(planDir, runtime);
				else assert.throws(() => assertAdapterRecoveryEvidence(planDir, runtime), /refusing recovery|manual child-process cleanup/);
				assert.equal(intercepted, true);
			} finally { reader.mock.restore(); }
			assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")),
				change === "replacement" || change === "mark" ? { ...record, resetCleanupRequired: true } : record);
			if (retained) assert.equal(fs.existsSync(retained), true, "inspection must retain evidence");
			assert.deepEqual(fs.readdirSync(path.dirname(lockPath)).sort(),
				["pi-session-owner.lock", ...(change === "replacement" ? ["pi-session-owner.lock.old"]
					: change === "quarantine" ? ["pi-session-owner.lock.cleanup-required"] : [])].sort(),
				"inspection must not initialize SQLite or create ownership state");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
}

test("retained final-removal evidence excludes acquisition and recovery without recreating runtime", () => {
	const { root, planDir } = fixture();
	const held = acquireAdapterOwnership(planDir, "run", "session");
	try {
		markAdapterOwnershipCleanupRequired(held);
		const runtime = readAdapterRuntimeIdentity(planDir);
		fs.linkSync(held.lockPath, `${planDir}.cleanup-required`);
		fs.rmSync(path.join(planDir, ".herder"), { recursive: true });
		assert.throws(() => acquireAdapterOwnership(planDir, "replacement", "replacement", { isProcessAlive: () => false }), /manual child-process cleanup/);
		assert.throws(() => assertAdapterRecoveryEvidence(planDir, runtime), /manual child-process cleanup/);
		assert.equal(fs.existsSync(path.join(planDir, ".herder")), false);
		assert.equal(fs.statSync(`${planDir}.cleanup-required`).ino, fs.fstatSync(held.descriptor).ino);
	} finally {
		releaseAdapterOwnership(held);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const kind of ["file", "symlink", "directory"] as const) {
	for (const ownerPresent of [true, false]) {
		test(`retained quarantine ${kind} excludes read-only recovery and acquisition with owner present: ${ownerPresent}`, () => {
			const { root, planDir } = fixture();
			try {
				const lockPath = writeOwner(planDir, { version: 1, pid: 4242, runId: "dead", piSessionId: "departed" });
				const runtime = readAdapterRuntimeIdentity(planDir);
				if (!ownerPresent) fs.unlinkSync(lockPath);
				const quarantine = `${lockPath}.cleanup-required`;
				if (kind === "file") fs.writeFileSync(quarantine, "conflicting evidence");
				else if (kind === "symlink") fs.symlinkSync(path.join(root, "absent"), quarantine);
				else fs.mkdirSync(quarantine);
				const retained = fs.lstatSync(quarantine);
				const files = fs.readdirSync(path.dirname(lockPath)).sort();
				assert.throws(() => readAdapterOwnershipEvidence(planDir), /manual child-process cleanup/);
				assert.throws(() => assertAdapterRecoveryEvidence(planDir, runtime), /manual child-process cleanup/);
				assert.throws(() => acquireAdapterOwnership(planDir, "replacement", "replacement", { isProcessAlive: () => false }), /manual child-process cleanup/);
				assert.equal(fs.lstatSync(quarantine).ino, retained.ino);
				assert.equal(fs.lstatSync(quarantine).dev, retained.dev);
				assert.equal(fs.existsSync(lockPath), ownerPresent);
				assert.deepEqual(fs.readdirSync(path.dirname(lockPath)).sort(), files, "inspection and refused acquisition must not initialize SQLite");
			} finally { fs.rmSync(root, { recursive: true, force: true }); }
		});
	}
}

test("stale reaper retains a quarantine collision published by its liveness probe", () => {
	const { root, planDir } = fixture();
	try {
		const lockPath = writeOwner(planDir, { version: 1, pid: 4242, runId: "dead", piSessionId: "departed" });
		const original = fs.lstatSync(lockPath);
		const bytes = fs.readFileSync(lockPath, "utf8");
		assert.throws(() => acquireAdapterOwnership(planDir, "replacement", "replacement", {
			isProcessAlive: () => { fs.writeFileSync(`${lockPath}.cleanup-required`, "conflict"); return false; },
		}), /manual child-process cleanup/);
		assert.equal(fs.lstatSync(lockPath).ino, original.ino);
		assert.equal(fs.readFileSync(lockPath, "utf8"), bytes);
		assert.equal(fs.readFileSync(`${lockPath}.cleanup-required`, "utf8"), "conflict");
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});
