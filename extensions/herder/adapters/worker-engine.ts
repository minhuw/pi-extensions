import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultPackageManager,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type SessionStats,
} from "@earendil-works/pi-coding-agent";
import type { ManagerAction, UsageEvidence } from "../src/shared/protocol.ts";
import {
	modelMatches,
	modelSupportsEffort,
	modelSupportsServiceTier,
	serviceTierRequestValue,
	type AvailableModel,
	type ThinkingEffort,
} from "./profile.ts";
import {
	HerderNestedAgentScope,
	mergeNestedUsage,
	type NestedWorkerSession,
	type PiNestedAgentSnapshot,
} from "./nested-agent-executor.ts";
import { createNestedAgentTools } from "./nested-agent-tool.ts";
import { loadHerderPiRole } from "./role-config.ts";

export type PiWorkerStatus = "prepared" | "running" | "stopping";
export type { PiNestedAgentSnapshot } from "./nested-agent-executor.ts";

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
	readonly messages: readonly unknown[];
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string, options?: { expandPromptTemplates?: boolean; source?: "extension" }): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	getSessionStats(): SessionStats;
}

export interface PreparedWorkerSession {
	session: WorkerSession;
	nested: HerderNestedAgentScope;
}

export interface PiWorkerSessionFactory {
	availableModels(): Promise<readonly AvailableModel[]>;
	create(request: PiWorkerRequest): Promise<PreparedWorkerSession>;
}

interface WorkerRecord {
	request: PiWorkerRequest;
	session: WorkerSession;
	nested: HerderNestedAgentScope;
	snapshot: PiWorkerSnapshot;
	activeToolCalls: Map<string, string>;
	unsubscribe: () => void;
	unsubscribeNested: () => void;
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

const SEARCHER_TOOL_NAMES = new Set(["web_search", "source_check", "fetch_content", "get_search_content"]);

export function applySearcherToolPolicy(toolName: string, rawInput: unknown): { block: true; reason: string } | undefined {
	if (!SEARCHER_TOOL_NAMES.has(toolName)) return { block: true, reason: `Herder searcher cannot call unexpected tool ${toolName}.` };
	const input = record(rawInput);
	if (!input) return undefined;
	// Apply by capability envelope rather than assumed semantic name: pi-web-access
	// permits configured tool-name swaps, so every allowed call gets both guards.
	input.workflow = "none";
	const values = [input.url, ...(Array.isArray(input.urls) ? input.urls : [])]
		.filter((value): value is string => typeof value === "string");
	if (values.some((value) => /^(?:file:|\/|\.\.?\/)/i.test(value.trim()))) {
		return { block: true, reason: "Herder searcher may fetch only remote URLs." };
	}
	return undefined;
}

export function trustedNestedExtensionPath(agentDir: string, installed: string, source: string): string {
	const trustedRoot = path.join(agentDir, "npm");
	const realRoot = realpathSync(trustedRoot);
	const realInstalled = realpathSync(installed);
	const relative = path.relative(realRoot, realInstalled);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Herder nested extension ${source} resolves outside the trusted user package store.`);
	}
	return realInstalled;
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
	return { ...agent, activeTools: [...agent.activeTools] };
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
	private readonly nestedExtensionPaths = new Map<string, string>();
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

	private resolveNestedExtensionPaths(sources: readonly string[], cwd: string): string[] {
		if (sources.length === 0) return [];
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		const packageManager = new DefaultPackageManager({ cwd, agentDir: this.agentDir, settingsManager });
		return sources.map((source) => {
			const cacheKey = `${cwd}\0${source}`;
			const cached = this.nestedExtensionPaths.get(cacheKey);
			if (cached && existsSync(cached)) return cached;
			const installed = packageManager.getInstalledPath(source, "user");
			if (!installed || !existsSync(installed)) {
				throw new Error(`Herder nested extension ${source} is not installed in the trusted user package store. Install it explicitly with: pi install ${source}`);
			}
			const trusted = trustedNestedExtensionPath(this.agentDir, installed, source);
			this.nestedExtensionPaths.set(cacheKey, trusted);
			return trusted;
		});
	}

	async create(request: PiWorkerRequest): Promise<PreparedWorkerSession> {
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
		const nestedRoot = path.join(sessionRoot, "nested", request.action.actionId.replace(/[^A-Za-z0-9._-]+/g, "_"));
		const nested = new HerderNestedAgentScope({
			action: request.action,
			agentRoot: this.agentRoot,
			createSession: async ({ id, definition: childDefinition, signal }) => {
				signal.throwIfAborted();
				const extensionPaths = this.resolveNestedExtensionPaths(childDefinition.extensions, request.action.worktree);
				const childRoot = path.join(nestedRoot, id);
				await mkdir(childRoot, { recursive: true, mode: 0o700 });
				signal.throwIfAborted();
				const childManager = SessionManager.create(request.action.worktree, childRoot);
				if (childManager.getHeader()?.parentSession) throw new Error("Herder nested agents cannot inherit a parent session.");
				const childLoader = new DefaultResourceLoader({
					cwd: request.action.worktree,
					agentDir: this.agentDir,
					additionalExtensionPaths: extensionPaths,
					extensionFactories: childDefinition.name === "searcher" ? [{
						name: "herder-searcher-policy",
						factory: (childPi) => {
							childPi.on("tool_call", (event) => applySearcherToolPolicy(event.toolName, event.input));
						},
					}] : [],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
					systemPromptOverride: () => childDefinition.systemPrompt,
					appendSystemPromptOverride: () => [],
				});
				await childLoader.reload();
				const extensionErrors = childLoader.getExtensions().errors;
				if (extensionErrors.length > 0) {
					throw new Error(`Herder nested extensions failed to load: ${extensionErrors.map((item) => `${item.path}: ${item.error}`).join("; ")}`);
				}
				signal.throwIfAborted();
				const { session: child } = await createAgentSession({
					cwd: request.action.worktree,
					agentDir: this.agentDir,
					modelRuntime: runtime,
					model: model as Model<any>,
					thinkingLevel: request.action.effort as ThinkingLevel,
					tools: childDefinition.tools,
					resourceLoader: childLoader,
					sessionManager: childManager,
				});
				if (signal.aborted) {
					await child.abort();
					child.dispose();
					signal.throwIfAborted();
				}
				if (child.messages.length !== 0) {
					child.dispose();
					throw new Error("Herder nested agent session was not created with clean history.");
				}
				const activeChildTools = new Set(child.agent.state.tools.map((tool) => tool.name));
				const missingChildTools = childDefinition.tools.filter((tool) => !activeChildTools.has(tool));
				if (missingChildTools.length > 0) {
					child.dispose();
					throw new Error(`Herder nested agent ${childDefinition.name} is missing required tools: ${missingChildTools.join(", ")}.`);
				}
				if (request.action.serviceTier) applyServiceTier(child, request.action.serviceTier);
				return {
					get sessionId() { return child.sessionId; },
					get messages() { return child.messages; },
					subscribe: (listener) => child.subscribe(listener),
					prompt: (text, options) => child.prompt(text, options),
					abort: () => child.abort(),
					dispose: () => child.dispose(),
					getSessionStats: () => child.getSessionStats(),
				} satisfies NestedWorkerSession;
			},
		});

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
		const nestedTools = createNestedAgentTools(request.action, nested);
		const { session } = await createAgentSession({
			cwd: request.action.worktree,
			agentDir: this.agentDir,
			modelRuntime: runtime,
			model: model as Model<any>,
			thinkingLevel: request.action.effort as ThinkingLevel,
			tools: definition.tools,
			customTools: [...nestedTools],
			resourceLoader,
			sessionManager,
		});
		if (session.messages.length !== 0) {
			session.dispose();
			await nested.stop("Parent Herder session creation failed");
			throw new Error("Herder Pi worker session was not created with clean history.");
		}
		if (request.action.serviceTier) applyServiceTier(session, request.action.serviceTier);
		return { session, nested };
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

	async prepare(request: PiWorkerRequest): Promise<string> {
		if ([...this.workers.values()].some((worker) => worker.request.action.actionId === request.action.actionId)) {
			throw new Error(`Pi worker action ${request.action.actionId} is already prepared.`);
		}
		const prepared = await this.factory.create(request);
		const { session, nested } = prepared;
		if (session.messages.length !== 0) {
			session.dispose();
			await nested.stop("Parent Herder session contained inherited history");
			throw new Error("Herder Pi workers require a session with zero inherited messages.");
		}
		const handle = `pi-worker:${session.sessionId}`;
		if (this.workers.has(handle)) {
			session.dispose();
			await nested.stop("Duplicate parent Herder session");
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
			nested,
			snapshot,
			activeToolCalls: new Map(),
			unsubscribe: () => {},
			unsubscribeNested: () => {},
			started: false,
			stopRequested: false,
		} satisfies WorkerRecord;
		worker.unsubscribe = session.subscribe((event) => this.observe(worker, event));
		worker.unsubscribeNested = nested.onUpdate((children) => {
			worker.snapshot.children = children.map(cloneNested);
			this.emitUpdate();
		});
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
		await worker.nested.stop("Prepared Herder worker was discarded");
		worker.unsubscribeNested();
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
		await Promise.allSettled([
			worker.session.abort(),
			worker.nested.stop("Parent Herder worker was stopped"),
		]);
		await worker.completion?.catch(() => {});
	}

	private async run(handle: string, worker: WorkerRecord): Promise<void> {
		let failure: string | undefined;
		try {
			await worker.session.prompt(worker.request.action.prompt, { expandPromptTemplates: false, source: "extension" });
		} catch (error) {
			failure = message(error);
		}
		const uncollected = worker.nested.uncollectedBackgroundIds();
		if (!worker.stopRequested && uncollected.length > 0) {
			failure = [failure, `Pi worker completed without collecting background nested agents: ${uncollected.join(", ")}`]
				.filter(Boolean)
				.join("\n");
		}
		await worker.nested.stop("Parent Herder worker completed");
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
			usage: mergeNestedUsage(
				usageEvidence(worker.session, worker.snapshot.startedAt, finishedAt),
				worker.nested.usage(),
			),
		};
		try {
			await Promise.all([...this.terminals].map((listener) => listener(terminal)));
		} finally {
			worker.unsubscribeNested();
			worker.unsubscribe();
			worker.session.dispose();
			this.workers.delete(handle);
			this.emitUpdate();
		}
	}
}
