import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HERDER_VERSION } from "../../src/config.ts";
import { sha256Hex } from "../../src/journal/keys.ts";
import { fileFs, writeAtomic } from "../../src/run/files.ts";
import { activeRun, createOutputStore, createRun, listRuns, openRun } from "../../src/run/store.ts";

const dirs: string[] = [];
const commonDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "herder-store-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const init = { title: "Do the thing", base: "b".repeat(40), repo: "/repo" };

describe("run store", () => {
	it("creates the run layout, journals run.started, and renders progress", () => {
		const common = commonDir();
		const run = createRun(common, { ...init, runId: "20260101-000000-abcd", goal: "# Goal: x\n" });
		expect(run.paths.dir).toBe(join(common, "herder", "runs", "20260101-000000-abcd"));
		expect(readFileSync(run.paths.goal, "utf8")).toBe("# Goal: x\n");
		expect(readFileSync(run.paths.plan, "utf8")).toBe("");
		expect(readFileSync(run.paths.notes, "utf8")).toBe("");
		expect(existsSync(run.paths.scripts) && existsSync(run.paths.outputs)).toBe(true);
		expect(run.journal.read()).toMatchObject([{ t: "run.started", runId: run.runId, title: init.title, base: init.base, runtime: HERDER_VERSION, repo: "/repo" }]);
		expect(readFileSync(run.paths.progress, "utf8")).toContain("# Herder run 20260101-000000-abcd: Do the thing");
		expect(() => createRun(common, { ...init, runId: "20260101-000000-abcd" })).toThrow();
		expect(createRun(common, init).runId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
	});

	it("opens an existing run and fails with nothing to resume otherwise", () => {
		const common = commonDir();
		const created = createRun(common, init);
		created.journal.append({ t: "plan.updated", sha256: "p" });
		const opened = openRun(common, created.runId);
		expect(opened.state()).toMatchObject({ runId: created.runId, planSha256: "p" });
		expect(() => openRun(common, "20990101-000000-0000")).toThrow(/^nothing to resume/);
		expect(() => openRun(common, "../../etc")).toThrow(/^nothing to resume/);
		rmSync(created.paths.journal);
		expect(() => openRun(common, created.runId)).toThrow(/^nothing to resume/);
	});

	it("re-renders progress atomically with plan tasks", () => {
		const run = createRun(commonDir(), init);
		run.renderProgress([{ id: "T1", text: "first" }]);
		const text = readFileSync(run.paths.progress, "utf8");
		expect(text).toContain("| T1 first | pending | — | — |");
		run.renderProgress([{ id: "T1", text: "first" }]);
		expect(readFileSync(run.paths.progress, "utf8")).toBe(text);
		expect(readdirSync(run.paths.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("writes immutable scripts with numbers beyond files and journaled launches", () => {
		const run = createRun(commonDir(), init);
		expect(run.writeScript("one")).toEqual({ launch: 1, path: join(run.paths.scripts, "1.js") });
		expect(run.writeScript("two").launch).toBe(2);
		run.journal.append({ t: "script.launched", launch: 2, scriptSha256: "x", args: null, head: init.base });
		run.journal.append({ t: "script.launched", launch: 5, scriptSha256: "y", args: null, head: init.base });
		expect(run.writeScript("six").launch).toBe(6);
		writeFileSync(join(run.paths.scripts, "9.js"), "crashed before journaling");
		expect(run.writeScript("ten").launch).toBe(10);
		expect(readFileSync(join(run.paths.scripts, "1.js"), "utf8")).toBe("one");
	});

	it("lists runs in order and finds the active one", () => {
		const common = commonDir();
		expect(listRuns(common)).toEqual([]);
		expect(activeRun(common)).toBeNull();
		const older = createRun(common, { ...init, runId: "20260101-000000-aaaa" });
		const newer = createRun(common, { ...init, runId: "20260102-000000-0000" });
		mkdirSync(join(common, "herder", "runs", "not-a-run"));
		expect(listRuns(common)).toEqual([older.runId, newer.runId]);
		expect(activeRun(common)).toBe(newer.runId);
		newer.journal.append({ t: "run.finished", status: "abandoned", reason: "test" });
		expect(activeRun(common)).toBe(older.runId);
	});

	it("skips runs with unreadable journals and reports them", () => {
		const common = commonDir();
		const older = createRun(common, { ...init, runId: "20260101-000000-aaaa" });
		const newer = createRun(common, { ...init, runId: "20260102-000000-0000" });
		writeFileSync(newer.paths.journal, "{oops\n{}\n");
		const errors: string[] = [];
		expect(activeRun(common, (runId, error) => errors.push(`${runId}: ${error.message}`))).toBe(older.runId);
		expect(errors).toEqual([expect.stringMatching(/^20260102-000000-0000: journal .* is corrupt at line 1/)]);
		expect(activeRun(common)).toBe(older.runId);
	});

	it("decides the active run by folded status", () => {
		const common = commonDir();
		const older = createRun(common, { ...init, runId: "20260101-000000-aaaa" });
		const newer = createRun(common, { ...init, runId: "20260102-000000-0000" });
		newer.journal.append({ t: "delivery.completed", mode: "series", target: "main", tip: "c", commits: ["c"] });
		expect(activeRun(common)).toBe(older.runId);
		older.journal.append({ t: "run.finished", status: "failed", reason: "test" });
		expect(activeRun(common)).toBeNull();
	});
});

describe("durable writes", () => {
	const observe = () => {
		const opened = new Map<number, string>();
		const synced: string[] = [];
		const { openSync, fsyncSync } = fileFs;
		vi.spyOn(fileFs, "openSync").mockImplementation(((path: string, ...rest: unknown[]) => {
			const fd = (openSync as (...args: unknown[]) => number)(path, ...rest);
			opened.set(fd, path);
			return fd;
		}) as typeof openSync);
		vi.spyOn(fileFs, "fsyncSync").mockImplementation((fd) => {
			synced.push(opened.get(fd as number) ?? "?");
			fsyncSync(fd);
		});
		return synced;
	};

	it("fsyncs the file and its directory for atomic writes, outputs, and scripts", () => {
		const run = createRun(commonDir(), init);
		const synced = observe();
		writeAtomic(join(run.paths.dir, "x.md"), "x");
		expect(synced).toEqual([expect.stringMatching(/x\.md\..*\.tmp$/), run.paths.dir]);
		synced.length = 0;
		run.outputs.put("output");
		expect(synced).toEqual([expect.stringMatching(/\.tmp$/), run.paths.outputs]);
		synced.length = 0;
		const { path } = run.writeScript("script");
		expect(synced).toEqual([path, run.paths.scripts]);
	});
});

describe("output store", () => {
	it("content-addresses outputs and rejects other refs", () => {
		const dir = join(commonDir(), "outputs");
		const outputs = createOutputStore(dir);
		const ref = outputs.put("hello\n");
		expect(ref).toBe(`outputs/${sha256Hex("hello\n")}.txt`);
		expect(outputs.put(new TextEncoder().encode("hello\n"))).toBe(ref);
		expect(outputs.read(ref)).toBe("hello\n");
		expect(readdirSync(dir)).toEqual([`${sha256Hex("hello\n")}.txt`]);
		for (const bad of ["../journal.jsonl", "outputs/../lock", `outputs/${"A".repeat(64)}.txt`, `/outputs/${sha256Hex("x")}.txt`, `outputs/${sha256Hex("x")}.txt/..`]) {
			expect(() => outputs.read(bad), bad).toThrow(/invalid output ref/);
		}
	});
});
