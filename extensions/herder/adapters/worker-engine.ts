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
	type NestedWorkerSession,
	type PiNestedAgentSnapshot,
} from "./nested-agent-executor.ts";
import { createNestedAgentTools } from "./nested-agent-tool.ts";
import { loadHerderPiRole, PONYTAIL_EXTENSION_SOURCE } from "./role-config.ts";
import { finalAssistantResult } from "./assistant-message.ts";
import { cloneSessionSnapshot, observeSessionEvent } from "./session-telemetry.ts";
import { record, sessionUsageTotals } from "./usage-accounting.ts";
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

function roleFromAgentType(agentType: string): ManagerAction["role"] {
	const role = agentType.startsWith("herder.") ? agentType.slice("herder.".length) : agentType;
	if (!new Set(["plan-implementer", "plan-reviewer", "plan-judge"]).has(role)) {
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

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function trustedNestedExtensionPath(agentDir: string, installed: string, source: string): string {
	const realRoot = realpathSync(path.join(agentDir, "npm"));
	const realInstalled = realpathSync(installed);
	if (!isWithin(realRoot, realInstalled)) {
		throw new Error(`Herder nested extension ${source} resolves outside the trusted user package store.`);
	}
	return realInstalled;
}

export function trustedRoleExtensionEntry(agentDir: string, installed: string, source: string): string {
	const installCommand = `pi install ${source}`;
	if (source !== PONYTAIL_EXTENSION_SOURCE) throw new Error(`Herder role extension ${source} is not allowed.`);
	const realRoot = realpathSync(path.join(agentDir, "git"));
	const realInstalled = realpathSync(installed);
	if (!isWithin(realRoot, realInstalled)) {
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
	if (!isWithin(realInstalled, realEntry) || !isWithin(realRoot, realEntry)) {
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

	private resolveNestedExtensionPaths(sources: readonly string[], cwd: string): string[] {
		if (sources.length === 0) return [];
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		const packageManager = new DefaultPackageManager({ cwd, agentDir: this.agentDir, settingsManager });
		return sources.map((source) => {
			const installed = packageManager.getInstalledPath(source, "user");
			if (!installed || !existsSync(installed)) {
				throw new Error(`Herder nested extension ${source} is not installed in the trusted user package store. Install it explicitly with: pi install ${source}`);
			}
			return source === PONYTAIL_EXTENSION_SOURCE
				? trustedRoleExtensionEntry(this.agentDir, installed, source)
				: trustedNestedExtensionPath(this.agentDir, installed, source);
		});
	}

	private resolveRoleExtensionPaths(sources: readonly string[], cwd: string): string[] {
		if (sources.length === 0) return [];
		const settingsManager = SettingsManager.create(cwd, this.agentDir);
		const packageManager = new DefaultPackageManager({ cwd, agentDir: this.agentDir, settingsManager });
		return sources.map((source) => {
			const installed = packageManager.getInstalledPath(source, "user");
			if (!installed || !existsSync(installed)) {
				throw new Error(`Herder role extension ${source} is not installed in the trusted user git store. Install it explicitly with: pi install ${source}`);
			}
			return trustedRoleExtensionEntry(this.agentDir, installed, source);
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
		const resolveBinding = (requested: string, effort: ThinkingEffort, serviceTier?: string) => {
			const resolved = available.find((candidate) => modelMatches(requested, candidate));
			if (!resolved) throw new Error(`Pi nested agent model ${requested} is unavailable.`);
			if (!modelSupportsEffort(resolved, effort)) {
				throw new Error(`Pi nested agent model ${requested} does not support thinking ${effort}.`);
			}
			if (serviceTier && !modelSupportsServiceTier(resolved)) {
				throw new Error(`Pi nested agent model ${requested} (${resolved.api || "unknown api"}) does not support service tier ${serviceTier}.`);
			}
			return resolved;
		};
		const nested = new HerderNestedAgentScope({
			action: request.action,
			agentRoot: this.agentRoot,
			createSession: async ({ id, definition: childDefinition, binding, signal }) => {
				signal.throwIfAborted();
				const childModel = resolveBinding(binding.model, binding.effort, binding.serviceTier);
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
					model: childModel as Model<any>,
					thinkingLevel: binding.effort as ThinkingLevel,
					tools: childDefinition.tools,
					resourceLoader: childLoader,
					sessionManager: childManager,
				});
				try {
					await child.bindExtensions({
						mode: "print",
						onError: (error) => {
							throw new Error(`Herder nested extension failed during ${error.event}: ${error.extensionPath}: ${error.error}`);
						},
					});
					signal.throwIfAborted();
					if (child.messages.length !== 0) throw new Error("Herder nested agent session was not created with clean history.");
					const activeChildTools = new Set(child.agent.state.tools.map((tool) => tool.name));
					const missingChildTools = childDefinition.tools.filter((tool) => !activeChildTools.has(tool));
					const unexpectedChildTools = [...activeChildTools].filter((tool) => !childDefinition.tools.includes(tool));
					if (missingChildTools.length > 0) {
						throw new Error(`Herder nested agent ${childDefinition.name} is missing required tools: ${missingChildTools.join(", ")}.`);
					}
					if (unexpectedChildTools.length > 0) {
						throw new Error(`Herder nested agent ${childDefinition.name} exposed unexpected tools: ${unexpectedChildTools.join(", ")}.`);
					}
				} catch (error) {
					await Promise.allSettled([
						...(signal.aborted ? [child.abort()] : []),
						disposeWorkerSession(child),
					]);
					throw error;
				}
				if (binding.serviceTier) applyServiceTier(child, binding.serviceTier);
				return {
					get sessionId() { return child.sessionId; },
					get messages() { return child.messages; },
					subscribe: (listener) => child.subscribe(listener),
					prompt: (text, options) => child.prompt(text, options),
					abort: () => child.abort(),
					shutdown: async () => { await child.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); },
					dispose: () => child.dispose(),
					getSessionStats: () => child.getSessionStats(),
				} satisfies NestedWorkerSession;
			},
		});

		const sessionManager = SessionManager.create(request.action.worktree, sessionRoot);
		if (sessionManager.getHeader()?.parentSession) throw new Error("Herder Pi workers cannot inherit a parent session.");
		const roleExtensionPaths = this.resolveRoleExtensionPaths(definition.extensions, request.action.worktree);
		const resourceLoader = new DefaultResourceLoader({
			cwd: request.action.worktree,
			agentDir: this.agentDir,
			additionalExtensionPaths: roleExtensionPaths,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			systemPromptOverride: () => definition.systemPrompt,
			appendSystemPromptOverride: () => [],
		});
		await resourceLoader.reload();
		const extensionErrors = resourceLoader.getExtensions().errors;
		if (extensionErrors.length > 0) {
			throw new Error(`Herder role extensions failed to load: ${extensionErrors.map((item) => `${item.path}: ${item.error}`).join("; ")}`);
		}
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
		try {
			await session.bindExtensions({
				mode: "print",
				onError: (error) => {
					throw new Error(`Herder role extension failed during ${error.event}: ${error.extensionPath}: ${error.error}`);
				},
			});
			if (session.messages.length !== 0) throw new Error("Herder Pi worker session was not created with clean history.");
			const activeTools = new Set(session.agent.state.tools.map((tool) => tool.name));
			const missingTools = definition.tools.filter((tool) => !activeTools.has(tool));
			const unexpectedTools = [...activeTools].filter((tool) => !definition.tools.includes(tool));
			if (missingTools.length > 0) throw new Error(`Herder role ${role} is missing required tools: ${missingTools.join(", ")}.`);
			if (unexpectedTools.length > 0) throw new Error(`Herder role ${role} exposed unexpected tools: ${unexpectedTools.join(", ")}.`);
		} catch (error) {
			await Promise.allSettled([
				disposeWorkerSession(session),
				nested.stop("Parent Herder session creation failed"),
			]);
			throw error;
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
		worker.unsubscribe = session.subscribe((event) => {
			if (observeSessionEvent(worker, event, () => { worker.snapshot.status = "running"; })) this.emitUpdate();
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
			usage: {
				...usageEvidence(worker.session, worker.snapshot.startedAt, finishedAt),
				...(worker.nested.usageSlices().length ? { nested: worker.nested.usageSlices() } : {}),
			},
		};
		try {
			await Promise.all([...this.terminals].map((listener) => listener(terminal)));
		} finally {
			worker.unsubscribeNested();
			worker.unsubscribe();
			try {
				await disposeWorkerSession(worker.session);
			} finally {
				this.workers.delete(handle);
				this.emitUpdate();
			}
		}
	}
}
