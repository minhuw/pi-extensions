import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { killAllChecks, runCheck, runChecks, summarizeOutput } from "../../src/checks/runner.ts";
import { CHECK_ERROR_LINES, CHECK_TAIL_LINES } from "../../src/config.ts";
import type { CheckSpec, OutputStore } from "../../src/types.ts";

function tempOutputs(dir: string): OutputStore {
	return {
		put(content) {
			const ref = `outputs/${createHash("sha256").update(content).digest("hex")}.txt`;
			mkdirSync(join(dir, "outputs"), { recursive: true });
			writeFileSync(join(dir, ref), content);
			return ref;
		},
		read: (ref) => readFileSync(join(dir, ref), "utf8"),
	};
}

const alive = (pid: number) => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitFor = async (predicate: () => boolean, ms = 2_000) => {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (predicate()) return true;
	return predicate();
};
const spec = (command: string, timeoutMs = 5_000, id = "c"): CheckSpec => ({ id, command, timeoutMs, integrate: false });

let dir = "";
let outputs: OutputStore;
const options = () => ({ cwd: dir, commit: "abc123", outputs });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "herder-checks-")); outputs = tempOutputs(dir); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("runCheck", () => {
	it("passes on exit 0 and captures combined output in the check's cwd", async () => {
		const result = await runCheck(spec("echo out; echo err >&2; pwd"), options());
		expect(result).toMatchObject({ id: "c", commit: "abc123", exitCode: 0, timedOut: false, passed: true });
		expect(result.logRef).toMatch(/^outputs\/[0-9a-f]{64}\.txt$/);
		const log = outputs.read(result.logRef);
		expect(log).toContain("out\n");
		expect(log).toContain("err\n");
		expect(log).toContain(`${realpathSync(dir)}\n`);
		expect(result.tail).toBe(summarizeOutput(log));
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("fails on a non-zero exit and keeps the output", async () => {
		const result = await runCheck(spec("echo 'test failed: x'; exit 3"), options());
		expect(result).toMatchObject({ exitCode: 3, timedOut: false, passed: false, tail: "test failed: x" });
	});

	it("inherits the parent environment", async () => {
		process.env.HERDER_CHECK_TEST = "inherited";
		try {
			const result = await runCheck(spec('test "$HERDER_CHECK_TEST" = inherited'), options());
			expect(result.passed).toBe(true);
		} finally {
			delete process.env.HERDER_CHECK_TEST;
		}
	});

	it("does not wait on stdin", async () => {
		const result = await runCheck(spec("cat; echo done", 2_000), options());
		expect(result).toMatchObject({ passed: true, tail: "done" });
	});

	it("times out, reports exitCode null, and keeps output written before the timeout", async () => {
		const started = performance.now();
		const result = await runCheck(spec("echo starting; sleep 30", 300), options());
		expect(result).toMatchObject({ exitCode: null, timedOut: true, passed: false, tail: "starting" });
		expect(result.durationMs).toBeGreaterThanOrEqual(250);
		expect(performance.now() - started).toBeLessThan(3_000);
	});

	it("kills a long-running child of a timed-out check, even one ignoring SIGTERM", async () => {
		const pidFile = join(dir, "child.pid");
		const result = await runCheck(spec(`sh -c 'trap "" TERM; sleep 30' & echo $! > "${pidFile}"; wait`, 300), options());
		expect(result.timedOut).toBe(true);
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(pid).toBeGreaterThan(0);
		expect(await waitFor(() => !alive(pid))).toBe(true);
	});

	it("does not hang on a background child holding the pipes after the check exits, and kills it", async () => {
		const pidFile = join(dir, "child.pid");
		const started = performance.now();
		const result = await runCheck(spec(`sleep 30 & echo $! > "${pidFile}"; echo leader done`, 10_000), options());
		expect(performance.now() - started).toBeLessThan(3_000);
		expect(result).toMatchObject({ exitCode: 0, timedOut: false, passed: true, tail: "leader done" });
		expect(await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
	});

	it("kills detached-output background children after the check exits", async () => {
		const pidFile = join(dir, "child.pid");
		const result = await runCheck(spec(`sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile}"`), options());
		expect(result.passed).toBe(true);
		expect(await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
	});

	it("rejects with the abort reason and kills the process group when aborted", async () => {
		const pidFile = join(dir, "child.pid");
		const controller = new AbortController();
		const pending = runCheck(spec(`sleep 30 & echo $! > "${pidFile}"; wait`, 10_000), { ...options(), signal: controller.signal });
		expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")).toBe(true);
		const reason = new Error("stopped");
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
		await expect(runCheck(spec("true"), { ...options(), signal: controller.signal })).rejects.toBe(reason);
	});

	it("reports a missing working directory as a failed check", async () => {
		const missing = join(dir, "missing");
		const result = await runCheck(spec("true"), { ...options(), cwd: missing });
		expect(result).toMatchObject({ exitCode: null, timedOut: false, passed: false });
		expect(outputs.read(result.logRef)).toBe(`check directory ${missing} does not exist\n`);
	});

	it("does not report a timeout that fires while waiting for pipes after a normal exit", async () => {
		const pidFile = join(dir, "child.pid");
		const result = await runCheck(spec(`sleep 30 & echo $! > "${pidFile}"; echo leader done`, 100), options());
		expect(result).toMatchObject({ exitCode: 0, timedOut: false, passed: true, tail: "leader done" });
		expect(await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
	});

	it("caps captured output, keeping the head and the rolling tail with an omission marker", async () => {
		const command = `printf 'HEAD error\\n'; i=0; while [ $i -lt 2000 ]; do echo "line $i"; i=$((i+1)); done; printf 'last line\\n'`;
		const result = await runCheck(spec(command), { ...options(), outputLimits: { headBytes: 64, tailBytes: 256 } });
		expect(result.passed).toBe(true);
		const log = outputs.read(result.logRef);
		expect(log.startsWith("HEAD error\n")).toBe(true);
		expect(log.endsWith("line 1999\nlast line\n")).toBe(true);
		const omitted = /\n… (\d+) bytes omitted …\n/.exec(log);
		expect(omitted).not.toBeNull();
		const total = "HEAD error\n".length + Array.from({ length: 2000 }, (_, i) => `line ${i}\n`.length).reduce((a, b) => a + b, 0) + "last line\n".length;
		expect(Number(omitted?.[1])).toBe(total - 64 - 256);
		expect(log.length).toBe(64 + 256 + omitted![0].length);
		expect(result.tail).toBe(summarizeOutput(log));
		expect(result.tail.split("\n")).toContain("HEAD error");
	});

	it("killAllChecks kills running check groups and the pending check settles", async () => {
		const pidFile = join(dir, "child.pid");
		const pending = runCheck(spec(`sleep 30 & echo $! > "${pidFile}"; wait`, 30_000), options());
		expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "")).toBe(true);
		killAllChecks();
		const result = await pending;
		expect(result).toMatchObject({ exitCode: null, timedOut: false, passed: false });
		expect(await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
	});

	it("kills running checks when the host process exits", async () => {
		const pidFile = join(dir, "child.pid");
		const runner = resolve(import.meta.dirname, "../../src/checks/runner.ts");
		const script = `
			import { existsSync, readFileSync } from "node:fs";
			const { runCheck } = await import(${JSON.stringify(runner)});
			runCheck({ id: "c", command: ${JSON.stringify(`sleep 30 & echo $! > "${pidFile}"; wait`)}, timeoutMs: 30000, integrate: false },
				{ cwd: ${JSON.stringify(dir)}, commit: "x", outputs: { put: () => "r", read: () => "" } });
			const poll = () => existsSync(${JSON.stringify(pidFile)}) && readFileSync(${JSON.stringify(pidFile)}, "utf8").trim() ? process.exit(0) : setTimeout(poll, 20);
			poll();`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
		expect(child.stderr).toBe("");
		expect(child.status).toBe(0);
		expect(await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))))).toBe(true);
	});

	it("stores logs content-addressed: identical output yields the identical ref and file", async () => {
		const a = await runCheck(spec("printf 'same\\n'"), options());
		const b = await runCheck(spec("printf 'same\\n'; exit 1", 5_000, "other"), options());
		const c = await runCheck(spec("printf 'different\\n'"), options());
		expect(a.logRef).toBe(b.logRef);
		expect(c.logRef).not.toBe(a.logRef);
		expect(a.logRef).toBe(`outputs/${createHash("sha256").update("same\n").digest("hex")}.txt`);
		expect(readdirSync(join(dir, "outputs")).sort()).toEqual([a.logRef, c.logRef].map((ref) => ref.slice("outputs/".length)).sort());
	});
});

describe("runChecks", () => {
	it("runs every check in order without short-circuiting", async () => {
		const order = join(dir, "order");
		const results = await runChecks([
			spec(`echo a >> "${order}"; exit 1`, 5_000, "a"),
			spec(`echo b >> "${order}"`, 5_000, "b"),
			spec(`echo c >> "${order}"; sleep 30`, 200, "c"),
			spec(`echo d >> "${order}"`, 5_000, "d"),
		], options());
		expect(results.map((r) => [r.id, r.passed, r.timedOut])).toEqual([["a", false, false], ["b", true, false], ["c", false, true], ["d", true, false]]);
		expect(readFileSync(order, "utf8")).toBe("a\nb\nc\nd\n");
	});
});

describe("summarizeOutput", () => {
	const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i));

	it("returns short output unchanged, without a trailing newline", () => {
		expect(summarizeOutput("")).toBe("");
		expect(summarizeOutput("a\nb\n")).toBe("a\nb");
		expect(summarizeOutput("a\r\nb\r\n")).toBe("a\nb");
		expect(summarizeOutput("\n\nx")).toBe("\n\nx");
	});

	it("keeps the last 40 lines and marks the omission", () => {
		const all = lines(100);
		expect(summarizeOutput(`${all.join("\n")}\n`)).toBe(["… 60 lines omitted", ...all.slice(60)].join("\n"));
		expect(summarizeOutput(lines(41).join("\n"))).toBe(["… 1 line omitted", ...lines(41).slice(1)].join("\n"));
		expect(summarizeOutput(lines(CHECK_TAIL_LINES).join("\n"))).toBe(lines(CHECK_TAIL_LINES).join("\n"));
	});

	it("keeps earlier error lines in order, at most 20, without duplicating the tail", () => {
		const all = lines(200, (i) => (i === 5 ? "Error: first" : i === 7 ? "build FAILED" : i === 190 ? "error in tail" : `line ${i}`));
		expect(summarizeOutput(all.join("\r\n"))).toBe(["… 5 lines omitted", "Error: first", "… 1 line omitted", "build FAILED", "… 152 lines omitted", ...all.slice(160)].join("\n"));

		const many = lines(100, (i) => (i < 60 ? `error ${i}` : `ok ${i}`));
		const summary = summarizeOutput(many.join("\n")).split("\n");
		expect(summary).toEqual([...many.slice(0, CHECK_ERROR_LINES), "… 40 lines omitted", ...many.slice(60)]);
	});

	it("is deterministic and handles very long output", () => {
		const big = `${lines(500_000, (i) => (i % 50_000 === 0 ? `fail ${i}` : `x ${i}`)).join("\n")}\n`;
		const started = performance.now();
		const summary = summarizeOutput(big);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(summary).toBe(summarizeOutput(big));
		const kept = summary.split("\n");
		expect(kept.filter((l) => l.startsWith("fail"))).toEqual(lines(10, (i) => `fail ${i * 50_000}`));
		expect(kept.slice(-CHECK_TAIL_LINES)).toEqual(lines(500_000).slice(-CHECK_TAIL_LINES).map((l) => l.replace("line", "x")));
	});

	it("clips very long lines", () => {
		const summary = summarizeOutput(`${"y".repeat(100_000)}\nend`);
		expect(summary.length).toBeLessThan(2_100);
		expect(summary.endsWith("\nend")).toBe(true);
	});
});
