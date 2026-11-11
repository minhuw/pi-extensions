import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedState } from "../../src/state.ts";
import { registerTools, resolveProcessCwd } from "../../src/tools.ts";
import { createCtx, createPi, FakeManager, info, resetShared } from "./fakes.ts";

let project: string;
let outside: string;

beforeEach(() => {
	resetShared();
	// Under the repository's git-ignored .pi/workspaces, not the system temp dir, so "outside" escapes both roots.
	const root = join(process.cwd(), ".pi", "workspaces");
	mkdirSync(root, { recursive: true });
	project = mkdtempSync(join(root, "processes-test-"));
	mkdirSync(join(project, "app"));
	outside = mkdtempSync(join(root, "processes-outside-"));
});
afterEach(() => {
	rmSync(project, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

function setup() {
	const pi = createPi();
	const manager = new FakeManager();
	registerTools(pi.api, () => manager);
	const ctx = createCtx("session-a", { cwd: project });
	const run = (name: string, params: unknown) => pi.tools.get(name)!.execute("call", params, undefined, undefined, ctx);
	return { pi, manager, ctx, run };
}

describe("resolveProcessCwd", () => {
	it("accepts the session dir, its subdirectories, and the temp dir", () => {
		expect(resolveProcessCwd(project, undefined)).toBe(realpathSync(project));
		expect(resolveProcessCwd(project, "app")).toBe(realpathSync(join(project, "app")));
		expect(resolveProcessCwd(project, "@app")).toBe(realpathSync(join(project, "app")));
		expect(resolveProcessCwd(project, tmpdir())).toBe(realpathSync(tmpdir()));
	});

	it("rejects missing directories and escapes, symlinked ones included", () => {
		expect(() => resolveProcessCwd(project, "missing")).toThrow(/does not exist/);
		expect(() => resolveProcessCwd(project, outside)).toThrow(/outside/);
		expect(() => resolveProcessCwd(project, "../")).toThrow(/outside/);
		symlinkSync(outside, join(project, "link"));
		expect(() => resolveProcessCwd(project, "link")).toThrow(/outside/);
	});
});

describe("process_start", () => {
	it("passes the owner, the resolved cwd, and service readiness", async () => {
		const { manager, run } = setup();
		const result = await run("process_start", { command: "npm run dev", cwd: "app", ready: { port: 5173 }, errorPattern: "ERROR" });
		expect(manager.starts).toEqual([
			{ command: "npm run dev", cwd: realpathSync(join(project, "app")), owner: "session-a", errorPattern: "ERROR", ready: { port: 5173 } },
		]);
		expect(result.content[0].text).toContain("Started dev.");
		expect(result.content[0].text).toContain("Log: /logs/p_1.log");
		expect(result.content[0].text).toContain("Do not sleep or poll");
	});

	it('starts kind "task" with readiness disabled and rejects ready for it', async () => {
		const { manager, run } = setup();
		await run("process_start", { command: "npm run build", name: "build", kind: "task" });
		expect(manager.starts[0]).toMatchObject({ name: "build", ready: false });
		await expect(run("process_start", { command: "x", kind: "task", ready: { port: 1 } })).rejects.toThrow(/only to kind "service"/);
	});

	it("leaves readiness to the manager's default when omitted", async () => {
		const { manager, run } = setup();
		await run("process_start", { command: "vite" });
		expect(manager.starts[0]).not.toHaveProperty("ready");
	});

	it("says when it reused a live process", async () => {
		const { manager, run } = setup();
		manager.reused = true;
		const result = await run("process_start", { command: "npm run dev" });
		expect(result.content[0].text).toContain("dev was already running; reused it.");
	});

	it("throws on a cwd outside the session dir", async () => {
		const { manager, run } = setup();
		await expect(run("process_start", { command: "x", cwd: outside })).rejects.toThrow(/outside/);
		expect(manager.starts).toEqual([]);
	});
});

describe("other tools", () => {
	it("lists processes as a table", async () => {
		const { manager, run } = setup();
		manager.processes = [info({ status: "exited", exitCode: 1, endedAt: 35_000, urls: ["http://127.0.0.1:5173"] })];
		const text = (await run("process_list", {})).content[0].text;
		expect(text).toMatch(/^NAME\s+ID\s+STATUS\s+PID\s+UPTIME\s+URLS\s+EXIT/);
		expect(text).toMatch(/dev\s+p_1\s+exited\s+4242\s+34s\s+http:\/\/127\.0\.0\.1:5173\s+code 1/);
		manager.processes = [];
		expect((await run("process_list", {})).content[0].text).toBe("No processes.");
	});

	it("reads logs with the cursor and paging notes", async () => {
		const { run } = setup();
		const text = (await run("process_logs", { name: "dev", cursor: 0 })).content[0].text;
		expect(text).toBe("one\ntwo\n\nnextCursor: 8\nMore output follows; read again with nextCursor.");
	});

	it("marks agent stops and restarts as requested while they run", async () => {
		const { manager, run } = setup();
		manager.processes = [info()];
		const seen: unknown[] = [];
		manager.subscribe(() => seen.push(sharedState().requested.get("p_1")));
		await run("process_stop", { name: "dev" });
		await run("process_restart", { name: "dev" });
		expect(seen).toEqual([{ by: "agent", session: "session-a" }, { by: "agent", session: "session-a" }]);
		expect(sharedState().requested.size).toBe(0);
	});

	it("registers waits for the calling session", async () => {
		const { manager, run } = setup();
		manager.processes = [info()];
		const result = await run("process_wait", { name: "dev", until: "match", pattern: "compiled", timeoutSeconds: 30 });
		expect(manager.waits).toEqual([{ idOrName: "p_1", options: { until: "match", pattern: "compiled", timeoutSeconds: 30 } }]);
		expect(sharedState().waits.get("w_1")).toBe("session-a");
		expect(result.content[0].text).toContain("end your turn");
		await expect(run("process_wait", { name: "dev", until: "match" })).rejects.toThrow(/requires pattern/);
		await expect(run("process_wait", { name: "nope", until: "exit" })).rejects.toThrow(/Unknown process/);
	});
});
