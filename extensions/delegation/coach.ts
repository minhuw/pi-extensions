import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { swarmBoards, type SwarmBoard } from "./board.ts";

/**
 * A nudge once when the context is `contextShare` percent full, a wake-up when a running background agent has sent no
 * telemetry for `stallMs` (or `activeToolStallMs` while running a tool), checked every `checkMs`, and a wake-up when a
 * subagent marks a swarm board card `blocked`.
 */
export const COACH = { contextShare: 50, stallMs: 10 * 60_000, activeToolStallMs: 25 * 60_000, checkMs: 60_000 } as const;

/** Not "swarm": swarm's own state reads its "swarm" messages to tell what the model was told. */
const ENTRY = "swarm-coach";
const COORDINATOR = "coordinator";

export const contextText = (percent: number) => `Swarm mode: your context is ${percent}% full. Delegate the remaining investigation and implementation to background agents and keep only their summaries.`;

/** What a stalled agent's telemetry says about it. */
export interface StalledAgent {
	agentId: string;
	type: string;
	description: string;
	idleMs: number;
	activeTools?: readonly string[];
}

export const stallText = (agents: readonly StalledAgent[]) => {
	const anyActive = agents.some((agent) => (agent.activeTools?.length ?? 0) > 0);
	const allActive = agents.every((agent) => (agent.activeTools?.length ?? 0) > 0);
	const list = agents.map(({ agentId, type, description, idleMs, activeTools }) => {
		const mins = Math.floor(idleMs / 60_000);
		const detail = activeTools && activeTools.length > 0
			? `running ${activeTools.join(", ")} for ${mins} min`
			: `idle ${mins} min`;
		return `${agentId} (${type}, "${description}", ${detail})`;
	}).join("; ");
	const subject = agents.length === 1 ? "a background agent has" : `${agents.length} background agents have`;
	const reason = !anyActive
		? "run no tool and reported nothing for a while"
		: allActive
			? "been stuck in a tool call with no telemetry for a while"
			: "stalled with no telemetry for a while";
	return `Swarm mode: ${subject} ${reason}: ${list}. `
		+ "Check each with get_subagent_result (pass verbose: true to inspect progress; do not pass wait: true), redirect it with steer_subagent, or drop its card on swarm_board to stop and relaunch it.";
};

/** A swarm board card a subagent marked blocked. */
export interface BlockedCard {
	id: string;
	title: string;
	agent?: string;
	agentId?: string;
	note?: string;
}

export const blockedText = (cards: readonly BlockedCard[]) => {
	const list = cards.map(({ id, title, agent, agentId, note }) => {
		const who = [agent, agentId].filter(Boolean).join(" ");
		const head = who ? `${id} (${who}, "${title}")` : `${id} ("${title}")`;
		return note ? `${head}: ${note}` : head;
	}).join("; ");
	return `Swarm mode: ${cards.length === 1 ? "a subagent marked a board card" : `${cards.length} board cards were marked`} blocked: ${list}. `
		+ "Inspect the blocker, unblock or steer the subagent, or take over the card.";
};

/** The fields of pi-subagents' `subagents:telemetry` payload the coach reads. */
interface Telemetry {
	phase: "started" | "updated" | "compacted" | "completed";
	owner?: string;
	parentAgentId?: string;
	agentId: string;
	status: string;
	type: string;
	description: string;
	activeTools: string[];
	parentSessionId?: string;
}

interface Tracked { telemetry: Telemetry; receivedAt: number; reported: boolean }

export interface CoachOptions { stallMs?: number; activeToolStallMs?: number; checkMs?: number; now?: () => number }

/**
 * Hidden `swarm-coach` messages while swarm mode is on: the context nudge joins a run's next request and never starts a
 * turn; the stall and blocked-card notices wake an idle session. Appended messages leave the cached prefix intact.
 * `isOn` tells whether swarm mode applies to the session and branch.
 */
export function registerCoach(pi: ExtensionAPI, isOn: (ctx: ExtensionContext) => boolean, options: CoachOptions = {}): void {
	const stallMs = options.stallMs ?? COACH.stallMs;
	const activeToolStallMs = options.activeToolStallMs ?? COACH.activeToolStallMs;
	const checkMs = options.checkMs ?? COACH.checkMs;
	const now = options.now ?? Date.now;
	let nudged = false;
	let current: ExtensionContext | undefined;
	const agents = new Map<string, Tracked>();
	const reportedBlocked = new Map<string, string>();
	let timer: ReturnType<typeof setInterval> | undefined;

	function stopTimer(): void {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	}

	function seedBlocked(ctx: ExtensionContext): void {
		reportedBlocked.clear();
		let sessionId: string;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			return;
		}
		const board = swarmBoards().boards.get(sessionId);
		if (!board) return;
		for (const card of board.cards) {
			if (card.status === "blocked") reportedBlocked.set(card.id, card.note ?? "");
		}
	}

	function onBoard(board: SwarmBoard): void {
		const ctx = current;
		if (!ctx) return;
		let sessionId: string;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			return;
		}
		if (board.sessionId !== sessionId) return;

		const blockedIds = new Set(board.cards.filter((card) => card.status === "blocked").map((card) => card.id));
		for (const id of reportedBlocked.keys()) {
			if (!blockedIds.has(id)) reportedBlocked.delete(id);
		}

		try {
			if (!isOn(ctx)) return;
		} catch {
			return;
		}

		const newlyBlocked: BlockedCard[] = [];
		for (const card of board.cards) {
			if (card.status !== "blocked" || card.updatedBy === COORDINATOR) continue;
			if (reportedBlocked.get(card.id) === (card.note ?? "")) continue;
			newlyBlocked.push({
				id: card.id,
				title: card.title,
				...(card.agent !== undefined ? { agent: card.agent } : {}),
				...(card.agentId !== undefined ? { agentId: card.agentId } : {}),
				...(card.note !== undefined ? { note: card.note } : {}),
			});
		}
		if (newlyBlocked.length === 0) return;
		try {
			pi.sendMessage({ customType: ENTRY, content: blockedText(newlyBlocked), display: false }, { deliverAs: "steer", triggerTurn: true });
			for (const card of newlyBlocked) reportedBlocked.set(card.id, card.note ?? "");
		} catch {}
	}

	function check(): void {
		const ctx = current;
		if (!ctx) return;
		const at = now();
		const stalled: StalledAgent[] = [];
		const marked: Tracked[] = [];
		try {
			if (!isOn(ctx)) return;
		} catch {
			// A stale context: the session is gone.
			return;
		}
		for (const tracked of agents.values()) {
			const { telemetry, receivedAt, reported } = tracked;
			const threshold = telemetry.activeTools.length > 0 ? activeToolStallMs : stallMs;
			if (reported || telemetry.status !== "running" || at - receivedAt < threshold) continue;
			stalled.push({
				agentId: telemetry.agentId,
				type: telemetry.type,
				description: telemetry.description,
				idleMs: at - receivedAt,
				...(telemetry.activeTools.length > 0 ? { activeTools: telemetry.activeTools } : {}),
			});
			marked.push(tracked);
		}
		if (stalled.length === 0) return;
		try {
			// A steer while streaming; when idle, `triggerTurn` starts a turn so the coordinator acts on it.
			pi.sendMessage({ customType: ENTRY, content: stallText(stalled), display: false }, { deliverAs: "steer", triggerTurn: true });
			for (const tracked of marked) tracked.reported = true;
		} catch {}
	}

	pi.on("session_start", (_event, ctx) => {
		nudged = false;
		current = ctx;
		agents.clear();
		stopTimer();
		seedBlocked(ctx);
		swarmBoards().listeners.add(onBoard);
	});
	pi.on("session_tree", (_event, ctx) => {
		nudged = false;
		current = ctx;
		seedBlocked(ctx);
	});
	pi.on("session_compact", () => { nudged = false; });
	pi.on("session_shutdown", () => {
		current = undefined;
		agents.clear();
		reportedBlocked.clear();
		stopTimer();
		swarmBoards().listeners.delete(onBoard);
	});

	pi.events.on("subagents:telemetry", (data) => {
		const telemetry = data as Telemetry;
		const ctx = current;
		// The session's own top-level agents: owned and nested agents report through their owner.
		if (!ctx || telemetry.owner !== undefined || telemetry.parentAgentId !== undefined) return;
		try {
			if (telemetry.parentSessionId !== undefined && telemetry.parentSessionId !== ctx.sessionManager.getSessionId()) return;
		} catch {
			return;
		}
		if (telemetry.phase === "completed") agents.delete(telemetry.agentId);
		else agents.set(telemetry.agentId, { telemetry, receivedAt: now(), reported: false });
		if (agents.size === 0) stopTimer();
		else if (timer === undefined) {
			timer = setInterval(check, checkMs);
			timer.unref?.();
		}
	});

	pi.on("turn_end", (event, ctx) => {
		// Only before a turn that follows anyway: a steer after the final turn would make one more request.
		if (nudged || event.toolResults.length === 0 || ctx.isIdle()) return;
		const percent = ctx.getContextUsage()?.percent;
		if (percent == null || percent < COACH.contextShare || !isOn(ctx)) return;
		nudged = true;
		try { pi.sendMessage({ customType: ENTRY, content: contextText(Math.floor(percent)), display: false }, { deliverAs: "steer" }); } catch {}
	});
}
