import { randomUUID } from "node:crypto";
import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import type { ManagerAction, NestedUsageSlice } from "../src/shared/protocol.ts";
import {
	HERDER_NESTED_AGENT_TYPES,
	loadHerderNestedAgent,
	resolveNestedBinding,
	type HerderNestedAgentDefinition,
	type HerderNestedAgentType,
	type NestedAgentModelBinding,
} from "./role-config.ts";
import { decodeAssistantResult } from "./assistant-message.ts";
import { cloneSessionSnapshot, observeSessionEvent } from "./session-telemetry.ts";
import { sessionUsageTotals } from "./usage-accounting.ts";

export type HerderNestedAgentStatus = "running" | "completed" | "aborted" | "stopped" | "error" | "timed_out";

export interface PiNestedAgentSnapshot {
	agentId: string;
	parentAgentId?: string;
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
	type: HerderNestedAgentType;
	model: string;
	effort: string;
	serviceTier?: string;
	status: HerderNestedAgentStatus;
	output: string;
	error?: string;
	startedAt: number;
	completedAt: number;
	turnCount: number;
	toolUses: number;
	lifetimeTokens: number;
	contextPercent: number | null;
	compactionCount: number;
	sessionId?: string;
	usage: NestedAgentUsage;
	nestedUsage?: NestedUsageSlice[];
}

export interface NestedAgentRunRequest {
	type: HerderNestedAgentType;
	prompt: string;
	description: string;
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
	shutdown?(): Promise<void>;
	dispose(): void;
	getSessionStats(): SessionStats;
}

export interface NestedSessionCreateRequest {
	id: string;
	definition: HerderNestedAgentDefinition;
	binding: NestedAgentModelBinding;
	signal: AbortSignal;
	nestedScope?: HerderNestedAgentScope;
}

export type NestedSessionCreator = (request: NestedSessionCreateRequest) => Promise<NestedWorkerSession>;

type UpdateListener = (snapshots: readonly PiNestedAgentSnapshot[]) => void;

interface NestedRecord {
	snapshot: PiNestedAgentSnapshot;
	session?: NestedWorkerSession;
	nestedScope?: HerderNestedAgentScope;
	activeToolCalls: Map<string, string>;
	promise: Promise<NestedAgentResult>;
	background: boolean;
	collected: boolean;
	result?: NestedAgentResult;
}

export const MAX_NESTED_CONCURRENCY_PER_ACTION = 4;
export const MAX_NESTED_CALLS = 8;
export const RECON_TIMEOUT_MS = 3_600_000;
export const RESULT_WAIT_TIMEOUT_MS = 60_000;
const CLEANUP_GRACE_MS = 5_000;

function usageFromSession(session: NestedWorkerSession): NestedAgentUsage {
	const totals = sessionUsageTotals(session);
	return {
		...totals,
		reasoningTokens: totals.reasoningTokens ?? 0,
		reasoningKnown: totals.reasoningTokens !== undefined,
	};
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	const abort = () => target.abort(source.reason);
	if (source.aborted) abort();
	else source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort);
			reject(signal.reason instanceof Error ? signal.reason : new Error("Nested agent aborted."));
		};
		promise.then(
			(value) => { signal.removeEventListener("abort", abort); resolve(value); },
			(error) => { signal.removeEventListener("abort", abort); reject(error); },
		);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

/** Scouts have bounded cleanup; unrestricted sessions retain ownership until settled. */
async function cleanupSession(session: NestedWorkerSession, abort?: Promise<void>, bounded = true): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const settled = Promise.allSettled([abort, Promise.resolve().then(() => session.shutdown?.())]);
		await (bounded ? Promise.race([
			settled,
			new Promise<void>((resolve) => { timer = setTimeout(resolve, CLEANUP_GRACE_MS); }),
		]) : settled);
	} finally {
		clearTimeout(timer);
		try { session.dispose(); } catch { /* cleanup must not prevent result settlement */ }
	}
}

function abortSession(session: NestedWorkerSession): Promise<void> {
	const abort = Promise.resolve().then(() => session.abort());
	void abort.catch(() => {});
	return abort;
}

function sliceKey(slice: Pick<NestedUsageSlice, "type" | "model" | "effort" | "serviceTier">): string {
	return [slice.type, slice.model, slice.effort, slice.serviceTier ?? ""].join("\0");
}

export function nestedUsageSlices(results: readonly NestedAgentResult[]): NestedUsageSlice[] {
	const groups = new Map<string, NestedUsageSlice>();
	for (const result of results) {
		const own: NestedUsageSlice = {
			type: result.type,
			model: result.model,
			effort: result.effort,
			...(result.serviceTier ? { serviceTier: result.serviceTier } : {}),
			count: 1,
			inputTokens: result.usage.inputTokens,
			cachedInputTokens: result.usage.cachedInputTokens,
			outputTokens: result.usage.outputTokens,
			reasoningTokens: result.usage.reasoningKnown ? result.usage.reasoningTokens : null,
			durationMs: Math.max(0, result.completedAt - result.startedAt),
		};
		for (const slice of [own, ...(result.nestedUsage ?? [])]) {
			const key = sliceKey(slice);
			const existing = groups.get(key);
			if (!existing) {
				groups.set(key, { ...slice });
				continue;
			}
			existing.count += slice.count;
			for (const field of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "durationMs"] as const) {
				if (slice[field] != null) existing[field] = (existing[field] ?? 0) + slice[field];
			}
		}
	}
	return [...groups.values()].sort((left, right) => {
		return sliceKey(left).localeCompare(sliceKey(right), undefined, { numeric: true });
	});
}

export class HerderNestedAgentScope {
	private readonly action: ManagerAction;
	private readonly agentRoot: string;
	private readonly createSession: NestedSessionCreator;
	private readonly records = new Map<string, NestedRecord>();
	private readonly pendingLaunches = new Set<Promise<NestedAgentLaunch>>();
	private readonly listeners = new Set<UpdateListener>();
	private readonly scopeController = new AbortController();
	readonly maxCalls: number;
	readonly maxConcurrency: number;
	readonly allowedTypes: readonly HerderNestedAgentType[];
	private readonly parentAgentId?: string;
	private calls = 0;
	private active = 0;
	private stopped = false;

	constructor(options: {
		action: ManagerAction;
		agentRoot: string;
		createSession: NestedSessionCreator;
		parentType?: "reviewer";
		parentAgentId?: string;
	}) {
		this.action = options.action;
		this.agentRoot = options.agentRoot;
		this.createSession = options.createSession;
		if (options.parentType !== undefined && (options.parentType !== "reviewer" || options.action.role !== "plan-reviewer")) {
			throw new Error("Only a nested reviewer may own a child scope.");
		}
		this.parentAgentId = options.parentAgentId;
		this.maxCalls = options.parentType ? 2 : MAX_NESTED_CALLS;
		this.maxConcurrency = options.parentType ? 1 : MAX_NESTED_CONCURRENCY_PER_ACTION;
		this.allowedTypes = Object.freeze(options.parentType ? ["recon"] : options.action.role === "plan-reviewer"
			? ["recon", "searcher", "reviewer"] : options.action.role === "plan-implementer"
				? ["recon", "searcher", "worker"] : ["recon", "searcher"]);
	}

	onUpdate(listener: UpdateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	snapshots(): PiNestedAgentSnapshot[] {
		return [...this.records.values()]
			.map((item) => cloneSessionSnapshot(item.snapshot))
			.sort((left, right) => left.startedAt - right.startedAt || left.agentId.localeCompare(right.agentId));
	}

	treeSnapshots(): PiNestedAgentSnapshot[] {
		return this.snapshots().flatMap((snapshot) => [snapshot, ...(this.records.get(snapshot.agentId)?.nestedScope?.treeSnapshots() ?? [])]);
	}

	usageSlices(): NestedUsageSlice[] {
		return nestedUsageSlices([...this.records.values()].flatMap((item) => item.result ? [item.result] : []));
	}

	activeCount(): number { return this.active; }

	uncollectedBackgroundIds(): string[] {
		return [...this.records.values()]
			.filter((item) => item.background && !item.collected)
			.map((item) => item.snapshot.agentId);
	}

	private reserveConcurrency(): () => void {
		if (this.active >= this.maxConcurrency) {
			throw new Error(`A Herder role may run at most ${this.maxConcurrency} nested agents concurrently.`);
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
		const snapshots = this.treeSnapshots();
		for (const listener of this.listeners) listener(snapshots);
	}

	async run(request: NestedAgentRunRequest, signal?: AbortSignal): Promise<NestedAgentResult> {
		const launch = await this.launch(request, false, signal);
		return await this.records.get(launch.id)!.promise;
	}

	async spawnBackground(request: NestedAgentRunRequest, signal?: AbortSignal): Promise<NestedAgentLaunch> {
		return await this.launch(request, true, signal);
	}

	private collect(item: NestedRecord): NestedAgentLookup {
		const changed = item.result && !item.collected;
		if (item.result) item.collected = true;
		if (changed) this.emitUpdate();
		return {
			snapshot: cloneSessionSnapshot(item.snapshot),
			...(item.result ? { result: item.result } : {}),
		};
	}

	async result(agentId: string, wait: boolean, signal?: AbortSignal): Promise<NestedAgentLookup> {
		signal?.throwIfAborted();
		const item = this.records.get(agentId);
		if (!item) throw new Error(`Unknown Herder nested agent ${JSON.stringify(agentId)}.`);
		if (wait && !item.result) {
			await this.waitForResult(() => item.result ? item : undefined, signal);
		}
		return this.collect(item);
	}

	async resultAny(wait: boolean, signal?: AbortSignal): Promise<NestedAgentLookup | undefined> {
		signal?.throwIfAborted();
		const pick = () => [...this.records.values()].find((item) => item.background && !item.collected && item.result);
		const item = pick();
		if (item) return this.collect(item);
		if (!wait || this.uncollectedBackgroundIds().length === 0) return undefined;
		return await this.waitForResult(pick, signal, () => this.uncollectedBackgroundIds().length === 0);
	}

	private waitForResult(
		pick: () => NestedRecord | undefined,
		signal?: AbortSignal,
		noneLeft = () => false,
	): Promise<NestedAgentLookup | undefined> {
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				unsubscribe();
				signal?.removeEventListener("abort", abort);
			};
			const abort = () => {
				cleanup();
				reject(signal?.reason instanceof Error ? signal.reason : new Error("Nested result wait aborted."));
			};
			const check = () => {
				const item = pick();
				if (!item && !noneLeft()) return;
				cleanup();
				resolve(item ? this.collect(item) : undefined);
			};
			const timer = setTimeout(() => { cleanup(); resolve(undefined); }, RESULT_WAIT_TIMEOUT_MS);
			const unsubscribe = this.onUpdate(check);
			if (signal?.aborted) abort();
			else {
				signal?.addEventListener("abort", abort, { once: true });
				check();
			}
		});
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
		if (!HERDER_NESTED_AGENT_TYPES.includes(request.type)) {
			throw new Error(`Unknown Herder nested agent type: ${JSON.stringify(request.type)}.`);
		}
		if (!this.allowedTypes.includes(request.type)) {
			if (request.type === "worker" && this.action.role !== "plan-implementer") {
				throw new Error(`${this.action.role} may delegate only to package-owned read-only nested agent types; worker is mutation-capable.`);
			}
			throw new Error(`This Herder scope may delegate only to: ${this.allowedTypes.join(", ")}; ${request.type} is forbidden.`);
		}
		if (this.calls >= this.maxCalls) throw new Error(`Herder roles may call Agent at most ${this.maxCalls} times.`);
		const releaseConcurrency = this.reserveConcurrency();
		this.calls += 1;
		const startedAt = Date.now();
		const childController = new AbortController();
		const detachScope = forwardAbort(this.scopeController.signal, childController);
		const detachCall = forwardAbort(signal, childController);
		let timedOut = false;
		const timer = request.type === "recon" ? setTimeout(() => {
			timedOut = true;
			childController.abort(new Error("Herder recon exceeded its one-hour deadline."));
		}, RECON_TIMEOUT_MS) : undefined;
		const detach = () => { clearTimeout(timer); detachScope(); detachCall(); releaseConcurrency(); };
		try {
			const definition = await waitWithSignal(loadHerderNestedAgent(this.agentRoot, request.type), childController.signal);
			childController.signal.throwIfAborted();
			if (this.action.role !== "plan-implementer" && request.type !== "reviewer" && !definition.readOnly) {
				throw new Error(`${this.action.role} may delegate only to package-owned read-only nested agent types; ${request.type} is mutation-capable.`);
			}
			const binding = resolveNestedBinding(definition, this.action);
			const id = randomUUID();
			const snapshot: PiNestedAgentSnapshot = {
				agentId: id,
				...(this.parentAgentId ? { parentAgentId: this.parentAgentId } : {}),
				displayName: definition.name.charAt(0).toUpperCase() + definition.name.slice(1),
				type: definition.name,
				description: request.description,
				status: "running",
				model: binding.model,
				effort: binding.effort,
				serviceTier: binding.serviceTier,
				startedAt,
				turns: 0,
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
				...(request.type === "reviewer" ? { nestedScope: new HerderNestedAgentScope({
					action: this.action, agentRoot: this.agentRoot, createSession: this.createSession,
					parentType: "reviewer", parentAgentId: id,
				}) } : {}),
			};
			this.records.set(id, item);
			const unsubscribeNested = item.nestedScope?.onUpdate(() => this.emitUpdate());
			this.emitUpdate();
			item.promise = this.execute(item, request, definition, childController.signal, () => timedOut, () => clearTimeout(timer))
				.finally(() => { unsubscribeNested?.(); detach(); this.emitUpdate(); });
			void item.promise.catch(() => {});
			return { id, snapshot: cloneSessionSnapshot(snapshot) };
		} catch (error) {
			this.calls -= 1;
			detach();
			throw error;
		}
	}

	private async execute(
		item: NestedRecord,
		request: NestedAgentRunRequest,
		definition: HerderNestedAgentDefinition,
		signal: AbortSignal,
		timedOut: () => boolean,
		clearDeadline: () => void,
	): Promise<NestedAgentResult> {
		// Bash/write-capable sessions retain the worktree until their SDK operations settle.
		const bounded = definition.readOnly;
		let unsubscribe = () => {};
		let aborting: Promise<void> | undefined;
		const abort = () => {
			if (item.session) aborting ??= abortSession(item.session);
			void item.nestedScope?.stop("Parent nested reviewer stopped");
		};
		signal.addEventListener("abort", abort, { once: true });
		let failure: string | undefined;
		try {
			signal.throwIfAborted();
			const creation = this.createSession({
				id: item.snapshot.agentId,
				definition,
				binding: resolveNestedBinding(definition, this.action),
				signal,
				...(item.nestedScope ? { nestedScope: item.nestedScope } : {}),
			}).then(async (session) => {
				if (signal.aborted) {
					await cleanupSession(session, abortSession(session), bounded);
					return;
				}
				item.session = session;
				return session;
			});
			const session = await (bounded ? waitWithSignal(creation, signal) : creation);
			signal.throwIfAborted();
			if (!session) throw new Error("Nested session creation aborted.");
			item.snapshot.sessionId = session.sessionId;
			if (session.messages.length !== 0) throw new Error("Herder nested agents require a session with zero inherited messages.");
			unsubscribe = session.subscribe((event) => {
				if (observeSessionEvent(item, event)) this.emitUpdate();
			});
			signal.throwIfAborted();
			const prompting = session.prompt(request.prompt, { expandPromptTemplates: false, source: "extension" });
			await (bounded ? waitWithSignal(prompting, signal) : prompting);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		clearDeadline();
		unsubscribe();
		item.activeToolCalls.clear();
		const uncollected = item.nestedScope?.uncollectedBackgroundIds() ?? [];
		if (!signal.aborted && uncollected.length) {
			failure = [failure, `Nested reviewer completed without collecting background nested agents: ${uncollected.join(", ")}`].filter(Boolean).join("\n");
		}
		if (signal.aborted) abort();
		await Promise.all([
			item.nestedScope?.stop("Parent nested reviewer completed"),
			item.session ? cleanupSession(item.session, aborting, bounded) : undefined,
		]);
		signal.removeEventListener("abort", abort);
		const completedAt = Date.now();
		const final = item.session
			? decodeAssistantResult(item.session.messages) ?? { failed: true, error: "Nested Herder agent returned no assistant result." }
			: { failed: true, error: failure || "Nested session was not created." };
		const errors = [...new Set([failure, final.error].filter((value): value is string => Boolean(value)))];
		item.snapshot.status = timedOut() ? "timed_out" : signal.aborted
			? (this.stopped ? "stopped" : "aborted")
			: errors.length || final.failed ? "error" : "completed";
		item.snapshot.completedAt = completedAt;
		item.snapshot.activeTools = [];
		item.snapshot.activity = item.snapshot.status === "completed" ? "done" : item.snapshot.status;
		let usage: NestedAgentUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, reasoningKnown: false };
		if (item.session) {
			try { usage = usageFromSession(item.session); } catch { /* retain zero usage */ }
		}
		const result: NestedAgentResult = {
			id: item.snapshot.agentId,
			type: item.snapshot.type,
			model: item.snapshot.model,
			effort: item.snapshot.effort,
			...(item.snapshot.serviceTier ? { serviceTier: item.snapshot.serviceTier } : {}),
			status: item.snapshot.status,
			output: (signal.aborted ? item.snapshot.responseText : undefined) ?? final.text ?? "",
			...(errors.length ? { error: errors.join("\n") } : {}),
			startedAt: item.snapshot.startedAt,
			completedAt,
			turnCount: item.snapshot.turns,
			toolUses: item.snapshot.toolUses,
			lifetimeTokens: item.snapshot.lifetimeTokens,
			contextPercent: item.snapshot.contextPercent,
			compactionCount: item.snapshot.compactionCount,
			sessionId: item.snapshot.sessionId,
			usage,
			...(item.nestedScope ? { nestedUsage: item.nestedScope.usageSlices() } : {}),
		};
		item.result = result;
		return result;
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
