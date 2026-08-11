import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
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
			() => acquireAdapterOwnership(planDir, "run-next", "session-next", { pid: 5252, isProcessAlive: (pid) => pid === 4242 }),
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
		ownership = acquireAdapterOwnership(planDir, "run-next", "session-next", { pid: 5252, isProcessAlive: () => false });
		assert.deepEqual(JSON.parse(fs.readFileSync(ownership.lockPath, "utf8")), {
			version: 1,
			pid: 5252,
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
	const ownership = acquireAdapterOwnership(planDir, "run-old", "session-old", { pid: 111, isProcessAlive: () => false });
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
