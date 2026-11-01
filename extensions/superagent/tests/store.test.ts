import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { branchCandidates, openStore, pidAlive, slugify } from "../src/store.ts";
import { LOCK_STALE_MS, type NewTicket } from "../src/types.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const STORE_URL = pathToFileURL(fileURLToPath(new URL("../src/store.ts", import.meta.url))).href;

const init = (title: string, more: Partial<NewTicket> = {}): NewTicket => ({
	title,
	request: `please: ${title}`,
	source: `the whole message about ${title}`,
	createdBy: "session-a",
	base: "0123456789abcdef0123456789abcdef01234567",
	target: "main",
	...more,
});

let dir: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "superagent-store-")));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("slugify and branchCandidates", () => {
	it.each([
		["Fix the Login Bug!", "fix-the-login-bug"],
		["  --Leading and trailing--  ", "leading-and-trailing"],
		["a/b\\c  d__e", "a-b-c-d-e"],
		["Café ünïcode", "caf-n-code"],
		["", "ticket"],
		["!!! ???", "ticket"],
		["x".repeat(50), "x".repeat(40)],
		[`${"x".repeat(39)} yz`, "x".repeat(39)],
		["Version 2.0 release", "version-2-0-release"],
	])("slugify(%j) is %j", (title, slug) => {
		expect(slugify(title)).toBe(slug);
	});

	it("yields pi/<id>-<slug>, then numbered suffixes", () => {
		const names = branchCandidates(7, "fix-it");
		expect([names.next().value, names.next().value, names.next().value]).toEqual(["pi/7-fix-it", "pi/7-fix-it-2", "pi/7-fix-it-3"]);
	});
});

describe("tickets", () => {
	it("creates the layout and a queued ticket with its paths and a created event", () => {
		const store = openStore(dir);
		expect(store.root).toBe(join(dir, "superagent"));
		expect(store.sessionsDir).toBe(join(dir, "superagent", "sessions"));
		expect(existsSync(store.sessionsDir)).toBe(true);

		const ticket = store.create(init("Fix the Login Bug", { note: "user prefers small commits" }), "session-b");
		expect(ticket).toMatchObject({
			version: 1,
			id: 1,
			slug: "fix-the-login-bug",
			title: "Fix the Login Bug",
			request: "please: Fix the Login Bug",
			source: "the whole message about Fix the Login Bug",
			note: "user prefers small commits",
			createdBy: "session-a",
			owner: "session-b",
			target: "main",
			branch: "pi/1-fix-the-login-bug",
			worktree: join(dir, "superagent", "worktrees", "1-fix-the-login-bug"),
			state: "queued",
		});
		expect(ticket.createdAt).toBe(ticket.updatedAt);
		expect(existsSync(ticket.worktree)).toBe(false);
		expect(store.get(1)).toEqual(ticket);
		expect(JSON.parse(readFileSync(join(dir, "superagent", "tickets", "1", "ticket.json"), "utf8"))).toEqual(ticket);
		expect(store.events(1)).toEqual([expect.objectContaining({ type: "created", at: expect.any(Number) })]);

		const detached = store.create(init("", { target: undefined, note: undefined }), "session-a");
		expect(detached.id).toBe(2);
		expect(detached.branch).toBe("pi/2-ticket");
		expect("target" in detached).toBe(false);
		expect("note" in detached).toBe(false);
		expect(store.list().map((t) => t.id)).toEqual([1, 2]);
	});

	it("skips ids whose directory exists, across store instances", () => {
		const a = openStore(dir);
		const b = openStore(dir);
		expect(a.create(init("one"), "s").id).toBe(1);
		expect(b.create(init("two"), "s").id).toBe(2);
		// Another process is between mkdir and its ticket.json write.
		mkdirSync(join(dir, "superagent", "tickets", "3"));
		expect(a.create(init("four"), "s").id).toBe(4);
		expect(a.list().map((t) => t.id)).toEqual([1, 2, 4]);
		expect(a.get(3)).toBeUndefined();
	});

	it("allocates distinct ids under concurrent create calls from several processes", async () => {
		openStore(dir);
		const script = `
			const { openStore } = await import(process.argv[1]);
			const store = openStore(process.argv[2]);
			const ids = [];
			for (let i = 0; i < 5; i++) ids.push(store.create({ title: "t " + process.pid + " " + i, request: "r", source: "s", createdBy: "x", base: "b" }, "x").id);
			console.log(JSON.stringify(ids));
		`;
		const runs = Array.from(
			{ length: 4 },
			() =>
				new Promise<number[]>((resolve, reject) => {
					execFile(
						process.execPath,
						["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, STORE_URL, dir],
						{ encoding: "utf8" },
						(error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout) as number[])),
					);
				}),
		);
		const ids = (await Promise.all(runs)).flat();
		expect(ids).toHaveLength(20);
		expect(new Set(ids).size).toBe(20);
		expect([...ids].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		const store = openStore(dir);
		expect(store.list()).toHaveLength(20);
		for (const ticket of store.list()) expect(ticket.branch).toBe(`pi/${ticket.id}-${ticket.slug}`);
	});

	it("updates: sets fields, deletes undefined ones, bumps updatedAt, appends the event", () => {
		const store = openStore(dir);
		const created = store.create(init("work"), "s");
		const first = store.update(1, { state: "question", question: "Which one?", mergeRequested: true }, { type: "report", state: "question" });
		expect(first).toMatchObject({ state: "question", question: "Which one?", mergeRequested: true, title: "work" });
		expect(first.updatedAt).toBeGreaterThan(created.updatedAt);

		const second = store.update(1, { state: "working", question: undefined, mergeRequested: undefined });
		expect(second.state).toBe("working");
		expect("question" in second).toBe(false);
		expect("mergeRequested" in second).toBe(false);
		expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
		expect(store.get(1)).toEqual(second);
		expect("question" in JSON.parse(readFileSync(join(dir, "superagent", "tickets", "1", "ticket.json"), "utf8"))).toBe(false);

		// The id and version are not patchable.
		expect(store.update(1, { id: 99, version: 1 } as never).id).toBe(1);
		expect(store.events(1).map((e) => e.type)).toEqual(["created", "report"]);
		expect(store.events(1)[1]).toMatchObject({ type: "report", state: "question" });
		expect(() => store.update(42, { state: "working" })).toThrow(/unknown ticket #42/);
		// No temp files left behind.
		expect(readdirNames(join(dir, "superagent", "tickets", "1")).sort()).toEqual(["events.jsonl", "ticket.json"]);
	});

	it("survives corrupt ticket.json and events lines", () => {
		const store = openStore(dir);
		store.create(init("good"), "s");
		store.create(init("bad"), "s");
		store.create(init("wrong id"), "s");
		writeFileSync(join(dir, "superagent", "tickets", "2", "ticket.json"), "{ not json");
		const third = JSON.parse(readFileSync(join(dir, "superagent", "tickets", "3", "ticket.json"), "utf8"));
		writeFileSync(join(dir, "superagent", "tickets", "3", "ticket.json"), JSON.stringify({ ...third, id: 9 }));
		writeFileSync(join(dir, "superagent", "tickets", "not-a-number"), "");
		expect(store.get(2)).toBeUndefined();
		expect(store.get(3)).toBeUndefined();
		expect(store.get(0)).toBeUndefined();
		expect(store.get(1.5)).toBeUndefined();
		expect(store.list().map((t) => t.id)).toEqual([1]);
		expect(() => store.update(2, { state: "working" })).toThrow(/unknown ticket #2/);
		expect(store.create(init("next"), "s").id).toBe(4);

		writeFileSync(join(dir, "superagent", "tickets", "1", "events.jsonl"), `${readFileSync(join(dir, "superagent", "tickets", "1", "events.jsonl"), "utf8")}garbage\n{"no":"type"}\n`);
		store.update(1, {}, { type: "later" });
		expect(store.events(1).map((e) => e.type)).toEqual(["created", "later"]);
		expect(store.events(77)).toEqual([]);
	});
});

function readdirNames(path: string): string[] {
	return readdirSync(path);
}

describe("locks", () => {
	const me = { pid: process.pid, sessionId: "session-a" };
	const other = { pid: process.pid, sessionId: "session-b" };
	const lockFile = () => join(dir, "superagent", "tickets", "1", "lock");

	function deadPid(): number {
		const child = spawnSync(process.execPath, ["-e", ""]);
		expect(pidAlive(child.pid as number)).toBe(false);
		return child.pid as number;
	}

	it("acquires, refuses a second live owner, refreshes, and releases", () => {
		const store = openStore(dir);
		store.create(init("t"), "s");
		expect(store.holder(1)).toBeUndefined();
		expect(store.acquire(1, me)).toBe(true);
		expect(store.holder(1)).toEqual(me);
		expect(store.acquire(1, other)).toBe(false);
		expect(store.holder(1)).toEqual(me);

		const before = JSON.parse(readFileSync(lockFile(), "utf8"));
		expect(before).toEqual({ ...me, heartbeat: expect.any(Number) });
		writeFileSync(lockFile(), JSON.stringify({ ...me, heartbeat: before.heartbeat - 60_000 }));
		store.refresh(1, me);
		expect(JSON.parse(readFileSync(lockFile(), "utf8")).heartbeat).toBeGreaterThanOrEqual(before.heartbeat);
		// Acquiring again as the same owner refreshes too.
		writeFileSync(lockFile(), JSON.stringify({ ...me, heartbeat: before.heartbeat - 60_000 }));
		expect(store.acquire(1, me)).toBe(true);
		expect(JSON.parse(readFileSync(lockFile(), "utf8")).heartbeat).toBeGreaterThanOrEqual(before.heartbeat);

		expect(() => store.refresh(1, other)).toThrow(/held by another session/);
		store.release(1, other);
		expect(store.holder(1)).toEqual(me);
		store.release(1, me);
		expect(existsSync(lockFile())).toBe(false);
		expect(store.holder(1)).toBeUndefined();
		store.release(1, me);
		expect(store.acquire(1, other)).toBe(true);
		expect(store.holder(1)).toEqual(other);
	});

	it("refresh retakes a lock that disappeared", () => {
		const store = openStore(dir);
		store.create(init("t"), "s");
		store.acquire(1, me);
		rmSync(lockFile());
		store.refresh(1, me);
		expect(store.holder(1)).toEqual(me);
	});

	it("treats an old heartbeat as stale and lets another owner take over", () => {
		const store = openStore(dir);
		store.create(init("t"), "s");
		writeFileSync(lockFile(), JSON.stringify({ ...other, heartbeat: Date.now() - LOCK_STALE_MS - 1_000 }));
		expect(store.holder(1)).toBeUndefined();
		expect(store.acquire(1, me)).toBe(true);
		expect(store.holder(1)).toEqual(me);
		expect(readdirNames(join(dir, "superagent", "tickets", "1")).sort()).toEqual(["events.jsonl", "lock", "ticket.json"]);
	});

	it("treats a dead pid as stale even with a fresh heartbeat", () => {
		const store = openStore(dir);
		store.create(init("t"), "s");
		const dead = { pid: deadPid(), sessionId: "gone" };
		writeFileSync(lockFile(), JSON.stringify({ ...dead, heartbeat: Date.now() }));
		expect(store.holder(1)).toBeUndefined();
		expect(store.acquire(1, me)).toBe(true);
		expect(store.holder(1)).toEqual(me);
	});

	it("keeps a fresh unreadable lock (being written) and takes over an old one", () => {
		const store = openStore(dir);
		store.create(init("t"), "s");
		writeFileSync(lockFile(), "");
		expect(store.acquire(1, me)).toBe(false);
		const old = (Date.now() - 60_000) / 1000;
		utimesSync(lockFile(), old, old);
		expect(store.acquire(1, me)).toBe(true);
		expect(store.holder(1)).toEqual(me);
	});

	it("a pid of another user (EPERM) counts as alive", () => {
		expect(pidAlive(process.pid)).toBe(true);
		expect(pidAlive(0)).toBe(false);
		expect(pidAlive(-5)).toBe(false);
		if (process.getuid?.() !== 0) expect(pidAlive(1)).toBe(true);
	});

	it("refuses locks for unknown tickets", () => {
		const store = openStore(dir);
		expect(() => store.acquire(5, me)).toThrow(/unknown ticket #5/);
		expect(store.holder(5)).toBeUndefined();
	});
});
