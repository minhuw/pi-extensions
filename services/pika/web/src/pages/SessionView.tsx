import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Icon } from "../components/icons";
import { MessageDialog } from "../components/MessageDialog";
import { Callout, cx, ErrorState, Page, PageTitle, Pill, Properties, Skeleton, SkeletonLines, type Property } from "../components/ui";
import { ApiError, useApi } from "../lib/api";
import { formatCost, formatCount, formatDateTime, formatDuration, formatRelative, totalTokens } from "../lib/format";
import { useOnlineSessions } from "../lib/relay";
import type { OnlineSession, SessionDetail } from "../lib/types";
import { ViewStateProvider } from "../lib/viewState";
import { ContextButton, ContextDrawerProvider } from "../context/ContextDrawer";
import { SessionSlotsContext, SessionViewContext, type SessionSlots } from "../session/context";
import { isLive, useLiveUpdates } from "../session/live";
import { InlineAgentChild, sessionContextFor, SubagentList } from "../session/subagents";
import { TurnList } from "../session/TurnList";
import { NotFoundPage } from "./NotFound";

function sessionProperties(session: SessionDetail): Property[] {
	const tokens = totalTokens(session.tokens);
	const items: Property[] = [
		{ icon: "device", label: "Device", value: <Pill>{session.device}</Pill> },
		{
			icon: "folder",
			label: "Project",
			value: (
				<Link to={`/?project=${encodeURIComponent(session.project)}`} className="hover:underline">
					{session.project || "—"}
				</Link>
			),
		},
		{ icon: "path", label: "Directory", value: <code className="code-chip !text-ink">{session.cwd}</code> },
		{
			icon: "calendar",
			label: "Started",
			value: (
				<span title={session.startedAt}>
					{formatDateTime(session.startedAt)} <span className="text-muted">· {formatRelative(session.startedAt)}</span>
				</span>
			),
		},
		{ icon: "clock", label: "Duration", value: formatDuration(session.durationMs) },
		{
			icon: "tokens",
			label: "Tokens",
			value: (
				<span>
					{formatCount(tokens)}{" "}
					<span className="text-muted">
						· {formatCount(session.tokens.input)} in · {formatCount(session.tokens.output)} out ·{" "}
						{formatCount(session.tokens.cacheRead)} cache read · {formatCount(session.tokens.cacheWrite)} cache write
					</span>
				</span>
			),
		},
		{ icon: "cost", label: "Cost", value: formatCost(session.cost) },
		{
			icon: "model",
			label: "Models",
			value: session.models.length ? session.models.map((model) => <Pill key={model}>{model}</Pill>) : <span className="text-muted">—</span>,
		},
	];
	if (session.parentSessionId) {
		const link = session.link;
		const what = link?.kind === "herder-step" ? "Herder step" : link?.agentType ? `${link.agentType} subagent` : "Child session";
		items.push({
			icon: "parent",
			label: "Parent",
			value: (
				<span className="flex min-w-0 flex-wrap items-center gap-1.5">
					<Link to={`/s/${encodeURIComponent(session.parentSessionId)}`} className="text-accent hover:underline">
						Parent session
					</Link>
					<span className="text-muted">
						· {what}
						{link?.description ? ` · ${link.description}` : ""}
					</span>
				</span>
			),
		});
	}
	if (session.herderRunId) {
		items.push({
			icon: "herder",
			label: "Herder run",
			value: (
				<Link to={`/runs/${encodeURIComponent(session.herderRunId)}`} className="mono text-accent hover:underline">
					{session.herderRunId}
				</Link>
			),
		});
	}
	if (session.children.length > 0) {
		items.push({ icon: "children", label: "Subagents", value: <SubagentList items={session.children} /> });
	}
	return items;
}

function HeaderSkeleton() {
	return (
		<div aria-busy="true" aria-label="Loading session">
			<Skeleton className="h-10 w-2/3" />
			<div className="mt-6 space-y-3">
				{Array.from({ length: 5 }, (_, i) => (
					<Skeleton key={i} className="h-5 w-1/2" />
				))}
			</div>
			<div className="mt-10">
				<SkeletonLines lines={4} />
			</div>
		</div>
	);
}

const slots: SessionSlots = { ModelCallExtra: ContextButton, AgentChild: InlineAgentChild };

export function SessionViewPage() {
	const { id = "" } = useParams();
	return (
		<ViewStateProvider key={id}>
			<ContextDrawerProvider>
				<SessionSlotsContext.Provider value={slots}>
					<SessionPage id={id} />
				</SessionSlotsContext.Provider>
			</ContextDrawerProvider>
		</ViewStateProvider>
	);
}

function SessionPage({ id }: { id: string }) {
	const api = useApi();
	const [showHidden, setShowHidden] = useState(false);
	const [params, setParams] = useSearchParams();
	const session = useQuery({ queryKey: ["session", id], queryFn: () => api.session(id) });
	useLiveUpdates(id, session.data);
	// The layout keeps the online sessions fresh.
	const relay = useOnlineSessions(false);
	const online = relay.availability === "on" ? relay.sessions.data?.items.find((item) => item.id === id) : undefined;
	// A snapshot, so the composer stays open if the session goes offline meanwhile.
	const [messaging, setMessaging] = useState<OnlineSession | null>(null);

	const seqParam = params.get("seq");
	const focusSeq = seqParam !== null && /^\d+$/.test(seqParam) ? Number(seqParam) : undefined;
	const clearFocus = useCallback(() => {
		setParams(
			(current) => {
				const next = new URLSearchParams(current);
				next.delete("seq");
				return next;
			},
			{ replace: true },
		);
	}, [setParams]);

	const context = useMemo(() => sessionContextFor(id, session.data, { showHidden }), [id, session.data, showHidden]);

	if (session.error instanceof ApiError && session.error.status === 404) return <NotFoundPage what="session" />;

	return (
		<Page className="pb-32">
			<nav className="mb-6 flex items-center gap-1.5 text-[13px] text-muted" aria-label="Breadcrumb">
				<Link to="/" className="rounded-sm px-1 hover:bg-hover">
					Sessions
				</Link>
				{session.data && (
					<>
						<span>/</span>
						<Link to={`/?project=${encodeURIComponent(session.data.project)}`} className="rounded-sm px-1 hover:bg-hover">
							{session.data.project}
						</Link>
					</>
				)}
			</nav>
			{session.isPending ? (
				<HeaderSkeleton />
			) : session.isError ? (
				session.error instanceof ApiError && session.error.status === 401 ? (
					<Callout tone="yellow" title="Sign in required">
						This server needs a password.
					</Callout>
				) : (
					<ErrorState error={session.error} onRetry={() => void session.refetch()} />
				)
			) : (
				<SessionViewContext.Provider value={context}>
					<PageTitle
						badges={
							(isLive(session.data.lastAt) || online) && (
								<>
									{isLive(session.data.lastAt) && (
										<span data-live="">
											<Pill tone="green">live</Pill>
										</span>
									)}
									{online && (
										<span data-online="" title="Connected to pika relay right now">
											<Pill tone="green">Online</Pill>
										</span>
									)}
								</>
							)
						}
					>
						{session.data.title || "Untitled session"}
					</PageTitle>
					<Properties items={sessionProperties(session.data)} />
					<div className="mb-6 flex flex-wrap items-center gap-2 border-y border-line py-2 text-[13px]">
						<label className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-0.5 text-muted hover:bg-hover">
							<input
								type="checkbox"
								checked={showHidden}
								onChange={(event) => setShowHidden(event.target.checked)}
								className="accent-[#2383e2]"
							/>
							<Icon name="eye" size={14} />
							Show hidden entries
						</label>
						<span className="text-muted">
							· {formatCount(session.data.entryCount)} entries · <kbd className="mono">j</kbd>/<kbd className="mono">k</kbd> to move between prompts
						</span>
						{online && (
							<button
								type="button"
								onClick={() => setMessaging(online)}
								className="ml-auto flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-muted hover:bg-hover"
								aria-label="Message this session"
							>
								<Icon name="message" size={14} />
								Message
							</button>
						)}
						<a
							href={api.exportUrl(id)}
							className={cx(!online && "ml-auto", "flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-muted hover:bg-hover")}
							download
						>
							<Icon name="download" size={14} />
							Export JSONL
						</a>
					</div>
					<TurnList key={id} sessionId={id} showHidden={showHidden} focusSeq={focusSeq} onFocusHandled={clearFocus} />
					{messaging && <MessageDialog session={messaging} onClose={() => setMessaging(null)} />}
				</SessionViewContext.Provider>
			)}
		</Page>
	);
}
