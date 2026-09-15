import assert from "node:assert/strict";
import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
	captureServiceTermination,
	acquireServiceOwnership,
	acquireStartExclusion,
	releaseServiceOwnership,
	releaseStartExclusion,
	serviceOwnershipLockPath,
	serviceProcessAlive,
} from "../../../src/daemon/service-ownership.ts";

async function spawnNodeHelper(marker?: string): Promise<{ child: ChildProcess; pid: number }> {
	// Liveness must not depend on the helper command line.
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

test("preserves service ownership held by a live unrelated process", { timeout: 10_000 }, async () => {
	const paths = fixture();
	let helper: ChildProcess | undefined;
	try {
		const spawned = await spawnNodeHelper();
		helper = spawned.child;
		assert.equal(serviceProcessAlive(spawned.pid), true);
		const lockPath = writeServiceLock(paths.planDirectory, spawned.pid);
		const payload = fs.readFileSync(lockPath, "utf8");
		assert.throws(() => acquireServiceOwnership(paths.planDirectory, "replacement-instance"), /already held/);
		assert.equal(fs.readFileSync(lockPath, "utf8"), payload);
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

// The child blocks synchronously inside the real synchronous acquisition API.
// Each byte on stdin advances exactly one publication/reclamation boundary.
const contenderSource = `
import fs from 'node:fs';
import * as ownership from ${JSON.stringify(new URL("../../../src/daemon/service-ownership.ts", import.meta.url).href)};
const [kind, target, lockPath, phase] = process.argv.slice(1);
// Node creates nonblocking child pipes on some platforms; readSync must wait.
process.stdin._handle.setBlocking(true);
const send = message => fs.writeSync(1, JSON.stringify(message) + '\\n');
const wait = () => {
  if (fs.readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error('handshake closed');
};
let paused = false;
const pause = () => { paused = true; send({ status: 'paused' }); wait(); };
const write = fs.writeFileSync;
fs.writeFileSync = function(fd, payload, ...args) {
  if (!paused && typeof fd === 'number' && (phase === 'empty' || phase === 'partial')) {
    if (phase === 'partial') fs.writeSync(fd, payload.slice(0, -1));
    pause();
    if (phase === 'partial') { fs.writeSync(fd, '\\n'); return; }
  }
  return write.call(this, fd, payload, ...args);
};
const mkdir = fs.mkdirSync;
fs.mkdirSync = function(name, ...args) {
  if (!paused && name === lockPath + '.reclaim' && phase === 'mkdir') pause();
  const result = mkdir.call(this, name, ...args);
  if (!paused && name === lockPath + '.reclaim' && phase === 'guard') pause();
  return result;
};
const read = fs.readSync;
fs.readSync = function(...args) {
  const result = read.apply(this, args);
  if (!paused && args[0] !== 0 && phase === 'inspection') pause();
  return result;
};
let lock, failure;
try {
  lock = kind === 'start' ? ownership.acquireStartExclusion(target)
    : ownership.acquireServiceOwnership(target, 'child-instance');
} catch (error) { failure = error.message; }
if (lock) {
  send({ status: 'acquired' }); wait();
  if (kind === 'start') ownership.releaseStartExclusion(lock);
  else ownership.releaseServiceOwnership(lock);
  send({ status: 'released' });
} else { send({ status: 'refused', error: failure }); }
`;

function contender(kind: string, target: string, lockPath: string, phase: string) {
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", contenderSource,
		kind, target, lockPath, phase], { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	return {
		child,
		resume: () => child.stdin.write("x"),
		async expect(status: string) {
			const line = await lines.next();
			assert.equal(line.done, false, `child exited before ${status}: ${stderr}`);
			const message = JSON.parse(line.value!);
			assert.equal(message.status, status, JSON.stringify(message));
			return message;
		},
	};
}

for (const kind of ["start", "service"] as const) {
	function api(paths: ReturnType<typeof fixture>) {
		const lockPath = kind === "start" ? paths.startLockPath : serviceOwnershipLockPath(paths.planDirectory);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		return {
			lockPath,
			target: kind === "start" ? lockPath : paths.planDirectory,
			acquire: () => kind === "start" ? acquireStartExclusion(lockPath) : acquireServiceOwnership(paths.planDirectory, "test-instance"),
			release: kind === "start" ? releaseStartExclusion : releaseServiceOwnership,
			payload: (pid: number) => kind === "start" ? `${pid}\n` : `${pid} test-instance\n`,
		};
	}

	function refuses(lock: ReturnType<typeof api>) {
		if (kind === "start") assert.equal(lock.acquire(), null);
		else assert.throws(lock.acquire, /already held|Cannot safely read/);
	}

	for (const phase of ["empty", "partial"]) {
		test(`${kind}: cross-process ${phase} publisher retains its lock`, { timeout: 10_000 }, async () => {
			const paths = fixture();
			let publisher: ReturnType<typeof contender> | undefined;
			try {
				const lock = api(paths);
				publisher = contender(kind, lock.target, lock.lockPath, phase);
				await publisher.expect("paused");
				const identity = fs.statSync(lock.lockPath);
				const payload = fs.readFileSync(lock.lockPath, "utf8");
				if (phase === "empty") assert.equal(payload, "");
				else if (kind === "start") assert.equal(payload, `${publisher.child.pid}`);
				else {
					assert.ok(payload.startsWith(`${publisher.child.pid} child-instance\n`));
					assert.ok(!payload.endsWith("\n"));
				}
				refuses(lock);
				assert.equal(fs.statSync(lock.lockPath).ino, identity.ino);
				assert.equal(fs.readFileSync(lock.lockPath, "utf8"), payload);
				publisher.resume();
				await publisher.expect("acquired");
				refuses(lock);
				assert.equal(fs.statSync(lock.lockPath).ino, identity.ino);
				publisher.resume();
				await publisher.expect("released");
				assert.equal(fs.existsSync(lock.lockPath), false);
			} finally {
				await stopProcess(publisher?.child);
				fs.rmSync(paths.root, { recursive: true, force: true });
			}
		});
	}

	test(`${kind}: stale pre-guard snapshots cannot reclaim the winning replacement`, { timeout: 10_000 }, async () => {
		const paths = fixture();
		const children: ReturnType<typeof contender>[] = [];
		try {
			const lock = api(paths);
			fs.writeFileSync(lock.lockPath, lock.payload(await spawnDeadOwner()));
			const winner = contender(kind, lock.target, lock.lockPath, "mkdir");
			children.push(winner);
			await winner.expect("paused");
			const loser = contender(kind, lock.target, lock.lockPath, "inspection");
			children.push(loser);
			await loser.expect("paused");
			winner.resume();
			await winner.expect("acquired");
			const identity = fs.statSync(lock.lockPath);
			const payload = fs.readFileSync(lock.lockPath, "utf8");
			loser.resume();
			const refusal = await loser.expect("refused");
			if (kind === "start") assert.equal(refusal.error, undefined);
			else assert.match(refusal.error, /already held by pid|Cannot safely read/);
			refuses(lock);
			assert.equal(fs.statSync(lock.lockPath).ino, identity.ino);
			assert.equal(fs.readFileSync(lock.lockPath, "utf8"), payload);
			assert.equal(fs.existsSync(`${lock.lockPath}.reclaim`), false);
			winner.resume();
			await winner.expect("released");
		} finally {
			await Promise.all(children.map(({ child }) => stopProcess(child)));
			fs.rmSync(paths.root, { recursive: true, force: true });
		}
	});

	test(`${kind}: a held reclamation guard excludes another process`, { timeout: 10_000 }, async () => {
		const paths = fixture();
		let reclaimer: ReturnType<typeof contender> | undefined;
		try {
			const lock = api(paths);
			const payload = lock.payload(await spawnDeadOwner());
			fs.writeFileSync(lock.lockPath, payload);
			reclaimer = contender(kind, lock.target, lock.lockPath, "guard");
			await reclaimer.expect("paused");
			assert.throws(lock.acquire, /reclamation guard/);
			assert.equal(fs.readFileSync(lock.lockPath, "utf8"), payload);
			reclaimer.resume();
			await reclaimer.expect("acquired");
			refuses(lock);
			reclaimer.resume();
			await reclaimer.expect("released");
		} finally {
			await stopProcess(reclaimer?.child);
			fs.rmSync(paths.root, { recursive: true, force: true });
		}
	});

	test(`${kind}: repeated identity replacement is preserved and bounded`, async (t) => {
		const paths = fixture();
		const lstat = fs.lstatSync;
		try {
			const lock = api(paths);
			const payload = lock.payload(await spawnDeadOwner());
			fs.writeFileSync(lock.lockPath, payload);
			let inspections = 0;
			let replacements = 0;
			try {
				t.mock.method(fs, "lstatSync", ((name, ...args) => {
					if (name === lock.lockPath && ++inspections % 3 === 0) {
						assert.ok(++replacements <= 3, "acquisition must not retry indefinitely");
						const next = `${lock.lockPath}.next`;
						fs.writeFileSync(next, payload);
						fs.renameSync(next, lock.lockPath);
					}
					return lstat(name, ...args);
				}) as typeof fs.lstatSync);
				refuses(lock);
			} finally { t.mock.restoreAll(); }
			assert.equal(replacements, 3);
			assert.equal(fs.readFileSync(lock.lockPath, "utf8"), payload);
			assert.equal(fs.existsSync(`${lock.lockPath}.reclaim`), false);
		} finally {
			t.mock.restoreAll();
			fs.rmSync(paths.root, { recursive: true, force: true });
		}
	});

	for (const failure of ["detached publication", "guard cleanup"]) {
		test(`${kind}: ${failure} failure closes the acquired descriptor`, async () => {
			const paths = fixture();
			const write = fs.writeFileSync;
			const rmdir = fs.rmdirSync;
			let descriptor: number | undefined;
			try {
				const lock = api(paths);
				if (failure === "guard cleanup") fs.writeFileSync(lock.lockPath, lock.payload(await spawnDeadOwner()));
				try {
					fs.writeFileSync = ((file, ...args) => {
						const result = write(file, ...args);
						if (typeof file === "number") {
							descriptor = file;
							if (failure === "detached publication") {
								fs.unlinkSync(lock.lockPath);
								write(lock.lockPath, "replacement");
							}
						}
						return result;
					}) as typeof fs.writeFileSync;
					fs.rmdirSync = ((name, ...args) => {
						if (name === `${lock.lockPath}.reclaim`) throw new Error("guard cleanup failed");
						return rmdir(name, ...args);
					}) as typeof fs.rmdirSync;
					assert.throws(lock.acquire, /replaced during publication|guard cleanup failed/);
				} finally { fs.writeFileSync = write; fs.rmdirSync = rmdir; }
				assert.notEqual(descriptor, undefined);
				assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
				if (failure === "detached publication") assert.equal(fs.readFileSync(lock.lockPath, "utf8"), "replacement");
				else {
					assert.equal(fs.existsSync(lock.lockPath), false);
					assert.throws(lock.acquire, /reclamation guard/);
				}
			} finally {
				fs.writeFileSync = write;
				fs.rmdirSync = rmdir;
				fs.rmSync(paths.root, { recursive: true, force: true });
			}
		});
	}

	test(`${kind}: malformed, symlink, nonregular and unreadable locks fail closed`, async () => {
		const paths = fixture();
		try {
			const lock = api(paths);
			const dead = await spawnDeadOwner();
			for (const payload of ["", `${dead}`, `${dead} instance`, `0\n`, `-1\n`, `${dead}\nextra\n`,
				`${dead} instance\nextra`, `${dead} a b\n`, lock.payload(Number.MAX_SAFE_INTEGER + 1), "x".repeat(4097)]) {
				fs.writeFileSync(lock.lockPath, payload);
				refuses(lock);
				assert.equal(fs.readFileSync(lock.lockPath, "utf8"), payload);
			}
			fs.unlinkSync(lock.lockPath);
			const target = path.join(paths.root, "target");
			fs.writeFileSync(target, lock.payload(dead));
			fs.symlinkSync(target, lock.lockPath);
			refuses(lock);
			assert.equal(fs.lstatSync(lock.lockPath).isSymbolicLink(), true);
			assert.equal(fs.readFileSync(target, "utf8"), lock.payload(dead));
			fs.unlinkSync(lock.lockPath);
			fs.mkdirSync(lock.lockPath);
			refuses(lock);
			assert.equal(fs.statSync(lock.lockPath).isDirectory(), true);
			fs.rmdirSync(lock.lockPath);
			fs.writeFileSync(lock.lockPath, lock.payload(dead));
			const open = fs.openSync;
			let injected = false;
			try {
				fs.openSync = ((name, flags, ...args) => {
					if (name === lock.lockPath && flags !== "wx") {
						injected = true;
						throw Object.assign(new Error("injected unreadable lock"), { code: "EACCES" });
					}
					return open(name, flags, ...args);
				}) as typeof fs.openSync;
				refuses(lock);
			} finally { fs.openSync = open; }
			assert.equal(injected, true);
			assert.equal(fs.readFileSync(lock.lockPath, "utf8"), lock.payload(dead));
		} finally { fs.rmSync(paths.root, { recursive: true, force: true }); }
	});

	for (const evidence of ["short read", "invalid UTF-8"]) {
		test(`${kind}: ${evidence} is not reclaimable evidence`, async (t) => {
			const paths = fixture();
			try {
				const lock = api(paths);
				const prefix = Buffer.from(lock.payload(await spawnDeadOwner()));
				const payload = evidence === "short read" ? Buffer.concat([prefix, Buffer.from("garbage")])
					: Buffer.concat([Buffer.from(prefix.toString().split(/[ \n]/)[0] + " "), Buffer.from([0xff, 10])]);
				fs.writeFileSync(lock.lockPath, payload);
				const identity = fs.statSync(lock.lockPath);
				const read = fs.readSync;
				if (evidence === "short read") {
					t.mock.method(fs, "readSync", ((fd, buffer, offset, length, position) =>
						read(fd, buffer, offset, Math.min(length, prefix.length), position)) as typeof fs.readSync);
				}
				try { refuses(lock); } finally { t.mock.restoreAll(); }
				assert.deepEqual(fs.readFileSync(lock.lockPath), payload);
				assert.equal(fs.statSync(lock.lockPath).ino, identity.ino);
			} finally {
				t.mock.restoreAll();
				fs.rmSync(paths.root, { recursive: true, force: true });
			}
		});
	}

	test(`${kind}: failed publication closes its descriptor without deleting a replacement`, () => {
		const paths = fixture();
		const write = fs.writeFileSync;
		let descriptor: number | undefined;
		try {
			const lock = api(paths);
			const replacement = lock.payload(process.pid);
			const failure = new Error("injected publication failure");
			try {
				fs.writeFileSync = ((file, ...args) => {
					if (typeof file === "number") {
						descriptor = file;
						fs.unlinkSync(lock.lockPath);
						write(lock.lockPath, replacement);
						throw failure;
					}
					return write(file, ...args);
				}) as typeof fs.writeFileSync;
				assert.throws(lock.acquire, (error) => error === failure);
			} finally { fs.writeFileSync = write; }
			assert.notEqual(descriptor, undefined);
			assert.throws(() => fs.fstatSync(descriptor!), { code: "EBADF" });
			assert.equal(fs.readFileSync(lock.lockPath, "utf8"), replacement);
		} finally {
			fs.writeFileSync = write;
			if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
			fs.rmSync(paths.root, { recursive: true, force: true });
		}
	});

	for (const removed of [false, true]) {
		test(`${kind}: release closes descriptor with ${removed ? "removed namespace" : "replacement lock"}`, () => {
			const paths = fixture();
			const lock = api(paths);
			let held: ReturnType<typeof lock.acquire> = null;
			try {
				held = lock.acquire();
				assert.ok(held);
				if (removed) fs.rmSync(paths.root, { recursive: true, force: true });
				else {
					fs.unlinkSync(lock.lockPath);
					fs.writeFileSync(lock.lockPath, lock.payload(process.pid));
				}
				lock.release(held);
				assert.throws(() => fs.fstatSync(held!.descriptor), { code: "EBADF" });
				if (removed) assert.equal(fs.existsSync(paths.root), false);
				else assert.equal(fs.readFileSync(lock.lockPath, "utf8"), lock.payload(process.pid));
				held = null;
			} finally {
				if (held) lock.release(held);
				fs.rmSync(paths.root, { recursive: true, force: true });
			}
		});
	}

	for (const missing of [false, true]) {
		test(`${kind}: abandoned reclaim guard fails closed with ${missing ? "missing" : "stale"} main lock`, async () => {
			const paths = fixture();
			try {
				const lock = api(paths);
				const payload = lock.payload(await spawnDeadOwner());
				if (!missing) fs.writeFileSync(lock.lockPath, payload);
				const guard = `${lock.lockPath}.reclaim`;
				fs.mkdirSync(guard);
				assert.throws(lock.acquire, (error: Error) => {
					assert.ok(error.message.includes(guard));
					assert.match(error.message, /quiescen/i);
					assert.match(error.message, /manual/i);
					return true;
				});
				assert.equal(fs.statSync(guard).isDirectory(), true);
				if (missing) assert.equal(fs.existsSync(lock.lockPath), false);
				else assert.equal(fs.readFileSync(lock.lockPath, "utf8"), payload);
			} finally { fs.rmSync(paths.root, { recursive: true, force: true }); }
		});
	}
}

for (const code of ["EPERM", "EACCES", "ESRCH"]) {
	test(`service liveness only treats ESRCH as death: ${code}`, (t) => {
		t.mock.method(process, "kill", () => { throw Object.assign(new Error(code), { code }); });
		assert.equal(serviceProcessAlive(process.pid), code !== "ESRCH");
	});
}

test("native service termination evidence captures and rechecks synchronously", () => {
	const paths = fixture();
	const held = acquireServiceOwnership(paths.planDirectory, "native-instance");
	try {
		const text = fs.readFileSync(held.lockPath, "utf8");
		assert.equal(text.split("\n")[0], `${process.pid} native-instance`);
		const metadata = JSON.parse(text.split("\n")[1]);
		assert.equal(metadata.version, 1);
		assert.equal(metadata.planDirectory, fs.realpathSync(paths.planDirectory));
		assert.match(metadata.processIdentity, /^(linux|darwin):/);
		const verify = captureServiceTermination(paths.planDirectory, { pid: process.pid, instanceId: "native-instance" });
		verify();
		verify();
	} finally { releaseServiceOwnership(held); fs.rmSync(paths.root, { recursive: true, force: true }); }
});

for (const when of ["capture", "invocation"]) {
	for (const failure of ["birth", "plan", "legacy", "pid", "instance", "missing", "lock swap", "runtime swap", "runtime symlink", "lock symlink", "probe", "inspection"]) {
		test(`termination refuses ${failure} at ${when}`, (t) => {
			const paths = fixture();
			const held = acquireServiceOwnership(paths.planDirectory, "native-instance");
			try {
				const service = { pid: process.pid, instanceId: "native-instance" };
				const capture = () => captureServiceTermination(paths.planDirectory, service);
				const verify = when === "invocation" ? capture() : capture;
				const text = fs.readFileSync(held.lockPath, "utf8");
				const [first, second] = text.split("\n");
				const metadata = JSON.parse(second);
				if (failure === "birth" || failure === "plan") {
					metadata[failure === "birth" ? "processIdentity" : "planDirectory"] = failure === "birth" ? "wrong-birth" : paths.root;
					fs.writeFileSync(held.lockPath, `${first}\n${JSON.stringify(metadata)}\n`);
				} else if (failure === "legacy") fs.writeFileSync(held.lockPath, `${first}\n`);
				else if (failure === "pid" || failure === "instance") {
					fs.writeFileSync(held.lockPath, `${failure === "pid" ? process.pid + 1 : process.pid} ${failure === "instance" ? "other" : service.instanceId}\n${second}\n`);
				} else if (failure === "missing") fs.unlinkSync(held.lockPath);
				else if (["lock swap", "lock symlink", "runtime swap", "runtime symlink"].includes(failure)) {
					const replace = () => {
						if (failure.startsWith("lock")) {
							fs.renameSync(held.lockPath, `${held.lockPath}.old`);
							if (failure === "lock symlink") fs.symlinkSync(`${held.lockPath}.old`, held.lockPath);
							else fs.writeFileSync(held.lockPath, text);
						} else {
							const runtime = path.dirname(held.lockPath);
							fs.renameSync(runtime, `${runtime}.old`);
							if (failure === "runtime symlink") fs.symlinkSync(`${runtime}.old`, runtime);
							else { fs.mkdirSync(runtime); fs.writeFileSync(held.lockPath, text); }
						}
					};
					if (when === "capture" && failure.endsWith("swap")) {
						const read = fs.readSync;
						t.mock.method(fs, "readSync", ((fd, buffer, offset, length, position) => {
							const result = read(fd, buffer, offset, length, position);
							replace();
							return result;
						}) as typeof fs.readSync);
					} else replace();
				} else if (failure === "probe") {
					t.mock.method(fs, "readFileSync", () => { throw new Error("probe failed"); });
					t.mock.method(childProcess, "execFileSync", () => { throw new Error("probe failed"); });
					syncBuiltinESMExports();
				} else if (failure === "inspection") {
					t.mock.method(fs, "readSync", () => { throw new Error("inspection failed"); });
				}
				assert.throws(verify);
			} finally {
				t.mock.restoreAll(); syncBuiltinESMExports();
				releaseServiceOwnership(held);
				fs.rmSync(paths.root, { recursive: true, force: true });
			}
		});
	}
}
