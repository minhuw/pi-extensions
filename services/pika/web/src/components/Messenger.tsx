import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError, useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { deviceLabel } from "../lib/devices";
import { formatDateTime, formatRelative, plural } from "../lib/format";
import { useMediaQuery } from "../lib/hooks";
import { bareModelOf } from "../lib/model";
import {
	formatBytes,
	isRelayDisabled,
	MAX_TEXT_BYTES,
	messageShape,
	plainLine,
	previewSource,
	reasonMessage,
	RELAY_EVENTS_KEY,
	RELAY_POLL_MS,
	RELAY_ROOMS_KEY,
	relayRoomKey,
	sessionLabel,
	shortId,
	shortReason,
	utf8Length,
} from "../lib/relay";
import type {
	OnlineSession,
	RelayEvent,
	RelayRejection,
	RelayRoom,
	RelayRoomMessage,
	RelaySender,
	RelayStatus,
	RelayTarget,
} from "../lib/types";
import { Icon } from "./icons";
import { useSigningOut } from "./Layout";
import { Markdown } from "./Markdown";
import { ModelMark } from "./ModelName";
import { BUTTON, cx, Pill, Segmented } from "./ui";

export type ThreadSelection =
	| { kind: "dm"; sessionId: string }
	| { kind: "room"; room: string };

type PeerState = "idle" | "busy" | "offline";

interface DmThread {
	kind: "dm";
	key: string;
	sessionId: string;
	label: string;
	device: string;
	project: string;
	model?: string;
	state: PeerState;
	recorded: boolean;
	/** When the last message to or from the session was sent; 0 without one. */
	lastAt: number;
	preview: string;
}

interface RoomThread {
	kind: "room";
	key: string;
	room: RelayRoom;
	lastAt: number;
	preview: string;
}

type ThreadItem = DmThread | RoomThread;

/** One message in a conversation: a direct relay event, or a post in a room's history. */
interface ChatMessage {
	id: string;
	at: string;
	from: RelaySender;
	/** Direct messages only: who it went to. */
	to?: RelayTarget;
	/** Room posts only: the members it woke. */
	notified?: RelayTarget[];
	status?: RelayStatus;
	reason?: RelayRejection;
	deliveredAt?: string;
	urgent: boolean;
	replyTo?: string;
	hops: number;
	text: string;
}

const ROOM_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** From this width a long message opens in a reader beside the conversation; below it, it expands in place. */
const READER_QUERY = "(min-width: 1280px)";
/** How close to the bottom the conversation must be for a new message to keep it pinned there. */
const STICK_PX = 80;

const STATE_WORD: Record<PeerState, string> = { busy: "Busy", idle: "Idle", offline: "Offline" };

function senderName(sender: RelaySender): string {
	return sender.kind === "web" ? "You" : sessionLabel(sender);
}

function senderWhere(sender: RelaySender): string {
	if (sender.kind === "web") return "";
	return [sender.project, deviceLabel(sender)].filter(Boolean).join(" · ");
}

function memberDevice(target: { device?: string; deviceName?: string }): string {
	return target.device ? deviceLabel({ device: target.device, deviceName: target.deviceName }) : "";
}

function names(targets: readonly RelayTarget[]): string {
	return targets.map((target) => sessionLabel(target)).join(", ");
}

/** Busy is a filled, pulsing dot; idle an open ring; offline a faint dashed ring. */
function StateDot({ state }: { state: PeerState }) {
	return (
		<span
			aria-hidden="true"
			className={cx(
				"inline-block h-2 w-2 shrink-0 rounded-full",
				state === "busy" && "running-dot bg-current",
				state === "idle" && "border border-current",
				state === "offline" && "border border-dashed border-current opacity-55",
			)}
		/>
	);
}

/** Marks a room's representative; outlined in the text colour, so it reads on pressed buttons too. */
function RepBadge() {
	return (
		<span
			title="Representative"
			data-imessage-representative=""
			className="inline-flex h-4 shrink-0 items-center rounded-sm border border-current px-1 text-[11px] leading-none font-medium"
		>
			rep
		</span>
	);
}

function DeliveryStatus({ message }: { message: ChatMessage }) {
	switch (message.status) {
		case "delivered":
			return (
				<span className="text-muted" title={message.deliveredAt ? `Delivered ${formatDateTime(message.deliveredAt)}` : undefined}>
					Delivered
				</span>
			);
		case "queued":
			return (
				<Pill tone="yellow" title="Waiting for the session to take it; dropped after 5 minutes">
					Queued
				</Pill>
			);
		case "expired":
			return <Pill title="Not delivered within 5 minutes, so it was dropped">Expired</Pill>;
		case "rejected":
			return (
				<Pill tone="red" title={reasonMessage(message.reason ?? "")}>
					Not delivered: {shortReason(message.reason)}
				</Pill>
			);
		default:
			return null;
	}
}

function ThreadRow({
	item,
	selected,
	now,
	onSelect,
}: {
	item: ThreadItem;
	selected: boolean;
	now: number;
	onSelect: () => void;
}) {
	const quiet = selected ? "text-page/75" : "text-muted";
	const label = item.kind === "room" ? `#${item.room.name}` : item.label;
	const repos = item.kind === "room" ? [...new Set(item.room.members.map((m) => m.project).filter(Boolean))] : [];
	const meta =
		item.kind === "room"
			? [plural(item.room.members.length, "member"), ...repos].join(" · ")
			: [item.project, item.device].filter(Boolean).join(" · ");
	return (
		<li>
			<button
				type="button"
				onClick={onSelect}
				data-imessage-thread={item.key}
				aria-current={selected ? "true" : undefined}
				className={cx(
					"flex w-full flex-col gap-px px-3 py-2 text-left transition-colors duration-150",
					selected ? "bg-ink text-page" : "hover:bg-hover",
				)}
			>
				<span className="flex min-w-0 items-center gap-2">
					{item.kind === "dm" && <StateDot state={item.state} />}
					<span className="min-w-0 flex-1 truncate text-[13.5px] leading-5 font-medium">{label}</span>
					{item.lastAt > 0 && (
						<span className={cx("tnum shrink-0 text-[11.5px]", quiet)}>
							{formatRelative(new Date(item.lastAt).toISOString(), now)}
						</span>
					)}
				</span>
				<span className={cx("truncate text-[12px]", quiet)}>
					{item.kind === "dm" && <span className="sr-only">{STATE_WORD[item.state]} · </span>}
					{meta}
				</span>
				<span className={cx("truncate text-[12px]", selected ? "text-page/90" : "text-ink/80")}>{item.preview}</span>
			</button>
		</li>
	);
}

function MessageRecord({
	message,
	now,
	readerMode,
	selected,
	expanded,
	onRead,
}: {
	message: ChatMessage;
	now: number;
	/** Long messages open in the reader; otherwise they expand in place. */
	readerMode: boolean;
	selected: boolean;
	expanded: boolean;
	onRead: (id: string) => void;
}) {
	const bodyId = useId();
	const shape = useMemo(() => messageShape(message.text), [message.text]);
	const whole = !shape.long || (!readerMode && expanded);
	const where = senderWhere(message.from);
	return (
		<li
			data-imessage-bubble={message.id}
			data-selected={selected ? "" : undefined}
			className={cx("border-b border-line px-4 py-3 last:border-b-0", selected && "bg-accent-soft")}
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] leading-5">
				<Icon name={message.from.kind === "web" ? "user" : "terminal"} size={14} className="shrink-0 text-muted" />
				<span className="font-medium" data-sender="" title={message.from.kind === "session" ? message.from.sessionId : undefined}>
					{senderName(message.from)}
				</span>
				{where && <span className="text-[12px] text-muted">{where}</span>}
				{message.to && (
					<>
						<span aria-hidden="true" className="text-muted">
							→
						</span>
						<span className="sr-only">to</span>
						<span className="font-medium" title={message.to.sessionId}>
							{sessionLabel(message.to)}
						</span>
					</>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-2 text-[12px]">
					{message.urgent && <Pill tone="red">Urgent</Pill>}
					<DeliveryStatus message={message} />
					<time className="tnum text-muted" dateTime={message.at} title={formatDateTime(message.at)}>
						{formatRelative(message.at, now)}
					</time>
				</span>
			</div>
			<div
				id={bodyId}
				data-message-body=""
				className={cx(
					"mt-1 pl-[22px] text-[13.5px]",
					!whole && "max-h-[11.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_62%,transparent)]",
				)}
			>
				<Markdown text={whole ? message.text : previewSource(message.text)} />
			</div>
			{(shape.long || message.notified) && (
				<div
					className={cx(
						"mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[22px] text-[12px] text-muted",
						// An expanded message keeps Show less in reach while it scrolls past.
						!readerMode && expanded && shape.long && "sticky bottom-0 -mx-4 border-t border-line bg-page px-4 py-1.5 pl-[38px]",
					)}
				>
					{shape.long && (
						<button
							type="button"
							onClick={() => onRead(message.id)}
							data-imessage-read={message.id}
							{...(readerMode
								? { "aria-pressed": selected }
								: { "aria-expanded": expanded, "aria-controls": bodyId })}
							className="-mx-1 rounded-sm px-1 font-medium text-ink underline decoration-ink/30 underline-offset-[3px] hover:bg-hover hover:decoration-ink"
						>
							{readerMode ? (selected ? "Close reader" : "Read in full") : expanded ? "Show less" : "Show all"}
						</button>
					)}
					{shape.long && (
						<span className="tnum">
							{plural(shape.lines, "line")} · {formatBytes(shape.bytes)}
						</span>
					)}
					{shape.long && shape.sections.length > 0 && (
						<span className="min-w-0 max-w-full truncate" title={shape.sections.join(" · ")}>
							{shape.sections.join(" · ")}
						</span>
					)}
					{message.notified && (
						<span className="basis-full" data-notified="">
							{message.notified.length > 0
								? `Notified ${names(message.notified)}`
								: "Room history only; no one notified"}
						</span>
					)}
				</div>
			)}
		</li>
	);
}

function Reader({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
	const [view, setView] = useState<"rendered" | "raw">("rendered");
	const [copied, setCopied] = useState<boolean | null>(null);
	const [headings, setHeadings] = useState<string[]>([]);
	const bodyRef = useRef<HTMLDivElement>(null);
	const shape = useMemo(() => messageShape(message.text), [message.text]);

	useEffect(() => {
		setCopied(null);
		bodyRef.current?.scrollTo({ top: 0 });
	}, [message.id]);
	// The outline is read from what was rendered, so it matches the headings it jumps to.
	useLayoutEffect(() => {
		const nodes = bodyRef.current?.querySelectorAll("h1, h2, h3") ?? [];
		setHeadings(view === "rendered" ? Array.from(nodes, (node) => node.textContent ?? "") : []);
	}, [message.text, view]);

	const jump = (index: number) => {
		const body = bodyRef.current;
		const target = body?.querySelectorAll<HTMLElement>("h1, h2, h3")[index];
		if (!body || !target) return;
		body.scrollTo({ top: target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 8 });
	};

	return (
		<aside
			aria-label="Message reader"
			data-imessage-reader={message.id}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
			className="flex min-h-0 flex-col border-t border-line bg-page xl:border-t-0 xl:border-l"
		>
			<div className="flex items-start gap-2 border-b border-line px-4 py-2.5">
				<div className="min-w-0 flex-1">
					<div className="text-[13.5px] leading-5 font-medium break-words">
						{senderName(message.from)}
						{message.to && (
							<>
								<span className="text-muted"> → </span>
								{sessionLabel(message.to)}
							</>
						)}
					</div>
					<div className="tnum text-[12px] text-muted">
						{formatDateTime(message.at)} · {plural(shape.lines, "line")} · {formatBytes(shape.bytes)}
					</div>
				</div>
				<button type="button" onClick={onClose} aria-label="Close reader" className={cx(BUTTON.quiet, "h-7 w-7 justify-center px-0")}>
					<Icon name="close" size={14} className="shrink-0" />
				</button>
			</div>
			<div className="flex items-center gap-2 border-b border-line px-4 py-2">
				<Segmented
					size="sm"
					label="Show the message"
					value={view}
					options={[
						["rendered", "Rendered"],
						["raw", "Raw"],
					]}
					onChange={setView}
				/>
				<button
					type="button"
					onClick={() => void copyText(message.text).then(setCopied)}
					data-imessage-copy=""
					className={cx(BUTTON.secondary, "ml-auto h-7")}
				>
					<Icon name={copied ? "check" : "copy"} size={14} />
					{copied ? "Copied" : copied === false ? "Copy failed" : "Copy text"}
				</button>
			</div>
			{headings.length > 1 && (
				<nav aria-label="Sections" className="max-h-24 overflow-y-auto border-b border-line px-4 py-2">
					<ol className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px]">
						{headings.map((heading, index) => (
							<li key={index}>
								<button
									type="button"
									onClick={() => jump(index)}
									className="-mx-1 rounded-sm px-1 text-muted hover:bg-hover hover:text-ink"
								>
									{heading}
								</button>
							</li>
						))}
					</ol>
				</nav>
			)}
			<div
				ref={bodyRef}
				tabIndex={0}
				aria-label="Message text"
				data-imessage-reader-body=""
				className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[13.5px]"
			>
				{view === "rendered" ? <Markdown text={message.text} /> : <pre className="code-block wrap">{message.text}</pre>}
			</div>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-t border-line px-4 py-2.5 text-[12px]">
				{message.status && (
					<>
						<dt className="text-muted">Status</dt>
						<dd>
							{message.status === "rejected" ? reasonMessage(message.reason ?? "") : message.status}
							{message.deliveredAt && message.status === "delivered" && ` ${formatDateTime(message.deliveredAt)}`}
						</dd>
					</>
				)}
				{message.notified && (
					<>
						<dt className="text-muted">Notified</dt>
						<dd className="break-words">{message.notified.length > 0 ? names(message.notified) : "No one"}</dd>
					</>
				)}
				<dt className="text-muted">Hops</dt>
				<dd className="tnum">{message.hops}</dd>
				{message.replyTo && (
					<>
						<dt className="text-muted">Reply to</dt>
						<dd className="mono truncate !text-[11.5px]">{message.replyTo}</dd>
					</>
				)}
				<dt className="text-muted">Id</dt>
				<dd className="mono truncate !text-[11.5px]">{message.id}</dd>
			</dl>
		</aside>
	);
}

function ThreadGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
	return (
		<section aria-label={title} className="pt-2 first:pt-1">
			<h3 className="flex items-baseline justify-between px-3 pb-1 text-[11.5px] font-semibold text-muted">
				<span>{title}</span>
				<span className="tnum font-normal">{count}</span>
			</h3>
			<ul>{children}</ul>
		</section>
	);
}

const FIELD =
	"mt-0.5 block w-full rounded-sm border border-line bg-page px-2 py-1 text-[13px] text-ink outline-none placeholder:text-muted focus:border-ink";

export function Messenger({
	sessions,
	events,
	now,
	selectedThread,
	onSelectThread,
}: {
	sessions: readonly OnlineSession[];
	events: readonly RelayEvent[];
	now: number;
	selectedThread?: ThreadSelection | null;
	onSelectThread?: (thread: ThreadSelection) => void;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const { signingOut } = useSigningOut();
	const composerId = useId();
	const roomNameId = useId();
	const roomTopicId = useId();
	const notifyId = useId();
	const readerMode = useMediaQuery(READER_QUERY);

	const roomsQuery = useQuery({
		queryKey: RELAY_ROOMS_KEY,
		queryFn: () => api.relayRooms(),
		enabled: !signingOut,
		staleTime: 0,
		refetchInterval: (query) => (signingOut || isRelayDisabled(query.state.error) ? false : RELAY_POLL_MS),
	});
	const rooms = roomsQuery.data?.items ?? [];

	const [search, setSearch] = useState("");
	const [internalThread, setInternalThread] = useState<ThreadSelection | null>(null);
	const activeThread = selectedThread !== undefined ? selectedThread : internalThread;
	const setActiveThread = (next: ThreadSelection) => {
		setInternalThread(next);
		onSelectThread?.(next);
	};

	// New room form
	const [creatingRoom, setCreatingRoom] = useState(false);
	const [newRoomName, setNewRoomName] = useState("");
	const [newRoomTopic, setNewRoomTopic] = useState("");
	const [newRoomMembers, setNewRoomMembers] = useState<ReadonlySet<string>>(() => new Set());
	const [roomFormError, setRoomFormError] = useState<string | null>(null);
	const [savingRoom, setSavingRoom] = useState(false);

	// Room management
	const [managingMembers, setManagingMembers] = useState(false);
	const [memberBusyId, setMemberBusyId] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	// Reading
	const [readerId, setReaderId] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

	// Composer
	const [text, setText] = useState("");
	const [urgent, setUrgent] = useState(false);
	const [selectedMentions, setSelectedMentions] = useState<ReadonlySet<string>>(() => new Set());
	const [sending, setSending] = useState(false);
	const [sendFeedback, setSendFeedback] = useState<{ tone: "ok" | "queued" | "error"; message: string } | null>(null);
	const streamRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const stickToBottom = useRef(true);

	const threads = useMemo<ThreadItem[]>(() => {
		const dmMap = new Map<string, DmThread>();
		for (const s of sessions) {
			dmMap.set(s.id, {
				kind: "dm",
				key: `dm:${s.id}`,
				sessionId: s.id,
				label: sessionLabel(s),
				device: deviceLabel(s),
				project: s.project || "—",
				model: bareModelOf(s.model),
				state: s.state,
				recorded: s.recorded,
				lastAt: 0,
				preview: "No messages yet",
			});
		}
		// Every session a direct message touched gets a thread, so offline ones that exchanged messages still show up.
		for (const ev of events) {
			if (ev.room || ev.to.sessionId.startsWith("#")) continue;
			const at = Date.parse(ev.at) || 0;
			const line = `${senderName(ev.from)}: ${plainLine(ev.text)}`;
			const peers: { id: string; meta: RelayTarget }[] = [{ id: ev.to.sessionId, meta: ev.to }];
			if (ev.from.kind === "session") peers.push({ id: ev.from.sessionId, meta: ev.from });
			for (const { id, meta } of peers) {
				let thread = dmMap.get(id);
				if (!thread) {
					thread = {
						kind: "dm",
						key: `dm:${id}`,
						sessionId: id,
						label: sessionLabel({ ...meta, sessionId: id }),
						device: meta.device ? deviceLabel({ device: meta.device, deviceName: meta.deviceName }) : "",
						project: meta.project || "—",
						state: "offline",
						recorded: false,
						lastAt: 0,
						preview: "",
					};
					dmMap.set(id, thread);
				}
				if (at >= thread.lastAt) {
					thread.lastAt = at;
					thread.preview = line;
				}
			}
		}
		const byRecent = (a: ThreadItem, b: ThreadItem) => b.lastAt - a.lastAt || a.key.localeCompare(b.key);
		const roomThreads: RoomThread[] = rooms.map((r) => ({
			kind: "room",
			key: `room:${r.name}`,
			room: r,
			lastAt: Date.parse(r.lastMessage?.at ?? r.updatedAt) || Date.parse(r.createdAt) || 0,
			preview: r.lastMessage
				? `${senderName(r.lastMessage.from)}: ${plainLine(r.lastMessage.text)}`
				: r.topic || "No messages yet",
		}));
		return [...roomThreads.sort(byRecent), ...[...dmMap.values()].sort(byRecent)];
	}, [sessions, events, rooms]);

	const filteredThreads = useMemo(() => {
		const q = search.trim().toLowerCase().replace(/^#/, "");
		if (!q) return threads;
		return threads.filter((item) => {
			if (item.kind === "room") {
				return (
					item.room.name.toLowerCase().includes(q)
					|| (item.room.topic?.toLowerCase().includes(q) ?? false)
					|| item.room.members.some(
						(m) =>
							m.sessionId.toLowerCase().includes(q)
							|| sessionLabel(m).toLowerCase().includes(q)
							|| (m.project?.toLowerCase().includes(q) ?? false),
					)
				);
			}
			return (
				item.label.toLowerCase().includes(q)
				|| item.sessionId.toLowerCase().includes(q)
				|| item.project.toLowerCase().includes(q)
				|| item.device.toLowerCase().includes(q)
			);
		});
	}, [threads, search]);

	// The selected thread, or the first one when nothing is selected or the selected room was deleted.
	const resolvedSelection = useMemo<ThreadSelection | null>(() => {
		if (activeThread) {
			if (activeThread.kind === "room" && rooms.some((r) => r.name === activeThread.room)) return activeThread;
			if (activeThread.kind === "dm" && threads.some((t) => t.kind === "dm" && t.sessionId === activeThread.sessionId)) {
				return activeThread;
			}
		}
		const first = filteredThreads[0] ?? threads[0];
		if (!first) return null;
		return first.kind === "room" ? { kind: "room", room: first.room.name } : { kind: "dm", sessionId: first.sessionId };
	}, [activeThread, rooms, threads, filteredThreads]);

	const activeRoomName = resolvedSelection?.kind === "room" ? resolvedSelection.room : null;
	const roomDetailQuery = useQuery({
		queryKey: relayRoomKey(activeRoomName ?? ""),
		queryFn: () => api.relayRoom(activeRoomName!, 150),
		enabled: Boolean(activeRoomName) && !signingOut,
		staleTime: 0,
		refetchInterval: (query) => (signingOut || !activeRoomName || isRelayDisabled(query.state.error) ? false : RELAY_POLL_MS),
	});

	const resolvedKey = resolvedSelection
		? resolvedSelection.kind === "room"
			? `room:${resolvedSelection.room}`
			: `dm:${resolvedSelection.sessionId}`
		: "";

	useEffect(() => {
		setSelectedMentions(new Set());
		setSendFeedback(null);
		setManagingMembers(false);
		setConfirmingDelete(false);
		setReaderId(null);
		setExpanded(new Set());
		stickToBottom.current = true;
	}, [resolvedKey]);

	const activeRoom: RelayRoom | undefined = useMemo(() => {
		if (resolvedSelection?.kind !== "room") return undefined;
		return roomDetailQuery.data?.room ?? rooms.find((r) => r.name === resolvedSelection.room);
	}, [resolvedSelection, roomDetailQuery.data, rooms]);

	const activeDm: DmThread | undefined = useMemo(() => {
		if (resolvedSelection?.kind !== "dm") return undefined;
		return threads.find((t): t is DmThread => t.kind === "dm" && t.sessionId === resolvedSelection.sessionId);
	}, [resolvedSelection, threads]);

	// The conversation, oldest first.
	const messages = useMemo<ChatMessage[]>(() => {
		if (resolvedSelection?.kind === "room") {
			const posts: RelayRoomMessage[] = roomDetailQuery.data?.messages ?? [];
			return posts.map((m) => ({
				id: m.id,
				at: m.at,
				from: m.from,
				notified: m.notified,
				urgent: m.urgent,
				replyTo: m.replyTo,
				hops: m.hops,
				text: m.text,
			}));
		}
		if (resolvedSelection?.kind !== "dm") return [];
		const sid = resolvedSelection.sessionId;
		return events
			.filter(
				(ev) =>
					!ev.room
					&& !ev.to.sessionId.startsWith("#")
					&& (ev.to.sessionId === sid || (ev.from.kind === "session" && ev.from.sessionId === sid)),
			)
			.map((ev) => ({
				id: ev.id,
				at: ev.at,
				from: ev.from,
				to: ev.to,
				status: ev.status,
				reason: ev.reason,
				deliveredAt: ev.deliveredAt,
				urgent: ev.urgent,
				replyTo: ev.replyTo,
				hops: ev.hops,
				text: ev.text,
			}))
			.reverse();
	}, [resolvedSelection, roomDetailQuery.data, events]);

	const readerMessage = readerMode && readerId ? messages.find((m) => m.id === readerId) : undefined;

	// New messages keep the conversation at its end only while the reader is already there.
	useLayoutEffect(() => {
		const node = streamRef.current;
		if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
	}, [messages.length, resolvedKey]);

	// The composer grows with its text, up to a limit after which it scrolls.
	useLayoutEffect(() => {
		const node = inputRef.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${Math.min(node.scrollHeight, 240)}px`;
	}, [text]);

	const bytes = utf8Length(text);
	const tooLong = bytes > MAX_TEXT_BYTES;
	const canSend = Boolean(resolvedSelection) && text.trim() !== "" && !tooLong && !sending;

	const onRead = (id: string) => {
		if (readerMode) setReaderId((current) => (current === id ? null : id));
		else
			setExpanded((current) => {
				const next = new Set(current);
				if (!next.delete(id)) next.add(id);
				return next;
			});
	};

	const toggleMention = (token: string) => {
		setSelectedMentions((current) => {
			const next = new Set(current);
			if (token === "all") {
				if (next.has("all")) next.delete("all");
				else {
					next.clear();
					next.add("all");
				}
				return next;
			}
			next.delete("all");
			if (!next.delete(token)) next.add(token);
			return next;
		});
	};

	const handleCreateRoom = async () => {
		const cleanName = newRoomName.trim().replace(/^#/, "");
		if (!ROOM_NAME_RE.test(cleanName)) {
			setRoomFormError("Use 1–64 letters, digits, dots, hyphens, or underscores, such as auth-sync.");
			return;
		}
		setSavingRoom(true);
		setRoomFormError(null);
		try {
			const created = await api.saveRelayRoom({
				name: cleanName,
				...(newRoomTopic.trim() ? { topic: newRoomTopic.trim() } : {}),
				members: [...newRoomMembers],
			});
			await queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY });
			setCreatingRoom(false);
			setNewRoomName("");
			setNewRoomTopic("");
			setNewRoomMembers(new Set());
			setActiveThread({ kind: "room", room: created.room.name });
		} catch (cause) {
			setRoomFormError(cause instanceof ApiError ? reasonMessage(cause.message) : cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSavingRoom(false);
		}
	};

	const handleToggleRoomMember = async (roomName: string, sessionId: string, isMember: boolean) => {
		setMemberBusyId(sessionId);
		try {
			await api.setRelayRoomMember(roomName, { sessionId, action: isMember ? "remove" : "add" });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
				queryClient.invalidateQueries({ queryKey: relayRoomKey(roomName) }),
			]);
		} finally {
			setMemberBusyId(null);
		}
	};

	const handleDeleteRoom = async (roomName: string) => {
		await api.deleteRelayRoom(roomName);
		await queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY });
		setInternalThread(null);
	};

	const handleSend = async () => {
		if (!canSend || !resolvedSelection) return;
		setSending(true);
		setSendFeedback(null);
		stickToBottom.current = true;
		try {
			if (resolvedSelection.kind === "dm") {
				const sent = await api.sendRelayMessage({ to: resolvedSelection.sessionId, text, urgent });
				setText("");
				setUrgent(false);
				setSendFeedback({
					tone: sent.status === "delivered" ? "ok" : "queued",
					message: sent.status === "delivered" ? "Delivered" : "Queued: delivered when the session takes it, or dropped after 5 minutes",
				});
				await queryClient.invalidateQueries({ queryKey: RELAY_EVENTS_KEY });
			} else {
				const mentions = [...selectedMentions];
				const sent = await api.sendRelayMessage({
					room: resolvedSelection.room,
					text,
					...(mentions.length > 0 ? { mentions } : {}),
					urgent,
				});
				setText("");
				setUrgent(false);
				setSelectedMentions(new Set());
				const notified = sent.notified?.length ?? 0;
				const unmatched = sent.unmatched ?? [];
				setSendFeedback({
					tone: "ok",
					message:
						(notified > 0 ? `Posted and notified ${plural(notified, "agent")}` : "Posted to the room's history")
						+ (unmatched.length > 0 ? `. Not members: ${unmatched.map((token) => `@${token.replace(/^@/, "")}`).join(", ")}` : ""),
				});
				await Promise.all([
					queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
					queryClient.invalidateQueries({ queryKey: relayRoomKey(resolvedSelection.room) }),
					queryClient.invalidateQueries({ queryKey: RELAY_EVENTS_KEY }),
				]);
			}
		} catch (cause) {
			const refused = cause instanceof ApiError && [400, 403, 404, 409, 429].includes(cause.status);
			setSendFeedback({
				tone: "error",
				message: refused ? reasonMessage(cause.message) : cause instanceof Error ? cause.message : String(cause),
			});
		} finally {
			setSending(false);
		}
	};

	const roomItems = filteredThreads.filter((item): item is RoomThread => item.kind === "room");
	const dmItems = filteredThreads.filter((item): item is DmThread => item.kind === "dm");
	const threadRow = (item: ThreadItem) => (
		<ThreadRow
			key={item.key}
			item={item}
			now={now}
			selected={resolvedKey === item.key}
			onSelect={() =>
				setActiveThread(item.kind === "room" ? { kind: "room", room: item.room.name } : { kind: "dm", sessionId: item.sessionId })
			}
		/>
	);
	// Room members and online sessions, for the member manager.
	const candidates = activeRoom
		? [
				...activeRoom.members.map((m) => ({
					id: m.sessionId,
					label: sessionLabel(m),
					project: m.project,
					device: memberDevice(m),
					state: m.state,
					representative: m.sessionId === activeRoom.representative,
				})),
				...sessions
					.filter((s) => !activeRoom.members.some((m) => m.sessionId === s.id))
					.map((s) => ({ id: s.id, label: sessionLabel(s), project: s.project, device: deviceLabel(s), state: s.state as PeerState, representative: false })),
			]
		: [];

	let header: ReactNode = null;
	let emptyConversation: ReactNode = null;
	if (resolvedSelection?.kind === "room" && activeRoom) {
		header = (
			<div data-imessage-header="" className="border-b border-line px-4 py-3">
				<div className="flex flex-wrap items-start gap-x-3 gap-y-2">
					<div className="min-w-0 flex-1">
						<h3 className="text-[16px] leading-6 font-semibold break-words" data-imessage-active-title="">
							#{activeRoom.name}
						</h3>
						{activeRoom.topic && <p className="text-[13px] text-muted">{activeRoom.topic}</p>}
					</div>
					<div className="flex flex-wrap items-center gap-1.5">
						{confirmingDelete ? (
							<>
								<span className="text-[12.5px]">Delete #{activeRoom.name} and its history?</span>
								<button
									type="button"
									onClick={() => void handleDeleteRoom(activeRoom.name)}
									data-imessage-delete-room=""
									className={cx(BUTTON.danger, "h-7")}
								>
									Delete
								</button>
								<button type="button" onClick={() => setConfirmingDelete(false)} className={cx(BUTTON.quiet, "h-7")}>
									Cancel
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									onClick={() => setManagingMembers((v) => !v)}
									data-imessage-manage-members=""
									aria-expanded={managingMembers}
									className={cx(BUTTON.secondary, "h-7")}
								>
									{managingMembers ? "Done" : "Members"}
								</button>
								<button
									type="button"
									onClick={() => setConfirmingDelete(true)}
									data-imessage-delete-room-ask=""
									className={cx(BUTTON.quiet, "h-7 hover:text-red")}
								>
									Delete room
								</button>
							</>
						)}
					</div>
				</div>
				{activeRoom.members.length === 0 ? (
					<p className="mt-2 text-[12.5px] text-muted" data-imessage-room-members="">
						No members yet. Add them with Members or <code className="code-chip">/relay join {activeRoom.name}</code>.
					</p>
				) : (
					<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]" data-imessage-room-members="">
						{activeRoom.members.map((m) => (
							<li key={m.sessionId} className="flex min-w-0 items-center gap-1.5" title={`${m.sessionId} · ${STATE_WORD[m.state]}`}>
								<StateDot state={m.state} />
								<span className="max-w-[28ch] truncate font-medium">{sessionLabel(m)}</span>
								{m.sessionId === activeRoom.representative && <RepBadge />}
								{m.project && <span className="text-muted">{m.project}</span>}
								<span className="sr-only">{STATE_WORD[m.state]}</span>
							</li>
						))}
					</ul>
				)}
				{managingMembers && (
					<div className="mt-3 border-t border-line pt-2" data-imessage-member-drawer="">
						{candidates.length === 0 ? (
							<p className="text-[12.5px] text-muted">No sessions are online to add right now.</p>
						) : (
							<ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
								{candidates.map((c) => {
									const inRoom = activeRoom.members.some((m) => m.sessionId === c.id);
									return (
										<li key={c.id} className="flex items-center gap-2 border-b border-line py-1.5 text-[12.5px]">
											<StateDot state={c.state} />
											<div className="min-w-0 flex-1">
												<div className="flex min-w-0 items-center gap-1.5">
													<span className="truncate font-medium">{c.label}</span>
													{c.representative && <RepBadge />}
												</div>
												<div className="truncate text-[11.5px] text-muted">
													{[c.project, c.device].filter(Boolean).join(" · ")}
												</div>
											</div>
											<button
												type="button"
												disabled={memberBusyId === c.id}
												onClick={() => void handleToggleRoomMember(activeRoom.name, c.id, inRoom)}
												data-imessage-toggle-member={c.id}
												className={cx(inRoom ? BUTTON.quiet : BUTTON.secondary, "h-7 shrink-0", inRoom && "hover:text-red")}
											>
												{inRoom ? "Remove" : "Add"}
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
				)}
			</div>
		);
		emptyConversation = (
			<div className="mx-auto max-w-[52ch] py-12 text-center text-[13px] text-muted">
				<p className="text-[14px] font-medium text-ink">Nothing posted in #{activeRoom.name} yet</p>
				<p className="mt-1">
					Choose who to notify below to wake those agents. Posts that notify no one stay in the room's history, where
					members read them with <code className="code-chip">relay_room</code>.
				</p>
			</div>
		);
	} else if (resolvedSelection?.kind === "dm" && activeDm) {
		header = (
			<div data-imessage-header="" className="border-b border-line px-4 py-3">
				<h3 className="flex min-w-0 items-center gap-2 text-[16px] leading-6 font-semibold" data-imessage-active-title="">
					{activeDm.recorded ? (
						<Link
							to={`/s/${encodeURIComponent(activeDm.sessionId)}`}
							className="min-w-0 truncate underline decoration-transparent underline-offset-[3px] hover:decoration-ink"
						>
							{activeDm.label}
						</Link>
					) : (
						<span className="min-w-0 truncate">{activeDm.label}</span>
					)}
				</h3>
				<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
					<span className="flex items-center gap-1.5 text-ink">
						<StateDot state={activeDm.state} />
						{STATE_WORD[activeDm.state]}
					</span>
					<span aria-hidden="true">·</span>
					<span className="mono !text-[11.5px]" title={activeDm.sessionId}>
						{shortId(activeDm.sessionId)}
					</span>
					{activeDm.project !== "—" && (
						<>
							<span aria-hidden="true">·</span>
							<span>{activeDm.project}</span>
						</>
					)}
					{activeDm.device && (
						<>
							<span aria-hidden="true">·</span>
							<span>{activeDm.device}</span>
						</>
					)}
					{activeDm.model && (
						<>
							<span aria-hidden="true">·</span>
							<span className="inline-flex items-center gap-1">
								<span className="mono !text-[11.5px]">{activeDm.model}</span>
								<ModelMark model={activeDm.model} size={11} />
							</span>
						</>
					)}
				</div>
			</div>
		);
		emptyConversation = (
			<div className="mx-auto max-w-[52ch] py-12 text-center text-[13px] text-muted">
				<p className="text-[14px] font-medium text-ink">No messages with {activeDm.label} yet</p>
				<p className="mt-1">
					What you send starts a turn in this session. Messages it exchanges with other sessions show up here too.
				</p>
			</div>
		);
	}

	const mentionHint = selectedMentions.has("all")
		? "Wakes every member"
		: selectedMentions.size > 0
			? `Wakes ${plural(selectedMentions.size, "agent")}`
			: "No one selected: the post stays in the room's history";

	return (
		<section aria-label="Messages and chatrooms" data-imessage="" className="mt-6 overflow-hidden rounded-sm border border-line border-t-ink">
			<div
				className={cx(
					"grid grid-cols-1 md:h-[min(80vh,820px)] md:grid-cols-[248px_minmax(0,1fr)]",
					readerMessage && "xl:grid-cols-[248px_minmax(0,1fr)_minmax(0,460px)]",
				)}
			>
				<aside className="flex min-h-0 flex-col border-b border-line bg-sidebar max-md:max-h-80 md:border-r md:border-b-0">
					<div className="flex items-center gap-1.5 border-b border-line p-2">
						<div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-sm border border-line bg-page px-2 text-muted focus-within:border-ink">
							<Icon name="search" size={13} className="shrink-0" />
							<input
								type="search"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search"
								aria-label="Search conversations by agent, project, or room"
								className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
							/>
						</div>
						<button
							type="button"
							onClick={() => {
								setCreatingRoom((v) => !v);
								setRoomFormError(null);
							}}
							data-imessage-new-room=""
							aria-expanded={creatingRoom}
							title="New room"
							className={cx(BUTTON.secondary, "h-8 shrink-0 px-2")}
						>
							<Icon name="plus" size={14} />
							Room
						</button>
					</div>

					{creatingRoom && (
						<form
							className="border-b border-line bg-page p-3"
							data-imessage-room-form=""
							onSubmit={(event) => {
								event.preventDefault();
								void handleCreateRoom();
							}}
						>
							<div className="text-[13px] font-semibold">New room</div>
							<p className="mt-0.5 text-[12px] text-muted">
								Sessions join here or with <code className="code-chip">/relay join</code>.
							</p>
							<label htmlFor={roomNameId} className="mt-2 block text-[12px] font-medium text-muted">
								Room name
							</label>
							<input
								id={roomNameId}
								type="text"
								value={newRoomName}
								onChange={(e) => setNewRoomName(e.target.value)}
								placeholder="auth-sync"
								className={FIELD}
							/>
							<label htmlFor={roomTopicId} className="mt-2 block text-[12px] font-medium text-muted">
								Topic (optional)
							</label>
							<input
								id={roomTopicId}
								type="text"
								value={newRoomTopic}
								onChange={(e) => setNewRoomTopic(e.target.value)}
								placeholder="What are these agents coordinating?"
								className={FIELD}
							/>
							{sessions.length > 0 && (
								<fieldset className="mt-2">
									<legend className="text-[12px] font-medium text-muted">Members</legend>
									<ul className="mt-0.5 max-h-32 overflow-y-auto rounded-sm border border-line">
										{sessions.map((s) => (
											<li key={s.id}>
												<label className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12.5px] hover:bg-hover">
													<input
														type="checkbox"
														checked={newRoomMembers.has(s.id)}
														onChange={() =>
															setNewRoomMembers((prev) => {
																const next = new Set(prev);
																if (!next.delete(s.id)) next.add(s.id);
																return next;
															})
														}
														className="accent-ink"
													/>
													<span className="min-w-0 truncate font-medium">{sessionLabel(s)}</span>
													<span className="ml-auto shrink-0 text-[11.5px] text-muted">{s.project || "—"}</span>
												</label>
											</li>
										))}
									</ul>
								</fieldset>
							)}
							{roomFormError && <p className="mt-1.5 text-[12px] text-red">{roomFormError}</p>}
							<div className="mt-2.5 flex justify-end gap-1.5">
								<button type="button" onClick={() => setCreatingRoom(false)} className={cx(BUTTON.quiet, "h-7")}>
									Cancel
								</button>
								<button
									type="submit"
									disabled={savingRoom || !newRoomName.trim()}
									data-imessage-create-room=""
									className={cx(BUTTON.primary, "h-7")}
								>
									{savingRoom ? "Creating…" : "Create room"}
								</button>
							</div>
						</form>
					)}

					<nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto pb-2" data-imessage-threads="">
						{filteredThreads.length === 0 ? (
							<p className="px-4 py-8 text-center text-[12.5px] text-muted">
								{threads.length === 0
									? "No conversations yet. Sessions appear here while they are online; create a room to bring several together."
									: `Nothing matches “${search.trim()}”.`}
							</p>
						) : (
							<>
								{roomItems.length > 0 && (
									<ThreadGroup title="Rooms" count={roomItems.length}>
										{roomItems.map(threadRow)}
									</ThreadGroup>
								)}
								{dmItems.length > 0 && (
									<ThreadGroup title="Direct" count={dmItems.length}>
										{dmItems.map(threadRow)}
									</ThreadGroup>
								)}
							</>
						)}
					</nav>
				</aside>

				<div className="flex min-h-0 min-w-0 flex-col max-md:h-[80vh]">
					{!resolvedSelection ? (
						<div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
							<Icon name="message" size={22} className="text-muted" />
							<p className="mt-3 text-[14px] font-medium">Nothing to show yet</p>
							<p className="mt-1 max-w-[46ch] text-[13px] text-muted">
								Message a session that is online, or create a room to coordinate agents across repositories.
							</p>
						</div>
					) : (
						<>
							{header}
							<div
								ref={streamRef}
								data-imessage-stream=""
								onScroll={(event) => {
									const node = event.currentTarget;
									stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
								}}
								className="min-h-0 flex-1 overflow-y-auto"
							>
								{messages.length === 0 ? (
									emptyConversation
								) : (
									<ol aria-label="Messages">
										{messages.map((message) => (
											<MessageRecord
												key={message.id}
												message={message}
												now={now}
												readerMode={readerMode}
												selected={readerMessage?.id === message.id}
												expanded={expanded.has(message.id)}
												onRead={onRead}
											/>
										))}
									</ol>
								)}
							</div>

							<div className="border-t border-line px-4 py-3">
								{resolvedSelection.kind === "room" && activeRoom && (
									<div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px]" data-imessage-mention-bar="">
										<span id={notifyId} className="mr-0.5 font-medium text-muted">
											Notify
										</span>
										<div role="group" aria-labelledby={notifyId} className="flex flex-wrap gap-1.5">
											{[{ token: "all", label: "Everyone", title: "Every member of the room", representative: false }, ...activeRoom.members.map((m) => ({
												token: m.sessionId,
												label: sessionLabel(m),
												title: [m.project, memberDevice(m)].filter(Boolean).join(" · "),
												representative: m.sessionId === activeRoom.representative,
											}))].map(({ token, label, title, representative }) => {
												const active = selectedMentions.has("all") || selectedMentions.has(token);
												return (
													<button
														key={token}
														type="button"
														onClick={() => toggleMention(token)}
														data-imessage-mention={token}
														aria-pressed={active}
														title={title}
														className={cx(
															"inline-flex h-6 max-w-[22ch] items-center gap-1 rounded-sm border px-2 font-medium transition-colors duration-150",
															active ? "border-ink bg-ink text-page" : "border-line text-ink hover:border-ink",
														)}
													>
														<span className="truncate">{label}</span>
														{representative && <RepBadge />}
													</button>
												);
											})}
										</div>
										<span className="ml-auto text-muted">{mentionHint}</span>
									</div>
								)}

								<div className="rounded-sm border border-line focus-within:border-ink">
									<label htmlFor={composerId} className="sr-only">
										Message
									</label>
									<textarea
										ref={inputRef}
										id={composerId}
										rows={2}
										value={text}
										onChange={(e) => setText(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && !e.shiftKey) {
												if (e.nativeEvent.isComposing) return;
												e.preventDefault();
												void handleSend();
											}
										}}
										placeholder={
											resolvedSelection.kind === "room"
												? `Message #${resolvedSelection.room}`
												: `Message ${activeDm?.label ?? "this session"}`
										}
										data-imessage-input=""
										className="block max-h-60 w-full resize-none bg-transparent px-3 py-2 text-[13.5px] leading-5 outline-none placeholder:text-muted"
									/>
									<div className="flex items-center gap-2 px-2 pb-1.5">
										<button
											type="button"
											onClick={() => setUrgent((v) => !v)}
											aria-pressed={urgent}
											data-imessage-urgent=""
											title="Steer into a busy session's current turn instead of waiting for it to finish"
											className={cx(
												BUTTON.quiet,
												"h-7 px-2",
												urgent && "bg-red-soft text-red hover:bg-red-soft hover:text-red",
											)}
										>
											<Icon name="alert" size={14} />
											Urgent
										</button>
										<span className="text-[11.5px] text-muted max-sm:hidden">Enter sends · Shift+Enter adds a line</span>
										{bytes > MAX_TEXT_BYTES / 2 && (
											<span className={cx("tnum ml-auto text-[11.5px]", tooLong ? "text-red" : "text-muted")}>
												{formatBytes(bytes)} of 32 KB
											</span>
										)}
										<button
											type="button"
											onClick={() => void handleSend()}
											disabled={!canSend}
											data-imessage-send=""
											className={cx(BUTTON.primary, "h-7", bytes <= MAX_TEXT_BYTES / 2 && "ml-auto")}
										>
											{sending ? "Sending…" : "Send"}
										</button>
									</div>
								</div>
								{tooLong && <p className="mt-1.5 text-[12px] text-red">The message is over the 32 KB limit. Shorten it to send.</p>}
								{sendFeedback && (
									<p
										data-imessage-feedback={sendFeedback.tone}
										role={sendFeedback.tone === "error" ? "alert" : "status"}
										className={cx("mt-1.5 text-[12px]", sendFeedback.tone === "error" ? "text-red" : "text-muted")}
									>
										{sendFeedback.message}
									</p>
								)}
							</div>
						</>
					)}
				</div>

				{readerMessage && <Reader message={readerMessage} onClose={() => setReaderId(null)} />}
			</div>
		</section>
	);
}
