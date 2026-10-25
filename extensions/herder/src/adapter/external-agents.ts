// Herder's side of the external-agent registry: Subagents shows the entries in its widget, `/agents` list, and viewer.
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { EXTERNAL_AGENT_TTL_MS } from "../config.ts";
import type { StepActivity } from "./runtime.ts";

/**
 * The registry contract, shared through `globalThis` because extensions do not import each other; Subagents keeps an
 * identical copy (`extensions/subagents/src/external-agents.ts`). Whoever needs the registry first creates it.
 * Publishers replace an entry's object on every change and call each listener with its id after every add, update,
 * or remove.
 */
export const EXTERNAL_AGENTS = Symbol.for("pi-extensions.external-agents");

export interface ExternalAgent {
	/** Unique across sources, e.g. `herder:<runId>:<stepKey>:<attempt>@<attemptStartMs>`. */
	id: string;
	source: string;
	/** The Pi session that started it; other sessions do not show it. */
	ownerSessionId?: string;
	/** Heading the agent is listed under, e.g. `Herder <runId> · launch 2`. */
	group?: string;
	name: string;
	role: string;
	/** The first line of the agent's prompt. */
	description?: string;
	model?: string;
	thinking?: string;
	status: "running" | "completed" | "failed" | "stopped";
	startedAt: number;
	completedAt?: number;
	/** The live session while the agent runs; removed once it is disposed. */
	session?: AgentSession;
	/** A persisted transcript, when the source keeps one. */
	sessionFile?: string;
}

export interface ExternalAgentRegistry {
	readonly agents: Map<string, ExternalAgent>;
	readonly listeners: Set<(id: string) => void>;
}

export function externalAgents(): ExternalAgentRegistry {
	const shared = globalThis as { [EXTERNAL_AGENTS]?: ExternalAgentRegistry };
	return shared[EXTERNAL_AGENTS] ??= { agents: new Map(), listeners: new Set() };
}

/** Where a session's steps belong: its Pi session, run, and running launch. */
export interface StepScope { ownerSessionId: string; runId: string; launch?: number }

export interface StepAgentsOptions { registry?: ExternalAgentRegistry; now?: () => number; ttlMs?: number }

const SETTLED: Record<NonNullable<StepActivity["status"]>, ExternalAgent["status"]> = {
	ok: "completed", no_changes: "completed", gate_failed: "failed", failed: "failed", stopped: "stopped",
};

const firstLine = (text: string | undefined) => text?.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 200);

/**
 * Publishes one Pi session's Herder steps as external agents, one entry per attempt. An entry appears once the
 * attempt's session exists; a finished one stays for `ttlMs`, and `clear` removes them all at once.
 */
export class StepAgents {
	readonly #registry: ExternalAgentRegistry;
	readonly #now: () => number;
	readonly #ttlMs: number;
	/** `<runId>:<stepKey>` → its running attempt's entry id. */
	readonly #current = new Map<string, { id: string; attempt: number }>();
	/** Entry ids this publisher added and has not removed yet. */
	readonly #ids = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: StepAgentsOptions = {}) {
		this.#registry = options.registry ?? externalAgents();
		this.#now = options.now ?? Date.now;
		this.#ttlMs = options.ttlMs ?? EXTERNAL_AGENT_TTL_MS;
	}

	update(activity: StepActivity, scope: StepScope): void {
		const now = this.#now();
		const step = `${scope.runId}:${activity.key}`;
		const attempt = activity.attempt ?? 1;
		let current = this.#current.get(step);
		const running = current && this.#registry.agents.get(current.id);
		if (activity.state === "settled" || current?.attempt !== attempt) {
			this.#current.delete(step);
			current = undefined;
			// Settled ends the attempt; a new attempt means the previous one failed and is being retried.
			const status = activity.state === "settled" ? SETTLED[activity.status ?? "stopped"] : "failed";
			if (running?.status === "running") this.#finish(running, status, now);
			if (activity.state === "settled") return;
		}
		const session = activity.session as AgentSession | undefined;
		if (!current) {
			if (!session) return;
			// The attempt's start keeps a rerun of the same step (same key and attempt) from replacing a finished entry.
			current = { id: `herder:${step}:${attempt}@${activity.startedAt ?? now}`, attempt };
			this.#current.set(step, current);
		}
		const { id } = current;
		const previous = this.#registry.agents.get(id);
		const entry: ExternalAgent = {
			id, source: "herder", ownerSessionId: scope.ownerSessionId,
			group: `Herder ${scope.runId}${scope.launch !== undefined ? ` · launch ${scope.launch}` : ""}`,
			name: [activity.task, activity.label || activity.phase || activity.key].filter(Boolean).join(" · "),
			role: activity.role ?? previous?.role ?? "worker",
			status: "running", startedAt: previous?.startedAt ?? activity.startedAt ?? now,
		};
		const description = firstLine(activity.prompt) ?? previous?.description;
		if (description) entry.description = description;
		const model = session?.model?.id ?? previous?.model;
		if (model) entry.model = model;
		const thinking = session?.thinkingLevel ?? previous?.thinking;
		if (thinking) entry.thinking = thinking;
		if (session) entry.session = session;
		this.#put(entry);
	}

	/** Removes every entry of this publisher (abort, lost lock, session shutdown). */
	clear(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#current.clear();
		for (const id of [...this.#ids]) this.#remove(id);
	}

	#finish(entry: ExternalAgent, status: ExternalAgent["status"], now: number): void {
		const { session: _disposed, ...rest } = entry;
		this.#put({ ...rest, status, completedAt: now });
		this.#schedule();
	}

	#put(entry: ExternalAgent): void {
		this.#ids.add(entry.id);
		this.#registry.agents.set(entry.id, entry);
		this.#notify(entry.id);
	}

	#remove(id: string): void {
		this.#ids.delete(id);
		if (this.#registry.agents.delete(id)) this.#notify(id);
	}

	#notify(id: string): void {
		for (const listener of [...this.#registry.listeners]) {
			try { listener(id); } catch {}
		}
	}

	/** One timer for the earliest expiry; it removes what expired and re-arms for the rest. */
	#schedule(): void {
		if (this.#timer) return;
		const finished = [...this.#ids].map((id) => this.#registry.agents.get(id)?.completedAt).filter((at) => at !== undefined);
		if (!finished.length) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const now = this.#now();
			for (const id of [...this.#ids]) {
				const entry = this.#registry.agents.get(id);
				if (!entry) this.#ids.delete(id);
				else if (entry.completedAt !== undefined && now - entry.completedAt >= this.#ttlMs) this.#remove(id);
			}
			this.#schedule();
		}, Math.max(0, Math.min(...finished) + this.#ttlMs - this.#now()));
		this.#timer.unref?.();
	}
}
