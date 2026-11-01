// Ticket agents on Subagents, driven over its cross-extension RPC on `pi.events`; see DESIGN.md "Ticket agents" and
// extensions/subagents/docs/rpc.md. Superagent imports nothing from Subagents: the bus and the shapes are the contract.
import { randomUUID } from "node:crypto";
import { registerTicket, ticketKey, type TicketHookTarget } from "./hook.ts";
import { LINK_KEY, SUBAGENTS_PROTOCOL, TICKET_AGENT_TYPE, type Ticket, type WorkerEvent, type WorkerHost, type WorkerStart } from "./types.ts";

/** The part of `pi.events` the host uses. */
export interface RpcBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export interface SubagentsHostOptions {
	events: RpcBus;
	/** Git common dir of the repository: with a ticket id, the key child sessions find their ticket by. */
	commonDir: string;
	/** The ticket as it is now. */
	ticket(ticketId: number): Ticket | undefined;
	onEvent(event: WorkerEvent): void;
	/** Reply timeout of ping, send, and stop (default 10 s). */
	timeoutMs?: number;
	/** Reply timeout of spawn and reopen, which wait for the agent to start (default 60 s). */
	startTimeoutMs?: number;
	/** How long `stop` waits for the stopped run to settle (default 5 s). */
	stopGraceMs?: number;
}

export const PROTOCOL_REQUIRED = `Subagents with RPC protocol ${SUBAGENTS_PROTOCOL} is required to run tickets`;

/** A `{ success: false }` reply; `message` is Subagents' error text as is. */
export class RpcError extends Error {}

type Envelope = { success: true; data?: unknown } | { success: false; error?: string };

/** `subagents:started` / `:completed` / `:failed` payloads, as far as superagent reads them. */
interface Lifecycle {
	id?: unknown;
	status?: unknown;
	result?: unknown;
	error?: unknown;
	toolUses?: unknown;
	runToolUses?: unknown;
	sessionFile?: unknown;
}

type LifecycleKind = "started" | "completed" | "failed";

interface Live {
	ticketId: number;
	agentId?: string;
	running: boolean;
	unregister: () => void;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Lifecycle events for agents whose spawn reply has not arrived yet (Subagents emits `started` before replying). */
const EARLY_LIMIT = 64;

export function createSubagentsHost(options: SubagentsHostOptions): WorkerHost {
	const { events } = options;
	const timeoutMs = options.timeoutMs ?? 10_000;
	const startTimeoutMs = options.startTimeoutMs ?? 60_000;
	const stopGraceMs = options.stopGraceMs ?? 5_000;
	const lives = new Map<number, Live>();
	/** Agent id → ticket id, for the agents this host runs. */
	const agents = new Map<string, number>();
	const early = new Map<string, [LifecycleKind, Lifecycle][]>();
	/** Agents being stopped: their settlement resolves the waiter, and is not a run end. */
	const settling = new Map<string, () => void>();
	let protocol: Promise<void> | undefined;
	let disposed = false;

	const emit = (event: WorkerEvent) => { try { options.onEvent(event); } catch {} };

	function rpc<T>(verb: string, params: Record<string, unknown>, ms = timeoutMs): Promise<T> {
		const channel = `subagents:rpc:${verb}`;
		const requestId = randomUUID();
		return new Promise<T>((resolve, reject) => {
			let unsubscribe = () => {};
			const timer = setTimeout(() => { unsubscribe(); reject(new Error(`no reply to ${channel} within ${ms} ms`)); }, ms);
			unsubscribe = events.on(`${channel}:reply:${requestId}`, (raw) => {
				clearTimeout(timer);
				unsubscribe();
				const reply = raw as Envelope | undefined;
				if (reply?.success === true) resolve(reply.data as T);
				else reject(new RpcError(reply && reply.success === false && typeof reply.error === "string" ? reply.error : `${channel} failed`));
			});
			try { events.emit(channel, { requestId, ...params }); } catch (error) { clearTimeout(timer); unsubscribe(); reject(error); }
		});
	}

	/** Checks `subagents:rpc:ping` once; a failure is checked again at the next use. */
	function ensureProtocol(): Promise<void> {
		return protocol ??= (async () => {
			let version: unknown;
			try {
				version = (await rpc<{ version?: unknown } | undefined>("ping", {}, Math.min(timeoutMs, 5_000)))?.version;
			} catch (error) {
				throw new Error(`${PROTOCOL_REQUIRED}: ${errorText(error)} (is the Subagents extension loaded in this session?)`);
			}
			if (typeof version !== "number" || version < SUBAGENTS_PROTOCOL) {
				throw new Error(`${PROTOCOL_REQUIRED}, and the loaded Subagents speaks protocol ${JSON.stringify(version ?? null)}. Update Subagents.`);
			}
		})().catch((error: unknown) => { protocol = undefined; throw error; });
	}

	function onLifecycle(kind: LifecycleKind, raw: unknown): void {
		const payload = (raw ?? {}) as Lifecycle;
		if (typeof payload.id !== "string") return;
		const id = payload.id;
		if (kind !== "started" && settling.has(id)) { settling.get(id)!(); return; }
		const ticketId = agents.get(id);
		if (ticketId === undefined) {
			const list = early.get(id) ?? [];
			list.push([kind, payload]);
			early.set(id, list);
			while (early.size > EARLY_LIMIT) early.delete(early.keys().next().value!);
			return;
		}
		const live = lives.get(ticketId);
		if (!live || live.agentId !== id) return;
		if (typeof payload.sessionFile === "string") emit({ type: "session", ticketId, sessionFile: payload.sessionFile });
		if (kind === "started") { live.running = true; return; }
		live.running = false;
		const status = typeof payload.status === "string" ? payload.status : kind === "failed" ? "error" : "completed";
		const toolCalls = typeof payload.runToolUses === "number" ? payload.runToolUses : typeof payload.toolUses === "number" ? payload.toolUses : 0;
		const event: Extract<WorkerEvent, { type: "run_end" }> = { type: "run_end", ticketId, text: typeof payload.result === "string" ? payload.result : "", toolCalls };
		const error = typeof payload.error === "string" && payload.error ? payload.error : undefined;
		if (status === "stopped" || status === "aborted") {
			event.aborted = true;
			if (error) event.error = error;
		} else if (kind === "failed" || status === "error") {
			event.error = error ?? "the run failed";
		}
		emit(event);
	}

	const unsubscribers = (["started", "completed", "failed"] as const).map((kind) => events.on(`subagents:${kind}`, (data) => onLifecycle(kind, data)));

	function target(ticketId: number): TicketHookTarget {
		return {
			ticket: () => options.ticket(ticketId),
			report: (report) => emit({ type: "report", ticketId, report }),
			session: (sessionFile) => emit({ type: "session", ticketId, ...(sessionFile !== undefined ? { sessionFile } : {}) }),
		};
	}

	/** Records the agent of a run that just started, and replays its events that came before the reply. */
	function bind(live: Live, agentId: string): void {
		if (live.agentId !== undefined) agents.delete(live.agentId);
		live.agentId = agentId;
		agents.set(agentId, live.ticketId);
		emit({ type: "session", ticketId: live.ticketId, agentId });
		const pending = early.get(agentId);
		early.delete(agentId);
		for (const [kind, payload] of pending ?? []) onLifecycle(kind, payload);
	}

	const runOptions = (ticket: Ticket) => ({
		cwd: ticket.worktree, description: `#${ticket.id} ${ticket.title}`, name: `ticket-${ticket.id}`,
		isBackground: false, notifyParent: false, retain: true,
	});

	async function reopen(live: Live, ticket: Ticket, prompt: string): Promise<void> {
		if (!ticket.sessionFile) throw new Error(`ticket #${ticket.id} has no recorded session file to reopen`);
		const reply = await rpc<{ id?: unknown } | undefined>("reopen", { sessionFile: ticket.sessionFile, type: TICKET_AGENT_TYPE, prompt, options: runOptions(ticket) }, startTimeoutMs);
		if (typeof reply?.id !== "string") throw new Error("subagents:rpc:reopen replied without an agent id");
		bind(live, reply.id);
	}

	async function start({ ticket, prompt, resume, parentToolCallId }: WorkerStart): Promise<void> {
		if (disposed) throw new Error("superagent is shutting down");
		await ensureProtocol();
		const id = ticket.id;
		if (lives.has(id)) throw new Error(`ticket #${id} already has a live agent`);
		const live: Live = { ticketId: id, running: true, unregister: registerTicket(ticketKey(options.commonDir, id), target(id)) };
		lives.set(id, live);
		try {
			if (resume) {
				await reopen(live, ticket, prompt);
			} else {
				const reply = await rpc<{ id?: unknown } | undefined>("spawn", {
					type: TICKET_AGENT_TYPE, prompt,
					options: {
						...runOptions(ticket),
						...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
						linkData: { [LINK_KEY]: { ticketId: id, branch: ticket.branch, title: ticket.title } },
					},
				}, startTimeoutMs);
				if (typeof reply?.id !== "string") throw new Error("subagents:rpc:spawn replied without an agent id");
				bind(live, reply.id);
			}
		} catch (error) {
			if (lives.get(id) === live) lives.delete(id);
			if (live.agentId !== undefined) agents.delete(live.agentId);
			live.unregister();
			throw error;
		}
	}

	async function send(ticketId: number, text: string): Promise<"steered" | "prompted" | "reopened"> {
		const live = lives.get(ticketId);
		if (!live?.agentId) throw new Error(`ticket #${ticketId} has no live agent`);
		await ensureProtocol();
		const agentId = live.agentId;
		const wasRunning = live.running;
		live.running = true;
		try {
			const reply = await rpc<{ delivery?: unknown } | undefined>("send", { agentId, text });
			if (reply?.delivery === "steered") return "steered";
			return "prompted";
		} catch (error) {
			if (error instanceof RpcError && error.message === `Unknown agent "${agentId}"`) {
				// The record is gone (evicted, or Subagents restarted): the same conversation continues from its file.
				const ticket = options.ticket(ticketId);
				if (!ticket) throw new Error(`ticket #${ticketId} does not exist`);
				try {
					await reopen(live, ticket, text);
				} catch (reopenError) {
					if (live.agentId === agentId) live.running = wasRunning;
					throw reopenError;
				}
				return "reopened";
			}
			if (live.agentId === agentId) live.running = wasRunning;
			throw error;
		}
	}

	async function stop(ticketId: number): Promise<void> {
		const live = lives.get(ticketId);
		if (!live) return;
		lives.delete(ticketId);
		live.unregister();
		const agentId = live.agentId;
		if (agentId === undefined) return;
		agents.delete(agentId);
		if (!live.running) return;
		let settled!: () => void;
		const done = new Promise<void>((resolve) => { settled = resolve; });
		settling.set(agentId, settled);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await rpc("stop", { agentId });
			await Promise.race([done, new Promise<void>((resolve) => { timer = setTimeout(resolve, stopGraceMs); })]);
		} catch {
			// "Agent is not running" (it settled meanwhile) or no reply: either way it is not ours any more.
		} finally {
			clearTimeout(timer);
			settling.delete(agentId);
		}
	}

	async function disposeAll(): Promise<void> {
		disposed = true;
		const running = [...lives.values()].filter((live) => live.running && live.agentId !== undefined).map((live) => live.agentId!);
		for (const live of lives.values()) live.unregister();
		lives.clear();
		agents.clear();
		early.clear();
		for (const unsubscribe of unsubscribers) unsubscribe();
		// Subagents stops its agents at its own shutdown too; a short wait covers the order of shutdown handlers.
		await Promise.all(running.map((agentId) => rpc("stop", { agentId }, 1_000).catch(() => {})));
	}

	return {
		start, send, stop, disposeAll,
		isLive: (ticketId) => lives.get(ticketId)?.agentId !== undefined,
		isRunning: (ticketId) => lives.get(ticketId)?.running ?? false,
	};
}
