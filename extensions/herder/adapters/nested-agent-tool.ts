import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ManagerAction } from "../src/shared/protocol.ts";
import {
	HerderNestedAgentScope,
	type NestedAgentResult,
} from "./nested-agent-executor.ts";
import { HERDER_NESTED_AGENT_TYPES, type HerderNestedAgentType } from "./role-config.ts";

const MAX_NESTED_CALLS = 8;

export interface NestedAgentToolDetails {
	agentId: string;
	status: string;
	type: string;
	displayName: string;
	turnCount: number;
	maxTurns: number;
	toolUses: number;
	lifetimeTokens: number;
	contextPercent: number | null;
	compactionCount: number;
	durationMs: number;
	error?: string;
}

function compactTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}t`;
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function displayName(type: string): string {
	return type.charAt(0).toUpperCase() + type.slice(1);
}

function resultText(result: NestedAgentResult, details: NestedAgentToolDetails): string {
	const turns = `↻${details.turnCount}≤${details.maxTurns}`;
	const stats = [turns, `${details.toolUses} tool${details.toolUses === 1 ? "" : "s"}`, compactTokens(details.lifetimeTokens), `${(details.durationMs / 1_000).toFixed(1)}s`].join(" · ");
	if (details.status === "limited") {
		return `Agent reached the turn limit; output may be partial (${stats}).\n\n${result.output.trim() || "No output."}`;
	}
	if (details.status !== "completed") {
		return `Agent ${details.status}: ${details.error ?? "child did not complete"}\n${stats}${result.output.trim() ? `\n\nPartial output:\n${result.output.trim()}` : ""}`;
	}
	return `Agent completed (${stats}).\n\n${result.output.trim() || "No output."}`;
}

/** Create the one-level, foreground-only Agent tool scoped to a single Herder action. */
export function createNestedAgentTool(action: ManagerAction, scope: HerderNestedAgentScope) {
	let calls = 0;
	return defineTool({
		name: "Agent",
		label: "Agent",
		description: [
			"Delegate one bounded foreground task to a package-owned Herder nested agent.",
			"The child inherits this role's exact model, thinking level, service tier, stable worktree, and action lifetime.",
			"Available types: recon and reviewer are strictly read-only; worker may mutate and is available only to Implementer roles.",
			"Nested children have no Agent tool, extensions, skills, inherited conversation, scheduling, resume, or secondary worktree.",
		].join(" "),
		promptSnippet: "Delegate bounded foreground work to a one-level Herder child",
		promptGuidelines: [
			"Use Agent only for a bounded subtask with a self-contained prompt; the child has no parent conversation.",
			"Herder Agent children inherit the current action's exact model and worktree and cannot delegate again.",
			"The parent role remains accountable for verifying the child's claims and repository effects.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Complete self-contained task for the child agent." }),
			description: Type.String({ description: "Short 3–5 word UI description." }),
			subagent_type: Type.String({ description: `Package-owned nested type: ${HERDER_NESTED_AGENT_TYPES.join(", ")}.` }),
			max_turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 64, description: "Maximum child agentic turns. Default: 8." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			if (calls >= MAX_NESTED_CALLS) throw new Error(`Herder workers may call Agent at most ${MAX_NESTED_CALLS} times.`);
			if (!HERDER_NESTED_AGENT_TYPES.includes(params.subagent_type as HerderNestedAgentType)) {
				throw new Error(`Unknown Herder nested agent type: ${JSON.stringify(params.subagent_type)}.`);
			}
			calls += 1;
			const result = await scope.run({
				type: params.subagent_type as HerderNestedAgentType,
				prompt: params.prompt,
				description: params.description,
				maxTurns: params.max_turns,
			}, signal);
			const details: NestedAgentToolDetails = {
				agentId: result.id,
				status: result.status,
				type: params.subagent_type,
				displayName: displayName(params.subagent_type),
				turnCount: result.turnCount,
				maxTurns: result.maxTurns,
				toolUses: result.toolUses,
				lifetimeTokens: result.lifetimeTokens,
				contextPercent: result.contextPercent,
				compactionCount: result.compactionCount,
				durationMs: Math.max(0, result.completedAt - result.startedAt),
				...(result.error ? { error: result.error } : {}),
			};
			return { content: [{ type: "text" as const, text: resultText(result, details) }], details };
		},
	});
}
