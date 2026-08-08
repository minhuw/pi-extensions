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
	type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ManagerAction, UsageEvidence } from "../../src/shared/protocol.ts";
import {
	modelMatches,
	modelSupportsEffort,
	modelSupportsServiceTier,
	serviceTierRequestValue,
	type AvailableModel,
	type ThinkingEffort,
} from "./profile.ts";
import { loadHerderPiRole } from "./role-config.ts";

export type PiWorkerStatus = "prepared" | "running" | "stopping";

export interface PiWorkerSnapshot {
	handle: string;
	actionId: string;
	planId: string;
	role: ManagerAction["role"];
	model: string;
	effort: string;
	status: PiWorkerStatus;
	startedAt: number;
	turns: number;
	toolUses: number;
	tokens: number;
	activity?: string;
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
	unsubscribe: () => void;
	started: boolean;
	stopRequested: boolean;
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
	session.agent.streamFunction = (model, context, options) =>
		base(model, context, { ...options, serviceTier } as typeof options);
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

export function finalAssistantResult(messages: readonly unknown[]): { text?: string; error?: string; failed: boolean } {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const candidate = record(messages[index]);
		if (candidate?.role !== "assistant") continue;
		const content = Array.isArray(candidate.content) ? candidate.content : [];
		const text = content
			.map(record)
			.filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
			.map((item) => String(item.text))
			.join("\n")
			.trim();
		const stopReason = String(candidate.stopReason || "");
		const error = typeof candidate.errorMessage === "string" && candidate.errorMessage.trim()
			? candidate.errorMessage.trim()
			: undefined;
		return {
			...(text ? { text } : {}),
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
	private modelRuntime?: ModelRuntime;

	constructor(agentRoot: string, agentDir = getAgentDir()) {
		this.agentRoot = agentRoot;
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
		const { session } = await createAgentSession({
			cwd: request.action.worktree,
			agentDir: this.agentDir,
			modelRuntime: runtime,
			model,
			thinkingLevel: request.action.effort as ThinkingLevel,
			tools: definition.tools,
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
			.map((worker) => ({ ...worker.snapshot }))
			.sort((left, right) => left.startedAt - right.startedAt || left.handle.localeCompare(right.handle));
	}

	has(handle: string): boolean {
		return this.workers.has(handle);
	}

	private emitUpdate(): void {
		const snapshot = this.snapshots();
		for (const listener of this.updates) listener(snapshot);
	}

	private refreshStats(worker: WorkerRecord): void {
		const stats = worker.session.getSessionStats();
		worker.snapshot.tokens = stats.tokens.total;
	}

	private observe(worker: WorkerRecord, event: AgentSessionEvent): void {
		let changed = false;
		if (event.type === "agent_start") {
			worker.snapshot.status = "running";
			changed = true;
		} else if (event.type === "turn_start") {
			worker.snapshot.turns += 1;
			changed = true;
		}
		else if (event.type === "tool_execution_start") {
			worker.snapshot.toolUses += 1;
			worker.snapshot.activity = event.toolName;
			changed = true;
		} else if (event.type === "tool_execution_end") {
			if (worker.snapshot.activity === event.toolName) delete worker.snapshot.activity;
			changed = true;
		} else if (event.type === "compaction_start") {
			worker.snapshot.activity = "compacting";
			changed = true;
		} else if (event.type === "compaction_end" && worker.snapshot.activity === "compacting") {
			delete worker.snapshot.activity;
			changed = true;
		}
		if (event.type === "message_end" || event.type === "agent_end" || event.type === "agent_settled") {
			this.refreshStats(worker);
			changed = true;
		}
		if (changed) this.emitUpdate();
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
			role: request.action.role,
			model: request.action.model,
			effort: request.action.effort,
			status: "prepared",
			startedAt: Date.now(),
			turns: 0,
			toolUses: 0,
			tokens: 0,
		};
		const worker = {
			request,
			session,
			snapshot,
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
		void this.run(handle, worker);
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
		const terminal: PiWorkerTerminal = {
			handle,
			actionId: worker.request.action.actionId,
			planDirectory: worker.request.planDirectory,
			...(result.text ? { response: result.text } : {}),
			...(interrupted ? { interrupted: true } : {}),
			...(interrupted ? { error: failure || result.error || (worker.stopRequested ? "Pi worker stopped" : "Pi worker produced no terminal result") } : {}),
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
