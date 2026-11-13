import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
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
	senderLabel,
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
	RelayRoomMember,
	RelayRoomMessage,
	RelaySender,
	RelayStatus,
	RelayTarget,
} from "../lib/types";
import { Icon } from "./icons";
import { useSigningOut } from "./Layout";
import { Markdown } from "./Markdown";
import { ModelMark } from "./ModelName";
import { RoomBoard } from "./RoomBoard";
import { BUTTON, cx, Dialog, Pill, Segmented } from "./ui";

export type ThreadSelection =
	| { kind: "dm"; sessionId: string }
	| { kind: "room"; room: string };

type PeerState = "idle" | "busy" | "offline";
type ThreadFilter = "all" | "rooms" | "direct";

interface DmThread {
	kind: "dm";
	key: string;
	sessionId: string;
	label: string;
	named: boolean;
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

interface MentionCandidate {
	token: string;
	label: string;
	detail: string;
	representative: boolean;
}

const ROOM_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** From this width a long message opens in a reader beside the conversation; below it, Show all expands in place. */
const READER_QUERY = "(min-width: 1280px)";
/** How close to the bottom the conversation must be for a new message to keep it pinned there. */
const STICK_PX = 80;

const STATE_WORD: Record<PeerState, string> = { busy: "Busy", idle: "Idle", offline: "Offline" };

const FIELD =
	"mt-1 block w-full rounded-sm border border-line bg-page px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-ink";

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

function mentionTokenOf(member: RelayRoomMember): string {
	if (member.name && /^[A-Za-z0-9._-]+$/.test(member.name)) return member.name;
	return member.sessionId;
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

/** Marks a room's representative; outlined in the text colour, or softened on inverted surfaces. */
function RepBadge({ inverted = false }: { inverted?: boolean }) {
	return (
		<span
			title="Representative"
			data-imessage-representative=""
			className={cx(
				"inline-flex h-4 shrink-0 items-center rounded-sm border px-1 text-[11px] leading-none font-medium",
				inverted ? "border-page/60 text-page" : "border-current",
			)}
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
	if (item.kind === "room") {
		const total = item.room.members.length;
		const onlineCount = item.room.members.filter((m) => m.online || m.state !== "offline").length;
		const anyBusy = item.room.members.some((m) => m.state === "busy");
		const hasRep = Boolean(item.room.representative && item.room.members.some((m) => m.sessionId === item.room.representative));
		const repos = [...new Set(item.room.members.map((m) => m.project).filter(Boolean))];
		const statusText = total === 0 ? "0 members" : `${onlineCount}/${total} online`;
		const meta = [statusText, ...repos].join(" · ");
		return (
			<li className="border-b border-line last:border-b-0">
				<button
					type="button"
					onClick={onSelect}
					data-imessage-thread={item.key}
					aria-current={selected ? "true" : undefined}
					className={cx(
						"flex w-full flex-col gap-0.5 px-3.5 py-2.5 text-left",
						selected ? "bg-ink text-page" : "text-ink hover:bg-hover",
					)}
				>
					<span className="flex min-w-0 items-center gap-1.5">
						{anyBusy && <StateDot state="busy" />}
						<span className="mono min-w-0 flex-1 truncate !text-[14px] leading-5 font-semibold">#{item.room.name}</span>
						{hasRep && <RepBadge inverted={selected} />}
						{item.lastAt > 0 && (
							<span className={cx("tnum shrink-0 text-[12px]", quiet)}>
								{formatRelative(new Date(item.lastAt).toISOString(), now)}
							</span>
						)}
					</span>
					<span className={cx("tnum truncate text-[12.5px]", quiet)}>{meta}</span>
					<span className={cx("truncate text-[12.5px]", selected ? "text-page/90" : "text-ink/80")}>{item.preview}</span>
				</button>
			</li>
		);
	}

	const meta = [item.project !== "—" ? item.project : "", item.device].filter(Boolean).join(" · ") || "—";
	return (
		<li className="border-b border-line last:border-b-0">
			<button
				type="button"
				onClick={onSelect}
				data-imessage-thread={item.key}
				aria-current={selected ? "true" : undefined}
				className={cx(
					"flex w-full flex-col gap-0.5 px-3.5 py-2.5 text-left",
					selected ? "bg-ink text-page" : "text-ink hover:bg-hover",
				)}
			>
				<span className="flex min-w-0 items-center gap-2">
					<StateDot state={item.state} />
					<span className={cx("min-w-0 flex-1 truncate text-[14px] leading-5 font-semibold", !item.named && "mono")}>
						{item.label}
					</span>
					{item.lastAt > 0 && (
						<span className={cx("tnum shrink-0 text-[12px]", quiet)}>
							{formatRelative(new Date(item.lastAt).toISOString(), now)}
						</span>
					)}
				</span>
				<span className={cx("truncate text-[12.5px]", quiet)}>
					<span className="sr-only">{STATE_WORD[item.state]} · </span>
					{meta}
				</span>
				<span className={cx("truncate text-[12.5px]", selected ? "text-page/90" : "text-ink/80")}>{item.preview}</span>
			</button>
		</li>
	);
}

function MessageRecord({
	message,
	parentMessage,
	canLinkSender,
	canLinkRecipient,
	now,
	readerMode,
	selected,
	highlighted,
	expanded,
	onRead,
	onInspect,
	onReply,
	onJumpToMessage,
}: {
	message: ChatMessage;
	parentMessage?: ChatMessage;
	canLinkSender: boolean;
	canLinkRecipient: boolean;
	now: number;
	/** Long messages open in the reader on wide screens; otherwise Show all expands in place. */
	readerMode: boolean;
	selected: boolean;
	highlighted: boolean;
	expanded: boolean;
	onRead: (id: string) => void;
	onInspect: (id: string) => void;
	onReply: (message: ChatMessage) => void;
	onJumpToMessage: (id: string) => void;
}) {
	const bodyId = useId();
	const readLabelId = useId();
	const [copied, setCopied] = useState(false);
	const shape = useMemo(() => messageShape(message.text), [message.text]);
	const whole = !shape.long || (!readerMode && expanded);
	const where = senderWhere(message.from);
	const bareSender = message.from.kind === "session" && !message.from.name && !message.from.title;
	const bareRecipient = Boolean(message.to && !message.to.name && !message.to.title);
	const readLabel = readerMode ? (selected ? "Close reader" : "Read in full") : expanded ? "Show less" : "Show all";

	const handleCopy = () => {
		void copyText(message.text).then((ok) => {
			if (!ok) return;
			setCopied(true);
			setTimeout(() => setCopied(false), 1_600);
		});
	};

	return (
		<li
			data-imessage-bubble={message.id}
			data-selected={selected ? "" : undefined}
			data-highlighted={highlighted ? "" : undefined}
			className={cx(
				"min-w-0 border-b border-line px-5 py-4 last:border-b-0 max-sm:px-4",
				selected && "bg-accent-soft",
				highlighted && "bg-hover ring-1 ring-inset ring-ink",
			)}
		>
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] leading-5">
				<span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-line bg-soft text-ink">
					<Icon name={message.from.kind === "web" ? "user" : "terminal"} size={13} />
				</span>
				{message.from.kind === "session" && canLinkSender ? (
					<Link
						to={`/s/${encodeURIComponent(message.from.sessionId)}`}
						data-sender=""
						title={message.from.sessionId}
						className={cx(
							"text-[14px] font-bold text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink",
							bareSender && "mono",
						)}
					>
						{senderName(message.from)}
					</Link>
				) : (
					<span
						className={cx("text-[14px] font-bold text-ink", bareSender && "mono")}
						data-sender=""
						title={message.from.kind === "session" ? message.from.sessionId : undefined}
					>
						{senderName(message.from)}
					</span>
				)}
				{where && <span className="text-[12.5px] text-muted">{where}</span>}
				{message.to && (
					<>
						<span aria-hidden="true" className="text-muted">
							→
						</span>
						<span className="sr-only">to</span>
						{canLinkRecipient ? (
							<Link
								to={`/s/${encodeURIComponent(message.to.sessionId)}`}
								title={message.to.sessionId}
								className={cx(
									"text-[13.5px] font-semibold text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink",
									bareRecipient && "mono",
								)}
							>
								{sessionLabel(message.to)}
							</Link>
						) : (
							<span className={cx("text-[13.5px] font-semibold text-ink", bareRecipient && "mono")} title={message.to.sessionId}>
								{sessionLabel(message.to)}
							</span>
						)}
					</>
				)}
				{message.urgent && <Pill tone="red">Urgent</Pill>}
				<span className="ml-auto flex shrink-0 items-center gap-2.5">
					<time className="tnum text-[12.5px] text-muted" dateTime={message.at} title={formatDateTime(message.at)}>
						{formatRelative(message.at, now)}
					</time>
					<span className="inline-flex items-stretch divide-x divide-line overflow-hidden rounded-sm border border-line bg-page text-[12.5px]">
						<button
							type="button"
							onClick={() => onReply(message)}
							data-imessage-reply={message.id}
							title="Reply to this message"
							className="inline-flex items-center gap-1 px-2 py-1 font-medium text-muted hover:bg-hover hover:text-ink focus-visible:outline-offset-[-2px]"
						>
							<Icon name="reply" size={12} />
							<span>Reply</span>
						</button>
						<button
							type="button"
							onClick={handleCopy}
							aria-label={copied ? "Copied message" : "Copy message"}
							title={copied ? "Copied" : "Copy message"}
							className="inline-flex items-center justify-center px-2 py-1 text-muted hover:bg-hover hover:text-ink focus-visible:outline-offset-[-2px]"
						>
							<Icon name={copied ? "check" : "copy"} size={12} />
						</button>
						{readerMode && (
							<button
								type="button"
								onClick={() => onInspect(message.id)}
								data-imessage-inspect={message.id}
								aria-label={selected ? "Close inspector" : "Inspect message"}
								title={selected ? "Close inspector" : "Open in message reader"}
								className={cx(
									"inline-flex items-center justify-center px-2 py-1 focus-visible:outline-offset-[-2px]",
									selected ? "bg-ink text-page hover:bg-ink/85 hover:text-page" : "text-muted hover:bg-hover hover:text-ink",
								)}
							>
								<Icon name="sidebar" size={12} />
							</button>
						)}
					</span>
				</span>
			</div>

			{message.replyTo && (
				<div className="mt-2" data-imessage-reply-context={message.replyTo}>
					{parentMessage ? (
						<button
							type="button"
							onClick={() => onJumpToMessage(parentMessage.id)}
							className="flex w-full items-center gap-2 rounded-sm border border-line border-l border-l-ink bg-soft px-3 py-1.5 text-left text-[12.5px] text-muted hover:border-ink hover:bg-hover hover:text-ink"
						>
							<Icon name="reply" size={13} className="shrink-0 text-ink" />
							<span className="sr-only">replying to </span>
							<span className="shrink-0 font-bold text-ink">{senderName(parentMessage.from)}</span>
							<span className="mono shrink-0 !text-[11.5px] text-muted">{shortId(message.replyTo)}</span>
							<span className="min-w-0 flex-1 truncate">{plainLine(parentMessage.text)}</span>
						</button>
					) : (
						<div className="flex w-full items-center gap-2 rounded-sm border border-line border-l border-l-ink bg-soft px-3 py-1.5 text-[12.5px] text-muted">
							<Icon name="reply" size={13} className="shrink-0 text-ink" />
							<span>replying to</span>
							<span className="mono shrink-0 !text-[11.5px]">{shortId(message.replyTo)}</span>
						</div>
					)}
				</div>
			)}

			<div
				id={bodyId}
				data-message-body=""
				className={cx(
					"mt-2.5 max-w-[78ch] min-w-0 text-[14.5px] leading-[1.6]",
					!whole && "max-h-[12.5rem] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_64%,transparent)]",
				)}
			>
				<Markdown text={whole ? message.text : previewSource(message.text)} highlightMentions />
			</div>

			{shape.long && (
				<button
					type="button"
					onClick={() => onRead(message.id)}
					data-imessage-read={message.id}
					aria-labelledby={readLabelId}
					{...(readerMode
						? { "aria-pressed": selected }
						: { "aria-expanded": expanded, "aria-controls": bodyId })}
					className={cx(
						"mt-2.5 flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 rounded-sm border border-line bg-soft px-3 py-1.5 text-left text-[12.5px] text-muted hover:border-ink hover:bg-hover",
						!readerMode && expanded && "sticky bottom-2 z-10 border-ink bg-page",
					)}
				>
					<span id={readLabelId} className="font-bold text-ink">
						{readLabel}
					</span>
					<span className="tnum">
						{plural(shape.lines, "line")} · {formatBytes(shape.bytes)}
					</span>
					{shape.sections.length > 0 && (
						<span className="max-w-full min-w-0 truncate" title={shape.sections.join(" · ")}>
							{shape.sections.join(" · ")}
						</span>
					)}
				</button>
			)}

			{(message.notified || message.status) && (
				<div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-2 text-[12px] text-muted">
					{message.status && <DeliveryStatus message={message} />}
					{message.notified && (
						<span data-notified="">
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

function Reader({
	message,
	onClose,
	onJumpToMessage,
	hasParentInStream,
}: {
	message: ChatMessage;
	onClose: () => void;
	onJumpToMessage: (id: string) => void;
	hasParentInStream: boolean;
}) {
	const [view, setView] = useState<"rendered" | "raw">("rendered");
	const [copied, setCopied] = useState<boolean | null>(null);
	const [headings, setHeadings] = useState<string[]>([]);
	const bodyRef = useRef<HTMLDivElement>(null);
	const shape = useMemo(() => messageShape(message.text), [message.text]);

	useEffect(() => {
		setCopied(null);
		bodyRef.current?.scrollTo({ top: 0 });
	}, [message.id]);

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
			className="flex h-full min-h-0 flex-col bg-page max-xl:fixed max-xl:inset-y-12 max-xl:right-0 max-xl:z-30 max-xl:w-full max-xl:max-w-[420px] max-xl:border-l max-xl:border-ink xl:w-[420px] xl:shrink-0 xl:border-l xl:border-ink"
		>
			<div className="flex items-start gap-2 border-b border-ink px-4 py-2.5">
				<div className="min-w-0 flex-1">
					<div className="text-[14px] leading-5 font-semibold break-words">
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
				<button
					type="button"
					onClick={onClose}
					aria-label="Close reader"
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line bg-page text-muted hover:border-ink hover:bg-hover hover:text-ink"
				>
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
					className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-sm border border-ink bg-page px-2.5 text-[12.5px] font-medium whitespace-nowrap text-ink hover:bg-hover"
				>
					<Icon name={copied ? "check" : "copy"} size={14} />
					{copied ? "Copied" : copied === false ? "Copy failed" : "Copy text"}
				</button>
			</div>
			{headings.length > 1 && (
				<nav aria-label="Sections" className="max-h-28 overflow-y-auto border-b border-line bg-soft px-4 py-2">
					<ol className="flex flex-wrap gap-1.5">
						{headings.map((heading, index) => (
							<li key={index}>
								<button
									type="button"
									onClick={() => jump(index)}
									className="rounded-sm border border-line bg-page px-2 py-0.5 text-[12px] font-medium text-ink hover:border-ink hover:bg-hover"
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
				className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 py-3 text-[14.5px] leading-[1.6]"
			>
				{view === "rendered" ? <Markdown text={message.text} highlightMentions /> : <pre className="code-block wrap">{message.text}</pre>}
			</div>
			<dl className="divide-y divide-line border-t border-ink bg-soft/50 text-[12.5px]">
				<div className="flex items-baseline gap-3 px-4 py-2">
					<dt className="w-24 shrink-0 text-muted">From</dt>
					<dd className="min-w-0 flex-1 truncate text-ink">{senderLabel(message.from)}</dd>
				</div>
				<div className="flex items-baseline gap-3 px-4 py-2">
					<dt className="w-24 shrink-0 text-muted">Sent</dt>
					<dd className="tnum min-w-0 flex-1 text-ink">{formatDateTime(message.at)}</dd>
				</div>
				{message.status && (
					<div className="flex items-baseline gap-3 px-4 py-2">
						<dt className="w-24 shrink-0 text-muted">Status</dt>
						<dd className="min-w-0 flex-1 text-ink">
							{message.status === "rejected" ? reasonMessage(message.reason ?? "") : message.status}
							{message.deliveredAt && message.status === "delivered" && ` (${formatDateTime(message.deliveredAt)})`}
						</dd>
					</div>
				)}
				{message.notified && (
					<div className="flex items-baseline gap-3 px-4 py-2">
						<dt className="w-24 shrink-0 text-muted">Woke</dt>
						<dd className="min-w-0 flex-1 break-words text-ink">{message.notified.length > 0 ? names(message.notified) : "No one"}</dd>
					</div>
				)}
				{message.replyTo && (
					<div className="flex items-baseline gap-3 px-4 py-2">
						<dt className="w-24 shrink-0 text-muted">Replying to</dt>
						<dd className="min-w-0 flex-1 truncate text-ink">
							{hasParentInStream ? (
								<button
									type="button"
									onClick={() => onJumpToMessage(message.replyTo!)}
									className="mono !text-[12px] text-ink underline decoration-line underline-offset-[3px] hover:decoration-ink"
								>
									{message.replyTo}
								</button>
							) : (
								<span className="mono !text-[12px]">{message.replyTo}</span>
							)}
						</dd>
					</div>
				)}
				<div className="flex items-baseline gap-3 px-4 py-2">
					<dt className="w-24 shrink-0 text-muted">Hops</dt>
					<dd className="tnum min-w-0 flex-1 text-ink">{message.hops}</dd>
				</div>
				<div className="flex items-baseline gap-3 px-4 py-2">
					<dt className="w-24 shrink-0 text-muted">Id</dt>
					<dd className="mono min-w-0 flex-1 truncate !text-[12px] text-ink">{message.id}</dd>
				</div>
			</dl>
		</aside>
	);
}

function RoomMembersRail({
	room,
	onlineSessions,
	memberBusyId,
	onToggleMember,
	onToggleRepresentative,
	onClose,
}: {
	room: RelayRoom;
	onlineSessions: readonly OnlineSession[];
	memberBusyId: string | null;
	onToggleMember: (roomName: string, sessionId: string, isMember: boolean) => Promise<void>;
	onToggleRepresentative: (roomName: string, sessionId: string, isRepresentative: boolean) => Promise<void>;
	onClose: () => void;
}) {
	const api = useApi();
	const { signingOut } = useSigningOut();
	const [filter, setFilter] = useState("");
	const [customSessionId, setCustomSessionId] = useState("");
	const [addError, setAddError] = useState<string | null>(null);

	const recentSessionsQuery = useQuery({
		queryKey: ["sessions", "relay-picker"],
		queryFn: () => api.sessions({}, undefined, 30),
		enabled: !signingOut,
	});

	const onlineById = useMemo(() => new Map(onlineSessions.map((s) => [s.id, s])), [onlineSessions]);
	const memberIds = useMemo(() => new Set(room.members.map((m) => m.sessionId)), [room.members]);

	const availableToAdd = useMemo(() => {
		const list: { id: string; label: string; named: boolean; project: string; device: string; state: PeerState }[] = [];
		const seen = new Set<string>(memberIds);
		for (const s of onlineSessions) {
			if (seen.has(s.id)) continue;
			seen.add(s.id);
			list.push({
				id: s.id,
				label: sessionLabel(s),
				named: Boolean(s.name || s.title),
				project: s.project || "—",
				device: deviceLabel(s),
				state: s.state,
			});
		}
		for (const rec of recentSessionsQuery.data?.items ?? []) {
			if (seen.has(rec.id)) continue;
			seen.add(rec.id);
			list.push({
				id: rec.id,
				label: sessionLabel(rec),
				named: Boolean(rec.title),
				project: rec.project || "—",
				device: deviceLabel(rec),
				state: "offline",
			});
		}
		const q = filter.trim().toLowerCase();
		if (!q) return list;
		return list.filter(
			(c) =>
				c.label.toLowerCase().includes(q)
				|| c.id.toLowerCase().includes(q)
				|| c.project.toLowerCase().includes(q)
				|| c.device.toLowerCase().includes(q),
		);
	}, [onlineSessions, recentSessionsQuery.data, memberIds, filter]);

	const handleAddById = async () => {
		const sid = customSessionId.trim();
		if (!sid) return;
		setAddError(null);
		try {
			await onToggleMember(room.name, sid, false);
			setCustomSessionId("");
		} catch (cause) {
			setAddError(cause instanceof ApiError ? reasonMessage(cause.message) : cause instanceof Error ? cause.message : String(cause));
		}
	};

	return (
		<aside
			aria-label="Room members"
			data-imessage-member-drawer=""
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
			className="flex h-full min-h-0 flex-col bg-page max-xl:fixed max-xl:inset-y-12 max-xl:right-0 max-xl:z-30 max-xl:w-full max-xl:max-w-[420px] max-xl:border-l max-xl:border-ink xl:w-[420px] xl:shrink-0 xl:border-l xl:border-ink"
		>
			<div className="flex items-center justify-between gap-2 border-b border-ink px-4 py-2.5">
				<div className="flex min-w-0 items-baseline gap-2">
					<h2 className="text-[14px] font-semibold">Members</h2>
					<span className="tnum text-[12px] text-muted">{room.members.length}</span>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close members"
					className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm border border-line bg-page text-muted hover:border-ink hover:bg-hover hover:text-ink"
				>
					<Icon name="close" size={14} className="shrink-0" />
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<section aria-label="Current members">
					{room.members.length === 0 ? (
						<p className="px-4 py-4 text-[12.5px] text-muted" data-imessage-room-members="">
							No members yet. Add a session below or run <code className="code-chip">/relay join {room.name}</code>.
						</p>
					) : (
						<ul data-imessage-room-members="">
							{room.members.map((m) => {
								const isRep = m.sessionId === room.representative;
								const onlineEntry = onlineById.get(m.sessionId);
								const canLink = onlineEntry ? onlineEntry.recorded : true;
								const label = sessionLabel(m);
								const named = Boolean(m.name || m.title);
								const subtitle = [m.project, memberDevice(m)].filter(Boolean).join(" · ");
								return (
									<li
										key={m.sessionId}
										className="flex items-center gap-2.5 border-b border-line px-4 py-2.5 text-[13px] last:border-b-0"
									>
										<StateDot state={m.state} />
										<div className="min-w-0 flex-1">
											<div className="flex min-w-0 items-center gap-1.5">
												{canLink ? (
													<Link
														to={`/s/${encodeURIComponent(m.sessionId)}`}
														className={cx(
															"min-w-0 truncate font-medium underline decoration-line underline-offset-[3px] hover:decoration-ink",
															!named && "mono",
														)}
														title={m.sessionId}
													>
														{label}
													</Link>
												) : (
													<span className={cx("min-w-0 truncate font-medium", !named && "mono")} title={m.sessionId}>
														{label}
													</span>
												)}
												{isRep && <RepBadge />}
												<span className="sr-only">{STATE_WORD[m.state]}</span>
											</div>
											<div className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
												{subtitle && <span className="truncate">{subtitle}</span>}
												<span className="mono shrink-0 !text-[11px]">{shortId(m.sessionId)}</span>
											</div>
										</div>
										<div className="flex shrink-0 items-center gap-1.5">
											<button
												type="button"
												disabled={memberBusyId === m.sessionId}
												onClick={() => void onToggleRepresentative(room.name, m.sessionId, isRep)}
												data-imessage-represent-member={m.sessionId}
												className={cx(
													"rounded-sm border bg-page px-2.5 py-1 text-[12.5px] whitespace-nowrap disabled:cursor-default disabled:opacity-45",
													isRep
														? "border-ink font-semibold text-ink hover:bg-hover"
														: "border-line font-medium text-ink hover:border-ink hover:bg-hover",
												)}
											>
												{isRep ? "Clear rep" : "Make rep"}
											</button>
											<button
												type="button"
												disabled={memberBusyId === m.sessionId}
												onClick={() =>
													void onToggleMember(room.name, m.sessionId, true).catch(() => {})
												}
												data-imessage-toggle-member={m.sessionId}
												className="rounded-sm border border-line bg-page px-2.5 py-1 text-[12.5px] whitespace-nowrap text-muted hover:border-red hover:bg-hover hover:text-red disabled:cursor-default disabled:opacity-45"
											>
												Remove
											</button>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</section>

				<section aria-label="Add member" className="border-t border-ink" data-imessage-add-members="">
					<h3 className="border-b border-line bg-soft px-4 py-2 text-[12px] font-semibold text-ink">Add member</h3>
					<div className="px-4 py-3">
						<div className="flex h-8 items-center gap-1.5 rounded-sm border border-line bg-page px-2 text-muted focus-within:border-ink">
							<Icon name="search" size={13} className="shrink-0" />
							<input
								type="search"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder="Filter online or recorded sessions"
								aria-label="Filter sessions to add"
								className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-muted"
							/>
						</div>

						{availableToAdd.length === 0 ? (
							<p className="pt-3 text-[12px] text-muted">
								{filter.trim() ? `No sessions matching “${filter.trim()}”.` : "No other online or recent sessions to add."}
							</p>
						) : (
							<ul className="mt-2.5 border-t border-line">
								{availableToAdd.map((c) => (
									<li key={c.id} className="flex items-center gap-2 border-b border-line py-2 text-[12.5px] last:border-b-0">
										<StateDot state={c.state} />
										<div className="min-w-0 flex-1">
											<div className={cx("truncate font-medium", !c.named && "mono")}>{c.label}</div>
											<div className="truncate text-[11.5px] text-muted">
												{[c.project !== "—" ? c.project : "", c.device, STATE_WORD[c.state]].filter(Boolean).join(" · ")}
											</div>
										</div>
										<button
											type="button"
											disabled={memberBusyId === c.id}
											onClick={() => void onToggleMember(room.name, c.id, false).catch(() => {})}
											data-imessage-toggle-member={c.id}
											className="shrink-0 rounded-sm border border-ink bg-page px-2.5 py-1 text-[12.5px] font-medium text-ink hover:bg-hover disabled:cursor-default disabled:opacity-45"
										>
											Add
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				</section>

				<section aria-label="Add by session ID" className="border-t border-ink">
					<h3 className="border-b border-line bg-soft px-4 py-2 text-[12px] font-semibold text-ink">Add by session ID</h3>
					<form
						className="px-4 py-3"
						data-imessage-add-by-id=""
						onSubmit={(event) => {
							event.preventDefault();
							void handleAddById();
						}}
					>
						<div className="flex items-center gap-1.5">
							<input
								type="text"
								value={customSessionId}
								onChange={(e) => {
									setCustomSessionId(e.target.value);
									setAddError(null);
								}}
								placeholder="00000000-0000-4000-8000-000000000000"
								aria-label="Session ID to add"
								className="mono h-8 min-w-0 flex-1 rounded-sm border border-line bg-page !text-[12px] px-2 text-ink outline-none placeholder:font-sans placeholder:text-muted focus:border-ink"
							/>
							<button
								type="submit"
								disabled={!customSessionId.trim() || memberBusyId !== null}
								className={cx(BUTTON.secondary, "h-8 shrink-0")}
							>
								Add
							</button>
						</div>
						{addError && (
							<p role="alert" className="mt-1.5 text-[12px] text-red">
								{addError}
							</p>
						)}
					</form>
				</section>
			</div>
		</aside>
	);
}

function ThreadGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
	return (
		<section aria-label={title} className="border-t border-line first:border-t-0">
			<div className="flex items-baseline justify-between border-b border-line bg-soft px-3.5 py-1.5 text-[11.5px] font-bold tracking-[0.05em] text-muted uppercase">
				<span>{title}</span>
				<span className="tnum font-medium">{count}</span>
			</div>
			<ul>{children}</ul>
		</section>
	);
}

export function Messenger({
	sessions,
	events,
	now,
	selectedThread,
	hasUrlSelection = false,
	onSelectThread,
}: {
	sessions: readonly OnlineSession[];
	events: readonly RelayEvent[];
	now: number;
	selectedThread?: ThreadSelection | null;
	hasUrlSelection?: boolean;
	onSelectThread?: (thread: ThreadSelection | null) => void;
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

	const [filter, setFilter] = useState<ThreadFilter>("all");
	const [search, setSearch] = useState("");
	const [internalThread, setInternalThread] = useState<ThreadSelection | null>(null);
	const [mobileView, setMobileView] = useState<"list" | "chat">(hasUrlSelection ? "chat" : "list");

	useEffect(() => {
		if (hasUrlSelection) setMobileView("chat");
	}, [hasUrlSelection, selectedThread]);

	const activeThread = selectedThread !== undefined ? selectedThread : internalThread;
	const selectThread = (next: ThreadSelection | null) => {
		setInternalThread(next);
		if (next) setMobileView("chat");
		onSelectThread?.(next);
	};

	// Resolve deep-linked DM session from recorded sessions if it isn't online or in recent events.
	const requestedDmId = activeThread?.kind === "dm" ? activeThread.sessionId : null;
	const knownDmPeer = useMemo(() => {
		if (!requestedDmId) return false;
		if (sessions.some((s) => s.id === requestedDmId)) return true;
		return events.some(
			(ev) =>
				!ev.room
				&& !ev.to.sessionId.startsWith("#")
				&& (ev.to.sessionId === requestedDmId || (ev.from.kind === "session" && ev.from.sessionId === requestedDmId)),
		);
	}, [requestedDmId, sessions, events]);

	const dmSessionQuery = useQuery({
		queryKey: ["session", "dm", requestedDmId],
		queryFn: () => api.session(requestedDmId!),
		enabled: Boolean(requestedDmId) && !knownDmPeer && !signingOut,
		retry: false,
	});

	// New room dialog
	const [creatingRoom, setCreatingRoom] = useState(false);
	const [newRoomName, setNewRoomName] = useState("");
	const [newRoomTopic, setNewRoomTopic] = useState("");
	const [newRoomFilter, setNewRoomFilter] = useState("");
	const [newRoomMembers, setNewRoomMembers] = useState<ReadonlySet<string>>(() => new Set());
	const [roomFormError, setRoomFormError] = useState<string | null>(null);
	const [savingRoom, setSavingRoom] = useState(false);
	const newRoomNameRef = useRef<HTMLInputElement>(null);

	const recentForNewRoom = useQuery({
		queryKey: ["sessions", "relay-picker"],
		queryFn: () => api.sessions({}, undefined, 30),
		enabled: creatingRoom && !signingOut,
	});

	useEffect(() => {
		if (creatingRoom) newRoomNameRef.current?.focus();
	}, [creatingRoom]);

	// Topic inline editing
	const [editingTopic, setEditingTopic] = useState(false);
	const [draftTopic, setDraftTopic] = useState("");
	const [savingTopic, setSavingTopic] = useState(false);
	const [topicError, setTopicError] = useState<string | null>(null);

	// A room shows its messages or its members' swarm boards.
	const [roomView, setRoomView] = useState<"messages" | "board">("messages");

	// Room management & deletion
	const [managingMembers, setManagingMembers] = useState(false);
	const [memberBusyId, setMemberBusyId] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [deletingRoom, setDeletingRoom] = useState(false);
	const deleteCancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (confirmingDelete) deleteCancelRef.current?.focus();
	}, [confirmingDelete]);

	// Reading & highlighting
	const [readerId, setReaderId] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const [scrolledUp, setScrolledUp] = useState(false);
	const [copiedDmId, setCopiedDmId] = useState(false);

	useEffect(() => {
		if (!readerMode) setReaderId(null);
	}, [readerMode]);

	// Composer
	const [text, setText] = useState("");
	const [cursorPos, setCursorPos] = useState(0);
	const [dismissedMentionAt, setDismissedMentionAt] = useState<number | null>(null);
	const [activeMentionIndex, setActiveMentionIndex] = useState(0);
	const [urgent, setUrgent] = useState(false);
	const [replyTo, setReplyTo] = useState<{ id: string; sender: string; preview: string } | null>(null);
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
				named: Boolean(s.name || s.title),
				device: deviceLabel(s),
				project: s.project || "—",
				model: bareModelOf(s.model),
				state: s.state,
				recorded: s.recorded,
				lastAt: 0,
				preview: "No messages yet",
			});
		}
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
						named: Boolean(meta.name || meta.title),
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
		if (requestedDmId && !dmMap.has(requestedDmId)) {
			const rec = dmSessionQuery.data;
			dmMap.set(requestedDmId, {
				kind: "dm",
				key: `dm:${requestedDmId}`,
				sessionId: requestedDmId,
				label: rec ? sessionLabel(rec) : shortId(requestedDmId),
				named: Boolean(rec?.title),
				device: rec ? deviceLabel(rec) : "",
				project: rec?.project || "—",
				model: rec?.models[0] ? bareModelOf(rec.models[0]) : undefined,
				state: "offline",
				recorded: Boolean(rec),
				lastAt: 0,
				preview: "No messages yet",
			});
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
	}, [sessions, events, rooms, requestedDmId, dmSessionQuery.data]);

	const searchMatchedThreads = useMemo(() => {
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

	const roomMatches = useMemo(() => searchMatchedThreads.filter((item): item is RoomThread => item.kind === "room"), [searchMatchedThreads]);
	const dmMatches = useMemo(() => searchMatchedThreads.filter((item): item is DmThread => item.kind === "dm"), [searchMatchedThreads]);

	const visibleThreads = useMemo(() => {
		if (filter === "rooms") return roomMatches;
		if (filter === "direct") return dmMatches;
		return searchMatchedThreads;
	}, [filter, roomMatches, dmMatches, searchMatchedThreads]);

	const resolvedSelection = useMemo<ThreadSelection | null>(() => {
		if (activeThread) {
			if (activeThread.kind === "room") {
				if (hasUrlSelection || rooms.some((r) => r.name === activeThread.room)) return activeThread;
			} else if (threads.some((t) => t.kind === "dm" && t.sessionId === activeThread.sessionId)) {
				return activeThread;
			}
		}
		const first = visibleThreads[0] ?? threads[0];
		if (!first) return null;
		return first.kind === "room" ? { kind: "room", room: first.room.name } : { kind: "dm", sessionId: first.sessionId };
	}, [activeThread, hasUrlSelection, rooms, threads, visibleThreads]);

	const activeRoomName = resolvedSelection?.kind === "room" ? resolvedSelection.room : null;
	const roomDetailQuery = useQuery({
		queryKey: relayRoomKey(activeRoomName ?? ""),
		queryFn: () => api.relayRoom(activeRoomName!, 150),
		enabled: Boolean(activeRoomName) && !signingOut,
		staleTime: 0,
		refetchInterval: (query) =>
			signingOut || !activeRoomName || isRelayDisabled(query.state.error) || (query.state.error instanceof ApiError && query.state.error.status === 404)
				? false
				: RELAY_POLL_MS,
	});

	const resolvedKey = resolvedSelection
		? resolvedSelection.kind === "room"
			? `room:${resolvedSelection.room}`
			: `dm:${resolvedSelection.sessionId}`
		: "";

	// The thread's own UI state resets in the render that switches threads. As an effect it ran after the switch
	// committed, so a click in between (Edit topic on a room just created) was undone.
	const [stateKey, setStateKey] = useState(resolvedKey);
	if (stateKey !== resolvedKey) {
		setStateKey(resolvedKey);
		setSelectedMentions(new Set());
		setSendFeedback(null);
		setManagingMembers(false);
		setRoomView("messages");
		setConfirmingDelete(false);
		setEditingTopic(false);
		setTopicError(null);
		setReaderId(null);
		setReplyTo(null);
		setExpanded(new Set());
		setHighlightedId(null);
		setScrolledUp(false);
		setCopiedDmId(false);
		setDismissedMentionAt(null);
	}
	useEffect(() => {
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

	const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
	const readerMessage = readerId ? messagesById.get(readerId) : undefined;

	useLayoutEffect(() => {
		const node = streamRef.current;
		if (node && stickToBottom.current) {
			node.scrollTop = node.scrollHeight;
			setScrolledUp(false);
		}
	}, [messages.length, resolvedKey]);

	useLayoutEffect(() => {
		const node = inputRef.current;
		if (!node) return;
		node.style.height = "auto";
		node.style.height = `${Math.min(node.scrollHeight, 240)}px`;
	}, [text]);

	// Inline @mention detection at the cursor inside rooms
	const activeMentionMatch = useMemo(() => {
		if (resolvedSelection?.kind !== "room" || !activeRoom) return null;
		const before = text.slice(0, cursorPos);
		const match = /(?:^|[\s([{"',:;])@([A-Za-z0-9._-]*)$/.exec(before);
		if (!match) return null;
		const query = match[1]!;
		const atIndex = before.length - query.length - 1;
		if (dismissedMentionAt === atIndex) return null;
		return { query, atIndex };
	}, [resolvedSelection, activeRoom, text, cursorPos, dismissedMentionAt]);

	const mentionCandidates = useMemo<MentionCandidate[]>(() => {
		if (!activeMentionMatch || !activeRoom) return [];
		const q = activeMentionMatch.query.toLowerCase();
		const all: MentionCandidate[] = [
			{ token: "all", label: "Everyone", detail: "Wake all room members", representative: false },
			...activeRoom.members.map((m) => ({
				token: mentionTokenOf(m),
				label: sessionLabel(m),
				detail: [m.project, memberDevice(m)].filter(Boolean).join(" · "),
				representative: m.sessionId === activeRoom.representative,
			})),
		];
		if (!q) return all;
		return all.filter(
			(item) =>
				item.token.toLowerCase().includes(q)
				|| item.label.toLowerCase().includes(q)
				|| item.detail.toLowerCase().includes(q),
		);
	}, [activeMentionMatch, activeRoom]);

	useEffect(() => {
		setActiveMentionIndex(0);
	}, [activeMentionMatch?.query, activeMentionMatch?.atIndex]);

	const insertMentionCandidate = (candidate: MentionCandidate) => {
		if (!activeMentionMatch) return;
		const before = text.slice(0, activeMentionMatch.atIndex);
		const after = text.slice(cursorPos);
		const inserted = `@${candidate.token} `;
		const nextText = `${before}${inserted}${after}`;
		const nextPos = before.length + inserted.length;
		setText(nextText);
		setCursorPos(nextPos);
		setDismissedMentionAt(null);
		requestAnimationFrame(() => {
			const node = inputRef.current;
			if (!node) return;
			node.focus();
			node.setSelectionRange(nextPos, nextPos);
		});
	};

	const bytes = utf8Length(text);
	const tooLong = bytes > MAX_TEXT_BYTES;
	const canSend = Boolean(resolvedSelection && (activeRoom || activeDm)) && text.trim() !== "" && !tooLong && !sending;

	const onRead = (id: string) => {
		if (readerMode) {
			setManagingMembers(false);
			setReaderId((current) => (current === id ? null : id));
		} else {
			setExpanded((current) => {
				const next = new Set(current);
				if (!next.delete(id)) next.add(id);
				return next;
			});
		}
	};

	const onInspect = (id: string) => {
		setManagingMembers(false);
		setReaderId((current) => (current === id ? null : id));
	};

	const onReply = (message: ChatMessage) => {
		setReplyTo({
			id: message.id,
			sender: senderName(message.from),
			preview: plainLine(message.text),
		});
		inputRef.current?.focus();
	};

	const jumpToMessage = (id: string) => {
		const target = streamRef.current?.querySelector<HTMLElement>(`[data-imessage-bubble="${CSS.escape(id)}"]`);
		target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
		setHighlightedId(id);
		setTimeout(() => {
			setHighlightedId((current) => (current === id ? null : current));
		}, 1_800);
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

	const newRoomCandidates = useMemo(() => {
		const list: { id: string; label: string; named: boolean; project: string; state: PeerState }[] = [];
		const seen = new Set<string>();
		for (const s of sessions) {
			seen.add(s.id);
			list.push({ id: s.id, label: sessionLabel(s), named: Boolean(s.name || s.title), project: s.project || "—", state: s.state });
		}
		for (const rec of recentForNewRoom.data?.items ?? []) {
			if (seen.has(rec.id)) continue;
			seen.add(rec.id);
			list.push({ id: rec.id, label: sessionLabel(rec), named: Boolean(rec.title), project: rec.project || "—", state: "offline" });
		}
		const q = newRoomFilter.trim().toLowerCase();
		if (!q) return list;
		return list.filter(
			(item) => item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q) || item.project.toLowerCase().includes(q),
		);
	}, [sessions, recentForNewRoom.data, newRoomFilter]);

	const openNewRoomDialog = (prefillName = "") => {
		setNewRoomName(prefillName);
		setNewRoomTopic("");
		setNewRoomFilter("");
		setNewRoomMembers(new Set());
		setRoomFormError(null);
		setCreatingRoom(true);
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
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
				queryClient.invalidateQueries({ queryKey: relayRoomKey(created.room.name) }),
			]);
			setCreatingRoom(false);
			setNewRoomName("");
			setNewRoomTopic("");
			setNewRoomMembers(new Set());
			selectThread({ kind: "room", room: created.room.name });
		} catch (cause) {
			setRoomFormError(cause instanceof ApiError ? reasonMessage(cause.message) : cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSavingRoom(false);
		}
	};

	const handleSaveTopic = async (roomName: string) => {
		setSavingTopic(true);
		setTopicError(null);
		try {
			const trimmed = draftTopic.trim();
			await api.saveRelayRoom({ name: roomName, topic: trimmed || null });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
				queryClient.invalidateQueries({ queryKey: relayRoomKey(roomName) }),
			]);
			setEditingTopic(false);
		} catch (cause) {
			setTopicError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSavingTopic(false);
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

	const handleToggleRepresentative = async (roomName: string, sessionId: string, isRep: boolean) => {
		setMemberBusyId(sessionId);
		try {
			await api.setRelayRoomMember(roomName, { sessionId, action: isRep ? "unrepresent" : "represent" });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
				queryClient.invalidateQueries({ queryKey: relayRoomKey(roomName) }),
			]);
		} finally {
			setMemberBusyId(null);
		}
	};

	const handleDeleteRoom = async (roomName: string) => {
		setDeletingRoom(true);
		try {
			await api.deleteRelayRoom(roomName);
			setConfirmingDelete(false);
			queryClient.removeQueries({ queryKey: relayRoomKey(roomName) });
			await queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY });
			selectThread(null);
		} finally {
			setDeletingRoom(false);
		}
	};

	const handleSend = async () => {
		if (!canSend || !resolvedSelection) return;
		setSending(true);
		setSendFeedback(null);
		stickToBottom.current = true;
		try {
			if (resolvedSelection.kind === "dm") {
				const sent = await api.sendRelayMessage({
					to: resolvedSelection.sessionId,
					text,
					urgent,
					...(replyTo ? { replyTo: replyTo.id } : {}),
				});
				setText("");
				setCursorPos(0);
				setUrgent(false);
				setReplyTo(null);
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
					...(replyTo ? { replyTo: replyTo.id } : {}),
				});
				setText("");
				setCursorPos(0);
				setUrgent(false);
				setReplyTo(null);
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

	const onComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
		if (e.nativeEvent.isComposing) return;
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			void handleSend();
			return;
		}
		if (activeMentionMatch && mentionCandidates.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveMentionIndex((idx) => (idx + 1) % mentionCandidates.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveMentionIndex((idx) => (idx - 1 + mentionCandidates.length) % mentionCandidates.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const chosen = mentionCandidates[activeMentionIndex] ?? mentionCandidates[0];
				if (chosen) insertMentionCandidate(chosen);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setDismissedMentionAt(activeMentionMatch.atIndex);
				return;
			}
		}
		if (e.key === "Escape" && replyTo) {
			e.preventDefault();
			setReplyTo(null);
		}
	};

	const renderThreadRow = (item: ThreadItem) => (
		<ThreadRow
			key={item.key}
			item={item}
			now={now}
			selected={resolvedKey === item.key}
			onSelect={() =>
				selectThread(item.kind === "room" ? { kind: "room", room: item.room.name } : { kind: "dm", sessionId: item.sessionId })
			}
		/>
	);

	const onlineById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
	const canLinkSession = (sessionId: string): boolean => {
		const online = onlineById.get(sessionId);
		if (online) return online.recorded;
		if (dmSessionQuery.data?.id === sessionId) return true;
		if (activeRoom?.members.some((m) => m.sessionId === sessionId)) return true;
		return false;
	};

	const inspectorOpen = Boolean((managingMembers && activeRoom) || readerMessage);
	const closeInspector = () => {
		setManagingMembers(false);
		setReaderId(null);
	};

	let header: ReactNode = null;
	let emptyConversation: ReactNode = null;

	if (resolvedSelection?.kind === "room" && activeRoom) {
		const onlineMemberCount = activeRoom.members.filter((m) => m.online || m.state !== "offline").length;
		const repMember = activeRoom.representative
			? activeRoom.members.find((m) => m.sessionId === activeRoom.representative)
			: undefined;

		header = (
			<div data-imessage-header="" className="shrink-0">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-page px-5 py-3 max-sm:px-4">
					<button
						type="button"
						onClick={() => setMobileView("list")}
						data-imessage-back=""
						className="order-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-sm border border-line bg-page px-2 text-[12.5px] font-medium whitespace-nowrap text-ink hover:border-ink hover:bg-hover md:hidden"
					>
						<Icon name="arrowLeft" size={14} />
						Threads
					</button>
					<h2
						className="mono order-2 min-w-0 truncate !text-[18px] !leading-6 font-bold tracking-[-0.01em] max-sm:flex-1"
						data-imessage-active-title=""
					>
						#{activeRoom.name}
					</h2>
					<div className="order-3 ml-auto flex shrink-0 items-center gap-1.5 sm:order-5">
						<Segmented
							size="sm"
							label="Room view"
							value={roomView}
							options={[
								["messages", "Messages"],
								["board", "Board"],
							]}
							onChange={(next) => {
								setReaderId(null);
								setRoomView(next);
							}}
						/>
						<button
							type="button"
							onClick={() => {
								setReaderId(null);
								setManagingMembers((v) => !v);
							}}
							data-imessage-manage-members=""
							aria-expanded={managingMembers}
							className={cx(
								"inline-flex h-7 items-center gap-1.5 rounded-sm border border-ink px-2.5 text-[12.5px] font-medium whitespace-nowrap",
								managingMembers ? "bg-ink text-page hover:bg-ink/85" : "bg-page text-ink hover:bg-hover",
							)}
						>
							<Icon name="users" size={13} />
							<span className="max-sm:sr-only">Members</span>
							<span className="tnum opacity-80">{activeRoom.members.length}</span>
						</button>
						<button
							type="button"
							onClick={() => setConfirmingDelete(true)}
							data-imessage-delete-room-ask=""
							aria-label={`Delete room #${activeRoom.name}`}
							className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line bg-page px-2.5 text-[12.5px] font-medium whitespace-nowrap text-muted hover:border-red hover:bg-hover hover:text-red"
						>
							<Icon name="trash" size={13} />
							<span className="max-sm:sr-only">Delete</span>
						</button>
					</div>
					<div className="order-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-muted max-sm:basis-full">
						<span className="tnum">
							{plural(activeRoom.members.length, "member")} · {onlineMemberCount} online
						</span>
						{repMember && (
							<span className="inline-flex min-w-0 items-center gap-1.5">
								<span>Rep:</span>
								<span className="truncate font-medium text-ink">{sessionLabel(repMember)}</span>
								<RepBadge />
							</span>
						)}
					</div>
				</div>

				<div className="border-b border-ink bg-soft px-5 py-2 max-sm:px-4">
					{editingTopic ? (
						<form
							data-imessage-topic-form=""
							className="flex flex-wrap items-center gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								void handleSaveTopic(activeRoom.name);
							}}
						>
							<span className="shrink-0 text-[12px] font-semibold text-muted">Topic</span>
							<input
								type="text"
								value={draftTopic}
								onChange={(e) => setDraftTopic(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Escape") {
										e.preventDefault();
										setEditingTopic(false);
										setTopicError(null);
									}
								}}
								placeholder="What are these agents coordinating?"
								aria-label="Room topic"
								autoFocus
								className="h-7 min-w-[200px] flex-1 rounded-sm border border-line bg-page px-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-ink"
							/>
							<button type="submit" disabled={savingTopic} className={cx(BUTTON.primary, "!h-7 !px-2.5 !text-[12px]")}>
								{savingTopic ? "Saving…" : "Save"}
							</button>
							<button
								type="button"
								disabled={savingTopic}
								onClick={() => {
									setEditingTopic(false);
									setTopicError(null);
								}}
								className="inline-flex h-7 items-center rounded-sm border border-line bg-page px-2.5 text-[12px] font-medium text-muted hover:border-ink hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-45"
							>
								Cancel
							</button>
							{topicError && <span className="w-full text-[12px] text-red">{topicError}</span>}
						</form>
					) : (
						<div className="flex min-w-0 items-center gap-2.5 text-[13px]">
							<span className="shrink-0 text-[12px] font-semibold text-muted">Topic</span>
							{activeRoom.topic ? (
								<span
									onClick={() => {
										setDraftTopic(activeRoom.topic ?? "");
										setEditingTopic(true);
									}}
									data-imessage-topic=""
									title="Click to edit topic"
									className="min-w-0 flex-1 cursor-pointer truncate text-[13px] text-ink"
								>
									{activeRoom.topic}
								</span>
							) : (
								<span className="min-w-0 flex-1 truncate text-[13px] text-muted">No topic set</span>
							)}
							<button
								type="button"
								onClick={() => {
									setDraftTopic(activeRoom.topic ?? "");
									setEditingTopic(true);
								}}
								data-imessage-edit-topic=""
								aria-label={activeRoom.topic ? "Edit topic" : "Add topic"}
								className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm border border-line bg-page px-2 py-0.5 text-[12px] font-medium text-ink hover:border-ink hover:bg-hover"
							>
								<Icon name={activeRoom.topic ? "edit" : "plus"} size={11} />
								<span>{activeRoom.topic ? "Edit topic" : "Add topic"}</span>
							</button>
						</div>
					)}
				</div>
			</div>
		);

		emptyConversation = (
			<div className="mx-auto max-w-[54ch] px-6 py-16 text-center text-[13px] text-muted">
				<p className="text-[14px] font-medium text-ink">
					Nothing posted in <span className="mono">#{activeRoom.name}</span> yet
				</p>
				<p className="mt-1">
					Choose who to notify below to wake those agents, or type <code className="code-chip">@</code> in your message. Posts
					that notify no one stay in the room’s history for <code className="code-chip">relay_room</code>.
				</p>
			</div>
		);
	} else if (resolvedSelection?.kind === "dm" && activeDm) {
		header = (
			<div data-imessage-header="" className="shrink-0 border-b border-ink bg-page px-5 py-3 max-sm:px-4">
				<div className="flex flex-wrap items-center gap-2.5">
					<button
						type="button"
						onClick={() => setMobileView("list")}
						data-imessage-back=""
						className="inline-flex h-7 shrink-0 items-center gap-1 rounded-sm border border-line bg-page px-2 text-[12.5px] font-medium whitespace-nowrap text-ink hover:border-ink hover:bg-hover md:hidden"
					>
						<Icon name="arrowLeft" size={14} />
						Threads
					</button>
					<StateDot state={activeDm.state} />
					<h2 className="flex min-w-0 items-center gap-2 text-[18px] leading-6 font-bold tracking-[-0.01em]" data-imessage-active-title="">
						{activeDm.recorded ? (
							<Link
								to={`/s/${encodeURIComponent(activeDm.sessionId)}`}
								className={cx(
									"min-w-0 truncate underline decoration-line underline-offset-[3px] hover:decoration-ink",
									!activeDm.named && "mono",
								)}
							>
								{activeDm.label}
							</Link>
						) : (
							<span className={cx("min-w-0 truncate", !activeDm.named && "mono")}>{activeDm.label}</span>
						)}
					</h2>
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
					<span className="font-medium text-ink">{STATE_WORD[activeDm.state]}</span>
					{activeDm.project !== "—" && <span>{activeDm.project}</span>}
					{activeDm.device && <span>{activeDm.device}</span>}
					{activeDm.model && (
						<span className="inline-flex items-center gap-1">
							<span className="mono !text-[12px]">{activeDm.model}</span>
							<ModelMark model={activeDm.model} size={12} />
						</span>
					)}
					<button
						type="button"
						onClick={() =>
							void copyText(activeDm.sessionId).then((ok) => {
								if (!ok) return;
								setCopiedDmId(true);
								setTimeout(() => setCopiedDmId(false), 1_600);
							})
						}
						title={`Copy session ID ${activeDm.sessionId}`}
						aria-label={copiedDmId ? "Copied session ID" : `Copy session ID ${activeDm.sessionId}`}
						className="mono inline-flex items-center gap-1 rounded-sm border border-line bg-page px-2 py-0.5 !text-[12px] text-muted hover:border-ink hover:bg-hover hover:text-ink"
					>
						<span>{shortId(activeDm.sessionId)}</span>
						<Icon name={copiedDmId ? "check" : "copy"} size={11} />
					</button>
				</div>
			</div>
		);

		emptyConversation = (
			<div className="mx-auto max-w-[54ch] px-6 py-16 text-center text-[13px] text-muted">
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
			: "History only unless @mentioned";

	const missingRoomName =
		resolvedSelection?.kind === "room" && !activeRoom && !roomsQuery.isPending && !roomDetailQuery.isPending
			? resolvedSelection.room
			: null;

	return (
		<section
			aria-label="Messages and chatrooms"
			data-imessage=""
			className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-page md:flex-row"
		>
			{/* Left Directory Rail */}
			<aside
				aria-label="Thread directory"
				className={cx(
					"flex min-h-0 w-full flex-col border-ink bg-page md:w-[272px] md:shrink-0 md:border-r",
					mobileView === "chat" && "max-md:hidden",
				)}
			>
				<div className="flex items-center justify-between gap-2 border-b border-ink px-3.5 py-2.5">
					<h1 className="text-[16px] leading-6 font-semibold tracking-[-0.01em]">Chatrooms</h1>
					<button
						type="button"
						onClick={() => openNewRoomDialog()}
						data-imessage-new-room=""
						className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-ink bg-page px-2.5 text-[12.5px] font-medium whitespace-nowrap text-ink hover:bg-hover"
					>
						<Icon name="plus" size={13} />
						New room
					</button>
				</div>

				<div className="space-y-2 border-b border-line px-3 py-2.5">
					<Segmented
						fullWidth
						size="sm"
						label="Filter conversations"
						value={filter}
						options={[
							["all", `All ${searchMatchedThreads.length}`],
							["rooms", `Rooms ${roomMatches.length}`],
							["direct", `Direct ${dmMatches.length}`],
						]}
						onChange={setFilter}
					/>
					<div className="flex h-8 min-w-0 items-center gap-1.5 rounded-sm border border-line bg-page px-2.5 text-muted focus-within:border-ink">
						<Icon name="search" size={13} className="shrink-0" />
						<input
							type="search"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search rooms or sessions"
							aria-label="Search conversations by agent, project, or room"
							data-imessage-search=""
							className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted"
						/>
					</div>
				</div>

				<nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto" data-imessage-threads="">
					{visibleThreads.length === 0 ? (
						<p className="px-4 py-10 text-center text-[12.5px] text-muted">
							{threads.length === 0
								? "No conversations yet. Sessions appear here while online; create a room to bring several together."
								: search.trim()
									? `Nothing matches “${search.trim()}”.`
									: filter === "rooms"
										? "No chatrooms yet."
										: "No direct conversations yet."}
						</p>
					) : filter === "all" ? (
						<>
							{roomMatches.length > 0 && (
								<ThreadGroup title="Rooms" count={roomMatches.length}>
									{roomMatches.map(renderThreadRow)}
								</ThreadGroup>
							)}
							{dmMatches.length > 0 && (
								<ThreadGroup title="Direct" count={dmMatches.length}>
									{dmMatches.map(renderThreadRow)}
								</ThreadGroup>
							)}
						</>
					) : (
						<ul>{visibleThreads.map(renderThreadRow)}</ul>
					)}
				</nav>
			</aside>

			{/* Center Conversation Sheet */}
			<div
				className={cx(
					"flex min-h-0 min-w-0 flex-1 flex-col bg-page",
					mobileView === "list" && "max-md:hidden",
				)}
			>
				{missingRoomName ? (
					<div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
						<button
							type="button"
							onClick={() => setMobileView("list")}
							className={cx(BUTTON.secondary, "mb-4 md:hidden")}
						>
							<Icon name="arrowLeft" size={14} />
							Threads
						</button>
						<Icon name="message" size={22} className="text-muted" />
						<p className="mt-3 text-[15px] font-medium">
							Room <span className="mono">#{missingRoomName}</span> does not exist
						</p>
						<p className="mt-1 max-w-[46ch] text-[13px] text-muted">
							It may have been deleted, or hasn’t been created yet.
						</p>
						{ROOM_NAME_RE.test(missingRoomName) && (
							<button
								type="button"
								onClick={() => openNewRoomDialog(missingRoomName)}
								className={cx(BUTTON.primary, "mt-4")}
							>
								<Icon name="plus" size={14} />
								Create #{missingRoomName}
							</button>
						)}
					</div>
				) : !resolvedSelection || (!activeRoom && !activeDm) ? (
					<div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
						<Icon name="message" size={22} className="text-muted" />
						<p className="mt-3 text-[15px] font-medium">Nothing selected</p>
						<p className="mt-1 max-w-[46ch] text-[13px] text-muted">
							Message a session that is online, or create a room to coordinate agents across repositories.
						</p>
						<button
							type="button"
							onClick={() => openNewRoomDialog()}
							className={cx(BUTTON.secondary, "mt-4")}
						>
							<Icon name="plus" size={14} />
							New room
						</button>
					</div>
				) : (
					<>
						{header}

						{resolvedSelection.kind === "room" && roomView === "board" ? (
							<RoomBoard room={resolvedSelection.room} now={now} />
						) : (
							<>
								<div className="relative flex min-h-0 flex-1 flex-col">
									<div
										ref={streamRef}
										data-imessage-stream=""
										onScroll={(event) => {
											const node = event.currentTarget;
											const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
											stickToBottom.current = atBottom;
											setScrolledUp(!atBottom);
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
														parentMessage={message.replyTo ? messagesById.get(message.replyTo) : undefined}
														canLinkSender={message.from.kind === "session" && canLinkSession(message.from.sessionId)}
														canLinkRecipient={Boolean(message.to && canLinkSession(message.to.sessionId))}
														now={now}
														readerMode={readerMode}
														selected={readerMessage?.id === message.id}
														highlighted={highlightedId === message.id}
														expanded={expanded.has(message.id)}
														onRead={onRead}
														onInspect={onInspect}
														onReply={onReply}
														onJumpToMessage={jumpToMessage}
													/>
												))}
											</ol>
										)}
									</div>

									{scrolledUp && messages.length > 0 && (
										<button
											type="button"
											data-imessage-jump-latest=""
											onClick={() => {
												stickToBottom.current = true;
												setScrolledUp(false);
												streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
											}}
											className="absolute bottom-3 left-1/2 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-sm border border-ink bg-page px-2.5 text-[12px] font-medium whitespace-nowrap text-ink hover:bg-hover"
										>
											<Icon name="arrowDown" size={12} />
											Jump to latest
										</button>
									)}
								</div>

								{/* Composer */}
								<div className="shrink-0 border-t border-ink bg-soft px-5 py-3 max-sm:px-4">
									{replyTo && (
										<div
											data-imessage-reply-banner={replyTo.id}
											className="mb-2 flex items-center gap-2 rounded-sm border border-line border-l border-l-ink bg-page px-3 py-1.5 text-[12.5px]"
										>
											<Icon name="reply" size={13} className="shrink-0 text-ink" />
											<span className="shrink-0 text-muted">Replying to</span>
											<span className="shrink-0 font-semibold text-ink">{replyTo.sender}</span>
											<span className="mono shrink-0 !text-[11.5px] text-muted">{shortId(replyTo.id)}</span>
											<span className="min-w-0 flex-1 truncate text-muted">{replyTo.preview}</span>
											<button
												type="button"
												onClick={() => setReplyTo(null)}
												aria-label="Cancel reply"
												data-imessage-cancel-reply=""
												className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-line bg-page text-muted hover:border-ink hover:bg-hover hover:text-ink"
											>
												<Icon name="close" size={12} />
											</button>
										</div>
									)}

									{resolvedSelection.kind === "room" && activeRoom && (
										<div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px]" data-imessage-mention-bar="">
											<span id={notifyId} className="mr-0.5 font-medium text-muted">
												Notify
											</span>
											<div role="group" aria-labelledby={notifyId} className="flex flex-wrap items-center gap-1.5">
												<button
													type="button"
													onClick={() => toggleMention("all")}
													data-imessage-mention="all"
													data-imessage-notify-chip="all"
													aria-pressed={selectedMentions.has("all")}
													title="Every member of the room"
													className={cx(
														"inline-flex h-6 items-center gap-1 rounded-sm border px-2 font-medium",
														selectedMentions.has("all")
															? "border-ink bg-ink text-page"
															: "border-line bg-page text-ink hover:border-ink hover:bg-hover",
													)}
												>
													<span>All</span>
													<span className="mono !text-[11px] opacity-80">@all</span>
												</button>

												{activeRoom.representative && activeRoom.members.some((m) => m.sessionId === activeRoom.representative) && (
													<button
														type="button"
														onClick={() => toggleMention(activeRoom.representative!)}
														data-imessage-notify-rep={activeRoom.representative}
														aria-pressed={selectedMentions.has("all") || selectedMentions.has(activeRoom.representative)}
														title="Notify the room's representative"
														className={cx(
															"inline-flex h-6 items-center gap-1 rounded-sm border px-2 font-medium",
															selectedMentions.has("all") || selectedMentions.has(activeRoom.representative)
																? "border-ink bg-ink text-page"
																: "border-line bg-page text-ink hover:border-ink hover:bg-hover",
														)}
													>
														Rep
													</button>
												)}

												{activeRoom.members.map((m) => {
													const active = selectedMentions.has("all") || selectedMentions.has(m.sessionId);
													const isRep = m.sessionId === activeRoom.representative;
													return (
														<button
															key={m.sessionId}
															type="button"
															onClick={() => toggleMention(m.sessionId)}
															data-imessage-mention={m.sessionId}
															data-imessage-notify-chip={m.sessionId}
															aria-pressed={active}
															title={[m.project, memberDevice(m)].filter(Boolean).join(" · ") || m.sessionId}
															className={cx(
																"inline-flex h-6 max-w-[22ch] items-center gap-1 rounded-sm border px-2 font-medium",
																active
																	? "border-ink bg-ink text-page"
																	: "border-line bg-page text-ink hover:border-ink hover:bg-hover",
															)}
														>
															<span className="truncate">{sessionLabel(m)}</span>
															{isRep && <RepBadge inverted={active} />}
														</button>
													);
												})}
											</div>
											<span className="ml-auto text-muted">{mentionHint}</span>
										</div>
									)}

									<div className="relative">
										{activeMentionMatch && mentionCandidates.length > 0 && (
											<ul
												role="listbox"
												aria-label="Mention a room member"
												data-imessage-mention-menu=""
												className="menu-in absolute right-0 bottom-full left-0 z-20 mb-1 max-h-48 overflow-y-auto rounded-sm border border-ink bg-page py-1"
											>
												{mentionCandidates.map((candidate, index) => {
													const active = index === activeMentionIndex;
													return (
														<li key={`${candidate.token}-${index}`} role="option" aria-selected={active}>
															<button
																type="button"
																onMouseDown={(e) => e.preventDefault()}
																onClick={() => insertMentionCandidate(candidate)}
																data-imessage-mention-option={candidate.token}
																className={cx(
																	"flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px]",
																	active ? "bg-ink text-page" : "text-ink hover:bg-hover",
																)}
															>
																<span className="mono shrink-0 !text-[12px] font-medium">@{candidate.token}</span>
																<span className="truncate">{candidate.label}</span>
																{candidate.representative && <RepBadge inverted={active} />}
																{candidate.detail && (
																	<span className={cx("ml-auto shrink-0 truncate text-[11.5px]", active ? "text-page/75" : "text-muted")}>
																		{candidate.detail}
																	</span>
																)}
															</button>
														</li>
													);
												})}
											</ul>
										)}

										<div className="rounded-sm border border-line bg-page focus-within:border-ink">
											<label htmlFor={composerId} className="sr-only">
												Message
											</label>
											<textarea
												ref={inputRef}
												id={composerId}
												rows={2}
												value={text}
												onChange={(e) => {
													const val = e.target.value;
													const pos = e.target.selectionStart ?? val.length;
													setText(val);
													setCursorPos(pos);
													setDismissedMentionAt(null);
												}}
												onSelect={(e) => setCursorPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
												onKeyDown={onComposerKeyDown}
												placeholder={
													resolvedSelection.kind === "room"
														? `Message #${resolvedSelection.room} (type @ to mention)`
														: `Message ${activeDm?.label ?? "this session"}`
												}
												data-imessage-input=""
												className="block max-h-60 w-full resize-none bg-transparent px-3 py-2 text-[13.5px] leading-5 outline-none placeholder:text-muted"
											/>
											<div className="flex flex-wrap items-center gap-2 border-t border-line bg-soft/50 px-2.5 py-1.5">
												<button
													type="button"
													onClick={() => setUrgent((v) => !v)}
													aria-pressed={urgent}
													data-imessage-urgent=""
													title="Steer into a busy session's current turn instead of waiting for it to finish"
													className={cx(
														"inline-flex h-7 items-center gap-1.5 rounded-sm border px-2.5 text-[12.5px] font-medium whitespace-nowrap",
														urgent
															? "border-red bg-red-soft text-red"
															: "border-line bg-page text-muted hover:border-ink hover:bg-hover hover:text-ink",
													)}
												>
													<Icon name="alert" size={13} />
													Urgent
												</button>
												<span className="text-[12px] text-muted max-sm:hidden">
													<kbd className="mono !text-[11px]">Cmd/Ctrl+Enter</kbd> to send
												</span>
												<span
													data-imessage-bytes=""
													className={cx("tnum ml-auto text-[12px]", tooLong ? "font-medium text-red" : "text-muted")}
												>
													{formatBytes(bytes)} / 32 KB
												</span>
												<button
													type="button"
													onClick={() => void handleSend()}
													disabled={!canSend}
													data-imessage-send=""
													className={cx(BUTTON.primary, "!h-7")}
												>
													{sending ? "Sending…" : "Send"}
												</button>
											</div>
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
					</>
				)}
			</div>

			{/* Right Unified Inspector Rail (slide-over backdrop on <xl, docked 3rd column on xl+) */}
			{inspectorOpen && (
				<div
					className="fixed inset-0 z-20 bg-ink/15 dark:bg-page/75 xl:hidden"
					onClick={closeInspector}
					aria-hidden="true"
				/>
			)}
			{managingMembers && activeRoom ? (
				<RoomMembersRail
					room={activeRoom}
					onlineSessions={sessions}
					memberBusyId={memberBusyId}
					onToggleMember={handleToggleRoomMember}
					onToggleRepresentative={handleToggleRepresentative}
					onClose={() => setManagingMembers(false)}
				/>
			) : readerMessage ? (
				<Reader
					message={readerMessage}
					onClose={() => setReaderId(null)}
					onJumpToMessage={jumpToMessage}
					hasParentInStream={Boolean(readerMessage.replyTo && messagesById.has(readerMessage.replyTo))}
				/>
			) : null}

			{/* New Room Modal Dialog */}
			{creatingRoom && (
				<Dialog
					title="New room"
					label="new-room"
					locked={savingRoom}
					onCancel={() => setCreatingRoom(false)}
				>
					<form
						data-imessage-room-form=""
						className="mt-2"
						onSubmit={(event) => {
							event.preventDefault();
							void handleCreateRoom();
						}}
					>
						<p className="text-[13px] text-muted">
							Coordinate sessions across repositories. Agents can also join with <code className="code-chip">/relay join</code>.
						</p>
						<label htmlFor={roomNameId} className="mt-3 block text-[12.5px] font-medium text-ink">
							Room name
						</label>
						<input
							ref={newRoomNameRef}
							id={roomNameId}
							type="text"
							value={newRoomName}
							onChange={(e) => {
								setNewRoomName(e.target.value);
								setRoomFormError(null);
							}}
							placeholder="auth-sync"
							className={cx(FIELD, "mono")}
						/>
						<label htmlFor={roomTopicId} className="mt-3 block text-[12.5px] font-medium text-ink">
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

						<fieldset className="mt-3">
							<legend className="text-[12.5px] font-medium text-ink">Initial members (optional)</legend>
							{(sessions.length > 0 || (recentForNewRoom.data?.items.length ?? 0) > 0) && (
								<div className="mt-1 flex h-7 items-center gap-1.5 rounded-sm border border-line bg-page px-2 text-muted focus-within:border-ink">
									<Icon name="search" size={12} className="shrink-0" />
									<input
										type="search"
										value={newRoomFilter}
										onChange={(e) => setNewRoomFilter(e.target.value)}
										placeholder="Filter sessions"
										aria-label="Filter sessions for room"
										className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-muted"
									/>
								</div>
							)}
							{newRoomCandidates.length === 0 ? (
								<p className="mt-1.5 text-[12px] text-muted">
									{newRoomFilter.trim() ? `No sessions matching “${newRoomFilter.trim()}”.` : "No online or recent sessions available yet."}
								</p>
							) : (
								<ul className="mt-1.5 max-h-44 overflow-y-auto rounded-sm border border-line">
									{newRoomCandidates.map((s) => (
										<li key={s.id} className="border-b border-line last:border-b-0">
											<label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12.5px] hover:bg-hover">
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
												<StateDot state={s.state} />
												<span className={cx("min-w-0 truncate font-medium", !s.named && "mono")}>{s.label}</span>
												<span className="ml-auto shrink-0 text-[11.5px] text-muted">{s.project}</span>
											</label>
										</li>
									))}
								</ul>
							)}
						</fieldset>

						{roomFormError && (
							<p role="alert" className="mt-2 text-[12.5px] text-red">
								{roomFormError}
							</p>
						)}
						<div className="mt-4 flex justify-end gap-2">
							<button type="button" disabled={savingRoom} onClick={() => setCreatingRoom(false)} className={BUTTON.secondary}>
								Cancel
							</button>
							<button
								type="submit"
								disabled={savingRoom || !newRoomName.trim()}
								data-imessage-create-room=""
								className={BUTTON.primary}
							>
								{savingRoom ? "Creating…" : "Create room"}
							</button>
						</div>
					</form>
				</Dialog>
			)}

			{/* Delete Room Confirmation Dialog */}
			{confirmingDelete && activeRoom && (
				<Dialog
					title={`Delete #${activeRoom.name}?`}
					label="delete-room"
					locked={deletingRoom}
					onCancel={() => setConfirmingDelete(false)}
				>
					<p className="mt-2 text-[14px] text-muted">
						Deletes <span className="mono text-ink">#{activeRoom.name}</span> and its room message history. Sessions in the room
						are not stopped.
					</p>
					<div className="mt-5 flex justify-end gap-2">
						<button
							ref={deleteCancelRef}
							type="button"
							disabled={deletingRoom}
							onClick={() => setConfirmingDelete(false)}
							className={BUTTON.secondary}
						>
							Cancel
						</button>
						<button
							type="button"
							disabled={deletingRoom}
							onClick={() => void handleDeleteRoom(activeRoom.name)}
							data-imessage-delete-room=""
							className={BUTTON.danger}
						>
							{deletingRoom ? "Deleting…" : "Delete room"}
						</button>
					</div>
				</Dialog>
			)}
		</section>
	);
}
