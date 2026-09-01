import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runCommand } from "../../../../src/daemon/git-driver.ts";

export const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../assets/roles/pi");

export class Deferred<T = void> {
	readonly promise: Promise<T>;
	private resolvePromise!: (value: T | PromiseLike<T>) => void;

	constructor() {
		this.promise = new Promise<T>((resolve) => {
			this.resolvePromise = resolve;
		});
	}

	resolve(value: T): void {
		this.resolvePromise(value);
	}
}

export async function withDeadline<T>(operation: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		return await Promise.race([operation, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export const availableModels = [
	{
		provider: "fake",
		id: "gpt-5.6-sol",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
	{
		provider: "fake",
		id: "gpt-5.6-luna",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
] as const;

export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
	return value as Record<string, unknown>;
}

export interface CapturedEntry {
	customType: string;
	data: unknown;
}

export interface CapturedNotification {
	message: string;
	level: string;
}

export interface CapturedUserMessage {
	content: string;
	options?: unknown;
}

export interface CapturedCustomMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
	options?: unknown;
}

export class CapturedExtensionAPI {
	readonly commands = new Map<string, unknown>();
	readonly tools: unknown[] = [];
	readonly handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	readonly renderers: string[] = [];
	readonly appendedEntries: CapturedEntry[] = [];
	readonly userMessages: CapturedUserMessage[] = [];
	readonly customMessages: CapturedCustomMessage[] = [];
	readonly execCalls: Array<{ command: string; args: string[] }> = [];
	private readonly userMessageWaiters: Array<{ marker: string; after: number; deferred: Deferred<CapturedUserMessage> }> = [];
	private readonly customMessageWaiters: Array<Deferred<CapturedCustomMessage>> = [];

	on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown): void {
		this.handlers.set(event, handler);
	}

	registerCommand(name: string, options: unknown): void {
		this.commands.set(name, options);
	}

	registerTool(tool: unknown): void {
		this.tools.push(tool);
	}

	registerEntryRenderer(customType: string, _renderer: unknown): void {
		this.renderers.push(customType);
	}

	appendEntry(customType: string, data: unknown): void {
		this.appendedEntries.push({ customType, data });
	}

	sendUserMessage(content: string, options?: unknown): void {
		const message = { content, ...(options === undefined ? {} : { options }) };
		this.userMessages.push(message);
		for (let index = this.userMessageWaiters.length - 1; index >= 0; index -= 1) {
			const waiter = this.userMessageWaiters[index]!;
			if (this.userMessages.length <= waiter.after || !content.includes(waiter.marker)) continue;
			this.userMessageWaiters.splice(index, 1);
			waiter.deferred.resolve(message);
		}
	}

	sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: unknown): void {
		const captured = { ...message, ...(options === undefined ? {} : { options }) };
		this.customMessages.push(captured);
		while (this.customMessageWaiters.length) this.customMessageWaiters.shift()!.resolve(captured);
	}

	async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		this.execCalls.push({ command, args: [...args] });
		const result = runCommand(command, args, { allowFailure: true });
		return { code: result.status, stdout: result.stdout, stderr: result.stderr };
	}

	async invoke(event: string, ctx: ExtensionContext): Promise<unknown> {
		const handler = this.handlers.get(event);
		if (!handler) throw new Error(`No captured ${event} handler`);
		return await handler({}, ctx);
	}

	command(name: string): { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> } {
		const command = this.commands.get(name) as { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> } | undefined;
		if (!command) throw new Error(`No captured ${name} command`);
		return command;
	}

	tool(name: string): { execute: (...args: unknown[]) => Promise<unknown> } {
		const tool = this.tools.find((candidate) => (candidate as { name?: unknown }).name === name) as { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
		if (!tool) throw new Error(`No captured ${name} tool`);
		return tool;
	}

	async waitForUserMessage(after = 0, marker = "HERDER_MAIN_SESSION_VERIFICATION_V1"): Promise<CapturedUserMessage> {
		const existing = this.userMessages.slice(after).find((message) => message.content.includes(marker));
		if (existing) return existing;
		const deferred = new Deferred<CapturedUserMessage>();
		this.userMessageWaiters.push({ marker, after, deferred });
		return deferred.promise;
	}

	async waitForAttentionMessage(): Promise<CapturedCustomMessage> {
		const existing = this.customMessages.find((message) => message.customType === "herder-attention-v1");
		if (existing) return existing;
		const deferred = new Deferred<CapturedCustomMessage>();
		this.customMessageWaiters.push(deferred);
		return deferred.promise;
	}
}

export class CapturedUI {
	readonly notifications: CapturedNotification[] = [];
	readonly statuses: Array<{ id: string; value: unknown }> = [];
	readonly widgets: Array<{ id: string; value: unknown }> = [];
	readonly theme = {
		fg: (_color: string, value: string) => value,
		bold: (value: string) => value,
	};

	notify(message: string, level: string): void {
		this.notifications.push({ message, level });
	}

	setStatus(id: string, value: unknown): void {
		this.statuses.push({ id, value });
	}

	setWidget(id: string, value: unknown): void {
		this.widgets.push({ id, value });
	}

	async confirm(): Promise<boolean> {
		return true;
	}
}

export class BaseSession {
	readonly sessionId: string;
	readonly messages: unknown[] = [];
	disposed = false;
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.disposed = true;
	}

	protected emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
