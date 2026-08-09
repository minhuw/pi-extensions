import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ManagerAction, UsageEvidence } from "../src/shared/protocol.ts";
import type { SubagentTelemetry } from "../../subagents/src/host-registry.ts";
import {
	modelMatches,
	modelSupportsEffort,
	modelSupportsServiceTier,
	serviceTierRequestValue,
	type AvailableModel,
	type ThinkingEffort,
} from "./profile.ts";
import { createNestedAgentTool } from "./nested-agent-tool.ts";
import { loadHerderPiRole } from "./role-config.ts";

export type PiWorkerStatus = "prepared" | "running" | "stopping";

export interface PiNestedAgentSnapshot {
	agentId: string;
	parentAgentId?: string;
	displayName: string;
	type: string;
	description: string;
	status: SubagentTelemetry["status"];
	model?: string;
	effort?: string;
	serviceTier?: string;
	startedAt: number;
	completedAt?: number;
	turns: number;
	maxTurns?: number;
	toolUses: number;
	lifetimeTokens: number;
	contextPercent: number | null;
	compactionCount: number;
	activeTools: string[];
	responseText?: string;
	activity?: string;
	parentSessionId?: string;
	sessionId?: string;
	children: PiNestedAgentSnapshot[];
}

export interface PiWorkerSnapshot {
	handle: string;
	actionId: string;
	planId: string;
	round: number;
	role: ManagerAction["role"];
	model: string;
	effort: string;
	serviceTier?: string;
	status: PiWorkerStatus;
	startedAt: number;
	turns: number;
	toolUses: number;
	lifetimeTokens: number;
	contextPercent: number | null;
	compactionCount: number;
	activeTools: string[];
	responseText?: string;
	activity?: string;
	children: PiNestedAgentSnapshot[];
}

export interface PiWorkerTerminal {
	handle: string;
	actionId: string;
	planDirectory: string;
	response?: string;
	interrupted?: boolean;
	error?: string;
	usage: Partial<UsageEvidence>;
}

export interface PiWorkerRequest {
	action: ManagerAction;
	planDirectory: string;
}

interface WorkerSession {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly messages: readonly unknown[];
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string, options?: { expandPromptTemplates?: boolean; source?: "extension" }): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	getSessionStats(): SessionStats;
}

export interface PiWorkerSessionFactory {
	availableModels(): Promise<readonly AvailableModel[]>;
	create(request: PiWorkerRequest): Promise<WorkerSession>;
}

interface WorkerRecord {
	request: PiWorkerRequest;
	session: WorkerSession;
	snapshot: PiWorkerSnapshot;
	activeToolCalls: Map<string, string>;
	unsubscribe: () => void;
	started: boolean;
	stopRequested: boolean;
	completion?: Promise<void>;
}

type UpdateListener = (workers: readonly PiWorkerSnapshot[]) => void;
type TerminalListener = (terminal: PiWorkerTerminal) => void | Promise<void>;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Pins every request of a worker session to the profile's exact service tier by
 * wrapping the agent stream function. Herder never downgrades a tier silently.
 */
export function applyServiceTier(session: AgentSession, tier: string): void {
	const serviceTier = serviceTierRequestValue(tier);
	const base = session.agent.streamFunction;
	session.agent.streamFunction = (model, context, options) => {
		const previousOnPayload = options?.onPayload;
		return base(model, context, {
			...options,
			serviceTier,
			onPayload: async (payload, payloadModel) => {
				const transformed = await previousOnPayload?.(payload, payloadModel);
				const finalPayload = transformed === undefined ? payload : transformed;
				if (!finalPayload || typeof finalPayload !== "object" || Array.isArray(finalPayload)) {
					throw new Error("Herder cannot pin a service tier on a non-object provider payload.");
				}
				return { ...finalPayload, service_tier: serviceTier };
			},
		} as typeof options);
	};
}

function roleFromAgentType(agentType: string): ManagerAction["role"] {
	const role = agentType.startsWith("herder.") ? agentType.slice("herder.".length) : agentType;
	if (!new Set(["plan-implementer", "plan-reviewer", "plan-judge"]).has(role)) {
		throw new Error(`Unknown Herder Pi role ${JSON.stringify(agentType)}.`);
	}
	return role as ManagerAction["role"];
}

function finiteCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function responseActivity(text: string | undefined): string | undefined {
	const line = text?.split("\n").find((candidate) => candidate.trim())?.trim();
	if (!line) return undefined;
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
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

function cloneNested(agent: PiNestedAgentSnapshot): PiNestedAgentSnapshot {
	return { ...agent, activeTools: [...agent.activeTools], children: agent.children.map(cloneNested) };
}

const TELEMETRY_PHASES = new Set(["started", "updated", "compacted", "completed"]);
const TELEMETRY_STATUSES = new Set(["queued", "running", "completed", "steered", "aborted", "stopped", "error"]);

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function optionalFiniteCount(value: unknown): value is number | undefined {
	return value === undefined || finiteCount(value) !== undefined;
}

function validSubagentTelemetry(value: unknown): value is SubagentTelemetry {
	const telemetry = record(value);
	if (!telemetry || telemetry.owner !== "herder") return false;
	if (typeof telemetry.phase !== "string" || !TELEMETRY_PHASES.has(telemetry.phase)) return false;
	if (typeof telemetry.status !== "string" || !TELEMETRY_STATUSES.has(telemetry.status)) return false;
	for (const field of ["rootActionId", "agentId", "displayName", "type", "description"] as const) {
		if (typeof telemetry[field] !== "string" || telemetry[field].trim().length === 0) return false;
	}
	for (const field of ["planId", "parentAgentId", "model", "thinking", "serviceTier", "activity", "responseText", "parentSessionId", "sessionId"] as const) {
		if (!optionalString(telemetry[field])) return false;
	}
	if (telemetry.parentAgentId === telemetry.agentId) return false;
	for (const field of ["turnCount", "maxTurns", "toolUses", "lifetimeTokens", "compactionCount", "completedAt"] as const) {
		if (!optionalFiniteCount(telemetry[field])) return false;
	}
	if (finiteCount(telemetry.turnCount) === undefined
		|| finiteCount(telemetry.toolUses) === undefined
		|| finiteCount(telemetry.lifetimeTokens) === undefined
		|| finiteCount(telemetry.compactionCount) === undefined
		|| finiteCount(telemetry.startedAt) === undefined) return false;
	if (telemetry.contextPercent !== null
		&& (typeof telemetry.contextPercent !== "number" || !Number.isFinite(telemetry.contextPercent) || telemetry.contextPercent < 0)) return false;
	if (!Array.isArray(telemetry.activeTools) || telemetry.activeTools.some((tool) => typeof tool !== "string" || tool.length === 0)) return false;
	return true;
}

export function finalAssistantResult(messages: readonly unknown[]): { text?: string; error?: string; failed: boolean } {
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
	return { failed: true, error: "Pi worker returned no assistant result." };
}

function reasoningTokens(messages: readonly unknown[]): number | undefined {
	let total = 0;
	let known = false;
	for (const value of messages) {
		const assistant = record(value);
		if (assistant?.role !== "assistant") continue;
		const reasoning = finiteCount(record(assistant.usage)?.reasoning);
		if (reasoning === undefined) continue;
		known = true;
		total += reasoning;
	}
	return known ? total : undefined;
}

function usageEvidence(session: WorkerSession, startedAt: number, finishedAt: number): Partial<UsageEvidence> {
	const stats = session.getSessionStats();
	const reasoning = reasoningTokens(session.messages);
	return {
		inputTokens: stats.tokens.input,
		cachedInputTokens: stats.tokens.cacheRead,
		outputTokens: stats.tokens.output,
		...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
		source: "herder pi worker session",
		startedAt: new Date(startedAt).toISOString(),
		finishedAt: new Date(finishedAt).toISOString(),
		durationMs: Math.max(0, finishedAt - startedAt),
	};
}

export class DefaultPiWorkerSessionFactory implements PiWorkerSessionFactory {
	private readonly agentRoot: string;
	private readonly agentDir: string;
	private readonly pi: ExtensionAPI;
	private modelRuntime?: ModelRuntime;

	constructor(agentRoot: string, pi: ExtensionAPI, agentDir = getAgentDir()) {
		this.agentRoot = agentRoot;
		this.pi = pi;
		this.agentDir = agentDir;
	}

	bindModelRegistry(registry: ModelRegistry): void {
		const runtime = (registry as unknown as { runtime?: unknown }).runtime;
		if (!runtime || typeof runtime !== "object"
			|| typeof (runtime as { getAvailable?: unknown }).getAvailable !== "function"
			|| typeof (runtime as { getModel?: unknown }).getModel !== "function") {
			throw new Error("This Pi version does not expose its canonical model runtime to extensions.");
		}
		this.modelRuntime = runtime as ModelRuntime;
	}

	private runtime(): ModelRuntime {
		if (!this.modelRuntime) throw new Error("Herder Pi worker engine has not been bound to the host model runtime.");
		return this.modelRuntime;
	}

	async availableModels(): Promise<readonly AvailableModel[]> {
		return await this.runtime().getAvailable();
	}

	async create(request: PiWorkerRequest): Promise<AgentSession> {
		const role = roleFromAgentType(request.action.agentType);
		if (role !== request.action.role) throw new Error(`Action role ${request.action.role} does not match ${request.action.agentType}.`);
		const definition = await loadHerderPiRole(this.agentRoot, role);
		const runtime = this.runtime();
		const available = await runtime.getAvailable();
		const model = available.find((candidate) => modelMatches(request.action.model, candidate));
		if (!model) throw new Error(`Pi worker model ${request.action.model} is unavailable.`);
		if (!modelSupportsEffort(model, request.action.effort as ThinkingEffort)) {
			throw new Error(`Pi worker model ${request.action.model} does not support thinking ${request.action.effort}.`);
		}
		if (request.action.serviceTier && !modelSupportsServiceTier(model)) {
			throw new Error(`Pi worker model ${request.action.model} (${model.api || "unknown api"}) does not support service tier ${request.action.serviceTier}.`);
		}

		const sessionRoot = path.join(request.planDirectory, ".herder", "pi-sessions");
		await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
		const sessionManager = SessionManager.create(request.action.worktree, sessionRoot);
		if (sessionManager.getHeader()?.parentSession) throw new Error("Herder Pi workers cannot inherit a parent session.");
		const resourceLoader = new DefaultResourceLoader({
			cwd: request.action.worktree,
			agentDir: this.agentDir,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPromptOverride: () => definition.systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		const agentTool = createNestedAgentTool(this.pi, request.action);
		const { session } = await createAgentSession({
			cwd: request.action.worktree,
			agentDir: this.agentDir,
			modelRuntime: runtime,
			model,
			thinkingLevel: request.action.effort as ThinkingLevel,
			tools: definition.tools,
			customTools: [agentTool],
			resourceLoader,
			sessionManager,
		});
		if (session.messages.length !== 0) {
			session.dispose();
			throw new Error("Herder Pi worker session was not created with clean history.");
		}
		if (request.action.serviceTier) applyServiceTier(session, request.action.serviceTier);
		return session;
	}
}

export class PiWorkerEngine {
	private readonly factory: PiWorkerSessionFactory;
	private readonly workers = new Map<string, WorkerRecord>();
	private readonly updates = new Set<UpdateListener>();
	private readonly terminals = new Set<TerminalListener>();

	constructor(factory: PiWorkerSessionFactory) {
		this.factory = factory;
	}

	availableModels(): Promise<readonly AvailableModel[]> {
		return this.factory.availableModels();
	}

	onUpdate(listener: UpdateListener): () => void {
		this.updates.add(listener);
		return () => this.updates.delete(listener);
	}

	onTerminal(listener: TerminalListener): () => void {
		this.terminals.add(listener);
		return () => this.terminals.delete(listener);
	}

	snapshots(): PiWorkerSnapshot[] {
		return [...this.workers.values()]
			.map((worker) => ({
				...worker.snapshot,
				activeTools: [...worker.snapshot.activeTools],
				children: worker.snapshot.children.map(cloneNested),
			}))
			.sort((left, right) => left.startedAt - right.startedAt || left.handle.localeCompare(right.handle));
	}

	has(handle: string): boolean {
		return this.workers.has(handle);
	}

	private emitUpdate(): void {
		const snapshot = this.snapshots();
		for (const listener of this.updates) listener(snapshot);
	}

	private refreshContext(worker: WorkerRecord): void {
		const stats = worker.session.getSessionStats();
		worker.snapshot.contextPercent = stats.contextUsage?.percent ?? null;
	}

	private addLifetimeUsage(snapshot: Pick<PiWorkerSnapshot, "lifetimeTokens">, usage: unknown): void {
		const value = record(usage);
		if (!value) return;
		snapshot.lifetimeTokens += (finiteCount(value.input) ?? 0) + (finiteCount(value.output) ?? 0) + (finiteCount(value.cacheWrite) ?? 0);
	}

	private syncTopActivity(worker: WorkerRecord): void {
		worker.snapshot.activeTools = [...worker.activeToolCalls.values()];
		worker.snapshot.activity = worker.snapshot.activeTools[0] ?? responseActivity(worker.snapshot.responseText);
	}

	private observe(worker: WorkerRecord, event: AgentSessionEvent): void {
		let changed = false;
		if (event.type === "agent_start") {
			worker.snapshot.status = "running";
			changed = true;
		} else if (event.type === "turn_start") {
			worker.snapshot.turns += 1;
			changed = true;
		} else if (event.type === "message_start" && event.message.role === "assistant") {
			delete worker.snapshot.responseText;
			this.syncTopActivity(worker);
		} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			worker.snapshot.responseText = (worker.snapshot.responseText ?? "") + event.assistantMessageEvent.delta;
			this.syncTopActivity(worker);
			// Keep token streaming cheap; the next meaningful state/stat event emits.
		} else if (event.type === "tool_execution_start") {
			worker.snapshot.toolUses += 1;
			worker.activeToolCalls.set(event.toolCallId, event.toolName);
			this.syncTopActivity(worker);
			changed = true;
		} else if (event.type === "tool_execution_end") {
			worker.activeToolCalls.delete(event.toolCallId);
			this.syncTopActivity(worker);
			changed = true;
		} else if (event.type === "compaction_start") {
			worker.snapshot.activity = "compacting";
			changed = true;
		} else if (event.type === "compaction_end") {
			if (!event.aborted && event.result) worker.snapshot.compactionCount += 1;
			this.syncTopActivity(worker);
			changed = true;
		}
		if (event.type === "message_end" && record(event.message)?.role === "assistant") {
			this.addLifetimeUsage(worker.snapshot, record(event.message)?.usage);
			const text = assistantText(event.message);
			if (text !== undefined) worker.snapshot.responseText = text;
			this.syncTopActivity(worker);
			this.refreshContext(worker);
			changed = true;
		} else if (event.type === "agent_end" || event.type === "agent_settled") {
			this.refreshContext(worker);
			changed = true;
		}
		if (changed) this.emitUpdate();
	}

	private findNested(children: PiNestedAgentSnapshot[], agentId: string): PiNestedAgentSnapshot | undefined {
		for (const child of children) {
			if (child.agentId === agentId) return child;
			const nested = this.findNested(child.children, agentId);
			if (nested) return nested;
		}
		return undefined;
	}

	private applyNestedTelemetry(target: PiNestedAgentSnapshot, telemetry: SubagentTelemetry): void {
		target.parentAgentId = telemetry.parentAgentId;
		target.displayName = telemetry.displayName;
		target.type = telemetry.type;
		target.description = telemetry.description;
		target.status = telemetry.status;
		target.model = telemetry.model;
		target.effort = telemetry.thinking;
		target.serviceTier = telemetry.serviceTier;
		target.startedAt = telemetry.startedAt;
		target.completedAt = telemetry.completedAt;
		target.turns = telemetry.turnCount;
		target.maxTurns = telemetry.maxTurns;
		target.toolUses = telemetry.toolUses;
		target.lifetimeTokens = telemetry.lifetimeTokens;
		target.contextPercent = telemetry.contextPercent;
		target.compactionCount = telemetry.compactionCount;
		target.activeTools = [...telemetry.activeTools];
		target.responseText = telemetry.responseText;
		target.activity = telemetry.activity;
		target.parentSessionId = telemetry.parentSessionId;
		target.sessionId = telemetry.sessionId;
	}

	/** Attach live subagent telemetry to its active Herder root worker. */
	acceptSubagentTelemetry(value: unknown): void {
		if (!validSubagentTelemetry(value)) return;
		const telemetry = value;
		const worker = [...this.workers.values()].find((candidate) =>
			candidate.request.action.actionId === telemetry.rootActionId
			&& (!telemetry.planId || candidate.request.action.planId === telemetry.planId));
		if (!worker) return;
		const existing = this.findNested(worker.snapshot.children, telemetry.agentId);
		if (existing) {
			this.applyNestedTelemetry(existing, telemetry);
			this.emitUpdate();
			return;
		}
		let siblings = worker.snapshot.children;
		if (telemetry.parentAgentId) {
			const parent = this.findNested(worker.snapshot.children, telemetry.parentAgentId);
			if (!parent) return;
			siblings = parent.children;
		}
		const nested: PiNestedAgentSnapshot = {
			agentId: telemetry.agentId,
			displayName: telemetry.displayName,
			type: telemetry.type,
			description: telemetry.description,
			status: telemetry.status,
			startedAt: telemetry.startedAt,
			turns: telemetry.turnCount,
			toolUses: telemetry.toolUses,
			lifetimeTokens: telemetry.lifetimeTokens,
			contextPercent: telemetry.contextPercent,
			compactionCount: telemetry.compactionCount,
			activeTools: [...telemetry.activeTools],
			children: [],
		};
		this.applyNestedTelemetry(nested, telemetry);
		siblings.push(nested);
		siblings.sort((left, right) => left.startedAt - right.startedAt || left.agentId.localeCompare(right.agentId));
		this.emitUpdate();
	}

	async prepare(request: PiWorkerRequest): Promise<string> {
		if ([...this.workers.values()].some((worker) => worker.request.action.actionId === request.action.actionId)) {
			throw new Error(`Pi worker action ${request.action.actionId} is already prepared.`);
		}
		const session = await this.factory.create(request);
		if (session.messages.length !== 0) {
			session.dispose();
			throw new Error("Herder Pi workers require a session with zero inherited messages.");
		}
		const handle = `pi-worker:${session.sessionId}`;
		if (this.workers.has(handle)) {
			session.dispose();
			throw new Error(`Duplicate Pi worker session ${session.sessionId}.`);
		}
		const snapshot: PiWorkerSnapshot = {
			handle,
			actionId: request.action.actionId,
			planId: request.action.planId,
			round: request.action.round,
			role: request.action.role,
			model: request.action.model,
			effort: request.action.effort,
			serviceTier: request.action.serviceTier,
			status: "prepared",
			startedAt: Date.now(),
			turns: 0,
			toolUses: 0,
			lifetimeTokens: 0,
			contextPercent: null,
			compactionCount: 0,
			activeTools: [],
			children: [],
		};
		const worker = {
			request,
			session,
			snapshot,
			activeToolCalls: new Map(),
			unsubscribe: () => {},
			started: false,
			stopRequested: false,
		} satisfies WorkerRecord;
		worker.unsubscribe = session.subscribe((event) => this.observe(worker, event));
		this.workers.set(handle, worker);
		this.emitUpdate();
		return handle;
	}

	start(handle: string): void {
		const worker = this.workers.get(handle);
		if (!worker) throw new Error(`Unknown Pi worker ${handle}.`);
		if (worker.started) return;
		worker.started = true;
		worker.snapshot.status = "running";
		this.emitUpdate();
		worker.completion = this.run(handle, worker);
		void worker.completion.catch(() => {});
	}

	async discard(handle: string): Promise<void> {
		const worker = this.workers.get(handle);
		if (!worker) return;
		if (worker.started) throw new Error(`Cannot discard running Pi worker ${handle}.`);
		worker.unsubscribe();
		worker.session.dispose();
		this.workers.delete(handle);
		this.emitUpdate();
	}

	async stop(handle: string): Promise<void> {
		const worker = this.workers.get(handle);
		if (!worker) return;
		worker.stopRequested = true;
		worker.snapshot.status = "stopping";
		this.emitUpdate();
		if (!worker.started) {
			await this.discard(handle);
			return;
		}
		await worker.session.abort();
		await worker.completion?.catch(() => {});
	}

	private async run(handle: string, worker: WorkerRecord): Promise<void> {
		let failure: string | undefined;
		try {
			await worker.session.prompt(worker.request.action.prompt, { expandPromptTemplates: false, source: "extension" });
		} catch (error) {
			failure = message(error);
		}
		const finishedAt = Date.now();
		const result = finalAssistantResult(worker.session.messages);
		const interrupted = worker.stopRequested || Boolean(failure) || result.failed || !result.text;
		const errors = [...new Set([failure, result.error].filter((value): value is string => Boolean(value)))];
		const terminal: PiWorkerTerminal = {
			handle,
			actionId: worker.request.action.actionId,
			planDirectory: worker.request.planDirectory,
			...(result.text ? { response: result.text } : {}),
			...(interrupted ? { interrupted: true } : {}),
			...(interrupted ? { error: errors.join("\n") || (worker.stopRequested ? "Pi worker stopped" : "Pi worker produced no terminal result") } : {}),
			usage: usageEvidence(worker.session, worker.snapshot.startedAt, finishedAt),
		};
		try {
			await Promise.all([...this.terminals].map((listener) => listener(terminal)));
		} finally {
			worker.unsubscribe();
			worker.session.dispose();
			this.workers.delete(handle);
			this.emitUpdate();
		}
	}
}
