import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentBrowser } from "../index.ts";

// How long the fake binary's background descendant keeps stdout and stderr open.
const DESCENDANT_LIFETIME_S = 5;
// Generous under load, yet far below the descendant's lifetime.
const SETTLE_BOUND_MS = 2500;
const TEST_TIMEOUT_MS = 15_000;

let sandboxRoot: string;
let fakeBinPath: string;
let pidFilePath: string;
let readyFilePath: string;

// Records the descendant's PID, then its own, in $SETTLE_PID_FILE. `hang` execs, so
// the direct child keeps its PID and leaves only the background descendant behind;
// it creates $SETTLE_PID_FILE.ready once its output is written.
async function createFakeAgentBrowserBinary(binPath: string): Promise<void> {
	const script = `#!/bin/sh
if [ "$1" = "warmup" ]; then
	exit 0
fi
sleep ${DESCENDANT_LIFETIME_S} &
echo $! > "$SETTLE_PID_FILE"
echo $$ >> "$SETTLE_PID_FILE"
echo "stdout before exit"
echo "stderr before exit" >&2
if [ "$1" = "hang" ]; then
	: > "$SETTLE_PID_FILE.ready"
	exec sleep 10
fi
exit 0
`;
	await writeFile(binPath, script, "utf8");
	await chmod(binPath, 0o755);
	// The first exec of a freshly written script can take hundreds of milliseconds on
	// macOS; pay that here so it does not eat into the timeouts under test.
	execFileSync(binPath, ["warmup"]);
}

async function readPids(): Promise<number[]> {
	if (!fs.existsSync(pidFilePath)) return [];
	const content = await readFile(pidFilePath, "utf8");
	return content
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => Number(line));
}

async function waitUntilReady(): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!fs.existsSync(readyFilePath)) {
		if (performance.now() > deadline) throw new Error("fake agent-browser never became ready");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function run(argv: string[], extra: { timeoutMs?: number; signal?: AbortSignal } = {}) {
	return runAgentBrowser({
		argv,
		binary: fakeBinPath,
		cwd: sandboxRoot,
		session: "pi-settle-test",
		env: { SETTLE_PID_FILE: pidFilePath },
		...extra,
	});
}

beforeEach(async () => {
	sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "pi-agent-browser-settle-"));
	fakeBinPath = path.join(sandboxRoot, "fake-agent-browser");
	pidFilePath = path.join(sandboxRoot, "pids");
	readyFilePath = `${pidFilePath}.ready`;
	await createFakeAgentBrowserBinary(fakeBinPath);
});

afterEach(async () => {
	for (const pid of await readPids()) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already exited.
		}
	}
	await rm(sandboxRoot, { recursive: true, force: true });
});

describe("agent_browser settles while a descendant holds stdout and stderr open", () => {
	it("reports the real exit code and output after a normal exit without waiting for the descendant", async () => {
		const startedAt = performance.now();
		const res = await run(["open", "https://example.com"]);
		const elapsedMs = performance.now() - startedAt;

		expect(elapsedMs).toBeLessThan(SETTLE_BOUND_MS);
		expect(res.ok).toBe(true);
		expect(res.status).toBe("success");
		expect(res.exitCode).toBe(0);
		expect(res.signal).toBeNull();
		expect(res.stdout).toBe("stdout before exit\n");
		expect(res.stderr).toBe("stderr before exit\n");

		// The descendant outlives the call: only the direct child is ever signalled.
		const [descendantPid] = await readPids();
		expect(descendantPid).toBeGreaterThan(0);
		expect(isAlive(descendantPid!)).toBe(true);
	}, TEST_TIMEOUT_MS);

	it("settles as a timeout shortly after the timeout", async () => {
		const startedAt = performance.now();
		const res = await run(["hang"], { timeoutMs: 1000 });
		const elapsedMs = performance.now() - startedAt;

		expect(elapsedMs).toBeLessThan(SETTLE_BOUND_MS);
		expect(res.ok).toBe(false);
		expect(res.status).toBe("timeout");
		expect(res.message).toBe("agent-browser timed out after 1000 ms.");
		expect(res.exitCode).toBeNull();
		expect(res.signal).toBe("SIGTERM");
		expect(res.stdout).toBe("stdout before exit\n");

		const [descendantPid, childPid] = await readPids();
		expect(isAlive(descendantPid!)).toBe(true);
		expect(isAlive(childPid!)).toBe(false);
	}, TEST_TIMEOUT_MS);

	it("settles as cancelled shortly after an abort", async () => {
		const controller = new AbortController();
		const pending = run(["hang"], { signal: controller.signal });
		await waitUntilReady();

		const abortedAt = performance.now();
		controller.abort();
		const res = await pending;
		const elapsedMs = performance.now() - abortedAt;

		expect(elapsedMs).toBeLessThan(SETTLE_BOUND_MS);
		expect(res.ok).toBe(false);
		expect(res.status).toBe("cancelled");
		expect(res.message).toBe("agent-browser invocation was cancelled.");
		expect(res.exitCode).toBeNull();
		expect(res.signal).toBe("SIGTERM");
		expect(res.stdout).toBe("stdout before exit\n");

		const [descendantPid, childPid] = await readPids();
		expect(isAlive(descendantPid!)).toBe(true);
		expect(isAlive(childPid!)).toBe(false);
	}, TEST_TIMEOUT_MS);
});
