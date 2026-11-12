import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	GrepOptions,
	GrepResult,
	HealthCheck,
	MixedSearchResult,
	MultiGrepOptions,
	Result,
	ScanProgress,
	SearchOptions,
	SearchResult,
} from "@ff-labs/fff-node";

export const SCAN_TIMEOUT_MS = 15_000;

export interface EnsureRootOptions {
	basePath: string;
	kind: "workspace" | "aux";
	exact?: boolean;
	frecencyDbPath?: string;
	historyDbPath?: string;
	enableHomeDirScanning?: boolean;
	enableFsRootScanning?: boolean;
	followSymlinks?: boolean;
	waitTimeoutMs?: number;
}

export interface EnsureRootResult {
	root: string;
	created?: boolean;
	dbFallbackError?: string;
}

export type FffHealth = HealthCheck & { pid?: number; sharedRoots?: number };

export interface FffBackend {
	ensureRoot(options: EnsureRootOptions, signal?: AbortSignal): Promise<EnsureRootResult>;
	getScanProgress(root: string, signal?: AbortSignal): Promise<Result<ScanProgress>>;
	grep(
		root: string,
		query: string,
		options?: GrepOptions,
		signal?: AbortSignal,
	): Promise<Result<GrepResult>>;
	multiGrep(
		root: string,
		options: MultiGrepOptions,
		signal?: AbortSignal,
	): Promise<Result<GrepResult>>;
	fileSearch(
		root: string,
		query: string,
		options?: SearchOptions,
		signal?: AbortSignal,
	): Promise<Result<SearchResult>>;
	mixedSearch(
		root: string,
		query: string,
		options?: SearchOptions,
		signal?: AbortSignal,
	): Promise<Result<MixedSearchResult>>;
	healthCheck(root: string, signal?: AbortSignal): Promise<Result<FffHealth>>;
	scanFiles(root: string, signal?: AbortSignal): Promise<Result<boolean>>;
	getPid(): number | undefined;
	dispose(): Promise<void>;
}

export interface SidecarBackendOptions {
	sidecarPath?: string;
	ensureTimeoutMs?: number;
	callTimeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

interface IpcSuccessMessage {
	id: number;
	ok: true;
	value: unknown;
}

interface IpcErrorMessage {
	id: number;
	ok: false;
	error?: string;
}

type IpcReplyMessage = IpcSuccessMessage | IpcErrorMessage;

interface ChildSession {
	proc: ChildProcess;
	ensuredRoots: Set<string>;
	watchdogs: Map<number, ReturnType<typeof setTimeout>>;
	closed: boolean;
	onProcessExit: () => void;
}

interface PendingRequest {
	id: number;
	session: ChildSession;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	cleanupAbort?: () => void;
}

const DEFAULT_ENSURE_TIMEOUT_MS = 25_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const DEFAULT_SIDECAR_PATH = fileURLToPath(new URL("./sidecar.mjs", import.meta.url));

export class SidecarFffBackend implements FffBackend {
	private readonly sidecarPath: string;
	private readonly ensureTimeoutMs: number;
	private readonly callTimeoutMs: number;
	private readonly env: NodeJS.ProcessEnv | undefined;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly rememberedRoots = new Map<string, EnsureRootOptions>();
	private child: ChildSession | null = null;
	private nextId = 1;

	constructor(options: SidecarBackendOptions = {}) {
		this.sidecarPath = options.sidecarPath ?? DEFAULT_SIDECAR_PATH;
		this.ensureTimeoutMs = options.ensureTimeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS;
		this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
		this.env = options.env;
	}

	async ensureRoot(options: EnsureRootOptions, signal?: AbortSignal): Promise<EnsureRootResult> {
		this.pruneRememberedRoots(options.basePath);

		let response: { value: EnsureRootResult; session: ChildSession };
		try {
			response = await this.sendRequest<EnsureRootResult>(
				"ensure",
				options as unknown as Record<string, unknown>,
				this.ensureTimeoutMs,
				signal,
			);
		} catch (err) {
			if (
				!signal?.aborted &&
				err instanceof Error &&
				/FFF sidecar exited unexpectedly/.test(err.message)
			) {
				response = await this.sendRequest<EnsureRootResult>(
					"ensure",
					options as unknown as Record<string, unknown>,
					this.ensureTimeoutMs,
					signal,
				);
			} else {
				throw err;
			}
		}

		const { value, session } = response;
		session.ensuredRoots.add(value.root);

		const previous = this.rememberedRoots.get(value.root);
		this.rememberedRoots.set(value.root, {
			...previous,
			...options,
			kind:
				previous?.kind === "workspace" || options.kind === "workspace" ? "workspace" : "aux",
			frecencyDbPath: options.frecencyDbPath ?? previous?.frecencyDbPath,
			historyDbPath: options.historyDbPath ?? previous?.historyDbPath,
			basePath: value.root,
			exact: true,
		});

		return value;
	}

	getScanProgress(root: string, signal?: AbortSignal): Promise<Result<ScanProgress>> {
		return this.callWithRoot<Result<ScanProgress>>("scanProgress", root, { root }, signal);
	}

	grep(
		root: string,
		query: string,
		options?: GrepOptions,
		signal?: AbortSignal,
	): Promise<Result<GrepResult>> {
		return this.callWithRoot<Result<GrepResult>>(
			"grep",
			root,
			{ root, query, options },
			signal,
		);
	}

	multiGrep(
		root: string,
		options: MultiGrepOptions,
		signal?: AbortSignal,
	): Promise<Result<GrepResult>> {
		return this.callWithRoot<Result<GrepResult>>("multiGrep", root, { root, options }, signal);
	}

	fileSearch(
		root: string,
		query: string,
		options?: SearchOptions,
		signal?: AbortSignal,
	): Promise<Result<SearchResult>> {
		return this.callWithRoot<Result<SearchResult>>(
			"fileSearch",
			root,
			{ root, query, options },
			signal,
		);
	}

	mixedSearch(
		root: string,
		query: string,
		options?: SearchOptions,
		signal?: AbortSignal,
	): Promise<Result<MixedSearchResult>> {
		return this.callWithRoot<Result<MixedSearchResult>>(
			"mixedSearch",
			root,
			{ root, query, options },
			signal,
		);
	}

	healthCheck(root: string, signal?: AbortSignal): Promise<Result<FffHealth>> {
		return this.callWithRoot<Result<FffHealth>>("healthCheck", root, { root }, signal);
	}

	scanFiles(root: string, signal?: AbortSignal): Promise<Result<boolean>> {
		return this.callWithRoot<Result<boolean>>("scanFiles", root, { root }, signal);
	}

	getPid(): number | undefined {
		if (!this.child || this.child.closed) {
			return undefined;
		}
		return this.child.proc.pid;
	}

	async dispose(): Promise<void> {
		if (this.child) {
			this.teardownChild(this.child, new Error("FFF sidecar disposed"), true);
		}
		if (this.pending.size > 0) {
			const remaining = Array.from(this.pending.values());
			this.pending.clear();
			for (const req of remaining) {
				req.cleanupAbort?.();
				req.reject(new Error("FFF sidecar disposed"));
			}
		}
	}

	private pruneRememberedRoots(preservePath?: string): void {
		const preservedResolved = preservePath ? path.resolve(preservePath) : undefined;
		for (const rememberedPath of this.rememberedRoots.keys()) {
			if (
				rememberedPath === preservePath ||
				(preservedResolved !== undefined && path.resolve(rememberedPath) === preservedResolved)
			) {
				continue;
			}
			if (!fs.existsSync(rememberedPath)) {
				this.rememberedRoots.delete(rememberedPath);
			}
		}
	}

	private async callWithRoot<T>(
		method: string,
		root: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const session = this.getOrSpawnChild();
		if (!session.ensuredRoots.has(root)) {
			this.pruneRememberedRoots();
			const remembered = this.rememberedRoots.get(root);
			if (remembered) {
				await this.ensureRoot(remembered, signal);
			}
		}

		try {
			const { value } = await this.sendRequest<T>(method, params, this.callTimeoutMs, signal);
			return value;
		} catch (err) {
			if (
				!signal?.aborted &&
				err instanceof Error &&
				(err.message.includes("FFF root not initialized:") ||
					/FFF sidecar exited unexpectedly/.test(err.message))
			) {
				this.pruneRememberedRoots();
				const remembered = this.rememberedRoots.get(root);
				if (remembered) {
					await this.ensureRoot(remembered, signal);
				} else if (err.message.includes("FFF root not initialized:")) {
					throw err;
				}
				const { value } = await this.sendRequest<T>(
					method,
					params,
					this.callTimeoutMs,
					signal,
				);
				return value;
			}
			throw err;
		}
	}

	private getOrSpawnChild(): ChildSession {
		if (this.child) {
			const proc = this.child.proc;
			if (
				!this.child.closed &&
				proc.exitCode === null &&
				proc.signalCode === null &&
				proc.connected
			) {
				return this.child;
			}
			this.teardownChild(
				this.child,
				new Error(
					`FFF sidecar exited unexpectedly (${proc.exitCode ?? proc.signalCode ?? "disconnected"})`,
				),
				true,
			);
		}

		const proc = fork(this.sidecarPath, [], {
			execArgv: [],
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			...(this.env ? { env: this.env } : {}),
		});

		const session: ChildSession = {
			proc,
			ensuredRoots: new Set<string>(),
			watchdogs: new Map<number, ReturnType<typeof setTimeout>>(),
			closed: false,
			onProcessExit: () => {
				killChildProcess(proc, "SIGKILL");
			},
		};

		process.once("exit", session.onProcessExit);

		proc.on("message", (raw: unknown) => {
			this.handleMessage(session, raw);
		});

		proc.on("error", (err: Error) => {
			if (session.closed) return;
			this.teardownChild(
				session,
				new Error(`FFF sidecar exited unexpectedly (${err.message || "error"})`),
				true,
			);
		});

		proc.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			if (session.closed) return;
			this.teardownChild(
				session,
				new Error(`FFF sidecar exited unexpectedly (${code ?? signal ?? "unknown"})`),
				false,
			);
		});

		this.child = session;
		this.syncRefState(session);
		return session;
	}

	private sendRequest<T>(
		method: string,
		params: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{ value: T; session: ChildSession }> {
		if (signal?.aborted) {
			return Promise.reject(new Error("Operation aborted"));
		}

		const session = this.getOrSpawnChild();
		const id = this.nextId++;

		return new Promise<{ value: T; session: ChildSession }>((resolve, reject) => {
			const watchdog = setTimeout(() => {
				session.watchdogs.delete(id);
				if (session.closed) return;
				this.teardownChild(
					session,
					new Error(`FFF sidecar timed out after ${timeoutMs}ms and was restarted`),
					true,
				);
			}, timeoutMs);
			watchdog.unref();
			session.watchdogs.set(id, watchdog);

			let cleanupAbort: (() => void) | undefined;
			if (signal) {
				const onAbort = () => {
					const active = this.pending.get(id);
					if (!active) return;
					this.pending.delete(id);
					clearTimeout(watchdog);
					session.watchdogs.delete(id);
					cleanupAbort?.();
					this.syncRefState(session);
					reject(new Error("Operation aborted"));
				};
				cleanupAbort = () => {
					signal.removeEventListener("abort", onAbort);
				};
				signal.addEventListener("abort", onAbort, { once: true });
			}

			const request: PendingRequest = {
				id,
				session,
				resolve: (val: unknown) => resolve({ value: val as T, session }),
				reject,
				cleanupAbort,
			};

			this.pending.set(id, request);
			this.syncRefState(session);

			try {
				if (!session.proc.connected || typeof session.proc.send !== "function") {
					throw new Error("disconnected");
				}
				session.proc.send({ id, method, params });
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				this.teardownChild(
					session,
					new Error(`FFF sidecar exited unexpectedly (${reason || "send_failed"})`),
					true,
				);
			}
		});
	}

	private handleMessage(session: ChildSession, raw: unknown): void {
		if (!raw || typeof raw !== "object" || !("id" in raw)) {
			return;
		}
		const msg = raw as IpcReplyMessage;
		if (typeof msg.id !== "number") {
			return;
		}

		const watchdog = session.watchdogs.get(msg.id);
		if (watchdog) {
			clearTimeout(watchdog);
			session.watchdogs.delete(msg.id);
		}

		const req = this.pending.get(msg.id);
		if (!req || req.session !== session) {
			return;
		}

		this.pending.delete(msg.id);
		req.cleanupAbort?.();
		this.syncRefState(session);

		if (msg.ok) {
			req.resolve(msg.value);
		} else {
			req.reject(new Error(typeof msg.error === "string" ? msg.error : "FFF sidecar error"));
		}
	}

	private teardownChild(session: ChildSession, error: Error, killProcess: boolean): void {
		if (session.closed) {
			return;
		}
		session.closed = true;
		process.removeListener("exit", session.onProcessExit);

		for (const timer of session.watchdogs.values()) {
			clearTimeout(timer);
		}
		session.watchdogs.clear();

		if (this.child === session) {
			this.child = null;
		}

		if (killProcess) {
			killChildProcess(session.proc, "SIGKILL");
		}

		const toReject: PendingRequest[] = [];
		for (const [id, req] of this.pending.entries()) {
			if (req.session === session) {
				this.pending.delete(id);
				toReject.push(req);
			}
		}

		for (const req of toReject) {
			req.cleanupAbort?.();
			req.reject(error);
		}
	}

	private syncRefState(session: ChildSession): void {
		if (session.closed) {
			return;
		}
		const channel = (
			session.proc as unknown as {
				channel?: { unref?: () => void; ref?: () => void };
			}
		).channel;
		if (this.pending.size === 0) {
			session.proc.unref();
			channel?.unref?.();
		} else {
			session.proc.ref();
			channel?.ref?.();
		}
	}
}

function killChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		child.kill(signal);
	} catch {
		// Child process already exited.
	}
}

export const SHARED_BACKEND_KEY = Symbol.for("pi-extensions.fff.backend");

export function getSharedFffBackend(): FffBackend {
	const store = globalThis as unknown as Record<symbol, unknown>;
	const existing = store[SHARED_BACKEND_KEY] as FffBackend | undefined;
	if (existing) {
		return existing;
	}
	const created = new SidecarFffBackend();
	store[SHARED_BACKEND_KEY] = created;
	return created;
}
