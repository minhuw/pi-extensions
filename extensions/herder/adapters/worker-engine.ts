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
	type ToolDefinition,
	type SessionStats,
} from "@earendil-works/pi-coding-agent";
import { WORKER_ROLES, type ManagerAction, type UsageEvidence, type WorkerRole } from "../src/shared/protocol.ts";
import {
	modelMatches,
	modelSupportsEffort,
	modelSupportsServiceTier,
	serviceTierRequestValue,
	type AvailableModel,
	type ThinkingEffort,
} from "./profile.ts";
import {
	abortSession,
	HerderNestedAgentScope,
	type NestedWorkerSession,
	type PiNestedAgentSnapshot,
} from "./nested-agent-executor.ts";
import { createNestedAgentTools } from "./nested-agent-tool.ts";
import { createReconTools } from "./recon-tools.ts";
import {
	loadHerderPiRole,
	PONYTAIL_EXTENSION_SOURCE,
	WEB_ACCESS_EXTENSION_SOURCE,
	type HerderPiRoleDefinition,
	type HerderNestedAgentDefinition,
} from "./role-config.ts";
import { finalAssistantResult } from "./assistant-message.ts";
import { cloneSessionSnapshot, observeSessionEvent } from "./session-telemetry.ts";
import { record, sessionUsageTotals } from "./usage-accounting.ts";
import { isInside } from "../src/daemon/git/primitives.ts";
export { finalAssistantResult };

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
	failureKind?: "review_budget_exhausted";
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
	readonly extensionRunner?: AgentSession["extensionRunner"];
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string, options?: { expandPromptTemplates?: boolean; source?: "extension" }): Promise<void>;
	abortCompaction?(): void;
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
	reviewBudgetExhausted: boolean;
	reviewDeadline?: number;
	reviewTimer?: ReturnType<typeof setTimeout>;
	aborting?: Promise<void>;
	completion?: Promise<void>;
}

type UpdateListener = (workers: readonly PiWorkerSnapshot[]) => void;
type TerminalListener = (terminal: PiWorkerTerminal) => void | Promise<void>;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function disposeWorkerSession(session: Pick<WorkerSession, "extensionRunner" | "dispose">): Promise<void> {
	try {
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
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

/** Scout cleanup can dispose subscriptions before SDK auth/preflight finishes. */
export function applyNestedAbortSignal(session: AgentSession, signal: AbortSignal): void {
	const base = session.agent.streamFunction;
	session.agent.streamFunction = (model, context, options) => {
		signal.throwIfAborted();
		return base(model, context, {
			...options,
			signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
		});
	};
}

function roleFromAgentType(agentType: string): ManagerAction["role"] {
	const role = agentType.startsWith("herder.") ? agentType.slice("herder.".length) : agentType;
	if (!WORKER_ROLES.includes(role as WorkerRole)) {
		throw new Error(`Unknown Herder Pi role ${JSON.stringify(agentType)}.`);
	}
	return role as ManagerAction["role"];
}

function usageEvidence(session: WorkerSession, startedAt: number, finishedAt: number): Partial<UsageEvidence> {
	return {
		...sessionUsageTotals(session),
		source: "herder pi worker session",
		startedAt: new Date(startedAt).toISOString(),
		finishedAt: new Date(finishedAt).toISOString(),
		durationMs: Math.max(0, finishedAt - startedAt),
	};
}

const SEARCHER_WEB_TOOL_NAMES = new Set(["web_search", "source_check", "fetch_content", "get_search_content"]);
const SEARCHER_LOCAL_TOOL_NAMES = new Set(["find", "grep"]);

function searchPathStaysWithinWorktree(worktree: string, rawPath: string): boolean {
	const value = rawPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").trim();
	if (!value) return true;
	if (value.startsWith("@") || /^file:\/\//i.test(value)
		|| value === "~" || value.startsWith("~/") || value.startsWith("~\\") || path.win32.isAbsolute(value)) return false;
	try {
		const lexicalRoot = path.resolve(worktree);
		const candidate = path.resolve(lexicalRoot, value);
		if (!isInside(lexicalRoot, candidate)) return false;
		let existing = candidate;
		while (!existsSync(existing)) {
			const parent = path.dirname(existing);
			if (parent === existing) return false;
			existing = parent;
		}
		return isInside(realpathSync(lexicalRoot), realpathSync(existing));
	} catch {
		return false;
	}
}

export function applySearcherToolPolicy(toolName: string, rawInput: unknown, worktree: string): { block: true; reason: string } | undefined {
	const input = record(rawInput);
	if (SEARCHER_LOCAL_TOOL_NAMES.has(toolName)) {
		if (input && typeof input.path === "string" && !searchPathStaysWithinWorktree(worktree, input.path)) {
			return { block: true, reason: "Herder searcher may search only inside its assigned worktree." };
		}
		return undefined;
	}
	if (!SEARCHER_WEB_TOOL_NAMES.has(toolName)) return { block: true, reason: `Herder searcher cannot call unexpected tool ${toolName}.` };
	if (!input) return undefined;
	// Apply by capability envelope rather than assumed semantic name: pi-web-access
	// permits configured tool-name swaps, so every allowed web call gets both guards.
	input.workflow = "none";
	const values = [input.url, ...(Array.isArray(input.urls) ? input.urls : [])]
		.filter((value): value is string => typeof value === "string");
	if (values.some((value) => /^(?:file:|\/|\.\.?\/)/i.test(value.trim()))) {
		return { block: true, reason: "Herder searcher may fetch only remote URLs." };
	}
	return undefined;
}

export function trustedNestedExtensionPath(agentDir: string, installed: string, source: string): string {
	if (source !== WEB_ACCESS_EXTENSION_SOURCE) throw new Error(`Herder npm extension ${source} is not allowed.`);
	const packagePath = ["pi-web-access"];
	const realRoot = realpathSync(path.join(agentDir, "npm"));
	const realInstalled = realpathSync(installed);
	if (!isInside(realRoot, realInstalled)) {
		throw new Error(`Herder npm extension ${source} resolves outside the trusted user package store.`);
	}
	if (realInstalled !== path.join(realRoot, "node_modules", ...packagePath)) {
		throw new Error(`Herder npm extension ${source} does not resolve to its exact trusted package path.`);
	}
	return realInstalled;
}

export function trustedRoleExtensionEntry(agentDir: string, installed: string, source: string): string {
	const installCommand = `pi install ${source}`;
	if (source !== PONYTAIL_EXTENSION_SOURCE) throw new Error(`Herder role extension ${source} is not allowed.`);
	const realRoot = realpathSync(path.join(agentDir, "git"));
	const realInstalled = realpathSync(installed);
	if (!isInside(realRoot, realInstalled)) {
		throw new Error(`Herder role extension ${source} resolves outside the trusted user git store.`);
	}
	const expectedPackage = path.join(realRoot, "github.com", "DietrichGebert", "ponytail");
	if (realInstalled !== expectedPackage) {
		throw new Error(`Herder role extension ${source} does not resolve to the exact trusted Ponytail package.`);
	}
	const entry = path.join(realInstalled, "pi-extension", "index.js");
	if (!existsSync(entry)) {
		throw new Error(`Herder role extension ${source} is missing pi-extension/index.js. Reinstall it explicitly with: ${installCommand}`);
	}
	const realEntry = realpathSync(entry);
	if (!isInside(realInstalled, realEntry) || !isInside(realRoot, realEntry)) {
		throw new Error(`Herder role extension ${source} entry resolves outside the trusted user package.`);
	}
	return realEntry;
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

	private resolveExtensionPaths(sources: readonly string[], cwd: string, owner: "role" | "nested"): string[] {
		if (sources.length === 0) return [];
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		const packageManager = new DefaultPackageManager({ cwd, agentDir: this.agentDir, settingsManager });
		return sources.map((source) => {
			const installed = packageManager.getInstalledPath(source, "user");
			if (!installed || !existsSync(installed)) {
				throw new Error(`Herder ${owner} extension ${source} is not installed in the trusted user package store. Install it explicitly with: pi install ${source}`);
			}
			return source === PONYTAIL_EXTENSION_SOURCE
				? trustedRoleExtensionEntry(this.agentDir, installed, source)
				: trustedNestedExtensionPath(this.agentDir, installed, source);
		});
	}

	private resolveModel(
		available: readonly AvailableModel[],
		requestedModel: string,
		effort: ThinkingEffort,
		serviceTier: string | undefined,
		label: "worker" | "nested agent",
	): Model<any> {
		const model = available.find((candidate) => modelMatches(requestedModel, candidate));
		if (!model) throw new Error(`Pi ${label} model ${requestedModel} is unavailable.`);
		if (!modelSupportsEffort(model, effort)) {
			throw new Error(`Pi ${label} model ${requestedModel} does not support thinking ${effort}.`);
		}
		if (serviceTier && !modelSupportsServiceTier(model)) {
			throw new Error(`Pi ${label} model ${requestedModel} (${model.api || "unknown api"}) does not support service tier ${serviceTier}.`);
		}
		return model as Model<any>;
	}

	private async admitSession(options: {
		model: Model<any>;
		modelRuntime: ModelRuntime;
		binding: Pick<ManagerAction, "effort" | "serviceTier">;
		cwd: string;
		sessionDirectory: string;
		definition: HerderPiRoleDefinition | HerderNestedAgentDefinition;
		customTools: ToolDefinition[];
		signal?: AbortSignal;
	}): Promise<AgentSession> {
		const { definition, binding } = options;
		const nested = "name" in definition;
		const owner = nested ? "nested" : "role";
		const label = nested ? `Herder nested agent ${definition.name}` : `Herder role ${definition.role}`;
		const sessionManager = SessionManager.create(options.cwd, options.sessionDirectory);
		if (sessionManager.getHeader()?.parentSession) throw new Error(`Herder ${nested ? "nested agents" : "Pi workers"} cannot inherit a parent session.`);
		const extensionPaths = this.resolveExtensionPaths(definition.extensions, options.cwd, owner);
		const resourceLoader = new DefaultResourceLoader({
			cwd: options.cwd,
			agentDir: this.agentDir,
			additionalExtensionPaths: extensionPaths,
			extensionFactories: nested && definition.name === "searcher" ? [{
				name: "herder-searcher-policy",
				factory: (childPi) => {
					childPi.on("tool_call", (event) => applySearcherToolPolicy(event.toolName, event.input, options.cwd));
				},
			}] : [],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			...(nested ? { noContextFiles: true } : {}),
			systemPromptOverride: () => definition.systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		const extensions = resourceLoader.getExtensions();
		if (extensions.errors.length > 0) {
			throw new Error(`Herder ${owner} extensions failed to load: ${extensions.errors.map((item) => `${item.path}: ${item.error}`).join("; ")}`);
		}
		options.signal?.throwIfAborted();

		let session: AgentSession | undefined;
		try {
			const created = await createAgentSession({
				cwd: options.cwd,
				agentDir: this.agentDir,
				modelRuntime: options.modelRuntime,
				model: options.model,
				thinkingLevel: binding.effort as ThinkingLevel,
				tools: definition.tools,
				customTools: options.customTools,
				resourceLoader,
				sessionManager,
			});
			session = created.session;
			await session.bindExtensions({
				mode: "print",
				onError: (error) => {
					throw new Error(`Herder ${owner} extension failed during ${error.event}: ${error.extensionPath}: ${error.error}`);
				},
			});
			options.signal?.throwIfAborted();
			session.setActiveToolsByName(definition.tools);
			if (session.messages.length !== 0) throw new Error(`Herder ${nested ? "nested agent" : "Pi worker"} session was not created with clean history.`);
			const activeTools = new Set(session.agent.state.tools.map((tool) => tool.name));
			const missingTools = definition.tools.filter((tool) => !activeTools.has(tool));
			const unexpectedTools = [...activeTools].filter((tool) => !definition.tools.includes(tool));
			if (missingTools.length > 0) throw new Error(`${label} is missing required tools: ${missingTools.join(", ")}.`);
			if (unexpectedTools.length > 0) throw new Error(`${label} exposed unexpected tools: ${unexpectedTools.join(", ")}.`);
		} catch (error) {
			if (session) {
				await Promise.allSettled([
					...(options.signal?.aborted ? [session.abort()] : []),
					disposeWorkerSession(session),
				]);
			}
			throw error;
		}
		if (binding.serviceTier) applyServiceTier(session, binding.serviceTier);
		if (options.signal) applyNestedAbortSignal(session, options.signal);
		return session;
	}

	async create(request: PiWorkerRequest): Promise<PreparedWorkerSession> {
		const role = roleFromAgentType(request.action.agentType);
		if (role !== request.action.role) throw new Error(`Action role ${request.action.role} does not match ${request.action.agentType}.`);
		const definition = await loadHerderPiRole(this.agentRoot, role);
		const runtime = this.runtime();
		const available = await runtime.getAvailable();
		const model = this.resolveModel(available, request.action.model, request.action.effort as ThinkingEffort, request.action.serviceTier, "worker");
		const sessionRoot = path.join(request.planDirectory, ".herder", "pi-sessions");
		await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
		const nestedRoot = path.join(sessionRoot, "nested", request.action.actionId.replace(/[^A-Za-z0-9._-]+/g, "_"));
		const nested = new HerderNestedAgentScope({
			action: request.action,
			agentRoot: this.agentRoot,
			createSession: async ({ id, definition: childDefinition, binding, signal, nestedScope }) => {
				signal.throwIfAborted();
				const childModel = this.resolveModel(available, binding.model, binding.effort, binding.serviceTier, "nested agent");
				const childRoot = path.join(nestedRoot, id);
				await mkdir(childRoot, { recursive: true, mode: 0o700 });
				signal.throwIfAborted();
				const child = await this.admitSession({
					model: childModel,
					modelRuntime: runtime,
					binding,
					cwd: request.action.worktree,
					sessionDirectory: childRoot,
					definition: childDefinition,
					customTools: [
						...(nestedScope ? createNestedAgentTools(nestedScope) : []),
						...(childDefinition.name === "recon" ? createReconTools(request.action.worktree, signal, this.agentDir) : []),
					],
					signal,
				});
				return {
					get sessionId() { return child.sessionId; },
					get messages() { return child.messages; },
					subscribe: (listener) => child.subscribe(listener),
					prompt: (text, options) => child.prompt(text, options),
					abort: () => { child.abortCompaction(); return child.abort(); },
					shutdown: async () => { await child.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); },
					dispose: () => child.dispose(),
					getSessionStats: () => child.getSessionStats(),
				} satisfies NestedWorkerSession;
			},
		});

		const nestedTools = createNestedAgentTools(nested);
		let session: AgentSession;
		try {
			session = await this.admitSession({
				model,
				modelRuntime: runtime,
				binding: request.action,
				cwd: request.action.worktree,
				sessionDirectory: sessionRoot,
				definition,
				customTools: [...nestedTools],
			});
		} catch (error) {
			await Promise.allSettled([nested.stop("Parent Herder session creation failed")]);
			throw error;
		}
		return { session, nested };
	}
}

export class PiWorkerEngine {
	private readonly factory: PiWorkerSessionFactory;
	private readonly workers = new Map<string, WorkerRecord>();
	private readonly updates = new Set<UpdateListener>();
	private readonly terminals = new Set<TerminalListener>();
	private readonly reviewTimeoutMs?: number;

	constructor(factory: PiWorkerSessionFactory, reviewTimeoutMs?: number) {
		this.factory = factory;
		const configured = reviewTimeoutMs ?? process.env.HERDER_REVIEW_TIMEOUT_MS;
		const timeout = typeof configured === "string" && /^\d+$/.test(configured) ? Number(configured) : configured;
		if (timeout !== undefined && (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)) {
			throw new Error("HERDER_REVIEW_TIMEOUT_MS must be a positive safe integer <= 2147483647 (unset to disable).");
		}
		this.reviewTimeoutMs = timeout;
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
				...cloneSessionSnapshot(worker.snapshot),
				children: worker.snapshot.children.map(cloneSessionSnapshot),
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


	async prepare(request: PiWorkerRequest): Promise<string> {
		if ([...this.workers.values()].some((worker) => worker.request.action.actionId === request.action.actionId)) {
			throw new Error(`Pi worker action ${request.action.actionId} is already prepared.`);
		}
		const prepared = await this.factory.create(request);
		const { session, nested } = prepared;
		if (session.messages.length !== 0) {
			await Promise.allSettled([
				disposeWorkerSession(session),
				nested.stop("Parent Herder session contained inherited history"),
			]);
			throw new Error("Herder Pi workers require a session with zero inherited messages.");
		}
		const handle = `pi-worker:${session.sessionId}`;
		if (this.workers.has(handle)) {
			await Promise.allSettled([
				disposeWorkerSession(session),
				nested.stop("Duplicate parent Herder session"),
			]);
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
		const worker: WorkerRecord = {
			request,
			session,
			nested,
			snapshot,
			activeToolCalls: new Map(),
			unsubscribe: () => {},
			unsubscribeNested: () => {},
			started: false,
			stopRequested: false,
			reviewBudgetExhausted: false,
		};
		worker.unsubscribe = session.subscribe((event) => {
			if (worker.stopRequested && (event.type === "agent_start" || event.type === "compaction_start")) {
				worker.aborting = abortSession(session, worker.aborting);
			}
			if (observeSessionEvent(worker, event, () => { if (!worker.stopRequested) worker.snapshot.status = "running"; })) this.emitUpdate();
		});
		worker.unsubscribeNested = nested.onUpdate((children) => {
			worker.snapshot.children = children.map(cloneSessionSnapshot);
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
		if (worker.request.action.role === "plan-reviewer" && this.reviewTimeoutMs !== undefined) {
			worker.reviewDeadline = Date.now() + this.reviewTimeoutMs;
			worker.reviewTimer = setTimeout(() => {
				worker.reviewBudgetExhausted = true;
				this.abortWorker(worker, "Herder reviewer wall-clock budget exhausted");
			}, this.reviewTimeoutMs);
		}
		this.emitUpdate();
		worker.completion = this.run(handle, worker).finally(() => clearTimeout(worker.reviewTimer));
		void worker.completion.catch(() => {});
	}

	async discard(handle: string): Promise<void> {
		const worker = this.workers.get(handle);
		if (!worker) return;
		if (worker.started) throw new Error(`Cannot discard running Pi worker ${handle}.`);
		clearTimeout(worker.reviewTimer);
		await worker.nested.stop("Prepared Herder worker was discarded");
		worker.unsubscribeNested();
		worker.unsubscribe();
		try {
			await disposeWorkerSession(worker.session);
		} finally {
			this.workers.delete(handle);
			this.emitUpdate();
		}
	}

	async stop(handle: string): Promise<void> {
		const worker = this.workers.get(handle);
		if (!worker) return;
		clearTimeout(worker.reviewTimer);
		if (!worker.started) {
			await this.discard(handle);
			return;
		}
		this.abortWorker(worker, "Parent Herder worker was stopped");
		await Promise.allSettled([worker.aborting, worker.completion]);
	}

	private abortWorker(worker: WorkerRecord, reason: string): void {
		clearTimeout(worker.reviewTimer);
		worker.stopRequested = true;
		worker.snapshot.status = "stopping";
		worker.aborting ??= abortSession(worker.session);
		// Close launches and cascade immediately, but never await our own run completion.
		void worker.nested.stop(reason).catch(() => {});
		this.emitUpdate();
	}

	private async run(handle: string, worker: WorkerRecord): Promise<void> {
		let failure: string | undefined;
		const prompt = worker.request.action.prompt + (worker.reviewDeadline === undefined ? "" :
			`\n\nHerder host review budget: ${this.reviewTimeoutMs}ms total wall-clock; deadline ${new Date(worker.reviewDeadline).toISOString()}; ${Math.max(0, worker.reviewDeadline - Date.now())}ms remaining. This single deadline includes SDK retries/compaction and all descendants; delegation does not reset it. Reserve time to collect evidence and synthesize your final review before the deadline.`);
		try {
			await worker.session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
		} catch (error) {
			failure = message(error);
		}
		const result = finalAssistantResult(worker.session.messages);
		const uncollected = worker.nested.uncollectedBackgroundIds();
		if (!worker.stopRequested && uncollected.length > 0) {
			failure = [failure, `Pi worker completed without collecting background nested agents: ${uncollected.join(", ")}`]
				.filter(Boolean)
				.join("\n");
		}
		// A failure that arrived first must not become a budget failure during cleanup.
		if (failure || result.failed || !result.text) clearTimeout(worker.reviewTimer);
		await worker.nested.stop("Parent Herder worker completed");
		clearTimeout(worker.reviewTimer);
		// The prompt can settle before SDK abort cleanup (including Bash) finishes.
		await worker.aborting?.catch(() => {});
		const finishedAt = Date.now();
		const interrupted = worker.stopRequested || Boolean(failure) || result.failed || !result.text;
		const errors = [...new Set([
			...(worker.reviewBudgetExhausted ? ["Herder reviewer wall-clock budget exhausted"] : []),
			failure, result.error,
		].filter((value): value is string => Boolean(value)))];
		const terminal: PiWorkerTerminal = {
			handle,
			actionId: worker.request.action.actionId,
			planDirectory: worker.request.planDirectory,
			...(result.text ? { response: result.text } : {}),
			...(interrupted ? { interrupted: true } : {}),
			...(worker.reviewBudgetExhausted ? { failureKind: "review_budget_exhausted" as const } : {}),
			...(interrupted ? { error: errors.join("\n") || (worker.stopRequested ? "Pi worker stopped" : "Pi worker produced no terminal result") } : {}),
			usage: {
				...usageEvidence(worker.session, worker.snapshot.startedAt, finishedAt),
				...(worker.nested.usageSlices().length ? { nested: worker.nested.usageSlices() } : {}),
			},
		};
		try {
			worker.unsubscribeNested();
			worker.unsubscribe();
			try {
				await disposeWorkerSession(worker.session);
			} catch (error) {
				terminal.interrupted = true;
				terminal.error = [terminal.error, message(error)].filter(Boolean).join("\n");
			}
			// An explicit stop may also arrive while extension shutdown is pending.
			await worker.aborting?.catch(() => {});
			if (worker.stopRequested) {
				terminal.interrupted = true;
				terminal.error ||= "Pi worker stopped";
			}
			await Promise.all([...this.terminals].map((listener) => listener(terminal)));
		} finally {
			this.workers.delete(handle);
			this.emitUpdate();
		}
	}
}
