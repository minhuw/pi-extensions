import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config.ts";
import { AgentError } from "../src/types.ts";
import { FakeRunner, fakeRole } from "./support/fake-runner.ts";
import { createGitFixture, withGitFixture } from "./support/git-fixture.ts";

const request = (cwd: string, prompt: string, extra: Partial<Parameters<FakeRunner["run"]>[0]> = {}) =>
	({ role: fakeRole(), prompt, cwd, signal: new AbortController().signal, timeoutMs: 1_000, stallMs: 50, ...extra });

describe("Herder scaffold", () => {
	it("pins the §7 limits", () => {
		expect(LIMITS).toMatchObject({ concurrentWriters: 4, agentsPerLaunch: 100, agentsPerRun: 400, itemsPerCall: 1024, retryBackoffMs: [30_000, 120_000, 480_000], stallRestarts: 2 });
		expect(LIMITS.concurrentAgents).toBeGreaterThanOrEqual(1);
		expect(LIMITS.concurrentAgents).toBeLessThanOrEqual(6);
	});

	it("creates and removes a real repository fixture", async () => {
		let dir = "";
		await withGitFixture((fixture) => {
			dir = fixture.dir;
			expect(existsSync(join(fixture.commonDir, "HEAD"))).toBe(true);
			const first = fixture.head();
			expect(fixture.commit("second", { "src/a.txt": "a\n" })).not.toBe(first);
			expect(fixture.read("src/a.txt")).toBe("a\n");
			expect(fixture.status()).toBe("");
		});
		expect(existsSync(dir)).toBe(false);
	});

	it("scripts edits, structured data, failures, and stalls", async () => {
		const fixture = createGitFixture();
		try {
			const runner = new FakeRunner([
				{ match: "implement", files: { "out.txt": "done\n" }, text: "implemented", times: 1 },
				{ match: "implement", fail: "rate_limit" },
				{ match: /^review/, role: "reviewer", data: (req) => ({ ok: req.cwd === fixture.dir }) },
				{ match: "slow", stall: true },
			]);
			await expect(runner.run(request(fixture.dir, "implement it"))).resolves.toEqual({ text: "implemented" });
			expect(fixture.read("out.txt")).toBe("done\n");
			await expect(runner.run(request(fixture.dir, "implement again"))).rejects.toMatchObject({ errorClass: "rate_limit" });
			await expect(runner.run(request(fixture.dir, "review", { role: fakeRole("reviewer") }))).resolves.toMatchObject({ data: { ok: true } });
			const stalled = runner.run(request(fixture.dir, "slow"));
			await expect(stalled).rejects.toBeInstanceOf(AgentError);
			await expect(stalled).rejects.toMatchObject({ errorClass: "stall" });
			await expect(runner.run(request(fixture.dir, "unknown"))).rejects.toMatchObject({ errorClass: "fatal" });
			expect(runner.calls.map((call) => call.rule)).toEqual([0, 1, 2, 3, -1]);
		} finally {
			fixture.cleanup();
		}
	});
});
