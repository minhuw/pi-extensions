import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ManagerAction } from "../src/shared/protocol.ts";
import {
	HerderNestedAgentScope,
	MAX_NESTED_CONCURRENCY_PER_ACTION,
	type NestedAgentResult,
	type PiNestedAgentSnapshot,
} from "./nested-agent-executor.ts";
import { HERDER_NESTED_AGENT_TYPES, type HerderNestedAgentType } from "./role-config.ts";

const MAX_NESTED_CALLS = 8;

export interface NestedAgentToolDetails {
	agentId: string;
	status: string;
	type: string;
	displayName: string;
	turnCount: number;
	toolUses: number;
	lifetimeTokens: number;
	contextPercent: number | null;
	compactionCount: number;
	durationMs: number;
	background?: boolean;
	error?: string;
}

interface NestedAgentResultToolDetails {
	agents?: PiNestedAgentSnapshot[];
	agent?: PiNestedAgentSnapshot;
	result?: NestedAgentToolDetails;
}

function compactTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}t`;
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 100_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function displayName(type: string): string {
	return type.charAt(0).toUpperCase() + type.slice(1);
}

function resultDetails(result: NestedAgentResult, type: string): NestedAgentToolDetails {
	return {
		agentId: result.id,
		status: result.status,
		type,
		displayName: displayName(type),
		turnCount: result.turnCount,
		toolUses: result.toolUses,
		lifetimeTokens: result.lifetimeTokens,
		contextPercent: result.contextPercent,
		compactionCount: result.compactionCount,
		durationMs: Math.max(0, result.completedAt - result.startedAt),
		...(result.error ? { error: result.error } : {}),
	};
}

function resultText(result: NestedAgentResult, details: NestedAgentToolDetails): string {
	const turns = `↻${details.turnCount}`;
	const stats = [turns, `${details.toolUses} tool${details.toolUses === 1 ? "" : "s"}`, compactTokens(details.lifetimeTokens), `${(details.durationMs / 1_000).toFixed(1)}s`].join(" · ");
	if (details.status !== "completed") {
		return `Agent ${details.status}: ${details.error ?? "child did not complete"}\n${stats}${result.output.trim() ? `\n\nPartial output:\n${result.output.trim()}` : ""}`;
	}
	return `Agent completed (${stats}).\n\n${result.output.trim() || "No output."}`;
}

function agentIdentity(snapshot: Pick<PiNestedAgentSnapshot, "model" | "effort" | "serviceTier">): string {
	return [snapshot.model, snapshot.effort, snapshot.serviceTier]
		.map((value) => (typeof value === "string" ? value.trim() : ""))
		.filter(Boolean)
		.join(" · ");
}

function snapshotLine(snapshot: PiNestedAgentSnapshot): string {
	const identity = agentIdentity(snapshot);
	const name = identity ? `${snapshot.displayName} · ${identity}` : snapshot.displayName;
	return `${snapshot.agentId} · ${name} · ${snapshot.status} · ↻${snapshot.turns} · ${snapshot.description}`;
}

/** Create the one-level Agent and result tools scoped to a single Herder action. */
export function createNestedAgentTools(action: ManagerAction, scope: HerderNestedAgentScope) {
	let calls = 0;
	const agentTool = defineTool({
		name: "Agent",
		label: "Agent",
		description: [
			"Delegate one bounded task to a package-owned Herder nested agent.",
			`Up to ${MAX_NESTED_CONCURRENCY_PER_ACTION} children may run concurrently for this role and at most ${MAX_NESTED_CALLS} may be launched in the action.`,
			"Set run_in_background to continue working while the child runs, then call get_subagent_result before returning the role's final answer.",
			"recon and searcher use the package-owned scout binding gpt-5.6-luna at max on the fast tier. worker inherits this role's exact model, thinking level, and service tier.",
			"Every child inherits this action's stable worktree and lifetime.",
			"Available types: recon is repository-read-only, searcher has allowlisted remote web tools, and worker may mutate and is available only to Implementer roles.",
			"Nested children have no Agent tool, extensions, skills, inherited conversation, scheduling, resume, or secondary worktree.",
		].join(" "),
		promptSnippet: "Delegate bounded foreground or background work to a one-level Herder child",
		promptGuidelines: [
			"Use Agent only for a bounded subtask with a self-contained prompt; the child has no parent conversation.",
			`You may launch up to ${MAX_NESTED_CONCURRENCY_PER_ACTION} independent children concurrently. Multiple Agent calls in one response execute in parallel.`,
			"For background children, retain every returned ID and collect each one with get_subagent_result before your final response.",
			"Herder Agent children cannot delegate again. recon/searcher use the package scout model; worker inherits this role's model and shares the stable worktree.",
			"The parent role remains accountable for verifying child claims and repository effects, including concurrent edits in the shared worktree.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Complete self-contained task for the child agent." }),
			description: Type.String({ description: "Short 3–5 word UI description." }),
			subagent_type: Type.String({ description: `Package-owned nested type: ${HERDER_NESTED_AGENT_TYPES.join(", ")}.` }),
			run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately with an agent ID. Retrieve it later with get_subagent_result." })),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			if (calls >= MAX_NESTED_CALLS) throw new Error(`Herder workers may call Agent at most ${MAX_NESTED_CALLS} times.`);
			if (!HERDER_NESTED_AGENT_TYPES.includes(params.subagent_type as HerderNestedAgentType)) {
				throw new Error(`Unknown Herder nested agent type: ${JSON.stringify(params.subagent_type)}.`);
			}
			calls += 1;
			const request = {
				type: params.subagent_type as HerderNestedAgentType,
				prompt: params.prompt,
				description: params.description,
			};
			if (params.run_in_background === true) {
				const launch = await scope.spawnBackground(request, signal);
				const details: NestedAgentToolDetails = {
					agentId: launch.id,
					status: launch.snapshot.status,
					type: launch.snapshot.type,
					displayName: launch.snapshot.displayName,
					turnCount: launch.snapshot.turns,
					toolUses: launch.snapshot.toolUses,
					lifetimeTokens: launch.snapshot.lifetimeTokens,
					contextPercent: launch.snapshot.contextPercent,
					compactionCount: launch.snapshot.compactionCount,
					durationMs: 0,
					background: true,
				};
				return {
					content: [{ type: "text" as const, text: `Agent started in background: ${launch.id}. Call get_subagent_result with this ID before returning your final response.` }],
					details,
				};
			}
			const result = await scope.run(request, signal);
			const details = resultDetails(result, params.subagent_type);
			return { content: [{ type: "text" as const, text: resultText(result, details) }], details };
		},
	});

	const resultTool = defineTool({
		name: "get_subagent_result",
		label: "Get Subagent Result",
		description: "List this role's direct Herder children or retrieve one background child's current/final result. This tool cannot access standalone subagents or grandchildren.",
		promptSnippet: "Collect a direct background Herder child",
		promptGuidelines: [
			"Collect every background child before returning the role's final response.",
			"Use wait: true to block efficiently until the selected child settles; multiple result calls may wait in parallel.",
		],
		parameters: Type.Object({
			agent_id: Type.Optional(Type.String({ description: "Direct child ID returned by Agent. Omit to list all direct children." })),
			wait: Type.Optional(Type.Boolean({ description: "Wait for completion. Default: true when agent_id is supplied." })),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			if (!params.agent_id) {
				const snapshots = scope.snapshots();
				return {
					content: [{ type: "text" as const, text: snapshots.length ? snapshots.map(snapshotLine).join("\n") : "No nested agents have been launched." }],
					details: { agents: snapshots } as NestedAgentResultToolDetails,
				};
			}
			const lookup = await scope.result(params.agent_id, params.wait !== false, signal);
			if (!lookup.result) {
				return {
					content: [{ type: "text" as const, text: `Agent still running: ${snapshotLine(lookup.snapshot)}` }],
					details: { agent: lookup.snapshot } as NestedAgentResultToolDetails,
				};
			}
			const details = resultDetails(lookup.result, lookup.snapshot.type);
			return {
				content: [{ type: "text" as const, text: resultText(lookup.result, details) }],
				details: { agent: lookup.snapshot, result: details } as NestedAgentResultToolDetails,
			};
		},
	});

	return [agentTool, resultTool] as const;
}

/** Compatibility helper for tests and callers that need only the Agent tool. */
export function createNestedAgentTool(action: ManagerAction, scope: HerderNestedAgentScope) {
	return createNestedAgentTools(action, scope)[0];
}
