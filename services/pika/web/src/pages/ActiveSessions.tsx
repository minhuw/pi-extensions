import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Icon } from "../components/icons";
import { useSigningOut } from "../components/Layout";
import { MessageDialog } from "../components/MessageDialog";
import { BUTTON, Callout, cx, EmptyState, ErrorState, Page, PageTitle, Pill, SkeletonLines } from "../components/ui";
import { useApi } from "../lib/api";
import { formatDateTime, formatRelative, plural } from "../lib/format";
import { LAYOUT_GUARD_MS, useNow, useSettling } from "../lib/hooks";
import {
	formatSince,
	groupByDevice,
	idsKey,
	isRelayDisabled,
	relayAvailability,
	RELAY_EVENTS_KEY,
	RELAY_POLL_MS,
	RELAY_SESSIONS_KEY,
	senderLabel,
	sessionLabel,
	shortReason,
	targetLabel,
	useOnlineSessions,
	type RelayAvailability,
} from "../lib/relay";
import type { OnlineSession, RelayEvent, RelaySessionState } from "../lib/types";

/** Relative times and online durations refresh this often between polls. */
const CLOCK_MS = 10_000;
/** Text longer than this, or than three lines, gets a Show more toggle even where nothing can be measured. */
const LONG_TEXT = 280;

function H2({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
	return (
		<div className="mt-9 mb-2 flex items-center gap-2">
			<h2 className="text-[16px] font-semibold">{children}</h2>
			{aside}
		</div>
	);
}

function Code({ children }: { children: ReactNode }) {
	return <code className="code-chip">{children}</code>;
}

/** Busy or idle, in a fixed width so the row doesn't move when it flips. */
function StateIndicator({ state, since }: { state: RelaySessionState; since: string }) {
	const busy = state === "busy";
	return (
		<span
			className="flex h-5 w-[52px] shrink-0 items-center gap-1.5 text-[12px]"
			data-session-state={state}
			title={`${busy ? "Busy" : "Idle"} since ${formatDateTime(since)}`}
		>
			<span
				aria-hidden="true"
				className={cx("h-2 w-2 shrink-0 rounded-full", busy ? "animate-pulse bg-ink motion-reduce:animate-none" : "border border-ink/45")}
			/>
			<span className={busy ? "font-medium text-ink" : "text-muted"}>{busy ? "Busy" : "Idle"}</span>
		</span>
	);
}

function SessionRow({
	session,
	now,
	settling,
	onMessage,
}: {
	session: OnlineSession;
	now: number;
	/** The list just changed; Message waits until it settles. */
	settling: boolean;
	onMessage: (session: OnlineSession) => void;
}) {
	const label = sessionLabel(session);
	const named = Boolean(session.name || session.title);
	const labelClass = cx("min-w-0 truncate font-medium", !named && "mono");
	return (
		<li
			className="flex items-start gap-3 border-b border-line px-1.5 py-1.5 last:border-b-0 hover:bg-hover"
			data-online-session={session.id}
		>
			<StateIndicator state={session.state} since={session.stateSince} />
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-2 text-[13.5px] leading-5">
					{session.recorded ? (
						<Link
							to={`/s/${encodeURIComponent(session.id)}`}
							className={cx(labelClass, "underline decoration-transparent underline-offset-[3px] hover:decoration-ink")}
							title={session.id}
						>
							{label}
						</Link>
					) : (
						<span className={labelClass} title={`${session.id} · pika has no transcript of this session yet`}>
							{label}
						</span>
					)}
					{named && <span className="mono shrink-0 text-[11.5px] text-muted">{session.id.slice(0, 8)}</span>}
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
					<span className="flex min-w-0 items-center gap-1 text-ink/80" data-project="">
						<span className="truncate">{session.project || "—"}</span>
					</span>
					<span className="mono min-w-0 truncate !text-[11.5px]" title={session.cwd} data-cwd="">
						{session.cwd}
					</span>
					{session.model && (
						<span className="flex min-w-0 items-center gap-1" data-model="">
							<span className="mono truncate text-[11.5px]">{session.model}</span>
						</span>
					)}
					<span className="tnum whitespace-nowrap" title={`Connected ${formatDateTime(session.connectedAt)}`} data-online-for="">
						Online {formatSince(session.connectedAt, now)}
					</span>
					<span className="tnum whitespace-nowrap" title={formatDateTime(session.stateSince)} data-last-activity="">
						Last activity {formatRelative(session.stateSince, now)}
					</span>
				</div>
			</div>
			<button
				type="button"
				onClick={() => onMessage(session)}
				disabled={settling}
				className={cx(BUTTON.secondary, "h-7 shrink-0 gap-1.5")}
				aria-label={`Message ${label}`}
			>
				<Icon name="message" size={14} />
				Message
			</button>
		</li>
	);
}

function DeviceGroup({ device, name, sessions, children }: { device: string; name: string; sessions: OnlineSession[]; children: ReactNode }) {
	const hosts = [...new Set(sessions.map((session) => session.host).filter((host) => host && host !== name && host !== device))];
	return (
		<section aria-label={`Sessions on ${name}`} data-relay-device={device} data-device-name={name} className="mt-5 first:mt-2">
			<h3 className="flex min-h-7 min-w-0 items-center gap-2 border-b border-ink px-1.5 pb-1 text-[13px] font-semibold">
				<Icon name="device" className="shrink-0 text-muted" />
				<span className="break-words" title={device}>
					{name}
				</span>
				{hosts.length > 0 && <span className="min-w-0 truncate font-normal text-muted">{hosts.join(", ")}</span>}
				<span className="tnum ml-auto shrink-0 text-[12px] font-normal text-muted">{plural(sessions.length, "session")}</span>
			</h3>
			<ul className="border-b border-line">{children}</ul>
		</section>
	);
}

function StatusBadge({ event }: { event: RelayEvent }) {
	switch (event.status) {
		case "delivered":
			return (
				<Pill tone="green" title={event.deliveredAt ? `Delivered ${formatDateTime(event.deliveredAt)}` : undefined}>
					delivered
				</Pill>
			);
		case "queued":
			return (
				<Pill tone="yellow" title="Not delivered yet; dropped after 5 minutes">
					queued
				</Pill>
			);
		case "expired":
			return (
				<Pill title="Not delivered within 5 minutes, so it was dropped">
					expired
				</Pill>
			);
		case "rejected":
			return <Pill tone="red">rejected: {shortReason(event.reason)}</Pill>;
		default:
			return <Pill>{String(event.status)}</Pill>;
	}
}

function EventItem({
	event,
	now,
	expanded,
	settling,
	onToggle,
}: {
	event: RelayEvent;
	now: number;
	expanded: boolean;
	settling: boolean;
	onToggle: (id: string) => void;
}) {
	const textId = useId();
	const textRef = useRef<HTMLDivElement>(null);
	const [overflowing, setOverflowing] = useState(false);
	useLayoutEffect(() => {
		const node = textRef.current;
		if (node && !expanded) setOverflowing(node.scrollHeight > node.clientHeight + 1);
	}, [event.text, expanded]);
	const long = overflowing || event.text.length > LONG_TEXT || event.text.split("\n").length > 3;
	const from = event.from;
	// A bare id has no spaces to wrap at, so a long one ends in an ellipsis; names and titles wrap.
	const bareSender = from.kind === "session" && !from.name && !from.title;
	const bareTarget = !event.to.name && !event.to.title;
	return (
		<li className="border-b border-line px-1.5 py-2 last:border-b-0" data-relay-event={event.id} data-status={event.status}>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
				<span
					className="flex max-w-full min-w-0 items-center gap-1.5 font-medium"
					data-sender=""
					title={from.kind === "session" ? from.sessionId : undefined}
				>
					<Icon name={from.kind === "web" ? "user" : "terminal"} size={14} className="shrink-0 text-muted" />
					<span className={cx("min-w-0", bareSender ? "truncate" : "break-words")}>{senderLabel(from)}</span>
				</span>
				<span className="text-muted" aria-hidden="true">
					→
				</span>
				<span className="sr-only">to</span>
				<span
					className={cx("max-w-full min-w-0 font-medium", bareTarget ? "truncate" : "break-words")}
					data-target=""
					title={event.to.sessionId}
				>
					{targetLabel(event.to)}
				</span>
				{event.urgent && <Pill tone="red">urgent</Pill>}
				{event.replyTo && (
					<span className="text-[13px] text-muted" title={`Replying to ${event.replyTo}`}>
						reply
					</span>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-2">
					<StatusBadge event={event} />
					<span className="tnum text-[12px] whitespace-nowrap text-muted" title={formatDateTime(event.at)} data-at="">
						{formatRelative(event.at, now)}
					</span>
				</span>
			</div>
			<div
				ref={textRef}
				id={textId}
				className={cx("mt-0.5 text-[13.5px] break-words whitespace-pre-wrap", !expanded && "line-clamp-3")}
				data-event-text=""
				data-expanded={expanded ? "" : undefined}
			>
				{event.text}
			</div>
			{long && (
				<button
					type="button"
					onClick={() => onToggle(event.id)}
					disabled={settling}
					aria-expanded={expanded}
					aria-controls={textId}
					className="-mx-1 mt-1 rounded-sm px-1 text-[13px] text-muted hover:bg-hover hover:text-ink disabled:cursor-default"
				>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
		</li>
	);
}

function RelayOff({ availability }: { availability: Exclude<RelayAvailability, "on" | "loading" | "error"> }) {
	return (
		<div className="mt-8" data-relay-off={availability}>
			{availability === "off" ? (
				<Callout tone="yellow" icon="alert" title="Relay is turned off on this server">
					<div className="text-[14px]">
						pika runs with <Code>PIKA_RELAY=off</Code>, so pi sessions don't connect to it and can't message each other.
						Relay is on by default: remove the setting and restart pika to see the sessions running right now.
					</div>
				</Callout>
			) : (
				<Callout tone="yellow" icon="alert" title="This pika server has no relay">
					<div className="text-[14px]">
						The server is too old: relay needs pika 0.3.0 or newer. Update it to see the pi sessions running right now and
						message them.
					</div>
				</Callout>
			)}
		</div>
	);
}

export function ActiveSessionsPage() {
	const api = useApi();
	const queryClient = useQueryClient();
	const { signingOut } = useSigningOut();
	// Polling stops while the tab is hidden (TanStack's refetchIntervalInBackground is off), and once signing out starts.
	const { health, sessions, availability: sessionsAvailability } = useOnlineSessions(signingOut ? false : RELAY_POLL_MS);
	const events = useQuery({
		queryKey: RELAY_EVENTS_KEY,
		queryFn: () => api.relayEvents(),
		enabled: sessionsAvailability === "on",
		staleTime: 0,
		refetchInterval: (query) => (signingOut || isRelayDisabled(query.state.error) ? false : RELAY_POLL_MS),
	});
	useEffect(() => {
		if (!signingOut) return;
		void queryClient.cancelQueries({ queryKey: RELAY_SESSIONS_KEY });
		void queryClient.cancelQueries({ queryKey: RELAY_EVENTS_KEY });
	}, [signingOut, queryClient]);
	const availability = relayAvailability(health, sessions.error, events.error);
	const now = useNow(true, CLOCK_MS);
	const [messaging, setMessaging] = useState<OnlineSession | null>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	// Rows come and go as sessions start and stop; buttons wait until the list settles before taking clicks.
	const sessionsSettling = useSettling(idsKey(sessions.data?.items), LAYOUT_GUARD_MS);
	const eventsSettling = useSettling(idsKey(events.data?.items), LAYOUT_GUARD_MS);

	const items = sessions.data?.items ?? [];
	const groups = groupByDevice(items);
	const eventItems = events.data?.items ?? [];
	const toggle = (id: string) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	let body: ReactNode;
	if (availability === "loading") body = <div className="mt-8"><SkeletonLines lines={3} /></div>;
	else if (availability === "error") body = <ErrorState error={health.error} onRetry={() => void health.refetch()} />;
	else if (availability !== "on") body = <RelayOff availability={availability} />;
	else
		body = (
			<>
				<H2 aside={items.length > 0 && <Pill tone="accent">{items.length}</Pill>}>Online</H2>
				{sessions.isPending ? (
					<SkeletonLines lines={3} />
				) : sessions.isError && !sessions.data ? (
					<ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} />
				) : items.length === 0 ? (
					<EmptyState title="No sessions online">
						pi sessions logged into pika appear here while they run, through the relay extension. Start pi on a machine that
						ran <Code>/pika login</Code>, and it shows up within seconds.
					</EmptyState>
				) : (
					<div data-online-sessions="">
						{groups.map((group) => (
							<DeviceGroup key={group.device} device={group.device} name={group.name} sessions={group.sessions}>
								{group.sessions.map((session) => (
									<SessionRow key={session.id} session={session} now={now} settling={sessionsSettling} onMessage={setMessaging} />
								))}
							</DeviceGroup>
						))}
					</div>
				)}
				<H2>Recent messages</H2>
				{events.isPending ? (
					<SkeletonLines lines={2} />
				) : events.isError && !events.data ? (
					<ErrorState error={events.error} onRetry={() => void events.refetch()} />
				) : eventItems.length === 0 ? (
					<p className="text-[13px] text-muted">
						No messages yet. Messages between sessions, and the ones you send from here, show up until pika restarts; it keeps
						the last 500.
					</p>
				) : (
					<ul className="border-t border-ink border-b border-b-line" data-relay-events="">
						{eventItems.map((event) => (
							<EventItem
								key={event.id}
								event={event}
								now={now}
								expanded={expanded.has(event.id)}
								settling={sessionsSettling || eventsSettling}
								onToggle={toggle}
							/>
						))}
					</ul>
				)}
			</>
		);

	return (
		<Page className="pb-24">
			<PageTitle>Active sessions</PageTitle>
			<p className="mt-2 max-w-[72ch] text-[14px] text-pretty text-muted">
				pi sessions running right now on machines logged into pika. Send one a message, or follow what sessions send each other.
			</p>
			{body}
			{messaging && <MessageDialog session={messaging} onClose={() => setMessaging(null)} />}
		</Page>
	);
}
