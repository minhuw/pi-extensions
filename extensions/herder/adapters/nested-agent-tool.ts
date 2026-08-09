import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ManagerAction } from "../src/shared/protocol.ts";
import { getSubagentHost } from "../../subagents/src/host-registry.ts";
import { resolveModel } from "../../subagents/src/model-resolver.ts";
import { parseServiceTier } from "../../subagents/src/service-tier.ts";
import type { ThinkingLevel } from "../../subagents/src/types.ts";

const MAX_NESTED_CALLS = 8;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface NestedAgentToolDetails {
	agentId: string;
	status: string;
	type: string;
	displayName: string;
	turnCount: number;
	maxTurns?: number;
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

function resultText(output: string, details: NestedAgentToolDetails): string {
	const turns = details.maxTurns == null ? `↻${details.turnCount}` : `↻${details.turnCount}≤${details.maxTurns}`;
	const stats = [turns, `${details.toolUses} tool${details.toolUses === 1 ? "" : "s"}`, compactTokens(details.lifetimeTokens), `${(details.durationMs / 1_000).toFixed(1)}s`].join(" · ");
	if (details.status === "error" || details.status === "aborted" || details.status === "stopped") {
		return `Agent ${details.status}: ${details.error ?? "child did not complete"}\n${stats}${output.trim() ? `\n\nPartial output:\n${output.trim()}` : ""}`;
	}
	if (details.status === "steered") {
		return `Agent wrapped up at the turn limit; output may be partial (${stats}).\n\n${output.trim() || "No output."}`;
	}
	return `Agent completed (${stats}).\n\n${output.trim() || "No output."}`;
}

/** Create the one foreground-only Agent tool scoped to a single Herder worker. */
export function createNestedAgentTool(pi: ExtensionAPI, action: ManagerAction) {
	let calls = 0;
	return defineTool({
		name: "Agent",
		label: "Agent",
		description: "Delegate one bounded foreground task to an isolated generic subagent. The parent Herder worker remains accountable for checking and integrating the result.",
		promptSnippet: "Delegate bounded foreground work to an isolated subagent",
		promptGuidelines: [
			"Use Agent only for a bounded subtask. It runs in the current stable Herder worktree, without extensions, skills, orchestration tools, background execution, resume, or worktree creation.",
			"You remain accountable for verifying the child's claims and for the role's exact terminal contract.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "The bounded task for the child agent." }),
			description: Type.String({ description: "A short 3–5 word UI description." }),
			subagent_type: Type.String({ description: "An enabled generic subagent type exposed by the host." }),
			model: Type.Optional(Type.String({ description: "Optional provider/model or fuzzy model override." })),
			thinking: Type.Optional(Type.String({ description: "Optional thinking level: off, minimal, low, medium, high, xhigh, or max." })),
			service_tier: Type.Optional(Type.String({ description: "Optional OpenAI-compatible service tier." })),
			max_turns: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum child agentic turns." })),
			run_in_background: Type.Optional(Type.Boolean({ description: "Background execution is unsupported; omit or set false." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.run_in_background === true) throw new Error("Herder Agent delegation is foreground-only; run_in_background: true is not allowed.");
			if (calls >= MAX_NESTED_CALLS) throw new Error(`Herder workers may call Agent at most ${MAX_NESTED_CALLS} times.`);
			calls += 1;

			const host = getSubagentHost();
			if (!host) throw new Error("The subagents host is unavailable. Ensure the subagents extension is active in the root Pi session.");
			const descriptor = host.resolveType(params.subagent_type);
			if (!descriptor) throw new Error(`Unknown or disabled subagent type: ${JSON.stringify(params.subagent_type)}.`);
			if (action.role !== "plan-implementer" && !descriptor.readOnly) {
				throw new Error(`${action.role} may delegate only to agent types with an explicitly declared read-only built-in tool set; ${descriptor.displayName} is not read-only.`);
			}

			let resolvedModel;
			if (params.model) {
				const resolved = resolveModel(params.model, ctx.modelRegistry);
				if (typeof resolved === "string") throw new Error(resolved);
				resolvedModel = resolved;
			}
			let thinking: ThinkingLevel | undefined;
			if (params.thinking) {
				if (!THINKING_LEVELS.has(params.thinking)) throw new Error(`Unknown thinking level: ${JSON.stringify(params.thinking)}.`);
				thinking = params.thinking as ThinkingLevel;
			}
			const serviceTier = params.service_tier ? parseServiceTier(params.service_tier) : undefined;
			const result = await host.spawnAndWait(pi, ctx, {
				prompt: params.prompt,
				description: params.description,
				type: descriptor.name,
				resolvedModel,
				thinking,
				serviceTier,
				maxTurns: params.max_turns,
				signal,
				isolated: true,
				cwd: action.worktree,
				metadata: {
					owner: "herder",
					rootActionId: action.actionId,
					planId: action.planId,
				},
			});
			const details: NestedAgentToolDetails = {
				agentId: result.id,
				status: result.status,
				type: descriptor.name,
				displayName: descriptor.displayName,
				turnCount: result.turnCount,
				maxTurns: result.maxTurns,
				toolUses: result.toolUses,
				lifetimeTokens: result.lifetimeTokens,
				contextPercent: result.contextPercent,
				compactionCount: result.compactionCount,
				durationMs: Math.max(0, (result.completedAt ?? Date.now()) - result.startedAt),
				error: result.error,
			};
			return { content: [{ type: "text" as const, text: resultText(result.output, details) }], details };
		},
	});
}
