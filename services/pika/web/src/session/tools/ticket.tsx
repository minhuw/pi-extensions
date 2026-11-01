import { PikaLink as Link } from "../../components/PikaLink";
import { Markdown } from "../../components/Markdown";
import { TicketBadge } from "../../components/Ticket";
import { Pill, Toggle } from "../../components/ui";
import { formatCount, formatDuration, totalTokens } from "../../lib/format";
import { backgroundLabel, linkTicket, ranPastCall } from "../../lib/tickets";
import { KindBullet } from "../../trace/parts";
import { useSessionSlots, useSessionView } from "../context";
import { argString, okResult, resultText, type ToolRenderProps } from "./shared";

function epoch(value: string | number | null | undefined): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Superagent's `ticket_create`: the ticket its call started, which keeps running in the background after the call
 * returned, with the ticket's session nested inline like an Agent's.
 */
export function TicketCreateTool({ call, result, resultEntry }: ToolRenderProps) {
	const { childrenByToolCall } = useSessionView();
	const { AgentChild } = useSessionSlots();
	const child = childrenByToolCall.get(call.id);
	const ticket = linkTicket(child?.link);
	const title = ticket?.title ?? argString(call, "title") ?? child?.link?.description ?? "Ticket";
	const task = argString(call, "task", "prompt", "description", "body");
	const report = resultText(okResult(result));
	const returned = epoch(result?.timestamp) ?? epoch(resultEntry?.timestamp);
	const ranPast = ranPastCall(returned, epoch(child?.lastAt));
	const tokens = child ? formatCount(totalTokens(child.tokens)) : undefined;
	return (
		<div className="border-l border-k-agent py-1 pl-3" data-ticket-card="">
			<div className="flex flex-wrap items-center gap-2">
				<KindBullet family="agent" />
				<span className="mono shrink-0 text-[12.5px] text-ink">ticket</span>
				<TicketBadge ticket={ticket} />
				<span className="min-w-0 flex-1 truncate font-medium">{title}</span>
				{result?.isError ? <Pill tone="red">error</Pill> : !result ? <Pill>no result</Pill> : null}
			</div>
			<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
				{ticket?.branch && (
					<span className="mono text-[12px]" title="Branch">
						{ticket.branch}
					</span>
				)}
				{child?.models[0] && <span title="Model">{child.models[0]}</span>}
				{tokens && <span>{tokens} tokens</span>}
				{child && <span>{formatDuration(child.durationMs)}</span>}
				{ranPast !== undefined && <span data-ran-past={ranPast}>{backgroundLabel(ranPast)}</span>}
				{child && (
					<Link to={`/s/${encodeURIComponent(child.id)}`} className="ml-auto text-ink underline decoration-ink/30 underline-offset-[3px] hover:decoration-ink">
						Open session →
					</Link>
				)}
			</div>
			{task && (
				<Toggle className="mt-2 text-[14px]" label={<span className="text-muted">Task</span>}>
					<Markdown text={task} className="text-[14px]" />
				</Toggle>
			)}
			{report && (
				<Toggle className="mt-1 text-[14px]" label={<span className="text-muted">Result</span>}>
					<Markdown text={report} className="text-[14px]" />
				</Toggle>
			)}
			{child && AgentChild && <AgentChild child={child} toolCallId={call.id} />}
		</div>
	);
}
