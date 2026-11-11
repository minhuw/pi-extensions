import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { describeStep } from "../../src/adapter/format.ts";
import { cleanupRun } from "../../src/deliver/deliver.ts";
import { stepRef, worktreePath } from "../../src/run/paths.ts";
import { healRunWorktrees, releaseRunPoolWorktrees } from "../../src/steps/worktrees.ts";
import type { StepFailedEvent } from "../../src/types.ts";
import { withRun, type Harness } from "./harness.ts";

const failures = (h: Harness) => h.events().filter((event): event is StepFailedEvent => event.t === "step.failed");
const slot = (h: Harness, name: string) => worktreePath(h.vcs.commonDir(), h.store.runId, name);

describe("a write step whose work is not captured in a step ref", () => {
	it("keeps the slot's edits when snapshot throws, says so, and hands later writers another slot", () => withRun(async (h) => {
		h.runner.add({ match: "first", files: { "work.txt": "precious\n" } }, { match: "second", files: { "two.txt": "2\n" } });
		const rw0 = slot(h, "rw-0");
		const failing = h.executor({ vcs: { ...h.vcs, snapshot() { throw new Error("index.lock exists"); } } });
		const result = await failing.run("first", { id: "first" });
		expect(result).toMatchObject({ status: "failed", error: { class: "fatal" } });
		expect(result.error!.message).toBe(`index.lock exists; work kept at ${rw0} (slot quarantined)`);
		expect(readFileSync(join(rw0, "work.txt"), "utf8")).toBe("precious\n");
		expect(h.runner.calls).toHaveLength(1);
		expect(failures(h)).toMatchObject([{ errorClass: "fatal", final: true, message: result.error!.message }]);
		expect(describeStep(result)).toContain(`work kept at ${rw0}`);

		const next = await h.executor().run("second", { id: "second" });
		expect(next.status).toBe("ok");
		expect(h.runner.calls[1]!.cwd).toBe(slot(h, "rw-1"));
		expect(readFileSync(join(rw0, "work.txt"), "utf8")).toBe("precious\n");
	}));

	it("keeps the slot and names the orphaned commit when updateRef throws after snapshot", () => withRun(async (h) => {
		h.runner.add({ match: "first", files: { "work.txt": "precious\n" } }, { match: "second", files: { "two.txt": "2\n" } });
		const rw0 = slot(h, "rw-0");
		const updateRef: typeof h.vcs.updateRef = (ref, value, old) => {
			if (ref.includes("/steps/")) throw new Error(`ref ${ref} moved`);
			h.vcs.updateRef(ref, value, old);
		};
		const result = await h.executor({ vcs: { ...h.vcs, updateRef } }).run("first", { id: "first" });
		expect(result.status).toBe("failed");
		const commit = h.vcs.worktreeHead(rw0);
		expect(commit).not.toBe(h.head);
		expect(h.fixture.git("show", `${commit}:work.txt`)).toBe("precious");
		expect(h.vcs.readRef(stepRef(h.store.runId, result.key))).toBeNull();
		expect(result.error!.message).toBe(`ref ${stepRef(h.store.runId, result.key)} moved; work kept at ${rw0}, commit ${commit} (slot quarantined)`);
		expect(failures(h)[0]!.message).toBe(result.error!.message);

		const next = await h.executor().run("second", { id: "second" });
		expect(next.status).toBe("ok");
		expect(h.runner.calls[1]!.cwd).toBe(slot(h, "rw-1"));
		expect(h.vcs.worktreeHead(rw0)).toBe(commit);
	}));

	it("keeps the slot when storing the reply throws before snapshot", () => withRun(async (h) => {
		h.runner.add({ match: "first", files: { "work.txt": "precious\n" } });
		const rw0 = slot(h, "rw-0");
		vi.spyOn(h.store.outputs, "put").mockImplementationOnce(() => { throw new Error("disk full"); });
		const result = await h.executor().run("first", { id: "first" });
		expect(result.error!.message).toBe(`disk full; work kept at ${rw0} (slot quarantined)`);
		expect(readFileSync(join(rw0, "work.txt"), "utf8")).toBe("precious\n");
	}));

	it("survives launch healing and session release, and goes with the run's worktrees", () => withRun(async (h) => {
		h.runner.add({ match: "first", files: { "work.txt": "precious\n" } }, { match: "second", files: { "two.txt": "2\n" } });
		const rw0 = slot(h, "rw-0");
		await h.executor({ vcs: { ...h.vcs, snapshot() { throw new Error("boom"); } } }).run("first", { id: "first" });
		healRunWorktrees(h.vcs, h.store.runId);
		expect(readFileSync(join(rw0, "work.txt"), "utf8")).toBe("precious\n");
		releaseRunPoolWorktrees(h.vcs, h.store.runId);
		expect(readFileSync(join(rw0, "work.txt"), "utf8")).toBe("precious\n");
		expect((await h.executor().run("second", { id: "second" })).status).toBe("ok");
		expect(h.runner.calls[1]!.cwd).toBe(slot(h, "rw-1"));

		cleanupRun(h.vcs, h.vcs.commonDir(), h.store.runId);
		expect(existsSync(h.store.paths.worktrees)).toBe(false);
		expect(h.fixture.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
	}));

	it("still resets the slot after an agent failure, so the retry starts from the base", () => withRun(async (h) => {
		h.runner.add({ match: "first", files: { "junk.txt": "partial" }, fail: "transient", times: 1 }, { match: "first", files: { "work.txt": "w\n" } });
		const result = await h.executor().run("first", { id: "first" });
		expect(result.status).toBe("ok");
		expect(h.runner.calls.map((call) => call.cwd)).toEqual([slot(h, "rw-0"), slot(h, "rw-0")]);
		expect(h.fixture.git("ls-tree", "--name-only", result.commit!)).not.toContain("junk.txt");
		h.assertClean();
	}));
});
