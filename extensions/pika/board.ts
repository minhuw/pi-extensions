import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { credentialsRegistry, type PikaCredentials } from "./credentials.ts";

/**
 * The process-global registry of swarm boards that a coordinator's extension publishes. Extensions never import each
 * other, so whoever needs it first creates it.
 */
export const SWARM_BOARDS = Symbol.for("pi-extensions.swarm-boards");

export type CardStatus = "todo" | "doing" | "blocked" | "done" | "failed" | "dropped";

export interface SwarmCard {
	id: string;
	title: string;
	status: CardStatus;
	agentId?: string;
	agent?: string;
	note?: string;
	createdBy: string;
	updatedBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface SwarmBoard {
	version: 1;
	/** The coordinator session. */
	sessionId: string;
	/** Unix milliseconds. */
	updatedAt: number;
	cards: SwarmCard[];
}

export interface SwarmBoards {
	version: 1;
	boards: Map<string, SwarmBoard>;
	listeners: Set<(board: SwarmBoard) => void>;
}

const global = globalThis as { [SWARM_BOARDS]?: SwarmBoards; [SYNC]?: BoardSync };
export const swarmBoards = (): SwarmBoards => global[SWARM_BOARDS] ??= { version: 1, boards: new Map(), listeners: new Set() };

/** At most one upload per board in this time. */
export const BOARD_INTERVAL_MS = 1_000;
/** The first wait after a failed upload; it doubles with each failure in a row, up to `BOARD_RETRY_MAX_MS`. */
export const BOARD_RETRY_MS = 5_000;
export const BOARD_RETRY_MAX_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 10_000;
/** Answers that the same snapshot would get again: the board waits for new credentials. */
const PERMANENT = new Set([400, 401, 403, 404, 413]);

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface BoardSyncOptions {
	/** Records a failure where `/pika` shows it. */
	noteError(message: string): void;
	intervalMs?: number;
	retryMs?: number;
	retryMaxMs?: number;
}

interface BoardState {
	/** A snapshot newer than the last one the server took is waiting. */
	dirty: boolean;
	timer?: NodeJS.Timeout;
	inFlight?: Promise<void>;
	lastAttemptAt: number;
	retryAt: number;
	failures: number;
	/** Why uploads stopped until the credentials change. */
	stopped?: string;
	/** The last failure noted, so a repeat is not noted again. */
	noted?: string;
}

/**
 * Uploads the boards of tracked sessions to pika, coalesced: at most one request per board per interval, always with
 * the board's latest snapshot. One per process, on `globalThis`, so module copies loaded for other cwds share it.
 */
export class BoardSync {
	private readonly sessions = new Map<string, { count: number; captured: () => boolean }>();
	private readonly states = new Map<string, BoardState>();
	private readonly onBoard = (board: SwarmBoard) => { this.update(board.sessionId); };
	private readonly onCredentials = () => { this.credentialsChanged(); };
	private attached = false;

	constructor(private readonly options: BoardSyncOptions) {}

	private get interval() { return this.options.intervalMs ?? BOARD_INTERVAL_MS; }

	/** Uploads the boards of `sessionId` while `captured()` holds, until the returned function is called. */
	track(sessionId: string, captured: () => boolean): () => void {
		const entry = this.sessions.get(sessionId);
		if (entry) entry.count++;
		else this.sessions.set(sessionId, { count: 1, captured });
		this.attach();
		if (swarmBoards().boards.has(sessionId)) this.update(sessionId);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			const current = this.sessions.get(sessionId);
			if (current && --current.count === 0) {
				this.sessions.delete(sessionId);
				const state = this.states.get(sessionId);
				if (state?.timer) clearTimeout(state.timer);
				this.states.delete(sessionId);
			}
			if (this.sessions.size === 0) this.detach();
		};
	}

	/** Sends the waiting snapshot of `sessionId` now and waits up to `timeoutMs` for its upload. */
	async flush(sessionId: string, timeoutMs: number): Promise<void> {
		const state = this.states.get(sessionId);
		if (!state) return;
		if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
		if (!state.inFlight && state.dirty && !state.stopped) this.send(sessionId, state);
		if (!state.inFlight) return;
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([state.inFlight, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
		clearTimeout(timer);
	}

	private attach(): void {
		if (this.attached) return;
		this.attached = true;
		swarmBoards().listeners.add(this.onBoard);
		credentialsRegistry().listeners.add(this.onCredentials);
	}

	private detach(): void {
		if (!this.attached) return;
		this.attached = false;
		swarmBoards().listeners.delete(this.onBoard);
		credentialsRegistry().listeners.delete(this.onCredentials);
	}

	private update(sessionId: string): void {
		if (!this.sessions.has(sessionId)) return;
		let state = this.states.get(sessionId);
		if (!state) this.states.set(sessionId, state = { dirty: false, lastAttemptAt: 0, retryAt: 0, failures: 0 });
		state.dirty = true;
		this.schedule(sessionId, state);
	}

	private credentialsChanged(): void {
		for (const [sessionId, state] of this.states) {
			state.stopped = undefined;
			state.noted = undefined;
			state.failures = 0;
			state.retryAt = 0;
			state.dirty = swarmBoards().boards.has(sessionId);
			this.schedule(sessionId, state);
		}
	}

	private schedule(sessionId: string, state: BoardState): void {
		if (!state.dirty || state.stopped || state.timer || state.inFlight) return;
		if (!credentialsRegistry().current) return;
		const now = Date.now();
		const delay = Math.max(0, state.lastAttemptAt + this.interval - now, state.retryAt - now);
		state.timer = setTimeout(() => { state.timer = undefined; this.send(sessionId, state); }, delay);
		state.timer.unref?.();
	}

	private send(sessionId: string, state: BoardState): void {
		const credentials = credentialsRegistry().current;
		const board = swarmBoards().boards.get(sessionId);
		const tracked = this.sessions.get(sessionId);
		if (!credentials || !board || !tracked?.captured()) return;
		const body = JSON.stringify({ version: board.version, sessionId: board.sessionId, updatedAt: board.updatedAt, cards: board.cards });
		state.dirty = false;
		state.lastAttemptAt = Date.now();
		state.inFlight = this.upload(credentials, sessionId, body)
			.then((failure) => this.settle(sessionId, state, failure))
			.finally(() => {
				state.inFlight = undefined;
				if (this.states.get(sessionId) === state) this.schedule(sessionId, state);
			});
	}

	/** Uploads one snapshot; the failure, if any, and whether a retry could succeed. */
	private async upload(credentials: PikaCredentials, sessionId: string, body: string): Promise<{ message: string; permanent: boolean } | undefined> {
		let response: Response;
		try {
			response = await fetch(`${credentials.url}/api/relay/v1/boards/${encodeURIComponent(sessionId)}`, {
				method: "PUT",
				headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json", Accept: "application/json" },
				body,
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
				redirect: "error",
			});
		} catch (error) {
			return { message: errorText(error), permanent: false };
		}
		if (response.ok) {
			await response.body?.cancel();
			return undefined;
		}
		let detail = "";
		try {
			const answer = await response.json() as { error?: unknown; message?: unknown };
			detail = [answer.error, answer.message].filter((part) => typeof part === "string").join(": ");
		} catch { /* the status says enough */ }
		return { message: `HTTP ${response.status}${detail ? ` ${detail}` : ""}`, permanent: PERMANENT.has(response.status) };
	}

	private settle(sessionId: string, state: BoardState, failure: { message: string; permanent: boolean } | undefined): void {
		if (!failure) {
			state.failures = 0;
			state.retryAt = 0;
			state.noted = undefined;
			return;
		}
		const message = `board upload for session ${sessionId}: ${failure.message}${failure.permanent ? "; not retried until the login changes" : ""}`;
		if (state.noted !== message) {
			state.noted = message;
			this.options.noteError(message);
		}
		if (failure.permanent) {
			state.stopped = failure.message;
			return;
		}
		state.dirty = true;
		state.failures++;
		const retryMs = this.options.retryMs ?? BOARD_RETRY_MS;
		state.retryAt = Date.now() + Math.min(retryMs * 2 ** (state.failures - 1), this.options.retryMaxMs ?? BOARD_RETRY_MAX_MS);
	}
}

const SYNC = Symbol.for("pi-extensions.pika.boards");
export const boardSync = (options: BoardSyncOptions): BoardSync => global[SYNC] ??= new BoardSync(options);

/** How long the end of a session waits for its board's last upload. */
const SHUTDOWN_FLUSH_MS = 2_000;

/**
 * Uploads the swarm board of this top-level session while pika captures it. Children are left out: they run in print
 * or json mode, or name a parent session in their header.
 */
export function boardExtension(pi: ExtensionAPI, options: BoardSyncOptions & { captured(sessionId: string): boolean }): void {
	let untrack: (() => void) | undefined;
	let sessionId: string | undefined;
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		untrack?.();
		untrack = undefined;
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (ctx.sessionManager.getHeader()?.parentSession) return;
		const id = sessionId = ctx.sessionManager.getSessionId();
		untrack = boardSync(options).track(id, () => options.captured(id));
	});
	pi.on("session_shutdown", async () => {
		if (!untrack || !sessionId) return;
		const stop = untrack;
		untrack = undefined;
		try { await boardSync(options).flush(sessionId, SHUTDOWN_FLUSH_MS); } finally { stop(); }
	});
}
