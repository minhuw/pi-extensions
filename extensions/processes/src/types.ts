// Contract between the process substrate (src/manager.ts and its modules) and the
// Pi facade (index.ts, src/tools.ts, src/notify.ts, src/guard.ts, src/ui.ts).
// The substrate imports nothing from Pi; the facade never spawns or signals.

export type ProcessStatus =
	| "starting" // spawned, readiness not yet reached (or no readiness criteria and no URL seen yet)
	| "running" // alive with readiness disabled (`ready: false`)
	| "ready" // readiness criteria met; the process keeps running
	| "stopping" // stop requested, waiting for the group to exit
	| "exited" // exited on its own (exitCode or signal set)
	| "stopped"; // exited after a stop request

export interface ReadinessSpec {
	/** Regex (JavaScript syntax) matched against each output line (ANSI stripped). */
	pattern?: string;
	/** TCP port on 127.0.0.1 that must accept a connection. */
	port?: number;
	/** HTTP(S) URL that must answer with any status below 500. */
	url?: string;
	/** Seconds before a "ready_timeout" event; the process keeps running. Default 120. */
	timeoutSeconds?: number;
}

export interface StartOptions {
	/** Unique among live processes; defaults to a slug of the command's first word. */
	name?: string;
	command: string;
	/** Absolute directory; the facade resolves and validates it. */
	cwd: string;
	env?: Record<string, string>;
	/**
	 * Readiness criteria, all of which must hold. When omitted, the process becomes
	 * ready once a local http(s) URL appears in its output and that port accepts TCP.
	 * `false` disables readiness entirely (one-shot commands such as builds).
	 */
	ready?: ReadinessSpec | false;
	/** Regex for output lines that are reported as errors (rate-limited). */
	errorPattern?: string;
	/** Opaque owner tag (the facade passes the Pi session id). */
	owner: string;
	/** `false` always spawns a new process instead of reusing a live twin. Default true. */
	reuse?: boolean;
	/**
	 * A foreground caller (Pi's bash tool) is waiting for this run and reports it itself; facades skip its events
	 * until `detach` hands it over.
	 */
	attached?: boolean;
	/** Raw output chunks while attached, after the manager has processed them. */
	onOutput?: (chunk: Buffer) => void;
}

export interface ProcessInfo {
	id: string; // stable random id, e.g. "p_3f9a"
	name: string;
	command: string;
	cwd: string;
	owner: string;
	pid: number | undefined;
	status: ProcessStatus;
	startedAt: number; // epoch ms
	readyAt?: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: string | null;
	/** Local URLs seen in output, first first; deduplicated. */
	urls: string[];
	logPath: string;
	/** Total bytes ever written to the log (monotonic, survives rotation). */
	logBytes: number;
	restarts: number;
	/** See StartOptions.attached. */
	attached: boolean;
}

export type ProcessEvent =
	| { type: "ready"; process: ProcessInfo; via: string } // via: "pattern" | "port" | "url" | "auto-url"
	| { type: "ready_timeout"; process: ProcessInfo; tail: string[] }
	| { type: "error_output"; process: ProcessInfo; lines: string[]; suppressed: number }
	| { type: "exit"; process: ProcessInfo; requested: boolean; tail: string[] }
	| {
			type: "wait_done";
			process: ProcessInfo;
			waitId: string;
			until: WaitUntil;
			/** "exited" when the process ended before a ready/match wait was satisfied. */
			outcome: "satisfied" | "timeout" | "exited";
			/** The matching line for "match". */
			line?: string;
			tail: string[];
	  }
	| { type: "changed"; process: ProcessInfo }; // any status/metadata change, for UI only

export type WaitUntil = "ready" | "exit" | "match";

export interface WaitOptions {
	until: WaitUntil;
	/** Required for "match": regex tested against new output lines only. */
	pattern?: string;
	/** Default 600. */
	timeoutSeconds?: number;
}

export interface LogRead {
	lines: string[];
	/** Pass back as `cursor` to read only newer output. */
	nextCursor: number;
	/** True when output between the requested cursor and the oldest retained byte was rotated away. */
	truncated: boolean;
	/** True when more output exists after nextCursor (page limit hit). */
	more: boolean;
}

export interface LogQuery {
	/** Byte offset from a previous read; omit to read the tail. */
	cursor?: number;
	/** Lines when reading the tail (default 50, max 500). */
	tail?: number;
	/** Regex filter applied per line. */
	filter?: string;
	/** Max bytes returned (default 32 KiB). */
	maxBytes?: number;
}

export interface StopResult {
	process: ProcessInfo;
	/** "terminated": exited after SIGTERM; "killed": needed SIGKILL; "already": was not running; "stuck": group survived SIGKILL. */
	outcome: "terminated" | "killed" | "already" | "stuck";
}

export interface ProcessManager {
	/** Spawns, or returns the existing live process when name+command+cwd match (reused: true). Throws on name clash with a different command, or when the live limit is reached. */
	start(options: StartOptions): Promise<{ process: ProcessInfo; reused: boolean }>;
	list(): ProcessInfo[];
	/** Accepts id or name. Throws when unknown. */
	get(idOrName: string): ProcessInfo;
	logs(idOrName: string, query?: LogQuery): Promise<LogRead>;
	/** SIGTERM to the group, SIGKILL after graceMs (default 3000). */
	stop(idOrName: string, graceMs?: number): Promise<StopResult>;
	/** Stop, then start again with the same options; same id and name, restarts + 1. */
	restart(idOrName: string): Promise<ProcessInfo>;
	/** Registers a one-shot wait; emits exactly one "wait_done" event. Resolves immediately with the wait id; if the condition already holds, the event fires on the next tick. */
	wait(idOrName: string, options: WaitOptions): string;
	cancelWait(waitId: string): boolean;
	/** Ends attachment: from now on the process is reported like any other. Emits "changed". */
	detach(idOrName: string): ProcessInfo;
	/** Removes one finished record and its log. Throws while it is live. */
	discard(idOrName: string): void;
	/** Removes exited/stopped records and their logs. Returns the count. */
	clear(): number;
	subscribe(listener: (event: ProcessEvent) => void): () => void;
	/** SIGKILL every live group synchronously (process exit path). */
	killAllSync(): void;
	/** Graceful stop of every live process. */
	shutdown(): Promise<void>;
}

export interface ManagerOptions {
	/** Root for logs and the owner marker, e.g. <agentDir>/processes. */
	stateDir: string;
	/** Shell and args, e.g. from Pi's getShellConfig(): { shell: "/bin/bash", args: ["-c"] }. */
	shell: { shell: string; args: string[] };
	/** Defaults: 16 live processes, 32 MiB per log generation (one previous generation kept), 7-day retention. */
	maxLive?: number;
	maxLogBytes?: number;
	retentionMs?: number;
	/** Error-output events per process: at most one per this many ms (default 30000). */
	errorCooldownMs?: number;
}
