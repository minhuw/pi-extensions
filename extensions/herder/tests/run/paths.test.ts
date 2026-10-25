import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stepKey } from "../../src/journal/keys.ts";
import { baseRef, herderRoot, integrationRef, isRunId, newRunId, refPrefix, runPaths, stepRef, worktreePath } from "../../src/run/paths.ts";

const common = "/repo/.git";
const runId = "20260102-030405-0a1b";

describe("paths", () => {
	it("generates UTC run ids", () => {
		const id = newRunId(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
		expect(id).toMatch(/^20260102-030405-[0-9a-f]{4}$/);
		expect(isRunId(id)).toBe(true);
		expect(isRunId(newRunId())).toBe(true);
		for (const bad of ["", "20260102-030405-0A1B", "20260102-030405-0a1", "../20260102-030405-0a1b", "20260102-030405-0a1b/x"]) expect(isRunId(bad), bad).toBe(false);
	});

	it("lays out the run under <common>/herder", () => {
		expect(herderRoot(common)).toBe("/repo/.git/herder");
		const dir = "/repo/.git/herder/runs/20260102-030405-0a1b";
		expect(runPaths(common, runId)).toEqual({
			root: "/repo/.git/herder", dir,
			goal: join(dir, "goal.md"), plan: join(dir, "plan.md"), progress: join(dir, "progress.md"), notes: join(dir, "notes.md"),
			scripts: join(dir, "scripts"), journal: join(dir, "journal.jsonl"), outputs: join(dir, "outputs"), lock: join(dir, "lock"),
			worktrees: "/repo/.git/herder/worktrees/20260102-030405-0a1b",
		});
		expect(worktreePath(common, runId, "integration")).toBe("/repo/.git/herder/worktrees/20260102-030405-0a1b/integration");
		expect(worktreePath(common, runId, stepKey("../x", 0))).toMatch(/^\/repo\/\.git\/herder\/worktrees\/20260102-030405-0a1b\/[^/]+$/);
	});

	it("names refs under refs/herder/<runId>", () => {
		expect(refPrefix(runId)).toBe("refs/herder/20260102-030405-0a1b");
		expect(baseRef(runId)).toBe("refs/herder/20260102-030405-0a1b/base");
		expect(integrationRef(runId)).toBe("refs/herder/20260102-030405-0a1b/integration");
		expect(stepRef(runId, "abc-0")).toBe("refs/herder/20260102-030405-0a1b/steps/abc-0");
	});

	it("rejects unsafe run ids, slots, and keys", () => {
		expect(() => runPaths(common, "../x")).toThrow(/invalid run id/);
		expect(() => refPrefix("x")).toThrow(/invalid run id/);
		for (const slot of ["..", "../x", "a/b", ".git", "-x", "", "a..b"]) expect(() => worktreePath(common, runId, slot), slot).toThrow(/invalid worktree slot/);
		for (const key of ["../a-0", "a/b-0", "a", "a.lock", "a@{1}-0", ".a-0"]) expect(() => stepRef(runId, key), key).toThrow(/invalid step key/);
	});
});
