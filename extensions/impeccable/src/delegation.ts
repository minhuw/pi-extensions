import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getSkillDir, getScriptsDir } from "./resources.ts";

export const DelegateSchema = Type.Object({
	role: Type.Union([Type.Literal("asset-producer"), Type.Literal("documenter"), Type.Literal("finish-reviewer"), Type.Literal("manual-edit-applier"), Type.Literal("assessment-a"), Type.Literal("assessment-b")]),
	task: Type.String({ minLength: 1, maxLength: 32000, description: "Self-contained bounded packet: original request, actual answers, scope, constraints, required role inputs, evidence, output contract; no sibling assessment results" }),
	artifactPaths: Type.Array(Type.String({ minLength: 1, description: "Artifact file path or inspected http(s) URL" }), { minItems: 1, maxItems: 64 }),
	contextPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
	needsBrowser: Type.Optional(Type.Boolean({ description: "Assessment A needs browser inspection: use worker rather than a read-only reviewer" })),
	resume: Type.Optional(Type.String({ minLength: 1, description: "Finish-reviewer verdict continuation only, after valid recapture; returns a handoff when its turn ceiling cannot be enforced" })),
});
type Request = Static<typeof DelegateSchema>;
const incompatibleTags = new Set(["inherit context", "isolated", "background", "worktree"]);

export async function buildDelegation(request: Request, cwd: string) {
	const roles = ["asset-producer", "documenter", "finish-reviewer", "manual-edit-applier", "assessment-a", "assessment-b"];
	if (!roles.includes(request.role) || !request.task.trim() || !request.artifactPaths.length) throw new Error("Provide a known role, a bounded task, and artifact paths.");
	if (request.resume && request.role !== "finish-reviewer") throw new Error("Only a finish-reviewer verdict may resume; assessments require separate fresh contexts.");
	const assessment = request.role.startsWith("assessment-");
	const rolePath = path.join(getSkillDir(), "reference", assessment ? "critique.md" : `agents/impeccable-${request.role}.md`);
	const roleText = (await readFile(rolePath, "utf8")).replaceAll("<skill-base-dir>", getSkillDir());
	const maxTurns = assessment ? 30 : Number(/^max-turns: (\d+)$/m.exec(roleText)?.[1]);
	if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error(`Missing turn ceiling in ${rolePath}`);
	const type = request.role === "finish-reviewer" || (request.role === "assessment-a" && !request.needsBrowser) ? "reviewer" : "worker";
	const references = request.role === "asset-producer" ? ["visualize.md", "component-review.md"]
		: request.role === "documenter" ? ["document.md"]
		: request.role === "finish-reviewer" ? ["craft-floor.md"]
		: request.role === "manual-edit-applier" ? ["live.md"] : ["critique.md"];
	const paths = (values: string[]) => values.map((value) => /^https?:\/\//i.test(value) ? value : path.resolve(cwd, value));
	const prompt = [
		`Perform only Impeccable ${request.role}. This is an individual bounded task; do not delegate, launch workflows, or synthesize sibling assessments.`,
		`Use the supplied Impeccable role's task and output contract for this assignment. Frontmatter below is upstream provenance, not Pi tool/model configuration; use actual installed tool names. The selected fleet's model, tier, permissions, and safety policies remain authoritative. Stop within ${maxTurns} turns and report blockers and incomplete work honestly.`,
		"Use impeccable_run for engine verbs. If unavailable, quote the absolute installed launcher path as one shell argument before passing its verb and arguments.",
		"Fresh context is required (inherit_context:false); isolated:false retains available extension/MCP image and browser tools. Never claim independence if configured policies override that request. Never claim a skipped visual operation succeeded.",
		...(assessment ? [`Execute only Assessment ${request.role === "assessment-a" ? "A: Design Review (before seeing any detector output)" : "B: Detector + Browser Evidence"} from the complete playbook below. Do not run the other assessment, parent orchestration, persistence, or closing questions. Each browser assessment uses its own fresh tab; clean up disposable helpers and report skipped/failed evidence steps.`] : []),
		`Project cwd: ${cwd}\nSkill: ${getSkillDir()}\nScripts: ${getScriptsDir()}\nRole source: ${rolePath}\nPi adapters: ${path.join(getSkillDir(), "reference/pi-runtime.md")}`,
		`Installed role references:\n${references.map((reference) => path.join(getSkillDir(), "reference", reference)).join("\n")}\nResolve relative reference/ mentions against the installed Skill directory above, never the project cwd.`,
		`Artifact paths:\n${paths(request.artifactPaths).join("\n")}\nContext/evidence paths:\n${paths(request.contextPaths ?? []).join("\n")}`,
		"--- Complete adapted role/playbook instructions ---", roleText,
		"--- Bounded task packet ---", request.task,
		`Return only the assigned role's output, including actual files/evidence and limitations. Hard task ceiling: ${maxTurns} turns.`,
	].join("\n\n");
	return {
		maxTurns,
		rolePath,
		fallbackPath: path.join(getSkillDir(), "reference", assessment ? "critique.md" : `degraded/${request.role}.md`),
		// Agent's soft limit permits grace turns. The progress guard cancels at N
		// synchronously at turn_end, before a continuation can execute tools.
		args: { prompt, description: `Impeccable ${request.role} task`, subagent_type: type, inherit_context: false, isolated: false, run_in_background: false, max_turns: maxTurns, ...(request.resume ? { resume: request.resume } : {}) },
	};
}

export async function delegate(request: Request, ctx: ExtensionToolContext, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback) {
	const packet = await buildDelegation(request, ctx.cwd);
	const fallback = `No child was dispatched. Follow ${packet.fallbackPath}; disclose the actual limitation and any inline substitution. Never label an inline review independent. Preserve required human checkpoints.`;
	const report = (status: string, message: string, extra: Record<string, unknown> = {}) => ({
		content: [{ type: "text" as const, text: message }],
		details: { status, role: request.role, ...extra },
	});
	if (signal?.aborted) return report("cancelled", "Delegation cancelled before dispatch; no child result exists.");
	if (request.resume) {
		return report("handoff", `Finish-reviewer continuation ${request.resume} was not dispatched: Agent resumes do not forward progress updates, so this adapter cannot enforce the hard ${packet.maxTurns}-turn ceiling when agent configuration overrides max_turns. Main session: inspect the stored reviewer's effective policies and actual partial evidence before any managed continuation; max_turns is a soft steering limit, not a hard cutoff. Prefer a fresh finish-reviewer with the recaptures and prior fixes, omitting resume, or disclose the upstream degraded review. The exact Agent handoff below is for a separately managed continuation only. Do not claim a continuation or independent verdict occurred.\n${JSON.stringify(packet.args)}`, { handoff: { tool: "Agent", arguments: packet.args }, reason: "continuation-limit-unenforceable", fallbackPath: packet.fallbackPath });
	}
	const agent = ctx.tools?.find((tool) => tool.name === "Agent");
	if (typeof ctx.executeTool !== "function" || !agent) {
		return report("handoff", `Automatic Agent delegation unavailable: ${typeof ctx.executeTool !== "function" ? "this Pi runtime has no callable executeTool API" : "Agent is not callable in this tool context"}. Main session: invoke Agent with the exact handoff arguments below if exposed; otherwise ${fallback}\n${JSON.stringify(packet.args)}`, { handoff: { tool: "Agent", arguments: packet.args }, fallbackPath: packet.fallbackPath });
	}
	// Nested Agent exposes text-only results and ignores onUpdate. Its metadata
	// identifies that contract before dispatch; do not start an unguarded writer.
	if (/child-safe nested subagent/i.test(agent.description ?? "")) {
		return report("handoff", `Nested Agent delegation was not dispatched: this child-safe Agent returns text without effective policies, terminal status, or progress updates. Return this complete packet to the main session for its normal Agent adapter. Do not invoke this nested handoff directly or claim independent work occurred.\n${JSON.stringify(packet.args)}`, { reason: "nested-agent-contract-unsupported", handoff: { tool: "Agent", arguments: packet.args }, inlineSubstitutionAllowed: false });
	}
	const typeSchema = (agent.parameters as { properties?: { subagent_type?: { enum?: string[] } } }).properties?.subagent_type;
	// The prose list is a registration-time snapshot; Agent reloads its fleet on dispatch.
	// Only a restrictive schema enum prevents this call from reaching current validation.
	const advertised = typeSchema?.enum;
	if (advertised && !advertised.includes(packet.args.subagent_type)) {
		return report("unavailable", `Agent schema excludes type ${packet.args.subagent_type} (allowed: ${advertised.join(", ")}). ${fallback}`, { fallbackPath: packet.fallbackPath, inlineSubstitutionAllowed: true });
	}
	const controller = new AbortController();
	const nestedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const observedConflicts = new Set<string>();
	let boundaryReached = false;
	let lastUpdate: Parameters<AgentToolUpdateCallback>[0] | undefined;
	const checkTurnLimit = (limit: number | undefined) => limit && limit > packet.maxTurns ? `turn ceiling overridden: ${limit}` : undefined;
	const update: AgentToolUpdateCallback = (partial) => {
		lastUpdate = partial;
		const details = partial.details as { tags?: string[]; maxTurns?: number; turnCount?: number } | undefined;
		for (const tag of details?.tags ?? []) {
			if (incompatibleTags.has(tag)) observedConflicts.add(tag);
		}
		const turnConflict = checkTurnLimit(details?.maxTurns);
		if (turnConflict) observedConflicts.add(turnConflict);
		// Counts arrive after tools execute. Cancel at N, including a possible
		// terminal answer: public progress cannot distinguish it from continuation.
		if ((details?.turnCount ?? 0) >= packet.maxTurns) boundaryReached = true;
		if (observedConflicts.size || boundaryReached) controller.abort();
		onUpdate?.(partial);
	};
	try {
		const outcome = await ctx.executeTool("Agent", packet.args, { signal: nestedSignal, onUpdate: update });
		const result = outcome.result;
		const details = result.details as { status?: string; subagentType?: string; tags?: string[]; maxTurns?: number; turnCount?: number; agentId?: string } | undefined;
		// A configured background override or foreground handoff detaches the child
		// from our signal. Treat it as active even if the caller has since aborted.
		if (details?.status === "background" || details?.status === "running" || details?.status === "queued") {
			const id = details.agentId;
			const management = ctx.tools?.some((tool) => tool.name === "get_subagent_result") && id
				? { tool: "get_subagent_result", arguments: { agent_id: id, wait: true } }
				: undefined;
			const active = report("active", `Impeccable ${request.role}: active detached Agent child ${id ?? "(ID missing; locate it in /agents)"}. It may still modify the shared checkout. Caller cancellation cannot stop this child; no callable stop API is available through Agent. Do not perform inline substitution, launch a duplicate, or start dependent work until this child has stopped or settled. Main session: use /agents to stop/manage it, or ${management ? `get_subagent_result with agent_id:${JSON.stringify(id)}, wait:true` : "the available Agent management UI"} to retrieve its actual terminal outcome. Cancelling a result wait only cancels the wait. Verify effective policies, turn count, output and evidence before accepting its result.`, { agent: result.details, agentId: id, callerCancelled: signal?.aborted ?? false, callerCancellationStopsChild: false, inlineSubstitutionAllowed: false, ...(management ? { handoff: management } : {}) });
			return { ...active, content: [...active.content, ...result.content] };
		}
		// These exact public Agent refusals precede spawning. Require the no-details,
		// single-text contract and no progress; arbitrary text remains uncertain.
		const refusal = result.content.length === 1 && result.content[0]?.type === "text" ? result.content[0].text : undefined;
		const refusalPrefix = `Unknown or disabled agent type: "${packet.args.subagent_type}". `;
		const refusalSuffix = refusal?.startsWith(refusalPrefix) ? refusal.slice(refusalPrefix.length) : undefined;
		if (!signal?.aborted && !lastUpdate && result.details === undefined && refusalSuffix && /^(?:Default fallback "worker" is unknown or disabled\. |The configured fallbackSubagent "[^"\r\n]+" is itself unknown or disabled\. )?Available: [^\r\n]+\.$/.test(refusalSuffix)) {
			return report("unavailable", `${refusal}\n${fallback}`, { fallbackPath: packet.fallbackPath, inlineSubstitutionAllowed: true });
		}
		// Dispatch happened, so an unknown/text-only result cannot establish that
		// a writer has terminated. Preserve output without authorizing duplicate work.
		if (!details?.status || !["completed", "steered", "error", "aborted", "stopped"].includes(details.status)) {
			const unresolved = report("unresolved", `Agent returned no recognized terminal status after dispatch. Preserve the actual output below; completion and child termination are unestablished. Main session: inspect Agent management/results before accepting evidence or doing dependent work. Do not substitute inline work or launch a duplicate.`, { agent: result.details, inlineSubstitutionAllowed: false });
			return { ...unresolved, content: [...unresolved.content, ...result.content] };
		}
		const finalTurnConflict = checkTurnLimit(details.maxTurns);
		const policyConflicts = [...new Set([
			...observedConflicts,
			...(details.tags?.filter((tag) => incompatibleTags.has(tag)) ?? []),
			...(finalTurnConflict ? [finalTurnConflict] : []),
			...((details.turnCount ?? 0) > packet.maxTurns ? [`actual turn count ${details.turnCount} exceeds role ceiling ${packet.maxTurns}`] : []),
			...(details.subagentType && details.subagentType !== packet.args.subagent_type ? [`agent type substituted: ${details.subagentType} (requested ${packet.args.subagent_type})`] : []),
		])];
		// A known native terminal outcome establishes termination, not task success.
		// Even errors and policy conflicts can follow writes in the shared checkout.
		const userStopped = details.status === "stopped" && !controller.signal.aborted;
		const atBoundary = boundaryReached || (details.turnCount ?? 0) >= packet.maxTurns;
		const nativeError = Boolean(outcome.isError || result.isError || details.status === "error");
		const cancelled = signal?.aborted || userStopped || boundaryReached || (details.status === "aborted" && !policyConflicts.length);
		const status = cancelled ? "cancelled" : policyConflicts.length || nativeError || atBoundary || details.status === "stopped" ? "partial" : details.status === "steered" ? "wrapped-up" : "completed";
		const reason = signal?.aborted ? "caller-cancelled" : userStopped ? "user-stopped" : atBoundary ? "turn-boundary-reached" : policyConflicts.length ? "policy-conflict" : details.status === "aborted" ? "native-turn-limit-aborted" : nativeError ? "agent-error" : details.status === "stopped" ? "adapter-stopped" : status === "wrapped-up" ? "soft-limit-wrap-up" : "native-completed";
		const limitations = [
			...(atBoundary ? [`Role boundary of ${packet.maxTurns} turns reached; ${boundaryReached ? "child cancellation requested before any further turn. " : ""}A boundary answer is conservatively treated as partial.`] : []),
			...(policyConflicts.length ? [`Configured Agent policies conflict with this role: ${policyConflicts.join(", ")}.`] : []),
			...(nativeError ? ["Agent terminated with an error; task completion is unestablished."] : []),
			...(reason === "user-stopped" ? ["The user stopped this child through Agent management."] : reason === "caller-cancelled" ? ["The caller cancelled this task."] : reason === "native-turn-limit-aborted" ? ["Agent exhausted its native turn limit and grace; task remains partial."] : reason === "adapter-stopped" ? ["The adapter stopped this child."] : []),
		];
		const instruction = status === "completed" ? "Verify evidence and effective Agent policies before claiming independent review."
			: status === "cancelled" ? "Retain actual partial output and artifacts; stop this task and do not substitute inline work or an invented child result."
			: `${status === "wrapped-up" ? "Agent wrapped up at its compatible soft limit; its output needs evidence assessment and may be partial." : "Retain the actual partial output, artifacts and policy limitations; do not label this independently verified or completed."} Main session: inspect the actual output and changed artifacts against the role contract before accepting evidence. Do not substitute the full role inline or replay already-applied work. If work remains, explicitly bound a handoff to only the remaining work after inspection, preserving role policies and human checkpoints.`;
		const message = `Impeccable ${request.role}: ${status}. ${limitations.join(" ")}${limitations.length ? " " : ""}${instruction}`;
		const reported = report(status, message, { agent: result.details, childTerminated: true, inlineSubstitutionAllowed: false, evidenceAssessmentRequired: true, reason, nativeError, policyConflicts, requested: { type: packet.args.subagent_type, maxTurns: packet.maxTurns, agentSoftLimit: packet.args.max_turns, inheritContext: false, isolated: false } });
		return {
			...reported,
			content: [...reported.content, ...result.content],
			// Pi accounts nested usage automatically; do not double-count result.usage.
			isError: !cancelled && (nativeError || policyConflicts.length > 0),
		};
	} catch (error) {
		const limitation = observedConflicts.size ? `Configured Agent policy conflict: ${[...observedConflicts].join(", ")}. ` : boundaryReached ? `Role boundary of ${packet.maxTurns} turns reached; cancellation requested. ` : "";
		const status = signal?.aborted ? "cancelled" : "unresolved";
		const failed = report(status, `${limitation}Agent call failed: ${String(error)}. ${status === "cancelled" ? "Cancelled; stop this task and do not substitute inline work or an invented child result." : "Child termination is unestablished. Main session: inspect Agent management/results and actual partial output before proceeding. Do not substitute inline work or launch a duplicate."}`, { inlineSubstitutionAllowed: false, ...(boundaryReached ? { reason: "turn-boundary-reached" } : {}) });
		return { ...failed, content: [...failed.content, ...(lastUpdate?.content ?? [])] };
	}
}

export function registerDelegation(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "impeccable_delegate", label: "Impeccable Delegate",
		description: "Send a complete Impeccable role and bounded packet to existing Agent worker/reviewer, foreground with fresh context and extension tools. Returns actual output or an explicit Agent handoff/fallback.",
		parameters: DelegateSchema,
		reachesTools: () => ["Agent"],
		async execute(_id, params, signal, update, ctx) { return delegate(params, ctx, signal, update); },
	});
}
