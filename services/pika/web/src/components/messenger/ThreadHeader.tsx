import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Link } from "react-router";
import { useApi } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { plural } from "../../lib/format";
import { RELAY_ROOMS_KEY, relayRoomKey, sessionLabel, shortId } from "../../lib/relay";
import type { RelayRoom } from "../../lib/types";
import { Icon } from "../icons";
import { ModelMark } from "../ModelName";
import { BUTTON, cx, Segmented } from "../ui";
import { formatError, STATE_WORD } from "./helpers";
import { RepBadge, StateDot } from "./primitives";
import type { DmThread } from "./types";

export interface TopicEditorController {
	editing: boolean;
	draft: string;
	saving: boolean;
	error: string | null;
	startEdit: (currentTopic?: string) => void;
	cancelEdit: () => void;
	setDraft: (value: string) => void;
	save: (roomName: string) => Promise<void>;
}

export function useTopicEditor({
	resolvedKey,
	resolvedKeyRef,
}: {
	resolvedKey: string;
	resolvedKeyRef: RefObject<string>;
}): TopicEditorController {
	const api = useApi();
	const queryClient = useQueryClient();
	const [editing, setEditing] = useState(false);
	const [draft, setDraftState] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reset synchronously on thread switch so a click right after commit is not undone.
	const [prevKey, setPrevKey] = useState(resolvedKey);
	if (prevKey !== resolvedKey) {
		setPrevKey(resolvedKey);
		setEditing(false);
		setError(null);
	}

	const save = async (roomName: string) => {
		if (saving) return;
		const targetKey = `room:${roomName}`;
		setSaving(true);
		setError(null);
		try {
			const trimmed = draft.trim();
			await api.saveRelayRoom({ name: roomName, topic: trimmed || null });
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: RELAY_ROOMS_KEY }),
				queryClient.invalidateQueries({ queryKey: relayRoomKey(roomName) }),
			]);
			if (resolvedKeyRef.current === targetKey) {
				setEditing(false);
			}
		} catch (cause) {
			if (resolvedKeyRef.current === targetKey) {
				setError(formatError(cause));
			}
		} finally {
			setSaving(false);
		}
	};

	return {
		editing,
		draft,
		saving,
		error,
		startEdit: (currentTopic) => {
			setDraftState(currentTopic ?? "");
			setError(null);
			setEditing(true);
		},
		cancelEdit: () => {
			setEditing(false);
			setError(null);
		},
		setDraft: (value) => {
			setDraftState(value);
			setError(null);
		},
		save,
	};
}

export function RoomHeader({
	room,
	roomView,
	onRoomViewChange,
	managingMembers,
	onToggleMembers,
	onAskDelete,
	topicEditor,
	onBack,
}: {
	room: RelayRoom;
	roomView: "messages" | "board";
	onRoomViewChange: (next: "messages" | "board") => void;
	managingMembers: boolean;
	onToggleMembers: () => void;
	onAskDelete: () => void;
	topicEditor: TopicEditorController;
	onBack: () => void;
}) {
	const onlineMemberCount = room.members.filter((m) => m.online || m.state !== "offline").length;
	const repMember = room.representative
		? room.members.find((m) => m.sessionId === room.representative)
		: undefined;

	return (
		<div data-imessage-header="" className="shrink-0">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-page px-5 py-3 max-sm:px-4">
				<button
					type="button"
					onClick={onBack}
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
					#{room.name}
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
						onChange={onRoomViewChange}
					/>
					<button
						type="button"
						onClick={onToggleMembers}
						data-imessage-manage-members=""
						aria-expanded={managingMembers}
						className={cx(
							"inline-flex h-7 items-center gap-1.5 rounded-sm border border-ink px-2.5 text-[12.5px] font-medium whitespace-nowrap",
							managingMembers ? "bg-ink text-page hover:bg-ink/85" : "bg-page text-ink hover:bg-hover",
						)}
					>
						<Icon name="users" size={13} />
						<span className="max-sm:sr-only">Members</span>
						<span className="tnum opacity-80">{room.members.length}</span>
					</button>
					<button
						type="button"
						onClick={onAskDelete}
						data-imessage-delete-room-ask=""
						aria-label={`Delete room #${room.name}`}
						className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line bg-page px-2.5 text-[12.5px] font-medium whitespace-nowrap text-muted hover:border-red hover:bg-hover hover:text-red"
					>
						<Icon name="trash" size={13} />
						<span className="max-sm:sr-only">Delete</span>
					</button>
				</div>
				<div className="order-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-muted max-sm:basis-full">
					<span className="tnum">
						{plural(room.members.length, "member")} · {onlineMemberCount} online
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
				{topicEditor.editing ? (
					<form
						data-imessage-topic-form=""
						className="flex flex-wrap items-center gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							void topicEditor.save(room.name);
						}}
					>
						<span className="shrink-0 text-[12px] font-semibold text-muted">Topic</span>
						<input
							type="text"
							value={topicEditor.draft}
							onChange={(e) => topicEditor.setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									topicEditor.cancelEdit();
								}
							}}
							placeholder="What are these agents coordinating?"
							aria-label="Room topic"
							autoFocus
							className="h-7 min-w-[200px] flex-1 rounded-sm border border-line bg-page px-2.5 text-[13px] text-ink outline-none placeholder:text-muted focus:border-ink"
						/>
						<button type="submit" disabled={topicEditor.saving} className={cx(BUTTON.primary, "!h-7 !px-2.5 !text-[12px]")}>
							{topicEditor.saving ? "Saving…" : "Save"}
						</button>
						<button
							type="button"
							disabled={topicEditor.saving}
							onClick={topicEditor.cancelEdit}
							className="inline-flex h-7 items-center rounded-sm border border-line bg-page px-2.5 text-[12px] font-medium text-muted hover:border-ink hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-45"
						>
							Cancel
						</button>
						{topicEditor.error && (
							<span role="alert" data-imessage-topic-error="" className="w-full text-[12px] text-red">
								{topicEditor.error}
							</span>
						)}
					</form>
				) : (
					<div className="flex min-w-0 items-center gap-2.5 text-[13px]">
						<span className="shrink-0 text-[12px] font-semibold text-muted">Topic</span>
						{room.topic ? (
							<span
								onClick={() => topicEditor.startEdit(room.topic)}
								data-imessage-topic=""
								title="Click to edit topic"
								className="min-w-0 flex-1 cursor-pointer truncate text-[13px] text-ink"
							>
								{room.topic}
							</span>
						) : (
							<span className="min-w-0 flex-1 truncate text-[13px] text-muted">No topic set</span>
						)}
						<button
							type="button"
							onClick={() => topicEditor.startEdit(room.topic)}
							data-imessage-edit-topic=""
							aria-label={room.topic ? "Edit topic" : "Add topic"}
							className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm border border-line bg-page px-2 py-0.5 text-[12px] font-medium text-ink hover:border-ink hover:bg-hover"
						>
							<Icon name={room.topic ? "edit" : "plus"} size={11} />
							<span>{room.topic ? "Edit topic" : "Add topic"}</span>
						</button>
					</div>
				)}
			</div>
		</div>
	);
}

export function DmHeader({
	dm,
	onBack,
}: {
	dm: DmThread;
	onBack: () => void;
}) {
	const [copiedDmId, setCopiedDmId] = useState(false);
	const dmCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const [prevSessionId, setPrevSessionId] = useState(dm.sessionId);
	if (prevSessionId !== dm.sessionId) {
		setPrevSessionId(dm.sessionId);
		setCopiedDmId(false);
	}

	useEffect(() => () => {
		if (dmCopyTimerRef.current) clearTimeout(dmCopyTimerRef.current);
	}, []);

	return (
		<div data-imessage-header="" className="shrink-0 border-b border-ink bg-page px-5 py-3 max-sm:px-4">
			<div className="flex flex-wrap items-center gap-2.5">
				<button
					type="button"
					onClick={onBack}
					data-imessage-back=""
					className="inline-flex h-7 shrink-0 items-center gap-1 rounded-sm border border-line bg-page px-2 text-[12.5px] font-medium whitespace-nowrap text-ink hover:border-ink hover:bg-hover md:hidden"
				>
					<Icon name="arrowLeft" size={14} />
					Threads
				</button>
				<StateDot state={dm.state} />
				<h2 className="flex min-w-0 items-center gap-2 text-[18px] leading-6 font-bold tracking-[-0.01em]" data-imessage-active-title="">
					{dm.recorded ? (
						<Link
							to={`/s/${encodeURIComponent(dm.sessionId)}`}
							className={cx(
								"min-w-0 truncate underline decoration-line underline-offset-[3px] hover:decoration-ink",
								!dm.named && "mono",
							)}
						>
							{dm.label}
						</Link>
					) : (
						<span className={cx("min-w-0 truncate", !dm.named && "mono")}>{dm.label}</span>
					)}
				</h2>
			</div>
			<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
				<span className="font-medium text-ink">{STATE_WORD[dm.state]}</span>
				{dm.project !== "—" && <span>{dm.project}</span>}
				{dm.device && <span>{dm.device}</span>}
				{dm.model && (
					<span className="inline-flex items-center gap-1">
						<span className="mono !text-[12px]">{dm.model}</span>
						<ModelMark model={dm.model} size={12} />
					</span>
				)}
				<button
					type="button"
					onClick={() =>
						void copyText(dm.sessionId)
							.then((ok) => {
								if (!ok) return;
								setCopiedDmId(true);
								if (dmCopyTimerRef.current) clearTimeout(dmCopyTimerRef.current);
								dmCopyTimerRef.current = setTimeout(() => setCopiedDmId(false), 1_600);
							})
							.catch(() => {})
					}
					title={`Copy session ID ${dm.sessionId}`}
					aria-label={copiedDmId ? "Copied session ID" : `Copy session ID ${dm.sessionId}`}
					className="mono inline-flex items-center gap-1 rounded-sm border border-line bg-page px-2 py-0.5 !text-[12px] text-muted hover:border-ink hover:bg-hover hover:text-ink"
				>
					<span>{shortId(dm.sessionId)}</span>
					<Icon name={copiedDmId ? "check" : "copy"} size={11} />
				</button>
			</div>
		</div>
	);
}
