import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { CHECK_ERROR_LINES, CHECK_TAIL_LINES } from "../config.ts";
import type { CheckResult, CheckSpec, OutputStore } from "../types.ts";

/** Captured output keeps the first `headBytes` and the last `tailBytes`; the middle is replaced by a marker. */
export interface OutputLimits { headBytes: number; tailBytes: number }
export const CHECK_OUTPUT_LIMITS: Readonly<OutputLimits> = Object.freeze({ headBytes: 1024 * 1024, tailBytes: 8 * 1024 * 1024 });

export interface CheckRunOptions { cwd: string; commit: string; outputs: OutputStore; signal?: AbortSignal; outputLimits?: OutputLimits }

/** SIGTERM → SIGKILL grace on timeout or abort. */
const KILL_GRACE_MS = 1_000;
/** How long pipes may stay open after the check's shell exits (a background child holding them). */
const PIPE_GRACE_MS = 200;
/** Summary lines longer than this are clipped; the full log keeps them. */
const SUMMARY_LINE_CHARS = 1_000;
const ERROR_LINE = /error|fail/i;

/** Process groups of running checks; detached groups would otherwise outlive Pi. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

/** SIGKILLs every running check's process group; each pending `runCheck` then settles as a failed check. */
export function killAllChecks(): void {
	for (const pgid of liveGroups) {
		try { process.kill(-pgid, "SIGKILL"); } catch {}
	}
}

class OutputCapture {
	private head: Buffer[] = [];
	private headLength = 0;
	private tail: Buffer[] = [];
	private tailLength = 0;
	private omitted = 0;
	private readonly limits: OutputLimits;
	constructor(limits: OutputLimits) { this.limits = limits; }

	push(chunk: Buffer): void {
		const room = this.limits.headBytes - this.headLength;
		if (room > 0) {
			const taken = chunk.subarray(0, room);
			this.head.push(taken);
			this.headLength += taken.length;
			chunk = chunk.subarray(taken.length);
		}
		if (!chunk.length) return;
		this.tail.push(chunk);
		this.tailLength += chunk.length;
		while (this.tailLength > this.limits.tailBytes) {
			const first = this.tail[0]!, excess = this.tailLength - this.limits.tailBytes;
			const dropped = Math.min(first.length, excess);
			if (dropped === first.length) this.tail.shift();
			else this.tail[0] = Buffer.from(first.subarray(dropped));  // copy so the dropped bytes can be freed
			this.tailLength -= dropped;
			this.omitted += dropped;
		}
	}

	toBuffer(): Buffer {
		const marker = this.omitted ? [Buffer.from(`\n… ${this.omitted} bytes omitted …\n`)] : [];
		return Buffer.concat([...this.head, ...marker, ...this.tail]);
	}
}

type Outcome = { exitCode: number | null; timedOut: boolean; aborted: boolean };

/**
 * Runs `spec.command` with `/bin/sh -c` in its own process group and kills the whole group when the check ends,
 * times out, or `signal` aborts, so no process outlives the check. The combined log, capped by `outputLimits`, goes to `outputs`.
 * An abort is not a check outcome: it rejects with `signal.reason` instead of returning a result.
 */
export async function runCheck(spec: CheckSpec, options: CheckRunOptions): Promise<CheckResult> {
	const { signal } = options;
	signal?.throwIfAborted();
	const started = performance.now();
	const output = new OutputCapture(options.outputLimits ?? CHECK_OUTPUT_LIMITS);
	let outcome: Outcome = { exitCode: null, timedOut: false, aborted: false };
	if (existsSync(options.cwd)) outcome = await execute(spec, options, output);
	else output.push(Buffer.from(`check directory ${options.cwd} does not exist\n`));
	if (outcome.aborted) throw signal?.reason;
	const log = output.toBuffer();
	const { exitCode, timedOut } = outcome;
	return {
		id: spec.id, commit: options.commit, exitCode, timedOut,
		durationMs: Math.round(performance.now() - started),
		tail: summarizeOutput(log.toString("utf8")),
		logRef: options.outputs.put(log),
		passed: exitCode === 0 && !timedOut,
	};
}

function execute(spec: CheckSpec, { cwd, signal }: CheckRunOptions, output: OutputCapture): Promise<Outcome> {
	return new Promise((resolve) => {
		const child = spawn("/bin/sh", ["-c", spec.command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let exitCode: number | null = null, timedOut = false, aborted = false, exited = false, done = false;
		let killTimer: NodeJS.Timeout | undefined, pipeTimer: NodeJS.Timeout | undefined;
		const pgid = child.pid;
		if (pgid !== undefined) {
			liveGroups.add(pgid);
			if (!exitHookInstalled) { exitHookInstalled = true; process.on("exit", killAllChecks); }
		}
		const killGroup = (sig: NodeJS.Signals) => {
			if (pgid === undefined) return;
			try { process.kill(-pgid, sig); } catch {}  // ESRCH: the group is already gone
		};
		const stop = () => {
			killGroup("SIGTERM");
			killTimer ??= setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
		};
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer); clearTimeout(killTimer); clearTimeout(pipeTimer);
			signal?.removeEventListener("abort", onAbort);
			killGroup("SIGKILL");  // background children that outlived the shell
			if (pgid !== undefined) liveGroups.delete(pgid);
			child.stdout.destroy(); child.stderr.destroy();
			resolve({ exitCode: timedOut || aborted ? null : exitCode, timedOut, aborted });
		};
		const onAbort = () => { aborted = true; stop(); };
		const timer = setTimeout(() => { timedOut = true; stop(); }, Math.min(Math.max(spec.timeoutMs, 0), 2 ** 31 - 1));
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
		child.on("error", (error) => {
			output.push(Buffer.from(`${error.message}\n`));
			exitCode = null;
			finish();
		});
		child.on("exit", (code) => {
			exited = true;
			exitCode = code;
			clearTimeout(timer);  // a timeout during the pipe grace period is not a timeout of the check
			pipeTimer = setTimeout(finish, PIPE_GRACE_MS);
		});
		child.on("close", () => { if (exited) finish(); });
	});
}

/** Runs every check in order (no short-circuit). Rejects on abort like `runCheck`. */
export async function runChecks(specs: readonly CheckSpec[], options: CheckRunOptions): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const spec of specs) results.push(await runCheck(spec, options));
	return results;
}

/**
 * The last 40 lines plus up to the first 20 earlier lines matching /error|fail/i, in original order, with each
 * skipped stretch marked (§10). Scans with indexOf so huge logs are never split into one array.
 */
export function summarizeOutput(output: string): string {
	const text = output.endsWith("\n") ? output.slice(0, -1) : output;
	if (!text) return "";
	let tailStart = 0;
	for (let n = 0, pos = text.length; n < CHECK_TAIL_LINES; n++) {
		const nl = pos > 0 ? text.lastIndexOf("\n", pos - 1) : -1;
		tailStart = nl + 1;
		if (nl < 0) break;
		pos = nl;
	}
	const kept: string[] = [];
	let gap = 0, matches = 0;
	const omit = () => {
		if (gap) kept.push(`… ${gap} line${gap === 1 ? "" : "s"} omitted`);
		gap = 0;
	};
	// The head is everything before the newline that precedes the tail.
	for (let i = 0; i < tailStart; ) {
		let end = text.indexOf("\n", i);
		if (end < 0 || end >= tailStart) end = tailStart - 1;
		if (matches < CHECK_ERROR_LINES) {
			const line = text.slice(i, end);
			if (ERROR_LINE.test(line)) { omit(); kept.push(clean(line)); matches++; } else gap++;
		} else gap++;
		i = end + 1;
	}
	omit();
	for (const line of text.slice(tailStart).split("\n")) kept.push(clean(line));
	return kept.join("\n");
}

function clean(line: string): string {
	if (line.endsWith("\r")) line = line.slice(0, -1);
	return line.length > SUMMARY_LINE_CHARS ? `${line.slice(0, SUMMARY_LINE_CHARS)}…` : line;
}
