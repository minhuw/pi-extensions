/** Test helpers: a fake daemon on a real unix socket, and a Pi extension harness. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { parseBridgeMessage, type BridgeMessage, type DaemonToBridge } from "../../../services/pika-node/src/protocol.ts";
import bridge from "../index.ts";
import { LineDecoder } from "../protocol.ts";

/** Polls until `check` holds. */
export async function until(check: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A short temporary directory (unix socket paths are limited to ~104 bytes on macOS). */
export function tempDir(): { path: string; cleanup: () => void } {
	const base = realpathSync(process.platform === "darwin" ? "/tmp" : tmpdir());
	const path = mkdtempSync(join(base, "pnb-"));
	return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

type Line = BridgeMessage & { connection: number };

/**
 * The daemon side of §5 on a real socket. Every line from the bridge must pass the daemon's own parser
 * (`services/pika-node/src/protocol.ts`); anything else lands in `invalid`.
 */
export class FakeDaemon {
	lines: Line[] = [];
	invalid: string[] = [];
	connections: Socket[] = [];
	panes = new Set(["pane-1"]);
	/** The reply to `open` / `diff`. */
	answer: (message: Extract<BridgeMessage, { type: "open" | "diff" }>) => DaemonToBridge | undefined = message => ({ type: "reply", id: message.id, result: { delivered: 1 } });
	/** Stop reading from bridges (a wedged daemon). */
	paused = false;
	readonly server: Server;

	constructor(readonly path: string) {
		this.server = createServer(socket => this.accept(socket));
	}

	listen(): Promise<void> {
		return new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.path, () => resolve()); });
	}

	private accept(socket: Socket): void {
		const connection = this.connections.push(socket) - 1;
		const decoder = new LineDecoder();
		const write = (message: DaemonToBridge) => socket.write(`${JSON.stringify(message)}\n`);
		if (this.paused) socket.pause();
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const line of decoder.push(chunk)) {
				const parsed = parseBridgeMessage(JSON.parse(line));
				if (!parsed.ok) { this.invalid.push(line); continue; }
				const message = parsed.message;
				this.lines.push({ ...message, connection });
				if (message.type === "hello") {
					if (message.role === "bridge" && this.panes.has(message.paneId)) write({ type: "welcome", version: "fake", protocolVersion: 1 });
					else { write({ type: "reply", id: "hello", error: { code: "not_found", message: "no live terminal" } }); socket.end(); }
				} else if (message.type === "open" || message.type === "diff") {
					const reply = this.answer(message);
					if (reply) write(reply);
				}
			}
		});
		socket.on("error", () => {});
	}

	statuses(): Array<Extract<BridgeMessage, { type: "status" }>["status"] & { connection: number }> {
		return this.lines.flatMap(line => line.type === "status" ? [{ ...line.status, connection: line.connection }] : []);
	}
	last() { return this.statuses().at(-1); }
	hellos() { return this.lines.filter(line => line.type === "hello"); }

	/** Drops every bridge connection, as a daemon restart does. */
	dropAll(): void { for (const socket of this.connections) socket.destroy(); }

	close(): Promise<void> {
		this.dropAll();
		return new Promise(resolve => this.server.close(() => resolve()));
	}
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
export class Bus {
	listeners = new Map<string, Set<(value: unknown) => void>>();
	emit(channel: string, value: unknown): void { for (const fn of [...this.listeners.get(channel) ?? []]) fn(value); }
	on(channel: string, fn: (value: unknown) => void): () => void {
		if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
		this.listeners.get(channel)!.add(fn);
		return () => { this.listeners.get(channel)?.delete(fn); };
	}
	// Pi hands each extension a distinct wrapper over the shared bus.
	wrapper() { return { on: this.on.bind(this), emit: this.emit.bind(this) }; }
}

export interface Session { id: string; name?: string; cwd: string; file?: string }

/** The extension loaded against a fake Pi API. */
export function harness(options: { bus?: Bus; mode?: string; session?: Session } = {}) {
	const bus = options.bus ?? new Bus();
	const session: Session = options.session ?? { id: "session-1", name: "My session", cwd: "/workspace/project" };
	const handlers = new Map<string, Set<Handler>>();
	const commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> }>();
	const notify = vi.fn();
	const sendUserMessage = vi.fn();
	const context = {
		mode: options.mode ?? "tui",
		get cwd() { return session.cwd; },
		ui: { notify },
		model: { provider: "magpie", id: "claude-opus-5-5" },
		sessionManager: {
			getSessionId: () => session.id,
			getSessionName: () => session.name,
			getCwd: () => session.cwd,
			getSessionFile: () => session.file,
		},
	} as unknown as ExtensionContext;
	const api = {
		events: bus.wrapper(),
		on(name: string, fn: Handler) {
			if (!handlers.has(name)) handlers.set(name, new Set());
			handlers.get(name)!.add(fn);
			return () => { handlers.get(name)?.delete(fn); };
		},
		registerCommand: (name: string, command: unknown) => commands.set(name, command as never),
		appendEntry: () => {},
		sendUserMessage,
	} as unknown as ExtensionAPI;
	bridge(api);
	return {
		bus, session, context, notify, sendUserMessage, handlers, commands,
		async fire(name: string, event: unknown = {}, ctx = context) {
			for (const fn of [...handlers.get(name) ?? []]) await fn(event, ctx);
		},
		command: (name: string, args: string) => commands.get(name)!.handler(args, context),
		snapshot(source: string, ...activities: Array<[string, string]>) {
			bus.emit("pi-extensions:activity", { source, activities: activities.map(([id, label]) => ({ id, label })) });
		},
	};
}
export type Harness = ReturnType<typeof harness>;
