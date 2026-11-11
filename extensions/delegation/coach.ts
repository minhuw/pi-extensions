import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * A nudge once when the context is `contextShare` percent full, and a wake-up when a running background agent has had no
 * active tool and sent no telemetry for `stallMs`, checked every `checkMs`.
 */
export const COACH = { contextShare: 50, stallMs: 10 * 60_000, checkMs: 60_000 } as const;

/** Not "swarm": swarm's own state reads its "swarm" messages to tell what the model was told. */
const ENTRY = "swarm-coach";

export const contextText = (percent: number) => `Swarm mode: your context is ${percent}% full. Delegate the remaining investigation and implementation to background agents and keep only their summaries.`;

/** What a stalled agent's telemetry says about it. */
export interface StalledAgent { agentId: string; type: string; description: string; idleMs: number }

export const stallText = (agents: readonly StalledAgent[]) => {
	const list = agents.map(({ agentId, type, description, idleMs }) => `${agentId} (${type}, "${description}", idle ${Math.floor(idleMs / 60_000)} min)`).join("; ");
	return `Swarm mode: ${agents.length === 1 ? "a background agent has" : `${agents.length} background agents have`} run no tool and reported nothing for a while: ${list}. `
		+ "Check each with get_subagent_result, redirect it with steer_subagent, or stop and relaunch it.";
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

export interface CoachOptions { stallMs?: number; checkMs?: number; now?: () => number }

/**
 * Hidden `swarm-coach` messages while swarm mode is on: the context nudge joins a run's next request and never starts a
 * turn; the stall notice wakes an idle session. Appended messages leave the cached prefix intact. `isOn` tells whether
 * swarm mode applies to the session and branch.
 */
export function registerCoach(pi: ExtensionAPI, isOn: (ctx: ExtensionContext) => boolean, options: CoachOptions = {}): void {
	const stallMs = options.stallMs ?? COACH.stallMs;
	const checkMs = options.checkMs ?? COACH.checkMs;
	const now = options.now ?? Date.now;
	let nudged = false;
	let current: ExtensionContext | undefined;
	const agents = new Map<string, Tracked>();
	let timer: ReturnType<typeof setInterval> | undefined;

	function stopTimer(): void {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
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
			if (reported || telemetry.status !== "running" || telemetry.activeTools.length > 0 || at - receivedAt < stallMs) continue;
			stalled.push({ agentId: telemetry.agentId, type: telemetry.type, description: telemetry.description, idleMs: at - receivedAt });
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
	});
	pi.on("session_compact", () => { nudged = false; });
	pi.on("session_shutdown", () => {
		current = undefined;
		agents.clear();
		stopTimer();
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
