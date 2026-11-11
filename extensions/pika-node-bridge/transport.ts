/**
 * The daemon socket (NODE.md §5): NDJSON over a unix socket with reconnect, and a latest-wins sender for status
 * snapshots (after `HookTransport` in `extensions/orca-bridge/transport.ts`). Nothing here blocks or fails the agent.
 */
import { connect, type Socket } from "node:net";
import {
	encodeLine, LineDecoder, parseDaemonToBridge, PROTOCOL_VERSION,
	type BridgeMessage, type BridgeStatus,
} from "./protocol.ts";

export interface SenderOptions { timeoutMs: number; intervalMs: number }

/**
 * One delivery in flight and one replaceable pending value; no retry backlog. Each attempt is bounded by
 * `timeoutMs` (its signal aborts with "timeout"), and attempts start at least `intervalMs` apart, so a burst
 * of changes ends on the latest value.
 */
export class LatestSender<T> {
	lastResult = "not sent";
	private pending: { value: T } | undefined;
	private running: Promise<void> | undefined;
	private cancel: (() => void) | undefined;
	private spacing: ReturnType<typeof setTimeout> | undefined;
	private lastStart = -Infinity;
	private closed = false;
	private closing: Promise<void> | undefined;
	constructor(private deliver: (value: T, signal: AbortSignal) => Promise<string>, private options: SenderOptions = { timeoutMs: 1000, intervalMs: 100 }) {}

	post(value: T): void {
		if (this.closed) return;
		this.pending = { value };
		this.drain();
	}

	private drain(): void {
		if (this.running || this.spacing || this.closed || !this.pending) return;
		const wait = this.lastStart + this.options.intervalMs - Date.now();
		if (wait > 0) {
			this.spacing = setTimeout(() => { this.spacing = undefined; this.drain(); }, wait);
			this.spacing.unref?.();
			return;
		}
		const { value } = this.pending;
		this.pending = undefined;
		this.lastStart = Date.now();
		this.running = this.attempt(value).finally(() => {
			this.running = undefined;
			this.drain();
		});
	}

	private async attempt(value: T): Promise<void> {
		const controller = new AbortController();
		let finish: (result: string) => void = () => {};
		const interrupted = new Promise<string>(resolve => { finish = resolve; });
		this.cancel = () => { finish("cancelled"); controller.abort("cancelled"); };
		const timer = setTimeout(() => { finish("timeout"); controller.abort("timeout"); }, this.options.timeoutMs);
		timer.unref?.();
		try {
			this.lastResult = await Promise.race([
				this.deliver(value, controller.signal).catch((error: unknown) => error instanceof Error ? error.message : "delivery failed"),
				interrupted,
			]);
		} finally {
			clearTimeout(timer);
			this.cancel = undefined;
		}
	}

	/** Drops pending work and cancels the attempt in flight, then makes one bounded attempt with `final`. */
	close(final?: T): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.pending = undefined;
		clearTimeout(this.spacing);
		this.spacing = undefined;
		this.cancel?.();
		this.closing = (async () => {
			await this.running;
			if (final !== undefined) await this.attempt(final);
		})();
		return this.closing;
	}
}

export type Reply = { delivered: number } | { error: { code: string; message?: string } };
type Request = { type: "open"; path: string; line?: number; column?: number } | { type: "diff"; path: string; staged?: boolean };

export interface LinkOptions {
	socket: string;
	pane: string;
	version: string;
	/** Called after every `welcome`: the bridge sends its full status on each connect. */
	onWelcome: () => void;
	/** Reconnect delay, doubling from `initialMs` to `maxMs`. */
	backoff?: { initialMs: number; maxMs: number };
	/** Connect and `hello` must finish within this. */
	connectTimeoutMs?: number;
}

/**
 * The bridge's connection to its daemon. It reconnects with backoff after the socket closes, except after the
 * daemon refuses the `hello` (an unknown pane or protocol version): reconnecting would be refused again.
 */
export class DaemonLink {
	state: "idle" | "connecting" | "ready" | "refused" | "closed" = "idle";
	/** Why the link is not ready, for diagnostics. */
	reason = "not connected";
	private socket: Socket | undefined;
	private retry: ReturnType<typeof setTimeout> | undefined;
	private delay: number;
	private nextId = 0;
	private replies = new Map<string, (reply: Reply) => void>();
	private readyWaiters = new Set<() => void>();

	constructor(private options: LinkOptions) {
		this.delay = options.backoff?.initialMs ?? 1000;
	}

	start(): void {
		if (this.state === "idle") this.connect();
	}

	private connect(): void {
		clearTimeout(this.retry);
		this.retry = undefined;
		this.state = "connecting";
		const socket = connect(this.options.socket);
		this.socket = socket;
		const decoder = new LineDecoder();
		let welcomed = false;
		const helloTimer = setTimeout(() => { this.reason = "no welcome in time"; socket.destroy(); }, this.options.connectTimeoutMs ?? 2000);
		helloTimer.unref?.();
		socket.unref();
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(encodeLine({ type: "hello", role: "bridge", paneId: this.options.pane, pid: process.pid, version: this.options.version, protocolVersion: PROTOCOL_VERSION }));
		});
		socket.on("data", (chunk: string) => {
			let lines: string[];
			try { lines = decoder.push(chunk); }
			catch { this.reason = "daemon line too long"; socket.destroy(); return; }
			for (const line of lines) {
				let value: unknown;
				try { value = JSON.parse(line); } catch { continue; }
				const message = parseDaemonToBridge(value);
				if (!message) continue;
				if (message.type === "welcome") {
					if (welcomed) continue;
					welcomed = true;
					clearTimeout(helloTimer);
					this.state = "ready";
					this.reason = "connected";
					this.delay = this.options.backoff?.initialMs ?? 1000;
					for (const wake of [...this.readyWaiters]) wake();
					this.options.onWelcome();
				} else if (message.id === "hello" && message.error) {
					this.state = "refused";
					this.reason = `daemon refused this pane (${message.error.code}${message.error.message ? `: ${message.error.message}` : ""})`;
					for (const wake of [...this.readyWaiters]) wake();
					socket.destroy();
				} else {
					const resolve = this.replies.get(message.id);
					this.replies.delete(message.id);
					resolve?.(message.error ? { error: message.error } : { delivered: message.result.delivered });
				}
			}
		});
		socket.on("error", error => { this.reason = (error as NodeJS.ErrnoException).code ?? error.message; });
		socket.on("close", () => {
			clearTimeout(helloTimer);
			if (this.socket !== socket) return;
			this.socket = undefined;
			for (const resolve of this.replies.values()) resolve({ error: { code: "disconnected", message: "the daemon socket closed" } });
			this.replies.clear();
			if (this.state === "refused" || this.state === "closed") return;
			if (this.state === "ready") this.reason = "daemon socket closed";
			this.state = "connecting";
			this.retry = setTimeout(() => this.connect(), this.delay);
			this.retry.unref?.();
			this.delay = Math.min(this.delay * 2, this.options.backoff?.maxMs ?? 30_000);
			// A request waiting for this attempt fails now rather than at its timeout.
			for (const wake of [...this.readyWaiters]) wake();
		});
	}

	/** Writes one status line; resolves once the socket has taken it. An abort while it waits drops the socket. */
	writeStatus(status: BridgeStatus, signal: AbortSignal): Promise<string> {
		return this.write({ type: "status", status }, signal);
	}

	private write(message: BridgeMessage, signal?: AbortSignal): Promise<string> {
		const socket = this.socket;
		if (this.state !== "ready" || !socket) return Promise.resolve(`not sent: ${this.reason}`);
		return new Promise(resolve => {
			const onAbort = () => {
				// A daemon that does not take a small line within the bound is wedged; reconnect to it.
				if (signal?.reason === "timeout") { this.reason = "daemon stopped reading"; socket.destroy(); }
				resolve(String(signal?.reason ?? "aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			socket.write(encodeLine(message), error => {
				signal?.removeEventListener("abort", onAbort);
				resolve(error ? `write failed: ${error.message}` : "sent");
			});
		});
	}

	/** Whether the current or an immediate connection attempt gets a welcome (instead of waiting out the backoff). */
	private whenReady(timeoutMs: number): Promise<boolean> {
		if (this.state === "ready") return Promise.resolve(true);
		if (this.state === "refused" || this.state === "closed") return Promise.resolve(false);
		if (this.retry) this.connect();
		return new Promise(resolve => {
			const done = () => { clearTimeout(timer); this.readyWaiters.delete(done); resolve(this.state === "ready"); };
			const timer = setTimeout(done, timeoutMs);
			timer.unref?.();
			this.readyWaiters.add(done);
		});
	}

	/** Sends `open` or `diff` and waits for the daemon's reply, within `timeoutMs` in total. */
	async request(request: Request, timeoutMs = 5000): Promise<Reply> {
		const deadline = Date.now() + timeoutMs;
		if (!await this.whenReady(timeoutMs)) return { error: { code: "unavailable", message: `the pika-node daemon is not connected (${this.reason})` } };
		const id = `${request.type}-${++this.nextId}`;
		const reply = new Promise<Reply>(resolve => {
			const timer = setTimeout(() => {
				this.replies.delete(id);
				resolve({ error: { code: "timeout", message: "the pika-node daemon did not answer in time" } });
			}, Math.max(0, deadline - Date.now()));
			timer.unref?.();
			this.replies.set(id, value => { clearTimeout(timer); resolve(value); });
		});
		const written = await this.write({ ...request, id } as BridgeMessage);
		if (written !== "sent") {
			this.replies.get(id)?.({ error: { code: "unavailable", message: written } });
		}
		return reply;
	}

	close(): void {
		this.state = "closed";
		this.reason = "closed";
		clearTimeout(this.retry);
		this.retry = undefined;
		for (const wake of [...this.readyWaiters]) wake();
		for (const resolve of this.replies.values()) resolve({ error: { code: "closed", message: "the bridge shut down" } });
		this.replies.clear();
		// end() still flushes lines already written, such as the final status.
		this.socket?.end();
		this.socket = undefined;
	}
}
