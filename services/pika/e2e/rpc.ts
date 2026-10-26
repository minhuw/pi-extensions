// A real `pi --mode rpc` process, for the relay checks: two of them must be separate processes, since pika publishes
// its credentials on `globalThis` and each session logs in as a different device.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, sleep, waitFor } from "./util.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const CLI = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

export interface SessionEntry {
	type: string;
	id: string;
	customType?: string;
	content?: unknown;
	display?: boolean;
	details?: Record<string, unknown>;
	data?: Record<string, unknown>;
	message?: { role: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean; stopReason?: string; errorMessage?: string };
}

type RpcRecord = { type?: string; id?: string; [key: string]: unknown };

/** The text of a message's content, a string or text parts. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
	return "";
}

export interface RpcPiOptions {
	/** Names the process in logs. */
	label: string;
	cwd: string;
	/** The isolated agent dir, holding `models.json` and `pika.json`. */
	agentDir: string;
	sessionDir: string;
	/** Absolute paths of the extensions to load, and nothing else. */
	extensions: string[];
	provider: string;
	model: string;
	/** The session's display name. */
	name: string;
	/** Each process's pid is appended here, so the script's trap stops it on any exit. */
	pidFile: string;
	logFile: string;
}

/**
 * pi in RPC mode with only the given extensions, an isolated agent dir, and no network at startup. Records every
 * event and every `notify` an extension shows; stderr goes to `logFile`.
 */
export class RpcPi {
	readonly options: RpcPiOptions;
	readonly events: RpcRecord[] = [];
	/** `notify` messages, oldest first. */
	readonly notes: { message: string; type: string }[] = [];
	sessionId = "";
	private child: ChildProcess | undefined;
	private buffer = "";
	private nextId = 0;
	private readonly pending = new Map<string, { resolve(value: RpcRecord): void; reject(error: Error): void }>();
	private exited: Promise<void> = Promise.resolve();

	constructor(options: RpcPiOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		const { cwd, agentDir, sessionDir, extensions, provider, model, name, pidFile, logFile } = this.options;
		for (const dir of [cwd, agentDir, sessionDir]) mkdirSync(dir, { recursive: true });
		const args = [
			CLI, "--mode", "rpc", "--provider", provider, "--model", model, "--name", name, "--session-dir", sessionDir,
			"--no-extensions", ...extensions.flatMap((path) => ["-e", path]),
			"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--offline",
		];
		const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
		for (const key of ["PIKA_URL", "PIKA_TOKEN", "PIKA_DISABLED", "PI_RELAY_DISABLED"]) delete env[key];
		const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.child = child;
		appendFileSync(pidFile, `${child.pid}\n`);
		const log = createWriteStream(logFile, { flags: "a" });
		child.stderr!.pipe(log);
		this.exited = new Promise((resolve) => child.once("exit", (code, signal) => {
			const error = new Error(`pi ${this.options.label} exited (code ${code}, signal ${signal}); see ${logFile}`);
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
			resolve();
		}));
		// Records are split on LF only: JSON strings may hold U+2028, which readline would split on.
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => {
			this.buffer += chunk;
			for (let end = this.buffer.indexOf("\n"); end >= 0; end = this.buffer.indexOf("\n")) {
				const line = this.buffer.slice(0, end).replace(/\r$/, "");
				this.buffer = this.buffer.slice(end + 1);
				if (line) this.record(line);
			}
		});
		const state = await this.command<{ sessionId: string }>({ type: "get_state" }, 30_000);
		this.sessionId = state.sessionId;
	}

	private record(line: string): void {
		let data: RpcRecord;
		try { data = JSON.parse(line) as RpcRecord; } catch { return; }
		if (data.type === "response" && typeof data.id === "string" && this.pending.has(data.id)) {
			const pending = this.pending.get(data.id)!;
			this.pending.delete(data.id);
			pending.resolve(data);
			return;
		}
		this.events.push(data);
		if (data.type === "extension_ui_request" && data.method === "notify") {
			this.notes.push({ message: String(data.message ?? ""), type: String(data.notifyType ?? "info") });
		}
	}

	/** Sends a command and returns its data; fails on an error response. */
	async command<T = unknown>(command: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
		const child = this.child;
		check(child?.stdin && child.exitCode === null, `pi ${this.options.label} is not running`);
		const id = `e2e-${++this.nextId}`;
		const response = await new Promise<RpcRecord>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`pi ${this.options.label} did not answer ${command.type} within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => { clearTimeout(timer); resolve(value); },
				reject: (error) => { clearTimeout(timer); reject(error); },
			});
			child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
		});
		check(response.success === true, `pi ${this.options.label}: ${command.type} failed: ${String(response.error)}`);
		return response.data as T;
	}

	/**
	 * Sends a prompt or command and, if it started a run, waits for pi to settle. Returns the notes it showed.
	 */
	async prompt(message: string, timeoutMs = 30_000): Promise<{ message: string; type: string }[]> {
		const notes = this.notes.length;
		const events = this.events.length;
		const { disposition } = await this.command<{ disposition: string }>({ type: "prompt", message });
		if (disposition !== "handled") {
			await waitFor(() => this.events.slice(events).some((event) => event.type === "agent_settled"), timeoutMs, `pi ${this.options.label} to settle after ${JSON.stringify(message.slice(0, 50))}`, 50);
		}
		return this.notes.slice(notes);
	}

	async entries(): Promise<SessionEntry[]> {
		return (await this.command<{ entries: SessionEntry[] }>({ type: "get_entries" })).entries;
	}

	/** Waits until pi is idle with nothing queued, twice in a row a little apart, so a turn about to start is seen. */
	async settled(timeoutMs: number, label: string): Promise<void> {
		let quiet = 0;
		await waitFor(async () => {
			const state = await this.command<{ isStreaming: boolean; pendingMessageCount: number }>({ type: "get_state" });
			quiet = !state.isStreaming && state.pendingMessageCount === 0 ? quiet + 1 : 0;
			return quiet >= 3;
		}, timeoutMs, `pi ${this.options.label} to settle (${label})`, 150);
	}

	/** Every assistant message ended normally. */
	async checkNoErrors(): Promise<void> {
		for (const entry of await this.entries()) {
			const message = entry.message;
			if (entry.type !== "message" || message?.role !== "assistant") continue;
			check(message.stopReason !== "error" && message.stopReason !== "aborted", `pi ${this.options.label} has an assistant message that ended with ${message.stopReason}: ${message.errorMessage ?? ""}`);
		}
	}

	/** Closes stdin, which shuts pi down in order (session_shutdown runs); kills it if it lingers. */
	async stop(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		child.stdin!.end();
		const deadline = Date.now() + 15_000;
		while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(50);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await this.exited;
		}
	}
}

/** An agent dir with a provider for the mock endpoint and pika logged in as one device. */
export function agentDirFor(agentDir: string, options: { provider: string; model: string; baseUrl: string; pikaUrl: string; token: string }): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({
		providers: {
			[options.provider]: {
				baseUrl: options.baseUrl, apiKey: "e2e-key", api: "openai-completions",
				models: [{ id: options.model, name: "Mock model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4096 }],
			},
		},
	}, null, "\t"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	writeFileSync(join(agentDir, "pika.json"), JSON.stringify({ url: options.pikaUrl, token: options.token, enabled: true }), { mode: 0o600 });
}
