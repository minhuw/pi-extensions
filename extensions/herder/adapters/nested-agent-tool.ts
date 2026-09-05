import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	HerderNestedAgentScope,
	type NestedAgentResult,
	type PiNestedAgentSnapshot,
} from "./nested-agent-executor.ts";
import type { HerderNestedAgentType } from "./role-config.ts";

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

/** Create Agent and direct-child result tools for this action or reviewer scope. */
export function createNestedAgentTools(scope: HerderNestedAgentScope) {
	const agentTool = defineTool({
		name: "Agent",
		label: "Agent",
		description: [
			"Delegate one bounded task to a package-owned Herder nested agent.",
			`Up to ${scope.maxConcurrency} children may run concurrently for this role and at most ${scope.maxCalls} may be launched in this scope.`,
			"Set run_in_background to continue working while the child runs, then call get_subagent_result before returning the role's final answer.",
			"recon and searcher use the package-owned scout binding gpt-5.6-luna at max on the fast tier. worker and reviewer inherit this role's exact model, thinking level, and service tier.",
			"Every child inherits this action's stable worktree and lifetime.",
			`Allowed types in this scope: ${scope.allowedTypes.join(", ")}. recon is repository-read-only; searcher is web research with delegated local read-only search; worker may mutate (Implementer only); reviewer independently reviews (root Reviewer only).`,
			"All children load Herder's trusted FFF package; searcher also loads pi-web-access, and worker also loads Ponytail's trusted pi-extension entry.",
			"Only reviewer children get Agent/result tools, restricted to recon leaves: one concurrent scout and two launches total. Other children cannot delegate. No child inherits conversation, skills, scheduling, resume, or a secondary worktree.",
			"recon has a fixed one-hour execution deadline, including setup and retries; timeouts return partial output and never retry automatically.",
		].join(" "),
		promptSnippet: "Delegate bounded foreground or background work to a direct Herder child",
		promptGuidelines: [
			"Use Agent only for a bounded subtask with a self-contained prompt; the child has no parent conversation.",
			`You may launch up to ${scope.maxConcurrency} independent children concurrently. Multiple Agent calls in one response execute in parallel.`,
			"Collect every background child before your final response. For parallel reviews use get_subagent_result with wait_any: true repeatedly, rather than batch waits for specific IDs.",
			"Only nested reviewers may delegate again, to recon leaves only. recon/searcher use the package scout model; worker/reviewer inherit this role's binding and share the stable worktree.",
			"The parent role remains accountable for verifying child claims and repository effects, including concurrent edits in the shared worktree.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Complete self-contained task for the child agent." }),
			description: Type.String({ description: "Short 3–5 word UI description." }),
			subagent_type: Type.String({ description: `Package-owned nested type: ${scope.allowedTypes.join(", ")}.` }),
			run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately with an agent ID. Retrieve it later with get_subagent_result." })),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
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
					content: [{ type: "text" as const, text: `Agent started in background: ${launch.id}. Collect it with get_subagent_result (prefer wait_any: true for parallel children) before returning your final response.` }],
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
			"Use wait_any: true for parallel children: collect whichever finishes first, then repeat. Do not batch waits for every specific ID.",
			"Each wait is bounded to 60 seconds and never cancels the child. Retry collection if it is still running; listing alone does not collect.",
		],
		parameters: Type.Object({
			agent_id: Type.Optional(Type.String({ description: "Direct child ID returned by Agent. Omit both agent_id and wait_any to list all direct children." })),
			wait_any: Type.Optional(Type.Boolean({ description: "Collect one uncollected background direct child, whichever completes first. Mutually exclusive with agent_id. Defaults to waiting when true." })),
			wait: Type.Optional(Type.Boolean({ description: "Wait up to 60 seconds, without cancelling the child. Default: true with agent_id or wait_any: true." })),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			if (params.agent_id !== undefined && params.wait_any !== undefined) {
				throw new Error("agent_id and wait_any are mutually exclusive.");
			}
			const lookup = params.wait_any === true
				? await scope.resultAny(params.wait !== false, signal)
				: params.agent_id !== undefined ? await scope.result(params.agent_id, params.wait !== false, signal) : undefined;
			if (!lookup) {
				const pending = new Set(scope.uncollectedBackgroundIds());
				const snapshots = scope.snapshots().filter((snapshot) => params.wait_any !== true || pending.has(snapshot.agentId));
				return {
					content: [{ type: "text" as const, text: snapshots.length
						? `${params.wait_any === true ? "Agents still running:\n" : ""}${snapshots.map(snapshotLine).join("\n")}`
						: params.wait_any === true ? "No uncollected background agents." : "No nested agents have been launched." }],
					details: { agents: snapshots } as NestedAgentResultToolDetails,
				};
			}
			if (!lookup.result) {
				return {
					content: [{ type: "text" as const, text: `Agent still running: ${snapshotLine(lookup.snapshot)}` }],
					details: { agent: lookup.snapshot } as NestedAgentResultToolDetails,
				};
			}
			const details = resultDetails(lookup.result, lookup.snapshot.type);
			return {
				content: [{ type: "text" as const, text: params.wait_any === true
					? `Collected agent ${lookup.snapshot.agentId} · ${lookup.snapshot.type} · ${lookup.snapshot.description}\n\n${resultText(lookup.result, details)}\n\nUncollected background IDs: ${scope.uncollectedBackgroundIds().join(", ") || "none"}.`
					: resultText(lookup.result, details) }],
				details: { agent: lookup.snapshot, result: details } as NestedAgentResultToolDetails,
			};
		},
	});

	return [agentTool, resultTool] as const;
}
