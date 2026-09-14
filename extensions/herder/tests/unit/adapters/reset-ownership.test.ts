import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireAdapterOwnership, adapterOwnershipLockPath, releaseAdapterOwnership, markAdapterOwnershipCleanupRequired, bindAdapterOwnershipRun, withAdapterResetOwnership, type AdapterResetOptions } from "../../../adapters/ownership.ts";
import { applyHerderReset } from "../../../src/application/tools.ts";
import { openExecutionDatabase } from "../../../src/daemon/execution-store.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "herder-reset-owner-"));
	fs.mkdirSync(path.join(root, ".herder"));
	return root;
}
const fake = { pid: 5252, processIdentity: () => "birth", isProcessAlive: () => false };
function foreign(root: string, processIdentity: string | undefined = "birth") {
	fs.writeFileSync(adapterOwnershipLockPath(root), JSON.stringify({ version: 1, pid: 2147483647, runId: "pending-fire", piSessionId: "foreign-session", processIdentity }));
}

test("owned pending-fire without restored state drains before reset, excludes Fire, then permits fresh ownership", async () => {
	const root = fixture();
	try {
		const held = acquireAdapterOwnership(root, "pending-fire", "own", fake);
		const calls: string[] = [];
		await withAdapterResetOwnership(root, "own", {
			...fake, ownership: held, confirm: async () => { throw Error("must not confirm own termination"); },
			quiesce: async () => { await Promise.resolve(); calls.push("workers and admitted tasks drained"); },
		}, async () => {
			calls.push("reset");
			assert.throws(() => acquireAdapterOwnership(root, "fire", "race", { ...fake, isProcessAlive: () => true }), /live Pi/);
		});
		assert.deepEqual(calls, ["workers and admitted tasks drained", "reset"]);
		const next = acquireAdapterOwnership(root, "fresh", "own", fake);
		releaseAdapterOwnership(next);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of ["cancel", "term", "term-unacknowledged", "kill", "legacy", "mismatch", "timeout", "replacement", "signal-error", "wait-error", "reuse-before-kill"] as const) {
	test(`foreign reset: ${scenario}`, async () => {
		const root = fixture();
		try {
			foreign(root);
			if (scenario === "legacy") {
				const record = JSON.parse(fs.readFileSync(adapterOwnershipLockPath(root), "utf8"));
				delete record.processIdentity;
				fs.writeFileSync(adapterOwnershipLockPath(root), JSON.stringify(record));
			}
			const original = fs.readFileSync(adapterOwnershipLockPath(root), "utf8");
			const originalStat = fs.statSync(adapterOwnershipLockPath(root));
			let alive = true;
			let birth = scenario === "mismatch" ? "other" : "birth";
			const calls: string[] = [];
			const options: AdapterResetOptions = {
				...fake, isProcessAlive: pid => pid === 2147483647 && alive, processIdentity: () => birth,
				confirm: async (_title, body) => {
					assert.match(body, /2147483647.*foreign-session.*ENTIRE foreign Pi.*other work/);
					calls.push("confirm"); return scenario !== "cancel";
				},
				quiesce: async () => { calls.push("drain"); }, waitAttempts: 1,
				wait: async () => {
					if (scenario === "wait-error") throw Error("wait failure");
					if (scenario === "reuse-before-kill") birth = "reused";
				},
				signal: (_pid, signal) => {
					calls.push(signal);
					const marked = JSON.parse(fs.readFileSync(adapterOwnershipLockPath(root), "utf8"));
					assert.equal(marked.resetCleanupRequired, true);
					assert.equal(fs.statSync(adapterOwnershipLockPath(root)).ino, originalStat.ino);
					if (scenario === "signal-error") throw Error("signal failure");
					if (scenario === "term") fs.unlinkSync(adapterOwnershipLockPath(root));
					if (scenario === "term-unacknowledged") alive = false;
					if (scenario === "term" || (scenario === "kill" && signal === "SIGKILL")) alive = false;
					if (scenario === "replacement") {
						fs.renameSync(adapterOwnershipLockPath(root), path.join(root, "original"));
						foreign(root); alive = false;
					}
				},
			};
			const run = () => withAdapterResetOwnership(root, "local", options, async () => { calls.push("reset"); return "done"; });
			if (scenario === "term") {
				assert.equal(await run(), "done");
				assert.deepEqual(calls, ["confirm", "SIGTERM", "drain", "reset"]);
				assert.equal(fs.existsSync(adapterOwnershipLockPath(root)), false);
			} else if (scenario === "cancel") {
				assert.equal(await run(), undefined);
				assert.deepEqual(calls, ["confirm"]);
				assert.equal(fs.readFileSync(adapterOwnershipLockPath(root), "utf8"), original);
			} else {
				await assert.rejects(run, /exit the owning Pi once|identity mismatch|Timed out|replaced|signal failure|wait failure|identity mismatch|manual child-process cleanup/i);
				assert.ok(!calls.includes("drain") && !calls.includes("reset"));
				if (["legacy", "mismatch"].includes(scenario)) assert.deepEqual(calls, []);
				if (scenario === "reuse-before-kill") assert.ok(!calls.includes("SIGKILL"));
				assert.equal(fs.existsSync(adapterOwnershipLockPath(root)), true);
				if (["term-unacknowledged", "kill"].includes(scenario)) {
					for (let retry = 0; retry < 2; retry++) {
						await assert.rejects(run, /manual child-process cleanup.*ownership evidence retained/i);
						assert.throws(() => acquireAdapterOwnership(root, "fire", "local", fake), /manual child-process cleanup/);
						await assert.rejects(() => applyHerderReset({ repoRoot: root, planDirectory: root }, {
							withExclusion: async () => { calls.push("reset"); assert.fail("must not stop service"); },
						}), /manual child-process cleanup/);
					}
					assert.ok(!calls.includes("drain") && !calls.includes("reset"));
					assert.equal(JSON.parse(fs.readFileSync(adapterOwnershipLockPath(root), "utf8")).resetCleanupRequired, true);
				}
			}
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
}

test("direct reset refuses uncoordinated live ownership before service exclusion", async () => {
	const root = fixture();
	const held = acquireAdapterOwnership(root, "pending-fire", "own");
	try {
		await assert.rejects(() => applyHerderReset({ repoRoot: root, planDirectory: root }, {
			withExclusion: async () => { throw Error("must not stop service"); },
		}), /already owned by live Pi/);
	} finally { releaseAdapterOwnership(held); fs.rmSync(root, { recursive: true, force: true }); }
});

test("reset failure releases claim only after drain; replacement never removed", async () => {
	const root = fixture();
	try {
		await assert.rejects(() => withAdapterResetOwnership(root, "own", {
			...fake, confirm: async () => true, quiesce: async () => {},
		}, async () => { throw Error("Git safety rejection"); }), /Git safety/);
		assert.equal(fs.existsSync(adapterOwnershipLockPath(root)), false);
		await assert.rejects(() => withAdapterResetOwnership(root, "own", {
			...fake, confirm: async () => true, quiesce: async () => {},
		}, async () => {
			fs.renameSync(adapterOwnershipLockPath(root), path.join(root, "old"));
			foreign(root);
		}), /replaced/);
		assert.equal(fs.existsSync(adapterOwnershipLockPath(root)), true);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed local drain retains exclusive ownership and never applies reset", async () => {
	const root = fixture();
	const held = acquireAdapterOwnership(root, "pending-fire", "own", { ...fake, pid: 2147483646 });
	const original = JSON.parse(fs.readFileSync(held.lockPath, "utf8"));
	const stat = fs.statSync(held.lockPath);
	try {
		await assert.rejects(() => withAdapterResetOwnership(root, "own", {
			...fake, ownership: held, confirm: async () => true,
			quiesce: async () => {
				assert.deepEqual(JSON.parse(fs.readFileSync(held.lockPath, "utf8")), { ...original, resetCleanupRequired: true });
				throw Error("worker disposal failed");
			},
		}, async () => { assert.fail("must not reset before drain"); }), /disposal failed/);
		assert.equal(fs.statSync(held.lockPath).ino, stat.ino);
		assert.equal(fs.statSync(held.lockPath).mode, stat.mode);
		for (let retry = 0; retry < 2; retry++) {
			assert.throws(() => acquireAdapterOwnership(root, "next", "next", fake), /manual child-process cleanup/);
			await assert.rejects(() => applyHerderReset({ repoRoot: root, planDirectory: root }, {
				withExclusion: async () => assert.fail("must refuse before service exclusion"),
			}), /manual child-process cleanup/);
		}
		assert.deepEqual(JSON.parse(fs.readFileSync(held.lockPath, "utf8")), { ...original, resetCleanupRequired: true });
	} finally { releaseAdapterOwnership(held); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const replacement of ["initial symlink", "confirmation symlink", "confirmation directory", "before KILL"] as const) {
	test(`reset refuses runtime ${replacement} before signaling unrelated ownership`, async () => {
		const root = fixture();
		const other = fixture();
		const signals: string[] = [];
		const replace = () => {
			fs.renameSync(path.join(root, ".herder"), path.join(root, "old-runtime"));
			if (replacement === "confirmation directory") fs.mkdirSync(path.join(root, ".herder"));
			else fs.symlinkSync(path.join(other, ".herder"), path.join(root, ".herder"));
		};
		try {
			foreign(root); foreign(other);
			if (replacement === "initial symlink") replace();
			await assert.rejects(() => withAdapterResetOwnership(root, "own", {
				...fake, isProcessAlive: () => true,
				confirm: async () => { if (replacement.startsWith("confirmation")) replace(); return true; },
				quiesce: async () => assert.fail("must not drain"), waitAttempts: 1,
				wait: async () => { if (replacement === "before KILL") replace(); },
				signal: (_pid, signal) => { signals.push(signal); },
			}, async () => assert.fail("must not reset")), /unsafe|replaced/);
			assert.deepEqual(signals, replacement === "before KILL" ? ["SIGTERM"] : []);
			assert.ok(fs.existsSync(adapterOwnershipLockPath(other)));
		} finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
	});
}

for (const marker of [false, "true", null, 1]) {
	test(`invalid cleanup-required marker fails closed: ${JSON.stringify(marker)}`, () => {
		const root = fixture();
		try {
			foreign(root);
			const lockPath = adapterOwnershipLockPath(root);
			const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
			fs.writeFileSync(lockPath, JSON.stringify({ ...record, resetCleanupRequired: marker }));
			assert.throws(() => acquireAdapterOwnership(root, "fire", "local", fake), /malformed/);
			assert.ok(fs.existsSync(lockPath));
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
}

test("unmarked dead foreign ownership remains reclaimable for reset", async () => {
	const root = fixture();
	try {
		foreign(root);
		let resets = 0;
		await withAdapterResetOwnership(root, "local", {
			...fake, confirm: async () => assert.fail("dead stale owner needs no termination"), quiesce: async () => {},
		}, async () => { resets++; });
		assert.equal(resets, 1);
		assert.equal(fs.existsSync(adapterOwnershipLockPath(root)), false);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("local marking is idempotent and preserves persisted startup identity, inode and permissions", () => {
	const root = fixture();
	const held = acquireAdapterOwnership(root, "pending-fire", "own", fake);
	try {
		const record = JSON.parse(fs.readFileSync(held.lockPath, "utf8"));
		const stat = fs.statSync(held.lockPath);
		bindAdapterOwnershipRun(held, "bound-run");
		markAdapterOwnershipCleanupRequired(held);
		const marked = fs.readFileSync(held.lockPath, "utf8");
		markAdapterOwnershipCleanupRequired(held);
		assert.equal(fs.readFileSync(held.lockPath, "utf8"), marked);
		assert.deepEqual(JSON.parse(marked), { ...record, resetCleanupRequired: true });
		const after = fs.statSync(held.lockPath);
		for (const field of ["dev", "ino", "mode", "uid", "gid"] as const) assert.equal(after[field], stat[field]);
		assert.equal(held.record.runId, "bound-run");
	} finally { releaseAdapterOwnership(held); fs.rmSync(root, { recursive: true, force: true }); }
});

for (const unsafe of ["lock replacement", "lock symlink", "lock directory", "runtime replacement", "runtime symlink", "runtime file"] as const) {
	test(`local marking rejects ${unsafe} before quiescence`, async () => {
		const root = fixture();
		const held = acquireAdapterOwnership(root, "pending-fire", "own", fake);
		const original = fs.readFileSync(held.lockPath, "utf8");
		let retained: string;
		try {
			if (unsafe.startsWith("lock")) {
				retained = path.join(root, "old-lock");
				fs.renameSync(held.lockPath, retained);
				if (unsafe === "lock replacement") fs.writeFileSync(held.lockPath, original);
				else if (unsafe === "lock symlink") fs.symlinkSync(retained, held.lockPath);
				else fs.mkdirSync(held.lockPath);
			} else {
				const runtime = path.join(root, ".herder");
				const old = path.join(root, "old-runtime");
				fs.renameSync(runtime, old);
				retained = path.join(old, path.basename(held.lockPath));
				if (unsafe === "runtime symlink") fs.symlinkSync(old, runtime);
				else if (unsafe === "runtime file") fs.writeFileSync(runtime, "unsafe");
				else {
					fs.mkdirSync(runtime);
					// Even the original lock inode moved into a new runtime is not the held namespace.
					fs.linkSync(retained, held.lockPath);
				}
			}
			await assert.rejects(() => withAdapterResetOwnership(root, "own", {
				...fake, ownership: held, confirm: async () => true,
				quiesce: async () => assert.fail("must not drain unsafe ownership"),
			}, async () => assert.fail("must not reset")), /unsafe|replaced/);
			assert.throws(() => markAdapterOwnershipCleanupRequired(held), /unsafe|replaced/);
			assert.equal(fs.readFileSync(retained, "utf8"), original);
		} finally { fs.closeSync(held.descriptor); fs.rmSync(root, { recursive: true, force: true }); }
	});
}

for (const failure of ["truncate", "invalidation sync", "torn write", "final sync"] as const) {
	test(`local marker ${failure} failure prevents drain and destruction`, async (t) => {
		const root = fixture();
		const held = acquireAdapterOwnership(root, "pending-fire", "own", fake);
		try {
			// Inject failures into ownership persistence, not execution DB initialization/permission repair.
			openExecutionDatabase(root, { create: true }).close();
			if (failure === "truncate") t.mock.method(fs, "ftruncateSync", () => { throw Error("fixture persistence failure"); });
			else if (failure === "torn write") {
				const write = fs.writeSync;
				t.mock.method(fs, "writeSync", (fd: number) => { write(fd, "{", 0, "utf8"); return 1; });
			} else {
				const sync = fs.fsyncSync;
				let calls = 0;
				t.mock.method(fs, "fsyncSync", (fd: number) => {
					if (++calls === (failure === "final sync" ? 2 : 1)) throw Error("fixture persistence failure");
					sync(fd);
				});
			}
			await assert.rejects(() => withAdapterResetOwnership(root, "own", {
				...fake, ownership: held, confirm: async () => true,
				quiesce: async () => assert.fail("must not drain after persistence error"),
			}, async () => assert.fail("must not reset")), /persistence failure|incomplete/);
			t.mock.restoreAll();
			assert.equal(held.record.resetCleanupRequired, true);
			if (failure !== "truncate") {
				assert.throws(() => acquireAdapterOwnership(root, "next", "next", fake), /malformed|manual child-process cleanup/);
				assert.ok(fs.existsSync(held.lockPath));
			}
		} finally { t.mock.restoreAll(); releaseAdapterOwnership(held); fs.rmSync(root, { recursive: true, force: true }); }
	});
}

test("stale reaper retains a cleanup marker published by its liveness probe", () => {
	const root = fixture();
	const held = acquireAdapterOwnership(root, "pending-fire", "own", fake);
	let unexpected: ReturnType<typeof acquireAdapterOwnership> | undefined;
	try {
		const original = JSON.parse(fs.readFileSync(held.lockPath, "utf8"));
		const stat = fs.statSync(held.lockPath);
		assert.throws(() => {
			unexpected = acquireAdapterOwnership(root, "next", "next", {
				...fake, isProcessAlive: () => { markAdapterOwnershipCleanupRequired(held); return false; },
			});
		}, /manual child-process cleanup/);
		assert.deepEqual(JSON.parse(fs.readFileSync(held.lockPath, "utf8")), { ...original, resetCleanupRequired: true });
		for (const field of ["dev", "ino", "mode", "uid", "gid"] as const) assert.equal(fs.statSync(held.lockPath)[field], stat[field]);
	} finally {
		if (unexpected) releaseAdapterOwnership(unexpected);
		releaseAdapterOwnership(held);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const marked of [false, true]) {
	for (const replacement of ["lock", "runtime"] as const) {
		test(`marker rejects ${replacement} replacement during final fsync (already marked: ${marked})`, (t) => {
			const root = fixture();
			const held = acquireAdapterOwnership(root, "pending-fire", "own", fake);
			try {
				const original = fs.readFileSync(held.lockPath, "utf8");
				const stat = fs.fstatSync(held.descriptor);
				if (marked) markAdapterOwnershipCleanupRequired(held);
				const sync = fs.fsyncSync;
				let calls = 0;
				t.mock.method(fs, "fsyncSync", (fd: number) => {
					sync(fd);
					const synced = fs.fstatSync(fd);
					if (synced.dev !== stat.dev || synced.ino !== stat.ino || ++calls !== (marked ? 1 : 2)) return;
					if (replacement === "lock") {
						fs.renameSync(held.lockPath, path.join(root, "old-lock"));
						fs.writeFileSync(held.lockPath, original);
					} else {
						fs.renameSync(path.join(root, ".herder"), path.join(root, "old-runtime"));
						fs.mkdirSync(path.join(root, ".herder"));
						fs.linkSync(path.join(root, "old-runtime", path.basename(held.lockPath)), held.lockPath);
					}
				});
				assert.throws(() => markAdapterOwnershipCleanupRequired(held), /replaced/);
				assert.equal(calls, marked ? 1 : 2);
				if (replacement === "lock") assert.equal(fs.readFileSync(held.lockPath, "utf8"), original);
			} finally {
				t.mock.restoreAll();
				fs.closeSync(held.descriptor);
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}
}
