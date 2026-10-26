import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { CodeBlock } from "../components/code";
import { Icon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Pill, Toggle } from "../components/ui";
import { useApi } from "../lib/api";
import { formatDuration, formatRelative, plural } from "../lib/format";
import type { ChildSession, SessionDetail } from "../lib/types";
import { useViewState } from "../lib/viewState";
import { SessionViewContext, useSessionView, type SessionViewContextValue } from "./context";
import { registerToolRenderer } from "./tools/registry";
import { argString, okResult, resultText, type ToolRenderProps } from "./tools/shared";
import { TurnList } from "./TurnList";

const MAX_DEPTH = 8;

function byStart(a: ChildSession, b: ChildSession): number {
	return a.startedAt.localeCompare(b.startedAt);
}

/** Session view context for `id`, with its children indexed by the tool call that spawned them. */
export function sessionContextFor(
	id: string,
	detail: SessionDetail | undefined,
	extra: Pick<SessionViewContextValue, "ancestors" | "showHidden"> = {},
): SessionViewContextValue {
	const childrenByToolCall = new Map<string, ChildSession>();
	const childGroups = new Map<string, ChildSession[]>();
	for (const child of [...(detail?.children ?? [])].sort(byStart)) {
		const toolCallId = child.parentToolCallId ?? child.link?.parentToolCallId;
		if (!toolCallId) continue;
		if (!childrenByToolCall.has(toolCallId)) childrenByToolCall.set(toolCallId, child);
		const group = childGroups.get(toolCallId);
		if (group) group.push(child);
		else childGroups.set(toolCallId, [child]);
	}
	return { sessionId: id, childrenByToolCall, childGroups, ancestors: extra.ancestors ?? [id], showHidden: extra.showHidden };
}

export function childLabel(child: ChildSession): { type: string; description: string } {
	const link = child.link;
	const type = link?.herder ? `${link.herder.role} step` : (link?.agentType ?? (link?.kind === "herder-step" ? "herder step" : "subagent"));
	return { type, description: link?.description ?? link?.herder?.task ?? child.title ?? "Untitled session" };
}

/** A child session's turns and timeline, nested inline under the call that spawned it. */
export function InlineSession({ child }: { child: ChildSession }) {
	const api = useApi();
	const parent = useSessionView();
	const ancestors = parent.ancestors ?? [parent.sessionId];
	const cyclic = ancestors.includes(child.id) || ancestors.length >= MAX_DEPTH;
	const detail = useQuery({ queryKey: ["session", child.id], queryFn: () => api.session(child.id), enabled: !cyclic });
	const value = useMemo(
		() =>
			sessionContextFor(child.id, detail.data, {
				ancestors: [...(parent.ancestors ?? [parent.sessionId]), child.id],
				showHidden: parent.showHidden,
			}),
		[child.id, detail.data, parent],
	);
	const { type, description } = childLabel(child);
	return (
		<div className="mt-2 border-l-2 border-line pl-4" data-inline-session={child.id}>
			<div className="mb-2 flex min-w-0 items-center gap-2 text-[13px]">
				<Pill tone="accent">{type}</Pill>
				<span className="min-w-0 flex-1 truncate font-medium">{description}</span>
				<span className="shrink-0 text-muted">{formatDuration(child.durationMs)}</span>
				<Link
					to={`/s/${encodeURIComponent(child.id)}`}
					className="flex shrink-0 items-center gap-1 rounded-sm px-1 text-muted hover:bg-hover hover:text-ink"
				>
					<Icon name="external" size={13} />
					Open as page
				</Link>
			</div>
			{cyclic ? (
				<div className="text-[13px] text-muted italic">Nested too deeply to show inline.</div>
			) : (
				<SessionViewContext.Provider value={value}>
					<TurnList sessionId={child.id} showHidden={parent.showHidden ?? false} nested />
				</SessionViewContext.Provider>
			)}
		</div>
	);
}

function InlineToggle({ child, label }: { child: ChildSession; label: ReactNode }) {
	const { sessionId } = useSessionView();
	const [open, setOpen] = useViewState(`inline:${sessionId}:${child.id}`, false);
	return (
		<div data-inline-toggle={child.id}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded-sm px-1 py-0.5 text-left text-[13px] text-muted hover:bg-hover"
			>
				<span aria-hidden="true" className="w-3 shrink-0 text-[11px]">
					{open ? "▾" : "▸"}
				</span>
				{label}
			</button>
			{open && <InlineSession child={child} />}
		</div>
	);
}

/** The `AgentChild` slot: a toggle under an Agent card that nests its child session inline. */
export function InlineAgentChild({ child }: { child: ChildSession; toolCallId: string }) {
	return (
		<div className="mt-2 border-t border-line pt-2">
			<InlineToggle child={child} label={<span>Subagent session · {plural(child.entryCount, "entry", "entries")}</span>} />
		</div>
	);
}

function WorkflowTool({ call, result }: ToolRenderProps) {
	const { childGroups } = useSessionView();
	const children = childGroups?.get(call.id) ?? [];
	const groups = new Map<string, ChildSession[]>();
	for (const child of children) {
		const key = child.link?.workflowId ?? "";
		const group = groups.get(key);
		if (group) group.push(child);
		else groups.set(key, [child]);
	}
	const name = argString(call, "name") ?? argString(call, "scriptPath") ?? "inline script";
	const script = argString(call, "script");
	const report = resultText(okResult(result));
	return (
		<div className="rounded-md border border-line px-4 py-3" data-workflow-card="">
			<div className="flex flex-wrap items-center gap-2">
				<Icon name="branch" className="text-muted" />
				<Pill tone="accent">workflow</Pill>
				<span className="mono min-w-0 flex-1 truncate">{name}</span>
				<span className="text-[13px] text-muted">{plural(children.length, "agent")}</span>
			</div>
			{script && (
				<Toggle className="mt-2 text-[14px]" label={<span className="text-muted">Script</span>}>
					<CodeBlock code={script} language="javascript" />
				</Toggle>
			)}
			{[...groups].map(([workflowId, group]) => (
				<div key={workflowId} className="mt-2 border-t border-line pt-2" data-workflow-group={workflowId}>
					{groups.size > 1 && workflowId && <div className="mb-1 text-[12px] text-muted mono">{workflowId}</div>}
					{group.map((child) => {
						const { type, description } = childLabel(child);
						return (
							<InlineToggle
								key={child.id}
								child={child}
								label={
									<>
										<Pill>{type}</Pill>
										<span className="min-w-0 flex-1 truncate text-ink">{description}</span>
										<span className="shrink-0">{formatDuration(child.durationMs)}</span>
									</>
								}
							/>
						);
					})}
				</div>
			))}
			{report && (
				<Toggle className="mt-2 text-[14px]" label={<span className="text-muted">Result</span>}>
					<Markdown text={report} className="text-[14px]" />
				</Toggle>
			)}
		</div>
	);
}

registerToolRenderer({
	id: "workflow",
	icon: "branch",
	match: (name) => name.server === undefined && name.base === "SubagentWorkflow",
	summary: (call) => argString(call, "name") ?? argString(call, "scriptPath"),
	Component: WorkflowTool,
});

const PROPERTY_LIMIT = 8;

/** The session page's "Subagents" property value. */
export function SubagentList({ items }: { items: ChildSession[] }) {
	const [all, setAll] = useViewState("subagents-all", false);
	const shown = all ? items : items.slice(0, PROPERTY_LIMIT);
	return (
		<div className="flex w-full min-w-0 flex-col py-1" data-subagents="">
			{shown.map((child) => {
				const { type, description } = childLabel(child);
				return (
					<Link
						key={child.id}
						to={`/s/${encodeURIComponent(child.id)}`}
						className="-mx-1 flex min-w-0 items-center gap-2 rounded-sm px-1 hover:bg-hover"
						title={child.title}
					>
						<Pill>{type}</Pill>
						<span className="min-w-0 truncate">{description}</span>
						<span className="ml-auto shrink-0 text-[12px] text-muted">{formatRelative(child.startedAt)}</span>
					</Link>
				);
			})}
			{items.length > PROPERTY_LIMIT && (
				<button type="button" onClick={() => setAll(!all)} className="self-start rounded-sm px-1 text-[13px] text-muted hover:bg-hover">
					{all ? "Show fewer" : `Show all ${items.length}`}
				</button>
			)}
		</div>
	);
}
