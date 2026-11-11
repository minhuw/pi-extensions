// A ProcessManager double and a minimal ExtensionAPI double for the facade tests.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { MANAGER_KEY } from "../../src/state.ts";
import type { LogQuery, ManagerOptions, ProcessEvent, ProcessInfo, ProcessManager, StartOptions, WaitOptions } from "../../src/types.ts";

export function info(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
	return {
		id: "p_1",
		name: "dev",
		command: "npm run dev",
		cwd: "/tmp",
		owner: "session-a",
		pid: 4242,
		status: "starting",
		startedAt: 1_000,
		urls: [],
		logPath: "/logs/p_1.log",
		logBytes: 0,
		restarts: 0,
		attached: false,
		...overrides,
	};
}

export class FakeManager implements ProcessManager {
	readonly listeners = new Set<(event: ProcessEvent) => void>();
	readonly starts: StartOptions[] = [];
	readonly waits: { idOrName: string; options: WaitOptions }[] = [];
	readonly cancelled: string[] = [];
	processes: ProcessInfo[] = [];
	shutdowns = 0;
	killed = 0;
	reused = false;
	private nextWait = 0;

	constructor(readonly options?: ManagerOptions) {}

	async start(options: StartOptions) {
		this.starts.push(options);
		const process = info({ name: options.name ?? "dev", command: options.command, cwd: options.cwd, owner: options.owner, status: options.ready === false ? "running" : "starting" });
		this.processes.push(process);
		return { process, reused: this.reused };
	}
	list() {
		return this.processes;
	}
	get(idOrName: string) {
		const found = this.processes.find((p) => p.id === idOrName || p.name === idOrName);
		if (!found) throw new Error(`Unknown process ${idOrName}`);
		return found;
	}
	async logs(_idOrName: string, _query?: LogQuery) {
		return { lines: ["one", "two"], nextCursor: 8, truncated: false, more: true };
	}
	async stop(idOrName: string) {
		const process = this.get(idOrName);
		const stopped = { ...process, status: "stopped" as const, signal: "SIGTERM", endedAt: process.startedAt + 5_000 };
		this.emit({ type: "exit", process: stopped, requested: true, tail: [] });
		return { process: stopped, outcome: "terminated" as const };
	}
	async restart(idOrName: string) {
		const { process } = await this.stop(idOrName);
		return { ...process, status: "starting" as const, restarts: process.restarts + 1 };
	}
	wait(idOrName: string, options: WaitOptions) {
		this.waits.push({ idOrName, options });
		return `w_${++this.nextWait}`;
	}
	detach(idOrName: string) {
		const process = this.get(idOrName);
		process.attached = false;
		return process;
	}
	discard(idOrName: string) {
		this.processes = this.processes.filter((p) => p !== this.get(idOrName));
	}
	cancelWait(waitId: string) {
		this.cancelled.push(waitId);
		return true;
	}
	clear() {
		return 0;
	}
	subscribe(listener: (event: ProcessEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	killAllSync() {
		this.killed++;
	}
	async shutdown() {
		this.shutdowns++;
	}
	emit(event: ProcessEvent) {
		for (const listener of this.listeners) listener(event);
	}
}

type Handler = (event: any, ctx: any) => unknown;

export interface FakePi {
	api: ExtensionAPI;
	tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
	commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
	handlers: Map<string, Handler[]>;
	sent: { message: any; options: any }[];
	busEmits: { channel: string; data: unknown }[];
	bus: { on(channel: string, handler: (data: unknown) => void): () => void; emit(channel: string, data: unknown): void };
	fire(event: string, payload: unknown, ctx: unknown): Promise<unknown[]>;
}

/** A shared event bus, as Pi gives every extension of one runtime. */
export function createBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const emits: { channel: string; data: unknown }[] = [];
	return {
		emits,
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			handlers.set(channel, set);
			set.add(handler);
			return () => set.delete(handler);
		},
		emit(channel: string, data: unknown) {
			emits.push({ channel, data });
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
}

export function createPi(bus = createBus()): FakePi {
	const fake: FakePi = {
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		sent: [],
		busEmits: bus.emits,
		bus,
		api: undefined as unknown as ExtensionAPI,
		async fire(event, payload, ctx) {
			const results = [];
			for (const handler of fake.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
			return results;
		},
	};
	fake.api = {
		registerTool: (tool: any) => fake.tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => fake.commands.set(name, command),
		registerMessageRenderer: vi.fn(),
		on: (event: string, handler: Handler) => fake.handlers.set(event, [...(fake.handlers.get(event) ?? []), handler]),
		sendMessage: (message: unknown, options: unknown) => fake.sent.push({ message, options }),
		events: bus,
	} as unknown as ExtensionAPI;
	return fake;
}

export function createCtx(sessionId: string, overrides: Record<string, unknown> = {}) {
	return {
		cwd: process.cwd(),
		mode: "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
		ui: { notify: vi.fn(), select: vi.fn(), confirm: vi.fn(), custom: vi.fn() },
		...overrides,
	};
}

export function resetShared(): void {
	delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
}
