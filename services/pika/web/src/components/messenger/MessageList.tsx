import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";
import { copyText } from "../../lib/clipboard";
import { formatDateTime, formatRelative, plural } from "../../lib/format";
import { formatBytes, messageShape, plainLine, previewSource, sessionLabel, shortId } from "../../lib/relay";
import { Icon } from "../icons";
import { Markdown } from "../Markdown";
import { BUTTON, cx, Pill } from "../ui";
import { formatError, names, senderName, senderWhere, STICK_PX } from "./helpers";
import { DeliveryStatus } from "./primitives";
import type { ChatMessage } from "./types";

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
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => {
		if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
	}, []);
	const shape = useMemo(() => messageShape(message.text), [message.text]);
	const whole = !shape.long || (!readerMode && expanded);
	const where = senderWhere(message.from);
	const bareSender = message.from.kind === "session" && !message.from.name && !message.from.title;
	const bareRecipient = Boolean(message.to && !message.to.name && !message.to.title);
	const readLabel = readerMode ? (selected ? "Close reader" : "Read in full") : expanded ? "Show less" : "Show all";

	const handleCopy = () => {
		void copyText(message.text)
			.then((ok) => {
				if (!ok) return;
				setCopied(true);
				if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
				copyTimerRef.current = setTimeout(() => setCopied(false), 1_600);
			})
			.catch(() => {});
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

export function MessageList({
	streamRef,
	messages,
	messagesById,
	canLinkSession,
	now,
	readerMode,
	readerMessageId,
	highlightedId,
	expanded,
	scrolledUp,
	roomLoadError,
	retryingRoom,
	onRetryRoom,
	dmLoadError,
	retryingDm,
	onRetryDm,
	emptyConversation,
	onAtBottomChange,
	onJumpLatest,
	onRead,
	onInspect,
	onReply,
	onJumpToMessage,
}: {
	streamRef: RefObject<HTMLDivElement | null>;
	messages: readonly ChatMessage[];
	messagesById: ReadonlyMap<string, ChatMessage>;
	canLinkSession: (sessionId: string) => boolean;
	now: number;
	readerMode: boolean;
	readerMessageId?: string;
	highlightedId: string | null;
	expanded: ReadonlySet<string>;
	scrolledUp: boolean;
	roomLoadError: unknown;
	retryingRoom: boolean;
	onRetryRoom: () => void;
	dmLoadError: unknown;
	retryingDm: boolean;
	onRetryDm: () => void;
	emptyConversation: ReactNode;
	onAtBottomChange: (atBottom: boolean) => void;
	onJumpLatest: () => void;
	onRead: (id: string) => void;
	onInspect: (id: string) => void;
	onReply: (message: ChatMessage) => void;
	onJumpToMessage: (id: string) => void;
}) {
	return (
		<div className="relative flex min-h-0 flex-1 flex-col">
			{roomLoadError !== null && roomLoadError !== undefined && messages.length > 0 && (
				<div
					role="alert"
					data-imessage-room-error=""
					className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-red-soft px-5 py-2 text-[12.5px] text-red max-sm:px-4"
				>
					<span className="min-w-0 flex-1">Couldn’t refresh room history: {formatError(roomLoadError)}</span>
					<button
						type="button"
						disabled={retryingRoom}
						onClick={onRetryRoom}
						className="shrink-0 font-medium underline hover:no-underline disabled:opacity-45"
					>
						{retryingRoom ? "Retrying…" : "Retry"}
					</button>
				</div>
			)}
			{dmLoadError !== null && dmLoadError !== undefined && (
				<div
					role="alert"
					data-imessage-dm-error=""
					className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-red-soft px-5 py-2 text-[12.5px] text-red max-sm:px-4"
				>
					<span className="min-w-0 flex-1">Couldn’t load session details: {formatError(dmLoadError)}</span>
					<button
						type="button"
						disabled={retryingDm}
						onClick={onRetryDm}
						className="shrink-0 font-medium underline hover:no-underline disabled:opacity-45"
					>
						{retryingDm ? "Retrying…" : "Retry"}
					</button>
				</div>
			)}
			<div
				ref={streamRef}
				data-imessage-stream=""
				onScroll={(event) => {
					const node = event.currentTarget;
					const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX;
					onAtBottomChange(atBottom);
				}}
				className="min-h-0 flex-1 overflow-y-auto"
			>
				{messages.length === 0 ? (
					roomLoadError !== null && roomLoadError !== undefined ? (
						<div
							role="alert"
							data-imessage-room-error=""
							className="mx-auto max-w-[54ch] px-6 py-16 text-center text-[13px] text-muted"
						>
							<p className="text-[14px] font-medium text-red">Couldn’t load room history</p>
							<p className="mt-1">{formatError(roomLoadError)}</p>
							<button
								type="button"
								disabled={retryingRoom}
								onClick={onRetryRoom}
								className={cx(BUTTON.secondary, "mt-3")}
							>
								{retryingRoom ? "Retrying…" : "Retry"}
							</button>
						</div>
					) : (
						emptyConversation
					)
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
								selected={readerMessageId === message.id}
								highlighted={highlightedId === message.id}
								expanded={expanded.has(message.id)}
								onRead={onRead}
								onInspect={onInspect}
								onReply={onReply}
								onJumpToMessage={onJumpToMessage}
							/>
						))}
					</ol>
				)}
			</div>

			{scrolledUp && messages.length > 0 && (
				<button
					type="button"
					data-imessage-jump-latest=""
					onClick={onJumpLatest}
					className="absolute bottom-3 left-1/2 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-sm border border-ink bg-page px-2.5 text-[12px] font-medium whitespace-nowrap text-ink hover:bg-hover"
				>
					<Icon name="arrowDown" size={12} />
					Jump to latest
				</button>
			)}
		</div>
	);
}
