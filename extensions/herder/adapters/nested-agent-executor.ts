import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ManagerAction, UsageEvidence } from "../src/shared/protocol.ts";
import {
	loadHerderNestedAgent,
	type HerderNestedAgentDefinition,
	type HerderNestedAgentType,
} from "./role-config.ts";

export type HerderNestedAgentStatus = "running" | "completed" | "limited" | "aborted" | "stopped" | "error";

export interface PiNestedAgentSnapshot {
	agentId: string;
	displayName: string;
	type: HerderNestedAgentType;
	description: string;
	status: HerderNestedAgentStatus;
	model: string;
	effort: string;
	serviceTier?: string;
	startedAt: number;
	completedAt?: number;
	turns: number;
	maxTurns: number;
	toolUses: number;
	lifetimeTokens: number;
	contextPercent: number | null;
	compactionCount: number;
	activeTools: string[];
	responseText?: string;
	activity?: string;
	sessionId?: string;
}

export interface NestedAgentUsage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	reasoningKnown: boolean;
}

export interface NestedAgentResult {
	id: string;
	status: HerderNestedAgentStatus;
	output: string;
	error?: string;
	startedAt: number;
	completedAt: number;
	turnCount: number;
	maxTurns: number;
	toolUses: number;
	lifetimeTokens: number;
	contextPercent: number | null;
	compactionCount: number;
	sessionId?: string;
	usage: NestedAgentUsage;
}

export interface NestedAgentRunRequest {
	type: HerderNestedAgentType;
	prompt: string;
	description: string;
	maxTurns?: number;
}

export interface NestedAgentLaunch {
	id: string;
	snapshot: PiNestedAgentSnapshot;
}

export interface NestedAgentLookup {
	snapshot: PiNestedAgentSnapshot;
	result?: NestedAgentResult;
}

export interface NestedWorkerSession {
	readonly sessionId: string;
	readonly messages: readonly unknown[];
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string, options?: { expandPromptTemplates?: boolean; source?: "extension" }): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	getSessionStats(): SessionStats;
	turnLimitReached?(): boolean;
}

export interface NestedSessionCreateRequest {
	id: string;
	definition: HerderNestedAgentDefinition;
	maxTurns: number;
	signal: AbortSignal;
}

export type NestedSessionCreator = (request: NestedSessionCreateRequest) => Promise<NestedWorkerSession>;

type UpdateListener = (snapshots: readonly PiNestedAgentSnapshot[]) => void;

interface NestedRecord {
	snapshot: PiNestedAgentSnapshot;
	session?: NestedWorkerSession;
	activeToolCalls: Map<string, string>;
	promise: Promise<NestedAgentResult>;
	background: boolean;
	collected: boolean;
	result?: NestedAgentResult;
}

export const MAX_NESTED_CONCURRENCY_PER_ACTION = 4;
const DEFAULT_MAX_TURNS = 8;

function finiteCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function assistantText(value: unknown): string | undefined {
	const message = record(value);
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.map(record)
		.filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
		.map((item) => String(item.text))
		.join("\n");
	return text || undefined;
}

function responseActivity(text: string | undefined): string | undefined {
	const line = text?.split("\n").find((candidate) => candidate.trim())?.trim();
	if (!line) return undefined;
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function finalAssistantResult(messages: readonly unknown[]): { text?: string; error?: string; failed: boolean } {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = record(messages[index]);
		if (candidate?.role !== "assistant") continue;
		const content = Array.isArray(candidate.content) ? candidate.content : [];
		const text = content
			.map(record)
			.filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
			.map((item) => String(item.text))
			.join("\n");
		const stopReason = String(candidate.stopReason || "");
		const error = typeof candidate.errorMessage === "string" && candidate.errorMessage.trim()
			? candidate.errorMessage.trim()
			: undefined;
		return {
			...(text.trim() ? { text } : {}),
			...(error ? { error } : {}),
			failed: stopReason === "error" || stopReason === "aborted" || Boolean(error),
		};
	}
	return { failed: true, error: "Nested Herder agent returned no assistant result." };
}

function usageFromSession(session: NestedWorkerSession): NestedAgentUsage {
	const stats = session.getSessionStats();
	let reasoningTokens = 0;
	let reasoningKnown = false;
	for (const value of session.messages) {
		const message = record(value);
		if (message?.role !== "assistant") continue;
		const reasoning = finiteCount(record(message.usage)?.reasoning);
		if (reasoning === undefined) continue;
		reasoningKnown = true;
		reasoningTokens += reasoning;
	}
	return {
		inputTokens: stats.tokens.input,
		cachedInputTokens: stats.tokens.cacheRead,
		outputTokens: stats.tokens.output,
		reasoningTokens,
		reasoningKnown,
	};
}

function cloneSnapshot(snapshot: PiNestedAgentSnapshot): PiNestedAgentSnapshot {
	return { ...snapshot, activeTools: [...snapshot.activeTools] };
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	const abort = () => target.abort(source.reason);
	if (source.aborted) abort();
	else source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return await promise;
	signal.throwIfAborted();
	return await new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Nested result wait aborted."));
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export function mergeNestedUsage(
	parent: Partial<UsageEvidence>,
	nested: NestedAgentUsage,
): Partial<UsageEvidence> {
	const count = (value: number | null | undefined) => value ?? 0;
	return {
		...parent,
		inputTokens: count(parent.inputTokens) + nested.inputTokens,
		cachedInputTokens: count(parent.cachedInputTokens) + nested.cachedInputTokens,
		outputTokens: count(parent.outputTokens) + nested.outputTokens,
		...(parent.reasoningTokens !== undefined || nested.reasoningKnown
			? { reasoningTokens: count(parent.reasoningTokens) + nested.reasoningTokens }
			: {}),
		source: nested.inputTokens || nested.outputTokens || nested.cachedInputTokens || nested.reasoningKnown
			? "herder pi worker session plus direct nested child sessions"
			: parent.source,
	};
}

export class HerderNestedAgentScope {
	private readonly action: ManagerAction;
	private readonly agentRoot: string;
	private readonly createSession: NestedSessionCreator;
	private readonly records = new Map<string, NestedRecord>();
	private readonly pendingLaunches = new Set<Promise<NestedAgentLaunch>>();
	private readonly listeners = new Set<UpdateListener>();
	private readonly scopeController = new AbortController();
	private active = 0;
	private stopped = false;
	private usageTotals: NestedAgentUsage = {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		reasoningKnown: false,
	};

	constructor(options: {
		action: ManagerAction;
		agentRoot: string;
		createSession: NestedSessionCreator;
	}) {
		this.action = options.action;
		this.agentRoot = options.agentRoot;
		this.createSession = options.createSession;
	}

	onUpdate(listener: UpdateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshots(): PiNestedAgentSnapshot[] {
		return [...this.records.values()]
			.map((item) => cloneSnapshot(item.snapshot))
			.sort((left, right) => left.startedAt - right.startedAt || left.agentId.localeCompare(right.agentId));
	}

	usage(): NestedAgentUsage {
		return { ...this.usageTotals };
	}

	activeCount(): number { return this.active; }

	uncollectedBackgroundIds(): string[] {
		return [...this.records.values()]
			.filter((item) => item.background && !item.collected)
			.map((item) => item.snapshot.agentId);
	}

	private reserveConcurrency(): () => void {
		if (this.active >= MAX_NESTED_CONCURRENCY_PER_ACTION) {
			throw new Error(`A Herder role may run at most ${MAX_NESTED_CONCURRENCY_PER_ACTION} nested agents concurrently.`);
		}
		this.active += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active = Math.max(0, this.active - 1);
		};
	}

	private emitUpdate(): void {
		const snapshots = this.snapshots();
		for (const listener of this.listeners) listener(snapshots);
	}

	private refreshActivity(item: NestedRecord): void {
		item.snapshot.activeTools = [...item.activeToolCalls.values()];
		item.snapshot.activity = item.snapshot.activeTools[0] ?? responseActivity(item.snapshot.responseText);
	}

	private refreshContext(item: NestedRecord): void {
		if (!item.session) return;
		item.snapshot.contextPercent = item.session.getSessionStats().contextUsage?.percent ?? null;
	}

	private observe(item: NestedRecord, event: AgentSessionEvent): void {
		let changed = false;
		if (event.type === "turn_start") {
			item.snapshot.turns += 1;
			changed = true;
		} else if (event.type === "message_start" && event.message.role === "assistant") {
			delete item.snapshot.responseText;
			this.refreshActivity(item);
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			item.snapshot.responseText = (item.snapshot.responseText ?? "") + event.assistantMessageEvent.delta;
			this.refreshActivity(item);
		} else if (event.type === "tool_execution_start") {
			item.snapshot.toolUses += 1;
			item.activeToolCalls.set(event.toolCallId, event.toolName);
			this.refreshActivity(item);
			changed = true;
		} else if (event.type === "tool_execution_end") {
			item.activeToolCalls.delete(event.toolCallId);
			this.refreshActivity(item);
			changed = true;
		} else if (event.type === "compaction_start") {
			item.snapshot.activity = "compacting";
			changed = true;
		} else if (event.type === "compaction_end") {
			if (!event.aborted && event.result) item.snapshot.compactionCount += 1;
			this.refreshActivity(item);
			changed = true;
		}
		if (event.type === "message_end" && record(event.message)?.role === "assistant") {
			const usage = record(record(event.message)?.usage);
			if (usage) {
				item.snapshot.lifetimeTokens += (finiteCount(usage.input) ?? 0)
					+ (finiteCount(usage.output) ?? 0)
					+ (finiteCount(usage.cacheWrite) ?? 0);
			}
			const text = assistantText(event.message);
			if (text !== undefined) item.snapshot.responseText = text;
			this.refreshActivity(item);
			this.refreshContext(item);
			changed = true;
		} else if (event.type === "agent_end" || event.type === "agent_settled") {
			this.refreshContext(item);
			changed = true;
		}
		if (changed) this.emitUpdate();
	}

	async run(request: NestedAgentRunRequest, signal?: AbortSignal): Promise<NestedAgentResult> {
		const launch = await this.launch(request, false, signal);
		return (await this.result(launch.id, true, signal)).result!;
	}

	async spawnBackground(request: NestedAgentRunRequest, signal?: AbortSignal): Promise<NestedAgentLaunch> {
		return await this.launch(request, true, signal);
	}

	async result(agentId: string, wait: boolean, signal?: AbortSignal): Promise<NestedAgentLookup> {
		const item = this.records.get(agentId);
		if (!item) throw new Error(`Unknown Herder nested agent ${JSON.stringify(agentId)}.`);
		if (wait && !item.result) await waitWithSignal(item.promise, signal);
		if (item.result) item.collected = true;
		return {
			snapshot: cloneSnapshot(item.snapshot),
			...(item.result ? { result: item.result } : {}),
		};
	}

	private launch(request: NestedAgentRunRequest, background: boolean, signal?: AbortSignal): Promise<NestedAgentLaunch> {
		const pending = this.launchInternal(request, background, signal);
		this.pendingLaunches.add(pending);
		void pending.then(
			() => this.pendingLaunches.delete(pending),
			() => this.pendingLaunches.delete(pending),
		);
		return pending;
	}

	private async launchInternal(request: NestedAgentRunRequest, background: boolean, signal?: AbortSignal): Promise<NestedAgentLaunch> {
		if (this.stopped || this.scopeController.signal.aborted) throw new Error("Herder nested agent scope is closed.");
		signal?.throwIfAborted();
		const releaseConcurrency = this.reserveConcurrency();
		try {
			const definition = await loadHerderNestedAgent(this.agentRoot, request.type);
			if (this.action.role !== "plan-implementer" && !definition.readOnly) {
				throw new Error(`${this.action.role} may delegate only to package-owned read-only nested agent types; ${request.type} is mutation-capable.`);
			}
			const maxTurns = request.maxTurns ?? DEFAULT_MAX_TURNS;
			if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error("Nested Agent max_turns must be a positive integer.");
			const id = randomUUID();
			const startedAt = Date.now();
			const snapshot: PiNestedAgentSnapshot = {
				agentId: id,
				displayName: definition.name.charAt(0).toUpperCase() + definition.name.slice(1),
				type: definition.name,
				description: request.description,
				status: "running",
				model: this.action.model,
				effort: this.action.effort,
				serviceTier: this.action.serviceTier,
				startedAt,
				turns: 0,
				maxTurns,
				toolUses: 0,
				lifetimeTokens: 0,
				contextPercent: null,
				compactionCount: 0,
				activeTools: [],
			};
			const item: NestedRecord = {
				snapshot,
				activeToolCalls: new Map<string, string>(),
				promise: Promise.resolve({} as NestedAgentResult),
				background,
				collected: !background,
			};
			this.records.set(id, item);
			this.emitUpdate();
			item.promise = this.execute(item, { ...request, maxTurns }, definition, signal)
				.finally(releaseConcurrency);
			void item.promise.catch(() => {});
			return { id, snapshot: cloneSnapshot(snapshot) };
		} catch (error) {
			releaseConcurrency();
			throw error;
		}
	}

	private async execute(
		item: NestedRecord,
		request: NestedAgentRunRequest & { maxTurns: number },
		definition: HerderNestedAgentDefinition,
		signal?: AbortSignal,
	): Promise<NestedAgentResult> {
		const childController = new AbortController();
		const detachScope = forwardAbort(this.scopeController.signal, childController);
		const detachCall = forwardAbort(signal, childController);
		let unsubscribe = () => {};
		let detachSessionAbort = () => {};
		let failure: string | undefined;
		try {
			childController.signal.throwIfAborted();
			const session = await this.createSession({ id: item.snapshot.agentId, definition, maxTurns: request.maxTurns, signal: childController.signal });
			item.session = session;
			item.snapshot.sessionId = session.sessionId;
			if (session.messages.length !== 0) throw new Error("Herder nested agents require a session with zero inherited messages.");
			const abortSession = () => { void session.abort(); };
			if (childController.signal.aborted) await session.abort();
			else {
				childController.signal.addEventListener("abort", abortSession, { once: true });
				detachSessionAbort = () => childController.signal.removeEventListener("abort", abortSession);
			}
			childController.signal.throwIfAborted();
			unsubscribe = session.subscribe((event) => this.observe(item, event));
			await session.prompt(request.prompt, { expandPromptTemplates: false, source: "extension" });
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		try {
			const completedAt = Date.now();
			const final = item.session ? finalAssistantResult(item.session.messages) : { failed: true, error: failure || "Nested session was not created." };
			const aborted = childController.signal.aborted || this.scopeController.signal.aborted;
			const errors = [...new Set([failure, final.error].filter((value): value is string => Boolean(value)))];
			const turnLimited = item.session?.turnLimitReached?.() === true;
			item.snapshot.status = aborted
				? (this.stopped ? "stopped" : "aborted")
				: errors.length || final.failed ? "error" : turnLimited ? "limited" : "completed";
			item.snapshot.completedAt = completedAt;
			item.snapshot.activeTools = [];
			item.snapshot.activity = item.snapshot.status === "completed" ? "done" : item.snapshot.status;
			let usage: NestedAgentUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, reasoningKnown: false };
			if (item.session) {
				try { usage = usageFromSession(item.session); } catch { /* retain zero usage */ }
			}
			this.usageTotals.inputTokens += usage.inputTokens;
			this.usageTotals.cachedInputTokens += usage.cachedInputTokens;
			this.usageTotals.outputTokens += usage.outputTokens;
			this.usageTotals.reasoningTokens += usage.reasoningTokens;
			this.usageTotals.reasoningKnown ||= usage.reasoningKnown;
			this.emitUpdate();
			const result: NestedAgentResult = {
				id: item.snapshot.agentId,
				status: item.snapshot.status,
				output: final.text ?? "",
				...(errors.length ? { error: errors.join("\n") } : {}),
				startedAt: item.snapshot.startedAt,
				completedAt,
				turnCount: item.snapshot.turns,
				maxTurns: request.maxTurns,
				toolUses: item.snapshot.toolUses,
				lifetimeTokens: item.snapshot.lifetimeTokens,
				contextPercent: item.snapshot.contextPercent,
				compactionCount: item.snapshot.compactionCount,
				sessionId: item.snapshot.sessionId,
				usage,
			};
			item.result = result;
			return result;
		} finally {
			unsubscribe();
			detachSessionAbort();
			item.session?.dispose();
			detachScope();
			detachCall();
		}
	}

	async stop(reason = "Parent Herder action stopped"): Promise<void> {
		if (!this.stopped) {
			this.stopped = true;
			this.scopeController.abort(new Error(reason));
		}
		await Promise.allSettled([...this.pendingLaunches]);
		await Promise.allSettled([...this.records.values()].map((item) => item.promise));
	}
}
