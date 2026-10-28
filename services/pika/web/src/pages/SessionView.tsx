import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { PikaLink as Link } from "../components/PikaLink";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { Icon } from "../components/icons";
import { MessageDialog } from "../components/MessageDialog";
import { Callout, cx, ErrorState, Pill, Skeleton, SkeletonLines } from "../components/ui";
import { ContextButton, ContextDrawerProvider } from "../context/ContextDrawer";
import { ApiError, useApi } from "../lib/api";
import { formatCount } from "../lib/format";
import { useOnlineSessions } from "../lib/relay";
import type { OnlineSession, SessionDetail } from "../lib/types";
import { ViewStateProvider } from "../lib/viewState";
import { SessionSlotsContext, SessionViewContext, type SessionSlots } from "../session/context";
import { isLive, useLiveUpdates } from "../session/live";
import { InlineAgentChild, sessionContextFor } from "../session/subagents";
import { TurnList } from "../session/TurnList";
import { useTrace } from "../trace/data";
import { KpiStrip, SessionChips, ViewSwitch, type SessionViewMode } from "../trace/Header";
import { NotFoundPage } from "./NotFound";

export const VIEW_STORAGE_KEY = "pika-session-view";
const HIDDEN_STORAGE_KEY = "pika-show-hidden";

/** The session page's two layouts: the full-width trajectory, and the transcript's reading column. */
export const TRAJECTORY_COLUMN = "w-full px-6";
export const TRANSCRIPT_COLUMN = "mx-auto w-full max-w-[1100px] px-8";

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function store(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Not remembered without storage.
	}
}

function parseView(value: string | null): SessionViewMode | undefined {
	return value === "trajectory" || value === "transcript" ? value : undefined;
}

function HeaderSkeleton() {
	return (
		<div aria-busy="true" aria-label="Loading session">
			<Skeleton className="h-7 w-2/3" />
			<Skeleton className="mt-3 h-5 w-1/2" />
			<Skeleton className="mt-4 h-[58px] w-full" />
			<div className="mt-8">
				<SkeletonLines lines={4} />
			</div>
		</div>
	);
}

const slots: SessionSlots = { ModelCallExtra: ContextButton, AgentChild: InlineAgentChild };
const publicSlots: SessionSlots = { AgentChild: InlineAgentChild };

// The trajectory view and its canvas overview load on demand, in their own chunk.
const Trajectory = lazy(() => import("../trace/Trajectory").then((module) => ({ default: module.Trajectory })));
const Overview = lazy(() => import("../trace/Overview").then((module) => ({ default: module.Overview })));

/** What a crashed trajectory shows: the transcript reads the same session without it. */
function TrajectoryError({ id, reset }: { id: string; reset: () => void }) {
	return (
		<div className="px-6 pt-6" data-trajectory-error="">
			<Callout title="The trajectory view could not be shown">
				<div className="text-[13px]">
					Something in this session’s records could not be drawn. The transcript shows the same session.
					<div className="mt-2 flex items-center gap-3">
						<Link to={`/s/${encodeURIComponent(id)}?view=transcript`} className="text-accent hover:underline" data-open-transcript="">
							Open the transcript
						</Link>
						<button type="button" onClick={reset} className="text-muted hover:text-ink">
							Try again
						</button>
					</div>
				</div>
			</Callout>
		</div>
	);
}

function TrajectorySkeleton() {
	return (
		<div className="space-y-3 px-6 pt-4" aria-busy="true" aria-label="Loading the trajectory">
			<Skeleton className="h-[110px] w-full" />
			<SkeletonLines lines={6} />
		</div>
	);
}

export function SessionViewPage() {
	const api = useApi();
	const { id = "" } = useParams();
	return (
		<ViewStateProvider key={id}>
			<ContextDrawerProvider>
				<SessionSlotsContext.Provider value={api.publicView ? publicSlots : slots}>
					<SessionPage id={id} />
				</SessionSlotsContext.Provider>
			</ContextDrawerProvider>
		</ViewStateProvider>
	);
}

function Breadcrumb({ session }: { session?: SessionDetail }) {
	return (
		<nav className="flex h-6 items-center gap-1 text-[12.5px] text-muted" aria-label="Breadcrumb">
			<Link to="/" className="rounded-sm px-1 hover:bg-hover hover:text-ink">
				Sessions
			</Link>
			{session && (
				<>
					<span className="opacity-60">/</span>
					<Link to={`/?project=${encodeURIComponent(session.project)}`} className="rounded-sm px-1 hover:bg-hover hover:text-ink">
						{session.project}
					</Link>
				</>
			)}
		</nav>
	);
}

function ActionButton({ children, ...props }: { children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			type="button"
			{...props}
			className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-[12.5px] text-muted transition-colors duration-150 hover:bg-hover hover:text-ink"
		>
			{children}
		</button>
	);
}

function SessionPage({ id }: { id: string }) {
	const api = useApi();
	const [params, setParams] = useSearchParams();
	const [showHidden, setShowHiddenState] = useState(() => readStored(HIDDEN_STORAGE_KEY) === "1");
	const setShowHidden = (value: boolean) => {
		setShowHiddenState(value);
		store(HIDDEN_STORAGE_KEY, value ? "1" : "0");
	};
	const session = useQuery({ queryKey: ["session", id], queryFn: () => api.session(id) });
	useLiveUpdates(id, session.data);
	// The layout keeps the online sessions fresh.
	const relay = useOnlineSessions(false);
	const online = relay.availability === "on" ? relay.sessions.data?.items.find((item) => item.id === id) : undefined;
	// A snapshot, so the composer stays open if the session goes offline meanwhile.
	const [messaging, setMessaging] = useState<OnlineSession | null>(null);

	const view: SessionViewMode = parseView(params.get("view")) ?? parseView(readStored(VIEW_STORAGE_KEY)) ?? "trajectory";
	const setView = (next: SessionViewMode) => {
		store(VIEW_STORAGE_KEY, next);
		setParams(
			(current) => {
				const updated = new URLSearchParams(current);
				updated.set("view", next);
				return updated;
			},
			{ replace: true },
		);
	};

	const trace = useTrace(id, Boolean(session.data));
	const traceMissing = trace.error instanceof ApiError && trace.error.status === 404;
	const shown: SessionViewMode = view === "trajectory" && traceMissing ? "transcript" : view;

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
	const focusOn = useCallback(
		(seq: number) =>
			setParams(
				(current) => {
					const next = new URLSearchParams(current);
					next.set("seq", String(seq));
					return next;
				},
				{ replace: true },
			),
		[setParams],
	);

	const context = useMemo(() => sessionContextFor(id, session.data, { showHidden }), [id, session.data, showHidden]);

	if (session.error instanceof ApiError && session.error.status === 404) return <NotFoundPage what="session" />;

	const live = session.data ? isLive(session.data.lastAt) : false;
	const column = shown === "trajectory" ? TRAJECTORY_COLUMN : TRANSCRIPT_COLUMN;

	const header = session.data && (
		<header className={cx(column, "pt-4")} data-session-header="">
			<Breadcrumb session={session.data} />
			<div className="mt-1 flex items-start gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-start gap-2.5">
						<h1 className="line-clamp-2 text-[21px] leading-[1.3] font-semibold tracking-[-0.012em] break-words" title={session.data.title || "Untitled session"}>
							{session.data.title || "Untitled session"}
						</h1>
						{(live || online) && (
							<span className="mt-[5px] inline-flex shrink-0 gap-1.5 text-[12px] leading-5" data-title-badges="">
								{live && (
									<span data-live="">
										<Pill tone="green">live</Pill>
									</span>
								)}
								{online && (
									<span data-online="" title="Connected to pika relay right now">
										<Pill tone="green">Online</Pill>
									</span>
								)}
							</span>
						)}
					</div>
					<SessionChips session={session.data} />
				</div>
				<div className="flex shrink-0 items-center gap-0.5 pt-0.5">
					{shown === "transcript" && (
						<label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-[12.5px] text-muted hover:bg-hover hover:text-ink">
							<input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} className="accent-[#2383e2]" />
							<Icon name="eye" size={13} />
							Show hidden entries
						</label>
					)}
					{!api.publicView && <a
						href={api.exportUrl(id)}
						className="inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-[12.5px] text-muted hover:bg-hover hover:text-ink"
						download
						title={`Export all ${formatCount(session.data.entryCount)} entries as JSONL`}
					>
						<Icon name="download" size={13} />
						Export JSONL
					</a>}
					{online && (
						<ActionButton onClick={() => setMessaging(online)} aria-label="Message this session">
							<Icon name="message" size={13} />
							Message
						</ActionButton>
					)}
					<div className="ml-2">
						<ViewSwitch view={shown} onChange={setView} />
					</div>
				</div>
			</div>
			<KpiStrip session={session.data} trace={trace.data} />
		</header>
	);

	return (
		<SessionViewContext.Provider value={context}>
			{session.isPending ? (
				<div className={cx(TRAJECTORY_COLUMN, "pt-6")}>
					<Breadcrumb />
					<div className="mt-3">
						<HeaderSkeleton />
					</div>
				</div>
			) : session.isError ? (
				<div className={cx(TRANSCRIPT_COLUMN, "pt-6")}>
					<Breadcrumb />
					{session.error instanceof ApiError && session.error.status === 401 ? (
						<Callout tone="yellow" title="Sign in required">
							This server needs a password.
						</Callout>
					) : (
						<ErrorState error={session.error} onRetry={() => void session.refetch()} />
					)}
				</div>
			) : shown === "trajectory" ? (
				<div className="flex h-full min-h-[660px] flex-col" data-session-page="trajectory">
					{header}
					<div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-line">
						{trace.data ? (
							<ErrorBoundary label="the trajectory view" resetKey={trace.data} fallback={({ reset }) => <TrajectoryError id={id} reset={reset} />}>
								<Suspense fallback={<TrajectorySkeleton />}>
									<Trajectory key={id} sessionId={id} trace={trace.data} live={live} focusSeq={focusSeq} onFocusHandled={clearFocus} />
								</Suspense>
							</ErrorBoundary>
						) : trace.isError ? (
							<div className="px-6">
								<ErrorState error={trace.error} onRetry={() => void trace.refetch()} />
							</div>
						) : (
							<TrajectorySkeleton />
						)}
					</div>
				</div>
			) : (
				<div className="pb-32" data-session-page="transcript">
					{header}
					<div className={cx(TRANSCRIPT_COLUMN, "mt-4")}>
						{traceMissing && view === "trajectory" && (
							<div className="mb-4">
								<Callout title="Transcript only">
									<div className="text-[13px]">This server does not serve session traces yet, so the trajectory view is unavailable.</div>
								</Callout>
							</div>
						)}
						{trace.data && trace.data.records.length > 0 && (
							<div className="mb-4 min-h-[84px] rounded-md border border-line px-2 pt-2 pb-1.5" data-transcript-overview="">
								<ErrorBoundary
									label="the transcript's timeline"
									resetKey={trace.data}
									fallback={() => (
										<div className="flex h-[64px] items-center justify-center text-[12.5px] text-muted" data-overview-error="">
											The timeline could not be drawn; the transcript below is complete.
										</div>
									)}
								>
									<Suspense fallback={null}>
										<Overview
											trace={trace.data}
											compact
											onSelect={(item) => {
												const seq = item.record?.seq ?? (item.turnIndex !== undefined ? trace.data.turns.find((turn) => turn.index === item.turnIndex)?.startSeq : undefined);
												if (seq !== undefined) focusOn(seq);
											}}
										/>
									</Suspense>
								</ErrorBoundary>
							</div>
						)}
						<TurnList key={id} sessionId={id} showHidden={showHidden} focusSeq={focusSeq} onFocusHandled={clearFocus} />
					</div>
					{messaging && <MessageDialog session={messaging} onClose={() => setMessaging(null)} />}
				</div>
			)}
			{shown === "trajectory" && messaging && <MessageDialog session={messaging} onClose={() => setMessaging(null)} />}
		</SessionViewContext.Provider>
	);
}
