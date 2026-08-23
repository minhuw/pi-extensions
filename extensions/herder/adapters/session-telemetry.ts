import type { AgentSessionEvent, SessionStats } from "@earendil-works/pi-coding-agent";
import { assistantText, responseActivity } from "./assistant-message.ts";
import { messageUsageTokens, record } from "./usage-accounting.ts";

export interface SessionTelemetrySnapshot {
	turns: number;
	toolUses: number;
	lifetimeTokens: number;
	contextPercent: number | null;
	compactionCount: number;
	activeTools: string[];
	responseText?: string;
	activity?: string;
}

export interface SessionTelemetryTarget {
	snapshot: SessionTelemetrySnapshot;
	activeToolCalls: Map<string, string>;
	session?: Pick<SessionTelemetrySession, "getSessionStats">;
}

export interface SessionTelemetrySession {
	getSessionStats(): SessionStats;
}

export type AgentStartHook = () => void;

export function cloneActiveTools(activeTools: Iterable<string>): string[] {
	return [...activeTools];
}

export function cloneSessionSnapshot<T extends { activeTools: readonly string[] }>(snapshot: T): T {
	return { ...snapshot, activeTools: cloneActiveTools(snapshot.activeTools) } as T;
}

export function refreshSessionActivity(target: SessionTelemetryTarget): void {
	target.snapshot.activeTools = cloneActiveTools(target.activeToolCalls.values());
	target.snapshot.activity = target.snapshot.activeTools[0] ?? responseActivity(target.snapshot.responseText);
}

export function refreshSessionContext(target: SessionTelemetryTarget): void {
	const stats = target.session?.getSessionStats();
	if (!stats) return;
	target.snapshot.contextPercent = stats.contextUsage?.percent ?? null;
}

export function observeSessionEvent(
	target: SessionTelemetryTarget,
	event: AgentSessionEvent,
	onAgentStart?: AgentStartHook,
): boolean {
	let changed = false;
	if (event.type === "agent_start") {
		if (onAgentStart) {
			onAgentStart();
			changed = true;
		}
	} else if (event.type === "turn_start") {
		target.snapshot.turns += 1;
		changed = true;
	} else if (event.type === "message_start" && event.message.role === "assistant") {
		delete target.snapshot.responseText;
		refreshSessionActivity(target);
	} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		target.snapshot.responseText = (target.snapshot.responseText ?? "") + event.assistantMessageEvent.delta;
		refreshSessionActivity(target);
		// Keep token streaming cheap; the next meaningful state/stat event emits.
	} else if (event.type === "tool_execution_start") {
		target.snapshot.toolUses += 1;
		target.activeToolCalls.set(event.toolCallId, event.toolName);
		refreshSessionActivity(target);
		changed = true;
	} else if (event.type === "tool_execution_end") {
		target.activeToolCalls.delete(event.toolCallId);
		refreshSessionActivity(target);
		changed = true;
	} else if (event.type === "compaction_start") {
		target.snapshot.activity = "compacting";
		changed = true;
	} else if (event.type === "compaction_end") {
		if (!event.aborted && event.result) target.snapshot.compactionCount += 1;
		refreshSessionActivity(target);
		changed = true;
	}
	if (event.type === "message_end" && record(event.message)?.role === "assistant") {
		target.snapshot.lifetimeTokens += messageUsageTokens(record(event.message)?.usage);
		const text = assistantText(event.message);
		if (text !== undefined) target.snapshot.responseText = text;
		refreshSessionActivity(target);
		refreshSessionContext(target);
		changed = true;
	} else if (event.type === "agent_end" || event.type === "agent_settled") {
		refreshSessionContext(target);
		changed = true;
	}
	return changed;
}
