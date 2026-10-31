import { PikaLink as Link } from "../../components/PikaLink";
import { CodeBlock, OutputBlock } from "../../components/code";
import { Markdown } from "../../components/Markdown";
import { Pill, Toggle } from "../../components/ui";
import { formatCount, formatDuration, totalTokens } from "../../lib/format";
import { KindBullet } from "../../trace/parts";
import { useSessionSlots, useSessionView } from "../context";
import { argString, okResult, resultText, type ToolRenderProps } from "./shared";

/** The Subagents extension's `AgentDetails`, as far as the card uses it. */
interface AgentDetails {
	displayName?: string;
	description?: string;
	subagentType?: string;
	toolUses?: number;
	tokens?: string;
	durationMs?: number;
	status?: string;
	modelName?: string;
	cost?: number;
	agentId?: string;
	error?: string;
}

function agentDetails(details: unknown): AgentDetails {
	return details && typeof details === "object" ? (details as AgentDetails) : {};
}

/** Running work is the inverted sign; finished work is neutral, and only a failure is red. */
function statusTone(status: string): "red" | "green" | "neutral" {
	if (status === "error" || status === "aborted" || status === "stopped") return "red";
	if (status === "running" || status === "queued" || status === "background") return "green";
	return "neutral";
}

export function AgentTool({ call, result }: ToolRenderProps) {
	const { childrenByToolCall } = useSessionView();
	const { AgentChild } = useSessionSlots();
	const details = agentDetails(result?.details);
	const child = childrenByToolCall.get(call.id);
	const type = argString(call, "subagent_type") ?? details.subagentType ?? child?.link?.agentType ?? "agent";
	const description = argString(call, "description") ?? details.description ?? child?.link?.description;
	const prompt = argString(call, "prompt");
	const model = details.modelName ?? argString(call, "model") ?? child?.models[0];
	const status = details.status ?? (result ? (result.isError ? "error" : "completed") : "unknown");
	// Subagents formats the count with its unit, such as "48.2k token".
	const tokens = details.tokens?.replace(/\s*tokens?$/i, "") || (child ? formatCount(totalTokens(child.tokens)) : undefined);
	const durationMs = details.durationMs ?? child?.durationMs;
	const ok = okResult(result);
	const report = resultText(ok);

	return (
		<div className="border-l border-k-agent py-1 pl-3" data-agent-card="">
			<div className="flex flex-wrap items-center gap-2">
				<KindBullet family="agent" />
				<span className="mono shrink-0 text-[12.5px] text-ink">{type}</span>
				<span className="min-w-0 flex-1 truncate font-medium">{description ?? "Subagent"}</span>
				<Pill tone={statusTone(status)}>{status}</Pill>
			</div>
			<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
				{model && <span title="Model">{model}</span>}
				{tokens && <span>{tokens} tokens</span>}
				{durationMs !== undefined && <span>{formatDuration(durationMs)}</span>}
				{details.toolUses !== undefined && <span>{details.toolUses} tool uses</span>}
				{child && (
					<Link to={`/s/${encodeURIComponent(child.id)}`} className="ml-auto text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink">
						Open session →
					</Link>
				)}
			</div>
			{details.error && <div className="mt-2 text-[13px] text-red">{details.error}</div>}
			{prompt && (
				<Toggle className="mt-2 text-[14px]" label={<span className="text-muted">Prompt</span>}>
					<Markdown text={prompt} className="text-[14px]" />
				</Toggle>
			)}
			{report && (
				<Toggle className="mt-1 text-[14px]" label={<span className="text-muted">Report</span>}>
					<Markdown text={report} className="text-[14px]" />
				</Toggle>
			)}
			{child && AgentChild && <AgentChild child={child} toolCallId={call.id} />}
		</div>
	);
}

export function GenericTool({ call, result }: ToolRenderProps) {
	const ok = okResult(result);
	const hasArgs = call.arguments && Object.keys(call.arguments).length > 0;
	return (
		<div>
			{hasArgs ? (
				<CodeBlock code={JSON.stringify(call.arguments, null, 2)} language="json" />
			) : (
				<div className="text-[13px] text-muted italic">No arguments</div>
			)}
			{ok && (
				<div className="mt-2">
					<div className="mb-1 text-[13px] text-muted">Result</div>
					<OutputBlock text={resultText(ok)} />
				</div>
			)}
			{!result && <div className="mt-1 text-[13px] text-muted italic">No result recorded</div>}
		</div>
	);
}
