import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { groupAlive, signalGroup, spawnWatchdog, terminateGroup } from "./core/group.ts";
import { LogFile } from "./core/logfile.ts";
import { httpUp, pollUntil, tcpOpen } from "./core/probes.ts";
import { compilePattern, findLocalUrls, LineSplitter, urlPort } from "./core/text.ts";
import type {
	LogQuery,
	LogRead,
	ManagerOptions,
	ProcessEvent,
	ProcessInfo,
	ProcessManager,
	ProcessStatus,
	StartOptions,
	StopResult,
	WaitOptions,
} from "./types.ts";

const LIVE = new Set<ProcessStatus>(["starting", "running", "ready", "stopping"]);
const DEFAULT_MAX_LIVE = 16;
const DEFAULT_MAX_LOG_BYTES = 32 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ERROR_COOLDOWN_MS = 30_000;
const DEFAULT_GRACE_MS = 3000;
const DEFAULT_READY_TIMEOUT_SECONDS = 120;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 600;
/** start() waits this long so an immediate exit shows in its result. */
const START_SETTLE_MS = 150;
/** After the shell exits, descendants holding its pipes get this long before the run finishes anyway. */
const CLOSE_GRACE_MS = 2000;
/** After the shell exits on its own, what remains of its group is terminated after this pause. */
const LEFTOVER_PAUSE_MS = 100;
const LEFTOVER_GRACE_MS = 1000;
const MAX_URLS = 5;
const TAIL_LINES = 20;
const TAIL_BYTES = 4096;
const ERROR_BATCH = 10;

/** Start options compiled once and reused by restarts. */
interface Plan {
	disabled: boolean;
	pattern?: RegExp;
	port?: number;
	url?: string;
	timeoutMs: number;
	errorPattern?: RegExp;
}

/** State of one spawn; a restart replaces it. */
interface Run {
	child: ChildProcess;
	/** Readiness criteria not yet met: "pattern", "port", "url", or "auto-url". */
	pending: Set<string>;
	autoProbing: boolean;
	stopProbes: Array<() => void>;
	readyTimer?: NodeJS.Timeout;
	errorLines: string[];
	suppressed: number;
	errorMuted: boolean;
	errorTimer?: NodeJS.Timeout;
	exited: boolean;
	stopping?: Promise<StopResult>;
	finished: Promise<void>;
}

interface ProcessRecord {
	info: ProcessInfo;
	options: StartOptions;
	plan: Plan;
	log: LogFile;
	run?: Run;
	lastByte?: number;
}

interface Wait {
	id: string;
	record: ProcessRecord;
	options: WaitOptions;
	pattern?: RegExp;
	timer: NodeJS.Timeout;
}

export function createProcessManager(options: ManagerOptions): ProcessManager {
	if (process.platform === "win32") throw new Error("The process manager supports macOS and Linux only.");
	const maxLive = options.maxLive ?? DEFAULT_MAX_LIVE;
	const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
	const errorCooldownMs = options.errorCooldownMs ?? DEFAULT_ERROR_COOLDOWN_MS;
	fs.mkdirSync(options.stateDir, { recursive: true });
	sweep(options.stateDir, options.retentionMs ?? DEFAULT_RETENTION_MS);
	const runDir = path.join(options.stateDir, `${process.pid}-${Date.now()}`);
	fs.mkdirSync(runDir);
	fs.writeFileSync(path.join(runDir, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);

	const records = new Map<string, ProcessRecord>();
	const waits = new Map<string, Wait>();
	const listeners = new Set<(event: ProcessEvent) => void>();

	const emit = (event: ProcessEvent) => {
		for (const listener of [...listeners]) listener(event);
	};
	const snapshot = (record: ProcessRecord): ProcessInfo => ({ ...record.info, urls: [...record.info.urls] });
	const changed = (record: ProcessRecord) => emit({ type: "changed", process: snapshot(record) });
	const tail = (record: ProcessRecord) => record.log.read({ tail: TAIL_LINES, maxBytes: TAIL_BYTES }, true).lines;
	const live = () => [...records.values()].filter((record) => LIVE.has(record.info.status));
	const current = (record: ProcessRecord, run: Run) => record.run === run && !run.exited;

	function find(idOrName: string): ProcessRecord {
		const byId = records.get(idOrName);
		if (byId) return byId;
		const named = [...records.values()].filter((record) => record.info.name === idOrName);
		const found = named.find((record) => LIVE.has(record.info.status)) ?? named.at(-1);
		if (!found) throw new Error(`Unknown process "${idOrName}".`);
		return found;
	}

	function uniqueId(prefix: string, taken: (id: string) => boolean): string {
		for (;;) {
			const id = `${prefix}_${randomBytes(2).toString("hex")}`;
			if (!taken(id)) return id;
		}
	}

	function defaultName(command: string): string {
		const first = command.trim().split(/\s+/).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
		const slug = path.basename(first).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "process";
		const names = new Set([...records.values()].map((record) => record.info.name));
		let name = slug;
		for (let suffix = 2; names.has(name); suffix++) name = `${slug}-${suffix}`;
		return name;
	}

	function checkCapacity(): void {
		if (live().length >= maxLive) throw new Error(`Live process limit reached (${maxLive}); stop one first.`);
	}

	async function launch(record: ProcessRecord): Promise<void> {
		const { options: start, plan } = record;
		const child = spawn(options.shell.shell, [...options.shell.args, start.command], {
			cwd: start.cwd,
			env: { ...process.env, ...start.env },
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once("exit", (code, signal) => resolve([code, signal])));
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(new Error(`Failed to start "${start.command}" in ${start.cwd}: ${error.message}`));
			child.once("error", onError);
			child.once("spawn", () => {
				child.off("error", onError);
				resolve();
			});
		});
		const pid = child.pid;
		if (pid === undefined) throw new Error(`Spawned "${start.command}" without a pid.`);
		spawnWatchdog(process.pid, pid);

		const pending = new Set<string>();
		if (plan.pattern) pending.add("pattern");
		if (plan.port !== undefined) pending.add("port");
		if (plan.url !== undefined) pending.add("url");
		if (!plan.disabled && pending.size === 0) pending.add("auto-url");
		const run: Run = { child, pending, autoProbing: false, stopProbes: [], errorLines: [], suppressed: 0, errorMuted: false, exited: false, finished: Promise.resolve() };
		record.run = run;
		const { info } = record;
		info.pid = pid;
		info.status = plan.disabled ? "running" : "starting";
		info.startedAt = Date.now();
		info.urls = [];
		for (const key of ["readyAt", "endedAt", "exitCode", "signal"] as const) delete info[key];

		const splitters = [new LineSplitter(), new LineSplitter()];
		const output = (splitter: LineSplitter) => (chunk: Buffer) => {
			if (record.run !== run) return;
			record.log.append(chunk);
			record.lastByte = chunk.at(-1);
			record.info.logBytes = record.log.bytes;
			for (const line of splitter.push(chunk)) onLine(record, run, line);
			if (record.info.attached) record.options.onOutput?.(chunk);
		};
		child.stdout!.on("data", output(splitters[0]));
		child.stderr!.on("data", output(splitters[1]));

		if (!plan.disabled) {
			if (plan.port !== undefined) {
				const port = plan.port;
				run.stopProbes.push(pollUntil(() => tcpOpen(port), 500, () => satisfy(record, run, "port")));
			}
			if (plan.url !== undefined) {
				const url = plan.url;
				run.stopProbes.push(pollUntil(() => httpUp(url), 1000, () => satisfy(record, run, "url")));
			}
			run.readyTimer = setTimeout(() => {
				if (current(record, run) && record.info.status === "starting") emit({ type: "ready_timeout", process: snapshot(record), tail: tail(record) });
			}, plan.timeoutMs);
		}
		run.finished = track(record, run, exited, closed, splitters);
		changed(record);
		await delay(START_SETTLE_MS);
	}

	async function track(record: ProcessRecord, run: Run, exited: Promise<[number | null, NodeJS.Signals | null]>, closed: Promise<void>, splitters: LineSplitter[]): Promise<void> {
		const [code, signal] = await exited;
		run.exited = true;
		stopReadiness(run);
		record.info.exitCode = code;
		record.info.signal = signal;
		const pgid = record.info.pid!;
		// We own the group: nothing the shell left behind may outlive it.
		const reap = (async () => {
			await delay(LEFTOVER_PAUSE_MS);
			if (!run.stopping && groupAlive(pgid)) await terminateGroup(pgid, LEFTOVER_GRACE_MS);
		})();
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, CLOSE_GRACE_MS)))]);
		clearTimeout(timer);
		await reap;
		run.child.stdout!.destroy();
		run.child.stderr!.destroy();
		for (const splitter of splitters) for (const line of splitter.end()) handleLine(record, run, line);
		record.log.close();
		clearTimeout(run.errorTimer);
		if (run.errorLines.length) emitErrors(record, run);
		const requested = run.stopping !== undefined;
		record.info.status = requested ? "stopped" : "exited";
		record.info.endedAt = Date.now();
		const lines = tail(record);
		emit({ type: "exit", process: snapshot(record), requested, tail: lines });
		for (const wait of [...waits.values()]) {
			if (wait.record === record) finishWait(wait, wait.options.until === "exit" ? "satisfied" : "exited");
		}
		changed(record);
	}

	function onLine(record: ProcessRecord, run: Run, line: string): void {
		if (current(record, run)) handleLine(record, run, line);
	}

	function handleLine(record: ProcessRecord, run: Run, line: string): void {
		const { info, plan } = record;
		const fresh = findLocalUrls(line).filter((url) => !info.urls.includes(url));
		if (fresh.length && info.urls.length < MAX_URLS) {
			info.urls.push(...fresh.slice(0, MAX_URLS - info.urls.length));
			changed(record);
		}
		if (run.pending.has("auto-url") && !run.autoProbing && info.urls.length && !run.exited) {
			run.autoProbing = true;
			const port = urlPort(info.urls[0]);
			run.stopProbes.push(pollUntil(() => tcpOpen(port), 500, () => satisfy(record, run, "auto-url")));
		}
		if (plan.pattern?.test(line)) satisfy(record, run, "pattern");
		if (plan.errorPattern?.test(line)) onErrorLine(record, run, line);
		for (const wait of [...waits.values()]) {
			if (wait.record === record && wait.pattern?.test(line)) finishWait(wait, "satisfied", line);
		}
	}

	function onErrorLine(record: ProcessRecord, run: Run, line: string): void {
		if (run.errorMuted) {
			if (run.errorLines.length < ERROR_BATCH) run.errorLines.push(line);
			else run.suppressed++;
			return;
		}
		run.errorLines.push(line);
		emitErrors(record, run);
		mute(record, run);
	}

	function mute(record: ProcessRecord, run: Run): void {
		run.errorMuted = true;
		run.errorTimer = setTimeout(() => {
			run.errorMuted = false;
			if (!run.errorLines.length || run.exited) return;
			emitErrors(record, run);
			mute(record, run);
		}, errorCooldownMs);
	}

	function emitErrors(record: ProcessRecord, run: Run): void {
		emit({ type: "error_output", process: snapshot(record), lines: run.errorLines, suppressed: run.suppressed });
		run.errorLines = [];
		run.suppressed = 0;
	}

	function satisfy(record: ProcessRecord, run: Run, kind: string): void {
		if (!current(record, run) || record.info.status !== "starting" || !run.pending.delete(kind) || run.pending.size) return;
		stopReadiness(run);
		record.info.status = "ready";
		record.info.readyAt = Date.now();
		emit({ type: "ready", process: snapshot(record), via: kind });
		for (const wait of [...waits.values()]) {
			if (wait.record === record && wait.options.until === "ready") finishWait(wait, "satisfied");
		}
		changed(record);
	}

	function stopReadiness(run: Run): void {
		for (const stop of run.stopProbes) stop();
		run.stopProbes = [];
		clearTimeout(run.readyTimer);
	}

	function finishWait(wait: Wait, outcome: "satisfied" | "timeout" | "exited", line?: string): void {
		if (!waits.delete(wait.id)) return;
		clearTimeout(wait.timer);
		const { record, options } = wait;
		emit({ type: "wait_done", process: snapshot(record), waitId: wait.id, until: options.until, outcome, ...(line === undefined ? {} : { line }), tail: tail(record) });
	}

	async function stop(record: ProcessRecord, graceMs: number): Promise<StopResult> {
		const run = record.run;
		if (!run || !LIVE.has(record.info.status)) return { process: snapshot(record), outcome: "already" };
		if (run.exited) {
			await run.finished;
			return { process: snapshot(record), outcome: "already" };
		}
		run.stopping ??= (async () => {
			stopReadiness(run);
			record.info.status = "stopping";
			changed(record);
			const outcome = await terminateGroup(record.info.pid!, graceMs);
			if (outcome !== "stuck") await run.finished;
			return { process: snapshot(record), outcome };
		})();
		return run.stopping;
	}

	return {
		async start(start) {
			if (!start.command.trim()) throw new Error("command must not be empty.");
			if (!path.isAbsolute(start.cwd)) throw new Error(`cwd must be absolute, got "${start.cwd}".`);
			const plan = compile(start);
			const twin = start.reuse === false ? undefined : live().find((record) =>
				start.name === undefined ? record.options.command === start.command && record.options.cwd === start.cwd : record.info.name === start.name,
			);
			if (twin) {
				if (twin.options.command !== start.command || twin.options.cwd !== start.cwd) {
					throw new Error(`Process "${twin.info.name}" is already running "${twin.options.command}" in ${twin.options.cwd}; stop it or pick another name.`);
				}
				return { process: snapshot(twin), reused: true };
			}
			checkCapacity();
			const id = uniqueId("p", (candidate) => records.has(candidate));
			const logPath = path.join(runDir, `${id}.log`);
			fs.closeSync(fs.openSync(logPath, "a"));
			const record: ProcessRecord = {
				info: { id, name: start.name ?? defaultName(start.command), command: start.command, cwd: start.cwd, owner: start.owner, pid: undefined, status: "starting", startedAt: Date.now(), urls: [], logPath, logBytes: 0, restarts: 0, attached: start.attached ?? false },
				options: { ...start, env: start.env && { ...start.env } },
				plan,
				log: new LogFile(logPath, maxLogBytes),
			};
			records.set(id, record);
			try {
				await launch(record);
			} catch (error) {
				records.delete(id);
				record.log.remove();
				throw error;
			}
			return { process: snapshot(record), reused: false };
		},

		list: () => [...records.values()].map(snapshot),

		get: (idOrName) => snapshot(find(idOrName)),

		async logs(idOrName: string, query: LogQuery = {}): Promise<LogRead> {
			const record = find(idOrName);
			return record.log.read(query, !LIVE.has(record.info.status));
		},

		stop: (idOrName, graceMs = DEFAULT_GRACE_MS) => stop(find(idOrName), graceMs),

		async restart(idOrName) {
			const record = find(idOrName);
			const result = await stop(record, DEFAULT_GRACE_MS);
			if (result.outcome === "stuck") throw new Error(`Process "${record.info.name}" survived SIGKILL; not restarting.`);
			const clash = live().find((other) => other !== record && other.info.name === record.info.name);
			if (clash) throw new Error(`Another live process (${clash.info.id}) is named "${record.info.name}".`);
			checkCapacity();
			record.info.restarts++;
			const separator = `${record.lastByte === undefined || record.lastByte === 10 ? "" : "\n"}--- restart ${record.info.restarts} ---\n`;
			record.log.append(Buffer.from(separator));
			record.lastByte = 10;
			record.info.logBytes = record.log.bytes;
			await launch(record);
			return snapshot(record);
		},

		wait(idOrName, waitOptions) {
			const record = find(idOrName);
			const { until } = waitOptions;
			if (until !== "ready" && until !== "exit" && until !== "match") throw new Error(`Unknown wait condition "${String(until)}".`);
			if (until === "ready" && record.plan.disabled) throw new Error(`Process "${record.info.name}" has readiness disabled; wait for "exit" instead.`);
			let pattern: RegExp | undefined;
			if (until === "match") {
				if (waitOptions.pattern === undefined) throw new Error('A "match" wait needs a pattern.');
				pattern = compilePattern(waitOptions.pattern, "pattern");
			}
			const seconds = waitOptions.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
			if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`timeoutSeconds must be a positive number, got ${seconds}.`);
			const id = uniqueId("w", (candidate) => waits.has(candidate));
			const wait: Wait = { id, record, options: { ...waitOptions }, pattern, timer: setTimeout(() => finishWait(wait, "timeout"), seconds * 1000) };
			waits.set(id, wait);
			const ended = !LIVE.has(record.info.status);
			if (until === "ready" && record.info.status === "ready") process.nextTick(() => finishWait(wait, "satisfied"));
			else if (ended) process.nextTick(() => finishWait(wait, until === "exit" ? "satisfied" : "exited"));
			return id;
		},

		detach(idOrName) {
			const record = find(idOrName);
			record.info.attached = false;
			changed(record);
			return snapshot(record);
		},

		discard(idOrName) {
			const record = find(idOrName);
			if (LIVE.has(record.info.status)) throw new Error(`Process "${record.info.name}" is still ${record.info.status}; stop it first.`);
			record.log.remove();
			records.delete(record.info.id);
		},

		cancelWait(waitId) {
			const wait = waits.get(waitId);
			if (!wait) return false;
			clearTimeout(wait.timer);
			return waits.delete(waitId);
		},

		clear() {
			let count = 0;
			for (const [id, record] of records) {
				if (LIVE.has(record.info.status)) continue;
				record.log.remove();
				records.delete(id);
				count++;
			}
			return count;
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		killAllSync() {
			for (const record of live()) {
				if (record.info.pid !== undefined) signalGroup(record.info.pid, "SIGKILL");
			}
		},

		async shutdown() {
			await Promise.all(live().map((record) => stop(record, DEFAULT_GRACE_MS)));
		},
	};
}

function compile(start: StartOptions): Plan {
	const errorPattern = start.errorPattern === undefined ? undefined : compilePattern(start.errorPattern, "errorPattern");
	if (start.ready === false) return { disabled: true, timeoutMs: 0, errorPattern };
	const spec = start.ready ?? {};
	if (spec.port !== undefined && !(Number.isInteger(spec.port) && spec.port > 0 && spec.port < 65536)) throw new Error(`ready.port must be a TCP port, got ${spec.port}.`);
	if (spec.url !== undefined && !/^https?:$/.test(URL.canParse(spec.url) ? new URL(spec.url).protocol : "")) throw new Error(`ready.url must be an http(s) URL, got "${spec.url}".`);
	const seconds = spec.timeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS;
	if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ready.timeoutSeconds must be a positive number, got ${seconds}.`);
	return {
		disabled: false,
		pattern: spec.pattern === undefined ? undefined : compilePattern(spec.pattern, "ready.pattern"),
		port: spec.port,
		url: spec.url,
		timeoutMs: seconds * 1000,
		errorPattern,
	};
}

/** Deletes run directories whose owner pid is dead and whose newest file is older than `retentionMs`. */
function sweep(stateDir: string, retentionMs: number): void {
	for (const entry of fs.readdirSync(stateDir, { withFileTypes: true })) {
		const match = /^(\d+)-\d+$/.exec(entry.name);
		if (!entry.isDirectory() || !match || pidAlive(Number(match[1]))) continue;
		const dir = path.join(stateDir, entry.name);
		const newest = Math.max(fs.statSync(dir).mtimeMs, ...fs.readdirSync(dir).map((file) => fs.statSync(path.join(dir, file)).mtimeMs));
		if (Date.now() - newest > retentionMs) fs.rmSync(dir, { recursive: true, force: true });
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		throw error;
	}
}
