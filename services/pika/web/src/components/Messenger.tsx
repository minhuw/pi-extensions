import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMediaQuery } from "../lib/hooks";
import { plainLine } from "../lib/relay";
import type { OnlineSession, RelayEvent } from "../lib/types";
import { Icon } from "./icons";
import { Composer } from "./messenger/Composer";
import { formatError, READER_QUERY, ROOM_NAME_RE, senderName } from "./messenger/helpers";
import { MessageList } from "./messenger/MessageList";
import { MessageReader } from "./messenger/MessageReader";
import { DeleteRoomDialog, NewRoomDialog } from "./messenger/RoomDialogs";
import { RoomMembersRail } from "./messenger/RoomMembersRail";
import { Sidebar } from "./messenger/Sidebar";
import { DmHeader, RoomHeader, useTopicEditor } from "./messenger/ThreadHeader";
import type { ChatMessage, ReplyDraft, ThreadFilter, ThreadSelection } from "./messenger/types";
import { useComposer } from "./messenger/useComposer";
import { useMessengerData } from "./messenger/useMessengerData";
import { RoomBoard } from "./RoomBoard";
import { BUTTON, cx } from "./ui";

export type { ThreadSelection } from "./messenger/types";

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
	const readerMode = useMediaQuery(READER_QUERY);

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

	// Dialogs & room management
	const [newRoomPrefill, setNewRoomPrefill] = useState<string | null>(null);
	const [roomView, setRoomView] = useState<"messages" | "board">("messages");
	const [managingMembers, setManagingMembers] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	// Reading, highlighting & scrolling
	const [readerId, setReaderId] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const [highlightedId, setHighlightedId] = useState<string | null>(null);
	const [scrolledUp, setScrolledUp] = useState(false);
	const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
	const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const streamRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);

	useEffect(() => () => {
		if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
	}, []);

	useEffect(() => {
		if (!readerMode) setReaderId(null);
	}, [readerMode]);

	const data = useMessengerData({
		sessions,
		events,
		activeThread,
		hasUrlSelection,
		search,
		filter,
		onCloseDeleteDialog: () => setConfirmingDelete(false),
		onClearSelection: () => selectThread(null),
	});

	const { resolvedSelection, resolvedKey, resolvedKeyRef, activeRoom, activeDm, messages, messagesById } = data;

	// The thread's own UI state resets in the render that switches threads. As an effect it ran after the switch
	// committed, so a click in between (Edit topic on a room just created) was undone.
	const [stateKey, setStateKey] = useState(resolvedKey);
	if (stateKey !== resolvedKey) {
		setStateKey(resolvedKey);
		setManagingMembers(false);
		setRoomView("messages");
		setConfirmingDelete(false);
		setReaderId(null);
		setReplyTo(null);
		setExpanded(new Set());
		setHighlightedId(null);
		setScrolledUp(false);
	}

	const readerMessage = readerId ? messagesById.get(readerId) : undefined;
	const lastMessage = messages[messages.length - 1];
	const lastMessageKey = lastMessage ? `${lastMessage.id}:${lastMessage.seq ?? ""}:${lastMessage.at}` : "";
	const prevScrollThreadKeyRef = useRef(resolvedKey);

	useLayoutEffect(() => {
		if (prevScrollThreadKeyRef.current !== resolvedKey) {
			prevScrollThreadKeyRef.current = resolvedKey;
			stickToBottom.current = true;
		}
		const node = streamRef.current;
		if (node && stickToBottom.current) {
			node.scrollTop = node.scrollHeight;
			setScrolledUp(false);
		}
	}, [resolvedKey, roomView, messages.length, lastMessageKey]);

	const topicEditor = useTopicEditor({ resolvedKey, resolvedKeyRef });

	const composer = useComposer({
		resolvedSelection,
		resolvedKey,
		resolvedKeyRef,
		activeRoom,
		activeDm,
		replyTo,
		onClearReply: () => setReplyTo(null),
		onMessageSent: () => {
			stickToBottom.current = true;
		},
	});

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
		composer.focusInput();
	};

	const jumpToMessage = (id: string) => {
		const target = streamRef.current?.querySelector<HTMLElement>(`[data-imessage-bubble="${CSS.escape(id)}"]`);
		target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
		setHighlightedId(id);
		if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
		highlightTimerRef.current = setTimeout(() => {
			setHighlightedId((current) => (current === id ? null : current));
		}, 1_800);
	};

	const inspectorOpen = Boolean((managingMembers && activeRoom) || readerMessage);
	const closeInspector = () => {
		setManagingMembers(false);
		setReaderId(null);
	};

	const emptyConversation =
		resolvedSelection?.kind === "room" && activeRoom ? (
			<div className="mx-auto max-w-[54ch] px-6 py-16 text-center text-[13px] text-muted">
				<p className="text-[14px] font-medium text-ink">
					Nothing posted in <span className="mono">#{activeRoom.name}</span> yet
				</p>
				<p className="mt-1">
					Choose who to notify below to wake those agents, or type <code className="code-chip">@</code> in your message. Posts
					that notify no one stay in the room’s history for <code className="code-chip">relay_room</code>.
				</p>
			</div>
		) : resolvedSelection?.kind === "dm" && activeDm ? (
			<div className="mx-auto max-w-[54ch] px-6 py-16 text-center text-[13px] text-muted">
				<p className="text-[14px] font-medium text-ink">No messages with {activeDm.label} yet</p>
				<p className="mt-1">
					What you send starts a turn in this session. Messages it exchanges with other sessions show up here too.
				</p>
			</div>
		) : null;

	return (
		<section
			aria-label="Messages and chatrooms"
			data-imessage=""
			className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-page md:flex-row"
		>
			<Sidebar
				hiddenOnMobile={mobileView === "chat"}
				filter={filter}
				onFilterChange={setFilter}
				search={search}
				onSearchChange={setSearch}
				totalThreads={data.threads.length}
				searchMatchedCount={data.searchMatchedThreads.length}
				roomMatches={data.roomMatches}
				dmMatches={data.dmMatches}
				visibleThreads={data.visibleThreads}
				resolvedKey={resolvedKey}
				now={now}
				roomsError={data.roomsError}
				retryingRooms={data.roomsQuery.isFetching}
				onRetryRooms={() => void data.roomsQuery.refetch()}
				onNewRoom={() => setNewRoomPrefill("")}
				onSelectThread={selectThread}
			/>

			{/* Center Conversation Sheet */}
			<div
				className={cx(
					"flex min-h-0 min-w-0 flex-1 flex-col bg-page",
					mobileView === "list" && "max-md:hidden",
				)}
			>
				{data.missingRoomName ? (
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
							Room <span className="mono">#{data.missingRoomName}</span> does not exist
						</p>
						<p className="mt-1 max-w-[46ch] text-[13px] text-muted">
							It may have been deleted, or hasn’t been created yet.
						</p>
						{ROOM_NAME_RE.test(data.missingRoomName) && (
							<button
								type="button"
								onClick={() => setNewRoomPrefill(data.missingRoomName)}
								className={cx(BUTTON.primary, "mt-4")}
							>
								<Icon name="plus" size={14} />
								Create #{data.missingRoomName}
							</button>
						)}
					</div>
				) : resolvedSelection?.kind === "room" && !activeRoom && data.roomLoadError ? (
					<div role="alert" data-imessage-room-error="" className="flex flex-1 flex-col items-center justify-center p-8 text-center">
						<button
							type="button"
							onClick={() => setMobileView("list")}
							className={cx(BUTTON.secondary, "mb-4 md:hidden")}
						>
							<Icon name="arrowLeft" size={14} />
							Threads
						</button>
						<Icon name="alert" size={22} className="text-red" />
						<p className="mt-3 text-[15px] font-medium text-red">
							Couldn’t load <span className="mono">#{resolvedSelection.room}</span>
						</p>
						<p className="mt-1 max-w-[46ch] text-[13px] text-muted">{formatError(data.roomLoadError)}</p>
						<button
							type="button"
							disabled={data.roomDetailQuery.isFetching}
							onClick={() => void Promise.all([data.roomsQuery.refetch(), data.roomDetailQuery.refetch()])}
							className={cx(BUTTON.secondary, "mt-4")}
						>
							{data.roomDetailQuery.isFetching ? "Retrying…" : "Retry"}
						</button>
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
							onClick={() => setNewRoomPrefill("")}
							className={cx(BUTTON.secondary, "mt-4")}
						>
							<Icon name="plus" size={14} />
							New room
						</button>
					</div>
				) : (
					<>
						{resolvedSelection.kind === "room" && activeRoom ? (
							<RoomHeader
								room={activeRoom}
								roomView={roomView}
								onRoomViewChange={(next) => {
									setReaderId(null);
									setRoomView(next);
								}}
								managingMembers={managingMembers}
								onToggleMembers={() => {
									setReaderId(null);
									setManagingMembers((v) => !v);
								}}
								onAskDelete={() => setConfirmingDelete(true)}
								topicEditor={topicEditor}
								onBack={() => setMobileView("list")}
							/>
						) : resolvedSelection.kind === "dm" && activeDm ? (
							<DmHeader dm={activeDm} onBack={() => setMobileView("list")} />
						) : null}

						{resolvedSelection.kind === "room" && roomView === "board" ? (
							<RoomBoard room={resolvedSelection.room} now={now} />
						) : (
							<>
								<MessageList
									streamRef={streamRef}
									messages={messages}
									messagesById={messagesById}
									canLinkSession={data.canLinkSession}
									now={now}
									readerMode={readerMode}
									readerMessageId={readerMessage?.id}
									highlightedId={highlightedId}
									expanded={expanded}
									scrolledUp={scrolledUp}
									roomLoadError={data.roomLoadError}
									retryingRoom={data.roomDetailQuery.isFetching}
									onRetryRoom={() => void data.roomDetailQuery.refetch()}
									dmLoadError={data.dmLoadError}
									retryingDm={data.dmSessionQuery.isFetching}
									onRetryDm={() => void data.dmSessionQuery.refetch()}
									emptyConversation={emptyConversation}
									onAtBottomChange={(atBottom) => {
										stickToBottom.current = atBottom;
										setScrolledUp(!atBottom);
									}}
									onJumpLatest={() => {
										stickToBottom.current = true;
										setScrolledUp(false);
										streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
									}}
									onRead={onRead}
									onInspect={onInspect}
									onReply={onReply}
									onJumpToMessage={jumpToMessage}
								/>

								<Composer
									selection={resolvedSelection}
									activeRoom={activeRoom}
									activeDm={activeDm}
									replyTo={replyTo}
									onClearReply={() => setReplyTo(null)}
									composer={composer}
								/>
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
					memberBusyId={data.memberBusyId}
					onToggleMember={data.handleToggleRoomMember}
					onToggleRepresentative={data.handleToggleRepresentative}
					onClose={() => setManagingMembers(false)}
				/>
			) : readerMessage ? (
				<MessageReader
					message={readerMessage}
					onClose={() => setReaderId(null)}
					onJumpToMessage={jumpToMessage}
					hasParentInStream={Boolean(readerMessage.replyTo && messagesById.has(readerMessage.replyTo))}
				/>
			) : null}

			{newRoomPrefill !== null && (
				<NewRoomDialog
					initialName={newRoomPrefill}
					sessions={sessions}
					onCancel={() => setNewRoomPrefill(null)}
					onCreated={(roomName) => {
						setNewRoomPrefill(null);
						selectThread({ kind: "room", room: roomName });
					}}
				/>
			)}

			{confirmingDelete && activeRoom && (
				<DeleteRoomDialog
					room={activeRoom}
					onCancel={() => setConfirmingDelete(false)}
					onDelete={data.handleDeleteRoom}
				/>
			)}
		</section>
	);
}
